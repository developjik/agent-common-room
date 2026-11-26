// 런타임 공통 HTTP 라우터 (Web 표준 Request/Response).
// 로컬 Node·Vercel(runtime/node.ts의 브리지), Cloudflare Workers(worker/index.ts)가 같은 경로·
// 상태 코드·에러 형태·보안 헤더를 쓰도록 하나로 모은 구현이다.
//
// 보안 불변조건은 로컬 구현 때와 같다:
//  - 오너 UI 정적 파일은 엄격한 CSP(script-src 'self', frame-ancestors 'none')로만 제공한다.
//  - 토큰·관리자 키는 Authorization(Bearer) 또는 HttpOnly 쿠키로만 받고, 저장은 해시. 응답에 평문을 다시 담지 않는다.
//  - 관리자 키·오너 로그인은 시도 횟수를 DB에 기록해 제한한다(서버리스 여러 인스턴스에서도 공유).
//
// v2 라우팅 요약
//   공개      /join/:tok · /api/join/:tok · /api/join-requests/:id/claim
//   설정      /api/setup · /api/setup/bootstrap · /api/setup/owner · /api/cron
//   관리자    /api/admin/rooms… · /api/admin/owners/:id/rotate-secret
//   오너 계정 /api/auth/login · /api/auth/logout · /api/auth/legacy · /api/auth/upgrade
//   오너 v2   /api/me · /api/workspaces/:wid/{overview,rooms,agents,invites,join-requests,activity}
//             /api/rooms/:rid{,/messages,/invites,/members/:aid} · /api/join-requests/:jid/{approve,deny}
//   호환      /api/owner/login · /api/owner/*  (방 1개 워크스페이스로 해석, 1~2 릴리스 유지)
//   에이전트  /mcp · /api/me · /api/room · /api/inbox · /api/ack · /api/messages
//             /api/rooms/:rid/{inbox,ack,messages}
import { joinInstructions, joinPageHtml } from "./instructions.js";
import { handleMcp } from "./mcp.js";
import { hashToken, safeEqualHex } from "./crypto.js";
import { ApiError, RoomService, type Agent, type OwnerScope } from "./service.js";

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
// "/"는 web/(Vite+React) 빌드 산출물인 public/app/index.html을 서빙한다.
// 이전 콘솔은 파일을 그대로 남겨 /ui/ 에서 계속 쓸 수 있다(정책·웹훅 설정 등).
const UI_FILES: Record<string, [string, string]> = {
  "/": ["app/index.html", "text/html; charset=utf-8"],
  "/index.html": ["app/index.html", "text/html; charset=utf-8"],
  "/app": ["app/index.html", "text/html; charset=utf-8"],
  "/app/": ["app/index.html", "text/html; charset=utf-8"],
  "/ui": ["ui/index.html", "text/html; charset=utf-8"],
  "/ui/": ["ui/index.html", "text/html; charset=utf-8"],
  "/ui/app.js": ["ui/app.js", "text/javascript; charset=utf-8"],
  "/ui/style.css": ["ui/style.css", "text/css; charset=utf-8"],
  "/ui/join.js": ["ui/join.js", "text/javascript; charset=utf-8"],
};
const STATIC_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
};
const UI_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** 오너 세션 쿠키. 30일, HttpOnly, SameSite=Lax. https 요청에서만 Secure를 붙인다(로컬 http 개발 보호). */
const OWNER_COOKIE = "acr_owner";
const OWNER_COOKIE_MAX_AGE = 30 * 24 * 3600;

