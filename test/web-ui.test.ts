// 웹 UI 수정 검증: 컴포넌트가 쓰는 순수 로직(그룹핑·표시 문구·인라인 토큰·@자동완성)을
// jsdom 없이 그대로 검사한다. React 컴포넌트는 이 함수들의 결과만 그리므로, 여기서 규칙이
// 맞으면 화면도 같은 규칙을 따른다.
import test from "node:test";
import assert from "node:assert/strict";
import { activeAgent, groupedWith, historyFloorLabel, plainPreview, recipientReset } from "../web/src/lib/format.js";
import { tokenizeLine } from "../web/src/lib/inline.js";
import { completeMention, mentionTokenAt } from "../web/src/lib/mention.js";
import type { Agent } from "../web/src/lib/types.js";

const agent = (id: string, name: string, status: string): Agent => ({ id, name, status }) as Agent;

function message(over: Record<string, unknown> = {}): any {
  return {
    seq: 1,
    id: "msg_1",
    client_id: null,
    kind: "message",
    sender: { type: "agent", id: "agt_1", name: "alpha" },
    recipient: null,
    reply_to: null,
    content: "본문",
    deleted: false,
    depth: 0,
    context_category: "general",
    created_at: "2026-11-26T01:00:00.000Z",
    delivery: null,
    ...over,
  };
}

test("삭제된 메시지(tombstone)는 다음 메시지와 묶이지 않는다", () => {
  const before = message({ seq: 1, created_at: "2026-11-26T01:00:00.000Z" });
  const after = message({ seq: 2, created_at: "2026-11-26T01:00:01.000Z" });
  assert.equal(groupedWith(before, after), true, "같은 발신자·같은 수신자·5분 이내면 묶인다");

  const tombstone = message({ seq: 1, deleted: true, content: null, created_at: "2026-11-26T01:00:00.000Z" });
  assert.equal(groupedWith(tombstone, after), false, "tombstone 아래 메시지는 발신자·시각을 다시 보여야 한다");
  assert.equal(groupedWith(before, message({ ...after, deleted: true, content: null })), false, "삭제된 메시지도 헤더를 가진다");
});

test("수신자·종류가 다르면 묶지 않는다(기존 규칙 유지)", () => {
  const a = message({ seq: 1 });
  assert.equal(groupedWith(a, message({ seq: 2, recipient: { id: "agt_2", name: "beta" } })), false);
  assert.equal(groupedWith(a, message({ seq: 2, kind: "question" })), false);
  assert.equal(groupedWith(undefined, a), false);
});

test("지목 대상은 활성(active) 참여자뿐이다", () => {
  const agents = [agent("agt_1", "Instinct", "active"), agent("agt_2", "피클", "revoked"), agent("agt_3", "Poke", "unclaimed")];
  assert.equal(activeAgent(agents, "agt_1")?.name, "Instinct");
  assert.equal(activeAgent(agents, "agt_2"), undefined, "폐기된 참여자는 지목 대상이 아니다");
  assert.equal(activeAgent(agents, "agt_3"), undefined, "미승인 참여자는 지목 대상이 아니다");
  assert.equal(activeAgent(agents, "agt_x"), undefined);
});

test("'기록 #N부터'는 서버 가시성(seq > floor)과 같은 번호를 가리킨다", () => {
  assert.equal(historyFloorLabel(0), "기록 #1부터", "floor 0이면 첫 메시지(#1)부터 보인다");
  assert.equal(historyFloorLabel(10), "기록 #11부터", "floor 10이면 #10은 보이지 않고 #11부터다");
});

test("언더스코어/별표 강조는 단어 경계에서만 적용된다", () => {
  const tokens = tokenizeLine("토큰 acr_agt_abcdefghijklmnop 과 room_50795a119a4a4b48, inv_6e5a6940e3d3451e", []);
  const italics = tokens.filter((t) => t.type === "italic");
  assert.deepEqual(italics, [], "식별자 안쪽의 _는 이탤릭이 아니다");
  assert.match(tokens.map((t) => t.text).join(""), /acr_agt_abcdefghijklmnop/, "식별자가 글자 그대로 남는다");

  const emphasized = tokenizeLine("이건 _기울임_ 이고 __굵게__ 는 아니다", []);
  assert.deepEqual(
    emphasized.filter((t) => t.type === "italic").map((t) => t.text),
    ["기울임"],
  );

  const math = tokenizeLine("2*3*4 는 곱셈", []);
  assert.deepEqual(math.filter((t) => t.type === "italic"), [], "수식의 *는 강조가 아니다");
});

