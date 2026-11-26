// 방 화면: 왼쪽(모바일은 목록)에 방 목록 + '+ 새 방', 오른쪽에 선택한 방 대화.
// 방 목록의 비서 수와 방 헤더의 비서 수는 같은 값(활성 구성원)을 쓴다.
import { useEffect, useRef, useState } from "react";
import { RoomView } from "./RoomView.js";
import { Icon } from "./icons.js";
import { useToast } from "./Toast.js";
import { sortRoomCards, roomNeedsAnswer } from "../lib/views.js";
import { relTime } from "../lib/format.js";
import type { WorkspaceStore } from "../hooks/useWorkspace.js";
import type { RoomCard, Workspace } from "../lib/types.js";

interface Props {
  store: WorkspaceStore;
  workspace: Workspace;
  roomId: string | null;
  isWide: boolean;
  onOpenRoom: (roomId: string) => void;
  onBack: () => void;
}

export function RoomsView({ store, workspace, roomId, isWide, onOpenRoom, onBack }: Props) {
  return (
    <div className="rooms-layout">
      <RoomList store={store} roomId={roomId} isWide={isWide} onOpenRoom={onOpenRoom} />
      {roomId ? (
        <RoomView roomId={roomId} store={store} workspace={workspace} isWide={isWide} onBack={onBack} />
      ) : (
        <div className="room-empty">{isWide ? <p className="text-[13px] text-muted">왼쪽에서 방을 고르거나 새 방을 만드세요.</p> : null}</div>
      )}
    </div>
  );
}

function RoomList({ store, roomId, isWide, onOpenRoom }: { store: WorkspaceStore; roomId: string | null; isWide: boolean; onOpenRoom: (id: string) => void }) {
  const notify = useToast();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rooms = sortRoomCards(store.overview?.rooms ?? []);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  const create = async () => {
    const wanted = name.trim();
    if (!wanted || busy) return;
    setBusy(true);
    try {
      const room = await store.createRoom(wanted);
      setName("");
      setCreating(false);
      notify(`'${room.name}' 방을 만들었습니다. 초대 링크로 비서를 부르세요.`);
      onOpenRoom(room.id);
    } catch (e) {
      notify(e instanceof Error ? e.message : "방을 만들지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  // 모바일에서 방을 열고 있으면 목록은 숨긴다(대화가 화면을 다 쓴다).
  if (!isWide && roomId) return null;

  return (
    <aside className="room-list-pane" aria-label="방 목록">
      <div className="room-list-head">
        <h2 className="section-title">방</h2>
        <button type="button" className="btn btn-sm" onClick={() => setCreating(true)} aria-label="새 방">
          <Icon name="plus" size={14} />
          <span>새 방</span>
        </button>
      </div>

      {creating ? (
        <form
          className="room-create"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input
            ref={inputRef}
            className="field"
            placeholder="방 이름 (예: 회의실)"
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setCreating(false);
                setName("");
              }
            }}
            aria-label="새 방 이름"
          />
          <div className="mt-2 flex gap-2">
            <button type="submit" className="btn btn-primary btn-sm flex-1" disabled={busy || !name.trim()}>
              {busy ? "만드는 중…" : "만들기"}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setCreating(false);
                setName("");
              }}
            >
              취소
            </button>
          </div>
        </form>
      ) : null}

      {!store.ready ? (
        <p className="panel-note px-3 py-2">불러오는 중…</p>
      ) : rooms.length === 0 ? (
        <div className="px-3 py-6 text-center">
          <p className="text-[13px] font-bold">아직 방이 없습니다</p>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">이름만 입력하면 바로 만들어집니다.</p>
        </div>
      ) : (
        <ul className="room-list">
          {rooms.map((r) => (
            <li key={r.id}>
              <RoomRow room={r} active={r.id === roomId} onOpen={() => onOpenRoom(r.id)} />
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function RoomRow({ room, active, onOpen }: { room: RoomCard; active: boolean; onOpen: () => void }) {
  const who = room.last_sender ? (room.last_sender.type === "owner" ? "나" : room.last_sender.name) : "";
  const preview = room.last_preview ? `${who ? who + ": " : ""}${room.last_preview}` : "아직 대화가 없습니다";
  return (
    <button type="button" className="rl-row" aria-current={active ? "page" : undefined} onClick={onOpen}>
      <span className="rl-head">
        <span className="rl-name">{room.name}</span>
        <span className="rl-meta">{room.last_message_at ? relTime(room.last_message_at) : ""}</span>
      </span>
      <span className="rl-preview">{preview}</span>
      <span className="rl-side">
        {room.paused ? <span className="tag tag-wait">정지</span> : null}
        {roomNeedsAnswer(room) ? (
          <span className="rl-need" title="답변 필요">
            답변 필요
          </span>
        ) : null}
        {room.unread > 0 ? (
          <span className="tile-unread">{room.unread > 99 ? "99+" : room.unread}</span>
        ) : (
          <span className="rl-members">
            <Icon name="bot" size={12} /> {room.member_count}
          </span>
        )}
      </span>
    </button>
  );
}
