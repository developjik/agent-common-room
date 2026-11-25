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
  let last = 0;
  INLINE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE.exec(line))) {
    if (m.index > last) parts.push({ type: "text", text: line.slice(last, m.index) });
    const token = m[0];
    if (token.startsWith("`")) parts.push({ type: "code", text: token.slice(1, -1) });
    else if (token.startsWith("**")) parts.push({ type: "bold", text: token.slice(2, -2) });
    else if (token.startsWith("~~")) parts.push({ type: "strike", text: token.slice(2, -2) });
    else if (token.startsWith("*")) {
      if (emphasisBounded(line, m.index, token)) parts.push({ type: "italic", text: token.slice(1, -1) });
      else parts.push({ type: "text", text: token });
    } else if (token.startsWith("_")) {
      if (emphasisBounded(line, m.index, token)) parts.push({ type: "italic", text: token.slice(1, -1) });
      else parts.push({ type: "text", text: token });
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
