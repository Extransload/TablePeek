import { SQLite } from "@codemirror/lang-sql";
import { highlightCode, tagHighlighter, tags } from "@lezer/highlight";

// Read-only SQL colouring for the console and history: the editor's grammar,
// with classes styled from the same --syntax-* variables.
const highlighter = tagHighlighter([
  { tag: tags.keyword, class: "sx-keyword" },
  { tag: [tags.string, tags.special(tags.string)], class: "sx-string" },
  { tag: tags.number, class: "sx-number" },
  { tag: tags.comment, class: "sx-comment" },
  { tag: tags.variableName, class: "sx-variable" },
  { tag: tags.typeName, class: "sx-type" },
  { tag: tags.operator, class: "sx-operator" },
  { tag: tags.bool, class: "sx-bool" },
  { tag: tags.null, class: "sx-null" },
  { tag: tags.punctuation, class: "sx-punctuation" },
  { tag: tags.function(tags.variableName), class: "sx-function" },
  { tag: tags.labelName, class: "sx-label" },
]);

const parser = SQLite.language.parser;

export interface SqlToken {
  text: string;
  // Empty for plain text.
  className: string;
}

// Statements seen again (the console re-renders, history reloads) skip the
// parse; bounded by entries and by total text, since statements can be long.
const cache = new Map<string, SqlToken[]>();
const CACHE_ENTRIES = 2000;
const CACHE_CHARS = 2_000_000;
let cachedChars = 0;

export function sqlTokens(text: string): SqlToken[] {
  const cached = cache.get(text);
  if (cached !== undefined) {
    return cached;
  }
  const tokens: SqlToken[] = [];
  highlightCode(
    text,
    parser.parse(text),
    highlighter,
    (piece, className) => tokens.push({ text: piece, className }),
    () => tokens.push({ text: "\n", className: "" }),
  );
  while (cache.size > 0 && (cache.size >= CACHE_ENTRIES || cachedChars + text.length > CACHE_CHARS)) {
    const oldest = cache.keys().next().value as string;
    cache.delete(oldest);
    cachedChars -= oldest.length;
  }
  if (text.length <= CACHE_CHARS) {
    cache.set(text, tokens);
    cachedChars += text.length;
  }
  return tokens;
}
