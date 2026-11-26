// 메시지 한 줄. 같은 발신자 5분 이내 연속 메시지는 이름·아바타를 접고(그룹핑),
// 호버하면 왼쪽 홈에 시각만, 오른쪽 위에 액션 바가 뜬다(스레드에 답글 · @멘션 · 복사 · 삭제).
import { useState } from "react";
import { Avatar } from "./Avatar.js";
import { Icon } from "./icons.js";
import { RichText } from "../lib/markdown.js";
import { fmtFull, fmtTime, groupedWith, KIND_LABEL, plainPreview, senderName, type ThreadSummary } from "../lib/format.js";
import type { Agent, Message } from "../lib/types.js";

const DELIVERY: Record<string, { label: string; title: string }> = {
  sent: { label: "보냄", title: "아직 상대가 받지 않았습니다" },
  fetched: { label: "받아감", title: "상대 에이전트가 inbox로 받아갔습니다" },
  acked: { label: "확인함", title: "상대 에이전트가 처리를 확인했습니다" },
  replied: { label: "답장함", title: "상대 에이전트가 답장했습니다" },
};

interface Props {
  m: Message;
  prev?: Message;
  agents: Agent[];
  bySeq: Map<number, Message>;
  summary?: ThreadSummary;
  threadOpen?: boolean;
  flash?: boolean;
  onOpenThread: (seq: number) => void;
  onQuoteReply: (m: Message) => void;
  onMention: (agent: Agent) => void;
  onCopy: (m: Message) => void;
  onDelete: (m: Message) => void;
  onJump: (seq: number) => void;
}

export function MessageRow({ m, prev, agents, bySeq, summary, threadOpen, flash, onOpenThread, onQuoteReply, onMention, onCopy, onDelete, onJump }: Props) {
  // 좁은 화면(터치)에는 호버가 없으므로, 메시지마다 '작업' 버튼으로 액션 바를 연다.
  const [actionsOpen, setActionsOpen] = useState(false);
  const grouped = groupedWith(prev, m);
  const isOwner = m.sender.type === "owner";
  const agent = m.sender.type === "agent" ? agents.find((a) => a.id === m.sender.id) : undefined;
  const parent = m.reply_to ? bySeq.get(m.reply_to) : undefined;
  const name = senderName(m);
  const delivery = m.recipient && m.delivery ? DELIVERY[m.delivery.state] : undefined;

  return (
    <li
      id={`msg-${m.seq}`}
      className={
        "msg group" +
        (grouped ? " is-grouped" : "") +
        (isOwner ? " is-owner" : "") +
        (m.deleted ? " is-deleted" : "") +
        (flash ? " flash" : "")
      }
      data-seq={m.seq}
    >
      <div className="msg-gutter">
        {grouped ? (
          <span className="msg-gutter-time" title={fmtFull(m.created_at)}>
            {fmtTime(m.created_at)}
          </span>
        ) : (
          <Avatar name={isOwner ? "오너" : m.sender.name || "?"} />
        )}
      </div>

      <div className="msg-body">
        <div className={"msg-actions" + (actionsOpen ? " is-open" : "")} role="group" aria-label={`#${m.seq} 메시지 작업`}>
          <button type="button" className="msg-action msg-action-label" onClick={() => onOpenThread(m.seq)} title="스레드에 답글">
            <Icon name="thread" size={14} />
            <span>스레드</span>
          </button>
          <button type="button" className="msg-action" onClick={() => onQuoteReply(m)} aria-label="인용 답장" title="인용 답장">
            <Icon name="reply" size={14} />
          </button>
          {agent && agent.status === "active" ? (
            <button type="button" className="msg-action" onClick={() => onMention(agent)} aria-label={`${agent.name} 지목`} title={`@${agent.name} 지목`}>
              <Icon name="at" size={15} />
            </button>
          ) : null}
          <button type="button" className="msg-action" onClick={() => onCopy(m)} aria-label="본문 복사" title="본문 복사">
            <Icon name="copy" size={14} />
          </button>
          {!m.deleted ? (
            <button type="button" className="msg-action is-danger" onClick={() => onDelete(m)} aria-label="메시지 삭제" title="메시지 삭제">
              <Icon name="trash" size={14} />
            </button>
          ) : null}
        </div>

        <button
          type="button"
          className="msg-more"
          aria-expanded={actionsOpen}
          aria-label={`#${m.seq} 메시지 작업 열기`}
          onClick={() => setActionsOpen((v) => !v)}
        >
          <Icon name="more" size={15} />
        </button>

        {!grouped ? (
          <div className="msg-head">
            <span className={"msg-name" + (isOwner ? " is-owner" : "")}>{name}</span>
            {agent?.product_self_declared ? <span className="msg-meta">{agent.product_self_declared}</span> : null}
            {m.recipient ? <span className="pill pill-accent">→ @{m.recipient.name}</span> : null}
            {m.kind !== "message" ? <span className="msg-tag">{KIND_LABEL[m.kind] ?? m.kind}</span> : null}
            <span className="msg-meta" title={fmtFull(m.created_at)}>
              {fmtTime(m.created_at)}
            </span>
            {m.seq === 0 ? null : <span className="msg-meta opacity-70">#{m.seq}</span>}
          </div>
        ) : null}

        {m.reply_to ? (
          <button type="button" className="reply-quote" onClick={() => onJump(m.reply_to!)} aria-label={`원문 #${m.reply_to}로 이동`}>
            {parent ? (
              <>
                <strong>{senderName(parent)}</strong> · {parent.deleted ? "삭제된 메시지" : plainPreview(parent.content)}
              </>
            ) : (
              <>#&#8203;{m.reply_to} 원문을 불러오지 못했습니다</>
            )}
          </button>
        ) : null}

        <div className="msg-rich">
          {m.deleted ? (
            <span className="italic">삭제된 메시지입니다</span>
          ) : (
            <RichText content={m.content ?? ""} agents={agents} />
          )}
        </div>

        {summary ? (
          <button
            type="button"
            className="thread-summary"
            onClick={() => onOpenThread(m.seq)}
            aria-expanded={!!threadOpen}
            aria-label={`답글 ${summary.count}개 스레드 열기`}
          >
            <Icon name="thread" size={14} />
            <span>답글 {summary.count}개</span>
            <span className="thread-last">마지막 답글 {fmtTime(summary.lastAt)}</span>
          </button>
        ) : null}

        {delivery ? (
          <span className={`pill mt-1.5 ${m.delivery?.state === "replied" ? "pill-live" : ""}`} title={delivery.title}>
            <Icon name={m.delivery?.state === "replied" ? "reply" : m.delivery?.state === "acked" ? "check" : "clock"} size={12} />
            {delivery.label}
          </span>
        ) : null}
      </div>
    </li>
  );
}
