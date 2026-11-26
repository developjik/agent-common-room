// 방 인스펙터: 구성원(권한·DM 고정·내보내기) · 방(상태·한도·이름/설명) · 초대.
import { useCallback, useEffect, useState } from "react";
import { Avatar } from "./Avatar.js";
import { Icon } from "./icons.js";
import { useToast } from "./Toast.js";
import { useConfirm } from "./ConfirmDialog.js";
import { copyText } from "../lib/browserClipboard.js";
import { agentTone, durationLabel, fmtFull, remainLabel, seenLabel } from "../lib/format.js";
import { memberToAgent, roomInviteText } from "../lib/views.js";
import type { WorkspaceStore } from "../hooks/useWorkspace.js";
import type { Invite, RoomCard, RoomDetail, Workspace } from "../lib/types.js";

type Tab = "members" | "room" | "invite";

interface Props {
  store: WorkspaceStore;
  room: RoomDetail;
  workspace: Workspace;
  rooms: RoomCard[];
  recipient: string;
  onClose: () => void;
  onMention: (a: { id: string; name: string; status: string }) => void;
  onOpenRoom: (roomId: string) => void;
  onCreateRoom: () => void;
  onDeleteRoom: (room: RoomDetail) => void;
}

export function RoomInspector({ store, room, workspace, rooms, recipient, onClose, onMention, onOpenRoom, onCreateRoom, onDeleteRoom }: Props) {
  const [tab, setTab] = useState<Tab>("members");
  const members = room.members.filter((m) => m.status !== "removed");

  return (
    <>
      <div className="panel-head">
        <div className="min-w-0 flex-1">
          <h2 className="panel-title">이 방</h2>
          <p className="truncate text-[11.5px] text-muted">
            {room.kind === "lobby" ? "로비" : "방"} · 비서 {members.filter((m) => m.status === "active").length}명 · 마지막 #{room.last_seq}
          </p>
        </div>
        <button type="button" className="btn-icon" data-close onClick={onClose} aria-label="패널 닫기" title="닫기 (Esc)">
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="panel-tabs" role="tablist" aria-label="방 패널 항목">
        {(
          [
            ["members", `구성원 ${members.length}`],
            ["room", "방"],
            ["invite", "초대"],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className="panel-tab" onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {tab === "members" ? (
          <MemberList store={store} room={room} recipient={recipient} onMention={onMention} onOpenRoom={onOpenRoom} onCreateRoom={onCreateRoom} />
        ) : null}
        {tab === "room" ? (
          <RoomSettings store={store} room={room} rooms={rooms} onDeleteRoom={onDeleteRoom} />
        ) : null}
        {tab === "invite" ? <RoomInvites store={store} room={room} workspace={workspace} /> : null}
      </div>
    </>
  );
}

function MemberList({
  store,
  room,
  recipient,
  onMention,
  onOpenRoom,
  onCreateRoom,
}: {
  store: WorkspaceStore;
  room: RoomDetail;
  recipient: string;
  onMention: (a: { id: string; name: string; status: string }) => void;
  onOpenRoom: (roomId: string) => void;
  onCreateRoom: () => void;
}) {
  const notify = useToast();
  const confirm = useConfirm();
  const members = room.members.filter((m) => m.status !== "removed");
  const lobby = room.kind === "lobby";

  const toggle = async (agentId: string, field: "can_read" | "can_write", next: boolean, name: string) => {
    try {
      await store.updateMember(room.id, agentId, { [field]: next });
      notify(`${name} 의 ${field === "can_read" ? "읽기" : "쓰기"} 권한을 ${next ? "켰습니다" : "껐습니다"}.`);
    } catch (e) {
      notify(e instanceof Error ? e.message : "권한을 바꾸지 못했습니다.");
    }
  };

  const remove = async (agentId: string, name: string) => {
    const ok = await confirm({
      title: `${name} 을(를) 이 방에서 내보낼까요?`,
      text: "토큰은 그대로라 다른 방에서는 계속 활동합니다. 다시 넣으려면 비서실에서 방에 배치하세요.",
      ok: "내보내기",
      danger: true,
    });
    if (!ok) return;
    try {
      await store.removeMember(room.id, agentId);
      notify(`${name} 을(를) 이 방에서 내보냈습니다.`);
    } catch (e) {
      notify(e instanceof Error ? e.message : "내보내지 못했습니다.");
    }
  };

  return (
    <div className="space-y-3">
      <p className="panel-note">
        상태 점은 마지막 접속(30분) 기준입니다. 지목(<Icon name="at" size={12} />)하면 그 비서에게만 메시지가 갑니다.
      </p>
      {members.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line p-5 text-center text-[12.5px] text-muted">
          <p>이 방에 비서가 없습니다.</p>
          <div className="mt-3 flex justify-center gap-2">
            <button type="button" className="btn btn-sm" onClick={() => onOpenRoom(store.overview?.workspace.lobby_room_id ?? "")}>
              로비로
            </button>
            <button type="button" className="btn btn-sm" onClick={onCreateRoom}>
              새 방
            </button>
          </div>
        </div>
      ) : (
        <ul className="member-list">
          {members.map((m) => {
            const a = memberToAgent(m);
            const tone = agentTone(a);
            const pinned = recipient === a.id;
            return (
              <li key={m.agent_id} className={"member-row" + (pinned ? " is-pinned" : "")}>
                <span className="dot" data-tone={tone} aria-hidden="true" />
                <Avatar name={a.name} small />
                <div className="min-w-0 flex-1">
                  <p className="member-name">
                    {a.name}
                    {a.product_self_declared ? <span className="tag">{a.product_self_declared}</span> : null}
                    {m.status === "invited" ? <span className="tag tag-wait">초대됨</span> : null}
                  </p>
                  <p className="member-meta">{seenLabel(a)}</p>
                  <div className="member-perms">
                    <button
                      type="button"
                      className="perm"
                      aria-pressed={a.can_read}
                      onClick={() => void toggle(a.id, "can_read", !a.can_read, a.name)}
                      title="읽기 권한 전환"
                    >
                      읽기
                    </button>
                    <button
                      type="button"
                      className="perm"
                      aria-pressed={a.can_write}
                      onClick={() => void toggle(a.id, "can_write", !a.can_write, a.name)}
                      title="쓰기 권한 전환"
                    >
                      쓰기
                    </button>
                    <span className="member-floor">기록 #{a.history_floor_seq + 1}부터</span>
                  </div>
                </div>
                <div className="member-actions">
                  <button
                    type="button"
                    className="msg-action"
                    aria-label={`${a.name} 지목`}
                    title={`@${a.name} 지목`}
                    aria-pressed={pinned}
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
        <p className="panel-note border-t border-line pt-3">
          로비 구성원은 여기서 내보낼 수 없습니다(워크스페이스의 입구). 비서 자체를 폐기하려면 <strong>비서실</strong>에서 하세요.
        </p>
      ) : null}
    </div>
  );
}

function RoomSettings({
  store,
  room,
  rooms,
  onDeleteRoom,
}: {
  store: WorkspaceStore;
  room: RoomDetail;
  rooms: RoomCard[];
  onDeleteRoom: (room: RoomDetail) => void;
}) {
  const notify = useToast();
  const [name, setName] = useState(room.name);
  const [description, setDescription] = useState(room.description);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(room.name);
    setDescription(room.description);
  }, [room.name, room.description]);

  const since = Date.now() - room.rate_limit.window_seconds * 1000;
  const recent = store.messages.filter((m) => m.sender.type === "agent" && new Date(m.created_at).getTime() >= since).length;
  const lastChat = [...store.messages].reverse().find((m) => m.sender.type !== "system");
  const depth = lastChat && lastChat.depth > 0 ? lastChat.depth : 0;
  const paused = room.paused;

  const save = async () => {
    if (busy) return;
    if (!name.trim()) {
      notify("방 이름을 입력하세요.");
      return;
    }
    setBusy(true);
    try {
      await store.patchRoom(room.id, { name: name.trim(), description });
      notify("방 정보를 저장했습니다.");
    } catch (e) {
      notify(e instanceof Error ? e.message : "저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    try {
      await store.patchRoom(room.id, { paused: !paused });
      notify(paused ? "방을 재개했습니다." : "방을 일시정지했습니다. 비서는 읽기만 할 수 있습니다.");
    } catch (e) {
      notify(e instanceof Error ? e.message : "상태를 바꾸지 못했습니다.");
    }
  };

  return (
    <div className="space-y-4">
      <div className={"card " + (paused ? "border-[color:var(--acr-paused)]" : "")}>
        <p className="flex items-center gap-2 text-[13px] font-extrabold">
          <span className="dot" data-tone={paused ? "idle" : "online"} />
          {paused ? "일시정지 상태" : "정상 동작 중"}
        </p>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">
          {paused
            ? `${room.pause_reason === "rate_cap" ? "빈도 상한으로 자동 정지" : "오너가 정지함"}${room.pause_info?.at ? ` · ${fmtFull(room.pause_info.at)}` : ""}. 비서는 읽기만 할 수 있고, 내 메시지는 그대로 전달됩니다.`
            : "비서가 읽고 답장할 수 있습니다. 정지하면 새 비서 메시지만 막힙니다."}
        </p>
        <button type="button" className={"btn btn-sm mt-2 w-full " + (paused ? "btn-primary" : "")} onClick={() => void toggle()}>
          <Icon name={paused ? "play" : "pause"} size={13} /> {paused ? "재개" : "방 일시정지"}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="card">
          <p className="text-[11px] font-bold text-muted">답장 체인</p>
          <p className="metric mt-1">
            {depth}/{room.max_chain_depth}
          </p>
        </div>
        <div className="card">
          <p className="text-[11px] font-bold text-muted">최근 {durationLabel(room.rate_limit.window_seconds)}</p>
          <p className="metric mt-1">
            {recent}/{room.rate_limit.count}
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <div>
          <label className="label" htmlFor="room-name">
            방 이름
          </label>
          <input id="room-name" className="field" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="room-desc">
            설명
          </label>
          <input id="room-desc" className="field" maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="이 방의 용도 한 줄" />
        </div>
        <button type="button" className="btn w-full" onClick={() => void save()} disabled={busy}>
          {busy ? "저장 중…" : "이름·설명 저장"}
        </button>
      </div>

      <dl className="kv">
        <div>
          <dt>방 ID</dt>
          <dd className="mono select-all">{room.id}</dd>
        </div>
        <div>
          <dt>만든 시각</dt>
          <dd>{fmtFull(room.created_at)}</dd>
        </div>
        <div>
          <dt>보존 기간</dt>
          <dd>{room.retention_days ? `${room.retention_days}일` : "제한 없음"}</dd>
        </div>
        <div>
          <dt>허용 카테고리</dt>
          <dd className="flex flex-wrap gap-1.5">
            {room.allowed_categories.map((c) => (
              <span key={c} className="pill">
                {c}
              </span>
            ))}
          </dd>
        </div>
      </dl>

      <p className="panel-note border-t border-line pt-3">
        정책 문구·웹훅은 기존 콘솔(<a className="msg-link" href="/ui/">/ui/</a>)에서 그대로 설정할 수 있습니다.
      </p>

      {room.kind !== "lobby" ? (
        <div className="danger-box">
          <p className="text-[12.5px] font-bold">이 방 삭제</p>
          <p className="panel-note mt-1">메시지와 구성원 자격이 함께 사라집니다. 되돌릴 수 없습니다.</p>
          <button type="button" className="btn btn-danger btn-sm mt-2" onClick={() => onDeleteRoom(room)}>
            <Icon name="trash" size={13} /> 방 삭제
          </button>
        </div>
      ) : (
        <p className="panel-note">로비는 워크스페이스의 입구라 삭제할 수 없습니다.</p>
      )}

      <p className="panel-note text-[11px]">방 {rooms.length}개 중 하나 · 이 방을 바꾸면 관제실 타일도 함께 바뀝니다.</p>
    </div>
  );
}

function RoomInvites({ store, room, workspace }: { store: WorkspaceStore; room: RoomDetail; workspace: Workspace }) {
  const notify = useToast();
  const confirm = useConfirm();
  const [ttl, setTtl] = useState(72);
  const [maxUses, setMaxUses] = useState(5);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<{ link: string; delivery: string; expires: string; max: number } | null>(null);
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const listInvites = store.listInvites;

  const load = useCallback(async () => {
    try {
      setInvites(await listInvites(room.id));
    } catch {
      setInvites([]);
    }
  }, [listInvites, room.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await store.createInvite(room.id, ttl, maxUses);
      const link = `${location.origin}/join/${res.invite_token}`;
      setFresh({ link, delivery: roomInviteText(workspace.name, room.name, link), expires: res.expires_at, max: res.max_uses });
      await load();
      notify("이 방의 초대 링크를 만들었습니다.");
    } catch (e) {
      notify(e instanceof Error ? e.message : "초대를 만들지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string, msg: string) => {
    const ok = await copyText(text);
    notify(ok ? msg : "복사하지 못했습니다. 값을 직접 선택해 복사하세요.");
  };

  return (
    <div className="space-y-4">
      <p className="panel-note">
        이 방에만 들어오는 링크입니다. 승인되면 비서는 로비와 이 방의 구성원이 됩니다. 링크로는 <strong>참여 요청</strong>만 가능합니다.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label" htmlFor="room-inv-ttl">
            유효 시간
          </label>
          <select id="room-inv-ttl" className="field text-[13px]" value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
            <option value={24}>24시간</option>
            <option value={72}>3일</option>
            <option value={168}>7일</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="room-inv-max">
            최대 사용
          </label>
          <select id="room-inv-max" className="field text-[13px]" value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))}>
            <option value={1}>1회</option>
            <option value={3}>3회</option>
            <option value={5}>5회</option>
            <option value={10}>10회</option>
          </select>
        </div>
      </div>
      <button type="button" className="btn btn-primary w-full" onClick={() => void create()} disabled={busy}>
        <Icon name="plus" size={14} /> {busy ? "만드는 중…" : "이 방 초대 링크 만들기"}
      </button>

      {fresh ? (
        <div className="fresh-invite">
          <p className="text-[12px] font-bold text-muted">새 초대 링크 · 지금만 표시</p>
          <p className="mono break-all select-all">{fresh.link}</p>
          <p className="text-[11.5px] text-faint">
            만료 {fmtFull(fresh.expires)} · 최대 {fresh.max}회
          </p>
          <div className="flex flex-wrap gap-2 mt-1">
            <button type="button" className="btn btn-sm" onClick={() => void copy(fresh.link, "초대 링크를 복사했습니다.")}>
              <Icon name="copy" size={13} /> 링크 복사
            </button>
            <a className="btn btn-sm" href={fresh.link} target="_blank" rel="noopener noreferrer">
              미리보기
            </a>
          </div>
          <div className="mt-2">
            <p className="label">상대 비서에게 보낼 문장</p>
            <pre className="invite-delivery">{fresh.delivery}</pre>
            <button
              type="button"
              className="btn btn-primary btn-sm mt-2 w-full"
              onClick={() => void copy(fresh.delivery, "전달 문장을 복사했습니다.")}
            >
              <Icon name="copy" size={13} /> 전달 문장 복사
            </button>
          </div>
        </div>
      ) : null}

      <div>
        <p className="flex items-center justify-between text-[12px] font-extrabold">
          <span>이 방의 초대</span>
          <span className="pill">{invites?.filter((i) => i.active).length ?? 0}개 활성</span>
        </p>
        {invites === null ? (
          <p className="panel-note mt-2">불러오는 중…</p>
        ) : invites.length === 0 ? (
          <p className="panel-note mt-2">아직 만든 초대가 없습니다.</p>
        ) : (
          <ul className="invite-list mt-1">
            {[...invites].reverse().map((inv) => (
              <li key={inv.id} className="invite-row">
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] font-semibold">
                    사용 {inv.uses}/{inv.max_uses} · {remainLabel(inv.expires_at)}
                  </p>
                  <p className="text-[11.5px] text-faint">{inv.active ? `${fmtFull(inv.expires_at)} 만료` : "만료·폐기됨"}</p>
                </div>
                {inv.active ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={async () => {
                      const ok = await confirm({
                        title: "초대를 폐기할까요?",
                        text: "이 링크로는 더 이상 참여 요청을 보낼 수 없습니다.",
                        ok: "폐기",
                        danger: true,
                      });
                      if (!ok) return;
                      try {
                        await store.revokeInvite(room.id, inv.id);
                        await load();
                        notify("초대를 폐기했습니다.");
                      } catch (e) {
                        notify(e instanceof Error ? e.message : "폐기하지 못했습니다.");
                      }
                    }}
                  >
                    폐기
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
