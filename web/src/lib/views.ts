// 화면이 서버 값을 번역하는 순수 규칙. 컴포넌트는 여기 결과만 그린다(테스트는 이 파일만 본다).
// 세 화면(방·비서·설정)만 남긴 단순화 이후에도 필요한 규칙만 둔다.
import type { Agent, AgentSummary, Message, PoolAgent, RoomCard, RoomMember } from "./types.js";
import { durationLabel, ONLINE_WINDOW_MS, TONE_LABEL, type AgentTone } from "./format.js";

/** 풀의 비서 상태 → 상태 점. agentTone 과 같은 규칙(신원 상태 + 마지막 실제 활동 5분). */
export function presenceTone(status: string, lastSeen: string | null, now = Date.now()): AgentTone {
  if (status === "revoked") return "offline";
  if (status === "unclaimed" || !lastSeen) return "pending";
  return now - new Date(lastSeen).getTime() < ONLINE_WINDOW_MS ? "online" : "idle";
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

/**
 * 이 방에 내가 아직 답할 것(안 읽은 질문·나에게 온 글·시스템 안내)이 있는가.
 * 서버가 준 방별 플래그를 쓰고, 플래그가 없는 응답(레거시 세션)만 health 로 대체한다.
 */
export function roomNeedsAnswer(r: RoomCard): boolean {
  return r.needs_attention ?? r.health === "needs_input";
}

/** 안 읽은 글이 있는 방 수. 방 목록 배지가 쓴다. */
export function unreadRoomCount(rooms: RoomCard[]): number {
  return rooms.filter((r) => r.unread > 0).length;
}

/**
 * 방 목록 순서: 답변 필요 → 정지 → 안 읽음 → 진행 중 → 조용함.
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

/** 방 한 줄의 오른쪽 표시: 안 읽은 수 → 없으면 비서 수. */
export function roomRowCount(r: RoomCard): number {
  return r.unread > 0 ? r.unread : r.member_count;
}

// ---------- 비서 화면 ----------

/** 지금 실제로 대화할 수 있는(폐기·미승인 아닌) 비서 수. 화면 어디서나 이 수 하나를 쓴다. */
export function activeAgentCount(agents: { status: string }[]): number {
  return agents.filter((a) => a.status === "active").length;
}

export interface AgentRoomToggle {
  roomId: string;
  name: string;
  /** 이 비서가 그 방의 활성 구성원인가. */
  on: boolean;
  /** 로비는 워크스페이스의 입구라 뺄 수 없다. */
  locked: boolean;
}

/** 비서 카드의 방 토글: 워크스페이스의 모든 방을 한 줄로 보여 주고 켜짐/꺼짐만 다룬다. */
export function agentRoomToggles(agent: PoolAgent, rooms: RoomCard[], lobbyRoomId: string | null): AgentRoomToggle[] {
  const on = new Set(agent.rooms.filter((r) => r.status !== "removed").map((r) => r.room_id));
  return rooms.map((r) => ({
    roomId: r.id,
    name: r.name,
    on: on.has(r.id),
    locked: r.id === lobbyRoomId,
  }));
}

/** 방 토글 하나를 눌렀을 때 서버에 보낼 "이 비서가 있어야 할 방 목록". 로비는 항상 포함한다. */
export function toggledRoomIds(agent: PoolAgent, rooms: RoomCard[], lobbyRoomId: string | null, toggleRoomId: string): string[] {
  const current = new Set(agent.rooms.filter((r) => r.status !== "removed").map((r) => r.room_id));
  // 로비는 워크스페이스의 입구라 어떤 경우에도 빠지지 않는다(화면도 이 칩을 잠가 둔다).
  if (toggleRoomId !== lobbyRoomId) {
    if (current.has(toggleRoomId)) current.delete(toggleRoomId);
    else current.add(toggleRoomId);
  }
  if (lobbyRoomId) current.add(lobbyRoomId);
  // 이 워크스페이스의 방만 남긴다(다른 워크스페이스 값이 섞이지 않게).
  return [...current].filter((id) => rooms.some((r) => r.id === id));
}

/** 토큰을 받지 못한(미승인) 비서에게 보여 줄 짧은 안내. */
export function unclaimedNotice(): string {
  return "토큰을 받지 못한 비서입니다. 같은 이름으로는 새 초대 링크를 받아도 들어올 수 없으니, 연결을 끊고 새로 초대하세요.";
}

// ---------- 초대 ----------

/** 원클릭 '초대 링크 복사'가 쓰는 기본값: 7일 · 10회. */
export const INVITE_DEFAULTS = { ttlHours: 168, maxUses: 10 } as const;

/**
 * 방 초대 전달 문장: 링크를 받은 비서가 join 을 한 번 부르면 바로 들어온다.
 * 입장은 시작일 뿐이라, 들어온 뒤 inbox 를 계속 확인해 대화를 이어가라는 한 줄을 함께 보낸다
 * (입장만 하고 멈추던 비서가 있었다).
 */
export function roomInviteText(workspaceName: string, roomName: string, link: string): string {
  return (
    `'${workspaceName}'의 방 '${roomName}'에 너의 비서를 초대하고 싶어.\n` +
    `아래 링크로 join 을 한 번 호출하면 바로 들어와.\n` +
    link +
    `\n입장한 뒤에는 멈추지 말고 계속 메시지를 확인해서 대화를 이어가 줘.`
  );
}

/** 풀 초대 전달 문장: 승인 없이 로비로 들어온다. */
export function poolInviteText(workspaceName: string, lobbyName: string, link: string): string {
  return (
    `내가 쓰는 라운지 '${workspaceName}'에 너의 비서를 초대하고 싶어.\n` +
    `아래 링크로 join 을 한 번 호출하면 바로 '${lobbyName}'에 들어와.\n` +
    link +
    `\n입장한 뒤에는 멈추지 말고 계속 메시지를 확인해서 대화를 이어가 줘.`
  );
}

// ---------- 일시정지 배너 ----------

/** 배너가 읽는 값만(방 상세의 pause_info + rate_limit). */
interface PausedRoom {
  pause_info: { reason: string; window_seconds?: number; limit?: number } | null;
  rate_limit?: { count: number; window_seconds: number };
}

/**
 * 일시정지 배너 제목: 누가·왜 멈췄나.
 * 예전에는 어떤 정지든 "일시정지" 한 마디에 "비서는 읽기만 합니다"만 보여,
 * 자동 속도 제한으로 멈춘 방인지 방장이 직접 멈춘 방인지 구분할 수 없었다.
 */
export function pauseTitle(room: PausedRoom): string {
  return room.pause_info?.reason === "rate_cap" ? "자동 일시정지 · 메시지 빈도 상한" : "일시정지 · 방장이 멈춤";
}

/**
 * 배너 본문: 자동 정지는 남은/해제 방법을, 수동 정지는 재개하면 되는 것을 말한다.
 * 재개하면 서버가 빈도 창의 기준점을 지금으로 옮기므로( rate_reset ) 바로 다시 대화할 수 있다.
 */
export function pauseDetail(room: PausedRoom): string {
  if (room.pause_info?.reason === "rate_cap") {
    const seconds = room.pause_info.window_seconds ?? room.rate_limit?.window_seconds ?? 600;
    const count = room.pause_info.limit ?? room.rate_limit?.count ?? 30;
    return `비서가 ${durationLabel(seconds)}에 ${count}건을 넘어 자동으로 멈췄습니다. 재개하면 이 방의 빈도 창을 지금부터 새로 셉니다(여러 방에 걸친 비서별 상한은 그대로 적용됩니다).`;
  }
  return "내 메시지는 그대로 전달되고, 비서는 읽기만 합니다. 재개하면 비서가 다시 답할 수 있습니다.";
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

/** 폴링 단계(ms). 새 글이 없으면 점점 늦춘다. */
export const POLL_STEPS = [4000, 6000, 10000, 15000, 20000];

/** 전달 배지(보냄→받아감→확인함→답장함)를 기다리는 최근 구간. */
export const DELIVERY_WATCH_MS = 15 * 60_000;

/**
 * 지금 전달 상태 변화를 기다리는 메시지가 있는지.
 * 내가 보낸 지 DELIVERY_WATCH_MS 안의 메시지가 수신자에게 아직 답장(replied)까지 가지 않았다면 true.
 * 이때는 폴링을 가장 짧은 간격으로 고정한다.
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
 */
export function setupLandingMode(setup: { needs_owner?: boolean } | null): LandingMode {
  if (!setup?.needs_owner) return "login";
  return "onboard";
}

/** 이미 풀에 있는(폐기되지 않은) 비서 이름과 부딪히면 그 이름을 돌려준다. */
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

/** 비서 화면의 한 줄 요약(0은 말하지 않는다). */
export function agentsSummary(agents: AgentSummary[]): string {
  const live = activeAgentCount(agents);
  const waiting = agents.filter((a) => a.status === "unclaimed").length;
  return [live ? `비서 ${live}명` : "비서 없음", waiting ? `연결 대기 ${waiting}명` : ""].filter(Boolean).join(" · ");
}
