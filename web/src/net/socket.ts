import { tableFromIPC } from "apache-arrow";
import type { AppError } from "../errorHelp";
import { WindowedRowSource, type ValueExpr } from "../grid/windowSource";
import { t } from "../i18n";

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
  // What the driver says a column holds ("boolean" for MySQL's TINYINT(1)),
  // for results whose table structure isn't known; absent from older servers.
  columnKinds?: (string | null)[];
  // Rows a statement with no result columns (UPDATE, DDL…) changed; absent
  // where the driver doesn't say (SQL Server) or from older servers.
  rowsAffected?: number;
  // Whether a transaction is open once the statement finished (BEGIN/COMMIT
  // typed in the editor move it); absent from older servers.
  inTx?: boolean;
  // The statement ended the transaction, and whether other results' rows were
  // dropped on the server (they must load again).
  txEnded?: "committed" | "rolledback";
  invalidated?: boolean;
}

export interface QueryResult {
  meta: QueryMeta;
  source: WindowedRowSource;
  queryId: string;
  conn: string;
}

export interface EditRequest {
  session: string;
  table: string;
  pk: { column: string; value: string | number | null }[];
  column: string;
  value: string | null;
  // Written by the database in place of `value`.
  expr?: ValueExpr;
  row: number;
  col: number;
}

export interface EditResult {
  rowsAffected: number;
  row: number;
  col: number;
  value: string | null;
}

export interface RowChange {
  id: string | null;
  conn: string | null;
  op: "insert" | "delete" | "tx";
  rowsAffected: number;
  invalidate: boolean;
}

export interface InsertRowRequest {
  session: string;
  table: string;
  values: { column: string; value: string | null; expr?: ValueExpr }[];
}

export interface DeleteRowRequest {
  session: string;
  table: string;
  pk: { column: string; value: string | null }[];
}

// One statement the server sent to the database, as the console shows it.
export interface ConsoleEntry {
  seq: number;
  atMs: number;
  sql: string;
}

export interface ConsoleUpdate {
  conn: string;
  entries: ConsoleEntry[];
  // Replace what's shown rather than append (first answer, gap, or clear).
  reset: boolean;
  // The connection's engine went away: watch again from scratch.
  closed: boolean;
}

type RowOpMessage =
  | ({ type: "insert_row" } & InsertRowRequest)
  | ({ type: "delete_row" } & DeleteRowRequest);

// A query or edit that failed, with what the server said about it (see
// AppError): the code, and the SQLSTATE, position and driver text when known.
export class TablePeekSocketError extends Error {
  readonly cancelled: boolean;
  // A COMMIT the server turned into a rollback (the transaction had failed):
  // nothing is open any more and nothing was written.
  readonly rolledBack: boolean;
  // "network" when the TablePeek server could not be reached; otherwise the
  // server's code ("" when it gave none).
  code = "";
  sqlstate?: string;
  position?: AppError["position"];
  server_code?: number;
  code_name?: string;
  details?: unknown;
  raw?: string;
  // For a failed query: whether a transaction is still open after it, and
  // whether it ended one (see QueryMeta).
  inTx?: boolean;
  txEnded?: "committed" | "rolledback";
  invalidated?: boolean;
  // A COMMIT whose outcome is not known (the connection dropped with it):
  // it may have committed, so it doesn't count as rolled back.
  outcomeUnknown?: boolean;

  constructor(message: string, cancelled: boolean, rolledBack = false, fields?: ServerErrorFields) {
    super(message);
    this.name = "TablePeekSocketError";
    this.cancelled = cancelled;
    this.rolledBack = rolledBack;
    if (fields !== undefined) {
      this.code = fields.code ?? "";
      this.sqlstate = fields.sqlstate;
      this.position = fields.position;
      this.server_code = fields.server_code;
      this.code_name = fields.code_name;
      this.details = fields.details;
      this.raw = fields.raw;
    }
  }
}

