// 방 목록: 방 전환(모바일 '방' 탭)과 답변 필요·안 읽음 확인. 제목은 상단바가 말한다.
import { useMemo, useState } from "react";
import { Icon } from "./icons.js";
import { EmptyState } from "./ui.js";
import { plainPreview, relTime, senderLabel } from "../lib/format.js";
import { countLabel, roomNeedsAnswer, sortRoomCards } from "../lib/views.js";
import type { RoomCard } from "../lib/types.js";

interface Props {
  rooms: RoomCard[];
  agents: number;
  /** 답변 필요 방 수(상단바 배지와 같은 값). */
  needCount: number;
  ready: boolean;
  onOpenRoom: (roomId: string) => void;
  onCreateRoom: () => void;
  onGoHome: () => void;
}

type Filter = "all" | "unread" | "paused" | "needs";

export function RoomsView({ rooms, agents, needCount, ready, onOpenRoom, onCreateRoom, onGoHome }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const sorted = useMemo(() => sortRoomCards(rooms), [rooms]);
  const shown = sorted.filter((r) =>
    filter === "unread" ? r.unread > 0 : filter === "paused" ? r.paused : filter === "needs" ? roomNeedsAnswer(r) : true,
  );

  return (
    <div className="page page-narrow">
      <div className="page-tools">
        <p className="page-summary">
          방 {rooms.length} · 비서 {agents}명
        </p>
        <div className="flex gap-2">
          <button type="button" className="btn btn-sm" onClick={onGoHome}>
            관제실
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={onCreateRoom}>
            <Icon name="plus" size={14} /> 새 방
          </button>
        </div>
      </div>

      <div className="filter-chips" role="group" aria-label="방 필터">
        {(
          [
            ["all", "전체", rooms.length],
            ["needs", "답변 필요", needCount],
            ["unread", "안 읽음", rooms.filter((r) => r.unread > 0).length],
            ["paused", "정지", rooms.filter((r) => r.paused).length],
          ] as [Filter, string, number][]
        ).map(([key, label, count]) => (
          <button key={key} type="button" className="filter-chip" aria-pressed={filter === key} onClick={() => setFilter(key)}>
            {countLabel(label, count)}
          </button>
        ))}
      </div>

      {!ready ? (
        <ul className="room-list" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <li key={i} className="room-row skeleton h-[56px]" />
          ))}
        </ul>
      ) : shown.length === 0 ? (
        <EmptyState
          icon="rooms"
          title={rooms.length ? "해당 없음" : "아직 방이 없습니다"}
          action={
            <button type="button" className="btn btn-primary" onClick={onCreateRoom}>
              <Icon name="plus" size={14} /> 방 만들기
            </button>
          }
        />
      ) : (
        <ul className="room-list" aria-label="방 목록">
          {shown.map((r) => (
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
                        {plainPreview(r.last_preview, 140)}
                      </>
                    ) : (
                      <span className="text-faint">아직 글 없음</span>
                    )}
                  </span>
                </span>
                <span className="room-row-side">
                  {r.unread ? <span className="tile-unread">{r.unread > 99 ? "99+" : r.unread}</span> : null}
                  <span className="room-row-meta">
                    {r.member_count ? `비서 ${r.member_count} · ` : ""}
                    {r.last_message_at ? relTime(r.last_message_at) : "새 방"}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
