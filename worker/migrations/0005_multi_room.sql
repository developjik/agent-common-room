-- 0005: 멀티룸(워크스페이스 · 에이전트 풀 · 방 구성원) — 전부 추가(additive)만 한다.
-- 기존 테이블은 재작성하지 않고, v4 데이터는 워커 첫 요청에서 core/migrate.ts 의 백필이 채운다.
--
-- 적용 순서 주의: 이 파일은 "구조"만 만든다. schema_version 은 여기서 올리지 않는다.
-- 또 이 파일은 ALTER TABLE 을 포함하므로 **한 번만** 적용된다(재실행하면 duplicate column). 그래서
-- 워커가 먼저 자동 이관한 DB(schema_version=5)에는 이 명령을 다시 적용하지 않는다(DEPLOY-CLOUDFLARE.md 참고).
-- 워커는 meta.schema_version < 5 이면 (1) DDL 재실행(IF NOT EXISTS, 무시됨) (2) 없는 컬럼 ALTER
-- (3) 백필(레거시 방 하나 = 워크스페이스 하나, 그 방이 로비) (4) 불변식 5종 검증 을 마친 뒤에만
-- version=5 를 쓴다. 그래서 이 SQL 을 먼저 손으로 돌려도 백필이 건너뛰어지지 않는다.

-- ---------- 새 테이블 6개 ----------
-- 오너 계정: 아이디(비밀 아님) + 비밀번호(PBKDF2-SHA256, 계정별 솔트·반복 저장)
CREATE TABLE IF NOT EXISTS owners (
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
);

-- 오너 세션(30일, 슬라이딩). 평문은 응답·쿠키에만 있고 저장은 SHA-256 해시다.
CREATE TABLE IF NOT EXISTS owner_sessions (
  token_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used INTEGER,
  label TEXT NOT NULL DEFAULT ''
);

-- 워크스페이스 = 테넌트. lobby_room_id 가 기존 "공용방"의 정체성을 보존한다.
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  owner_id TEXT REFERENCES owners(id),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  lobby_room_id TEXT,
  default_retention_days INTEGER,
  legacy_room_id TEXT,
  legacy_owner_code_hash TEXT
);

-- 신원(agents)과 분리된 방별 구성원 자격·권한·읽기 커서.
CREATE TABLE IF NOT EXISTS room_members (
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
);

-- 오너가 방마다 어디까지 읽었는지(방 카드의 unread).
CREATE TABLE IF NOT EXISTS owner_reads (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, room_id)
);

-- 레거시 로그인 → 오너 계정 승격 티켓(10분, 해시 저장).
CREATE TABLE IF NOT EXISTS upgrade_tickets (
  token_hash TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- ---------- 컬럼 추가 (v4 DB에는 없음, 재실행 시 중복 오류는 워커가 사전 확인으로 막는다) ----------
ALTER TABLE rooms ADD COLUMN workspace_id TEXT;
ALTER TABLE rooms ADD COLUMN kind TEXT NOT NULL DEFAULT 'room';
ALTER TABLE rooms ADD COLUMN last_message_at INTEGER;
ALTER TABLE rooms ADD COLUMN last_preview TEXT;
ALTER TABLE rooms ADD COLUMN last_sender_name TEXT;
ALTER TABLE rooms ADD COLUMN last_sender_type TEXT;
ALTER TABLE agents ADD COLUMN workspace_id TEXT;
ALTER TABLE invites ADD COLUMN kind TEXT NOT NULL DEFAULT 'room';
ALTER TABLE join_requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'room';
ALTER TABLE join_requests ADD COLUMN existing_agent INTEGER NOT NULL DEFAULT 0;

-- ---------- 인덱스 ----------
CREATE UNIQUE INDEX IF NOT EXISTS owners_login ON owners(login_key);
CREATE INDEX IF NOT EXISTS idx_owner_sessions_owner ON owner_sessions(owner_id);
CREATE INDEX IF NOT EXISTS idx_owner_sessions_expires ON owner_sessions(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_legacy ON workspaces(legacy_room_id) WHERE legacy_room_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_id);
CREATE INDEX IF NOT EXISTS room_members_agent ON room_members(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_upgrade_tickets_expires ON upgrade_tickets(expires_at);
CREATE INDEX IF NOT EXISTS rooms_ws ON rooms(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS agents_ws ON agents(workspace_id, status);
CREATE INDEX IF NOT EXISTS messages_sender_time ON messages(sender_id, created_at);
