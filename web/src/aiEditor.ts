import { completionStatus } from "@codemirror/autocomplete";
import { isolateHistory } from "@codemirror/commands";
import { RangeSet, RangeSetBuilder, StateEffect, StateField, Transaction, type EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  gutterLineClass,
  ViewPlugin,
  WidgetType,
  type ViewUpdate,
} from "@codemirror/view";

// The SQL editor's AI: the inline edit (a request written in a box anchored
// in the text, its SQL written straight into the document as a pending
// change to accept or reject) and suggestions as the user types (gray ghost
// text after the cursor). Nothing here runs SQL.

// ---- The inline edit's place: room made between two lines ----

// The box itself is a React element over the editor (see AiInlineEdit), not
// inside the editable content, so its field and the IME stay the page's own;
// a spacer as tall as the box makes room for it, above line `pos` starts
// (side -1) or below the line `pos` ends (side 1).
export interface AiZone {
  pos: number;
  side: -1 | 1;
  height: number;
}

export const setAiZone = StateEffect.define<AiZone | null>();
export const setAiZoneHeight = StateEffect.define<number>();

class ZoneSpacer extends WidgetType {
  constructor(readonly height: number) {
    super();
  }

  eq(other: ZoneSpacer): boolean {
    return other.height === this.height;
  }

  toDOM(): HTMLElement {
    const dom = document.createElement("div");
    dom.className = "cm-ai-zone";
    dom.setAttribute("aria-hidden", "true");
    dom.style.height = `${this.height}px`;
    return dom;
  }

  updateDOM(dom: HTMLElement): boolean {
    dom.style.height = `${this.height}px`;
    return true;
  }

  get estimatedHeight(): number {
    return this.height;
  }
}

export const aiZoneField = StateField.define<AiZone | null>({
  create: () => null,
  update(zone, tr) {
    let next = zone !== null && tr.docChanged ? { ...zone, pos: tr.changes.mapPos(zone.pos, -1) } : zone;
    for (const effect of tr.effects) {
      if (effect.is(setAiZone)) {
        next = effect.value;
      } else if (effect.is(setAiZoneHeight) && next !== null && next.height !== effect.value) {
        next = { ...next, height: effect.value };
      }
    }
    return next;
  },
  provide: (field) =>
    EditorView.decorations.compute([field], (state) => {
      const zone = state.field(field);
      if (zone === null) {
        return Decoration.none;
      }
      // A block widget sits on a line's edge, wherever edits moved `pos`.
      const line = state.doc.lineAt(Math.min(zone.pos, state.doc.length));
      return Decoration.set(
        Decoration.widget({ widget: new ZoneSpacer(zone.height), block: true, side: zone.side }).range(
          zone.side < 0 ? line.from : line.to,
        ),
      );
    }),
});

// The element the box is drawn in: a child of the scroller, so it scrolls
// with the text; placed over the spacer after every layout change.
export const AI_ZONE_HOST = "cm-ai-zone-host";

// Kept clear at the scroller's bottom: the app's 10px scrollbar track lies
// over that edge. And a little room above.
const SCROLLBAR_ROOM = 12;
const REVEAL_MARGIN = 4;

