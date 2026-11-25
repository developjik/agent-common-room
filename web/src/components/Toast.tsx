import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

interface ToastItem {
  id: number;
  text: string;
}

const ToastContext = createContext<(text: string) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef<number[]>([]);

  const notify = useCallback((text: string) => {
    const id = ++seq.current;
    setItems((prev) => [...prev.slice(-2), { id, text }]);
    const t = window.setTimeout(() => {
      setItems((prev) => prev.filter((i) => i.id !== id));
    }, 4200);
    timers.current.push(t);
  }, []);

  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const value = useMemo(() => notify, [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-wrap" aria-live="polite" aria-atomic="false">
        {items.map((i) => (
          <div key={i.id} className="toast" role="status">
            {i.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
