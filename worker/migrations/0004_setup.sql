-- 0004: 웹 온보딩(CLI 없이 브라우저에서 첫 방 만들기) 지원
-- 관리자 키 시도 제한을 IP 단위로 기록한다(로그인 제한 login_fails와 별개).
CREATE TABLE IF NOT EXISTS auth_fails (
  scope TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  first INTEGER NOT NULL
);

-- 스키마 버전 표식: 워커가 첫 요청에서 이 값을 보고 DDL 재실행을 건너뛴다.
INSERT INTO meta(key, value) VALUES ('schema_version', '4')
  ON CONFLICT(key) DO UPDATE SET value=excluded.value;
