// 관제실(홈): 상태 한 줄 → 방 목록 하나 → 비서 요약. "정상은 침묵" — 값이 있을 때만 말하고,
// 같은 사실을 점·라벨·숫자로 되풀이하지 않는다.
import { Avatar } from "./Avatar.js";
import { Icon } from "./icons.js";
import { EmptyState } from "./ui.js";
import { plainPreview, relTime, senderLabel } from "../lib/format.js";
import { agentRoomNames, presenceTone, roomNeedsAnswer, roomSummaryLine, sortRoomCards, unreadRoomCount } from "../lib/views.js";
import type { Overview, Workspace } from "../lib/types.js";
import type { View } from "../lib/route.js";

interface Props {
  workspace: Workspace;
  overview: Overview | null;
  ready: boolean;
  onOpenRoom: (roomId: string, seq?: number) => void;
  onGoView: (view: View) => void;
  onCreateRoom: () => void;
  onInvite: () => void;
  onRetry: () => void;
}

export function MissionControl({ overview, ready, onOpenRoom, onGoView, onCreateRoom, onInvite, onRetry }: Props) {
  if (ready && !overview) {
    return (
      <div className="page">
        <EmptyState
          icon="alert"
          title="워크스페이스를 불러오지 못했습니다"
          text="연결이 잠시 끊겼을 수 있습니다. 잠시 뒤 다시 시도하세요."
          action={
            <button type="button" className="btn btn-primary" onClick={onRetry}>
              다시 시도
            </button>
          }
        />
      </div>
    );
  }
  if (!ready || !overview) {
    return (
      <div className="page" aria-busy="true">
        <div className="skeleton h-4 w-52" />
        <ul className="room-list mt-4">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="room-row skeleton h-[56px]" />
          ))}
        </ul>
      </div>
    );
  }

  const rooms = sortRoomCards(overview.rooms);
  const live = overview.agents.filter((a) => a.status === "active");
  const waiting = overview.agents.filter((a) => a.status === "unclaimed");
  const need = overview.counts.needs_you_rooms ?? rooms.filter(roomNeedsAnswer).length;
  const summary = roomSummaryLine({
    need,
    unread: unreadRoomCount(overview.rooms),
    paused: overview.rooms.filter((r) => r.paused || r.health === "paused").length,
  });

  return (
    <div className="page">
      <div className="page-tools">
        <p className="page-summary" aria-live="polite">
          {summary}
        </p>
        {need ? (
          <button type="button" className="btn btn-sm" onClick={() => onGoView("inbox")}>
            인박스 열기 <Icon name="chevron-right" size={13} />
          </button>
        ) : null}
      </div>

      <div className="mc-body">
        <div className="mc-main">
          {rooms.length === 0 ? (
            <EmptyState
              icon="rooms"
              title="아직 방이 없습니다"
              text="방을 만들면 여기에 표시됩니다."
              action={
                <button type="button" className="btn btn-primary" onClick={onCreateRoom}>
                  <Icon name="plus" size={14} /> 첫 방 만들기
                </button>
              }
            />
          ) : (
            <>
              <ul className="room-list" aria-label="방 목록">
                {rooms.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className={"room-row" + (roomNeedsAnswer(r) ? " is-need" : "")}
                      onClick={() => onOpenRoom(r.id)}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="room-row-head">
                          <span className="room-row-name">{r.name}</span>
                                                    {r.paused || roomNeedsAnswer(r) ? (
                            <span className="room-state" data-tone={r.paused ? "paused" : "wait"}>
                              {r.paused ? "정지" : "답변 필요"}
                            </span>
                          ) : null}
                        </span>
                        <span className="room-row-preview">
                          {r.last_preview ? (
                            <>
                              {r.last_sender ? <strong>{senderLabel(r.last_sender.name)}</strong> : null}
                              {r.last_sender ? " · " : ""}
                              {plainPreview(r.last_preview, 120)}
                            </>
                          ) : (
                            <span className="text-faint">아직 글 없음</span>
                          )}
                        </span>
                      </span>
                      <span className="room-row-side">
                        {r.unread ? <span className="tile-unread">{r.unread > 99 ? "99+" : r.unread}</span> : null}
                        <span className="room-row-meta">
                          {/* 0은 침묵: 비서가 없는 방은 '비서 0' 대신 시간만 말한다. */}
                          {[r.member_count ? `비서 ${r.member_count}` : "", r.last_message_at ? relTime(r.last_message_at) : ""]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="row-add" onClick={onCreateRoom}>
                <Icon name="plus" size={14} /> 새 방
              </button>
            </>
          )}
        </div>

        <aside className="mc-aside" aria-label="비서 요약">
          <section className="aside-card">
            <div className="aside-head">
              <h2 className="section-title">비서</h2>
              <span className="aside-count">
                {live.length}명
                {waiting.length ? ` · 연결 대기 ${waiting.length}` : ""}
              </span>
              <button type="button" className="btn btn-sm" onClick={() => onGoView("desk")}>
                관리
              </button>
            </div>
            {overview.agents.length === 0 ? (
              <button type="button" className="btn btn-sm btn-primary w-full" onClick={onInvite}>
                <Icon name="link" size={13} /> 초대 링크 만들기
              </button>
            ) : (
              <ul className="aside-agents">
                {overview.agents.slice(0, 6).map((a) => {
                  const names = agentRoomNames(a, rooms);
                  return (
                    <li key={a.id} className="aside-agent">
                      <span className="dot" data-tone={presenceTone(a.status, a.last_seen)} aria-hidden="true" />
                      <Avatar name={a.name} small />
                      <span className="min-w-0 flex-1">
                        <span className="aside-agent-name">{a.name}</span>
                        <span className="aside-agent-meta">
                          {names.length ? names.slice(0, 2).join(", ") + (names.length > 2 ? ` +${names.length - 2}` : "") : "방 없음"}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {overview.pending_requests ? (
              <button type="button" className="aside-alert" onClick={() => onGoView("desk")}>
                <Icon name="inbox" size={14} /> 승인 대기 {overview.pending_requests}건
              </button>
            ) : null}
          </section>
        </aside>
      </div>
    </div>
  );
}
