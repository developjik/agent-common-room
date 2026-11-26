// 1단계 즉시 입장(v2.1): 유효한 초대 링크로 POST /api/join 을 한 번 부르면
// 그 자리에서 active 신원 + 초대된 방의 활성 멤버십 + agent_token 이 생기고,
// 오너 승인·claim 왕복이 없다. 예전 2단계는 "instant": false 로 남아 있다.
import test from "node:test";
import assert from "node:assert/strict";
import { ADMIN_KEY, start } from "./helpers.js";

async function workspace(t: Awaited<ReturnType<typeof start>>, login: string) {
  const own = await t.call("POST", "/api/setup/owner", ADMIN_KEY, {
    login_id: login, password: "long-enough-password", workspace_name: "우리 집",
  });
  const owner = own.json.session_token as string;
  const wid = own.json.workspace.id as string;
  const lobbyId = own.json.workspace.lobby_room_id as string;
  return { owner, wid, lobbyId };
}

test("초대 링크 한 번: 신원·방 멤버십·토큰이 즉시 생기고 바로 대화할 수 있다", async () => {
  const t = await start();
  try {
    const { owner, wid, lobbyId } = await workspace(t, "instant1");
    const room = (await t.call("POST", `/api/workspaces/${wid}/rooms`, owner, { name: "회의실" })).json;
    const invite = (await t.call("POST", `/api/rooms/${room.id}/invites`, owner, { max_uses: 1, ttl_hours: 24 })).json;

    const joined = await t.call("POST", `/api/join/${invite.invite_token}`, undefined, { display_name: "피클", product: "Pickle" });
    assert.equal(joined.status, 201);
    assert.equal(joined.json.status, "joined", "승인 대기가 아니라 즉시 입장");
    assert.match(joined.json.agent_token, /^acr_agt_/, "토큰을 그 자리에서 받는다");
    assert.equal(joined.json.room_id, room.id, "방 초대의 대표 방은 초대된 그 방이다(로비가 아니다)");
    assert.equal(joined.json.lobby_room_id, lobbyId, "로비는 lobby_room_id 로 따로 알려 준다");
    assert.deepEqual([...joined.json.rooms].sort(), [lobbyId, room.id].sort(), "로비 + 초대된 방");
    assert.ok(joined.json.next_steps.some((s: string) => /inbox/.test(s)), "응답만 읽고도 다음 행동(대화 시작)을 알 수 있다");
    assert.ok(joined.json.next_steps.some((s: string) => /멈추지 마세요/.test(s)), "입장만 하고 멈추지 말라는 안내");

    // 바로 대화: 받은편지함·전송이 승인 없이 동작한다.
    assert.equal((await t.call("GET", "/api/me", joined.json.agent_token)).status, 200);
    const posted = await t.call("POST", `/api/rooms/${room.id}/messages`, joined.json.agent_token, {
      client_id: "j-1", content: "바로 들어왔습니다", kind: "answer",
    });
    assert.equal(posted.status, 201);

    // 오너 화면: 승인 대기 0, 활성 비서로 보이고, 방 구성원 수에 포함된다.
    const ov = (await t.call("GET", `/api/workspaces/${wid}/overview`, owner)).json;
    assert.equal(ov.pending_requests, 0, "오너가 승인할 것이 없다");
    const pool = (await t.call("GET", `/api/workspaces/${wid}/agents`, owner)).json.agents;
    assert.equal(pool.length, 1);
    assert.equal(pool[0].status, "active");
    assert.equal(ov.agents.filter((a: any) => a.status === "active").length, 1);
    assert.equal(ov.rooms.find((r: any) => r.id === room.id).member_count, 1);

    // 입장 이력은 join_requests 에 approved·claimed 로 남는다(누가 언제 들어왔는지).
    const requests = (await t.call("GET", `/api/workspaces/${wid}/join-requests`, owner)).json.requests;
    assert.equal(requests.length, 1);
    assert.equal(requests[0].status, "approved");
    assert.equal(requests[0].claimed, true);
    assert.equal(requests[0].agent_id, joined.json.agent_id);
  } finally { await t.close(); }
});

