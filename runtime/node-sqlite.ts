// 로컬 Node·Render·Railway용 SQLite 드라이버(node:sqlite).
// 배포 즉시 쓸 수 있도록 첫 쿼리 전에 스키마(멱등 DDL)를 만든다.
import { DatabaseSync } from "node:sqlite";
import type { ChangeResult, DbStatement, Row, SqlDb, SqlDialect } from "../core/db.js";
import { migrateToLatest } from "../core/migrate.js";

interface BoundStatement {
  sql: string;
  params: any[];
}

export class NodeSqliteDb implements SqlDb {
  readonly dialect: SqlDialect = "sqlite";
  constructor(public raw: DatabaseSync) {}

  prep(sql: string, ...params: any[]): DbStatement {
    return { sql, params } as BoundStatement;
  }

  async one(sql: string, ...params: any[]): Promise<Row | undefined> {
    // UPDATE ... RETURNING * 같은 문장도 get()으로 첫 행을 받는다.
    return this.raw.prepare(sql).get(...params) as Row | undefined;
  }

  async all(sql: string, ...params: any[]): Promise<Row[]> {
    return this.raw.prepare(sql).all(...params) as Row[];
  }

  async run(sql: string, ...params: any[]): Promise<ChangeResult> {
    return this.runSync(sql, params);
  }

  private runSync(sql: string, params: any[]): ChangeResult {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes ?? 0) };
  }

  /**
   * batch는 하나의 트랜잭션이다. 문장 사이에 await를 두지 않아 이벤트 루프가 끼어들 수 없고,
   * 실패하면 전부 롤백한다(서비스의 seq 가드·경합 보상이 이 원자성에 의존한다).
   */
  async batch(statements: DbStatement[]): Promise<ChangeResult[]> {
    const out: ChangeResult[] = [];
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      for (const s of statements) {
        const b = s as BoundStatement;
        out.push(this.runSync(b.sql, b.params));
      }
      this.raw.exec("COMMIT");
    } catch (e) {
      try { this.raw.exec("ROLLBACK"); } catch { /* 이미 종료된 트랜잭션 */ }
      throw e;
    }
    return out;
  }

  async ensureSchema(): Promise<void> {
    // DDL·백필·불변식 검증을 한 절차로 실행한다(이미 최신이면 읽기 1회).
    await migrateToLatest(this);
  }

  async close(): Promise<void> {
    this.raw.close();
  }
}

export function openSqliteDb(path: string): NodeSqliteDb {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  return new NodeSqliteDb(db);
}
