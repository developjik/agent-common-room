// UI/UX 개편 검증: '상태 레일 · 에이전트 카드 · 초대 전달물 · 정지 이유와 복구 · 수신자/인용 · 접근성'
// 브라우저를 띄우지 않고 jsdom에서 실제 페이지 스크립트를 실행하며, fetch는 실제 코어 라우터로 연결한다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { handleFetch } from "../core/http.js";
import { RoomService, type Agent } from "../core/service.js";
import { openSqliteDb } from "../runtime/node-sqlite.js";

const html = readFileSync(new URL("../../public/ui/index.html", import.meta.url), "utf8");
const appJs = readFileSync(new URL("../../public/ui/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../../public/ui/style.css", import.meta.url), "utf8");
const joinJs = readFileSync(new URL("../../public/ui/join.js", import.meta.url), "utf8");

const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 5)); };
const ROOM_NAME = "우리 에이전트 협업방";

async function openApp(opts: { width?: number; name?: string } = {}) {
  const sqlite = openSqliteDb(":memory:");
  await sqlite.ensureSchema();
  const svc = new RoomService(sqlite);
  const room = await svc.createRoom(opts.name ?? ROOM_NAME);
  const session = await svc.login(room.room_id, room.owner_code);
  const invite = await svc.createInvite(room.room_id, { max_uses: 10 });

  const dom = new JSDOM(html, { url: "https://rooms.example.com/", runScripts: "outside-only", pretendToBeVisual: true });
  const win = dom.window as any;
  Object.defineProperty(win, "innerWidth", { value: opts.width ?? 1280, configurable: true, writable: true });
  win.fetch = async (input: string, init: any = {}) => {
    const url = new URL(input, "https://rooms.example.com");
    const req = new Request(url, { method: init.method ?? "GET", headers: init.headers, body: init.body });
    return handleFetch(svc, { ACR_RUNTIME: "test" }, req, { waitUntil() {} });
  };
  const copied: string[] = [];
  win.navigator.clipboard = { writeText: async (t: string) => { copied.push(t); } };
  win.sessionStorage.setItem("acr_session", session.session_token);
  win.eval(appJs);
  await tick(12);

  const doc = win.document;
  async function joinAgent(name: string, product: string) {
    const jr = await svc.requestJoin(invite.invite_token, { display_name: name, product });
    await svc.approveJoin(room.room_id, jr.request_id, { history: "all" });
    const c = (await svc.claim(jr.request_id, jr.claim_secret)) as any;
    const agent: Agent = { id: c.agent_id, room_id: room.room_id, workspace_id: c.workspace_id ?? "", name, product, status: "active", can_read: true, can_write: true, history_floor: 0 };
    return { agent, token: c.agent_token as string };
  }
  /** 화면이 스스로 하는 폴링과 같은 경로(탭이 다시 보일 때)로 새로고침한다. */
  async function refresh() {
    doc.dispatchEvent(new win.Event("visibilitychange"));
    await tick(12);
  }
  return {
    win, doc, svc, room, session, copied, invite, joinAgent, refresh,
    messageEl: (seq: number) => doc.getElementById("msg-" + seq),
    close: async () => { win.close(); await sqlite.close(); },
  };
}

test("참여자 카드: 제품·권한·마지막 확인·상태 점을 보여주고 내부 좌표(fetched/ack/기록 시작)를 숨긴다", async () => {
  const ui = await openApp();
  try {
    const { token: agentToken } = await ui.joinAgent("피클", "Pickle");
    await ui.svc.authAgent(agentToken); // 토큰 인증 = last_seen 갱신
    await ui.refresh();

    const card = ui.doc.querySelector("#agents .agent-item")!;
    assert.ok(card, "참여자 카드가 있다");
    const text = card.textContent as string;
    assert.match(text, /피클/);
    assert.match(text, /Pickle/, "자기 신고 제품 배지");
    assert.match(text, /읽기/, "권한 칩 읽기");
    assert.match(text, /쓰기/, "권한 칩 쓰기");
    assert.match(text, /방금 확인함/, "last_seen 상대시간");
    assert.equal(card.querySelector(".dot")!.getAttribute("data-state"), "ok");
    assert.ok(!/fetched|ack|기록 시작/.test(text), "서버 내부 좌표를 쓰지 않는다");
  } finally { await ui.close(); }
});

