// 스키마 일치 검사: 배포 경로가 무엇이든 같은 논리 스키마를 갖게 한다.
//  - worker/migrations/*.sql(기존 D1 운영 DB의 정본) 과 core/schema.ts의 SQLite DDL이 같은 테이블·컬럼·인덱스를 만드는지
//  - Postgres DDL이 SQLite와 같은 테이블·컬럼 이름을 갖는지
//  - 새 테이블(auth_fails)이 마이그레이션 파일에도 있는지
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { POSTGRES_SCHEMA_STATEMENTS, SQLITE_SCHEMA_STATEMENTS } from "../core/schema.js";

// dist/test → 저장소 루트의 worker/migrations (실행 cwd가 아니라 파일 위치 기준)
const MIGRATIONS_DIR = new URL("../../worker/migrations/", import.meta.url);

function sqliteFromMigrations(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) db.exec(readFileSync(new URL(f, MIGRATIONS_DIR), "utf8"));
  return db;
}

function sqliteFromSchema(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const stmt of SQLITE_SCHEMA_STATEMENTS) db.exec(stmt);
  return db;
}

const objects = (db: DatabaseSync) =>
  (db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as any[])
    .map((r) => `${r.type}:${r.name}`);

const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as any[])
    .map((c) => `${c.name}:${String(c.type).toUpperCase()}:${c.notnull}:${c.pk}`)
    .sort();

/** Postgres DDL에서 테이블별 컬럼 이름만 뽑는다(간단한 구조 파서). */
function pgColumns(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\)\s*`?\s*,?\s*$/gm;
  for (const stmt of POSTGRES_SCHEMA_STATEMENTS) {
    const m = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*)\)\s*$/.exec(stmt);
    if (!m) continue;
    const body = m[2];
    const cols: string[] = [];
    let depth = 0, cur = "";
    for (const ch of body) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) { cols.push(cur); cur = ""; continue; }
      cur += ch;
    }
    if (cur.trim()) cols.push(cur);
    const names = cols
      .map((c) => c.trim())
      .filter((c) => c && !/^(PRIMARY|UNIQUE|CONSTRAINT|FOREIGN|CHECK)\b/i.test(c))
      .map((c) => c.split(/\s+/)[0].toLowerCase());
    out.set(m[1].toLowerCase(), names);
  }
  void re;
  return out;
}

test("마이그레이션 파일과 core 스키마가 같은 테이블·인덱스를 만든다", () => {
  const a = objects(sqliteFromMigrations());
  const b = objects(sqliteFromSchema());
  assert.deepEqual(b, a, "테이블/인덱스 목록이 다르다 (core/schema.ts 와 worker/migrations 정합 필요)");
});

test("마이그레이션과 core 스키마의 컬럼 정의가 같다", () => {
  const m = sqliteFromMigrations();
  const s = sqliteFromSchema();
  const tables = (s.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as any[]).map((r) => r.name);
  assert.ok(tables.length >= 12, "테이블 수");
  for (const t of tables) assert.deepEqual(columns(s, t), columns(m, t), `${t} 컬럼 불일치`);
});

test("최초 설정 테이블(auth_fails)이 마이그레이션에도 있다", () => {
  const m = sqliteFromMigrations();
  assert.ok(objects(m).includes("table:auth_fails"));
  const cols = columns(m, "auth_fails").map((c) => c.split(":")[0]);
  assert.deepEqual(cols.sort(), ["first", "n", "scope"]);
});

test("Postgres 스키마는 SQLite와 같은 테이블·컬럼 이름을 쓴다", () => {
  const s = sqliteFromSchema();
  const pg = pgColumns();
  const tables = (s.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as any[]).map((r) => r.name);
  for (const t of tables) {
    assert.ok(pg.has(t), `Postgres DDL에 ${t} 없음`);
    const sqliteCols = columns(s, t).map((c) => c.split(":")[0]).sort();
    assert.deepEqual([...pg.get(t)!].sort(), sqliteCols, `${t} 컬럼 이름 불일치`);
  }
  assert.equal(pg.size, tables.length, "Postgres에만 있는 테이블이 있다");
});
