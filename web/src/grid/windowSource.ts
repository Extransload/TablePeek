import { cellToString } from "../rowOps";
import { moveItem, movedIndex } from "./columnMove";
import type { CellState, RowSource, RowState } from "./rowSource";

export interface WindowedRowSourceOptions {
  columns: string[];
  rowCount: number;
  windowSize: number;
  fetchWindow: (offset: number, limit: number) => Promise<unknown[][]>;
  maxWindows?: number;
  // Called once, when the rows are no longer read (the server can let them go).
  onDispose?: () => void;
}

export interface PkPair {
  column: string;
  value: string | number | null;
}

export interface PendingSummary {
  edits: number;
  inserts: number;
  deletes: number;
  total: number;
}

// A value the database writes itself (TablePlus's Set Value ▸ DEFAULT and
// NOW()), named for the server; `label` is what the cell shows until applied.
export type ValueExpr = "default" | "now";

export interface StagedExpr {
  expr: ValueExpr;
  label: string;
}

export interface PendingCell {
  col: number;
  value: string | null;
  expr?: ValueExpr;
  // `value` is an amount the database adds to the column in one write (a
  // CQL counter's increment); what the column becomes is read back.
  add?: true;
}

export interface PendingEditOp {
  row: number;
  key: PkPair[];
  cells: PendingCell[];
}

export interface PendingOps {
  edits: PendingEditOp[];
  inserts: PendingCell[][];
  deletes: { row: number; key: PkPair[] }[];
}

interface PendingEditRow {
  key: PkPair[];
  // An expression's cell holds its label, an increment's "+n".
  cells: Map<number, string | null>;
  exprs: Map<number, ValueExpr>;
  // Increments staged by stageAdd: the amount of each.
  adds: Map<number, string>;
}

interface PendingInsertRow {
  values: (string | null)[];
  touched: boolean[];
  exprs: (ValueExpr | null)[];
}

const DEFAULT_MAX_WINDOWS = 64;
const pendingListeners = new Set<() => void>();

export function subscribePendingChanges(listener: () => void): () => void {
  pendingListeners.add(listener);
  return () => {
    pendingListeners.delete(listener);
  };
}

export class WindowedRowSource implements RowSource {
  private cols: string[];
  readonly baseRowCount: number;
  private readonly windowSize: number;
  private readonly maxWindows: number;
  private readonly fetchWindow: (offset: number, limit: number) => Promise<unknown[][]>;
  private readonly onDispose: (() => void) | undefined;
  private readonly windows = new Map<number, unknown[][]>();
  private readonly pending = new Map<number, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private readonly edits = new Map<number, PendingEditRow>();
  private readonly inserts: PendingInsertRow[] = [];
  private readonly deletes = new Map<number, PkPair[]>();
  private lastTouched = -1;
  private disposed = false;
  // Rows come from the server in the order it was asked for; after a column
  // moves (moveColumn), column c of a fetched row is at fetchOrder[c].
  private fetchOrder: number[] | null = null;

  constructor(options: WindowedRowSourceOptions) {
    this.cols = options.columns;
    this.baseRowCount = options.rowCount;
    this.windowSize = Math.max(1, Math.trunc(options.windowSize));
    this.maxWindows = Math.max(1, Math.trunc(options.maxWindows ?? DEFAULT_MAX_WINDOWS));
    this.fetchWindow = options.fetchWindow;
    this.onDispose = options.onDispose;
  }

  get columns(): string[] {
    return this.cols;
  }

  // Column `from` moved to index `to`, as if the rows had been read in that
  // order: the rows loaded, the ones still on their way and the changes
  // staged on them all go with it. The column list is a new array.
  moveColumn(from: number, to: number): void {
    const count = this.cols.length;
    if (from === to || from < 0 || to < 0 || from >= count || to >= count) {
      return;
    }
    const cols = this.cols.slice();
    moveItem(cols, from, to);
    this.cols = cols;
    const order = this.fetchOrder?.slice() ?? cols.map((_, index) => index);
    moveItem(order, from, to);
    this.fetchOrder = order;
    for (const rows of this.windows.values()) {
      for (const line of rows) {
        if (line.length < count) {
          line.length = count;
        }
        moveItem(line, from, to);
      }
    }
    const remap = <T>(cells: Map<number, T>): Map<number, T> =>
      new Map([...cells].map(([col, value]) => [movedIndex(col, from, to), value]));
    for (const entry of this.edits.values()) {
      entry.cells = remap(entry.cells);
      entry.exprs = remap(entry.exprs);
      entry.adds = remap(entry.adds);
    }
    for (const insert of this.inserts) {
      moveItem(insert.values, from, to);
      moveItem(insert.touched, from, to);
      moveItem(insert.exprs, from, to);
    }
    if (this.hasPending()) {
      this.changed();
    } else {
      this.notify();
    }
  }

