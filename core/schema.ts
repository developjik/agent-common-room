// 저장소 스키마 정의. 배포 직후 "마이그레이션 없이" 뜨는 것을 목표로 한다.
//  - SQLite 계열(로컬 Node 파일 DB, Cloudflare D1): worker/migrations/*.sql 과 같은 테이블/인덱스를
//    전부 IF NOT EXISTS로 다시 적었다. 첫 요청에서 ensureSchema()가 실행하며, 이미 있는 DB에는
//    없는 것만 추가된다(0001~0003으로 만들어진 인권 님의 기존 D1도 그대로 호환).
//  - Postgres(Vercel·Render): 같은 논리 스키마. 불리언은 INTEGER(0/1)로 맞춰 방 로직 SQL을 공유한다.
// 두 DDL이 서로 어긋나지 않는지는 test/schema.test.ts 가 검사한다.

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
    rate_limit_window_s INTEGER NOT NULL DEFAULT 600
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
    revoked INTEGER NOT NULL DEFAULT 0
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
    decided_at INTEGER
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
    last_seen INTEGER
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
];

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
];

/** SQLite/D1용 전체 DDL. 순서대로 실행하면 새 DB가 바로 쓸 수 있는 상태가 된다. */
export const SQLITE_SCHEMA_STATEMENTS: string[] = [...SQLITE_BASE, ...SQLITE_WEBHOOKS, ...SQLITE_INDEXES];

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
    rate_limit_window_s INTEGER NOT NULL DEFAULT 600
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
    revoked INTEGER NOT NULL DEFAULT 0
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
    decided_at BIGINT
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
    last_seen BIGINT
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
];

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
];

/** Postgres용 전체 DDL. */
export const POSTGRES_SCHEMA_STATEMENTS: string[] = [...PG_BASE, ...PG_WEBHOOKS, ...PG_INDEXES];

/** 마이그레이션 기록 확인용 스키마 버전. DDL을 바꾸면 올린다. */
export const SCHEMA_VERSION = 4;