test("1회 초대는 한 번만: 두 번째 호출은 404 이고 사용 횟수는 1/1 이다", async () => {
  const t = await start();
  try {
    const { owner, wid } = await workspace(t, "instant2");
    const invite = (await t.call("POST", `/api/workspaces/${wid}/invites`, owner, { max_uses: 1 })).json;
    const first = await t.call("POST", `/api/join/${invite.invite_token}`, undefined, { display_name: "하나" });
    assert.equal(first.status, 201);
    const second = await t.call("POST", `/api/join/${invite.invite_token}`, undefined, { display_name: "둘" });
    assert.equal(second.status, 404);
    assert.equal(second.json.error.code, "invite_invalid");
    const [inv] = (await t.call("GET", `/api/rooms/${first.json.room_id}/invites`, owner)).json.invites;
    assert.equal(inv.uses, 1);
    assert.equal(inv.max_uses, 1);
  } finally { await t.close(); }
});

test("이름 충돌은 409 name_taken 이고 그 초대의 사용 횟수는 차감되지 않는다", async () => {
  const t = await start();
  try {
    const { owner, wid } = await workspace(t, "instant3");
    const a = (await t.call("POST", `/api/workspaces/${wid}/invites`, owner, { max_uses: 5 })).json;
    const b = (await t.call("POST", `/api/workspaces/${wid}/invites`, owner, { max_uses: 5 })).json;
    assert.equal((await t.call("POST", `/api/join/${a.invite_token}`, undefined, { display_name: "피클" })).status, 201);

    const dup = await t.call("POST", `/api/join/${b.invite_token}`, undefined, { display_name: "피클" });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error.code, "name_taken");
    assert.match(dup.json.error.message, /초대 사용 횟수는 차감되지 않았습니다/);
    const raw = t.sqlite.raw.prepare("SELECT uses, max_uses FROM invites WHERE id=?").get(b.invite_id) as any;
    assert.equal(Number(raw.uses), 0, "충돌한 호출은 한 트랜잭션으로 롤백된다");

    const agents = (await t.call("GET", `/api/workspaces/${wid}/agents`, owner)).json.agents;
    assert.equal(agents.length, 1, "같은 이름의 신원이 두 개 생기지 않는다");

    // 같은 초대 링크로 다른 이름을 대면 그대로 들어간다(막다른 길 없음).
    assert.equal((await t.call("POST", `/api/join/${b.invite_token}`, undefined, { display_name: "피클 2" })).status, 201);
  } finally { await t.close(); }
});

test("풀 초대는 대표 방이 로비다(방 초대와 구분된다)", async () => {
  const t = await start();
  try {
    const { owner, wid, lobbyId } = await workspace(t, "instant-pool");
    // 로비가 아닌 방도 하나 만들어, 풀 초대가 그 방을 가리키지 않는지 확인한다.
    const room = (await t.call("POST", `/api/workspaces/${wid}/rooms`, owner, { name: "회의실" })).json;
    const invite = (await t.call("POST", `/api/workspaces/${wid}/invites`, owner, {})).json;
    assert.equal(invite.kind, "pool");
    const joined = await t.call("POST", `/api/join/${invite.invite_token}`, undefined, { display_name: "풀비서" });
    assert.equal(joined.status, 201);
    assert.equal(joined.json.room_id, lobbyId, "풀 초대의 대표 방은 로비");
    assert.equal(joined.json.lobby_room_id, lobbyId);
    assert.deepEqual(joined.json.rooms, [lobbyId], "풀 초대는 로비 하나");
    assert.ok(!joined.json.rooms.includes(room.id));
  } finally { await t.close(); }
});

