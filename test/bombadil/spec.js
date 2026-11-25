// Bombadil UI 프로퍼티 스펙.
// 대상은 로컬/프리뷰 워커(http://127.0.0.1:8787)뿐이며 운영 배포본에 붙지 않는다.
// 실행: wrangler dev --port 8787 을 띄운 뒤 `npm run test:ui`.
//
// always/eventually는 코어 패키지에서 import해야 한다 (browser 경유 re-export는 bombadil 번들러에서 호출 시 깨짐).
import { always } from "@antithesishq/bombadil";
import { actions, extract, registerCustomAction } from "@antithesishq/bombadil/browser";
export * from "@antithesishq/bombadil/browser/defaults";

// CI/로컬 전용 더미 관리자 키. .github/workflows/ci.yml의 .dev.vars와 같은 값이며 실제 비밀이 아니다.
const ADMIN_KEY = "test-admin-key-0123456789abcdef";

// 로그인 상태가 아니면 방을 하나 만들고 오너로 로그인한다.
// 이 액션 덕분에 탐색이 온보딩 화면에 갇히지 않고 실제 방 UI(메시지 피드/입력/관리 화면)까지 닿는다.
const bootstrapOwnerRoom = registerCustomAction("bootstrapOwnerRoom", async (document, window) => {
  if (window.sessionStorage.getItem("acr_session")) return;
  const r = await window.fetch("/api/admin/rooms", {
    method: "POST",
    headers: { authorization: "Bearer " + ADMIN_KEY, "content-type": "application/json" },
    body: JSON.stringify({ name: "bombadil 탐색 방" }),
  });
  if (!r.ok) return;
  const created = await r.json();
  const lr = await window.fetch("/api/owner/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ room_id: created.room_id, owner_code: created.owner_code }),
  });
  if (!lr.ok) return;
  const lj = await lr.json();
  window.sessionStorage.setItem("acr_session", lj.session_token);
  window.location.reload();
});

export const roomActions = actions(() => [bootstrapOwnerRoom()]);

const bodyText = extract((state) => state.document.body?.innerText ?? "");
const title = extract((state) => state.document.title ?? "");

// 어떤 탐색 상태에서도 본문이 완전히 비면 안 된다 (렌더 크래시/빈 화면 방지).
export const body_never_blank = always(() => bodyText.current.trim().length > 0);

// 모든 화면에 문서 타이틀이 있어야 한다.
export const title_present = always(() => title.current.trim().length > 0);

// 서버/런타임 오류 문구가 사용자 화면에 새어나오면 안 된다.
export const no_server_error_text = always(
  () => !/Internal Server Error|Unhandled Runtime Error|Traceback \(most recent/.test(bodyText.current),
);
