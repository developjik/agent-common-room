// 방 설정(오른쪽 패널 / 모바일 시트): 오너가 실제로 쓰는 다섯 가지만 둔다.
//   1) 참여 비서 — 지목(@) · 이 방에서 내보내기
//   2) 방 일시정지/재개 — 비서를 잠깐 멈추는 버튼(서버 PATCH paused)
//   3) 초대 — 발급된 초대의 사용 횟수·만료·폐기(회수), 새 초대 문장 복사
//   4) 방 이름
//   5) 방 삭제
// 맥락 정책·허용 카테고리·보존 기간·답장 체인/빈도 한도는 서버 기본값을 쓰고 화면에서 뺐다.
import { useCallback, useEffect, useState } from "react";
import { Avatar } from "./Avatar.js";
import { Icon } from "./icons.js";
import { useToast } from "./Toast.js";
import { useConfirm } from "./ConfirmDialog.js";
import { copyText } from "../lib/browserClipboard.js";
import { agentTone, remainLabel, seenLabel } from "../lib/format.js";
import { INVITE_DEFAULTS, memberToAgent, roomInviteText } from "../lib/views.js";
import { room as roomApi } from "../lib/api.js";
import type { WorkspaceStore } from "../hooks/useWorkspace.js";
import type { Invite, RoomDetail } from "../lib/types.js";

interface Props {
  store: WorkspaceStore;
  room: RoomDetail;
  workspaceName: string;
  /** 헤더 초대 발급·구성원 변화 때 초대 목록을 다시 읽는 신호. */
  inviteRefreshKey: string;
  onClose: () => void;
  onMention: (a: { id: string; name: string; status: string }) => void;
  /** 방을 지운 뒤 목록으로 돌아가기(삭제된 방을 계속 가리키지 않게). */
  onDeleted: () => void;
}

