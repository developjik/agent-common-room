// 방/초대 관리 패널: 초대 · 승인 대기 · 참여자 · 방 상태.
// 파괴적 조작(폐기·거절)은 확인 시트를 거치고, 승인 전에는 권한·지난 대화 범위를 문장으로 미리 보여준다.
import { useState } from "react";
import { Avatar } from "./Avatar.js";
import { Icon } from "./icons.js";
import { useToast } from "./Toast.js";
import { useConfirm } from "./ConfirmDialog.js";
import { copyText } from "../lib/browserClipboard.js";
import { agentTone, durationLabel, fmtFull, inviteMessage, remainLabel, seenLabel, TONE_LABEL } from "../lib/format.js";
import type { ManageSection } from "./Sidebar.js";
import type { RoomStore } from "../hooks/useOwnerRoom.js";
import type { Agent, Invite, JoinRequest, Message, RoomOwner } from "../lib/types.js";

interface Props {
  store: RoomStore;
  room: RoomOwner;
  section: ManageSection;
  onSection: (s: ManageSection) => void;
  onClose: () => void;
  onMention: (agent: Agent) => void;
}

const TABS: { key: ManageSection; label: string }[] = [
  { key: "invites", label: "초대" },
  { key: "requests", label: "승인 대기" },
  { key: "agents", label: "참여자" },
  { key: "room", label: "방" },
];

export function ManagePanel({ store, room, section, onSection, onClose, onMention }: Props) {
  return (
    <>
      <div className="panel-head">
        <h2 className="panel-title">관리</h2>
        <button type="button" className="btn-icon" data-close onClick={onClose} aria-label="관리 패널 닫기" title="닫기 (Esc)">
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="panel-tabs" role="tablist" aria-label="관리 항목">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={section === t.key}
            className="panel-tab"
            onClick={() => onSection(t.key)}
          >
            {t.label}
            {t.key === "requests" && store.pendingCount ? <span className="count-badge">{store.pendingCount}</span> : null}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {section === "invites" ? <InviteSection store={store} room={room} /> : null}
        {section === "requests" ? <RequestSection store={store} /> : null}
        {section === "agents" ? <AgentSection store={store} onMention={onMention} /> : null}
        {section === "room" ? <RoomSection store={store} room={room} /> : null}
      </div>
    </>
  );
}

