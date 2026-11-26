// 방 하나: 대화 + 컴포저 + 방 패널. 단톡방처럼 읽히게 대화·@멘션·답장만 남겼다.
// 초대는 헤더의 '초대 문장 복사' 한 번(7일 · 10회 기본값)으로 끝난다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatFeed, type ChatFeedHandle } from "./ChatFeed.js";
import { Composer, type SendInput } from "./Composer.js";
import { RoomPanel } from "./RoomPanel.js";
import { Icon } from "./icons.js";
import { useToast } from "./Toast.js";
import { useConfirm } from "./ConfirmDialog.js";
import { copyText } from "../lib/browserClipboard.js";
import { recipientReset } from "../lib/format.js";
import { INVITE_DEFAULTS, roomInviteText } from "../lib/views.js";
import type { WorkspaceStore } from "../hooks/useWorkspace.js";
import type { Message, RoomDetail, Workspace } from "../lib/types.js";

interface Props {
  roomId: string;
  store: WorkspaceStore;
  workspace: Workspace;
  isWide: boolean;
  onBack: () => void;
}

export function RoomView({ roomId, store, workspace, isWide, onBack }: Props) {
  const notify = useToast();
  const confirm = useConfirm();
  const [panelOpen, setPanelOpen] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [recipientNotice, setRecipientNotice] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null);
  const [focusComposer, setFocusComposer] = useState(0);
  const [flashSeq, setFlashSeq] = useState<number | null>(null);
  const [inviting, setInviting] = useState(false);
  const [fallbackLink, setFallbackLink] = useState<string | null>(null);
  const feedRef = useRef<ChatFeedHandle | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);

  const room = store.room;
  const agents = store.agents;
  const bySeq = useMemo(() => new Map(store.messages.map((m) => [m.seq, m])), [store.messages]);

  // 방을 바꾸면 이전 방의 수신자·답장 대상·패널을 남기지 않는다.
  useEffect(() => {
    setRecipient("");
    setRecipientNotice(null);
    setReplyTo(null);
    setPanelOpen(false);
    setFallbackLink(null);
  }, [roomId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector(".dialog-backdrop")) return;
      if (panelOpen) setPanelOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panelOpen]);

  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  // 폐기·미승인 비서가 수신자로 남아 있으면 방 전체로 되돌리고 알린다.
  useEffect(() => {
    const { reset, notice } = recipientReset(agents, recipient);
    if (!reset) return;
    setRecipient("");
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

  const quoteReply = useCallback(
    (m: Message) => {
      if (recipient) {
        setRecipient("");
        notify("답장은 방 전체로 보냅니다. 한 비서에게만 보내려면 받는 사람을 다시 고르세요.");
      }
      setReplyTo(m);
      setFocusComposer((n) => n + 1);
    },
    [recipient, notify],
  );

  const mention = useCallback(
    (a: { id: string; name: string; status: string }) => {
      if (a.status !== "active") {
        notify(`@${a.name} 은(는) 지금 메시지를 받을 수 없습니다.`);
        return;
      }
      setRecipient(a.id);
      setFocusComposer((n) => n + 1);
      notify(`@${a.name} 에게 보냅니다. 방 전체에 말하려면 받는 사람을 비우세요.`);
    },
    [notify],
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

  /** 원클릭 초대: 기본값(7일 · 10회)으로 링크를 만들어 '전달 문장'째로 클립보드에 넣는다. */
  const invite = async () => {
    if (inviting) return;
    setInviting(true);
    try {
      const res = await store.createInvite(roomId, INVITE_DEFAULTS.ttlHours, INVITE_DEFAULTS.maxUses);
      const link = `${location.origin}/join/${res.invite_token}`;
      // 링크만 보내면 비서가 join 만 하고 멈출 수 있다. 입장 뒤 대화를 이어가라는 한 줄까지 같이 보낸다.
      const text = roomInviteText(workspace.name, room?.name ?? "이 방", link);
      const ok = await copyText(text);
      if (ok) {
        setFallbackLink(null);
        notify(`초대 문장을 복사했습니다 · 7일 · 10회. 비서에게 그대로 붙여넣으세요.`);
      } else {
        setFallbackLink(link);
        notify("클립보드에 넣지 못했습니다. 아래 링크를 직접 복사하세요.");
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : "초대 링크를 만들지 못했습니다.");
    } finally {
      setInviting(false);
    }
  };

  const resume = async () => {
    try {
      await store.patchRoom(roomId, { paused: false });
      notify("방을 재개했습니다.");
    } catch (e) {
      notify(e instanceof Error ? e.message : "재개하지 못했습니다.");
    }
  };

  // 모바일 시트를 열면 포커스를 시트 안으로 옮긴다(대화 컨트롤부터 Tab 이 돌지 않게).
  useEffect(() => {
    if (!panelOpen || isWide) return;
    window.setTimeout(() => document.querySelector<HTMLElement>(".sheet [data-close]")?.focus(), 0);
  }, [panelOpen, isWide]);

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
                <button type="button" className="btn" onClick={onBack}>
                  방 목록으로
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
  const panel = panelOpen ? (
    <RoomPanel store={store} room={room} onClose={() => setPanelOpen(false)} onMention={mention} onDeleted={onBack} />
  ) : null;

  return (
    <div className="room-shell">
      <div className="room-main">
        <header className="room-head">
          {!isWide ? (
            <button type="button" className="btn-icon" onClick={onBack} aria-label="방 목록" title="방 목록">
              <Icon name="back" size={17} />
            </button>
          ) : null}
          <div className="room-switch-name">
            {room.kind === "lobby" ? <span className="tag">로비</span> : null}
            {room.name}
          </div>
          <div className="room-head-meta">
            <span>비서 {liveAgents.length}명</span>
          </div>
          <div className="room-head-actions">
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void invite()} disabled={inviting} aria-label="초대 문장 복사">
              <Icon name="link" size={14} />
              <span className="hidden sm:inline">{inviting ? "만드는 중…" : "초대 문장 복사"}</span>
            </button>
            <button
              type="button"
              className={"btn btn-sm" + (panelOpen ? " btn-primary" : "")}
              aria-pressed={panelOpen}
              aria-label="방 설정"
              onClick={() => setPanelOpen((v) => !v)}
            >
              <Icon name="users" size={14} />
              <span className="hidden sm:inline">설정</span>
            </button>
          </div>
        </header>

        {room.description ? <p className="room-desc">{room.description}</p> : null}

        {fallbackLink ? (
          <div className="invite-bar" role="status">
            <Icon name="link" size={14} />
            <code className="min-w-0 flex-1 select-all break-all">{fallbackLink}</code>
            <button type="button" className="btn btn-sm" onClick={() => void copyText(fallbackLink)}>
              복사
            </button>
            <button type="button" className="btn-icon" onClick={() => setFallbackLink(null)} aria-label="닫기">
              <Icon name="close" size={13} />
            </button>
          </div>
        ) : null}

        {room.paused ? (
          <div className="banner" role="status">
            <Icon name="pause" size={18} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="banner-title">일시정지</p>
              <p className="banner-text">비서는 읽기만 합니다. 내 메시지는 그대로 전달됩니다.</p>
            </div>
            <button type="button" className="btn btn-primary btn-sm shrink-0" onClick={() => void resume()}>
              재개
            </button>
          </div>
        ) : null}

        {replyTo || recipientNotice ? (
          <div className="pins" aria-label="보내는 대상">
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
          flashSeq={flashSeq}
          ready={store.ready}
          emptyHint={
            <>
              위의 <strong>초대 링크 복사</strong>로 비서를 부르고 첫 메시지를 보내세요.
            </>
          }
          onQuoteReply={quoteReply}
          onMention={mention}
          onCopy={copyMessage}
          onDelete={deleteMessage}
          onJump={flash}
          onSeedChain={() => setSeed({ text: "체인을 다시 시작합니다", nonce: Date.now() })}
          onOpenInvite={() => void invite()}
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
        />
      </div>

      {panel && isWide ? (
        <section className="panel" aria-label="방 설정">
          {panel}
        </section>
      ) : null}

      {panel && !isWide ? (
        <>
          <div className="backdrop" onClick={() => setPanelOpen(false)} />
          <section className="sheet" role="dialog" aria-modal="true" aria-label="방 설정">
            {panel}
          </section>
        </>
      ) : null}
    </div>
  );
}
