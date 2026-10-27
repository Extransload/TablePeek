import { basicSetup } from "codemirror";
import {
  MSSQL,
  MariaSQL,
  MySQL,
  PostgreSQL,
  SQLite,
  keywordCompletionSource,
  type SQLDialect,
} from "@codemirror/lang-sql";
import { HighlightStyle, LanguageSupport, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { isolateHistory } from "@codemirror/commands";
import { selectNextOccurrence } from "@codemirror/search";
import { tags } from "@lezer/highlight";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { completeSql, type SqlWord } from "../sqlComplete";
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
}

interface SqlEditorProps {
  tabId: string;
  tabIds: string[];
  initialSql: string;
  readOnly?: boolean;
  onRun: () => void;
  onSqlChange(tabId: string, sql: string): void;
  schema: Record<string, string[]>;
  favorites: FavoriteSnippet[];
  // CodeMirror key for onRun; null leaves running to the app's shortcuts.
  runKey?: string | null;
  // The engine's SQL, which decides where a statement ends (see sqlSplit).
  dialect?: string;
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

// The connection's SQL, for highlighting and completion; any other kind (or
// no connection) keeps SQLite's.
const DIALECTS: Record<string, SQLDialect> = {
  sqlite: SQLite,
  postgres: PostgreSQL,
  cockroach: PostgreSQL,
  mysql: MySQL,
  mariadb: MariaSQL,
  mssql: MSSQL,
};

function dialectFor(kind: string | undefined): SQLDialect {
  return DIALECTS[kind ?? ""] ?? SQLite;
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

const editorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "var(--bg)",
      color: "var(--ink)",
      fontSize: "var(--editor-font-size, 12px)",
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-content": {
      caretColor: "var(--accent)",
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
    ".cm-scroller": {
      scrollbarColor: "var(--line) var(--bg)",
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
  { tag: [tags.string, tags.special(tags.string)], color: "var(--syntax-string)" },
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

// How the editor looks, shared with its Settings preview.
const editorLook = [editorTheme, syntaxHighlighting(highlightStyle), EditorView.lineWrapping];

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
    { tabId, tabIds, initialSql, readOnly, onRun, onSqlChange, schema, favorites, runKey, dialect },
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
    const runKeyRef = useRef(runKey === undefined ? "Mod-Enter" : runKey);
    const pendingRef = useRef<{ tabId: string; sql: string; timer: number } | null>(null);
    const [languageCompartment] = useState(() => new Compartment());

    onRunRef.current = onRun;
    onSqlChangeRef.current = onSqlChange;
    initialSqlRef.current = initialSql;
    readOnlyRef.current = readOnly ?? false;
    favoritesRef.current = favorites;
    schemaRef.current = schema;
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

    // Columns, tables and keywords by where the cursor is (see sqlComplete),
    // after the saved queries whose keyword starts with what was typed.
    function sqlCompletion(context: CompletionContext): CompletionResult | null {
      const { state, pos } = context;
      const dialect = dialectFor(dialectRef.current);
      const start = pos > COMPLETION_WINDOW ? state.doc.lineAt(pos - COMPLETION_WINDOW).from : 0;
      const end =
        state.doc.length - pos > COMPLETION_WINDOW ? state.doc.lineAt(pos + COMPLETION_WINDOW).to : state.doc.length;
      const found = completeSql(state.sliceDoc(start, end), pos - start, {
        schema: schemaRef.current,
        words: wordsOf(dialect),
        dialect: dialectRef.current,
        identifierQuotes: dialect.spec.identifierQuotes ?? '"',
        caseInsensitiveIdentifiers: dialect.spec.caseInsensitiveIdentifiers,
        explicit: context.explicit,
      });
      if (found === null) {
        return null;
      }
      const typed = found.typed.toLowerCase();
      const favorites: Completion[] = found.bare
        ? favoritesRef.current
            .filter((favorite) => favorite.keyword.toLowerCase().startsWith(typed))
            .map((favorite) => ({
              label: favorite.keyword,
              detail: favorite.name,
              info: favorite.sql,
              apply: favorite.sql,
              type: "keyword",
            }))
        : [];
      const options = [...favorites, ...found.options];
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
          const at = completion.label.toLowerCase().indexOf(typed);
          return typed === "" || at < 0 ? [] : [at, at + typed.length];
        },
        // Each keystroke ranks the list anew.
        update: (_current, _from, _to, next) => sqlCompletion(next),
      };
    }

    // Schema and saved queries are read when completing, so only a new
    // dialect needs the language reconfigured.
    function sqlLanguage(kind: string | undefined): LanguageSupport {
      const dialect = dialectFor(kind);
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
            ]),
          ),
          basicSetup,
          languageCompartment.of(sqlLanguage(dialectRef.current)),
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
      // A face picked in Settings loads after the editor measured its lines
      // and letters in the fallback.
      const remeasure = () => view.requestMeasure();
      document.fonts.addEventListener("loadingdone", remeasure);
      return () => {
        document.fonts.removeEventListener("loadingdone", remeasure);
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
      }),
      [],
    );

    return <div ref={hostRef} className="sql-editor" />;
  },
);
