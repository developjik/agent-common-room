// Vercel 서버리스 엔트리. 모든 경로는 vercel.json의 rewrite로 이 함수에 모인다.
// 저장소는 DATABASE_URL/POSTGRES_URL(Neon·Vercel Postgres)을 자동 감지해 Postgres를 쓴다.
// 무료 플랜은 Cron이 하루 1회뿐이라, 요청이 올 때 안전한 주기(10분)로 만료 정리도 함께 돈다.
import { createNodeHandler } from "../runtime/node.js";

export default createNodeHandler({ lazyPurgeMs: 10 * 60_000, purgeIntervalMs: 0 });
