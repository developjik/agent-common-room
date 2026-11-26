// 3화면 단순화(방·비서·설정) 이후의 순수 규칙 검증:
// 경로(예전 주소 호환 포함) · 방 목록 순서/표시 · 비서 방 토글 · 초대 문장 · 전달 상태 폴링 창.
import test from "node:test";
import assert from "node:assert/strict";
import { activeTab, parseRoute, routeHref } from "../web/src/lib/route.js";
import {
  activeAgentCount,
  agentNameConflict,
  agentRoomToggles,
  agentsSummary,
  awaitingDelivery,
  countNew,
  INVITE_DEFAULTS,
  loginIdProblem,
  memberToAgent,
  nextFetchAfter,
  passwordProblem,
  POLL_STEPS,
  pollDelay,
  poolInviteText,
  presenceLabel,
  roomNeedsAnswer,
  roomInviteText,
  roomRowCount,
  setupLandingMode,
  sortRoomCards,
  toggledRoomIds,
  unclaimedNotice,
  unreadRoomCount,
} from "../web/src/lib/views.js";
import type { Message, PoolAgent, RoomCard, RoomMember } from "../web/src/lib/types.js";

function card(over: Partial<RoomCard> = {}): RoomCard {
  return {
    id: "room_1",
    name: "방",
    kind: "room",
    paused: false,
    pause_reason: null,
    member_count: 2,
    unread: 0,
    last_seq: 10,
    last_message_at: "2026-11-26T00:00:00.000Z",
    last_preview: "미리보기",
    last_sender: { name: "피클", type: "agent" },
    health: "ok",
    ...over,
  };
}

function agent(over: Partial<PoolAgent> = {}): PoolAgent {
  return {
    id: "agt_1",
    name: "피클",
    product_self_declared: "Pickle",
    status: "active",
    last_seen: "2026-11-26T00:00:00.000Z",
    created_at: "2026-11-25T00:00:00.000Z",
    rooms: [{ room_id: "room_lobby", room_name: "로비", status: "active" }],
    ...over,
  };
}

function message(over: Partial<Message> = {}): Message {
  return {
    seq: 1,
    id: "msg_1",
    client_id: null,
    kind: "message",
    sender: { type: "agent", id: "agt_1", name: "피클" },
    recipient: null,
    reply_to: null,
    content: "본문",
    deleted: false,
    depth: 0,
    context_category: "general",
    created_at: "2026-11-26T01:00:00.000Z",
    delivery: null,
    ...over,
  };
}

test("경로: 방·비서·설정 세 화면뿐이고, 예전 주소는 막다른 길 없이 새 화면으로 간다", () => {
  assert.deepEqual(parseRoute(""), { view: "rooms", roomId: null }, "기본은 방");
  assert.deepEqual(parseRoute("?view=agents"), { view: "agents", roomId: null });
  assert.deepEqual(parseRoute("?view=settings"), { view: "settings", roomId: null });
  assert.deepEqual(parseRoute("?room=room_50795a119a4a4b48"), { view: "rooms", roomId: "room_50795a119a4a4b48" });
  assert.deepEqual(parseRoute("?view=agents&room=room_x"), { view: "rooms", roomId: "room_x" }, "방을 보고 있으면 방 화면");
  assert.deepEqual(parseRoute("?view=../../etc"), { view: "rooms", roomId: null }, "모르는 뷰는 방");
  assert.deepEqual(parseRoute("?view=__proto__"), { view: "rooms", roomId: null }, "상속된 키는 화면 이름이 아니다");
  assert.deepEqual(parseRoute("?view=constructor"), { view: "rooms", roomId: null });
  assert.deepEqual(parseRoute("?room=<script>"), { view: "rooms", roomId: null }, "방 ID 모양이 아니면 무시");

  // 예전 주소(관제실·인박스·비서실) 호환
  assert.equal(parseRoute("?view=home").view, "rooms");
  assert.equal(parseRoute("?view=inbox").view, "rooms");
  assert.equal(parseRoute("?view=desk").view, "agents");

  assert.equal(routeHref({ view: "rooms", roomId: null }), "/");
  assert.equal(routeHref({ view: "agents", roomId: null }), "?view=agents");
  assert.equal(routeHref({ view: "settings", roomId: null }), "?view=settings");
  assert.equal(routeHref({ view: "rooms", roomId: "room_a" }), "?room=room_a");

  assert.equal(activeTab({ view: "rooms", roomId: "room_a" }), "rooms");
  assert.equal(activeTab({ view: "agents", roomId: null }), "agents");
  assert.equal(activeTab({ view: "settings", roomId: null }), "settings");
});