// The box placed over its spacer and, when it opens, changes height, or
// the AI's SQL starts or finishes coming, scrolled into sight together with
// the first line of that SQL (the box alone when both don't fit).
const zonePlacer = ViewPlugin.fromClass(
  class {
    reveal = true;

    constructor(view: EditorView) {
      this.place(view);
    }

    update(update: ViewUpdate): void {
      const before = update.startState.field(aiPendingField, false) ?? null;
      const after = update.state.field(aiPendingField, false) ?? null;
      const sqlShown =
        after !== null && after.written && (before === null || !before.written || (before.streaming && !after.streaming));
      const zoneSet = update.transactions.some((tr) =>
        tr.effects.some((effect) => effect.is(setAiZone) || effect.is(setAiZoneHeight)),
      );
      if (zoneSet || sqlShown) {
        this.reveal = true;
      }
      if (
        this.reveal ||
        update.docChanged ||
        update.geometryChanged ||
        update.viewportChanged ||
        update.startState.field(aiZoneField, false) !== update.state.field(aiZoneField, false)
      ) {
        this.place(update.view);
      }
    }

    place(view: EditorView): void {
      view.requestMeasure({
        key: this,
        read: (view) => {
          const zone = view.state.field(aiZoneField, false) ?? null;
          const reveal = this.reveal;
          this.reveal = false;
          if (zone === null) {
            return null;
          }
          const scrollDOM = view.scrollDOM;
          const scroller = scrollDOM.getBoundingClientRect();
          const content = view.contentDOM.getBoundingClientRect();
          // Where the document's top is in the scroller's content.
          const docTop = view.documentTop - scroller.top + scrollDOM.scrollTop;
          const line = view.state.doc.lineAt(Math.min(zone.pos, view.state.doc.length));
          const block = view.lineBlockAt(zone.side < 0 ? line.from : line.to);
          const top = (zone.side < 0 ? block.top : block.bottom - zone.height) + docTop;
          // Lined up with the text; over the gutter too when the editor is
          // narrow, never wider than the scroller (which would scroll it sideways).
          const width = scrollDOM.clientWidth;
          const textLeft = content.left - scroller.left + scrollDOM.scrollLeft;
          const left = width - textLeft - 12 >= 280 ? textLeft : 4;
          let scrollTop: number | null = null;
          if (reveal && zone.height > 0) {
            let from = top;
            let to = top + zone.height;
            const room = scrollDOM.clientHeight - SCROLLBAR_ROOM - REVEAL_MARGIN;
            const pending = aiPendingOf(view.state);
            if (pending?.written) {
              const first = view.lineBlockAt(Math.min(pending.from + pending.prefix.length, view.state.doc.length));
              const lineFrom = Math.min(from, first.top + docTop);
              const lineTo = Math.max(to, first.bottom + docTop);
              if (lineTo - lineFrom <= room) {
                from = lineFrom;
                to = lineTo;
              }
            }
            const current = scrollDOM.scrollTop;
            let next = current;
            if (to - from > room || from < current + REVEAL_MARGIN) {
              next = from - REVEAL_MARGIN;
            } else if (to > current + scrollDOM.clientHeight - SCROLLBAR_ROOM) {
              next = to - scrollDOM.clientHeight + SCROLLBAR_ROOM;
            }
            scrollTop = next === current ? null : Math.max(0, next);
          }
          return { top, left, width: Math.max(0, width - left - (left === 4 ? 4 : 12)), scrollTop };
        },
        write: (place, view) => {
          const host = view.scrollDOM.querySelector<HTMLElement>(`:scope > .${AI_ZONE_HOST}`);
          if (host === null) {
            return;
          }
          if (place === null) {
            host.style.display = "none";
            return;
          }
          host.style.display = "";
          host.style.top = `${place.top}px`;
          host.style.left = `${place.left}px`;
          host.style.width = `${place.width}px`;
          if (place.scrollTop !== null) {
            view.scrollDOM.scrollTop = place.scrollTop;
          }
        },
      });
    }
  },
);

// While the box is open the text ends with room below it, so the box can
// scroll clear of the scrollbar at the editor's bottom.
const zoneRoom = EditorView.editorAttributes.compute([aiZoneField], (state): Record<string, string> =>
  state.field(aiZoneField) === null ? {} : { class: "cm-ai-zone-open" },
);

// ---- The inline edit's change: AI text in the document, not yet accepted ----

// [from, to] holds `prefix` and the AI's SQL once `written`, the text it
// replaces (`original`) before. `anchor`/`head` are the selection before,
// as offsets from `from`, put back on reject.
export interface AiPending {
  from: number;
  to: number;
  prefix: string;
  original: string;
  written: boolean;
  streaming: boolean;
  anchor: number;
  head: number;
}

const setAiPending = StateEffect.define<AiPending | null>();

const addedMark = Decoration.mark({ class: "cm-ai-added" });
const addedStreamingMark = Decoration.mark({ class: "cm-ai-added streaming" });
const targetMark = Decoration.mark({ class: "cm-ai-target" });
const addedLine = Decoration.line({ class: "cm-ai-added-line" });
const addedGutter = new (class extends GutterMarker {
  elementClass = "cm-ai-added-gutter";
})();

function pendingLines(state: EditorState, pending: AiPending): number[] {
  const start = pending.written ? pending.from + pending.prefix.length : pending.from;
  if (pending.to <= start) {
    return [];
  }
  const starts: number[] = [];
  for (let pos = start; pos <= pending.to; ) {
    const line = state.doc.lineAt(pos);
    starts.push(line.from);
    if (line.to >= pending.to) {
      break;
    }
    pos = line.to + 1;
  }
  return starts;
}

