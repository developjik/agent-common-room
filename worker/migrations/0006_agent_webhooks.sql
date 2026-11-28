-- 0006: 에이전트별 웹훅(HTTP POST 푸시) 등록 정보. core/schema.ts 의 agent_webhooks 와 같은 정의다.
-- 전부 추가(additive): 기존 테이블·데이터는 건드리지 않는다. 운영 D1은 첫 요청의 ensureSchema 가
-- 이 DDL을 IF NOT EXISTS 로 다시 실행하므로, 이 파일은 새 DB·wrangler d1 migrations 경로용 정본이다.
-- secret 은 HMAC 서명 키라 서버가 검증에 써야 하므로 해시가 아니라 그대로 저장한다(발급 응답에서 한 번만 보임).
CREATE TABLE IF NOT EXISTS agent_webhooks (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_delivery_at INTEGER,
  last_status INTEGER,
  last_error TEXT,
  failures INTEGER NOT NULL DEFAULT 0
);
