import type { RowSource, RowState } from "./rowSource";
import { palette } from "../palette";
import { getSettings } from "../settings";
import { classifyCell } from "./valueKind";
import { edgeScrollStep } from "./edgeScroll";
import { isDateKind, type CellKind, type GridColumnSpec } from "./columns";
import { COPY_MAX_ROWS, parseClipboardTable, toPlainText } from "../copyFormats";
import { t } from "../i18n";
import { IS_MAC } from "../shortcuts";
import { scrollbarsFor, type ScrollArea } from "../scrollbars";

// Sizes at the default system font size (12px); scaled by syncScale().
const BASE_FONT_PX = 12;
const BASE_ROW_H = 26;
const BASE_HEADER_H = 28;
let ROW_H = BASE_ROW_H;
let HEADER_H = BASE_HEADER_H;
const GUTTER_MIN = 48;
const CELL_PAD = 8;
const COL_DEFAULT = 150;
const COL_MIN = 48;
const COL_MAX = 800;
// A new result's columns fit their contents up to this; longer values end in
// an ellipsis until the column is widened.
const FIT_MAX = 360;
const RESIZE_GRIP = 4;
const MAX_SCROLL_PX = 33_000_000;
const MIN_CHAR_W = 3;
const STATE_ALPHA = 0.16;
const EDIT_ALPHA = 0.24;
let FONT = "";
let FONT_HEADER = "";
// The grid's text, rows and header follow the Data Table font and size
// (Settings), as every table in the app does.
let SCALE = 0;
let FAMILY = "";

// A row's and the header's height at a font size.
export function gridHeightsAt(size: number): { row: number; header: number } {
  const scale = size / BASE_FONT_PX;
  return { row: Math.round(BASE_ROW_H * scale), header: Math.round(BASE_HEADER_H * scale) };
}

function syncScale(): void {
  const { gridFontSize: size, gridFontFamily: family } = getSettings();
  const scale = size / BASE_FONT_PX;
  if (scale === SCALE && family === FAMILY) {
    return;
  }
  SCALE = scale;
  FAMILY = family;
  ({ row: ROW_H, header: HEADER_H } = gridHeightsAt(size));
  FONT = `${size}px ${family}`;
  FONT_HEADER = `600 ${size}px ${family}`;
}

syncScale();

export function gridRowH(): number {
  syncScale();
  return ROW_H;
}

export function gridHeaderH(): number {
  syncScale();
  return HEADER_H;
}
// Room at a cell's right for its button: ⌃⌄ (a list, a date picker) or →
// (a foreign key's row).
const ACCESSORY_W = 16;
// Room a header keeps beside its name for the sort arrow.
const SORT_W = 14;
// The corner button's icon: columns pushed apart to fit.
const FIT_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M4 4H2.8v8H4M12 4h1.2v8H12"/><path d="M5.2 8h5.6M6.8 6.4 5.2 8l1.6 1.6M9.2 6.4 10.8 8l-1.6 1.6"/></svg>';
// How long a grid awaiting new rows keeps its last frame: --loading-delay in
// styles.css, after which the loading state takes over.
const HOLD_MS = 200;
const MENU_MAX_H = 240;
const MENU_MAX_ITEMS = 300;

export type SelMode = "cell" | "row" | "col";

interface CellPos {
  row: number;
  col: number;
}

interface SelRange {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

type DragState =
  | { kind: "none" }
  | { kind: "resize"; col: number; startX: number; startW: number }
  | { kind: "select" };

export interface SortIndicator {
  columnIndex: number;
  dir: "asc" | "desc";
}

type HeaderClickHandler = (columnIndex: number, event: { shiftKey: boolean }) => void;
// The cursor row, and the span of rows the selection covers (null for a
// column selection, which takes every row).
export interface SelectedRows {
  from: number;
  to: number;
}
type SelectionHandler = (row: number | null, rows: SelectedRows | null) => void;
// What is selected, as a block: whole rows (from the row numbers) span every
// column, whole columns (from the header) every row.
export interface GridSelection {
  mode: SelMode;
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}
type CellContextMenuHandler = (row: number, col: number, x: number, y: number, selection: GridSelection) => void;
type DeleteRowsHandler = (rows: number[]) => void;
// Clipboard rows pasted over whole selected rows, each with a field per column.
type PasteRowsHandler = (rows: string[][]) => void;

// A cell's button: "choices" opens the editor's list here; the others go to
// the accessory handler (a date picker, the row a foreign key points at).
export type CellAccessory = "choices" | "date" | "link";
export type AccessoryHandler = (kind: "date" | "link", row: number, col: number) => void;

const CLICK_SLOP = 2;

// Values listed under a cell's editor, as TablePlus offers types and defaults.
// A strict cell takes only these; others also accept typing.
export interface CellChoices {
  options: string[];
  strict?: boolean;
  // The part of the typed text that narrows the list, and how a picked option
  // joins the typed text, for list cells such as an index's columns.
  query?(text: string): string;
  pick?(text: string, option: string): string;
}

export interface GridEditHandlers {
  onCommit(row: number, col: number, value: string | null): void;
  onCancel?(): void;
  canEdit?(row: number, col: number): boolean;
  choices?(row: number, col: number): CellChoices | null;
}

interface EditState {
  input: HTMLInputElement;
  row: number;
  col: number;
  initial: string;
  scrollLeft: number;
  scrollTop: number;
  choices: CellChoices | null;
  menu: HTMLDivElement | null;
  // Options on show, highlighted one (-1 for none), and whether anything has
  // been typed yet (until then the list shows every option).
  shown: string[];
  active: number;
  typed: boolean;
}

// The text the last single-cell copy put on the clipboard (from any grid):
// pasted back, it stays one value even with line breaks in it.
let lastCellCopy: string | null = null;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export class CanvasGrid {
  private readonly host: HTMLElement;
  private readonly scroller: HTMLDivElement;
  private readonly sizer: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  // The (0,0) corner, as in TablePlus: sizes every column to its contents again.
  private readonly fitButton: HTMLButtonElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly ro: ResizeObserver;
  // The app's bars over the scroller, kept in view as Settings asks.
  private readonly bars: ScrollArea;

  private source: RowSource | null = null;
  private widths: number[] = [];
  private offsets: number[] = [0];
  private gutterW = GUTTER_MIN;

  private hoverRow: number | null = null;
  private hoverColEdge: number | null = null;

  private selMode: SelMode = "cell";
  private anchor: CellPos | null = null;
  private cursor: CellPos | null = null;

  private drag: DragState = { kind: "none" };
  // Where a selection drag's pointer is, so dragging past an edge keeps
  // scrolling (and extending the selection) while the pointer holds still.
  private dragPoint: { x: number; y: number } | null = null;
  private autoScrollId = 0;
  private focused = false;

  private editable: GridEditHandlers | null = null;
  private editor: EditState | null = null;
  private disposeUpdates: (() => void) | null = null;

  private headerClick: HeaderClickHandler | null = null;
  private sortColumns: SortIndicator[] = [];
  private selectionListener: SelectionHandler | null = null;
  private contextMenuHandler: CellContextMenuHandler | null = null;
  private deleteRowsHandler: DeleteRowsHandler | null = null;
  private pasteRowsHandler: PasteRowsHandler | null = null;
  private quickLook: ((row: number, col: number) => void) | null = null;
  private cellQuickLook: ((row: number, col: number) => void) | null = null;
  private lastNotified = "";
  private pendingHeaderClick: { col: number; x: number; y: number; shiftKey: boolean } | null =
    null;
  // A press on a cell's button acts once the pointer comes up on it.
  private pendingAccessory: (CellPos & { kind: CellAccessory }) | null = null;
  private specs: (GridColumnSpec | null)[] | null = null;
  private accessoryHandler: AccessoryHandler | null = null;
  // Width of one ASCII character in the cell font, for a cheap fit check.
  private charW = 0;
  // A new source's columns still to be sized to their contents, once its
  // first rows are in.
  private autoFit = false;
  private layoutListener: (() => void) | null = null;
  private keyMoveListener: ((row: number) => void) | null = null;

  private rafId = 0;
  // How the corner button sizes columns: a table's opening fit, unless the
  // owner fits its own way (fitColumns).
  private fitPolicy = { min: COL_MIN, cap: FIT_MAX };
  // Until then a grid awaiting new rows leaves its last frame on screen.
  private holdUntil = 0;
  private holdTimer = 0;
  private viewW = 0;
  private viewH = 0;
  private knownRowCount = 0;
  // What the next source keeps of the view when its columns are the same:
  // everything (the same rows read again), or the columns' widths and the
  // sideways scroll (the rows sorted, paged or filtered, read from the top).
  private keepViewOnce: "all" | "columns" | null = null;
  // The system font scale and the font this grid was last laid out with.
  private scaleSeen = SCALE;
  private fontSeen = FONT;

  constructor(host: HTMLElement) {
    this.host = host;
    syncScale();
    this.scaleSeen = SCALE;
    this.fontSeen = FONT;

    const scroller = document.createElement("div");
    scroller.className = "grid-scroller";
    scroller.style.position = "absolute";
    scroller.style.inset = "0";
    scroller.style.overflow = "auto";
    scroller.style.background = palette.bg;
    scroller.style.outline = "none";

    const sizer = document.createElement("div");
    sizer.style.position = "relative";

    // The canvas sticks to the scrollport, so the compositor keeps it (and the
    // painted header) in place while scrolling instead of a scroll-event transform.
    const canvas = document.createElement("canvas");
    canvas.tabIndex = 0;
    canvas.style.position = "sticky";
    canvas.style.top = "0";
    canvas.style.left = "0";
    canvas.style.zIndex = "1";
    canvas.style.display = "block";
    canvas.style.outline = "none";
    canvas.style.cursor = "default";

    sizer.appendChild(canvas);
    scroller.appendChild(sizer);
    host.appendChild(scroller);

    const fitButton = document.createElement("button");
    fitButton.type = "button";
    fitButton.className = "grid-fit-button";
    fitButton.title = t("열 너비 맞추기");
    fitButton.setAttribute("aria-label", t("열 너비 맞추기"));
    fitButton.innerHTML = FIT_ICON;
    fitButton.hidden = true;
    fitButton.addEventListener("click", this.onFitClick);
    host.appendChild(fitButton);

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("canvas 2d context unavailable");
    }

    this.scroller = scroller;
    this.sizer = sizer;
    this.canvas = canvas;
    this.fitButton = fitButton;
    this.ctx = ctx;
    this.ro = new ResizeObserver(this.onResize);
    this.bars = scrollbarsFor(scroller, true);
    this.bars.watch(sizer);

    scroller.addEventListener("scroll", this.onScroll);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("lostpointercapture", this.onLostCapture);
    canvas.addEventListener("contextmenu", this.onContextMenu);
    canvas.addEventListener("auxclick", this.onAuxClick);
    canvas.addEventListener("dblclick", this.onDblClick);
    canvas.addEventListener("keydown", this.onKeyDown);
    canvas.addEventListener("focus", this.onFocus);
    canvas.addEventListener("blur", this.onBlur);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.ro.observe(scroller);
    // Browsers send ⌘V to the focused element or to the body, depending on
    // the selection; the document hears it either way.
    document.addEventListener("paste", this.onPaste);
    // A face picked in Settings loads after the frame that first asks for
    // it, which drew in the fallback.
    document.fonts.addEventListener("loadingdone", this.onFontsLoaded);

    this.updateSizer();
    this.resizeSurface();
    this.schedulePaint();
  }

