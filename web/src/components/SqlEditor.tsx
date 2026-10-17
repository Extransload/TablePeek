import { basicSetup } from "codemirror";
import { SQLite, sql } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { palette } from "../palette";

export interface SqlEditorHandle {
  getSql(): string;
  getDoc(): string;
  setSql(text: string): void;
  focus(): void;
}

interface SqlEditorProps {
  tabId: string;
  tabIds: string[];
  initialSql: string;
  readOnly?: boolean;
  onRun: () => void;
  onSqlChange(tabId: string, sql: string): void;
  tables: string[];
}

function buildSchema(tables: string[]): Record<string, string[]> {
  return Object.fromEntries(tables.map((table): [string, string[]] => [table, []]));
}

const editorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: palette.bg,
      color: palette.ink,
      fontSize: "12px",
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-content": {
      caretColor: palette.accent,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: palette.accent,
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: palette.selFill,
    },
    "&.cm-focused .cm-selectionBackground": {
      backgroundColor: palette.selFillFocus,
    },
    ".cm-activeLine": {
      backgroundColor: palette.hoverFill,
    },
    ".cm-activeLineGutter": {
      backgroundColor: palette.hoverFill,
      color: palette.muted,
    },
    ".cm-gutters": {
      backgroundColor: palette.bg,
      color: palette.faint,
      borderRight: `1px solid ${palette.line}`,
    },
    ".cm-scroller": {
      scrollbarColor: `${palette.line} ${palette.bg}`,
      lineHeight: "1.5",
    },
    ".cm-tooltip": {
      backgroundColor: palette.panel,
      border: `1px solid ${palette.line}`,
    },
  },
  { dark: true },
);

const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: palette.accent },
  { tag: tags.string, color: palette.ok },
  { tag: tags.number, color: palette.warn },
  { tag: tags.comment, color: palette.faint, fontStyle: "italic" },
  { tag: tags.variableName, color: palette.ink },
  { tag: tags.typeName, color: palette.muted },
  { tag: tags.operator, color: palette.muted },
  { tag: [tags.bool, tags.null], color: palette.error },
  { tag: tags.punctuation, color: palette.muted },
]);

export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(
  function SqlEditor({ tabId, tabIds, initialSql, readOnly, onRun, onSqlChange, tables }, ref) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const statesRef = useRef(new Map<string, EditorState>());
    const aliveRef = useRef(new Set(tabIds));
    const currentTabRef = useRef<string | null>(null);
    const initialSqlRef = useRef(initialSql);
    const readOnlyRef = useRef(readOnly ?? false);
    const onRunRef = useRef(onRun);
    const onSqlChangeRef = useRef(onSqlChange);
    const [schemaCompartment] = useState(() => new Compartment());

    onRunRef.current = onRun;
    onSqlChangeRef.current = onSqlChange;
    initialSqlRef.current = initialSql;
    readOnlyRef.current = readOnly ?? false;

    function makeState(doc: string): EditorState {
      return EditorState.create({
        doc,
        extensions: [
          Prec.highest(
            keymap.of([
              {
                key: "Mod-Enter",
                run: () => {
                  onRunRef.current();
                  return true;
                },
              },
              {
                key: "Shift-Enter",
                run: () => {
                  onRunRef.current();
                  return true;
                },
              },
            ]),
          ),
          basicSetup,
          schemaCompartment.of(sql({ dialect: SQLite, schema: {} })),
          editorTheme,
          syntaxHighlighting(highlightStyle),
          ...(readOnlyRef.current
            ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
            : []),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const id = currentTabRef.current;
              if (id !== null) {
                onSqlChangeRef.current(id, update.state.doc.toString());
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
    view.dispatch({
      effects: schemaCompartment.reconfigure(
        sql({ dialect: SQLite, schema: buildSchema(tables) }),
      ),
    });
  }, [schemaCompartment, tables]);

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
      getDoc(): string {
        const view = viewRef.current;
        return view ? view.state.doc.toString() : "";
      },
        setSql(text: string): void {
          const view = viewRef.current;
          if (!view) {
            return;
          }
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: text },
          });
        },
        focus(): void {
          viewRef.current?.focus();
        },
      }),
      [],
    );

    return <div ref={hostRef} className="sql-editor" />;
  },
);
