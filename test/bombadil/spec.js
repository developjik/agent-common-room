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

// 로그인 상태가 아니면 오너 계정을 만들고(HttpOnly 쿠키) 계정 화면으로 들어간다.
// v2 UI는 sessionStorage 토큰이 아니라 오너 쿠키로 인증하므로, 쿠키가 생기도록 같은 출처 fetch를 쓴다.
const BOOT_LOGIN = { login_id: "bombadil", password: "bombadil-test-2026", display_name: "Bombadil" };
const bootstrapOwnerRoom = registerCustomAction("bootstrapOwnerRoom", async (document, window) => {
  const me = await window.fetch("/api/me");
  if (me.ok) return;
  // 새 dev D1이면 계정을 만들고, 이미 있으면 같은 자격으로 로그인한다.
  let ok = await window.fetch("/api/setup/owner", {
    method: "POST",
    headers: { authorization: "Bearer " + ADMIN_KEY, "content-type": "application/json" },
    body: JSON.stringify({ ...BOOT_LOGIN, workspace_name: "bombadil 워크스페이스" }),
  });
  if (!ok.ok) {
    ok = await window.fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login_id: BOOT_LOGIN.login_id, password: BOOT_LOGIN.password }),
    });
  }
  if (!ok.ok) return;
  const me2 = await window.fetch("/api/me");
  if (me2.ok) {
    const data = await me2.json();
    const wid = data.workspaces?.[0]?.id;
    if (wid) {
      await window.fetch(`/api/workspaces/${wid}/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "bombadil 탐색 방", description: "UI 속성 탐색용" }),
      });
    }
  }
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