type ServerErrorFields = Partial<Omit<AppError, "message">>;

// The server could not be reached, or the socket to it dropped.
function networkError(message: string): TablePeekSocketError {
  return new TablePeekSocketError(t(message), false, false, { code: "network" });
}

interface MetaMessage {
  type: "meta";
  conn?: string;
  id: string;
  kind: string;
  columns: string[];
  row_count: number;
  elapsed_ms: number;
  truncated: boolean;
  source_table: string | null;
  pk: string[] | null;
  column_kinds?: (string | null)[];
  rows_affected?: number | null;
  in_tx?: boolean;
  tx?: "committed" | "rolledback";
  invalidate?: boolean;
}

interface WindowMessage {
  type: "window";
  conn?: string;
  id: string;
  offset: number;
  count: number;
}

interface ErrorMessage extends ServerErrorFields {
  type: "error";
  conn?: string | null;
  id: string | null;
  message: string;
  cancelled: boolean;
  in_tx?: boolean;
  tx?: "committed" | "rolledback";
  invalidate?: boolean;
}

interface EditedMessage {
  type: "edited";
  conn?: string;
  row: number;
  col: number;
  column: string;
  value: string | null;
  rows_affected: number;
}

interface TxMessage {
  type: "tx";
  conn?: string;
  state: "began" | "committed" | "rolledback";
  invalidate?: boolean;
  unknown?: boolean;
}

interface RowChangeMessage {
  type: "row_change";
  conn?: string;
  id: string | null;
  op: "insert" | "delete";
  rows_affected: number;
  invalidate: boolean;
}

interface ConsoleMessage {
  type: "console";
  conn: string;
  entries: { seq: number; at_ms: number; sql: string }[];
  reset: boolean;
}

interface ConsoleClosedMessage {
  type: "console_closed";
  conn: string;
}

type ServerMessage =
  | ConsoleMessage
  | ConsoleClosedMessage
  | MetaMessage
  | WindowMessage
  | ErrorMessage
  | EditedMessage
  | TxMessage
  | RowChangeMessage;

interface MetaWaiter {
  id: string;
  conn: string;
  resolve: (message: MetaMessage) => void;
  reject: (error: TablePeekSocketError) => void;
}

interface WindowWaiter {
  id: string;
  conn: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (rows: unknown[][]) => void;
  reject: (error: TablePeekSocketError) => void;
}

interface EditWaiter {
  conn: string;
  resolve: (result: EditResult) => void;
  reject: (error: TablePeekSocketError) => void;
}

interface TxWaiter {
  conn: string;
  expected: TxMessage["state"];
  // A COMMIT came back rolled back; the error with the reason follows.
  rolledBack?: boolean;
  // …or with its outcome unknown.
  unknown?: boolean;
  resolve: () => void;
  reject: (error: TablePeekSocketError) => void;
}