test("이미 토큰이 있는 비서: 새 토큰 없이 그 방의 구성원만 추가된다", async () => {
  const t = await start();
  try {
    const { owner, wid } = await workspace(t, "instant4");
    const room = (await t.call("POST", `/api/workspaces/${wid}/rooms`, owner, { name: "연구방" })).json;
    const pool = (await t.call("POST", `/api/workspaces/${wid}/invites`, owner, {})).json;
    const first = await t.call("POST", `/api/join/${pool.invite_token}`, undefined, { display_name: "피클", product: "Pickle" });
    const token = first.json.agent_token as string;

    const roomInvite = (await t.call("POST", `/api/rooms/${room.id}/invites`, owner, {})).json;
    const again = await t.call("POST", `/api/join/${roomInvite.invite_token}`, token, { display_name: "피클" });
    assert.equal(again.status, 201);
    assert.equal(again.json.status, "joined");
    assert.equal(again.json.existing_agent, true);
    assert.equal(again.json.agent_id, first.json.agent_id);
    assert.equal(again.json.agent_token, undefined, "새 토큰을 발급하지 않는다");
    assert.equal(again.json.room_id, room.id, "기존 토큰으로 방 초대를 받아도 대표 방은 초대된 그 방");

    const me = (await t.call("GET", "/api/me", token)).json;
    assert.deepEqual(me.rooms.map((r: any) => r.name).sort(), ["로비", "연구방"].sort());
    assert.equal(me.rooms.every((r: any) => r.you.status === "active"), true, "두 방 모두 활성 멤버십");
    assert.equal((await t.call("GET", `/api/workspaces/${wid}/agents`, owner)).json.agents.length, 1);
  } finally { await t.close(); }
});

test("즉시 입장은 지난 대화를 보지 못한다(참여 이후부터)", async () => {
  const t = await start();
  try {
    const { owner, wid, lobbyId } = await workspace(t, "instant5");
    await t.call("POST", `/api/rooms/${lobbyId}/messages`, owner, { client_id: "before", content: "들어오기 전 대화" });
    const invite = (await t.call("POST", `/api/workspaces/${wid}/invites`, owner, {})).json;
    const joined = await t.call("POST", `/api/join/${invite.invite_token}`, undefined, { display_name: "늦은 비서" });
    const inbox = (await t.call("GET", `/api/rooms/${lobbyId}/inbox`, joined.json.agent_token)).json;
    assert.equal(inbox.messages.length, 0, "이전 글은 읽히지 않는다");

    await t.call("POST", `/api/rooms/${lobbyId}/messages`, owner, { client_id: "after", content: "들어온 뒤 대화" });
    const after = (await t.call("GET", `/api/rooms/${lobbyId}/inbox`, joined.json.agent_token)).json;
    assert.equal(after.messages.length, 1);
    assert.equal(after.messages[0].content, "들어온 뒤 대화");
  } finally { await t.close(); }
});

test("레거시 2단계는 instant:false 로 그대로 남아 있다(참여 요청 → 승인 → claim)", async () => {
  const t = await start();
  try {
    const { owner, wid } = await workspace(t, "legacy-join");
    const invite = (await t.call("POST", `/api/workspaces/${wid}/invites`, owner, {})).json;
    const jr = (await t.call("POST", `/api/join/${invite.invite_token}`, undefined, { display_name: "승인제", instant: false })).json;
    assert.equal(jr.status, "pending");
    assert.equal(jr.agent_token, undefined, "아직 토큰이 없다");
    assert.equal((await t.call("GET", `/api/workspaces/${wid}/overview`, owner)).json.pending_requests, 1);
    const claimedBefore = (await t.call("POST", `/api/join-requests/${jr.request_id}/claim`, undefined, { claim_secret: jr.claim_secret })).json;
    assert.equal(claimedBefore.status, "pending", "승인 전에는 토큰이 나오지 않는다");

    assert.equal((await t.call("POST", `/api/join-requests/${jr.request_id}/approve`, owner, { history: "all" })).status, 200);
    const claimed = (await t.call("POST", `/api/join-requests/${jr.request_id}/claim`, undefined, { claim_secret: jr.claim_secret })).json;
    assert.equal(claimed.status, "approved");
    assert.match(claimed.agent_token, /^acr_agt_/);
  } finally { await t.close(); }
});

