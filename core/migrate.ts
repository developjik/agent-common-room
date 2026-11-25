// 스키마 마이그레이션(v4 → v5, 멀티룸). 모든 런타임이 같은 절차를 쓴다:
//   1) 전체 DDL(IF NOT EXISTS)을 한 batch(=트랜잭션)로 실행  → 새 DB는 여기서 끝난다
//   2) v4에만 없는 컬럼을 "존재 확인 후" ALTER (SQLite/D1은 NOT NULL 해제·재작성이 필요 없게 컬럼을 추가만 한다)
//   3) 백필: 레거시 방 하나 = 워크스페이스 하나, 방은 그 워크스페이스의 로비, 에이전트는 로비 구성원
//   4) 4개 불변식 검증 — 실패하면 예외를 던지고 버전을 쓰지 않는다(다음 요청에서 재시도, 백필은 멱등)
//   5) meta.schema_version = 5
//
// 백필은 전부 "이미 있으면 건너뛰는" 문장만 쓴다. batch 중간 실패는 롤백되고(Postgres·SQLite·D1 모두),
// 같은 절차를 다시 돌려도 데이터가 중복되지 않는다.
import { newId } from "./crypto.js";
import type { SqlDb } from "./db.js";
import { addedColumns, POSTGRES_INDEX_STATEMENTS, POSTGRES_TABLE_STATEMENTS, SCHEMA_VERSION, SQLITE_INDEX_STATEMENTS, SQLITE_TABLE_STATEMENTS } from "./schema.js";

export interface InvariantFailure {
  name: string;
  count: number;
}

/** meta.schema_version. 테이블이 아직 없으면(새 DB) 0. */
export async function readSchemaVersion(db: SqlDb): Promise<number> {
  try {
    const row = await db.one("SELECT value FROM meta WHERE key='schema_version'");
    return row ? Number(row.value) || 0 : 0;
  } catch {
    return 0;
  }
}

/** 테이블 컬럼 이름 집합. SQLite/D1은 pragma_table_info, Postgres는 information_schema. */
async function tableColumns(db: SqlDb, table: string): Promise<Set<string>> {
  if (!/^[a-z_]+$/.test(table)) throw new Error(`bad table name: ${table}`);
  const rows = db.dialect === "postgres"
    ? await db.all("SELECT column_name FROM information_schema.columns WHERE table_name=?", table)
    : await db.all("SELECT name FROM pragma_table_info(?)", table);
  return new Set(rows.map((r) => String(r.column_name ?? r.name)));
}

/**
 * 레거시 데이터를 v5 구조로 채운다(멱등).
 *  - workspace_id 가 비어 있는 방 = v5 이전에 만들어진 방 → 그 방 하나가 워크스페이스 하나이고 로비다.
 *    (운영 D1의 room_50795a119a4a4b48 이 이 경로로 그대로 살아남는다.)
 *  - 에이전트의 workspace_id 는 소속 방의 워크스페이스에서 채운다(신규 에이전트는 생성 시 이미 채워진다).
 *  - 에이전트의 읽기 커서는 room_members 로 복사한다. v4가 읽던 agents.* 값은 지우지 않는다(롤백 대비 미러).
 */