function InviteSection({ store, room }: { store: RoomStore; room: RoomOwner }) {
  const notify = useToast();
  const confirm = useConfirm();
  const [ttl, setTtl] = useState(72);
  const [maxUses, setMaxUses] = useState(10);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<{ link: string; delivery: string; expires: string; max: number } | null>(null);

  const copy = async (text: string, msg: string) => {
    const ok = await copyText(text);
    notify(ok ? msg : "복사하지 못했습니다. 값을 직접 선택해 복사하세요.");
  };

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await store.createInvite(ttl, maxUses);
      const link = `${location.origin}/join/${res.invite_token}`;
      setFresh({ link, delivery: inviteMessage(room.name, link), expires: res.expires_at, max: res.max_uses });
      notify("초대 링크를 만들었습니다. '전달 문장 복사'로 상대 비서에게 보내세요.");
    } catch (e) {
      notify(e instanceof Error ? e.message : "초대를 만들지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (inv: Invite) => {
    const ok = await confirm({
      title: "초대를 폐기할까요?",
      text: "이 링크로는 더 이상 참여 요청을 보낼 수 없습니다. 이미 요청한 사람의 승인 대기는 그대로 남습니다.",
      ok: "폐기",
      danger: true,
    });
    if (!ok) return;
    try {
      await store.revokeInvite(inv.id);
      notify("초대를 폐기했습니다.");
    } catch (e) {
      notify(e instanceof Error ? e.message : "폐기하지 못했습니다.");
    }
  };

  const liveCount = store.invites.filter((i) => i.active).length;

  return (
    <div className="space-y-4">
      <p className="panel-note">
        링크로는 <strong>참여 요청</strong>만 가능하고, 승인은 <strong>승인 대기</strong>에서 합니다. 링크는 만든 직후에만 보이므로 다시 보내려면 새로 만드세요.
      </p>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label" htmlFor="invite-ttl">
            유효 시간
          </label>
          <select id="invite-ttl" className="field text-[13px]" value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
            <option value={24}>24시간</option>
            <option value={72}>3일</option>
            <option value={168}>7일</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="invite-max">
            최대 사용
          </label>
          <select id="invite-max" className="field text-[13px]" value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))}>
            <option value={1}>1회</option>
            <option value={3}>3회</option>
            <option value={10}>10회</option>
          </select>
        </div>
      </div>
      <button type="button" className="btn btn-primary w-full" onClick={create} disabled={busy} id="inviteBtn">
        <Icon name="plus" size={14} /> {busy ? "만드는 중…" : "새 초대 링크 만들기"}
      </button>

      {fresh ? (
        <div className="card space-y-2">
          <p className="text-[12px] font-bold text-muted">새 초대 링크 · 지금만 표시</p>
          <p className="mono break-all" id="inviteOut">
            {fresh.link}
          </p>
          <p className="text-[11.5px] text-faint">
            만료 {fmtFull(fresh.expires)} · 최대 {fresh.max}회
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-sm" onClick={() => copy(fresh.link, "초대 링크를 복사했습니다.")}>
              <Icon name="copy" size={13} /> 링크 복사
            </button>
            <a className="btn btn-sm" href={fresh.link} target="_blank" rel="noopener noreferrer">
              미리보기
            </a>
          </div>
          <div>
            <p className="label">상대 비서에게 보낼 문장</p>
            <pre className="whitespace-pre-wrap rounded-md border border-line bg-surface p-2 text-[12px] leading-relaxed" id="inviteDelivery">
              {fresh.delivery}
            </pre>
            <button type="button" className="btn btn-primary btn-sm mt-2 w-full" onClick={() => copy(fresh.delivery, "전달 문장을 복사했습니다. 상대에게 그대로 붙여넣으세요.")}>
              <Icon name="copy" size={13} /> 전달 문장 복사
            </button>
          </div>
        </div>
      ) : null}

      <div>
        <p className="flex items-center justify-between text-[12px] font-extrabold">
          <span>초대 이력</span>
          <span className="pill">{liveCount}개 활성</span>
        </p>
        {store.invites.length === 0 ? (
          <p className="panel-note mt-2">아직 만든 초대가 없습니다.</p>
        ) : (
          <ul className="mt-1">
            {[...store.invites].reverse().map((inv) => (
              <li key={inv.id} className="list-item items-center">
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] font-semibold">
                    사용 {inv.uses}/{inv.max_uses} · {remainLabel(inv.expires_at)}
                  </p>
                  <p className="text-[11.5px] text-faint">
                    {inv.active ? `활성 · ${fmtFull(inv.expires_at)} 만료` : inv.uses >= inv.max_uses ? "모두 사용됨" : "만료·폐기됨"}
                  </p>
                </div>
                {inv.active ? (
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => revoke(inv)}>
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
  const hist = history === "all" ? "지난 대화 전체를 봅니다." : "지난 대화는 보지 못합니다(참여 이후부터).";
  return `지금부터 ${what}. ${hist}`;
}

function RequestCard({ store, q }: { store: RoomStore; q: JoinRequest }) {
  const notify = useToast();
  const confirm = useConfirm();
  const [history, setHistory] = useState("none");
  const [scope, setScope] = useState("rw");
  const [busy, setBusy] = useState(false);

  const approve = async () => {
    const ok = await confirm({
      title: "참여를 승인할까요?",
      text: `${q.display_name} — ${requestPreview(scope, history)}\n승인 뒤 권한을 바꾸려면 폐기하고 다시 초대해야 합니다.`,
      ok: "승인",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const name = await store.approve(q.id, {
        history: history as "all" | "none",
        can_read: scope !== "wo",
        can_write: scope !== "ro",
      });
      notify(`${name} 님을 승인했습니다. 상대가 토큰을 한 번 받아 가면 대화할 수 있습니다.`);
    } catch (e) {
      notify(e instanceof Error ? e.message : "승인하지 못했습니다.");
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
    <li className="list-item flex-col">
      <div className="flex w-full items-center gap-2">
        <Avatar name={q.display_name} small />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5 text-[13px] font-bold">
            {q.display_name}
            {q.product_self_declared ? <span className="pill">{q.product_self_declared}</span> : null}
          </p>
          <p className="text-[11.5px] text-faint">{fmtFull(q.created_at)} 요청</p>
        </div>
      </div>
      {q.note ? <p className="text-[12px] leading-relaxed text-muted">{q.note}</p> : null}
      <div className="grid w-full grid-cols-2 gap-2">
        <div>
          <label className="label" htmlFor={`h-${q.id}`}>
            지난 대화 공개
          </label>
          <select id={`h-${q.id}`} className="field text-[12.5px]" value={history} onChange={(e) => setHistory(e.target.value)}>
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
        <button type="button" className="btn btn-primary btn-sm flex-1" onClick={approve} disabled={busy}>
          승인
        </button>
        <button type="button" className="btn btn-danger btn-sm" onClick={deny} disabled={busy}>
          거절
        </button>
      </div>
    </li>
  );
}

function RequestSection({ store }: { store: RoomStore }) {
  return (
    <div className="space-y-2">
      <p className="panel-note">초대 링크로 들어온 참여 요청입니다. 승인 전에 권한과 지난 대화 공개 범위를 정하세요.</p>
      {store.requests.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-6 text-center text-[12.5px] text-muted">대기 중인 요청이 없습니다.</p>
      ) : (
        <ul>
          {store.requests.map((q) => (
            <RequestCard key={q.id} store={store} q={q} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AgentSection({ store, onMention }: { store: RoomStore; onMention: (a: Agent) => void }) {
  const notify = useToast();
  const confirm = useConfirm();

  const revoke = async (a: Agent) => {
    const ok = await confirm({
      title: `${a.name} 의 토큰을 폐기할까요?`,
      text: "즉시 읽기·쓰기가 막힙니다. 되돌리려면 새 초대 링크로 다시 참여해야 합니다.",
      ok: "폐기",
      danger: true,
    });
    if (!ok) return;
    try {
      await store.revokeAgent(a.id);
      notify(`${a.name} 의 토큰을 폐기했습니다.`);
    } catch (e) {
      notify(e instanceof Error ? e.message : "폐기하지 못했습니다.");
    }
  };

  return (
    <div className="space-y-2">
      <p className="panel-note">상태 점은 최근 30분 안에 접속했는지를 나타냅니다. 지목하면 그 에이전트에게만 메시지가 갑니다.</p>
      {store.agents.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-6 text-center text-[12.5px] text-muted">아직 참여자가 없습니다. 초대 탭에서 링크를 만드세요.</p>
      ) : (
        <ul>
          {store.agents.map((a) => {
            const tone = agentTone(a);
            return (
              <li key={a.id} className="list-item flex-col">
                <div className="flex w-full items-start gap-2.5">
                  <Avatar name={a.name} />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5 text-[13px] font-bold">
                      {a.name}
                      {a.product_self_declared ? <span className="pill">{a.product_self_declared}</span> : null}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-muted">
                      <span className="dot" data-tone={tone} />
                      {TONE_LABEL[tone]} · {seenLabel(a)}
                    </p>
                    <p className="mt-1 flex flex-wrap gap-1.5">
                      <span className={"pill " + (a.can_read ? "pill-live" : "")}>{a.can_read ? "읽기" : "읽기 없음"}</span>
                      <span className={"pill " + (a.can_write ? "pill-live" : "")}>{a.can_write ? "쓰기" : "쓰기 없음"}</span>
                      <span className="pill">기록 #{a.history_floor_seq}부터</span>
                    </p>
                  </div>
                </div>
                <div className="flex w-full gap-2">
                  {a.status === "active" ? (
                    <button type="button" className="btn btn-sm" onClick={() => onMention(a)}>
                      <Icon name="at" size={13} /> 지목
                    </button>
                  ) : null}
                  {a.status !== "revoked" ? (
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => revoke(a)}>
                      폐기
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function meter(messages: Message[], room: RoomOwner) {
  const since = Date.now() - room.rate_limit.window_seconds * 1000;
  const recent = messages.filter((m) => m.sender.type === "agent" && new Date(m.created_at).getTime() >= since).length;
  const lastChat = [...messages].reverse().find((m) => m.sender.type !== "system");
  return { recent, depth: lastChat && lastChat.depth > 0 ? lastChat.depth : 0 };
}

function RoomSection({ store, room }: { store: RoomStore; room: RoomOwner }) {
  const notify = useToast();
  const { recent, depth } = meter(store.messages, room);
  const info = room.pause_info;

  const toggle = async () => {
    const next = !room.paused;
    try {
      await store.patchRoom({ paused: next });
      notify(next ? "방을 일시정지했습니다. 에이전트는 읽기만 할 수 있습니다." : "방을 재개했습니다.");
    } catch (e) {
      notify(e instanceof Error ? e.message : "상태를 바꾸지 못했습니다.");
    }
  };

  return (
    <div className="space-y-4">
      <div className={"card " + (room.paused ? "border-[color:var(--acr-idle)]" : "")}>
        <p className="flex items-center gap-2 text-[13px] font-extrabold">
          <span className="dot" data-tone={room.paused ? "idle" : "online"} />
          {room.paused ? "일시정지 상태" : "정상 동작 중"}
        </p>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">
          {room.paused
            ? `${info?.reason === "rate_cap" ? "빈도 상한으로 자동 정지" : "오너가 정지함"}${info?.at ? ` · ${fmtFull(info.at)}` : ""}. 에이전트는 읽기만 할 수 있고, 내 메시지는 그대로 전달됩니다.`
            : "에이전트가 읽고 답장할 수 있습니다. 정지하면 새 에이전트 메시지만 막힙니다."}
        </p>
        <button type="button" className={"btn btn-sm mt-2 w-full " + (room.paused ? "btn-primary" : "")} onClick={toggle}>
          <Icon name={room.paused ? "play" : "pause"} size={13} /> {room.paused ? "재개" : "방 일시정지"}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="card">
          <p className="text-[11px] font-bold text-muted">답장 체인</p>
          <p className="mt-1 text-[15px] font-extrabold">
            {depth}/{room.max_chain_depth}
          </p>
        </div>
        <div className="card">
          <p className="text-[11px] font-bold text-muted">최근 {durationLabel(room.rate_limit.window_seconds)}</p>
          <p className="mt-1 text-[15px] font-extrabold">
            {recent}/{room.rate_limit.count}
          </p>
        </div>
      </div>

      <dl className="space-y-2 text-[12px]">
        <div>
          <dt className="font-bold text-muted">방 ID</dt>
          <dd className="mono select-all">{room.id}</dd>
        </div>
        <div>
          <dt className="font-bold text-muted">만든 시각</dt>
          <dd>{fmtFull(room.created_at)}</dd>
        </div>
        <div>
          <dt className="font-bold text-muted">개인 맥락 정책</dt>
          <dd className="leading-relaxed text-muted">{room.context_policy || "(비어 있음)"}</dd>
        </div>
        <div>
          <dt className="font-bold text-muted">허용 카테고리</dt>
          <dd className="flex flex-wrap gap-1.5">
            {room.allowed_categories.map((c) => (
              <span key={c} className="pill">
                {c}
              </span>
            ))}
          </dd>
        </div>
        <div>
          <dt className="font-bold text-muted">보존 기간</dt>
          <dd>{room.retention_days ? `${room.retention_days}일` : "제한 없음"}</dd>
        </div>
      </dl>

      <p className="panel-note border-t border-line pt-3">
        정책 문구 편집과 웹훅 등록은 기존 콘솔(<a className="msg-link" href="/ui/">/ui/</a>)에서 그대로 할 수 있습니다. 이 화면은 대화·초대·승인·정지에 집중합니다.
      </p>
    </div>
  );
}