test("마지막 1회를 두고 경합해도 진 쪽은 신원을 남기지 않는다(토큰 없는 활성 비서 금지)", async () => {
  const t = await start();
  try {
    const { owner, wid } = await workspace(t, "instant-race");
    const invite = (await t.call("POST", `/api/workspaces/${wid}/invites`, owner, { max_uses: 1 })).json;
    const [a, b] = await Promise.all([
      t.call("POST", `/api/join/${invite.invite_token}`, undefined, { display_name: "동시A" }),
      t.call("POST", `/api/join/${invite.invite_token}`, undefined, { display_name: "동시B" }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [201, 404], "하나만 들어온다");
    const agents = (await t.call("GET", `/api/workspaces/${wid}/agents`, owner)).json.agents;
    assert.equal(agents.length, 1, "진 쪽의 활성 신원이 남지 않는다");
    assert.equal(agents[0].status, "active");
    const loser = a.status === 404 ? "동시A" : "동시B";
    const raw = t.sqlite.raw.prepare("SELECT count(*) c FROM agents WHERE name=?").get(loser) as any;
    assert.equal(Number(raw.c), 0, `${loser} 신원이 만들어지지 않았다`);
  } finally { await t.close(); }
});

test("기존 비서가 다른 방 초대를 수락해도 오너가 내린 로비 읽기 제한은 그대로다", async () => {
  const t = await start();
  try {
    const { owner, wid, lobbyId } = await workspace(t, "instant-perm");
    const room = (await t.call("POST", `/api/workspaces/${wid}/rooms`, owner, { name: "연구방" })).json;
    const pool = (await t.call("POST", `/api/workspaces/${wid}/invites`, owner, {})).json;
    const first = await t.call("POST", `/api/join/${pool.invite_token}`, undefined, { display_name: "제한" });
    const token = first.json.agent_token as string;
    const aid = first.json.agent_id as string;

    // 오너가 로비 읽기를 끈다.
    assert.equal((await t.call("PATCH", `/api/rooms/${lobbyId}/members/${aid}`, owner, { can_read: false, can_write: true })).status, 200);
    const lobbyInvite = (await t.call("POST", `/api/rooms/${room.id}/invites`, owner, {})).json;
    const again = await t.call("POST", `/api/join/${lobbyInvite.invite_token}`, token, { display_name: "제한" });
    assert.equal(again.status, 201);

    const me = (await t.call("GET", "/api/me", token)).json;
    const lobby = me.rooms.find((r: any) => r.id === lobbyId);
    const joined = me.rooms.find((r: any) => r.id === room.id);
    assert.equal(lobby.you.can_read, false, "로비 읽기 제한이 초대 수락으로 풀리지 않는다");
    assert.equal(joined.you.can_read, true, "새로 들어온 방은 기본 권한");
  } finally { await t.close(); }
});

test("잘못된 이름으로 실패해도 초대 사용 횟수는 남는다(이름을 고쳐 같은 링크로 입장)", async () => {
  const t = await start();
  try {
    const { owner, wid } = await workspace(t, "instant-name");
    const invite = (await t.call("POST", `/api/workspaces/${wid}/invites`, owner, { max_uses: 1 })).json;
    const bad = await t.call("POST", `/api/join/${invite.invite_token}`, undefined, { display_name: "owner" });
    assert.equal(bad.status, 400, "예약 이름은 거부");
    assert.equal(bad.json.error.code, "reserved_name");
    const raw = t.sqlite.raw.prepare("SELECT uses FROM invites WHERE id=?").get(invite.invite_id) as any;
    assert.equal(Number(raw.uses), 0, "이름 검사는 차감 전에 한다");
    const ok = await t.call("POST", `/api/join/${invite.invite_token}`, undefined, { display_name: "올바른이름" });
    assert.equal(ok.status, 201, "같은 링크로 다시 입장할 수 있다");
  } finally { await t.close(); }
});

test("방 초대 안내는 '한 번 호출' 로 바뀌었고, 예전 승인 방식은 접힌 참고로만 남는다", async () => {
  const t = await start();
  try {
    const { owner, wid } = await workspace(t, "instant6");
    const invite = (await t.call("POST", `/api/workspaces/${wid}/invites`, owner, {})).json;
    const md = (await t.call("GET", `/join/${invite.invite_token}`)).text;
    assert.match(md, /한 번만 호출하면 바로 입장/);
    assert.match(md, /curl -s -X POST/);
    assert.match(md, /"status":"joined"/);
    assert.match(md, /409 name_taken/);
    assert.match(md, /"instant": false/, "레거시 방식은 명시적으로 고를 때만");
    assert.ok(md.indexOf("한 번만 호출하면 바로 입장") < md.indexOf("instant\": false"), "기본 안내가 먼저");
  } finally { await t.close(); }
});