  // Colours, and the Data Table font and size: a new size scales rows, the
  // header, the row numbers and every column with it.
  refreshTheme(): void {
    syncScale();
    if (this.fontSeen !== FONT) {
      // Text widths change with the font: measure again.
      this.fontSeen = FONT;
      this.charW = 0;
    }
    if (this.scaleSeen !== SCALE) {
      const ratio = SCALE / this.scaleSeen;
      this.scaleSeen = SCALE;
      if (this.editor) {
        this.cancelEdit();
      }
      // The same rows and columns stay in view.
      const top = this.scroller.scrollTop * ratio;
      const left = this.scroller.scrollLeft * ratio;
      this.charW = 0;
      this.widths = this.widths.map((width) => clamp(Math.round(width * ratio), COL_MIN, COL_MAX));
      this.gutterW = this.gutterFor(this.knownRowCount);
      this.placeFitButton();
      this.rebuildOffsets();
      // A held frame stays until its hold ends (endHold sizes the grid then).
      if (this.holdUntil === 0) {
        this.updateSizer();
        this.resizeSurface();
        this.scroller.scrollTop = Math.round(top);
        this.scroller.scrollLeft = Math.round(left);
      }
    }
    this.scroller.style.background = palette.bg;
    this.schedulePaint();
  }

  setQuickLookHandler(handler: ((row: number, col: number) => void) | null): void {
    this.quickLook = handler;
  }

  setCellQuickLookHandler(handler: ((row: number, col: number) => void) | null): void {
    this.cellQuickLook = handler;
  }

  // What each column is (type, key, foreign key), by column index.
  setColumnSpecs(specs: (GridColumnSpec | null)[] | null): void {
    this.specs = specs;
    this.schedulePaint();
  }

  setAccessoryHandler(handler: AccessoryHandler | null): void {
    this.accessoryHandler = handler;
    this.schedulePaint();
  }

  sourceCell(row: number, col: number): unknown {
    return this.source?.cell(row, col);
  }

  // The element the grid was given to draw into.
  hostElement(): HTMLElement {
    return this.host;
  }

  // `awaitingRows`: the grid is emptied because other rows are on their way
  // (another table is loading). It keeps the last frame it drew until they
  // come, or for HOLD_MS, so a quick switch goes straight from one table to
  // the next instead of through a blank grid. Nothing can be picked from that
  // frame: its source is already gone.
  setSource(source: RowSource | null, awaitingRows = false): void {
    if (this.editor) {
      this.cancelEdit();
    }
    if (this.disposeUpdates) {
      this.disposeUpdates();
      this.disposeUpdates = null;
    }
    const previous = this.source;
    window.clearTimeout(this.holdTimer);
    this.holdUntil = 0;
    if (source === null && previous !== null && awaitingRows) {
      this.holdUntil = performance.now() + HOLD_MS;
      this.holdTimer = window.setTimeout(() => this.endHold(), HOLD_MS);
    }
    const sameColumns =
      previous !== null &&
      source !== null &&
      previous.columns.length === source.columns.length &&
      previous.columns.every((name, index) => name === source.columns[index]);
    const keep = sameColumns ? this.keepViewOnce : null;
    this.keepViewOnce = null;
    this.source = source;
    if (source && source.onUpdate) {
      this.disposeUpdates = source.onUpdate(this.onSourceUpdate);
    }
    if (keep === null) {
      this.scroller.scrollLeft = 0;
    }
    if (keep !== "all") {
      this.scroller.scrollTop = 0;
    }
    this.hoverRow = null;
    this.hoverColEdge = null;
    this.canvas.style.cursor = "default";
    this.selMode = "cell";
    this.anchor = null;
    this.cursor = null;
    this.drag = { kind: "none" };
    this.pendingHeaderClick = null;
    this.notifySelection();

    const colCount = source ? source.columns.length : 0;
    const rowCount = source ? source.rowCount : 0;
    if (keep === null) {
      const widths = new Array<number>(colCount);
      for (let c = 0; c < colCount; c++) {
        widths[c] = Math.round(COL_DEFAULT * SCALE);
      }
      this.widths = widths;
      this.autoFit = true;
    }
    this.knownRowCount = rowCount;
    this.gutterW = this.gutterFor(rowCount);
    this.placeFitButton();
    this.rebuildOffsets();
    // Sizing the canvas would clear the held frame (scrollbars that take room
    // come and go with the sizer); endHold does it once the hold is over.
    if (this.holdUntil === 0) {
      this.updateSizer();
      this.resizeSurface();
    }
    this.schedulePaint();
    this.fitNewColumns();
  }

  // Ends a hold: the rows came some other way, or won't come (the load failed
  // or was stopped), so the empty grid shows.
  endHold(): void {
    if (this.holdUntil === 0) {
      return;
    }
    window.clearTimeout(this.holdTimer);
    this.holdUntil = 0;
    this.placeFitButton();
    this.updateSizer();
    this.resizeSurface();
    this.schedulePaint();
  }

  // Sizes a new source's columns to what they hold, as TablePlus opens a
  // table: once, when its first rows are there to measure.
  private fitNewColumns(): void {
    const src = this.source;
    if (!this.autoFit || src === null || (src.rowCount > 0 && src.cell(0, 0) === undefined)) {
      return;
    }
    this.autoFit = false;
    this.fitToContents();
  }

  // Every column as wide as what it holds, up to FIT_MAX: what a table opens
  // with, and what the corner button goes back to.
  private fitToContents(): void {
    this.hoverColEdge = null;
    const { min, cap } = this.fitPolicy;
    const from = Math.floor(this.virtualScrollY() / ROW_H);
    for (let c = 0; c < this.widths.length; c++) {
      this.widths[c] = Math.max(Math.round(min * SCALE), this.fitWidth(c, Math.round(cap * SCALE), from));
    }
    this.rebuildOffsets();
    this.updateSizer();
    this.resizeSurface();
    this.schedulePaint();
  }

  private readonly onFitClick = (): void => {
    if (this.source === null) {
      return;
    }
    this.fitToContents();
    this.canvas.focus({ preventScroll: true });
  };

  // The corner button covers the row-number column's header cell.
  private placeFitButton(): void {
    // Kept through a hold, so it doesn't blink on a table switch.
    this.fitButton.hidden = this.source === null && this.holdUntil === 0;
    this.fitButton.style.width = `${this.gutterW}px`;
    this.fitButton.style.height = `${HEADER_H}px`;
  }

  // null takes back a request whose run brought no rows (it failed or was
  // stopped), so it can't carry over to another table.
  keepViewOnNextSource(scope: "all" | "columns" | null = "all"): void {
    // A reload asked for already keeps more than a re-sort would.
    this.keepViewOnce = scope === null ? null : this.keepViewOnce === "all" ? "all" : scope;
  }

  setEditable(handlers: GridEditHandlers | null): void {
    if (handlers === null && this.editor) {
      this.cancelEdit();
    }
    this.editable = handlers;
  }

  setHeaderClickHandler(handler: HeaderClickHandler | null): void {
    this.headerClick = handler;
  }

  setSortColumns(sorts: SortIndicator[] | null): void {
    this.sortColumns = sorts ?? [];
    this.schedulePaint();
  }

  setSelectionListener(listener: SelectionHandler | null): void {
    this.selectionListener = listener;
  }

  setCellContextMenuHandler(handler: CellContextMenuHandler | null): void {
    this.contextMenuHandler = handler;
  }

  setDeleteRowsHandler(handler: DeleteRowsHandler | null): void {
    this.deleteRowsHandler = handler;
  }

  // Without one, rows pasted over selected rows go over their cells instead.
  setPasteRowsHandler(handler: PasteRowsHandler | null): void {
    this.pasteRowsHandler = handler;
  }

  selection(): GridSelection | null {
    const range = this.selectionRange();
    return range === null ? null : { mode: this.selMode, ...range };
  }

  // Selects rows `from`…`to` whole, as the row numbers do.
  selectRows(from: number, to: number): void {
    const src = this.source;
    if (!src || from < 0 || to >= src.rowCount || from > to) {
      return;
    }
    this.selMode = "row";
    this.anchor = { row: from, col: 0 };
    this.cursor = { row: to, col: 0 };
    this.ensureVisibleFor(to, 0);
    this.notifySelection();
    this.canvas.focus({ preventScroll: true });
    this.schedulePaint();
  }

  beginEdit(row: number, col: number): void {
    if (this.editor) {
      this.commitEdit();
    }
    // The host may have just grown (a row added); scrolling against the old
    // size would move the view and close the editor again.
    this.resizeSurface();
    this.updateSizer();
    this.schedulePaint();
    if (this.source && row >= 0 && row < this.source.rowCount && col >= 0 && col < this.widths.length) {
      this.ensureVisibleFor(row, col);
    }
    this.startEdit(row, col);
  }

  /** Sizes every column to its header and values, no narrower than `min`. */
  fitColumns(min: number): void {
    // The corner button fits the same way from now on.
    this.fitPolicy = { min, cap: COL_MAX };
    for (let c = 0; c < this.widths.length; c++) {
      this.widths[c] = Math.max(Math.round(min * SCALE), this.fitWidth(c));
    }
    this.rebuildOffsets();
    this.updateSizer();
    this.resizeSurface();
    this.schedulePaint();
  }

