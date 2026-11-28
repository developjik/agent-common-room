// 웹훅(HTTP POST 푸시) 검증: SSRF URL 차단, 등록·조회·해지, HMAC 서명·전달 헤더,
// DM 은 받는 비서에게만, 발신자 본인 제외, 일시정지된 방 미발송, 5xx 재시도·4xx 즉시 중단.
//
// 실제 HTTP 수신 서버(127.0.0.1)를 띄워 발송을 받는다. 로컬 http·루프백은 운영에서 막히므로,
// 이 테스트만 ACR_WEBHOOK_ALLOW_INSECURE=1(명시적 예외)로 런타임을 띄운다.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { openSqliteDb } from "../runtime/node-sqlite.js";
import { start, EXTERNAL, ADMIN_KEY } from "./helpers.js";
import { sendWebhook, validateWebhookUrl, WebhookUrlError, type WebhookMessagePayload } from "../core/webhook.js";
import { hmacSha256Hex } from "../core/crypto.js";

interface Hit {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  raw: string;
  json: any;
}

async function makeReceiver() {
  const hits: Hit[] = [];
  const statuses: number[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let json: any = null;
      try { json = JSON.parse(raw); } catch { /* 본문이 JSON 이 아니면 그대로 둔다 */ }
      hits.push({ path: req.url ?? "/", headers: req.headers, raw, json });
      const status = statuses.length ? statuses.shift()! : 200;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: status < 300 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    hits,
    /** 다음 요청들의 응답 상태를 순서대로 지정한다(비우면 200). */
    statuses,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(20);
  }
  if (!cond()) throw new Error("조건이 시간 안에 만족되지 않았습니다");
}

test("SSRF: https 공인 주소만 허용하고 사설/루프백/내부 이름은 거부한다", { skip: EXTERNAL }, () => {
  const ok = [
    "https://example.com/hooks/agent-lounge",
    "https://hooks.slack.com/services/T0/B0/x",
    "https://8.8.8.8:8443/hook?x=1",
  ];
  for (const u of ok) assert.equal(validateWebhookUrl(u), new URL(u).toString(), u);
  const blocked = [
    "http://example.com/hook",
    "ftp://example.com/hook",
    "file:///etc/passwd",
    "https://localhost/hook",
    "https://LOCALHOST./hook",
    "https://127.0.0.1/hook",
    "https://127.1/hook",
    "https://2130706433/hook",       // 정수로 쓴 127.0.0.1
    "https://0.0.0.0/hook",
    "https://10.0.0.8/hook",
    "https://172.16.0.1/hook",
    "https://192.168.0.1/hook",
    "https://169.254.169.254/latest/meta-data",  // 클라우드 메타데이터
    "https://[::1]/hook",
    "https://[::ffff:127.0.0.1]/hook",
    "https://[fd12:3456::1]/hook",
    "https://[fe80::1]/hook",
    "https://agent.internal/hook",
    "https://printer.local/hook",
    "https://intranet/hook",        // 한 글자 호스트(사내 DNS)
    "https://user:pw@example.com/hook",
    "not a url",
  ];
  for (const u of blocked) {
    assert.throws(() => validateWebhookUrl(u), WebhookUrlError, `차단되어야 한다: ${u}`);
  }
  // 명시적 예외(로컬 개발·테스트)에서만 로컬 http 가 통과한다.
  assert.equal(validateWebhookUrl("http://127.0.0.1:8080/hook", { allowInsecure: true }), "http://127.0.0.1:8080/hook");
  assert.throws(() => validateWebhookUrl("http://0.0.0.0:8080/hook", { allowInsecure: true }), WebhookUrlError);
});