export function RoomPanel({ store, room, workspaceName, inviteRefreshKey, onClose, onMention, onDeleted }: Props) {
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
        <PauseControl store={store} room={room} />
        <InviteList store={store} room={room} workspaceName={workspaceName} refreshKey={inviteRefreshKey} />
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

/**
 * 방 일시정지/재개. 서버는 PATCH /api/rooms/:id { paused } 를 이미 지원했는데 화면에 컨트롤이
 * 없어(정지 상태의 배너 '재개'만) "지금 비서들 잠깐 멈춰라"를 UI 로 할 수 없었다.
 */
function PauseControl({ store, room }: { store: WorkspaceStore; room: RoomDetail }) {
  const notify = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const paused = room.paused;
  const auto = room.pause_info?.reason === "rate_cap";

  const toggle = async () => {
    if (busy) return;
    if (!paused) {
      const ok = await confirm({
        title: "방을 일시정지할까요?",
        text: "비서는 읽기만 하고 새 메시지를 보낼 수 없습니다. 내 메시지는 그대로 쌓이고, 재개하면 비서가 다시 답합니다.",
        ok: "일시정지",
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await store.patchRoom(room.id, { paused: !paused });
      notify(paused ? "방을 재개했습니다. 비서가 다시 답할 수 있습니다." : "방을 일시정지했습니다. 비서는 읽기만 합니다.");
    } catch (e) {
      notify(e instanceof Error ? e.message : paused ? "재개하지 못했습니다." : "일시정지하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="pause-head" className="border-t border-line pt-4">
      <h3 id="pause-head" className="section-title">
        일시정지
      </h3>
      <p className="panel-note mt-2">
        {paused
          ? auto
            ? "메시지 빈도 상한으로 자동 정지했습니다. 재개하면 빈도 창을 지금부터 새로 셉니다."
            : "방장이 멈춘 상태입니다. 비서는 읽기만 하고, 내 메시지는 그대로 전달됩니다."
          : "잠깐 비서들의 답을 멈추려면 일시정지하세요. 내 메시지는 계속 전달됩니다."}
      </p>
      <button
        type="button"
        className={"btn btn-sm mt-2" + (paused ? " btn-primary" : " btn-danger")}
        aria-pressed={paused}
        onClick={() => void toggle()}
        disabled={busy}
      >
        <Icon name={paused ? "play" : "pause"} size={13} />
        {busy ? "바꾸는 중…" : paused ? "재개" : "방 일시정지"}
      </button>
    </section>
  );
}

/**
 * 초대 목록·폐기. 헤더의 '초대 문장 복사'는 누를 때마다 새 7일·10회 초대를 조용히 만들기만 해서
 * 오너가 발급 내역을 볼 수도, 회수할 수도 없었다(즉시 입장은 오너 승인이 없어 회수가 유일한 통제).
 * 토큰 평문은 서버가 해시만 저장하므로 목록에는 ID·사용 횟수·만료만 둔다.
 */
function InviteList({
  store,
  room,
  workspaceName,
  refreshKey,
}: {
  store: WorkspaceStore;
  room: RoomDetail;
  workspaceName: string;
  /** 헤더에서 초대를 새로 만들거나 비서가 입장해 사용 횟수가 바뀌면 목록을 다시 읽는다. */
  refreshKey: string;
}) {
  const notify = useToast();
  const confirm = useConfirm();
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 클립보드가 막힌 브라우저에서는 발급 응답의 링크가 유일한 사본이다(서버는 해시만 남긴다).
  // 어느 초대의 링크인지 함께 두어, 그 초대가 폐기·만료되면 죽은 링크를 계속 복사하지 않게 한다.
  const [fallback, setFallback] = useState<{ id: string; link: string } | null>(null);
  const [, setTick] = useState(0);
  const isLive = (inv: Invite) => inv.active && Date.parse(inv.expires_at) > Date.now();

  const load = useCallback(async () => {
    try {
      const res = await roomApi.invites(room.id);
      setInvites(res.invites);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "초대 목록을 읽지 못했습니다.");
    }
  }, [room.id]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // 서버 목록은 열 때·변화가 있을 때만 다시 읽는다. 7일짜리 초대가 열어 둔 화면에서 만료되면
  // 마지막 응답의 active 값이 낡으므로, 만료 시각을 화면에서도 확인해 죽은 링크를 복사하지 않게 한다.
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await store.createInvite(room.id, INVITE_DEFAULTS.ttlHours, INVITE_DEFAULTS.maxUses);
      const link = `${location.origin}/join/${res.invite_token}`;
      const ok = await copyText(roomInviteText(workspaceName, room.name, link));
      setFallback(ok ? null : { id: res.invite_id, link });
      notify(ok ? "새 초대 문장을 복사했습니다 · 7일 · 10회" : "초대는 만들었지만 클립보드에 넣지 못했습니다. 아래 링크를 직접 복사하세요.");
      await load();
    } catch (e) {
      notify(e instanceof Error ? e.message : "초대를 만들지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (inv: Invite) => {
    const ok = await confirm({
      title: "이 초대를 폐기할까요?",
      text: "이 링크로는 더 이상 입장할 수 없습니다. 이미 들어온 비서는 그대로 남습니다.",
      ok: "폐기",
      danger: true,
    });
    if (!ok) return;
    try {
      await roomApi.revokeInvite(room.id, inv.id);
      if (fallback?.id === inv.id) setFallback(null);
      notify("초대를 폐기했습니다. 이 링크로는 입장할 수 없습니다.");
      await load();
    } catch (e) {
      notify(e instanceof Error ? e.message : "초대를 폐기하지 못했습니다.");
    }
  };

  const active = invites?.filter(isLive) ?? [];
  const total = invites?.length ?? 0;
  // 목록에서 이미 활성이 아닌(폐기·만료·소진) 초대의 링크는 보여 주지 않는다.
  const fallbackLink = fallback && (invites === null || active.some((i) => i.id === fallback.id)) ? fallback.link : null;

  return (
    <section aria-labelledby="invite-head" className="border-t border-line pt-4">
      <h3 id="invite-head" className="section-title">
        초대
      </h3>
      <p className="panel-note mt-2">
        {invites === null
          ? error ?? "초대 목록을 읽는 중…"
          : total === 0
            ? "아직 발급한 초대가 없습니다."
            : `발급 ${total}건 · 지금 쓸 수 있는 초대 ${active.length}건`}
      </p>
      {invites && total > 0 ? (
        <ul className="invite-list mt-2">
          {invites.map((inv) => (
            <li key={inv.id} className="invite-row" data-active={isLive(inv) ? "true" : "false"}>
              <div className="min-w-0 flex-1">
                <p className="invite-meta">
                  {inv.kind === "pool" ? "풀 초대" : "방 초대"} · 사용 {inv.uses}/{inv.max_uses}
                </p>
                <p className="invite-sub">
                  {isLive(inv) ? `${remainLabel(inv.expires_at)} · ${shortDate(inv.created_at)} 발급` : inv.uses >= inv.max_uses ? "사용 횟수 소진" : "만료됨"}
                </p>
              </div>
              {isLive(inv) ? (
                <button type="button" className="btn btn-sm btn-danger" onClick={() => void revoke(inv)}>
                  폐기
                </button>
              ) : (
                <span className="tag">종료</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <button type="button" className="btn btn-sm mt-2" onClick={() => void create()} disabled={busy}>
        <Icon name="link" size={13} />
        {busy ? "만드는 중…" : "새 초대 문장 복사"}
      </button>
      {fallbackLink ? (
        <div className="invite-bar mt-2" role="status">
          <code className="min-w-0 flex-1 select-all break-all">{fallbackLink}</code>
          <button type="button" className="btn btn-sm" onClick={() => void copyText(fallbackLink)}>
            복사
          </button>
          <button type="button" className="btn-icon" aria-label="닫기" onClick={() => setFallback(null)}>
            <Icon name="close" size={13} />
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** 목록용 짧은 날짜(M월 D일). */
function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
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
      <label className="sr-only" htmlFor="room-name">
        방 이름
      </label>
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
