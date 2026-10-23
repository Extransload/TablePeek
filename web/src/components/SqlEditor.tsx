import { basicSetup } from "codemirror";
import { SQLite, sql } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { isolateHistory } from "@codemirror/commands";
import { selectNextOccurrence } from "@codemirror/search";
import { tags } from "@lezer/highlight";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
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
    const [schemaCompartment] = useState(() => new Compartment());

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

    function favoriteCompletion(context: CompletionContext): CompletionResult | null {
      const word = context.matchBefore(/[A-Za-z_][A-Za-z0-9_]*$/);
      if (word === null || (word.from === word.to && !context.explicit)) {
        return null;
      }
      const typed = word.text.toLowerCase();
      const options = favoritesRef.current
        .filter((favorite) => favorite.keyword.toLowerCase().startsWith(typed))
        .map((favorite) => ({
          label: favorite.keyword,
          detail: favorite.name,
          info: favorite.sql,
          apply: favorite.sql,
          type: "keyword",
        }));
      if (options.length === 0) {
        return null;
      }
      return { from: word.from, options };
    }

    function makeState(doc: string): EditorState {
      const support = sql({ dialect: SQLite, schema: schemaRef.current });
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
          schemaCompartment.of([
            support,
            support.language.data.of({
              autocomplete: (context: CompletionContext) => favoriteCompletion(context),
            }),
          ]),
          editorTheme,
          syntaxHighlighting(highlightStyle),
          EditorView.lineWrapping,
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
      return () => {
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
    const support = sql({ dialect: SQLite, schema });
    const extension = [
      support,
      support.language.data.of({
        autocomplete: (context: CompletionContext) => favoriteCompletion(context),
      }),
    ];
    for (const [key, state] of statesRef.current) {
      statesRef.current.set(
        key,
        state.update({ effects: schemaCompartment.reconfigure(extension) }).state,
      );
    }
    view.dispatch({ effects: schemaCompartment.reconfigure(extension) });
  }, [schemaCompartment, schema]);

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
