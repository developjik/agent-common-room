import { Db } from "./db";
import { handleFetch, type Env } from "./http";
import { RoomServiceD1 } from "./service";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return handleFetch(new RoomServiceD1(new Db(env.DB)), env, request);
  },
  // 매시간 보존기간 만료 메시지와 만료 세션을 정리한다 (로컬 구현의 시간당 purgeExpired와 동일).
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(new RoomServiceD1(new Db(env.DB)).purgeExpired());
  },
};
