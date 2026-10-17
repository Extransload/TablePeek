import type { RowSource } from "./rowSource";

export interface WindowedRowSourceOptions {
  columns: string[];
  rowCount: number;
  windowSize: number;
  fetchWindow: (offset: number, limit: number) => Promise<unknown[][]>;
  maxWindows?: number;
}

const DEFAULT_MAX_WINDOWS = 64;

export class WindowedRowSource implements RowSource {
  readonly columns: string[];
  readonly rowCount: number;
  private readonly windowSize: number;
  private readonly maxWindows: number;
  private readonly fetchWindow: (offset: number, limit: number) => Promise<unknown[][]>;
  private readonly windows = new Map<number, unknown[][]>();
  private readonly pending = new Map<number, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(options: WindowedRowSourceOptions) {
    this.columns = options.columns;
    this.rowCount = options.rowCount;
    this.windowSize = Math.max(1, Math.trunc(options.windowSize));
    this.maxWindows = Math.max(1, Math.trunc(options.maxWindows ?? DEFAULT_MAX_WINDOWS));
    this.fetchWindow = options.fetchWindow;
  }

  cell(row: number, col: number): unknown {
    if (!Number.isInteger(row) || row < 0 || row >= this.rowCount) {
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
    if (!this.disposed) {
      this.request(offset);
    }
    return undefined;
  }

  setCell(row: number, col: number, value: unknown): boolean {
    if (!Number.isInteger(row) || row < 0 || row >= this.rowCount) {
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

  clearWindows(): void {
    this.windows.clear();
    this.notify();
  }

  async ensureRow(row: number): Promise<void> {
    if (!Number.isInteger(row) || row < 0 || row >= this.rowCount) {
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
    this.disposed = true;
    this.pending.clear();
    this.listeners.clear();
  }

  loadedWindowCount(): number {
    return this.windows.size;
  }

  private touch(offset: number): void {
    const rows = this.windows.get(offset);
    if (rows === undefined) {
      return;
    }
    this.windows.delete(offset);
    this.windows.set(offset, rows);
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
        this.windows.set(offset, rows);
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

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