  selectCell(row: number, col: number): void {
    const src = this.source;
    if (!src || row < 0 || row >= src.rowCount || col < 0 || col >= this.widths.length) {
      return;
    }
    this.selMode = "cell";
    this.anchor = { row, col };
    this.cursor = { row, col };
    this.ensureVisibleFor(row, col);
    this.notifySelection();
    this.canvas.focus({ preventScroll: true });
    this.schedulePaint();
  }

  /** The cell's box in client coordinates, clipped to the visible grid; null when scrolled out of view. */
  cellRect(row: number, col: number): { left: number; top: number; right: number; bottom: number } | null {
    const src = this.source;
    if (!src || row < 0 || row >= src.rowCount || col < 0 || col >= this.widths.length) {
      return null;
    }
    const rect = this.canvas.getBoundingClientRect();
    const x = this.gutterW + this.offsets[col] - this.virtualScrollX();
    const y = HEADER_H + row * ROW_H - this.virtualScrollY();
    const left = Math.max(x, this.gutterW);
    const right = Math.min(x + this.widths[col], rect.width);
    const top = Math.max(y, HEADER_H);
    const bottom = Math.min(y + ROW_H, rect.height);
    if (right <= left || bottom <= top) {
      return null;
    }
    return { left: rect.left + left, top: rect.top + top, right: rect.left + right, bottom: rect.top + bottom };
  }

  focus(): void {
    this.canvas.focus({ preventScroll: true });
  }

  destroy(): void {
    this.stopAutoScroll();
    window.clearTimeout(this.holdTimer);
    if (this.editor) {
      this.cancelEdit();
    }
    if (this.disposeUpdates) {
      this.disposeUpdates();
      this.disposeUpdates = null;
    }
    this.ro.disconnect();
    this.bars.destroy();
    this.scroller.removeEventListener("scroll", this.onScroll);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("lostpointercapture", this.onLostCapture);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    this.canvas.removeEventListener("auxclick", this.onAuxClick);
    this.canvas.removeEventListener("dblclick", this.onDblClick);
    this.canvas.removeEventListener("keydown", this.onKeyDown);
    document.removeEventListener("paste", this.onPaste);
    document.fonts.removeEventListener("loadingdone", this.onFontsLoaded);
    this.canvas.removeEventListener("focus", this.onFocus);
    this.canvas.removeEventListener("blur", this.onBlur);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.fitButton.removeEventListener("click", this.onFitClick);
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.source = null;
    this.host.innerHTML = "";
  }

  private gutterFor(rowCount: number): number {
    return Math.round(Math.max(GUTTER_MIN, String(Math.max(1, rowCount)).length * 8 + 24) * SCALE);
  }

  private totalW(): number {
    return this.gutterW + this.offsets[this.offsets.length - 1];
  }

  private totalH(): number {
    const rowCount = this.source ? this.source.rowCount : 0;
    return HEADER_H + rowCount * ROW_H;
  }

  private scaleX(): number {
    const total = this.totalW();
    return total > MAX_SCROLL_PX ? total / MAX_SCROLL_PX : 1;
  }

  private scaleY(): number {
    const total = this.totalH();
    return total > MAX_SCROLL_PX ? total / MAX_SCROLL_PX : 1;
  }

  private virtualScrollX(): number {
    return this.scroller.scrollLeft * this.scaleX();
  }

  private virtualScrollY(): number {
    return this.scroller.scrollTop * this.scaleY();
  }

  private rebuildOffsets(): void {
    const n = this.widths.length;
    const offsets = new Array<number>(n + 1);
    offsets[0] = 0;
    for (let c = 0; c < n; c++) {
      offsets[c + 1] = offsets[c] + this.widths[c];
    }
    this.offsets = offsets;
  }

  private updateSizer(): void {
    const w = Math.max(Math.min(this.totalW(), MAX_SCROLL_PX), this.viewW);
    const h = Math.max(Math.min(this.totalH(), MAX_SCROLL_PX), this.viewH);
    this.sizer.style.width = `${Math.max(0, w)}px`;
    this.sizer.style.height = `${Math.max(0, h)}px`;
    this.layoutListener?.();
  }

  /** Called whenever the columns or the view change size. */
  setLayoutListener(listener: (() => void) | null): void {
    this.layoutListener = listener;
  }

  /** Called after the arrow (or page) keys move the cursor to a row. */
  setKeyMoveListener(listener: ((row: number) => void) | null): void {
    this.keyMoveListener = listener;
  }

  /** The sideways scrollbar's height, 0 while the columns fit the view. */
  horizontalScrollbar(): number {
    if (this.viewW === 0 || this.totalW() <= this.viewW) {
      return 0;
    }
    return this.scroller.offsetHeight - this.scroller.clientHeight;
  }

  /** A row's top and bottom in client coordinates, whether or not it is in view. */
  rowBounds(row: number): { top: number; bottom: number } {
    const top = this.canvas.getBoundingClientRect().top + HEADER_H + row * ROW_H - this.virtualScrollY();
    return { top, bottom: top + ROW_H };
  }

