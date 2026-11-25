// 안전한 경량 마크다운. HTML을 만들어 넣지 않고 React 노드로만 돌려준다
// (dangerouslySetInnerHTML 금지). 허용: 펜스 코드블록, 인라인 코드, 굵게, 기울임, 취소선,
// 인용, 링크(http/https만), @멘션 칩. 나머지는 전부 글자 그대로다.
import type { ReactNode } from "react";
import { tokenizeLine } from "./inline.js";
import type { Agent } from "./types.js";

function inlineNodes(line: string, agents: Agent[], keyBase: string): ReactNode[] {
  return tokenizeLine(line, agents).map((p, i) => {
    const key = `${keyBase}-${i}`;
    switch (p.type) {
      case "code":
        return (
          <code key={key} className="msg-code">
            {p.text}
          </code>
        );
      case "bold":
        return (
          <strong key={key} className="font-semibold">
            {p.text}
          </strong>
        );
      case "italic":
        return (
          <em key={key} className="italic">
            {p.text}
          </em>
        );
      case "strike":
        return (
          <span key={key} className="line-through opacity-70">
            {p.text}
          </span>
        );
      case "link":
        return (
          <a key={key} className="msg-link" href={p.href} target="_blank" rel="noopener noreferrer nofollow">
            {p.text}
          </a>
        );
      case "mention":
        return (
          <span key={key} className="mention-chip" data-agent={p.agent?.id}>
            {p.text}
          </span>
        );
      default:
        return <span key={key}>{p.text}</span>;
    }
  });
}

type Block =
  | { kind: "code"; lang: string; text: string }
  | { kind: "quote"; lines: string[] }
  | { kind: "text"; lines: string[] };

function parseBlocks(content: string): Block[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    // 언어 뒤에 파일명 등 부가 정보가 붙은 펜스도 받는다: "```ts src/app.ts"
    const fence = /^\s*```(.*)$/.exec(lines[i]);
    if (fence) {
      const lang = fence[1].trim().split(/\s+/)[0] ?? "";
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // 닫는 펜스(없으면 끝)
      blocks.push({ kind: "code", lang, text: body.join("\n") });
      continue;
    }
    if (/^\s*>\s?/.test(lines[i])) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push({ kind: "quote", lines: body });
      continue;
    }
    const body: string[] = [];
    while (i < lines.length && !/^\s*```/.test(lines[i]) && !/^\s*>\s?/.test(lines[i])) {
      body.push(lines[i]);
      i += 1;
    }
    // 어떤 경우에도 줄을 하나는 소비해 무한 루프를 막는다.
    if (body.length === 0) {
      body.push(lines[i]);
      i += 1;
    }
    blocks.push({ kind: "text", lines: body });
  }
  return blocks;
}

export function RichText({ content, agents }: { content: string; agents: Agent[] }) {
  const blocks = parseBlocks(content);
  return (
    <div className="msg-rich">
      {blocks.map((b, bi) => {
        if (b.kind === "code") {
          return (
            <div key={bi} className="msg-pre-wrap">
              {b.lang ? <span className="msg-pre-lang">{b.lang}</span> : null}
              <pre className="msg-pre">
                <code>{b.text}</code>
              </pre>
            </div>
          );
        }
        if (b.kind === "quote") {
          return (
            <blockquote key={bi} className="msg-quote">
              {b.lines.map((line, li) => (
                <span key={li} className="block">
                  {inlineNodes(line, agents, `${bi}-q${li}`)}
                </span>
              ))}
            </blockquote>
          );
        }
        return (
          <span key={bi} className="block">
            {b.lines.map((line, li) => (
              <span key={li} className={line === "" ? "block h-2" : "block"}>
                {line === "" ? null : inlineNodes(line, agents, `${bi}-${li}`)}
              </span>
            ))}
          </span>
        );
      })}
    </div>
  );
}
