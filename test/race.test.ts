import test from "node:test";
import assert from "node:assert/strict";
import { start } from "./helpers.js";

// 경합/부분실패 불변조건 테스트. helpers가 ACR_EXTERNAL_BASE를 지원하므로
// 같은 파일이 로컬 Node(BEGIN IMMEDIATE)와 Workers+D1(조건부 UPDATE+batch) 양쪽을 검증한다.
// 특히 D1 포트의 claim/approve 보상(compensation)이 승자 상태를 훼손하지 않는지 확인한다.

test("동시 claim 경합: 한 번만 발급되고 승자 토큰은 유효하다", async () => {
  const t = await start();
  try {
    const r = await t.setupRoom();
    const jr = (await t.call("POST", `/api/join/${r.invite}`, undefined, { display_name: "racer", product: "test" })).json;
    const pending = (await t.call("POST", `/api/join-requests/${jr.request_id}/claim`, undefined, { claim_secret: jr.claim_secret })).json;
    assert.equal(pending.status, "pending");
    assert.equal((await t.call("POST", `/api/owner/join-requests/${jr.request_id}/approve`, r.sess)).status, 200);

    const [c1, c2] = await Promise.all([
      t.call("POST", `/api/join-requests/${jr.request_id}/claim`, undefined, { claim_secret: jr.claim_secret }),
      t.call("POST", `/api/join-requests/${jr.request_id}/claim`, undefined, { claim_secret: jr.claim_secret }),
    ]);
    const statuses = [c1.status, c2.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const winner = c1.status === 200 ? c1 : c2;
    // 패자의 보상이 승자의 토큰을 되돌리지 않았어야 한다: 발급 토큰으로 인증 성공.
    const me = await t.call("GET", "/api/me", winner.json.agent_token);
    assert.equal(me.status, 200);
    assert.equal(me.json.you.name, "racer");
  } finally { await t.close(); }
});

test("동시 approve 경합: 한 번만 승인되고 참여자는 하나만 생긴다", async () => {
  const t = await start();
  try {
    const r = await t.setupRoom();
    const jr = (await t.call("POST", `/api/join/${r.invite}`, undefined, { display_name: "apprace", product: "test" })).json;
    const [a1, a2] = await Promise.all([
      t.call("POST", `/api/owner/join-requests/${jr.request_id}/approve`, r.sess),
      t.call("POST", `/api/owner/join-requests/${jr.request_id}/approve`, r.sess),
    ]);
    const statuses = [a1.status, a2.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    // 승인된 요청은 정상적으로 claim 가능해야 한다(패자의 보상이 승자 상태를 망가뜨리지 않음).
    const cl = (await t.call("POST", `/api/join-requests/${jr.request_id}/claim`, undefined, { claim_secret: jr.claim_secret })).json;
    assert.ok(cl.agent_token);
    const me = await t.call("GET", "/api/me", cl.agent_token);
    const named = me.json.participants.filter((p: { name: string }) => p.name === "apprace");
    assert.equal(named.length, 1);
  } finally { await t.close(); }
});

test("approve 이름 경합: 같은 이름 동시 승인은 하나만 성공한다", async () => {
  const t = await start();
  try {
    const r = await t.setupRoom();
    const mk = async (name: string) => (await t.call("POST", `/api/join/${r.invite}`, undefined, { display_name: name, product: "test" })).json;
    const j1 = await mk("name-a");
    const j2 = await mk("name-b");
    const [a1, a2] = await Promise.all([
      t.call("POST", `/api/owner/join-requests/${j1.request_id}/approve`, r.sess, { name: "same-name" }),
      t.call("POST", `/api/owner/join-requests/${j2.request_id}/approve`, r.sess, { name: "same-name" }),
    ]);
    const statuses = [a1.status, a2.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const loser = a1.status === 409 ? a1 : a2;
    assert.equal(loser.json.error.code, "name_taken");
    const winnerJ = a1.status === 200 ? j1 : j2;
    const cl = (await t.call("POST", `/api/join-requests/${winnerJ.request_id}/claim`, undefined, { claim_secret: winnerJ.claim_secret })).json;
    const me = await t.call("GET", "/api/me", cl.agent_token);
    assert.equal(me.json.participants.filter((p: { name: string }) => p.name === "same-name").length, 1);
    // 패자 측 join request는 승인되지 않은 상태로 남아 있어야 한다(재승인 시도 가능).
    const reqs = await t.call("GET", "/api/owner/join-requests?status=pending", r.sess);
    assert.ok(reqs.json.requests.length >= 1);
  } finally { await t.close(); }
});

test("초대 max_uses 경합: 1회 초대에 동시 2요청이면 하나만 생성된다", async () => {
  const t = await start();
  try {
    const r = await t.setupRoom();
    const one = (await t.call("POST", "/api/owner/invites", r.sess, { max_uses: 1 })).json.invite_token as string;
    const [j1, j2] = await Promise.all([
      t.call("POST", `/api/join/${one}`, undefined, { display_name: "u1", product: "test" }),
      t.call("POST", `/api/join/${one}`, undefined, { display_name: "u2", product: "test" }),
    ]);
    const statuses = [j1.status, j2.status].sort();
    assert.deepEqual(statuses, [201, 404]);
    const loser = j1.status === 404 ? j1 : j2;
    assert.equal(loser.json.error.code, "invite_invalid");
  } finally { await t.close(); }
});

test("일시정지 중 전송은 423이고 seq에 구멍이 생기지 않는다", async () => {
  const t = await start();
  try {
    const r = await t.setupRoom();
    const a = await t.join(r, "pauser");
    const p1 = await t.call("POST", "/api/messages", a.token, { client_id: "p1", content: "첫 메시지" });
    assert.equal(p1.status, 201);
    assert.equal(p1.json.message.seq, 1);
    assert.equal((await t.call("PATCH", "/api/owner/room", r.sess, { paused: true })).status, 200);
    const blocked = await t.call("POST", "/api/messages", a.token, { client_id: "p2", content: "정지 중 메시지" });
    assert.equal(blocked.status, 423);
    assert.equal(blocked.json.error.code, "room_paused");
    assert.equal((await t.call("PATCH", "/api/owner/room", r.sess, { paused: false })).status, 200);
    const p3 = await t.call("POST", "/api/messages", a.token, { client_id: "p3", content: "재개 후 메시지" });
    assert.equal(p3.status, 201);
    assert.equal(p3.json.message.seq, 2); // 구멍 없이 연속
  } finally { await t.close(); }
});
