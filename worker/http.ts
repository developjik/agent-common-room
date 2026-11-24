// Workers fetch 라우터. 로컬 Node 구현(src/http.ts)과 같은 경로·상태 코드·헤더를 유지한다.
// 오너 웹 UI 정적 파일은 Workers Static Assets가 서빙하고 CSP 등 헤더는 public/_headers가 붙인다.
import { joinInstructions } from "../src/instructions";
import { handleMcp } from "./mcp";
import { hashToken, safeEqualHex } from "./crypto";
import { ApiError, RoomServiceD1, type Agent } from "./service";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ACR_ADMIN_KEY?: string;
  ACR_PUBLIC_URL?: string;
}

const MAX_BODY = 64 * 1024;

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

async function readJson(req: Request): Promise<any> {
  // 헤더가 크기를 알려주면 본문을 읽기 전에 거른다(대형 본문의 메모리 할당 방지).
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) throw new ApiError(413, "body_too_large", "요청 본문이 너무 큽니다 (최대 64KB).");
  const text = await req.text();
  if (!text) return {};
  if (new TextEncoder().encode(text).length > MAX_BODY) throw new ApiError(413, "body_too_large", "요청 본문이 너무 큽니다 (최대 64KB).");
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "bad_json", "JSON을 해석할 수 없습니다.");
  }
}
function bearer(req: Request): string {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1] : "";
}
const obj = (b: unknown): Record<string, any> => (b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, any>) : {});

async function checkAdminKey(env: Env, req: Request): Promise<boolean> {
  const configured = env.ACR_ADMIN_KEY;
  if (!configured || configured.length < 24) return false; // 시크릿 미설정/너무 짧으면 관리자 API 전체 잠금
  return safeEqualHex(await hashToken(bearer(req)), await hashToken(configured));
}

export async function handleFetch(svc: RoomServiceD1, env: Env, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method ?? "GET";
  let m: RegExpExecArray | null;

  try {
    if (method === "GET" && path === "/healthz") return json(200, { ok: true });

    // ----- public: invite link (join request only) -----
    if ((m = /^\/join\/([^/]+)$/.exec(path)) && method === "GET") {
      const info = await svc.inviteInfo(m[1]);
      const host = /^[A-Za-z0-9.:\-\[\]]+$/.test(url.host) ? url.host : "localhost";
      const base = env.ACR_PUBLIC_URL ?? `${url.protocol}//${host}`;
      return json(200, joinInstructions(base, m[1], info));
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
      if (!(await checkAdminKey(env, req))) throw new ApiError(401, "unauthorized", "관리자 키가 필요합니다.");
      if (path === "/api/admin/rooms" && method === "POST") {
        const b = obj(await readJson(req));
        return json(201, await svc.createRoom(String(b.name ?? ""), typeof b.description === "string" ? b.description : ""));
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
      if (path === "/api/owner/messages" && method === "POST") { const r = await svc.postAsOwner(room, obj(await readJson(req))); return json(r.duplicate ? 200 : 201, r); }
      if ((m = /^\/api\/owner\/messages\/(\d+)$/.exec(path)) && method === "DELETE") { await svc.deleteMessage(room, Number(m[1])); return json(200, { deleted: true }); }
      throw new ApiError(404, "not_found", "없는 경로입니다.");
    }

    // ----- agent token authority -----
    if (path === "/mcp" || path === "/api/me" || path === "/api/room" || path === "/api/inbox" || path === "/api/ack" || path === "/api/messages") {
      const agent: Agent | null = await svc.authAgent(bearer(req));
      if (!agent) throw new ApiError(401, "unauthorized", "유효한 에이전트 토큰이 필요합니다.");
      if (path === "/mcp") {
        if (method !== "POST") return json(405, { error: { code: "method_not_allowed", message: "POST만 지원합니다 (stateless Streamable HTTP)." } }, { allow: "POST" });
        // 공식 SDK 전송이 바디 파싱/JSON-RPC 에러(-32700 등)/프로토콜 협상을 직접 처리한다.
        return await handleMcp(svc, agent, req);
      }
      if ((path === "/api/me" || path === "/api/room") && method === "GET") return json(200, await svc.roomForAgent(agent));
      if (path === "/api/inbox" && method === "GET") return json(200, await svc.inbox(agent, url.searchParams.get("limit") ?? undefined));
      if (path === "/api/ack" && method === "POST") return json(200, await svc.ack(agent, obj(await readJson(req)).seq));
      if (path === "/api/messages" && method === "GET") return json(200, await svc.readMessages(agent, Number(url.searchParams.get("after") ?? 0), url.searchParams.get("limit") ?? undefined));
      if (path === "/api/messages" && method === "POST") { const r = await svc.postAsAgent(agent, obj(await readJson(req))); return json(r.duplicate ? 200 : 201, r); }
    }
    throw new ApiError(404, "not_found", "없는 경로입니다.");
  } catch (e) {
    if (e instanceof ApiError) return fail(e);
    console.error("internal error:", e instanceof Error ? e.message : String(e));
    return json(500, { error: { code: "internal", message: "서버 내부 오류" } });
  }
}
