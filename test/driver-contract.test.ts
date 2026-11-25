// 드라이버 계약 테스트: 저장소 어댑터가 무엇이든(로컬 SQLite, Postgres) 방 로직이 같게 동작해야 한다.
//  - node:sqlite: 항상 실행(이 환경에 그대로 있다).
//  - Postgres: TEST_DATABASE_URL 이 있으면 실제 서버로, 없으면 pg-mem(Postgres 에뮬레이터)로 실행한다.
//    pg-mem은 문법·제약·트랜잭션 의미만 흉내 내는 도구라 실제 Postgres에서의 최종 확인을 대체하지 않는다.
import test from "node:test";
import assert from "node:assert/strict";
import { newDb } from "pg-mem";
import type { Pool as PgPool } from "pg";
import type { SqlDb } from "../core/db.js";
import { RoomService } from "../core/service.js";
import { openSqliteDb } from "../runtime/node-sqlite.js";
import { PostgresDb, createPostgresDb, toPgParams } from "../runtime/pg.js";

const REAL_PG = process.env.TEST_DATABASE_URL;

test("Postgres 플레이스홀더 변환: 문자열 리터럴·주석의 ?는 건드리지 않는다", () => {
  assert.equal(toPgParams("SELECT * FROM t WHERE a=? AND b=?"), "SELECT * FROM t WHERE a=$1 AND b=$2");
  assert.equal(toPgParams("SELECT 'a?b' , c=? FROM t -- ? 주석\nWHERE d=?"), "SELECT 'a?b' , c=$1 FROM t -- ? 주석\nWHERE d=$2");
  assert.equal(toPgParams("SELECT 'it''s ?' , ?"), "SELECT 'it''s ?' , $1");
});

/** 모든 드라이버가 지켜야 하는 계약. */
function contract(label: string, make: () => Promise<{ db: SqlDb; done: () => Promise<void> }>, opts: { rollbackIsolation?: boolean } = {}) {
  const rollbackIsolation = opts.rollbackIsolation !== false;
  test(`${label}: 스키마 준비·prep/one/all/run/batch 기본 계약`, async () => {
    const { db, done } = await make();
    try {
      await db.ensureSchema?.();
      await db.ensureSchema?.(); // 멱등
      const svc = new RoomService(db);
      assert.equal(await svc.adminKeyConfigured(), false);
      await svc.setAdminKeyHash(await (await import("../core/crypto.js")).hashToken("admin-key-0123456789abcdef"));
      assert.equal(await svc.adminKeyConfigured(), true);
      const room = await svc.createRoom("계약 방", "드라이버 계약");
      assert.match(room.room_id, /^room_/);
      const row = await db.one("SELECT name FROM rooms WHERE id=?", room.room_id);
      assert.equal(row!.name, "계약 방");
      const rows = await db.all("SELECT id FROM rooms");
      assert.equal(rows.length, 1);
      const r = await db.run("UPDATE rooms SET name=? WHERE id=?", "이름 변경", room.room_id);
      assert.equal(r.changes, 1);
      const missing = await db.run("UPDATE rooms SET name=? WHERE id=?", "없음", "room_does_not_exist");
      assert.equal(missing.changes, 0);
      assert.equal(await db.one("SELECT id FROM rooms WHERE id=?", "room_does_not_exist"), undefined);
    } finally { await done(); }
  });

  test(`${label}: batch는 한 트랜잭션 — 실패하면 전부 롤백된다`, async () => {
    const { db, done } = await make();
    try {
      await db.ensureSchema?.();
      const svc = new RoomService(db);
      const room = await svc.createRoom("원자성");
      await db.run("INSERT INTO messages(room_id,seq,id,sender_type,sender_id,sender_name,kind,content,content_hash,created_at) VALUES (?,1,'msg_seed','owner','owner','owner','message','seed','h',1)", room.room_id);
      const before = Number((await db.one("SELECT next_seq FROM rooms WHERE id=?", room.room_id))!.next_seq);
      // 두 번째 문장이 PK 충돌 → 첫 문장(next_seq 증가)도 되돌아가야 한다.
      await assert.rejects(() =>
        db.batch([
          db.prep("UPDATE rooms SET next_seq = next_seq + 1 WHERE id=?", room.room_id),
          db.prep("INSERT INTO messages(room_id,seq,id,sender_type,sender_id,sender_name,kind,content,content_hash,created_at) VALUES (?,1,'msg_dup','owner','owner','owner','message','dup','h',1)", room.room_id),
        ]),
      );
      const after = await db.one("SELECT next_seq FROM rooms WHERE id=?", room.room_id);
      if (rollbackIsolation) assert.equal(Number(after!.next_seq), before, "가드 UPDATE가 롤백되어 next_seq가 그대로다");
      else assert.ok(Number(after!.next_seq) >= before, "에뮬레이터는 롤백 격리를 보장하지 않는다(실서버 테스트에서 확인)");
      assert.equal(await db.one("SELECT id FROM messages WHERE id='msg_dup'"), undefined);
    } finally { await done(); }
  });

  test(`${label}: 코어 서비스 전체 흐름(방 생성→초대→참여→전송→inbox→ack→정지 가드)`, async () => {
    const { db, done } = await make();
    try {
      await db.ensureSchema?.();
      const svc = new RoomService(db);
      const room = await svc.createRoom("흐름 방");
      const login = await svc.login(room.room_id, room.owner_code);
      assert.match(login.session_token, /^acr_ses_/);
      const invite = await svc.createInvite(room.room_id, { max_uses: 2 });
      const jr = await svc.requestJoin(invite.invite_token, { display_name: "alpha", product: "test" });
      assert.equal(jr.status, "pending");
      await svc.approveJoin(room.room_id, jr.request_id, { history: "all" });
      const claim = (await svc.claim(jr.request_id, jr.claim_secret)) as any;
      assert.equal(claim.status, "approved");
      const agent = await svc.authAgent(claim.agent_token);
      assert.ok(agent);

      const posted = await svc.postAsAgent(agent!, { client_id: "c1", content: "첫 메시지" });
      assert.equal((posted.message as any).seq, 1);
      const dup = await svc.postAsAgent(agent!, { client_id: "c1", content: "첫 메시지" });
      assert.equal(dup.duplicate, true);
      await assert.rejects(() => svc.postAsAgent(agent!, { client_id: "c1", content: "다른 내용" }), (e: any) => e.code === "client_id_conflict");

      const ownerMsg = await svc.postAsOwner(room.room_id, { client_id: "o1", content: "오너 공지" });
      assert.equal((ownerMsg.message as any).seq, 2);
      const inbox = await svc.inbox(agent!);
      assert.equal(inbox.messages.length, 1);
      assert.equal(inbox.messages[0].content, "오너 공지");
      const acked = await svc.ack(agent!, inbox.messages[0].seq);
      assert.equal(acked.acked_seq, 2);
      assert.equal((await svc.inbox(agent!)).messages.length, 0, "ack 이후에는 다시 오지 않는다");
      assert.equal((await svc.readMessages(agent!, 0)).messages.length, 2, "커서 읽기는 기록 전체");

      // 일시정지 가드: 에이전트 전송은 423, seq에 구멍이 생기지 않는다.
      await svc.updateRoom(room.room_id, { paused: true });
      await assert.rejects(() => svc.postAsAgent(agent!, { client_id: "c2", content: "정지 중" }), (e: any) => e.code === "room_paused");
      const roomRow = await db.one("SELECT next_seq FROM rooms WHERE id=?", room.room_id);
      assert.equal(Number(roomRow!.next_seq), 3);
      await svc.updateRoom(room.room_id, { paused: false });
      const after = await svc.postAsAgent(agent!, { client_id: "c3", content: "재개" });
      assert.equal((after.message as any).seq, 3);

      // 초대 사용 횟수·폐기 경합의 조건부 UPDATE가 드라이버에서도 원자적으로 동작한다.
      await svc.rotateOwnerCode(room.room_id);
      assert.equal(await svc.authSession(login.session_token), null, "코드 교체 시 세션 폐기");
      assert.ok((await svc.purgeExpired()) >= 0);
    } finally { await done(); }
  });
}