test("계정 만들기 규칙: 아이디 3~40자, 비밀번호 12자 이상", () => {
  assert.equal(loginIdProblem("ingwon"), null);
  assert.match(loginIdProblem("ab") ?? "", /3~40자/);
  assert.match(loginIdProblem("_ingwon") ?? "", /3~40자/, "첫 글자는 글자·숫자");
  assert.equal(loginIdProblem("정인권"), null, "한글 아이디 허용");

  assert.equal(passwordProblem("123456789012"), null);
  assert.match(passwordProblem("12345678901") ?? "", /12자 이상/);
  assert.match(passwordProblem("") ?? "", /입력/);
  assert.equal(passwordProblem(" ".repeat(12)), null, "서버는 앞뒤 공백도 글자로 센다");
});

test("방 목록: 답변 필요 → 정지 → 안 읽음 → 진행 중 → 조용함, 같은 순위는 최근 활동", () => {
  const needs = card({ id: "a", health: "needs_input", needs_attention: true, last_message_at: "2026-11-20T00:00:00.000Z" });
  const paused = card({ id: "b", health: "paused", paused: true });
  const unread = card({ id: "c", unread: 3 });
  const fresh = card({ id: "d", last_message_at: "2026-11-25T00:00:00.000Z" });
  const idle = card({ id: "e", health: "idle", last_message_at: "2026-11-10T00:00:00.000Z" });
  const lobby = card({ id: "f", kind: "lobby", health: "idle", last_message_at: null });

  const order = sortRoomCards([idle, fresh, unread, paused, needs, lobby]).map((r) => r.id);
  assert.deepEqual(order.slice(0, 4), ["a", "b", "c", "d"], "답변 필요·정지·안 읽음·진행 중 순");
  assert.equal(order[4], "f", "같은 조용함 순위에서는 로비가 먼저");

  const pendingOnly = card({ id: "g", health: "needs_input", needs_attention: false });
  const directedOnly = card({ id: "h", health: "ok", needs_attention: true, last_message_at: "2026-11-01T00:00:00.000Z" });
  assert.deepEqual(sortRoomCards([pendingOnly, directedOnly]).map((r) => r.id), ["h", "g"], "답변 필요 방이 승인 대기 방보다 먼저");
  assert.equal(roomNeedsAnswer(pendingOnly), false);
  assert.equal(roomNeedsAnswer(directedOnly), true, "질문·내 앞 지목이면 답변 필요");

  assert.equal(unreadRoomCount([needs, paused, unread]), 1);
  assert.equal(roomRowCount(unread), 3, "안 읽은 수가 있으면 그 수");
  assert.equal(roomRowCount(fresh), 2, "없으면 비서 수(방 목록과 헤더가 같은 값)");
});

test("비서 수는 화면 어디서나 '활성' 하나로 센다(초대됨·폐기 제외)", () => {
  const agents = [
    { id: "1", name: "a", product: "", status: "active", last_seen: null, rooms: [] },
    { id: "2", name: "b", product: "", status: "unclaimed", last_seen: null, rooms: [] },
    { id: "3", name: "c", product: "", status: "revoked", last_seen: null, rooms: [] },
  ];
  assert.equal(activeAgentCount(agents), 1);
  assert.equal(agentsSummary(agents), "비서 1명 · 연결 대기 1명");
  assert.equal(agentsSummary([{ id: "3", name: "c", product: "", status: "revoked", last_seen: null, rooms: [] }]), "비서 없음");
});

