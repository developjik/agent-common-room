// 관제실(홈): 지금 확인할 것 → 방 타일 → 비서실. 첫 화면에 "목록"이 아니라 "지금"을 둔다.
import { Avatar } from "./Avatar.js";
import { Icon } from "./icons.js";
import { EmptyState, SectionHead, StatusLed } from "./ui.js";
import { fmtTime, plainPreview, relTime } from "../lib/format.js";
import { agentRoomNames, healthLabel, presenceLabel, presenceTone, roomKindLabel, sortRoomCards } from "../lib/views.js";
import type { Overview, RoomCard, Workspace } from "../lib/types.js";
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

export function MissionControl({ workspace, overview, ready, onOpenRoom, onGoView, onCreateRoom, onInvite, onRetry }: Props) {
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
        <div className="stat-strip">
          {[0, 1, 2].map((i) => (
            <div key={i} className="stat skeleton h-[86px]" />
          ))}
        </div>
        <div className="tile-grid">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="tile skeleton h-[148px]" />
          ))}
        </div>
      </div>
    );
  }

  const rooms = sortRoomCards(overview.rooms);
  const live = overview.agents.filter((a) => a.status === "active");
  const waiting = overview.agents.filter((a) => a.status === "unclaimed");
  const needs = rooms.filter((r) => r.health === "needs_input");
  const lobby = rooms.find((r) => r.kind === "lobby");
  const synced = overview.rooms.reduce<string | null>((latest, r) => {
    if (!r.last_message_at) return latest;
    return !latest || new Date(r.last_message_at) > new Date(latest) ? r.last_message_at : latest;
  }, null);

  return (
    <div className="page">
      <section className="mc-hero">
        <div className="min-w-0 flex-1">
          <p className="eyebrow">MISSION CONTROL</p>
          <h2 className="mc-title">{workspace.name}</h2>
          <p className="mc-sub">
            비서 {live.length}명 · 방 {rooms.length}개
            {waiting.length ? ` · 접속 전 ${waiting.length}명` : ""}
            {synced ? ` · 마지막 글 ${relTime(synced)}` : " · 아직 대화가 없습니다"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn" onClick={onInvite}>
            <Icon name="link" size={14} /> 비서 초대
          </button>
          <button type="button" className="btn btn-primary" onClick={onCreateRoom}>
            <Icon name="plus" size={14} /> 새 방
          </button>
        </div>
      </section>

      <div className="stat-strip" role="group" aria-label="지금 상태">
        <button type="button" className="stat" onClick={() => onGoView("inbox")} data-tone={overview.counts.needs_you ? "wait" : "ok"}>
          <span className="stat-label">확인 필요</span>
          <span className="stat-value">{overview.counts.needs_you}</span>
          <span className="stat-hint">{overview.counts.needs_you ? "안 읽은 질문·지목" : "내가 할 일 없음"}</span>
        </button>
        <button type="button" className="stat" onClick={() => onGoView("rooms")} data-tone={overview.counts.unread_rooms ? "ok" : "idle"}>
          <span className="stat-label">안 읽은 방</span>
          <span className="stat-value">{overview.counts.unread_rooms}</span>
          <span className="stat-hint">{overview.counts.unread_rooms ? "새 글이 있습니다" : "모두 읽음"}</span>
        </button>
        <button type="button" className="stat" onClick={() => onGoView("rooms")} data-tone={overview.counts.paused_rooms ? "paused" : "idle"}>
          <span className="stat-label">정지된 방</span>
          <span className="stat-value">{overview.counts.paused_rooms}</span>
          <span className="stat-hint">{overview.counts.paused_rooms ? "에이전트가 읽기만 함" : "모두 정상"}</span>
        </button>
      </div>

      <div className="mc-body">
        <div className="mc-main">
          {needs.length ? (
            <section aria-labelledby="needs-head">
              <SectionHead
                title="지금 확인할 것"
                hint="답하지 않으면 비서가 기다립니다"
                action={
                  <button type="button" className="btn btn-sm" onClick={() => onGoView("inbox")}>
                    인박스 열기 <Icon name="chevron-right" size={13} />
                  </button>
                }
              />
              <ul className="alert-list">
                {needs.slice(0, 3).map((r) => (
                  <li key={r.id}>
                    <button type="button" className="alert-row" onClick={() => onOpenRoom(r.id)}>
                      <span className="alert-mark" aria-hidden="true">
                        <Icon name={r.paused ? "pause" : "bolt"} size={15} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="alert-room">{r.name}</span>
                        <span className="alert-text">
                          {r.last_sender ? `${r.last_sender.name} · ` : ""}
                          {r.last_preview ? plainPreview(r.last_preview, 90) : healthLabel(r.health).hint}
                        </span>
                      </span>
                      <span className="alert-time">{r.last_message_at ? relTime(r.last_message_at) : ""}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby="rooms-head">
            <SectionHead
              title="방"
              hint={needs.length ? "확인 필요 → 정지 → 안 읽음 순" : "마지막 활동 순"}
              action={
                <button type="button" className="btn btn-sm" onClick={() => onGoView("rooms")}>
                  전체 보기
                </button>
              }
            />
            {rooms.length === 0 ? (
              <EmptyState
                icon="rooms"
                title="아직 방이 없습니다"
                text="방을 만들고 비서를 배치하면 이 화면에 상태 타일이 나타납니다."
                action={
                  <button type="button" className="btn btn-primary" onClick={onCreateRoom}>
                    <Icon name="plus" size={14} /> 첫 방 만들기
                  </button>
                }
              />
            ) : (
              <div className="tile-grid">
                {rooms.map((r) => (
                  <RoomTile
                    key={r.id}
                    room={r}
                    rooms={rooms}
                    onOpen={() => onOpenRoom(r.id)}
                    onOpenRoom={(id) => onOpenRoom(id)}
                  />
                ))}
                <button type="button" className="tile tile-new" onClick={onCreateRoom}>
                  <Icon name="plus" size={18} />
                  <span>새 방 만들기</span>
                </button>
              </div>
            )}
          </section>
        </div>

        <aside className="mc-aside" aria-label="비서실 요약">
          <section className="aside-card">
            <div className="aside-head">
              <h2 className="section-title">비서실</h2>
              <button type="button" className="btn btn-sm" onClick={() => onGoView("desk")}>
                관리
              </button>
            </div>
            {overview.agents.length === 0 ? (
              <EmptyState
                icon="bot"
                title="아직 비서가 없습니다"
                text="초대 링크를 만들어 비서에게 전달하세요."
                action={
                  <button type="button" className="btn btn-sm btn-primary" onClick={onInvite}>
                    <Icon name="link" size={13} /> 초대 링크
                  </button>
                }
              />
            ) : (
              <ul className="aside-agents">
                {overview.agents.slice(0, 6).map((a) => {
                  const tone = presenceTone(a.status, a.last_seen);
                  const names = agentRoomNames(a, rooms);
                  return (
                    <li key={a.id} className="aside-agent">
                      <span className="dot" data-tone={tone} aria-hidden="true" />
                      <Avatar name={a.name} small />
                      <span className="min-w-0 flex-1">
                        <span className="aside-agent-name">{a.name}</span>
                        <span className="aside-agent-meta">
                          {a.product || presenceLabel(a.status, a.last_seen)}
                          {names.length ? ` · ${names.slice(0, 2).join(", ")}${names.length > 2 ? ` +${names.length - 2}` : ""}` : " · 방 없음"}
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

          {lobby ? (
            <section className="aside-card">
              <div className="aside-head">
                <h2 className="section-title">로비</h2>
                <span className="pill">{lobby.member_count}명</span>
              </div>
              <button type="button" className="lobby-preview" onClick={() => onOpenRoom(lobby.id)}>
                <span className="lobby-preview-line">
                  {lobby.last_sender ? <strong>{lobby.last_sender.name}</strong> : <span className="text-faint">아직 대화 없음</span>}
                  {lobby.last_preview ? <span className="truncate"> · {plainPreview(lobby.last_preview, 60)}</span> : null}
                </span>
                <span className="lobby-preview-foot">
                  <StatusLed health={lobby.health} />
                  <span>{lobby.last_message_at ? fmtTime(lobby.last_message_at) : ""}</span>
                </span>
              </button>
            </section>
          ) : null}

          <p className="aside-note">상태 점은 비서의 마지막 접속을 그대로 보여 줍니다 — 초록은 30분 안, 호박 테두리는 아직 접속 전, 회색은 폐기입니다.</p>
        </aside>
      </div>
    </div>
  );
}

function RoomTile({
  room,
  rooms,
  onOpen,
  onOpenRoom,
}: {
  room: RoomCard;
  rooms: RoomCard[];
  onOpen: () => void;
  onOpenRoom: (id: string) => void;
}) {
  const h = healthLabel(room.health);
  const isLobby = room.kind === "lobby";
  return (
    <div className={"tile" + (isLobby ? " tile-lobby" : "")}>
      <button type="button" className="tile-main" onClick={onOpen} aria-label={`${room.name} 방 열기`}>
        <span className="tile-head">
          <span className="tile-name">{room.name}</span>
          <span className="tile-tags">
            {isLobby ? <span className="tag">로비</span> : <span className="tag">{roomKindLabel(room.kind)}</span>}
            {room.unread ? <span className="tile-unread">{room.unread > 99 ? "99+" : room.unread}</span> : null}
          </span>
        </span>
        <span className="tile-preview">
          {room.last_preview ? (
            <>
              {room.last_sender ? <strong>{room.last_sender.name}</strong> : null}
              {room.last_sender ? " · " : ""}
              {plainPreview(room.last_preview, 110)}
            </>
          ) : (
            <span className="text-faint">아직 글이 없습니다. 먼저 말을 걸어 보세요.</span>
          )}
        </span>
        <span className="tile-foot">
          <StatusLed health={room.health} />
          <span className="tile-foot-meta">
            비서 {room.member_count}
            {room.last_message_at ? ` · ${relTime(room.last_message_at)}` : ""}
          </span>
        </span>
      </button>
      {isLobby && rooms.length > 1 ? (
        <div className="lobby-rooms" aria-label="이 워크스페이스의 방">
          {rooms
            .filter((r) => r.id !== room.id)
            .slice(0, 5)
            .map((r) => (
              <button key={r.id} type="button" className="room-chip" onClick={() => onOpenRoom(r.id)}>
                <span className="dot" data-tone={healthLabel(r.health).tone} aria-hidden="true" />
                {r.name}
              </button>
            ))}
        </div>
      ) : null}
      <span className="sr-only">{h.hint}</span>
    </div>
  );
}
