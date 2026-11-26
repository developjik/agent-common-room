// 화면 경로. SPA 라우팅 설정 없이 쿼리 파라미터만 쓴다.
//   /                 관제실(홈)
//   /?view=inbox      통합 인박스
//   /?view=rooms      방 목록
//   /?view=desk       비서실
//   /?view=settings   설정
//   /?room=room_x     방 집중 뷰
// 경로 라우팅(/rooms/:id)은 세 런타임의 fallback을 모두 고쳐야 하므로 v2에서는 쿼리로 둔다.

export type View = "home" | "inbox" | "rooms" | "desk" | "settings";
export type Tab = "home" | "inbox" | "rooms" | "desk";

export interface Route {
  view: View;
  roomId: string | null;
}

export const VIEWS: readonly View[] = ["home", "inbox", "rooms", "desk", "settings"];

const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseView(raw: string | null | undefined): View {
  return (VIEWS as readonly string[]).includes(String(raw)) ? (raw as View) : "home";
}

/** 검색 문자열(‘?’ 포함/미포함 모두)을 경로로 해석한다. 방 ID가 있으면 방 집중 뷰가 우선한다. */
export function parseRoute(search: string): Route {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const roomId = params.get("room");
  if (roomId && ROOM_ID.test(roomId)) return { view: "home", roomId };
  return { view: parseView(params.get("view")), roomId: null };
}

/** 경로의 href. 홈은 쿼리 없이 `/` 하나로 둔다. */
export function routeHref(route: Route): string {
  if (route.roomId) return `?room=${encodeURIComponent(route.roomId)}`;
  if (route.view === "home") return "/";
  return `?view=${route.view}`;
}

/** 좌측 레일·하단 탭에서 켜져 있어야 하는 탭. 방을 보고 있으면 ‘방’ 탭이 활성이다. */
export function activeTab(route: Route): Tab {
  if (route.roomId) return "rooms";
  if (route.view === "settings") return "home";
  return route.view as Tab;
}

/** 브라우저 주소만 바꾼다(문서 재로딩 없음). 같은 경로면 아무 것도 하지 않는다. */
export function pushRoute(route: Route): void {
  const href = routeHref(route);
  if (href === location.pathname + location.search || href === location.search) return;
  history.pushState(null, "", href);
}
