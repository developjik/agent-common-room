// 앱 껍데기: 56px 아이콘 레일(데스크톱) · 상단 바 · 뷰 전환 · ⌘K 팔레트 · 모바일 하단 탭 4개.
// Slack식 3단(채널 목록·메시지·플렉스페인)을 버리고, 첫 화면은 관제실이다.
import { useCallback, useEffect, useMemo, useState } from "react";
import { MissionControl } from "./MissionControl.js";
import { InboxView } from "./InboxView.js";
import { RoomsView } from "./RoomsView.js";
import { DeskView } from "./DeskView.js";
import { RoomView } from "./RoomView.js";
import { SettingsView } from "./SettingsView.js";
import { CommandPalette } from "./CommandPalette.js";
import { CreateRoomDialog } from "./CreateRoomDialog.js";
import { Icon, type IconName } from "./icons.js";
import { useConfirm } from "./ConfirmDialog.js";
import { useToast } from "./Toast.js";
import { useWorkspace } from "../hooks/useWorkspace.js";
import { useMediaQuery, type Theme } from "../hooks/useTheme.js";
import { activeTab, type Route, type Tab } from "../lib/route.js";
import { needsAttentionRoomIds, sortRoomCards, unreadRoomCount } from "../lib/views.js";
import type { Owner, RoomDetail, Workspace } from "../lib/types.js";

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

const TABS: { key: Tab; label: string; icon: IconName }[] = [
  { key: "home", label: "관제실", icon: "gauge" },
  { key: "inbox", label: "인박스", icon: "inbox" },
  { key: "rooms", label: "방", icon: "rooms" },
  { key: "desk", label: "비서실", icon: "bot" },
];

const THEME_LABEL: Record<Theme, string> = { light: "라이트", dark: "다크", system: "시스템" };
const THEME_ICON: Record<Theme, IconName> = { light: "sun", dark: "moon", system: "monitor" };