test("비서 방 토글: 방을 누르면 넣고 빼되 로비는 고정, 다른 워크스페이스 방은 섞이지 않는다", () => {
  const rooms = [card({ id: "room_lobby", kind: "lobby", name: "로비" }), card({ id: "room_a", name: "회의실" }), card({ id: "room_b", name: "연구방" })];
  const a = agent();
  const toggles = agentRoomToggles(a, rooms, "room_lobby");
  assert.deepEqual(toggles.map((t) => [t.roomId, t.on, t.locked]), [
    ["room_lobby", true, true],
    ["room_a", false, false],
    ["room_b", false, false],
  ]);

  assert.deepEqual(toggledRoomIds(a, rooms, "room_lobby", "room_a"), ["room_lobby", "room_a"], "누르면 그 방을 넣는다");
  const both = agent({ rooms: [
    { room_id: "room_lobby", room_name: "로비", status: "active" },
    { room_id: "room_a", room_name: "회의실", status: "active" },
  ] });
  assert.deepEqual(toggledRoomIds(both, rooms, "room_lobby", "room_a"), ["room_lobby"], "다시 누르면 뺀다");
  assert.deepEqual(toggledRoomIds(both, rooms, "room_lobby", "room_lobby").sort(), ["room_a", "room_lobby"], "로비 칩은 잠겨 있어 눌러도 빠지지 않는다");
  assert.ok(!toggledRoomIds(agent({ rooms: [{ room_id: "room_gone", room_name: "옛 방", status: "active" }] }), rooms, "room_lobby", "room_a").includes("room_gone"), "이 워크스페이스에 없는 방은 보내지 않는다");
  assert.match(unclaimedNotice(), /토큰을 받지 못한 비서/);
  assert.match(unclaimedNotice(), /연결을 끊고 새로 초대/, "같은 이름으로 재초대해도 들어올 수 없다는 사실을 숨기지 않는다");
});

test("초대 문장과 기본값: 한 번 호출로 바로 입장, 7일 · 10회", () => {
  assert.equal(INVITE_DEFAULTS.ttlHours, 168);
  assert.equal(INVITE_DEFAULTS.maxUses, 10);
  const room = roomInviteText("우리 집", "회의실", "https://x/join/acr_inv_2");
  assert.match(room, /회의실/);
  assert.match(room, /한 번 호출하면 바로 들어와/);
  assert.ok(!/로비/.test(room), "방 초대에 로비 문구를 섞지 않는다");
  const pool = poolInviteText("우리 집", "로비", "https://x/join/acr_inv_1");
  assert.match(pool, /우리 집/);
  assert.match(pool, /바로 '로비'에 들어와/);
  assert.match(pool, /https:\/\/x\/join\/acr_inv_1/);
});

test("P1-3: 내가 보낸 최근 메시지가 답장 전이면 폴링을 4초로 유지한다", () => {
  const now = Date.UTC(2026, 10, 26, 4, 0, 0);
  const sent = message({
    seq: 5,
    sender: { type: "owner", id: "owner", name: "owner" },
    recipient: { id: "agt_1", name: "피클" },
    delivery: { state: "sent" },
    created_at: new Date(now - 30_000).toISOString(),
  });
  assert.equal(awaitingDelivery([sent], now), true);
  assert.equal(awaitingDelivery([{ ...sent, delivery: { state: "acked" } }], now), true, "확인함도 답장 전이면 기다린다");
  assert.equal(awaitingDelivery([{ ...sent, delivery: { state: "replied" } }], now), false, "답장하면 끝난다");
  assert.equal(awaitingDelivery([{ ...sent, recipient: null }], now), false, "지목 없는 글은 배지가 없다");
  assert.equal(awaitingDelivery([{ ...sent, created_at: new Date(now - 16 * 60_000).toISOString() }], now), false, "오래된 글은 따라가지 않는다");

  assert.equal(pollDelay(0, false), POLL_STEPS[0]);
  assert.equal(pollDelay(4, false), POLL_STEPS[4], "조용하면 20초까지 늦춘다");
  assert.equal(pollDelay(4, true), POLL_STEPS[0], "기다리는 동안은 4초 고정");
  assert.equal(pollDelay(99, true), POLL_STEPS[0]);
  assert.equal(pollDelay(-3, false), POLL_STEPS[0], "음수는 첫 단계로");
});

