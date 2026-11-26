// 방 집중 뷰: 방 전환 · 실시간 대화 · 스레드 · 컴포저 · 우측 인스펙터(구성원·방·초대).
// 기존에 검증된 안전한 동작(인용 답장·@ 자동완성·DM 고정 칩·삭제·일시정지/재개)을 그대로 유지한다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatFeed, type ChatFeedHandle } from "./ChatFeed.js";
import { Composer, type SendInput } from "./Composer.js";
import { ThreadPanel } from "./ThreadPanel.js";
import { RoomInspector } from "./RoomInspector.js";
import { Icon } from "./icons.js";
import { useToast } from "./Toast.js";
import { useConfirm } from "./ConfirmDialog.js";
import { copyText } from "../lib/browserClipboard.js";
import { durationLabel, recipientReset, threadRootOf, threadSummaries } from "../lib/format.js";
import { roomStateText } from "../lib/views.js";
import type { WorkspaceStore } from "../hooks/useWorkspace.js";
import type { Message, RoomCard, RoomDetail, Workspace } from "../lib/types.js";
import type { View } from "../lib/route.js";

type PanelState = { kind: "thread"; seq: number } | { kind: "inspector" } | null;

interface Props {
  roomId: string;
  store: WorkspaceStore;
  workspace: Workspace;
  rooms: RoomCard[];
  isWide: boolean;
  jumpSeq: number | null;
  onConsumeJump: () => void;
  onOpenRoom: (roomId: string, seq?: number) => void;
  onGoView: (view: View) => void;
  onCreateRoom: () => void;
  onDeleteRoom: (room: RoomDetail) => void;
  onOpenPalette: () => void;
}