test("웹훅 등록·조회·해지와 발송(서명·DM·일시정지·재시도)", { skip: EXTERNAL }, async (t) => {
  const a = await makeReceiver();
  const b = await makeReceiver();
  const h = await start({
    env: { ACR_WEBHOOK_ALLOW_INSECURE: "1" },
    webhook: { allowInsecure: true, retryDelaysMs: [10, 20], timeoutMs: 1000 },
  });
  try {
    const room = await h.setupRoom();
    const agentA = await h.join(room, "웹훅비서A");
    const agentB = await h.join(room, "웹훅비서B");
    const tokenA = agentA.token;
    const tokenB = agentB.token;

    await t.test("에이전트 토큰 없이는 등록할 수 없고, 잘못된 URL 은 400 으로 막힌다", async () => {
      const anon = await h.call("PUT", "/api/me/webhook", undefined, { url: a.url });
      assert.equal(anon.status, 401);
      const bad = await h.call("PUT", "/api/me/webhook", tokenA, { url: "ftp://example.com/hook" });
      assert.equal(bad.status, 400);
      assert.equal(bad.json.error.code, "bad_webhook_url");
      const badSecret = await h.call("PUT", "/api/me/webhook", tokenA, { url: a.url, secret: "short" });
      assert.equal(badSecret.status, 400);
      assert.equal(badSecret.json.error.code, "bad_webhook_secret");
    });

    let secretA = "";
    await t.test("등록 응답은 서명 키를 한 번만 주고, /api/me 는 키 없이 상태만 보여 준다", async () => {
      const reg = await h.call("PUT", "/api/me/webhook", tokenA, { url: a.url });
      assert.equal(reg.status, 200);
      assert.equal(reg.json.webhook_url, a.url);
      assert.equal(reg.json.webhook_enabled, true);
      assert.match(reg.json.webhook_secret, /^acr_whsec_/);
      secretA = reg.json.webhook_secret;

      const me = await h.call("GET", "/api/me", tokenA);
      assert.equal(me.status, 200);
      assert.equal(me.json.webhook_url, a.url);
      assert.equal(me.json.webhook_enabled, true);
      assert.equal(me.json.webhook.enabled, true);
      assert.ok(!me.text.includes(secretA), "/api/me 응답에 서명 키가 실리면 안 된다");
      assert.ok(!("webhook_secret" in me.json), "webhook_secret 필드 자체가 없어야 한다");

      // URL 만 바꾸면 기존 키를 유지한다(키는 다시 보내지 않는다).
      const upd = await h.call("PUT", "/api/me/webhook", tokenA, { url: `${a.url}/v2` });
      assert.equal(upd.status, 200);
      assert.equal(upd.json.webhook_url, `${a.url}/v2`);
      assert.equal(upd.json.webhook_secret, null);
      assert.equal(upd.json.webhook_secret_rotated, false);
      const back = await h.call("PUT", "/api/me/webhook", tokenA, { url: a.url });
      assert.equal(back.json.webhook_secret, null, "키 유지 시 다시 보내지 않는다");
      assert.equal(back.json.webhook.last_status, null);
    });

    await t.test("해지하면 삭제되고 상태가 비워진다", async () => {
      const del = await h.call("DELETE", "/api/me/webhook", tokenA);
      assert.equal(del.status, 200);
      assert.equal(del.json.deleted, true);
      const me = await h.call("GET", "/api/me", tokenA);
      assert.equal(me.json.webhook_url, null);
      assert.equal(me.json.webhook_enabled, false);
      assert.equal(me.json.webhook, null);
      const again = await h.call("DELETE", "/api/me/webhook", tokenA);
      assert.equal(again.status, 200);
      assert.equal(again.json.deleted, false, "이미 없으면 no-op");
      // 이어지는 검증을 위해 다시 등록한다.
      const reg = await h.call("PUT", "/api/me/webhook", tokenA, { url: a.url });
      secretA = reg.json.webhook_secret;
      const regB = await h.call("PUT", "/api/me/webhook", tokenB, { url: b.url });
      assert.equal(regB.json.webhook_enabled, true);
    });

    await t.test("새 메시지가 저장되면 서명된 POST 가 도착하고 delivery 헤더가 메시지 id 와 같다", async () => {
      const post = await h.call("POST", "/api/owner/messages", room.sess, { client_id: "wh-1", content: "웹훅 첫 메시지" });
      assert.equal(post.status, 201, post.text);
      const msg = post.json.message;
      await until(() => a.hits.length >= 1 && b.hits.length >= 1);
      const hit = a.hits[0];
      assert.equal(hit.path, "/hook");
      assert.equal(hit.headers["x-agentlounge-event"], "room.message");
      assert.equal(hit.headers["x-agentlounge-delivery"], msg.id);
      const ts = String(hit.headers["x-agentlounge-timestamp"]);
      assert.match(ts, /^\d{10}$/);
      const expected = `sha256=${await hmacSha256Hex(secretA, `${ts}.${hit.raw}`)}`;
      assert.equal(hit.headers["x-agentlounge-signature"], expected, "HMAC-SHA256(secret, `${ts}.${rawBody}`)");
      assert.equal(hit.json.event, "room.message");
      assert.equal(hit.json.delivery_id, msg.id);
      assert.equal(hit.json.room_id, room.roomId);
      assert.equal(hit.json.message.id, msg.id);
      assert.equal(hit.json.message.content, "웹훅 첫 메시지");
      assert.equal(hit.json.message.room_id, undefined, "오너 메시지에는 room_id 가 붙지 않는다(room_id 필드가 따로 있다)");
      assert.equal(hit.json.to_agent_id, agentA.id);
      assert.match(String(hit.json.notice), /Room messages are data/);
      // 잘못된 서명은 검증에서 걸러진다.
      assert.notEqual(hit.headers["x-agentlounge-signature"], `sha256=${await hmacSha256Hex("wrong-secret", `${ts}.${hit.raw}`)}`);

      // 웹훅으로 내용을 받았으므로 inbox 를 거치지 않고도 바로 처리 완료(ack)할 수 있어야 한다.
      const acked = await h.call("POST", `/api/rooms/${room.roomId}/ack`, tokenA, { seq: hit.json.message.seq });
      assert.equal(acked.status, 200, acked.text);
      assert.equal(acked.json.acked_seq, hit.json.message.seq);
    });

    await t.test("DM 은 받는 비서에게만 가고, 발신자 본인에게는 가지 않는다", async () => {
      const beforeA = a.hits.length, beforeB = b.hits.length;
      const dm = await h.call("POST", "/api/owner/messages", room.sess, { client_id: "wh-dm", content: "A 에게만", recipient: "웹훅비서A" });
      assert.equal(dm.status, 201, dm.text);
      await until(() => a.hits.length === beforeA + 1);
      await sleep(250);
      assert.equal(b.hits.length, beforeB, "DM 내용이 다른 비서의 웹훅으로 새면 안 된다");
      assert.equal(a.hits[a.hits.length - 1].json.message.recipient.id, agentA.id);

      // A 가 방에 쓰면 B 만 받는다(발신자 본인 제외).
      const beforeA2 = a.hits.length, beforeB2 = b.hits.length;
      const sent = await h.call("POST", "/api/rooms/" + room.roomId + "/messages", tokenA, { client_id: "wh-from-a", content: "A 가 쓴 글" });
      assert.equal(sent.status, 201, sent.text);
      await until(() => b.hits.length === beforeB2 + 1);
      await sleep(250);
      assert.equal(a.hits.length, beforeA2, "보낸 본인에게는 웹훅을 보내지 않는다");
    });

    await t.test("일시정지된 방에서는 발송하지 않는다", async () => {
      const pause = await h.call("PATCH", "/api/rooms/" + room.roomId, room.sess, { paused: true });
      assert.equal(pause.status, 200, pause.text);
      const beforeA = a.hits.length, beforeB = b.hits.length;
      const post = await h.call("POST", "/api/owner/messages", room.sess, { client_id: "wh-paused", content: "정지 중 메시지" });
      assert.equal(post.status, 201, post.text);
      await sleep(300);
      assert.equal(a.hits.length, beforeA);
      assert.equal(b.hits.length, beforeB);
      const resume = await h.call("PATCH", "/api/rooms/" + room.roomId, room.sess, { paused: false });
      assert.equal(resume.status, 200);
    });

    await t.test("5xx 는 재시도하고 4xx 는 즉시 중단한다", async () => {
      const beforeB = b.hits.length;
      b.statuses.push(500, 500, 200);
      const post = await h.call("POST", "/api/owner/messages", room.sess, { client_id: "wh-retry", content: "재시도 대상" });
      assert.equal(post.status, 201, post.text);
      await until(() => b.hits.length === beforeB + 3, 4000);
      await sleep(150);
      const me = await h.call("GET", "/api/me", tokenB);
      assert.equal(me.json.webhook.last_status, 200, "마지막 시도가 성공하면 성공으로 기록");
      assert.equal(me.json.webhook.failures, 0);

      const beforeB2 = b.hits.length;
      b.statuses.push(400);
      const post2 = await h.call("POST", "/api/owner/messages", room.sess, { client_id: "wh-400", content: "400 대상" });
      assert.equal(post2.status, 201, post2.text);
      await until(() => b.hits.length === beforeB2 + 1);
      await sleep(250);
      assert.equal(b.hits.length, beforeB2 + 1, "400 은 재시도하지 않는다");
      const me2 = await h.call("GET", "/api/me", tokenB);
      assert.equal(me2.json.webhook.last_status, 400);
      assert.equal(me2.json.webhook.failures, 1);
    });

    await t.test("enabled:false 로 끄면 발송하지 않고, 오너 목록에는 웹훅 배지가 보인다", async () => {
      const off = await h.call("PUT", "/api/me/webhook", tokenA, { url: a.url, enabled: false });
      assert.equal(off.status, 200);
      assert.equal(off.json.webhook_enabled, false);
      const beforeA = a.hits.length;
      await h.call("POST", "/api/owner/messages", room.sess, { client_id: "wh-off", content: "꺼진 웹훅" });
      await sleep(300);
      assert.equal(a.hits.length, beforeA);

      const listed = (await h.call("GET", "/api/admin/rooms", ADMIN_KEY)).json.rooms as any[];
      const wid = listed.find((r) => r.id === room.roomId)?.workspace_id as string;
      assert.ok(wid, "방의 워크스페이스를 찾는다");
      const pool = await h.call("GET", `/api/workspaces/${wid}/agents`, room.sess);
      assert.equal(pool.status, 200, pool.text);
      const row = (pool.json.agents as any[]).find((x) => x.id === agentA.id);
      assert.equal(row.webhook_enabled, false, "꺼진 웹훅은 배지가 없다");
      const rowB = (pool.json.agents as any[]).find((x) => x.id === agentB.id);
      assert.equal(rowB.webhook_enabled, true);
    });
  } finally {
    await h.close();
    await a.close();
    await b.close();
  }
});