export const aiPendingField = StateField.define<AiPending | null>({
  create: () => null,
  update(pending, tr) {
    let next =
      pending !== null && tr.docChanged
        ? { ...pending, from: tr.changes.mapPos(pending.from, 1), to: Math.max(tr.changes.mapPos(pending.from, 1), tr.changes.mapPos(pending.to, -1)) }
        : pending;
    for (const effect of tr.effects) {
      if (effect.is(setAiPending)) {
        next = effect.value;
      }
    }
    return next;
  },
  provide: (field) => [
    EditorView.decorations.compute([field], (state) => {
      const pending = state.field(field);
      if (pending === null) {
        return Decoration.none;
      }
      const start = pending.written ? pending.from + pending.prefix.length : pending.from;
      if (pending.to <= start) {
        return Decoration.none;
      }
      if (!pending.written) {
        return Decoration.set(targetMark.range(start, pending.to));
      }
      const builder = new RangeSetBuilder<Decoration>();
      const lines = pendingLines(state, pending);
      // Line decorations and the mark, in document order.
      for (const [index, from] of lines.entries()) {
        builder.add(from, from, addedLine);
        if (index === 0) {
          builder.add(start, pending.to, pending.streaming ? addedStreamingMark : addedMark);
        }
      }
      return builder.finish();
    }),
    gutterLineClass.compute([field], (state) => {
      const pending = state.field(field);
      if (pending === null || !pending.written) {
        return RangeSet.empty;
      }
      return RangeSet.of(pendingLines(state, pending).map((from) => addedGutter.range(from)));
    }),
  ],
});

export function aiPendingOf(state: EditorState): AiPending | null {
  return state.field(aiPendingField, false) ?? null;
}

// Where a new request writes: over the selection; over the cursor's line
// when it is blank; else on lines of its own after the cursor's line. The
// box goes just above where the SQL starts.
export function aiTarget(state: EditorState): { pending: AiPending; zone: Omit<AiZone, "height"> } {
  const range = state.selection.main;
  const line = state.doc.lineAt(range.head);
  let from: number;
  let to: number;
  let prefix = "";
  let zone: Omit<AiZone, "height">;
  if (!range.empty) {
    from = range.from;
    to = range.to;
    zone = { pos: state.doc.lineAt(range.from).from, side: -1 };
  } else if (line.text.trim() === "") {
    from = line.from;
    to = line.to;
    zone = { pos: line.from, side: -1 };
  } else {
    from = to = line.to;
    prefix = "\n";
    zone = { pos: line.to, side: 1 };
  }
  return {
    pending: {
      from,
      to,
      prefix,
      original: state.sliceDoc(from, to),
      written: false,
      streaming: false,
      anchor: range.anchor - from,
      head: range.head - from,
    },
    zone,
  };
}

// The text a request about the pending change works on: the AI's SQL once
// written, else the selection it replaces ("" when there was none).
export function aiPendingText(state: EditorState, pending: AiPending): string {
  return pending.written ? state.sliceDoc(pending.from + pending.prefix.length, pending.to) : pending.original;
}

// Marks where a request will write, before any of its SQL arrives.
export function startAiPending(view: EditorView, pending: AiPending): void {
  view.dispatch({ effects: setAiPending.of(pending) });
}

// Writes (or rewrites) the AI's SQL into the pending range. Kept out of the
// undo history: accepting records the whole change as one step. The first
// write drops the selection it replaces, so the added text shows as added.
export function writeAiPending(view: EditorView, sql: string, streaming: boolean): void {
  const pending = aiPendingOf(view.state);
  if (pending === null) {
    return;
  }
  const insert = pending.prefix + sql;
  view.dispatch({
    changes: { from: pending.from, to: pending.to, insert },
    selection: pending.written ? undefined : { anchor: pending.from + insert.length },
    effects: setAiPending.of({ ...pending, to: pending.from + insert.length, written: true, streaming }),
    annotations: Transaction.addToHistory.of(false),
  });
}

// Puts the replaced text back, the change still pending (an error or a stop
// before any SQL was kept).
export function restoreAiOriginal(view: EditorView): void {
  const pending = aiPendingOf(view.state);
  if (pending === null || !pending.written) {
    return;
  }
  view.dispatch({
    changes: { from: pending.from, to: pending.to, insert: pending.original },
    effects: setAiPending.of({ ...pending, to: pending.from + pending.original.length, written: false, streaming: false }),
    annotations: Transaction.addToHistory.of(false),
  });
}

