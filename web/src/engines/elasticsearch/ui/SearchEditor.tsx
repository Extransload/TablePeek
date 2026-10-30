// The code editor of the search workbench: the 문서 tab's Query DSL box,
// document editors, the analyze tester and the Dev Tools console. JSON
// colouring (or the caller's), completion from `dsl.ts`-style sources, an
// error range underlined, ⌘↩ to run. Styled like the MongoDB editors
// (`mg-cm`).

import { basicSetup } from "codemirror";
import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, closeCompletion, completionKeymap, completionStatus, pickedCompletion, startCompletion, type Completion, type CompletionContext as CMContext, type CompletionResult as CMResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { EditorState, Prec, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, drawSelection, keymap, placeholder as placeholderExt, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { t } from "../../../i18n";
import { tokenizeJson, type DslCompletion, type DslItem, type ItemKind } from "../dsl";

export interface SearchEditorHandle {
  view(): EditorView | null;
  focus(): void;
  text(): string;
  // The selection (or the caret as an empty range).
  selection(): { from: number; to: number };
  // Briefly marks a range (the request just run).
  flash(from: number, to: number): void;
  // Replaces the whole text (a template, a reformat).
  setText(text: string): void;
}

export interface Span {
  from: number;
  to: number;
  cls: string;
}

interface SearchEditorProps {
  value: string;
  onChange?(text: string): void;
  // ⌘↩, and Return in a one-line box (unless the completion list is open).
  onRun?(): void;
  onEscape?(): void;
  // Read at completion time, so it may change without reconfiguring.
  complete?(text: string, pos: number): DslCompletion | null;
  // Colouring; JSON by default.
  spans?(text: string): Span[];
  // Line-start marks (the console's request lines), as gutter-less classes.
  lineClass?(text: string): { line: number; cls: string }[];
  singleLine?: boolean;
  placeholder?: string;
  error?: { from: number; to: number } | null;
  autoFocus?: boolean;
  readOnly?: boolean;
  className?: string;
  ariaLabel?: string;
}

const BADGES: Record<ItemKind, { mark: string; cls: string; title: string }> = {
  field: { mark: "F", cls: "column", title: "필드" },
  keyword: { mark: "K", cls: "keyword", title: "키" },
  query: { mark: "Q", cls: "function", title: "쿼리" },
  agg: { mark: "Σ", cls: "function", title: "집계" },
  value: { mark: "v", cls: "value", title: "값" },
  path: { mark: "/", cls: "table", title: "경로" },
  param: { mark: "?", cls: "keyword", title: "매개변수" },
  method: { mark: "M", cls: "keyword", title: "메서드" },
  index: { mark: "I", cls: "table", title: "인덱스" },
};

// JSON colouring with the app's sx-* classes: keys, strings, numbers,
// booleans, null, punctuation, comments.
export function jsonSpans(src: string, offset = 0, end = src.length): Span[] {
  const toks = tokenizeJson(src, offset, end);
  const out: Span[] = [];
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    let cls: string;
    switch (tok.type) {
      case "str":
        cls = toks[i + 1]?.type === "punc" && toks[i + 1].text === ":" ? "sx-variable" : "sx-double";
        break;
      case "num":
        cls = "sx-number";
        break;
      case "word":
        cls = tok.text === "true" || tok.text === "false" ? "sx-bool" : tok.text === "null" ? "sx-null" : "sx-text";
        break;
      case "punc":
        cls = "sx-punctuation";
        break;
      case "comment":
        cls = "sx-comment";
        break;
      default:
        cls = "sx-text";
    }
    out.push({ from: tok.from, to: tok.to, cls });
  }
  return out;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

interface SearchCompletion extends Completion {
  item: DslItem;
}

// Replaces the typed word; inside a string also the closing quote typed
// ahead of the caret, since the insert brings its own.
function applyItem(item: DslItem, from: number, quoted: boolean) {
  return (view: EditorView, completion: Completion, _from: number, to: number) => {
    const doc = view.state.doc;
    const line = doc.lineAt(to);
    const after = doc.sliceString(to, line.to);
    let end = to + (/^[\w.@*-]*/.exec(after)?.[0].length ?? 0);
    if (quoted && doc.sliceString(end, end + 1) === '"') {
      end += 1;
    }
    const text = item.insert ?? item.label;
    view.dispatch({
      changes: { from, to: end, insert: text },
      selection: { anchor: from + text.length - (item.caretBack ?? 0) },
      annotations: pickedCompletion.of(completion),
      userEvent: "input.complete",
    });
    // A path segment or a key ending in a template opens the next list.
    if (/[/?&=]$/.test(text) || /: (?:""|\{ \}|\[ \])$/.test(text)) {
      window.setTimeout(() => startCompletion(view), 0);
    }
  };
}

const setError = StateEffect.define<{ from: number; to: number } | null>();
const errorMark = Decoration.mark({ class: "mg-cm-error" });
const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    let next = marks.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setError)) {
        const range = effect.value;
        const len = tr.state.doc.length;
        if (range === null || len === 0) {
          next = Decoration.none;
        } else {
          const from = Math.max(0, Math.min(range.from, len - 1));
          const to = Math.max(from + 1, Math.min(range.to, len));
          next = Decoration.set([errorMark.range(from, to)]);
        }
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const setFlash = StateEffect.define<{ from: number; to: number } | null>();
const flashMark = Decoration.mark({ class: "mg-cm-flash" });
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    let next = marks.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setFlash)) {
        const range = effect.value;
        next = range === null || range.to <= range.from ? Decoration.none : Decoration.set([flashMark.range(range.from, Math.min(range.to, tr.state.doc.length))]);
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// Colouring the whole text is cheap at body sizes; a bulk-sized text goes
// uncoloured rather than slow.
const COLOUR_LIMIT = 300_000;

const theme = EditorView.theme(
  {
    "&": { backgroundColor: "var(--bg)", color: "var(--ink)", fontSize: "var(--editor-font-size, 12px)" },
    "&.cm-focused": { outline: "none" },
    ".cm-content": { caretColor: "var(--accent)", color: "var(--syntax-text, var(--ink))", fontFamily: "var(--mono)" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "var(--accent-soft)" },
    "&.cm-focused .cm-selectionBackground": { backgroundColor: "var(--accent-line)" },
    ".cm-activeLine": { backgroundColor: "var(--hover-fill)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--hover-fill)", color: "var(--muted)" },
    ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--faint)", borderRight: "1px solid var(--line-soft)" },
    ".cm-scroller": { lineHeight: "1.5", fontFamily: "var(--mono)" },
    ".cm-tooltip": { backgroundColor: "var(--panel)", border: "1px solid var(--line)" },
    ".cm-placeholder": { color: "var(--faint)" },
  },
  { dark: true },
);

