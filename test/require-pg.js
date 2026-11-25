// 실제 Postgres 계약 테스트는 전용 DB가 필요하다(TEST_DATABASE_URL). 운영 DB를 지우지 않도록 opt-in.
if (!process.env.TEST_DATABASE_URL) {
  console.error("test:pg는 TEST_DATABASE_URL이 필요합니다. 예: TEST_DATABASE_URL=postgres://user:pw@127.0.0.1:5432/acr_test npm run test:pg");
  process.exit(1);
}
