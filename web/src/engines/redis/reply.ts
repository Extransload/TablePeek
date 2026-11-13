// A console reply laid out as redis-cli prints it: `(integer) 3`, quoted
// bulk strings, `1) …` for arrays with nested ones indented under their
// number, `1# key => value` for maps. Lines are segments tagged with what
// they show, so the console colours them and copies the plain text.

import { binText, type Bin } from "./bin";

export type Reply =
  | { t: "nil" }
  | { t: "int"; v: number }
  | { t: "bulk"; v: Bin }
  | { t: "status"; v: string }
  | { t: "double"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "verbatim"; v: { format: string; text: string } }
  | { t: "bignum"; v: string }
  | { t: "array"; v: Reply[] }
  | { t: "set"; v: Reply[] }
  | { t: "map"; v: [Reply, Reply][] }
  | { t: "push"; v: { kind: string; data: Reply[] } }
  | { t: "error"; v: string };

export type SegKind = "index" | "nil" | "int" | "string" | "status" | "number" | "bool" | "text" | "error" | "type" | "punct";

export interface Seg {
  text: string;
  kind: SegKind;
}

export type ReplyLine = Seg[];

function single(text: string, kind: SegKind): ReplyLine[] {
  return [[{ text, kind }]];
}

// Items of an array, set or push under their numbers ("1) ", " 2) " … padded
// to the widest), continuation lines indented to line up.
function numbered(items: Reply[], mark: string): ReplyLine[] {
  const width = String(items.length).length;
  return items.flatMap((item, i) => {
    const prefix = `${String(i + 1).padStart(width)}${mark} `;
    return replyLines(item).map((line, j) => [{ text: j === 0 ? prefix : " ".repeat(prefix.length), kind: "index" as const }, ...line]);
  });
}

export function replyLines(reply: Reply): ReplyLine[] {
  switch (reply.t) {
    case "nil":
      return single("(nil)", "nil");
    case "int":
      return [[{ text: "(integer) ", kind: "type" }, { text: String(reply.v), kind: "int" }]];
    case "bulk":
      return single(binText(reply.v, true), "string");
    case "status":
      return single(reply.v, "status");
    case "double":
      return [[{ text: "(double) ", kind: "type" }, { text: reply.v, kind: "number" }]];
    case "bool":
      return single(reply.v ? "(true)" : "(false)", "bool");
    case "bignum":
      return [[{ text: "(big number) ", kind: "type" }, { text: reply.v, kind: "number" }]];
    case "verbatim":
      return reply.v.text.split("\n").map((line) => [{ text: line, kind: "text" as const }]);
    case "error":
      return [[{ text: "(error) ", kind: "error" }, { text: reply.v, kind: "error" }]];
    case "array":
      return reply.v.length === 0 ? single("(empty array)", "nil") : numbered(reply.v, ")");
    case "set":
      return reply.v.length === 0 ? single("(empty set)", "nil") : numbered(reply.v, ")");
    case "push":
      return [[{ text: `(push ${reply.v.kind})`, kind: "type" }], ...numbered(reply.v.data, ")")];
    case "map": {
      if (reply.v.length === 0) {
        return single("(empty hash)", "nil");
      }
      const width = String(reply.v.length).length;
      return reply.v.flatMap(([key, value], i) => {
        const prefix = `${String(i + 1).padStart(width)}# `;
        const keyLines = replyLines(key);
        const keyText = keyLines[0].map((seg) => seg.text).join("");
        const pad = " ".repeat(prefix.length + keyText.length + 4);
        const valueLines = replyLines(value);
        const head: ReplyLine = [{ text: prefix, kind: "index" }, ...keyLines[0], { text: " => ", kind: "punct" }, ...valueLines[0]];
        return [head, ...valueLines.slice(1).map((line) => [{ text: pad, kind: "index" as const }, ...line])];
      });
    }
  }
}

export function replyText(reply: Reply): string {
  return replyLines(reply)
    .map((line) => line.map((seg) => seg.text).join(""))
    .join("\n");
}
