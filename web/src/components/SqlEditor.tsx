import { basicSetup } from "codemirror";
import { SQLite, keywordCompletionSource, type SQLDialect } from "@codemirror/lang-sql";
import { HighlightStyle, LanguageSupport, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { Compartment, EditorState, Prec, RangeSet, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  gutterLineClass,
  keymap,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  acceptCompletion,
  autocompletion,
  pickedCompletion,
  snippet,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { isolateHistory } from "@codemirror/commands";
import { selectNextOccurrence } from "@codemirror/search";
import { tags } from "@lezer/highlight";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { SqlDialect } from "../engines/sqlDialect";
import type { AppError } from "../errorHelp";
import { scrollbarsFor } from "../scrollbars";
import { t } from "../i18n";
import {
  completeSql,
  valueSlotAt,
  type CompletionColumn,
  type CompletionRelation,
  type SqlCompletionOption,
  type SqlWord,
} from "../sqlComplete";
import { statementAt } from "../sqlSplit";

export interface FavoriteSnippet {
  keyword: string;
  name: string;
  sql: string;
}

export interface SqlEditorHandle {
  getSql(): string;
  // What ⌘↵ runs: the selection, else the statement the cursor is in (null
  // when the cursor is among comments that belong to no statement).
  currentStatement(): string | null;
  getDoc(): string;
  setSql(text: string): void;
  // Rewrites the selection, or the whole text when nothing is selected, as
  // one undo step; the cursor stays by the same code.
  format(rewrite: (sql: string) => string): void;
  // Replaces the selection (or inserts at the cursor) and focuses.
  insertText(text: string): void;
  // Drops what a background tab's editor holds, so it reopens with the tab's SQL.
  forget(tabId: string): void;
  focus(): void;
  flush(): void;
  // Underlines where the server says `statement` (as it was sent) failed, in
  // this tab's text, and returns that spot's line and column; null when the
  // statement or the spot isn't found (it was edited, or parameters were
  // filled in). Typing clears the mark, as does markError(null).
  markError(failure: { statement: string; position: AppError["position"] } | null): { line: number; column: number } | null;
  // Puts the cursor on the marked spot.
  revealError(): void;
}

interface SqlEditorProps {
  tabId: string;
  tabIds: string[];
  initialSql: string;
  readOnly?: boolean;
  onRun: () => void;
  onSqlChange(tabId: string, sql: string): void;
  // Table to its columns, and the connection's foreign keys, for completion.
  schema: Record<string, CompletionColumn[]>;
  relations?: CompletionRelation[];
  // A column's known values (an enum's labels), offered inside a string
  // compared with it; null when it has none.
  loadValues?: (table: string, column: string) => Promise<string[] | null>;
  favorites: FavoriteSnippet[];
  // CodeMirror key for onRun; null leaves running to the app's shortcuts.
  runKey?: string | null;
  // The engine's SQL, which decides where a statement ends (see sqlSplit);
  // none without a connection.
  dialect?: SqlDialect;
}

// Where `offset` in `before` lands in `after`, a rewrite of it that changed
// blanks, letter case and comment marks (minify writes -- x as /* x */):
// just past as many other characters as precede it.
function sameSpot(before: string, offset: number, after: string): number {
  // How long the mark or blank at `at` is; 0 for a character that counts.
  const skip = (text: string, at: number): number =>
    /\s|#/.test(text[at]) ? 1 : /^(--|\/\*|\*\/)/.test(text.slice(at, at + 2)) ? 2 : 0;
  let code = 0;
  for (let index = 0; index < offset; ) {
    const step = skip(before, index);
    code += step === 0 ? 1 : 0;
    index += Math.max(step, 1);
  }
  let at = 0;
  while (at < after.length && code > 0) {
    const step = skip(after, at);
    code -= step === 0 ? 1 : 0;
    at += Math.max(step, 1);
  }
  // At the start of a word: still there, not at the end of the one before.
  if (/\s/.test(before[offset - 1] ?? "") && /\S/.test(before[offset] ?? "")) {
    while (at < after.length && /\s/.test(after[at])) {
      at += 1;
    }
  }
  return at;
}

// The connection's SQL, for highlighting and completion; with no connection
// SQLite's.
function dialectFor(dialect: SqlDialect | undefined): SQLDialect {
  return dialect?.editor ?? SQLite;
}

const dialectWords = new Map<SQLDialect, SqlWord[]>();

// The dialect's keywords, types and functions: lang-sql builds its keyword
// options up front, through the builder it is given.
function wordsOf(dialect: SQLDialect): SqlWord[] {
  let words = dialectWords.get(dialect);
  if (words === undefined) {
    const list: SqlWord[] = [];
    keywordCompletionSource(dialect, false, (label, type) => {
      list.push({ label, type });
      return { label, type };
    });
    words = list;
    dialectWords.set(dialect, words);
  }
  return words;
}

// How far either side of the cursor completion reads a long script (a dump).
const COMPLETION_WINDOW = 50_000;

// What a completion in the list is, beyond CodeMirror's fields: an option
// sqlComplete made, a saved query, or a column's known value.
type CompletionKind = SqlCompletionOption["kind"] | "saved" | "value";
interface TpCompletion extends Completion {
  tp: { kind: CompletionKind; option?: SqlCompletionOption; saved?: FavoriteSnippet; usageKey?: string };
}

// The mark before each option: a letter on its kind's colour.
const BADGES: Record<CompletionKind, { mark: string; title: string }> = {
  column: { mark: "C", title: "컬럼" },
  table: { mark: "T", title: "테이블" },
  alias: { mark: "A", title: "별칭" },
  join: { mark: "⋈", title: "조인" },
  condition: { mark: "=", title: "조인 조건" },
  function: { mark: "ƒ", title: "함수" },
  keyword: { mark: "K", title: "키워드" },
  type: { mark: "τ", title: "타입" },
  snippet: { mark: "{}", title: "문장" },
  saved: { mark: "★", title: "저장한 쿼리" },
  value: { mark: "v", title: "값" },
};

// How often each option was picked, kept across sessions so the ones used
// most rank first among equals. Capped: the least used go first.
const USAGE_KEY = "tablepeek.completion-usage";
const USAGE_CAP = 500;
let usage: Map<string, number> | null = null;

function usageMap(): Map<string, number> {
  if (usage === null) {
    usage = new Map();
    try {
      const stored: unknown = JSON.parse(window.localStorage.getItem(USAGE_KEY) ?? "{}");
      if (stored !== null && typeof stored === "object") {
        for (const [key, count] of Object.entries(stored)) {
          if (typeof count === "number" && count > 0) {
            usage.set(key, count);
          }
        }
      }
    } catch {}
  }
  return usage;
}

function recordUsage(key: string): void {
  const map = usageMap();
  map.set(key, (map.get(key) ?? 0) + 1);
  if (map.size > USAGE_CAP) {
    const least = [...map.entries()].sort((a, b) => a[1] - b[1]).slice(0, map.size - USAGE_CAP);
    for (const [key] of least) {
      map.delete(key);
    }
  }
  try {
    window.localStorage.setItem(USAGE_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {}
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

// The panel beside the selected option: what a column, table, join,
// function, statement or saved query is, from what completion knows.
function completionInfo(
  completion: TpCompletion,
  schema: Record<string, CompletionColumn[]>,
  relations: readonly CompletionRelation[],
): HTMLElement | null {
  const { kind, option, saved } = completion.tp;
  const box = el("div", "ac-info");
  const head = el("div", "ac-info-head");
  head.append(el("span", `ac-badge ac-${kind}`, BADGES[kind].mark), el("span", "ac-info-title"));
  box.append(head);
  const title = head.lastElementChild as HTMLElement;
  const line = (label: string, value: string, mono = true): void => {
    const row = el("div", "ac-info-row");
    row.append(el("span", "ac-info-label", label), el("span", mono ? "ac-info-value mono" : "ac-info-value", value));
    box.append(row);
  };
  if (kind === "saved" && saved !== undefined) {
    title.textContent = saved.name;
    box.append(el("pre", "ac-info-code", saved.sql.split("\n").slice(0, 12).join("\n")));
    return box;
  }
  if (option === undefined) {
    return null;
  }
  if (kind === "column" && option.column !== undefined && option.table !== undefined) {
    const column = option.column;
    title.textContent = column.name;
    line(t("타입"), column.type ?? "—");
    line(t("테이블"), option.table);
    const flags = [column.pk ? t("기본 키") : "", column.notNull ? "NOT NULL" : ""].filter((flag) => flag !== "");
    if (flags.length > 0) {
      line(t("제약"), flags.join(" · "), false);
    }
    for (const relation of relations) {
      const at = relation.table === option.table ? relation.columns.indexOf(column.name) : -1;
      if (at >= 0) {
        line(t("참조"), `${relation.refTable}.${relation.refColumns[at] ?? ""}`);
      }
    }
    return box;
  }
  if (kind === "table" && option.table !== undefined) {
    const key = option.table;
    const columns = schema[key] ?? [];
    title.textContent = key;
    const list = el("div", "ac-info-columns");
    for (const column of columns.slice(0, 14)) {
      const row = el("div", "ac-info-column");
      row.append(
        el("span", column.pk ? "ac-info-pk" : "ac-info-pk off", column.pk ? "🔑" : ""),
        el("span", "mono", column.name),
        el("span", "ac-info-type mono", column.type ?? ""),
      );
      list.append(row);
    }
    box.append(list);
    if (columns.length > 14) {
      box.append(el("div", "ac-info-more", t("외 {count}개 컬럼", { count: columns.length - 14 })));
    }
    const refersTo = [...new Set(relations.filter((relation) => relation.table === key).map((relation) => relation.refTable))];
    const referredBy = [...new Set(relations.filter((relation) => relation.refTable === key).map((relation) => relation.table))];
    if (refersTo.length > 0) {
      line(t("참조"), refersTo.join(", "));
    }
    if (referredBy.length > 0) {
      line(t("참조됨"), referredBy.join(", "));
    }
    return box;
  }
  if ((kind === "join" || kind === "condition") && option.relation !== undefined) {
    const relation = option.relation;
    title.textContent = kind === "join" ? `JOIN ${option.label}` : t("조인 조건");
    box.append(el("pre", "ac-info-code", option.apply ?? option.label));
    box.append(
      el(
        "div",
        "ac-info-note",
        option.guessed
          ? t("외래 키는 없고 이름으로 추정했습니다: {from} → {to}", {
              from: `${relation.table}.${relation.columns.join(", ")}`,
              to: `${relation.refTable}.${relation.refColumns.join(", ")}`,
            })
          : t("외래 키: {from} → {to}", {
              from: `${relation.table}.${relation.columns.join(", ")}`,
              to: `${relation.refTable}.${relation.refColumns.join(", ")}`,
            }),
      ),
    );
    return box;
  }
  if (kind === "function" && option.signature !== undefined) {
    title.textContent = option.label;
    box.append(el("pre", "ac-info-code", option.signature));
    if (option.about !== undefined) {
      box.append(el("div", "ac-info-note", t(option.about)));
    }
    return box;
  }
  if (kind === "snippet" && option.snippet !== undefined) {
    title.textContent = t("문장 채우기");
    box.append(el("pre", "ac-info-code", option.snippet.replace(/\$\{([^}]*)\}/g, "‹$1›")));
    box.append(el("div", "ac-info-note", t("Tab으로 다음 칸으로 이동합니다")));
    return box;
  }
  return null;
}

const editorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "var(--bg)",
      color: "var(--ink)",
      fontSize: "var(--editor-font-size, 12px)",
    },
    ".cm-sql-single": {
      color: "var(--syntax-string)",
    },
    ".cm-sql-double": {
      color: "var(--syntax-string-double, var(--syntax-string))",
    },
    ".cm-sql-backtick": {
      color: "var(--syntax-string-backtick, var(--syntax-string))",
    },
    "&.cm-focused": {
      outline: "none",
    },
    // The "other text" colour is the code's own; popups keep the ink.
    ".cm-content": {
      caretColor: "var(--accent)",
      color: "var(--syntax-text, var(--ink))",
      fontFamily: "var(--mono)",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--accent)",
    },
    ".cm-cursor": {
      transition: "left 45ms var(--ease-out, ease-out), top 45ms var(--ease-out, ease-out)",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "var(--accent-soft)",
    },
    "&.cm-focused .cm-selectionBackground": {
      backgroundColor: "var(--accent-line)",
    },
    ".cm-activeLine": {
      backgroundColor: "var(--hover-fill)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "var(--hover-fill)",
      color: "var(--muted)",
    },
    ".cm-gutters": {
      backgroundColor: "var(--bg)",
      color: "var(--faint)",
      borderRight: "1px solid var(--line)",
    },
    // Its bars are the app's own (see styles.css).
    ".cm-scroller": {
      lineHeight: "1.5",
    },
    ".cm-tooltip": {
      backgroundColor: "var(--panel)",
      border: "1px solid var(--line)",
    },
  },
  { dark: true },
);