async function sqliteDriver() {
  const db = openSqliteDb(":memory:");
  return { db: db as SqlDb, done: async () => { await db.close(); } };
}

async function pgMemDriver() {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = mem.adapters.createPg();
  const pool = new adapter.Pool();
  const db = new PostgresDb(pool as unknown as PgPool);
  return { db: db as SqlDb, done: async () => { await pool.end(); } };
}

contract("SQLite(node:sqlite)", sqliteDriver);
// pg-mem은 한 연결을 공유해 ROLLBACK 격리를 보장하지 않는다(문법·제약·흐름만 검증).
// 트랜잭션 원자성은 SQLite 계약과, TEST_DATABASE_URL이 있을 때의 실서버 테스트가 확인한다.
contract("Postgres(pg-mem)", pgMemDriver, { rollbackIsolation: false });

test("Postgres(실제 서버): TEST_DATABASE_URL이 있을 때만 실행", async (t) => {
  if (!REAL_PG) return t.skip("TEST_DATABASE_URL 미설정 — pg-mem 계약으로 대체 검증");
  const db = createPostgresDb(REAL_PG);
  try {
    // 테스트 전용 DB를 전제로 스키마를 비우고 새로 만든다(운영 DB에 쓰지 말 것).
    for (const tbl of ["webhook_deliveries", "webhooks", "messages", "agents", "join_requests", "invites", "sessions", "rooms", "audit", "login_fails", "auth_fails", "meta"]) {
      await db.run(`DROP TABLE IF EXISTS ${tbl} CASCADE`);
    }
    await db.ensureSchema();
    const svc = new RoomService(db);
    const room = await svc.createRoom("실서버 방");
    const invite = await svc.createInvite(room.room_id, { max_uses: 1 });
    const jr = await svc.requestJoin(invite.invite_token, { display_name: "live" });
    await svc.approveJoin(room.room_id, jr.request_id, {});
    const claim = (await svc.claim(jr.request_id, jr.claim_secret)) as any;
    const agent = await svc.authAgent(claim.agent_token);
    const posted = await svc.postAsAgent(agent!, { client_id: "live-1", content: "실서버 확인" });
    assert.equal((posted.message as any).seq, 1);
    // 실서버 트랜잭션 원자성: 실패한 batch는 전부 롤백된다.
    const before = Number((await db.one("SELECT next_seq FROM rooms WHERE id=?", room.room_id))!.next_seq);
    await assert.rejects(() => db.batch([
      db.prep("UPDATE rooms SET next_seq = next_seq + 1 WHERE id=?", room.room_id),
      db.prep("INSERT INTO messages(room_id,seq,id,sender_type,sender_id,sender_name,kind,content,content_hash,created_at) VALUES (?,1,'msg_dup','owner','owner','owner','message','dup','h',1)", room.room_id),
    ]));
    assert.equal(Number((await db.one("SELECT next_seq FROM rooms WHERE id=?", room.room_id))!.next_seq), before, "실서버에서 batch 롤백 확인");
    const inbox = await svc.inbox(agent!);
    assert.equal(inbox.messages.length, 0);
  } finally {
    await db.close();
  }
});
