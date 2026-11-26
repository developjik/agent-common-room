// 통합 인박스: 방을 가로질러 '내가 결정해야 하는 것'(질문·내 앞 지목·시스템 안내)을 한 줄기로 모은다.
import { useMemo, useState } from "react";
import { Avatar } from "./Avatar.js";
import { Icon } from "./icons.js";
import { EmptyState, SectionHead } from "./ui.js";
import { fmtFull, plainPreview, relTime } from "../lib/format.js";
import { ACTIVITY_KINDS, ACTIVITY_LABEL, activityKind, filterActivity, unreadActivityCount, type ActivityKind } from "../lib/views.js";
import type { ActivityItem, RoomCard } from "../lib/types.js";

interface Props {
  items: ActivityItem[];
  rooms: RoomCard[];
  ready: boolean;
  /** 승인 대기 참여 요청 수(인박스 목록에는 넣지 않고 비서실로 보낸다). */
  pendingCount: number;
  onOpenRoom: (roomId: string, seq?: number) => void;
  onGoRooms: () => void;
  onGoDesk: () => void;
}

export function InboxView({ items, rooms, ready, pendingCount, onOpenRoom, onGoRooms, onGoDesk }: Props) {
  const [kind, setKind] = useState<ActivityKind>("all");
  const [roomId, setRoomId] = useState("");

  const filtered = useMemo(() => filterActivity(items, { roomId, kind }), [items, roomId, kind]);
  // 배지(인박스 숫자)와 같은 기준: 목록 중 아직 읽지 않은 항목.
  const unread = useMemo(() => unreadActivityCount(items), [items]);
  const counts = useMemo(() => {
    const byKind: Record<string, number> = { all: items.length, question: 0, directed: 0, system: 0 };
    for (const it of items) byKind[activityKind(it)] = (byKind[activityKind(it)] ?? 0) + 1;
    return byKind;
  }, [items]);

  return (
    <div className="page page-narrow">
      <SectionHead
        title="통합 인박스"
        hint={
          items.length
            ? `방 ${new Set(items.map((i) => i.room_id)).size}곳에서 ${items.length}건 · 확인 필요 ${unread}건`
            : "내가 답할 질문과 내 앞 지목이 여기에 모입니다"
        }
        action={
          <button type="button" className="btn btn-sm" onClick={onGoRooms}>
            방 목록
          </button>
        }
      />

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
        <button type="button" className="inbox-item mb-2" data-approvals onClick={onGoDesk}>
          <span className="inbox-kind" data-kind="system">
            <Icon name="bot" size={15} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="inbox-head">
              <span className="inbox-room">비서실</span>
              <span className="inbox-dot" aria-hidden="true">
                ·
              </span>
              <span className="inbox-sender">승인 대기</span>
              <span className="tag tag-wait">{pendingCount}건</span>
            </span>
            <span className="inbox-text">새 비서의 참여 요청이 기다리고 있습니다. 비서실에서 승인·거절하세요.</span>
          </span>
          <span className="inbox-time">열기 →</span>
        </button>
      ) : null}

      {!ready ? (
        <div className="inbox-list" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="inbox-item skeleton h-[76px]" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="inbox"
          title={items.length ? "이 필터에 해당하는 항목이 없습니다" : "지금 확인할 것이 없습니다"}
          text={
            items.length
              ? "다른 종류나 다른 방을 골라 보세요."
              : "비서가 질문을 남기거나 나를 지목하면 이 목록에 나타납니다. 방에서 먼저 말을 걸어도 됩니다."
          }
          action={
            <button type="button" className="btn" onClick={onGoRooms}>
              방 열기
            </button>
          }
        />
      ) : (
        <ul className="inbox-list" aria-label="확인이 필요한 항목">
          {filtered.map((it) => {
            const k = activityKind(it);
            const m = it.message;
            return (
              <li key={`${it.room_id}:${m.seq}`}>
                <button type="button" className="inbox-item" data-unread={it.unread ? "true" : undefined} onClick={() => onOpenRoom(it.room_id, m.seq)}>
                  <span className={"inbox-kind"} data-kind={k}>
                    <Icon name={k === "system" ? "alert" : k === "directed" ? "at" : "bolt"} size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="inbox-head">
                      <span className="inbox-room">{it.room_name}</span>
                      <span className="inbox-dot" aria-hidden="true">
                        ·
                      </span>
                      {m.sender.type !== "system" ? <Avatar name={m.sender.type === "owner" ? "오너" : m.sender.name} small /> : null}
                      <span className="inbox-sender">{m.sender.type === "owner" ? "오너 (나)" : m.sender.type === "system" ? "시스템" : m.sender.name}</span>
                      <span className="tag">{ACTIVITY_LABEL[k]}</span>
                      {m.kind === "question" && k !== "question" ? <span className="tag">질문</span> : null}
                      {it.unread ? <span className="tag tag-wait">확인 필요</span> : null}
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
