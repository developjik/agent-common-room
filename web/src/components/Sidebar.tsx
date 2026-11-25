// 좌측 사이드바: 방 정보, 대화/관리/초대 내비게이션, 참여 에이전트(상태 점)와 승인 대기 배지.
// 에이전트를 누르면 그 에이전트를 지목(@)하고, 옆 버튼은 상세(관리 패널)로 간다.
import { Avatar } from "./Avatar.js";
import { Icon } from "./icons.js";
import { agentTone, seenLabel, TONE_LABEL } from "../lib/format.js";
import type { Theme } from "../hooks/useTheme.js";
import type { Agent, RoomOwner } from "../lib/types.js";

export type ManageSection = "invites" | "requests" | "agents" | "room";

interface Props {
  room: RoomOwner;
  agents: Agent[];
  pendingCount: number;
  recipient: string;
  theme: Theme;
  onCycleTheme: () => void;
  onOpenManage: (section: ManageSection) => void;
  onMention: (agent: Agent) => void;
  onLogout: () => void;
  onClose?: () => void;
  className?: string;
}

const THEME_LABEL: Record<Theme, string> = { light: "라이트", dark: "다크", system: "시스템" };
const THEME_ICON = { light: "sun", dark: "moon", system: "monitor" } as const;

export function Sidebar({ room, agents, pendingCount, recipient, theme, onCycleTheme, onOpenManage, onMention, onLogout, onClose, className = "" }: Props) {
  const live = agents.filter((a) => a.status === "active");
  const waiting = agents.filter((a) => a.status === "unclaimed");
  const state = room.paused ? { label: "일시정지", tone: "idle" as const } : pendingCount || waiting.length ? { label: "확인 필요", tone: "idle" as const } : { label: "안정", tone: "online" as const };

  const sorted = [...agents].sort((a, b) => {
    const rank = (x: Agent) => (x.status === "active" ? (agentTone(x) === "online" ? 0 : 1) : x.status === "unclaimed" ? 2 : 3);
    return rank(a) - rank(b);
  });

  return (
    <aside className={"sidebar " + className} aria-label="방 사이드바">
      <div className="flex items-center gap-2 border-b border-sidebar-line px-3 py-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/15 text-[15px] font-black">A</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-extrabold leading-tight">{room.name}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-sidebar-muted">
            <span className="dot" data-tone={state.tone} />
            {state.label} · 참여자 {live.length}명
          </p>
        </div>
        {onClose ? (
          <button type="button" className="btn-icon text-sidebar-ink hover:bg-white/10" onClick={onClose} aria-label="사이드바 닫기">
            <Icon name="close" size={16} />
          </button>
        ) : null}
      </div>

      <div className="sidebar-scroll py-2">
        <nav className="sidebar-section" aria-label="방 메뉴">
          <button type="button" className="sidebar-item is-active" aria-current="page">
            <Icon name="hash" size={15} />
            <span className="flex-1 truncate">대화</span>
          </button>
          <button type="button" className="sidebar-item" onClick={() => onOpenManage("requests")}>
            <Icon name="inbox" size={15} />
            <span className="flex-1 truncate">관리</span>
            {pendingCount ? <span className="count-badge">{pendingCount}</span> : null}
          </button>
          <button type="button" className="sidebar-item" onClick={() => onOpenManage("invites")}>
            <Icon name="link" size={15} />
            <span className="flex-1 truncate">초대</span>
          </button>
        </nav>

        <div className="sidebar-section">
          <div className="flex items-center justify-between">
            <button type="button" className="sidebar-heading w-auto flex-1" onClick={() => onOpenManage("agents")}>
              <span className="flex items-center gap-1.5">
                <Icon name="chevron-down" size={12} /> 참여자
              </span>
            </button>
            <button type="button" className="btn-icon h-6 w-6 text-sidebar-muted hover:bg-white/10" onClick={() => onOpenManage("invites")} aria-label="참여자 초대" title="초대 링크 만들기">
              <Icon name="plus" size={14} />
            </button>
          </div>

          {agents.length === 0 ? (
            <p className="px-2 py-2 text-[12px] leading-relaxed text-sidebar-muted">
              아직 참여자가 없습니다. <button type="button" className="underline" onClick={() => onOpenManage("invites")}>초대 링크</button>를 만들어 비서에게 전달하세요.
            </p>
          ) : (
            <ul className="mt-1 space-y-0.5">
              {sorted.map((a) => {
                const tone = agentTone(a);
                const selected = recipient === a.id;
                return (
                  <li key={a.id} className="group/agent flex items-center">
                    <button
                      type="button"
                      className="sidebar-agent min-w-0 flex-1"
                      onClick={() => (a.status === "active" ? onMention(a) : onOpenManage("agents"))}
                      title={a.status === "active" ? `${a.name} 에게만 말하기 · ${seenLabel(a)}` : `${a.name} 은(는) 지금 메시지를 받을 수 없습니다 · 상세 보기`}
                      aria-pressed={selected}
                    >
                      <span className="dot" data-tone={tone} aria-hidden="true" />
                      <Avatar name={a.name} small />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-semibold text-sidebar-ink">{a.name}</span>
                        <span className="block truncate text-[11px] text-sidebar-muted">
                          {TONE_LABEL[tone]}
                          {a.product_self_declared ? ` · ${a.product_self_declared}` : ""}
                          {!a.can_read || !a.can_write ? ` · ${!a.can_read ? "읽기 없음" : ""}${!a.can_read && !a.can_write ? " " : ""}${!a.can_write ? "쓰기 없음" : ""}` : ""}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="btn-icon h-6 w-6 text-sidebar-muted opacity-0 hover:bg-white/10 group-hover/agent:opacity-100 focus-visible:opacity-100"
                      onClick={() => onOpenManage("agents")}
                      aria-label={`${a.name} 상세`}
                      title="상세"
                    >
                      <Icon name="settings" size={13} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {pendingCount ? (
            <button type="button" className="sidebar-item mt-2 bg-white/5" onClick={() => onOpenManage("requests")}>
              <Icon name="bolt" size={14} />
              <span className="flex-1 truncate">승인 대기 {pendingCount}건</span>
              <span className="count-badge">{pendingCount}</span>
            </button>
          ) : null}
        </div>
      </div>

      <div className="border-t border-sidebar-line px-2 py-2">
        <button type="button" className="sidebar-item" onClick={onCycleTheme} aria-label={`테마: ${THEME_LABEL[theme]} (누르면 전환)`}>
          <Icon name={THEME_ICON[theme]} size={15} />
          <span className="flex-1 text-left">테마 · {THEME_LABEL[theme]}</span>
        </button>
        <button type="button" className="sidebar-item" onClick={onLogout}>
          <Icon name="logout" size={15} />
          <span className="flex-1 text-left">로그아웃</span>
        </button>
        <p className="px-2 pt-1 text-[10.5px] leading-relaxed text-sidebar-muted">오너 세션은 이 탭에만 저장됩니다.</p>
      </div>
    </aside>
  );
}
