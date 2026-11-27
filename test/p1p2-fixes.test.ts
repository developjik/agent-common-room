// P1·P2 일괄 수정 회귀 테스트.
//  - P1-1: rate cap 자동 정지 뒤 재개가 같은 창에서 즉시 무효화되지 않는다(재개 = 새 창).
//  - P1-2: 오너가 방을 직접 일시정지/재개할 수 있고, 사유가 배너 문구로 갈린다.
//  - P2-1: 만료·잘못된 초대 링크는 브라우저에 HTML 안내, API 에는 기존 JSON 오류.
//  - P2-2: 초대 목록(사용 횟수·만료)과 폐기(회수)가 오너 경로로 동작한다.
//  - P2-3: 입장만 한 비서는 접속(last_seen)으로 기록되지 않는다(실제 인증 요청만).
//  - P2-4: 연결 끊긴 비서에게 남은 DM 은 delivery.recipient_status='revoked' 로 끝난 상태를 알린다.
//  - P2-6: 시스템 안내는 방 목록 미리보기를 오염시키지 않고, 오너가 지울 수 있다.
//  - P2-7: 마지막 메시지를 지우면 미리보기가 즉시 이전 메시지로 바뀐다.
// 화면 규칙(순수 함수)과 컴포넌트 소스의 계약은 jsdom 없이 그대로 검사한다.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { start, EXTERNAL } from "./helpers.js";
import { agentTone, deliveryNotice, seenLabel } from "../web/src/lib/format.js";
import { pauseDetail, pauseTitle } from "../web/src/lib/views.js";
import type { Agent, Message } from "../web/src/lib/types.js";

let t: Awaited<ReturnType<typeof start>>;
before(async () => { t = await start(); });
after(async () => { await t.close(); });

const msg = (client_id: string, content: string, extra: Record<string, unknown> = {}) => ({ client_id, content, ...extra });

test("P1-1: 빈도 상한 자동 정지 뒤 재개하면 같은 창에서도 다시 보낼 수 있다", async () => {
  const r = await t.setupRoom();
  const a = await t.join(r, "속도");
  assert.equal((await t.call("PATCH", "/api/owner/room", r.sess, { rate_limit_count: 3, rate_limit_window_s: 60 })).status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await t.call("POST", "/api/messages", a.token, msg(`s${i}`, `n${i}`))).status, 201);
  const hit = await t.call("POST", "/api/messages", a.token, msg("s3", "n3"));
  assert.equal(hit.status, 429);
  assert.equal(hit.json.error.code, "rate_cap_paused");

  const paused = (await t.call("GET", "/api/owner/room", r.sess)).json;
  assert.equal(paused.paused, true);
  assert.equal(paused.pause_reason, "rate_cap");
  assert.equal(paused.pause_info.reason, "rate_cap", "배너가 자동 정지임을 알 수 있다");
  assert.equal(paused.pause_info.actor, "auto");
  assert.ok(paused.pause_info.at, "정지 시각");
  assert.equal(paused.pause_info.window_seconds, 60);
  assert.equal(paused.pause_info.limit, 3);

  assert.equal((await t.call("PATCH", "/api/owner/room", r.sess, { paused: false })).status, 200);
  // 시계를 돌리지 않는다 — 재개가 창의 기준점을 지금으로 옮겼으므로 바로 보낼 수 있어야 한다.
  // (예전에는 같은 창의 3건 때문에 재개 직후 곧바로 429 rate_cap_paused 로 다시 잠겼다.)
  const after = await t.call("POST", "/api/messages", a.token, msg("s4", "n4"));
  assert.equal(after.status, 201, `재개 직후 전송이 성공해야 한다 (${after.text})`);
  assert.equal(after.json.message.sender.type, "agent");
});

