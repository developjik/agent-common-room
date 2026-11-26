// v2 탈-슬랙 UI의 순수 규칙 검증: 경로 · 상태 번역 · 정렬 · 인박스 필터 · ⌘K · 전달 상태 폴링 창.
// React 컴포넌트는 이 함수들의 결과만 그리므로, 여기서 규칙이 맞으면 화면도 같은 규칙을 따른다.
import test from "node:test";
import assert from "node:assert/strict";
import { activeTab, parseRoute, routeHref } from "../web/src/lib/route.js";
import {
  agentNameConflict,
  awaitingDelivery,
  countNew,
  filterActivity,
  healthLabel,
  loginIdProblem,
  memberToAgent,
  needsYouRooms,
  nextFetchAfter,
  paletteItems,
  passwordProblem,
  POLL_STEPS,
  pollDelay,
  poolInviteText,
  presenceLabel,
  answerNeededRooms,
  roomInviteText,
  roomStateText,
  roomSummaryLine,
  setupLandingMode,
  sortRoomCards,
  unreadActivityCount,
  unreadRoomCount,
} from "../web/src/lib/views.js";
import type { ActivityItem, Message, RoomCard, RoomMember } from "../web/src/lib/types.js";

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

test("경로: 쿼리 파라미터만 쓰고, 방 ID가 있으면 방 집중 뷰가 우선한다", () => {
  assert.deepEqual(parseRoute(""), { view: "home", roomId: null });
  assert.deepEqual(parseRoute("?view=inbox"), { view: "inbox", roomId: null });
  assert.deepEqual(parseRoute("?view=desk"), { view: "desk", roomId: null });
  assert.deepEqual(parseRoute("?room=room_50795a119a4a4b48"), { view: "home", roomId: "room_50795a119a4a4b48" });
  assert.deepEqual(parseRoute("?view=desk&room=room_x"), { view: "home", roomId: "room_x" }, "방을 보고 있으면 뷰 파라미터는 무시");
  assert.deepEqual(parseRoute("?view=../../etc"), { view: "home", roomId: null }, "모르는 뷰는 홈");
  assert.deepEqual(parseRoute("?room=<script>"), { view: "home", roomId: null }, "방 ID 모양이 아니면 무시");

  assert.equal(routeHref({ view: "home", roomId: null }), "/");
  assert.equal(routeHref({ view: "inbox", roomId: null }), "?view=inbox");
  assert.equal(routeHref({ view: "home", roomId: "room_a" }), "?room=room_a");
  assert.equal(activeTab({ view: "home", roomId: "room_a" }), "rooms");
  assert.equal(activeTab({ view: "settings", roomId: null }), "home", "설정은 레일 하단이라 홈 탭을 유지");
  assert.equal(activeTab({ view: "desk", roomId: null }), "desk");
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

test("서버 health 를 상태 라벨로만 번역한다(정상은 침묵)", () => {
  assert.equal(healthLabel("needs_input").label, "답변 필요");
  assert.equal(healthLabel("needs_input").tone, "wait");
  assert.equal(healthLabel("needs_input").quiet, false);
  assert.equal(healthLabel("paused").label, "정지");
  assert.equal(healthLabel("ok").label, "", "정상은 화면에 라벨을 그리지 않는다");
  assert.equal(healthLabel("ok").quiet, true);
  assert.equal(healthLabel("idle").label, "");
  assert.equal(healthLabel("알수없음").quiet, true, "모르는 값은 침묵으로(추측 금지)");
  assert.equal(roomStateText("ok"), "");
  assert.equal(roomStateText("needs_input"), "답변 필요");
  assert.equal(roomStateText("ok", true), "정지", "일시정지가 방 상태보다 먼저다");
});

test("`답변 필요` 수는 화면 어디서나 방 기준 한 값이다", () => {
  const rooms = [
    card({ id: "a", health: "needs_input" }),
    card({ id: "b", health: "needs_input", unread: 4 }),
    card({ id: "c", unread: 2 }),
  ];
  assert.equal(answerNeededRooms(rooms), 2);
  assert.equal(needsYouRooms(rooms), 2, "예전 이름도 같은 값을 센다");
  assert.equal(unreadRoomCount(rooms), 2);
  assert.equal(roomSummaryLine(rooms), "답변 필요 2곳 · 안 읽은 방 2");
  assert.equal(roomSummaryLine([card({ id: "d" })]), "", "0 은 쓰지 않는다");
});

test("관제실 정렬: 답변 필요 → 정지 → 안 읽음 → 진행 중 → 조용함, 같은 순위는 최근 활동", () => {
  const needs = card({ id: "a", health: "needs_input", last_message_at: "2026-11-20T00:00:00.000Z" });
  const paused = card({ id: "b", health: "paused", paused: true });
  const unread = card({ id: "c", unread: 3 });
  const fresh = card({ id: "d", last_message_at: "2026-11-25T00:00:00.000Z" });
  const idle = card({ id: "e", health: "idle", last_message_at: "2026-11-10T00:00:00.000Z" });
  const lobby = card({ id: "f", kind: "lobby", health: "idle", last_message_at: null });

  const order = sortRoomCards([idle, fresh, unread, paused, needs, lobby]).map((r) => r.id);
  assert.deepEqual(order.slice(0, 4), ["a", "b", "c", "d"], "확인 필요·정지·안 읽음·진행 중 순");
  assert.equal(order[4], "f", "같은 조용함 순위에서는 로비가 먼저");
  assert.equal(needsYouRooms([needs, paused, unread]), 1);
});

test("인박스 필터: 종류(질문·나에게·시스템)와 방", () => {
  const q = message({ seq: 1, kind: "question" });
  const direct = message({ seq: 2, recipient: { id: "owner", name: "owner" } });
  const sys = message({ seq: 3, sender: { type: "system", id: "system", name: "system" } });
  const items: ActivityItem[] = [
    { room_id: "room_a", room_name: "로비", room_kind: "lobby", message: q },
    { room_id: "room_b", room_name: "회의실", room_kind: "room", message: direct },
    { room_id: "room_a", room_name: "로비", room_kind: "lobby", message: sys },
  ];
  assert.equal(filterActivity(items, {}).length, 3);
  assert.deepEqual(filterActivity(items, { kind: "question" }).map((i) => i.message.seq), [1]);
  assert.deepEqual(filterActivity(items, { kind: "directed" }).map((i) => i.message.seq), [2]);
  assert.deepEqual(filterActivity(items, { kind: "system" }).map((i) => i.message.seq), [3]);
  assert.deepEqual(filterActivity(items, { roomId: "room_a" }).map((i) => i.message.seq), [1, 3]);
});

test("⌘K 팔레트: 이동·방·비서·명령을 한 목록에서 검색한다", () => {
  const all = paletteItems({ rooms: [card({ id: "room_a", name: "회의실" })], agents: [{ id: "agt_1", name: "피클", product: "Pickle", status: "active", last_seen: null, rooms: [] }] }, "");
  assert.deepEqual([...new Set(all.map((i) => i.group))], ["이동", "방", "비서", "명령"]);
  const hit = paletteItems({ rooms: [card({ id: "room_a", name: "회의실" })], agents: [{ id: "agt_1", name: "피클", product: "Pickle", status: "active", last_seen: null, rooms: [] }] }, "회의");
  assert.equal(hit.length, 1);
  assert.deepEqual(hit[0].action, { type: "room", roomId: "room_a" });
  const byProduct = paletteItems({ rooms: [], agents: [{ id: "agt_1", name: "피클", product: "Pickle", status: "active", last_seen: null, rooms: [] }] }, "pickle");
  assert.deepEqual(byProduct[0].action, { type: "agent", agentId: "agt_1" }, "제품명으로도 찾는다");
  assert.equal(paletteItems({ rooms: [], agents: [] }, "없는말").length, 0);
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

test("초대 전달 문장은 워크스페이스·방·링크를 구분해 담는다", () => {
  const pool = poolInviteText("우리 집", "로비", "https://x/join/acr_inv_1");
  assert.match(pool, /우리 집/);
  assert.match(pool, /로비/);
  assert.match(pool, /https:\/\/x\/join\/acr_inv_1/);
  const room = roomInviteText("우리 집", "회의실", "https://x/join/acr_inv_2");
  assert.match(room, /회의실/);
  assert.ok(!/로비/.test(room), "방 초대에 로비 문구를 섞지 않는다");
});

test("P0-1: 계정이 없고 관리자 키를 모르면 기존 방 코드 탭으로 열고, 방이 없으면 계정 만들기로 연다", () => {
  assert.equal(setupLandingMode(null), "login");
  assert.equal(setupLandingMode({ needs_owner: false }), "login");
  assert.equal(setupLandingMode({ needs_owner: true, bootstrap_allowed: true, legacy_rooms: 0 }), "onboard");
  assert.equal(
    setupLandingMode({ needs_owner: true, bootstrap_allowed: false, legacy_rooms: 2 }),
    "legacy",
    "관리자 키를 모르는 상태에서 기존 방이 있으면 방 코드 경로가 막다른 길을 피한다",
  );
  assert.equal(
    setupLandingMode({ needs_owner: true, bootstrap_allowed: true, legacy_rooms: 1 }),
    "onboard",
    "웹에서 키를 만들 수 있으면 계정 만들기가 첫 화면이다",
  );
  assert.equal(
    setupLandingMode({ needs_owner: true, bootstrap_allowed: false, legacy_rooms: 0 }),
    "onboard",
    "기존 방이 없으면 안내만 하고 계정 만들기 탭에 둔다",
  );
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

test("P1-2: 인박스 확인 필요 수는 목록의 unread 항목 수와 같다", () => {
  const item = (seq: number, unread: boolean): ActivityItem => ({
    room_id: "room_1",
    room_name: "로비",
    room_kind: "lobby",
    unread,
    message: message({ seq }),
  });
  assert.equal(unreadActivityCount([item(1, true), item(2, false), item(3, true)]), 2);
  assert.equal(unreadActivityCount([]), 0);
  assert.equal(unreadActivityCount([{ ...item(1, false), unread: undefined }]), 0, "읽음 표시가 없으면 세지 않는다");
});