test("메시지: 수신자 칩(방 전체/@이름)을 헤더에 두고 인용 답장으로 원문에 점프한다", async () => {
  const ui = await openApp();
  try {
    const { agent } = await ui.joinAgent("피클", "Pickle");
    const broadcast = await ui.svc.postAsAgent(agent, { client_id: "a1", content: "일정 정리부터 볼까요?" });
    const dm = await ui.svc.postAsOwner(ui.room.room_id, { client_id: "o1", content: "오늘 3시 회의록 부탁해", recipient: agent.id });
    const reply = await ui.svc.postAsAgent(agent, { client_id: "a2", content: "네, 정리해 둘게요", reply_to: dm.message.seq });
    await ui.refresh();

    const bEl = ui.messageEl(broadcast.message.seq)!;
    const dEl = ui.messageEl(dm.message.seq)!;
    const rEl = ui.messageEl(reply.message.seq)!;
    assert.equal(bEl.querySelector(".chip.rcpt-all")!.textContent, "방 전체");
    assert.equal(dEl.querySelector(".chip.rcpt")!.textContent, "@피클");
    assert.equal(dEl.querySelector(".body")!.textContent, "오늘 3시 회의록 부탁해", "본문은 그대로");

    const quote = rEl.querySelector(".quote") as HTMLElement;
    assert.ok(quote, "인용 블록");
    assert.match(quote.textContent as string, /회의록 부탁해/);
    quote.click();
    assert.ok(ui.messageEl(dm.message.seq)!.classList.contains("hl"), "원문 하이라이트");
  } finally { await ui.close(); }
});

