// 초단순 모던 컴포저.
// - 입력한 만큼 1줄에서 최대 6줄(160px)까지 자라고, 그 위로는 내부 스크롤. 전송하면 1줄로 돌아온다.
// - 받는 사람은 네이티브 select 대신 `@` 버튼(커서 자리에 @ 삽입 + 자동완성)과
//   선택된 비서 칩(`@이름 ×`)으로만 다룬다. 메시지 종류는 고르지 않고 항상 message로 보낸다.
// - Enter 전송 / Shift+Enter 줄바꿈, IME(한글) 조합 중 Enter는 보내지 않는다. 보내는 동안 중복 전송을 막는다.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Avatar } from "./Avatar.js";
import { Icon } from "./icons.js";
import { completeMention, mentionTokenAt } from "../lib/mention.js";
import { activeAgent, plainPreview, senderName } from "../lib/format.js";
import type { Agent, Message } from "../lib/types.js";

export interface SendInput {
  content: string;
  kind: string;
  recipient: string;
  reply_to?: number;
}

interface Props {
  agents: Agent[];
  recipient: string;
  onRecipient: (id: string) => void;
  replyTo?: Message | null;
  onCancelReply?: () => void;
  onSend: (input: SendInput) => Promise<void>;
  seed?: { text: string; nonce: number } | null;
  focusNonce?: number;
  /** false면 @ 수신자 자동완성을 끈다(방 전체 공개 전용인 스레드 입력창). */
  allowRecipientMention?: boolean;
  placeholder?: string;
  compact?: boolean;
  autoFocus?: boolean;
}

/** 한 줄 높이부터 이 높이까지만 자란다(약 6줄). 넘으면 textarea 안에서 스크롤한다. */
export const MAX_TEXTAREA_HEIGHT = 160;
/** 이 컴포저가 보내는 유일한 메시지 종류. 종류 선택 UI는 없앴다. */
const SEND_KIND = "message";

/** 내용 높이에 맞춰 textarea 높이를 다시 잡는다(1줄 → 최대 160px, 그 위는 스크롤). */
function autoSize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  const full = el.scrollHeight;
  el.style.height = `${Math.min(full, MAX_TEXTAREA_HEIGHT)}px`;
  el.style.overflowY = full > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
}