export function RoomView({
  roomId,
  store,
  workspace,
  rooms,
  isWide,
  jumpSeq,
  onConsumeJump,
  onOpenRoom,
  onGoView,
  onCreateRoom,
  onDeleteRoom,
  onOpenPalette,
}: Props) {
  const notify = useToast();
  const confirm = useConfirm();
  const [panel, setPanel] = useState<PanelState>(null);
  const [recipient, setRecipient] = useState("");
  const [recipientNotice, setRecipientNotice] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null);
  const [focusComposer, setFocusComposer] = useState(0);
  const [flashSeq, setFlashSeq] = useState<number | null>(null);
  const [switcher, setSwitcher] = useState(false);
  const feedRef = useRef<ChatFeedHandle | null>(null);
  const sheetRef = useRef<HTMLElement | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);

  const room = store.room;
  const agents = store.agents;
  const bySeq = useMemo(() => new Map(store.messages.map((m) => [m.seq, m])), [store.messages]);
  const summaries = useMemo(() => threadSummaries(store.messages, bySeq), [store.messages, bySeq]);

  // 방을 바꾸면 이전 방의 수신자·답장 대상·패널을 남기지 않는다.
  useEffect(() => {
    setRecipient("");
    setReplyTo(null);
    setPanel(null);
  }, [roomId]);

  // Esc: 확인 시트가 열려 있으면 그쪽이 처리하고, 아니면 패널 → 방 전환 시트 순서로 닫는다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector(".dialog-backdrop")) return;
      if (panel) {
        setPanel(null);
        return;
      }
      if (switcher) setSwitcher(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panel, switcher]);

  useEffect(() => {
    if (panel && !isWide) {
      window.setTimeout(() => sheetRef.current?.querySelector<HTMLElement>("[data-close]")?.focus(), 0);
    }
  }, [panel, isWide]);

  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  // 인박스에서 넘어온 메시지로 이동(메시지가 아직 안 왔으면 올 때까지 기다린다).
  useEffect(() => {
    if (jumpSeq == null || !store.ready) return;
    if (!bySeq.has(jumpSeq)) return;
    feedRef.current?.jumpTo(jumpSeq);
    onConsumeJump();
  }, [jumpSeq, store.ready, bySeq, onConsumeJump]);

  // 폐기·미승인 비서가 수신자로 남아 있으면 방 전체로 되돌리고 알린다.
  useEffect(() => {
    const { reset, notice } = recipientReset(agents, recipient);
    if (!reset) return;
    setRecipient("");
    // 안내는 토스트로 한 번 띄우고, 초안을 보내기 전까지 칩으로 계속 보여 준다.
    if (notice) {
      setRecipientNotice(notice);
      notify(notice);
    }
  }, [agents, recipient, notify]);

  const flash = useCallback((seq: number) => {
    setFlashSeq(seq);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashSeq(null), 2000);
  }, []);

  const openThread = useCallback(
    (seq: number) => {
      const target = bySeq.get(seq);
      setPanel({ kind: "thread", seq: target ? threadRootOf(target, bySeq).seq : seq });
    },
    [bySeq],
  );

  const quoteReply = useCallback(
    (m: Message) => {
      if (recipient) {
        setRecipient("");
        notify("인용 답장은 방 전체로 보냅니다. 한 비서에게만 보내려면 받는 사람을 다시 고르세요.");
      }
      setReplyTo(m);
      setFocusComposer((n) => n + 1);
    },
    [recipient, notify],
  );

  const mention = useCallback(
    (a: { id: string; name: string; status: string }) => {
      if (a.status !== "active") {
        notify(`@${a.name} 은(는) 지금 메시지를 받을 수 없습니다. 구성원 관리에서 상태를 확인하세요.`);
        return;
      }
      setRecipient(a.id);
      setFocusComposer((n) => n + 1);
      notify(`@${a.name} 에게 보냅니다. 방 전체에 말하려면 받는 사람을 비우세요.`);
    },
    [notify],
  );

  const jumpToMessage = useCallback(
    (seq: number) => {
      if (panel && !isWide) setPanel(null);
      feedRef.current?.jumpTo(seq);
    },
    [panel, isWide],
  );

  const copyMessage = async (m: Message) => {
    const ok = await copyText(m.content ?? "");
    notify(ok ? "메시지를 복사했습니다." : "복사하지 못했습니다. 값을 직접 선택해 복사하세요.");
  };

  const deleteMessage = async (m: Message) => {
    const ok = await confirm({
      title: "메시지를 삭제할까요?",
      text: "이 메시지를 지웁니다. 이미 받아 간 비서의 사본은 회수되지 않습니다.",
      ok: "삭제",
      danger: true,
    });
    if (!ok) return;
    try {
      await store.deleteMessage(roomId, m.seq);
      notify("메시지를 삭제했습니다.");
    } catch (e) {
      notify(e instanceof Error ? e.message : "삭제하지 못했습니다.");
    }
  };

  const send = async (input: SendInput) => {
    try {
      await store.send(roomId, {
        content: input.content,
        kind: input.kind,
        recipient: input.recipient || undefined,
        reply_to: input.reply_to,
      });
      setRecipient("");
      setRecipientNotice(null);
      setReplyTo(null);
    } catch (e) {
      notify(e instanceof Error ? e.message : "보내지 못했습니다.");
      throw e;
    }
  };

  const togglePause = async () => {
    if (!room) return;
    try {
      await store.patchRoom(roomId, { paused: !room.paused });
      notify(room.paused ? "방을 재개했습니다." : "방을 일시정지했습니다. 비서는 읽기만 할 수 있습니다.");
    } catch (e) {
      notify(e instanceof Error ? e.message : "상태를 바꾸지 못했습니다.");
    }
  };

  if (!room) {
    return (
      <div className="page">
        <div className="boot">
          <span className="brand-mark" aria-hidden="true">
            A
          </span>
          {store.ready && store.error ? (
            <>
              <h1 className="mt-4 text-[16px] font-extrabold">방을 불러오지 못했습니다</h1>
              <p className="mt-2 max-w-sm text-center text-[13px] leading-relaxed text-muted">{store.error}</p>
              <div className="mt-4 flex justify-center gap-2">
                <button type="button" className="btn btn-primary" onClick={() => void store.refresh({ full: true })}>
                  다시 시도
                </button>
                <button type="button" className="btn" onClick={() => onGoView("home")}>
                  관제실로
                </button>
              </div>
            </>
          ) : (
            <>
              <h1 className="mt-4 text-[16px] font-extrabold">방을 불러오는 중…</h1>
              <div className="mx-auto mt-4 h-1 w-40 overflow-hidden rounded-full bg-surface-2">
                <div className="skeleton h-1 w-24" />
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  const liveAgents = agents.filter((a) => a.status === "active");
  const pinnedAgent = recipient ? agents.find((a) => a.id === recipient) : undefined;
  const panelContent =
    panel?.kind === "thread" ? (
      <ThreadPanel
        chat={store}
        roomId={roomId}
        rootSeq={panel.seq}
        agents={agents}
        onClose={() => setPanel(null)}
        onJump={jumpToMessage}
        onQuoteReply={quoteReply}
        onMention={mention}
        onCopy={copyMessage}
        onDelete={deleteMessage}
        onOpenThread={openThread}
      />
    ) : panel?.kind === "inspector" ? (
      <RoomInspector
        store={store}
        room={room}
        workspace={workspace}
        onClose={() => setPanel(null)}
        onMention={mention}
        recipient={recipient}
        onOpenRoom={onOpenRoom}
        onCreateRoom={onCreateRoom}
        onDeleteRoom={onDeleteRoom}
      />
    ) : null;

  return (
    <div className="room-shell">
      <div className="room-main">
        <header className="room-head">
          <button type="button" className="room-switch" onClick={() => setSwitcher(true)} aria-haspopup="dialog">
            <span className="room-switch-name">
              {room.kind === "lobby" ? <span className="tag">로비</span> : null}
              {room.name}
            </span>
            <Icon name="chevron-down" size={15} />
          </button>
          <div className="room-head-meta">
            <span>비서 {liveAgents.length}명</span>
          </div>
          <div className="room-head-actions">
            <button type="button" className="btn-icon" onClick={onOpenPalette} aria-label="검색·이동 (⌘K)" title="검색·이동 (⌘K)">
              <Icon name="search" size={16} />
            </button>
            <button type="button" className="btn btn-sm" onClick={() => void togglePause()}>
              <Icon name={room.paused ? "play" : "pause"} size={13} />
              <span className="hidden sm:inline">{room.paused ? "재개" : "일시정지"}</span>
            </button>
            <button
              type="button"
              className={"btn btn-sm" + (panel?.kind === "inspector" ? " btn-primary" : "")}
              aria-pressed={panel?.kind === "inspector"}
              onClick={() => setPanel(panel?.kind === "inspector" ? null : { kind: "inspector" })}
            >
              <Icon name="users" size={14} />
              <span className="hidden sm:inline">구성원</span>
              {liveAgents.length ? <span className="count-badge">{liveAgents.length}</span> : null}
            </button>
          </div>
        </header>

        {room.description ? <p className="room-desc">{room.description}</p> : null}

        {room.paused ? <PauseBanner room={room} messages={store.messages} onResume={() => void togglePause()} /> : null}

        {pinnedAgent || replyTo || recipientNotice ? (
          <div className="pins" aria-label="보내는 대상">
            {pinnedAgent ? (
              <span className="pin">
                <Icon name="at" size={13} />
                <strong>@{pinnedAgent.name}</strong> 에게만
                <button type="button" className="pin-clear" onClick={() => setRecipient("")} aria-label="받는 사람 해제 (방 전체로)">
                  <Icon name="close" size={12} />
                </button>
              </span>
            ) : null}
            {replyTo ? (
              <span className="pin">
                <Icon name="reply" size={13} />
                답장
                <button type="button" className="pin-clear" onClick={() => setReplyTo(null)} aria-label="답장 대상 해제">
                  <Icon name="close" size={12} />
                </button>
              </span>
            ) : null}
            {recipientNotice ? (
              <span className="pin pin-warn">
                <Icon name="alert" size={13} />
                {recipientNotice}
                <button type="button" className="pin-clear" onClick={() => setRecipientNotice(null)} aria-label="안내 닫기">
                  <Icon name="close" size={12} />
                </button>
              </span>
            ) : null}
          </div>
        ) : null}

        {store.error && store.messages.length > 0 ? (
          <div className="reconnect" role="status">
            <Icon name="alert" size={13} />
            <span className="flex-1 truncate">연결이 잠시 끊겼습니다 — {store.error}</span>
            <button type="button" className="btn btn-sm" onClick={() => void store.refresh({ full: true })}>
              다시 시도
            </button>
          </div>
        ) : null}

        <ChatFeed
          ref={feedRef}
          messages={store.messages}
          agents={agents}
          summaries={summaries}
          threadOpenSeq={panel?.kind === "thread" ? panel.seq : null}
          flashSeq={flashSeq}
          ready={store.ready}
          emptyHint={<><strong>비서</strong>를 초대하고 첫 메시지를 보내세요.</>}
          onOpenThread={openThread}
          onQuoteReply={quoteReply}
          onMention={mention}
          onCopy={copyMessage}
          onDelete={deleteMessage}
          onJump={flash}
          onSeedChain={() => setSeed({ text: "체인을 다시 시작합니다", nonce: Date.now() })}
          onOpenInvite={() => setPanel({ kind: "inspector" })}
        />

        <Composer
          agents={agents}
          recipient={recipient}
          onRecipient={(id) => {
            setRecipient(id);
            setRecipientNotice(null);
          }}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          onSend={send}
          seed={seed}
          focusNonce={focusComposer}
          placeholder={recipient ? `@${agents.find((a) => a.id === recipient)?.name ?? ""} 에게 보내기` : `${room.name}에 보내기`}
        />
      </div>

      {panel && isWide ? (
        <section className="panel" aria-label={panel.kind === "thread" ? "스레드 패널" : "구성원·방 패널"}>
          {panelContent}
        </section>
      ) : null}

      {panel && !isWide ? (
        <>
          <div className="backdrop" onClick={() => setPanel(null)} />
          <section
            ref={sheetRef}
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-label={panel.kind === "thread" ? "스레드 패널" : "구성원·방 패널"}
          >
            {panelContent}
          </section>
        </>
      ) : null}

      {switcher ? (
        <>
          <div className="backdrop" onClick={() => setSwitcher(false)} />
          <div className="room-switcher" role="dialog" aria-modal="true" aria-label="방 전환">
            <div className="panel-head">
              <h2 className="panel-title">방 전환</h2>
              <button type="button" className="btn-icon" onClick={() => setSwitcher(false)} aria-label="닫기">
                <Icon name="close" size={16} />
              </button>
            </div>
            <div className="panel-body">
              <ul className="switch-list">
                {rooms.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className="switch-row"
                      aria-current={r.id === roomId ? "page" : undefined}
                      onClick={() => {
                        setSwitcher(false);
                        if (r.id !== roomId) onOpenRoom(r.id);
                      }}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="switch-name">{r.name}</span>
                        <span className="switch-meta">
                          {[roomStateText(r.health, r.paused), `비서 ${r.member_count}`].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                      {r.unread ? <span className="tile-unread">{r.unread}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="btn w-full mt-3" onClick={onCreateRoom}>
                <Icon name="plus" size={14} /> 새 방 만들기
              </button>
              <button
                type="button"
                className="btn btn-ghost w-full mt-1 text-muted"
                onClick={() => {
                  setSwitcher(false);
                  onGoView("desk");
                }}
              >
                <Icon name="bot" size={14} /> 비서실에서 비서 관리
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function PauseBanner({ room, messages, onResume }: { room: RoomDetail; messages: Message[]; onResume: () => void }) {
  const since = Date.now() - room.rate_limit.window_seconds * 1000;
  const recent = messages.filter((m) => m.sender.type === "agent" && new Date(m.created_at).getTime() >= since).length;
  const info = room.pause_info;
  const auto = room.pause_reason === "rate_cap";
  const who = info?.actor_id ? messages.find((m) => m.sender.id === info.actor_id)?.sender.name : "";
  const at = info?.at ? new Date(info.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }) : "";
  return (
    <div className={"banner" + (auto ? " is-auto" : "")} role="status">
      <Icon name={auto ? "bolt" : "pause"} size={18} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="banner-title">
          {auto ? "자동 정지" : "일시정지"}
          {auto ? ` · 최근 ${durationLabel(room.rate_limit.window_seconds)} ${recent}/${room.rate_limit.count}` : at ? ` · ${at}` : ""}
        </p>
        <p className="banner-text">
          {auto && who ? `마지막 발신 ${who} · ` : ""}비서는 읽기만 합니다. 내 메시지는 그대로 전달됩니다.
        </p>
      </div>
      <button type="button" className="btn btn-primary btn-sm shrink-0" onClick={onResume}>
        재개
      </button>
    </div>
  );
}