test("입력창: @지목은 본문을 지우지 않고 받는 사람만 지정하며 키보드로 고를 수 있다", async () => {
  const ui = await openApp();
  try {
    const { agent } = await ui.joinAgent("피클", "Pickle");
    await ui.refresh();
    const ta = ui.doc.getElementById("text") as HTMLTextAreaElement;
    ta.value = "@피";
    ta.selectionStart = ta.selectionEnd = 2;
    ta.dispatchEvent(new ui.win.Event("input"));
    await tick(3);
    assert.equal(ui.doc.getElementById("mentionBox")!.hidden, false, "자동완성 열림");
    ta.dispatchEvent(new ui.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick(3);
    assert.equal(ta.value, "@피", "본문의 @토큰은 남는다");
    assert.equal((ui.doc.getElementById("recipient") as HTMLSelectElement).value, agent.id, "받는 사람 지정");
    assert.equal(ui.doc.getElementById("mentionBox")!.hidden, true, "자동완성 닫힘");
  } finally { await ui.close(); }
});

test("일시정지 배너: 사유·수치·시각과 인라인 재개를 보여주고, 재개로 풀린다", async () => {
  const ui = await openApp();
  try {
    const { agent } = await ui.joinAgent("피클", "Pickle");
    await ui.svc.updateRoom(ui.room.room_id, { rate_limit_count: 1, rate_limit_window_s: 60 });
    await ui.svc.postAsAgent(agent, { client_id: "r1", content: "n1" });
    await assert.rejects(() => ui.svc.postAsAgent(agent, { client_id: "r2", content: "n2" }));
    await ui.refresh();

    const banner = ui.doc.getElementById("banner")!;
    assert.equal(banner.hidden, false);
    const text = banner.textContent as string;
    assert.match(text, /자동 정지/);
    assert.match(text, /상한\(1개\)/);
    assert.match(text, /1\/1/, "현재 사용량/상한 수치");
    assert.equal(ui.doc.getElementById("roomState")!.textContent, "정지");

    (ui.doc.getElementById("bannerResumeBtn") as HTMLButtonElement).click();
    await tick(12);
    assert.equal(banner.hidden, true, "재개하면 배너가 사라진다");
    assert.equal((await ui.svc.getRoomOwner(ui.room.room_id)).paused, false);

    // 오너가 직접 정지한 경우도 '누가·언제'를 말한다.
    await ui.svc.updateRoom(ui.room.room_id, { paused: true });
    await ui.refresh();
    assert.match(ui.doc.getElementById("banner")!.textContent as string, /내가 정지함/);
  } finally { await ui.close(); }
});

test("루프 상한: 체인 미터(N/최대)와 차단 시스템 메시지·'체인 다시 시작'을 보여준다", async () => {
  const ui = await openApp();
  try {
    await ui.svc.updateRoom(ui.room.room_id, { max_chain_depth: 3, rate_limit_count: 1000 });
    const a = await ui.joinAgent("알파", "Instinct");
    const b = await ui.joinAgent("베타", "Pally");
    const root = await ui.svc.postAsAgent(a.agent, { client_id: "c0", content: "시작" });
    let last = root.message.seq;
    for (const [i, who] of [b, a, b].entries()) {
      const p = await ui.svc.postAsAgent(who.agent, { client_id: "c" + (i + 1), content: "답장 " + i, reply_to: last });
      last = p.message.seq;
    }
    await assert.rejects(() => ui.svc.postAsAgent(a.agent, { client_id: "cx", content: "넘침", reply_to: last }), (e: any) => e.code === "loop_cap");
    await ui.refresh();

    assert.equal(ui.doc.getElementById("chainMeter")!.textContent, "답장 체인 3/3");
    assert.equal(ui.doc.getElementById("chainRestartBtn")!.hidden, false);
    const sys = ui.doc.querySelector("#messages .msg.sys")!;
    assert.ok(sys, "차단 사실이 대화 안에 남는다");
    assert.match(sys.textContent as string, /최대 깊이\(3\)/);
    const restart = sys.querySelector("button") as HTMLButtonElement;
    assert.equal(restart.textContent, "체인 다시 시작");
    restart.click();
    assert.match((ui.doc.getElementById("text") as HTMLTextAreaElement).value, /체인을 다시 시작/);
  } finally { await ui.close(); }
});

test("초대: 전달 문장을 원클릭 복사하고, 이력에서 사용량·남은 시간·폐기를 다룬다", async () => {
  const ui = await openApp();
  try {
    await ui.refresh();
    (ui.doc.getElementById("inviteBtn") as HTMLButtonElement).click();
    await tick(14);
    const link = ui.doc.getElementById("inviteOut")!.textContent as string;
    assert.match(link, /^https:\/\/rooms\.example\.com\/join\/acr_inv_/);
    const delivery = ui.doc.getElementById("inviteDelivery")!.textContent as string;
    assert.ok(delivery.includes(link), "전달 문장에 링크가 들어간다");
    assert.ok(delivery.includes(ROOM_NAME), "전달 문장에 방 이름이 들어간다");
    assert.equal(ui.doc.getElementById("invitePreview")!.getAttribute("href"), link);

    (ui.doc.getElementById("copyDeliveryBtn") as HTMLButtonElement).click();
    await tick(3);
    assert.equal(ui.copied.at(-1), delivery, "전달 문장 복사");

    const before = (await ui.svc.listInvites(ui.room.room_id)).filter((i) => i.active).length;
    assert.match(ui.doc.getElementById("invites")!.textContent as string, /사용 0\/10/);
    (ui.doc.querySelector("#invites .invite-item button") as HTMLButtonElement).click();
    await tick(3);
    assert.equal(ui.doc.getElementById("dialog")!.hidden, false, "폐기는 확인을 받는다");
    (ui.doc.getElementById("dlgOk") as HTMLButtonElement).click();
    await tick(14);
    const after = (await ui.svc.listInvites(ui.room.room_id)).filter((i) => i.active).length;
    assert.equal(after, before - 1);
  } finally { await ui.close(); }
});

test("증분 렌더: 새 메시지는 끝에만 붙고 기존 노드는 버리지 않는다(role=log)", async () => {
  const ui = await openApp();
  try {
    await ui.svc.postAsOwner(ui.room.room_id, { client_id: "m1", content: "첫 메시지" });
    await ui.refresh();
    assert.equal(ui.doc.getElementById("messages")!.getAttribute("role"), "log");
    const first = ui.doc.querySelector("#messages .msg");
    assert.ok(first);

    await ui.svc.postAsOwner(ui.room.room_id, { client_id: "m2", content: "두 번째 메시지" });
    await ui.refresh();
    assert.equal(ui.doc.querySelector("#messages .msg"), first, "첫 메시지 노드가 그대로 남는다");
    assert.equal(ui.doc.querySelectorAll("#messages .msg").length, 2);
  } finally { await ui.close(); }
});

test("관리 레일: 데스크톱은 3섹션으로 기본 열림, 모바일은 시트 + Esc + 포커스 복귀", async () => {
  const desk = await openApp({ width: 1280 });
  try {
    const panel = desk.doc.getElementById("panel")!;
    assert.equal(panel.hidden, false, "데스크톱 기본 열림");
    const heads = [...panel.querySelectorAll(".rail-h")].map((h) => h.textContent);
    assert.deepEqual(heads, ["초대", "승인 대기", "참여자"]);
    assert.match(desk.doc.getElementById("panelBtn")!.textContent as string, /관리/);
    (desk.doc.getElementById("panelBtn") as HTMLButtonElement).click();
    assert.equal(panel.hidden, true, "버튼으로 접을 수 있다");
  } finally { await desk.close(); }

  const mob = await openApp({ width: 390 });
  try {
    const panel = mob.doc.getElementById("panel")!;
    assert.equal(panel.hidden, true, "모바일은 시트로 닫힌 채 시작");
    const btn = mob.doc.getElementById("panelBtn") as HTMLButtonElement;
    btn.focus();
    btn.click();
    await tick(3);
    assert.equal(panel.hidden, false);
    assert.equal(panel.getAttribute("aria-modal"), "true");
    assert.equal(panel.getAttribute("role"), "dialog");
    mob.doc.body.dispatchEvent(new mob.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick(3);
    assert.equal(panel.hidden, true, "Esc로 닫힌다");
    assert.equal(mob.doc.activeElement, btn, "호출한 버튼으로 포커스가 돌아온다");
  } finally { await mob.close(); }
});

test("/join/<token>: 브라우저에는 HTML 안내 페이지, 에이전트·CLI에는 기존 마크다운", async () => {
  const sqlite = openSqliteDb(":memory:");
  await sqlite.ensureSchema();
  const svc = new RoomService(sqlite);
  try {
    const room = await svc.createRoom(ROOM_NAME + " <b>\"방\"</b>");
    const invite = await svc.createInvite(room.room_id, { max_uses: 1 });
    const url = `https://rooms.example.com/join/${invite.invite_token}`;
    const env = { ACR_RUNTIME: "test" };

    const browser = await handleFetch(svc, env, new Request(url, { headers: { accept: "text/html,application/xhtml+xml;q=0.9" } }));
    assert.equal(browser.status, 200);
    assert.match(browser.headers.get("content-type") ?? "", /text\/html/);
    assert.match(browser.headers.get("content-security-policy") ?? "", /form-action 'none'/);
    const page = await browser.text();
    assert.match(page, /바로 입장/);
    assert.match(page, /data-copy-target="#joinLink"/, "복사 버튼");
    assert.match(page, /\/ui\/join\.js/);
    // 입장 직후 행동 안내(이 페이지에는 예전에 join 호출 방법만 있었다).
    assert.match(page, /입장만 하고 멈추지 마세요/, "입장만 하고 멈추지 말라는 안내");
    assert.match(page, /2단계 · 입장 직후 바로 시작/, "입장 다음 단계가 같은 화면에 있다");
    assert.match(page, /\/mcp/, "MCP 경로 안내");
    assert.match(page, /list_rooms/);
    assert.match(page, /read_inbox/);
    assert.match(page, /post_message/);
    assert.match(page, /\/api\/inbox\?wait=25/, "REST 폴링 안내");
    assert.match(page, /\/api\/rooms\/&lt;room_id&gt;\/messages/, "답장 경로 안내");
    assert.match(page, /\/api\/rooms\/&lt;room_id&gt;\/ack/, "ack 경로 안내");
    assert.match(page, /reply_to/, "답장은 원문 seq 를 reply_to 로 넘긴다");
    assert.match(page, /메시지에 실린 <code>room_id<\/code>/, "방이 둘 이상이면 메시지의 room_id 로 ack·답장");
    assert.match(page, /omitted_rooms/, "8개를 넘은 방은 방별 inbox 로 읽는다");
    assert.match(page, /room_id/, "응답의 room_id 를 어떻게 읽는지");
    assert.ok(page.includes(invite.invite_token), "초대 링크 자체는 안내에 필요하다");
    assert.ok(!page.includes(room.owner_code), "오너 코드는 새지 않는다");
    assert.ok(!page.includes("<b>"), "방 이름은 이스케이프된다");
    assert.ok(!/<script(?![^>]*src=)/.test(page), "인라인 스크립트 없음");

    const cli = await handleFetch(svc, env, new Request(url, { headers: { accept: "*/*" } }));
    assert.match(cli.headers.get("content-type") ?? "", /text\/plain/);
    const md = await cli.text();
    assert.match(md, /curl -s -X POST/);
    assert.match(md, /한 번만 호출하면 바로 입장/);
    assert.match(md, /입장만 하고 멈추지 마세요/);
    assert.match(md, /## 2\. 입장 직후 바로 시작/);
    assert.match(md, /\/mcp/);
    assert.match(md, /\/api\/inbox\?wait=25/);
    assert.match(md, /reply_to/);
    assert.match(md, /그 메시지의/);
    assert.match(md, /omitted_rooms/);
    assert.match(md, /next_steps/);

    assert.equal((await handleFetch(svc, env, new Request("https://rooms.example.com/join/acr_inv_nope"))).status, 404);
  } finally { await sqlite.close(); }
  // 안내 페이지 스크립트는 외부 CDN 없이 data-copy-target만 쓴다(CSP 'self').
  assert.ok(!/https?:\/\//.test(joinJs.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, "")), "외부 스크립트 참조 없음");
});

test("접근성 기본기: 12px 하한·24px 이상 타깃·--muted WCAG AA 대비", () => {
  assert.ok(!/font-size:\s*1[01](\.\d+)?px/.test(css), "12px 미만 글자 없음");
  assert.match(css, /\.msg-action\s*\{[^}]*min-height:\s*28px/, "메시지 액션 24px 이상");
  assert.match(css, /\.icon-btn\s*\{[^}]*min-width:\s*28px/, "아이콘 버튼 24px 이상");
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/, "hidden 속성이 항상 이긴다");

  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const light = css.slice(0, css.indexOf("@media (prefers-color-scheme: dark)"));
  const dark = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
  const token = (block: string, name: string) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i").exec(block)![1];

  for (const [label, block] of [["light", light], ["dark", dark]] as const) {
    const muted = token(block, "muted"), surface = token(block, "surface"), bg = token(block, "bg");
    assert.ok(ratio(muted, surface) >= 4.5, `${label} --muted on --surface 대비 ${ratio(muted, surface).toFixed(2)}`);
    assert.ok(ratio(muted, bg) >= 4.5, `${label} --muted on --bg 대비 ${ratio(muted, bg).toFixed(2)}`);
  }
});
