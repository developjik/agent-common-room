// 컴포저의 `@` 자동완성: 커서 앞의 `@검색어` 구간을 찾고, 고른 이름으로 본문을 완성한다.
// 수신자 칩만 바꾸고 본문을 `@Ins`로 두면 상대가 자기 이름으로 인식하지 못한다.
export interface MentionToken {
  start: number;
  end: number;
  query: string;
}

const OPEN = /(?:^|\s)@([\p{L}\p{N}_.-]{0,30})$/u;

/** 커서(caret) 바로 앞에 있는 `@검색어`의 위치와 검색어. 없으면 null. */
export function mentionTokenAt(text: string, caret: number): MentionToken | null {
  const upto = text.slice(0, caret);
  const m = OPEN.exec(upto);
  if (!m) return null;
  // `(?:^|\s)`가 삼킨 앞 공백은 자리 계산에서 뺀다.
  const lead = m[0].length - m[0].trimStart().length;
  return { start: m.index + lead, end: caret, query: m[1] };
}

/**
 * `@검색어`를 `@이름 `로 바꾸고 커서를 이름 뒤로 옮긴다(뒤에 공백을 두어 자동완성을 닫는다).
 * 해당 구간이 없으면 본문을 그대로 돌려준다.
 * 커서가 검색어 중간에 있어도(`@Ins|t`) 이름 뒤쪽 글자까지 함께 가져가 `@Instinct t`가 되지 않게 한다.
 */
export function completeMention(text: string, caret: number, name: string): { text: string; caret: number; replaced: boolean } {
  const token = mentionTokenAt(text, caret);
  if (!token) return { text, caret, replaced: false };
  let end = token.end;
  while (end < text.length && /[\p{L}\p{N}_.-]/u.test(text[end])) end += 1;
  const inserted = `@${name} `;
  return {
    text: text.slice(0, token.start) + inserted + text.slice(end),
    caret: token.start + inserted.length,
    replaced: true,
  };
}
