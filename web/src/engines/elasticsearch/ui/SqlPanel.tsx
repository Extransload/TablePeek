// The SQL sub-tab of an index tab: Elasticsearch SQL (or OpenSearch SQL) on
// the index. The editor colours SQL and completes keywords, functions, the
// index and its fields; ⌘↩ runs the statement (or the selection) and the
// rows show in the app's grid, typed by the columns SQL reports. A reply
// with a cursor has more pages: 더 불러오기 appends the next one, and the
// cursor is closed when a new statement runs or the tab goes. 번역 shows the
// Query DSL the statement becomes. A parse error underlines its place.

import { useEffect, useMemo, useRef, useState } from "react";
import { columnWidthsKey } from "../../../columnWidths";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { CloseIcon, CodeIcon, PlayIcon, StopIcon } from "../../../components/icons";
import { Spinner } from "../../../components/Spinner";
import { TableGrid, type TableGridHandle } from "../../../components/TableGrid";
import type { GridColumnSpec } from "../../../grid/columns";
import type { RowSource } from "../../../grid/rowSource";
import { t } from "../../../i18n";
import { stringifyJson } from "../../mongodb/bson";
import { SearchError, clusterInfo, getMapping, isAbort, sql, sqlClose, sqlTranslate, type SqlResult } from "../api";
import type { DslCompletion, DslItem, MappedField } from "../dsl";
import { RawJson, allMappedFields } from "./MappingPanel";
import { SearchEditor, type SearchEditorHandle, type Span } from "./SearchEditor";
import type { SqlPanelProps } from "./types";
import "../../mongodb/mongodb.css";
import "../../mongodb/ui/panels.css";
import "./panels.css";

// Rows asked for per page.
const FETCH_SIZE = 1000;

// ---- SQL text ----

const KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "GROUP",
  "BY",
  "HAVING",
  "ORDER",
  "LIMIT",
  "OFFSET",
  "AS",
  "AND",
  "OR",
  "NOT",
  "NULL",
  "IS",
  "IN",
  "LIKE",
  "RLIKE",
  "BETWEEN",
  "ASC",
  "DESC",
  "DISTINCT",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "JOIN",
  "ON",
  "INNER",
  "LEFT",
  "OUTER",
  "ALL",
  "TRUE",
  "FALSE",
  "SHOW",
  "TABLES",
  "COLUMNS",
  "FUNCTIONS",
  "DESCRIBE",
  "EXISTS",
  "ESCAPE",
  "INTERVAL",
  "NULLS",
  "FIRST",
  "LAST",
  "TOP",
  "PIVOT",
  "FOR",
  "FROZEN",
  "INCLUDE",
];
const KEYWORD_SET: Record<string, true> = Object.fromEntries(KEYWORDS.map((k) => [k, true]));

