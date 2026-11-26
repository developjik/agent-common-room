// 우측 스레드 패널: 루트 메시지 + reply_to 사슬 기반 답글 목록 + 스레드 전용 입력창.
import { useRef } from "react";
import { MessageRow } from "./MessageRow.js";
import { Composer } from "./Composer.js";
import { Icon } from "./icons.js";
import { repliesOf, threadSummaries } from "../lib/format.js";
import type { Agent, Message } from "../lib/types.js";
import { useToast } from "./Toast.js";

interface Props {
  chat: {
    messages: Message[];
    send: (roomId: string, input: { content: string; kind?: string; recipient?: string; reply_to?: number }) => Promise<Message>;
  };
  roomId: string;
  rootSeq: number;
  agents: Agent[];
  onClose: () => void;
  onJump: (seq: number) => void;
  onQuoteReply: (m: Message) => void;
  onMention: (a: Agent) => void;
  onCopy: (m: Message) => void;
  onDelete: (m: Message) => void;
  onOpenThread: (seq: number) => void;
}

export function ThreadPanel({ chat, roomId, rootSeq, agents, onClose, onJump, onQuoteReply, onMention, onCopy, onDelete, onOpenThread }: Props) {
  const notify = useToast();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const bySeq = new Map(chat.messages.map((m) => [m.seq, m]));
  const root = bySeq.get(rootSeq);
  const replies = root ? repliesOf(rootSeq, chat.messages, bySeq) : [];
  const summaries = threadSummaries(chat.messages, bySeq);

  return (
    <>
      <div className="panel-head">
        <div className="min-w-0 flex-1">
          <h2 className="panel-title">스레드</h2>
          <p className="truncate text-[11.5px] text-muted">
            #{rootSeq} · 답글 {replies.length}개
          </p>
        </div>
        {root ? (
          <button type="button" className="btn btn-sm" onClick={() => onJump(root.seq)}>
            대화에서 보기
          </button>
        ) : null}
        <button type="button" className="btn-icon" data-close onClick={onClose} aria-label="스레드 닫기" title="닫기 (Esc)">
          <Icon name="close" size={16} />
        </button>
      </div>

      <div className="panel-body px-0" ref={bodyRef}>
        {!root ? (
          <p className="px-4 py-8 text-center text-[12.5px] text-muted">원문을 불러오지 못했습니다. 대화를 새로고침해 주세요.</p>
        ) : (
          <ul role="log" aria-live="polite" aria-relevant="additions" aria-label="스레드 메시지">
            <li className="list-none">
              <MessageRow
                m={root}
                agents={agents}
                bySeq={bySeq}
                onOpenThread={onOpenThread}
                onQuoteReply={onQuoteReply}
                onMention={onMention}
                onCopy={onCopy}
                onDelete={onDelete}
                onJump={onJump}
              />
            </li>
            <li aria-hidden="true" className="my-2 flex items-center gap-2 px-4">
              <span className="text-[11px] font-bold text-muted">{replies.length ? `답글 ${replies.length}개` : "첫 답글을 남겨 보세요"}</span>
              <span className="h-px flex-1 bg-line" />
            </li>
            {replies.map((m, i) => (
              <li key={m.seq} className="list-none">
                <MessageRow
                  m={m}
                  prev={replies[i - 1]}
                  agents={agents}
                  bySeq={bySeq}
                  summary={summaries.get(m.seq)}
                  onOpenThread={onOpenThread}
                  onQuoteReply={onQuoteReply}
                  onMention={onMention}
                  onCopy={onCopy}
                  onDelete={onDelete}
                  onJump={onJump}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {root ? (
        <Composer
          // 스레드를 바꾸면 입력창을 새로 만들어 이전 스레드의 초안이 넘어가지 않게 한다.
          key={root.seq}
          agents={agents}
          recipient=""
          onRecipient={() => {}}
          allowRecipientMention={false}
          compact
          placeholder="스레드에 답글 남기기 (방 전체에 공개)"
          onSend={async (input) => {
            try {
              // 스레드 답글은 방 전체 공개다. 중앙 입력창의 수신자를 몰래 물려받지 않는다.
              await chat.send(roomId, { ...input, recipient: undefined, reply_to: rootSeq });
              window.setTimeout(() => {
                const el = bodyRef.current;
                if (el) el.scrollTop = el.scrollHeight;
              }, 60);
            } catch (e) {
              notify(e instanceof Error ? e.message : "보내지 못했습니다.");
              throw e; // 컴포저가 초안을 지우지 않게
            }
          }}
        />
      ) : null}
    </>
  );
}
