import { escapeString, lexingFor, splitSqlRanges } from "./sqlSplit";

// What the SQL editor offers at the cursor, as in TablePlus. After "alias."
// or "table." that table's columns alone; right after FROM, JOIN, INTO,
// UPDATE or TABLE the tables first; anywhere else the columns of the tables
// the statement names first, then tables, then keywords and functions.
// Names match anywhere in them, keywords only from their start: "na" offers
// a name column and NATURAL, never BINARY or RENAME.

// A keyword, type or function of the dialect, as lang-sql lists them.
export interface SqlWord {
  label: string;
  type: string;
}

export interface SqlCompletionOption {
  label: string;
  type: string;
  apply?: string;
  detail?: string;
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
  // default schema) to its column names.
  schema: Record<string, string[]>;
  words: readonly SqlWord[];
  // The engine kind (sqlite, postgres, mysql, …): how the SQL is read.
  dialect?: string;
  // The characters that quote names; the first quotes an inserted name that needs it.
  identifierQuotes: string;
  caseInsensitiveIdentifiers?: boolean;
  // Asked for (Ctrl-Space) rather than typed: offers something with nothing typed.
  explicit?: boolean;
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
  if (typed === "" && quote === null && !afterDot && !config.explicit) {
    return null;
  }

  const keys = Object.keys(config.schema);
  const refs = tableRefs(tokens, keys);
  const folded = typed.toLowerCase();
  // In quotes the user opened, names come in those; elsewhere the dialect's
  // first quote wraps the names that need one (as lang-sql does).
  const open = quote ?? quotes[0];
  const shut = open === "[" ? "]" : open;
  const plain = new RegExp("^[a-z_][a-z_\\d]*$", config.caseInsensitiveIdentifiers ? "i" : "");
  const quoteName = (name: string): string =>
    quote === null && plain.test(name) ? name : open + name.replaceAll(shut, shut + shut) + shut;

  interface Candidate {
    name: string;
    type: string;
    insert: string;
    detail?: string;
  }
  const columnsOf = (key: string, detail?: string): Candidate[] =>
    (config.schema[key] ?? []).map((column) => ({ name: column, type: "property", insert: quoteName(column), detail }));
  const tablesNamed = (names: string[]): Candidate[] =>
    names.map((name) => ({ name, type: "type", insert: name.split(".").map(quoteName).join(".") }));
  // Names match anywhere (those starting with the text first), keywords only from their start.
  const rankOf = (name: string, prefixOnly: boolean): number => {
    const lower = name.toLowerCase();
    return lower.startsWith(folded) ? 0 : !prefixOnly && lower.includes(folded) ? 1 : -1;
  };

  // What fits the spot best first.
  const tiers: { candidates: Candidate[]; prefixOnly: boolean }[] = [];
  const addNames = (candidates: Candidate[]): void => {
    tiers.push({ candidates, prefixOnly: false });
  };
  if (parents.length > 0) {
    const alias = parents.length === 1
      ? refs.find((ref) => ref.alias !== null && ref.alias.toLowerCase() === parents[0].toLowerCase())
      : undefined;
    const key = alias !== undefined ? alias.key : tableKey(parents, keys);
    if (key !== null) {
      addNames(columnsOf(key));
    } else if (alias === undefined) {
      // schema. offers that schema's tables (PostgreSQL's public. the ones listed bare).
      const prefix = `${parents.join(".").toLowerCase()}.`;
      const inSchema = keys.filter((name) => name.toLowerCase().startsWith(prefix)).map((name) => name.slice(prefix.length));
      const bare = parents.length === 1 && parents[0].toLowerCase() === defaultSchemaOf(config.dialect)
        ? keys.filter((name) => !name.includes("."))
        : [];
      addNames(tablesNamed([...inSchema, ...bare]));
    }
  } else {
    const tables = tablesNamed(keys);
    if (wantsTable(before)) {
      addNames(tables);
    } else {
      const seen = new Set<string>();
      const columns: Candidate[] = [];
      for (const ref of refs) {
        if (ref.key !== null && !seen.has(ref.key)) {
          seen.add(ref.key);
          columns.push(...columnsOf(ref.key, ref.key));
        }
      }
      addNames(columns);
      const aliases = refs.flatMap((ref) =>
        ref.alias === null ? [] : [{ name: ref.alias, type: "constant", insert: quoteName(ref.alias) }],
      );
      addNames([...tables, ...aliases]);
    }
    if (quote === null) {
      tiers.push({
        candidates: config.words.map((word) => ({ name: word.label, type: word.type, insert: word.label })),
        prefixOnly: true,
      });
    }
  }

  // Whatever starts with the text first, tier by tier, then what only holds it.
  const matched = tiers
    .flatMap((tier, order) =>
      tier.candidates.map((candidate) => ({
        candidate,
        order,
        lower: candidate.name.toLowerCase(),
        rank: rankOf(candidate.name, tier.prefixOnly),
      })),
    )
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.order - b.order || (a.lower < b.lower ? -1 : a.lower > b.lower ? 1 : 0));
  const options: SqlCompletionOption[] = [];
  const offered = new Set<string>();
  for (const { candidate, lower } of matched) {
    if (offered.has(lower)) {
      continue;
    }
    offered.add(lower);
    options.push({
      label: quote !== null ? candidate.insert : candidate.name,
      type: candidate.type,
      ...(quote === null && candidate.insert !== candidate.name ? { apply: candidate.insert } : {}),
      ...(candidate.detail !== undefined ? { detail: candidate.detail } : {}),
    });
  }
  return { from, to, typed, bare: quote === null && parents.length === 0, options };
}