const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--syntax-keyword)" },
  // Strings are coloured by their quote (quoteColors), not here.
  { tag: tags.number, color: "var(--syntax-number)" },
  { tag: tags.comment, color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: tags.variableName, color: "var(--syntax-variable)" },
  { tag: tags.typeName, color: "var(--syntax-type)" },
  { tag: tags.operator, color: "var(--syntax-operator)" },
  { tag: tags.bool, color: "var(--syntax-bool)" },
  { tag: tags.null, color: "var(--syntax-null)" },
  { tag: tags.punctuation, color: "var(--syntax-punctuation)" },
  { tag: tags.function(tags.variableName), color: "var(--syntax-function)" },
  { tag: tags.labelName, color: "var(--syntax-label)" },
]);

// Quoted text by its quote, as TablePlus colours 'single', "double" and
// `backtick` (or [bracket]) quoted text apart: the grammar tags strings and
// quoted names alike, so the quote decides.
const QUOTE_MARKS: Record<string, Decoration> = {
  "'": Decoration.mark({ class: "cm-sql-single" }),
  '"': Decoration.mark({ class: "cm-sql-double" }),
  "`": Decoration.mark({ class: "cm-sql-backtick" }),
  "[": Decoration.mark({ class: "cm-sql-backtick" }),
};
const QUOTED_NODES = new Set(["String", "QuotedIdentifier", "Bytes"]);

function quoteDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let last = -1;
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (!QUOTED_NODES.has(node.name) || node.from < last) {
          return;
        }
        // A prefix may come first: N'…', E'…', x'…'.
        const head = view.state.doc.sliceString(node.from, Math.min(node.to, node.from + 3));
        const quote = [...head].find((char) => char in QUOTE_MARKS) ?? "'";
        builder.add(node.from, node.to, QUOTE_MARKS[quote]);
        last = node.to;
      },
    });
  }
  return builder.finish();
}

const quoteColors = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = quoteDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = quoteDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// A server error's spot: a wavy underline, its line tinted, a mark in the gutter.
const setErrorMark = StateEffect.define<{ from: number; to: number } | null>();
const errorRangeMark = Decoration.mark({ class: "cm-sql-error" });
const errorLineMark = Decoration.line({ class: "cm-sql-error-line" });
const errorGutterMark = new (class extends GutterMarker {
  elementClass = "cm-sql-error-gutter";
})();
const errorMarkField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(range, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setErrorMark)) {
        return effect.value;
      }
    }
    // The text the error was about is gone.
    return tr.docChanged ? null : range;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (range) =>
      range === null
        ? Decoration.none
        : Decoration.set([errorLineMark.range(range.from), errorRangeMark.range(range.from, range.to)], true),
    ),
    gutterLineClass.from(field, (range) => (range === null ? RangeSet.empty : RangeSet.of([errorGutterMark.range(range.from)]))),
  ],
});

