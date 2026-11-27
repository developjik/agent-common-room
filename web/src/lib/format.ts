// 화면에 쓰는 시간·이름·상태 표기. 서버가 아는 것(값)만 문장으로 바꾼다.
import type { Agent, Message } from "./types.js";

const pad = (n: number) => String(n).padStart(2, "0");

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtFull(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. ${fmtTime(iso)}`;
}

export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const WEEKDAYS = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
const MONTHS = ["1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월"];

/** 날짜 구분선: `2026년 11월 25일 수요일`. */
export function dateSeparatorLabel(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}년 ${MONTHS[d.getMonth()]} ${d.getDate()}일 ${WEEKDAYS[d.getDay()]}`;
}

/** 상대시간: 방금 전 / N분 전 / N시간 전 / 어제 HH:MM / M월 D일. */
export function relTime(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const now = Date.now();
  const d = Math.max(0, now - t);
  if (d < 45_000) return "방금 전";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}분 전`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}시간 전`;
  const day = new Date(t);
  const yesterday = new Date(now - 86_400_000);
  if (day.getDate() === yesterday.getDate() && day.getMonth() === yesterday.getMonth()) return `어제 ${fmtTime(iso)}`;
  if (day.getFullYear() === new Date(now).getFullYear()) return `${MONTHS[day.getMonth()]} ${day.getDate()}일`;
  return `${day.getFullYear()}년 ${MONTHS[day.getMonth()]} ${day.getDate()}일`;
}

export function remainLabel(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "만료됨";
  // 72시간짜리 초대를 2.98일 뒤에 보면 '2일 남음'이었다. 남은 일수는 시간을 내림하지 않고
  // 남은 밀리초에서 바로 올림한다(48시간 30분 → 3일 남음).
  if (ms >= 24 * 3_600_000) return `${Math.ceil(ms / 86_400_000)}일 남음`;
  const h = Math.floor(ms / 3_600_000);
  if (h >= 1) return `${h}시간 남음`;
  return `${Math.max(1, Math.floor(ms / 60_000))}분 남음`;
}

export type AgentTone = "online" | "idle" | "pending" | "offline";

/**
 * 온라인 판정 창.
 * 예전에는 30분이었는데, 입장(토큰 발급)만 하고 inbox 를 한 번도 열지 않은 비서도 30분간
 * 초록 점으로 보였다. 온라인은 "지금 폴링·답장 중"이라는 뜻이어야 하므로 5분으로 좁히고,
 * 5분이 지나면 자리 비움으로 내린다.
 */
export const ONLINE_WINDOW_MS = 5 * 60_000;

export function agentTone(a: Agent, now = Date.now()): AgentTone {
  if (a.status === "revoked") return "offline";
  if (a.status === "unclaimed") return "pending";
  // 토큰은 발급됐지만 인증 요청이 한 번도 없었으면 아직 연결 대기다(입장했지만 폴링 전).
  if (!a.last_seen) return "pending";
  return now - new Date(a.last_seen).getTime() < ONLINE_WINDOW_MS ? "online" : "idle";
}

export const TONE_LABEL: Record<AgentTone, string> = {
  online: "온라인",
  idle: "자리 비움",
  pending: "연결 대기",
  offline: "폐기됨",
};

/** 지금 메시지를 받을 수 있는(활성) 참여자만 돌려준다. 폐기·미승인 참여자는 지목 대상이 아니다. */
export function activeAgent(agents: Agent[], id: string): Agent | undefined {
  const a = agents.find((x) => x.id === id);
  return a && a.status === "active" ? a : undefined;
}

/**
 * 받는 사람으로 골라 둔 참여자가 더 이상 활성이 아니게 되었을 때(폐기·미승인),
 * 받는 사람을 `방 전체`로 되돌릴지와 그때 띄울 안내 문구를 정한다.
 * 고른 적이 없거나 아직 활성이면 그대로 두고, 참여자 목록을 아직 받지 못해(빈 배열)
 * 누가 사라진 것인지 알 수 없을 때는 조용히 되돌린다(초기 로딩 오발동 방지).
 */
export function recipientReset(agents: Agent[], recipient: string): { reset: boolean; notice: string | null } {
  if (!recipient || activeAgent(agents, recipient)) return { reset: false, notice: null };
  const gone = agents.find((a) => a.id === recipient);
  if (!gone) return { reset: true, notice: null };
  const why = gone.status === "revoked" ? "폐기되어" : gone.status === "unclaimed" ? "아직 승인 전이라" : "지금은 메시지를 받을 수 없어";
  return { reset: true, notice: `@${gone.name} 비서가 ${why} 받는 사람이 방 전체로 바뀌었습니다.` };
}

/** 서버는 `seq > history_floor`를 보여 주므로, 화면에는 실제로 보이는 첫 번호(floor+1)를 적는다. */
export function historyFloorLabel(historyFloorSeq: number): string {
  return `기록 #${Math.max(0, historyFloorSeq) + 1}부터`;
}