test("전달 상태 실시간 갱신: 증분 폴링도 최근 구간을 되읽는다", () => {
  assert.equal(nextFetchAfter(0, true), 0, "전체 재조회");
  assert.equal(nextFetchAfter(0, false), 0, "빈 방");
  assert.equal(nextFetchAfter(10, false), 0, "짧은 방은 처음부터");
  assert.equal(nextFetchAfter(500, false), 420, "최근 80개를 되읽어 delivery.state 변화를 받는다");
  assert.equal(nextFetchAfter(500, false, 1), 499);
  assert.equal(nextFetchAfter(500, true), 0, "30번째 폴링의 전체 재조회");
  assert.equal(nextFetchAfter(Number.NaN, false), 0);

  assert.equal(countNew(100, [95, 101, 102]), 2, "되읽은 기존 메시지는 새 글로 세지 않는다");
  assert.equal(countNew(0, []), 0);
});

test("방 구성원 → 화면 참여자: 멤버십과 신원 상태를 함께 본다", () => {
  const m = (over: Partial<RoomMember> = {}): RoomMember => ({
    agent_id: "agt_1",
    name: "피클",
    product_self_declared: "Pickle",
    status: "active",
    agent_status: "active",
    can_read: true,
    can_write: false,
    history_floor_seq: 4,
    fetched_seq: 2,
    acked_seq: 1,
    last_seen: null,
    ...over,
  });
  const active = memberToAgent(m());
  assert.equal(active.status, "active");
  assert.equal(active.can_write, false);
  assert.equal(memberToAgent(m({ status: "invited" })).status, "unclaimed", "초대만 된 구성원은 지목 대상이 아니다");
  assert.equal(memberToAgent(m({ agent_status: "revoked" })).status, "revoked");
  assert.equal(presenceLabel("active", null), "연결 대기");
  assert.equal(presenceLabel("active", new Date().toISOString()), "온라인");
  assert.equal(presenceLabel("revoked", new Date().toISOString()), "폐기됨");
});

test("P0-1: 오너가 없으면 계정 만들기로 열고, 이미 있으면 로그인으로 연다", () => {
  assert.equal(setupLandingMode(null), "login");
  assert.equal(setupLandingMode({ needs_owner: false }), "login");
  assert.equal(setupLandingMode({ needs_owner: true }), "onboard", "오너가 없으면 계정 만들기가 첫 화면");
});

test("P1-8: 승인 전에 풀의 기존 이름과 대조한다(폐기된 비서·자기 자신은 제외)", () => {
  const pool = [
    { id: "agt_1", name: "피클", status: "active" },
    { id: "agt_2", name: "Poke", status: "unclaimed" },
    { id: "agt_3", name: "옛비서", status: "revoked" },
  ];
  assert.equal(agentNameConflict(pool, "피클"), "피클");
  assert.equal(agentNameConflict(pool, "  피클 "), "피클", "앞뒤 공백은 무시한다");
  assert.equal(agentNameConflict(pool, "poke"), "Poke", "대소문자 무시(서버 name_key 와 같다)");
  assert.equal(agentNameConflict(pool, "옛비서"), null, "폐기된 이름은 다시 쓸 수 있다");
  assert.equal(agentNameConflict(pool, "새비서"), null);
  assert.equal(agentNameConflict(pool, "피클", "agt_1"), null, "기존 비서의 구성원 추가는 자기 이름을 그대로 쓴다");
  assert.equal(agentNameConflict(pool, "   "), null);
});
