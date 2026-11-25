import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { newToken, newId, sha256Hex, safeEqualHex, hmacSha256Hex } from "../core/crypto.js";
import { toPgParams } from "../runtime/pg.js";
import { start, ADMIN_KEY, EXTERNAL } from "./helpers.js";

// fast-check 프로퍼티 테스트: 예시 테스트가 덮지 못하는 입력 공간의 불변 조건을 검증한다.
// 무작위 탐색이므로 외부(운영) 대상으로는 실행하지 않는다. EXTERNAL 모드에서는 전체를 건너뛴다.

const msg = (client_id: string, content: string, extra: Record<string, unknown> = {}) => ({ client_id, content, ...extra });

test("토큰/ID는 항상 접두사+본문 형식이고 100개를 뽑아도 충돌하지 않는다", { skip: EXTERNAL }, () => {
  fc.assert(fc.property(fc.stringMatching(/^[a-z]{1,8}$/), (prefix) => {
    const tok = newToken(prefix);
    const id = newId(prefix);
    assert.ok(tok.startsWith(prefix + "_"), tok);
    assert.ok(id.startsWith(prefix + "_"), id);
    assert.ok(new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`).test(tok), tok);
    assert.ok(new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`).test(id), id);
  }));
  const seenTok = new Set<string>();
  const seenId = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const tok = newToken("acr");
    const id = newId("acr");
    assert.ok(!seenTok.has(tok), "토큰 충돌");
    assert.ok(!seenId.has(id), "ID 충돌");
    seenTok.add(tok);
    seenId.add(id);
  }
});

test("sha256Hex/hashToken은 결정적이고 항상 64자리 소문자 hex다", { skip: EXTERNAL }, async () => {
  await fc.assert(fc.asyncProperty(fc.string(), async (s) => {
    const a = await sha256Hex(s);
    const b = await sha256Hex(s);
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  }));
});

test("safeEqualHex는 정확히 같은 비어있지 않은 문자열에만 true를 준다 (빈 해시는 항상 불일치)", { skip: EXTERNAL }, () => {
  fc.assert(fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (a, b) => {
    assert.equal(safeEqualHex(a, b), a === b, `${a} vs ${b}`);
  }));
  fc.assert(fc.property(fc.string({ minLength: 1 }), (a) => {
    assert.equal(safeEqualHex(a, a + "x"), false);
  }));
  // 저장된 해시가 빈 문자열인 손상 상태에서는 어떤 입력도 통과하면 안 된다
  fc.assert(fc.property(fc.string(), (a) => {
    assert.equal(safeEqualHex(a, ""), false);
    assert.equal(safeEqualHex("", a), false);
  }));
});

test("hmacSha256Hex는 결정적이며 시크릿이나 문서가 다르면 출력도 다르다", { skip: EXTERNAL }, async () => {
  // WebCrypto는 빈 HMAC 키를 거부하므로 시크릿은 1자 이상 (실제 시크릿은 항상 비어있지 않음)
  await fc.assert(fc.asyncProperty(fc.string({ minLength: 1 }), fc.string(), async (secret, text) => {
    const a = await hmacSha256Hex(secret, text);
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.equal(await hmacSha256Hex(secret, text), a);
    if (text !== text + "x") assert.notEqual(await hmacSha256Hex(secret, text + "x"), a);
    if (secret !== secret + "x") assert.notEqual(await hmacSha256Hex(secret + "x", text), a);
  }));
});

// toPgParams의 독립 오라클: 문자열 리터럴('' 이스케이프 포함)과 -- 주석을 제거한 뒤 남은 ?의 개수와 순서.
function expectedPlaceholders(sql: string): number {
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (ch === "?") n++;
    i++;
  }
  return n;
}
function outsideHasBareQ(sql: string): boolean {
  // 오라클: 리터럴·-- 주석 밖에 날것의 ?가 하나라도 있으면 true.
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (ch === "?") return true;
    i++;
  }
  return false;
}