// Rejects: the text exactly as it was, the selection too, nothing in the
// undo history.
export function rejectAiPending(view: EditorView): boolean {
  const pending = aiPendingOf(view.state);
  if (pending === null) {
    return false;
  }
  const length = view.state.doc.length;
  const clamp = (pos: number) => Math.max(0, Math.min(pos, length - (pending.to - pending.from) + pending.original.length));
  view.dispatch({
    changes: pending.written ? { from: pending.from, to: pending.to, insert: pending.original } : undefined,
    selection: { anchor: clamp(pending.from + pending.anchor), head: clamp(pending.from + pending.head) },
    effects: setAiPending.of(null),
    annotations: Transaction.addToHistory.of(false),
    scrollIntoView: true,
  });
  return true;
}

// Accepts: the AI's text stays, unmarked, the cursor after it; one undo
// step takes the whole change back. The text streamed in outside the
// history, so it is put back to the original and written again as a step.
export function acceptAiPending(view: EditorView): boolean {
  const pending = aiPendingOf(view.state);
  if (pending === null || !pending.written) {
    return false;
  }
  const text = view.state.sliceDoc(pending.from, pending.to);
  view.dispatch({
    changes: { from: pending.from, to: pending.to, insert: pending.original },
    annotations: Transaction.addToHistory.of(false),
  });
  view.dispatch({
    changes: { from: pending.from, to: pending.from + pending.original.length, insert: text },
    selection: { anchor: pending.from + text.length },
    effects: setAiPending.of(null),
    annotations: isolateHistory.of("full"),
    userEvent: "input.ai",
    scrollIntoView: true,
  });
  return true;
}

// ---- Suggestions as the user types: ghost text after the cursor ----

export type AiCompleteSource = (before: string, after: string, signal: AbortSignal) => Promise<string>;

interface Ghost {
  pos: number;
  text: string;
}

const setGhost = StateEffect.define<Ghost | null>();

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }

  toDOM(): HTMLElement {
    const dom = document.createElement("span");
    dom.className = "cm-ai-ghost";
    // Screen readers hear it from the editor's live region instead.
    dom.setAttribute("aria-hidden", "true");
    dom.textContent = this.text;
    return dom;
  }
}

const ghostField = StateField.define<Ghost | null>({
  create: () => null,
  update(ghost, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setGhost)) {
        return effect.value;
      }
    }
    if (ghost === null) {
      return null;
    }
    if (tr.docChanged) {
      // Typing what the suggestion says uses it up; anything else drops it.
      const edits: { from: number; to: number; text: string }[] = [];
      tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
        edits.push({ from, to, text: inserted.toString() });
      });
      const edit = edits.length === 1 ? edits[0] : null;
      if (
        edit !== null &&
        edit.from === ghost.pos &&
        edit.to === edit.from &&
        edit.text !== "" &&
        tr.isUserEvent("input") &&
        !tr.isUserEvent("input.complete") &&
        ghost.text.startsWith(edit.text)
      ) {
        const rest = ghost.text.slice(edit.text.length);
        return rest === "" ? null : { pos: ghost.pos + edit.text.length, text: rest };
      }
      return null;
    }
    if (tr.selection !== undefined) {
      const range = tr.selection.main;
      if (!range.empty || range.head !== ghost.pos || tr.selection.ranges.length > 1) {
        return null;
      }
    }
    return ghost;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (ghost) =>
      ghost === null ? Decoration.none : Decoration.set(Decoration.widget({ widget: new GhostWidget(ghost.text), side: 1 }).range(ghost.pos)),
    ),
});

// Takes the suggestion, or its next word (`word`), as typed text.
export function acceptAiGhost(view: EditorView, word = false): boolean {
  const ghost = view.state.field(ghostField, false) ?? null;
  if (ghost === null || completionStatus(view.state) === "active") {
    return false;
  }
  const part = word ? (/^\s*(?:[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]+)/u.exec(ghost.text)?.[0] ?? ghost.text) : ghost.text;
  const rest = ghost.text.slice(part.length);
  view.dispatch({
    changes: { from: ghost.pos, insert: part },
    selection: { anchor: ghost.pos + part.length },
    effects: setGhost.of(rest === "" ? null : { pos: ghost.pos + part.length, text: rest }),
    userEvent: "input.complete",
    scrollIntoView: true,
  });
  return true;
}

