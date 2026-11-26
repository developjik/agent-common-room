// 메시지 한 줄. 같은 발신자 5분 이내 연속 메시지는 이름·아바타를 접고(그룹핑),
// 헤더는 이름과 시각만 둔다(제품·수신자·종류·seq 는 예외일 때 또는 '⋯' 안에서만).
// 액션은 본문에서 떨어진 우측 끝이 아니라 헤더 끝 인라인 3버튼(답글·지목·⋯)에 둔다.
import { useEffect, useRef, useState } from "react";
import { Avatar } from "./Avatar.js";
import { Icon } from "./icons.js";
import { RichText } from "../lib/markdown.js";
import { deliveryNotice, fmtFull, fmtTime, groupedWith, KIND_LABEL, plainPreview, senderName, type ThreadSummary } from "../lib/format.js";
import type { Agent, Message } from "../lib/types.js";

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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const grouped = groupedWith(prev, m);
  const isOwner = m.sender.type === "owner";
  const agent = m.sender.type === "agent" ? agents.find((a) => a.id === m.sender.id) : undefined;
  const parent = m.reply_to ? bySeq.get(m.reply_to) : undefined;
  const name = senderName(m);
  const notice = deliveryNotice(m);
  // 받는 사람 표시: 오너에게 온 글은 `나에게만`, 비서에게 간 글은 `@이름에게만`.
  // '나'라는 이름의 비서가 있을 수 있으므로 이름이 아니라 수신자 ID 로 구분한다.
  const toMe = m.recipient?.id === "owner";
  const dm = m.recipient ? (toMe ? "나" : m.recipient.name) : null;

  // Esc: 열린 메뉴만 닫고 이벤트를 소비한다(방 화면·스레드 패널의 문서 핸들러가 함께 닫히면 초안이 사라진다).
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

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
          <Avatar name={isOwner ? "나" : m.sender.name || "?"} />
        )}
      </div>

      <div className="msg-body">
        <div className="msg-head">
          {grouped ? null : <span className={"msg-name" + (isOwner ? " is-owner" : "")}>{name}</span>}
          {grouped ? null : (
            <span className="msg-time" title={fmtFull(m.created_at)}>
              {fmtTime(m.created_at)}
            </span>
          )}
          {dm ? (
            <span className="msg-dm" title={`${dm}에게만`}>
              {toMe ? "나에게만" : `@${dm}에게만`}
            </span>
          ) : null}
          {m.kind !== "message" ? <span className="msg-kind">{KIND_LABEL[m.kind] ?? m.kind}</span> : null}

          <div className="msg-actions" role="group" aria-label="메시지 작업">
            <button type="button" className="msg-action" onClick={() => onOpenThread(m.seq)} aria-label="스레드에 답글" title="스레드에 답글" aria-expanded={!!threadOpen}>
              <Icon name="thread" size={14} />
            </button>
            {agent && agent.status === "active" ? (
              <button type="button" className="msg-action" onClick={() => onMention(agent)} aria-label={`${agent.name} 지목`} title={`@${agent.name} 지목`}>
                <Icon name="at" size={15} />
              </button>
            ) : null}
            <div
              className="msg-menu-wrap"
              ref={menuRef}
              onKeyDown={(e) => {
                if (e.key !== "Escape" || !menuOpen) return;
                e.preventDefault();
                e.stopPropagation();
                setMenuOpen(false);
                menuRef.current?.querySelector<HTMLButtonElement>("[aria-expanded]")?.focus();
              }}
            >
              <button
                type="button"
                className="msg-action"
                aria-expanded={menuOpen}
                aria-label="더 보기"
                title="더 보기"
                onClick={() => setMenuOpen((v) => !v)}
              >
                <Icon name="more" size={15} />
              </button>
              {menuOpen ? (
                <div className="msg-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onQuoteReply(m);
                    }}
                  >
                    <Icon name="reply" size={14} /> 인용 답장
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onCopy(m);
                    }}
                  >
                    <Icon name="copy" size={14} /> 본문 복사
                  </button>
                  {!m.deleted ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="is-danger"
                      onClick={() => {
                        setMenuOpen(false);
                        onDelete(m);
                      }}
                    >
                      <Icon name="trash" size={14} /> 삭제
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {m.reply_to ? (
          <button type="button" className="reply-quote" onClick={() => onJump(m.reply_to!)} aria-label="원문으로 이동">
            {parent ? (
              <>
                <strong>{senderName(parent)}</strong> · {parent.deleted ? "삭제된 메시지" : plainPreview(parent.content)}
              </>
            ) : (
              <>원문을 불러오지 못했습니다</>
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
            title={`마지막 답글 ${fmtFull(summary.lastAt)}`}
          >
            <span className="thread-mark" aria-hidden="true">
              └
            </span>
            답글 {summary.count}
          </button>
        ) : null}

        {notice ? (
          <span className="msg-notice" title={notice.title}>
            {notice.label}
          </span>
        ) : null}
      </div>
    </li>
  );
}
