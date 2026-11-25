// 이전 오너 콘솔(public/ui/, /ui/ 로 서빙)의 온보딩 버튼을 실제 DOM에서 눌러 본다.
// 기본 화면(/)은 web/ React UI이고, 이 콘솔은 정책·웹훅 설정 등 그대로 남겨 둔 경로다.
// 페이지 스크립트는 브라우저와 같은 방식으로 실행되고, fetch는 실제 코어 라우터로 연결해
// "버튼 → API → 화면"까지 한 번에 검증한다(브라우저를 띄우지 않는 통합 테스트).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { handleFetch } from "../core/http.js";
import { RoomService } from "../core/service.js";
import { openSqliteDb } from "../runtime/node-sqlite.js";

const html = readFileSync(new URL("../../public/ui/index.html", import.meta.url), "utf8");
const appJs = readFileSync(new URL("../../public/ui/app.js", import.meta.url), "utf8");

const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 5)); };

async function openUi(shared?: { sqlite: any; svc: RoomService }) {
  const sqlite = shared?.sqlite ?? openSqliteDb(":memory:");
  if (!shared) await sqlite.ensureSchema();
  const svc = shared?.svc ?? new RoomService(sqlite);
  const env = { ACR_RUNTIME: "test" };
  const dom = new JSDOM(html, { url: "https://rooms.example.com/", runScripts: "outside-only", pretendToBeVisual: true });
  const win = dom.window as any;
  // 페이지의 fetch를 실제 라우터로 연결한다(네트워크 없이 브라우저와 같은 경로).
  win.fetch = async (input: string, init: any = {}) => {
    const url = new URL(input, "https://rooms.example.com");
    const req = new Request(url, { method: init.method ?? "GET", headers: init.headers, body: init.body });
    return handleFetch(svc, env, req, { waitUntil() {} });
  };
  win.navigator.clipboard = { writeText: async () => {} };
  win.eval(appJs);
  await tick();
  return {
    win, doc: win.document, sqlite, svc,
    close: async () => { dom.window.close(); if (!shared) await sqlite.close(); },
  };
}

const isShown = (el: any) => !el.hidden;

test("UI 온보딩: 버튼만으로 관리자 키 발급 → 방 생성 → 자격 증명·초대 링크 표시", async () => {
  const ui = await openUi();
  try {
    const { doc } = ui;
    assert.ok(isShown(doc.getElementById("loginPane")), "처음에는 로그인 화면");
    assert.ok(doc.getElementById("onboardPane").hidden, "온보딩은 접혀 있다");
    assert.ok(isShown(doc.getElementById("bootstrapWrap")), "키가 없으면 최초 발급 버튼이 보인다");

    doc.getElementById("goOnboard").click();
    await tick();
    assert.ok(!doc.getElementById("onboardPane").hidden, "온보딩 열림");

    // 1) 최초 관리자 키 발급
    doc.getElementById("bootstrapBtn").click();
    await tick(12);
    const key = doc.getElementById("bootstrapOut").textContent as string;
    assert.match(key, /^acr_adm_/, "발급된 키가 화면에 보인다");
    assert.equal(doc.getElementById("adminKey").value, key, "방 만들기 입력칸에 채워진다");
    assert.equal(doc.getElementById("bootstrapOutWrap").hidden, false);
    assert.ok(!doc.getElementById("onboardErr").textContent, "오류 없음");

    // 2) 방 만들기 + 초대 링크
    doc.getElementById("newRoomName").value = "UI 방";
    doc.getElementById("newRoomDesc").value = "버튼으로 만든 방";
    doc.getElementById("createRoomBtn").click();
    await tick(20);
    assert.ok(!doc.getElementById("createdPane").hidden, "결과 화면으로 넘어간다");
    const roomId = doc.getElementById("cRoomId").textContent as string;
    const ownerCode = doc.getElementById("cOwnerCode").textContent as string;
    const invite = doc.getElementById("cInvite").textContent as string;
    assert.match(roomId, /^room_/);
    assert.match(ownerCode, /^acr_own_/);
    assert.equal(invite, `https://rooms.example.com/join/${invite.split("/join/")[1]}`, "초대 링크는 현재 주소 기준");
    assert.ok(doc.getElementById("adminKey").value === "", "관리자 키는 화면에 남기지 않는다");

    // 3) 방으로 들어가기 → 오너 앱 화면
    doc.getElementById("enterRoomBtn").click();
    await tick(20);
    assert.ok(!doc.getElementById("app").hidden, "방 화면이 열린다");
    assert.equal(doc.getElementById("login").hidden, true, "로그인 화면은 가려진다");
    assert.equal(doc.getElementById("roomName").textContent, "UI 방");
    assert.match(ui.win.sessionStorage.getItem("acr_session") ?? "", /^acr_ses_/);
  } finally { await ui.close(); }
});

test("UI 온보딩: 틀린 관리자 키는 화면에 오류를 보여 주고 방을 만들지 않는다", async () => {
  const ui = await openUi();
  try {
    const { doc } = ui;
    doc.getElementById("createRoomBtn").click();
    await tick();
    assert.match(doc.getElementById("onboardErr").textContent as string, /관리자 키를 입력/);

    doc.getElementById("goOnboard").click();
    doc.getElementById("adminKey").value = "acr_adm_" + "x".repeat(43);
    doc.getElementById("newRoomName").value = "실패 방";
    doc.getElementById("createRoomBtn").click();
    await tick(15);
    assert.match(doc.getElementById("onboardErr").textContent as string, /관리자 키|관리자/);
    assert.ok(doc.getElementById("createdPane").hidden, "결과 화면은 열리지 않는다");
  } finally { await ui.close(); }
});

test("UI 온보딩: 이미 키가 있으면 다음 접속부터 최초 발급 버튼이 숨는다", async () => {
  const first = await openUi();
  try {
    first.doc.getElementById("goOnboard").click();
    first.doc.getElementById("bootstrapBtn").click();
    await tick(12);
    assert.match(first.doc.getElementById("bootstrapOut").textContent as string, /^acr_adm_/);

    // 같은 서버 상태로 새로 연 화면(= 다른 사람이 나중에 접속한 경우)
    const second = await openUi({ sqlite: first.sqlite, svc: first.svc });
    try {
      const d2 = second.doc;
      await tick(6);
      assert.equal(d2.getElementById("bootstrapWrap").hidden, true, "키가 있으면 발급 버튼을 숨긴다");
      assert.ok(isShown(d2.getElementById("onboardPane")) === false);
      d2.getElementById("goOnboard").click();
      await tick();
      assert.ok(!d2.getElementById("onboardPane").hidden, "관리자 키를 입력해 기존 서버에 방을 만들 수는 있다");
    } finally { await second.close(); }
  } finally { await first.close(); }
});
