-- 0003: 읽기 경로 인덱스 보강 (무료 D1 행 읽기 한도 소진 대응, 2026-11-25)
-- 매분 실행되는 cron 정리 쿼리와 방 삭제 경로가 테이블 전체를 스캔하지 않게 한다.
-- sessions 정리: purgeExpired가 매분 DELETE FROM sessions WHERE expires_at<=? 실행
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
-- 방 삭제: deleteRoom이 방마다 DELETE FROM webhook_deliveries WHERE room_id=? 실행
CREATE INDEX IF NOT EXISTS idx_deliveries_room ON webhook_deliveries(room_id);
-- 종결 전달 정리: 매분 DELETE ... WHERE status IN ('ok','failed') AND created_at<? 실행
CREATE INDEX IF NOT EXISTS idx_deliveries_cleanup ON webhook_deliveries(status, created_at);
-- 보존기간 방 순회: 매분 SELECT id FROM rooms WHERE retention_days IS NOT NULL ...
CREATE INDEX IF NOT EXISTS idx_rooms_retention ON rooms(id) WHERE retention_days IS NOT NULL;
