// 방 화면: 헤더 + 일시정지 배너 + 대화 피드 + 컴포저, 그리고 좌측 사이드바 / 우측 패널(스레드·관리).
// 좁은 화면은 사이드바 드로어, 1280px 미만은 패널 시트, 그 이상은 3단 고정 레이아웃.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatFeed, type ChatFeedHandle } from "./ChatFeed.js";
import { Composer, type SendInput } from "./Composer.js";
import { ManagePanel } from "./ManagePanel.js";
import { Sidebar, type ManageSection } from "./Sidebar.js";
import { ThreadPanel } from "./ThreadPanel.js";
import { Icon } from "./icons.js";
import { useToast } from "./Toast.js";
import { useConfirm } from "./ConfirmDialog.js";
import { copyText } from "../lib/browserClipboard.js";
import { useOwnerRoom } from "../hooks/useOwnerRoom.js";
import { useMediaQuery, type Theme } from "../hooks/useTheme.js";
import { durationLabel, threadRootOf, threadSummaries } from "../lib/format.js";
import type { Agent, Message, RoomOwner } from "../lib/types.js";

type PanelState = { kind: "thread"; seq: number } | { kind: "manage"; section: ManageSection } | null;

interface Props {
  token: string;
  theme: Theme;
  onTheme: (t: Theme) => void;
  onLogout: () => void;
  onUnauthorized: () => void;
}