test("P1-2: 오너가 방을 직접 일시정지/재개하고, 사유가 다르게 표시된다", async () => {
  const r = await t.setupRoom();
  const a = await t.join(r, "수동");
  const paused = (await t.call("PATCH", "/api/owner/room", r.sess, { paused: true })).json;
  assert.equal(paused.paused, true);
  assert.equal(paused.pause_reason, "owner");
  assert.equal(paused.pause_info.actor, "owner");
  assert.equal(paused.pause_info.reason, "owner");
  assert.equal((await t.call("POST", "/api/messages", a.token, msg("p1", "멈춤"))).status, 423);
  assert.equal((await t.call("POST", "/api/inbox", a.token)).status, 404, "inbox 는 GET 이라 POST 는 없는 경로");
  assert.equal((await t.call("POST", "/api/owner/messages", r.sess, msg("o1", "오너는 계속 쓴다"))).status, 201);
  assert.equal((await t.call("PATCH", "/api/owner/room", r.sess, { paused: false })).status, 200);
  assert.equal((await t.call("POST", "/api/messages", a.token, msg("p2", "다시"))).status, 201);
});

test("P2-1: 만료·잘못된 초대는 브라우저에 HTML 안내, API 에는 JSON 오류", async () => {
  if (EXTERNAL) return;
  const r = await t.setupRoom();
  const html = await fetch(`${t.base}/join/acr_inv_does_not_exist`, { headers: { accept: "text/html,application/xhtml+xml" } });
  assert.equal(html.status, 404);
  assert.equal(html.headers.get("content-type"), "text/html; charset=utf-8");
  const page = await html.text();
  assert.match(page, /초대를 열 수 없습니다/);
  assert.match(page, /Agent Lounge 열기/, "앱 홈으로 가는 길");
  assert.match(page, /새 초대 문장/, "무엇을 하면 되는지");
  assert.ok(!page.includes("acr_inv_does_not_exist"), "토큰을 되비추지 않는다");

  const api = await fetch(`${t.base}/join/acr_inv_does_not_exist`, { headers: { accept: "application/json" } });
  assert.equal(api.status, 404);
  assert.equal((await api.json() as any).error.code, "invite_invalid", "API 클라이언트는 기존 JSON 그대로");

  // 폐기된(한때 유효했던) 초대도 같은 안내로 끝난다.
  const created = (await t.call("POST", "/api/owner/invites", r.sess, { max_uses: 1 })).json;
  assert.equal((await t.call("DELETE", `/api/owner/invites/${created.invite_id}`, r.sess)).status, 200);
  const revoked = await fetch(`${t.base}/join/${created.invite_token}`, { headers: { accept: "text/html" } });
  assert.equal(revoked.status, 404);
  assert.match(await revoked.text(), /초대를 열 수 없습니다/);
});

test("P2-2: 오너가 발급된 초대의 사용 횟수·만료를 보고 폐기(회수)할 수 있다", async () => {
  const r = await t.setupRoom();
  const created = (await t.call("POST", "/api/owner/invites", r.sess, { max_uses: 2, ttl_hours: 24 })).json;
  const list = (await t.call("GET", "/api/owner/invites", r.sess)).json.invites as any[];
  const row = list.find((i) => i.id === created.invite_id);
  assert.ok(row, "발급한 초대가 목록에 있다");
  assert.equal(row.max_uses, 2);
  assert.equal(row.uses, 0);
  assert.equal(row.active, true);
  assert.ok(Number.isFinite(Date.parse(row.expires_at)), "만료일이 있다");

  assert.equal((await t.call("DELETE", `/api/owner/invites/${row.id}`, r.sess)).status, 200);
  const after = (await t.call("GET", "/api/owner/invites", r.sess)).json.invites.find((i: any) => i.id === row.id);
  assert.equal(after.active, false, "폐기하면 더 이상 쓸 수 없다");
  assert.equal((await t.call("POST", `/api/join/${created.invite_token}`, undefined, { display_name: "늦은비서" })).status, 404, "폐기된 초대는 입장 불가");
});

test("P2-3: 입장만 한 비서는 '접속'으로 기록되지 않고, 실제 요청이 있을 때만 갱신된다", async () => {
  const r = await t.setupRoom();
  const a = await t.join(r, "조용한비서");
  const before = (await t.call("GET", `/api/rooms/${r.roomId}`, r.sess)).json.members.find((m: any) => m.agent_id === a.id);
  assert.equal(before.last_seen, null, "join 은 토큰 발급일 뿐 활동이 아니다");
  // 실제 인증 요청(예: /api/me)은 활동으로 기록된다.
  assert.equal((await t.call("GET", "/api/me", a.token)).status, 200);
  const after = (await t.call("GET", `/api/rooms/${r.roomId}`, r.sess)).json.members.find((m: any) => m.agent_id === a.id);
  assert.ok(after.last_seen, "실제 요청 뒤에는 last_seen 이 생긴다");
});

