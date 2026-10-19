import type { RowSource } from "./rowSource";
import { palette } from "../palette";
import { getSettings } from "../settings";

const ROW_H = 26;
const HEADER_H = 28;
const GUTTER_MIN = 48;
const CELL_PAD = 8;
const COL_DEFAULT = 150;
const COL_MIN = 48;
const COL_MAX = 800;
const RESIZE_GRIP = 4;
const MAX_SCROLL_PX = 33_000_000;
const COPY_MAX_ROWS = 100_000;
const FONT = '12px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const FONT_HEADER = '600 12px ui-monospace, "SF Mono", Menlo, Consolas, monospace';

type SelMode = "cell" | "row" | "col";

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
type SelectionHandler = (row: number | null) => void;
type CellContextMenuHandler = (row: number, col: number, x: number, y: number) => void;

const CLICK_SLOP = 2;

export interface GridEditHandlers {
  onCommit(row: number, col: number, value: string | null): void;
  onCancel?(): void;
}

interface EditState {
  input: HTMLInputElement;
  row: number;
  col: number;
  scrollLeft: number;
  scrollTop: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export class CanvasGrid {
  private readonly host: HTMLElement;
  private readonly scroller: HTMLDivElement;
  private readonly sizer: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly ro: ResizeObserver;

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
  private focused = false;

  private editable: GridEditHandlers | null = null;
  private editor: EditState | null = null;
  private disposeUpdates: (() => void) | null = null;

  private headerClick: HeaderClickHandler | null = null;
  private sortColumns: SortIndicator[] = [];
  private selectionListener: SelectionHandler | null = null;
  private contextMenuHandler: CellContextMenuHandler | null = null;
  private quickLook: ((row: number, col: number) => void) | null = null;
  private cellQuickLook: ((row: number, col: number) => void) | null = null;
  private lastNotifiedRow: number | null = null;
  private pendingHeaderClick: { col: number; x: number; y: number; shiftKey: boolean } | null =
    null;

  private rafId = 0;
  private viewW = 0;
  private viewH = 0;

  constructor(host: HTMLElement) {
    this.host = host;

    const scroller = document.createElement("div");
    scroller.className = "grid-scroller";
    scroller.style.position = "absolute";
    scroller.style.inset = "0";
    scroller.style.overflow = "auto";
    scroller.style.background = palette.bg;
    scroller.style.outline = "none";

    const sizer = document.createElement("div");

    const canvas = document.createElement("canvas");
    canvas.tabIndex = 0;
    canvas.style.position = "absolute";
    canvas.style.top = "0";
    canvas.style.left = "0";
    canvas.style.zIndex = "1";
    canvas.style.display = "block";
    canvas.style.willChange = "transform";
    canvas.style.outline = "none";
    canvas.style.cursor = "default";

    scroller.appendChild(sizer);
    scroller.appendChild(canvas);
    host.appendChild(scroller);

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("canvas 2d context unavailable");
    }

    this.scroller = scroller;
    this.sizer = sizer;
    this.canvas = canvas;
    this.ctx = ctx;
    this.ro = new ResizeObserver(this.onResize);

    scroller.addEventListener("scroll", this.onScroll);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("contextmenu", this.onContextMenu);
    canvas.addEventListener("auxclick", this.onAuxClick);
    canvas.addEventListener("dblclick", this.onDblClick);
    canvas.addEventListener("keydown", this.onKeyDown);
    canvas.addEventListener("focus", this.onFocus);
    canvas.addEventListener("blur", this.onBlur);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.ro.observe(host);

    this.applyTransform();
    this.updateSizer();
    this.resizeSurface();
    this.schedulePaint();
  }

  refreshTheme(): void {
    this.scroller.style.background = palette.bg;
    this.schedulePaint();
  }

  setQuickLookHandler(handler: ((row: number, col: number) => void) | null): void {
    this.quickLook = handler;
  }

  setCellQuickLookHandler(handler: ((row: number, col: number) => void) | null): void {
    this.cellQuickLook = handler;
  }

