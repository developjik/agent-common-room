// Node HTTP ↔ Web 표준 Request/Response 브리지 + 프로세스 런타임(로컬·Render·Railway·Vercel).
// 코어 라우터(core/http.ts)는 Web 표준만 알기 때문에, 여기서 요청을 옮겨 담고 응답을 되쓴다.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { handleFetch, type Assets, type Ctx, type Env } from "../core/http.js";
import { ApiError, RoomService, realClock, type Clock, type WebhookSettings } from "../core/service.js";
import type { SqlDb } from "../core/db.js";
import { PostgresDb, createPostgresDb, detectPostgresUrl } from "./pg.js";

const MAX_BODY = 64 * 1024;

export interface NodeRuntimeOptions {
  /** 테스트·임베딩용 주입. 없으면 환경변수로 Postgres/SQLite를 고른다. */
  db?: SqlDb;
  env?: Env;
  clock?: Clock;
  /** 오너 UI 정적 파일 디렉터리. 기본값: 작업 디렉터리의 public/ */
  publicDir?: string;
  /** 요청이 올 때만 도는 정리 주기(ms). 0이면 끔. 서버리스(Vercel)는 10분 권장. */
  lazyPurgeMs?: number;
  /** 장수 프로세스의 주기 정리(ms). 0이면 끔. 로컬·Render·Railway는 1시간. */
  purgeIntervalMs?: number;
  /** 웹훅 발송 설정(테스트가 타임아웃·재시도·http 예외를 주입). 생략하면 환경변수를 따른다. */
  webhook?: WebhookSettings;
  /**
   * 서버리스(Vercel 등)에서 응답을 쓴 뒤 백그라운드 작업(웹훅 발송·재시도)이 끝날 때까지 기다리는 상한(ms).
   * 0(기본)이면 기다리지 않는다 — 장수 프로세스는 기다릴 필요가 없고, 서버리스는 응답 후 함수가 끝나
   * 진행 중인 fetch 가 잘릴 수 있어 짧게 붙잡는다.
   */
  drainBackgroundMs?: number;
}

export interface NodeRuntime {
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  svc: RoomService;
  db: SqlDb;
  env: Env;
  close(): Promise<void>;
}

function envFromProcess(): Env {
  const e = process.env;
  return {
    ACR_ADMIN_KEY: e.ACR_ADMIN_KEY,
    ACR_PUBLIC_URL: e.ACR_PUBLIC_URL,
    ACR_BOOTSTRAP: e.ACR_BOOTSTRAP,
    CRON_SECRET: e.CRON_SECRET,
    ACR_RUNTIME: e.ACR_RUNTIME ?? (e.VERCEL ? "vercel" : "node"),
  };
}

function makeAssets(dir: string): Assets {
  const cache = new Map<string, Uint8Array>();
  const types: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };
  return {
    async read(name) {
      if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.includes("..")) return null;
      let body = cache.get(name);
      if (!body) {
        try {
          body = readFileSync(join(dir, name));
        } catch {
          return null;
        }
        cache.set(name, body);
      }
      const ext = name.split(".").pop() ?? "";
      return { body, type: types[ext] ?? "application/octet-stream" };
    },
  };
}

function requestUrl(req: IncomingMessage): URL {
  const host = /^[A-Za-z0-9.:\-\[\]]+$/.test(req.headers.host ?? "") ? req.headers.host! : "localhost";
  const protoHeader = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const proto = protoHeader === "https" ? "https" : "http";
  return new URL(req.url ?? "/", `${proto}://${host}`);
}

