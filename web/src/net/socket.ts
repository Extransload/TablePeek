import { tableFromIPC } from "apache-arrow";
import { WindowedRowSource } from "../grid/windowSource";

export type SocketStatus = "connecting" | "open" | "closed";

export interface QueryMeta {
  id: string;
  kind: string;
  columns: string[];
  rowCount: number;
  elapsedMs: number;
  truncated: boolean;
  sourceTable: string | null;
  pk: string[] | null;
}

export interface QueryResult {
  meta: QueryMeta;
  source: WindowedRowSource;
  queryId: string;
}

export interface EditRequest {
  session: string;
  table: string;
  pk: { column: string; value: string | number | null }[];
  column: string;
  value: string | null;
  row: number;
  col: number;
}

export interface EditResult {
  rowsAffected: number;
  row: number;
  col: number;
  value: string | null;
}

export class ProdbSocketError extends Error {
  readonly cancelled: boolean;

  constructor(message: string, cancelled: boolean) {
    super(message);
    this.name = "ProdbSocketError";
    this.cancelled = cancelled;
  }
}

interface MetaMessage {
  type: "meta";
  id: string;
  kind: string;
  columns: string[];
  row_count: number;
  elapsed_ms: number;
  truncated: boolean;
  source_table: string | null;
  pk: string[] | null;
}

interface WindowMessage {
  type: "window";
  id: string;
  offset: number;
  count: number;
}

interface ErrorMessage {
  type: "error";
  id: string | null;
  message: string;
  cancelled: boolean;
}

interface EditedMessage {
  type: "edited";
  row: number;
  col: number;
  column: string;
  value: string | null;
  rows_affected: number;
}

interface TxMessage {
  type: "tx";
  state: "began" | "committed" | "rolledback";
}

type ServerMessage = MetaMessage | WindowMessage | ErrorMessage | EditedMessage | TxMessage;

interface MetaWaiter {
  id: string;
  resolve: (message: MetaMessage) => void;
  reject: (error: ProdbSocketError) => void;
}

interface WindowWaiter {
  id: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (rows: unknown[][]) => void;
  reject: (error: ProdbSocketError) => void;
}

interface EditWaiter {
  resolve: (result: EditResult) => void;
  reject: (error: ProdbSocketError) => void;
}

interface TxWaiter {
  expected: TxMessage["state"];
  resolve: () => void;
  reject: (error: ProdbSocketError) => void;
}

const CONNECT_ERROR = "서버에 연결할 수 없습니다";
const CLOSED_ERROR = "서버 연결이 끊어졌습니다";
const CANCELLED_ERROR = "쿼리가 취소되었습니다";
const FETCH_TIMEOUT_ERROR = "데이터 응답 시간이 초과되었습니다";
const FETCH_TIMEOUT_MS = 30000;

function decodeCell(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  return value === undefined ? null : value;
}

export function decodeArrow(buffer: ArrayBuffer): unknown[][] {
  const table = tableFromIPC(new Uint8Array(buffer));
  const colCount = table.numCols;
  const children = new Array(colCount);
  for (let c = 0; c < colCount; c += 1) {
    children[c] = table.getChildAt(c);
  }
  const rows: unknown[][] = new Array(table.numRows);
  for (let r = 0; r < table.numRows; r += 1) {
    const row: unknown[] = new Array(colCount);
    for (let c = 0; c < colCount; c += 1) {
      const child = children[c];
      row[c] = decodeCell(child ? child.get(r) : null);
    }
    rows[r] = row;
  }
  return rows;
}

function concatRows(frames: unknown[][][]): unknown[][] {
  if (frames.length === 1) {
    return frames[0];
  }
  let total = 0;
  for (const frame of frames) {
    total += frame.length;
  }
  const rows: unknown[][] = new Array(total);
  let index = 0;
  for (const frame of frames) {
    for (const row of frame) {
      rows[index] = row;
      index += 1;
    }
  }
  return rows;
}

export class ProdbSocket {
  private readonly url: string;
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private statusValue: SocketStatus = "closed";
  private readonly statusListeners = new Set<(status: SocketStatus) => void>();
  private activeQueryId: string | null = null;
  private metaWaiter: MetaWaiter | null = null;
  private readonly windowWaiters = new Map<number, WindowWaiter>();
  private editWaiter: EditWaiter | null = null;
  private txWaiter: TxWaiter | null = null;
  private pendingFrames: unknown[][][] = [];

