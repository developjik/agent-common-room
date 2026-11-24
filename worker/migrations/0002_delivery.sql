-- 0002: 오너 웹훅(지정 수신 메시지 알림) + 전달 시도 기록.
CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_webhooks_room ON webhooks(room_id, active);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id),
  room_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- message | ping
  message_id TEXT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | ok | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  http_status INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_deliveries_due ON webhook_deliveries(status, next_attempt_at);
CREATE INDEX idx_deliveries_hook ON webhook_deliveries(webhook_id, id);
