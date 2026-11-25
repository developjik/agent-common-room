// Postgres 드라이버(Vercel Postgres/Neon, Render Postgres, 그 밖의 표준 Postgres).
// 방 로직 SQL은 SQLite 방언(?)으로 쓰여 있으므로, 여기서 $1..$n 으로 변환하고 트랜잭션을 맡는다.
// 문자열 리터럴('...') 안의 ?는 건드리지 않는다.
import pg from "pg";
import type { Pool, PoolClient } from "pg";
import type { ChangeResult, DbStatement, Row, SqlDb, SqlDialect } from "../core/db.js";
import { migrateToLatest } from "../core/migrate.js";

const { Pool: PgPool } = pg;

/** int8(COUNT(*), BIGINT)는 JS number로 받는다. 문자열로 오면 비교·산술에서 실수가 난다. */
function configureTypes() {
  const t = (pg as any).types;
  if (t?.setTypeParser) t.setTypeParser(20, (v: string) => Number(v));
}

interface BoundStatement {
  sql: string;
  params: any[];
}

/** '?' 플레이스홀더를 Postgres의 $n으로 바꾼다. 작은따옴표 문자열/주석은 건너뛴다. */
export function toPgParams(sql: string): string {
  let out = "";
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      out += ch;
      i++;
      for (;;) {
        if (i >= sql.length) break;
        const c = sql[i];
        out += c;
        i++;
        if (c === "'") {
          if (sql[i] === "'") { out += sql[i]; i++; continue; } // '' 이스케이프
          break;
        }
      }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "?") {
      n++;
      out += `$${n}`;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** 접속 문자열에서 sslmode 등은 pg가 해석한다. 로컬이 아니면 TLS를 기본으로 요구한다. */
function poolConfig(url: string) {
  const u = new URL(url);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
  const needsSsl = !local && !/sslmode=/.test(url);
  return {
    connectionString: url,
    max: Number(process.env.ACR_PG_POOL_MAX ?? 4),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  };
}

/**
 * 잠금을 잡은 "연결 하나"에 묶인 어댑터. 풀 크기가 1인 배포(ACR_PG_POOL_MAX=1)에서도
 * 스키마 준비가 같은 연결을 재사용하게 한다(추가 연결을 요구하면 시작이 멈춘다).
 */
class ClientDb implements SqlDb {
  readonly dialect: SqlDialect = "postgres";
  constructor(private client: PoolClient) {}
  prep(sql: string, ...params: any[]): DbStatement {
    return { sql: toPgParams(sql), params } as BoundStatement;
  }
  async one(sql: string, ...params: any[]): Promise<Row | undefined> {
    const r = await this.client.query(toPgParams(sql), params);
    return r.rows[0];
  }
  async all(sql: string, ...params: any[]): Promise<Row[]> {
    const r = await this.client.query(toPgParams(sql), params);
    return r.rows;
  }
  async run(sql: string, ...params: any[]): Promise<ChangeResult> {
    const r = await this.client.query(toPgParams(sql), params);
    return { changes: Number(r.rowCount ?? 0) };
  }
  async batch(statements: DbStatement[]): Promise<ChangeResult[]> {
    const out: ChangeResult[] = [];
    await this.client.query("BEGIN");
    try {
      for (const s of statements) {
        const b = s as BoundStatement;
        const r = await this.client.query(b.sql, b.params);
        out.push({ changes: Number(r.rowCount ?? 0) });
      }
      await this.client.query("COMMIT");
      return out;
    } catch (e) {
      try { await this.client.query("ROLLBACK"); } catch { /* 연결이 이미 끊긴 경우 */ }
      throw e;
    }
  }
  async ensureSchema(): Promise<void> { /* 잠금 안에서만 쓰는 어댑터 */ }
}

export class PostgresDb implements SqlDb {
  readonly dialect: SqlDialect = "postgres";
  private schemaReady: Promise<void> | null = null;
  constructor(public pool: Pool) {}

  prep(sql: string, ...params: any[]): DbStatement {
    return { sql: toPgParams(sql), params } as BoundStatement;
  }

  async one(sql: string, ...params: any[]): Promise<Row | undefined> {
    const r = await this.pool.query(toPgParams(sql), params);
    return r.rows[0];
  }

  async all(sql: string, ...params: any[]): Promise<Row[]> {
    const r = await this.pool.query(toPgParams(sql), params);
    return r.rows;
  }

  async run(sql: string, ...params: any[]): Promise<ChangeResult> {
    const r = await this.pool.query(toPgParams(sql), params);
    return { changes: Number(r.rowCount ?? 0) };
  }

  /** batch = 한 클라이언트의 한 트랜잭션. 실패하면 전부 롤백한다. */
  async batch(statements: DbStatement[]): Promise<ChangeResult[]> {
    const client: PoolClient = await this.pool.connect();
    const out: ChangeResult[] = [];
    try {
      await client.query("BEGIN");
      for (const s of statements) {
        const b = s as BoundStatement;
        const r = await client.query(b.sql, b.params);
        out.push({ changes: Number(r.rowCount ?? 0) });
      }
      await client.query("COMMIT");
      return out;
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* 연결이 이미 끊긴 경우 */ }
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * 스키마 준비(멱등). 서버리스에서 여러 인스턴스가 동시에 시작해도 안전하도록
   * advisory lock 안에서 DDL·백필을 한 번만 실행한다.
   */
  ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = (async () => {
        const client = await this.pool.connect();
        let locked = false;
        try {
          // 동시 부팅 시 DDL 경합 방지. (advisory lock이 없는 엔진에서도 스키마 준비는 계속한다)
          try { await client.query("SELECT pg_advisory_lock(914_210_731)"); locked = true; } catch { /* noop */ }
          // migrate 는 batch(=트랜잭션)와 개별 조회를 섞어 쓴다. 잠금을 잡은 "이 연결"로만 실행한다
          // (풀 크기 1인 배포에서 두 번째 연결을 요구하면 시작이 멈춘다).
          await migrateToLatest(new ClientDb(client));
        } catch (e) {
          this.schemaReady = null;
          throw e;
        } finally {
          if (locked) { try { await client.query("SELECT pg_advisory_unlock(914_210_731)"); } catch { /* noop */ } }
          client.release();
        }
      })();
    }
    return this.schemaReady;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createPostgresDb(url: string): PostgresDb {
  configureTypes();
  return new PostgresDb(new PgPool(poolConfig(url)));
}

/** 배포 환경에서 자동 감지할 접속 문자열 후보. Vercel Postgres/Neon은 POSTGRES_URL, 그 외는 DATABASE_URL. */
export function detectPostgresUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  for (const k of ["ACR_DATABASE_URL", "DATABASE_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL", "NEON_DATABASE_URL"]) {
    const v = env[k];
    if (v && /^postgres(ql)?:\/\//.test(v)) return v;
  }
  return undefined;
}