  get rowCount(): number {
    return this.baseRowCount + this.inserts.length;
  }

  cell(row: number, col: number): unknown {
    if (row >= this.baseRowCount && row < this.rowCount && col >= 0 && col < this.columns.length) {
      return this.inserts[row - this.baseRowCount].values[col];
    }
    const edited = this.edits.get(row)?.cells;
    if (edited !== undefined && edited.has(col)) {
      return edited.get(col);
    }
    return this.baseCell(row, col);
  }

  // With fetch=false an unloaded row just reports undefined instead of requesting its window.
  baseCell(row: number, col: number, fetch = true): unknown {
    if (!Number.isInteger(row) || row < 0 || row >= this.baseRowCount) {
      return null;
    }
    if (col < 0 || col >= this.columns.length) {
      return null;
    }
    const offset = row - (row % this.windowSize);
    const rows = this.windows.get(offset);
    if (rows) {
      this.touch(offset);
      const line = rows[row - offset];
      if (!line) {
        return null;
      }
      const value = line[col];
      return value === undefined ? null : value;
    }
    if (fetch && !this.disposed) {
      this.request(offset);
    }
    return undefined;
  }

  setCell(row: number, col: number, value: unknown): boolean {
    if (!Number.isInteger(row) || row < 0 || row >= this.baseRowCount) {
      return false;
    }
    if (col < 0 || col >= this.columns.length) {
      return false;
    }
    const offset = row - (row % this.windowSize);
    const rows = this.windows.get(offset);
    if (!rows) {
      return false;
    }
    this.touch(offset);
    const line = rows[row - offset];
    if (!line) {
      return false;
    }
    line[col] = value;
    this.notify();
    return true;
  }

  isInserted(row: number): boolean {
    return row >= this.baseRowCount && row < this.rowCount;
  }

  isDeleted(row: number): boolean {
    return this.deletes.has(row);
  }

  rowState(row: number): RowState {
    if (this.isInserted(row)) {
      return "inserted";
    }
    if (this.deletes.has(row)) {
      return "deleted";
    }
    return this.edits.has(row) ? "edited" : null;
  }

  // The expression staged in a cell, if one is.
  stagedExpr(row: number, col: number): StagedExpr | null {
    if (this.isInserted(row)) {
      const insert = this.inserts[row - this.baseRowCount];
      const expr = insert.exprs[col] ?? null;
      return expr === null ? null : { expr, label: insert.values[col] ?? "" };
    }
    const entry = this.edits.get(row);
    const expr = entry?.exprs.get(col);
    return expr === undefined ? null : { expr, label: entry?.cells.get(col) ?? "" };
  }

  cellExpr(row: number, col: number): string | null {
    return this.stagedExpr(row, col)?.label ?? null;
  }

  cellState(row: number, col: number): CellState {
    if (this.isInserted(row)) {
      return this.inserts[row - this.baseRowCount].touched[col] ? "edited" : "default";
    }
    return this.edits.get(row)?.cells.has(col) ? "edited" : null;
  }

  stageEdit(row: number, col: number, value: string | null, key: PkPair[] | null): boolean {
    if (col < 0 || col >= this.columns.length) {
      return false;
    }
    if (this.isInserted(row)) {
      const insert = this.inserts[row - this.baseRowCount];
      insert.values[col] = value;
      insert.touched[col] = true;
      insert.exprs[col] = null;
      this.changed();
      return true;
    }
    if (!Number.isInteger(row) || row < 0 || row >= this.baseRowCount) {
      return false;
    }
    const base = this.baseCell(row, col);
    const entry = this.edits.get(row);
    if (base !== undefined && cellToString(base) === value) {
      if (entry !== undefined && entry.cells.delete(col)) {
        entry.exprs.delete(col);
        entry.adds.delete(col);
        if (entry.cells.size === 0) {
          this.edits.delete(row);
        }
        this.changed();
      }
      return true;
    }
    if (entry !== undefined) {
      entry.cells.set(col, value);
      entry.exprs.delete(col);
      entry.adds.delete(col);
    } else if (key !== null) {
      this.edits.set(row, { key, cells: new Map([[col, value]]), exprs: new Map(), adds: new Map() });
    } else {
      return false;
    }
    this.changed();
    return true;
  }