  setSource(source: RowSource | null): void {
    if (this.editor) {
      this.cancelEdit();
    }
    if (this.disposeUpdates) {
      this.disposeUpdates();
      this.disposeUpdates = null;
    }
    this.source = source;
    if (source && source.onUpdate) {
      this.disposeUpdates = source.onUpdate(() => this.schedulePaint());
    }
    this.scroller.scrollLeft = 0;
    this.scroller.scrollTop = 0;
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
    const widths = new Array<number>(colCount);
    for (let c = 0; c < colCount; c++) {
      widths[c] = COL_DEFAULT;
    }
    this.widths = widths;
    this.gutterW = Math.max(GUTTER_MIN, String(Math.max(1, rowCount)).length * 8 + 24);
    this.rebuildOffsets();
    this.applyTransform();
    this.updateSizer();
    this.resizeSurface();
    this.schedulePaint();
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

  beginEdit(row: number, col: number): void {
    this.startEdit(row, col);
  }

  focus(): void {
    this.canvas.focus();
  }

  destroy(): void {
    if (this.editor) {
      this.cancelEdit();
    }
    if (this.disposeUpdates) {
      this.disposeUpdates();
      this.disposeUpdates = null;
    }
    this.ro.disconnect();
    this.scroller.removeEventListener("scroll", this.onScroll);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    this.canvas.removeEventListener("auxclick", this.onAuxClick);
    this.canvas.removeEventListener("dblclick", this.onDblClick);
    this.canvas.removeEventListener("keydown", this.onKeyDown);
    this.canvas.removeEventListener("focus", this.onFocus);
    this.canvas.removeEventListener("blur", this.onBlur);
    this.canvas.removeEventListener("wheel", this.onWheel);
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.source = null;
    this.host.innerHTML = "";
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
    const w = Math.min(this.totalW(), MAX_SCROLL_PX);
    const h = Math.min(this.totalH(), MAX_SCROLL_PX);
    this.sizer.style.width = `${Math.max(0, w)}px`;
    this.sizer.style.height = `${Math.max(0, h)}px`;
  }

  private resizeSurface(): void {
    const cw = this.scroller.clientWidth;
    const ch = this.scroller.clientHeight;
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

  private applyTransform(): void {
    this.canvas.style.transform = `translate(${this.scroller.scrollLeft}px, ${this.scroller.scrollTop}px)`;
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
    if (row === this.lastNotifiedRow) {
      return;
    }
    this.lastNotifiedRow = row;
    if (this.selectionListener) {
      this.selectionListener(row);
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

  private textInk(v: unknown): string {
    if (v === null) {
      return palette.nullInk;
    }
    if (typeof v === "number" || typeof v === "bigint") {
      return palette.accent;
    }
    if (typeof v === "boolean") {
      return palette.warn;
    }
    return palette.ink;
  }

  private fitText(text: string, maxWidth: number): string {
    if (maxWidth <= 0) {
      return "";
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

    ctx.textBaseline = "middle";
    ctx.font = FONT;

    for (let r = first; r <= last; r++) {
      const y = HEADER_H + r * ROW_H - virtualY;
      if (getSettings().rowAlt && (r & 1) === 1) {
        ctx.fillStyle = palette.rowAlt;
        ctx.fillRect(0, y, w, ROW_H);
      }
      if (r === this.hoverRow) {
        ctx.fillStyle = palette.hoverFill;
        ctx.fillRect(0, y, w, ROW_H);
      }
      for (let c = startCol; c < colCount; c++) {
        const x = gutterW + this.offsets[c] - virtualX;
        if (x >= w) {
          break;
        }
        const cw = this.widths[c];
        if (x + cw <= gutterW) {
          continue;
        }
        if (sel && r >= sel.r0 && r <= sel.r1 && c >= sel.c0 && c <= sel.c1) {
          ctx.fillStyle = selFill;
          const fx = Math.max(x, gutterW);
          const fw = Math.min(x + cw, w) - fx;
          if (fw > 0) {
            ctx.fillRect(fx, y, fw, ROW_H);
          }
        }
        const v = src.cell(r, c);
        if (v === undefined) {
          continue;
        }
        const isNull = v === null;
        const text = isNull ? "NULL" : this.cellText(v);
        const right = typeof v === "number";
        ctx.fillStyle = this.textInk(v);
        ctx.textAlign = right ? "right" : "left";
        const tx = right ? x + cw - CELL_PAD : x + CELL_PAD;
        const ty = y + ROW_H / 2;
        if (ctx.measureText(text).width > cw - CELL_PAD * 2) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, cw, ROW_H);
          ctx.clip();
          ctx.fillText(text, tx, ty);
          ctx.restore();
        } else {
          ctx.fillText(text, tx, ty);
        }
      }
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
    for (let c = startCol; c < colCount; c++) {
      const bx = gutterW + this.offsets[c] + this.widths[c] - virtualX;
      if (bx > w) {
        break;
      }
      if (bx < gutterW) {
        continue;
      }
      const lx = Math.round(bx) + 0.5;
      ctx.moveTo(lx, HEADER_H);
      ctx.lineTo(lx, h);
    }
    ctx.stroke();
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
      ctx.fillStyle = r === this.hoverRow || inSel ? palette.accent : palette.faint;
      ctx.fillText(String(r + 1), numX, y + ROW_H / 2);
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
    ctx.textAlign = "left";
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
      const reserved = sort ? 14 : 0;
      const maxTextW = Math.max(0, cw - CELL_PAD * 2 - reserved);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + CELL_PAD, 0, maxTextW, HEADER_H);
      ctx.clip();
      ctx.fillStyle = sort ? palette.accent : palette.ink;
      ctx.fillText(this.fitText(src.columns[c], maxTextW), x + CELL_PAD, HEADER_H / 2);
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

  private copySelection(): void {
    const src = this.source;
    const sel = this.selectionRange();
    if (!src || !sel) {
      return;
    }
    const lastRow = Math.min(sel.r1, sel.r0 + COPY_MAX_ROWS - 1);
    const lines: string[] = [];
    for (let r = sel.r0; r <= lastRow; r++) {
      const cells: string[] = [];
      for (let c = sel.c0; c <= sel.c1; c++) {
        const v = src.cell(r, c);
        if (v === undefined || v === null) {
          cells.push("");
        } else {
          cells.push(this.cellText(v));
        }
      }
      lines.push(cells.join("\t"));
    }
    const text = lines.join("\n");
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
    const raw = src.cell(row, col);
    const input = document.createElement("input");
    input.type = "text";
    input.className = "cell-editor";
    input.value = raw === null || raw === undefined ? "" : this.cellText(raw);
    input.style.textAlign = typeof raw === "number" ? "right" : "left";
    input.style.left = `${this.gutterW + this.offsets[col] - this.virtualScrollX()}px`;
    input.style.top = `${HEADER_H + row * ROW_H - this.virtualScrollY()}px`;
    input.style.width = `${this.widths[col]}px`;
    input.style.height = `${ROW_H}px`;
    this.editor = {
      input,
      row,
      col,
      scrollLeft: this.scroller.scrollLeft,
      scrollTop: this.scroller.scrollTop,
    };
    this.selMode = "cell";
    this.anchor = { row, col };
    this.cursor = { row, col };
    this.notifySelection();
    input.addEventListener("keydown", this.onEditorKeyDown);
    input.addEventListener("blur", this.onEditorBlur);
    this.host.appendChild(input);
    input.focus();
    input.select();
    this.schedulePaint();
  }

  private endEdit(): void {
    const ed = this.editor;
    if (!ed) {
      return;
    }
    this.editor = null;
    ed.input.removeEventListener("keydown", this.onEditorKeyDown);
    ed.input.removeEventListener("blur", this.onEditorBlur);
    if (ed.input.parentNode) {
      ed.input.parentNode.removeChild(ed.input);
    }
  }

  private commitEdit(): void {
    const ed = this.editor;
    if (!ed) {
      return;
    }
    const value = ed.input.value;
    const row = ed.row;
    const col = ed.col;
    this.endEdit();
    if (this.editable) {
      this.editable.onCommit(row, col, value === "" ? null : value);
    }
    this.canvas.focus();
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
    this.canvas.focus();
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

  private readonly onEditorBlur = (): void => {
    if (!this.editor) {
      return;
    }
    this.commitEdit();
  };

  private autofitColumn(col: number): void {
    const src = this.source;
    if (!src || col < 0 || col >= this.widths.length) {
      return;
    }
    const ctx = this.ctx;
    ctx.font = FONT_HEADER;
    let maxW = ctx.measureText(src.columns[col]).width;
    ctx.font = FONT;
    const sample = Math.min(200, src.rowCount);
    for (let r = 0; r < sample; r++) {
      const v = src.cell(r, col);
      if (v === undefined) {
        continue;
      }
      const text = v === null ? "NULL" : this.cellText(v);
      const tw = ctx.measureText(text).width;
      if (tw > maxW) {
        maxW = tw;
      }
    }
    const next = Math.round(clamp(maxW + CELL_PAD * 2 + 6, COL_MIN, COL_MAX));
    if (next !== this.widths[col]) {
      this.widths[col] = next;
      this.rebuildOffsets();
      this.updateSizer();
      this.resizeSurface();
      this.schedulePaint();
    }
  }

  private readonly onResize = (): void => {
    if (this.editor) {
      this.cancelEdit();
    }
    this.resizeSurface();
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
    this.applyTransform();
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
    if (!src || e.button !== 0) {
      return;
    }
    this.canvas.focus();
    this.canvas.setPointerCapture(e.pointerId);
    this.pendingHeaderClick = null;
    const p = this.localPos(e);
    if (p.x < this.gutterW && p.y < HEADER_H) {
      this.selMode = "cell";
      this.anchor = null;
      this.cursor = null;
      this.drag = { kind: "none" };
      this.notifySelection();
      this.schedulePaint();
      return;
    }
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
    this.notifySelection();
    this.schedulePaint();
    if (e.altKey && this.contextMenuHandler) {
      const menu = this.contextMenuHandler;
      window.setTimeout(() => menu(row, col, e.clientX, e.clientY), 0);
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
      const p = this.localPos(e);
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
    if (row !== this.hoverRow || edge !== this.hoverColEdge) {
      this.hoverRow = row;
      this.hoverColEdge = edge;
      const overHeader = p.y < HEADER_H && p.x >= this.gutterW;
      this.canvas.style.cursor =
        edge !== null
          ? "col-resize"
          : this.headerClick && overHeader
            ? "pointer"
            : "default";
      this.schedulePaint();
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
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
    this.selMode = "cell";
    this.anchor = { row, col };
    this.cursor = { row, col };
    this.notifySelection();
    this.schedulePaint();
    this.contextMenuHandler(row, col, e.clientX, e.clientY);
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
      this.cellQuickLook(this.cursor.row, this.cursor.col);
      return;
    }
    if (key === " " && this.quickLook && this.cursor) {
      e.preventDefault();
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
  }
}
