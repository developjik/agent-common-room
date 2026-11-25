// 저장소 포트. 방 로직(core/service.ts)은 이 인터페이스만 알면 되고,
// 실제 SQL 방언·드라이버는 런타임별 어댑터(runtime/d1.ts, runtime/pg.ts, runtime/node-sqlite.ts)가 맡는다.
//
// 규칙 (모든 어댑터가 지켜야 함):
//  - prep()는 실행 전 문장 핸들을 만든다. batch()는 그 문장들을 "하나의 트랜잭션"으로 실행한다.
//  - batch()는 원자적이다. 문장 하나가 실패하면 전체가 롤백되고, 예외는 호출자에게 그대로 올라간다.
//  - batch() 결과는 문장별 affected row 수(changes)를 같은 순서로 돌려준다.
//  - SQL은 SQLite 방언으로 쓴다(?, INTEGER 불리언, INSERT ... SELECT, RETURNING). 어댑터가 방언 차이를 흡수한다.

export type Row = Record<string, any>;

/** SQL 방언. 마이그레이션의 컬럼 존재 확인·시각 타입처럼 방언별 문장이 필요한 곳에서 쓴다. */
export type SqlDialect = "sqlite" | "postgres";

/** 실행 전 문장 핸들. 드라이버마다 실제 타입이 다르므로 불투명하게 취급한다. */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface DbStatement {}

export interface ChangeResult {
  changes: number;
}

export interface SqlDb {
  readonly dialect: SqlDialect;
  prep(sql: string, ...params: any[]): DbStatement;
  one(sql: string, ...params: any[]): Promise<Row | undefined>;
  all(sql: string, ...params: any[]): Promise<Row[]>;
  run(sql: string, ...params: any[]): Promise<ChangeResult>;
  batch(statements: DbStatement[]): Promise<ChangeResult[]>;
  /** 필요한 스키마를 만들고(멱등) 준비가 끝나면 resolve. 첫 요청/쿼리 전에 한 번 호출된다. */
  ensureSchema?(): Promise<void>;
  close?(): Promise<void>;
}

export function batchChanges(r: ChangeResult | undefined): number {
  return Number(r?.changes ?? 0);
}

/** 유니크/PK/외래키 위반인지. 드라이버마다 메시지가 달라 정규식으로 판별한다. */
export function isConstraintError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  // SQLite: "UNIQUE constraint failed", Postgres: "duplicate key value violates unique constraint"
  // / "violates foreign key constraint", D1: 같은 SQLite 메시지를 감싼 오류.
  return /constraint|duplicate key|unique violation/i.test(msg);
}