  // DEFAULT or the current time, written by the database when applied.
  stageExpr(row: number, col: number, staged: StagedExpr, key: PkPair[] | null): boolean {
    if (col < 0 || col >= this.columns.length) {
      return false;
    }
    if (this.isInserted(row)) {
      const insert = this.inserts[row - this.baseRowCount];
      insert.values[col] = staged.label;
      insert.touched[col] = true;
      insert.exprs[col] = staged.expr;
      this.changed();
      return true;
    }
    if (!Number.isInteger(row) || row < 0 || row >= this.baseRowCount) {
      return false;
    }
    const entry = this.edits.get(row);
    if (entry !== undefined) {
      entry.cells.set(col, staged.label);
      entry.exprs.set(col, staged.expr);
      entry.adds.delete(col);
    } else if (key !== null) {
      this.edits.set(row, {
        key,
        cells: new Map([[col, staged.label]]),
        exprs: new Map([[col, staged.expr]]),
        adds: new Map(),
      });
    } else {
      return false;
    }
    this.changed();
    return true;
  }

  // An amount the database adds to a stored row's counter when applied
  // (UPDATE … SET c = c + n); the cell shows "+n" until then. A new row's
  // counter starts from the amount, so it is staged as its value.
  stageAdd(row: number, col: number, amount: string, key: PkPair[] | null): boolean {
    if (col < 0 || col >= this.columns.length) {
      return false;
    }
    if (this.isInserted(row)) {
      return this.stageEdit(row, col, amount, key);
    }
    if (!Number.isInteger(row) || row < 0 || row >= this.baseRowCount) {
      return false;
    }
    const label = amount.startsWith("-") ? amount : `+${amount}`;
    const entry = this.edits.get(row);
    if (entry !== undefined) {
      entry.cells.set(col, label);
      entry.exprs.delete(col);
      entry.adds.set(col, amount);
    } else if (key !== null) {
      this.edits.set(row, {
        key,
        cells: new Map([[col, label]]),
        exprs: new Map(),
        adds: new Map([[col, amount]]),
      });
    } else {
      return false;
    }
    this.changed();
    return true;
  }

  revertCell(row: number, col: number): void {
    if (this.isInserted(row)) {
      const insert = this.inserts[row - this.baseRowCount];
      insert.values[col] = null;
      insert.touched[col] = false;
      insert.exprs[col] = null;
      this.changed();
      return;
    }
    const entry = this.edits.get(row);
    if (entry !== undefined && entry.cells.delete(col)) {
      entry.exprs.delete(col);
      entry.adds.delete(col);
      if (entry.cells.size === 0) {
        this.edits.delete(row);
      }
      this.changed();
    }
  }

  stageInsert(values?: Map<number, string | null>): number {
    const count = this.columns.length;
    const row: PendingInsertRow = {
      values: new Array<string | null>(count).fill(null),
      touched: new Array<boolean>(count).fill(false),
      exprs: new Array<ValueExpr | null>(count).fill(null),
    };
    if (values !== undefined) {
      for (const [col, value] of values) {
        if (col >= 0 && col < count) {
          row.values[col] = value;
          row.touched[col] = true;
        }
      }
    }
    this.inserts.push(row);
    this.changed();
    return this.rowCount - 1;
  }

  // Inserted rows are dropped outright; existing rows are marked (or unmarked) for deletion.
  // Rows whose key cannot be read (no PK, or not loaded) are skipped and counted.
  stageDelete(
    rows: number[],
    keyOf: (row: number) => PkPair[] | null,
  ): { changed: number; skipped: number } {
    let applied = 0;
    let skipped = 0;
    const dropped = rows
      .filter((row) => this.isInserted(row))
      .sort((a, b) => b - a);
    for (const row of dropped) {
      this.inserts.splice(row - this.baseRowCount, 1);
      applied += 1;
    }
    const existing = rows.filter(
      (row) => Number.isInteger(row) && row >= 0 && row < this.baseRowCount,
    );
    const unmark = existing.length > 0 && existing.every((row) => this.deletes.has(row));
    for (const row of existing) {
      if (unmark) {
        this.deletes.delete(row);
        applied += 1;
        continue;
      }
      if (this.deletes.has(row)) {
        continue;
      }
      const key = this.edits.get(row)?.key ?? keyOf(row);
      if (key !== null) {
        this.deletes.set(row, key);
        applied += 1;
      } else {
        skipped += 1;
      }
    }
    if (applied > 0) {
      this.changed();
    }
    return { changed: applied, skipped };
  }

