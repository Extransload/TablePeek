import { escapeString, lexingFor, splitSqlRanges } from "./sqlSplit";

// What the SQL editor offers at the cursor, as in TablePlus, and a little
// more. After "alias." or "table." that table's columns alone; right after
// FROM, INTO, UPDATE or TABLE the tables; right after JOIN the tables a
// foreign key ties to the statement's first, each with its ON condition;
// right after ON those conditions; anywhere else the columns of the tables
// the statement names first, then tables, functions and keywords, and at the
// start of a statement whole statements to fill in.
// Names match from their start, from the start of one of their words
// ("id" → user_id), anywhere, or by their letters in order ("usid" →
// user_id), in that order; keywords only from their start: "na" offers a
// name column and NATURAL, never BINARY or RENAME. Among equals, what was
// picked more often comes first.

// A keyword, type or function of the dialect, as lang-sql lists them.
export interface SqlWord {
  label: string;
  type: string;
}

// A column as completion knows it: its type and whether it is (part of) the key.
export interface CompletionColumn {
  name: string;
  type: string | null;
  notNull: boolean;
  pk: boolean;
}

// A foreign key: `table`(`columns`) refers to `refTable`(`refColumns`).
export interface CompletionRelation {
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
}

export type SqlOptionKind =
  | "column"
  | "table"
  | "alias"
  | "join"
  | "condition"
  | "function"
  | "keyword"
  | "type"
  | "snippet";

export interface SqlCompletionOption {
  label: string;
  kind: SqlOptionKind;
  // Inserted instead of the label.
  apply?: string;
  // Inserted instead of the label, with ${fields} to Tab through.
  snippet?: string;
  detail?: string;
  // A column's table, or the table itself (a join's: the one it adds).
  table?: string;
  column?: CompletionColumn;
  // What a join or condition rests on; `guessed` when no foreign key says
  // so and the names do (orders.user_id and users.id).
  relation?: CompletionRelation;
  guessed?: boolean;
  // A function's arguments and what it does.
  signature?: string;
  about?: string;
  // The label's matched characters, as from/to pairs.
  matched: number[];
  // Counted when picked; more picks rank it higher among equals.
  usageKey: string;
}

export interface SqlCompletions {
  from: number;
  to: number;
  // The name typed so far (without its opening quote), which options matched.
  typed: string;
  // A plain word, where a saved query's keyword fits too: not "x.", not quoted.
  bare: boolean;
  // In the order to show them.
  options: SqlCompletionOption[];
}

export interface SqlCompletionConfig {
  // Table (named as the sidebar names it: "x", or "schema.x" outside the
  // default schema) to its columns.
  schema: Record<string, CompletionColumn[]>;
  // The connection's foreign keys, tables named as in `schema`.
  relations?: readonly CompletionRelation[];
  words: readonly SqlWord[];
  // How often an option (by its usageKey) was picked before.
  usage?: (key: string) => number;
  // The engine kind (sqlite, postgres, mysql, …): how the SQL is read.
  dialect?: string;
  // The characters that quote names; the first quotes an inserted name that needs it.
  identifierQuotes: string;
  caseInsensitiveIdentifiers?: boolean;
  // Asked for (Ctrl-Space) rather than typed: offers something with nothing typed.
  explicit?: boolean;
}

// Inside a string compared with a column (status = '…', status IN ('…', '…')):
// the column, for its values, the string's text so far, its quote, and
// whether it already has its closing quote.
export interface SqlValueSlot {
  from: number;
  to: number;
  typed: string;
  table: string;
  column: string;
  quote: string;
  closed: boolean;
}

type TokenKind = "name" | "quoted" | "string" | "comment" | "punct" | "other";

interface Token {
  kind: TokenKind;
  from: number;
  to: number;
  // A name, a quoted name without its quotes, or the punctuation mark.
  text: string;
  // Whether a quoted name, string or block comment has its closing mark.
  closed: boolean;
}

interface TableRef {
  // The schema's key for it; null for a table the schema doesn't know.
  key: string | null;
  alias: string | null;
}

// The words a table is introduced by.
const TABLE_WORDS = new Set(["FROM", "JOIN", "INTO", "UPDATE", "TABLE"]);
// Between such a word and the table: FROM ONLY t, CREATE TABLE IF NOT EXISTS t.
const TABLE_MODIFIERS = new Set(["ONLY", "LATERAL", "IF", "NOT", "EXISTS", "LOW_PRIORITY", "IGNORE"]);
// Words that follow a table without being its alias (or its name).
const NOT_NAMES = new Set(
  (
    "AS ON USING WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL STRAIGHT_JOIN APPLY GROUP ORDER " +
    "HAVING LIMIT OFFSET FETCH FOR UNION INTERSECT EXCEPT MINUS WINDOW SET VALUES VALUE SELECT " +
    "RETURNING DEFAULT WITH TABLESAMPLE FORCE IGNORE USE PARTITION INDEXED NOT AND OR OUTPUT " +
    "OVERRIDING DO WHEN THEN ELSE END INTO LOCK QUALIFY PIVOT UNPIVOT CONNECT START ONLY LATERAL " +
    "FROM IF EXISTS INSERT UPDATE DELETE REPLACE MERGE CREATE DROP ALTER TRUNCATE BEGIN COMMIT " +
    "ROLLBACK EXPLAIN SHOW PRAGMA DECLARE EXEC EXECUTE CALL GRANT REVOKE"
  ).split(" "),
);

