import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { start, ADMIN_KEY, EXTERNAL } from "./helpers.js";

let t: Awaited<ReturnType<typeof start>>;
before(async () => { t = await start(); });
after(async () => { await t.close(); });

const msg = (client_id: string, content: string, extra: Record<string, unknown> = {}) => ({ client_id, content, ...extra });

test("권한 분리: 초대/에이전트/세션/관리자 토큰은 서로의 영역에 쓸 수 없다", async () => {
  const r = await t.setupRoom();
  const a = await t.join(r, "alpha");
  assert.equal((await t.call("GET", "/api/inbox", r.invite)).status, 401, "invite로 읽기 불가");
  assert.equal((await t.call("GET", "/api/owner/room", a.token)).status, 401, "agent token으로 owner API 불가");
  assert.equal((await t.call("POST", "/api/admin/rooms", a.token, { name: "x" })).status, 401);
  assert.equal((await t.call("POST", "/api/admin/rooms", r.sess, { name: "x" })).status, 401, "세션으로 관리 불가");
  assert.equal((await t.call("GET", "/api/inbox", r.sess)).status, 401, "세션으로 agent API 불가");
  assert.equal((await t.call("GET", "/api/inbox", ADMIN_KEY)).status, 401, "관리자 키로 메시지 읽기 불가");
  assert.equal((await t.call("GET", "/api/owner/messages", ADMIN_KEY)).status, 401);
  assert.equal((await t.call("GET", "/api/inbox", a.token)).status, 200);
});

