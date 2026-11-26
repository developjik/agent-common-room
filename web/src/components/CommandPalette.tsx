// ⌘K / Ctrl+K 이동 팔레트: 화면·방·비서·명령을 한 입력으로 찾는다(Raycast식).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "./icons.js";
import { paletteItems, type PaletteAction } from "../lib/views.js";
import type { AgentSummary, RoomCard } from "../lib/types.js";

interface Props {
  rooms: RoomCard[];
  agents: AgentSummary[];
  onClose: () => void;
  onPick: (action: PaletteAction) => void;
}

export function CommandPalette({ rooms, agents, onClose, onPick }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const items = useMemo(() => paletteItems({ rooms, agents }, query), [rooms, agents, query]);
  const active = Math.min(index, Math.max(0, items.length - 1));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (i: number) => {
    const item = items[i];
    if (item) onPick(item.action);
    else onClose();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // 한글 조합 중 Enter는 글자 확정이지 선택이 아니다.
    if (e.nativeEvent.isComposing || (e.nativeEvent as unknown as { keyCode?: number }).keyCode === 229) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((n) => (items.length ? (Math.min(n, items.length - 1) + 1) % items.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((n) => (items.length ? (Math.min(n, items.length - 1) - 1 + items.length) % items.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  let lastGroup = "";

  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="검색·이동">
        <div className="palette-input-wrap">
          <Icon name="search" size={17} className="text-muted" />
          <input
            ref={inputRef}
            className="palette-input"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items.length ? `palette-item-${active}` : undefined}
            placeholder="방, 비서, 화면으로 이동…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="kbd">ESC</kbd>
        </div>
        {items.length === 0 ? (
          <p className="palette-empty">찾는 항목이 없습니다.</p>
        ) : (
          <ul id="palette-list" role="listbox" className="palette-list" ref={listRef}>
            {items.map((it, i) => {
              const head = it.group !== lastGroup ? it.group : "";
              lastGroup = it.group;
              return (
                <li key={it.id} role="presentation">
                  {head ? <p className="palette-group">{head}</p> : null}
                  <button
                    type="button"
                    id={`palette-item-${i}`}
                    data-idx={i}
                    role="option"
                    aria-selected={i === active}
                    className="palette-item"
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => run(i)}
                  >
                    <Icon name={it.icon ?? (it.group === "방" ? "rooms" : it.group === "비서" ? "bot" : "gauge")} size={15} className="shrink-0 text-muted" />
                    <span className="palette-label">{it.label}</span>
                    {it.hint ? <span className="palette-hint">{it.hint}</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="palette-foot">
          <span>
            <kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> 이동
          </span>
          <span>
            <kbd className="kbd">Enter</kbd> 열기
          </span>
        </p>
      </div>
    </div>
  );
}
