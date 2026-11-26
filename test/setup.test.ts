// 웹 온보딩(첫 방 만들기) 계약: 관리자 키 최초 발급 → 방 생성 → 오너 로그인 → 초대 링크까지
// CLI 없이 브라우저(HTTP)만으로 끝나야 하고, 키는 해시로만 저장돼야 한다.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createNodeRuntime } from "../runtime/node.js";
import { openSqliteDb } from "../runtime/node-sqlite.js";
import type { Env } from "../core/http.js";

const servers: Array<() => Promise<void>> = [];

/** 부트스트랩 상태가 다른 서버를 띄운다(각 테스트가 자기 DB를 가진다). */
async function boot(env: Env = {}) {
  const sqlite = openSqliteDb(":memory:");
  const runtime = await createNodeRuntime({ db: sqlite, env, lazyPurgeMs: 0, purgeIntervalMs: 0 });
  const server = createServer(runtime.handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = async () => {
    await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
    await runtime.close();
  };
  servers.push(close);
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { base, call, sqlite, runtime, close };
}

after(async () => { for (const c of servers) await c(); });

test("최초 접속: 키가 없으면 웹에서 한 번만 발급할 수 있고, 두 번째부터는 409", async () => {
  const s = await boot();
  const state0 = await s.call("GET", "/api/setup");
  assert.equal(state0.status, 200);
  assert.equal(state0.json.admin_key_configured, false);
  assert.equal(state0.json.bootstrap_allowed, true);

  const first = await s.call("POST", "/api/setup/bootstrap", undefined, {});
  assert.equal(first.status, 201);
  assert.match(first.json.admin_key, /^acr_adm_[A-Za-z0-9_-]{40,}$/);

  const state1 = await s.call("GET", "/api/setup");
  assert.equal(state1.json.admin_key_configured, true);
  assert.equal(state1.json.bootstrap_allowed, false, "이미 키가 있으면 웹 발급을 닫는다");

  const second = await s.call("POST", "/api/setup/bootstrap", undefined, {});
  assert.equal(second.status, 409);

  // 평문 키는 어디에도 저장되지 않는다(해시만). meta 에는 schema_version 같은 다른 표식도 있다.
  const meta = s.sqlite.raw.prepare("SELECT key, value FROM meta").all() as any[];
  const keyRows = meta.filter((r) => r.key === "admin_key_hash");
  assert.equal(keyRows.length, 1);
  assert.match(String(keyRows[0].value), /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(meta).includes(first.json.admin_key));
});

test("웹 온보딩 한 번에: 관리자 키로 방 생성 → 오너 세션 → 초대 링크 → 초대 페이지", async () => {
  const s = await boot();
  const booted = await s.call("POST", "/api/setup/bootstrap", undefined, {});
  const adminKey = booted.json.admin_key as string;

  const noKey = await s.call("POST", "/api/admin/rooms", undefined, { name: "권한 없음" });
  assert.equal(noKey.status, 401);
  const wrongKey = await s.call("POST", "/api/admin/rooms", "acr_adm_" + "x".repeat(43), { name: "권한 없음" });
  assert.equal(wrongKey.status, 401);

  const created = await s.call("POST", "/api/admin/rooms", adminKey, { name: "온보딩 방", description: "웹에서 만든 방" });
  assert.equal(created.status, 201);
  assert.match(created.json.room_id, /^room_/);
  assert.match(created.json.owner_code, /^acr_own_/);

  // UI가 하는 그대로: 만든 코드로 로그인 → 첫 초대(3일·10회) → 링크 조립
  const login = await s.call("POST", "/api/owner/login", undefined, { room_id: created.json.room_id, owner_code: created.json.owner_code });
  assert.equal(login.status, 200);
  const invite = await s.call("POST", "/api/owner/invites", login.json.session_token, { ttl_hours: 72, max_uses: 10 });
  assert.equal(invite.status, 201);
  const link = `${s.base}/join/${invite.json.invite_token}`;
  const page = await fetch(link);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /한 번만 호출하면 바로 입장/);

  // 방 목록·정책도 관리자 키로 확인된다.
  const rooms = await s.call("GET", "/api/admin/rooms", adminKey);
  assert.equal(rooms.status, 200);
  assert.equal(rooms.json.rooms.length, 1);
  assert.equal(rooms.json.rooms[0].name, "온보딩 방");
});