export const SearchEditor = forwardRef<SearchEditorHandle, SearchEditorProps>(function SearchEditor(props, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const { singleLine = false, readOnly = false } = propsRef.current;

    const source = (context: CMContext): CMResult | null => {
      const complete = propsRef.current.complete;
      if (complete === undefined) {
        return null;
      }
      const text = context.state.doc.toString();
      const result = complete(text, context.pos);
      if (result === null) {
        return null;
      }
      const typed = text.slice(result.from, context.pos);
      if (!context.explicit && typed === "" && !/[{,\[:"/?&=\s]$/.test(text.slice(0, context.pos))) {
        return null;
      }
      const options: SearchCompletion[] = result.items.map((item) => ({
        label: item.label,
        detail: item.detail,
        apply: applyItem(item, result.from, result.quoted),
        item,
      }));
      const prefix = typed.toLowerCase();
      return {
        from: result.from,
        to: context.pos,
        options,
        filter: false,
        getMatch: (completion) => {
          const at = completion.label.toLowerCase().indexOf(prefix);
          return prefix === "" || at < 0 ? [] : [at, at + prefix.length];
        },
      };
    };

    const colours = ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = this.build(view);
        }
        update(update: ViewUpdate) {
          if (update.docChanged) {
            this.decorations = this.build(update.view);
          }
        }
        build(view: EditorView): DecorationSet {
          const builder = new RangeSetBuilder<Decoration>();
          const text = view.state.doc.toString();
          if (text.length > COLOUR_LIMIT) {
            return builder.finish();
          }
          const lineMarks = propsRef.current.lineClass?.(text) ?? [];
          const spans = (propsRef.current.spans ?? jsonSpans)(text);
          // Line decorations and marks go in one sorted pass.
          const ranges: { from: number; to: number; deco: Decoration }[] = [];
          for (const mark of lineMarks) {
            if (mark.line >= 1 && mark.line <= view.state.doc.lines) {
              const at = view.state.doc.line(mark.line).from;
              ranges.push({ from: at, to: at, deco: Decoration.line({ class: mark.cls }) });
            }
          }
          for (const span of spans) {
            if (span.to > span.from) {
              ranges.push({ from: span.from, to: span.to, deco: Decoration.mark({ class: span.cls }) });
            }
          }
          ranges.sort((a, b) => a.from - b.from || (a.from === a.to ? -1 : 0) - (b.from === b.to ? -1 : 0));
          for (const range of ranges) {
            builder.add(range.from, range.to, range.deco);
          }
          return builder.finish();
        }
      },
      { decorations: (plugin) => plugin.decorations },
    );

    const runKeys = keymap.of([
      {
        key: "Mod-Enter",
        run: (view: EditorView) => {
          // Running leaves no completion list hanging over the result.
          closeCompletion(view);
          propsRef.current.onRun?.();
          return propsRef.current.onRun !== undefined;
        },
      },
      ...(singleLine
        ? [
            {
              key: "Enter",
              run: (view: EditorView) => {
                if (completionStatus(view.state) === "active") {
                  return false;
                }
                propsRef.current.onRun?.();
                return true;
              },
            },
          ]
        : []),
      {
        key: "Escape",
        run: (view: EditorView) => {
          if (completionStatus(view.state) !== null || propsRef.current.onEscape === undefined) {
            return false;
          }
          propsRef.current.onEscape();
          return true;
        },
      },
      { key: "Tab", run: acceptCompletion },
    ]);

    const completionExt = autocompletion({
      override: [source],
      icons: false,
      maxRenderedOptions: 80,
      optionClass: (completion) => `ac-option ac-${BADGES[(completion as SearchCompletion).item?.kind ?? "keyword"].cls}`,
      addToOptions: [
        {
          position: 20,
          render: (completion) => {
            const badge = BADGES[(completion as SearchCompletion).item?.kind ?? "keyword"];
            const node = el("span", `ac-badge ac-${badge.cls}`, badge.mark);
            node.title = t(badge.title);
            return node;
          },
        },
      ],
    });

    const extensions = [
      Prec.highest(runKeys),
      singleLine
        ? [
            history(),
            drawSelection(),
            closeBrackets(),
            bracketMatching(),
            keymap.of([...closeBracketsKeymap, ...completionKeymap, ...historyKeymap, ...defaultKeymap]),
            EditorState.transactionFilter.of((tr) =>
              tr.docChanged && tr.newDoc.lines > 1 ? [tr, { changes: { from: 0, to: tr.newDoc.length, insert: tr.newDoc.toString().replace(/\r?\n/g, " ") }, sequential: true }] : tr,
            ),
          ]
        : [basicSetup, EditorView.lineWrapping],
      completionExt,
      colours,
      errorField,
      flashField,
      theme,
      readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
      EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off", "aria-label": propsRef.current.ariaLabel ?? "" }),
      propsRef.current.placeholder ? placeholderExt(propsRef.current.placeholder) : [],
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          propsRef.current.onChange?.(update.state.doc.toString());
        }
      }),
    ];
    const view = new EditorView({ parent: host, state: EditorState.create({ doc: propsRef.current.value, extensions }) });
    viewRef.current = view;
    if (propsRef.current.autoFocus) {
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
    }
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, []);

  // A value set from outside (reset, history pick, a new reply) replaces the text.
  useEffect(() => {
    const view = viewRef.current;
    if (view && view.state.doc.toString() !== props.value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.value }, selection: { anchor: Math.min(view.state.selection.main.head, props.value.length) } });
    }
  }, [props.value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setError.of(props.error ?? null) });
  }, [props.error?.from, props.error?.to, props.error]);

  useImperativeHandle(
    ref,
    () => ({
      view: () => viewRef.current,
      focus: () => viewRef.current?.focus(),
      text: () => viewRef.current?.state.doc.toString() ?? "",
      selection: () => {
        const range = viewRef.current?.state.selection.main;
        return range ? { from: range.from, to: range.to } : { from: 0, to: 0 };
      },
      flash: (from, to) => {
        const view = viewRef.current;
        if (!view) {
          return;
        }
        view.dispatch({ effects: setFlash.of({ from, to }) });
        window.setTimeout(() => viewRef.current?.dispatch({ effects: setFlash.of(null) }), 700);
      },
      setText: (text) => {
        const view = viewRef.current;
        view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: Math.min(view.state.selection.main.head, text.length) } });
      },
    }),
    [],
  );

  return <div ref={hostRef} className={`mg-cm${props.singleLine ? " single" : ""}${props.className ? ` ${props.className}` : ""}`} />;
});