async function readBody(req: IncomingMessage): Promise<Uint8Array | null> {
  if (req.method === "GET" || req.method === "HEAD") return null;
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  // 상한을 넘으면 더 읽지 않고 즉시 413을 낸다(남은 본문은 응답 종료 시 Node가 버린다).
  // async iterator를 throw로 끊으면 소켓까지 닫혀 413이 전달되지 않으므로 이벤트로 멈춘다.
  await new Promise<void>((resolve, reject) => {
    req.on("data", (c: Buffer) => {
      if (tooLarge) return;
      size += c.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        req.pause();
        resolve();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve());
    req.on("error", (e) => (tooLarge ? resolve() : reject(e)));
  });
  if (tooLarge) throw new ApiError(413, "body_too_large", "요청 본문이 너무 큽니다 (최대 64KB).");
  return chunks.length ? new Uint8Array(Buffer.concat(chunks)) : null;
}

async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const url = requestUrl(req);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) headers.append(k, item);
    else headers.set(k, String(v));
  }
  const body = await readBody(req);
  return new Request(url, { method: req.method ?? "GET", headers, body: (body ?? undefined) as unknown as BodyInit | undefined });
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}

/** 요청 하나를 코어로 넘기고 응답을 되쓴다. 413처럼 본문을 다 읽기 전에 끝나는 경우도 처리한다. */
async function serve(svc: RoomService, env: Env, assets: Assets, ctx: Ctx, req: IncomingMessage, res: ServerResponse, drain?: () => Promise<void>): Promise<void> {
  try {
    const webReq = await toWebRequest(req);
    const response = await handleFetch(svc, env, webReq, ctx, assets);
    await writeWebResponse(res, response);
  } catch (e) {
    if (res.headersSent) { res.end(); return; }
    const err = e instanceof ApiError ? e : new ApiError(500, "internal", "서버 내부 오류");
    if (!(e instanceof ApiError)) console.error("internal error:", e instanceof Error ? e.message : String(e));
    const body = JSON.stringify({ error: { code: err.code, message: err.message } });
    res.writeHead(err.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(body);
  } finally {
    // 응답은 이미 나갔다. 서버리스에서는 여기서 붙잡아야 웹훅 발송이 잘리지 않는다(장수 프로세스는 drain 없음).
    if (drain) await drain();
  }
}

async function resolveDb(opts: NodeRuntimeOptions): Promise<{ db: SqlDb; note: string }> {
  if (opts.db) return { db: opts.db, note: "injected" };
  const pgUrl = detectPostgresUrl();
  if (pgUrl) return { db: createPostgresDb(pgUrl), note: "postgres" };
  // SQLite는 필요할 때만 불러온다: Postgres만 쓰는 환경(예: Node 20 서버리스)에서
  // node:sqlite 모듈 로드 자체가 실패하지 않게 한다.
  const { openSqliteDb } = await import("./node-sqlite.js");
  const dbPath = process.env.ACR_DB ?? "./data/room.db";
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  return { db: openSqliteDb(dbPath), note: `sqlite:${dbPath}` };
}

export async function createNodeRuntime(opts: NodeRuntimeOptions = {}): Promise<NodeRuntime & { storage: string }> {
  const env = opts.env ?? envFromProcess();
  const { db, note } = await resolveDb(opts);
  if (db.ensureSchema) await db.ensureSchema();
  // 응답 뒤 작업(웹훅 발송·재시도)을 모아 둔다. 프로세스가 살아 있으면 그냥 진행되고,
  // 서버리스는 아래 drain 이 상한까지 기다려 준다(Vercel 은 응답이 끝나면 함수를 정리한다).
  const pending = new Set<Promise<unknown>>();
  const ctx: Ctx = {
    waitUntil(promise: Promise<unknown>) {
      const p = promise.catch(() => {});
      pending.add(p);
      void p.finally(() => pending.delete(p));
    },
  };
  const drainMs = opts.drainBackgroundMs ?? 0;
  const drain = async () => {
    if (!drainMs) return;
    const all = [...pending];
    if (!all.length) return;
    await Promise.race([
      Promise.allSettled(all),
      new Promise<void>((resolve) => { const t = setTimeout(resolve, drainMs); t.unref?.(); }),
    ]);
  };
  // 웹훅 예외 플래그는 환경변수로만 켠다(로컬 개발·CI). 미설정이면 https·공인 주소만 허용.
  const insecure = opts.webhook?.allowInsecure ?? (process.env.ACR_WEBHOOK_ALLOW_INSECURE === "1");
  const svc = new RoomService(db, opts.clock ?? realClock, {
    allowInsecure: insecure,
    // 자체 호스팅은 발송 직전 DNS 해석 결과까지 다시 검사한다(등록 뒤 사설 주소로 바뀌는 리바인딩 방어).
    // 예외 모드에서는 이름→루프백을 일부러 허용하므로 검사를 끈다.
    ...(insecure ? {} : { resolveHost: async (host: string) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address) }),
    background: (p: Promise<unknown>) => { if (ctx.waitUntil) ctx.waitUntil(p); else void p.catch(() => {}); },
    ...opts.webhook,
  });
  const publicDir = opts.publicDir ?? process.env.ACR_PUBLIC_DIR ?? join(process.cwd(), "public");
  const assets = makeAssets(publicDir);

  let lastPurge = 0;
  const lazyPurgeMs = opts.lazyPurgeMs ?? Number(process.env.ACR_LAZY_PURGE_MS ?? 0);
  const maybeLazyPurge = () => {
    if (!lazyPurgeMs) return;
    const now = Date.now();
    if (now - lastPurge < lazyPurgeMs) return;
    lastPurge = now;
    void svc.purgeExpired().catch(() => {});
  };

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    maybeLazyPurge();
    void serve(svc, env, assets, ctx, req, res, drain);
  };

  let timer: NodeJS.Timeout | undefined;
  const interval = opts.purgeIntervalMs ?? Number(process.env.ACR_PURGE_INTERVAL_MS ?? 0);
  if (interval > 0) {
    timer = setInterval(() => { void svc.purgeExpired().catch(() => {}); }, interval);
    timer.unref?.();
  }

  return {
    handler,
    svc,
    db,
    env,
    storage: note,
    async close() {
      if (timer) clearInterval(timer);
      await db.close?.();
    },
  };
}