test("P2-4: 연결 끊긴 비서에게 남은 DM 은 끝난 상태(recipient_status=revoked)로 알린다", async () => {
  const r = await t.setupRoom();
  const a = await t.join(r, "보내는이");
  const b = await t.join(r, "끊길이");
  const dm = await t.call("POST", "/api/owner/messages", r.sess, msg("dm1", "전달될 메시지", { recipient: b.id }));
  assert.equal(dm.status, 201);
  const seq = dm.json.message.seq as number;
  const live = (await t.call("GET", "/api/owner/messages", r.sess)).json.messages.find((m: any) => m.seq === seq);
  assert.equal(live.delivery.recipient_status, "active");
  assert.equal((await t.call("POST", `/api/owner/agents/${b.id}/revoke`, r.sess)).status, 200);
  const gone = (await t.call("GET", "/api/owner/messages", r.sess)).json.messages.find((m: any) => m.seq === seq);
  assert.equal(gone.delivery.state, "sent");
  assert.equal(gone.delivery.recipient_status, "revoked", "이제 전달될 수 없는 메시지다");
  assert.equal((await t.call("POST", "/api/messages", a.token, msg("a1", "안녕"))).status, 201);
});

test("P2-6·P2-7: 시스템 안내는 미리보기를 오염시키지 않고 지울 수 있으며, 삭제는 미리보기에 즉시 반영된다", async () => {
  const r = await t.setupRoom();
  const a = await t.join(r, "미리보기");
  const m1 = await t.call("POST", "/api/messages", a.token, msg("v1", "첫 메시지"));
  const m2 = await t.call("POST", "/api/messages", a.token, msg("v2", "두 번째 메시지"));
  assert.equal(m1.status, 201);
  assert.equal(m2.status, 201);

  // 마지막 메시지 삭제 → 미리보기가 곧바로 이전 메시지로 바뀐다(다음 폴링을 기다리지 않는다).
  assert.equal((await t.call("DELETE", `/api/owner/messages/${m2.json.message.seq}`, r.sess)).status, 200);
  let room = (await t.call("GET", "/api/owner/room", r.sess)).json;
  assert.equal(room.last_preview, "첫 메시지");

  // 빈도 상한으로 자동 정지 → 시스템 안내가 쌓여도 미리보기는 마지막 '대화'다.
  assert.equal((await t.call("PATCH", "/api/owner/room", r.sess, { rate_limit_count: 1, rate_limit_window_s: 60 })).status, 200);
  const blocked = await t.call("POST", "/api/messages", a.token, msg("v3", "세 번째"));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error.code, "rate_cap_paused");
  room = (await t.call("GET", "/api/owner/room", r.sess)).json;
  assert.equal(room.last_preview, "첫 메시지", "시스템 문장이 미리보기에 들어가지 않는다");

  const messages = (await t.call("GET", "/api/owner/messages", r.sess)).json.messages as any[];
  const sys = messages.find((m) => m.sender.type === "system");
  assert.ok(sys, "자동 정지 안내는 시스템 메시지로 남는다");
  assert.equal((await t.call("DELETE", `/api/owner/messages/${sys.seq}`, r.sess)).status, 200, "오너가 시스템 안내도 지울 수 있다");
  const after = (await t.call("GET", "/api/owner/messages", r.sess)).json.messages.find((m: any) => m.seq === sys.seq);
  assert.equal(after.deleted, true);
  room = (await t.call("GET", "/api/owner/room", r.sess)).json;
  assert.equal(room.last_preview, "첫 메시지");
});

test("P2-3 화면 규칙: 온라인은 5분 안의 실제 활동만, 입장만 한 비서는 inbox 미확인으로 표시한다", () => {
  const now = Date.UTC(2026, 10, 27, 12, 0, 0);
  const base = { id: "agt_1", name: "피클", product_self_declared: "Pickle", status: "active", can_read: true, can_write: true, history_floor_seq: 0, fetched_seq: 0, acked_seq: 0, last_seen: null } as Agent;
  assert.equal(agentTone(base, now), "pending", "토큰만 있고 요청이 없으면 연결 대기");
  assert.equal(seenLabel(base), "입장함 · inbox 미확인");
  assert.equal(agentTone({ ...base, last_seen: new Date(now - 60_000).toISOString() }, now), "online");
  assert.equal(agentTone({ ...base, last_seen: new Date(now - 10 * 60_000).toISOString() }, now), "idle", "30분이 아니라 5분이 기준");
  assert.equal(agentTone({ ...base, last_seen: new Date(now - 31 * 60_000).toISOString() }, now), "idle");
  assert.equal(agentTone({ ...base, status: "revoked", last_seen: new Date(now).toISOString() }, now), "offline");
});