/** 기울임 토큰만 <em>으로 감싸 화면이 그릴 글자를 그대로 만든다. */
function renderInline(line: string): string {
  return tokenizeLine(line, [])
    .map((t) => (t.type === "italic" ? `<em>${t.text}</em>` : t.text))
    .join("");
}

test("식별자 바로 뒤의 밑줄 기울임은 식별자를 훼손하지 않고 적용된다", () => {
  const line = "room_50795a119a4a4b48 와 agent_common_room, 강조는 _기울임_ 과 acr_agt_abcdef";
  assert.equal(
    renderInline(line),
    "room_50795a119a4a4b48 와 agent_common_room, 강조는 <em>기울임</em> 과 acr_agt_abcdef",
    "앞 식별자의 _가 뒤 문장의 여는 _를 삼키지 않는다",
  );

  // 여러 식별자가 앞에 있어도, 주소가 섞여 있어도 같다.
  assert.equal(
    renderInline("acr_agt_1 과 room_1a2b3c, inv_6e5a6940 그리고 _기울임_ 끝"),
    "acr_agt_1 과 room_1a2b3c, inv_6e5a6940 그리고 <em>기울임</em> 끝",
  );
  const mixed = tokenizeLine("room_1a2b3c 보다 https://example.com/a_b_c 의 _draft_ 문서", []);
  assert.equal(mixed.find((t) => t.type === "link")?.href, "https://example.com/a_b_c", "URL의 _는 주소의 일부");
  assert.deepEqual(mixed.filter((t) => t.type === "italic").map((t) => t.text), ["draft"]);

  // 강조로 보이지 않는 기호는 하나도 잃지 않는다.
  assert.equal(renderInline("2*3*4 와 a_b_c_d, foo_bar and baz_qux"), "2*3*4 와 a_b_c_d, foo_bar and baz_qux");
  assert.equal(renderInline("__굵게__ 와 _하나_"), "__굵게__ 와 <em>하나</em>");
});

test("기울임 후보가 주소·인라인 코드의 밑줄을 닫는 기호로 가져가지 않는다", () => {
  const render = (line: string) =>
    tokenizeLine(line, [])
      .map((t) => (t.type === "italic" ? `<em>${t.text}</em>` : t.type === "link" ? `[${t.text}](${t.href})` : t.type === "code" ? `\`${t.text}\`` : t.text))
      .join("");

  // 식별자 뒤의 기울임처럼 보이는 후보가 주소 안의 `_`에서 끝나면 주소가 링크로 남아야 한다.
  assert.equal(
    render("room_1의 _private 설정은 https://hub.docker.com/_/node 참고"),
    "room_1의 _private 설정은 [https://hub.docker.com/_/node](https://hub.docker.com/_/node) 참고",
  );
  assert.equal(
    render("room_1에서 _private 값은 `config_.json`에 있습니다."),
    "room_1에서 _private 값은 `config_.json`에 있습니다.",
    "코드 값의 밑줄이 빠지면 값 자체가 달라진다",
  );
  assert.equal(render("_private https://x/_/y 더"), "_private [https://x/_/y](https://x/_/y) 더");

  // 주소를 통째로 감싼 기울임은 닫는 기호를 주소로 넘기지 않고 그대로 기울임으로 그린다.
  assert.equal(render("문서는 _https://example.com/download_ 참고"), "문서는 <em>https://example.com/download</em> 참고");
  assert.equal(render("문서는 *https://example.com/download* 참고"), "문서는 <em>https://example.com/download</em> 참고");
  assert.equal(
    render("https://hub.docker.com/_/node"),
    "[https://hub.docker.com/_/node](https://hub.docker.com/_/node)",
    "주소 경로 안의 _는 링크 대상에서 빠지지 않는다",
  );

  // 주소를 품은 진짜 기울임은 닫는 기호가 주소 밖이므로 그대로 적용된다.
  assert.equal(render("_자세한 건 https://x.y/a 참고_ 끝"), "<em>자세한 건 https://x.y/a 참고</em> 끝");
});