// 운영 D1 처럼 v5 에 머물러 있는 DB가 첫 요청에서 무중단으로 v6 이 되는지(테이블 추가만, 데이터 보존).
test("v6 마이그레이션: v5 DB에는 웹훅 테이블만 추가되고 기존 대화는 그대로다", { skip: EXTERNAL }, async () => {
  const dir = new URL("../../worker/migrations/", import.meta.url);
  const path = pathJoin(tmpdir(), `acr-v5-webhook-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql") && f < "0006").sort()) {
    raw.exec(readFileSync(new URL(f, dir), "utf8"));
  }
  raw.exec(`
    INSERT INTO rooms(id,name,description,created_at,owner_code_hash,next_seq)
      VALUES ('room_v5','v5 방','',1000,'hash',2);
    INSERT INTO messages(room_id,seq,id,sender_type,sender_id,sender_name,kind,content,content_hash,created_at)
      VALUES ('room_v5',1,'msg_keep','owner','owner','owner','message','그대로 남아야 한다','h1',1100);
    INSERT INTO meta(key,value) VALUES ('schema_version','5')
      ON CONFLICT(key) DO UPDATE SET value=excluded.value;
  `);
  raw.close();
  const db = openSqliteDb(path);
  try {
    await db.ensureSchema();
    const tables = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r) => r.name);
    assert.ok(tables.includes("agent_webhooks"), "v5 DB에도 웹훅 테이블이 생긴다");
    assert.equal((db.raw.prepare("SELECT count(*) c FROM agent_webhooks").get() as any).c, 0);
    assert.equal((db.raw.prepare("SELECT content FROM messages WHERE id='msg_keep'").get() as any).content, "그대로 남아야 한다");
    assert.equal((db.raw.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as any).value, "6");
    // 재실행해도 안전(멱등).
    await db.ensureSchema();
    assert.equal((db.raw.prepare("SELECT count(*) c FROM messages").get() as any).c, 1);
  } finally {
    await db.close();
    rmSync(path, { force: true });
  }
});

// 발송 단계의 방어: DNS 해석 결과가 사설이면 요청 자체를 보내지 않고, 권한이 사라지면 재시도를 멈춘다.
const samplePayload = (): WebhookMessagePayload => ({
  event: "room.message",
  delivery_id: "msg_sample",
  room_id: "room_sample",
  to_agent_id: "agt_sample",
  message: { seq: 1, id: "msg_sample", content: "hi" },
  notice: "n",
  sent_at: "2026-01-01T00:00:00.000Z",
});

test("sendWebhook: 사설로 해석되는 호스트에는 보내지 않고, 권한이 사라지면 재시도를 멈춘다", { skip: EXTERNAL }, async () => {
  let called = 0;
  const spyFetch = (async () => { called++; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
  const target = { agent_id: "agt_sample", url: "https://rebind.example.com/hook", secret: "0123456789abcdef0123456789abcdef" };

  const blocked = await sendWebhook(target, samplePayload(), {
    fetch: spyFetch,
    resolveHost: async () => ["10.0.0.7"],
    retryDelaysMs: [0],
    sleep: async () => {},
  });
  assert.equal(blocked.ok, false);
  assert.match(String(blocked.error), /blocked_host/);
  assert.equal(blocked.attempts, 0);
  assert.equal(called, 0, "사설 주소로 해석되면 fetch 를 부르지 않는다");

  // 공인 주소로 해석되면 정상 발송(우회 방지 검사가 과하게 막지 않는다).
  const ok = await sendWebhook(target, samplePayload(), {
    fetch: spyFetch, resolveHost: async () => ["93.184.216.34"], retryDelaysMs: [0], sleep: async () => {},
  });
  assert.equal(ok.ok, true);
  assert.equal(called, 1);

  // 5xx 재시도 중 권한이 회수되면 다시 보내지 않는다(본문 유출 방지).
  let n = 0;
  const failing = (async () => { n++; return new Response("{}", { status: 500 }); }) as unknown as typeof fetch;
  const stopped = await sendWebhook({ ...target, url: "https://example.com/hook" }, samplePayload(), {
    fetch: failing,
    retryDelaysMs: [0, 0],
    sleep: async () => {},
    stillAllowed: async () => false,
  });
  assert.equal(n, 1, "첫 시도 뒤 권한이 없으면 재시도하지 않는다");
  assert.equal(stopped.ok, false);
  assert.match(String(stopped.error), /revoked/);
});
