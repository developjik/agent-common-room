// 방 목록: 관제실 타일의 자세한 표. 방 전환(모바일 '방' 탭)과 정지·안 읽음 확인에 쓴다.
import { useMemo, useState } from "react";
import { Icon } from "./icons.js";
import { EmptyState, SectionHead, StatusLed } from "./ui.js";
import { plainPreview, relTime } from "../lib/format.js";
import { healthLabel, sortRoomCards } from "../lib/views.js";
import type { RoomCard } from "../lib/types.js";

interface Props {
  rooms: RoomCard[];
  agents: number;
  ready: boolean;
  onOpenRoom: (roomId: string) => void;
  onCreateRoom: () => void;
  onGoHome: () => void;
}

type Filter = "all" | "unread" | "paused" | "needs";

export function RoomsView({ rooms, agents, ready, onOpenRoom, onCreateRoom, onGoHome }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const sorted = useMemo(() => sortRoomCards(rooms), [rooms]);
  const shown = sorted.filter((r) =>
    filter === "unread" ? r.unread > 0 : filter === "paused" ? r.paused : filter === "needs" ? r.health === "needs_input" : true,
  );

  return (
    <div className="page page-narrow">
      <SectionHead
        title="방"
        hint={`${rooms.length}개 · 비서 ${agents}명이 활동 중`}
        action={
          <div className="flex gap-2">
            <button type="button" className="btn btn-sm" onClick={onGoHome}>
              관제실
            </button>
            <button type="button" className="btn btn-sm btn-primary" onClick={onCreateRoom}>
              <Icon name="plus" size={14} /> 새 방
            </button>
          </div>
        }
      />

      <div className="filter-chips" role="group" aria-label="방 필터">
        {(
          [
            ["all", `전체 ${rooms.length}`],
            ["needs", `확인 필요 ${rooms.filter((r) => r.health === "needs_input").length}`],
            ["unread", `안 읽음 ${rooms.filter((r) => r.unread > 0).length}`],
            ["paused", `정지 ${rooms.filter((r) => r.paused).length}`],
          ] as [Filter, string][]
        ).map(([key, label]) => (
          <button key={key} type="button" className="filter-chip" aria-pressed={filter === key} onClick={() => setFilter(key)}>
            {label}
          </button>
        ))}
      </div>

      {!ready ? (
        <ul className="room-list" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <li key={i} className="room-row skeleton h-[72px]" />
          ))}
        </ul>
      ) : shown.length === 0 ? (
        <EmptyState
          icon="rooms"
          title={rooms.length ? "이 필터에 맞는 방이 없습니다" : "아직 방이 없습니다"}
          text={rooms.length ? "다른 필터를 골라 보세요." : "방을 만들고 비서를 배치하면 여기서 방을 전환할 수 있습니다."}
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
              <button type="button" className="room-row" onClick={() => onOpenRoom(r.id)}>
                <span className="led-dot" data-tone={healthLabel(r.health).tone} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="room-row-head">
                    <span className="room-row-name">{r.name}</span>
                    <span className="tag">{r.kind === "lobby" ? "로비" : "방"}</span>
                    {r.paused ? <span className="tag tag-danger">정지</span> : null}
                  </span>
                  <span className="room-row-preview">
                    {r.last_preview ? (
                      <>
                        {r.last_sender ? <strong>{r.last_sender.name}</strong> : null}
                        {r.last_sender ? " · " : ""}
                        {plainPreview(r.last_preview, 140)}
                      </>
                    ) : (
                      <span className="text-faint">아직 글이 없습니다</span>
                    )}
                  </span>
                </span>
                <span className="room-row-side">
                  <StatusLed health={r.health} />
                  <span className="room-row-meta">
                    비서 {r.member_count} · {r.last_message_at ? relTime(r.last_message_at) : "새 방"}
                  </span>
                </span>
                {r.unread ? <span className="tile-unread">{r.unread > 99 ? "99+" : r.unread}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
