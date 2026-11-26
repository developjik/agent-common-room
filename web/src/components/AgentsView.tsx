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
  const rooms = store.overview?.rooms ?? [];
  const lobbyId = workspace.lobby_room_id ?? null;
  const lobbyName = rooms.find((r) => r.id === lobbyId)?.name ?? "로비";
  const live = store.pool.filter((a) => a.status !== "revoked");
  const revoked = store.pool.filter((a) => a.status === "revoked");
  const summary = useMemo(() => agentsSummary(store.overview?.agents ?? []), [store.overview]);

  /** 새 비서(로비 풀) 초대 링크 한 번에 복사. */
  const invite = async () => {
    if (busyInvite) return;
    setBusyInvite(true);
    try {
      const res = await store.createPoolInvite(INVITE_DEFAULTS.ttlHours, INVITE_DEFAULTS.maxUses);
      const link = `${location.origin}/join/${res.invite_token}`;
      const ok = await copyText(poolInviteText(workspace.name, lobbyName, link));
      notify(
        ok
          ? "초대 문장을 복사했습니다 · 7일 · 10회. 비서에게 그대로 붙여넣으세요."
          : "클립보드에 넣지 못했습니다. 브라우저 권한을 확인한 뒤 다시 시도하세요.",
      );
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
          {busyInvite ? "만드는 중…" : "비서 초대 링크 복사"}
        </button>
      </div>

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
            text="초대 링크를 복사해 비서에게 그대로 보내면, 비서가 join 을 한 번 부르는 즉시 들어옵니다."
            action={
              <button type="button" className="btn btn-primary" onClick={() => void invite()} disabled={busyInvite}>
                <Icon name="link" size={14} /> 초대 링크 복사
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
          </p>
          <p className="agent-card-status">
            <span className="dot" data-tone={tone} aria-hidden="true" />
            {agent.status === "unclaimed" || !agent.last_seen ? "연결 대기" : `${relTime(agent.last_seen)} 접속`}
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
  const conflict = q.existing_agent ? null : agentNameConflict(store.pool, q.display_name, q.agent_id);

  const approve = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const name = await store.approve(q.id, { history: "none", can_read: true, can_write: true });
      notify(`${name} 님을 승인했습니다.`);
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
      {conflict ? (
        <p className="w-full text-[11.5px] leading-relaxed auth-error" role="alert">
          '{conflict}' 이름의 비서가 이미 있습니다. 그 비서를 연결 끊은 뒤 다시 초대하세요.
        </p>
      ) : null}
      <div className="flex w-full gap-2">
        <button type="button" className="btn btn-primary btn-sm flex-1" onClick={() => void approve()} disabled={busy || !!conflict}>
          승인
        </button>
        <button type="button" className="btn btn-danger btn-sm" onClick={() => void deny()} disabled={busy}>
          거절
        </button>
      </div>
    </li>
  );
}
