// 저장소 스키마 정의. 배포 직후 "마이그레이션 없이" 뜨는 것을 목표로 한다.
//  - SQLite 계열(로컬 Node 파일 DB, Cloudflare D1): worker/migrations/*.sql 과 같은 테이블/인덱스를
//    전부 IF NOT EXISTS로 다시 적었다. 첫 요청에서 ensureSchema()가 실행하며, 이미 있는 DB에는
//    없는 것만 추가된다(0001~0004로 만들어진 인권 님의 기존 D1도 그대로 호환).
//  - Postgres(Vercel·Render): 같은 논리 스키마. 불리언은 INTEGER(0/1)로 맞춰 방 로직 SQL을 공유한다.
// 두 DDL이 서로 어긋나지 않는지는 test/schema.test.ts 가 검사한다.
//
// v5(멀티룸)는 전부 추가(additive)만 한다: 새 테이블 6개, 컬럼 7개, 인덱스 3개.
// 기존 테이블은 재작성하지 않고, 레거시 데이터는 core/migrate.ts 의 백필이 채운다.

const SQLITE_BASE = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    owner_code_hash TEXT NOT NULL,
    next_seq INTEGER NOT NULL DEFAULT 1,
    paused INTEGER NOT NULL DEFAULT 0,
    pause_reason TEXT,
    context_policy TEXT NOT NULL DEFAULT '개인 맥락(사용자의 사적 정보, 계정, 비밀)은 이 방에 공유하지 않습니다.',
    allowed_categories TEXT NOT NULL DEFAULT '["none"]',
    content_filter INTEGER NOT NULL DEFAULT 1,
    retention_days INTEGER,
    max_chain_depth INTEGER NOT NULL DEFAULT 6,
    rate_limit_count INTEGER NOT NULL DEFAULT 30,
    rate_limit_window_s INTEGER NOT NULL DEFAULT 600,
    workspace_id TEXT,
    kind TEXT NOT NULL DEFAULT 'room',
    last_message_at INTEGER,
    last_preview TEXT,
    last_sender_name TEXT,
    last_sender_type TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    max_uses INTEGER NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    revoked INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'room'
  )`,
  `CREATE TABLE IF NOT EXISTS join_requests (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    invite_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    product TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    claim_hash TEXT NOT NULL,
    claimed INTEGER NOT NULL DEFAULT 0,
    agent_id TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    kind TEXT NOT NULL DEFAULT 'room',
    existing_agent INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    product TEXT NOT NULL DEFAULT '',
    token_hash TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'unclaimed',
    can_read INTEGER NOT NULL DEFAULT 1,
    can_write INTEGER NOT NULL DEFAULT 1,
    history_floor INTEGER NOT NULL DEFAULT 0,
    fetched_seq INTEGER NOT NULL DEFAULT 0,
    acked_seq INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    last_seen INTEGER,
    workspace_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    id TEXT NOT NULL UNIQUE,
    client_id TEXT,
    sender_type TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    recipient_id TEXT,
    reply_to_seq INTEGER,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    context_category TEXT NOT NULL DEFAULT 'none',
    depth INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER,
    PRIMARY KEY (room_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY,
    room_id TEXT,
    ts INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS login_fails (
    room_id TEXT PRIMARY KEY,
    n INTEGER NOT NULL,
    first INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS auth_fails (
    scope TEXT PRIMARY KEY,
    n INTEGER NOT NULL,
    first INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS owners (
    id TEXT PRIMARY KEY,
    login_key TEXT NOT NULL,
    login_id TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    secret_hash TEXT NOT NULL,
    secret_kind TEXT NOT NULL DEFAULT 'password_pbkdf2',
    pw_salt TEXT NOT NULL DEFAULT '',
    pw_iter INTEGER NOT NULL DEFAULT 25000,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active'
  )`,
  `CREATE TABLE IF NOT EXISTS owner_sessions (
    token_hash TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_used INTEGER,
    label TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    owner_id TEXT REFERENCES owners(id),
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    lobby_room_id TEXT,
    default_retention_days INTEGER,
    legacy_room_id TEXT,
    legacy_owner_code_hash TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'invited',
    can_read INTEGER NOT NULL DEFAULT 1,
    can_write INTEGER NOT NULL DEFAULT 1,
    history_floor INTEGER NOT NULL DEFAULT 0,
    fetched_seq INTEGER NOT NULL DEFAULT 0,
    acked_seq INTEGER NOT NULL DEFAULT 0,
    invited_at INTEGER,
    joined_at INTEGER,
    removed_at INTEGER,
    PRIMARY KEY (room_id, agent_id)
  )`,
  `CREATE TABLE IF NOT EXISTS owner_reads (
    owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    last_read_seq INTEGER NOT NULL DEFAULT 0,
    read_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, room_id)
  )`,
  `CREATE TABLE IF NOT EXISTS upgrade_tickets (
    token_hash TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
];

// 레거시 테이블: 웹훅 기능은 2026-11-26 제거됐다(개인 비서 단톡방 흐름은 MCP·롱폴링·인박스가 맡는다).
// 기존 D1·Postgres 에 남아 있는 테이블과 행을 지우는 DROP 마이그레이션은 넣지 않는다(비파괴).
// 다만 방 삭제가 FK(ON DELETE CASCADE 없음)에 막히지 않도록 DELETE 는 계속 쓰므로, 새 DB 에도 만든다.
const SQLITE_WEBHOOKS = [
  `CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    webhook_id TEXT NOT NULL REFERENCES webhooks(id),
    room_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    message_id TEXT,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    http_status INTEGER,
    created_at INTEGER NOT NULL
  )`,
];

// 인덱스는 v5 이후에도 "워크스페이스당 이름 유일"을 기존 agents_live_name 으로 달성한다:
// 새 에이전트의 agents.room_id 는 항상 그 워크스페이스의 로비 방이므로 (room_id, name_key) 유일 == (workspace, name) 유일.
const SQLITE_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS agents_live_name ON agents(room_id, name_key) WHERE status IN ('unclaimed','active')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS messages_idem ON messages(room_id, sender_id, client_id) WHERE client_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS messages_time ON messages(room_id, sender_type, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_webhooks_room ON webhooks(room_id, active)`,
  `CREATE INDEX IF NOT EXISTS idx_deliveries_due ON webhook_deliveries(status, next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS idx_deliveries_hook ON webhook_deliveries(webhook_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_deliveries_room ON webhook_deliveries(room_id)`,
  `CREATE INDEX IF NOT EXISTS idx_deliveries_cleanup ON webhook_deliveries(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_rooms_retention ON rooms(id) WHERE retention_days IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS owners_login ON owners(login_key)`,
  `CREATE INDEX IF NOT EXISTS idx_owner_sessions_owner ON owner_sessions(owner_id)`,
  `CREATE INDEX IF NOT EXISTS idx_owner_sessions_expires ON owner_sessions(expires_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS workspaces_legacy ON workspaces(legacy_room_id) WHERE legacy_room_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_id)`,
  `CREATE INDEX IF NOT EXISTS room_members_agent ON room_members(agent_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_upgrade_tickets_expires ON upgrade_tickets(expires_at)`,
  `CREATE INDEX IF NOT EXISTS rooms_ws ON rooms(workspace_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS agents_ws ON agents(workspace_id, status)`,
  `CREATE INDEX IF NOT EXISTS messages_sender_time ON messages(sender_id, created_at)`,
];

/** SQLite/D1용 전체 DDL. 순서대로 실행하면 새 DB가 바로 쓸 수 있는 상태가 된다. */
/** 테이블 DDL(신규 DB용)과 인덱스 DDL을 나눠 둔다. v4 DB에는 인덱스가 가리키는 컬럼(workspace_id 등)이
 * 아직 없으므로, migrate 는 "테이블 → 컬럼 추가 → 인덱스" 순서로 실행해야 한다. */
export const SQLITE_TABLE_STATEMENTS: string[] = [...SQLITE_BASE, ...SQLITE_WEBHOOKS];
export const SQLITE_INDEX_STATEMENTS: string[] = [...SQLITE_INDEXES];
export const SQLITE_SCHEMA_STATEMENTS: string[] = [...SQLITE_TABLE_STATEMENTS, ...SQLITE_INDEX_STATEMENTS];

const PG_BASE = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL,
    owner_code_hash TEXT NOT NULL,
    next_seq INTEGER NOT NULL DEFAULT 1,
    paused INTEGER NOT NULL DEFAULT 0,
    pause_reason TEXT,
    context_policy TEXT NOT NULL DEFAULT '개인 맥락(사용자의 사적 정보, 계정, 비밀)은 이 방에 공유하지 않습니다.',
    allowed_categories TEXT NOT NULL DEFAULT '["none"]',
    content_filter INTEGER NOT NULL DEFAULT 1,
    retention_days INTEGER,
    max_chain_depth INTEGER NOT NULL DEFAULT 6,
    rate_limit_count INTEGER NOT NULL DEFAULT 30,
    rate_limit_window_s INTEGER NOT NULL DEFAULT 600,
    workspace_id TEXT,
    kind TEXT NOT NULL DEFAULT 'room',
    last_message_at BIGINT,
    last_preview TEXT,
    last_sender_name TEXT,
    last_sender_type TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    max_uses INTEGER NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    revoked INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'room'
  )`,
  `CREATE TABLE IF NOT EXISTS join_requests (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    invite_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    product TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    claim_hash TEXT NOT NULL,
    claimed INTEGER NOT NULL DEFAULT 0,
    agent_id TEXT,
    created_at BIGINT NOT NULL,
    decided_at BIGINT,
    kind TEXT NOT NULL DEFAULT 'room',
    existing_agent INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    product TEXT NOT NULL DEFAULT '',
    token_hash TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'unclaimed',
    can_read INTEGER NOT NULL DEFAULT 1,
    can_write INTEGER NOT NULL DEFAULT 1,
    history_floor INTEGER NOT NULL DEFAULT 0,
    fetched_seq INTEGER NOT NULL DEFAULT 0,
    acked_seq INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    revoked_at BIGINT,
    last_seen BIGINT,
    workspace_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    id TEXT NOT NULL UNIQUE,
    client_id TEXT,
    sender_type TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    recipient_id TEXT,
    reply_to_seq INTEGER,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    context_category TEXT NOT NULL DEFAULT 'none',
    depth INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    deleted_at BIGINT,
    PRIMARY KEY (room_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS audit (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    room_id TEXT,
    ts BIGINT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS login_fails (
    room_id TEXT PRIMARY KEY,
    n INTEGER NOT NULL,
    first BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS auth_fails (
    scope TEXT PRIMARY KEY,
    n INTEGER NOT NULL,
    first BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS owners (
    id TEXT PRIMARY KEY,
    login_key TEXT NOT NULL,
    login_id TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    secret_hash TEXT NOT NULL,
    secret_kind TEXT NOT NULL DEFAULT 'password_pbkdf2',
    pw_salt TEXT NOT NULL DEFAULT '',
    pw_iter INTEGER NOT NULL DEFAULT 25000,
    created_at BIGINT NOT NULL,
    last_login_at BIGINT,
    status TEXT NOT NULL DEFAULT 'active'
  )`,
  `CREATE TABLE IF NOT EXISTS owner_sessions (
    token_hash TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    last_used BIGINT,
    label TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    owner_id TEXT REFERENCES owners(id),
    name TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    lobby_room_id TEXT,
    default_retention_days INTEGER,
    legacy_room_id TEXT,
    legacy_owner_code_hash TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'invited',
    can_read INTEGER NOT NULL DEFAULT 1,
    can_write INTEGER NOT NULL DEFAULT 1,
    history_floor INTEGER NOT NULL DEFAULT 0,
    fetched_seq INTEGER NOT NULL DEFAULT 0,
    acked_seq INTEGER NOT NULL DEFAULT 0,
    invited_at BIGINT,
    joined_at BIGINT,
    removed_at BIGINT,
    PRIMARY KEY (room_id, agent_id)
  )`,
  `CREATE TABLE IF NOT EXISTS owner_reads (
    owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    last_read_seq INTEGER NOT NULL DEFAULT 0,
    read_at BIGINT NOT NULL,
    PRIMARY KEY (owner_id, room_id)
  )`,
  `CREATE TABLE IF NOT EXISTS upgrade_tickets (
    token_hash TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
  )`,
];

// SQLITE_WEBHOOKS 와 같은 이유로 남긴 레거시 테이블이다(웹훅 기능은 제거됨).
const PG_WEBHOOKS = [
  `CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    webhook_id TEXT NOT NULL REFERENCES webhooks(id),
    room_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    message_id TEXT,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at BIGINT NOT NULL,
    last_error TEXT,
    http_status INTEGER,
    created_at BIGINT NOT NULL
  )`,
];

const PG_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS agents_live_name ON agents(room_id, name_key) WHERE status IN ('unclaimed','active')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS messages_idem ON messages(room_id, sender_id, client_id) WHERE client_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS messages_time ON messages(room_id, sender_type, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_webhooks_room ON webhooks(room_id, active)`,
  `CREATE INDEX IF NOT EXISTS idx_deliveries_due ON webhook_deliveries(status, next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS idx_deliveries_hook ON webhook_deliveries(webhook_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_deliveries_room ON webhook_deliveries(room_id)`,
  `CREATE INDEX IF NOT EXISTS idx_deliveries_cleanup ON webhook_deliveries(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_rooms_retention ON rooms(id) WHERE retention_days IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS owners_login ON owners(login_key)`,
  `CREATE INDEX IF NOT EXISTS idx_owner_sessions_owner ON owner_sessions(owner_id)`,
  `CREATE INDEX IF NOT EXISTS idx_owner_sessions_expires ON owner_sessions(expires_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS workspaces_legacy ON workspaces(legacy_room_id) WHERE legacy_room_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_id)`,
  `CREATE INDEX IF NOT EXISTS room_members_agent ON room_members(agent_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_upgrade_tickets_expires ON upgrade_tickets(expires_at)`,
  `CREATE INDEX IF NOT EXISTS rooms_ws ON rooms(workspace_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS agents_ws ON agents(workspace_id, status)`,
  `CREATE INDEX IF NOT EXISTS messages_sender_time ON messages(sender_id, created_at)`,
];

/** Postgres용 전체 DDL. */
export const POSTGRES_TABLE_STATEMENTS: string[] = [...PG_BASE, ...PG_WEBHOOKS];
export const POSTGRES_INDEX_STATEMENTS: string[] = [...PG_INDEXES];
export const POSTGRES_SCHEMA_STATEMENTS: string[] = [...POSTGRES_TABLE_STATEMENTS, ...POSTGRES_INDEX_STATEMENTS];

/**
 * v4 DB에만 없는 컬럼. migrate 가 존재를 확인한 뒤에만 ALTER 한다(재실행 안전).
 * 시각 컬럼의 타입은 SQLite(schema.test 의 컬럼 정의 비교)에서 INTEGER, Postgres에서 BIGINT다.
 */
export function addedColumns(dialect: "sqlite" | "postgres"): Array<{ table: string; column: string; ddl: string }> {
  const ts = dialect === "postgres" ? "BIGINT" : "INTEGER";
  return [
    { table: "rooms", column: "workspace_id", ddl: "ALTER TABLE rooms ADD COLUMN workspace_id TEXT" },
    { table: "rooms", column: "kind", ddl: "ALTER TABLE rooms ADD COLUMN kind TEXT NOT NULL DEFAULT 'room'" },
    { table: "rooms", column: "last_message_at", ddl: `ALTER TABLE rooms ADD COLUMN last_message_at ${ts}` },
    { table: "rooms", column: "last_preview", ddl: "ALTER TABLE rooms ADD COLUMN last_preview TEXT" },
    { table: "rooms", column: "last_sender_name", ddl: "ALTER TABLE rooms ADD COLUMN last_sender_name TEXT" },
    { table: "rooms", column: "last_sender_type", ddl: "ALTER TABLE rooms ADD COLUMN last_sender_type TEXT" },
    { table: "agents", column: "workspace_id", ddl: "ALTER TABLE agents ADD COLUMN workspace_id TEXT" },
    { table: "invites", column: "kind", ddl: "ALTER TABLE invites ADD COLUMN kind TEXT NOT NULL DEFAULT 'room'" },
    { table: "join_requests", column: "kind", ddl: "ALTER TABLE join_requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'room'" },
    { table: "join_requests", column: "existing_agent", ddl: "ALTER TABLE join_requests ADD COLUMN existing_agent INTEGER NOT NULL DEFAULT 0" },
  ];
}

/** 마이그레이션 기록 확인용 스키마 버전. DDL을 바꾸면 올린다. */
export const SCHEMA_VERSION = 5;

/** 백필·불변식 검증이 다루는 테이블(테스트가 재사용). */
export const V5_TABLES = ["owners", "owner_sessions", "workspaces", "room_members", "owner_reads", "upgrade_tickets"];