export function Composer({ agents, recipient, onRecipient, replyTo, onCancelReply, onSend, seed, focusNonce, allowRecipientMention = true, placeholder, compact, autoFocus }: Props) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [mention, setMention] = useState<{ query: string; index: number } | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // 본문에 이름을 넣은 뒤 커서를 그 뒤로 옮긴다(React 재렌더 후에 적용).
  const pendingCaret = useRef<number | null>(null);
  // 불러오기 지연 시간: 입력창을 떠난 뒤에만 자동완성을 닫는다(다시 들어와 연 목록을 지우지 않게).
  const blurTimer = useRef<number | null>(null);

  useEffect(() => {
    const at = pendingCaret.current;
    if (at === null) return;
    pendingCaret.current = null;
    const el = taRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(at, at);
  }, [text]);

  // 내용이 바뀔 때마다 높이를 다시 잰다. 전송으로 비면 1줄로 돌아온다.
  useEffect(() => {
    autoSize(taRef.current);
  }, [text]);

  // 화면 폭이 바뀌면(회전·창 크기) 줄바꿈 위치가 달라져 높이도 달라진다.
  useEffect(() => {
    const onResize = () => autoSize(taRef.current);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (seed) {
      setText(seed.text);
      const el = taRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }
  }, [seed]);

  useEffect(() => {
    if (autoFocus) taRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (focusNonce) {
      // 다른 곳(구성원 목록 등)에서 지목해 포커스를 돌려받으면 열려 있던 자동완성은 닫는다.
      // 그대로 두면 Enter가 메시지 전송 대신 낡은 후보 선택이 되어 방금 지목한 수신자를 덮어쓴다.
      setMention(null);
      taRef.current?.focus();
    }
  }, [focusNonce]);

  useEffect(() => {
    return () => {
      if (blurTimer.current !== null) window.clearTimeout(blurTimer.current);
    };
  }, []);

  const live = useMemo(() => agents.filter((a) => a.status === "active"), [agents]);
  const candidates = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return live.filter((a) => a.name.toLowerCase().includes(q)).slice(0, 8);
  }, [mention, live]);

  const closed = mention === null || candidates.length === 0;
  const selected = mention && candidates.length ? Math.min(mention.index, candidates.length - 1) : 0;

  function updateMention(el: HTMLTextAreaElement) {
    if (!allowRecipientMention) {
      setMention(null);
      return;
    }
    const caret = el.selectionStart ?? el.value.length;
    const token = mentionTokenAt(el.value, caret);
    setMention(token ? { query: token.query, index: 0 } : null);
  }

  function choose(a: Agent) {
    // 칩(받는 사람)만 바꾸고 본문을 `@Ins`로 두면 상대는 자기 지목으로 읽지 못한다.
    // 입력한 검색어 구간을 고른 이름으로 완성한다.
    const el = taRef.current;
    const caret = el?.selectionStart ?? text.length;
    const done = completeMention(text, caret, a.name);
    if (done.replaced) {
      if (done.text === text) {
        // 뒤 공백을 그대로 쓴 경우처럼 본문이 그대로면, 재렌더가 없으니 커서를 바로 옮긴다.
        el?.focus();
        el?.setSelectionRange(done.caret, done.caret);
      } else {
        pendingCaret.current = done.caret;
        setText(done.text);
      }
    }
    onRecipient(a.id);
    setMention(null);
    taRef.current?.focus();
  }

  /**
   * `@` 버튼: 커서 자리에 `@`를 넣고 자동완성 목록을 연다.
   * 앞 글자에 붙지 않게 한 칸 띄우고, 뒤에 이미 본문이 있으면 `@`와 본문 사이도 띄운다 —
   * 본문 단어가 검색어로 오인되어 지워지지 않게. 커서는 `@` 바로 뒤에 둔다.
   */
  function insertMentionMark() {
    const el = taRef.current;
    const value = el?.value ?? text;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? start;
    const leadSpace = start > 0 && !/\s/.test(value[start - 1]);
    const proseFollows = end < value.length;
    const mark = (leadSpace ? " @" : "@") + (proseFollows ? " " : "");
    const next = value.slice(0, start) + mark + value.slice(end);
    pendingCaret.current = start + mark.length - (proseFollows ? 1 : 0);
    setText(next);
    setMention(allowRecipientMention && live.length ? { query: "", index: 0 } : null);
    el?.focus();
  }

  async function submit() {
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      await onSend({ content, kind: SEND_KIND, recipient, reply_to: replyTo?.seq });
      setText("");
      setMention(null);
    } catch {
      // 호출부가 오류를 알린다. 입력 내용은 남겨 두어 다시 보낼 수 있게 한다.
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    const composing = e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229;
    if (!closed) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMention((m) => (m ? { ...m, index: (selected + 1) % candidates.length } : m));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMention((m) => (m ? { ...m, index: (selected - 1 + candidates.length) % candidates.length } : m));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (composing) return;
        e.preventDefault();
        choose(candidates[selected]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !composing) {
      e.preventDefault();
      void submit();
    }
  }

  const recipientAgent = activeAgent(agents, recipient);
  const canMention = allowRecipientMention && !compact;
  const hint =
    placeholder ??
    (compact
      ? "답글 입력"
      : recipientAgent
        ? `@${recipientAgent.name}에게만 보내기`
        : canMention && live.length
          ? "메시지 입력 (@로 비서 호출)"
          : "메시지 입력");
  const empty = !text.trim();

  return (
    <form
      className={compact ? "composer composer-compact px-3 pb-3 pt-1" : "composer border-t border-line pt-2"}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {replyTo ? (
        <div className="composer-chip">
          <Icon name="reply" size={14} />
          <span className="min-w-0 flex-1 truncate">
            답장 · <strong>{senderName(replyTo)}</strong> · {replyTo.deleted ? "삭제된 메시지" : plainPreview(replyTo.content)}
          </span>
          <button type="button" className="btn-icon h-6 w-6" onClick={onCancelReply} aria-label="답장 대상 해제">
            <Icon name="close" size={14} />
          </button>
        </div>
      ) : null}

      <div className="composer-box">
        {!closed ? (
          <div className="mention-popup" role="listbox" aria-label="참여자 지목">
            {candidates.map((a, i) => (
              <button
                key={a.id}
                type="button"
                role="option"
                aria-selected={i === selected}
                className="mention-item"
                // 포인터·보조 기술 모두 click 하나로 고른다. mousedown의 기본 동작(포커스 이동)만
                // 막아 본문 커서를 잃지 않게 한다.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(a)}
              >
                <Avatar name={a.name} small />
                <span className="font-semibold">@{a.name}</span>
                {a.product_self_declared ? <span className="mention-sub">{a.product_self_declared}</span> : null}
              </button>
            ))}
          </div>
        ) : null}

        <textarea
          ref={taRef}
          rows={1}
          maxLength={4000}
          placeholder={hint}
          aria-label="메시지 내용"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            updateMention(e.target);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            // 120ms 뒤에도 포커스가 입력창에 없을 때만 닫는다. 그 사이 다시 포커스해 연
            // 목록(예: @ 버튼을 눌러 연 팝업)을 낡은 타이머가 지우지 않게 한다.
            if (blurTimer.current !== null) window.clearTimeout(blurTimer.current);
            blurTimer.current = window.setTimeout(() => {
              blurTimer.current = null;
              if (document.activeElement !== taRef.current) setMention(null);
            }, 120);
          }}
        />

        {compact ? (
          <div className="composer-toolbar composer-toolbar-compact">
            <span className="flex-1" />
            <button type="submit" className="composer-send" disabled={empty || sending} aria-label="스레드에 보내기">
              <Icon name="send" size={14} />
              <span className="composer-send-text">보내기</span>
            </button>
          </div>
        ) : (
          <div className="composer-toolbar">
            {canMention && live.length ? (
              <button
                type="button"
                className="composer-at"
                aria-label="비서 호출 (@)"
                title="비서 호출 (@)"
                onMouseDown={(e) => e.preventDefault()}
                onClick={insertMentionMark}
              >
                <Icon name="at" size={15} />
              </button>
            ) : null}

            {recipientAgent ? (
              <span className="composer-recipient">
                <strong className="truncate">@{recipientAgent.name}</strong>
                <button
                  type="button"
                  className="composer-recipient-x"
                  onClick={() => onRecipient("")}
                  aria-label="받는 사람 해제 (방 전체로)"
                  title="방 전체로"
                >
                  <Icon name="close" size={12} />
                </button>
              </span>
            ) : null}

            <span className="composer-hint hidden sm:inline">
              <strong>Enter</strong> 전송 · <strong>Shift+Enter</strong> 줄바꿈
            </span>
            <span className="flex-1" />
            <button type="submit" className="composer-send" disabled={empty || sending} aria-label={sending ? "보내는 중" : "전송"}>
              <Icon name="send" size={14} />
              <span className="composer-send-text">{sending ? "보내는 중" : "전송"}</span>
            </button>
          </div>
        )}
      </div>
    </form>
  );
}
