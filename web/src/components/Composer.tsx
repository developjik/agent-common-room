// 슬랙형 컴포저: @멘션 자동완성(키보드 선택), 답장 대상 칩, Enter 전송 / Shift+Enter 줄바꿈,
// IME(한글) 조합 중 Enter는 전송하지 않는다. 보내는 동안은 중복 전송을 막는다.
// 기본 화면은 입력 + 받는 사람 + 전송만 둔다. 메시지 종류는 `＋` 옵션을 열어야 고르고,
// 보내면 항상 기본(일반)으로 돌아간다(종류가 남아 다음 글이 잘못 라벨링되던 문제).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Avatar } from "./Avatar.js";
import { Icon } from "./icons.js";
import { completeMention, mentionTokenAt } from "../lib/mention.js";
import { activeAgent, KIND_LABEL, plainPreview, senderName } from "../lib/format.js";
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

/** 기본 화면에서 쓰는 종류 이름. `메시지`는 이 화면에서 '일반'으로 부른다. */
const KIND_CHOICES: { value: string; label: string }[] = [
  { value: "message", label: "일반" },
  { value: "question", label: "질문" },
  { value: "answer", label: "답변" },
  { value: "status", label: "상태" },
];
const kindLabel = (kind: string) => KIND_CHOICES.find((k) => k.value === kind)?.label ?? KIND_LABEL[kind] ?? kind;

export function Composer({ agents, recipient, onRecipient, replyTo, onCancelReply, onSend, seed, focusNonce, allowRecipientMention = true, placeholder, compact, autoFocus }: Props) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState("message");
  const [kindOpen, setKindOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [mention, setMention] = useState<{ query: string; index: number } | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // 보조 옵션(종류) 칩 묶음. 키보드로 열었을 때는 칩으로 바로 들어갈 수 있게 포커스를 옮긴다.
  const extrasRef = useRef<HTMLDivElement | null>(null);
  // 본문 끝에 이름을 넣은 뒤 커서를 이름 뒤로 옮긴다(React 재렌더 후에 적용).
  const pendingCaret = useRef<number | null>(null);

  useEffect(() => {
    const at = pendingCaret.current;
    if (at === null) return;
    pendingCaret.current = null;
    const el = taRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(at, at);
  }, [text]);

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
    if (focusNonce) taRef.current?.focus();
  }, [focusNonce]);

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
      pendingCaret.current = done.caret;
      setText(done.text);
    }
    onRecipient(a.id);
    setMention(null);
    taRef.current?.focus();
  }

  async function submit() {
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      await onSend({ content, kind, recipient, reply_to: replyTo?.seq });
      setText("");
      setMention(null);
      // 받는 사람과 마찬가지로 종류도 기본(일반)으로 돌린다. 남겨 두면 다음 글이 엉뚱한 라벨로 나간다.
      setKind("message");
      setKindOpen(false);
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

  return (
    <form
      className={compact ? "composer px-3 pb-3 pt-1" : "composer border-t border-line pt-2"}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {/* 받는 사람(@비서에게만)은 방 헤더 아래 핀에서 보여 주고 해제한다 — 같은 말을 두 번 하지 않는다. */}
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
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(a);
                }}
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
          placeholder={placeholder ?? "오너로 메시지 보내기"}
          aria-label="메시지 내용"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            updateMention(e.target);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => window.setTimeout(() => setMention(null), 120)}
        />

        {!compact && kindOpen ? (
          <div className="composer-extras" id="composer-extras" ref={extrasRef} role="group" aria-label="보내는 종류">
            {KIND_CHOICES.map((k) => (
              <button
                key={k.value}
                type="button"
                className="filter-chip"
                aria-pressed={kind === k.value}
                onClick={() => setKind(k.value)}
              >
                {k.label}
              </button>
            ))}
            <span className="composer-extras-hint">보내는 글의 종류입니다. 기본은 일반.</span>
          </div>
        ) : null}

        {compact ? (
          <div className="composer-toolbar justify-end">
            <button type="submit" className="btn btn-primary btn-sm" disabled={!text.trim() || sending} aria-label="스레드에 보내기">
              <Icon name="send" size={14} /> 보내기
            </button>
          </div>
        ) : (
          <div className="composer-toolbar">
            <label className="sr-only" htmlFor="composer-recipient">
              받는 사람
            </label>
            <select
              id="composer-recipient"
              className="field"
              value={recipientAgent ? recipient : ""}
              onChange={(e) => onRecipient(e.target.value)}
            >
              <option value="">방 전체</option>
              {live.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-icon composer-opt"
              aria-expanded={kindOpen}
              aria-controls="composer-extras"
              aria-label="보내기 옵션 (메시지 종류)"
              title="보내기 옵션 (메시지 종류)"
              onClick={(e) => {
                const opening = !kindOpen;
                setKindOpen(opening);
                // e.detail === 0 은 키보드(Enter/Space) 활성화다. 칩은 이 버튼보다 DOM 앞이라
                // Tab으로는 지나쳐 버리므로, 열자마자 지금 종류로 포커스를 옮긴다.
                if (opening && e.detail === 0) {
                  window.setTimeout(() => extrasRef.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus(), 0);
                }
              }}
            >
              <Icon name="plus" size={15} />
              {kind !== "message" ? <span className="composer-opt-text">{kindLabel(kind)}</span> : null}
            </button>
            <span className="composer-hint hidden sm:inline">
              <strong>Enter</strong> 전송 · <strong>Shift+Enter</strong> 줄바꿈
            </span>
            <span className="flex-1" />
            <button type="submit" className="btn btn-primary btn-sm" disabled={!text.trim() || sending}>
              <Icon name="send" size={14} /> 전송
            </button>
          </div>
        )}
      </div>
    </form>
  );
}
