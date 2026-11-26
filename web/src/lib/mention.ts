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
 *
 * 커서 뒤쪽 처리: 이어지는 같은 단어 전체가 고른 이름의 앞부분일 때만 그 단어를 이름으로
 * 흡수한다(`@Ins|t` → `@Instinct `, `@피|클` → `@피클 `). 그 밖에는 커서 앞 `@검색어`만
 * 바꾸므로, 이미 쓰던 본문(`@피클을 냉장고에…`, `@인금요일입니다`)은 지워지지 않는다.
 * 버튼이든 키보드든 같은 규칙이라, 본문이 이름과 겹치는지로만 판단한다.
 */
export function completeMention(text: string, caret: number, name: string): { text: string; caret: number; replaced: boolean } {
  const token = mentionTokenAt(text, caret);
  if (!token) return { text, caret, replaced: false };
  const word = /[\p{L}\p{N}_.-]/u;
  let end = token.end;
  let wordEnd = end;
  while (wordEnd < text.length && word.test(text[wordEnd])) wordEnd += 1;
  const typed = text.slice(token.start + 1, wordEnd).toLowerCase();
  if (typed.length > 0 && name.toLowerCase().startsWith(typed)) end = wordEnd;
  const inserted = `@${name} `;
  return {
    text: text.slice(0, token.start) + inserted + text.slice(end),
    caret: token.start + inserted.length,
    replaced: true,
  };
}
