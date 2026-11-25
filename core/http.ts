// 런타임 공통 HTTP 라우터 (Web 표준 Request/Response).
// 로컬 Node·Vercel(runtime/node.ts의 브리지), Cloudflare Workers(worker/index.ts)가 같은 경로·
// 상태 코드·에러 형태·보안 헤더를 쓰도록 하나로 모은 구현이다.
//
// 보안 불변조건은 로컬 구현 때와 같다:
//  - 오너 UI 정적 파일은 엄격한 CSP(script-src 'self', frame-ancestors 'none')로만 제공한다.
//  - 토큰·관리자 키는 헤더(Bearer)로만 받고, 저장은 해시. 응답에 평문을 다시 담지 않는다.
//  - 관리자 키·오너 로그인은 시도 횟수를 DB에 기록해 제한한다(서버리스 여러 인스턴스에서도 공유).
import { joinInstructions, joinPageHtml } from "./instructions.js";
import { handleMcp } from "./mcp.js";
import { hashToken, safeEqualHex } from "./crypto.js";
import { ApiError, RoomService, type Agent } from "./service.js";

export interface Env {
  /** 설정하면 이 값이 관리자 키가 된다(비밀). 미설정이면 meta의 부트스트랩 키를 쓴다. */
  ACR_ADMIN_KEY?: string;
  /** 초대 안내문·웹 온보딩에 표시할 외부 주소. 없으면 요청 Host를 쓴다. */
  ACR_PUBLIC_URL?: string;
  /** "off"면 웹에서 최초 관리자 키를 만들 수 없다(이미 키를 배포한 경우 권장). */
  ACR_BOOTSTRAP?: string;
  /** Vercel Cron 등 외부 스케줄러가 /api/cron 을 호출할 때의 Bearer 값. */
  CRON_SECRET?: string;
  /** 표시용 런타임 이름(node | vercel | cloudflare ...). */
  ACR_RUNTIME?: string;
}

/** 요청 수명 이후에도 도는 작업(웹훅 전송, lazy 정리). Workers/Vercel의 waitUntil. */
export interface Ctx {
  waitUntil?(promise: Promise<unknown>): void;
}

/** 런타임이 UI 정적 파일을 직접 서빙할 때 쓰는 리더. Workers는 Static Assets가 맡으므로 넘기지 않는다. */
export interface Assets {
  read(path: string): Promise<{ body: Uint8Array; type: string } | null>;
}

const MAX_BODY = 64 * 1024;
const UI_FILES: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/ui/app.js": ["ui/app.js", "text/javascript; charset=utf-8"],
  "/ui/style.css": ["ui/style.css", "text/css; charset=utf-8"],
  "/ui/join.js": ["ui/join.js", "text/javascript; charset=utf-8"],
};
const UI_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: {
      "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}
const fail = (e: ApiError) => json(e.status, { error: { code: e.code, message: e.message } });

/** 본문 상한. 헤더가 크기를 알려주면 읽기 전에, 아니면 스트림을 64KB까지만 읽어 자른다. */
async function readJson(req: Request): Promise<any> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) throw new ApiError(413, "body_too_large", "요청 본문이 너무 큽니다 (최대 64KB).");
  const text = await readBounded(req);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "bad_json", "JSON을 해석할 수 없습니다.");
  }
}

async function readBounded(req: Request): Promise<string> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel().catch(() => {});
        throw new ApiError(413, "body_too_large", "요청 본문이 너무 큽니다 (최대 64KB).");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(buf);
}

function bearer(req: Request): string {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1] : "";
}
const obj = (b: unknown): Record<string, any> => (b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, any>) : {});