export function seenLabel(a: Agent): string {
  if (a.status === "revoked") return "연결 끊김 · 다시 초대해야 함";
  if (a.status === "unclaimed") return "승인됨 · 연결 대기";
  // last_seen 은 실제 인증 요청(me·inbox·ack·답장)에서 생긴다. 기록이 없으면 입장만 하고
  // inbox 를 열지 않은 비서다(예전에는 입장 시각을 기록해 '방금 확인함'으로 보였다).
  if (!a.last_seen) return "입장함 · inbox 미확인";
  const d = Math.max(0, Date.now() - new Date(a.last_seen).getTime());
  if (d < 3 * 60_000) return "방금 확인함";
  if (d < 60 * 60_000) return `${Math.max(1, Math.floor(d / 60_000))}분 전 확인`;
  if (d < 24 * 3_600_000) return `${Math.floor(d / 3_600_000)}시간 전 확인`;
  return `${relTime(a.last_seen)} 확인`;
}

/** 아바타 색: 이름에서 뽑은 안정적인 색조(라이트/다크 토큰 8종). */
export function avatarTone(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 1_000_003;
  return h % 8;
}

export function senderName(m: Message): string {
  if (m.sender.type === "owner") return "나";
  if (m.sender.type === "system") return "시스템";
  return m.sender.name || "?";
}

/** 전달 상태는 예외만 말한다: 아직 받지 않은(sent) 30초 경과만 화면에 남긴다. */
export function deliveryNotice(m: Message, now = Date.now()): { label: string; title: string } | null {
  if (!m.recipient || !m.delivery || m.deleted) return null;
  if (m.delivery.state !== "sent") return null;
  const who = m.recipient.id === "owner" ? "나" : `${m.recipient.name} 비서`;
  // 받는 비서의 연결이 끊겼으면 이 메시지는 영영 전달되지 않는다. "아직 전달 전"은 기다리면
  // 되는 것처럼 읽히므로, 끝난 상태(전달 안 됨 · 연결 끊김)로 바로 알린다.
  if (m.delivery.recipient_status === "revoked") {
    return { label: "전달 안 됨 · 연결 끊김", title: `${who}의 연결이 끊겨 전달할 수 없습니다` };
  }
  const at = new Date(m.created_at).getTime();
  if (!Number.isFinite(at) || now - at < 30_000) return null;
  return { label: "아직 전달 전", title: `${who}에게 아직 전달되지 않았습니다` };
}

/** 전달 상태 한 단어(테스트·툴팁용). fetched 는 '전달됨'이다. */
export const DELIVERY_LABEL: Record<string, string> = {
  sent: "보냄",
  fetched: "전달됨",
  acked: "확인함",
  replied: "답장함",
};

export function groupedWith(prev: Message | undefined, m: Message): boolean {
  if (!prev) return false;
  // 삭제된 메시지(tombstone)는 그 자체로 한 줄을 차지한다. 아래 메시지가 여기에 묶이면
  // 발신자·시각이 사라져 삭제된 메시지의 일부처럼 보인다.
  if (prev.deleted || m.deleted) return false;
  if (prev.sender.type !== m.sender.type || prev.sender.id !== m.sender.id) return false;
  // 받는 사람이나 메시지 종류가 바뀌면 헤더(수신자 칩·종류)를 다시 보여야 한다.
  if ((prev.recipient?.id ?? "") !== (m.recipient?.id ?? "")) return false;
  if (prev.kind !== m.kind) return false;
  if (dayKey(prev.created_at) !== dayKey(m.created_at)) return false;
  return new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < 5 * 60_000;
}

// 식별자·수식 안쪽 기호는 강조가 아니므로 지우지 않는다(markdown의 강조 경계와 같은 규칙).
// 예: acr_agt_abcd, room_50795a11, 2*3*4 는 그대로 두고 _기울임_ / *기울임* 만 표시자를 걷어낸다.
function stripEmphasis(text: string, mark: "*" | "_"): string {
  const m = mark === "*" ? "\\*" : "_";
  const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${m}([^${mark === "*" ? "\\*" : "_"}\\n]+?)${m}(?=$|[^\\p{L}\\p{N}_])`, "gu");
  return text.replace(re, "$1$2");
}

/** 인용 미리보기: 마크다운 표시자를 걷어내고 한 줄로. */
export function plainPreview(text: string | null, max = 80): string {
  const urls: string[] = [];
  const flat = String(text ?? "")
    .replace(/```[\s\S]*?```/g, " [코드] ")
    // 머리표(#)·목록 기호는 백틱을 걷기 전에 줄 첫머리에서만 지운다(인라인 코드 `- 3` 은 그대로 둔다).
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/`([^`]*)`/g, "$1")
    // 주소 안의 `_`는 강조가 아니라 주소의 일부다(미리보기에서도 그대로 둔다).
    .replace(/https?:\/\/[^\s<>"']+/g, (u) => {
      urls.push(u);
      return `\u0000${urls.length - 1}\u0000`;
    })
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/~~([^~]*)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const emphasized = stripEmphasis(stripEmphasis(flat, "*"), "_").replace(/\u0000(\d+)\u0000/g, (_, i: string) => urls[Number(i)] ?? "");
  return emphasized.length > max ? emphasized.slice(0, max).trimEnd() + "…" : emphasized;
}

export function inviteMessage(roomName: string, link: string): string {
  return (
    `내가 만든 에이전트 방 '${roomName}'에 너의 비서를 초대하고 싶어.\n` +
    `아래 링크를 비서에게 그대로 전달해 주면 참여 요청을 보낼 수 있어(내가 승인하면 대화에 참여해).\n` +
    link
  );
}

export function clientId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `own-${Date.now()}-${rand}`;
}

export function durationLabel(seconds: number): string {
  if (seconds >= 3600) return `${Math.round(seconds / 3600)}시간`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}분`;
  return `${seconds}초`;
}