test("관리자 키가 환경변수로 있으면 웹 발급은 닫히고, 그 키로 관리자 API를 쓴다", async () => {
  const envKey = "env-admin-key-0123456789abcdef";
  const s = await boot({ ACR_ADMIN_KEY: envKey });
  const state = await s.call("GET", "/api/setup");
  assert.equal(state.json.admin_key_configured, true);
  assert.equal(state.json.bootstrap_allowed, false);
  assert.equal((await s.call("POST", "/api/setup/bootstrap", undefined, {})).status, 409);
  assert.equal((await s.call("POST", "/api/admin/rooms", envKey, { name: "env 방" })).status, 201);
  // 짧은 키는 관리자 키로 인정하지 않는다(최소 24자).
  const short = await boot({ ACR_ADMIN_KEY: "short" });
  assert.equal((await short.call("POST", "/api/setup/bootstrap", undefined, {})).status, 201, "짧은 값은 설정으로 보지 않는다");
});

test("ACR_BOOTSTRAP=off: 웹 발급이 꺼지고 반복 호출은 429로 제한된다", async () => {
  const s = await boot({ ACR_BOOTSTRAP: "off" });
  const state = await s.call("GET", "/api/setup");
  assert.equal(state.json.bootstrap_allowed, false);
  assert.equal((await s.call("POST", "/api/setup/bootstrap", undefined, {})).status, 403);
  for (let i = 0; i < 4; i++) await s.call("POST", "/api/setup/bootstrap", undefined, {});
  assert.equal((await s.call("POST", "/api/setup/bootstrap", undefined, {})).status, 429, "5회 뒤 제한");
});

test("관리자 키 무차별 대입: 자격 증명을 계속 틀리면 429", async () => {
  const s = await boot();
  const adminKey = (await s.call("POST", "/api/setup/bootstrap", undefined, {})).json.admin_key as string;
  let last = 0;
  for (let i = 0; i < 31; i++) last = (await s.call("POST", "/api/admin/rooms", "acr_adm_" + String(i).padStart(43, "0"), { name: "x" })).status;
  assert.equal(last, 429, "30회 넘는 오답은 429");
  // 올바른 키는 제한에 걸리지 않는다(남의 무차별 대입으로 오너가 잠기지 않게).
  assert.equal((await s.call("POST", "/api/admin/rooms", adminKey, { name: "정상 키" })).status, 201);
});

test("기본 화면(/)은 새 React UI 셸을, /ui/는 이전 콘솔을 CSP와 함께 서빙한다", async () => {
  const s = await boot();
  const res = await fetch(s.base + "/");
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  assert.match(res.headers.get("content-security-policy") ?? "", /form-action 'none'/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.ok(html.includes('id="root"'), "React 마운트 지점");
  const asset = /<script[^>]+src="(\/app\/assets\/[^"]+\.js)"/.exec(html);
  assert.ok(asset, "web 빌드 번들이 /app/assets 아래에서 참조된다");
  assert.ok(!/<script(?![^>]*src=)/.test(html), "인라인 스크립트 없음");
  assert.ok(!/onclick=/i.test(html), "인라인 이벤트 핸들러 없음");

  const js = await fetch(s.base + asset[1]);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /text\/javascript/);
  assert.match(js.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.ok(!/(?:src|href)=["']https?:\/\//.test(await js.text()), "번들이 외부 스크립트를 부르지 않는다");

  // 해시된 CSS도 같은 규칙으로 서빙되고, 경로 탈출은 막힌다.
  const cssPath = /<link[^>]+href="(\/app\/assets\/[^"]+\.css)"/.exec(html)?.[1];
  assert.ok(cssPath, "번들 CSS 참조");
  assert.equal((await fetch(s.base + cssPath)).status, 200);
  assert.equal((await fetch(s.base + "/app/../package.json")).status, 404);
  assert.equal((await fetch(s.base + "/app/%2e%2e/package.json")).status, 404, "인코딩된 경로 탈출도 막힌다");

  // 이전 콘솔은 /ui/에서 그대로: 온보딩 화면과 스크립트가 남아 있고 키를 저장소에 남기지 않는다.
  const legacy = await fetch(s.base + "/ui/");
  const legacyHtml = await legacy.text();
  assert.equal(legacy.status, 200);
  for (const id of ["onboardPane", "createRoomBtn", "adminKey", "bootstrapBtn", "createdPane", "copyInviteOnlyBtn"]) {
    assert.ok(legacyHtml.includes(`id="${id}"`), `${id} 누락`);
  }
  const legacyJs = await (await fetch(s.base + "/ui/app.js")).text();
  assert.ok(!/localStorage\.(setItem|getItem)/.test(legacyJs), "관리자 키를 localStorage에 남기지 않는다");
  assert.ok(/sessionStorage\.setItem\("acr_session"/.test(legacyJs));
});
