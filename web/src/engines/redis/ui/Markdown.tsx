// Markdown drawn as React elements, so nothing in the value can run: raw
// HTML stays text, links open only http(s) and mailto addresses, and
// images are shown as links (nothing is fetched). Headings, paragraphs,
// lists, quotes, fenced code, rules, tables and the usual inline marks.

import type { ReactNode } from "react";

function safeUrl(url: string): string | null {
  const trimmed = url.trim();
  return /^(https?:|mailto:)/i.test(trimmed) ? trimmed : null;
}

// `code`, **bold**, *em* / _em_, ~~strike~~, [link](url), ![image](url).
const INLINE = /(`+)([\s\S]*?)\1|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const found of text.matchAll(INLINE)) {
    if (found.index > at) {
      out.push(text.slice(at, found.index));
    }
    const id = `${key}:${found.index}`;
    const [whole, , code, bold, bold2, strike, em, em2, label, url] = found;
    if (code !== undefined) {
      out.push(<code key={id}>{code}</code>);
    } else if (bold !== undefined || bold2 !== undefined) {
      out.push(<strong key={id}>{inline(bold ?? bold2 ?? "", key + 1)}</strong>);
    } else if (strike !== undefined) {
      out.push(<del key={id}>{inline(strike, key + 1)}</del>);
    } else if (em !== undefined || em2 !== undefined) {
      out.push(<em key={id}>{inline(em ?? em2 ?? "", key + 1)}</em>);
    } else if (url !== undefined) {
      const href = safeUrl(url);
      const image = whole.startsWith("!");
      const content = image ? `🖼 ${label || url}` : inline(label ?? "", key + 1);
      out.push(
        href === null ? (
          <span key={id} className="kv-md-link" title={url}>
            {content}
          </span>
        ) : (
          <a key={id} href={href} target="_blank" rel="noreferrer noopener" className="kv-md-link">
            {content}
          </a>
        ),
      );
    }
    at = found.index + whole.length;
  }
  if (at < text.length) {
    out.push(text.slice(at));
  }
  return out;
}

const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = blocks.length;
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const fence = /^\s*(```|~~~)(.*)$/.exec(line);
    if (fence !== null) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push(
        <pre key={key} className="kv-md-code mono">
          {body.join("\n")}
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      const Tag = `h${heading[1].length}` as "h1";
      blocks.push(<Tag key={key}>{inline(heading[2])}</Tag>);
      i += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={key} />);
      i += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push(
        <blockquote key={key}>
          <Markdown text={body.join("\n")} />
        </blockquote>,
      );
      continue;
    }
    const item = /^\s*([-*+]|\d+[.)])\s+/;
    if (item.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && (item.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length > 0))) {
        if (item.test(lines[i])) {
          items.push(lines[i].replace(item, ""));
        } else {
          items[items.length - 1] += ` ${lines[i].trim()}`;
        }
        i += 1;
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={key}>
          {items.map((entry, n) => {
            const task = /^\[([ xX])\]\s+/.exec(entry);
            return (
              <li key={n}>
                {task !== null ? <input type="checkbox" checked={task[1] !== " "} readOnly disabled /> : null}
                {inline(task !== null ? entry.slice(task[0].length) : entry)}
              </li>
            );
          })}
        </List>,
      );
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(cells(lines[i]));
        i += 1;
      }
      blocks.push(
        <table key={key} className="kv-md-table">
          <thead>
            <tr>
              {head.map((cell, n) => (
                <th key={n}>{inline(cell)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {head.map((_, n) => (
                  <td key={n}>{inline(row[n] ?? "")}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^\s*(#{1,6}\s|```|~~~|>|([-*+]|\d+[.)])\s)/.test(lines[i])) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    if (paragraph.length === 0) {
      paragraph.push(line.trim());
      i += 1;
    }
    blocks.push(<p key={key}>{inline(paragraph.join(" "))}</p>);
  }
  return <div className="kv-md">{blocks}</div>;
}