/**
 * 서버리스(Vercel)용 핸들러. 첫 요청에서 런타임·스키마를 준비하고(콜드 스타트 1회), 이후 요청은 그대로 재사용한다.
 * 준비에 실패하면 다음 요청이 다시 시도한다.
 */
export function createNodeHandler(opts: NodeRuntimeOptions = {}): (req: IncomingMessage, res: ServerResponse) => void {
  // 서버리스는 응답 후 함수가 정리되므로, 웹훅 발송·재시도가 잘리지 않게 9초까지 붙잡는다
  // (Vercel 기본 실행 상한 안에서 재시도 대부분이 끝나는 값. 장수 프로세스는 이 옵션을 쓰지 않는다).
  const withDrain: NodeRuntimeOptions = { drainBackgroundMs: 9000, ...opts };
  let ready: Promise<NodeRuntime> | null = null;
  return (req, res) => {
    if (!ready) {
      ready = createNodeRuntime(withDrain).then((rt) => {
        if (opts.purgeIntervalMs && opts.purgeIntervalMs > 0) void rt.svc.purgeExpired().catch(() => {});
        return rt;
      });
      ready.catch(() => { ready = null; });
    }
    ready.then((rt) => rt.handler(req, res)).catch((e) => {
      console.error("runtime init failed:", e instanceof Error ? e.message : String(e));
      if (res.headersSent) { res.end(); return; }
      res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: { code: "internal", message: "서버 초기화에 실패했습니다." } }));
    });
  };
}

export interface StartedServer {
  server: Server;
  runtime: Awaited<ReturnType<typeof createNodeRuntime>>;
  url: string;
}

/** 프로세스 런타임 기동(로컬 npm start, Render, Railway). */
export async function startNodeServer(opts: NodeRuntimeOptions & { host?: string; port?: number } = {}): Promise<StartedServer> {
  const runtime = await createNodeRuntime(opts);
  const host = opts.host ?? process.env.ACR_HOST ?? "0.0.0.0";
  const port = opts.port ?? Number(process.env.PORT ?? process.env.ACR_PORT ?? 8787);
  const server = createServer(runtime.handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  return { server, runtime, url: `http://${host}:${actualPort}` };
}
