// 화면이 서버 값을 번역하는 순수 규칙. 컴포넌트는 여기 결과만 그린다(테스트는 이 파일만 본다).
import type { ActivityItem, Agent, AgentSummary, Message, RoomCard, RoomHealth, RoomMember } from "./types.js";
import type { View } from "./route.js";
import { TONE_LABEL, type AgentTone } from "./format.js";

/** 풀의 비서 상태 → 상태 점. agentTone 과 같은 규칙(신원 상태 + 마지막 접속 30분). */
export function presenceTone(status: string, lastSeen: string | null, now = Date.now()): AgentTone {
  if (status === "revoked") return "offline";
  if (status === "unclaimed" || !lastSeen) return "pending";
  return now - new Date(lastSeen).getTime() < 30 * 60_000 ? "online" : "idle";
}

export function presenceLabel(status: string, lastSeen: string | null): string {
  return TONE_LABEL[presenceTone(status, lastSeen)];
}

/** 방 구성원을 화면 부품(멘션·아바타·상태 점)이 쓰는 참여자 모양으로 바꾼다. */
export function memberToAgent(m: RoomMember): Agent {
  const status =
    m.agent_status === "revoked"
      ? "revoked"
      : m.status === "active" && m.agent_status === "active"
        ? "active"
        : "unclaimed";
  return {
    id: m.agent_id,
    name: m.name,
    product_self_declared: m.product_self_declared,
    status,
    can_read: m.can_read,
    can_write: m.can_write,
    history_floor_seq: m.history_floor_seq,
    fetched_seq: m.fetched_seq,
    acked_seq: m.acked_seq,
    last_seen: m.last_seen,
  };
}

export const LOGIN_ID_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{2,39}$/u;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 200;

/** 아이디: 3~40자, 첫 글자는 글자·숫자. 서버 normalizeLoginId 와 같은 규칙. */
export function loginIdProblem(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "아이디를 입력하세요.";
  if (!LOGIN_ID_RE.test(v)) return "아이디는 3~40자 (글자, 숫자, . _ -)여야 합니다.";
  return null;
}

/** 비밀번호: 12자 이상. 서버 PASSWORD_MIN 과 같은 값(앞뒤 공백도 그대로 센다). */
export function passwordProblem(raw: string): string | null {
  if (!raw) return "비밀번호를 입력하세요.";
  if (raw.length < PASSWORD_MIN) return `비밀번호는 ${PASSWORD_MIN}자 이상이어야 합니다.`;
  if (raw.length > PASSWORD_MAX) return `비밀번호는 ${PASSWORD_MAX}자 이하여야 합니다.`;
  return null;
}

export interface HealthLabel {
  /** 화면에 그릴 라벨. 정상(ok·idle)은 빈 문자열이다("정상은 침묵"). */
  label: string;
  tone: "online" | "wait" | "paused" | "idle";
  /** 어디에나 붙는 대신 hover·title 로만 보여 주는 한 줄 설명. */
  hint: string;
  /** 할 일이 없는 상태(정상). 점·라벨을 그리지 않는다. */
  quiet: boolean;
}

const HEALTH: Record<string, HealthLabel> = {
  ok: { label: "", tone: "online", hint: "30분 안에 대화가 있었습니다", quiet: true },
  needs_input: { label: "답변 필요", tone: "wait", hint: "내가 답해야 할 질문이 있습니다", quiet: false },
  paused: { label: "정지", tone: "paused", hint: "비서는 읽기만 할 수 있습니다", quiet: false },
  idle: { label: "", tone: "idle", hint: "30분 넘게 새 글이 없습니다", quiet: true },
};

/** 서버가 정한 health 를 한국어 한 단어로 옮긴다(추측하지 않는다). 정상은 말하지 않는다. */
export function healthLabel(health: RoomHealth | string): HealthLabel {
  return HEALTH[health] ?? HEALTH.idle;
}

/** 방 health 를 상태 한 단어로 옮긴다(정상이면 빈 문자열). 화면 행은 roomNeedsAnswer 를 쓴다. */
export function roomStateText(health: RoomHealth | string, paused = false): string {
  return paused || health === "paused" ? "정지" : health === "needs_input" ? "답변 필요" : "";
}