/** 시도 제한의 단위. 프록시 뒤에서도 실제 클라이언트를 최대한 구분한다. */
function clientIp(req: Request): string {
  const h = req.headers;
  const raw = h.get("cf-connecting-ip") || (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || h.get("x-real-ip") || "local";
  return /^[A-Za-z0-9.:_-]{1,64}$/.test(raw) ? raw : "local";
}

function bootstrapAllowed(env: Env): boolean {
  const v = (env.ACR_BOOTSTRAP ?? "").trim().toLowerCase();
  return !(v === "off" || v === "false" || v === "0" || v === "no");
}

function envAdminKey(env: Env): string | undefined {
  const k = env.ACR_ADMIN_KEY;
  return k && k.length >= 24 ? k : undefined;
}

/** 관리자 영역 인증. 실패는 IP 단위로 세어 무차별 대입을 막는다. */
async function requireAdmin(svc: RoomService, env: Env, req: Request): Promise<void> {
  const scope = `admin:${clientIp(req)}`;
  const token = bearer(req);
  // 올바른 키는 시도 제한에 걸리지 않는다(남의 무차별 대입으로 오너가 잠기지 않게).
  if (await svc.checkAdminKey(envAdminKey(env), token)) {
    await svc.clearFailures(scope);
    return;
  }
  // 자격 증명을 아예 안 보낸 요청은 오타·미설정일 뿐이므로 세지 않는다.
  if (token) {
    if (await svc.throttled(scope)) throw new ApiError(429, "too_many_attempts", "관리자 키 시도가 너무 많습니다. 15분 뒤 다시 시도하세요.");
    await svc.recordFailure(scope);
  }
  throw new ApiError(401, "unauthorized", "관리자 키가 필요합니다.");
}

export async function handleFetch(
  svc: RoomService,
  env: Env,
  req: Request,
  ctx?: Ctx,
  assets?: Assets,
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method ?? "GET";
  let m: RegExpExecArray | null;

  try {
    // ----- 오너 UI (정적 파일) -----
    if (method === "GET" && assets && UI_FILES[path]) {
      const [file, type] = UI_FILES[path];
      const found = await assets.read(file);
      if (found) {
        return new Response(found.body as unknown as BodyInit, {
          status: 200,
          headers: {
            "content-type": type,
            "content-security-policy": UI_CSP,
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            "x-frame-options": "DENY",
            "cache-control": "no-store",
          },
        });
      }
    }

    if (method === "GET" && path === "/healthz") return json(200, { ok: true });

    // ----- 최초 설정(웹 온보딩): 관리자 키 상태와 최초 발급 -----
    if (method === "GET" && path === "/api/setup") {
      const state = await svc.setupState({ envKeyConfigured: !!envAdminKey(env), bootstrapAllowed: bootstrapAllowed(env) });
      return json(200, { ...state, runtime: env.ACR_RUNTIME ?? "node" });
    }
    if (method === "POST" && path === "/api/setup/bootstrap") {
      const ip = clientIp(req);
      if (await svc.throttled(`bootstrap:${ip}`, 5)) throw new ApiError(429, "too_many_attempts", "너무 많은 요청입니다. 잠시 뒤 다시 시도하세요.");
      await svc.recordFailure(`bootstrap:${ip}`);
      if (!bootstrapAllowed(env)) throw new ApiError(403, "bootstrap_disabled", "웹 최초 설정이 꺼져 있습니다(ACR_BOOTSTRAP=off). ACR_ADMIN_KEY 환경변수를 설정하세요.");
      if (envAdminKey(env) || (await svc.adminKeyConfigured())) throw new ApiError(409, "already_configured", "관리자 키가 이미 설정되어 있습니다.");
      const created = await svc.bootstrapAdminKey();
      if (!created) throw new ApiError(409, "already_configured", "관리자 키가 이미 설정되어 있습니다.");
      await svc.clearFailures(`bootstrap:${ip}`);
      return json(201, {
        admin_key: created.admin_key,
        notice: "이 키는 지금 한 번만 보입니다. 안전한 곳에 저장하세요. 잃어버리면 ACR_ADMIN_KEY 환경변수를 새로 설정해야 합니다.",
      });
    }

    // ----- 스케줄러용 정리(Vercel Cron 등). CRON_SECRET 미설정이면 경로를 숨긴다 -----
    if ((method === "GET" || method === "POST") && path === "/api/cron") {
      const secret = env.CRON_SECRET;
      if (!secret) throw new ApiError(404, "not_found", "없는 경로입니다.");
      if (!safeEqualHex(await hashToken(bearer(req)), await hashToken(secret))) throw new ApiError(401, "unauthorized", "스케줄러 인증이 필요합니다.");
      const purged = await svc.purgeExpired();
      const delivered = await svc.processDueDeliveries();
      return json(200, { ok: true, purged, delivered });
    }

    // ----- public: invite link (join request only) -----
    // 브라우저(Accept: text/html)에는 방 이름·규칙·복사 버튼이 있는 안내 페이지를,
    // 에이전트·CLI(*/*, text/plain 등)에는 기존 마크다운 안내를 그대로 내려준다(양쪽 호환).
    if ((m = /^\/join\/([^/]+)$/.exec(path)) && method === "GET") {
      const info = await svc.inviteInfo(m[1]);
      const host = /^[A-Za-z0-9.:\-\[\]]+$/.test(url.host) ? url.host : "localhost";
      const base = env.ACR_PUBLIC_URL ?? `${url.protocol}//${host}`;
      if ((req.headers.get("accept") ?? "").toLowerCase().includes("text/html")) {
        return new Response(joinPageHtml(base, m[1], info), {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": UI_CSP,
            "vary": "accept",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            "x-frame-options": "DENY",
            "cache-control": "no-store",
          },
        });
      }
      return json(200, joinInstructions(base, m[1], info), { vary: "accept" });
    }
    if ((m = /^\/api\/join\/([^/]+)$/.exec(path)) && method === "POST") {
      return json(201, await svc.requestJoin(m[1], obj(await readJson(req))));
    }
    if ((m = /^\/api\/join-requests\/([^/]+)\/claim$/.exec(path)) && method === "POST") {
      const b = obj(await readJson(req));
      if (typeof b.claim_secret !== "string") throw new ApiError(400, "bad_claim", "claim_secret이 필요합니다.");
      return json(200, await svc.claim(m[1], b.claim_secret));
    }

    // ----- admin authority -----
    if (path.startsWith("/api/admin/")) {
      await requireAdmin(svc, env, req);
      if (path === "/api/admin/rooms" && method === "POST") {
        const b = obj(await readJson(req));
        const created = await svc.createRoom(String(b.name ?? ""), typeof b.description === "string" ? b.description : "");
        return json(201, { ...created, created_at: new Date(svc.clock.now()).toISOString() });
      }
      if (path === "/api/admin/rooms" && method === "GET") return json(200, { rooms: await svc.listRooms() });
      if ((m = /^\/api\/admin\/rooms\/([^/]+)\/rotate-owner-code$/.exec(path)) && method === "POST") return json(200, await svc.rotateOwnerCode(m[1]));
      if ((m = /^\/api\/admin\/rooms\/([^/]+)$/.exec(path)) && method === "DELETE") { await svc.deleteRoom(m[1]); return json(200, { deleted: true }); }
      throw new ApiError(404, "not_found", "없는 경로입니다.");
    }

    // ----- human session authority -----
    if (path === "/api/owner/login" && method === "POST") {
      const b = obj(await readJson(req));
      return json(200, await svc.login(String(b.room_id ?? ""), String(b.owner_code ?? "")));
    }
    if (path.startsWith("/api/owner/")) {
      const token = bearer(req);
      const sess = await svc.authSession(token);
      if (!sess) throw new ApiError(401, "unauthorized", "오너 세션이 필요합니다. /api/owner/login 으로 로그인하세요.");
      const room = sess.roomId;
      if (path === "/api/owner/logout" && method === "POST") { await svc.logout(token); return json(200, { ok: true }); }
      if (path === "/api/owner/room" && method === "GET") return json(200, await svc.getRoomOwner(room));
      if (path === "/api/owner/room" && method === "PATCH") return json(200, await svc.updateRoom(room, obj(await readJson(req))));
      if (path === "/api/owner/invites" && method === "POST") return json(201, await svc.createInvite(room, obj(await readJson(req))));
      if (path === "/api/owner/invites" && method === "GET") return json(200, { invites: await svc.listInvites(room) });
      if ((m = /^\/api\/owner\/invites\/([^/]+)$/.exec(path)) && method === "DELETE") { await svc.revokeInvite(room, m[1]); return json(200, { revoked: true }); }
      if (path === "/api/owner/join-requests" && method === "GET") return json(200, { requests: await svc.listJoinRequests(room, url.searchParams.get("status") ?? undefined) });
      if ((m = /^\/api\/owner\/join-requests\/([^/]+)\/approve$/.exec(path)) && method === "POST") return json(200, await svc.approveJoin(room, m[1], obj(await readJson(req)) as any));
      if ((m = /^\/api\/owner\/join-requests\/([^/]+)\/deny$/.exec(path)) && method === "POST") { await svc.denyJoin(room, m[1]); return json(200, { denied: true }); }
      if (path === "/api/owner/agents" && method === "GET") return json(200, { agents: await svc.listAgents(room) });
      if ((m = /^\/api\/owner\/agents\/([^/]+)\/revoke$/.exec(path)) && method === "POST") { await svc.revokeAgent(room, m[1]); return json(200, { revoked: true }); }
      if (path === "/api/owner/messages" && method === "GET") return json(200, await svc.ownerMessages(room, Number(url.searchParams.get("after") ?? 0), url.searchParams.get("limit") ?? undefined));
      if (path === "/api/owner/messages" && method === "POST") { const r = await svc.postAsOwner(room, obj(await readJson(req))); if (!r.duplicate) ctx?.waitUntil?.(svc.processDueDeliveries(room).catch(() => {})); return json(r.duplicate ? 200 : 201, r); }
      if ((m = /^\/api\/owner\/messages\/(\d+)$/.exec(path)) && method === "DELETE") { await svc.deleteMessage(room, Number(m[1])); return json(200, { deleted: true }); }
      if (path === "/api/owner/webhooks" && method === "GET") return json(200, await svc.listWebhooks(room));
      if (path === "/api/owner/webhooks" && method === "POST") return json(201, await svc.createWebhook(room, obj(await readJson(req)).url));
      if ((m = /^\/api\/owner\/webhooks\/(whk_[A-Za-z0-9]+)$/.exec(path)) && method === "DELETE") { await svc.revokeWebhook(room, m[1]); return json(200, { revoked: true }); }
      if ((m = /^\/api\/owner\/webhooks\/(whk_[A-Za-z0-9]+)\/test$/.exec(path)) && method === "POST") return json(200, { delivery: await svc.testWebhook(room, m[1]) });
      throw new ApiError(404, "not_found", "없는 경로입니다.");
    }

    // ----- agent token authority -----
    if (path === "/mcp" || path === "/api/me" || path === "/api/room" || path === "/api/inbox" || path === "/api/ack" || path === "/api/messages") {
      const agent: Agent | null = await svc.authAgent(bearer(req));
      if (!agent) throw new ApiError(401, "unauthorized", "유효한 에이전트 토큰이 필요합니다.");
      if (path === "/mcp") {
        if (method !== "POST") return json(405, { error: { code: "method_not_allowed", message: "POST만 지원합니다 (stateless Streamable HTTP)." } }, { allow: "POST" });
        // 공식 SDK 전송이 바디 파싱/JSON-RPC 에러(-32700 등)/프로토콜 협상을 직접 처리한다.
        const res = await handleMcp(svc, agent, req);
        ctx?.waitUntil?.(svc.processDueDeliveries(agent.room_id).catch(() => {}));
        return res;
      }
      if ((path === "/api/me" || path === "/api/room") && method === "GET") return json(200, await svc.roomForAgent(agent));
      if (path === "/api/inbox" && method === "GET") return json(200, await svc.inbox(agent, url.searchParams.get("limit") ?? undefined, url.searchParams.get("wait") ?? undefined, bearer(req)));
      if (path === "/api/ack" && method === "POST") return json(200, await svc.ack(agent, obj(await readJson(req)).seq));
      if (path === "/api/messages" && method === "GET") return json(200, await svc.readMessages(agent, Number(url.searchParams.get("after") ?? 0), url.searchParams.get("limit") ?? undefined));
      if (path === "/api/messages" && method === "POST") { const r = await svc.postAsAgent(agent, obj(await readJson(req))); if (!r.duplicate) ctx?.waitUntil?.(svc.processDueDeliveries(agent.room_id).catch(() => {})); return json(r.duplicate ? 200 : 201, r); }
    }
    throw new ApiError(404, "not_found", "없는 경로입니다.");
  } catch (e) {
    if (e instanceof ApiError) return fail(e);
    console.error("internal error:", e instanceof Error ? e.message : String(e));
    return json(500, { error: { code: "internal", message: "서버 내부 오류" } });
  }
}
