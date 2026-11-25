// 확인 시트. 되돌릴 수 없는 조작(폐기·거절·삭제) 직전에 한 번 묻는다.
// Promise 기반이라 호출부는 `if (!(await confirm({...}))) return;` 한 줄로 끝난다.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export interface ConfirmOptions {
  title: string;
  text?: string;
  ok?: string;
  danger?: boolean;
}

type Ask = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Ask>(() => Promise.resolve(false));

export function useConfirm() {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ opts: ConfirmOptions; resolve: (v: boolean) => void } | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const okRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  const ask = useCallback<Ask>((opts) => {
    return new Promise<boolean>((resolve) => {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setState({ opts, resolve });
    });
  }, []);

  const close = useCallback(
    (answer: boolean) => {
      setState((cur) => {
        cur?.resolve(answer);
        return null;
      });
      const back = returnFocus.current;
      returnFocus.current = null;
      window.setTimeout(() => {
        try {
          back?.focus();
        } catch {
          /* 사라진 버튼이면 포커스 복귀는 생략한다. */
        }
      }, 0);
    },
    [],
  );

  useEffect(() => {
    if (!state) return;
    // 파괴적 확인(삭제·폐기·거절)은 기본 포커스를 '취소'에 둔다.
    // 삭제 버튼에 포커스가 있으면 Enter 한 번에 되돌릴 수 없는 일이 일어난다.
    const initial = state.opts.danger ? cancelRef.current : (okRef.current ?? cancelRef.current);
    initial?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(false);
      }
      if (e.key === "Tab" && okRef.current) {
        const dialog = okRef.current.closest(".dialog");
        const nodes = dialog
          ? [...dialog.querySelectorAll<HTMLButtonElement>("button")].filter((n) => !n.disabled)
          : [];
        if (nodes.length < 2) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state, close]);

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {state ? (
        <div
          className="dialog-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) close(false);
          }}
        >
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
            <h2 id="confirm-title" className="text-base font-extrabold">
              {state.opts.title}
            </h2>
            {state.opts.text ? (
              <p className="mt-2 whitespace-pre-line text-[13px] leading-relaxed text-muted">{state.opts.text}</p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <button ref={cancelRef} type="button" className="btn" onClick={() => close(false)}>
                취소
              </button>
              <button
                ref={okRef}
                type="button"
                className={"btn " + (state.opts.danger ? "btn-danger" : "btn-primary")}
                onClick={() => close(true)}
              >
                {state.opts.ok ?? "확인"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </ConfirmContext.Provider>
  );
}