test("폐기된 수신자는 조용히 지우지 않고 방 전체로 되돌리며 안내한다", () => {
  assert.deepEqual(recipientReset([agent("agt_1", "피클", "active")], "agt_1"), { reset: false, notice: null }, "활성 수신자는 그대로 둔다");
  assert.deepEqual(recipientReset([agent("agt_1", "피클", "active")], ""), { reset: false, notice: null }, "초기 마운트·전송 뒤 초기화는 조용하다");

  const revoked = recipientReset([agent("agt_1", "피클", "revoked")], "agt_1");
  assert.equal(revoked.reset, true, "폐기되면 방 전체로 되돌린다");
  assert.match(revoked.notice ?? "", /피클/, "누가 사라졌는지 이름으로 알린다");
  assert.match(revoked.notice ?? "", /폐기/);
  assert.match(revoked.notice ?? "", /방 전체로 바뀌었습니다/);

  const unclaimed = recipientReset([agent("agt_1", "피클", "unclaimed")], "agt_1");
  assert.equal(unclaimed.reset, true);
  assert.match(unclaimed.notice ?? "", /승인 전/);

  assert.deepEqual(recipientReset([], "agt_1"), { reset: true, notice: null }, "목록을 받기 전에는 조용히 되돌린다");
});

test("코드·굵게·링크·멘션 토큰은 그대로 유지된다", () => {
  const agents = [agent("agt_1", "Instinct", "active")];
  const tokens = tokenizeLine("**굵게** `code` @Instinct @없는이름 https://example.com/a_b_c.", agents);
  assert.equal(tokens.find((t) => t.type === "bold")?.text, "굵게");
  assert.equal(tokens.find((t) => t.type === "code")?.text, "code");
  assert.equal(tokens.find((t) => t.type === "mention")?.agent?.id, "agt_1", "등록된 참여자는 멘션 칩");
  assert.ok(tokens.some((t) => t.type === "text" && t.text === "@없는이름"), "모르는 이름은 글자 그대로");
  const link = tokens.find((t) => t.type === "link");
  assert.equal(link?.href, "https://example.com/a_b_c", "URL 안의 _ 는 자르지 않고 끝 문장부호만 뗀다");
});

test("인용 미리보기에서도 식별자의 _ 를 건드리지 않는다", () => {
  assert.equal(plainPreview("토큰 acr_agt_abcdefghijklmnop 그대로"), "토큰 acr_agt_abcdefghijklmnop 그대로");
  assert.equal(plainPreview("_진짜_ 기울임"), "진짜 기울임");
  assert.equal(plainPreview("2*3*4 는 곱셉, *강조* 는 아님"), "2*3*4 는 곱셉, 강조 는 아님");
  assert.equal(
    plainPreview("주소 https://example.com/_draft_/notes 확인"),
    "주소 https://example.com/_draft_/notes 확인",
    "주소 안의 _ 는 주소의 일부다",
  );
});

test("@ 자동완성은 본문의 검색어를 고른 이름으로 바꾼다", () => {
  const done = completeMention("@Ins", 4, "Instinct");
  assert.deepEqual(done, { text: "@Instinct ", caret: 10, replaced: true });

  const mid = completeMention("안녕 @Ins 그리고", 7, "Instinct");
  assert.equal(mid.text, "안녕 @Instinct  그리고", "커서 뒤의 글자는 그대로 남는다");
  assert.equal(mid.caret, 13);

  const spaced = completeMention("@Ins", 0, "Instinct");
  assert.deepEqual(spaced, { text: "@Ins", caret: 0, replaced: false }, "커서 앞에 지목 구간이 없으면 건드리지 않는다");

  // 커서가 검색어 중간에 있어도(@Ins|t) 이름 뒤쪽 글자가 본문에 남지 않아야 한다.
  const middle = completeMention("@Inst", 4, "Instinct");
  assert.deepEqual(middle, { text: "@Instinct ", caret: 10, replaced: true });
});

test("mentionTokenAt은 커서 바로 앞의 지목 구간만 찾는다", () => {
  assert.deepEqual(mentionTokenAt("가 @Pi", 5), { start: 2, end: 5, query: "Pi" });
  assert.equal(mentionTokenAt("가 @Pi 나", 6), null, "커서 뒤에 글자가 이어지면 자동완성 대상이 아니다");
  assert.equal(mentionTokenAt("@", 1)?.query, "", "이름 없이 @만 쳐도 후보를 보여 줄 수 있다");
  assert.equal(mentionTokenAt("메일 a@b", 7), null, "주소 일부의 @는 지목이 아니다");
});
