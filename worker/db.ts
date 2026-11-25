// D1 어댑터. core/db.ts의 SqlDb 포트를 D1 바인딩으로 구현한다.
// D1에는 대화형 트랜잭션이 없지만 batch()가 곧 SQL 트랜잭션이라, 코어의 "조건부 UPDATE + batch" 불변조건이 그대로 성립한다.
import type { ChangeResult, DbStatement, Row, SqlDb, SqlDialect } from "../core/db.js";
import { migrateToLatest } from "../core/migrate.js";

export class D1Db implements SqlDb {
  readonly dialect: SqlDialect = "sqlite";
  constructor(private d1: D1Database) {}

  prep(sql: string, ...params: any[]): DbStatement {
    return this.d1.prepare(sql).bind(...params);
  }

  async one(sql: string, ...params: any[]): Promise<Row | undefined> {
    const r = await this.d1.prepare(sql).bind(...params).first<Row>();
    return r ?? undefined;
  }

  async all(sql: string, ...params: any[]): Promise<Row[]> {
    const r = await this.d1.prepare(sql).bind(...params).all<Row>();
    return r.results ?? [];
  }

  async run(sql: string, ...params: any[]): Promise<ChangeResult> {
    const r = await this.d1.prepare(sql).bind(...params).run();
    return { changes: Number(r.meta?.changes ?? 0) };
  }

  async batch(statements: DbStatement[]): Promise<ChangeResult[]> {
    if (!statements.length) return [];
    const results = await this.d1.batch(statements as D1PreparedStatement[]);
    return results.map((r) => ({ changes: Number(r.meta?.changes ?? 0) }));
  }

  /**
   * 배포 버튼으로 새로 만든 D1에도, 0001~0004만 적용된 기존 D1에도
   * "마이그레이션 명령 없이" 스키마를 갖추게 한다. 이미 최신이면 읽기 1회로 끝난다.
   * v4 → v5 백필·불변식 검증은 core/migrate.ts 가 맡는다.
   */
  async ensureSchema(): Promise<void> {
    await migrateToLatest(this);
  }
}
