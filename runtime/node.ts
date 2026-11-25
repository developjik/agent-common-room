// Node HTTP ↔ Web 표준 Request/Response 브리지 + 프로세스 런타임(로컬·Render·Railway·Vercel).
// 코어 라우터(core/http.ts)는 Web 표준만 알기 때문에, 여기서 요청을 옮겨 담고 응답을 되쓴다.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { handleFetch, type Assets, type Ctx, type Env } from "../core/http.js";
import { ApiError, RoomService, realClock, type Clock } from "../core/service.js";
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
async function serve(svc: RoomService, env: Env, assets: Assets, ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
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
  const svc = new RoomService(db, opts.clock ?? realClock);
  const publicDir = opts.publicDir ?? process.env.ACR_PUBLIC_DIR ?? join(process.cwd(), "public");
  const assets = makeAssets(publicDir);

  let lastPurge = 0;
  const lazyPurgeMs = opts.lazyPurgeMs ?? Number(process.env.ACR_LAZY_PURGE_MS ?? 0);
  const ctx: Ctx = {
    waitUntil(promise: Promise<unknown>) { void promise.catch(() => {}); },
  };
  const maybeLazyPurge = () => {
    if (!lazyPurgeMs) return;
    const now = Date.now();
    if (now - lastPurge < lazyPurgeMs) return;
    lastPurge = now;
    void svc.purgeExpired().catch(() => {});
  };

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    maybeLazyPurge();
    void serve(svc, env, assets, ctx, req, res);
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
  let ready: Promise<NodeRuntime> | null = null;
  return (req, res) => {
    if (!ready) {
      ready = createNodeRuntime(opts).then((rt) => {
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
