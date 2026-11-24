import { Db } from "./db";
import { handleFetch, type Env } from "./http";
import { RoomServiceD1 } from "./service";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(new RoomServiceD1(new Db(env.DB)), env, request, ctx);
  },
  // 매분: 보존기간 만료 메시지/세션 정리 + 웹훅 재시도 처리.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const svc = new RoomServiceD1(new Db(env.DB));
    ctx.waitUntil((async () => { await svc.purgeExpired(); await svc.processDueDeliveries(); })());
  },
};