  constructor(token: string) {
    this.url = `ws://${location.host}/api/ws?token=${encodeURIComponent(token)}`;
  }

  get status(): SocketStatus {
    return this.statusValue;
  }

  onStatus(listener: (status: SocketStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.setStatus("connecting");
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      let opened = false;
      let failed = false;
      const failConnect = (): void => {
        if (failed || opened) {
          return;
        }
        failed = true;
        this.connectPromise = null;
        reject(new ProdbSocketError(CONNECT_ERROR, false));
      };
      ws.onopen = () => {
        if (this.ws !== ws) {
          return;
        }
        opened = true;
        this.connectPromise = null;
        this.setStatus("open");
        resolve();
      };
      ws.onerror = () => {
        failConnect();
      };
      ws.onmessage = (event) => {
        if (this.ws === ws) {
          this.handleMessage(event.data);
        }
      };
      ws.onclose = () => {
        if (this.ws === ws) {
          this.ws = null;
          this.connectPromise = null;
          this.setStatus("closed");
          this.failPending(new ProdbSocketError(CLOSED_ERROR, false));
        }
        failConnect();
      };
    });
    return this.connectPromise;
  }

  async query(
    sql: string,
    options: { maxRows: number; window: number },
  ): Promise<QueryResult> {
    await this.connect();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new ProdbSocketError(CLOSED_ERROR, false);
    }
    this.cancelPending();
    const queryId = crypto.randomUUID();
    this.activeQueryId = queryId;
    const messagePromise = new Promise<MetaMessage>((resolve, reject) => {
      this.metaWaiter = { id: queryId, resolve, reject };
    });
    ws.send(
      JSON.stringify({
        type: "query",
        id: queryId,
        sql,
        max_rows: options.maxRows,
        window: options.window,
      }),
    );
    const message = await messagePromise;
    const meta: QueryMeta = {
      id: message.id,
      kind: message.kind,
      columns: message.columns,
      rowCount: message.row_count,
      elapsedMs: message.elapsed_ms,
      truncated: message.truncated,
      sourceTable: message.source_table,
      pk: message.pk,
    };
    const source = new WindowedRowSource({
      columns: meta.columns,
      rowCount: meta.rowCount,
      windowSize: options.window,
      fetchWindow: (offset, limit) => this.fetch(queryId, offset, limit),
    });
    return { meta, source, queryId };
  }

  async fetch(id: string, offset: number, limit: number): Promise<unknown[][]> {
    await this.connect();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new ProdbSocketError(CLOSED_ERROR, false);
    }
    const existing = this.windowWaiters.get(offset);
    if (existing) {
      this.windowWaiters.delete(offset);
      clearTimeout(existing.timer);
      existing.reject(new ProdbSocketError(CANCELLED_ERROR, true));
    }
    return new Promise<unknown[][]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.windowWaiters.delete(offset);
        reject(new ProdbSocketError(FETCH_TIMEOUT_ERROR, false));
      }, FETCH_TIMEOUT_MS);
      this.windowWaiters.set(offset, { id, timer, resolve, reject });
      ws.send(JSON.stringify({ type: "fetch", id, offset, limit }));
    });
  }

  cancel(): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "cancel" }));
    }
  }

  async edit(request: EditRequest): Promise<EditResult> {
    await this.connect();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new ProdbSocketError(CLOSED_ERROR, false);
    }
    if (this.editWaiter) {
      throw new ProdbSocketError("이전 수정 요청이 아직 완료되지 않았습니다", false);
    }
    const result = new Promise<EditResult>((resolve, reject) => {
      this.editWaiter = { resolve, reject };
    });
    ws.send(JSON.stringify({ type: "edit", ...request }));
    return result;
  }

  begin(): Promise<void> {
    return this.runTx("begin");
  }

  commit(): Promise<void> {
    return this.runTx("commit");
  }

  rollback(): Promise<void> {
    return this.runTx("rollback");
  }

  close(): void {
    const ws = this.ws;
    if (!ws) {
      this.setStatus("closed");
      return;
    }
    ws.close();
  }

  private async runTx(action: "begin" | "commit" | "rollback"): Promise<void> {
    await this.connect();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new ProdbSocketError(CLOSED_ERROR, false);
    }
    if (this.txWaiter) {
      throw new ProdbSocketError("이전 트랜잭션 요청이 아직 완료되지 않았습니다", false);
    }
    const expected: TxMessage["state"] =
      action === "begin" ? "began" : action === "commit" ? "committed" : "rolledback";
    const promise = new Promise<void>((resolve, reject) => {
      this.txWaiter = { expected, resolve, reject };
    });
    ws.send(JSON.stringify({ type: "tx", action }));
    return promise;
  }

  private setStatus(status: SocketStatus): void {
    if (this.statusValue === status) {
      return;
    }
    this.statusValue = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }

  private handleMessage(data: unknown): void {
    if (typeof data === "string") {
      this.handleText(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      try {
        this.pendingFrames.push(decodeArrow(data));
      } catch {
        return;
      }
    }
  }

  private handleText(raw: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    if (message.type === "meta") {
      const waiter = this.metaWaiter;
      if (waiter && waiter.id === message.id) {
        this.metaWaiter = null;
        waiter.resolve(message);
      }
      return;
    }
    if (message.type === "window") {
      const frames = this.pendingFrames;
      this.pendingFrames = [];
      const waiter = this.windowWaiters.get(message.offset);
      if (waiter && waiter.id === message.id) {
        this.windowWaiters.delete(message.offset);
        clearTimeout(waiter.timer);
        waiter.resolve(message.count > 0 ? concatRows(frames) : []);
      }
      return;
    }
    if (message.type === "error") {
      const error = new ProdbSocketError(message.message, message.cancelled);
      const meta = this.metaWaiter;
      if (meta && (message.id === null || message.id === meta.id)) {
        this.metaWaiter = null;
        meta.reject(error);
      }
      const targetId = message.id ?? this.activeQueryId;
      if (targetId !== null) {
        for (const [offset, waiter] of this.windowWaiters) {
          if (waiter.id === targetId) {
            this.windowWaiters.delete(offset);
            clearTimeout(waiter.timer);
            waiter.reject(error);
          }
        }
      }
      if (this.editWaiter) {
        const edit = this.editWaiter;
        this.editWaiter = null;
        edit.reject(error);
      }
      if (this.txWaiter) {
        const tx = this.txWaiter;
        this.txWaiter = null;
        tx.reject(error);
      }
      return;
    }
    if (message.type === "edited") {
      const waiter = this.editWaiter;
      if (waiter) {
        this.editWaiter = null;
        waiter.resolve({
          rowsAffected: message.rows_affected,
          row: message.row,
          col: message.col,
          value: message.value,
        });
      }
      return;
    }
    if (message.type === "tx") {
      const waiter = this.txWaiter;
      if (waiter) {
        this.txWaiter = null;
        if (waiter.expected === message.state) {
          waiter.resolve();
        } else {
          waiter.reject(new ProdbSocketError(`예상하지 못한 트랜잭션 상태: ${message.state}`, false));
        }
      }
    }
  }

  private cancelPending(): void {
    const error = new ProdbSocketError(CANCELLED_ERROR, true);
    if (this.metaWaiter) {
      const waiter = this.metaWaiter;
      this.metaWaiter = null;
      waiter.reject(error);
    }
    for (const [offset, waiter] of this.windowWaiters) {
      this.windowWaiters.delete(offset);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pendingFrames = [];
  }

  private failPending(error: ProdbSocketError): void {
    if (this.metaWaiter) {
      const waiter = this.metaWaiter;
      this.metaWaiter = null;
      waiter.reject(error);
    }
    for (const [offset, waiter] of this.windowWaiters) {
      this.windowWaiters.delete(offset);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    if (this.editWaiter) {
      const waiter = this.editWaiter;
      this.editWaiter = null;
      waiter.reject(error);
    }
    if (this.txWaiter) {
      const waiter = this.txWaiter;
      this.txWaiter = null;
      waiter.reject(error);
    }
    this.pendingFrames = [];
  }
}