export async function backfillV5(db: SqlDb): Promise<void> {
  const legacyRooms = await db.all(
    "SELECT id, name, created_at, owner_code_hash FROM rooms WHERE workspace_id IS NULL ORDER BY created_at",
  );
  for (const r of legacyRooms) {
    const existing = await db.one("SELECT id FROM workspaces WHERE legacy_room_id=?", r.id);
    let workspaceId = existing ? String(existing.id) : "";
    if (!workspaceId) {
      workspaceId = newId("ws");
      await db.run(
        "INSERT INTO workspaces(id,owner_id,name,created_at,lobby_room_id,legacy_room_id,legacy_owner_code_hash) VALUES (?,?,?,?,?,?,?)",
        workspaceId, null, r.name, r.created_at, r.id, r.id, r.owner_code_hash,
      );
    }
    await db.run("UPDATE rooms SET workspace_id=? WHERE id=? AND workspace_id IS NULL", workspaceId, r.id);
  }
  // 로비 표식은 "그 워크스페이스의 lobby_room_id"인 방에만 준다(새로 만든 일반 방을 건드리지 않는다).
  const lobbies = await db.all("SELECT lobby_room_id FROM workspaces WHERE lobby_room_id IS NOT NULL");
  for (const w of lobbies) {
    await db.run("UPDATE rooms SET kind='lobby' WHERE id=? AND kind<>'lobby'", w.lobby_room_id);
  }
  // 에이전트의 workspace_id 는 소속 방의 워크스페이스에서 채운다.
  // (Postgres·pg-mem 이 UPDATE ... SET 의 상관 서브쿼리를 모두 지원하지 않으므로 한 행씩 채운다. 대상은 소수다.)
  const orphanAgents = await db.all("SELECT id, room_id FROM agents WHERE workspace_id IS NULL");
  for (const a of orphanAgents) {
    const room = await db.one("SELECT workspace_id FROM rooms WHERE id=?", a.room_id);
    if (room?.workspace_id) await db.run("UPDATE agents SET workspace_id=? WHERE id=? AND workspace_id IS NULL", room.workspace_id, a.id);
  }
  // 개요 카드의 마지막 메시지 캐시를 채운다(v5 이전 방은 last_preview 가 비어 있다).
  // 빈 방을 방마다 조회하지 않도록 "방별 마지막 메시지"를 한 번에 읽는다(이관 재시도 시 쿼리 절약).
  const lastSeqs = await db.all(
    "SELECT room_id, max(seq) AS mx FROM messages WHERE deleted_at IS NULL GROUP BY room_id");
  for (const row of lastSeqs) {
    const room = await db.one("SELECT id FROM rooms WHERE id=? AND last_message_at IS NULL", row.room_id);
    if (!room) continue;
    const last = await db.one("SELECT created_at, content, sender_name, sender_type FROM messages WHERE room_id=? AND seq=?", row.room_id, row.mx);
    if (!last) continue;
    const preview = String(last.content ?? "").replace(/\s+/g, " ").slice(0, 120) || null;
    await db.run("UPDATE rooms SET last_message_at=?, last_preview=?, last_sender_name=?, last_sender_type=? WHERE id=? AND last_message_at IS NULL",
      last.created_at, preview, last.sender_name, last.sender_type, row.room_id);
  }

  // 읽기 커서 이사: agents → room_members(대표 방). 이미 있으면 건너뛴다(멱등).
  // pg-mem 이 INSERT ... SELECT 의 상관 NOT EXISTS 를 지원하지 않으므로 대상 행을 읽어 한 건씩 넣는다.
  const needMembers = await db.all(
    `SELECT a.id, a.room_id, a.status, a.can_read, a.can_write, a.history_floor, a.fetched_seq, a.acked_seq, a.created_at
       FROM agents a LEFT JOIN room_members m ON m.room_id=a.room_id AND m.agent_id=a.id
      WHERE m.agent_id IS NULL`,
  );
  for (const a of needMembers) {
    const status = a.status === "active" ? "active" : a.status === "unclaimed" ? "invited" : "removed";
    await db.run(
      `INSERT INTO room_members(room_id, agent_id, status, can_read, can_write, history_floor, fetched_seq, acked_seq, invited_at, joined_at)
       VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(room_id, agent_id) DO NOTHING`,
      a.room_id, a.id, status, a.can_read, a.can_write, a.history_floor, a.fetched_seq, a.acked_seq, a.created_at, a.created_at,
    );
  }
}

