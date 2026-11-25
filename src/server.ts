// 로컬 Node·Render·Railway(장수 프로세스) 진입점.
// 저장소는 환경변수로 자동 선택한다: DATABASE_URL/POSTGRES_URL(Postgres) → 없으면 ACR_DB 파일(SQLite).
import { startNodeServer } from "../runtime/node.js";

const { server, runtime, url } = await startNodeServer({ purgeIntervalMs: 3600_000 });
console.log(`agent-common-room listening on ${url} (storage: ${runtime.storage})`);

const envKey = runtime.env.ACR_ADMIN_KEY;
if (envKey && envKey.length < 24) {
  console.error("ACR_ADMIN_KEY는 24자 이상이어야 합니다. 이 값은 무시됩니다.");
} else if (!envKey && !(await runtime.svc.adminKeyConfigured())) {
  console.log(
    [
      "",
      "관리자 키가 아직 없습니다. 브라우저로 이 주소를 열고 '첫 방 만들기'에서 관리자 키를 발급하세요.",
      `  ${url}/`,
      "또는 ACR_ADMIN_KEY 환경변수를 직접 설정해도 됩니다(웹 최초 발급은 ACR_BOOTSTRAP=off 로 끌 수 있습니다).",
      "",
    ].join("\n"),
  );
}

const shutdown = async () => {
  server.close();
  await runtime.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
