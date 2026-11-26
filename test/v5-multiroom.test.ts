// v5(멀티룸) 검증: v4 → v5 비파괴 마이그레이션·불변식, 오너 계정(아이디+비밀번호) 로그인,
// 멀티룸(워크스페이스·중앙 풀·방별 권한/커서), 로비 자동 가입·단일 토큰 호환을 실제 HTTP로 확인한다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { start, ADMIN_KEY } from "./helpers.js";
import { openSqliteDb } from "../runtime/node-sqlite.js";
import { backfillV5, checkInvariants } from "../core/migrate.js";
import { hashToken } from "../core/crypto.js";

const MIGRATIONS_DIR = new URL("../../worker/migrations/", import.meta.url);

/** v4 시점(0001~0004 적용 + 레거시 데이터)의 SQLite 파일 DB를 만든다. */
function makeV4Fixture(): string {
  const path = pathJoin(tmpdir(), `acr-v4-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && f < "0005").sort();
  for (const f of files) db.exec(readFileSync(new URL(f, MIGRATIONS_DIR), "utf8"));
  db.exec(`
    INSERT INTO rooms(id,name,description,created_at,owner_code_hash,next_seq)
      VALUES ('room_legacy','레거시 방','',1000,'hash-owner-code',3);
    INSERT INTO invites(id,room_id,token_hash,created_at,expires_at,max_uses,uses,revoked)
      VALUES ('inv_legacy','room_legacy','hash-invite',1000,9999999999999,5,1,0);
    INSERT INTO agents(id,room_id,name,name_key,product,token_hash,status,can_read,can_write,history_floor,fetched_seq,acked_seq,created_at,last_seen)
      VALUES ('agt_live','room_legacy','피클','피클','Pickle','hash-token-live','active',1,1,0,1,0,1100,1200),
             ('agt_wait','room_legacy','포크','포크','Poke',NULL,'unclaimed',1,1,0,0,0,1300,NULL),
             ('agt_gone','room_legacy','옛비서','옛비서','Old','hash-token-old','revoked',1,1,0,0,0,1400,NULL);
    INSERT INTO messages(room_id,seq,id,client_id,sender_type,sender_id,sender_name,kind,content,content_hash,context_category,depth,created_at)
      VALUES ('room_legacy',1,'msg_1',NULL,'owner','owner','owner','message','안녕','h1','none',0,1500),
             ('room_legacy',2,'msg_2',NULL,'agent','agt_live','피클','answer','네','h2','none',0,1600);
    INSERT INTO meta(key,value) VALUES ('schema_version','4')
      ON CONFLICT(key) DO UPDATE SET value=excluded.value;
  `);
  db.close();
  return path;
}

test("v5 마이그레이션: v4 데이터를 지우지 않고 워크스페이스·로비·구성원으로 백필한다", async () => {
  const path = makeV4Fixture();
  const db = openSqliteDb(path);
  try {
    await db.ensureSchema();
    const version = (db.raw.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as any).value;
    assert.equal(String(version), "5");

    const ws = db.raw.prepare("SELECT * FROM workspaces").all() as any[];
    assert.equal(ws.length, 1, "레거시 방 하나 = 워크스페이스 하나");
    assert.equal(ws[0].legacy_room_id, "room_legacy");
    assert.equal(ws[0].lobby_room_id, "room_legacy");
    assert.equal(ws[0].owner_id, null, "계정 승격 전에는 오너 미연결");
    assert.equal(ws[0].legacy_owner_code_hash, "hash-owner-code");

    const room = db.raw.prepare("SELECT * FROM rooms WHERE id='room_legacy'").get() as any;
    assert.equal(room.workspace_id, ws[0].id);
    assert.equal(room.kind, "lobby");

    const agents = db.raw.prepare("SELECT id, workspace_id, status FROM agents ORDER BY id").all() as any[];
    assert.deepEqual(agents.map((a) => a.workspace_id), [ws[0].id, ws[0].id, ws[0].id], "모든 에이전트가 워크스페이스에 속한다");

    const members = db.raw.prepare("SELECT room_id, agent_id, status, fetched_seq, acked_seq FROM room_members ORDER BY agent_id").all() as any[];
    assert.deepEqual(members.map((m) => [m.agent_id, m.status]), [["agt_gone", "removed"], ["agt_live", "active"], ["agt_wait", "invited"]]);
    assert.equal(members[1].fetched_seq, 1, "읽기 커서가 room_members 로 이사한다");
    assert.equal((db.raw.prepare("SELECT count(*) c FROM messages").get() as any).c, 2, "메시지는 그대로");
    // 이관 직후 개요 카드가 빈 미리보기를 보이지 않도록 마지막 메시지 캐시도 채운다.
    assert.equal(room.last_preview, "네");
    assert.equal(Number(room.last_message_at), 1600);
    assert.equal(room.last_sender_name, "피클");

    assert.deepEqual(await checkInvariants(db), [], "불변식 5종 위반 0");

    // 재실행해도 중복이 생기지 않는다(멱등).
    await db.ensureSchema();
    assert.equal((db.raw.prepare("SELECT count(*) c FROM workspaces").get() as any).c, 1);
    assert.equal((db.raw.prepare("SELECT count(*) c FROM room_members").get() as any).c, 3);
  } finally {
    await db.close();
    rmSync(path, { force: true });
  }
});

test("백필은 v5에서 만든 일반 방을 로비로 바꾸지 않고, 불변식이 위반을 잡는다", async () => {
  const path = makeV4Fixture();
  const db = openSqliteDb(path);
  try {
    await db.ensureSchema();
    const ws = (db.raw.prepare("SELECT * FROM workspaces").get() as any).id;
    db.raw.exec(`INSERT INTO rooms(id,name,description,created_at,owner_code_hash,workspace_id,kind)
                 VALUES ('room_extra','회의실','',2000,'hash-x','${ws}','room')`);
    await backfillV5(db);
    assert.equal((db.raw.prepare("SELECT kind FROM rooms WHERE id='room_extra'").get() as any).kind, "room", "일반 방은 로비가 아니다");
    assert.equal((db.raw.prepare("SELECT count(*) c FROM workspaces").get() as any).c, 1);

    db.raw.exec("UPDATE rooms SET workspace_id=NULL WHERE id='room_extra'");
    const bad = await checkInvariants(db);
    assert.ok(bad.some((b) => b.name === "rooms_without_workspace" && b.count === 1), "워크스페이스 없는 방을 잡는다");
  } finally {
    await db.close();
    rmSync(path, { force: true });
  }
});

test("오너 계정: 아이디+비밀번호로 가입·로그인하고, 비밀번호는 평문으로 저장하지 않는다", async () => {
  const t = await start();
  try {
    const created = await t.call("POST", "/api/setup/owner", ADMIN_KEY, {
      login_id: "ingwon", password: "correct-horse-battery", display_name: "인권", workspace_name: "우리 집",
    });
    assert.equal(created.status, 201);
    assert.match(created.json.session_token, /^acr_osess_/);
    assert.equal(created.json.workspace.name, "우리 집");
    assert.equal(created.json.lobby_room.name, "로비");

    const row = t.sqlite.raw.prepare("SELECT secret_hash, pw_salt, pw_iter, secret_kind FROM owners WHERE login_id='ingwon'").get() as any;
    assert.equal(row.secret_kind, "password_pbkdf2");
    assert.match(row.secret_hash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(row).includes("correct-horse-battery"), "평문 비밀번호가 남지 않는다");
    assert.ok(row.pw_iter <= 100_000 && row.pw_iter >= 10_000, "Workers PBKDF2 상한 안");

    const bad = await t.call("POST", "/api/auth/login", undefined, { login_id: "ingwon", password: "wrong-password-here" });
    assert.equal(bad.status, 401);
    const login = await t.call("POST", "/api/auth/login", undefined, { login_id: "INGWON", password: "correct-horse-battery" });
    assert.equal(login.status, 200, "아이디는 대소문자를 구분하지 않는다");
    const me = await t.call("GET", "/api/me", login.json.session_token);
    assert.equal(me.status, 200);
    assert.equal(me.json.owner.login_id, "ingwon");
    assert.equal(me.json.workspaces.length, 1);
    assert.equal(me.json.workspaces[0].id, created.json.workspace.id);

    const short = await t.call("POST", "/api/setup/owner", ADMIN_KEY, { login_id: "other", password: "short" });
    assert.ok(short.status === 409 || short.status === 400, "짧은 비밀번호·중복 아이디는 거절된다");
  } finally { await t.close(); }
});

test("레거시 로그인은 계정 승격 티켓을 주고, 승격 뒤 같은 방·데이터로 계정 로그인이 된다", async () => {
  const t = await start();
  try {
    const r = await t.setupRoom();
    const agent = await t.join(r, "피클");
    await t.call("POST", "/api/owner/messages", r.sess, { client_id: "legacy-1", content: "옛 대화", kind: "message" });

    const legacy = await t.call("POST", "/api/auth/legacy", undefined, { room_id: r.roomId, owner_code: r.ownerCode });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.json.upgrade_required, true);
    assert.match(legacy.json.upgrade_ticket, /^acr_upg_/);

    const up = await t.call("POST", "/api/auth/upgrade", undefined, {
      upgrade_ticket: legacy.json.upgrade_ticket, login_id: "legacy-owner", password: "another-long-password", display_name: "인권",
    });
    assert.equal(up.status, 200);
    assert.equal(up.json.upgraded, true);
    assert.equal(up.json.workspace.id, legacy.json.workspace.id);
    const me = await t.call("GET", "/api/me", up.json.session_token);
    assert.equal(me.json.workspaces[0].lobby_room_id, r.roomId, "레거시 방이 그 워크스페이스의 로비다");

    // 대화·에이전트는 그대로 살아 있다.
    const msgs = await t.call("GET", `/api/rooms/${r.roomId}/messages`, up.json.session_token);
    assert.equal(msgs.status, 200);
    assert.ok(msgs.json.messages.some((m: any) => m.content === "옛 대화"));
    const meAgent = await t.call("GET", "/api/me", agent.token);
    assert.equal(meAgent.json.agent.name, "피클");
    assert.equal(meAgent.json.rooms[0].id, r.roomId);

    // 승격 뒤에도 레거시 오너 코드 로그인은 계속 동작한다(잠금 경로 유지).
    const again = await t.call("POST", "/api/auth/legacy", undefined, { room_id: r.roomId, owner_code: r.ownerCode });
    assert.equal(again.status, 200);
    assert.equal(again.json.upgraded, true);
  } finally { await t.close(); }
});

test("멀티룸: 방 2개에 배치된 비서는 방을 지정해 읽고 쓰며, 커서·권한이 방마다 독립이다", async () => {
  const t = await start();
  try {
    const own = await t.call("POST", "/api/setup/owner", ADMIN_KEY, { login_id: "multi", password: "long-enough-password", workspace_name: "우리 집" });
    const owner = own.json.session_token as string;
    const wid = own.json.workspace.id as string;
    const lobby = own.json.lobby_room.name;
    const lobbyId = own.json.workspace.lobby_room_id as string;

    const roomA = (await t.call("POST", `/api/workspaces/${wid}/rooms`, owner, { name: "회의실", description: "결정 기록" })).json;
    const roomB = (await t.call("POST", `/api/workspaces/${wid}/rooms`, owner, { name: "연구방" })).json;
    assert.equal(roomA.kind, "room");
    const dup = await t.call("POST", `/api/workspaces/${wid}/rooms`, owner, { name: "회의실" });
    assert.equal(dup.status, 409, "같은 워크스페이스에서 방 이름은 유일하다");

    // 풀 초대 → 승인 → 로비 구성원(자동 가입)
    const poolInvite = (await t.call("POST", `/api/workspaces/${wid}/invites`, owner, { max_uses: 3 })).json;
    assert.equal(poolInvite.kind, "pool");
    const jr = (await t.call("POST", `/api/join/${poolInvite.invite_token}`, undefined, { display_name: "피클", product: "Pickle" })).json;
    const approved = await t.call("POST", `/api/join-requests/${jr.request_id}/approve`, owner, { history: "all" });
    assert.equal(approved.status, 200);
    const claim = (await t.call("POST", `/api/join-requests/${jr.request_id}/claim`, undefined, { claim_secret: jr.claim_secret })).json;
    const agent = claim.agent_token as string;
    const aid = claim.agent_id as string;

    const afterJoin = (await t.call("GET", "/api/me", agent)).json;
    assert.equal(afterJoin.rooms.length, 1);
    assert.equal(afterJoin.rooms[0].name, lobby, "풀 초대는 로비로 들어온다");
    assert.equal(afterJoin.rooms[0].kind, "lobby");

    // 오너가 두 방에 배치
    const placed = await t.call("POST", `/api/workspaces/${wid}/agents/${aid}/rooms`, owner, { room_ids: [roomA.id, roomB.id], history: "all" });
    assert.equal(placed.status, 200);
    assert.deepEqual(placed.json.rooms.sort(), [roomA.id, roomB.id].sort());

    const me = (await t.call("GET", "/api/me", agent)).json;
    assert.equal(me.rooms.length, 3);
    assert.equal(me.agent.name, "피클");

    // 방을 지정하지 않은 inbox 는 409 가 아니라 방별 묶음(MCP read_inbox 와 같은 계약)을 돌려준다
    const ambiguous = await t.call("GET", "/api/inbox", agent);
    assert.equal(ambiguous.status, 200, "방이 여러 개여도 방 없는 inbox 가 실패하지 않는다");
    assert.equal(ambiguous.json.rooms.length, 3, "읽을 수 있는 방마다 묶음이 온다");
    assert.ok(ambiguous.json.rooms.every((r: any) => r.room_id && Array.isArray(r.messages)));
    // ack·messages 는 seq 가 방마다 독립이라 여전히 방을 지정해야 한다(409 room_required + 방 목록).
    const ackNoRoom = await t.call("POST", "/api/ack", agent, { seq: 0 });
    assert.equal(ackNoRoom.status, 409);
    assert.equal(ackNoRoom.json.error.code, "room_required");

    // 오너가 방 A에만 글을 쓴다 → A에만 보이고 B는 비어 있다
    const posted = await t.call("POST", `/api/rooms/${roomA.id}/messages`, owner, { client_id: "a-1", content: "회의실 먼저 볼게요", kind: "message" });
    assert.equal(posted.status, 201);
    const inboxA = (await t.call("GET", `/api/rooms/${roomA.id}/inbox`, agent)).json;
    assert.equal(inboxA.messages.length, 1);
    assert.equal(inboxA.messages[0].room_id, roomA.id);
    const inboxB = (await t.call("GET", `/api/rooms/${roomB.id}/inbox`, agent)).json;
    assert.equal(inboxB.messages.length, 0, "다른 방의 메시지는 새지 않는다");
    const agentPost = await t.call("POST", `/api/rooms/${roomA.id}/messages`, agent, { client_id: "a-2", content: "확인했습니다", kind: "answer" });
    assert.equal(agentPost.status, 201);
    const readA = (await t.call("GET", `/api/rooms/${roomA.id}/messages?after=0`, agent)).json;
    assert.equal(readA.messages.length, 2, "내가 쓴 글도 읽기 목록에는 보인다");
    assert.equal((await t.call("GET", `/api/rooms/${roomB.id}/messages?after=0`, agent)).json.messages.length, 0);

    // ack는 방 A의 커서만 옮긴다
    const acked = await t.call("POST", `/api/rooms/${roomA.id}/ack`, agent, { seq: inboxA.fetched_seq });
    assert.equal(acked.status, 200);
    const me2 = (await t.call("GET", "/api/me", agent)).json;
    const a = me2.rooms.find((r: any) => r.id === roomA.id);
    const b = me2.rooms.find((r: any) => r.id === roomB.id);
    assert.ok(a.you.acked_seq >= 1);
    assert.equal(b.you.acked_seq, 0, "방 B의 커서는 그대로");

    // 다른 워크스페이스의 방에는 배치할 수 없다
    const otherRoom = await t.call("POST", "/api/admin/rooms", ADMIN_KEY, { name: "남의 방" });
    const cross = await t.call("POST", `/api/workspaces/${wid}/agents/${aid}/rooms`, owner, { room_id: otherRoom.json.room_id });
    assert.equal(cross.status, 404);

    // 다른 워크스페이스의 오너 세션으로는 이 비서를 폐기할 수 없다
    const otherSess = (await t.call("POST", "/api/owner/login", undefined, { room_id: otherRoom.json.room_id, owner_code: otherRoom.json.owner_code })).json.session_token as string;
    assert.equal((await t.call("POST", `/api/owner/agents/${aid}/revoke`, otherSess)).status, 404);
    assert.equal((await t.call("GET", `/api/rooms/${roomB.id}/inbox`, agent)).status, 200, "폐기되지 않았다");

    // 방이 남아 있는 로비는 관리자 경로로도 삭제되지 않는다
    assert.equal((await t.call("DELETE", `/api/admin/rooms/${lobbyId}`, ADMIN_KEY)).status, 409);

    // 방 A만 읽기·쓰기 권한을 끄면 A는 403, B는 그대로
    const denied = await t.call("PATCH", `/api/rooms/${roomA.id}/members/${aid}`, owner, { can_read: false, can_write: false });
    assert.equal(denied.status, 200);
    assert.equal((await t.call("GET", `/api/rooms/${roomA.id}/inbox`, agent)).status, 403);
    assert.equal((await t.call("GET", `/api/rooms/${roomB.id}/inbox`, agent)).status, 200);
    assert.equal((await t.call("POST", `/api/rooms/${roomA.id}/messages`, agent, { client_id: "a-3", content: "써도 되나" })).status, 403);

    // 개요: 방 3개, 마지막 글 미리보기, 비서 목록
    const overview = (await t.call("GET", `/api/workspaces/${wid}/overview`, owner)).json;
    assert.equal(overview.rooms.length, 3);
    const cardA = overview.rooms.find((r: any) => r.id === roomA.id);
    assert.equal(cardA.last_preview, "확인했습니다");
    assert.equal(cardA.last_sender.name, "피클");
    assert.equal(cardA.member_count, 1);
    assert.equal(overview.agents.length, 1);
    assert.deepEqual(overview.agents[0].rooms.sort(), [roomA.id, roomB.id, overview.workspace.lobby_room_id].sort());

    // 활동(방을 가로지르는 인박스)
    const activity = (await t.call("GET", `/api/workspaces/${wid}/activity`, owner)).json;
    assert.ok(activity.items.every((i: any) => i.room_id));

    // 로비는 삭제할 수 없다
    const delLobby = await t.call("DELETE", `/api/rooms/${overview.workspace.lobby_room_id}`, owner);
    assert.equal(delLobby.status, 409);
  } finally { await t.close(); }
});

test("단일 토큰 호환: 이미 토큰이 있는 비서는 방 초대 링크로 새 토큰 없이 구성원만 추가된다", async () => {
  const t = await start();
  try {
    const own = await t.call("POST", "/api/setup/owner", ADMIN_KEY, { login_id: "compat", password: "long-enough-password", workspace_name: "우리 집" });
    const owner = own.json.session_token as string;
    const wid = own.json.workspace.id as string;
    const lobbyId = own.json.workspace.lobby_room_id as string;

    const poolInvite = (await t.call("POST", `/api/workspaces/${wid}/invites`, owner, {})).json;
    const jr = (await t.call("POST", `/api/join/${poolInvite.invite_token}`, undefined, { display_name: "피클", product: "Pickle" })).json;
    await t.call("POST", `/api/join-requests/${jr.request_id}/approve`, owner, { history: "all" });
    const claim = (await t.call("POST", `/api/join-requests/${jr.request_id}/claim`, undefined, { claim_secret: jr.claim_secret })).json;
    const token = claim.agent_token as string;
    const aid = claim.agent_id as string;

    // 방 하나뿐일 때: v1 경로(/api/inbox)와 v1 모양(/api/me 의 room·you·participants)이 그대로 동작한다
    const meOne = (await t.call("GET", "/api/me", token)).json;
    assert.equal(meOne.room.id, lobbyId);
    assert.equal(meOne.you.name, "피클");
    assert.equal(meOne.participants.length, 1);
    assert.equal(meOne.rooms.length, 1, "v2 필드는 추가 키로만 붙는다");
    assert.equal((await t.call("GET", "/api/inbox", token)).status, 200);

    // 새 방을 만들고 그 방 초대 링크를 기존 토큰으로 연다
    const room = (await t.call("POST", `/api/workspaces/${wid}/rooms`, owner, { name: "연구방" })).json;
    const roomInvite = (await t.call("POST", `/api/rooms/${room.id}/invites`, owner, { max_uses: 2 })).json;
    assert.equal(roomInvite.kind, "room");
    const existing = await t.call("POST", `/api/join/${roomInvite.invite_token}`, token, { display_name: "피클" });
    assert.equal(existing.status, 201);
    assert.equal(existing.json.existing_agent, true, "새 신원을 만들지 않는다");
    const pendingForExisting = await t.call("POST", "/api/join-requests/" + existing.json.request_id + "/claim", undefined, { claim_secret: existing.json.claim_secret });
    assert.equal(pendingForExisting.json.status, "pending");

    const ap = await t.call("POST", `/api/join-requests/${existing.json.request_id}/approve`, owner, { history: "all" });
    assert.equal(ap.status, 200);
    assert.equal(ap.json.existing_agent, true);
    assert.equal(ap.json.agent_id, aid, "같은 신원(에이전트)에 방만 추가된다");

    const cl = (await t.call("POST", `/api/join-requests/${existing.json.request_id}/claim`, undefined, { claim_secret: existing.json.claim_secret })).json;
    assert.equal(cl.existing_agent, true);
    assert.equal(cl.agent_token, undefined, "새 토큰을 발급하지 않는다");
    assert.equal(cl.redirect_room_id, room.id);

    // 기존 토큰 하나로 두 방을 모두 본다
    const meTwo = (await t.call("GET", "/api/me", token)).json;
    assert.equal(meTwo.rooms.length, 2);
    assert.equal((await t.call("GET", `/api/rooms/${room.id}/messages`, token)).status, 200);
    // 같은 이름의 비서가 두 명 생기지 않았다
    const agents = (await t.call("GET", `/api/workspaces/${wid}/agents`, owner)).json.agents;
    assert.equal(agents.length, 1);
  } finally { await t.close(); }
});

test("방 초대는 그 방으로, 풀 초대는 로비로 들어온다(안내문에도 반영)", async () => {
  const t = await start();
  try {
    const own = await t.call("POST", "/api/setup/owner", ADMIN_KEY, { login_id: "invites", password: "long-enough-password", workspace_name: "우리 집" });
    const owner = own.json.session_token as string;
    const wid = own.json.workspace.id as string;
    const room = (await t.call("POST", `/api/workspaces/${wid}/rooms`, owner, { name: "회의실" })).json;
    const roomInvite = (await t.call("POST", `/api/rooms/${room.id}/invites`, owner, {})).json;

    const info = await t.call("GET", `/join/${roomInvite.invite_token}`);
    assert.equal(info.status, 200);
    assert.match(info.text, /Workspace: 우리 집/);
    assert.match(info.text, /Invite: 방 초대/);
    assert.match(info.text, /list_rooms/);
    assert.match(info.text, /\/api\/rooms\/<room_id>/);

    const jr = (await t.call("POST", `/api/join/${roomInvite.invite_token}`, undefined, { display_name: "보이", product: "Vooy" })).json;
    await t.call("POST", `/api/join-requests/${jr.request_id}/approve`, owner, {});
    const cl = (await t.call("POST", `/api/join-requests/${jr.request_id}/claim`, undefined, { claim_secret: jr.claim_secret })).json;
    const me = (await t.call("GET", "/api/me", cl.agent_token)).json;
    const names = me.rooms.map((r: any) => r.name).sort();
    assert.deepEqual(names, ["로비", "회의실"].sort(), "방 초대는 로비 + 그 방");
  } finally { await t.close(); }
});

test("워크스페이스 경계: 다른 워크스페이스의 방은 오너·에이전트 모두 읽을 수 없다", async () => {
  const t = await start();
  try {
    const a = await t.call("POST", "/api/admin/rooms", ADMIN_KEY, { name: "A 방" });
    const b = await t.call("POST", "/api/admin/rooms", ADMIN_KEY, { name: "B 방" });
    const sessA = (await t.call("POST", "/api/owner/login", undefined, { room_id: a.json.room_id, owner_code: a.json.owner_code })).json.session_token as string;
    const sessB = (await t.call("POST", "/api/owner/login", undefined, { room_id: b.json.room_id, owner_code: b.json.owner_code })).json.session_token as string;
    await t.call("POST", `/api/rooms/${b.json.room_id}/messages`, sessB, { client_id: "b-1", content: "B의 비밀", kind: "message" });

    assert.equal((await t.call("GET", `/api/rooms/${b.json.room_id}/messages`, sessA)).status, 403, "남의 방 대화 열람 거부");
    assert.equal((await t.call("GET", `/api/rooms/${b.json.room_id}`, sessA)).status, 403);
    assert.equal((await t.call("POST", `/api/rooms/${b.json.room_id}/messages`, sessA, { client_id: "x-1", content: "끼어들기" })).status, 403);
    assert.equal((await t.call("DELETE", `/api/rooms/${b.json.room_id}`, sessA)).status, 403);
    assert.equal((await t.call("GET", `/api/rooms/${b.json.room_id}/messages`, sessB)).status, 200);

    // 계정 세션도 같은 경계를 지킨다(레거시 세션은 자기 방 하나로 해석된다).
    const own = await t.call("POST", "/api/setup/owner", ADMIN_KEY, { login_id: "boundary", password: "long-enough-password", workspace_name: "우리 집" });
    const owner = own.json.session_token as string;
    assert.equal((await t.call("GET", `/api/rooms/${a.json.room_id}/messages`, owner)).status, 403);
    assert.equal((await t.call("GET", `/api/workspaces/${b.json.workspace_id}/overview`, owner)).status, 403);
    assert.equal((await t.call("PATCH", `/api/rooms/${a.json.room_id}`, owner, { name: "가로채기" })).status, 403);
  } finally { await t.close(); }
});

test("승인 원자성: 잘못된 방 ID로 실패하면 신원·구성원이 남지 않고, 요청은 다시 승인할 수 있다", async () => {
  const t = await start();
  try {
    const r = await t.setupRoom();
    const jr = (await t.call("POST", `/api/join/${r.invite}`, undefined, { display_name: "atomic", product: "test" })).json;
    const bad = await t.call("POST", `/api/owner/join-requests/${jr.request_id}/approve`, r.sess, { room_ids: ["room_missing"] });
    assert.equal(bad.status, 404);
    assert.equal((t.sqlite.raw.prepare("SELECT count(*) c FROM agents WHERE name='atomic'").get() as any).c, 0, "신원이 남지 않는다");
    const pending = (await t.call("GET", "/api/owner/join-requests?status=pending", r.sess)).json.requests;
    assert.equal(pending.length, 1, "요청은 대기 상태 그대로");

    const ok = await t.call("POST", `/api/owner/join-requests/${jr.request_id}/approve`, r.sess, { history: "all" });
    assert.equal(ok.status, 200);
    const cl = (await t.call("POST", `/api/join-requests/${jr.request_id}/claim`, undefined, { claim_secret: jr.claim_secret })).json;
    assert.ok(cl.agent_token);
    const me = await t.call("GET", "/api/me", cl.agent_token);
    assert.equal(me.json.participants.length, 1, "로비 구성원으로 활성화된다");
  } finally { await t.close(); }
});

test("레거시 로그인은 로비(기존 방) 코드로만 열리고, 코드 교체는 남은 승격 티켓도 무효화한다", async () => {
  const t = await start();
  try {
    // 계정이 연결된 워크스페이스에 일반 방을 하나 더 만든다
    const own = await t.call("POST", "/api/setup/owner", ADMIN_KEY, { login_id: "legacy2", password: "long-enough-password", workspace_name: "우리 집" });
    const owner = own.json.session_token as string;
    const wid = own.json.workspace.id as string;
    const room = (await t.call("POST", `/api/workspaces/${wid}/rooms`, owner, { name: "회의실" })).json;

    // 일반 방의 복구 코드(설령 유출돼도)로는 레거시 로그인(→ 계정 세션)이 열리지 않는다
    const leaked = "acr_own_leaked_room_code_0000000000";
    t.sqlite.raw.prepare("UPDATE rooms SET owner_code_hash=? WHERE id=?").run(await hashToken(leaked), room.id);
    const direct = await t.call("POST", "/api/auth/legacy", undefined, { room_id: room.id, owner_code: leaked });
    assert.equal(direct.status, 403);
    assert.equal(direct.json.error.code, "legacy_scope");

    // 로비 세션(레거시)은 여러 방이 된 워크스페이스의 v2 API를 쓸 수 없다
    const r = await t.setupRoom();
    const legacySess = (await t.call("POST", "/api/owner/login", undefined, { room_id: r.roomId, owner_code: r.ownerCode })).json.session_token as string;
    const ticket = (await t.call("POST", "/api/auth/legacy", undefined, { room_id: r.roomId, owner_code: r.ownerCode })).json.upgrade_ticket as string;
    const up = await t.call("POST", "/api/auth/upgrade", undefined, { upgrade_ticket: ticket, login_id: "legacy3", password: "long-enough-password" });
    const wid2 = up.json.workspace.id as string;
    await t.call("POST", `/api/workspaces/${wid2}/rooms`, up.json.session_token, { name: "두 번째 방" });
    const denied = await t.call("GET", `/api/workspaces/${wid2}/activity`, legacySess);
    assert.equal(denied.status, 403, "방 전용 세션은 워크스페이스 단위 API를 쓸 수 없다");
    assert.equal((await t.call("GET", "/api/owner/room", legacySess)).status, 200, "v1 호환 경로는 그대로");

    // 오너 코드를 교체하면 그 전에 발급된 승격 티켓은 무효
    const r2 = await t.setupRoom();
    const t2 = (await t.call("POST", "/api/auth/legacy", undefined, { room_id: r2.roomId, owner_code: r2.ownerCode })).json.upgrade_ticket as string;
    assert.ok(t2);
    await t.call("POST", `/api/admin/rooms/${r2.roomId}/rotate-owner-code`, ADMIN_KEY);
    const stale = await t.call("POST", "/api/auth/upgrade", undefined, { upgrade_ticket: t2, login_id: "legacy4", password: "long-enough-password" });
    assert.equal(stale.status, 401, "교체 전 티켓은 만료 처리된다");
  } finally { await t.close(); }
});

test("MCP 집계 inbox는 쓰기 전용 방 때문에 실패하지 않고, 폐기된 비서는 v1 목록에 남는다", async () => {
  const t = await start();
  try {
    const own = await t.call("POST", "/api/setup/owner", ADMIN_KEY, { login_id: "mcpagg", password: "long-enough-password", workspace_name: "우리 집" });
    const owner = own.json.session_token as string;
    const wid = own.json.workspace.id as string;
    const room = (await t.call("POST", `/api/workspaces/${wid}/rooms`, owner, { name: "회의실" })).json;
    const inv = (await t.call("POST", `/api/workspaces/${wid}/invites`, owner, {})).json;
    const jr = (await t.call("POST", `/api/join/${inv.invite_token}`, undefined, { display_name: "agg", product: "test" })).json;
    await t.call("POST", `/api/join-requests/${jr.request_id}/approve`, owner, { history: "all" });
    const cl = (await t.call("POST", `/api/join-requests/${jr.request_id}/claim`, undefined, { claim_secret: jr.claim_secret })).json;
    const aid = cl.agent_id as string;
    await t.call("POST", `/api/workspaces/${wid}/agents/${aid}/rooms`, owner, { room_ids: [room.id], history: "all" });
    await t.call("PATCH", `/api/rooms/${room.id}/members/${aid}`, owner, { can_read: false, can_write: true });
    await t.call("POST", `/api/rooms/${room.id}/messages`, owner, { client_id: "wo-1", content: "쓰기만 가능한 방" });

    const me = (await t.call("GET", "/api/me", cl.agent_token)).json;
    const writeOnly = me.rooms.find((x: any) => x.id === room.id);
    assert.equal(writeOnly.you.can_read, false);

    const agent = (await t.svc.authAgent(cl.agent_token as string))!;
    const agg = await t.svc.inboxMany(agent, 50);
    assert.deepEqual(agg.rooms.map((x: any) => x.room_id), [me.workspace.lobby_room_id], "읽을 수 있는 방만 돌려준다");
    assert.equal(agg.omitted_rooms, 0);

    // v1 관리 목록은 폐기된 비서를 계속 보여 준다(폐기 상태 확인 경로 보존)
    await t.call("POST", `/api/owner/agents/${aid}/revoke`, owner);
    const listed = (await t.call("GET", "/api/owner/agents", owner)).json.agents;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, "revoked");
  } finally { await t.close(); }
});

test("이미 승인된 구성원 추가 요청을 다시 승인해도 확정된 권한을 덮어쓰지 않는다", async () => {
  const t = await start();
  try {
    const own = await t.call("POST", "/api/setup/owner", ADMIN_KEY, { login_id: "twice", password: "long-enough-password", workspace_name: "우리 집" });
    const owner = own.json.session_token as string;
    const wid = own.json.workspace.id as string;
    const inv = (await t.call("POST", `/api/workspaces/${wid}/invites`, owner, {})).json;
    const jr = (await t.call("POST", `/api/join/${inv.invite_token}`, undefined, { display_name: "twice", product: "test" })).json;
    await t.call("POST", `/api/join-requests/${jr.request_id}/approve`, owner, { history: "all" });
    const cl = (await t.call("POST", `/api/join-requests/${jr.request_id}/claim`, undefined, { claim_secret: jr.claim_secret })).json;

    const room = (await t.call("POST", `/api/workspaces/${wid}/rooms`, owner, { name: "회의실" })).json;
    const roomInvite = (await t.call("POST", `/api/rooms/${room.id}/invites`, owner, {})).json;
    const again = (await t.call("POST", `/api/join/${roomInvite.invite_token}`, cl.agent_token, {})).json;
    // 두 오너 탭이 서로 다른 권한으로 동시에 승인한다 → 하나만 성공하고, 확정된 권한은 승자의 값이어야 한다.
    const [withRead, noRead] = await Promise.all([
      t.call("POST", `/api/join-requests/${again.request_id}/approve`, owner, { history: "all", can_read: true, can_write: true }),
      t.call("POST", `/api/join-requests/${again.request_id}/approve`, owner, { history: "all", can_read: false, can_write: false }),
    ]);
    assert.deepEqual([withRead.status, noRead.status].sort(), [200, 409], "하나만 승인된다");
    const winnerCanRead = withRead.status === 200;

    const detail = (await t.call("GET", `/api/rooms/${room.id}`, owner)).json;
    const member = detail.members.find((m: any) => m.agent_id === cl.agent_id);
    assert.equal(member.can_read, winnerCanRead, "패자의 늦은 쓰기가 확정 권한을 덮어쓰지 않는다");
    assert.equal(member.can_write, winnerCanRead);
    assert.equal((await t.call("GET", `/api/rooms/${room.id}/messages`, cl.agent_token)).status, winnerCanRead ? 200 : 403);
  } finally { await t.close(); }
});

test("P0-2 회귀: 레거시(방 코드) 세션은 방을 만들 수 없고, 실패해도 빈 방이 남지 않는다", async () => {
  const t = await start();
  try {
    const r = await t.setupRoom();
    const legacySess = (await t.call("POST", "/api/owner/login", undefined, { room_id: r.roomId, owner_code: r.ownerCode })).json.session_token as string;
    const wsId = (t.sqlite.raw.prepare("SELECT workspace_id FROM rooms WHERE id=?").get(r.roomId) as any).workspace_id as string;
    const before = (t.sqlite.raw.prepare("SELECT count(*) c FROM rooms WHERE workspace_id=?").get(wsId) as any).c as number;

    const denied = await t.call("POST", `/api/workspaces/${wsId}/rooms`, legacySess, { name: "검증용 방" });
    assert.equal(denied.status, 403, "커밋 뒤 403 이 아니라 처음부터 거부한다");
    assert.equal(denied.json.error.code, "legacy_scope");

    const after = (t.sqlite.raw.prepare("SELECT count(*) c FROM rooms WHERE workspace_id=?").get(wsId) as any).c as number;
    assert.equal(after, before, "유령 방이 남지 않는다");
    // 레거시 세션은 여전히 자기 방(v1 경로)을 쓸 수 있다 — 방 하나짜리 워크스페이스 그대로.
    assert.equal((await t.call("GET", "/api/owner/room", legacySess)).status, 200);

    // 오너 계정 세션은 같은 요청이 정상 동작하고, 응답에 방 상세가 온다(내부 상세 경로).
    const ticket = (await t.call("POST", "/api/auth/legacy", undefined, { room_id: r.roomId, owner_code: r.ownerCode })).json.upgrade_ticket as string;
    const up = await t.call("POST", "/api/auth/upgrade", undefined, { upgrade_ticket: ticket, login_id: "p02-owner", password: "long-enough-password" });
    const owner = up.json.session_token as string;
    const created = await t.call("POST", `/api/workspaces/${up.json.workspace.id}/rooms`, owner, { name: "정상 방" });
    assert.equal(created.status, 201);
    assert.equal(created.json.name, "정상 방");
    assert.equal(created.json.kind, "room");
    assert.deepEqual(created.json.members, []);
  } finally { await t.close(); }
});

test("P0-1 회귀: /api/setup 은 계정에 연결되지 않은 기존 방 수를 알려 준다", async () => {
  const t = await start();
  try {
    const empty = (await t.call("GET", "/api/setup")).json;
    assert.equal(empty.needs_owner, true);
    assert.equal(empty.legacy_rooms, 0, "새 배포에는 기존 방이 없다");

    const r = await t.setupRoom();
    const withLegacy = (await t.call("GET", "/api/setup")).json;
    assert.equal(withLegacy.needs_owner, true);
    assert.equal(withLegacy.legacy_rooms, 1, "방 코드로 들어올 수 있는 기존 방을 센다");

    // 계정이 연결되면 더 이상 '기존 방' 후보가 아니다.
    const ticket = (await t.call("POST", "/api/auth/legacy", undefined, { room_id: r.roomId, owner_code: r.ownerCode })).json.upgrade_ticket as string;
    await t.call("POST", "/api/auth/upgrade", undefined, { upgrade_ticket: ticket, login_id: "p01-owner", password: "long-enough-password" });
    const after = (await t.call("GET", "/api/setup")).json;
    assert.equal(after.needs_owner, false);
    assert.equal(after.legacy_rooms, 0);
  } finally { await t.close(); }
});

test("P1-2 회귀: 인박스 배지(counts.needs_you)는 승인 대기를 빼고, 목록의 '안 읽음' 과 같은 기준이다", async () => {
  const t = await start();
  try {
    const own = await t.call("POST", "/api/setup/owner", ADMIN_KEY, { login_id: "badge", password: "long-enough-password", workspace_name: "우리 집" });
    const owner = own.json.session_token as string;
    const wid = own.json.workspace.id as string;
    const lobbyId = own.json.workspace.lobby_room_id as string;

    const inv = (await t.call("POST", `/api/workspaces/${wid}/invites`, owner, {})).json;
    const jr = (await t.call("POST", `/api/join/${inv.invite_token}`, undefined, { display_name: "피클", product: "Pickle" })).json;
    // 아직 승인 전 = 대기 참여 요청 1건. 이때는 인박스(needs_you) 0, 비서실(pending_requests) 1.
    const pendingOnly = (await t.call("GET", `/api/workspaces/${wid}/overview`, owner)).json;
    assert.equal(pendingOnly.counts.needs_you, 0, "승인 대기는 인박스 배지에 더하지 않는다");
    assert.equal(pendingOnly.pending_requests, 1);
    assert.equal(pendingOnly.rooms.find((x: any) => x.id === lobbyId).health, "needs_input", "방 타일은 대기 요청을 확인 필요로 표시한다");

    await t.call("POST", `/api/join-requests/${jr.request_id}/approve`, owner, { history: "all" });
    const cl = (await t.call("POST", `/api/join-requests/${jr.request_id}/claim`, undefined, { claim_secret: jr.claim_secret })).json;
    const question = await t.call("POST", `/api/rooms/${lobbyId}/messages`, cl.agent_token, { client_id: "q-1", content: "오늘 일정 알려 줄까요?", kind: "question" });
    assert.equal(question.status, 201);
    await t.call("POST", `/api/rooms/${lobbyId}/messages`, cl.agent_token, { client_id: "q-2", content: "두 번째 질문입니다", kind: "question" });

    const overview = (await t.call("GET", `/api/workspaces/${wid}/overview`, owner)).json;
    const feed = (await t.call("GET", `/api/workspaces/${wid}/activity`, owner)).json;
    const unread = feed.items.filter((i: any) => i.unread).length;
    assert.equal(overview.counts.needs_you, 2, "안 읽은 질문 2건");
    assert.equal(overview.counts.needs_you, unread, "배지와 인박스 목록의 확인 필요 수가 같다");
    assert.equal(overview.pending_requests, 0);

    // 방을 열어 읽음 위치를 옮기면 배지도 0이 된다(읽었지만 답하지 않은 것을 계속 세지 않는다).
    await t.call("GET", `/api/rooms/${lobbyId}/messages?after=0`, owner);
    const read = (await t.call("GET", `/api/workspaces/${wid}/overview`, owner)).json;
    assert.equal(read.counts.needs_you, 0);
    const feedAfter = (await t.call("GET", `/api/workspaces/${wid}/activity`, owner)).json;
    assert.equal(feedAfter.items.filter((i: any) => i.unread).length, 0);
    assert.ok(feedAfter.items.length >= 2, "목록은 이력으로 남는다");

    // 읽지 않은 내 앞 지목도 같은 기준으로 센다.
    await t.call("POST", `/api/rooms/${lobbyId}/messages`, cl.agent_token, { client_id: "d-1", content: "이건 오너에게", recipient: "피클" });
    await t.call("POST", `/api/rooms/${lobbyId}/messages`, cl.agent_token, { client_id: "d-2", content: "@owner 확인 부탁드려요", recipient: "owner" });
    const directed = (await t.call("GET", `/api/workspaces/${wid}/overview`, owner)).json;
    assert.equal(directed.counts.needs_you, 1, "내 앞 지목 1건만 센다");
  } finally { await t.close(); }
});

test("P1-4 회귀: 오너 세션이 v2 API 로 방 웹훅을 조회·등록·시험·폐기한다", async () => {
  const t = await start();
  try {
    const own = await t.call("POST", "/api/setup/owner", ADMIN_KEY, { login_id: "hooks", password: "long-enough-password", workspace_name: "우리 집" });
    const owner = own.json.session_token as string;
    const wid = own.json.workspace.id as string;
    const room = (await t.call("POST", `/api/workspaces/${wid}/rooms`, owner, { name: "회의실" })).json;

    const empty = await t.call("GET", `/api/rooms/${room.id}/webhooks`, owner);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json.webhooks, []);

    const bad = await t.call("POST", `/api/rooms/${room.id}/webhooks`, owner, { url: "http://example.com/hook" });
    assert.equal(bad.status, 400, "https 만 등록한다");

    const created = await t.call("POST", `/api/rooms/${room.id}/webhooks`, owner, { url: "https://example.com/acr-hook" });
    assert.equal(created.status, 201);
    assert.match(created.json.id, /^whk_/);
    assert.match(created.json.secret, /^whsec_/);

    const listed = (await t.call("GET", `/api/rooms/${room.id}/webhooks`, owner)).json.webhooks;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].active, true);

    const ping = await t.call("POST", `/api/rooms/${room.id}/webhooks/${created.json.id}/test`, owner);
    assert.equal(ping.status, 200);
    assert.equal(ping.json.delivery.kind, "ping");
    assert.ok(["delivered", "pending", "failed"].includes(ping.json.delivery.status));

    assert.equal((await t.call("DELETE", `/api/rooms/${room.id}/webhooks/${created.json.id}`, owner)).status, 200);
    assert.equal((await t.call("GET", `/api/rooms/${room.id}/webhooks`, owner)).json.webhooks[0].active, false);

    // 세션 없는 요청은 웹훅 경로를 쓸 수 없다.
    assert.equal((await t.call("GET", `/api/rooms/${room.id}/webhooks`)).status, 401);
    assert.equal((await t.call("POST", `/api/rooms/${room.id}/webhooks`, undefined, { url: "https://example.com/x" })).status, 401);
  } finally { await t.close(); }
});

test("P1-2 후속: 읽은 최신 글이 페이지를 채워도 안 읽은 항목이 인박스 목록에 남는다", async () => {
  const t = await start();
  try {
    const own = await t.call("POST", "/api/setup/owner", ADMIN_KEY, { login_id: "unreadfirst", password: "long-enough-password", workspace_name: "우리 집" });
    const owner = own.json.session_token as string;
    const wid = own.json.workspace.id as string;
    const lobbyId = own.json.workspace.lobby_room_id as string;
    const room = (await t.call("POST", `/api/workspaces/${wid}/rooms`, owner, { name: "연구방" })).json;

    const inv = (await t.call("POST", `/api/workspaces/${wid}/invites`, owner, {})).json;
    const jr = (await t.call("POST", `/api/join/${inv.invite_token}`, undefined, { display_name: "피클", product: "test" })).json;
    await t.call("POST", `/api/join-requests/${jr.request_id}/approve`, owner, { history: "all", room_ids: [room.id] });
    const cl = (await t.call("POST", `/api/join-requests/${jr.request_id}/claim`, undefined, { claim_secret: jr.claim_secret })).json;
    const agent = cl.agent_token as string;

    // 연구방에 질문 1건 → 아직 읽지 않음
    await t.call("POST", `/api/rooms/${room.id}/messages`, agent, { client_id: "old-q", content: "오래된 질문", kind: "question" });
    // 로비에는 더 최근 질문 여러 건 → 전부 읽어 둔다(페이지 한도를 채우는 '읽은 최신 글')
    for (let i = 0; i < 5; i++) {
      await t.call("POST", `/api/rooms/${lobbyId}/messages`, agent, { client_id: `new-q-${i}`, content: `새 질문 ${i}`, kind: "question" });
    }
    await t.call("GET", `/api/rooms/${lobbyId}/messages?after=0`, owner); // 로비만 읽음

    const overview = (await t.call("GET", `/api/workspaces/${wid}/overview`, owner)).json;
    assert.equal(overview.counts.needs_you, 1, "읽지 않은 것은 연구방 질문 1건");
    const feed = (await t.call("GET", `/api/workspaces/${wid}/activity?limit=3`, owner)).json;
    assert.equal(feed.items[0].room_id, room.id, "안 읽은 항목이 읽은 최신 글보다 먼저 온다");
    assert.equal(feed.items[0].unread, true);
    assert.equal(feed.items.filter((i: any) => i.unread).length, 1);
    assert.equal(feed.items.filter((i: any) => i.unread).length, overview.counts.needs_you, "배지와 목록의 확인 필요 수가 같다");
  } finally { await t.close(); }
});

test("P1-4 후속: 폐기한 웹훅은 등록 한도를 차지하지 않는다", async () => {
  const t = await start();
  try {
    const own = await t.call("POST", "/api/setup/owner", ADMIN_KEY, { login_id: "hooklimit", password: "long-enough-password", workspace_name: "우리 집" });
    const owner = own.json.session_token as string;
    const room = (await t.call("POST", `/api/workspaces/${own.json.workspace.id}/rooms`, owner, { name: "알림방" })).json;

    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const created = await t.call("POST", `/api/rooms/${room.id}/webhooks`, owner, { url: `https://example.com/hook-${i}` });
      assert.equal(created.status, 201);
      ids.push(created.json.id);
    }
    assert.equal((await t.call("POST", `/api/rooms/${room.id}/webhooks`, owner, { url: "https://example.com/hook-11" })).status, 409, "활성 10개가 한도");

    for (const id of ids) assert.equal((await t.call("DELETE", `/api/rooms/${room.id}/webhooks/${id}`, owner)).status, 200);
    const again = await t.call("POST", `/api/rooms/${room.id}/webhooks`, owner, { url: "https://example.com/hook-new" });
    assert.equal(again.status, 201, "폐기 뒤에는 같은 방에 다시 등록할 수 있다");
    assert.equal((await t.call("GET", `/api/rooms/${room.id}/webhooks`, owner)).json.webhooks.filter((h: any) => h.active).length, 1);
  } finally { await t.close(); }
});

