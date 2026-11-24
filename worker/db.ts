// D1 래퍼. 로컬 Node 구현(src/db.ts, node:sqlite 동기 API)과 달리 전부 비동기다.
// 스키마 DDL은 worker/migrations/0001_init.sql 이 소유한다 (wrangler d1 migrations apply).

export type Row = Record<string, any>;

export class Db {
  constructor(private d1: D1Database) {}

  prep(sql: string, ...params: any[]): D1PreparedStatement {
    return this.d1.prepare(sql).bind(...params);
  }

  async one(sql: string, ...params: any[]): Promise<Row | undefined> {
    const r = await this.prep(sql, ...params).first<Row>();
    return r ?? undefined;
  }

  async all(sql: string, ...params: any[]): Promise<Row[]> {
    const r = await this.prep(sql, ...params).all<Row>();
    return r.results ?? [];
  }

  /** 반환값의 changes는 affected row 수. */
  async run(sql: string, ...params: any[]): Promise<{ changes: number }> {
    const r = await this.prep(sql, ...params).run();
    return { changes: Number(r.meta?.changes ?? 0) };
  }

  /** D1 batch()는 SQL 트랜잭션: 한 문장이 실패하면 전체가 롤백된다. */
  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    return this.d1.batch(statements);
  }
}

export function batchChanges(r: D1Result): number {
  return Number(r.meta?.changes ?? 0);
}

export function isConstraintError(e: unknown): boolean {
  return /constraint/i.test(e instanceof Error ? e.message : String(e));
}