  hasPending(): boolean {
    return this.edits.size > 0 || this.inserts.length > 0 || this.deletes.size > 0;
  }

  pendingSummary(): PendingSummary {
    let edits = 0;
    for (const [row, entry] of this.edits) {
      if (!this.deletes.has(row)) {
        edits += entry.cells.size;
      }
    }
    const inserts = this.inserts.length;
    const deletes = this.deletes.size;
    return { edits, inserts, deletes, total: edits + inserts + deletes };
  }

  pendingOps(): PendingOps {
    const edits: PendingEditOp[] = [];
    for (const [row, entry] of this.edits) {
      if (this.deletes.has(row)) {
        continue;
      }
      edits.push({
        row,
        key: entry.key,
        cells: [...entry.cells].map(([col, value]): PendingCell => {
          const expr = entry.exprs.get(col);
          const amount = entry.adds.get(col);
          if (amount !== undefined) {
            return { col, value: amount, add: true };
          }
          return expr === undefined ? { col, value } : { col, value: null, expr };
        }),
      });
    }
    const inserts = this.inserts.map((insert) =>
      insert.values
        .map((value, col): PendingCell => {
          const expr = insert.exprs[col];
          return expr === null ? { col, value } : { col, value: null, expr };
        })
        .filter((entry) => insert.touched[entry.col]),
    );
    const deletes = [...this.deletes].map(([row, key]) => ({ row, key }));
    return { edits, inserts, deletes };
  }

  discardPending(): void {
    if (!this.hasPending()) {
      return;
    }
    this.edits.clear();
    this.inserts.length = 0;
    this.deletes.clear();
    this.changed();
  }

  clearWindows(): void {
    this.windows.clear();
    this.lastTouched = -1;
    this.notify();
  }

  async ensureRow(row: number): Promise<void> {
    if (!Number.isInteger(row) || row < 0 || row >= this.baseRowCount) {
      return;
    }
    const offset = row - (row % this.windowSize);
    if (this.windows.has(offset)) {
      this.touch(offset);
      return;
    }
    await this.startFetch(offset);
  }

  onUpdate(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    if (!this.disposed) {
      this.onDispose?.();
    }
    this.disposed = true;
    this.pending.clear();
    this.listeners.clear();
    if (this.hasPending()) {
      this.edits.clear();
      this.inserts.length = 0;
      this.deletes.clear();
      for (const listener of pendingListeners) {
        listener();
      }
    }
  }

  loadedWindowCount(): number {
    return this.windows.size;
  }

  private touch(offset: number): void {
    if (offset === this.lastTouched) {
      return;
    }
    const rows = this.windows.get(offset);
    if (rows === undefined) {
      return;
    }
    this.windows.delete(offset);
    this.windows.set(offset, rows);
    this.lastTouched = offset;
  }

  private startFetch(offset: number): Promise<void> {
    const existing = this.pending.get(offset);
    if (existing) {
      return existing;
    }
    const promise = this.fetchWindow(offset, this.windowSize)
      .then((rows) => {
        if (this.disposed) {
          return;
        }
        const order = this.fetchOrder;
        this.windows.set(offset, order === null ? rows : rows.map((line) => order.map((index) => line[index])));
        this.lastTouched = offset;
        this.evict();
        this.notify();
      })
      .finally(() => {
        this.pending.delete(offset);
      });
    this.pending.set(offset, promise);
    return promise;
  }

  private request(offset: number): void {
    void this.startFetch(offset).catch(() => {});
  }

  private evict(): void {
    while (this.windows.size > this.maxWindows) {
      const oldest = this.windows.keys().next();
      if (oldest.done) {
        return;
      }
      this.windows.delete(oldest.value);
    }
  }

  private changed(): void {
    this.notify();
    for (const listener of pendingListeners) {
      listener();
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