export function AppShell({ owner, workspace, route, onNavigate, onLogout, onUnauthorized, theme, onTheme }: Props) {
  const store = useWorkspace({ workspace, roomId: route.roomId, view: route.view, onUnauthorized });
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const isWide = useMediaQuery("(min-width: 1280px)");
  const notify = useToast();
  const confirm = useConfirm();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [jumpSeq, setJumpSeq] = useState<number | null>(null);
  const [deskFocus, setDeskFocus] = useState<{ kind: "agent" | "invite"; id?: string } | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const rooms = useMemo(() => sortRoomCards(store.overview?.rooms ?? []), [store.overview]);
  const tab = activeTab(route);
  const liveAgents = store.overview?.agents.filter((a) => a.status === "active").length ?? 0;
  // "답변 필요"는 어디서나 같은 값(인박스와 같은 기준의 고유 방 수)을 쓴다.
  // 상단바·레일·탭·문서 제목·홈 상태줄·방 목록 필터가 모두 이 수를 쓴다.
  const needRoomIds = useMemo(() => needsAttentionRoomIds(store.overview?.rooms ?? []), [store.overview]);
  const needRooms = store.overview?.counts.needs_you_rooms ?? needRoomIds.size;
  const unreadRooms = store.overview ? unreadRoomCount(store.overview.rooms) : 0;
  const viewTitle = route.roomId
    ? store.room?.name ?? "방"
    : route.view === "inbox"
      ? "인박스"
      : route.view === "rooms"
        ? "방"
        : route.view === "desk"
          ? "비서실"
          : route.view === "settings"
            ? "설정"
            : "관제실";

  // 창 제목: 답변을 기다리는 방 수를 먼저 알린다.
  useEffect(() => {
    document.title = `${needRooms ? `(${needRooms}) ` : ""}${viewTitle} · ${workspace.name}`;
  }, [needRooms, viewTitle, workspace.name]);

  // 오류는 한 번만 토스트로 알리고, 연결 끊김 배너는 화면이 계속 보여 준다.
  useEffect(() => {
    if (store.error && store.error !== lastError && store.ready) {
      setLastError(store.error);
      notify(store.error);
    }
    if (!store.error) setLastError(null);
  }, [store.error, store.ready, lastError, notify]);

  // ⌘K / Ctrl+K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const openRoom = useCallback(
    (roomId: string, seq?: number) => {
      setJumpSeq(typeof seq === "number" ? seq : null);
      onNavigate({ view: "home", roomId });
    },
    [onNavigate],
  );

  const goView = useCallback((view: Route["view"]) => onNavigate({ view, roomId: null }), [onNavigate]);

  const created = useCallback(
    (room: RoomDetail) => {
      setCreateOpen(false);
      notify(`'${room.name}' 방을 만들었습니다. 비서실에서 비서를 배치하세요.`);
      openRoom(room.id);
    },
    [notify, openRoom],
  );

  const deleteRoom = useCallback(
    async (room: RoomDetail) => {
      const ok = await confirm({
        title: `'${room.name}' 방을 삭제할까요?`,
        text: "방의 메시지·구성원 자격이 함께 사라집니다. 로비는 삭제할 수 없습니다.",
        ok: "삭제",
        danger: true,
      });
      if (!ok) return;
      try {
        await store.deleteRoom(room.id);
        notify(`'${room.name}' 방을 삭제했습니다.`);
        goView("home");
      } catch (e) {
        notify(e instanceof Error ? e.message : "방을 삭제하지 못했습니다.");
      }
    },
    [confirm, store, notify, goView],
  );

  const cycleTheme = () => onTheme(theme === "light" ? "dark" : theme === "dark" ? "system" : "light");

  const railButton = (key: Tab, label: string, icon: IconName, badge?: number) => (
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

  const content = route.roomId ? (
    <RoomView
      roomId={route.roomId}
      store={store}
      workspace={workspace}
      rooms={rooms}
      isWide={isWide}
      jumpSeq={jumpSeq}
      onConsumeJump={() => setJumpSeq(null)}
      onOpenRoom={openRoom}
      onGoView={goView}
      onCreateRoom={() => setCreateOpen(true)}
      onDeleteRoom={(room) => void deleteRoom(room)}
      onOpenPalette={() => setPaletteOpen(true)}
    />
  ) : route.view === "inbox" ? (
    <InboxView
      items={store.activity}
      rooms={rooms}
      ready={store.ready}
      needCount={needRooms}
      pendingCount={store.overview?.pending_requests ?? 0}
      onOpenRoom={openRoom}
      onGoRooms={() => goView("rooms")}
      onGoDesk={() => goView("desk")}
    />
  ) : route.view === "rooms" ? (
    <RoomsView
      rooms={rooms}
      agents={liveAgents}
      needRoomIds={needRoomIds}
      ready={store.ready}
      onOpenRoom={openRoom}
      onCreateRoom={() => setCreateOpen(true)}
      onGoHome={() => goView("home")}
    />
  ) : route.view === "desk" ? (
    <DeskView
      store={store}
      workspace={workspace}
      rooms={store.overview?.rooms ?? []}
      focus={deskFocus}
      onClearFocus={() => setDeskFocus(null)}
      onCreatedPoolInvite={(link) => notify(`초대 링크가 준비되었습니다: ${link}`)}
      onOpenRoom={openRoom}
    />
  ) : route.view === "settings" ? (
    <SettingsView
      owner={owner}
      workspace={workspace}
      theme={theme}
      onTheme={onTheme}
      onLogout={onLogout}
      syncedAt={store.syncedAt}
    />
  ) : (
    <MissionControl
      workspace={workspace}
      overview={store.overview}
      needRoomIds={needRoomIds}
      ready={store.ready}
      onOpenRoom={openRoom}
      onGoView={goView}
      onCreateRoom={() => setCreateOpen(true)}
      onRetry={() => void store.refresh({ full: true })}
      onInvite={() => {
        setDeskFocus({ kind: "invite" });
        goView("desk");
      }}
    />
  );

  return (
    <div className="shell">
      {isDesktop ? (
        <nav className="rail" aria-label="주요 화면">
          <div className="rail-logo" title={workspace.name} aria-hidden="true">
            {Array.from(workspace.name.trim())[0] ?? "A"}
          </div>
          <div className="rail-group">
            {railButton("home", "관제실", "gauge")}
            {railButton("inbox", "인박스", "inbox", needRooms)}
            {railButton("rooms", "방", "rooms", unreadRooms)}
            {railButton("desk", "비서실", "bot", store.overview?.pending_requests)}
          </div>
          <div className="rail-spacer" />
          <div className="rail-group">
            <button
              type="button"
              className="rail-btn"
              aria-label={`테마: ${THEME_LABEL[theme]}`}
              title={`테마: ${THEME_LABEL[theme]} (누르면 전환)`}
              onClick={cycleTheme}
            >
              <Icon name={THEME_ICON[theme]} size={19} />
              <span className="rail-label">테마</span>
            </button>
            <button
              type="button"
              className="rail-btn"
              aria-label="설정"
              aria-current={route.view === "settings" && !route.roomId ? "page" : undefined}
              title="설정"
              onClick={() => goView("settings")}
            >
              <Icon name="settings" size={19} />
              <span className="rail-label">설정</span>
            </button>
            <button type="button" className="rail-btn" aria-label="로그아웃" title="로그아웃" onClick={onLogout}>
              <Icon name="logout" size={19} />
              <span className="rail-label">로그아웃</span>
            </button>
          </div>
        </nav>
      ) : null}

      <div className="shell-main">
        <header className={"topbar" + (route.roomId ? " is-room" : "")}>
          <div className="topbar-title">
            <h1 className="topbar-heading">{viewTitle}</h1>
            {!route.roomId ? (
              <span className="topbar-meta">
                {workspace.name} · 방 {rooms.length}
                {needRooms ? ` · 답변 필요 ${needRooms}곳` : ""}
              </span>
            ) : null}
          </div>
          <button type="button" className="search-btn" onClick={() => setPaletteOpen(true)} aria-label="검색·이동 (⌘K)">
            <Icon name="search" size={15} />
            <span className="hidden sm:inline">검색·이동</span>
            {/* .kbd 가 display:inline-flex 라 같은 요소의 .hidden 을 덮어썼다 → 래퍼에 숨김을 건다. */}
            <span className="hidden sm:inline">
              <kbd className="kbd">⌘K</kbd>
            </span>
          </button>
          <div className="topbar-actions">
            <button type="button" className="btn btn-sm" onClick={() => setCreateOpen(true)}>
              <Icon name="plus" size={14} />
              <span className="hidden sm:inline">새 방</span>
            </button>
            {!isDesktop ? (
              <>
                <button type="button" className="btn-icon" onClick={cycleTheme} aria-label={`테마: ${THEME_LABEL[theme]}`}>
                  <Icon name={THEME_ICON[theme]} size={17} />
                </button>
                <button type="button" className="btn-icon" onClick={() => goView("settings")} aria-label="설정">
                  <Icon name="settings" size={17} />
                </button>
              </>
            ) : null}
          </div>
        </header>

        <div className="shell-view">{content}</div>
      </div>

      {!isDesktop ? (
        <nav className="mobile-tabs" aria-label="주요 화면">
          {TABS.map((t) => {
            const badge =
              t.key === "inbox"
                ? needRooms
                : t.key === "rooms"
                  ? unreadRooms
                  : t.key === "desk"
                    ? store.overview?.pending_requests
                    : undefined;
            return (
              <button
                key={t.key}
                type="button"
                className="mobile-tab"
                aria-current={tab === t.key ? "page" : undefined}
                onClick={() => goView(t.key)}
              >
                <span className="mobile-tab-icon">
                  <Icon name={t.icon} size={20} />
                  {badge ? <span className="mobile-tab-badge">{badge > 9 ? "9+" : badge}</span> : null}
                </span>
                <span>{t.label}</span>
              </button>
            );
          })}
        </nav>
      ) : null}

      {paletteOpen ? (
        <CommandPalette
          rooms={store.overview?.rooms ?? []}
          agents={store.overview?.agents ?? []}
          onClose={() => setPaletteOpen(false)}
          onPick={(action) => {
            setPaletteOpen(false);
            if (action.type === "view") goView(action.view);
            else if (action.type === "room") openRoom(action.roomId);
            else if (action.type === "agent") {
              setDeskFocus({ kind: "agent", id: action.agentId });
              goView("desk");
            } else if (action.type === "new-room") setCreateOpen(true);
            else if (action.type === "invite") {
              setDeskFocus({ kind: "invite" });
              goView("desk");
            }
          }}
        />
      ) : null}

      {createOpen ? (
        <CreateRoomDialog
          onClose={() => setCreateOpen(false)}
          onCreate={async (name, description) => {
            const room = await store.createRoom(name, description);
            created(room);
          }}
        />
      ) : null}
    </div>
  );
}