function outsidePlaceholderNumbers(sql: string): number[] {
  // 오라클: 리터럴·-- 주석 밖에서만 $n을 수집한다 (주석/리터럴 안의 $0 같은 텍스트는 플레이스홀더가 아님).
  const nums: number[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (ch === "$" && i + 1 < sql.length && sql[i + 1] >= "0" && sql[i + 1] <= "9") {
      let j = i + 1;
      while (j < sql.length && sql[j] >= "0" && sql[j] <= "9") j++;
      nums.push(Number(sql.slice(i + 1, j)));
      i = j;
      continue;
    }
    i++;
  }
  return nums;
}

const frag = fc.oneof(
  fc.stringMatching(/^[A-Z_ ]{0,12}$/),
  fc.constant("?"),
  fc.string().map((s) => `'${s.replace(/'/g, "''")}'`),
  fc.string().map((s) => `--${s.replace(/\n/g, " ")}`),
  fc.constant("\n"),
);

test("toPgParams: 리터럴·주석 밖의 ?는 순서대로 $1..$n이 되고, 밖에 ?가 남지 않는다", { skip: EXTERNAL }, () => {
  fc.assert(fc.property(fc.array(frag, { maxLength: 12 }).map((a) => a.join(" ")), (sql) => {
    const out = toPgParams(sql);
    const n = expectedPlaceholders(sql);
    const got = outsidePlaceholderNumbers(out);
    assert.deepEqual(got, Array.from({ length: n }, (_, i) => i + 1), `placeholders for ${JSON.stringify(sql)} -> ${out}`);
    // 변환 결과에서 리터럴·주석 밖에 남은 ?가 없어야 한다
    assert.ok(!outsideHasBareQ(out), `bare ? left: ${JSON.stringify(out)}`);
  }));
});

test("toPgParams: 리터럴·주석 안의 내용은 바이트 그대로 보존된다", { skip: EXTERNAL }, () => {
  fc.assert(fc.property(fc.string(), fc.string(), (inner, comment) => {
    const lit = `'${inner.replace(/'/g, "''")}'`;
    const com = `--${comment.replace(/\n/g, " ")}`;
    const sql = `SELECT 1, ${lit} WHERE a=? ${com}`;
    const out = toPgParams(sql);
    assert.ok(out.includes(lit), `literal changed: ${JSON.stringify(out)}`);
    assert.ok(out.includes(com), `comment changed: ${JSON.stringify(out)}`);
    assert.equal(out, `SELECT 1, ${lit} WHERE a=$1 ${com}`);
  }));
});

// ----- 서비스 수준 프로퍼티 (로컬 인메모리 런타임, HTTP 경유) -----

let t: Awaited<ReturnType<typeof start>>;
before(async () => { t = await start(); });
after(async () => { await t.close(); });

const RUNS = { numRuns: 25 }; // HTTP 경유라 방당 수십 호출; 예시 테스트와 실행 시간 균형

test("멱등성: 같은 발신자+client_id는 같은 본문이면 1건만, 다른 본문이면 409", { skip: EXTERNAL }, async () => {
  // 본문은 서버 검증(공백만·4000자 초과 불가, 비밀 패턴 필터)을 항상 통과하는 짧은 소문자 단어 조합으로 제한
  const body = fc.stringMatching(/^[a-z]{1,10}( [a-z]{1,10}){0,3}$/);
  await fc.assert(fc.asyncProperty(
    fc.stringMatching(/^[a-z0-9-]{1,16}$/),
    body,
    body,
    fc.integer({ min: 1, max: 3 }),
    async (cid, body1, body2, repeats) => {
      fc.pre(body1 !== body2);
      const r = await t.setupRoom();
      const a = await t.join(r, "alpha");
      const first = await t.call("POST", "/api/messages", a.token, msg(cid, body1));
      assert.equal(first.status, 201);
      for (let i = 0; i < repeats; i++) {
        const dup = await t.call("POST", "/api/messages", a.token, msg(cid, body1));
        assert.equal(dup.status, 200, "같은 본문 재전송은 200 duplicate");
        assert.equal(dup.json.message.seq, first.json.message.seq);
        assert.equal(dup.json.duplicate, true);
      }
      assert.equal((await t.call("POST", "/api/messages", a.token, msg(cid, body2))).status, 409, "다른 본문은 충돌");
      assert.equal((t.sqlite.raw.prepare("SELECT count(*) c FROM messages WHERE room_id=?").get(r.roomId) as any).c, 1, "저장은 1건");
    },
  ), RUNS);
});