const NAME_START = /[\p{L}_]/u;
const NAME_PART = /[\p{L}\p{N}_$]/u;
const DOLLAR_TAG = /\$[A-Za-z0-9_]*\$/y;

function dollarTagAt(input: string, at: number): string | null {
  DOLLAR_TAG.lastIndex = at;
  return DOLLAR_TAG.exec(input)?.[0] ?? null;
}

function upper(token: Token | undefined): string {
  return token?.kind === "name" ? token.text.toUpperCase() : "";
}

function isPunct(token: Token | undefined, mark: string): boolean {
  return token?.kind === "punct" && token.text === mark;
}

// A table's or alias's name: quoted, or a word that isn't a clause's.
function isName(token: Token | undefined): token is Token {
  return token?.kind === "quoted" || (token?.kind === "name" && !NOT_NAMES.has(upper(token)));
}

// The statement the cursor is in: from just past the ";" before it to the
// end of the one it is in. Text after the cursor counts (SELECT na| FROM t).
function statementBounds(input: string, pos: number, dialect?: string): [number, number] {
  let start = 0;
  for (const range of splitSqlRanges(input, dialect)) {
    if (range.to <= pos && input[range.to - 1] === ";") {
      start = range.to;
    } else if (range.to > pos) {
      return [start, range.to];
    }
  }
  return [start, input.length];
}

// A quoted name still being typed, its closing quote not there yet, ends at
// the cursor (`pos`) rather than taking the rest of the statement with it.
function tokenize(input: string, from: number, to: number, pos: number, dialect: string | undefined, quotes: string): Token[] {
  const lex = lexingFor(dialect);
  const nameQuote = (ch: string): boolean => quotes.includes(ch) || (ch === "[" && lex.bracketNames);
  const tokens: Token[] = [];
  let at = from;
  while (at < to) {
    const ch = input[at];
    const next = input[at + 1] ?? "";
    const tag = ch === "$" && lex.dollarQuotes ? dollarTagAt(input, at) : null;
    if (/\s/.test(ch)) {
      at += 1;
    } else if ((ch === "-" && next === "-") || (ch === "#" && lex.hashComments)) {
      const end = input.indexOf("\n", at);
      const stop = end < 0 || end > to ? to : end;
      tokens.push({ kind: "comment", from: at, to: stop, text: "", closed: false });
      at = stop;
    } else if (ch === "/" && next === "*") {
      const end = input.indexOf("*/", at + 2);
      const closed = end >= 0 && end + 2 <= to;
      const stop = closed ? end + 2 : to;
      tokens.push({ kind: "comment", from: at, to: stop, text: "", closed });
      at = stop;
    } else if (ch === "'" || ch === '"' || ch === "`" || (ch === "[" && nameQuote(ch))) {
      const name = nameQuote(ch);
      const close = ch === "[" ? "]" : ch;
      const escapes = !name && ((lex.backslashEscapes && ch !== "`") || (lex.escapeStrings && escapeString(input, at)));
      let cursor = at + 1;
      let text = "";
      let closed = false;
      while (cursor < to) {
        const inner = input[cursor];
        if (inner === "\\" && escapes && cursor + 1 < to) {
          text += input[cursor + 1];
          cursor += 2;
        } else if (inner === close && input[cursor + 1] === close && cursor + 1 < to) {
          text += close;
          cursor += 2;
        } else if (inner === close) {
          cursor += 1;
          closed = true;
          break;
        } else {
          text += inner;
          cursor += 1;
        }
      }
      if (name && !closed && at < pos && pos < cursor) {
        text = input.slice(at + 1, pos);
        cursor = pos;
      }
      tokens.push({ kind: name ? "quoted" : "string", from: at, to: cursor, text, closed });
      at = cursor;
    } else if (tag !== null) {
      const end = input.indexOf(tag, at + tag.length);
      const closed = end >= 0 && end + tag.length <= to;
      const stop = closed ? end + tag.length : to;
      tokens.push({ kind: "string", from: at, to: stop, text: "", closed });
      at = stop;
    } else if (NAME_START.test(ch)) {
      let end = at + 1;
      while (end < to && NAME_PART.test(input[end])) {
        end += 1;
      }
      tokens.push({ kind: "name", from: at, to: end, text: input.slice(at, end), closed: true });
      at = end;
    } else if (/[\d@]/.test(ch) || (ch === ":" && next !== ":" && input[at - 1] !== ":" && NAME_START.test(next))) {
      // A number, @variable or :param: nothing to complete in it.
      let end = at + 1;
      while (end < to && /[\p{L}\p{N}_$.@]/u.test(input[end])) {
        end += 1;
      }
      tokens.push({ kind: "other", from: at, to: end, text: input.slice(at, end), closed: true });
      at = end;
    } else {
      tokens.push({ kind: /[.,();]/.test(ch) ? "punct" : "other", from: at, to: at + 1, text: ch, closed: true });
      at += 1;
    }
  }
  return tokens;
}

