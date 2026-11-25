// Cloudflare Workers 진입점. 로컬 Node·Vercel과 같은 코어(core/)를 쓰고,
// 저장소만 D1 어댑터(worker/db.ts)로 바꾼다.
// UI 정적 파일은 Workers Static Assets([assets])가 서빙하고 CSP는 public/_headers가 붙인다.
import { handleFetch, type Env as CoreEnv } from "../core/http.js";
import { RoomService } from "../core/service.js";
import { D1Db } from "./db.js";

export interface Env extends CoreEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  ACR_BOOTSTRAP?: string;
  CRON_SECRET?: string;
  ACR_RUNTIME?: string;
}

// 격리(isolate)마다 한 번만 스키마를 준비한다. 실패하면 다음 요청에서 다시 시도한다.
let dbReady: Promise<D1Db> | null = null;
function readyDb(env: Env): Promise<D1Db> {
  if (!dbReady) {
    const db = new D1Db(env.DB);
    dbReady = db.ensureSchema().then(() => db).catch((e) => { dbReady = null; throw e; });
  }
  return dbReady;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const db = await readyDb(env);
    const svc = new RoomService(db);
    // Workers 환경 객체는 바인딩을 포함하므로 코어가 쓰는 문자열 변수만 추려 넘긴다.
    const coreEnv: CoreEnv = {
      ACR_ADMIN_KEY: env.ACR_ADMIN_KEY,
      ACR_PUBLIC_URL: env.ACR_PUBLIC_URL,
      ACR_BOOTSTRAP: env.ACR_BOOTSTRAP,
      CRON_SECRET: env.CRON_SECRET,
      ACR_RUNTIME: env.ACR_RUNTIME ?? "cloudflare",
    };
    return handleFetch(svc, coreEnv, request, ctx);
  },

  // 매분: 보존기간 만료 메시지/세션 정리 + 웹훅 재시도 처리.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const db = await readyDb(env);
    const svc = new RoomService(db);
    ctx.waitUntil((async () => { await svc.purgeExpired(); await svc.processDueDeliveries(); })());
  },
};