/** 오너 UI 정적 응답. HTML·해시된 번들 모두 같은 엄격한 CSP로만 내보낸다. */
function assetResponse(body: Uint8Array, type: string): Response {
  return new Response(body as unknown as BodyInit, {
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
const fail = (e: ApiError) => json(e.status, { error: { code: e.code, message: e.message }, ...(e.details ?? {}) });

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
function cookie(req: Request, name: string): string {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
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

function isHttps(req: Request): boolean {
  if (new URL(req.url).protocol === "https:") return true;
  return (req.headers.get("x-forwarded-proto") ?? "").split(",")[0].trim() === "https";
}

function ownerCookieHeader(token: string, secure: boolean): string {
  return `${OWNER_COOKIE}=${token}; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Path=/; Max-Age=${OWNER_COOKIE_MAX_AGE}`;
}
const CLEAR_COOKIE = (secure: boolean) => `${OWNER_COOKIE}=; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Path=/; Max-Age=0`;

/**
 * 쿠키로 인증된 상태 변경 요청의 CSRF 방어. SameSite=Lax + Origin/Sec-Fetch-Site 검사.
 * Bearer(스크립트·CLI)에는 교차 출처 컨텍스트가 없으므로 적용하지 않는다.
 */
function crossSite(req: Request): boolean {
  const site = (req.headers.get("sec-fetch-site") ?? "").toLowerCase();
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      const o = new URL(origin);
      const u = new URL(req.url);
      if (o.host !== u.host || o.protocol !== u.protocol) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** 관리자 영역 인증. 실패는 IP 단위로 세어 무차별 대입을 막는다. body 로 넘어온 키도 같은 경로로 검사한다. */
async function verifyAdminKey(svc: RoomService, env: Env, req: Request, token: string): Promise<void> {
  const scope = `admin:${clientIp(req)}`;
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
const requireAdmin = (svc: RoomService, env: Env, req: Request) => verifyAdminKey(svc, env, req, bearer(req));

interface OwnerAuth {
  scope: OwnerScope;
  token: string;
  viaCookie: boolean;
}

/**
 * 오너 요청의 주체를 해석한다. Bearer(새 오너 세션·레거시 방 세션) 우선, 없으면 쿠키.
 * 쿠키로 인증한 상태 변경 요청은 교차 사이트를 거부한다.
 */
async function ownerAuth(svc: RoomService, req: Request): Promise<OwnerAuth | null> {
  const header = bearer(req);
  const token = header || cookie(req, OWNER_COOKIE);
  if (!token) return null;
  const viaCookie = !header;
  if (token.startsWith("acr_osess_")) {
    const s = await svc.authOwnerSession(token);
    return s ? { scope: { ownerId: s.ownerId, legacyRoomId: null }, token, viaCookie } : null;
  }
  if (token.startsWith("acr_ses_")) {
    const s = await svc.authSession(token);
    return s ? { scope: { ownerId: null, legacyRoomId: s.roomId }, token, viaCookie } : null;
  }
  return null;
}

async function requireOwner(svc: RoomService, req: Request): Promise<OwnerAuth> {
  const auth = await ownerAuth(svc, req);
  if (!auth) throw new ApiError(401, "unauthorized", "오너 세션이 필요합니다. /api/auth/login 또는 /api/owner/login 으로 로그인하세요.");
  const method = req.method ?? "GET";
  if (auth.viaCookie && method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && crossSite(req)) {
    throw new ApiError(403, "cross_site", "교차 사이트 요청은 허용되지 않습니다.");
  }
  return auth;
}

/**
 * 쿠키로 인증한 오너 요청에 세션 쿠키를 다시 실어 준다. 서버 세션은 슬라이딩으로 연장되는데
 * 브라우저 쿠키는 발급 시점에 만료되므로, 앱이 시작할 때 부르는 /api/me·개요에서 함께 갱신한다.
 */
const ownerCookieRefresh = (auth: OwnerAuth, secure: boolean): Record<string, string> =>
  auth.viaCookie ? { "set-cookie": ownerCookieHeader(auth.token, secure) } : {};

/** 에이전트 토큰이면 Agent, 아니면 null. */
async function agentOrNull(svc: RoomService, req: Request): Promise<Agent | null> {
  const t = bearer(req);
  return t.startsWith("acr_agt_") ? await svc.authAgent(t) : null;
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
  const secure = isHttps(req);
  let m: RegExpExecArray | null;

  try {
    // ----- 오너 UI (정적 파일) -----
    // 고정 경로("/", "/ui/...")와 web 빌드 산출물(/app/assets/index-<hash>.js|css)을 함께 서빙한다.
    if (method === "GET" && assets) {
      const fixed = UI_FILES[path];
      if (fixed) {
        const found = await assets.read(fixed[0]);
        if (found) return assetResponse(found.body, fixed[1]);
      }
      if (/^\/(?:app|ui)\/[A-Za-z0-9._/-]+$/.test(path) && !path.includes("..")) {
        const name = path.slice(1);
        const ext = name.split(".").pop() ?? "";
        const type = STATIC_TYPES[ext];
        if (type) {
          const found = await assets.read(name);
          if (found) return assetResponse(found.body, type);
        }
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
    // 오너 계정 + 워크스페이스 + 로비를 한 번에 만든다(관리자 키 필요).
    if (method === "POST" && path === "/api/setup/owner") {
      const b = obj(await readJson(req));
      await verifyAdminKey(svc, env, req, bearer(req) || (typeof b.admin_key === "string" ? b.admin_key : ""));
      const state = await svc.setupState({ envKeyConfigured: !!envAdminKey(env), bootstrapAllowed: bootstrapAllowed(env) });
      if (!state.needs_owner) throw new ApiError(409, "already_configured", "오너 계정이 이미 있습니다. 아이디 재발급은 관리자 rotate-secret 을 쓰세요.");
      const created = await svc.createOwnerAccount({ login_id: b.login_id, password: b.password, display_name: b.display_name, workspace_name: b.workspace_name });
      return json(201, { ...created, cookie: `${OWNER_COOKIE} (HttpOnly)` }, { "set-cookie": ownerCookieHeader(created.session_token, secure) });
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
      // 기존 에이전트가 토큰을 함께 보내면 새 신원을 만들지 않고 구성원 추가 요청이 된다.
      const existing = await agentOrNull(svc, req);
      return json(201, await svc.requestJoin(m[1], obj(await readJson(req)), existing));
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
      if (path === "/api/admin/owners" && method === "GET") return json(200, { owners: await svc.listOwners() });
      if ((m = /^\/api\/admin\/owners\/([^/]+)\/rotate-secret$/.exec(path)) && method === "POST") return json(200, await svc.rotateOwnerSecret(m[1]));
      throw new ApiError(404, "not_found", "없는 경로입니다.");
    }

    // ----- 오너 계정 인증 (ID + 비밀번호) -----
    if (path === "/api/auth/login" && method === "POST") {
      const b = obj(await readJson(req));
      const res = await svc.loginOwner(b.login_id, b.password, clientIp(req));
      return json(200, res, { "set-cookie": ownerCookieHeader(res.session_token, secure) });
    }
    if (path === "/api/auth/logout" && method === "POST") {
      const auth = await ownerAuth(svc, req);
      if (auth) {
        if (auth.token.startsWith("acr_osess_")) await svc.logoutOwnerSession(auth.token, obj(await readJson(req)).all === true);
        else await svc.logout(auth.token);
      }
      return json(200, { ok: true }, { "set-cookie": CLEAR_COOKIE(secure) });
    }
    if (path === "/api/auth/legacy" && method === "POST") {
      const b = obj(await readJson(req));
      const res = await svc.legacyOwnerLogin(String(b.room_id ?? ""), String(b.owner_code ?? ""));
      return json(200, res, "session_token" in res ? { "set-cookie": ownerCookieHeader(res.session_token, secure) } : {});
    }
    if (path === "/api/auth/upgrade" && method === "POST") {
      const b = obj(await readJson(req));
      const res = await svc.upgradeLegacy(String(b.upgrade_ticket ?? ""), { login_id: b.login_id, password: b.password, display_name: b.display_name });
      return json(200, res, { "set-cookie": ownerCookieHeader(res.session_token, secure) });
    }

    // ----- human session authority (레거시: 방 ID + 오너 코드) -----
    if (path === "/api/owner/login" && method === "POST") {
      const b = obj(await readJson(req));
      return json(200, await svc.login(String(b.room_id ?? ""), String(b.owner_code ?? "")));
    }

    // ----- /api/owner/* 호환 계층 (방 1개 워크스페이스로 해석) -----
    if (path.startsWith("/api/owner/")) {
      const auth = await requireOwner(svc, req);
      const roomRow = await svc.resolveOwnerHomeRoom(auth.scope);
      const room = String(roomRow.id);
      if (path === "/api/owner/logout" && method === "POST") {
        if (auth.token.startsWith("acr_osess_")) await svc.logoutOwnerSession(auth.token);
        else await svc.logout(auth.token);
        return json(200, { ok: true }, { "set-cookie": CLEAR_COOKIE(secure) });
      }
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
      if (path === "/api/owner/messages" && method === "GET") return json(200, await svc.ownerMessages(room, Number(url.searchParams.get("after") ?? 0), url.searchParams.get("limit") ?? undefined, auth.scope));
      if (path === "/api/owner/messages" && method === "POST") { const r = await svc.postAsOwner(room, obj(await readJson(req))); if (!r.duplicate) ctx?.waitUntil?.(svc.processDueDeliveries(room).catch(() => {})); return json(r.duplicate ? 200 : 201, r); }
      if ((m = /^\/api\/owner\/messages\/(\d+)$/.exec(path)) && method === "DELETE") { await svc.deleteMessage(room, Number(m[1])); return json(200, { deleted: true }); }
      if (path === "/api/owner/webhooks" && method === "GET") return json(200, await svc.listWebhooks(room));
      if (path === "/api/owner/webhooks" && method === "POST") return json(201, await svc.createWebhook(room, obj(await readJson(req)).url));
      if ((m = /^\/api\/owner\/webhooks\/(whk_[A-Za-z0-9]+)$/.exec(path)) && method === "DELETE") { await svc.revokeWebhook(room, m[1]); return json(200, { revoked: true }); }
      if ((m = /^\/api\/owner\/webhooks\/(whk_[A-Za-z0-9]+)\/test$/.exec(path)) && method === "POST") return json(200, { delivery: await svc.testWebhook(room, m[1]) });
      throw new ApiError(404, "not_found", "없는 경로입니다.");
    }

    // ----- GET /api/me : 오너 계정 또는 에이전트 -----
    if (path === "/api/me" && method === "GET") {
      const agent = await agentOrNull(svc, req);
      if (agent) return json(200, await svc.agentMe(agent));
      const auth = await requireOwner(svc, req);
      if (!auth.scope.ownerId) throw new ApiError(403, "legacy_session", "레거시 방 세션입니다. /api/auth/legacy 로 계정 로그인으로 옮기세요.");
      return json(200, await svc.ownerMe(auth.scope.ownerId), ownerCookieRefresh(auth, secure));
    }

    // ----- 오너 v2: 워크스페이스 -----
    if ((m = /^\/api\/workspaces\/([^/]+)(\/.*)?$/.exec(path))) {
      const wid = m[1];
      const rest = m[2] ?? "";
      const auth = await requireOwner(svc, req);
      if (rest === "/overview" && method === "GET") return json(200, await svc.workspaceOverview(auth.scope, wid), ownerCookieRefresh(auth, secure));
      if (rest === "/rooms" && method === "POST") return json(201, await svc.createRoomForWorkspace(auth.scope, wid, obj(await readJson(req))));
      if (rest === "/agents" && method === "GET") return json(200, { agents: await svc.workspaceAgents(auth.scope, wid) });
      if ((m = /^\/agents\/([^/]+)\/rooms$/.exec(rest)) && method === "POST") return json(200, await svc.placeAgent(auth.scope, wid, m[1], obj(await readJson(req))));
      if ((m = /^\/agents\/([^/]+)\/revoke$/.exec(rest)) && method === "POST") return json(200, await svc.revokeWorkspaceAgent(auth.scope, wid, m[1]));
      if (rest === "/invites" && method === "POST") return json(201, await svc.createPoolInvite(auth.scope, wid, obj(await readJson(req))));
      if (rest === "/join-requests" && method === "GET") return json(200, { requests: await svc.workspaceJoinRequests(auth.scope, wid, url.searchParams.get("status") ?? undefined) });
      if (rest === "/activity" && method === "GET") return json(200, await svc.workspaceActivity(auth.scope, wid, url.searchParams.get("limit") ?? undefined));
      throw new ApiError(404, "not_found", "없는 경로입니다.");
    }

    // ----- 오너 v2: 방 (에이전트 경로와 겹치므로 토큰 종류로 나눈다) -----
    if ((m = /^\/api\/rooms\/([^/]+)(\/.*)?$/.exec(path))) {
      const rid = m[1];
      const rest = m[2] ?? "";
      const agent = await agentOrNull(svc, req);
      if (agent) {
        if (rest === "/inbox" && method === "GET") return json(200, await svc.inbox(agent, url.searchParams.get("limit") ?? undefined, url.searchParams.get("wait") ?? undefined, bearer(req), rid));
        if (rest === "/ack" && method === "POST") return json(200, await svc.ack(agent, obj(await readJson(req)).seq, rid));
        if (rest === "/messages" && method === "GET") return json(200, await svc.readMessages(agent, Number(url.searchParams.get("after") ?? 0), url.searchParams.get("limit") ?? undefined, rid));
        if (rest === "/messages" && method === "POST") {
          const r = await svc.postAsAgent(agent, obj(await readJson(req)), rid);
          if (!r.duplicate) ctx?.waitUntil?.(svc.processDueDeliveries(rid).catch(() => {}));
          return json(r.duplicate ? 200 : 201, r);
        }
        if (rest === "" && method === "GET") return json(200, await svc.roomForAgent(agent, rid));
        throw new ApiError(404, "not_found", "없는 경로입니다.");
      }
      const auth = await requireOwner(svc, req);
      if (rest === "" && method === "GET") return json(200, await svc.ownerRoomDetail(auth.scope, rid));
      if (rest === "" && method === "PATCH") return json(200, await svc.updateRoomForOwner(auth.scope, rid, obj(await readJson(req))));
      if (rest === "" && method === "DELETE") return json(200, await svc.deleteRoomForOwner(auth.scope, rid));
      if (rest === "/messages" && method === "GET") { await svc.assertOwnerRoom(auth.scope, rid); return json(200, await svc.ownerMessages(rid, Number(url.searchParams.get("after") ?? 0), url.searchParams.get("limit") ?? undefined, auth.scope)); }
      if (rest === "/messages" && method === "POST") {
        await svc.assertOwnerRoom(auth.scope, rid);
        const r = await svc.postAsOwner(rid, obj(await readJson(req)));
        if (!r.duplicate) ctx?.waitUntil?.(svc.processDueDeliveries(rid).catch(() => {}));
        return json(r.duplicate ? 200 : 201, r);
      }
      if ((m = /^\/messages\/(\d+)$/.exec(rest)) && method === "DELETE") { await svc.assertOwnerRoom(auth.scope, rid); await svc.deleteMessage(rid, Number(m[1])); return json(200, { deleted: true }); }
      if (rest === "/invites" && method === "POST") { await svc.assertOwnerRoom(auth.scope, rid); return json(201, await svc.createInvite(rid, obj(await readJson(req)))); }
      if (rest === "/invites" && method === "GET") { await svc.assertOwnerRoom(auth.scope, rid); return json(200, { invites: await svc.listInvites(rid) }); }
      if ((m = /^\/invites\/([^/]+)$/.exec(rest)) && method === "DELETE") { await svc.assertOwnerRoom(auth.scope, rid); await svc.revokeInvite(rid, m[1]); return json(200, { revoked: true }); }
      if ((m = /^\/members\/([^/]+)$/.exec(rest)) && method === "PATCH") return json(200, await svc.updateMembership(auth.scope, rid, m[1], obj(await readJson(req))));
      if ((m = /^\/members\/([^/]+)$/.exec(rest)) && method === "DELETE") return json(200, await svc.removeMembership(auth.scope, rid, m[1]));
      if (rest === "/webhooks" && method === "GET") { await svc.assertOwnerRoom(auth.scope, rid); return json(200, await svc.listWebhooks(rid)); }
      throw new ApiError(404, "not_found", "없는 경로입니다.");
    }

    // ----- 오너 v2: 참여 요청 승인/거부 (요청 ID만으로) -----
    if ((m = /^\/api\/join-requests\/([^/]+)\/(approve|deny)$/.exec(path)) && method === "POST") {
      const auth = await requireOwner(svc, req);
      if (m[2] === "approve") return json(200, await svc.approveJoinRequest(auth.scope, m[1], obj(await readJson(req)) as any));
      await svc.denyJoinRequest(auth.scope, m[1]);
      return json(200, { denied: true });
    }

    // ----- agent token authority (v1 호환 경로) -----
    if (path === "/mcp" || path === "/api/room" || path === "/api/inbox" || path === "/api/ack" || path === "/api/messages") {
      const agent: Agent | null = await svc.authAgent(bearer(req));
      if (!agent) throw new ApiError(401, "unauthorized", "유효한 에이전트 토큰이 필요합니다.");
      if (path === "/mcp") {
        if (method !== "POST") return json(405, { error: { code: "method_not_allowed", message: "POST만 지원합니다 (stateless Streamable HTTP)." } }, { allow: "POST" });
        // 공식 SDK 전송이 바디 파싱/JSON-RPC 에러(-32700 등)/프로토콜 협상을 직접 처리한다.
        const res = await handleMcp(svc, agent, req);
        ctx?.waitUntil?.(svc.processDueDeliveries(agent.room_id).catch(() => {}));
        return res;
      }
      if (path === "/api/room" && method === "GET") return json(200, await svc.roomForAgent(agent));
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