// The schema key a written table name means: as written, else without its
// schema or database (PostgreSQL's public and SQL Server's dbo tables are
// listed bare; MySQL's db.table names the table in that database).
function tableKey(parts: string[], keys: string[]): string | null {
  const find = (name: string): string | null => {
    const folded = name.toLowerCase();
    return keys.find((key) => key === name) ?? keys.find((key) => key.toLowerCase() === folded) ?? null;
  };
  if (parts.length === 1) {
    return find(parts[0]);
  }
  return find(parts.join(".")) ?? find(parts.slice(-2).join(".")) ?? find(parts[parts.length - 1]);
}

// The tables a statement names (FROM a, b; JOIN; UPDATE; INSERT INTO; TABLE)
// with their aliases (FROM a x, FROM a AS x). Subqueries are read where they
// are, so their tables count too.
function tableRefs(tokens: Token[], keys: string[]): TableRef[] {
  const refs: TableRef[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const intro = upper(tokens[index]);
    if (!TABLE_WORDS.has(intro)) {
      continue;
    }
    let at = index + 1;
    for (;;) {
      while (TABLE_MODIFIERS.has(upper(tokens[at]))) {
        at += 1;
      }
      if (!isName(tokens[at])) {
        break;
      }
      const parts = [tokens[at].text];
      at += 1;
      while (isPunct(tokens[at], ".") && isName(tokens[at + 1])) {
        parts.push(tokens[at + 1].text);
        at += 2;
      }
      // FROM fn(…) is a function, not a table; INSERT INTO t (…) lists its columns.
      if (isPunct(tokens[at], "(")) {
        if (intro === "INTO" || intro === "TABLE") {
          refs.push({ key: tableKey(parts, keys), alias: null });
        }
        break;
      }
      let alias: string | null = null;
      if (intro !== "TABLE") {
        if (upper(tokens[at]) === "AS" && isName(tokens[at + 1])) {
          alias = tokens[at + 1].text;
          at += 2;
        } else if (intro !== "INTO" && isName(tokens[at])) {
          alias = tokens[at].text;
          at += 1;
        }
      }
      refs.push({ key: tableKey(parts, keys), alias });
      if (!((intro === "FROM" || intro === "UPDATE") && isPunct(tokens[at], ","))) {
        break;
      }
      at += 1;
    }
    index = at - 1;
  }
  return refs;
}

// Whether a table goes where the cursor is: right after FROM, JOIN, INTO,
// UPDATE or TABLE, or after a comma in FROM's (or UPDATE's) list of tables.
function wantsTable(before: Token[]): boolean {
  const last = before[before.length - 1];
  if (TABLE_WORDS.has(upper(last))) {
    return true;
  }
  if (!isPunct(last, ",")) {
    return false;
  }
  let depth = 0;
  for (let index = before.length - 2; index >= 0; index -= 1) {
    const token = before[index];
    if (token.kind === "punct") {
      if (token.text === ")") {
        depth += 1;
      } else if (token.text === "(") {
        if (depth === 0) {
          return false;
        }
        depth -= 1;
      }
    } else if (depth > 0) {
      continue;
    } else if (upper(token) === "FROM" || upper(token) === "UPDATE") {
      return true;
    } else if (!isName(token) && upper(token) !== "AS") {
      return false;
    }
  }
  return false;
}

function defaultSchemaOf(dialect: string | undefined): string | null {
  return dialect === "postgres" || dialect === "cockroach" ? "public" : dialect === "mssql" ? "dbo" : null;
}

// The engine family a dialect's functions come from.
function familyOf(dialect: string | undefined): "postgres" | "mysql" | "mssql" | "sqlite" {
  if (dialect === "postgres" || dialect === "cockroach") {
    return "postgres";
  }
  if (dialect === "mysql" || dialect === "mariadb") {
    return "mysql";
  }
  return dialect === "mssql" ? "mssql" : "sqlite";
}

// Functions people reach for, with their arguments and what they do; `only`
// the engines that have them (all when absent).
interface SqlFunction {
  name: string;
  args: string;
  about: string;
  only?: ("postgres" | "mysql" | "mssql" | "sqlite")[];
  // Called with OVER (…): a window function.
  window?: boolean;
}

