import { useCallback, useEffect, useState } from "react";
import { AuthScreen } from "./components/AuthScreen.js";
import { AppShell } from "./components/AppShell.js";
import { ConfirmProvider } from "./components/ConfirmDialog.js";
import { ToastProvider } from "./components/Toast.js";
import { ApiError, api } from "./lib/api.js";
import { parseRoute, routeHref, type Route } from "./lib/route.js";
import { useTheme } from "./hooks/useTheme.js";
import type { Owner, Workspace } from "./lib/types.js";

export function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <Boot />
      </ConfirmProvider>
    </ToastProvider>
  );
}

type Phase = "boot" | "auth" | "ready" | "error";

function Boot() {
  const [theme, setTheme] = useTheme();
  const [phase, setPhase] = useState<Phase>("boot");
  const [owner, setOwner] = useState<Owner | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [error, setError] = useState<string>("");
  const [route, setRoute] = useState<Route>(() => parseRoute(location.search));

  const load = useCallback(async () => {
    setPhase("boot");
    try {
      const me = await api.me();
      setOwner(me.owner);
      setWorkspaces(me.workspaces);
      setPhase("ready");
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setPhase("auth");
        return;
      }
      setError(e instanceof Error ? e.message : "계정을 불러오지 못했습니다.");
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 뒤로/앞으로: 주소가 곧 화면이다.
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((next: Route) => {
    const href = routeHref(next);
    const current = location.pathname + location.search;
    if (href !== current && href !== location.search) history.pushState(null, "", href);
    setRoute(next);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* 서버가 응답하지 않아도 화면은 로그인으로 돌린다(다음 요청이 401이면 같은 결과). */
    }
    setOwner(null);
    setWorkspaces([]);
    setPhase("auth");
    document.title = "Agent Lounge";
    history.replaceState(null, "", "/");
    setRoute({ view: "rooms", roomId: null });
  }, []);

  const unauthorized = useCallback(() => {
    setOwner(null);
    setWorkspaces([]);
    setPhase("auth");
    document.title = "Agent Lounge";
  }, []);

  if (phase === "boot") {
    return (
      <div className="boot" role="status" aria-live="polite">
        <span className="brand-mark" aria-hidden="true">
          A
        </span>
        <p className="boot-text">계정을 확인하는 중…</p>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="boot">
        <span className="brand-mark" aria-hidden="true">
          A
        </span>
        <h1 className="mt-4 text-[16px] font-extrabold">화면을 열지 못했습니다</h1>
        <p className="mt-2 max-w-sm text-center text-[13px] leading-relaxed text-muted">{error}</p>
        <div className="mt-4 flex gap-2">
          <button type="button" className="btn btn-primary" onClick={() => void load()}>
            다시 시도
          </button>
          <button type="button" className="btn" onClick={() => setPhase("auth")}>
            로그인 화면
          </button>
        </div>
      </div>
    );
  }

  if (phase === "auth" || !owner) {
    return <AuthScreen onAuthed={() => void load()} />;
  }

  const workspace = workspaces[0];
  if (!workspace) {
    return (
      <div className="boot">
        <span className="brand-mark" aria-hidden="true">
          A
        </span>
        <h1 className="mt-4 text-[16px] font-extrabold">워크스페이스가 없습니다</h1>
        <p className="mt-2 max-w-sm text-center text-[13px] leading-relaxed text-muted">
          이 계정에 연결된 워크스페이스가 없습니다. 서버를 다시 설치하거나 관리자에게 문의하세요.
        </p>
        <button type="button" className="btn mt-4" onClick={() => void logout()}>
          로그아웃
        </button>
      </div>
    );
  }

  return (
    <AppShell
      owner={owner}
      workspace={workspace}
      route={route}
      onNavigate={navigate}
      onLogout={logout}
      onUnauthorized={unauthorized}
      theme={theme}
      onTheme={setTheme}
    />
  );
}
