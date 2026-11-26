// 비서실: 중앙 에이전트 풀(신원·상태·소속 방) + 승인 대기 + 풀 초대.
// 승인은 이름·권한·지난 대화 범위를 문장으로 미리 보여 주고, 폐기·거절은 확인을 거친다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Avatar } from "./Avatar.js";
import { Icon } from "./icons.js";
import { EmptyState, SectionHead } from "./ui.js";
import { useConfirm } from "./ConfirmDialog.js";
import { useToast } from "./Toast.js";
import { copyText } from "../lib/browserClipboard.js";
import { ApiError } from "../lib/api.js";
import { fmtFull, remainLabel, relTime } from "../lib/format.js";
import { agentNameConflict, poolInviteText, presenceTone } from "../lib/views.js";
import type { WorkspaceStore } from "../hooks/useWorkspace.js";
import type { Invite, JoinRequest, PoolAgent, RoomCard, Workspace } from "../lib/types.js";

interface Props {
  store: WorkspaceStore;
  workspace: Workspace;
  rooms: RoomCard[];
  focus: { kind: "agent" | "invite"; id?: string } | null;
  onClearFocus: () => void;
  onCreatedPoolInvite: (link: string) => void;
  onOpenRoom: (roomId: string) => void;
}

export function DeskView({ store, workspace, rooms, focus, onClearFocus, onCreatedPoolInvite, onOpenRoom }: Props) {
  const lobbyId = workspace.lobby_room_id ?? "";
  const lobbyName = rooms.find((r) => r.id === lobbyId)?.name ?? "로비";
  const [placing, setPlacing] = useState<PoolAgent | null>(null);
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const inviteRef = useRef<HTMLDivElement | null>(null);
  const agentRefs = useRef(new Map<string, HTMLElement>());
  const notify = useToast();
  const confirm = useConfirm();

  const listInvites = store.listInvites;
  const loadInvites = useCallback(async () => {
    if (!lobbyId) return;
    try {
      setInvites(await listInvites(lobbyId));
    } catch {
      setInvites([]);
    }
  }, [lobbyId, listInvites]);

  useEffect(() => {
    void loadInvites();
  }, [loadInvites]);

  useEffect(() => {
    if (!focus) return;
    if (focus.kind === "invite") inviteRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    if (focus.kind === "agent" && focus.id) agentRefs.current.get(focus.id)?.scrollIntoView({ block: "center", behavior: "smooth" });
    onClearFocus();
  }, [focus, onClearFocus]);

  const live = store.pool.filter((a) => a.status !== "revoked");
  const revoked = store.pool.filter((a) => a.status === "revoked");

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
    <div className="page">
      <div className="page-tools">
        <p className="page-summary">
          비서 {live.length}명 · 방 {rooms.length}개
          {live.filter((a) => a.status === "unclaimed").length ? ` · 연결 대기 ${live.filter((a) => a.status === "unclaimed").length}명` : ""}
        </p>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            inviteRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
            inviteRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
          }}
        >
          <Icon name="link" size={14} /> 비서 초대
        </button>
      </div>

      <div className="desk-grid">
        <div className="desk-main">
          <section aria-labelledby="requests-head">
            <SectionHead
              title="승인 대기"
              action={store.requests.length ? <span className="pill pill-wait">{store.requests.length}건</span> : null}
            />
            {store.requests.length === 0 ? (
              <p className="desk-empty-line">대기 중인 요청이 없습니다</p>
            ) : (
              <ul className="request-list">
                {store.requests.map((q) => (
                  <RequestCard key={q.id} store={store} q={q} rooms={rooms} />
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="pool-head">
            <SectionHead title="비서" hint="방에 넣으면 그 방 대화를 받습니다" />
            {live.length === 0 ? (
              <EmptyState
                icon="bot"
                title="아직 비서가 없습니다"
                text="초대 링크를 만들어 비서에게 그대로 전달하세요."
                action={
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => inviteRef.current?.scrollIntoView({ block: "start", behavior: "smooth" })}
                  >
                    <Icon name="link" size={14} /> 초대 링크 만들기
                  </button>
                }
              />
            ) : (
              <ul className="agent-grid">
                {live.map((a) => {
                  const tone = presenceTone(a.status, a.last_seen);
                  return (
                    <li
                      key={a.id}
                      className={"agent-card" + (focus?.kind === "agent" && focus.id === a.id ? " is-focus" : "")}
                      ref={(el) => {
                        if (el) agentRefs.current.set(a.id, el);
                        else agentRefs.current.delete(a.id);
                      }}
                    >
                      <div className="agent-card-head">
                        <Avatar name={a.name} />
                        <div className="min-w-0 flex-1">
                          <p className="agent-card-name">
                            {a.name}
                            {a.product_self_declared ? <span className="tag">{a.product_self_declared}</span> : null}
                          </p>
                          <p className="agent-card-status">
                            <span className="dot" data-tone={tone} aria-hidden="true" />
                            {a.status === "unclaimed" || !a.last_seen ? "연결 대기" : `${relTime(a.last_seen)} 접속`}
                          </p>
                        </div>
                      </div>
                      <div className="agent-rooms">
                        {a.rooms.filter((r) => r.status !== "removed").length === 0 ? (
                          <span className="text-faint text-[12px]">소속 방 없음</span>
                        ) : (
                          a.rooms
                            .filter((r) => r.status !== "removed")
                            .map((r) => (
                              <button key={r.room_id} type="button" className="room-chip" onClick={() => onOpenRoom(r.room_id)}>
                                {r.room_name}
                                {r.status === "invited" ? <span className="chip-note">초대됨</span> : null}
                              </button>
                            ))
                        )}
                      </div>
                      <div className="agent-card-actions">
                        <button type="button" className="btn btn-sm" onClick={() => setPlacing(a)}>
                          <Icon name="plus" size={13} /> 방 배치
                        </button>
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => void revoke(a)}>
                          연결 끊기
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {revoked.length ? (
              <details className="revoked-box">
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

        <aside className="desk-aside">
          <div ref={inviteRef}>
            <PoolInvitePanel
              workspaceName={workspace.name}
              lobbyName={lobbyName}
              create={store.createPoolInvite}
              onCreated={(link) => {
                onCreatedPoolInvite(link);
                void loadInvites();
              }}
            />
          </div>
          <section className="aside-card mt-3">
            <div className="aside-head">
              <h2 className="section-title">초대 이력</h2>
              <span className="pill">{invites?.filter((i) => i.active).length ?? 0}개 활성</span>
            </div>
            {invites === null ? (
              <p className="desk-empty-line">불러오는 중…</p>
            ) : invites.filter((i) => (i.kind ?? "room") === "pool").length === 0 ? (
              <p className="desk-empty-line">아직 만든 초대가 없습니다</p>
            ) : (
              <ul className="invite-list">
                {[...invites]
                  .filter((i) => (i.kind ?? "room") === "pool")
                  .reverse()
                  .map((inv) => (
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
                              text: "이 링크로는 더 이상 참여 요청을 보낼 수 없습니다. 이미 요청한 사람의 승인 대기는 그대로 남습니다.",
                              ok: "폐기",
                              danger: true,
                            });
                            if (!ok) return;
                            try {
                              await store.revokeInvite(lobbyId, inv.id);
                              await loadInvites();
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
          </section>
        </aside>
      </div>

      {placing ? (
        <PlaceDialog
          agent={placing}
          rooms={rooms}
          lobbyId={lobbyId}
          onClose={() => setPlacing(null)}
          onSubmit={async (roomIds, opts) => {
            await store.placeAgent(placing.id, roomIds, opts);
            notify(`"${placing.name}" 비서를 ${roomIds.length}개 방에 배치했습니다.`);
            setPlacing(null);
          }}
        />
      ) : null}
    </div>
  );
}

function requestPreview(scope: string, history: string): string {
  const canRead = scope !== "wo";
  const canWrite = scope !== "ro";
  const what =
    canRead && canWrite
      ? "대화를 읽고 답장할 수 있습니다"
      : canRead
        ? "대화를 읽기만 하고 말은 못 합니다"
        : canWrite
          ? "말은 할 수 있지만 지난 대화는 읽지 못합니다"
          : "대화를 읽지도 쓰지도 못합니다";
  const hist = !canRead ? "읽기 권한이 없어 지난 대화는 공개되지 않습니다." : history === "all" ? "지난 대화 전체를 봅니다." : "지난 대화는 보지 못합니다(참여 이후부터).";
  return `지금부터 ${what}. ${hist}`;
}

function RequestCard({ store, q, rooms }: { store: WorkspaceStore; q: JoinRequest; rooms: RoomCard[] }) {
  const notify = useToast();
  const confirm = useConfirm();
  const [history, setHistory] = useState("none");
  const [scope, setScope] = useState("rw");
  const [name, setName] = useState(q.display_name);
  const [busy, setBusy] = useState(false);
  // 입력하는 순간 풀의 기존 이름과 대조한다(승인 버튼을 누른 뒤 409 로 알게 되던 것을 앞당긴다).
  const conflict = q.existing_agent ? null : agentNameConflict(store.pool, name, q.agent_id);

  const approve = async () => {
    const wanted = name.trim();
    if (!wanted) {
      notify("비서 이름을 입력하세요.");
      return;
    }
    if (conflict) {
      notify(`'${conflict}' 이름은 이미 쓰고 있습니다. 다른 이름으로 승인하세요.`);
      return;
    }
    const target = rooms.find((r) => r.id === q.room_id);
    const ok = await confirm({
      title: "참여를 승인할까요?",
      text: `${wanted} — ${requestPreview(scope, history)}${target ? `\n입구: '${target.name}'` : ""}\n승인 뒤 권한을 바꾸려면 이 방의 구성원 관리에서 조정하세요.`,
      ok: "승인",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const approved = await store.approve(q.id, {
        history: history as "all" | "none",
        can_read: scope !== "wo",
        can_write: scope !== "ro",
        name: q.existing_agent || wanted === q.display_name.trim() ? undefined : wanted,
      });
      notify(`${approved} 님을 승인했습니다. 상대가 연결하면 대화할 수 있습니다.`);
    } catch (e) {
      if (e instanceof ApiError && e.code === "name_taken") {
        notify(`'${wanted}' 이름은 이미 쓰고 있습니다. 이름을 바꿔 다시 승인하세요.`);
      } else {
        notify(e instanceof Error ? e.message : "승인하지 못했습니다.");
      }
    } finally {
      setBusy(false);
    }
  };

  const deny = async () => {
    const ok = await confirm({
      title: "요청을 거절할까요?",
      text: `${q.display_name} 님의 참여 요청을 거절합니다. 상대에게는 거절로 표시됩니다.`,
      ok: "거절",
      danger: true,
    });
    if (!ok) return;
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
            {q.kind === "pool" ? <span className="tag">초대</span> : null}
            {q.existing_agent ? <span className="tag">이미 연결됨</span> : null}
          </p>
          <p className="text-[11.5px] text-faint">
            {fmtFull(q.created_at)} 요청
            {q.room_name ? ` · ${q.room_name}` : ""}
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
          placeholder={q.display_name}
        />
        <p className="mt-1 text-[11px] leading-relaxed text-faint">
          {q.existing_agent
            ? "이미 연결된 비서 · 이 방에만 추가"
            : conflict
              ? "이름을 바꾸면 바로 승인할 수 있습니다."
              : ""}
        </p>
        {conflict ? (
          <p className="mt-1 text-[11px] leading-relaxed auth-error" role="alert">
            '{conflict}' 이름의 비서가 이미 있습니다. 다른 이름으로 승인하세요.
          </p>
        ) : null}
      </div>
      <div className="grid w-full grid-cols-2 gap-2">
        <div>
          <label className="label" htmlFor={`h-${q.id}`}>
            지난 대화 공개
          </label>
          <select id={`h-${q.id}`} className="field text-[12.5px]" value={history} disabled={scope === "wo"} onChange={(e) => setHistory(e.target.value)}>
            <option value="none">지난 대화 없음</option>
            <option value="all">지난 대화 전체</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`s-${q.id}`}>
            권한
          </label>
          <select id={`s-${q.id}`} className="field text-[12.5px]" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="rw">읽기·쓰기</option>
            <option value="ro">읽기만</option>
            <option value="wo">쓰기만</option>
          </select>
        </div>
      </div>
      <p className="w-full rounded-md bg-surface px-2 py-1.5 text-[11.5px] leading-relaxed text-muted">{requestPreview(scope, history)}</p>
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

export function PoolInvitePanel({
  workspaceName,
  lobbyName,
  create,
  onCreated,
  roomName,
  scopeLabel,
}: {
  workspaceName: string;
  lobbyName: string;
  create: (ttlHours: number, maxUses: number) => Promise<{ invite_token: string; expires_at: string; max_uses: number }>;
  onCreated: (link: string) => void;
  roomName?: string;
  scopeLabel?: string;
}) {
  const notify = useToast();
  const [ttl, setTtl] = useState(72);
  const [maxUses, setMaxUses] = useState(10);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<{ link: string; delivery: string; expires: string; max: number } | null>(null);

  const copy = async (text: string, msg: string) => {
    const ok = await copyText(text);
    notify(ok ? msg : "복사하지 못했습니다. 값을 직접 선택해 복사하세요.");
  };

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await create(ttl, maxUses);
      const link = `${location.origin}/join/${res.invite_token}`;
      setFresh({
        link,
        delivery: roomName ? `${workspaceName} 의 방 '${roomName}'에 비서를 초대합니다.\n${link}` : poolInviteText(workspaceName, lobbyName, link),
        expires: res.expires_at,
        max: res.max_uses,
      });
      onCreated(link);
      notify("초대 링크를 만들었습니다. '전달 문장 복사'로 상대 비서에게 보내세요.");
    } catch (e) {
      notify(e instanceof Error ? e.message : "초대를 만들지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="aside-card" aria-label="비서 초대">
      <div className="aside-head">
        <h2 className="section-title">비서 초대</h2>
        {scopeLabel ? <span className="pill">{scopeLabel}</span> : null}
      </div>
      <p className="panel-note">링크는 만든 직후에만 보입니다</p>
      <div className="grid grid-cols-2 gap-2 mt-2">
        <div>
          <label className="label" htmlFor="pool-inv-ttl">
            유효 시간
          </label>
          <select id="pool-inv-ttl" className="field text-[13px]" value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
            <option value={24}>24시간</option>
            <option value={72}>3일</option>
            <option value={168}>7일</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="pool-inv-max">
            최대 사용
          </label>
          <select id="pool-inv-max" className="field text-[13px]" value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))}>
            <option value={1}>1회</option>
            <option value={3}>3회</option>
            <option value={10}>10회</option>
          </select>
        </div>
      </div>
      <button type="button" className="btn btn-primary w-full mt-2" onClick={() => void run()} disabled={busy}>
        <Icon name="plus" size={14} /> {busy ? "만드는 중…" : "초대 링크 만들기"}
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
              onClick={() => void copy(fresh.delivery, "전달 문장을 복사했습니다. 상대에게 그대로 붙여넣으세요.")}
            >
              <Icon name="copy" size={13} /> 전달 문장 복사
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function PlaceDialog({
  agent,
  rooms,
  lobbyId,
  onClose,
  onSubmit,
}: {
  agent: PoolAgent;
  rooms: RoomCard[];
  lobbyId: string;
  onClose: () => void;
  onSubmit: (roomIds: string[], opts: { history: "all" | "none"; can_read: boolean; can_write: boolean }) => Promise<void>;
}) {
  const current = useMemo(
    () => new Set(agent.rooms.filter((r) => r.status !== "removed").map((r) => r.room_id)),
    [agent],
  );
  const [selected, setSelected] = useState<Set<string>>(() => new Set([...current, lobbyId].filter(Boolean)));
  const [history, setHistory] = useState<"all" | "none">("none");
  const [canRead, setCanRead] = useState(true);
  const [canWrite, setCanWrite] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Esc로도 닫는다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".palette-backdrop")) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async () => {
    // 이미 참여 중인 방을 다시 보내면 그 방의 권한이 기본값(읽기·쓰기)으로 덮인다.
    // 그래서 새로 넣을 방만 보내고, 기존 방의 권한은 방 인스펙터에서 따로 바꾼다.
    const ids = [...selected].filter((id) => id && !current.has(id));
    if (!ids.length) {
      setError("선택한 방에 이미 모두 참여하고 있습니다. 권한은 그 방의 구성원 패널에서 바꾸세요.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSubmit(ids, { history, can_read: canRead, can_write: canWrite });
    } catch (e) {
      setError(e instanceof Error ? e.message : "배치하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="place-title">
        <div className="dialog-head">
          <h2 id="place-title" className="text-[15px] font-extrabold">
            {agent.name} 방 배치
          </h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="닫기">
            <Icon name="close" size={16} />
          </button>
        </div>
        <p className="panel-note mt-1">
          새로 넣을 방만 저장합니다. 이미 참여한 방 권한은 그 방의 구성원 패널에서 바꾸세요.
        </p>
        <ul className="place-list">
          {rooms.map((r) => {
            const isLobby = r.id === lobbyId;
            return (
              <li key={r.id}>
                <label className="place-row">
                  <input type="checkbox" checked={selected.has(r.id)} disabled={isLobby} onChange={() => toggle(r.id)} />
                  <span className="min-w-0 flex-1">
                    <span className="font-semibold">{r.name}</span>
                    <span className="text-[11.5px] text-faint"> {r.kind === "lobby" ? "· 로비(항상 포함)" : current.has(r.id) ? "· 이미 참여" : ""}</span>
                  </span>
                  <span className="pill">비서 {r.member_count}</span>
                </label>
              </li>
            );
          })}
        </ul>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <div>
            <label className="label" htmlFor="place-history">
              지난 대화
            </label>
            <select id="place-history" className="field text-[12.5px]" value={history} onChange={(e) => setHistory(e.target.value as "all" | "none")}>
              <option value="none">지난 대화 없음</option>
              <option value="all">지난 대화 전체</option>
            </select>
          </div>
          <div>
            <label className="label">권한</label>
            <div className="flex gap-2">
              <label className="check-inline">
                <input type="checkbox" checked={canRead} onChange={(e) => setCanRead(e.target.checked)} /> 읽기
              </label>
              <label className="check-inline">
                <input type="checkbox" checked={canWrite} onChange={(e) => setCanWrite(e.target.checked)} /> 쓰기
              </label>
            </div>
          </div>
        </div>
        {error ? (
          <p role="alert" className="auth-error mt-2">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            취소
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? "배치 중…" : "배치"}
          </button>
        </div>
      </div>
    </div>
  );
}