export function ChatScreen({ token, theme, onTheme, onLogout, onUnauthorized }: Props) {
  const store = useOwnerRoom(token, onUnauthorized);
  const notify = useToast();
  const confirm = useConfirm();
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const isWide = useMediaQuery("(min-width: 1280px)");

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [panel, setPanel] = useState<PanelState>(null);
  const [recipient, setRecipient] = useState("");
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null);
  const [focusComposer, setFocusComposer] = useState(0);
  const [flashSeq, setFlashSeq] = useState<number | null>(null);
  const feedRef = useRef<ChatFeedHandle | null>(null);
  const sheetRef = useRef<HTMLElement | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);

  const room = store.room;
  const agents = store.agents;
  const bySeq = useMemo(() => new Map(store.messages.map((m) => [m.seq, m])), [store.messages]);
  const summaries = useMemo(() => threadSummaries(store.messages, bySeq), [store.messages, bySeq]);

  // 데스크톱으로 넓어지면 모바일 드로어는 닫는다.
  useEffect(() => {
    if (isDesktop) setSidebarOpen(false);
  }, [isDesktop]);

  // 창 제목: 승인 대기가 있으면 먼저 알린다.
  useEffect(() => {
    document.title = room ? `${store.pendingCount ? `(${store.pendingCount}) ` : ""}${room.name} · 공통 룸` : "공통 룸";
  }, [room, store.pendingCount]);

  // Esc: 확인 시트가 열려 있으면 그쪽이 처리하고, 아니면 패널 → 드로어 순서로 닫는다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector(".dialog-backdrop")) return;
      if (panel) {
        setPanel(null);
        return;
      }
      if (sidebarOpen) setSidebarOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panel, sidebarOpen]);

  // 시트(좁은 화면)로 열리면 닫기 버튼으로 포커스를 옮긴다.
  useEffect(() => {
    if (!panel || isWide) return;
    sheetRef.current?.querySelector<HTMLElement>("[data-close]")?.focus();
  }, [panel, isWide]);

  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  const flash = useCallback((seq: number) => {
    setFlashSeq(seq);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashSeq(null), 2000);
  }, []);

  const openManage = useCallback(
    (section: ManageSection) => {
      setPanel({ kind: "manage", section });
      store.requestInvites();
      if (!isDesktop) setSidebarOpen(false);
    },
    [store, isDesktop],
  );

  // 답글에서 스레드를 열어도 최상위 원문의 스레드로 모아 연다(후속 답글이 빠지지 않게).
  const openThread = useCallback(
    (seq: number) => {
      const target = bySeq.get(seq);
      setPanel({ kind: "thread", seq: target ? threadRootOf(target, bySeq).seq : seq });
    },
    [bySeq],
  );

  const quoteReply = useCallback((m: Message) => {
    setReplyTo(m);
    setFocusComposer((n) => n + 1);
  }, []);

  const mention = useCallback(
    (a: Agent) => {
      setRecipient(a.id);
      setFocusComposer((n) => n + 1);
      notify(`@${a.name} 에게 보냅니다. 방 전체에 말하려면 받는 사람을 비우세요.`);
      if (!isDesktop) setSidebarOpen(false);
    },
    [notify, isDesktop],
  );

  // 스레드/인용에서 원문으로: 피드를 스크롤해 그 메시지로 이동하고, 좁은 화면의 시트는 닫는다.
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
      text: `#${m.seq} 메시지를 지웁니다. 이미 받아 간 에이전트의 사본은 회수되지 않습니다.`,
      ok: "삭제",
      danger: true,
    });
    if (!ok) return;
    try {
      await store.deleteMessage(m.seq);
      notify("메시지를 삭제했습니다.");
    } catch (e) {
      notify(e instanceof Error ? e.message : "삭제하지 못했습니다.");
    }
  };

  const send = async (input: SendInput) => {
    try {
      await store.send({
        content: input.content,
        kind: input.kind,
        recipient: input.recipient || undefined,
        reply_to: input.reply_to,
      });
      setReplyTo(null);
    } catch (e) {
      notify(e instanceof Error ? e.message : "보내지 못했습니다.");
      throw e;
    }
  };

  const togglePause = async () => {
    if (!room) return;
    try {
      await store.patchRoom({ paused: !room.paused });
      notify(room.paused ? "방을 재개했습니다." : "방을 일시정지했습니다. 에이전트는 읽기만 할 수 있습니다.");
    } catch (e) {
      notify(e instanceof Error ? e.message : "상태를 바꾸지 못했습니다.");
    }
  };

  if (!room) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="max-w-sm text-center">
          <span className="brand-mark">A</span>
          {store.ready && store.error ? (
            <>
              <h1 className="mt-4 text-[16px] font-extrabold">방을 불러오지 못했습니다</h1>
              <p className="mt-2 text-[13px] leading-relaxed text-muted">{store.error}</p>
              <div className="mt-4 flex justify-center gap-2">
                <button type="button" className="btn btn-primary" onClick={() => void store.refresh({ full: true, invites: true })}>
                  다시 시도
                </button>
                <button type="button" className="btn" onClick={onLogout}>
                  로그아웃
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

  const panelContent =
    panel?.kind === "thread" ? (
      <ThreadPanel
        store={store}
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
    ) : panel?.kind === "manage" ? (
      <ManagePanel
        store={store}
        room={room}
        section={panel.section}
        onSection={(section) => setPanel({ kind: "manage", section })}
        onClose={() => setPanel(null)}
        onMention={mention}
      />
    ) : null;

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-canvas">
      {isDesktop ? (
        <Sidebar
          room={room}
          agents={agents}
          pendingCount={store.pendingCount}
          recipient={recipient}
          theme={theme}
          onCycleTheme={() => onTheme(theme === "light" ? "dark" : theme === "dark" ? "system" : "light")}
          onOpenManage={openManage}
          onMention={mention}
          onLogout={onLogout}
        />
      ) : null}

      {!isDesktop && sidebarOpen ? (
        <>
          <div className="backdrop" onClick={() => setSidebarOpen(false)} />
          <Sidebar
            className="drawer"
            room={room}
            agents={agents}
            pendingCount={store.pendingCount}
            recipient={recipient}
            theme={theme}
            onCycleTheme={() => onTheme(theme === "light" ? "dark" : theme === "dark" ? "system" : "light")}
            onOpenManage={openManage}
            onMention={mention}
            onLogout={onLogout}
            onClose={() => setSidebarOpen(false)}
          />
        </>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-[52px] items-center gap-2 border-b border-line bg-surface px-3 py-2 sm:px-4">
          {!isDesktop ? (
            <button type="button" className="btn-icon" onClick={() => setSidebarOpen(true)} aria-label="사이드바 열기">
              <Icon name="menu" size={18} />
            </button>
          ) : null}
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-1.5 truncate text-[15px] font-extrabold">
              <Icon name="hash" size={15} className="shrink-0 text-muted" />
              <span className="truncate">{room.name}</span>
              {room.paused ? <span className="pill pill-danger ml-1">일시정지</span> : null}
            </h1>
            <p className="truncate text-[11.5px] text-muted">
              {room.description ||
                `참여자 ${agents.filter((a) => a.status === "active").length}명 · 답장 체인 최대 ${room.max_chain_depth} · ${durationLabel(room.rate_limit.window_seconds)}당 ${room.rate_limit.count}개`}
            </p>
          </div>

          <button type="button" className="btn btn-sm" onClick={togglePause}>
            <Icon name={room.paused ? "play" : "pause"} size={13} />
            <span className="hidden sm:inline">{room.paused ? "재개" : "일시정지"}</span>
          </button>
          <button
            type="button"
            className={"btn btn-sm" + (panel?.kind === "manage" ? " btn-primary" : "")}
            onClick={() => (panel?.kind === "manage" ? setPanel(null) : openManage("requests"))}
            aria-pressed={panel?.kind === "manage"}
          >
            <Icon name="inbox" size={14} />
            <span className="hidden sm:inline">관리</span>
            {store.pendingCount ? <span className="count-badge">{store.pendingCount}</span> : null}
          </button>
        </header>

        {room.paused ? <PauseBanner room={room} messages={store.messages} onResume={togglePause} /> : null}

        {store.error && store.messages.length > 0 ? (
          <div className="flex items-center gap-2 border-b border-line bg-surface-2 px-4 py-1.5 text-[12px] text-muted" role="status">
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
          emptyHint={
            <>
              <strong>관리 → 초대</strong>에서 전달 문장을 복사해 비서에게 보내거나, 아래 입력창에서 첫 메시지를 보내 보세요.
            </>
          }
          onOpenThread={openThread}
          onQuoteReply={quoteReply}
          onMention={mention}
          onCopy={copyMessage}
          onDelete={deleteMessage}
          onJump={flash}
          onSeedChain={() => setSeed({ text: "체인을 다시 시작합니다", nonce: Date.now() })}
          onOpenInvite={() => openManage("invites")}
        />

        <Composer
          agents={agents}
          recipient={recipient}
          onRecipient={setRecipient}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          onSend={send}
          seed={seed}
          focusNonce={focusComposer}
          placeholder={recipient ? `@${agents.find((a) => a.id === recipient)?.name ?? ""} 에게 보내기` : "오너로 메시지 보내기"}
        />
      </div>

      {panel && isWide ? (
        <section className="panel" aria-label={panel.kind === "thread" ? "스레드 패널" : "관리 패널"}>
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
            aria-label={panel.kind === "thread" ? "스레드 패널" : "관리 패널"}
          >
            {panelContent}
          </section>
        </>
      ) : null}
    </div>
  );
}

function PauseBanner({ room, messages, onResume }: { room: RoomOwner; messages: Message[]; onResume: () => void }) {
  const since = Date.now() - room.rate_limit.window_seconds * 1000;
  const recent = messages.filter((m) => m.sender.type === "agent" && new Date(m.created_at).getTime() >= since).length;
  const info = room.pause_info;
  const auto = room.pause_reason === "rate_cap";
  const who = info?.actor_id ? messages.find((m) => m.sender.id === info.actor_id)?.sender.name : "";
  return (
    <div className={"banner" + (auto ? " is-auto" : "")} role="status">
      <Icon name={auto ? "bolt" : "pause"} size={18} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="banner-title">
          {auto ? "자동 정지" : "일시정지"}
          {info?.at ? ` · ${new Date(info.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false })}` : ""}
          {auto ? " · 빈도 상한" : " · 내가 정지함"}
        </p>
        <p className="banner-text">
          {auto
            ? `최근 ${durationLabel(room.rate_limit.window_seconds)}에 에이전트 메시지가 상한(${room.rate_limit.count}개)에 닿았습니다${who ? ` · 마지막 발신 ${who}` : ""} · 지금 ${recent}/${room.rate_limit.count}. 일시정지 중에도 내 메시지는 전달됩니다.`
            : "에이전트는 읽기만 할 수 있습니다. 재개하면 다시 말할 수 있습니다. 일시정지 중에도 내 메시지는 전달됩니다."}
        </p>
      </div>
      <button type="button" className="btn btn-primary btn-sm shrink-0" onClick={onResume}>
        재개
      </button>
    </div>
  );
}