test("seq 무결성: 임의 수의 발신자가 동시에 보내도 1..n이 중복·구멍 없이 부여된다", { skip: EXTERNAL }, async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 1, max: 3 }),
    fc.integer({ min: 1, max: 30 }),
    async (senders, count) => {
      const r = await t.setupRoom();
      const agents = [];
      for (let i = 0; i < senders; i++) agents.push(await t.join(r, `a${i}`));
      const jobs = [];
      for (let i = 0; i < count; i++) jobs.push(t.call("POST", "/api/messages", agents[i % senders].token, msg(`c${i}`, `m${i}`)));
      const res = await Promise.all(jobs);
      assert.ok(res.every((x) => x.status === 201), JSON.stringify(res.find((x) => x.status !== 201)?.json));
      const seqs = res.map((x) => x.json.message.seq as number).sort((x, y) => x - y);
      assert.deepEqual(seqs, Array.from({ length: count }, (_, i) => i + 1));
    },
  ), RUNS);
});

test("권한 분리: 어떤 잘못된 토큰으로도 agent API는 401", { skip: EXTERNAL }, async () => {
  await fc.assert(fc.asyncProperty(fc.string({ minLength: 0, maxLength: 40 }), async (junk) => {
    const r = await t.setupRoom();
    const a = await t.join(r, "alpha");
    const bad = [junk, r.invite, r.sess, ADMIN_KEY, a.claimSecret];
    for (const token of bad) {
      assert.equal((await t.call("GET", "/api/inbox", token)).status, 401, `inbox with ${String(token).slice(0, 12)}`);
      assert.equal((await t.call("POST", "/api/messages", token, msg("x", "y"))).status, 401);
    }
  }), RUNS);
});

test("페이지네이션: 임의 개수·페이지 크기로 읽어도 커서가 메시지를 건너뛰거나 중복하지 않는다", { skip: EXTERNAL }, async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 1, max: 25 }),
    fc.integer({ min: 1, max: 7 }),
    async (count, page) => {
      const r = await t.setupRoom();
      const a = await t.join(r, "alpha");
      for (let i = 0; i < count; i++) {
        const p = await t.call("POST", "/api/messages", a.token, msg(`p${i}`, `m${i}`));
        assert.equal(p.status, 201);
      }
      const seen: number[] = [];
      let after = 0;
      for (;;) {
        const res = await t.call("GET", `/api/messages?after=${after}&limit=${page}`, a.token);
        assert.equal(res.status, 200);
        const list = res.json.messages as { seq: number }[];
        if (!list.length) break;
        // 서버가 limit을 무시하고 더 많이 돌려주거나(페이지 크기 강제), 커서를 앞으로 옮기지 못하면(진행 보장) 실패해야 한다
        assert.ok(list.length <= page, `limit=${page}인데 ${list.length}개 반환`);
        const last = list[list.length - 1].seq;
        assert.ok(last > after, `커서가 진행하지 않음: after=${after} last=${last}`);
        for (const m of list) seen.push(m.seq);
        after = last;
      }
      assert.deepEqual(seen, Array.from({ length: count }, (_, i) => i + 1), "커서 읽기는 1..n을 한 번씩 순서대로");
    },
  ), RUNS);
});