  private resizeSurface(): void {
    // clientWidth/Height are rounded; flooring the real box keeps the canvas (and the
    // sizer, which is at least the canvas size) from overflowing by a fraction of a pixel.
    const rect = this.scroller.getBoundingClientRect();
    const scroller = this.scroller;
    const cw = Math.floor(rect.width) - (scroller.offsetWidth - scroller.clientWidth);
    const ch = Math.floor(rect.height) - (scroller.offsetHeight - scroller.clientHeight);
    this.viewW = cw > 0 ? cw : 0;
    this.viewH = ch > 0 ? ch : 0;
    if (this.viewW === 0 || this.viewH === 0) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.max(1, Math.round(this.viewW * dpr));
    const ph = Math.max(1, Math.round(this.viewH * dpr));
    if (this.canvas.width !== pw) {
      this.canvas.width = pw;
    }
    if (this.canvas.height !== ph) {
      this.canvas.height = ph;
    }
    this.canvas.style.width = `${this.viewW}px`;
    this.canvas.style.height = `${this.viewH}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private schedulePaint(): void {
    if (this.rafId !== 0) {
      return;
    }
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      this.paint();
    });
  }

  private notifySelection(): void {
    const row = this.selMode === "col" || !this.cursor ? null : this.cursor.row;
    const range = row === null ? null : this.selectionRange();
    const rows = range === null ? null : { from: range.r0, to: range.r1 };
    const key = `${row}:${rows?.from}:${rows?.to}`;
    if (key === this.lastNotified) {
      return;
    }
    this.lastNotified = key;
    if (this.selectionListener) {
      this.selectionListener(row, rows);
    }
  }

  private sortAt(col: number): SortIndicator | null {
    for (const sort of this.sortColumns) {
      if (sort.columnIndex === col) {
        return sort;
      }
    }
    return null;
  }

  private selectionRange(): SelRange | null {
    const src = this.source;
    const a = this.anchor;
    const cur = this.cursor;
    if (!src || !a || !cur || src.rowCount === 0 || this.widths.length === 0) {
      return null;
    }
    const lastRow = src.rowCount - 1;
    const lastCol = this.widths.length - 1;
    if (this.selMode === "row") {
      const r0 = Math.min(a.row, cur.row);
      const r1 = Math.max(a.row, cur.row);
      return { r0: clamp(r0, 0, lastRow), r1: clamp(r1, 0, lastRow), c0: 0, c1: lastCol };
    }
    if (this.selMode === "col") {
      const c0 = Math.min(a.col, cur.col);
      const c1 = Math.max(a.col, cur.col);
      return { r0: 0, r1: lastRow, c0: clamp(c0, 0, lastCol), c1: clamp(c1, 0, lastCol) };
    }
    const r0 = Math.min(a.row, cur.row);
    const r1 = Math.max(a.row, cur.row);
    const c0 = Math.min(a.col, cur.col);
    const c1 = Math.max(a.col, cur.col);
    return {
      r0: clamp(r0, 0, lastRow),
      r1: clamp(r1, 0, lastRow),
      c0: clamp(c0, 0, lastCol),
      c1: clamp(c1, 0, lastCol),
    };
  }

  private firstVisibleCol(virtualX: number): number {
    const n = this.widths.length;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.offsets[mid] + this.widths[mid] <= virtualX) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  // The list a cell offers, when it can be edited and has one.
  private choicesAt(row: number, col: number): CellChoices | null {
    const handlers = this.editable;
    if (!handlers || !handlers.choices) {
      return null;
    }
    if (handlers.canEdit && !handlers.canEdit(row, col)) {
      return null;
    }
    const choices = handlers.choices(row, col);
    return choices !== null && choices.options.length > 0 ? choices : null;
  }

  private canEditCell(row: number, col: number): boolean {
    const handlers = this.editable;
    return handlers !== null && (!handlers.canEdit || handlers.canEdit(row, col));
  }

  // The button a cell shows: → on a foreign key with a value, ⌃⌄ on a cell
  // with a list, ⌃⌄ on an editable date.
  private accessoryAt(row: number, col: number, value: unknown): CellAccessory | null {
    // A row marked for deletion, or a new row's DEFAULT, shows no button.
    const src = this.source;
    if (src?.rowState?.(row) === "deleted" || src?.cellState?.(row, col) === "default") {
      return null;
    }
    const spec = this.specs?.[col] ?? null;
    if (spec?.link && this.accessoryHandler && value !== null && value !== undefined) {
      return "link";
    }
    if (this.choicesAt(row, col) !== null) {
      return "choices";
    }
    if (spec !== null && isDateKind(spec.kind) && this.accessoryHandler && this.canEditCell(row, col)) {
      return "date";
    }
    return null;
  }

  // The button under a point of a cell, if the point is on it.
  private accessoryUnder(localX: number, row: number, col: number): CellAccessory | null {
    const right = this.gutterW + this.offsets[col] + this.widths[col] - this.virtualScrollX();
    if (localX < right - CELL_PAD - ACCESSORY_W) {
      return null;
    }
    return this.accessoryAt(row, col, this.source?.cell(row, col));
  }

  private paintLinkMark(x: number, y: number, ink: string): void {
    const ctx = this.ctx;
    const cy = Math.round(y) + 0.5;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x - 4, cy);
    ctx.lineTo(x + 4, cy);
    ctx.moveTo(x + 1, cy - 3);
    ctx.lineTo(x + 4, cy);
    ctx.lineTo(x + 1, cy + 3);
    ctx.stroke();
  }

  private paintChoiceMark(x: number, y: number, ink: string): void {
    const ctx = this.ctx;
    const cx = Math.round(x) + 0.5;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cx - 3, y - 1.5);
    ctx.lineTo(cx, y - 4.5);
    ctx.lineTo(cx + 3, y - 1.5);
    ctx.moveTo(cx - 3, y + 1.5);
    ctx.lineTo(cx, y + 4.5);
    ctx.lineTo(cx + 3, y + 1.5);
    ctx.stroke();
  }

  private textInk(v: unknown, colorsEnabled: boolean, column: CellKind | undefined): string {
    if (v === null) {
      return palette.nullInk;
    }
    const kind = classifyCell(v, column);
    if (!colorsEnabled) {
      if (kind === "boolean") {
        return palette.warn;
      }
      if (typeof v === "number" || typeof v === "bigint") {
        return palette.accent;
      }
      return palette.ink;
    }
    return kind === null ? palette.ink : palette.typeInks[kind];
  }

  private fitText(text: string, maxWidth: number): string {
    if (maxWidth <= 0) {
      return "";
    }
    // Twice an ASCII width covers wide (CJK) characters: short text needs no measuring.
    if (this.charW > 0 && text.length * this.charW * 2 <= maxWidth) {
      return text;
    }
    if (this.ctx.measureText(text).width <= maxWidth) {
      return text;
    }
    const suffix = "…";
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.ctx.measureText(text.slice(0, mid) + suffix).width <= maxWidth) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo > 0 ? text.slice(0, lo) + suffix : "";
  }

  private cellText(v: unknown): string {
    if (typeof v === "string") {
      return v;
    }
    if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
      return String(v);
    }
    try {
      const s = JSON.stringify(v);
      return s === undefined ? String(v) : s;
    } catch {
      return String(v);
    }
  }

  private paint(): void {
    if (this.source === null && this.holdUntil > performance.now()) {
      return;
    }
    const ctx = this.ctx;
    const w = this.viewW;
    const h = this.viewH;
    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, w, h);

    const src = this.source;
    if (!src || w === 0 || h === 0) {
      return;
    }

    const virtualX = this.virtualScrollX();
    const virtualY = this.virtualScrollY();
    const gutterW = this.gutterW;
    const contentW = Math.max(0, w - gutterW);
    const contentH = Math.max(0, h - HEADER_H);
    const rowCount = src.rowCount;
    const colCount = this.widths.length;
    const first = Math.max(0, Math.floor(virtualY / ROW_H));
    const last = Math.min(rowCount - 1, Math.floor((virtualY + contentH) / ROW_H));
    const sel = this.selectionRange();
    const selFill = this.focused ? palette.selFillFocus : palette.selFill;
    const startCol = this.firstVisibleCol(virtualX);
    let endCol = startCol;
    while (endCol < colCount && gutterW + this.offsets[endCol] - virtualX < w) {
      endCol++;
    }
    const settings = getSettings();
    const colorsEnabled = settings.typeColors;
    const rowAlt = settings.rowAlt;
    const rowStateOf = src.rowState ? (r: number) => src.rowState!(r) : null;
    const cellStateOf = src.cellState ? (r: number, c: number) => src.cellState!(r, c) : null;
    const rowStates: RowState[] = [];

    for (let r = first; r <= last; r++) {
      const y = HEADER_H + r * ROW_H - virtualY;
      const state = rowStateOf ? rowStateOf(r) : null;
      rowStates.push(state);
      if (rowAlt && (r & 1) === 1) {
        ctx.fillStyle = palette.rowAlt;
        ctx.fillRect(0, y, w, ROW_H);
      }
      if (state === "inserted" || state === "deleted") {
        ctx.globalAlpha = STATE_ALPHA;
        ctx.fillStyle = state === "inserted" ? palette.ok : palette.error;
        ctx.fillRect(gutterW, y, contentW, ROW_H);
        ctx.globalAlpha = 1;
      }
      if (r === this.hoverRow) {
        ctx.fillStyle = palette.hoverFill;
        ctx.fillRect(0, y, w, ROW_H);
      }
      for (let c = startCol; c < endCol; c++) {
        const x = gutterW + this.offsets[c] - virtualX;
        const cw = this.widths[c];
        const fx = Math.max(x, gutterW);
        const fw = Math.min(x + cw, w) - fx;
        if (fw <= 0) {
          continue;
        }
        if (state === "edited" && cellStateOf && cellStateOf(r, c) === "edited") {
          ctx.globalAlpha = EDIT_ALPHA;
          ctx.fillStyle = palette.warn;
          ctx.fillRect(fx, y, fw, ROW_H);
          ctx.globalAlpha = 1;
        }
        if (sel && r >= sel.r0 && r <= sel.r1 && c >= sel.c0 && c <= sel.c1) {
          ctx.fillStyle = selFill;
          ctx.fillRect(fx, y, fw, ROW_H);
        }
      }
    }

    // Text is clipped once per column; slicing bounds the cost of very long
    // values, and what still overflows ends in an ellipsis, as in TablePlus.
    ctx.textBaseline = "middle";
    ctx.font = FONT;
    if (this.charW === 0) {
      this.charW = ctx.measureText("0").width;
    }
    const inkOf = src.cellInk ? (r: number, c: number) => src.cellInk!(r, c) : null;
    const exprOf = src.cellExpr ? (r: number, c: number) => src.cellExpr!(r, c) : null;
    for (let c = startCol; c < endCol; c++) {
      const x = gutterW + this.offsets[c] - virtualX;
      const cw = this.widths[c];
      if (x + cw <= gutterW) {
        continue;
      }
      const maxChars = Math.ceil(cw / MIN_CHAR_W) + 1;
      const spec = this.specs?.[c] ?? null;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, HEADER_H, cw, contentH);
      ctx.clip();
      for (let r = first; r <= last; r++) {
        const v = src.cell(r, c);
        if (v === undefined) {
          continue;
        }
        const y = HEADER_H + r * ROW_H - virtualY + ROW_H / 2;
        const state = rowStates[r - first];
        // A new row's DEFAULT, or a DEFAULT or NOW() staged for the database
        // to write: faint, as TablePlus shows them until saved.
        const label =
          cellStateOf && state === "inserted" && cellStateOf(r, c) === "default"
            ? "DEFAULT"
            : (exprOf?.(r, c) ?? null);
        if (label !== null) {
          ctx.fillStyle = palette.faint;
          ctx.textAlign = "left";
          ctx.fillText(this.fitText(label, cw - CELL_PAD * 2), x + CELL_PAD, y);
          continue;
        }
        const accessory = state === "deleted" ? null : this.accessoryAt(r, c, v);
        const room = cw - CELL_PAD * 2 - (accessory !== null ? ACCESSORY_W : 0);
        if (v === null) {
          // NULL sits faint in the middle of its cell, as in TablePlus.
          ctx.fillStyle = state === "deleted" ? palette.faint : palette.nullInk;
          ctx.textAlign = "center";
          ctx.fillText(this.fitText("NULL", room), x + CELL_PAD + room / 2, y);
        } else {
          let text = this.cellText(v);
          const right = typeof v === "number";
          if (text.length > maxChars) {
            text = text.slice(0, maxChars);
          }
          text = this.fitText(text, room);
          const ink = inkOf === null ? null : inkOf(r, c);
          ctx.fillStyle =
            state === "deleted"
              ? palette.faint
              : (ink ?? (spec?.pk && colorsEnabled ? palette.error : this.textInk(v, colorsEnabled, spec?.kind)));
          ctx.textAlign = right ? "right" : "left";
          ctx.fillText(text, right ? x + CELL_PAD + room : x + CELL_PAD, y);
        }
        if (accessory !== null) {
          const lit =
            r === this.hoverRow || (this.cursor !== null && this.cursor.row === r && this.cursor.col === c);
          const markInk = lit ? palette.muted : palette.faint;
          if (accessory === "link") {
            this.paintLinkMark(x + cw - CELL_PAD - 4, y, markInk);
          } else {
            this.paintChoiceMark(x + cw - CELL_PAD - 4, y, markInk);
          }
        }
      }
      ctx.restore();
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(gutterW, HEADER_H, contentW, contentH);
    ctx.clip();
    ctx.strokeStyle = palette.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let r = first; r <= last; r++) {
      const y = Math.round(HEADER_H + (r + 1) * ROW_H - virtualY) + 0.5;
      ctx.moveTo(gutterW, y);
      ctx.lineTo(w, y);
    }
    for (let c = startCol; c < endCol; c++) {
      const bx = gutterW + this.offsets[c] + this.widths[c] - virtualX;
      if (bx < gutterW) {
        continue;
      }
      const lx = Math.round(bx) + 0.5;
      ctx.moveTo(lx, HEADER_H);
      ctx.lineTo(lx, h);
    }
    ctx.stroke();
    const rowEnd = Math.min(w, gutterW + this.offsets[colCount] - virtualX);
    ctx.strokeStyle = palette.error;
    ctx.beginPath();
    for (let r = first; r <= last; r++) {
      if (rowStates[r - first] === "deleted") {
        const y = Math.round(HEADER_H + r * ROW_H - virtualY + ROW_H / 2) + 0.5;
        ctx.moveTo(gutterW, y);
        ctx.lineTo(rowEnd, y);
      }
    }
    ctx.globalAlpha = 0.55;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();

    ctx.fillStyle = palette.head;
    ctx.fillRect(0, HEADER_H, gutterW, contentH);
    ctx.font = FONT;
    ctx.textAlign = "right";
    const numX = gutterW - CELL_PAD;
    for (let r = first; r <= last; r++) {
      const y = HEADER_H + r * ROW_H - virtualY;
      const inSel = sel !== null && r >= sel.r0 && r <= sel.r1;
      if (inSel) {
        ctx.fillStyle = selFill;
        ctx.fillRect(0, y, gutterW, ROW_H);
      }
      const state = rowStates[r - first];
      ctx.fillStyle =
        state === "inserted"
          ? palette.ok
          : state === "deleted"
            ? palette.error
            : state === "edited"
              ? palette.warn
              : r === this.hoverRow || inSel
                ? palette.accent
                : palette.faint;
      ctx.fillText(state === "inserted" ? "+" : String(r + 1), numX, y + ROW_H / 2);
    }
    ctx.strokeStyle = palette.line;
    ctx.lineWidth = 1;
    const gx = Math.round(gutterW) - 0.5;
    ctx.beginPath();
    ctx.moveTo(gx, HEADER_H);
    ctx.lineTo(gx, h);
    ctx.stroke();

    ctx.fillStyle = palette.head;
    ctx.fillRect(0, 0, w, HEADER_H);
    ctx.font = FONT_HEADER;
    ctx.textAlign = "center";
    ctx.save();
    ctx.beginPath();
    ctx.rect(gutterW, 0, contentW, HEADER_H);
    ctx.clip();
    for (let c = startCol; c < colCount; c++) {
      const x = gutterW + this.offsets[c] - virtualX;
      if (x >= w) {
        break;
      }
      const cw = this.widths[c];
      if (x + cw <= gutterW) {
        continue;
      }
      if (this.selMode === "col" && sel && c >= sel.c0 && c <= sel.c1) {
        ctx.fillStyle = selFill;
        const fx = Math.max(x, gutterW);
        const fw = Math.min(x + cw, w) - fx;
        if (fw > 0) {
          ctx.fillRect(fx, 0, fw, HEADER_H);
        }
      }
      const sort = this.sortAt(c);
      // Headers sit in the middle of their column, clear of the sort arrow on
      // the right. A name too wide to stay centred past it moves left into
      // the arrow's mirror room before it is cut short.
      const room = Math.max(0, cw - CELL_PAD * 2 - (sort ? SORT_W : 0));
      const name = src.columns[c];
      const centred = !sort || ctx.measureText(name).width <= room - SORT_W;
      const textLeft = x + CELL_PAD + (sort && centred ? SORT_W : 0);
      const textW = sort && centred ? room - SORT_W : room;
      ctx.save();
      ctx.beginPath();
      ctx.rect(textLeft, 0, textW, HEADER_H);
      ctx.clip();
      ctx.fillStyle = sort ? palette.accent : palette.ink;
      ctx.fillText(this.fitText(name, textW), textLeft + textW / 2, HEADER_H / 2);
      ctx.restore();
      if (sort) {
        const ax = x + cw - CELL_PAD - 7;
        const cy = HEADER_H / 2;
        ctx.fillStyle = palette.accent;
        ctx.beginPath();
        if (sort.dir === "asc") {
          ctx.moveTo(ax, cy + 2.5);
          ctx.lineTo(ax + 7, cy + 2.5);
          ctx.lineTo(ax + 3.5, cy - 3.5);
        } else {
          ctx.moveTo(ax, cy - 2.5);
          ctx.lineTo(ax + 7, cy - 2.5);
          ctx.lineTo(ax + 3.5, cy + 3.5);
        }
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.strokeStyle = palette.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = startCol; c < colCount; c++) {
      const bx = gutterW + this.offsets[c] + this.widths[c] - virtualX;
      if (bx > w) {
        break;
      }
      if (bx < gutterW) {
        continue;
      }
      const lx = Math.round(bx) + 0.5;
      ctx.moveTo(lx, 0);
      ctx.lineTo(lx, HEADER_H);
    }
    ctx.stroke();
    ctx.restore();

    if (this.hoverColEdge !== null && this.hoverColEdge < colCount) {
      const bx = gutterW + this.offsets[this.hoverColEdge] + this.widths[this.hoverColEdge] - virtualX;
      const lx = Math.round(bx);
      if (lx >= gutterW && lx <= w) {
        ctx.fillStyle = palette.selLine;
        ctx.fillRect(lx - 1, 0, 2, HEADER_H);
      }
    }

    ctx.fillStyle = palette.head;
    ctx.fillRect(0, 0, gutterW, HEADER_H);
    ctx.fillStyle = palette.line;
    ctx.fillRect(0, HEADER_H - 1, w, 1);
    ctx.fillRect(Math.round(gutterW) - 1, 0, 1, HEADER_H);

    if (sel) {
      const x0 = gutterW + this.offsets[sel.c0] - virtualX;
      const x1 = gutterW + this.offsets[sel.c1] + this.widths[sel.c1] - virtualX;
      const y0 = HEADER_H + sel.r0 * ROW_H - virtualY;
      const y1 = HEADER_H + (sel.r1 + 1) * ROW_H - virtualY;
      let left = x0;
      let top = y0;
      let clipX = gutterW;
      let clipY = HEADER_H;
      let clipW = contentW;
      let clipH = contentH;
      if (this.selMode === "row") {
        left = 0;
        clipX = 0;
        clipW = w;
      } else if (this.selMode === "col") {
        top = 0;
        clipY = 0;
        clipH = h;
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(clipX, clipY, clipW, clipH);
      ctx.clip();
      ctx.strokeStyle = palette.selLine;
      ctx.lineWidth = 1;
      ctx.strokeRect(
        Math.round(left) + 0.5,
        Math.round(top) + 0.5,
        Math.max(0, Math.round(x1) - Math.round(left) - 1),
        Math.max(0, Math.round(y1) - Math.round(top) - 1),
      );
      ctx.restore();
    }
  }

  private localPos(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private hitRow(localY: number): number | null {
    const src = this.source;
    if (!src || localY < HEADER_H) {
      return null;
    }
    const r = Math.floor((this.virtualScrollY() + localY - HEADER_H) / ROW_H);
    return r >= 0 && r < src.rowCount ? r : null;
  }

  private hitCol(localX: number): number | null {
    const n = this.widths.length;
    if (n === 0 || localX < this.gutterW) {
      return null;
    }
    const vx = localX - this.gutterW + this.virtualScrollX();
    let lo = 0;
    let hi = n - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.offsets[mid] <= vx) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (ans < 0) {
      return null;
    }
    return this.offsets[ans] + this.widths[ans] > vx ? ans : null;
  }

  private hitRowClamped(localY: number): number {
    const src = this.source;
    if (!src || src.rowCount === 0) {
      return 0;
    }
    const r = Math.floor((this.virtualScrollY() + localY - HEADER_H) / ROW_H);
    return clamp(r, 0, src.rowCount - 1);
  }

  private hitColClamped(localX: number): number {
    const n = this.widths.length;
    if (n === 0) {
      return 0;
    }
    const vx = localX - this.gutterW + this.virtualScrollX();
    if (vx <= 0) {
      return 0;
    }
    let lo = 0;
    let hi = n - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.offsets[mid] <= vx) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  private colEdgeAt(localX: number): number | null {
    if (localX < this.gutterW) {
      return null;
    }
    const virtualX = this.virtualScrollX();
    const vx = localX - this.gutterW + virtualX;
    const start = this.firstVisibleCol(virtualX);
    for (let c = start; c < this.widths.length; c++) {
      const bx = this.offsets[c] + this.widths[c];
      if (bx < vx - RESIZE_GRIP) {
        continue;
      }
      if (bx > vx + RESIZE_GRIP) {
        break;
      }
      return c;
    }
    return null;
  }

  private ensureVisible(): void {
    const cur = this.cursor;
    if (!cur) {
      return;
    }
    this.ensureVisibleFor(cur.row, cur.col);
  }

  private ensureVisibleFor(row: number, col: number): void {
    if (!this.source) {
      return;
    }
    const virtualX = this.virtualScrollX();
    const virtualY = this.virtualScrollY();
    const contentW = Math.max(0, this.viewW - this.gutterW);
    const contentH = Math.max(0, this.viewH - HEADER_H);
    const x0 = this.gutterW + this.offsets[col] - virtualX;
    const x1 = x0 + this.widths[col];
    const y0 = HEADER_H + row * ROW_H - virtualY;
    const y1 = y0 + ROW_H;
    let nextTop: number | null = null;
    if (y0 < HEADER_H) {
      nextTop = virtualY + y0 - HEADER_H;
    } else if (y1 > HEADER_H + contentH) {
      nextTop = virtualY + y1 - (HEADER_H + contentH);
    }
    let nextLeft: number | null = null;
    if (x0 < this.gutterW) {
      nextLeft = virtualX + x0 - this.gutterW;
    } else if (x1 > this.gutterW + contentW) {
      nextLeft = virtualX + x1 - (this.gutterW + contentW);
    }
    if (nextTop !== null) {
      this.scroller.scrollTop = Math.max(0, nextTop / this.scaleY());
    }
    if (nextLeft !== null) {
      this.scroller.scrollLeft = Math.max(0, nextLeft / this.scaleX());
    }
  }

  private selectAll(): void {
    const src = this.source;
    if (!src || src.rowCount === 0 || this.widths.length === 0) {
      return;
    }
    this.selMode = "cell";
    this.anchor = { row: 0, col: 0 };
    this.cursor = { row: src.rowCount - 1, col: this.widths.length - 1 };
    this.notifySelection();
    this.schedulePaint();
  }

  // ⌘C: the selected cells as tab-separated text (rows not loaded yet come
  // out empty).
  copySelection(): void {
    const src = this.source;
    const sel = this.selectionRange();
    if (!src || !sel) {
      return;
    }
    const lastRow = Math.min(sel.r1, sel.r0 + COPY_MAX_ROWS - 1);
    const rows: unknown[][] = [];
    for (let r = sel.r0; r <= lastRow; r++) {
      const cells: unknown[] = [];
      for (let c = sel.c0; c <= sel.c1; c++) {
        cells.push(src.cell(r, c));
      }
      rows.push(cells);
    }
    const text = toPlainText(rows);
    lastCellCopy = rows.length === 1 && rows[0].length === 1 ? text : null;
    const clip = navigator.clipboard;
    if (clip) {
      clip.writeText(text).catch(() => this.copyFallback(text));
    } else {
      this.copyFallback(text);
    }
  }

  private copyFallback(text: string): void {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.left = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand("copy");
    } finally {
      document.body.removeChild(ta);
    }
  }

  private startEdit(row: number, col: number): void {
    const src = this.source;
    if (!src || !this.editable || this.editor) {
      return;
    }
    if (row < 0 || row >= src.rowCount || col < 0 || col >= this.widths.length) {
      return;
    }
    if (this.editable.canEdit && !this.editable.canEdit(row, col)) {
      return;
    }
    const raw = src.cell(row, col);
    const choices = this.choicesAt(row, col);
    const input = document.createElement("input");
    input.type = "text";
    input.className = "cell-editor";
    input.spellcheck = false;
    input.value = raw === null || raw === undefined ? "" : this.cellText(raw);
    const initial = input.value;
    input.style.textAlign = typeof raw === "number" ? "right" : "left";
    input.style.left = `${this.gutterW + this.offsets[col] - this.virtualScrollX()}px`;
    input.style.top = `${HEADER_H + row * ROW_H - this.virtualScrollY()}px`;
    input.style.width = `${this.widths[col]}px`;
    input.style.height = `${ROW_H}px`;
    // A strict cell is picked from its list, like a select.
    input.readOnly = choices?.strict === true;
    const current = choices === null ? -1 : choices.options.indexOf(initial);
    this.editor = {
      input,
      row,
      col,
      initial,
      scrollLeft: this.scroller.scrollLeft,
      scrollTop: this.scroller.scrollTop,
      choices,
      menu: null,
      shown: [],
      // The current value starts highlighted, unless a pick adds to the text;
      // a value the list doesn't hold (NULL, say) highlights nothing, so
      // Return keeps it rather than picking the first entry.
      active: choices === null || choices.pick ? -1 : current,
      typed: false,
    };
    this.selMode = "cell";
    this.anchor = { row, col };
    this.cursor = { row, col };
    this.notifySelection();
    input.addEventListener("keydown", this.onEditorKeyDown);
    input.addEventListener("blur", this.onEditorBlur);
    input.addEventListener("input", this.onEditorInput);
    this.host.appendChild(input);
    input.focus();
    if (!input.readOnly) {
      input.select();
    }
    if (choices !== null) {
      this.openMenu();
    }
    this.schedulePaint();
  }

  private openMenu(): void {
    const ed = this.editor;
    if (!ed) {
      return;
    }
    const menu = document.createElement("div");
    menu.className = "cell-menu";
    // Clicks in the list keep the editor focused, so it doesn't commit early.
    menu.addEventListener("mousedown", (e) => e.preventDefault());
    // The pointer only highlights (CSS :hover); Enter keeps the typed text or
    // the option picked with the arrow keys.
    menu.addEventListener("click", this.onMenuClick);
    document.body.appendChild(menu);
    ed.menu = menu;
    window.addEventListener("scroll", this.placeMenu, true);
    window.addEventListener("resize", this.placeMenu);
    this.renderMenu();
  }

  private closeMenu(ed: EditState): void {
    if (ed.menu === null) {
      return;
    }
    ed.menu.remove();
    ed.menu = null;
    window.removeEventListener("scroll", this.placeMenu, true);
    window.removeEventListener("resize", this.placeMenu);
  }

  private renderMenu(): void {
    const ed = this.editor;
    if (!ed || !ed.menu || !ed.choices) {
      return;
    }
    const { options, strict, query } = ed.choices;
    let shown = options;
    if (!strict && ed.typed) {
      const needle = (query ? query(ed.input.value) : ed.input.value).trim().toLowerCase();
      if (needle !== "") {
        shown = options.filter((option) => option.toLowerCase().includes(needle));
      }
    }
    ed.shown = shown.slice(0, MENU_MAX_ITEMS);
    if (ed.active >= ed.shown.length) {
      ed.active = -1;
    }
    ed.menu.replaceChildren(
      ...ed.shown.map((option, index) => {
        const item = document.createElement("button");
        item.type = "button";
        item.tabIndex = -1;
        item.textContent = option;
        item.dataset.index = String(index);
        if (index === ed.active) {
          item.className = "active";
        }
        return item;
      }),
    );
    ed.menu.hidden = ed.shown.length === 0;
    this.placeMenu();
    this.revealActive();
  }

  private markActive(): void {
    const ed = this.editor;
    if (!ed || !ed.menu) {
      return;
    }
    ed.menu.querySelectorAll("button").forEach((item, index) => {
      item.classList.toggle("active", index === ed.active);
    });
  }

  private revealActive(): void {
    const item = this.editor?.menu?.children[this.editor.active];
    if (item instanceof HTMLElement) {
      item.scrollIntoView({ block: "nearest" });
    }
  }

  // Below the cell, or above it when the window has no room underneath.
  private readonly placeMenu = (): void => {
    const ed = this.editor;
    if (!ed || !ed.menu || ed.menu.hidden) {
      return;
    }
    const rect = ed.input.getBoundingClientRect();
    const width = Math.max(rect.width, 160);
    const style = ed.menu.style;
    style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    style.minWidth = `${width}px`;
    const below = window.innerHeight - rect.bottom - 10;
    if (below < Math.min(MENU_MAX_H, 160) && rect.top > below) {
      style.top = "";
      style.bottom = `${window.innerHeight - rect.top + 2}px`;
      style.maxHeight = `${Math.min(MENU_MAX_H, rect.top - 10)}px`;
    } else {
      style.bottom = "";
      style.top = `${rect.bottom + 2}px`;
      style.maxHeight = `${Math.min(MENU_MAX_H, below)}px`;
    }
  };

  private readonly onMenuClick = (e: MouseEvent): void => {
    const ed = this.editor;
    const item = e.target instanceof Element ? e.target.closest("button") : null;
    if (!ed || !item) {
      return;
    }
    const option = ed.shown[Number(item.dataset.index)];
    if (option !== undefined) {
      this.pickOption(option);
    }
  };

  private pickOption(option: string): void {
    const ed = this.editor;
    if (!ed) {
      return;
    }
    ed.input.value = ed.choices?.pick ? ed.choices.pick(ed.input.value, option) : option;
    this.commitEdit();
  }

  private readonly onEditorInput = (): void => {
    const ed = this.editor;
    if (!ed || !ed.choices) {
      return;
    }
    ed.typed = true;
    ed.active = -1;
    this.renderMenu();
  };

  // Up and Down walk the list; Enter takes the highlighted option. In a strict
  // cell the value follows the highlight, and a letter jumps to an option.
  private menuKey(e: KeyboardEvent): boolean {
    const ed = this.editor;
    if (!ed || !ed.menu || ed.shown.length === 0) {
      return false;
    }
    const strict = ed.choices?.strict === true;
    const count = ed.shown.length;
    let next: number | null = null;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const down = e.key === "ArrowDown";
      next = ed.active < 0 ? (down ? 0 : count - 1) : (ed.active + (down ? 1 : -1) + count) % count;
    } else if (strict && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const letter = e.key.toLowerCase();
      const from = ed.active + 1;
      for (let step = 0; step < count && next === null; step++) {
        const index = (from + step) % count;
        if (ed.shown[index].toLowerCase().startsWith(letter)) {
          next = index;
        }
      }
      if (next === null) {
        return false;
      }
    } else if (e.key === "Enter" && ed.active >= 0 && ed.active < count) {
      e.preventDefault();
      this.pickOption(ed.shown[ed.active]);
      return true;
    } else {
      return false;
    }
    e.preventDefault();
    ed.active = next;
    if (strict) {
      ed.input.value = ed.shown[next];
    }
    this.markActive();
    this.revealActive();
    return true;
  }

  private endEdit(): void {
    const ed = this.editor;
    if (!ed) {
      return;
    }
    this.editor = null;
    this.closeMenu(ed);
    ed.input.removeEventListener("keydown", this.onEditorKeyDown);
    ed.input.removeEventListener("blur", this.onEditorBlur);
    ed.input.removeEventListener("input", this.onEditorInput);
    if (ed.input.parentNode) {
      ed.input.parentNode.removeChild(ed.input);
    }
  }

  // `refocus` keeps the keyboard in the grid; a blur toward another control
  // must not pull focus back from it.
  private commitEdit(refocus = true): void {
    const ed = this.editor;
    if (!ed) {
      return;
    }
    const value = ed.input.value;
    const row = ed.row;
    const col = ed.col;
    this.endEdit();
    if (this.editable && value !== ed.initial) {
      this.editable.onCommit(row, col, value === "" ? null : value);
    }
    if (refocus) {
      this.canvas.focus({ preventScroll: true });
    }
  }

  private cancelEdit(): void {
    if (!this.editor) {
      return;
    }
    const handlers = this.editable;
    this.endEdit();
    if (handlers && handlers.onCancel) {
      handlers.onCancel();
    }
    this.canvas.focus({ preventScroll: true });
  }

  private commitEditAndStep(dir: 1 | -1): void {
    const ed = this.editor;
    if (!ed) {
      return;
    }
    const row = ed.row;
    const col = ed.col;
    this.commitEdit();
    const src = this.source;
    if (!src) {
      return;
    }
    const colCount = this.widths.length;
    let nextRow = row;
    let nextCol = col + dir;
    if (nextCol >= colCount) {
      nextCol = 0;
      nextRow = row + 1;
    } else if (nextCol < 0) {
      nextCol = colCount - 1;
      nextRow = row - 1;
    }
    if (nextRow < 0 || nextRow >= src.rowCount || nextCol < 0 || nextCol >= colCount) {
      return;
    }
    this.ensureVisibleFor(nextRow, nextCol);
    this.startEdit(nextRow, nextCol);
  }

  private readonly onEditorKeyDown = (e: KeyboardEvent): void => {
    if (!this.editor) {
      return;
    }
    if (e.isComposing || e.keyCode === 229) {
      return;
    }
    if (this.menuKey(e)) {
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      this.commitEdit();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      this.cancelEdit();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      this.commitEditAndStep(e.shiftKey ? -1 : 1);
    }
  };

  // Focus moving to another control (another grid, a button) stays there.
  // With no new focus target (another window, or a click on plain page) it
  // comes back to the grid.
  private readonly onEditorBlur = (e: FocusEvent): void => {
    if (!this.editor) {
      return;
    }
    this.commitEdit(e.relatedTarget === null);
  };

  // Wide enough for the header and the first rows' values, up to `cap`; long
  // values are cut before measuring, since nothing past the cap counts.
  // From `from` on: the rows in view, which are the ones loaded.
  private fitWidth(col: number, cap = COL_MAX, from = 0): number {
    const src = this.source;
    if (!src || col < 0 || col >= this.widths.length) {
      return COL_MIN;
    }
    const maxChars = Math.ceil(cap / MIN_CHAR_W) + 1;
    const ctx = this.ctx;
    ctx.font = FONT_HEADER;
    // The header keeps room for a sort arrow, so sorting never cuts it short.
    let maxW = ctx.measureText(src.columns[col]).width + SORT_W;
    ctx.font = FONT;
    let mark = 0;
    let seen = 0;
    const start = clamp(from, 0, Math.max(0, src.rowCount - 1));
    const end = Math.min(start + 200, src.rowCount);
    for (let r = start; r < end; r++) {
      const v = src.cell(r, col);
      if (v === undefined) {
        continue;
      }
      seen += 1;
      if (mark === 0 && this.accessoryAt(r, col, v) !== null) {
        mark = ACCESSORY_W;
      }
      if (maxW >= cap) {
        continue;
      }
      const full = v === null ? "NULL" : this.cellText(v);
      const tw = ctx.measureText(full.length > maxChars ? full.slice(0, maxChars) : full).width;
      if (tw > maxW) {
        maxW = tw;
      }
    }
    // Nothing loaded to measure: sizing to the header alone would squeeze it.
    if (seen === 0 && end > start) {
      return this.widths[col];
    }
    return Math.round(clamp(maxW + mark + CELL_PAD * 2 + 6, COL_MIN, Math.min(cap, COL_MAX)));
  }

  private autofitColumn(col: number): void {
    if (col < 0 || col >= this.widths.length) {
      return;
    }
    const next = this.fitWidth(col);
    if (next !== this.widths[col]) {
      this.widths[col] = next;
      this.rebuildOffsets();
      this.updateSizer();
      this.resizeSurface();
      this.schedulePaint();
    }
  }

  private readonly onResize = (): void => {
    this.resizeSurface();
    this.updateSizer();
    // The editor stays while its cell is still fully in view (a structure
    // grid grows by a row as one is added); otherwise it would float loose.
    if (this.editor) {
      if (this.editorFits()) {
        this.placeMenu();
      } else {
        this.cancelEdit();
      }
    }
    // A new canvas size clears it; drawing in this same frame (resize
    // observers run before paint) keeps a panel drag from flashing it blank.
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.paint();
  };

  private editorFits(): boolean {
    const ed = this.editor;
    if (!ed) {
      return true;
    }
    const x = this.gutterW + this.offsets[ed.col] - this.virtualScrollX();
    const y = HEADER_H + ed.row * ROW_H - this.virtualScrollY();
    return (
      x >= this.gutterW &&
      y >= HEADER_H &&
      x + this.widths[ed.col] <= this.viewW &&
      y + ROW_H <= this.viewH
    );
  }

  private readonly onSourceUpdate = (): void => {
    // A source that changed its columns in place gets fresh widths.
    const src = this.source;
    if (src !== null && src.columns.length !== this.widths.length) {
      this.widths = src.columns.map(() => Math.round(COL_DEFAULT * SCALE));
      this.autoFit = true;
      this.rebuildOffsets();
      this.updateSizer();
      this.resizeSurface();
    }
    this.fitNewColumns();
    const rowCount = this.source ? this.source.rowCount : 0;
    if (rowCount !== this.knownRowCount) {
      this.knownRowCount = rowCount;
      this.gutterW = this.gutterFor(rowCount);
      this.placeFitButton();
      this.updateSizer();
      if (this.cursor && this.cursor.row >= rowCount) {
        this.selMode = "cell";
        this.anchor = null;
        this.cursor = null;
        this.notifySelection();
      }
    }
    this.schedulePaint();
  };

  private readonly onFontsLoaded = (): void => {
    // Letters were measured in the fallback.
    this.charW = 0;
    this.schedulePaint();
  };

  private readonly onScroll = (): void => {
    const ed = this.editor;
    if (
      ed &&
      (ed.scrollLeft !== this.scroller.scrollLeft || ed.scrollTop !== this.scroller.scrollTop)
    ) {
      this.cancelEdit();
    }
    this.schedulePaint();
  };

  private readonly onFocus = (): void => {
    this.focused = true;
    this.schedulePaint();
  };

  private readonly onBlur = (): void => {
    this.focused = false;
    this.schedulePaint();
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (!e.shiftKey) {
      return;
    }
    e.preventDefault();
    if (!this.source) {
      return;
    }
    this.scroller.scrollLeft += e.deltaY;
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    const src = this.source;
    // ⌃-click on macOS is a right-click: the selection stays for its menu.
    if (!src || e.button !== 0 || (IS_MAC && e.ctrlKey)) {
      return;
    }
    // Read the point first, and focus without scrolling: a grid only partly
    // in view (Structure) must not move under the pointer.
    const p = this.localPos(e);
    this.canvas.focus({ preventScroll: true });
    this.canvas.setPointerCapture(e.pointerId);
    this.pendingHeaderClick = null;
    this.pendingAccessory = null;
    if (p.y < HEADER_H) {
      const edge = this.colEdgeAt(p.x);
      if (edge !== null) {
        this.drag = { kind: "resize", col: edge, startX: e.clientX, startW: this.widths[edge] };
        this.hoverColEdge = edge;
        this.schedulePaint();
        return;
      }
      const col = this.hitCol(p.x);
      if (col === null) {
        return;
      }
      if (this.headerClick && e.button === 0) {
        this.pendingHeaderClick = { col, x: e.clientX, y: e.clientY, shiftKey: e.shiftKey };
        this.drag = { kind: "none" };
        return;
      }
      this.selMode = "col";
      if (e.shiftKey && this.anchor) {
        this.cursor = { row: 0, col };
      } else {
        this.anchor = { row: 0, col };
        this.cursor = { row: 0, col };
      }
      this.drag = { kind: "select" };
      this.notifySelection();
      this.schedulePaint();
      return;
    }
    if (p.x < this.gutterW) {
      const row = this.hitRow(p.y);
      if (row === null) {
        return;
      }
      this.selMode = "row";
      if (e.shiftKey && this.anchor) {
        this.cursor = { row, col: 0 };
      } else {
        this.anchor = { row, col: 0 };
        this.cursor = { row, col: 0 };
      }
      this.drag = { kind: "select" };
      this.notifySelection();
      this.schedulePaint();
      return;
    }
    const row = this.hitRow(p.y);
    const col = this.hitCol(p.x);
    if (row === null || col === null) {
      this.selMode = "cell";
      this.anchor = null;
      this.cursor = null;
      this.drag = { kind: "none" };
      this.notifySelection();
      this.schedulePaint();
      return;
    }
    this.selMode = "cell";
    if (e.shiftKey && this.anchor) {
      this.cursor = { row, col };
    } else {
      this.anchor = { row, col };
      this.cursor = { row, col };
    }
    this.drag = { kind: "select" };
    const accessory = !e.shiftKey && !e.altKey ? this.accessoryUnder(p.x, row, col) : null;
    this.pendingAccessory = accessory !== null ? { row, col, kind: accessory } : null;
    this.notifySelection();
    this.schedulePaint();
    if (e.altKey && this.contextMenuHandler) {
      const menu = this.contextMenuHandler;
      const selection: GridSelection = { mode: "cell", r0: row, r1: row, c0: col, c1: col };
      window.setTimeout(() => menu(row, col, e.clientX, e.clientY, selection), 0);
    }
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.source) {
      return;
    }
    const drag = this.drag;
    if (drag.kind === "resize") {
      const col = drag.col;
      const next = Math.round(clamp(drag.startW + (e.clientX - drag.startX), COL_MIN, COL_MAX));
      if (next !== this.widths[col]) {
        this.widths[col] = next;
        this.rebuildOffsets();
        this.updateSizer();
        this.resizeSurface();
        this.schedulePaint();
      }
      return;
    }
    if (drag.kind === "select") {
      this.dragPoint = { x: e.clientX, y: e.clientY };
      this.extendSelectionTo(e.clientX, e.clientY);
      if (this.autoScrollId === 0) {
        this.autoScrollId = requestAnimationFrame(this.autoScrollTick);
      }
      return;
    }
    if (e.buttons !== 0) {
      return;
    }
    const p = this.localPos(e);
    let row: number | null = null;
    let edge: number | null = null;
    if (p.y < HEADER_H) {
      if (p.x >= this.gutterW) {
        edge = this.colEdgeAt(p.x);
      }
    } else {
      row = this.hitRow(p.y);
    }
    const src = this.source;
    if (src && src.cellTitle) {
      const col = row === null ? null : this.hitCol(p.x);
      const title = row === null || col === null ? undefined : src.cellTitle(row, col);
      if (this.canvas.title !== (title ?? "")) {
        this.canvas.title = title ?? "";
      }
    }
    const hoverCol = row === null || p.x < this.gutterW ? null : this.hitCol(p.x);
    const onButton = row !== null && hoverCol !== null && this.accessoryUnder(p.x, row, hoverCol) !== null;
    const overHeader = p.y < HEADER_H && p.x >= this.gutterW;
    const cursor =
      edge !== null ? "col-resize" : (this.headerClick && overHeader) || onButton ? "pointer" : "default";
    if (this.canvas.style.cursor !== cursor) {
      this.canvas.style.cursor = cursor;
    }
    if (row !== this.hoverRow || edge !== this.hoverColEdge) {
      this.hoverRow = row;
      this.hoverColEdge = edge;
      this.schedulePaint();
    }
  };

  private extendSelectionTo(clientX: number, clientY: number): void {
    const p = this.localPos({ clientX, clientY });
    const row = this.hitRowClamped(p.y);
    const col = this.hitColClamped(p.x);
    if (this.selMode === "row") {
      if (!this.cursor || this.cursor.row !== row) {
        this.cursor = { row, col: 0 };
        this.notifySelection();
        this.schedulePaint();
      }
    } else if (this.selMode === "col") {
      if (!this.cursor || this.cursor.col !== col) {
        this.cursor = { row: 0, col };
        this.notifySelection();
        this.schedulePaint();
      }
    } else if (!this.cursor || this.cursor.row !== row || this.cursor.col !== col) {
      this.cursor = { row, col };
      this.notifySelection();
      this.schedulePaint();
    }
  }

  // Runs every frame while a selection drag sits in an edge zone of the
  // visible cells: scrolls that way and extends the selection with it.
  private readonly autoScrollTick = (): void => {
    this.autoScrollId = 0;
    const point = this.dragPoint;
    if (this.drag.kind !== "select" || point === null) {
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const dx =
      this.selMode === "row" ? 0 : edgeScrollStep(point.x, rect.left + this.gutterW, rect.right);
    const dy =
      this.selMode === "col" ? 0 : edgeScrollStep(point.y, rect.top + HEADER_H, rect.bottom);
    if (dx === 0 && dy === 0) {
      return;
    }
    const before = this.scroller.scrollLeft + this.scroller.scrollTop;
    this.scroller.scrollLeft += dx;
    this.scroller.scrollTop += dy;
    // At the end of the content there is nothing left to scroll; the next
    // pointer move starts the loop again if it can go on.
    if (this.scroller.scrollLeft + this.scroller.scrollTop === before) {
      return;
    }
    this.extendSelectionTo(point.x, point.y);
    this.autoScrollId = requestAnimationFrame(this.autoScrollTick);
  };

  private stopAutoScroll(): void {
    if (this.autoScrollId !== 0) {
      cancelAnimationFrame(this.autoScrollId);
      this.autoScrollId = 0;
    }
    this.dragPoint = null;
  }

  // Capture can go away without a pointerup (the window loses focus, say);
  // the drag ends there too.
  private readonly onLostCapture = (): void => {
    this.stopAutoScroll();
    if (this.drag.kind === "select") {
      this.drag = { kind: "none" };
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    this.stopAutoScroll();
    if (this.canvas.hasPointerCapture(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }
    const pending = this.pendingHeaderClick;
    if (pending) {
      this.pendingHeaderClick = null;
      const dx = Math.abs(e.clientX - pending.x);
      const dy = Math.abs(e.clientY - pending.y);
      if (dx <= CLICK_SLOP && dy <= CLICK_SLOP && this.headerClick) {
        this.headerClick(pending.col, { shiftKey: pending.shiftKey });
      }
    }
    if (this.drag.kind !== "none") {
      this.drag = { kind: "none" };
    }
    const pressed = this.pendingAccessory;
    this.pendingAccessory = null;
    const a = this.anchor;
    const cur = this.cursor;
    if (
      pressed !== null &&
      a !== null &&
      cur !== null &&
      a.row === pressed.row &&
      a.col === pressed.col &&
      cur.row === pressed.row &&
      cur.col === pressed.col
    ) {
      if (pressed.kind === "choices") {
        this.startEdit(pressed.row, pressed.col);
      } else {
        this.accessoryHandler?.(pressed.kind, pressed.row, pressed.col);
      }
    }
  };

  private readonly onAuxClick = (e: MouseEvent): void => {
    if (e.button !== 1 || !this.source || !this.cellQuickLook) {
      return;
    }
    const p = this.localPos(e);
    const row = this.hitRow(p.y);
    const col = this.hitCol(p.x);
    if (row === null || col === null) {
      return;
    }
    e.preventDefault();
    this.selMode = "cell";
    this.anchor = { row, col };
    this.cursor = { row, col };
    this.notifySelection();
    this.schedulePaint();
    this.cellQuickLook(row, col);
  };

  // A right-click inside the selection (a block of cells, whole rows, whole
  // columns) keeps it, so the menu acts on all of it; one outside selects the
  // cell clicked.
  private readonly onContextMenu = (e: MouseEvent): void => {
    if (!this.source || !this.contextMenuHandler) {
      return;
    }
    const p = this.localPos(e);
    const row = this.hitRow(p.y);
    const col = this.hitCol(p.x);
    if (row === null || col === null) {
      return;
    }
    e.preventDefault();
    const sel = this.selectionRange();
    const inside = sel !== null && row >= sel.r0 && row <= sel.r1 && col >= sel.c0 && col <= sel.c1;
    if (!inside) {
      this.selMode = "cell";
      this.anchor = { row, col };
      this.cursor = { row, col };
      this.notifySelection();
      this.schedulePaint();
    }
    const selection = this.selection() ?? { mode: "cell", r0: row, r1: row, c0: col, c1: col };
    this.contextMenuHandler(row, col, e.clientX, e.clientY, selection);
  };

  // ⌘V: the clipboard's text over the cells from the selection's top-left
  // corner, rightward and downward, each field staged as an edit through the
  // grid's editing handlers (and so their rules). Rows pasted over as many
  // whole rows selected, with a field per column, are added as new rows
  // instead, when the owner takes them.
  private readonly onPaste = (e: ClipboardEvent): void => {
    const src = this.source;
    const handlers = this.editable;
    const sel = this.selectionRange();
    if (document.activeElement !== this.canvas || e.defaultPrevented || !src || !handlers || !sel) {
      return;
    }
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (text === "") {
      return;
    }
    e.preventDefault();
    const fields = text === lastCellCopy ? [[text]] : parseClipboardTable(text);
    const colCount = this.widths.length;
    if (
      this.selMode === "row" &&
      this.pasteRowsHandler !== null &&
      fields.every((line) => line.length === colCount)
    ) {
      this.pasteRowsHandler(fields);
      return;
    }
    let lastRow = sel.r0 - 1;
    let lastCol = sel.c0 - 1;
    for (let i = 0; i < fields.length; i++) {
      const row = sel.r0 + i;
      // Rows not loaded yet can't be edited; the paste stops at them.
      if (row >= src.rowCount || src.cell(row, sel.c0) === undefined) {
        break;
      }
      lastRow = row;
      for (let j = 0; j < fields[i].length && sel.c0 + j < colCount; j++) {
        const col = sel.c0 + j;
        lastCol = Math.max(lastCol, col);
        if (!this.canEditCell(row, col)) {
          continue;
        }
        // An empty field is NULL, as an emptied cell editor is.
        const value = fields[i][j] === "" ? null : fields[i][j];
        const choices = this.choicesAt(row, col);
        if (choices?.strict && value !== null && !choices.options.includes(value)) {
          continue;
        }
        handlers.onCommit(row, col, value);
      }
    }
    if (lastRow >= sel.r0 && lastCol >= sel.c0) {
      this.selMode = "cell";
      this.anchor = { row: sel.r0, col: sel.c0 };
      this.cursor = { row: lastRow, col: lastCol };
      this.notifySelection();
      this.schedulePaint();
    }
  };

  private readonly onDblClick = (e: MouseEvent): void => {
    const src = this.source;
    if (!src) {
      return;
    }
    const p = this.localPos(e);
    if (p.x < this.gutterW) {
      return;
    }
    const edge = this.colEdgeAt(p.x);
    if (edge !== null) {
      this.autofitColumn(edge);
      return;
    }
    const col = this.hitCol(p.x);
    if (col === null) {
      return;
    }
    if (p.y < HEADER_H) {
      this.autofitColumn(col);
      return;
    }
    if (!this.editable) {
      return;
    }
    const row = this.hitRow(p.y);
    if (row !== null) {
      this.startEdit(row, col);
    }
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.editor) {
      return;
    }
    const src = this.source;
    if (!src) {
      return;
    }
    const meta = e.metaKey || e.ctrlKey;
    const key = e.key;
    if (meta && (key === "a" || key === "A")) {
      e.preventDefault();
      this.selectAll();
      return;
    }
    if (meta && (key === "c" || key === "C")) {
      e.preventDefault();
      this.copySelection();
      return;
    }
    if (meta && key === "Enter" && this.cellQuickLook && this.cursor) {
      e.preventDefault();
      e.stopPropagation();
      this.cellQuickLook(this.cursor.row, this.cursor.col);
      return;
    }
    if (key === " " && this.quickLook && this.cursor) {
      e.preventDefault();
      e.stopPropagation();
      this.quickLook(this.cursor.row, this.cursor.col);
      return;
    }
    if (key === "Escape") {
      e.preventDefault();
      this.selMode = "cell";
      this.anchor = null;
      this.cursor = null;
      this.notifySelection();
      this.schedulePaint();
      return;
    }
    if ((key === "Enter" || key === "F2") && this.editable && this.cursor) {
      e.preventDefault();
      this.startEdit(this.cursor.row, this.cursor.col);
      return;
    }
    if ((key === "Delete" || key === "Backspace") && this.deleteRowsHandler && this.selMode !== "col") {
      const sel = this.selectionRange();
      if (sel) {
        e.preventDefault();
        const rows: number[] = [];
        for (let r = sel.r0; r <= sel.r1; r++) {
          rows.push(r);
        }
        this.deleteRowsHandler(rows);
      }
      return;
    }
    if (src.rowCount === 0 || this.widths.length === 0) {
      return;
    }
    const lastRow = src.rowCount - 1;
    const lastCol = this.widths.length - 1;
    let cur = this.cursor;
    if (!cur) {
      cur = { row: 0, col: 0 };
    }
    const shift = e.shiftKey;
    let row = cur.row;
    let col = cur.col;
    let handled = true;
    switch (key) {
      case "ArrowUp":
        row = meta ? 0 : row - 1;
        break;
      case "ArrowDown":
        row = meta ? lastRow : row + 1;
        break;
      case "ArrowLeft":
        col = meta ? 0 : col - 1;
        break;
      case "ArrowRight":
        col = meta ? lastCol : col + 1;
        break;
      case "Home":
        col = 0;
        break;
      case "End":
        col = lastCol;
        break;
      case "PageUp": {
        const step = Math.max(1, Math.floor((this.viewH - HEADER_H) / ROW_H));
        row -= step;
        break;
      }
      case "PageDown": {
        const step = Math.max(1, Math.floor((this.viewH - HEADER_H) / ROW_H));
        row += step;
        break;
      }
      default:
        handled = false;
    }
    if (!handled) {
      return;
    }
    e.preventDefault();
    row = clamp(row, 0, lastRow);
    col = clamp(col, 0, lastCol);
    this.selMode = "cell";
    if (shift) {
      if (!this.anchor) {
        this.anchor = { row: cur.row, col: cur.col };
      }
    } else {
      this.anchor = { row, col };
    }
    this.cursor = { row, col };
    this.ensureVisible();
    this.notifySelection();
    this.schedulePaint();
    this.keyMoveListener?.(row);
  }
}