interface RowWaiter {
  conn: string;
  resolve: (change: RowChange) => void;
  reject: (error: TablePeekSocketError) => void;
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

export class TablePeekSocket {
  private readonly url: string;
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private statusValue: SocketStatus = "closed";
  private readonly statusListeners = new Set<(status: SocketStatus) => void>();
  private readonly metaWaiters = new Map<string, MetaWaiter>();
  private readonly windowWaiters = new Map<string, WindowWaiter>();
  private readonly editWaiters = new Map<string, EditWaiter>();
  private readonly txWaiters = new Map<string, TxWaiter>();
  private readonly rowWaiters = new Map<string, RowWaiter>();
  // Queries a background job runs (an export's pages): the page's next query
  // doesn't cancel them, and a connection-wide error isn't theirs.
  private readonly jobQueries = new Set<string>();
  private readonly rowChangeListeners = new Set<(change: RowChange) => void>();
  private readonly consoleListeners = new Set<(update: ConsoleUpdate) => void>();
  // Connections whose console a panel is showing.
  private readonly consoleWanted = new Set<string>();
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
        reject(networkError(CONNECT_ERROR));
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
          this.failPending(networkError(CLOSED_ERROR));
        }
        failConnect();
      };
    });
    return this.connectPromise;
  }

  async query(
    conn: string,
    sql: string,
    // history: file the run under this connection's history (editor runs only).
    // job: a background job's read, which runs beside the page's queries
    // (neither cancels the other) and whose rows the server keeps only until
    // its source is disposed.
    options: { maxRows: number; window: number; history?: boolean; job?: boolean },
  ): Promise<QueryResult> {
    await this.connect();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw networkError(CLOSED_ERROR);
    }
    const job = options.job === true;
    if (!job) {
      this.cancelPending(conn);
    }
    const queryId = crypto.randomUUID();
    if (job) {
      this.jobQueries.add(queryId);
    }
    const messagePromise = new Promise<MetaMessage>((resolve, reject) => {
      this.metaWaiters.set(queryId, { id: queryId, conn, resolve, reject });
      ws.send(
        JSON.stringify({
          type: "query",
          conn,
          id: queryId,
          sql,
          max_rows: options.maxRows,
          window: options.window,
          ...(options.history === true ? { history: true } : {}),
          ...(job ? { job: true } : {}),
        }),
      );
    });
    let message: MetaMessage;
    try {
      message = await messagePromise;
    } catch (error) {
      this.jobQueries.delete(queryId);
      throw error;
    }
    const meta: QueryMeta = {
      id: message.id,
      kind: message.kind,
      columns: message.columns,
      rowCount: message.row_count,
      elapsedMs: message.elapsed_ms,
      truncated: message.truncated,
      sourceTable: message.source_table,
      pk: message.pk,
      columnKinds: message.column_kinds,
      rowsAffected: message.rows_affected ?? undefined,
      inTx: message.in_tx,
      txEnded: message.tx,
      invalidated: message.invalidate,
    };
    const source = new WindowedRowSource({
      columns: meta.columns,
      rowCount: meta.rowCount,
      windowSize: options.window,
      fetchWindow: (offset, limit) => this.fetch(conn, queryId, offset, limit),
      onDispose: job ? () => this.release(conn, queryId) : undefined,
    });
    return { meta, source, queryId, conn };
  }

  // A job is done reading a result: the server lets it go.
  release(conn: string, id: string): void {
    this.jobQueries.delete(id);
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "release", conn, id }));
    }
  }

  private windowKey(conn: string, id: string, offset: number): string {
    return `${conn}\u0000${id}\u0000${offset}`;
  }

  async fetch(conn: string, id: string, offset: number, limit: number): Promise<unknown[][]> {
    await this.connect();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw networkError(CLOSED_ERROR);
    }
    const key = this.windowKey(conn, id, offset);
    const existing = this.windowWaiters.get(key);
    if (existing) {
      this.windowWaiters.delete(key);
      clearTimeout(existing.timer);
      existing.reject(new TablePeekSocketError(t(CANCELLED_ERROR), true));
    }
    return new Promise<unknown[][]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.windowWaiters.delete(key);
        reject(new TablePeekSocketError(t(FETCH_TIMEOUT_ERROR), false));
      }, FETCH_TIMEOUT_MS);
      this.windowWaiters.set(key, { id, conn, timer, resolve, reject });
      ws.send(JSON.stringify({ type: "fetch", conn, id, offset, limit }));
    });
  }

  // job: a background job's Stop, which interrupts the job's statement
  // running now (and only that).
  cancel(conn: string, job = false): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "cancel", conn, ...(job ? { job: true } : {}) }));
    }
  }

  async edit(conn: string, request: EditRequest): Promise<EditResult> {
    await this.connect();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw networkError(CLOSED_ERROR);
    }
    if (this.editWaiters.has(conn)) {
      throw new TablePeekSocketError(t("이전 수정 요청이 아직 완료되지 않았습니다"), false);
    }
    const result = new Promise<EditResult>((resolve, reject) => {
      this.editWaiters.set(conn, { conn, resolve, reject });
    });
    ws.send(JSON.stringify({ type: "edit", conn, ...request }));
    return result;
  }

  // job: an import's own transaction (the server lets nothing cancel the
  // page's statements while it is open).
  begin(conn: string, job = false): Promise<void> {
    return this.runTx(conn, "begin", job);
  }

  onRowChange(listener: (change: RowChange) => void): () => void {
    this.rowChangeListeners.add(listener);
    return () => {
      this.rowChangeListeners.delete(listener);
    };
  }

  insertRow(conn: string, request: InsertRowRequest): Promise<RowChange> {
    return this.sendRowOp(conn, { type: "insert_row", ...request });
  }

  deleteRow(conn: string, request: DeleteRowRequest): Promise<RowChange> {
    return this.sendRowOp(conn, { type: "delete_row", ...request });
  }

  commit(conn: string, job = false): Promise<void> {
    return this.runTx(conn, "commit", job);
  }

  rollback(conn: string, job = false): Promise<void> {
    return this.runTx(conn, "rollback", job);
  }

  close(): void {
    const ws = this.ws;
    if (!ws) {
      this.setStatus("closed");
      return;
    }
    ws.close();
  }

  private async sendRowOp(conn: string, message: RowOpMessage): Promise<RowChange> {
    await this.connect();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw networkError(CLOSED_ERROR);
    }
    const id = crypto.randomUUID();
    const promise = new Promise<RowChange>((resolve, reject) => {
      this.rowWaiters.set(id, { conn, resolve, reject });
    });
    ws.send(JSON.stringify({ ...message, conn, id }));
    return promise;
  }

  // Asks for the statements logged on `conn` after `since` (all of them for
  // null); the server answers and then keeps pushing new ones on this socket.
  async watchConsole(conn: string, since: number | null): Promise<void> {
    this.consoleWanted.add(conn);
    await this.connect();
    // Unwatched while the socket was still opening: don't start pushes now.
    if (!this.consoleWanted.has(conn)) {
      return;
    }
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw networkError(CLOSED_ERROR);
    }
    ws.send(JSON.stringify({ type: "console", conn, since }));
  }

  // Stops the pushes for `conn` (the console closed); nothing to wait for.
  unwatchConsole(conn: string): void {
    this.consoleWanted.delete(conn);
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "console_unwatch", conn }));
    }
  }

  onConsole(listener: (update: ConsoleUpdate) => void): () => void {
    this.consoleListeners.add(listener);
    return () => {
      this.consoleListeners.delete(listener);
    };
  }

  private emitConsole(update: ConsoleUpdate): void {
    for (const listener of this.consoleListeners) {
      listener(update);
    }
  }

  private emitRowChange(change: RowChange): void {
    for (const listener of this.rowChangeListeners) {
      listener(change);
    }
  }

  private async runTx(conn: string, action: "begin" | "commit" | "rollback", job: boolean): Promise<void> {
    await this.connect();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw networkError(CLOSED_ERROR);
    }
    if (this.txWaiters.has(conn)) {
      throw new TablePeekSocketError(t("이전 트랜잭션 요청이 아직 완료되지 않았습니다"), false);
    }
    const expected: TxMessage["state"] =
      action === "begin" ? "began" : action === "commit" ? "committed" : "rolledback";
    const promise = new Promise<void>((resolve, reject) => {
      this.txWaiters.set(conn, { conn, expected, resolve, reject });
    });
    ws.send(JSON.stringify({ type: "tx", conn, action, ...(job ? { job: true } : {}) }));
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
    if (message.type === "console") {
      this.emitConsole({
        conn: message.conn,
        entries: message.entries.map((entry) => ({
          seq: entry.seq,
          atMs: entry.at_ms,
          sql: entry.sql,
        })),
        reset: message.reset,
        closed: false,
      });
      return;
    }
    if (message.type === "console_closed") {
      this.emitConsole({ conn: message.conn, entries: [], reset: true, closed: true });
      return;
    }
    if (message.type === "meta") {
      const waiter = this.metaWaiters.get(message.id);
      if (waiter) {
        this.metaWaiters.delete(message.id);
        waiter.resolve(message);
      }
      return;
    }
    if (message.type === "window") {
      const frames = this.pendingFrames;
      this.pendingFrames = [];
      const conn = message.conn ?? "";
      const key = this.windowKey(conn, message.id, message.offset);
      const rows = message.count > 0 ? concatRows(frames) : [];
      const waiter = this.windowWaiters.get(key);
      if (waiter) {
        this.windowWaiters.delete(key);
        clearTimeout(waiter.timer);
        waiter.resolve(rows);
      }
      // A window nobody waits for is dropped: the first one the server sends
      // unasked after a query's meta, or a second reply for a window that one
      // already answered. Handing it to another offset's waiter would show (or
      // export) those rows twice.
      return;
    }
    if (message.type === "error") {
      // The reason a COMMIT came back rolled back belongs to that COMMIT alone;
      // rows being fetched meanwhile carry on.
      const rolledBack = message.id == null && message.conn != null ? this.txWaiters.get(message.conn) : undefined;
      if (rolledBack?.rolledBack) {
        this.txWaiters.delete(rolledBack.conn);
        const failure = new TablePeekSocketError(message.message, false, true, message);
        failure.outcomeUnknown = rolledBack.unknown === true;
        rolledBack.reject(failure);
        return;
      }
      const error = new TablePeekSocketError(message.message, message.cancelled, false, message);
      error.inTx = message.in_tx;
      error.txEnded = message.tx;
      error.invalidated = message.invalidate;
      for (const [id, waiter] of this.metaWaiters) {
        const matches =
          message.id !== null
            ? message.id === id
            : !this.jobQueries.has(id) && (message.conn == null || message.conn === waiter.conn);
        if (matches) {
          this.metaWaiters.delete(id);
          waiter.reject(error);
        }
      }
      for (const [key, waiter] of this.windowWaiters) {
        const matches =
          message.id !== null
            ? waiter.id === message.id
            : !this.jobQueries.has(waiter.id) && (message.conn == null || message.conn === waiter.conn);
        if (matches) {
          this.windowWaiters.delete(key);
          clearTimeout(waiter.timer);
          waiter.reject(error);
        }
      }
      // Edit and tx failures arrive without an id; an id-bearing error belongs to
      // a query, window fetch or row op and must not fail an in-flight edit/COMMIT.
      const idless = message.id == null;
      if (idless && message.conn != null) {
        const edit = this.editWaiters.get(message.conn);
        if (edit) {
          this.editWaiters.delete(message.conn);
          edit.reject(error);
        }
      } else if (idless) {
        for (const [conn, edit] of this.editWaiters) {
          this.editWaiters.delete(conn);
          edit.reject(error);
        }
      }
      for (const [id, waiter] of this.rowWaiters) {
        const matches =
          message.id !== null ? id === message.id : message.conn == null || message.conn === waiter.conn;
        if (matches) {
          this.rowWaiters.delete(id);
          waiter.reject(error);
        }
      }
      const txError = (tx: TxWaiter): TablePeekSocketError =>
        tx.rolledBack ? new TablePeekSocketError(message.message, false, true, message) : error;
      if (idless && message.conn != null) {
        const tx = this.txWaiters.get(message.conn);
        if (tx) {
          this.txWaiters.delete(message.conn);
          tx.reject(txError(tx));
        }
      } else if (idless) {
        for (const [conn, tx] of this.txWaiters) {
          this.txWaiters.delete(conn);
          tx.reject(txError(tx));
        }
      }
      return;
    }
    if (message.type === "edited") {
      const waiter = message.conn != null ? this.editWaiters.get(message.conn) : undefined;
      if (waiter) {
        this.editWaiters.delete(message.conn as string);
        waiter.resolve({
          rowsAffected: message.rows_affected,
          row: message.row,
          col: message.col,
          value: message.value,
        });
      } else if (message.conn == null) {
        const first = this.editWaiters.entries().next();
        if (!first.done) {
          this.editWaiters.delete(first.value[0]);
          first.value[1].resolve({
            rowsAffected: message.rows_affected,
            row: message.row,
            col: message.col,
            value: message.value,
          });
        }
      }
      return;
    }
    if (message.type === "tx") {
      const waiter = message.conn != null ? this.txWaiters.get(message.conn) : undefined;
      const target = waiter ?? (message.conn == null ? this.txWaiters.entries().next().value?.[1] : undefined);
      if (target) {
        if (target.expected === "committed" && message.state === "rolledback") {
          // Keep waiting for the reason; settle without it if none comes.
          target.rolledBack = true;
          target.unknown = message.unknown === true;
          window.setTimeout(() => {
            if (this.txWaiters.get(target.conn) === target) {
              this.txWaiters.delete(target.conn);
              const failure = new TablePeekSocketError(t("트랜잭션이 오류로 중단되어 롤백했습니다"), false, true);
              failure.outcomeUnknown = target.unknown === true;
              target.reject(failure);
            }
          }, 2000);
        } else {
          this.txWaiters.delete(target.conn);
        }
        if (target.rolledBack) {
          // Settled when the reason arrives.
        } else if (target.expected === message.state) {
          target.resolve();
        } else {
          target.reject(new TablePeekSocketError(
            t("예상하지 못한 트랜잭션 상태: {state}", { state: message.state }),
            false,
          ));
        }
      }
      if (message.invalidate === true) {
        this.emitRowChange({
          id: null,
          conn: message.conn ?? null,
          op: "tx",
          rowsAffected: 0,
          invalidate: true,
        });
      }
      return;
    }
    if (message.type === "row_change") {
      const change: RowChange = {
        id: message.id,
        conn: message.conn ?? null,
        op: message.op,
        rowsAffected: message.rows_affected,
        invalidate: message.invalidate === true,
      };
      if (message.id !== null) {
        const waiter = this.rowWaiters.get(message.id);
        if (waiter) {
          this.rowWaiters.delete(message.id);
          waiter.resolve(change);
        }
      }
      this.emitRowChange(change);
    }
  }

  // The page's newer query replaces what it was still waiting for; a job's
  // reads carry on. Frames already in are left alone: the server sends a
  // window's frames and its "window" message together, so they belong to
  // the next window message, which may well be a job's.
  private cancelPending(conn: string): void {
    const error = new TablePeekSocketError(t(CANCELLED_ERROR), true);
    for (const [id, waiter] of this.metaWaiters) {
      if (waiter.conn === conn && !this.jobQueries.has(id)) {
        this.metaWaiters.delete(id);
        waiter.reject(error);
      }
    }
    for (const [key, waiter] of this.windowWaiters) {
      if (waiter.conn === conn && !this.jobQueries.has(waiter.id)) {
        this.windowWaiters.delete(key);
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
  }

  private failPending(error: TablePeekSocketError): void {
    for (const [id, waiter] of this.metaWaiters) {
      this.metaWaiters.delete(id);
      waiter.reject(error);
    }
    for (const [key, waiter] of this.windowWaiters) {
      this.windowWaiters.delete(key);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    for (const [conn, waiter] of this.editWaiters) {
      this.editWaiters.delete(conn);
      waiter.reject(error);
    }
    for (const [conn, waiter] of this.txWaiters) {
      this.txWaiters.delete(conn);
      waiter.reject(error);
    }
    for (const [key, waiter] of this.rowWaiters) {
      this.rowWaiters.delete(key);
      waiter.reject(error);
    }
    this.pendingFrames = [];
  }
}
