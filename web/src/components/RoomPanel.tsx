// 방 설정(오른쪽 패널 / 모바일 시트): 오너가 실제로 쓰는 세 가지만 둔다.
//   1) 참여 비서 — 지목(@) · 이 방에서 내보내기
//   2) 방 이름
//   3) 방 삭제
// 맥락 정책·허용 카테고리·보존 기간·답장 체인/빈도 한도는 서버 기본값을 쓰고 화면에서 뺐다.
import { useEffect, useState } from "react";
import { Avatar } from "./Avatar.js";
import { Icon } from "./icons.js";
import { useToast } from "./Toast.js";
import { useConfirm } from "./ConfirmDialog.js";
import { agentTone, seenLabel } from "../lib/format.js";
import { memberToAgent } from "../lib/views.js";
import type { WorkspaceStore } from "../hooks/useWorkspace.js";
import type { RoomDetail } from "../lib/types.js";

interface Props {
  store: WorkspaceStore;
  room: RoomDetail;
  onClose: () => void;
  onMention: (a: { id: string; name: string; status: string }) => void;
  /** 방을 지운 뒤 목록으로 돌아가기(삭제된 방을 계속 가리키지 않게). */
  onDeleted: () => void;
}

export function RoomPanel({ store, room, onClose, onMention, onDeleted }: Props) {
  return (
    <>
      <div className="panel-head">
        <div className="min-w-0 flex-1">
          <h2 className="panel-title">방 설정</h2>
          <p className="truncate text-[11px] text-muted">
            {room.kind === "lobby" ? "로비" : "방"} · 비서 {room.members.filter((m) => m.status === "active").length}명
          </p>
        </div>
        <button type="button" className="btn-icon" data-close onClick={onClose} aria-label="패널 닫기" title="닫기 (Esc)">
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="panel-body space-y-5">
        <MemberList store={store} room={room} onMention={onMention} />
        <RoomName store={store} room={room} />
        <DangerZone store={store} room={room} onDeleted={onDeleted} />
      </div>
    </>
  );
}

function MemberList({ store, room, onMention }: { store: WorkspaceStore; room: RoomDetail; onMention: Props["onMention"] }) {
  const notify = useToast();
  const confirm = useConfirm();
  const members = room.members.filter((m) => m.status !== "removed");
  const lobby = room.kind === "lobby";

  const remove = async (agentId: string, name: string) => {
    const ok = await confirm({
      title: `"${name}" 비서를 이 방에서 내보낼까요?`,
      text: "토큰은 그대로라 다른 방에서는 계속 활동합니다. 다시 넣으려면 비서 화면에서 방을 켜면 됩니다.",
      ok: "내보내기",
      danger: true,
    });
    if (!ok) return;
    try {
      await store.removeMember(room.id, agentId);
      notify(`"${name}" 비서를 이 방에서 내보냈습니다.`);
    } catch (e) {
      notify(e instanceof Error ? e.message : "내보내지 못했습니다.");
    }
  };

  return (
    <section aria-labelledby="members-head">
      <h3 id="members-head" className="section-title">
        참여 비서
      </h3>
      {members.length === 0 ? (
        <p className="panel-note mt-2">
          아직 비서가 없습니다. 방 상단의 <strong>초대 문장 복사</strong>를 눌러 비서에게 그대로 보내세요.
        </p>
      ) : (
        <ul className="member-list mt-2">
          {members.map((m) => {
            const a = memberToAgent(m);
            const invited = m.status === "invited";
            return (
              <li key={m.agent_id} className="member-row">
                <span className="dot" data-tone={agentTone(a)} aria-hidden="true" />
                <Avatar name={a.name} small />
                <div className="min-w-0 flex-1">
                  <p className="member-name">
                    {a.name}
                    {a.product_self_declared ? <span className="tag">{a.product_self_declared}</span> : null}
                    {invited ? <span className="tag tag-wait">초대됨</span> : null}
                  </p>
                  <p className="member-meta">{seenLabel(a)}</p>
                </div>
                <div className="member-actions">
                  <button
                    type="button"
                    className="msg-action"
                    aria-label={`${a.name} 지목`}
                    title={`@${a.name} 지목`}
                    disabled={m.status !== "active"}
                    onClick={() => onMention(a)}
                  >
                    <Icon name="at" size={15} />
                  </button>
                  {!lobby ? (
                    <button
                      type="button"
                      className="msg-action is-danger"
                      aria-label={`${a.name} 이 방에서 내보내기`}
                      title="이 방에서 내보내기"
                      onClick={() => void remove(a.id, a.name)}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {lobby ? (
        <p className="panel-note mt-2">로비는 워크스페이스의 입구라 비서를 내보낼 수 없습니다. 비서 자체를 끊으려면 비서 화면에서 하세요.</p>
      ) : null}
    </section>
  );
}

function RoomName({ store, room }: { store: WorkspaceStore; room: RoomDetail }) {
  const notify = useToast();
  const [name, setName] = useState(room.name);
  const [busy, setBusy] = useState(false);

  // 폴링이 서버 값을 다시 가져와도 편집 중인 입력을 덮지 않는다(이름이 실제로 바뀌었을 때만).
  useEffect(() => {
    setName(room.name);
  }, [room.name]);

  const save = async () => {
    const wanted = name.trim();
    if (busy) return;
    if (!wanted) {
      notify("방 이름을 입력하세요.");
      return;
    }
    if (wanted === room.name) return;
    setBusy(true);
    try {
      await store.patchRoom(room.id, { name: wanted });
      notify("방 이름을 바꿨습니다.");
    } catch (e) {
      notify(e instanceof Error ? e.message : "저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="room-name-head" className="border-t border-line pt-4">
      <h3 id="room-name-head" className="section-title">
        방 이름
      </h3>
      <div className="mt-2 flex gap-2">
        <input
          id="room-name"
          className="field flex-1"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            // 한글 입력기로 후보를 확정하는 Enter 는 저장하지 않는다(조합 중 전송 방지와 같은 규칙).
            if (e.key === "Enter" && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) void save();
          }}
        />
        <button type="button" className="btn" onClick={() => void save()} disabled={busy || name.trim() === room.name}>
          {busy ? "저장 중…" : "저장"}
        </button>
      </div>
    </section>
  );
}

function DangerZone({ store, room, onDeleted }: { store: WorkspaceStore; room: RoomDetail; onDeleted: () => void }) {
  const notify = useToast();
  const confirm = useConfirm();

  const remove = async () => {
    const ok = await confirm({
      title: `'${room.name}' 방을 삭제할까요?`,
      text: "방의 메시지·구성원 자격이 함께 사라집니다. 되돌릴 수 없습니다.",
      ok: "삭제",
      danger: true,
    });
    if (!ok) return;
    try {
      await store.deleteRoom(room.id);
      notify(`'${room.name}' 방을 삭제했습니다.`);
      onDeleted();
    } catch (e) {
      notify(e instanceof Error ? e.message : "방을 삭제하지 못했습니다.");
    }
  };

  if (room.kind === "lobby") {
    return <p className="panel-note border-t border-line pt-4">로비는 삭제할 수 없습니다.</p>;
  }
  return (
    <section aria-labelledby="room-danger-head" className="danger-box">
      <h3 id="room-danger-head" className="text-[12.5px] font-bold">
        이 방 삭제
      </h3>
      <button type="button" className="btn btn-danger btn-sm mt-2" onClick={() => void remove()}>
        <Icon name="trash" size={13} /> 방 삭제
      </button>
    </section>
  );
}
