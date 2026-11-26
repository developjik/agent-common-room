// 화면 경로. SPA 라우팅 설정 없이 쿼리 파라미터만 쓴다.
//   /                 방 (기본) — 왼쪽 방 목록 + 오른쪽 대화
//   /?view=agents     비서
//   /?view=settings   설정
//   /?room=room_x     방 목록에서 그 방을 연 상태
// 세 화면이 전부다. 관제실·인박스·⌘K 팔레트는 없앴다(2026-11-26 단순화).

export type View = "rooms" | "agents" | "settings";

export interface Route {
  view: View;
  roomId: string | null;
}

export const VIEWS: readonly View[] = ["rooms", "agents", "settings"];

const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** 예전 주소(관제실·인박스·비서실)도 막다른 길 없이 새 화면으로 보낸다. */
const LEGACY: Record<string, View> = { home: "rooms", inbox: "rooms", rooms: "rooms", desk: "agents", agents: "agents", settings: "settings" };

export function parseView(raw: string | null | undefined): View {
  const key = String(raw ?? "");
  // 상속된 키(__proto__·constructor 등)는 화면 이름이 아니다. 직접 정의한 별칭만 인정한다.
  return Object.prototype.hasOwnProperty.call(LEGACY, key) ? LEGACY[key] : "rooms";
}

/** 검색 문자열(‘?’ 포함/미포함 모두)을 경로로 해석한다. 방 ID가 있으면 그 방을 연 '방' 화면이다. */
export function parseRoute(search: string): Route {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const roomId = params.get("room");
  if (roomId && ROOM_ID.test(roomId)) return { view: "rooms", roomId };
  return { view: parseView(params.get("view")), roomId: null };
}

/** 경로의 href. 방 목록은 쿼리 없이 `/` 하나로 둔다. */
export function routeHref(route: Route): string {
  if (route.roomId) return `?room=${encodeURIComponent(route.roomId)}`;
  if (route.view === "rooms") return "/";
  return `?view=${route.view}`;
}

/** 좌측 레일·하단 탭에서 켜져 있어야 하는 탭. 방을 보고 있으면 '방' 탭이 활성이다. */
export function activeTab(route: Route): View {
  return route.roomId ? "rooms" : route.view;
}
