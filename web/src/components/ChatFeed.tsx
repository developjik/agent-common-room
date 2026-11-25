// 중앙 대화 피드: 날짜 구분선, 발신자 그룹핑, 스레드 요약 배지, 시스템 안내, 빈/로딩 상태.
// role="log"로 새 메시지만 낭독되고, 사용자가 바닥 근처에 있을 때만 자동 스크롤한다.
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { MessageRow } from "./MessageRow.js";
import { Icon } from "./icons.js";
import { dateSeparatorLabel, dayKey, type ThreadSummary } from "../lib/format.js";
import type { Agent, Message } from "../lib/types.js";

export interface ChatFeedHandle {
  scrollToBottom: (smooth?: boolean) => void;
  jumpTo: (seq: number) => void;
}

interface Props {
  messages: Message[];
  agents: Agent[];
  summaries: Map<number, ThreadSummary>;
  threadOpenSeq: number | null;
  flashSeq: number | null;
  ready: boolean;
  emptyHint: React.ReactNode;
  onOpenThread: (seq: number) => void;
  onQuoteReply: (m: Message) => void;
  onMention: (agent: Agent) => void;
  onCopy: (m: Message) => void;
  onDelete: (m: Message) => void;
  onJump: (seq: number) => void;
  onSeedChain: () => void;
  onOpenInvite: () => void;
}

function Skeleton() {
  return (
    <div className="space-y-5 p-5" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex gap-3">
          <div className="skeleton h-9 w-9 shrink-0 rounded-lg" />
          <div className="w-full max-w-xl space-y-2">
            <div className="skeleton h-3 w-28" />
            <div className="skeleton h-3.5" />
            <div className="skeleton h-3.5 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export const ChatFeed = forwardRef<ChatFeedHandle, Props>(function ChatFeed(
  { messages, agents, summaries, threadOpenSeq, flashSeq, ready, emptyHint, onOpenThread, onQuoteReply, onMention, onCopy, onDelete, onJump, onSeedChain, onOpenInvite },
  ref,
) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);
  const firstPaint = useRef(true);

  const scrollToBottom = (smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };

  const jumpTo = (seq: number) => {
    const el = scroller.current;
    if (!el) return;
    const node = el.querySelector<HTMLElement>(`[id="msg-${seq}"]`);
    if (!node) return;
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    onJump(seq);
  };

  useImperativeHandle(ref, () => ({ scrollToBottom, jumpTo }));

  useEffect(() => {
    if (!ready) return;
    if (firstPaint.current || atBottom.current) {
      scrollToBottom(false);
      firstPaint.current = false;
    }
  }, [ready, messages.length]);

  const bySeq = new Map(messages.map((m) => [m.seq, m]));

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        className="scroll-area absolute inset-0"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
        }}
      >
        {!ready ? <Skeleton /> : null}

        {ready && messages.length === 0 ? (
          <div className="mx-auto max-w-md px-6 py-16 text-center">
            <div className="flex justify-center">
              <span className="brand-mark">A</span>
            </div>
            <h2 className="mt-4 text-[17px] font-extrabold">아직 메시지가 없습니다</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">{emptyHint}</p>
            <button type="button" className="btn mt-4" onClick={onOpenInvite}>
              <Icon name="link" size={14} /> 초대 링크 만들기
            </button>
          </div>
        ) : null}

        <ul role="log" aria-live="polite" aria-relevant="additions" className="feed" aria-label="대화 메시지">
          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const newDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at);
            const isSystem = m.sender.type === "system";
            const loopNotice = !m.deleted && typeof m.content === "string" && m.content.startsWith("답장 체인이 최대 깊이");
            return (
              <li key={m.seq} className="list-none">
                {newDay ? (
                  <div className="day-sep">
                    <span>{dateSeparatorLabel(m.created_at)}</span>
                  </div>
                ) : null}
                {isSystem ? (
                  <div className="sys-msg">
                    <Icon name="alert" size={15} className="mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p>{m.deleted ? "삭제된 시스템 안내입니다" : m.content}</p>
                      {loopNotice ? (
                        <button type="button" className="btn btn-sm mt-2" onClick={onSeedChain}>
                          체인 다시 시작
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <MessageRow
                    m={m}
                    prev={prev && prev.sender.type !== "system" ? prev : undefined}
                    agents={agents}
                    bySeq={bySeq}
                    summary={summaries.get(m.seq)}
                    threadOpen={threadOpenSeq === m.seq}
                    flash={flashSeq === m.seq}
                    onOpenThread={onOpenThread}
                    onQuoteReply={onQuoteReply}
                    onMention={onMention}
                    onCopy={onCopy}
                    onDelete={onDelete}
                    onJump={jumpTo}
                  />
                )}
              </li>
            );
          })}
        </ul>
        <div className="h-6" />
      </div>
    </div>
  );
});