// Functions both SQL dialects know (and a few one of them adds), with what
// each does; aggregates are marked.
const FUNCTIONS: { name: string; doc: string; agg?: true }[] = [
  { name: "COUNT", doc: "개수", agg: true },
  { name: "SUM", doc: "합계", agg: true },
  { name: "AVG", doc: "평균", agg: true },
  { name: "MIN", doc: "최솟값", agg: true },
  { name: "MAX", doc: "최댓값", agg: true },
  { name: "FIRST", doc: "정렬 순 첫 값", agg: true },
  { name: "LAST", doc: "정렬 순 마지막 값", agg: true },
  { name: "PERCENTILE", doc: "백분위수", agg: true },
  { name: "PERCENTILE_RANK", doc: "백분위 순위", agg: true },
  { name: "STDDEV_POP", doc: "표준편차", agg: true },
  { name: "VAR_POP", doc: "분산", agg: true },
  { name: "MATCH", doc: "전문 검색 (match)" },
  { name: "QUERY", doc: "query_string 검색" },
  { name: "SCORE", doc: "관련도 점수" },
  { name: "MATCH_PHRASE", doc: "구문 검색 (OpenSearch)" },
  { name: "MULTI_MATCH", doc: "여러 필드 검색 (OpenSearch)" },
  { name: "HISTOGRAM", doc: "구간 묶기" },
  { name: "NOW", doc: "지금 시각" },
  { name: "CURRENT_DATE", doc: "오늘 날짜" },
  { name: "CURRENT_TIMESTAMP", doc: "지금 시각" },
  { name: "DATE_TRUNC", doc: "날짜 자르기" },
  { name: "DATE_ADD", doc: "날짜 더하기" },
  { name: "DATE_DIFF", doc: "날짜 차이" },
  { name: "DATE_FORMAT", doc: "날짜 서식" },
  { name: "DATE_PARSE", doc: "글을 날짜로" },
  { name: "EXTRACT", doc: "날짜의 부분" },
  { name: "YEAR", doc: "연" },
  { name: "MONTH", doc: "월" },
  { name: "DAY", doc: "일" },
  { name: "HOUR", doc: "시" },
  { name: "MINUTE", doc: "분" },
  { name: "SECOND", doc: "초" },
  { name: "DAY_OF_WEEK", doc: "요일" },
  { name: "CONCAT", doc: "이어 붙이기" },
  { name: "LENGTH", doc: "길이" },
  { name: "LOWER", doc: "소문자로" },
  { name: "UPPER", doc: "대문자로" },
  { name: "SUBSTRING", doc: "부분 문자열" },
  { name: "TRIM", doc: "앞뒤 공백 빼기" },
  { name: "REPLACE", doc: "바꾸기" },
  { name: "LEFT", doc: "왼쪽 n글자" },
  { name: "RIGHT", doc: "오른쪽 n글자" },
  { name: "LOCATE", doc: "위치 찾기" },
  { name: "ABS", doc: "절댓값" },
  { name: "ROUND", doc: "반올림" },
  { name: "FLOOR", doc: "내림" },
  { name: "CEIL", doc: "올림" },
  { name: "SQRT", doc: "제곱근" },
  { name: "POWER", doc: "거듭제곱" },
  { name: "LOG", doc: "자연로그" },
  { name: "LOG10", doc: "상용로그" },
  { name: "MOD", doc: "나머지" },
  { name: "TRUNCATE", doc: "자리 자르기" },
  { name: "COALESCE", doc: "첫 NULL 아닌 값" },
  { name: "IFNULL", doc: "NULL이면 다른 값" },
  { name: "NULLIF", doc: "같으면 NULL" },
  { name: "GREATEST", doc: "가장 큰 값" },
  { name: "LEAST", doc: "가장 작은 값" },
  { name: "CAST", doc: "형 바꾸기" },
  { name: "CONVERT", doc: "형 바꾸기" },
  { name: "ST_DISTANCE", doc: "두 점 사이 거리" },
  { name: "ST_X", doc: "경도" },
  { name: "ST_Y", doc: "위도" },
];

type SqlTokKind = "space" | "comment" | "string" | "quoted" | "backtick" | "number" | "word" | "punc";

interface SqlTok {
  kind: SqlTokKind;
  from: number;
  to: number;
  text: string;
}

const TOKEN = /(\s+)|(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^']|'')*'?)|("(?:[^"]|"")*"?)|(`[^`]*`?)|(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([A-Za-z_@][\w@]*)|([\s\S])/gy;
const KINDS: SqlTokKind[] = ["space", "comment", "string", "quoted", "backtick", "number", "word", "punc"];

function sqlTokens(src: string): SqlTok[] {
  const out: SqlTok[] = [];
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(src); m !== null; m = TOKEN.exec(src)) {
    const group = m.findIndex((g, i) => i > 0 && g !== undefined);
    out.push({ kind: KINDS[group - 1], from: m.index, to: m.index + m[0].length, text: m[0] });
  }
  return out;
}

// Keywords, functions (a word before `(`), identifiers, literals and
// comments in the app's sx-* colours.
function sqlSpans(src: string): Span[] {
  const toks = sqlTokens(src);
  const spans: Span[] = [];
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    let cls: string | null = null;
    switch (tok.kind) {
      case "comment":
        cls = "sx-comment";
        break;
      case "string":
        cls = "sx-string sx-single";
        break;
      case "quoted":
      case "backtick":
        cls = "sx-variable";
        break;
      case "number":
        cls = "sx-number";
        break;
      case "punc":
        cls = /[=<>!+\-*/%|]/.test(tok.text) ? "sx-operator" : "sx-punctuation";
        break;
      case "word": {
        const upper = tok.text.toUpperCase();
        let j = i + 1;
        while (j < toks.length && toks[j].kind === "space") {
          j++;
        }
        const next = toks[j];
        cls = upper === "TRUE" || upper === "FALSE" ? "sx-bool" : upper === "NULL" ? "sx-null" : next?.text === "(" ? "sx-function" : Object.hasOwn(KEYWORD_SET, upper) ? "sx-keyword" : "sx-variable";
        break;
      }
    }
    if (cls !== null) {
      spans.push({ from: tok.from, to: tok.to, cls });
    }
  }
  return spans;
}

