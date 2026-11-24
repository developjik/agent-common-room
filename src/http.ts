import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { ApiError, type RoomService, type Agent } from "./service.js";
import { handleMcp } from "./mcp.js";
import { joinInstructions } from "./instructions.js";

const MAX_BODY = 64 * 1024;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(text);
}
const fail = (res: ServerResponse, e: ApiError) => send(res, e.status, { error: { code: e.code, message: e.message } });

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new ApiError(413, "body_too_large", "요청 본문이 너무 큽니다 (최대 64KB).");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "bad_json", "JSON을 해석할 수 없습니다.");
  }
}
function bearer(req: IncomingMessage): string {
  const h = req.headers.authorization ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : "";
}
const obj = (b: unknown): Record<string, any> => (b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, any>) : {});

export interface ServerOptions { publicUrl?: string }

export function createApp(svc: RoomService, opts: ServerOptions = {}): Server {
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const q = url.searchParams;
    let m: RegExpExecArray | null;

    if (method === "GET" && path === "/healthz") return send(res, 200, { ok: true });

    // ----- public: invite link (join request only) -----
    if ((m = /^\/join\/([^/]+)$/.exec(path)) && method === "GET") {
      const info = svc.inviteInfo(m[1]);
      const base = opts.publicUrl ?? `http://${/^[A-Za-z0-9.:\-\[\]]+$/.test(req.headers.host ?? "") ? req.headers.host : "localhost"}`;
      return send(res, 200, joinInstructions(base, m[1], info));
    }
    if ((m = /^\/api\/join\/([^/]+)$/.exec(path)) && method === "POST") {
      return send(res, 201, svc.requestJoin(m[1], obj(await readJson(req))));
    }
    if ((m = /^\/api\/join-requests\/([^/]+)\/claim$/.exec(path)) && method === "POST") {
      const b = obj(await readJson(req));
      if (typeof b.claim_secret !== "string") throw new ApiError(400, "bad_claim", "claim_secret이 필요합니다.");
      return send(res, 200, svc.claim(m[1], b.claim_secret));
    }

    // ----- admin authority -----
    if (path.startsWith("/api/admin/")) {
      if (!svc.checkAdminKey(bearer(req))) throw new ApiError(401, "unauthorized", "관리자 키가 필요합니다.");
      if (path === "/api/admin/rooms" && method === "POST") {
        const b = obj(await readJson(req));
        return send(res, 201, svc.createRoom(String(b.name ?? ""), typeof b.description === "string" ? b.description : ""));
      }
      if (path === "/api/admin/rooms" && method === "GET") return send(res, 200, { rooms: svc.listRooms() });
      if ((m = /^\/api\/admin\/rooms\/([^/]+)\/rotate-owner-code$/.exec(path)) && method === "POST") return send(res, 200, svc.rotateOwnerCode(m[1]));
      if ((m = /^\/api\/admin\/rooms\/([^/]+)$/.exec(path)) && method === "DELETE") { svc.deleteRoom(m[1]); return send(res, 200, { deleted: true }); }
      throw new ApiError(404, "not_found", "없는 경로입니다.");
    }

    // ----- human session authority -----
    if (path === "/api/owner/login" && method === "POST") {
      const b = obj(await readJson(req));
      return send(res, 200, svc.login(String(b.room_id ?? ""), String(b.owner_code ?? "")));
    }
    if (path.startsWith("/api/owner/")) {
      const token = bearer(req);
      const sess = svc.authSession(token);
      if (!sess) throw new ApiError(401, "unauthorized", "오너 세션이 필요합니다. /api/owner/login 으로 로그인하세요.");
      const room = sess.roomId;
      if (path === "/api/owner/logout" && method === "POST") { svc.logout(token); return send(res, 200, { ok: true }); }
      if (path === "/api/owner/room" && method === "GET") return send(res, 200, svc.getRoomOwner(room));
      if (path === "/api/owner/room" && method === "PATCH") return send(res, 200, svc.updateRoom(room, obj(await readJson(req))));
      if (path === "/api/owner/invites" && method === "POST") return send(res, 201, svc.createInvite(room, obj(await readJson(req))));
      if (path === "/api/owner/invites" && method === "GET") return send(res, 200, { invites: svc.listInvites(room) });
      if ((m = /^\/api\/owner\/invites\/([^/]+)$/.exec(path)) && method === "DELETE") { svc.revokeInvite(room, m[1]); return send(res, 200, { revoked: true }); }
      if (path === "/api/owner/join-requests" && method === "GET") return send(res, 200, { requests: svc.listJoinRequests(room, q.get("status") ?? undefined) });
      if ((m = /^\/api\/owner\/join-requests\/([^/]+)\/approve$/.exec(path)) && method === "POST") return send(res, 200, svc.approveJoin(room, m[1], obj(await readJson(req)) as any));
      if ((m = /^\/api\/owner\/join-requests\/([^/]+)\/deny$/.exec(path)) && method === "POST") { svc.denyJoin(room, m[1]); return send(res, 200, { denied: true }); }
      if (path === "/api/owner/agents" && method === "GET") return send(res, 200, { agents: svc.listAgents(room) });
      if ((m = /^\/api\/owner\/agents\/([^/]+)\/revoke$/.exec(path)) && method === "POST") { svc.revokeAgent(room, m[1]); return send(res, 200, { revoked: true }); }
      if (path === "/api/owner/messages" && method === "GET") return send(res, 200, svc.ownerMessages(room, Number(q.get("after") ?? 0), q.get("limit") ?? undefined));
      if (path === "/api/owner/messages" && method === "POST") { const r = svc.postAsOwner(room, obj(await readJson(req))); return send(res, r.duplicate ? 200 : 201, r); }
      if ((m = /^\/api\/owner\/messages\/(\d+)$/.exec(path)) && method === "DELETE") { svc.deleteMessage(room, Number(m[1])); return send(res, 200, { deleted: true }); }
      throw new ApiError(404, "not_found", "없는 경로입니다.");
    }

    // ----- agent token authority -----
    if (path === "/mcp" || path === "/api/me" || path === "/api/room" || path === "/api/inbox" || path === "/api/ack" || path === "/api/messages") {
      const agent: Agent | null = svc.authAgent(bearer(req));
      if (!agent) throw new ApiError(401, "unauthorized", "유효한 에이전트 토큰이 필요합니다.");
      if (path === "/mcp") {
        if (method !== "POST") return send(res, 405, { error: { code: "method_not_allowed", message: "POST만 지원합니다 (stateless Streamable HTTP)." } }, { allow: "POST" });
        return handleMcp(svc, agent, req, res, await readJson(req));
      }
      if ((path === "/api/me" || path === "/api/room") && method === "GET") return send(res, 200, svc.roomForAgent(agent));
      if (path === "/api/inbox" && method === "GET") return send(res, 200, svc.inbox(agent, q.get("limit") ?? undefined));
      if (path === "/api/ack" && method === "POST") return send(res, 200, svc.ack(agent, obj(await readJson(req)).seq));
      if (path === "/api/messages" && method === "GET") return send(res, 200, svc.readMessages(agent, Number(q.get("after") ?? 0), q.get("limit") ?? undefined));
      if (path === "/api/messages" && method === "POST") { const r = svc.postAsAgent(agent, obj(await readJson(req))); return send(res, r.duplicate ? 200 : 201, r); }
    }
    throw new ApiError(404, "not_found", "없는 경로입니다.");
  };

  return createServer((req, res) => {
    handler(req, res).catch(e => {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof ApiError) return fail(res, e);
      console.error("internal error:", e instanceof Error ? e.message : String(e));
      send(res, 500, { error: { code: "internal", message: "서버 내부 오류" } });
    });
  });
}