const FUNCTIONS: SqlFunction[] = [
  { name: "COUNT", args: "expr | *", about: "행 수 (NULL이 아닌 값의 수)" },
  { name: "SUM", args: "expr", about: "합계" },
  { name: "AVG", args: "expr", about: "평균" },
  { name: "MIN", args: "expr", about: "최솟값" },
  { name: "MAX", args: "expr", about: "최댓값" },
  { name: "COALESCE", args: "value, fallback, …", about: "NULL이 아닌 첫 값" },
  { name: "NULLIF", args: "a, b", about: "a와 b가 같으면 NULL, 아니면 a" },
  { name: "CAST", args: "expr AS type", about: "다른 타입으로 변환" },
  { name: "LOWER", args: "text", about: "소문자로" },
  { name: "UPPER", args: "text", about: "대문자로" },
  { name: "LENGTH", args: "text", about: "문자열 길이", only: ["postgres", "mysql", "sqlite"] },
  { name: "LEN", args: "text", about: "문자열 길이 (끝 공백 제외)", only: ["mssql"] },
  { name: "SUBSTRING", args: "text, start, length", about: "부분 문자열", only: ["postgres", "mysql", "mssql", "sqlite"] },
  { name: "SUBSTR", args: "text, start, length", about: "부분 문자열", only: ["sqlite", "mysql", "postgres"] },
  { name: "TRIM", args: "text", about: "앞뒤 공백 제거" },
  { name: "REPLACE", args: "text, from, to", about: "문자열 바꾸기" },
  { name: "CONCAT", args: "a, b, …", about: "문자열 잇기" },
  { name: "ROUND", args: "number, digits", about: "반올림" },
  { name: "ABS", args: "number", about: "절댓값" },
  { name: "NOW", args: "", about: "현재 시각", only: ["postgres", "mysql"] },
  { name: "DATE_TRUNC", args: "'day', timestamp", about: "단위로 자른 시각", only: ["postgres"] },
  { name: "EXTRACT", args: "field FROM timestamp", about: "시각에서 연·월·일 등을 꺼냄", only: ["postgres", "mysql"] },
  { name: "TO_CHAR", args: "value, format", about: "서식에 맞춘 문자열", only: ["postgres"] },
  { name: "DATE_FORMAT", args: "date, format", about: "서식에 맞춘 문자열", only: ["mysql"] },
  { name: "STRFTIME", args: "format, time", about: "서식에 맞춘 시각 문자열", only: ["sqlite"] },
  { name: "DATE", args: "time", about: "날짜 부분", only: ["sqlite", "mysql"] },
  { name: "DATEDIFF", args: "a, b", about: "두 날짜의 차이", only: ["mysql", "mssql"] },
  { name: "DATEADD", args: "part, amount, date", about: "날짜에 더하기", only: ["mssql"] },
  { name: "GETDATE", args: "", about: "현재 시각", only: ["mssql"] },
  { name: "IFNULL", args: "value, fallback", about: "NULL이면 fallback", only: ["mysql", "sqlite"] },
  { name: "ISNULL", args: "value, fallback", about: "NULL이면 fallback", only: ["mssql"] },
  { name: "STRING_AGG", args: "expr, separator", about: "값을 구분자로 이어 붙임", only: ["postgres", "mssql"] },
  { name: "GROUP_CONCAT", args: "expr", about: "값을 쉼표로 이어 붙임", only: ["mysql", "sqlite"] },
  { name: "ARRAY_AGG", args: "expr", about: "값을 배열로 모음", only: ["postgres"] },
  { name: "JSON_EXTRACT", args: "json, path", about: "JSON에서 값 꺼내기", only: ["mysql", "sqlite"] },
  { name: "JSONB_EXTRACT_PATH", args: "jsonb, key, …", about: "JSONB에서 값 꺼내기", only: ["postgres"] },
  { name: "ROW_NUMBER", args: "", about: "창 안에서의 행 번호", window: true },
  { name: "RANK", args: "", about: "창 안에서의 순위 (같으면 건너뜀)", window: true },
  { name: "DENSE_RANK", args: "", about: "창 안에서의 순위 (건너뛰지 않음)", window: true },
  { name: "LAG", args: "expr, offset", about: "앞 행의 값", window: true },
  { name: "LEAD", args: "expr, offset", about: "뒤 행의 값", window: true },
];

// Whole statements offered at the start of one; ${…} are fields Tab moves through.
const STATEMENTS: { label: string; template: string }[] = [
  { label: "SELECT * FROM …", template: "SELECT * FROM ${table}" },
  { label: "SELECT … FROM … WHERE …", template: "SELECT ${columns} FROM ${table} WHERE ${condition}" },
  { label: "INSERT INTO … VALUES …", template: "INSERT INTO ${table} (${columns}) VALUES (${values})" },
  { label: "UPDATE … SET … WHERE …", template: "UPDATE ${table} SET ${column} = ${value} WHERE ${condition}" },
  { label: "DELETE FROM … WHERE …", template: "DELETE FROM ${table} WHERE ${condition}" },
];

// Keywords take the case of what was typed: "sel" → select, "Sel" → SELECT.
function caseLike(word: string, typed: string): string {
  return typed !== "" && typed === typed.toLowerCase() ? word.toLowerCase() : word.toUpperCase();
}

// Where a new word starts in a name: after _ - . or a space, or at a capital after a small letter.
function wordStartAt(name: string, at: number): boolean {
  if (at === 0) {
    return true;
  }
  const prev = name[at - 1];
  return /[_\-.\s$]/.test(prev) || (/[a-z0-9]/.test(prev) && /[A-Z]/.test(name[at]));
}

