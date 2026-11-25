// 한 줄 안의 인라인 표시자(코드·굵게·기울임·취소선·링크·@멘션)를 토큰으로 나눈다.
// React 노드를 만들지 않는 순수 모듈이라 서버 테스트에서도 그대로 검증할 수 있다.
import type { Agent } from "./types.js";

export interface Part {
  type: "text" | "bold" | "italic" | "strike" | "code" | "link" | "mention";
  text: string;
  href?: string;
  agent?: Agent;
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(_[^_\n]+_)|(https?:\/\/[^\s<>"']+)|(@[\p{L}\p{N}_.-]{1,40})/gu;

/** 끝 문장부호를 떼되, 괄호는 짝이 맞으면 주소의 일부로 남긴다(위키백과 링크 등). */
export function trimUrlTail(url: string): { url: string; tail: string } {
  let kept = url;
  for (;;) {
    const last = kept[kept.length - 1];
    if (!last || !/[.,!?;:)\]}'"]/.test(last)) break;
    if (last === ")" || last === "]") {
      const open = last === ")" ? "(" : "[";
      const opens = kept.split(open).length - 1;
      const closes = kept.split(last).length - 1;
      if (opens >= closes) break;
    }
    kept = kept.slice(0, -1);
  }
  return { url: kept, tail: url.slice(kept.length) };
}

const WORD = /[\p{L}\p{N}_]/u;
// 코드 스팬과 주소는 나중에 그 자체로 해석된다. 그 안의 `_`·`*`는 강조의 짝이 아니다.
const PROTECTED = /`[^`\n]+`|https?:\/\/[^\s<>"']+/g;

/**
 * 코드·주소로 해석될 구간들. 이 안쪽의 기호로는 기울임을 열거나 닫지 않는다.
 * 주소는 링크로 넘어갈 몸통(끝 문장부호 제외)이며, 끝의 `_`·`*`도 주소의 일부다.
 */
function protectedSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  PROTECTED.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PROTECTED.exec(line))) {
    const raw = m[0];
    const length = raw.startsWith("`") ? raw.length : trimUrlTail(raw).url.length;
    spans.push([m.index, m.index + length]);
  }
  return spans;
}

/**
 * 닫는 기호가 코드·주소 안쪽에 있으면 그 글자가 사라져 링크·코드가 깨진다.
 * 다만 여는 기호가 주소 바로 앞에 붙어 주소를 통째로 감싼 경우(`_https://x.y/z_`)에는
 * 주소 끝의 `_`·`*`를 닫는 기호로 본다(링크로 넘기면 엉뚱한 주소가 열린다).
 */
function closesOutsideProtected(spans: Array<[number, number]>, open: number, close: number): boolean {
  return !spans.some(([start, end]) => start < close && close < end && !(open + 1 === start && close === end - 1));
}

/**
 * 강조 표시자(`*`·`_`)가 단어 경계에 있는지 본다.
 * `acr_agt_abcdef`, `room_1a2b3c`, `2*3*4`처럼 식별자·수식 안쪽에 있는 기호는
 * 강조가 아니라 글자 그대로 보여야 한다.
 */
export function emphasisBounded(line: string, index: number, token: string): boolean {
  const before = index > 0 ? line[index - 1] : "";
  const after = index + token.length < line.length ? line[index + token.length] : "";
  return !WORD.test(before) && !WORD.test(after);
}

export function tokenizeLine(line: string, agents: Agent[]): Part[] {
  const parts: Part[] = [];
  const lower = new Map(agents.map((a) => [a.name.toLowerCase(), a]));
  const protected_ = protectedSpans(line);
  let last = 0;
  INLINE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE.exec(line))) {
    if (m.index > last) parts.push({ type: "text", text: line.slice(last, m.index) });
    const token = m[0];
    if (token.startsWith("`")) parts.push({ type: "code", text: token.slice(1, -1) });
    else if (token.startsWith("**")) parts.push({ type: "bold", text: token.slice(2, -2) });
    else if (token.startsWith("~~")) parts.push({ type: "strike", text: token.slice(2, -2) });
    else if (token.startsWith("*") || token.startsWith("_")) {
      const bounded = emphasisBounded(line, m.index, token);
      // 닫는 기호가 코드·주소 안에 있으면 그 글자가 사라져 링크·코드가 깨진다.
      const closesOutside = closesOutsideProtected(protected_, m.index, m.index + token.length - 1);
      if (bounded && closesOutside) {
        parts.push({ type: "italic", text: token.slice(1, -1) });
        last = m.index + token.length;
      } else {
        // 단어 경계가 아니면 여는 기호 하나만 글자로 남기고 한 칸 뒤부터 다시 찾는다.
        // 후보를 통째로 글자로 삼키면, 식별자에 붙은 `_`가 문장 뒤쪽의 여는 `_`와 짝지어져
        // `room_1a2b3c … agent_common_room, 강조는 _기울임_`의 기울임이 풀린다.
        parts.push({ type: "text", text: token.slice(0, 1) });
        last = m.index + 1;
      }
      INLINE.lastIndex = last;
      continue;
    } else if (/^https?:/i.test(token)) {
      const { url, tail } = trimUrlTail(token);
      parts.push({ type: "link", text: url, href: url });
      if (tail) parts.push({ type: "text", text: tail });
    } else if (token.startsWith("@")) {
      const agent = lower.get(token.slice(1).toLowerCase());
      if (agent) parts.push({ type: "mention", text: token, agent });
      else parts.push({ type: "text", text: token });
    } else parts.push({ type: "text", text: token });
    last = m.index + token.length;
  }
  if (last < line.length) parts.push({ type: "text", text: line.slice(last) });
  return parts;
}
