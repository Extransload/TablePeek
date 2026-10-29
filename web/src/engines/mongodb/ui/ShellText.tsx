// mongosh text coloured with the app's sx-* classes (the editor palette),
// for read-only text and, through `shellSpans`, the code editors.

import { useMemo } from "react";
import { tokenize } from "../shell/parse";

const CONSTRUCTORS = new Set(["ObjectId", "ISODate", "Date", "NumberDecimal", "Decimal128", "NumberInt", "Int32", "NumberLong", "Long", "Double", "RegExp", "UUID", "Timestamp", "BinData", "Binary", "MinKey", "MaxKey", "Code"]);

export interface ShellSpan {
  from: number;
  to: number;
  cls: string;
}

// The coloured ranges of `src`; text between them stays plain.
export function shellSpans(src: string): ShellSpan[] {
  const toks = tokenize(src, true);
  const out: ShellSpan[] = [];
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    const prev = toks[i - 1];
    const next = toks[i + 1];
    const isKey = next !== undefined && next.type === "punc" && next.text === ":";
    let cls: string;
    switch (tok.type) {
      case "comment":
        cls = "sx-comment";
        break;
      case "str":
        cls = isKey ? (tok.text.startsWith("$") ? "sx-operator" : "sx-variable") : src[tok.from] === '"' ? "sx-double" : "sx-string";
        break;
      case "regex":
        cls = "sx-string";
        break;
      case "num":
        cls = "sx-number";
        break;
      case "punc":
        cls = "sx-punctuation";
        break;
      case "ident":
        if (tok.text === "true" || tok.text === "false") {
          cls = "sx-bool";
        } else if (tok.text === "null" || tok.text === "undefined") {
          cls = "sx-null";
        } else if (tok.text === "db" || tok.text === "new" || tok.text === "show" || tok.text === "use") {
          cls = "sx-keyword";
        } else if (CONSTRUCTORS.has(tok.text) && next?.text === "(") {
          cls = "sx-type";
        } else if (prev?.text === "." && next?.text === "(") {
          cls = "sx-function";
        } else if (isKey || tok.text.startsWith("$")) {
          cls = tok.text.startsWith("$") ? "sx-operator" : "sx-variable";
        } else {
          cls = "sx-text";
        }
        break;
      default:
        cls = "sx-text";
    }
    out.push({ from: tok.from, to: tok.to, cls });
  }
  return out;
}

export function ShellText({ text, className }: { text: string; className?: string }) {
  const parts = useMemo(() => {
    const list: { text: string; cls: string | null }[] = [];
    let at = 0;
    for (const span of shellSpans(text)) {
      if (span.from > at) {
        list.push({ text: text.slice(at, span.from), cls: null });
      }
      list.push({ text: text.slice(span.from, span.to), cls: span.cls });
      at = span.to;
    }
    if (at < text.length) {
      list.push({ text: text.slice(at), cls: null });
    }
    return list;
  }, [text]);
  return (
    <span className={className}>
      {parts.map((part, i) => (part.cls === null ? part.text : <span key={i} className={part.cls}>{part.text}</span>))}
    </span>
  );
}