// How `typed` matches `name`: 0 from its start, 1 from the start of one of its
// words, 2 anywhere, 3 by its letters in order starting at a word (usid →
// user_id); null when not at all. `prefixOnly` allows only the first.
function matchName(name: string, typed: string, prefixOnly: boolean): { rank: number; spans: number[] } | null {
  if (typed === "") {
    return { rank: 0, spans: [] };
  }
  const lower = name.toLowerCase();
  const want = typed.toLowerCase();
  if (lower.startsWith(want)) {
    return { rank: 0, spans: [0, want.length] };
  }
  if (prefixOnly) {
    return null;
  }
  for (let at = 1; at < name.length; at += 1) {
    if (wordStartAt(name, at) && lower.startsWith(want, at)) {
      return { rank: 1, spans: [at, at + want.length] };
    }
  }
  const inside = lower.indexOf(want);
  if (inside >= 0) {
    return { rank: 2, spans: [inside, inside + want.length] };
  }
  if (want.length < 2) {
    return null;
  }
  let first = -1;
  for (let at = 0; at < lower.length; at += 1) {
    if (lower[at] === want[0] && wordStartAt(name, at)) {
      first = at;
      break;
    }
  }
  if (first < 0) {
    return null;
  }
  const spans = [first, first + 1];
  let next = first + 1;
  for (const char of want.slice(1)) {
    const found = lower.indexOf(char, next);
    if (found < 0) {
      return null;
    }
    if (spans[spans.length - 1] === found) {
      spans[spans.length - 1] = found + 1;
    } else {
      spans.push(found, found + 1);
    }
    next = found + 1;
  }
  return { rank: 3, spans };
}

function lastPart(key: string): string {
  return key.slice(key.lastIndexOf(".") + 1);
}

function singular(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith("ies")) {
    return lower.slice(0, -3) + "y";
  }
  if (lower.endsWith("ses") || lower.endsWith("xes")) {
    return lower.slice(0, -2);
  }
  return lower.endsWith("s") && !lower.endsWith("ss") ? lower.slice(0, -1) : lower;
}

// Two letters an alias mustn't be, being keywords.
const RESERVED_ALIASES = new Set(
  "as at by do go if in is no of on or to all and any asc end for key not set top use".split(" "),
);

// A short alias for a table: the first letters of its words (order_items → oi),
// numbered on when taken.
function aliasFor(key: string, taken: Set<string>): string {
  const words = lastPart(key)
    .split(/[_\-\s]+|(?<=[a-z0-9])(?=[A-Z])/)
    .filter((word) => word !== "");
  const base = words.map((word) => word[0].toLowerCase()).join("").replace(/[^a-z]/g, "") || "t";
  let alias = base;
  for (let n = 2; taken.has(alias) || RESERVED_ALIASES.has(alias); n += 1) {
    alias = `${base}${n}`;
  }
  return alias;
}

// What joins tables a and b: their foreign keys either way; failing those,
// what the names suggest (a column orders.user_id or orders.users_id against
// the single-column key users.id).
function linksBetween(
  a: string,
  b: string,
  config: SqlCompletionConfig,
): { relation: CompletionRelation; guessed: boolean }[] {
  const declared = (config.relations ?? []).filter(
    (relation) => (relation.table === a && relation.refTable === b) || (relation.table === b && relation.refTable === a),
  );
  if (declared.length > 0) {
    return declared.map((relation) => ({ relation, guessed: false }));
  }
  const guessed: { relation: CompletionRelation; guessed: boolean }[] = [];
  for (const [child, parent] of [
    [a, b],
    [b, a],
  ]) {
    const keyColumns = (config.schema[parent] ?? []).filter((column) => column.pk);
    if (keyColumns.length !== 1) {
      continue;
    }
    const key = keyColumns[0].name;
    const parentName = lastPart(parent).toLowerCase();
    const wanted = new Set([`${singular(parentName)}_${key.toLowerCase()}`, `${parentName}_${key.toLowerCase()}`]);
    const column = (config.schema[child] ?? []).find((candidate) => wanted.has(candidate.name.toLowerCase()));
    if (column !== undefined) {
      guessed.push({
        relation: { table: child, columns: [column.name], refTable: parent, refColumns: [key] },
        guessed: true,
      });
    }
  }
  return guessed;
}

