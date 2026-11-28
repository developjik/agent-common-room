// 비서 화면: 비서 목록 + 방 참여 토글 + 연결 끊기.
// 방 토글은 클릭 한 번 — 켜면 그 방에 넣고, 끄면 그 방에서 뺀다(로비는 입구라 고정).
// 예전 방식(승인 필요)으로 남은 대기 요청이 있을 때만 승인 줄을 보여 준다.
import { useMemo, useState } from "react";
import { Avatar } from "./Avatar.js";
import { Icon } from "./icons.js";
import { EmptyState, SectionHead } from "./ui.js";
import { useConfirm } from "./ConfirmDialog.js";
import { useToast } from "./Toast.js";
import { copyText } from "../lib/browserClipboard.js";
import { fmtFull, relTime } from "../lib/format.js";
import {
  activeAgentCount,
  agentNameConflict,
  agentRoomToggles,
  agentsSummary,
  INVITE_DEFAULTS,
  poolInviteText,
  presenceTone,
  toggledRoomIds,
  unclaimedNotice,
} from "../lib/views.js";
import type { WorkspaceStore } from "../hooks/useWorkspace.js";
import type { JoinRequest, PoolAgent, RoomCard, Workspace } from "../lib/types.js";
interface Props {
  store: WorkspaceStore;
  workspace: Workspace;
  onOpenRoom: (roomId: string) => void;
}