const INVARIANTS: Array<{ name: string; sql: string }> = [
  // 1) 모든 방이 워크스페이스에 속한다
  { name: "rooms_without_workspace", sql: "SELECT count(*) c FROM rooms WHERE workspace_id IS NULL" },
  // 2) 모든 로비가 자기 워크스페이스 소속이고 kind='lobby'다
  {
    name: "lobby_mismatch",
    sql: "SELECT count(*) c FROM workspaces w JOIN rooms r ON r.id=w.lobby_room_id WHERE r.workspace_id<>w.id OR r.kind<>'lobby'",
  },
  // 3) 살아 있는(활성·미수령) 에이전트는 최소 1개의 유효한 멤버십을 가진다
  {
    name: "live_agent_without_membership",
    // 상관 NOT EXISTS 는 pg-mem 이 해석하지 못한다 → LEFT JOIN + IS NULL(같은 의미).
    sql: `SELECT count(*) c FROM agents a
            LEFT JOIN room_members m ON m.agent_id=a.id AND m.status IN ('active','invited')
           WHERE a.status IN ('active','unclaimed') AND m.agent_id IS NULL`,
  },
  // 4) 대표 방(agents.room_id)의 멤버십 커서가 v4 커서와 같다(롤백 미러가 살아 있다)
  {
    name: "cursor_mirror_mismatch",
    sql: `SELECT count(*) c FROM agents a JOIN room_members m ON m.agent_id=a.id AND m.room_id=a.room_id
           WHERE m.fetched_seq<>a.fetched_seq OR m.acked_seq<>a.acked_seq`,
  },
  // 5) 에이전트는 모두 워크스페이스에 속한다
  { name: "agents_without_workspace", sql: "SELECT count(*) c FROM agents WHERE workspace_id IS NULL" },
];

/** 불변식 위반 목록(비어 있으면 정상). */
export async function checkInvariants(db: SqlDb): Promise<InvariantFailure[]> {
  const out: InvariantFailure[] = [];
  for (const inv of INVARIANTS) {
    const row = await db.one(inv.sql);
    const n = Number(row?.c ?? 0);
    if (n > 0) out.push({ name: inv.name, count: n });
  }
  return out;
}

/**
 * 최신 스키마로 올린다. 이미 최신이면 읽기 1회로 끝난다.
 * 실패하면 예외를 던져 호출자(런타임 초기화)가 다음 요청에서 다시 시도하게 한다.
 */
export async function migrateToLatest(db: SqlDb): Promise<void> {
  const version = await readSchemaVersion(db);
  if (version >= SCHEMA_VERSION) return;

  const tables = db.dialect === "postgres" ? POSTGRES_TABLE_STATEMENTS : SQLITE_TABLE_STATEMENTS;
  const indexes = db.dialect === "postgres" ? POSTGRES_INDEX_STATEMENTS : SQLITE_INDEX_STATEMENTS;
  // 1) 테이블 DDL. 새 DB에서는 이것만으로 v5 구조가 된다. 이미 있는 테이블은 IF NOT EXISTS로 무시된다.
  await db.batch(tables.map((s) => db.prep(s)));

  // 2) v4 DB에 없는 컬럼만 추가한다(재실행 안전). 새 컬럼을 가리키는 인덱스보다 먼저 와야 한다.
  const stmts = [] as ReturnType<SqlDb["prep"]>[];
  const cache = new Map<string, Set<string>>();
  for (const col of addedColumns(db.dialect)) {
    if (!cache.has(col.table)) cache.set(col.table, await tableColumns(db, col.table));
    if (!cache.get(col.table)!.has(col.column)) stmts.push(db.prep(col.ddl));
  }
  if (stmts.length) await db.batch(stmts);

  // 3) 인덱스. 컬럼이 준비된 뒤에 만든다(중복은 IF NOT EXISTS).
  await db.batch(indexes.map((s) => db.prep(s)));

  // 4) 백필 (멱등)
  await backfillV5(db);

  // 5) 불변식. 실패하면 버전을 쓰지 않는다 → 다음 요청에서 1~3을 다시 시도한다(모두 멱등).
  const bad = await checkInvariants(db);
  if (bad.length) {
    throw new Error(`schema invariant failed: ${bad.map((b) => `${b.name}=${b.count}`).join(", ")}`);
  }

  await db.run(
    "INSERT INTO meta(key,value) VALUES ('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    String(SCHEMA_VERSION),
  );
}