export function completeSql(input: string, pos: number, config: SqlCompletionConfig): SqlCompletions | null {
  const [start, end] = statementBounds(input, pos, config.dialect);
  const quotes = config.identifierQuotes || '"';
  const all = tokenize(input, start, end, pos, config.dialect, quotes);
  // The token the cursor is in or just past the end of.
  const here = all.find((token) => token.from < pos && pos <= token.to) ?? null;
  let from = pos;
  let to = pos;
  let typed = "";
  let quote: string | null = null;
  if (here !== null) {
    const inside = pos < here.to || !here.closed;
    if ((here.kind === "comment" || here.kind === "string") && inside) {
      return null;
    }
    if (here.kind === "other" && /^[\d@:]/.test(here.text)) {
      return null;
    }
    if (here.kind === "name") {
      from = here.from;
      typed = input.slice(here.from, pos);
    } else if (here.kind === "quoted" && inside) {
      quote = input[here.from];
      from = here.from;
      typed = input.slice(here.from + 1, pos);
      // The whole quoted name is replaced, its closing quote too.
      to = here.closed ? here.to : pos;
    }
  }
  const word = from < pos || quote !== null ? here : null;
  const tokens = all.filter((token) => token !== word && token.kind !== "comment");
  const before = tokens.filter((token) => token.to <= from);
  const lastWord = upper(before[before.length - 1]);

  // alias. / table. / schema. / schema.table.
  const parents: string[] = [];
  let back = before.length - 1;
  while (isPunct(before[back], ".") && (before[back - 1]?.kind === "name" || before[back - 1]?.kind === "quoted")) {
    parents.unshift(before[back - 1].text);
    back -= 2;
  }
  const afterDot = isPunct(before[before.length - 1], ".");
  if (afterDot && parents.length === 0) {
    return null;
  }
  // Nothing typed: only asked for, after a dot, or right after JOIN / ON,
  // where the joins and their conditions are worth offering unasked.
  const joinSpot = quote === null && parents.length === 0 && (lastWord === "JOIN" || lastWord === "ON");
  if (typed === "" && quote === null && !afterDot && !config.explicit && !joinSpot) {
    return null;
  }
  const unasked = typed === "" && quote === null && !afterDot && !config.explicit;

  const keys = Object.keys(config.schema);
  const refs = tableRefs(tokens, keys);
  // The tables named before the cursor, in order: the last is the one a JOIN … ON is joining.
  const refsBefore = tableRefs(before, keys);
  // In quotes the user opened, names come in those; elsewhere the dialect's
  // first quote wraps the names that need one (as lang-sql does).
  const open = quote ?? quotes[0];
  const shut = open === "[" ? "]" : open;
  const plain = new RegExp("^[a-z_][a-z_\\d]*$", config.caseInsensitiveIdentifiers ? "i" : "");
  const quoteName = (name: string): string =>
    quote === null && plain.test(name) ? name : open + name.replaceAll(shut, shut + shut) + shut;
  const quoteTable = (key: string): string => key.split(".").map(quoteName).join(".");

  interface Candidate {
    name: string;
    kind: SqlOptionKind;
    insert?: string;
    snippet?: string;
    detail?: string;
    table?: string;
    column?: CompletionColumn;
    relation?: CompletionRelation;
    guessed?: boolean;
    signature?: string;
    about?: string;
    usageKey: string;
  }
  const columnsOf = (key: string, showTable: boolean): Candidate[] =>
    (config.schema[key] ?? []).map((column) => ({
      name: column.name,
      kind: "column",
      insert: quoteName(column.name),
      detail: showTable ? `${column.type ?? ""} · ${lastPart(key)}`.replace(/^ · /, "") : (column.type ?? undefined),
      table: key,
      column,
      usageKey: `column:${key}.${column.name}`,
    }));
  // A table, offered as `shown`: its key, or what follows a schema already typed.
  const tableOf = (key: string, shown = key): Candidate => ({
    name: shown,
    kind: "table",
    insert: quoteTable(shown),
    table: key,
    usageKey: `table:${key}`,
  });
  // A condition joining `link` between tables qualified as `qualify` says.
  const conditionOf = (relation: CompletionRelation, qualify: (key: string) => string): string =>
    relation.columns
      .map(
        (column, index) =>
          `${qualify(relation.table)}.${quoteName(column)} = ${qualify(relation.refTable)}.${quoteName(relation.refColumns[index] ?? column)}`,
      )
      .join(caseLike(" AND ", typed));

  // What fits the spot best first; prefixOnly tiers match from the start alone.
  const tiers: { candidates: Candidate[]; prefixOnly: boolean }[] = [];
  const addNames = (candidates: Candidate[], prefixOnly = false): void => {
    tiers.push({ candidates, prefixOnly });
  };
  if (parents.length > 0) {
    const alias = parents.length === 1
      ? refs.find((ref) => ref.alias !== null && ref.alias.toLowerCase() === parents[0].toLowerCase())
      : undefined;
    const key = alias !== undefined ? alias.key : tableKey(parents, keys);
    if (key !== null) {
      addNames(columnsOf(key, false));
    } else if (alias === undefined) {
      // schema. offers that schema's tables (PostgreSQL's public. the ones listed bare).
      const prefix = `${parents.join(".").toLowerCase()}.`;
      const inSchema = keys.filter((name) => name.toLowerCase().startsWith(prefix));
      const bare = parents.length === 1 && parents[0].toLowerCase() === defaultSchemaOf(config.dialect)
        ? keys.filter((name) => !name.includes("."))
        : [];
      addNames(
        [...inSchema, ...bare].map((name) =>
          tableOf(name, name.toLowerCase().startsWith(prefix) ? name.slice(prefix.length) : name),
        ),
      );
    }
  } else {
    const present = refsBefore.filter((ref): ref is TableRef & { key: string } => ref.key !== null);
    const presentKeys = new Set(refs.flatMap((ref) => (ref.key === null ? [] : [ref.key])));
    const qualifierOf = (ref: TableRef & { key: string }): string => ref.alias ?? quoteTable(ref.key);
    if (lastWord === "JOIN") {
      // The tables tied to the statement's by a foreign key (or by their
      // names), each inserted with its alias and ON condition.
      const aliased = refs.some((ref) => ref.alias !== null);
      const taken = new Set(refs.flatMap((ref) => (ref.alias === null ? [] : [ref.alias.toLowerCase()])));
      const declared: Candidate[] = [];
      const guessed: Candidate[] = [];
      for (const key of keys) {
        if (presentKeys.has(key)) {
          continue;
        }
        // The latest table first: JOIN usually follows on from it.
        for (const ref of [...present].reverse()) {
          const link = linksBetween(key, ref.key, config)[0];
          if (link === undefined) {
            continue;
          }
          const alias = aliased ? aliasFor(key, taken) : null;
          const qualify = (table: string): string => (table === key ? (alias ?? quoteTable(key)) : qualifierOf(ref));
          const condition = conditionOf(link.relation, qualify);
          const candidate: Candidate = {
            name: key,
            kind: "join",
            insert: `${quoteTable(key)}${alias === null ? "" : ` ${alias}`} ${caseLike("ON", typed)} ${condition}`,
            detail: condition,
            table: key,
            relation: link.relation,
            guessed: link.guessed,
            usageKey: `join:${key}`,
          };
          (link.guessed ? guessed : declared).push(candidate);
          break;
        }
      }
      addNames(declared);
      addNames(guessed);
      if (!unasked) {
        addNames(keys.map((key) => tableOf(key)));
      }
    } else if (lastWord === "ON" && present.length >= 2) {
      // The table being joined against each one before it.
      const joined = present[present.length - 1];
      const declared: Candidate[] = [];
      const guessed: Candidate[] = [];
      for (const other of present.slice(0, -1).reverse()) {
        if (other.key === joined.key) {
          continue;
        }
        for (const link of linksBetween(joined.key, other.key, config)) {
          const qualify = (table: string): string => (table === joined.key ? qualifierOf(joined) : qualifierOf(other));
          const condition = conditionOf(link.relation, qualify);
          (link.guessed ? guessed : declared).push({
            name: condition,
            kind: "condition",
            insert: condition,
            table: joined.key,
            relation: link.relation,
            guessed: link.guessed,
            usageKey: `on:${link.relation.table}.${link.relation.columns.join(",")}`,
          });
        }
      }
      addNames(declared);
      addNames(guessed);
    }
    if (!unasked && lastWord !== "JOIN") {
      if (wantsTable(before)) {
        addNames(keys.map((key) => tableOf(key)));
      } else {
        const seen = new Set<string>();
        const columns: Candidate[] = [];
        const several = new Set(refs.map((ref) => ref.key)).size > 1;
        for (const ref of refs) {
          if (ref.key !== null && !seen.has(ref.key)) {
            seen.add(ref.key);
            columns.push(...columnsOf(ref.key, several));
          }
        }
        addNames(columns);
        const aliases: Candidate[] = refs.flatMap((ref) =>
          ref.alias === null
            ? []
            : [{
                name: ref.alias,
                kind: "alias" as const,
                insert: quoteName(ref.alias),
                detail: ref.key === null ? undefined : lastPart(ref.key),
                table: ref.key ?? undefined,
                usageKey: `alias:${ref.alias}`,
              }],
        );
        addNames([...keys.map((key) => tableOf(key)), ...aliases]);
        if (quote === null) {
          const family = familyOf(config.dialect);
          addNames(
            FUNCTIONS.filter((fn) => fn.only === undefined || fn.only.includes(family)).map((fn) => {
              const name = caseLike(fn.name, typed);
              return {
                name,
                kind: "function" as const,
                snippet: fn.window ? `${name}()${caseLike(" OVER (", typed)}\${})` : `${name}(\${})`,
                detail: fn.window ? `(${fn.args}) OVER` : `(${fn.args})`,
                signature: `${name}(${fn.args})${fn.window ? caseLike(" OVER (…)", typed) : ""}`,
                about: fn.about,
                usageKey: `function:${fn.name}`,
              };
            }),
            true,
          );
        }
      }
      if (quote === null) {
        addNames(
          config.words.map((word) => ({
            name: caseLike(word.label, typed),
            kind: word.type === "type" ? ("type" as const) : ("keyword" as const),
            usageKey: `word:${word.label.toLowerCase()}`,
          })),
          true,
        );
        // After the keyword itself, so typing it out and pressing Return keeps just the word.
        if (before.length === 0) {
          addNames(
            STATEMENTS.map((statement) => ({
              name: caseLike(statement.label, typed),
              kind: "snippet" as const,
              snippet: caseLike(statement.template, typed).replace(/\$\{([a-z]+)\}/gi, (_m, field: string) => `\${${field.toLowerCase()}}`),
              usageKey: `statement:${statement.label}`,
            })),
            true,
          );
        }
      }
    }
  }

  // Best match first; then the tier (what fits the spot); then what was
  // picked more often; then by name.
  const usage = config.usage ?? (() => 0);
  const matched = tiers
    .flatMap((tier, order) =>
      tier.candidates.flatMap((candidate) => {
        const match = matchName(candidate.name, typed, tier.prefixOnly);
        return match === null
          ? []
          : [{ candidate, order, match, lower: candidate.name.toLowerCase(), used: usage(candidate.usageKey) }];
      }),
    )
    .sort(
      (a, b) =>
        a.match.rank - b.match.rank ||
        a.order - b.order ||
        b.used - a.used ||
        (a.lower < b.lower ? -1 : a.lower > b.lower ? 1 : 0),
    );
  const options: SqlCompletionOption[] = [];
  const offered = new Set<string>();
  for (const { candidate, lower, match } of matched) {
    const seenKey = `${candidate.kind === "join" ? "join:" : ""}${lower}`;
    if (offered.has(seenKey)) {
      continue;
    }
    offered.add(seenKey);
    const insert = candidate.insert ?? candidate.name;
    // In quotes the label is the quoted name, so it reads as what goes in.
    const label = quote !== null && candidate.kind !== "join" ? insert : candidate.name;
    const shift = label === candidate.name ? 0 : label.indexOf(candidate.name);
    options.push({
      label,
      kind: candidate.kind,
      ...(candidate.snippet !== undefined ? { snippet: candidate.snippet } : insert !== label ? { apply: insert } : {}),
      ...(candidate.detail !== undefined && candidate.detail !== "" ? { detail: candidate.detail } : {}),
      ...(candidate.table !== undefined ? { table: candidate.table } : {}),
      ...(candidate.column !== undefined ? { column: candidate.column } : {}),
      ...(candidate.relation !== undefined ? { relation: candidate.relation, guessed: candidate.guessed ?? false } : {}),
      ...(candidate.signature !== undefined ? { signature: candidate.signature, about: candidate.about } : {}),
      matched: shift >= 0 ? match.spans.map((at) => at + shift) : [],
      usageKey: candidate.usageKey,
    });
  }
  return { from, to, typed, bare: quote === null && parents.length === 0, options };
}