// A name as SQL reads it: bare when plain, quoted otherwise (Elasticsearch
// quotes with "…", OpenSearch with `…`).
function sqlName(name: string, quote: string): string {
  return /^[A-Za-z_][\w.]*$/.test(name) && !Object.hasOwn(KEYWORD_SET, name.toUpperCase()) ? name : `${quote}${name.split(quote).join(quote + quote)}${quote}`;
}

// After these the next word is a table name.
const TABLE_BEFORE: Record<string, true> = { FROM: true, JOIN: true, DESCRIBE: true, TABLE: true };
// After these a field name fits even before anything is typed.
const FIELD_BEFORE: Record<string, true> = { SELECT: true, WHERE: true, BY: true, AND: true, OR: true, ON: true, HAVING: true, ",": true, "(": true, "=": true, NOT: true, DISTINCT: true };

function completeSql(text: string, pos: number, ctx: { fields: MappedField[]; index: string; quote: string }): DslCompletion | null {
  const toks = sqlTokens(text.slice(0, pos));
  const last = toks[toks.length - 1];
  let from = pos;
  let prefix = "";
  let quoted = false;
  if (last !== undefined && last.to === pos && (last.kind === "string" || last.kind === "comment")) {
    return null;
  }
  if (last !== undefined && last.to === pos && (last.kind === "quoted" || last.kind === "backtick") && (last.text.length === 1 || !last.text.endsWith(last.text[0]))) {
    quoted = true;
    from = last.from + 1;
    prefix = last.text.slice(1);
  } else {
    prefix = /[\w.@]*$/.exec(text.slice(0, pos))?.[0] ?? "";
    from = pos - prefix.length;
  }
  // The word before the one typed (`FROM`, `WHERE`, `,` …).
  const before = toks.filter((tok) => tok.to <= (quoted ? from - 1 : from) && tok.kind !== "space" && tok.kind !== "comment");
  const prev = before.length === 0 ? "" : before[before.length - 1].text.toUpperCase();
  const tableSlot = Object.hasOwn(TABLE_BEFORE, prev);
  if (prefix === "" && !quoted && !tableSlot && !Object.hasOwn(FIELD_BEFORE, prev)) {
    return null;
  }
  // A quoted name ends with its quote unless one already follows the caret.
  const q = quoted ? text[from - 1] : ctx.quote;
  const rest = text.slice(pos);
  const closer = quoted ? (rest.replace(/^[\w.@*-]*/, "").startsWith(q) && q !== '"' ? "" : q) : "";
  const name = (label: string) => (quoted ? label + closer : sqlName(label, q));
  let items: DslItem[];
  if (tableSlot) {
    items = [{ label: ctx.index, kind: "index", insert: name(ctx.index) }];
  } else {
    items = ctx.fields.filter((f) => f.type !== "object" && f.type !== "nested").map((f): DslItem => ({ label: f.path, kind: "field", detail: f.type, insert: name(f.path) }));
    if (!quoted) {
      items.push(
        ...FUNCTIONS.map((f): DslItem => ({ label: f.name, kind: f.agg ? "agg" : "query", detail: t(f.doc), insert: `${f.name}()`, caretBack: 1 })),
        ...KEYWORDS.map((k): DslItem => ({ label: k, kind: "keyword", insert: k })),
        { label: ctx.index, kind: "index", insert: name(ctx.index) },
      );
    }
  }
  const lower = prefix.toLowerCase();
  const matched = items
    .map((item, order) => ({ item, order, at: item.label.toLowerCase().indexOf(lower) }))
    .filter((x) => x.at >= 0 && x.item.label.toLowerCase() !== lower)
    .sort((a, b) => Number(a.at !== 0) - Number(b.at !== 0) || a.order - b.order)
    .slice(0, 200)
    .map((x) => x.item);
  return matched.length === 0 ? null : { from, to: pos, quoted, items: matched };
}