test("P2-4 화면 규칙: 연결 끊긴 수신자의 DM 은 '아직 전달 전'이 아니라 끝난 상태다", () => {
  const now = Date.UTC(2026, 10, 27, 12, 0, 0);
  const dm = {
    seq: 3, id: "msg_3", client_id: null, kind: "message",
    sender: { type: "owner", id: "owner", name: "owner" },
    recipient: { id: "agt_2", name: "피클" }, reply_to: null, content: "확인 부탁",
    deleted: false, depth: 0, context_category: "none", created_at: new Date(now).toISOString(),
    delivery: { state: "sent", recipient_status: "revoked" },
  } as unknown as Message;
  const notice = deliveryNotice(dm, now);
  assert.equal(notice?.label, "전달 안 됨 · 연결 끊김", "기다리면 되는 것처럼 보이지 않게");
  assert.match(notice!.title, /연결이 끊겨/);
  const waiting = deliveryNotice({ ...dm, delivery: { state: "sent", recipient_status: "active" } } as Message, now);
  assert.equal(waiting, null, "방금 보낸 글은 조용히 기다린다");
});

test("P1-1 화면 규칙: 배너가 정지 사유(자동/방장)와 재개 안내를 구분한다", () => {
  const auto = { pause_info: { reason: "rate_cap", window_seconds: 600, limit: 30 } };
  assert.match(pauseTitle(auto), /자동/);
  assert.match(pauseDetail(auto), /10분에 30건/, "빈도 창과 상한을 그대로 말한다");
  assert.match(pauseDetail(auto), /재개하면 지금부터 새로 세므로/);
  const manual = { pause_info: { reason: "owner" } };
  assert.match(pauseTitle(manual), /방장/);
  assert.match(pauseDetail(manual), /다시 답할 수 있습니다/);
});

test("P1-2·P2-2·P2-6 화면 계약: 방 설정의 일시정지·초대 폐기, 시스템 안내 삭제 버튼", () => {
  const panel = readFileSync(new URL("../../web/src/components/RoomPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /방 일시정지/, "수동 일시정지 버튼");
  assert.match(panel, /paused: !paused/, "같은 버튼이 재개도 한다");
  assert.match(panel, /revokeInvite/, "초대 폐기(회수) 연결");
  assert.match(panel, /사용 \{inv\.uses}\/\{inv\.max_uses}/, "사용 횟수를 보여준다");
  assert.match(panel, /new 초대|새 초대 문장 복사/);

  const feed = readFileSync(new URL("../../web/src/components/ChatFeed.tsx", import.meta.url), "utf8");
  assert.match(feed, /시스템 안내 지우기/, "오너가 시스템 안내를 지울 수 있다");

  const view = readFileSync(new URL("../../web/src/components/RoomView.tsx", import.meta.url), "utf8");
  assert.match(view, /pauseTitle\(room\)/);
  assert.match(view, /pauseDetail\(room\)/);

  const css = readFileSync(new URL("../../web/src/index.css", import.meta.url), "utf8");
  assert.match(css, /\.sys-msg \{/, "시스템 안내가 문단 하나로 떨어지지 않는다");
  assert.match(css, /\.sys-msg-x \{/);
  assert.match(css, /\.invite-row \{/);
  assert.match(css, /@media \(hover: none\) \{[\s\S]*?\.msg-menu \.msg-menu-touch \{\s*display: contents;/, "터치에서는 ⋯ 메뉴로 액션을 모은다");
  assert.match(css, /@media \(max-width: 639px\) \{[\s\S]*?\.composer-at \{\s*width: 40px;/, "모바일 `@` 터치 영역");
  assert.match(css, /\.sheet \{\s*width: 100vw;/, "390px 시트가 잘린 것처럼 보이지 않는다");
});