// The string the cursor is in, when it is compared with a column
// (col = '…', col <> '…', col IN ('…', '…')): that column, for its values.
export function valueSlotAt(input: string, pos: number, config: SqlCompletionConfig): SqlValueSlot | null {
  const [start, end] = statementBounds(input, pos, config.dialect);
  const quotes = config.identifierQuotes || '"';
  const tokens = tokenize(input, start, end, pos, config.dialect, quotes).filter((token) => token.kind !== "comment");
  const index = tokens.findIndex(
    (token) => token.kind === "string" && token.from < pos && (pos < token.to || !token.closed),
  );
  if (index < 0) {
    return null;
  }
  const string = tokens[index];
  const quote = input[string.from];
  if (quote !== "'" && quote !== '"') {
    return null;
  }
  let at = index - 1;
  const op = tokens[at];
  if (op?.kind === "other" && op.text === "=") {
    at -= 1;
    if (tokens[at]?.kind === "other" && (tokens[at].text === "!" || tokens[at].text === "<" || tokens[at].text === ">")) {
      at -= 1;
    }
  } else if (op?.kind === "other" && op.text === ">" && tokens[at - 1]?.text === "<") {
    at -= 2;
  } else {
    // IN ('a', 'b', |
    while (isPunct(tokens[at], ",") && tokens[at - 1]?.kind === "string") {
      at -= 2;
    }
    if (!isPunct(tokens[at], "(") || upper(tokens[at - 1]) !== "IN") {
      return null;
    }
    at -= 2;
    if (upper(tokens[at]) === "NOT") {
      at -= 1;
    }
  }
  const columnToken = tokens[at];
  if (columnToken === undefined || (columnToken.kind !== "name" && columnToken.kind !== "quoted")) {
    return null;
  }
  const keys = Object.keys(config.schema);
  const refs = tableRefs(tokens, keys);
  const qualifier = isPunct(tokens[at - 1], ".") ? tokens[at - 2] : undefined;
  const wanted = columnToken.text.toLowerCase();
  let table: string | null = null;
  if (qualifier !== undefined) {
    const alias = refs.find((ref) => ref.alias !== null && ref.alias.toLowerCase() === qualifier.text.toLowerCase());
    table = alias !== undefined ? alias.key : tableKey([qualifier.text], keys);
  } else {
    table = refs.find((ref) => ref.key !== null && (config.schema[ref.key] ?? []).some((column) => column.name.toLowerCase() === wanted))?.key ?? null;
  }
  const column = table === null ? undefined : (config.schema[table] ?? []).find((entry) => entry.name.toLowerCase() === wanted);
  if (table === null || column === undefined) {
    return null;
  }
  const from = string.from + 1;
  const closed = string.closed && pos < string.to;
  const to = closed ? string.to - 1 : pos;
  return { from, to, typed: input.slice(from, pos), table, column: column.name, quote, closed };
}
