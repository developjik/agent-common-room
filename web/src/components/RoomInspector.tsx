// 방 인스펙터: 구성원(권한·DM 고정·내보내기) · 방(상태·한도·이름/설명) · 초대.
import { useCallback, useEffect, useState } from "react";
import { Avatar } from "./Avatar.js";
import { Icon } from "./icons.js";
import { useToast } from "./Toast.js";
import { useConfirm } from "./ConfirmDialog.js";
import { copyText } from "../lib/browserClipboard.js";
import { room as roomApi } from "../lib/api.js";
import { agentTone, durationLabel, fmtFull, historyFloorLabel, remainLabel, seenLabel } from "../lib/format.js";
import { memberToAgent, roomInviteText } from "../lib/views.js";
import type { WorkspaceStore } from "../hooks/useWorkspace.js";
import type { Invite, RoomDetail, Webhook, Workspace } from "../lib/types.js";

type Tab = "members" | "room" | "invite";

/**
 * 웹훅 카드의 상태 한 줄. pending 만 보여 주면 "시험 직후 대기"가 정상인지 실패인지 알 수 없어서
 * 전달됨·실패·대기를 구분하고 시도 횟수를 덧붙인다.
 */
function webhookStatus(h: Webhook): string {
  if (!h.last_kind) return "아직 전달 기록 없음";
  const what = h.last_kind === "ping" ? "시험" : "새 글";
  const tries = h.last_attempts && h.last_attempts > 1 ? ` · 시도 ${h.last_attempts}회` : "";
  if (h.last_status === "ok") return `${what} · 전달됨${tries}`;
  if (h.last_status === "failed") return `${what} · 전달 실패${tries}`;
  return `${what} · 전달 대기${tries}`;
}

interface Props {
  store: WorkspaceStore;
  room: RoomDetail;
  workspace: Workspace;
  recipient: string;
  onClose: () => void;
  onMention: (a: { id: string; name: string; status: string }) => void;
  onOpenRoom: (roomId: string) => void;
  onCreateRoom: () => void;
  onDeleteRoom: (room: RoomDetail) => void;
}

