// 모던 컴포저 회귀: 받는 사람 네이티브 select와 메시지 종류 `＋` UI를 없애고,
// 보내는 종류는 항상 message, 입력창은 1줄에서 160px까지만 자라는 규칙을 소스 수준에서 고정한다.
// (React 컴포넌트는 루트 빌드에서 JSX로 컴파일하지 않으므로, 공개 UI 규칙을 파일 내용으로 검사한다.)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const composer = readFileSync(new URL("../../web/src/components/Composer.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../../web/src/index.css", import.meta.url), "utf8");

test("컴포저에는 받는 사람 select와 메시지 종류(＋) UI가 없다", () => {
  assert.equal(/<select/.test(composer), false, "받는 사람은 @ 버튼·칩으로만 고른다");
  assert.equal(/<option/.test(composer), false, "네이티브 옵션 목록을 쓰지 않는다");
  assert.equal(/KIND_CHOICES|kindOpen|composer-extras|composer-opt/.test(composer), false, "메시지 종류 선택 UI는 없다");
});

test("컴포저는 언제나 kind=message로 보낸다", () => {
  assert.match(composer, /const SEND_KIND = "message"/);
  assert.match(composer, /kind: SEND_KIND/);
  assert.equal(/kind, recipient/.test(composer), false, "상태로 고른 종류를 싣지 않는다");
});

test("입력창은 1줄에서 160px까지만 자라고 제자리에서 스크롤한다", () => {
  assert.match(composer, /MAX_TEXTAREA_HEIGHT = 160/);
  assert.match(composer, /Math\.min\(full, MAX_TEXTAREA_HEIGHT\)/);
  assert.match(composer, /overflowY = full > MAX_TEXTAREA_HEIGHT \? "auto" : "hidden"/);
  assert.match(composer, /setText\(""\)/, "전송하면 초안을 비워 1줄로 돌아온다");
  assert.match(css, /\.composer textarea \{[\s\S]*?max-height: 160px/);
  assert.match(css, /\.composer-compact textarea/, "스레드(compact) 입력창도 같은 규칙을 쓴다");
  assert.equal(/field-sizing/.test(css), false, "높이는 스크립트가 재므로 CSS 자동 높이와 겹치지 않는다");
});

test("멘션 후보는 click으로도 고를 수 있고 전송 버튼은 이름을 가진다", () => {
  // 후보 버튼 블록만 잘라서 본다(툴바 `@` 버튼의 같은 코드에 걸려 통과하지 않게).
  const item = composer.slice(composer.indexOf('className="mention-item"'), composer.indexOf("</button>", composer.indexOf('className="mention-item"')));
  assert.match(item, /onMouseDown=\{\(e\) => e\.preventDefault\(\)\}/, "mousedown은 포커스 이동만 막는다");
  assert.match(item, /onClick=\{\(\) => choose\(a\)\}/, "보조 기술의 click도 같은 선택으로 들어온다");
  assert.match(composer, /aria-label=\{sending \? "보내는 중" : "전송"\}/, "모바일에서 문구를 숨겨도 이름이 남는다");
});

test("다른 곳에서 지목해 포커스를 받으면 열린 자동완성을 닫는다", () => {
  assert.match(composer, /if \(focusNonce\) \{[\s\S]{0,200}?setMention\(null\)/, "낡은 후보가 새 수신자를 덮어쓰지 않는다");
  assert.match(composer, /rightBoundary: caret/, "@ 버튼이 넣은 멘션은 커서 뒤 본문을 삼키지 않는다");
});

test("플레이스홀더와 @ 호출·수신자 칩이 있다", () => {
  assert.match(composer, /"메시지 입력 \(@로 비서 호출\)"/);
  assert.match(composer, /`@\$\{recipientAgent\.name\}에게만 보내기`/);
  assert.match(composer, /"답글 입력"/);
  assert.match(composer, /"메시지 입력"/);
  assert.match(composer, /composer-at/);
  assert.match(composer, /composer-recipient/);
});
