// 앱 껍데기: 좌측 레일(데스크톱) · 상단 바 · 모바일 하단 탭.
// 화면은 세 개뿐이다 — 방 · 비서 · 설정. 관제실·인박스·⌘K 팔레트는 없앴다.
import { useCallback, useEffect, useState } from "react";
import { RoomsView } from "./RoomsView.js";
import { AgentsView } from "./AgentsView.js";
import { SettingsView } from "./SettingsView.js";
import { Icon, type IconName } from "./icons.js";
import { useToast } from "./Toast.js";
import { useWorkspace } from "../hooks/useWorkspace.js";
import { useMediaQuery, type Theme } from "../hooks/useTheme.js";
import { activeTab, type Route, type View } from "../lib/route.js";
import { unreadRoomCount } from "../lib/views.js";
import type { Owner, Workspace } from "../lib/types.js";

interface Props {
  owner: Owner;
  workspace: Workspace;
  route: Route;
  onNavigate: (route: Route) => void;
  onLogout: () => void;
  onUnauthorized: () => void;
  theme: Theme;
  onTheme: (t: Theme) => void;
}

const TABS: { key: View; label: string; icon: IconName }[] = [
  { key: "rooms", label: "방", icon: "rooms" },
  { key: "agents", label: "비서", icon: "bot" },
  { key: "settings", label: "설정", icon: "settings" },
];

const TITLES: Record<View, string> = { rooms: "방", agents: "비서", settings: "설정" };

export function AppShell({ owner, workspace, route, onNavigate, onLogout, onUnauthorized, theme, onTheme }: Props) {
  const store = useWorkspace({ workspace, roomId: route.roomId, view: route.view, onUnauthorized });
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const isWide = useMediaQuery("(min-width: 1180px)");
  const notify = useToast();
  const [lastError, setLastError] = useState<string | null>(null);

  const tab = activeTab(route);
  const rooms = store.overview?.rooms ?? [];
  const unreadRooms = unreadRoomCount(rooms);
  const title = route.roomId ? store.room?.name ?? TITLES.rooms : TITLES[route.view];

  useEffect(() => {
    document.title = `${unreadRooms ? `(${unreadRooms}) ` : ""}${title} · ${workspace.name}`;
  }, [unreadRooms, title, workspace.name]);

  // 오류는 한 번만 토스트로 알린다(연결 끊김 배너는 방 화면이 계속 보여 준다).
  useEffect(() => {
    if (store.error && store.error !== lastError && store.ready) {
      setLastError(store.error);
      notify(store.error);
    }
    if (!store.error) setLastError(null);
  }, [store.error, store.ready, lastError, notify]);

  const goView = useCallback((view: View) => onNavigate({ view, roomId: null }), [onNavigate]);
  const openRoom = useCallback((roomId: string) => onNavigate({ view: "rooms", roomId }), [onNavigate]);
  const backToRooms = useCallback(() => onNavigate({ view: "rooms", roomId: null }), [onNavigate]);

  const content =
    route.view === "agents" ? (
      <AgentsView store={store} workspace={workspace} onOpenRoom={openRoom} />
    ) : route.view === "settings" ? (
      <SettingsView owner={owner} workspace={workspace} theme={theme} onTheme={onTheme} onLogout={onLogout} />
    ) : (
      <RoomsView store={store} workspace={workspace} roomId={route.roomId} isWide={isWide} onOpenRoom={openRoom} onBack={backToRooms} />
    );

  const railButton = (key: View, label: string, icon: IconName, badge?: number) => (
    <button
      key={key}
      type="button"
      className="rail-btn"
      aria-label={label}
      aria-current={tab === key ? "page" : undefined}
      title={label}
      onClick={() => goView(key)}
    >
      <Icon name={icon} size={20} />
      <span className="rail-label">{label}</span>
      {badge ? <span className="rail-badge">{badge > 99 ? "99+" : badge}</span> : null}
    </button>
  );

  return (
    <div className="shell">
      {isDesktop ? (
        <nav className="rail" aria-label="주요 화면">
          <div className="rail-logo" title={workspace.name} aria-hidden="true">
            {Array.from(workspace.name.trim())[0] ?? "A"}
          </div>
          <div className="rail-group">
            {railButton("rooms", "방", "rooms", unreadRooms)}
            {railButton("agents", "비서", "bot")}
            {railButton("settings", "설정", "settings")}
          </div>
          <div className="rail-spacer" />
          <div className="rail-group">
            <button type="button" className="rail-btn" aria-label="로그아웃" title="로그아웃" onClick={onLogout}>
              <Icon name="logout" size={19} />
              <span className="rail-label">로그아웃</span>
            </button>
          </div>
        </nav>
      ) : null}

      <div className="shell-main">
        {isDesktop && !route.roomId ? (
          <header className="topbar">
            <div className="topbar-title">
              <h1 className="topbar-heading">{title}</h1>
              <span className="topbar-meta">{workspace.name}</span>
            </div>
          </header>
        ) : null}

        <div className="shell-view is-plain">{content}</div>
      </div>

      {!isDesktop ? (
        <nav className="mobile-tabs" aria-label="주요 화면">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className="mobile-tab"
              aria-current={tab === t.key ? "page" : undefined}
              onClick={() => goView(t.key)}
            >
              <span className="mobile-tab-icon">
                <Icon name={t.icon} size={20} />
                {t.key === "rooms" && unreadRooms ? <span className="mobile-tab-badge">{unreadRooms > 9 ? "9+" : unreadRooms}</span> : null}
              </span>
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