export function RoomInspector({ store, room, workspace, recipient, onClose, onMention, onOpenRoom, onCreateRoom, onDeleteRoom }: Props) {
  const [tab, setTab] = useState<Tab>("members");
  const members = room.members.filter((m) => m.status !== "removed");

  return (
    <>
      <div className="panel-head">
        <div className="min-w-0 flex-1">
          <h2 className="panel-title">이 방</h2>
          <p className="truncate text-[11px] text-muted">
            {room.kind === "lobby" ? "로비" : "방"} · 비서 {members.filter((m) => m.status === "active").length}명
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
          <RoomSettings store={store} room={room} onDeleteRoom={onDeleteRoom} />
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
      title: `"${name}" 비서를 이 방에서 내보낼까요?`,
      text: "토큰은 그대로라 다른 방에서는 계속 활동합니다. 다시 넣으려면 비서실에서 방에 배치하세요.",
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
    <div className="space-y-3">
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
                  <p className="member-meta" title={historyFloorLabel(a.history_floor_seq)}>
                    {seenLabel(a)}
                  </p>
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
  onDeleteRoom,
}: {
  store: WorkspaceStore;
  room: RoomDetail;
  onDeleteRoom: (room: RoomDetail) => void;
}) {
  const notify = useToast();
  const [name, setName] = useState(room.name);
  const [description, setDescription] = useState(room.description);
  const [policy, setPolicy] = useState(room.context_policy);
  const [categories, setCategories] = useState(room.allowed_categories.join(", "));
  const [retention, setRetention] = useState(room.retention_days ? String(room.retention_days) : "");
  const [busy, setBusy] = useState(false);
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [hookUrl, setHookUrl] = useState("");
  const [hookBusy, setHookBusy] = useState(false);
  const [freshHook, setFreshHook] = useState<{ id: string; url: string; secret: string } | null>(null);

  // allowed_categories 는 폴링마다 새 배열이라 그대로 의존성에 두면 4초마다 입력이 서버 값으로 되돌아간다.
  const catsKey = room.allowed_categories.join(",");
  // 저장 범위를 둘로 나눠 두었으므로(이름·설명 / 고급) 서버 값 동기화도 같은 범위로 나눈다.
  // 이름만 저장했을 때 접힌 고급 설정의 편집 중인 초안이 조용히 호기지 않게 한다.
  useEffect(() => {
    setName(room.name);
    setDescription(room.description);
  }, [room.name, room.description]);
  useEffect(() => {
    setPolicy(room.context_policy);
    setCategories(catsKey.replace(/,/g, ", "));
    setRetention(room.retention_days ? String(room.retention_days) : "");
  }, [room.context_policy, catsKey, room.retention_days]);

  const since = Date.now() - room.rate_limit.window_seconds * 1000;
  const recent = store.messages.filter((m) => m.sender.type === "agent" && new Date(m.created_at).getTime() >= since).length;
  const lastChat = [...store.messages].reverse().find((m) => m.sender.type !== "system");
  const depth = lastChat && lastChat.depth > 0 ? lastChat.depth : 0;
  const paused = room.paused;
  const depthRatio = room.max_chain_depth ? depth / room.max_chain_depth : 0;
  const rateRatio = room.rate_limit.count ? recent / room.rate_limit.count : 0;
  const nearLimit = depthRatio >= 0.8 || rateRatio >= 0.8;
  const warning = depthRatio >= 0.8 ? `답장 체인 ${depth}/${room.max_chain_depth}` : `최근 ${durationLabel(room.rate_limit.window_seconds)} ${recent}/${room.rate_limit.count}`;

  /**
   * 기본 저장: 이름·설명만 보낸다.
   * 예전에는 한 저장 버튼이 맥락 정책·카테고리·보존 기간까지 함께 보냈는데, 고급 설정을 접어 두면
   * 보이지 않는 입력값이 함께 적용돼 이름만 바꿔도 메시지가 삭제될 수 있었다(보존 기간 축소).
   */
  const saveBasic = async () => {
    if (busy) return;
    if (!name.trim()) {
      notify("방 이름을 입력하세요.");
      return;
    }
    setBusy(true);
    try {
      await store.patchRoom(room.id, { name: name.trim(), description });
      notify("방 이름과 설명을 저장했습니다.");
    } catch (e) {
      notify(e instanceof Error ? e.message : "저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  /** 고급 저장: 맥락 정책·허용 카테고리·보존 기간만. */
  const saveAdvanced = async () => {
    if (busy) return;
    const days = retention.trim();
    if (days && (!/^\d+$/.test(days) || Number(days) < 1 || Number(days) > 3650)) {
      notify("보존 기간은 1~3650일 숫자이거나 비워 두세요.");
      return;
    }
    setBusy(true);
    try {
      await store.patchRoom(room.id, {
        context_policy: policy,
        allowed_categories: categories.split(",").map((c) => c.trim()).filter(Boolean),
        retention_days: days ? Number(days) : null,
      });
      notify("고급 설정을 저장했습니다.");
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

  const loadHooks = useCallback(async () => {
    try {
      setHooks((await roomApi.webhooks(room.id)).webhooks);
    } catch {
      setHooks([]);
    }
  }, [room.id]);

  useEffect(() => {
    void loadHooks();
  }, [loadHooks]);

  // 웹훅은 v2 인스펙터에서 직접 다룬다(예전에는 /ui/ + 방 복구 코드가 필요했는데 v2 에서 코드를 보여 주지 않았다).
  const addHook = async () => {
    if (hookBusy) return;
    const url = hookUrl.trim();
    if (!/^https:\/\//i.test(url)) {
      notify("https:// 로 시작하는 URL을 넣으세요.");
      return;
    }
    setHookBusy(true);
    try {
      const created = await roomApi.createWebhook(room.id, url);
      setFreshHook({ id: created.id, url: created.url, secret: created.secret });
      setHookUrl("");
      await loadHooks();
      notify("웹훅을 등록했습니다. 서명 시크릿은 지금만 보입니다.");
    } catch (e) {
      notify(e instanceof Error ? e.message : "웹훅을 등록하지 못했습니다.");
    } finally {
      setHookBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="status-box" data-paused={paused ? "true" : undefined}>
        <div className="status-line">
          <span className="dot" data-tone={paused ? "paused" : "online"} aria-hidden="true" />
          <span className="status-name">{paused ? "일시정지" : "정상"}</span>
          {paused && room.pause_info?.at ? <span className="status-time">{fmtFull(room.pause_info.at)}</span> : null}
          <button type="button" className="btn btn-sm ml-auto" onClick={() => void toggle()}>
            <Icon name={paused ? "play" : "pause"} size={13} /> {paused ? "재개" : "일시정지"}
          </button>
        </div>
        <p className="panel-note mt-1">{paused ? "비서는 읽기만 합니다. 내 메시지는 그대로 전달됩니다." : "비서가 답장할 수 있습니다"}</p>
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
        <button type="button" className="btn w-full" onClick={() => void saveBasic()} disabled={busy}>
          {busy ? "저장 중…" : "저장"}
        </button>
      </div>

      {/* 웹훅·한도·맥락 정책은 매일 쓰는 화면이 아니라 '고급 설정' 하나로 접는다.
          평소 방 화면은 초대·구성원·대화만 보이게 둔다. */}
      <details className="more-box" open={nearLimit || paused}>
        <summary>고급 설정{nearLimit ? ` · ${warning}` : ""}</summary>
        <div className="mt-3 space-y-4">
          <section>
            <p className="label">한도</p>
            <div className="limit-rows">
              <span>
                답장 체인 <strong>{depth}/{room.max_chain_depth}</strong>
              </span>
              <span>
                최근 {durationLabel(room.rate_limit.window_seconds)} <strong>{recent}/{room.rate_limit.count}</strong>
              </span>
            </div>
          </section>

          <section className="space-y-2">
            <div>
              <label className="label" htmlFor="room-policy">
                개인 맥락 정책
              </label>
              <textarea
                id="room-policy"
                className="field"
                rows={3}
                maxLength={1000}
                value={policy}
                onChange={(e) => setPolicy(e.target.value)}
                placeholder="예: 개인 일정·업무 맥락은 이 방 안에서만 공유합니다."
              />
            </div>
            <div>
              <label className="label" htmlFor="room-categories">
                허용 카테고리 (쉼표)
              </label>
              <input
                id="room-categories"
                className="field mono"
                value={categories}
                onChange={(e) => setCategories(e.target.value)}
                placeholder="schedule, work, docs"
              />
              <p className="mt-1 text-[11px] leading-relaxed text-faint">소문자·밑줄 2~30자. 'none'은 항상 포함됩니다.</p>
            </div>
            <div>
              <label className="label" htmlFor="room-retention">
                보존 기간 (일, 비우면 제한 없음)
              </label>
              <input
                id="room-retention"
                className="field mono"
                inputMode="numeric"
                value={retention}
                onChange={(e) => setRetention(e.target.value)}
                placeholder="예: 30"
              />
            </div>
            <button type="button" className="btn w-full" onClick={() => void saveAdvanced()} disabled={busy}>
              {busy ? "저장 중…" : "고급 설정 저장"}
            </button>
          </section>

          <section className="space-y-2">
            <p className="label">웹훅</p>
            <p className="panel-note">
              비서에게 보낸 글(지목·답장)을 외부 서비스로 알립니다. 등록하면 서명 시크릿을 한 번 보여 줍니다(수신측 검증용).
            </p>
            <div className="flex gap-2">
              <input
                id="room-hook-url"
                className="field mono text-[12px]"
                value={hookUrl}
                onChange={(e) => setHookUrl(e.target.value)}
                placeholder="https://example.com/acr-hook"
                spellCheck={false}
                aria-label="웹훅 URL"
              />
              <button type="button" className="btn btn-sm" onClick={() => void addHook()} disabled={hookBusy}>
                {hookBusy ? "등록 중…" : "등록"}
              </button>
            </div>
            {freshHook ? (
              <div className="fresh-invite">
                <p className="text-[12px] font-bold text-muted">서명 시크릿 · 지금만 표시</p>
                <p className="mono break-all select-all">{freshHook.secret}</p>
                <button
                  type="button"
                  className="btn btn-sm mt-1"
                  onClick={async () => {
                    const ok = await copyText(freshHook.secret);
                    notify(ok ? "시크릿을 복사했습니다." : "복사하지 못했습니다. 값을 직접 선택해 복사하세요.");
                  }}
                >
                  <Icon name="copy" size={13} /> 복사
                </button>
              </div>
            ) : null}
            {hooks === null ? (
              <p className="panel-note">불러오는 중…</p>
            ) : hooks.filter((h) => h.active).length === 0 ? (
              <p className="panel-note">등록된 웹훅이 없습니다.</p>
            ) : (
              <ul className="invite-list">
                {hooks
                  .filter((h) => h.active)
                  .map((h) => (
                    <li key={h.id} className="invite-row">
                      <div className="min-w-0 flex-1">
                        <p className="mono break-all text-[11px]">{h.url}</p>
                        <p className="text-[11px] text-faint">{webhookStatus(h)}</p>
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={async () => {
                          try {
                            const r = await roomApi.testWebhook(room.id, h.id);
                            notify(`시험 전달: ${r.delivery.status}${r.delivery.http_status ? ` (HTTP ${r.delivery.http_status})` : ""}`);
                            await loadHooks();
                          } catch (e) {
                            notify(e instanceof Error ? e.message : "시험 전달을 보내지 못했습니다.");
                          }
                        }}
                      >
                        시험
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={async () => {
                          try {
                            await roomApi.revokeWebhook(room.id, h.id);
                            await loadHooks();
                            notify("웹훅을 폐기했습니다.");
                          } catch (e) {
                            notify(e instanceof Error ? e.message : "폐기하지 못했습니다.");
                          }
                        }}
                      >
                        폐기
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </section>

          <dl className="kv">
            <div>
              <dt>방 ID</dt>
              <dd className="mono select-all">{room.id}</dd>
            </div>
            <div>
              <dt>만든 시각</dt>
              <dd>{fmtFull(room.created_at)}</dd>
            </div>
          </dl>
        </div>
      </details>

      {room.kind !== "lobby" ? (
        <div className="danger-box">
          <p className="text-[12.5px] font-bold">이 방 삭제</p>
          <button type="button" className="btn btn-danger btn-sm mt-2" onClick={() => onDeleteRoom(room)}>
            <Icon name="trash" size={13} /> 방 삭제
          </button>
        </div>
      ) : (
        <p className="panel-note">로비는 삭제할 수 없습니다</p>
      )}
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
        이 방에만 들어오는 링크입니다. 승인하면 로비와 이 방에 들어옵니다.
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
        ) : invites.filter((i) => (i.kind ?? "room") === "room").length === 0 ? (
          <p className="panel-note mt-2">아직 만든 방 초대가 없습니다. 풀 초대(비서실)는 여기에 섞이지 않습니다.</p>
        ) : (
          <ul className="invite-list mt-1">
            {[...invites]
              .filter((i) => (i.kind ?? "room") === "room")
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
