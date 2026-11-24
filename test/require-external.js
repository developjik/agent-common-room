// test:worker는 실제 Worker(wrangler dev 또는 배포 URL)를 대상으로 돌아야 의미가 있다.
// ACR_EXTERNAL_BASE 없이 실행하면 로컬 Node 서버만 검증하므로 여기서 막는다.
if (!process.env.ACR_EXTERNAL_BASE) {
  console.error("test:worker는 ACR_EXTERNAL_BASE가 필요합니다. 예: ACR_EXTERNAL_BASE=http://127.0.0.1:8787 npm run test:worker");
  process.exit(1);
}
