-- Agent Lounge D1 초기 스키마. 로컬 Node 구현(src/db.ts의 SCHEMA)과 같은 테이블을 만든다.
-- 차이: audit.id는 D1에서 AUTOINCREMENT 키워드 없이 INTEGER PRIMARY KEY 사용,
-- login_fails는 Workers 포트에서 오너 로그인 시도 제한을 격리(isolate) 간에 공유하기 위한 추가 테이블.
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rooms (
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
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS join_requests (
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
);
CREATE TABLE IF NOT EXISTS agents (
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
);
CREATE UNIQUE INDEX IF NOT EXISTS agents_live_name ON agents(room_id, name_key) WHERE status IN ('unclaimed','active');
CREATE TABLE IF NOT EXISTS messages (
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
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_idem ON messages(room_id, sender_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_time ON messages(room_id, sender_type, created_at);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  room_id TEXT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS login_fails (
  room_id TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  first INTEGER NOT NULL
);
