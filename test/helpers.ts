import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { openDb } from "../src/db.js";
import { RoomService, type Clock } from "../src/service.js";
import { createApp } from "../src/http.js";
import { hashToken } from "../src/crypto.js";

export const ADMIN_KEY = process.env.ACR_ADMIN_KEY ?? "test-admin-key-0123456789abcdef";

// ACR_EXTERNAL_BASE가 있으면 로컬 서버를 띄우지 않고 그 주소(예: wrangler dev의 Workers+D1)를 대상으로 돌린다.
// 이 모드에서는 svc/clock이 없어서 DB 직접 조회나 시계 조작이 필요한 검사는 각 테스트에서 건너뛴다.
export const EXTERNAL = !!process.env.ACR_EXTERNAL_BASE;

export class FakeClock implements Clock {
  t = Date.UTC(2026, 0, 1);
  now() { return this.t; }
  advance(ms: number) { this.t += ms; }
}

export async function start() {
  if (EXTERNAL) {
    const base = process.env.ACR_EXTERNAL_BASE!.replace(/\/$/, "");
    async function call(method: string, path: string, token?: string, body?: unknown) {
      const res = await fetch(base + path, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* text */ }
      return { status: res.status, json, text };
    }
    async function setupRoom() {
      const room = (await call("POST", "/api/admin/rooms", ADMIN_KEY, { name: "테스트 방" })).json;
      const sess = (await call("POST", "/api/owner/login", undefined, { room_id: room.room_id, owner_code: room.owner_code })).json.session_token as string;
      const invite = (await call("POST", "/api/owner/invites", sess, { max_uses: 20 })).json.invite_token as string;
      return { roomId: room.room_id as string, ownerCode: room.owner_code as string, sess, invite };
    }
    async function join(r: { sess: string; invite: string }, name: string, opts: Record<string, unknown> = {}) {
      const jr = (await call("POST", `/api/join/${r.invite}`, undefined, { display_name: name, product: "test" })).json;
      const pending = (await call("POST", `/api/join-requests/${jr.request_id}/claim`, undefined, { claim_secret: jr.claim_secret })).json;
      if (pending.status !== "pending") throw new Error("expected pending");
      const ap = await call("POST", `/api/owner/join-requests/${jr.request_id}/approve`, r.sess, opts);
      if (ap.status !== 200) throw new Error("approve failed " + ap.text);
      const cl = (await call("POST", `/api/join-requests/${jr.request_id}/claim`, undefined, { claim_secret: jr.claim_secret })).json;
      return { token: cl.agent_token as string, id: cl.agent_id as string, requestId: jr.request_id as string, claimSecret: jr.claim_secret as string };
    }
    return { svc: null as any, clock: null as any, server: null as any, base, call, setupRoom, join, close: () => Promise.resolve() };
  }
  const clock = new FakeClock();
  const svc = new RoomService(openDb(":memory:"), clock);
  svc.setAdminKeyHash(hashToken(ADMIN_KEY));
  const server: Server = createApp(svc, { publicUrl: "http://test.invalid" });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function call(method: string, path: string, token?: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, json, text };
  }
  /** Full owner setup: room, owner session, one invite. */
  async function setupRoom() {
    const room = (await call("POST", "/api/admin/rooms", ADMIN_KEY, { name: "테스트 방" })).json;
    const sess = (await call("POST", "/api/owner/login", undefined, { room_id: room.room_id, owner_code: room.owner_code })).json.session_token as string;
    const invite = (await call("POST", "/api/owner/invites", sess, { max_uses: 20 })).json.invite_token as string;
    return { roomId: room.room_id as string, ownerCode: room.owner_code as string, sess, invite };
  }
  /** Join an agent through the real flow. */
  async function join(r: { sess: string; invite: string }, name: string, opts: Record<string, unknown> = {}) {
    const jr = (await call("POST", `/api/join/${r.invite}`, undefined, { display_name: name, product: "test" })).json;
    const pending = (await call("POST", `/api/join-requests/${jr.request_id}/claim`, undefined, { claim_secret: jr.claim_secret })).json;
    if (pending.status !== "pending") throw new Error("expected pending");
    const ap = await call("POST", `/api/owner/join-requests/${jr.request_id}/approve`, r.sess, opts);
    if (ap.status !== 200) throw new Error("approve failed " + ap.text);
    const cl = (await call("POST", `/api/join-requests/${jr.request_id}/claim`, undefined, { claim_secret: jr.claim_secret })).json;
    return { token: cl.agent_token as string, id: cl.agent_id as string, requestId: jr.request_id as string, claimSecret: jr.claim_secret as string };
  }
  return { svc, clock, server, base, call, setupRoom, join, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