/** 방 health 기준으로 답을 기다리는 방 수(서버 needs_attention 이 없는 레거시 응답용 대체값). */
export function answerNeededRooms(rooms: RoomCard[]): number {
  return rooms.filter((r) => r.health === "needs_input").length;
}

/**
 * 이 방에 내가 아직 답할 것(안 읽은 질문·나에게 온 글·시스템 안내)이 있는가.
 * 서버가 준 방별 플래그를 쓰고, 플래그가 없는 응답(레거시 세션)만 health 로 대체한다.
 * 행 막대·`답변 필요` 단어·정렬·방 전환 메뉴가 모두 이 판정 하나를 쓴다.
 */
export function roomNeedsAnswer(r: RoomCard): boolean {
  return r.needs_attention ?? r.health === "needs_input";
}

/** "답변 필요" 행 표시: 서버가 준 방별 답할 것(없으면 health 로 대체). */
export function needsAttentionRoomIds(rooms: RoomCard[]): Set<string> {
  const out = new Set<string>();
  for (const r of rooms) if (roomNeedsAnswer(r)) out.add(r.id);
  return out;
}

/** 안 읽은 글이 있는 방 수. */
export function unreadRoomCount(rooms: RoomCard[]): number {
  return rooms.filter((r) => r.unread > 0).length;
}

/**
 * 관제실 상태 한 줄. 0 은 쓰지 않고, 할 일이 없으면 빈 문자열이다(정상은 침묵).
 * need 는 인박스와 같은 기준의 고유 방 수(서버 counts.needs_you_rooms).
 */
