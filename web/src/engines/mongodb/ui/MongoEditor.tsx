// The code editor of the document views: the query bar's one-line boxes,
// the JSON block and document editors, and the mongosh tab. mongosh
// colouring from the shell tokenizer, completion from complete.ts, an
// error range underlined, ⌘↩ to run.

import { basicSetup } from "codemirror";
import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, completionStatus, pickedCompletion, startCompletion, type Completion, type CompletionContext as CMContext, type CompletionResult as CMResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { EditorState, Prec, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, drawSelection, keymap, placeholder as placeholderExt, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { t } from "../../../i18n";
import { completionsAt, type CompletionContext, type CompletionItem, type CompletionKind, type CompletionRole } from "../complete";
import { statementAt } from "../shell/parse";
import { shellSpans } from "./ShellText";

export interface MongoEditorHandle {
  view(): EditorView | null;
  focus(): void;
  text(): string;
  // The selection (or the caret as an empty range).
  selection(): { from: number; to: number };
  // Briefly marks a range (the statement just run).
  flash(from: number, to: number): void;
}

interface MongoEditorProps {
  value: string;
  onChange?(text: string): void;
  // ⌘↩, and Return in a one-line box (unless the completion list is open).
  onRun?(): void;
  // Esc with no completion list open.
  onEscape?(): void;
  role: CompletionRole;
  // Read at completion time, so it may change without reconfiguring.
  completion?: () => CompletionContext;
  // Text read as standing before the editor's own for completion (an
  // aggregation stage's body completes as `[{ $match: ` + body).
  contextPrefix?: string;
  singleLine?: boolean;
  placeholder?: string;
  // Underlined with a wavy line (a parse error).
  error?: { from: number; to: number } | null;
  autoFocus?: boolean;
  className?: string;
  ariaLabel?: string;
}

const BADGES: Record<CompletionKind, { mark: string; cls: string; title: string }> = {
  field: { mark: "F", cls: "column", title: "필드" },
  operator: { mark: "$", cls: "keyword", title: "연산자" },
  stage: { mark: "|", cls: "function", title: "단계" },
  accumulator: { mark: "Σ", cls: "function", title: "누산기" },
  expression: { mark: "ƒ", cls: "function", title: "식" },
  update: { mark: "$", cls: "keyword", title: "업데이트 연산자" },
  value: { mark: "v", cls: "value", title: "값" },
  keyword: { mark: "K", cls: "keyword", title: "키워드" },
  collection: { mark: "C", cls: "table", title: "컬렉션" },
  method: { mark: "ƒ", cls: "function", title: "메서드" },
};

interface MongoCompletion extends Completion {
  item: CompletionItem;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function infoOf(item: CompletionItem): HTMLElement | null {
  if (item.info === null && item.detail === "") {
    return null;
  }
  const badge = BADGES[item.kind];
  const box = el("div", "ac-info");
  const head = el("div", "ac-info-head");
  head.append(el("span", `ac-badge ac-${badge.cls}`, badge.mark), el("span", "ac-info-title", item.label));
  box.append(head);
  if (item.info !== null) {
    box.append(el("div", "ac-info-note", t(item.info.doc)));
    if (item.info.example !== null) {
      box.append(el("pre", "ac-info-code", item.info.example));
    }
  } else {
    box.append(el("div", "ac-info-note mono", item.detail));
  }
  return box;
}

// Replaces the typed prefix as the prototype's completer did: inside a
// string up to its closing quote, a key gets ": ", "()" leaves the caret
// between the parentheses; a call or path opens the next list.
function applyItem(item: CompletionItem, from: number) {
  return (view: EditorView, completion: Completion, _from: number, to: number) => {
    const doc = view.state.doc;
    const line = doc.lineAt(to);
    const after = doc.sliceString(to, line.to);
    let text = item.apply;
    let end = to;
    if (item.closeQuote) {
      const quote = doc.sliceString(from - 1, from);
      const close = after.indexOf(quote);
      if (quote !== "" && close >= 0) {
        end += close + 1;
      }
      text += quote;
    } else {
      end += /^[\w$.]*/.exec(after)?.[0].length ?? 0;
    }
    if (item.key && !/^\s*:/.test(doc.sliceString(end, Math.min(doc.length, end + 40)))) {
      text += ": ";
    }
    view.dispatch({
      changes: { from, to: end, insert: text },
      selection: { anchor: from + text.length - item.caretBack },
      annotations: pickedCompletion.of(completion),
      userEvent: "input.complete",
    });
    if (/[.(]$/.test(text) || (item.caretBack > 0 && text.endsWith("()"))) {
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

// Colouring the whole text is cheap at document sizes; a dump-sized text
// goes uncoloured rather than slow.
const COLOUR_LIMIT = 300_000;

function colourDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const text = view.state.doc.toString();
  if (text.length <= COLOUR_LIMIT) {
    for (const span of shellSpans(text)) {
      if (span.to > span.from) {
        builder.add(span.from, span.to, Decoration.mark({ class: span.cls }));
      }
    }
  }
  return builder.finish();
}

const colours = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = colourDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.decorations = colourDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

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

export const MongoEditor = forwardRef<MongoEditorHandle, MongoEditorProps>(function MongoEditor(props, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const { singleLine = false } = propsRef.current;

    const source = (context: CMContext): CMResult | null => {
      const { role, completion } = propsRef.current;
      if (completion === undefined) {
        return null;
      }
      const ctx = completion();
      const text = context.state.doc.toString();
      const pos = context.pos;
      let result;
      let offset = 0;
      if (role === "shell") {
        const range = statementAt(text, pos);
        offset = range !== null && pos >= range.from ? range.from : 0;
        result = completionsAt(text.slice(offset, pos), pos - offset, role, ctx);
      } else {
        const lead = propsRef.current.contextPrefix ?? "";
        result = completionsAt(lead + text, lead.length + pos, role, ctx);
        if (result !== null) {
          result = { ...result, from: result.from - lead.length };
        }
      }
      if (result === null) {
        return null;
      }
      const before = text.slice(Math.max(0, pos - 2), pos);
      if (!context.explicit && result.prefix === "" && !/[{,(\[:."'$]\s?$/.test(before) && text.trim() !== "") {
        return null;
      }
      const from = result.from + offset;
      const prefix = result.prefix.toLowerCase();
      const matched = result.items
        .map((item, index) => ({ item, index, at: item.label.toLowerCase().indexOf(prefix) }))
        .filter((x) => prefix === "" || x.at >= 0)
        .sort((a, b) => Number(a.at !== 0) - Number(b.at !== 0) || a.index - b.index);
      if (matched.length === 0) {
        return null;
      }
      const options: MongoCompletion[] = matched.map(({ item }) => ({
        label: item.label,
        detail: item.detail === "" ? undefined : t(item.detail),
        apply: applyItem(item, from),
        info: () => infoOf(item),
        item,
      }));
      return {
        from,
        to: pos,
        options,
        filter: false,
        getMatch: (completion) => {
          const at = completion.label.toLowerCase().indexOf(prefix);
          return prefix === "" || at < 0 ? [] : [at, at + prefix.length];
        },
      };
    };

    const runKeys = keymap.of([
      {
        key: "Mod-Enter",
        run: () => {
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
      optionClass: (completion) => `ac-option ac-${BADGES[(completion as MongoCompletion).item?.kind ?? "keyword"].cls}`,
      addToOptions: [
        {
          position: 20,
          render: (completion) => {
            const badge = BADGES[(completion as MongoCompletion).item?.kind ?? "keyword"];
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
            // One line: pasted line breaks become spaces.
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

  // A value set from outside (reset, history pick) replaces the text.
  useEffect(() => {
    const view = viewRef.current;
    if (view && view.state.doc.toString() !== props.value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.value }, selection: { anchor: props.value.length } });
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
    }),
    [],
  );

  return <div ref={hostRef} className={`mg-cm${props.singleLine ? " single" : ""}${props.className ? ` ${props.className}` : ""}`} />;
});
