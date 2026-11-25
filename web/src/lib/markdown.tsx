// 안전한 경량 마크다운. HTML을 만들어 넣지 않고 React 노드로만 돌려준다
// (dangerouslySetInnerHTML 금지). 허용: 펜스 코드블록, 인라인 코드, 굵게, 기울임, 취소선,
// 인용, 링크(http/https만), @멘션 칩. 나머지는 전부 글자 그대로다.
import type { ReactNode } from "react";
import type { Agent } from "./types.js";

interface Part {
  type: "text" | "bold" | "italic" | "strike" | "code" | "link" | "mention";
  text: string;
  href?: string;
  agent?: Agent;
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(_[^_\n]+_)|(https?:\/\/[^\s<>"']+)|(@[\p{L}\p{N}_.-]{1,40})/gu;

function trimUrlTail(url: string): { url: string; tail: string } {
  const m = /[.,!?;:)\]}]+$/.exec(url);
  if (!m) return { url, tail: "" };
  return { url: url.slice(0, -m[0].length), tail: m[0] };
}

function tokenizeLine(line: string, agents: Agent[]): Part[] {
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
    else if (token.startsWith("*")) parts.push({ type: "italic", text: token.slice(1, -1) });
    else if (token.startsWith("_")) parts.push({ type: "italic", text: token.slice(1, -1) });
    else if (/^https?:/i.test(token)) {
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
    const fence = /^\s*```(\S*)\s*$/.exec(lines[i]);
    if (fence) {
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // 닫는 펜스(없으면 끝)
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