// Where a parse error points in the statement: the reply's line and column
// (1-based), or the `line 1:15:` the message starts with.
function errorRange(error: unknown, text: string, base: number): { from: number; to: number } | null {
  if (!(error instanceof SearchError)) {
    return null;
  }
  let line = error.position?.line;
  let column = error.position?.column;
  if (line === undefined || column === undefined) {
    const m = /line (\d+):(\d+)/.exec(error.message);
    if (m === null) {
      return null;
    }
    line = Number(m[1]);
    column = Number(m[2]);
  }
  const lines = text.split("\n");
  if (line < 1 || line > lines.length) {
    return null;
  }
  let at = 0;
  for (let i = 0; i < line - 1; i++) {
    at += lines[i].length + 1;
  }
  at += Math.max(0, Math.min(column - 1, lines[line - 1].length));
  const word = /^[\w."`'@*]+/.exec(text.slice(at))?.[0].length ?? 1;
  return { from: base + at, to: base + at + Math.max(1, word) };
}

// ---- Rows ----

const NUMERIC: Record<string, true> = { long: true, integer: true, short: true, byte: true, double: true, float: true, half_float: true, scaled_float: true, unsigned_long: true, int: true, bigint: true, smallint: true, tinyint: true, real: true };
const DATES: Record<string, true> = { datetime: true, date: true, timestamp: true, date_nanos: true, time: true };
const STRUCTS: Record<string, true> = { object: true, nested: true, struct: true, array: true, geo_point: true, geo_shape: true, shape: true };

function columnSpec(type: string): GridColumnSpec {
  const ty = type.toLowerCase();
  return { kind: Object.hasOwn(NUMERIC, ty) ? "number" : ty === "boolean" ? "boolean" : Object.hasOwn(DATES, ty) ? "datetime" : Object.hasOwn(STRUCTS, ty) ? "json" : "text" };
}

// The reply's rows for the canvas grid, read-only: objects and arrays as
// one-line JSON, numbers of number columns on the right.
class SqlRowSource implements RowSource {
  readonly columns: string[];
  readonly rowCount: number;

  constructor(
    private readonly cols: { name: string; type: string }[],
    private readonly rows: unknown[][],
  ) {
    this.columns = cols.map((c) => c.name);
    this.rowCount = rows.length;
  }

  cell(row: number, col: number): unknown {
    const v = this.rows[row]?.[col];
    if (v === undefined) {
      return null;
    }
    return v !== null && typeof v === "object" ? stringifyJson(v) : v;
  }

  cellAlign(_row: number, col: number): "left" | "right" | null {
    return Object.hasOwn(NUMERIC, (this.cols[col]?.type ?? "").toLowerCase()) ? "right" : null;
  }

  cellTitle(_row: number, col: number): string | undefined {
    const c = this.cols[col];
    return c === undefined ? undefined : `${c.name} — ${c.type}`;
  }
}

// ---- The panel ----

interface SqlRun {
  query: string;
  columns: SqlResult["columns"];
  rows: unknown[][];
  cursor: string | null;
  elapsedMs: number;
  pages: number;
}

// The statement of each index tab, kept while the app is open.
const texts = new Map<string, string>();
// The SQL dialect's quote of each connection, once known.
const quotes = new Map<string, string>();

function seedFor(index: string, quote: string): string {
  return `SELECT * FROM ${quote}${index.split(quote).join(quote + quote)}${quote} LIMIT 100`;
}

function closeCursor(conn: string, cursor: string | null): void {
  if (cursor !== null) {
    // A cursor left open expires on the server by itself; nothing to report.
    sqlClose(conn, cursor).catch(() => undefined);
  }
}

export function SqlPanel({ host, index, connKey, refreshSeq }: SqlPanelProps) {
  const key = `${host.conn}\u0000${index}`;
  const [quote, setQuote] = useState(() => quotes.get(host.conn) ?? '"');
  const [text, setText] = useState(() => texts.get(key) ?? seedFor(index, quote));
  const [fields, setFields] = useState<MappedField[]>([]);
  const [run, setRun] = useState<SqlRun | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [errorAt, setErrorAt] = useState<{ from: number; to: number } | null>(null);
  const [busy, setBusy] = useState<"run" | "more" | "translate" | null>(null);
  const [translation, setTranslation] = useState<{ query: string; dsl: unknown } | { query: string; error: unknown } | null>(null);
  const editorRef = useRef<SearchEditorHandle | null>(null);
  const gridRef = useRef<TableGridHandle | null>(null);
  const controller = useRef<AbortController | null>(null);
  // The open cursor, closed when the tab goes.
  const cursorRef = useRef<string | null>(null);
  cursorRef.current = run?.cursor ?? null;

  useEffect(
    () => () => {
      controller.current?.abort();
      closeCursor(host.conn, cursorRef.current);
    },
    [host.conn],
  );

  // Which quote the server's SQL takes; the untouched seed follows it.
  useEffect(() => {
    if (quotes.has(host.conn)) {
      return;
    }
    const ctl = new AbortController();
    clusterInfo(host.conn, ctl.signal).then(
      (info) => {
        const q = info.flavor === "opensearch" ? "`" : '"';
        quotes.set(host.conn, q);
        setQuote(q);
        setText((cur) => (cur === seedFor(index, '"') ? seedFor(index, q) : cur));
      },
      () => undefined,
    );
    return () => ctl.abort();
  }, [host.conn, index]);

  useEffect(() => {
    const ctl = new AbortController();
    getMapping(host.conn, index, ctl.signal).then(
      (reply) => setFields(allMappedFields(reply)),
      () => setFields([]),
    );
    return () => ctl.abort();
  }, [host.conn, index, refreshSeq]);

  // F5 runs the statement on show again.
  const lastQuery = useRef<string | null>(null);
  const firstRefresh = useRef(refreshSeq);
  useEffect(() => {
    if (refreshSeq !== firstRefresh.current && lastQuery.current !== null) {
      execute(lastQuery.current, 0);
    }
  }, [refreshSeq]);

  function changeText(next: string): void {
    setText(next);
    texts.set(key, next);
  }

  // The statement to run: the selection if there is one, else the whole
  // text; where it starts in the editor, for the error's place.
  function statement(): { query: string; base: number } | null {
    const selection = editorRef.current?.selection() ?? { from: 0, to: 0 };
    const whole = editorRef.current?.text() ?? text;
    const raw = selection.to > selection.from ? whole.slice(selection.from, selection.to) : whole;
    const from = selection.to > selection.from ? selection.from : 0;
    const lead = raw.length - raw.trimStart().length;
    const query = raw.trim().replace(/;+\s*$/, "");
    return query === "" ? null : { query, base: from + lead };
  }

  function execute(query: string, base: number): void {
    controller.current?.abort();
    const ctl = new AbortController();
    controller.current = ctl;
    closeCursor(host.conn, cursorRef.current);
    cursorRef.current = null;
    lastQuery.current = query;
    setBusy("run");
    setError(null);
    setErrorAt(null);
    sql(host.conn, { query, fetch_size: FETCH_SIZE }, ctl.signal).then(
      (result) => {
        setRun({ query, columns: result.columns, rows: result.rows, cursor: result.cursor, elapsedMs: result.elapsedMs, pages: 1 });
        setBusy(null);
      },
      (e: unknown) => {
        if (isAbort(e)) {
          return;
        }
        // The old rows stay, marked stale, under the error.
        setRun((cur) => (cur === null ? null : { ...cur, cursor: null }));
        setError(e);
        setErrorAt(errorRange(e, query, base));
        setBusy(null);
      },
    );
  }

  function runStatement(): void {
    const s = statement();
    if (s !== null) {
      execute(s.query, s.base);
    }
  }

  function loadMore(): void {
    if (run === null || run.cursor === null || busy !== null) {
      return;
    }
    const cur = run;
    const ctl = new AbortController();
    controller.current = ctl;
    setBusy("more");
    setError(null);
    sql(host.conn, { cursor: cur.cursor ?? undefined }, ctl.signal).then(
      (page) => {
        gridRef.current?.keepViewOnNextSource("all");
        setRun({ ...cur, rows: [...cur.rows, ...page.rows], cursor: page.cursor, elapsedMs: cur.elapsedMs + page.elapsedMs, pages: cur.pages + 1 });
        setBusy(null);
      },
      (e: unknown) => {
        if (!isAbort(e)) {
          setError(e);
          setBusy(null);
        }
      },
    );
  }

  function translate(): void {
    const s = statement();
    if (s === null) {
      return;
    }
    const ctl = new AbortController();
    controller.current?.abort();
    controller.current = ctl;
    setBusy("translate");
    setErrorAt(null);
    sqlTranslate(host.conn, s.query, ctl.signal).then(
      (dsl) => {
        setTranslation({ query: s.query, dsl });
        setBusy(null);
      },
      (e: unknown) => {
        if (!isAbort(e)) {
          setTranslation({ query: s.query, error: e });
          setErrorAt(errorRange(e, s.query, s.base));
          setBusy(null);
        }
      },
    );
  }

  function stop(): void {
    controller.current?.abort();
    controller.current = null;
    setBusy(null);
  }

  const source = useMemo(() => (run === null ? null : new SqlRowSource(run.columns, run.rows)), [run]);
  const specs = useMemo(() => (run === null ? null : run.columns.map((c) => columnSpec(c.type))), [run?.columns]);
  const complete = (src: string, pos: number) => completeSql(src, pos, { fields, index, quote });

  return (
    <div className="mg-pane es-pane es-sql">
      <div className="mg-agg-bar">
        <span className="mg-agg-count">SQL</span>
        <span className="panel-dim">{t("⌘↩ 실행 · 선택한 부분만 실행")}</span>
        <span className="spacer" />
        <button type="button" className={`mg-qbtn${translation !== null ? " active" : ""}`} disabled={busy !== null} title={t("이 SQL이 되는 Query DSL 보기")} onClick={translate}>
          {busy === "translate" ? <Spinner size={10} /> : <CodeIcon size={10} />}
          {t("번역")}
        </button>
        {busy === "run" ? (
          <button type="button" className="mg-qbtn" onClick={stop}>
            <StopIcon size={9} />
            {t("멈추기")}
          </button>
        ) : null}
        <button type="button" className="primary mg-find" disabled={busy !== null} title="⌘↩" onClick={runStatement}>
          {busy === "run" ? <Spinner size={10} /> : <PlayIcon size={9} />}
          {t("실행")}
        </button>
      </div>
      <div className="es-sql-editor">
        <SearchEditor
          ref={editorRef}
          value={text}
          onChange={changeText}
          onRun={runStatement}
          complete={complete}
          spans={sqlSpans}
          error={errorAt}
          placeholder={seedFor(index, quote)}
          ariaLabel={t("SQL 문장")}
        />
      </div>
      {translation !== null ? (
        <div className="es-sql-translate">
          <div className="es-raw-bar">
            <span className="mg-agg-count">{t("Query DSL 번역")}</span>
            <span className="spacer" />
            <button type="button" className="icon-button" title={t("닫기")} aria-label={t("닫기")} onClick={() => setTranslation(null)}>
              <CloseIcon size={10} />
            </button>
          </div>
          {"error" in translation ? <ErrorNotice error={translation.error} context="editor" engine="elasticsearch" variant="compact" /> : <RawJson host={host} value={translation.dsl} label={translation.query} />}
        </div>
      ) : null}
      <div className="es-sql-results">
        {run !== null && source !== null ? (
          <div className={`es-sql-grid${error !== null ? " stale" : ""}`}>
            <TableGrid ref={gridRef} source={source} specs={specs} widthsKey={columnWidthsKey(connKey, `sql › ${index}`)} />
            {run.rows.length === 0 ? <div className="panel-empty mg-grid-empty">{t("행이 없습니다")}</div> : null}
          </div>
        ) : error === null ? (
          <div className="panel-empty">{busy === "run" ? <Spinner size={14} /> : t("SQL을 쓰고 ⌘↩로 실행하세요")}</div>
        ) : null}
        {error !== null ? (
          <div className={run !== null ? "es-sql-banner" : "es-sql-error"}>
            <ErrorNotice error={error} context="editor" engine="elasticsearch" variant={run !== null ? "banner" : "block"} onClose={() => setError(null)} />
          </div>
        ) : null}
      </div>
      {run !== null ? (
        <div className="data-toolbar es-sql-foot">
          <div className="footer-start">
            <span className="row-range">{t("{count}행", { count: run.rows.length.toLocaleString() })}</span>
            <span className="result-bar-time">{`${Math.round(run.elapsedMs).toLocaleString()} ms`}</span>
            {run.pages > 1 ? <span className="panel-dim">{t("{pages}쪽", { pages: run.pages })}</span> : null}
          </div>
          <span className="spacer" />
          {run.cursor !== null ? (
            <button type="button" className="footer-button" disabled={busy !== null} title={t("다음 {count}행을 이어 붙입니다", { count: FETCH_SIZE.toLocaleString() })} onClick={loadMore}>
              {busy === "more" ? <Spinner size={10} /> : null}
              <span className="footer-label">{t("더 불러오기")}</span>
            </button>
          ) : (
            <span className="panel-dim">{t("모두 불러왔습니다")}</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