// Where a server position falls in the text when the statement starts at
// `start`: PostgreSQL counts characters from 1, MySQL and SQL Server lines
// (and maybe columns) from 1.
function errorRange(
  state: EditorState,
  start: number,
  statement: string,
  position: NonNullable<AppError["position"]>,
): { from: number; to: number } | null {
  let from: number;
  if (position.offset !== undefined) {
    if (position.offset < 1 || position.offset > statement.length + 1) {
      return null;
    }
    from = start + position.offset - 1;
  } else if (position.line !== undefined) {
    const number = state.doc.lineAt(start).number + position.line - 1;
    if (position.line < 1 || number > state.doc.lines) {
      return null;
    }
    const line = state.doc.line(number);
    const lineStart = position.line === 1 ? start : line.from;
    if (position.column === undefined) {
      return { from: lineStart, to: Math.max(lineStart + 1, line.to) };
    }
    from = Math.min(line.to, lineStart + Math.max(0, position.column - 1));
  } else {
    return null;
  }
  from = Math.min(from, state.doc.length);
  // The word there, or one character.
  const rest = state.sliceDoc(from, Math.min(state.doc.length, from + 200));
  const word = /^[\p{L}\p{N}_$"`.[\]]+/u.exec(rest)?.[0].length ?? 1;
  return { from, to: Math.min(state.doc.length, from + Math.max(1, word)) };
}

// How the editor looks, shared with its Settings preview.
const editorLook = [editorTheme, syntaxHighlighting(highlightStyle), quoteColors, EditorView.lineWrapping];

// The editor as Settings shows it: the same setup and look over a fixed
// sample, read-only, so the preview can't drift from the real thing.
// Its font and size follow the settings through --mono and --editor-font-size.
export function SqlPreview({ doc }: { doc: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        extensions: [
          basicSetup,
          new LanguageSupport(dialectFor(undefined).language),
          ...editorLook,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
        ],
      }),
    });
    const remeasure = () => view.requestMeasure();
    document.fonts.addEventListener("loadingdone", remeasure);
    return () => {
      document.fonts.removeEventListener("loadingdone", remeasure);
      view.destroy();
    };
  }, [doc]);

  return <div ref={hostRef} className="sql-preview" />;
}