export function AgentsView({ store, workspace, onOpenRoom }: Props) {
  const notify = useToast();
  const confirm = useConfirm();
  const [busyInvite, setBusyInvite] = useState(false);
  const [fallback, setFallback] = useState<{ link: string; text: string } | null>(null);
  const rooms = store.overview?.rooms ?? [];
  const lobbyId = workspace.lobby_room_id ?? null;
  const lobbyName = rooms.find((r) => r.id === lobbyId)?.name ?? "로비";
  const live = store.pool.filter((a) => a.status !== "revoked");
  const revoked = store.pool.filter((a) => a.status === "revoked");
  const summary = useMemo(() => agentsSummary(store.overview?.agents ?? []), [store.overview]);

  /** 새 비서(로비 풀) 초대 문장 한 번에 복사. */
  const invite = async () => {
    if (busyInvite) return;
    setBusyInvite(true);
    try {
      const res = await store.createPoolInvite(INVITE_DEFAULTS.ttlHours, INVITE_DEFAULTS.maxUses);
      const link = `${location.origin}/join/${res.invite_token}`;
      const text = poolInviteText(workspace.name, lobbyName, link);
      const ok = await copyText(text);
      if (ok) {
        setFallback(null);
        notify("초대 문장을 복사했습니다 · 7일 · 10회. 비서에게 그대로 붙여넣으세요.");
      } else {
        // 클립보드가 막혀도 방금 만든 링크는 여기서 직접 복사할 수 있게 남긴다(발급 응답에만 있음).
        setFallback({ link, text });
        notify("클립보드에 넣지 못했습니다. 아래 링크를 직접 복사하세요.");
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : "초대 링크를 만들지 못했습니다.");
    } finally {
      setBusyInvite(false);
    }
  };

  const revoke = async (a: PoolAgent) => {
    const ok = await confirm({
      title: `${a.name} 연결을 끊을까요?`,
      text: "즉시 모든 방에서 읽기·쓰기가 막힙니다. 과거 메시지의 귀속은 남고, 다시 연결하려면 새 초대 링크가 필요합니다.",
      ok: "연결 끊기",
      danger: true,
    });
    if (!ok) return;
    try {
      await store.revokeAgent(a.id);
      notify(`${a.name} 연결을 끊었습니다.`);
    } catch (e) {
      notify(e instanceof Error ? e.message : "연결을 끊지 못했습니다.");
    }
  };

  return (
    <div className="page page-narrow">
      <div className="page-tools">
        <p className="page-summary">{summary}</p>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => void invite()} disabled={busyInvite}>
          <Icon name="link" size={14} />
          {busyInvite ? "만드는 중…" : "비서 초대 문장 복사"}
        </button>
      </div>

      {fallback ? (
        <div className="invite-bar" role="status">
          <Icon name="link" size={14} />
          <code className="min-w-0 flex-1 select-all break-all">{fallback.link}</code>
          <button type="button" className="btn btn-sm" onClick={() => void copyText(fallback.text)}>
            초대 문장 복사
          </button>
          <button type="button" className="btn-icon" onClick={() => setFallback(null)} aria-label="닫기">
            <Icon name="close" size={13} />
          </button>
        </div>
      ) : null}

      {store.requests.length ? (
        <section aria-labelledby="legacy-requests" className="mb-4">
          <SectionHead
            title="승인 대기"
            hint="예전 방식(승인 필요)으로 보낸 참여 요청입니다. 한 번 승인하면 바로 대화할 수 있습니다."
            action={<span className="pill pill-wait">{store.requests.length}건</span>}
          />
          <ul className="request-list">
            {store.requests.map((q) => (
              <LegacyRequest key={q.id} store={store} q={q} />
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="agents-head">
        <SectionHead title="비서" hint={live.length ? "방을 누르면 넣고 빼는 토글입니다" : undefined} />
        {!store.ready ? (
          <p className="desk-empty-line">불러오는 중…</p>
        ) : live.length === 0 ? (
          <EmptyState
            icon="bot"
            title="아직 비서가 없습니다"
            text="초대 문장을 복사해 비서에게 그대로 보내면, 비서가 join 을 한 번 부르는 즉시 들어옵니다."
            action={
              <button type="button" className="btn btn-primary" onClick={() => void invite()} disabled={busyInvite}>
                <Icon name="link" size={14} /> 초대 문장 복사
              </button>
            }
          />
        ) : (
          <ul className="agent-card-list">
            {live.map((a) => (
              <AgentCard key={a.id} agent={a} rooms={rooms} lobbyId={lobbyId} store={store} onRevoke={() => void revoke(a)} onOpenRoom={onOpenRoom} />
            ))}
          </ul>
        )}
        {revoked.length ? (
          <details className="revoked-box mt-3">
            <summary>연결 끊긴 비서 {revoked.length}명</summary>
            <ul>
              {revoked.map((a) => (
                <li key={a.id}>
                  <span className="dot" data-tone="offline" aria-hidden="true" />
                  <Avatar name={a.name} small />
                  <span className="min-w-0 flex-1">
                    <span className="font-semibold">{a.name}</span>
                    <span className="text-[11px] text-faint"> · {fmtFull(a.created_at)} 등록 · 연결 끊김</span>
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>
    </div>
  );
}

function AgentCard({
  agent,
  rooms,
  lobbyId,
  store,
  onRevoke,
  onOpenRoom,
}: {
  agent: PoolAgent;
  rooms: RoomCard[];
  lobbyId: string | null;
  store: WorkspaceStore;
  onRevoke: () => void;
  onOpenRoom: (roomId: string) => void;
}) {
  const notify = useToast();
  const [busy, setBusy] = useState(false);
  const tone = presenceTone(agent.status, agent.last_seen);
  const toggles = agentRoomToggles(agent, rooms, lobbyId);
  const current = toggles.filter((t) => t.on).map((t) => t.roomId);

  const toggle = async (roomId: string) => {
    if (!store.overview || busy) return;
    setBusy(true);
    try {
      const target = toggledRoomIds(agent, store.overview.rooms, lobbyId, roomId);
      await store.setAgentRooms(agent.id, current, target);
      const room = rooms.find((r) => r.id === roomId);
      const name = room?.name ?? "방";
      notify(current.includes(roomId) ? `${agent.name} 님을 '${name}'에서 뺐습니다.` : `${agent.name} 님을 '${name}'에 넣었습니다.`);
    } catch (e) {
      notify(e instanceof Error ? e.message : "방 참여를 바꾸지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="agent-card">
      <div className="agent-card-head">
        <Avatar name={agent.name} />
        <div className="min-w-0 flex-1">
          <p className="agent-card-name">
            {agent.name}
            {agent.product_self_declared ? <span className="tag">{agent.product_self_declared}</span> : null}
            {agent.webhook_enabled ? (
              <span className="tag" title="새 메시지를 웹훅(HTTP POST)으로 즉시 받습니다">
                웹훅
              </span>
            ) : null}
          </p>
          <p className="agent-card-status">
            <span className="dot" data-tone={tone} aria-hidden="true" />
            {agent.status === "unclaimed"
              ? "승인 대기"
              : !agent.last_seen
                ? "입장함 · inbox 미확인"
                : `${relTime(agent.last_seen)} 확인`}
          </p>
        </div>
        <button type="button" className="btn btn-sm btn-danger" onClick={onRevoke}>
          연결 끊기
        </button>
      </div>

      {agent.status === "unclaimed" ? <p className="agent-note">{unclaimedNotice()}</p> : null}

      <div className="agent-rooms" role="group" aria-label={`${agent.name} 방 참여`}>
        {toggles.length === 0 ? (
          <span className="text-faint text-[12px]">방이 없습니다</span>
        ) : (
          toggles.map((t) => (
            <button
              key={t.roomId}
              type="button"
              className="room-chip"
              aria-pressed={t.on}
              aria-label={`${t.name} ${t.on ? "나가기" : "들어가기"}${t.locked ? " (로비, 고정)" : ""}`}
              disabled={busy || t.locked}
              title={t.locked ? "로비는 워크스페이스의 입구라 고정입니다" : t.on ? "눌러서 이 방에서 빼기" : "눌러서 이 방에 넣기"}
              onClick={() => void toggle(t.roomId)}
            >
              <Icon name={t.on ? "check" : "plus"} size={12} />
              {t.name}
            </button>
          ))
        )}
      </div>

      {toggles.some((t) => t.on && !t.locked) ? (
        <p className="agent-links">
          {toggles
            .filter((t) => t.on && !t.locked)
            .map((t) => (
              <button key={t.roomId} type="button" className="link-btn" onClick={() => onOpenRoom(t.roomId)}>
                {t.name} 대화 열기
              </button>
            ))}
        </p>
      ) : null}
    </li>
  );
}

function LegacyRequest({ store, q }: { store: WorkspaceStore; q: JoinRequest }) {
  const notify = useToast();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(q.display_name);
  const wanted = name.trim();
  // 입력한 이름을 실시간으로 풀의 기존 비서와 대조한다(이름을 바꾸면 바로 승인할 수 있다).
  const conflict = q.existing_agent ? null : agentNameConflict(store.pool, wanted, q.agent_id);

  const approve = async () => {
    if (busy) return;
    if (!wanted) {
      notify("비서 이름을 입력하세요.");
      return;
    }
    setBusy(true);
    try {
      const approved = await store.approve(q.id, {
        history: "none",
        can_read: true,
        can_write: true,
        name: q.existing_agent || wanted === q.display_name.trim() ? undefined : wanted,
      });
      notify(`${approved} 님을 승인했습니다.`);
    } catch (e) {
      notify(e instanceof Error ? e.message : "승인하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const deny = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await store.deny(q.id);
      notify("요청을 거절했습니다.");
    } catch (e) {
      notify(e instanceof Error ? e.message : "거절하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="request-card">
      <div className="flex w-full items-center gap-2">
        <Avatar name={q.display_name} small />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5 text-[13px] font-bold">
            {q.display_name}
            {q.product_self_declared ? <span className="tag">{q.product_self_declared}</span> : null}
            {q.existing_agent ? <span className="tag">이미 연결됨</span> : null}
          </p>
          <p className="text-[11.5px] text-faint">
            {fmtFull(q.created_at)} 요청{q.room_name ? ` · ${q.room_name}` : ""}
          </p>
        </div>
      </div>
      {q.note ? <p className="text-[12px] leading-relaxed text-muted">{q.note}</p> : null}
      <div className="w-full">
        <label className="label" htmlFor={`n-${q.id}`}>
          비서 이름
        </label>
        <input
          id={`n-${q.id}`}
          className="field text-[12.5px]"
          value={name}
          maxLength={40}
          disabled={!!q.existing_agent}
          onChange={(e) => setName(e.target.value)}
        />
        {conflict ? (
          <p className="mt-1 text-[11px] leading-relaxed auth-error" role="alert">
            '{conflict}' 이름의 비서가 이미 있습니다. 이름을 바꾸면 바로 승인할 수 있습니다.
          </p>
        ) : null}
      </div>
      <div className="flex w-full gap-2">
        <button type="button" className="btn btn-primary btn-sm flex-1" onClick={() => void approve()} disabled={busy || !!conflict || !wanted}>
          승인
        </button>
        <button type="button" className="btn btn-danger btn-sm" onClick={() => void deny()} disabled={busy}>
          거절
        </button>
      </div>
    </li>
  );
}