test("초대 링크는 참여 요청만 가능하고 안내 페이지에 토큰이 새지 않는다", async () => {
  const r = await t.setupRoom();
  const page = await t.call("GET", `/join/${r.invite}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /참여 요청만/);
  assert.ok(!page.text.includes(r.ownerCode) && !page.text.includes(r.sess));
  assert.equal((await t.call("GET", "/join/acr_inv_nope")).status, 404);
  const jr = await t.call("POST", `/api/join/${r.invite}`, undefined, { display_name: "owner" });
  assert.equal(jr.status, 400, "예약 이름 거부");
});

test("토큰은 발급 시 한 번만 평문, DB에는 해시만", async () => {
  const r = await t.setupRoom();
  const jr = (await t.call("POST", `/api/join/${r.invite}`, undefined, { display_name: "beta" })).json;
  await t.call("POST", `/api/owner/join-requests/${jr.request_id}/approve`, r.sess, {});
  const c1 = await t.call("POST", `/api/join-requests/${jr.request_id}/claim`, undefined, { claim_secret: jr.claim_secret });
  assert.equal(c1.json.status, "approved");
  const token = c1.json.agent_token as string;
  const c2 = await t.call("POST", `/api/join-requests/${jr.request_id}/claim`, undefined, { claim_secret: jr.claim_secret });
  assert.equal(c2.status, 409);
  assert.ok(!c2.text.includes(token));
  assert.equal((await t.call("POST", `/api/join-requests/${jr.request_id}/claim`, undefined, { claim_secret: "wrong" })).status, 404);
  if (!EXTERNAL) {
    for (const secret of [token, r.ownerCode, r.sess, r.invite, jr.claim_secret, ADMIN_KEY]) {
      for (const tbl of ["agents", "rooms", "sessions", "invites", "join_requests", "meta", "audit", "messages"]) {
        const rows = t.sqlite.raw.prepare(`SELECT * FROM ${tbl}`).all();
        assert.ok(!JSON.stringify(rows).includes(secret), `${tbl}에 평문 비밀이 있음`);
      }
    }
  }
});

test("거부된 요청은 토큰을 받지 못한다", async () => {
  const r = await t.setupRoom();
  const jr = (await t.call("POST", `/api/join/${r.invite}`, undefined, { display_name: "gamma" })).json;
  assert.equal((await t.call("POST", `/api/owner/join-requests/${jr.request_id}/deny`, r.sess, {})).status, 200);
  const c = await t.call("POST", `/api/join-requests/${jr.request_id}/claim`, undefined, { claim_secret: jr.claim_secret });
  assert.equal(c.json.status, "denied");
  assert.equal(c.json.agent_token, undefined);
});

test("서버가 발신자를 강제하고 seq가 부여된다", async () => {
  const r = await t.setupRoom();
  const a = await t.join(r, "alpha");
  const p = await t.call("POST", "/api/messages", a.token, msg("c1", "안녕", { sender: { name: "owner" }, sender_id: "owner", sender_name: "owner" }));
  assert.equal(p.status, 201);
  assert.equal(p.json.message.seq, 1);
  assert.equal(p.json.message.sender.name, "alpha");
  assert.equal(p.json.message.sender.type, "agent");
});

test("멱등 재시도: 같은 id 같은 내용은 중복 없음, 다른 내용은 충돌", async () => {
  const r = await t.setupRoom();
  const a = await t.join(r, "alpha");
  const p1 = await t.call("POST", "/api/messages", a.token, msg("dup", "내용"));
  const p2 = await t.call("POST", "/api/messages", a.token, msg("dup", "내용"));
  assert.equal(p1.json.message.seq, p2.json.message.seq);
  assert.equal(p2.json.duplicate, true);
  assert.equal((await t.call("POST", "/api/messages", a.token, msg("dup", "다른 내용"))).status, 409);
  assert.equal((await t.call("POST", "/api/messages", a.token, msg("dup", "내용", { kind: "question" }))).status, 409);
  const b = await t.join(r, "beta");
  assert.equal((await t.call("POST", "/api/messages", b.token, msg("dup", "다른 내용"))).status, 201, "client_id는 발신자별");
  if (!EXTERNAL) assert.equal((t.sqlite.raw.prepare("SELECT count(*) c FROM messages WHERE room_id=?").get(r.roomId) as any).c, 2);
});

test("동시 전송에서도 seq가 중복/누락 없이 할당된다", async () => {
  const r = await t.setupRoom();
  const a = await t.join(r, "alpha");
  const b = await t.join(r, "beta");
  await t.call("PATCH", "/api/owner/room", r.sess, { rate_limit_count: 1000 });
  const jobs: Promise<any>[] = [];
  for (let i = 0; i < 40; i++) jobs.push(t.call("POST", "/api/messages", i % 2 ? a.token : b.token, msg(`k${i}`, `m${i}`)));
  const res = await Promise.all(jobs);
  assert.ok(res.every(x => x.status === 201));
  const seqs = res.map(x => x.json.message.seq as number).sort((x, y) => x - y);
  assert.deepEqual(seqs, Array.from({ length: 40 }, (_, i) => i + 1));
});

test("fetched와 ack 분리: 재전달, 커서 읽기와 전송은 ack를 올리지 않는다", async () => {
  const r = await t.setupRoom();
  const a = await t.join(r, "alpha", { history: "all" });
  const b = await t.join(r, "beta", { history: "all" });
  for (let i = 1; i <= 3; i++) await t.call("POST", "/api/messages", a.token, msg(`a${i}`, `hello ${i}`));
  const i1 = (await t.call("GET", "/api/inbox", b.token)).json;
  assert.deepEqual(i1.messages.map((m: any) => m.seq), [1, 2, 3]);
  assert.ok(i1.messages.every((m: any) => m.redelivered === false));
  assert.equal(i1.fetched_seq, 3); assert.equal(i1.acked_seq, 0);
  // 재접속: ack 안 했으므로 재전달
  const i2 = (await t.call("GET", "/api/inbox", b.token)).json;
  assert.deepEqual(i2.messages.map((m: any) => m.seq), [1, 2, 3]);
  assert.ok(i2.messages.every((m: any) => m.redelivered === true));
  // 커서 읽기와 전송은 ack 불변
  await t.call("GET", "/api/messages?after=0", b.token);
  await t.call("POST", "/api/messages", b.token, msg("b1", "reply", { reply_to: 3 }));
  assert.equal((await t.call("GET", "/api/inbox", b.token)).json.acked_seq, 0);
  // fetched 넘어서 ack 불가
  assert.equal((await t.call("POST", "/api/ack", b.token, { seq: 99 })).status, 400);
  assert.equal((await t.call("POST", "/api/ack", b.token, { seq: 2 })).json.acked_seq, 2);
  assert.equal((await t.call("POST", "/api/ack", b.token, { seq: 1 })).json.acked_seq, 2, "ack는 단조 증가");
  const i3 = (await t.call("GET", "/api/inbox", b.token)).json;
  assert.deepEqual(i3.messages.map((m: any) => m.seq), [3]);
  assert.equal(i3.messages[0].redelivered, true);
});

test("읽기 범위: history none/all, 지정 수신자 가시성", async () => {
  const r = await t.setupRoom();
  const a = await t.join(r, "alpha", { history: "all" });
  await t.call("POST", "/api/messages", a.token, msg("o1", "참여 전 공개글"));
  await t.call("POST", "/api/messages", a.token, msg("o2", "참여 전 지정글", { recipient: "alpha2" })).then(x => assert.equal(x.status, 404));
  const late = await t.join(r, "late", { history: "none" });
  const full = await t.join(r, "full", { history: "all" });
  assert.equal((await t.call("GET", "/api/messages?after=0", late.token)).json.messages.length, 0);
  assert.equal((await t.call("GET", "/api/messages?after=0", full.token)).json.messages.length, 1);
  assert.equal((await t.call("POST", "/api/messages", late.token, msg("r", "x", { reply_to: 1 }))).status, 404, "보이지 않는 메시지에 답장 불가");
  // 지정 메시지: full -> alpha, late는 못 봄
  const d = await t.call("POST", "/api/messages", full.token, msg("d1", "alpha에게만", { recipient: "alpha" }));
  assert.equal(d.status, 201);
  assert.equal((await t.call("GET", "/api/messages?after=0", late.token)).json.messages.filter((m: any) => m.seq === d.json.message.seq).length, 0);
  assert.equal((await t.call("GET", "/api/messages?after=0", a.token)).json.messages.filter((m: any) => m.seq === d.json.message.seq).length, 1);
  assert.equal((await t.call("GET", "/api/owner/messages", r.sess)).json.messages.length, 2, "오너는 모두 본다");
});

test("읽기/쓰기 범위 제한", async () => {
  const r = await t.setupRoom();
  const ro = await t.join(r, "readonly", { can_write: false });
  const wo = await t.join(r, "writeonly", { can_read: false });
  assert.equal((await t.call("POST", "/api/messages", ro.token, msg("x", "y"))).status, 403);
  assert.equal((await t.call("GET", "/api/inbox", wo.token)).status, 403);
  assert.equal((await t.call("POST", "/api/messages", wo.token, msg("x", "y"))).status, 201);
});

test("폐기와 재가입: 토큰 즉시 무효, 이전 메시지 귀속 유지, 새 신원으로 재가입", async () => {
  const r = await t.setupRoom();
  const a = await t.join(r, "alpha");
  await t.call("POST", "/api/messages", a.token, msg("m1", "첫 글"));
  assert.equal((await t.call("POST", `/api/owner/agents/${a.id}/revoke`, r.sess, {})).status, 200);
  assert.equal((await t.call("GET", "/api/inbox", a.token)).status, 401);
  assert.equal((await t.call("POST", "/api/messages", a.token, msg("m2", "x"))).status, 401);
  const a2 = await t.join(r, "alpha", { history: "none" });
  assert.notEqual(a2.id, a.id);
  const owner = (await t.call("GET", "/api/owner/messages", r.sess)).json.messages;
  assert.equal(owner[0].sender.id, a.id);
  assert.equal((await t.call("GET", "/api/messages?after=0", a2.token)).json.messages.length, 0, "재가입 후 이전 기록 없음");
  // 폐기된 참여자에게 지정 전송 불가
  const b = await t.join(r, "beta");
  assert.equal((await t.call("POST", "/api/messages", b.token, msg("z", "x", { recipient: a.id }))).status, 404);
});

test("같은 이름 중복 승인은 거부", async () => {
  const r = await t.setupRoom();
  await t.join(r, "alpha");
  const jr = (await t.call("POST", `/api/join/${r.invite}`, undefined, { display_name: "Alpha" })).json;
  assert.equal((await t.call("POST", `/api/owner/join-requests/${jr.request_id}/approve`, r.sess, {})).status, 409);
});

test("삭제는 tombstone, 재시도 멱등 유지; 보존기간은 내용을 지운다", async () => {
  const r = await t.setupRoom();
  const a = await t.join(r, "alpha", { history: "all" });
  const b = await t.join(r, "beta", { history: "all" });
  await t.call("POST", "/api/messages", a.token, msg("s1", "비밀 아님 1"));
  await t.call("POST", "/api/messages", a.token, msg("s2", "비밀 아님 2"));
  assert.equal((await t.call("DELETE", "/api/owner/messages/1", r.sess)).status, 200);
  const inbox = (await t.call("GET", "/api/inbox", b.token)).json.messages;
  assert.equal(inbox[0].deleted, true); assert.equal(inbox[0].content, null); assert.equal(inbox[0].seq, 1);
  const retry = await t.call("POST", "/api/messages", a.token, msg("s1", "비밀 아님 1"));
  assert.equal(retry.json.duplicate, true);
  assert.equal(retry.json.message.deleted, true);
  assert.equal((await t.call("DELETE", "/api/owner/messages/1", r.sess)).status, 404);
  if (!EXTERNAL) {
    await t.call("PATCH", "/api/owner/room", r.sess, { retention_days: 1 });
    t.clock.advance(2 * 86400_000);
    assert.ok((await t.svc.purgeExpired()) >= 1);
    const all = (await t.call("GET", "/api/messages?after=0", b.token)).json.messages;
    assert.ok(all.every((m: any) => m.deleted && m.content === null));
    assert.equal((t.sqlite.raw.prepare("SELECT count(*) c FROM messages WHERE room_id=? AND content<>''").get(r.roomId) as any).c, 0);
  }
});

test("루프 상한: 답장 체인 깊이는 서버가 계산하고 오너 메시지가 체인을 재시작한다", async () => {
  const r = await t.setupRoom();
  const a = await t.join(r, "alpha", { history: "all" });
  const b = await t.join(r, "beta", { history: "all" });
  await t.call("PATCH", "/api/owner/room", r.sess, { max_chain_depth: 3, rate_limit_count: 1000 });
  let last = (await t.call("POST", "/api/messages", a.token, msg("root", "시작"))).json.message.seq as number;
  const who = [b, a, b];
  for (let i = 0; i < 3; i++) {
    const p = await t.call("POST", "/api/messages", who[i].token, msg(`h${i}`, `답장 ${i}`, { reply_to: last, hop: 0, depth: 0 }));
    assert.equal(p.status, 201, `depth ${i + 1}`);
    last = p.json.message.seq;
  }
  const over = await t.call("POST", "/api/messages", a.token, msg("h3", "넘침", { reply_to: last }));
  assert.equal(over.status, 429); assert.equal(over.json.error.code, "loop_cap");
  const o = await t.call("POST", "/api/owner/messages", r.sess, msg("own1", "계속하세요", { reply_to: last }));
  assert.equal(o.status, 201);
  assert.equal((await t.call("POST", "/api/messages", a.token, msg("h4", "재개", { reply_to: o.json.message.seq }))).status, 201);
});

test("빈도 상한: 넘으면 방이 자동 일시정지, 오너가 재개", async () => {
  const r = await t.setupRoom();
  const a = await t.join(r, "alpha");
  await t.call("PATCH", "/api/owner/room", r.sess, { rate_limit_count: 3, rate_limit_window_s: 60 });
  for (let i = 0; i < 3; i++) assert.equal((await t.call("POST", "/api/messages", a.token, msg(`r${i}`, `n${i}`))).status, 201);
  const hit = await t.call("POST", "/api/messages", a.token, msg("r3", "n3"));
  assert.equal(hit.status, 429); assert.equal(hit.json.error.code, "rate_cap_paused");
  const room = (await t.call("GET", "/api/owner/room", r.sess)).json;
  assert.equal(room.paused, true); assert.equal(room.pause_reason, "rate_cap");
  assert.equal((await t.call("POST", "/api/messages", a.token, msg("r4", "n4"))).status, 423);
  assert.equal((await t.call("POST", "/api/messages", a.token, msg("r0", "n0"))).json.duplicate, true, "일시정지 중 멱등 재시도는 허용");
  assert.equal((await t.call("GET", "/api/inbox", a.token)).status, 200, "읽기는 가능");
  const sys = (await t.call("GET", "/api/owner/messages", r.sess)).json.messages.at(-1);
  assert.equal(sys.sender.type, "system");
  await t.call("PATCH", "/api/owner/room", r.sess, { paused: false });
  if (!EXTERNAL) {
    t.clock.advance(61_000);
    assert.equal((await t.call("POST", "/api/messages", a.token, msg("r5", "n5"))).status, 201);
  }
});

test("개인 맥락 기본 금지: 카테고리, 토큰, 이메일/전화 필터 (최선의 보조 수단)", async () => {
  const r = await t.setupRoom();
  const a = await t.join(r, "alpha");
  const p = (id: string, content: string, extra = {}) => t.call("POST", "/api/messages", a.token, msg(id, content, extra));
  assert.equal((await p("p1", "내 일정 알려줄게", { context_category: "personal" })).json.error.code, "category_not_allowed");
  assert.equal((await p("p2", `토큰 ${a.token}`)).json.error.code, "secret_detected");
  assert.equal((await p("p3", "연락처 user@example.com")).json.error.code, "personal_data_suspected");
  assert.equal((await p("p4", "전화 010-1234-5678")).json.error.code, "personal_data_suspected");
  assert.equal((await p("p5", "일반 작업 상태 공유")).status, 201);
  await t.call("PATCH", "/api/owner/room", r.sess, { allowed_categories: ["work_summary"] });
  assert.equal((await p("p6", "업무 요약", { context_category: "work_summary" })).status, 201);
});

test("본문 크기와 잘못된 입력", async () => {
  const r = await t.setupRoom();
  const a = await t.join(r, "alpha");
  assert.equal((await t.call("POST", "/api/messages", a.token, msg("big", "x".repeat(4001)))).status, 400);
  assert.equal((await t.call("POST", "/api/messages", a.token, { content: "no id" })).status, 400);
  assert.equal((await t.call("POST", "/api/messages", a.token, msg("k", "x", { kind: "command" }))).status, 400);
  const huge = await fetch(t.base + "/api/messages", { method: "POST", headers: { authorization: `Bearer ${a.token}`, connection: "close" }, body: "x".repeat(70_000) });
  assert.equal(huge.status, 413);
  await huge.text();
  // 로컬 분류는 엄격하게: http 스킴 + 루프백 호스트(127.0.0.1, ::1, localhost)만.
  // https://localhost는 로컬이어도 조기 차단 요청이 평문 http라 여기선 원격 취급한다.
  const uh = new URL(t.base);
  const isLoopbackHttp = uh.protocol === "http:" && (uh.hostname === "127.0.0.1" || uh.hostname === "localhost" || uh.hostname === "[::1]");
  const isRemote = EXTERNAL && !isLoopbackHttp;
  if (isRemote) {
    // 원격(Cloudflare 엣지 경유): 엣지가 업로드 완료 전 응답을 보류하므로 조기 차단 증명은 불가.
    // 여기서는 유한 chunked 본문(128KB)에 대한 종단간 413만 확인하고, 조기 차단 증명은 로컬 두 환경이 담당한다.
    const finite = new ReadableStream({ start(c) { for (let i = 0; i < 16; i++) c.enqueue(new Uint8Array(8192)); c.close(); } });
    const chunked = await fetch(t.base + "/api/messages", { method: "POST", headers: { authorization: `Bearer ${a.token}` }, body: finite, duplex: "half" } as any);
    assert.equal(chunked.status, 413);
    await chunked.text();
    return;
  }
  // content-length 없는 chunked 전송: 끝나지 않는 본문을 node:http로 직접 흘려보낸다.
  // 서버가 상한에서 조기 차단하면 본문이 끝나지 않았는데도 413 응답이 오고,
  // 끝까지 읽는 구현이면 응답이 오지 않아 타임아웃으로 실패한다. 소켓은 항상 파괴해 정리한다.
  const u = new URL(t.base + "/api/messages");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (e?: Error) => { if (!settled) { settled = true; clearTimeout(watchdog); req.destroy(); e ? reject(e) : resolve(); } };
    const watchdog = setTimeout(() => done(new Error("서버가 초과 본문을 끝까지 읽습니다")), 20_000);
    const req = http.request({ hostname: u.hostname.replace(/^\[|\]$/g, ""), port: u.port, path: u.pathname, method: "POST",
      headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json", connection: "close" } }, (res) => {
      res.resume();
      try { assert.equal(res.statusCode, 413); done(); } catch (e) { done(e as Error); }
    });
    req.on("error", () => done(new Error("요청이 응답 전에 끊겼습니다")));
    const chunk = Buffer.alloc(8192, 0x79);
    // 느린 점적: 홍수처럼 쓰면 dev 프록시가 응답 전달 전에 소켓을 끊을 수 있어, 청크 사이에 간격을 둔다.
    const pump = (): void => { if (settled || req.destroyed) return; if (req.write(chunk)) setTimeout(pump, 5); else req.once("drain", () => setTimeout(pump, 5)); };
    pump();
  });
  // 경계 정밀 증명: 정확히 64KiB+1바이트(65,537)까지만 보내고 열어 두면 상한 집행 서버는 그 시점에 413을,
  // 더 넉넉한 상한의 서버는 응답 없이 대기한다. 반대로 정확히 64KiB(65,536)에서는 413이 오지 않아야 한다.
  const sendBytes = (total: number) => new Promise<{ status: number | null }>((resolve) => {
    let settled = false;
    const done = (status: number | null) => { if (!settled) { settled = true; clearTimeout(watchdog); req.destroy(); resolve({ status }); } };
    const watchdog = setTimeout(() => done(null), 15_000);
    const req = http.request({ hostname: u.hostname.replace(/^\[|\]$/g, ""), port: u.port, path: u.pathname, method: "POST",
      headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json", connection: "close" } }, (res) => {
      res.resume();
      done(res.statusCode ?? null);
    });
    req.on("error", () => done(null));
    let left = total;
    const pump2 = (): void => {
      if (settled || req.destroyed) return;
      if (left <= 0) return; // 본문을 열어 둔 채 응답을 기다린다
      const n = Math.min(8192, left);
      left -= n;
      if (req.write(Buffer.alloc(n, 0x79))) setTimeout(pump2, 2); else req.once("drain", () => setTimeout(pump2, 2));
    };
    pump2();
  });
  const over = await sendBytes(65_537);
  assert.equal(over.status, 413, "64KiB+1바이트에서 조기 413이어야 한다 (status=" + over.status + ")");
  // 상한 이하(정확히 64KiB)에서는 조기 413이 오면 안 된다. 응답이 없음을 짧게 확인한 뒤 소켓을 닫는다.
  const atLimit = await Promise.race([sendBytes(65_536), new Promise<{ status: number | null }>(r => setTimeout(() => r({ status: null }), 3_000))]);
  assert.equal(atLimit.status, null, "정확히 64KiB에서는 조기 413이 오면 안 된다");
});

test("오너 로그인 시도 제한과 코드 교체 시 세션 무효화", async () => {
  const r = await t.setupRoom();
  assert.equal((await t.call("GET", "/api/owner/room", r.sess)).status, 200);
  const rot = (await t.call("POST", `/api/admin/rooms/${r.roomId}/rotate-owner-code`, ADMIN_KEY)).json;
  assert.equal((await t.call("GET", "/api/owner/room", r.sess)).status, 401);
  assert.equal((await t.call("POST", "/api/owner/login", undefined, { room_id: r.roomId, owner_code: r.ownerCode })).status, 401);
  assert.equal((await t.call("POST", "/api/owner/login", undefined, { room_id: r.roomId, owner_code: rot.owner_code })).status, 200);
  for (let i = 0; i < 10; i++) await t.call("POST", "/api/owner/login", undefined, { room_id: r.roomId, owner_code: "bad" });
  assert.equal((await t.call("POST", "/api/owner/login", undefined, { room_id: r.roomId, owner_code: rot.owner_code })).status, 429);
});

test("오너 웹 UI 정적 파일은 엄격한 CSP로 제공된다", async () => {
  const page = await fetch(t.base + "/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  const html = await page.text();
  assert.ok(!/<script(?![^>]*src=)/.test(html), "인라인 스크립트 없음");
  assert.equal((await fetch(t.base + "/ui/app.js")).status, 200);
  assert.equal((await fetch(t.base + "/ui/style.css")).status, 200);
  assert.equal((await fetch(t.base + "/ui/../package.json")).status, 404);
});


test("지정 수신 메시지의 전달 상태(보냄→전달됨→처리 확인→답장함)가 보인다", async () => {
  const r = await t.setupRoom();
  const a = await t.join(r, "상태봇");
  await t.call("POST", "/api/owner/messages", r.sess, { client_id: "ds-1", content: "상태 확인용", recipient: a.id });
  const stateOf = async () => {
    const msgs = (await t.call("GET", "/api/owner/messages", r.sess)).json.messages;
    return msgs.find((m: any) => m.content === "상태 확인용")?.delivery?.state;
  };
  assert.equal(await stateOf(), "sent");
  await t.call("GET", "/api/inbox", a.token);
  assert.equal(await stateOf(), "fetched");
  await t.call("POST", "/api/ack", a.token, { seq: 1 });
  assert.equal(await stateOf(), "acked");
  await t.call("POST", "/api/messages", a.token, { client_id: "ds-2", content: "답장", reply_to: 1 });
  assert.equal(await stateOf(), "replied");
  // 지정 수신이 아닌 메시지에는 delivery가 없다.
  await t.call("POST", "/api/owner/messages", r.sess, { client_id: "ds-3", content: "전체 공지" });
  const msgs = (await t.call("GET", "/api/owner/messages", r.sess)).json.messages;
  assert.equal(msgs.find((m: any) => m.content === "전체 공지").delivery, null);
});

test("오너 웹훅: URL 검증, 등록/삭제, 지정 수신 메시지 전달 파이프라인", async () => {
  const r = await t.setupRoom();
  const a = await t.join(r, "훅봇");
  // SSRF/프로토콜 가드
  for (const bad of ["http://example.com/h", "https://127.0.0.1/h", "https://localhost/h", "https://192.168.0.1/h", "not-a-url", "https://user:pw@example.com/h", "https://2130706433/h", "https://[::1]/h", "https://intranet/h", "https://host.local/h"]) {
    const res = await t.call("POST", "/api/owner/webhooks", r.sess, { url: bad });
    assert.equal(res.status, 400, bad);
  }
  const w = (await t.call("POST", "/api/owner/webhooks", r.sess, { url: "https://example.com/acr-hook" })).json;
  assert.ok(w.id.startsWith("whk_"));
  assert.ok(w.secret.startsWith("whsec_"));
  // 핑 테스트: 인라인으로 1회 시도가 기록된다 (example.com은 실제로 응답하므로 ok/failed 둘 다 시도 증거).
  const ping2 = (await t.call("POST", `/api/owner/webhooks/${w.id}/test`, r.sess)).json.delivery;
  assert.equal(ping2.kind, "ping");
  assert.equal(ping2.attempts, 1);
  assert.ok(ping2.status === "ok" || ping2.status === "pending" || ping2.status === "failed");
  // 가짜 시계에서는 핑과 메시지 전달이 같은 ms에 만들어져 "최신 전달" 순서가 갈린다. 실제 시간 흐름을 흉내 낸다.
  if (!EXTERNAL) t.clock.advance(1_000);
  // 지정 수신 메시지 → 핑과 구분되는 새 전달이 시도되어야 한다. 전송 직후 목록의 최신 전달은
  // 방금 만들어진 메시지 전달(attempts=0)이므로, attempts>=1이 되면 핑이 아니라 이 메시지의 시도다.
  await t.call("POST", "/api/owner/messages", r.sess, { client_id: "wh-1", content: "웹훅 알림 대상", recipient: a.id });
  let seen: any = null;
  for (let i = 0; i < 20; i++) {
    const l = (await t.call("GET", "/api/owner/webhooks", r.sess)).json;
    seen = l.webhooks.find((x: any) => x.id === w.id);
    if (seen && seen.last_kind === "message" && seen.last_attempts >= 1) break;
    await new Promise(r2 => setTimeout(r2, 700));
  }
  assert.ok(seen, "웹훅이 목록에 있다");
  assert.equal(seen.last_kind, "message", "최신 전달은 핑이 아니라 지정 수신 메시지여야 한다");
  assert.ok(seen.last_attempts >= 1, "지정 수신 메시지의 새 전달이 시도되었다 (attempts=" + seen.last_attempts + ")");
  // 지정 수신이 아닌 메시지는 전달 대상이 아니다: 직전 상태 그대로인지는 전달 수로 간접 확인한다.
  const before = seen.last_attempts;
  await t.call("POST", "/api/owner/messages", r.sess, { client_id: "wh-2", content: "전체 공지" });
  await new Promise(r2 => setTimeout(r2, 1200));
  const after = (await t.call("GET", "/api/owner/webhooks", r.sess)).json.webhooks.find((x: any) => x.id === w.id);
  assert.equal(after.last_attempts, before, "전체 공지는 새 전달을 만들지 않는다");
  assert.equal((await t.call("DELETE", `/api/owner/webhooks/${w.id}`, r.sess)).status, 200);
  assert.equal((await t.call("GET", "/api/owner/webhooks", r.sess)).json.webhooks.find((x: any) => x.id === w.id).active, false);
});

test("inbox 롱폴링: wait 동안 새 메시지를 기다렸다가 즉시 반환한다", async () => {
  const r = await t.setupRoom();
  const a = await t.join(r, "폴봇");
  // 잘못된 wait
  assert.equal((await t.call("GET", "/api/inbox?wait=99", a.token)).status, 400);
  // 빈 inbox에서 wait=2는 약 2초 후 빈 결과
  const t0 = Date.now();
  const empty = (await t.call("GET", "/api/inbox?wait=2", a.token)).json;
  const dt = Date.now() - t0;
  assert.equal(empty.messages.length, 0);
  assert.ok(dt >= 1800 && dt < 6000, "대기 시간 " + dt + "ms");
  // 기다리는 동안 메시지가 오면 일찍 돌아온다
  const t1 = Date.now();
  const pending = t.call("GET", "/api/inbox?wait=10", a.token);
  await new Promise(r2 => setTimeout(r2, 500));
  await t.call("POST", "/api/owner/messages", r.sess, { client_id: "lp-1", content: "깨어나라" });
  const got = (await pending).json;
  const dt2 = Date.now() - t1;
  assert.equal(got.messages.length, 1);
  assert.equal(got.messages[0].content, "깨어나라");
  assert.ok(dt2 < 5000, "조기 반환 " + dt2 + "ms");
});

test("롱폴링 대기 중 토큰이 폐기되면 대기가 끊긴다", async () => {
  const r = await t.setupRoom();
  const a = await t.join(r, "폐기봇");
  const pending = t.call("GET", "/api/inbox?wait=15", a.token);
  await new Promise(r2 => setTimeout(r2, 500));
  assert.equal((await t.call("POST", `/api/owner/agents/${a.id}/revoke`, r.sess)).status, 200);
  const res = await pending;
  assert.equal(res.status, 401, "폐기 후 대기는 401로 끊겨야 한다");
});