export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(
  function SqlEditor(
    {
      tabId,
      tabIds,
      initialSql,
      readOnly,
      onRun,
      onSqlChange,
      schema,
      relations,
      loadValues,
      favorites,
      runKey,
      dialect,
    },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const dialectRef = useRef(dialect);
    dialectRef.current = dialect;
    const viewRef = useRef<EditorView | null>(null);
    const statesRef = useRef(new Map<string, EditorState>());
    const aliveRef = useRef(new Set(tabIds));
    const currentTabRef = useRef<string | null>(null);
    const initialSqlRef = useRef(initialSql);
    const readOnlyRef = useRef(readOnly ?? false);
    const onRunRef = useRef(onRun);
    const onSqlChangeRef = useRef(onSqlChange);
    const favoritesRef = useRef(favorites);
    const schemaRef = useRef(schema);
    const relationsRef = useRef(relations ?? []);
    const loadValuesRef = useRef(loadValues);
    const runKeyRef = useRef(runKey === undefined ? "Mod-Enter" : runKey);
    const pendingRef = useRef<{ tabId: string; sql: string; timer: number } | null>(null);
    const [languageCompartment] = useState(() => new Compartment());

    onRunRef.current = onRun;
    onSqlChangeRef.current = onSqlChange;
    initialSqlRef.current = initialSql;
    readOnlyRef.current = readOnly ?? false;
    favoritesRef.current = favorites;
    schemaRef.current = schema;
    relationsRef.current = relations ?? [];
    loadValuesRef.current = loadValues;
    runKeyRef.current = runKey === undefined ? "Mod-Enter" : runKey;

    function flushPending(): void {
      const pending = pendingRef.current;
      if (pending === null) {
        return;
      }
      pendingRef.current = null;
      window.clearTimeout(pending.timer);
      onSqlChangeRef.current(pending.tabId, pending.sql);
    }

    function queueChange(tabId: string, sql: string): void {
      const pending = pendingRef.current;
      if (pending !== null && pending.tabId !== tabId) {
        flushPending();
      }
      const timer = window.setTimeout(flushPending, 320);
      if (pending !== null && pending.tabId === tabId) {
        window.clearTimeout(pending.timer);
        pending.sql = sql;
        pending.timer = timer;
        return;
      }
      pendingRef.current = { tabId, sql, timer };
    }

    function cancelPending(): void {
      const pending = pendingRef.current;
      if (pending === null) {
        return;
      }
      window.clearTimeout(pending.timer);
      pendingRef.current = null;
    }

    // Columns, tables, joins, functions and keywords by where the cursor is
    // (see sqlComplete), after the saved queries whose keyword starts with
    // what was typed; inside a string compared with a column, its values.
    function sqlCompletion(context: CompletionContext): CompletionResult | Promise<CompletionResult | null> | null {
      const { state, pos } = context;
      const dialect = dialectFor(dialectRef.current);
      const start = pos > COMPLETION_WINDOW ? state.doc.lineAt(pos - COMPLETION_WINDOW).from : 0;
      const end =
        state.doc.length - pos > COMPLETION_WINDOW ? state.doc.lineAt(pos + COMPLETION_WINDOW).to : state.doc.length;
      const text = state.sliceDoc(start, end);
      const config = {
        schema: schemaRef.current,
        relations: relationsRef.current,
        words: wordsOf(dialect),
        usage: (key: string) => usageMap().get(key) ?? 0,
        dialect: dialectRef.current,
        identifierQuotes: dialect.spec.identifierQuotes ?? '"',
        caseInsensitiveIdentifiers: dialect.spec.caseInsensitiveIdentifiers,
        explicit: context.explicit,
      };
      const loadValues = loadValuesRef.current;
      const slot = loadValues === undefined ? null : valueSlotAt(text, pos - start, config);
      if (slot !== null && loadValues !== undefined) {
        return loadValues(slot.table, slot.column).then((values) => {
          const wanted = slot.typed.toLowerCase();
          const options: TpCompletion[] = (values ?? [])
            .filter((value) => value.toLowerCase().includes(wanted))
            // Those starting with the text first, each group in the column's own order.
            .sort((a, b) => Number(!a.toLowerCase().startsWith(wanted)) - Number(!b.toLowerCase().startsWith(wanted)))
            .map((value) => ({
              label: value,
              detail: slot.column,
              apply: value.replaceAll(slot.quote, slot.quote + slot.quote) + (slot.closed ? "" : slot.quote),
              tp: { kind: "value", usageKey: `value:${slot.table}.${slot.column}=${value}` },
            }));
          return options.length === 0 ? null : { from: start + slot.from, to: start + slot.to, options, filter: false };
        });
      }
      const found = completeSql(text, pos - start, config);
      if (found === null) {
        return null;
      }
      const typed = found.typed.toLowerCase();
      const favorites: TpCompletion[] = found.bare
        ? favoritesRef.current
            .filter((favorite) => favorite.keyword.toLowerCase().startsWith(typed))
            .map((favorite) => ({
              label: favorite.keyword,
              detail: favorite.name,
              apply: favorite.sql,
              tp: { kind: "saved", saved: favorite, usageKey: `saved:${favorite.keyword}` },
            }))
        : [];
      const info = (completion: Completion): HTMLElement | null =>
        completionInfo(completion as TpCompletion, schemaRef.current, relationsRef.current);
      const options: TpCompletion[] = [
        ...favorites.map((favorite) => ({ ...favorite, info })),
        ...found.options.map((option) => ({
          label: option.label,
          ...(option.detail !== undefined ? { detail: option.detail } : {}),
          ...(option.snippet !== undefined
            ? { apply: snippet(option.snippet) }
            : option.apply !== undefined
              ? { apply: option.apply }
              : {}),
          info,
          tp: { kind: option.kind, option, usageKey: option.usageKey },
        })),
      ];
      if (options.length === 0) {
        return null;
      }
      return {
        from: start + found.from,
        to: start + found.to,
        options,
        // Already matched and ranked; CodeMirror's fuzzy filter would bring
        // back keywords that merely contain the text.
        filter: false,
        getMatch: (completion) => {
          const option = (completion as TpCompletion).tp.option;
          if (option !== undefined) {
            return option.matched;
          }
          const at = completion.label.toLowerCase().indexOf(typed);
          return typed === "" || at < 0 ? [] : [at, at + typed.length];
        },
        // Each keystroke ranks the list anew.
        update: (_current, _from, _to, next) => {
          const again = sqlCompletion(next);
          return again instanceof Promise ? null : again;
        },
      };
    }

    // Schema and saved queries are read when completing, so only a new
    // dialect needs the language reconfigured.
    function sqlLanguage(sqlDialect: SqlDialect | undefined): LanguageSupport {
      const dialect = dialectFor(sqlDialect);
      return new LanguageSupport(dialect.language, dialect.language.data.of({ autocomplete: sqlCompletion }));
    }

    function makeState(doc: string): EditorState {
      return EditorState.create({
        doc,
        extensions: [
          Prec.highest(
            keymap.of([
              ...(runKeyRef.current === null
                ? []
                : [
                    {
                      key: runKeyRef.current,
                      run: () => {
                        onRunRef.current();
                        return true;
                      },
                    },
                  ]),
              {
                key: "Mod-d",
                run: selectNextOccurrence,
              },
              // Tab takes the highlighted completion, as Return does.
              {
                key: "Tab",
                run: acceptCompletion,
              },
            ]),
          ),
          basicSetup,
          autocompletion({
            icons: false,
            maxRenderedOptions: 80,
            optionClass: (completion) => `ac-option ac-${(completion as TpCompletion).tp?.kind ?? "keyword"}`,
            addToOptions: [
              {
                position: 20,
                render: (completion) => {
                  const kind = (completion as TpCompletion).tp?.kind ?? "keyword";
                  const badge = el("span", `ac-badge ac-${kind}`, BADGES[kind].mark);
                  badge.title = t(BADGES[kind].title);
                  return badge;
                },
              },
            ],
          }),
          languageCompartment.of(sqlLanguage(dialectRef.current)),
          errorMarkField,
          ...editorLook,
          EditorView.contentAttributes.of({
            spellcheck: "false",
            autocorrect: "off",
            autocapitalize: "off",
          }),
          EditorView.domEventHandlers({
            blur: () => {
              flushPending();
            },
          }),
          ...(readOnlyRef.current
            ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
            : []),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const id = currentTabRef.current;
              if (id !== null) {
                queueChange(id, update.state.doc.toString());
              }
            }
            for (const transaction of update.transactions) {
              const picked = transaction.annotation(pickedCompletion) as TpCompletion | undefined;
              if (picked?.tp?.usageKey !== undefined) {
                recordUsage(picked.tp.usageKey);
              }
            }
          }),
        ],
      });
    }

    useEffect(() => {
      const host = hostRef.current;
      if (!host) {
        return;
      }
      const view = new EditorView({ parent: host, state: makeState("") });
      viewRef.current = view;
      // The app's bars, kept in view as Settings asks.
      const bars = scrollbarsFor(view.scrollDOM, true);
      bars.watch(view.contentDOM);
      // A face picked in Settings loads after the editor measured its lines
      // and letters in the fallback.
      const remeasure = () => view.requestMeasure();
      document.fonts.addEventListener("loadingdone", remeasure);
      return () => {
        document.fonts.removeEventListener("loadingdone", remeasure);
        bars.destroy();
        flushPending();
        viewRef.current = null;
        view.destroy();
      };
    }, []);

    const idsKey = tabIds.join("\u0000");

    useEffect(() => {
      const alive = new Set(tabIds);
      aliveRef.current = alive;
      for (const key of Array.from(statesRef.current.keys())) {
        if (!alive.has(key)) {
          statesRef.current.delete(key);
        }
      }
    }, [idsKey]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) {
        return;
      }
      flushPending();
      const previous = currentTabRef.current;
      if (previous !== null && previous !== tabId && aliveRef.current.has(previous)) {
        statesRef.current.set(previous, view.state);
      }
      currentTabRef.current = tabId;
      let next = statesRef.current.get(tabId);
      if (!next) {
        next = makeState(initialSqlRef.current);
        statesRef.current.set(tabId, next);
      }
      view.setState(next);
    }, [tabId]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    const extension = sqlLanguage(dialect);
    for (const [key, state] of statesRef.current) {
      statesRef.current.set(
        key,
        state.update({ effects: languageCompartment.reconfigure(extension) }).state,
      );
    }
    view.dispatch({ effects: languageCompartment.reconfigure(extension) });
  }, [languageCompartment, dialect]);

  useImperativeHandle(
    ref,
    () => ({
      getSql(): string {
        const view = viewRef.current;
        if (!view) {
          return "";
        }
        const range = view.state.selection.main;
        return range.empty
          ? view.state.doc.toString()
          : view.state.sliceDoc(range.from, range.to);
      },
      currentStatement(): string | null {
        const view = viewRef.current;
        if (!view) {
          return null;
        }
        const range = view.state.selection.main;
        if (!range.empty) {
          return view.state.sliceDoc(range.from, range.to);
        }
        return statementAt(view.state.doc.toString(), range.head, dialectRef.current)?.text ?? null;
      },
      getDoc(): string {
        const view = viewRef.current;
        return view ? view.state.doc.toString() : "";
      },
        setSql(text: string): void {
          const view = viewRef.current;
          if (!view) {
            return;
          }
          cancelPending();
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: text },
          });
        },
        format(rewrite: (sql: string) => string): void {
          const view = viewRef.current;
          if (!view) {
            return;
          }
          cancelPending();
          const range = view.state.selection.main;
          const from = range.empty ? 0 : range.from;
          const to = range.empty ? view.state.doc.length : range.to;
          const before = view.state.sliceDoc(from, to);
          const after = rewrite(before);
          if (after === before) {
            return;
          }
          view.dispatch({
            changes: { from, to, insert: after },
            selection: range.empty
              ? { anchor: from + sameSpot(before, range.head - from, after) }
              : { anchor: from, head: from + after.length },
            // Undone on its own, not with typing just before or after it.
            annotations: isolateHistory.of("full"),
            userEvent: "input.format",
            scrollIntoView: true,
          });
        },
        insertText(text: string): void {
          const view = viewRef.current;
          if (!view) {
            return;
          }
          view.dispatch(view.state.replaceSelection(text));
          view.focus();
        },
        forget(tabId: string): void {
          if (tabId !== currentTabRef.current) {
            statesRef.current.delete(tabId);
          }
        },
        focus(): void {
          viewRef.current?.focus();
        },
        flush(): void {
          flushPending();
        },
        markError(failure): { line: number; column: number } | null {
          const view = viewRef.current;
          if (!view) {
            return null;
          }
          const { state } = view;
          let range: { from: number; to: number } | null = null;
          if (failure !== null && failure.position !== undefined && failure.statement !== "") {
            // The statement's copy the cursor is in (Run Current), else the first.
            const doc = state.doc.toString();
            const head = state.selection.main.head;
            let start = doc.indexOf(failure.statement);
            for (let at = start; at >= 0; at = doc.indexOf(failure.statement, at + 1)) {
              if (head >= at && head <= at + failure.statement.length) {
                start = at;
                break;
              }
            }
            range = start < 0 ? null : errorRange(state, start, failure.statement, failure.position);
          }
          view.dispatch({
            effects:
              range === null
                ? setErrorMark.of(null)
                : [setErrorMark.of(range), EditorView.scrollIntoView(range.from, { y: "nearest" })],
          });
          if (range === null) {
            return null;
          }
          const line = state.doc.lineAt(range.from);
          return { line: line.number, column: range.from - line.from + 1 };
        },
        revealError(): void {
          const view = viewRef.current;
          const range = view?.state.field(errorMarkField, false) ?? null;
          if (!view || range === null) {
            return;
          }
          view.dispatch({ selection: { anchor: range.from, head: range.to }, scrollIntoView: true });
          view.focus();
        },
      }),
      [],
    );

    return <div ref={hostRef} className="sql-editor" />;
  },
);
