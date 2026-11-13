// A Redis value as code: CodeMirror with line numbers, search (⌘F) and the
// app's syntax colours, read-only or as the value's editor. JSON is coloured
// by the data grid's kinds (jsonIndex's tokens, the --type-* inks Quick Look
// uses), XML by the editor's syntax colours; a JSON error is underlined.

import { basicSetup } from "codemirror";
import { Compartment, EditorState, Prec, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { jsonSpans } from "../../../jsonIndex";

export type CodeLang = "json" | "xml" | "plain";

interface CodeTextProps {
  value: string;
  lang: CodeLang;
  wrap: boolean;
  editable?: boolean;
  onChange?(text: string): void;
  // ⌘S / ⌘↩ and Esc while editing.
  onSave?(): void;
  onCancel?(): void;
  // A character offset to underline (a JSON error).
  errorAt?: number | null;
  autoFocus?: boolean;
  label: string;
}

// Past this the text is shown plain: a mark per token costs more than it shows.
const COLOUR_MAX = 1_000_000;

const theme = EditorView.theme({
  // The pane's own background shows through (a background picture too).
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--ink)", fontSize: "calc(12px * var(--ui-scale, 1))" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { lineHeight: "1.55", fontFamily: "var(--mono)" },
  ".cm-content": { caretColor: "var(--accent)", color: "var(--syntax-text, var(--ink))", fontFamily: "var(--mono)", padding: "8px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "var(--accent-soft)" },
  "&.cm-focused .cm-selectionBackground": { backgroundColor: "var(--accent-line)" },
  ".cm-activeLine": { backgroundColor: "var(--hover-fill)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--hover-fill)", color: "var(--muted)" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--faint)", borderRight: "1px solid var(--line-soft)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--hover-fill)", border: "0", color: "var(--muted)" },
  ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--ink)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line-soft)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--warn) 30%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--warn) 55%, transparent)" },
  ".cm-tooltip": { backgroundColor: "var(--panel)", border: "1px solid var(--line)" },
});

const marks = new Map<string, Decoration>();
function mark(cls: string): Decoration {
  let found = marks.get(cls);
  if (found === undefined) {
    found = Decoration.mark({ class: cls });
    marks.set(cls, found);
  }
  return found;
}

// XML: comments, CDATA, tags with their attributes, entities.
const XML_TOKEN = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<[?!/]?[A-Za-z_:][^>]*>?|&[#\w]+;/g;
const XML_ATTR = /([A-Za-z_:][-\w.:]*)(\s*=\s*)("[^"]*"?|'[^']*'?)?/g;

function xmlDecorations(text: string, builder: RangeSetBuilder<Decoration>): void {
  for (const found of text.matchAll(XML_TOKEN)) {
    const from = found.index;
    const token = found[0];
    if (token.startsWith("<!--") || token.startsWith("<![CDATA[")) {
      builder.add(from, from + token.length, mark("cm-kv-comment"));
      continue;
    }
    if (token.startsWith("&")) {
      builder.add(from, from + token.length, mark("cm-kv-entity"));
      continue;
    }
    const name = /^<[?!/]?[A-Za-z_:][-\w.:]*/.exec(token)?.[0] ?? "<";
    builder.add(from, from + name.length, mark("cm-kv-tag"));
    const rest = token.slice(name.length);
    for (const attr of rest.matchAll(XML_ATTR)) {
      const at = from + name.length + attr.index;
      builder.add(at, at + attr[1].length, mark("cm-kv-attr"));
      if (attr[3] !== undefined) {
        const valueAt = at + attr[1].length + attr[2].length;
        builder.add(valueAt, valueAt + attr[3].length, mark("jv-string"));
      }
    }
    const close = /\/?\??>$/.exec(token);
    if (close !== null) {
      builder.add(from + token.length - close[0].length, from + token.length, mark("cm-kv-tag"));
    }
  }
}

function colours(lang: CodeLang) {
  const build = (view: EditorView): DecorationSet => {
    const doc = view.state.doc;
    if (lang === "plain" || doc.length > COLOUR_MAX) {
      return Decoration.none;
    }
    const builder = new RangeSetBuilder<Decoration>();
    const text = doc.toString();
    if (lang === "json") {
      for (const span of jsonSpans(text)) {
        builder.add(span.from, span.to, mark(`jv-${span.ink}`));
      }
    } else {
      xmlDecorations(text, builder);
    }
    return builder.finish();
  };
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged) {
          this.decorations = build(update.view);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

// The character an error is at (the last one when it is at the end).
const setError = StateEffect.define<number | null>();
const errorMark = Decoration.mark({ class: "cm-kv-error" });
const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setError)) {
        const length = tr.state.doc.length;
        if (effect.value === null || length === 0) {
          return Decoration.none;
        }
        const from = Math.min(effect.value, length - 1);
        return Decoration.set([errorMark.range(from, from + 1)]);
      }
    }
    return marks.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function CodeText({ value, lang, wrap, editable = false, onChange, onSave, onCancel, errorAt = null, autoFocus, label }: CodeTextProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const wrapRef = useRef(new Compartment());
  const propsRef = useRef({ onChange, onSave, onCancel });
  propsRef.current = { onChange, onSave, onCancel };

  // A new editor for a new language or mode; the text follows `value` below.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }
    const keys = Prec.highest(
      keymap.of([
        {
          key: "Escape",
          run: () => {
            propsRef.current.onCancel?.();
            return propsRef.current.onCancel !== undefined;
          },
        },
      ]),
    );
    // ⌘S and ⌘↩ save. The app takes both in the window's capture phase
    // (apply changes, run) before the editor sees them, so they are
    // listened for there too, for this editor only.
    const onSaveKey = (event: KeyboardEvent) => {
      const saveKey = (event.metaKey || event.ctrlKey) && !event.altKey && (event.key.toLowerCase() === "s" || event.key === "Enter");
      if (saveKey && propsRef.current.onSave !== undefined && event.target instanceof Node && host.contains(event.target)) {
        event.preventDefault();
        propsRef.current.onSave();
      }
    };
    window.addEventListener("keydown", onSaveKey, true);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          keys,
          basicSetup,
          theme,
          colours(lang),
          errorField,
          wrapRef.current.of(wrap ? EditorView.lineWrapping : []),
          EditorState.readOnly.of(!editable),
          EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off", "aria-label": label }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              propsRef.current.onChange?.(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    if (autoFocus === true) {
      view.focus();
    }
    const remeasure = () => view.requestMeasure();
    document.fonts.addEventListener("loadingdone", remeasure);
    return () => {
      window.removeEventListener("keydown", onSaveKey, true);
      document.fonts.removeEventListener("loadingdone", remeasure);
      viewRef.current = null;
      view.destroy();
    };
    // `value` is applied by the effect below; a remount would lose the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, editable, label]);

  useEffect(() => {
    const view = viewRef.current;
    if (view !== null && view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: wrapRef.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);

  useEffect(() => {
    const view = viewRef.current;
    if (view !== null) {
      view.dispatch({ effects: setError.of(errorAt) });
    }
  }, [errorAt, value]);

  return <div ref={hostRef} className={`kv-code${editable ? " editing" : ""}`} />;
}
