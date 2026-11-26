// 통합 인박스: 방을 가로질러 '내가 답할 것'(질문·나에게 온 글·시스템 안내)을 한 줄기로 모은다.
// 제목은 상단바가 말한다. 여기서는 필터와 목록만 둔다.
import { useMemo, useState } from "react";
import { Avatar } from "./Avatar.js";
import { Icon } from "./icons.js";
import { EmptyState } from "./ui.js";
import { fmtFull, plainPreview, relTime } from "../lib/format.js";
import { ACTIVITY_KINDS, ACTIVITY_LABEL, activityKind, filterActivity, type ActivityKind } from "../lib/views.js";
import type { ActivityItem, RoomCard } from "../lib/types.js";

interface Props {
  items: ActivityItem[];
  rooms: RoomCard[];
  ready: boolean;
  /** 안 읽은 답할 것이 있는 방 수(상단바·레일 배지와 같은 값). */
  needCount: number;
  /** 승인 대기 참여 요청 수(인박스 목록에는 넣지 않고 비서실로 보낸다). */
  pendingCount: number;
  onOpenRoom: (roomId: string, seq?: number) => void;
  onGoRooms: () => void;
  onGoDesk: () => void;
}

export function InboxView({ items, rooms, ready, needCount, pendingCount, onOpenRoom, onGoRooms, onGoDesk }: Props) {
  const [kind, setKind] = useState<ActivityKind>("all");
  const [roomId, setRoomId] = useState("");

  const filtered = useMemo(() => filterActivity(items, { roomId, kind }), [items, roomId, kind]);
  const counts = useMemo(() => {
    const byKind: Record<string, number> = { all: items.length, question: 0, directed: 0, system: 0 };
    for (const it of items) byKind[activityKind(it)] = (byKind[activityKind(it)] ?? 0) + 1;
    return byKind;
  }, [items]);

  return (
    <div className="page page-narrow">
      <div className="page-tools">
        <p className="page-summary">
          {needCount ? `답변 필요 ${needCount}곳` : "답변 필요 없음"}
          {items.length ? ` · ${items.length}건` : ""}
        </p>
        <button type="button" className="btn btn-sm" onClick={onGoRooms}>
          방 목록
        </button>
      </div>

      <div className="filter-row">
        <div className="filter-chips" role="group" aria-label="종류 필터">
          {ACTIVITY_KINDS.map((k) => (
            <button
              key={k.key}
              type="button"
              className="filter-chip"
              aria-pressed={kind === k.key}
              onClick={() => setKind(k.key)}
            >
              {k.label}
              {counts[k.key] ? <span className="filter-count">{counts[k.key]}</span> : null}
            </button>
          ))}
        </div>
        <label className="filter-select">
          <span className="sr-only">방 필터</span>
          <select className="field" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
            <option value="">모든 방</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {pendingCount ? (
        <button type="button" className="inbox-item inbox-approval" data-approvals onClick={onGoDesk}>
          <span className="inbox-kind" data-kind="system">
            <Icon name="bot" size={15} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="inbox-head">
              <span className="inbox-room">승인 대기 {pendingCount}건</span>
              <span className="inbox-sender">새 비서가 참여를 기다립니다</span>
            </span>
          </span>
          <span className="inbox-time">열기 →</span>
        </button>
      ) : null}

      {!ready ? (
        <div className="inbox-list" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="inbox-item skeleton h-[64px]" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="inbox"
          title={items.length ? "해당 없음" : "답할 것이 없습니다"}
          action={
            <button type="button" className="btn" onClick={onGoRooms}>
              방 열기
            </button>
          }
        />
      ) : (
        <ul className="inbox-list" aria-label="답할 것">
          {filtered.map((it) => {
            const k = activityKind(it);
            const m = it.message;
            return (
              <li key={`${it.room_id}:${m.seq}`}>
                <button
                  type="button"
                  className="inbox-item"
                  data-unread={it.unread ? "true" : undefined}
                  onClick={() => onOpenRoom(it.room_id, m.seq)}
                >
                  {it.unread ? <span className="sr-only">안 읽음</span> : null}
                  <span className="inbox-kind" data-kind={k}>
                    <Icon name={k === "system" ? "alert" : k === "directed" ? "at" : "bolt"} size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="inbox-head">
                      <span className="inbox-room">{it.room_name}</span>
                      {m.sender.type !== "system" ? <Avatar name={m.sender.type === "owner" ? "나" : m.sender.name} small /> : null}
                      <span className="inbox-sender">{m.sender.type === "owner" ? "나" : m.sender.type === "system" ? "시스템" : m.sender.name}</span>
                      <span className="inbox-kind-label">{ACTIVITY_LABEL[k]}</span>
                    </span>
                    <span className="inbox-text">{m.deleted ? "삭제된 메시지입니다" : plainPreview(m.content, 180)}</span>
                  </span>
                  <span className="inbox-time" title={fmtFull(m.created_at)}>
                    {relTime(m.created_at)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