export function dismissAiGhost(view: EditorView): boolean {
  if ((view.state.field(ghostField, false) ?? null) === null) {
    return false;
  }
  view.dispatch({ effects: setGhost.of(null) });
  return true;
}

// After this long without typing, a suggestion is asked for.
const PAUSE_MS = 400;
// Answers kept by the text around the cursor, so going back asks nothing.
const CACHE_SIZE = 24;
// What may follow the cursor on its line: nothing, blanks, closing marks.
const AFTER_CURSOR = /^[\s)\]}'"`;,]*$/;

function ghostPlugin(source: () => AiCompleteSource | null, onShown: (text: string) => void) {
  return ViewPlugin.fromClass(
    class {
      timer: number | undefined;
      controller: AbortController | null = null;
      cache = new Map<string, string>();

      constructor(readonly view: EditorView) {}

      update(update: ViewUpdate): void {
        if (update.docChanged || update.selectionSet || update.focusChanged) {
          this.cancel();
        }
        const ghost = update.state.field(ghostField);
        const before = update.startState.field(ghostField);
        if (ghost !== null && before === null) {
          onShown(ghost.text);
        }
        // The completion list opened over it: the list has the keys.
        if (ghost !== null && completionStatus(update.state) === "active") {
          window.setTimeout(() => dismissAiGhost(this.view), 0);
          return;
        }
        // Typing, Enter, pasting, deleting; not a suggestion or AI text taken.
        const typed = update.transactions.some(
          (tr) =>
            ((tr.isUserEvent("input") && !tr.isUserEvent("input.complete") && !tr.isUserEvent("input.ai")) ||
              tr.isUserEvent("delete")) &&
            tr.docChanged,
        );
        if (typed && ghost === null && source() !== null) {
          this.timer = window.setTimeout(() => this.ask(), PAUSE_MS);
        }
      }

      ask(): void {
        this.timer = undefined;
        const view = this.view;
        const { state } = view;
        const fetch = source();
        const range = state.selection.main;
        if (
          fetch === null ||
          !view.hasFocus ||
          view.composing ||
          state.readOnly ||
          state.selection.ranges.length > 1 ||
          !range.empty ||
          completionStatus(state) !== null ||
          aiPendingOf(state) !== null ||
          (state.field(aiZoneField, false) ?? null) !== null
        ) {
          return;
        }
        const head = range.head;
        const line = state.doc.lineAt(head);
        if (!AFTER_CURSOR.test(state.sliceDoc(head, line.to))) {
          return;
        }
        const before = state.sliceDoc(Math.max(0, head - 6000), head);
        const after = state.sliceDoc(head, Math.min(state.doc.length, head + 2000));
        if (before.trim() === "") {
          return;
        }
        const key = `${before}\u0000${after}`;
        const cached = this.cache.get(key);
        if (cached !== undefined) {
          this.show(head, cached);
          return;
        }
        const controller = new AbortController();
        this.controller = controller;
        const doc = state.doc;
        fetch(before, after, controller.signal).then(
          (text) => {
            if (controller.signal.aborted) {
              return;
            }
            this.controller = null;
            this.cache.delete(key);
            this.cache.set(key, text);
            if (this.cache.size > CACHE_SIZE) {
              this.cache.delete(this.cache.keys().next().value as string);
            }
            if (view.state.doc === doc && view.state.selection.main.head === head && view.state.selection.main.empty) {
              this.show(head, text);
            }
          },
          // The caller reports failures; the editor stays quiet.
          () => {
            if (this.controller === controller) {
              this.controller = null;
            }
          },
        );
      }

      show(pos: number, text: string): void {
        if (text.trim() === "" || completionStatus(this.view.state) !== null) {
          return;
        }
        this.view.dispatch({ effects: setGhost.of({ pos, text }) });
      }

      cancel(): void {
        window.clearTimeout(this.timer);
        this.timer = undefined;
        this.controller?.abort();
        this.controller = null;
      }

      destroy(): void {
        this.cancel();
      }
    },
  );
}

// `source` is read on each pause, so turning suggestions off (null) needs no
// reconfiguring; `onShown` hears each new suggestion (for screen readers).
export function aiEditorExtensions(source: () => AiCompleteSource | null, onShown: (text: string) => void): Extension {
  return [aiZoneField, zonePlacer, zoneRoom, aiPendingField, ghostField, ghostPlugin(source, onShown)];
}