export function roomSummaryLine(counts: { need: number; unread: number; paused: number }): string {
  return [
    counts.need ? `답변 필요 ${counts.need}곳` : "",
    counts.unread ? `안 읽은 방 ${counts.unread}` : "",
    counts.paused ? `정지 ${counts.paused}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * 관제실 방 목록 순서: 답변 필요 → 정지 → 안 읽음 → 진행 중 → 조용함.
 * 같은 순위에서는 최근 활동이 위, 로비는 같은 순위에서 먼저(정체성).
 */
export function sortRoomCards(rooms: RoomCard[]): RoomCard[] {
  const rank = (r: RoomCard): number =>
    roomNeedsAnswer(r) ? 0 : r.paused || r.health === "paused" ? 1 : r.unread > 0 ? 2 : r.health === "ok" ? 3 : 4;
  return [...rooms].sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    if ((a.kind === "lobby") !== (b.kind === "lobby")) return a.kind === "lobby" ? -1 : 1;
    const at = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
    const bt = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
    return bt - at;
  });
}

/** 확인이 필요한 방 수(타일에서 바로 쓰는 값). */
export function needsYouRooms(rooms: RoomCard[]): number {
  return rooms.filter((r) => r.health === "needs_input").length;
}

export type ActivityKind = "all" | "question" | "directed" | "system";

export const ACTIVITY_KINDS: { key: ActivityKind; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "question", label: "질문" },
  { key: "directed", label: "나에게" },
  { key: "system", label: "시스템" },
];

export function activityKind(item: ActivityItem): Exclude<ActivityKind, "all"> {
  if (item.message.sender.type === "system") return "system";
  if (item.message.kind === "question") return "question";
  if (item.message.recipient?.id === "owner") return "directed";
  return "question";
}

export const ACTIVITY_LABEL: Record<Exclude<ActivityKind, "all">, string> = {
  question: "질문",
  directed: "나에게",
  system: "시스템",
};

/** 인박스 필터: 방 하나 + 종류. 서버가 준 순서(최신순)를 유지한다. */
export function filterActivity(items: ActivityItem[], filter: { roomId?: string; kind?: ActivityKind }): ActivityItem[] {
  const roomId = filter.roomId ?? "";
  const kind = filter.kind ?? "all";
  return items.filter((it) => (!roomId || it.room_id === roomId) && (kind === "all" || activityKind(it) === kind));
}

export function roomKindLabel(kind: string): string {
  return kind === "lobby" ? "로비" : "방";
}

/** 풀 초대: 우리 집(워크스페이스)에 비서를 들이는 링크. 승인되면 로비 구성원이 된다. */
export function poolInviteText(workspaceName: string, lobbyName: string, link: string): string {
  return (
    `내가 쓰는 공통 룸 '${workspaceName}'에 너의 비서를 초대하고 싶어.\n` +
    `아래 링크를 비서에게 그대로 전달해 주면 참여 요청을 보낼 수 있어(내가 승인하면 '${lobbyName}'에 들어와).\n` +
    link
  );
}

/** 방 초대: 그 방에만 바로 들어오는 링크. */
export function roomInviteText(workspaceName: string, roomName: string, link: string): string {
  return (
    `'${workspaceName}'의 방 '${roomName}'에 너의 비서를 초대하고 싶어.\n` +
    `아래 링크를 비서에게 그대로 전달해 주면 참여 요청을 보낼 수 있어(내가 승인하면 그 방에 들어와).\n` +
    link
  );
}

/** 홈/비서실에서 쓰는 "어느 방에 있나" 문장. */
export function agentRoomNames(agent: AgentSummary, rooms: RoomCard[]): string[] {
  const byId = new Map(rooms.map((r) => [r.id, r.name]));
  return agent.rooms.map((id) => byId.get(id) ?? id);
}

// ---------- ⌘K 팔레트 ----------

export type PaletteAction =
  | { type: "view"; view: View }
  | { type: "room"; roomId: string }
  | { type: "agent"; agentId: string }
  | { type: "new-room" }
  | { type: "invite" };

export interface PaletteItem {
  id: string;
  group: "이동" | "방" | "비서" | "명령";
  label: string;
  hint?: string;
  /** 항목마다 다른 아이콘(이동 4행이 모두 같은 아이콘이면 구분이 안 된다). */
  icon?: "gauge" | "inbox" | "rooms" | "bot" | "plus" | "link";
  action: PaletteAction;
}

export const PALETTE_COMMANDS: PaletteItem[] = [
  { id: "cmd:new-room", group: "명령", label: "새 방 만들기", icon: "plus", action: { type: "new-room" } },
  { id: "cmd:invite", group: "명령", label: "비서 초대 링크 만들기", icon: "link", action: { type: "invite" } },
];

/** 팔레트 항목: 이동 4 + 방 + 비서 + 명령. 검색어는 라벨·힌트의 부분 일치(대소문자 무시). */
export function paletteItems(
  input: { rooms: RoomCard[]; agents: AgentSummary[] },
  query: string,
  limit = 14,
): PaletteItem[] {
  const nav: PaletteItem[] = [
    { id: "nav:home", group: "이동", label: "관제실 (홈)", icon: "gauge", action: { type: "view", view: "home" } },
    { id: "nav:inbox", group: "이동", label: "통합 인박스", icon: "inbox", action: { type: "view", view: "inbox" } },
    { id: "nav:rooms", group: "이동", label: "방 목록", icon: "rooms", action: { type: "view", view: "rooms" } },
    { id: "nav:desk", group: "이동", label: "비서실", icon: "bot", action: { type: "view", view: "desk" } },
  ];
  const rooms: PaletteItem[] = input.rooms.map((r) => ({
    id: `room:${r.id}`,
    group: "방",
    label: r.name,
    icon: "rooms",
    hint: r.kind === "lobby" ? "로비" : r.unread ? `새 글 ${r.unread}` : roomNeedsAnswer(r) ? "답변 필요" : undefined,
    action: { type: "room", roomId: r.id },
  }));
  const agents: PaletteItem[] = input.agents.map((a) => ({
    id: `agent:${a.id}`,
    group: "비서",
    label: a.name,
    icon: "bot",
    hint: a.product || "비서실에서 보기",
    action: { type: "agent", agentId: a.id },
  }));
  const all = [...nav, ...rooms, ...agents, ...PALETTE_COMMANDS];
  const q = query.trim().toLowerCase();
  if (!q) return all.slice(0, limit);
  return all
    .filter((it) => `${it.label} ${it.hint ?? ""}`.toLowerCase().includes(q))
    .slice(0, limit);
}

// ---------- 메시지 폴링 ----------

/** 증분 폴링이 되읽는 최근 구간. 이보다 오래된 메시지의 전달 상태는 전체 재조회에서만 갱신된다. */
export const DELIVERY_WINDOW = 80;

/**
 * 오너 메시지 폴링 시작 커서.
 * 증분 API(after=)는 커서 이후만 주므로, 기존 메시지의 delivery.state(보냄→받음→답장함)가
 * 바뀌어도 새로고침 전에는 화면이 그대로였다. 매 폴링마다 최근 구간을 함께 되읽어
 * 같은 seq 를 새 값으로 합치면(mergeMessages) 전달 상태가 실시간으로 바뀐다.
 */
export function nextFetchAfter(lastSeq: number, full: boolean, window = DELIVERY_WINDOW): number {
  if (full) return 0;
  const last = Number.isFinite(lastSeq) ? Math.max(0, Math.trunc(lastSeq)) : 0;
  return Math.max(0, last - Math.max(1, window));
}

/** 새 메시지 수(폴링 간격 판단). 되읽은 기존 메시지는 세지 않는다. */
export function countNew(previousLast: number, seqs: number[]): number {
  return seqs.filter((s) => s > previousLast).length;
}

// ---------- 적응형 폴링 ----------

/** 폴링 단계(ms). 새 글이 없으면 점점 늦춘다. */
export const POLL_STEPS = [4000, 6000, 10000, 15000, 20000];

/** 전달 배지(보냄→받아감→확인함→답장함)를 기다리는 최근 구간. */
export const DELIVERY_WATCH_MS = 15 * 60_000;

/**
 * 지금 전달 상태 변화를 기다리는 메시지가 있는지.
 * 내가 보낸 지 DELIVERY_WATCH_MS 안의 메시지가 수신자에게 아직 답장(replied)까지 가지 않았다면 true.
 * 이때는 폴링을 가장 짧은 간격으로 고정해 배지가 최대 20초 늦게 바뀌던 문제를 줄인다.
 */
export function awaitingDelivery(messages: Message[], now = Date.now()): boolean {
  return messages.some((m) => {
    if (m.sender.type !== "owner" || !m.recipient || !m.delivery) return false;
    if (m.delivery.state === "replied" || m.deleted) return false;
    const at = new Date(m.created_at).getTime();
    return Number.isFinite(at) && now - at < DELIVERY_WATCH_MS;
  });
}

/** 폴링 간격: 전달을 기다리는 중이면 가장 짧은 단계(4초), 아니면 조용한 만큼 늦춘 단계. */
export function pollDelay(quiet: number, waiting: boolean, steps: number[] = POLL_STEPS): number {
  const idx = Math.min(Math.max(0, Math.trunc(quiet)), steps.length - 1);
  return waiting ? steps[0] : steps[idx];
}

// ---------- 최초 화면(로그인/계정 만들기) ----------

export type LandingMode = "login" | "onboard";

/**
 * 계정이 하나도 없을 때 어느 탭으로 열지 정한다.
 * 로그인 화면만 보이는 것은 막다른 길이라, 오너가 없으면 '계정 만들기'로 연다.
 * (v1 방 코드 로그인은 화면에서 걷어냈다 — 백엔드 /api/auth/legacy 는 기존 클라이언트용으로 남긴다.)
 */
export function setupLandingMode(setup: { needs_owner?: boolean } | null): LandingMode {
  if (!setup?.needs_owner) return "login";
  return "onboard";
}

/** 이미 풀에 있는(폐기되지 않은) 비서 이름과 부딪히면 그 이름을 돌려준다. 승인 전에 미리 알려 409 왕복을 줄인다. */
export function agentNameConflict(
  pool: { id: string; name: string; status: string }[],
  wanted: string,
  ignoreId?: string | null,
): string | null {
  const key = wanted.trim().toLowerCase();
  if (!key) return null;
  const hit = pool.find((a) => a.status !== "revoked" && a.id !== ignoreId && a.name.trim().toLowerCase() === key);
  return hit ? hit.name : null;
}

/** 인박스에서 아직 읽지 않은 항목 수(배지와 같은 기준). */
export function unreadActivityCount(items: ActivityItem[]): number {
  return items.filter((it) => it.unread).length;
}