test("P1-7 후속: 다중 방 inbox 도 wait 를 지키고, 잘못된 wait 는 거부한다", async () => {
  const t = await start();
  try {
    const own = await t.call("POST", "/api/setup/owner", ADMIN_KEY, { login_id: "aggwait", password: "long-enough-password", workspace_name: "우리 집" });
    const owner = own.json.session_token as string;
    const wid = own.json.workspace.id as string;
    const room = (await t.call("POST", `/api/workspaces/${wid}/rooms`, owner, { name: "회의실" })).json;
    const inv = (await t.call("POST", `/api/workspaces/${wid}/invites`, owner, {})).json;
    const jr = (await t.call("POST", `/api/join/${inv.invite_token}`, undefined, { display_name: "대기", product: "test" })).json;
    await t.call("POST", `/api/join-requests/${jr.request_id}/approve`, owner, { history: "all", room_ids: [room.id] });
    const cl = (await t.call("POST", `/api/join-requests/${jr.request_id}/claim`, undefined, { claim_secret: jr.claim_secret })).json;
    const agent = cl.agent_token as string;

    const bad = await t.call("GET", "/api/inbox?wait=30", agent);
    assert.equal(bad.status, 400, "0~25초 밖의 wait 는 400");
    assert.equal(bad.json.error.code, "bad_wait");

    const t0 = Date.now();
    const waited = await t.call("GET", "/api/inbox?wait=2", agent);
    const elapsed = Date.now() - t0;
    assert.equal(waited.status, 200);
    assert.ok(Array.isArray(waited.json.rooms) && waited.json.rooms.length === 2, "방별 묶음을 그대로 돌려준다");
    assert.ok(elapsed >= 1800, `새 메시지가 없으면 기다린다(실측 ${elapsed}ms)`);

    // 대기 중 새 메시지가 오면 바로 깨어난다.
    const pending = t.call("GET", "/api/inbox?wait=10", agent);
    setTimeout(() => { void t.call("POST", `/api/rooms/${room.id}/messages`, owner, { client_id: "wake-1", content: "깨어나세요" }); }, 700);
    const woke = await pending;
    const t1 = Date.now();
    assert.equal(woke.status, 200);
    const msgs = woke.json.rooms.flatMap((r: any) => r.messages).filter((m: any) => m.content === "깨어나세요");
    assert.equal(msgs.length, 1, "대기 중 온 메시지가 응답에 담긴다");
    assert.ok(t1 - t0 < 9000, "wait 최대치까지 기다리지 않는다");
  } finally { await t.close(); }
});
