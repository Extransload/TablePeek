import type { PkPair, StagedExpr, WindowedRowSource } from "./grid/windowSource";
import { cellToString } from "./rowOps";
import {
  TablePeekSocket,
  TablePeekSocketError,
  type ConsoleUpdate,
  type QueryMeta,
} from "./net/socket";
import type { DefinitionKind } from "./sqlTools";
import type { InstalledFont } from "./fonts";
import { t } from "./i18n";
import { appErrorFromBody, toAppError, type AppError } from "./errorHelp";
// The TX controls' failures belong to no tab: they go to the error toasts.
import { notifyError } from "./components/ErrorNotice";
import type { Capabilities, EngineDescriptor, FieldValue } from "./engines";

export interface EngineMeta {
  // The engine's id.
  kind: string;
  path: string | null;
  demo: boolean;
  tables: string[];
  // What this connection can actually do; absent from servers that predate it.
  capabilities?: Capabilities;
}

export interface FsEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
  size: number | null;
}

export interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

export interface PathStat {
  path: string;
  exists: boolean;
  is_file: boolean;
  readable: boolean;
}

export interface TableSchemaColumn {
  name: string;
  decl_type: string | null;
  not_null: boolean;
  pk: boolean;
}

export interface TableSchema {
  name: string;
  columns: TableSchemaColumn[];
}

// A foreign key: `table`(`columns`) refers to `ref_table`(`ref_columns`),
// tables named as /api/schema names them.
export interface Relation {
  table: string;
  columns: string[];
  ref_table: string;
  ref_columns: string[];
}

export interface TableDetailColumn {
  name: string;
  decl_type: string | null;
  not_null: boolean;
  pk: boolean;
  default: string | null;
  // An enum's (or MySQL set's) labels, in order, when the driver knows them.
  enum_values?: string[];
}

export interface TableDetailIndex {
  name: string;
  unique: boolean;
  primary: boolean;
  columns: string[];
  // The engine's own statement for the index (PostgreSQL, CockroachDB, SQLite).
  definition?: string;
  // A partial (filtered) index's predicate, without WHERE.
  where?: string;
  // The key parts in order (PostgreSQL, CockroachDB, MySQL, SQL Server): a
  // column, with MySQL's prefix length, or an expression; descending or not.
  parts?: { column?: string; expression?: string; prefix_length?: number; descending?: boolean }[];
  // Non-key columns the index carries (INCLUDE).
  included?: string[];
}

export interface TableDetailForeignKey {
  name: string;
  columns: string[];
  ref_table: string;
  ref_columns: string[];
}

// A trigger on a table; the statement that makes it, when the driver gives it.
export interface TableDetailTrigger {
  name: string;
  timing?: string | null;
  event?: string | null;
  definition: string | null;
}

export interface TableDetail {
  name: string;
  schema: string | null;
  row_count_estimate: number | null;
  // Total of data and indexes; the parts and the comment when the driver knows them.
  size_bytes: number | null;
  data_bytes?: number | null;
  index_bytes?: number | null;
  comment?: string | null;
  columns: TableDetailColumn[];
  indexes: TableDetailIndex[];
  foreign_keys: TableDetailForeignKey[];
  ddl: string | null;
  // Absent from servers that predate it.
  triggers?: TableDetailTrigger[];
}

export interface ServerSession {
  id: string;
  user: string | null;
  database: string | null;
  state: string | null;
  query: string | null;
  elapsed_ms: number | null;
  is_current: boolean;
}

export interface ServerInfo {
  driver: string;
  version: string | null;
  database: string | null;
  encoding: string | null;
  uptime: string | null;
  size_bytes: number | null;
  sessions: ServerSession[] | null;
  can_kill: boolean;
  // Document stores: "standalone", "replica_set", "sharded"…, and the host it reached.
  topology?: string | null;
  host?: string | null;
}

export interface ObjectList {
  views: string[];
  functions: string[];
  triggers: string[];
  sequences: string[];
  procedures: string[];
}

export interface DefinitionDetail {
  name: string;
  kind: string;
  ddl: string | null;
}

// An engine's connection settings, keyed by its form's field keys (see the
// engine's `connection.fields`), e.g. { host, port, user, database, ssl_mode }.
export type ConnConfig = Record<string, FieldValue>;

export interface SshInput {
  host: string;
  port: number;
  user: string;
  password?: string;
  private_key_path?: string;
}

export interface HttpTunnelInput {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface ConnectInput {
  // The engine's id.
  driver: string;
  config: ConnConfig;
  ssh?: SshInput;
  http_tunnel?: HttpTunnelInput;
}

export interface SavedSsh {
  host: string;
  port: number;
  user: string;
  private_key_path?: string;
}

export interface SavedHttpTunnel {
  host: string;
  port: number;
  username?: string;
}

// A saved profile as the server lists it: its settings without the secrets,
// which stay in the keychain (`has_password` tells whether one is kept).
export interface SavedConnection {
  id: string;
  name: string;
  driver: string;
  config: ConnConfig;
  ssh?: SavedSsh;
  http_tunnel?: SavedHttpTunnel;
  persist_password: boolean;
  has_password: boolean;
  last_used?: number;
}

export interface ConnSummary {
  id: string;
  label: string;
  saved_id?: string;
  is_default: boolean;
  kind: string;
  path?: string | null;
  demo: boolean;
  table_count: number;
  // This connection's own safe mode; null when the app-wide default applies.
  safe_mode?: number | null;
}

export interface LiveConn {
  conn: string;
  meta: EngineMeta;
}

// One statement run from the editor, or made by a change committed from the
// grid, structure or user views, on a connection; `at` is in seconds.
export interface HistoryEntry {
  id: string;
  sql: string;
  at: number;
  ms: number;
  ok: boolean;
  rows: number;
  error?: string;
}

// A saved query (TablePlus's "Queries"), shared by every connection.
export interface Favorite {
  id: string;
  name: string;
  sql: string;
  keyword?: string | null;
  folder?: string | null;
  // Unix seconds.
  created_at: number;
  updated_at: number;
}

export interface FavoriteFolder {
  id: string;
  name: string;
  created_at: number;
}

export interface FavoriteChanges {
  name?: string;
  sql?: string;
  keyword?: string | null;
  folder?: string | null;
}

export interface GridResult {
  queryId: string;
  sql: string;
  meta: QueryMeta;
  source: WindowedRowSource;
  conn: string;
}

export type Status = "idle" | "running" | "error";
export type Connection = "connecting" | "open" | "closed";
export type TxState = "none" | "active";

// Whether this page can reach the TablePeek server: "down" while neither REST
// nor the socket gets through (retried by itself), "restarted" when the server
// answers but no longer knows this page's token (it was started again).
export type ServerReach = "up" | "down" | "restarted";

export interface ServerState {
  reach: ServerReach;
  // When the next automatic try starts (ms since the epoch), while "down".
  retryAt: number | null;
  checking: boolean;
  // Counts the returns from "down": panels read again on a change.
  epoch: number;
}

// A batch of staged changes that failed at one row (and cell, for an edit):
// the grid marks it until the changes are applied, discarded or replaced.
export interface EditFailure {
  result: GridResult;
  row: number;
  col: number | null;
  error: AppError;
}

export interface StoreState {
  status: Status;
  // The error of the tab in front (its run, reload or apply); each tab keeps
  // its own, and errors outside a tab go to the error toasts instead.
  error: AppError | null;
  editFailure: EditFailure | null;
  info: string | null;
  meta: EngineMeta | null;
  result: GridResult | null;
  connection: Connection;
  tx: TxState;
  connId: string | null;
  tabId: string | null;
  // The system's file dialog was asked for and isn't on screen yet.
  filePickOpening: boolean;
  server: ServerState;
}

export interface TabSnapshot {
  id: string;
  sql: string;
  source: WindowedRowSource | null;
  meta: QueryMeta | null;
  info: string | null;
  error: AppError | null;
}

export type QueryOutcome =
  | { kind: "ok"; result: GridResult }
  | { kind: "cancelled" }
  | { kind: "error"; error: AppError };

const TOKEN_KEY = "tablepeek.token";
const UNKNOWN_ERROR = "알 수 없는 오류가 발생했습니다";
const NETWORK_ERROR = "서버에 연결할 수 없습니다";
const QUERY_WINDOW = 1000;
const CANCELLED_INFO = "쿼리가 취소되었습니다";

function initialToken(): string {
  let fromUrl: string | null = null;
  try {
    fromUrl = new URL(window.location.href).searchParams.get("token");
  } catch {
    fromUrl = null;
  }
  if (fromUrl) {
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("token");
      window.history.replaceState(null, "", url.toString());
    } catch {}
    try {
      window.localStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {}
    return fromUrl;
  }
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

const tokenValue = initialToken();

let state: StoreState = {
  status: "idle",
  error: null,
  editFailure: null,
  info: null,
  meta: null,
  result: null,
  connection: "closed",
  tx: "none",
  connId: null,
  tabId: null,
  filePickOpening: false,
  server: { reach: "up", retryAt: null, checking: false, epoch: 0 },
};

const listeners = new Set<() => void>();

function setState(patch: Partial<StoreState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) {
    listener();
  }
}

function errorOf(error: unknown): AppError {
  return toAppError(error, t(UNKNOWN_ERROR));
}

// A failed REST call, with what the server said about it (see AppError).
export class ApiRequestError extends Error {
  readonly code: string;
  readonly sqlstate?: string;
  readonly position?: AppError["position"];
  readonly server_code?: number;
  readonly code_name?: string;
  readonly details?: unknown;
  readonly raw?: string;

  constructor(error: AppError) {
    super(error.message);
    this.code = error.code;
    this.sqlstate = error.sqlstate;
    this.position = error.position;
    this.server_code = error.server_code;
    this.code_name = error.code_name;
    this.details = error.details;
    this.raw = error.raw;
  }
}

export type MissingSecret = "db" | "ssh" | "http";

// Which stored secret the server needs typed in, if that is why a connect failed.
export function missingSecretOf(error: unknown): MissingSecret | null {
  if (!(error instanceof ApiRequestError)) {
    return null;
  }
  switch (error.code) {
    case "password_required":
      return "db";
    case "ssh_password_required":
      return "ssh";
    case "http_password_required":
      return "http";
    default:
      return null;
  }
}

function networkError(): ApiRequestError {
  return new ApiRequestError({ code: "network", message: t(NETWORK_ERROR) });
}

// A request that reached nothing marks the server down; one refused for its
// token marks it restarted. Every REST call (and the Mongo workbench's) goes
// through here, so the app banner is the one place that says so.
async function serverFetch(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-tablepeek-token": tokenValue,
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    // An aborted request (a cancelled export, say) says nothing about the server.
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    serverUnreachable();
    throw networkError();
  }
  if (response.status === 401) {
    serverRestarted();
  } else if (state.server.reach !== "up") {
    serverReached();
  }
  return response;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await serverFetch(path, init);
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new ApiRequestError(appErrorFromBody(body, response.status));
  }
  return body as T;
}

// Waits between automatic tries while the server is down, growing to the last.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];
let retryTimer: number | undefined;
let retryCount = 0;

function setServer(patch: Partial<ServerState>): void {
  setState({ server: { ...state.server, ...patch } });
}

function serverUnreachable(): void {
  if (state.server.reach === "restarted") {
    return;
  }
  if (state.server.reach === "up") {
    retryCount = 0;
    setServer({ reach: "down" });
  }
  if (retryTimer === undefined && !state.server.checking) {
    scheduleRetry();
  }
}

function scheduleRetry(): void {
  const delay = RETRY_DELAYS_MS[Math.min(retryCount, RETRY_DELAYS_MS.length - 1)];
  retryCount += 1;
  retryTimer = window.setTimeout(() => void reconnect(), delay);
  setServer({ retryAt: Date.now() + delay });
}

function serverRestarted(): void {
  window.clearTimeout(retryTimer);
  retryTimer = undefined;
  if (state.server.reach !== "restarted") {
    setServer({ reach: "restarted", retryAt: null, checking: false });
  }
}

function serverReached(): void {
  window.clearTimeout(retryTimer);
  retryTimer = undefined;
  retryCount = 0;
  if (state.server.reach === "down") {
    setServer({ reach: "up", retryAt: null, checking: false, epoch: state.server.epoch + 1 });
  }
}

// One try at the server now (the banner's 다시 연결, or the timer): a cheap
// authenticated call, then the socket.
async function reconnect(): Promise<void> {
  if (state.server.reach !== "down" || state.server.checking) {
    return;
  }
  window.clearTimeout(retryTimer);
  retryTimer = undefined;
  setServer({ checking: true, retryAt: null });
  try {
    // Any reply marks the server reached (or restarted); then the socket.
    await serverFetch("/api/engines");
    await ensureSocket().connect();
  } catch {
    // Still down: the next try is planned below.
  }
  setServer({ checking: false });
  // Read afresh: the awaits above moved it.
  if (getState().server.reach === "down" && retryTimer === undefined) {
    scheduleRetry();
  }
}

// The address the restarted server printed (or just its token): this page
// opens again with it.
function openNewAddress(text: string): boolean {
  const trimmed = text.trim();
  let next: string | null = null;
  try {
    next = new URL(trimmed).searchParams.get("token");
  } catch {
    next = /^[0-9a-f]{16,}$/i.test(trimmed) ? trimmed : null;
  }
  if (next === null || next === "") {
    return false;
  }
  const url = new URL(window.location.href);
  url.searchParams.set("token", next);
  window.location.assign(url.toString());
  return true;
}

let socket: TablePeekSocket | null = null;
let activeRunner: (() => void) | null = null;

function ensureSocket(): TablePeekSocket {
  if (!socket) {
    const created = new TablePeekSocket(tokenValue);
    created.onStatus((status) => {
      setState({ connection: status });
      if (status === "closed") {
        serverUnreachable();
      }
    });
    created.onRowChange((change) => {
      if (change.invalidate) {
        const resultConn = state.result?.conn ?? null;
        if (
          change.conn !== null &&
          resultConn !== null &&
          change.conn !== resultConn
        ) {
          return;
        }
        activeRunner?.();
      }
    });
    socket = created;
  }
  return socket;
}

function token(): string {
  return tokenValue;
}

function getState(): StoreState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function refreshMeta(conn: string): Promise<EngineMeta> {
  return api<EngineMeta>(`/api/meta?conn=${encodeURIComponent(conn)}`);
}

const resultCache = new WeakMap<WindowedRowSource, GridResult>();
const inflight = new Set<string>();

function showSnapshot(conn: string, snapshot: TabSnapshot): void {
  let result: GridResult | null = null;
  if (snapshot.source !== null && snapshot.meta !== null) {
    const cached = resultCache.get(snapshot.source);
    if (cached) {
      result = cached;
    } else {
      result = {
        queryId: snapshot.meta.id,
        sql: snapshot.sql,
        meta: snapshot.meta,
        source: snapshot.source,
        conn,
      };
      resultCache.set(snapshot.source, result);
    }
  }
  const status: Status = inflight.has(conn)
    ? "running"
    : snapshot.error !== null
      ? "error"
      : "idle";
  setState({
    connId: conn,
    tabId: snapshot.id,
    result,
    info: snapshot.info,
    error: snapshot.error,
    // A failed apply's mark belongs to the rows it failed on.
    editFailure: state.editFailure?.result === result ? state.editFailure : null,
    status,
  });
}

async function runQuery(
  conn: string,
  sql: string,
  maxRows: number,
  ownerId?: string,
  // True for statements the user ran from the editor, which go into history.
  record = false,
): Promise<QueryOutcome> {
  inflight.add(conn);
  if (state.connId === conn) {
    setState({ status: "running", error: null, editFailure: null, info: null });
  }
  const isView = (): boolean =>
    state.connId === conn && (ownerId === undefined || state.tabId === ownerId);
  try {
    const { meta, source, queryId } = await ensureSocket().query(conn, sql, {
      maxRows,
      window: QUERY_WINDOW,
      history: record,
    });
    const result: GridResult = { queryId, sql, meta, source, conn };
    resultCache.set(source, result);
    inflight.delete(conn);
    followTx(conn, meta.inTx);
    txEnded(conn, ownerId, meta.txEnded, meta.invalidated);
    if (isView()) {
      setState({ status: "idle", error: null, editFailure: null, info: null, result });
    } else if (state.connId === conn) {
      setState({ status: "idle" });
    }
    return { kind: "ok", result };
  } catch (error) {
    inflight.delete(conn);
    if (error instanceof TablePeekSocketError) {
      followTx(conn, error.inTx);
      txEnded(conn, ownerId, error.txEnded, error.invalidated);
    }
    if (error instanceof TablePeekSocketError && error.cancelled) {
      if (isView()) {
        setState({ status: "idle", error: null, editFailure: null, info: t(CANCELLED_INFO) });
      } else if (state.connId === conn) {
        setState({ status: "idle" });
      }
      return { kind: "cancelled" };
    }
    const message = errorOf(error);
    if (isView()) {
      setState({ status: "error", error: message, editFailure: null, info: null });
    } else if (state.connId === conn) {
      setState({ status: "idle" });
    }
    return { kind: "error", error: message };
  }
}

// A statement from the editor ended the transaction: the other tabs' rows on
// this connection may hold what was rolled back (or be gone on the server).
function txEnded(
  conn: string,
  ownerId: string | undefined,
  ended: "committed" | "rolledback" | undefined,
  invalidated: boolean | undefined,
): void {
  if (ended === undefined && invalidated !== true) {
    return;
  }
  window.dispatchEvent(
    new CustomEvent("tablepeek:tx-ended", {
      detail: { conn, ownerId: ownerId ?? null, rolledBack: ended === "rolledback", invalidated: invalidated === true },
    }),
  );
}

// The TX controls follow BEGIN, COMMIT and ROLLBACK typed in the editor too.
function followTx(conn: string, inTx: boolean | undefined): void {
  // A job's transaction (an import's) is its own: it never becomes the user's.
  if (inTx === undefined || state.connId !== conn || inOwnTx(conn)) {
    return;
  }
  const tx: TxState = inTx ? "active" : "none";
  if (state.tx !== tx) {
    setState({ tx });
    // A transaction the editor committed files its held changes in History.
    if (tx === "none") {
      historyChanged(conn);
    }
  }
}

function cancelQuery(conn?: string): void {
  const target = conn === undefined ? state.connId : conn;
  if (target !== null) {
    socket?.cancel(target);
  }
}

// A background job's Stop: interrupts its statement running now (an import
// chunk waiting on a row lock, a long export read), which then fails and
// lets the job wind down.
function cancelJobStatement(conn: string): void {
  socket?.cancel(conn, true);
}

// A COMMIT the server says was rolled back, for certain; a dropped
// connection or an unknown outcome is not that.
function isDefiniteRollback(error: unknown): boolean {
  return error instanceof TablePeekSocketError && error.rolledBack && error.outcomeUnknown !== true;
}

export interface EditOutcome {
  row: number;
  col: number;
  value: string | null;
}

function rowKey(result: GridResult, row: number, fetch = true): PkPair[] | null {
  const meta = result.meta;
  if (!meta.pk || meta.pk.length === 0) {
    return null;
  }
  const pairs: PkPair[] = [];
  for (const name of meta.pk) {
    const index = meta.columns.indexOf(name);
    if (index < 0) {
      return null;
    }
    const value = result.source.baseCell(row, index, fetch);
    if (value === undefined) {
      return null;
    }
    pairs.push({ column: name, value: value as string | number | null });
  }
  return pairs;
}

let applying = false;

function isApplying(): boolean {
  return applying;
}

// Staging is refused while the result can still be replaced (a run is in flight)
// or while a batch is being written, so no change is silently dropped.
function stagingBlocked(result: GridResult): boolean {
  if (applying) {
    setState({ info: t("변경사항을 적용하는 중입니다") });
    return true;
  }
  if (state.status === "running" && state.connId === result.conn) {
    setState({ info: t("쿼리 실행 중에는 편집할 수 없습니다") });
    return true;
  }
  return false;
}

// Cell edits, inserts and deletes are staged on the result's row source and only
// reach the database through applyPending().
async function editCell(
  row: number,
  col: number,
  value: string | null,
): Promise<EditOutcome | null> {
  const result = state.result;
  if (!result || !result.meta.sourceTable) {
    setState({ info: t("편집할 수 없는 결과입니다") });
    return null;
  }
  if (stagingBlocked(result)) {
    return null;
  }
  const source = result.source;
  if (source.isDeleted(row)) {
    setState({ info: t("삭제 예정인 행은 편집할 수 없습니다") });
    return null;
  }
  if (source.isInserted(row)) {
    return source.stageEdit(row, col, value, null) ? { row, col, value } : null;
  }
  if (!result.meta.pk || result.meta.pk.length === 0) {
    setState({ info: t("기본 키가 없어 편집할 수 없습니다") });
    return null;
  }
  const key = rowKey(result, row);
  if (key === null) {
    setState({ info: t("아직 로드되지 않은 행입니다") });
    return null;
  }
  return source.stageEdit(row, col, value, key) ? { row, col, value } : null;
}

async function runDetached(
  conn: string,
  sql: string,
  maxRows: number,
): Promise<{ meta: QueryMeta; source: WindowedRowSource }> {
  // While an import or restore holds the connection its rows aren't
  // committed yet: an export or backup would read them as if they were.
  if (inOwnTx(conn)) {
    throw new Error(t(BUSY_ERROR));
  }
  // A job's read: it runs beside the page's queries, and the server keeps its
  // rows only until the source is disposed.
  return ensureSocket().query(conn, sql, { maxRows, window: QUERY_WINDOW, job: true });
}

// DEFAULT or the current time for a cell, written by the database on apply.
function setCellExpr(row: number, col: number, staged: StagedExpr): boolean {
  const result = state.result;
  if (!result || !result.meta.sourceTable) {
    setState({ info: t("편집할 수 없는 결과입니다") });
    return false;
  }
  if (stagingBlocked(result)) {
    return false;
  }
  const source = result.source;
  if (source.isDeleted(row)) {
    return false;
  }
  if (source.isInserted(row)) {
    return source.stageExpr(row, col, staged, null);
  }
  const key = rowKey(result, row);
  return key !== null && source.stageExpr(row, col, staged, key);
}

// A staged cell back to what it was: an edited cell to its value, a new row's
// cell to DEFAULT (left out of the INSERT).
function revertCell(row: number, col: number): void {
  const result = state.result;
  if (!result || stagingBlocked(result)) {
    return;
  }
  result.source.revertCell(row, col);
}

function stageInsert(values?: Map<number, string | null>): number | null {
  const result = state.result;
  if (!result || !result.meta.sourceTable || stagingBlocked(result)) {
    return null;
  }
  return result.source.stageInsert(values);
}

function stageDelete(rows: number[]): { changed: number; skipped: number } | null {
  const result = state.result;
  if (!result || !result.meta.sourceTable || stagingBlocked(result)) {
    return null;
  }
  return result.source.stageDelete(rows, (row) => rowKey(result, row, false));
}

export interface ApplyOutcome {
  structural: boolean;
}

function requireRow(rowsAffected: number): void {
  if (rowsAffected === 0) {
    throw new Error(
      t("대상 행을 찾지 못했습니다. 다른 곳에서 변경·삭제되었을 수 있습니다. 새로고침 후 다시 시도하세요."),
    );
  }
}

async function applyPending(result: GridResult): Promise<ApplyOutcome | null> {
  const source = result.source;
  const meta = result.meta;
  const table = meta.sourceTable;
  if (applying || table === null || !source.hasPending()) {
    return applying ? null : { structural: false };
  }
  if (inOwnTx(result.conn)) {
    // The changes would go into the import's transaction, and be undone with it.
    setState({ error: { code: "", message: t(BUSY_ERROR) } });
    return null;
  }
  const ops = source.pendingOps();
  const pkNames = new Set(meta.pk ?? []);
  const conn = result.conn;
  const sock = ensureSocket();
  const ownTx = !(state.connId === conn && state.tx === "active");
  const applied: { row: number; col: number; value: string | null }[] = [];
  let expressions = false;
  let phase: "begin" | "write" | "commit" = "begin";
  // The row (and cell) being written when a statement failed.
  let at: { row: number; col: number | null } | null = null;
  applying = true;
  try {
    if (ownTx) {
      await sock.begin(conn);
    }
    phase = "write";
    for (const edit of ops.edits) {
      let key = edit.key;
      // Key columns go last so the other edits still find the row by its
      // original key; a key set to DEFAULT or NOW() goes after those, since
      // only the database knows the key it leaves.
      const order = (cell: { col: number; expr?: string }): number =>
        pkNames.has(meta.columns[cell.col]) ? (cell.expr !== undefined ? 2 : 1) : 0;
      const cells = [...edit.cells].sort((a, b) => order(a) - order(b));
      for (const cell of cells) {
        const column = meta.columns[cell.col];
        at = { row: edit.row, col: cell.col };
        const outcome = await sock.edit(conn, {
          session: result.queryId,
          table,
          pk: key,
          column,
          value: cell.value,
          ...(cell.expr !== undefined ? { expr: cell.expr } : {}),
          row: edit.row,
          col: cell.col,
        });
        requireRow(outcome.rowsAffected);
        // What DEFAULT or the time became is read back with the rows.
        if (cell.expr !== undefined) {
          expressions = true;
          continue;
        }
        applied.push({ row: edit.row, col: cell.col, value: cell.value });
        if (pkNames.has(column)) {
          key = key.map((pair) => (pair.column === column ? { column, value: cell.value } : pair));
        }
      }
    }
    // Deletes before inserts, so a deleted key can be re-used by a new row.
    for (const entry of ops.deletes) {
      at = { row: entry.row, col: null };
      const change = await sock.deleteRow(conn, {
        session: result.queryId,
        table,
        pk: entry.key.map((pair) => ({ column: pair.column, value: cellToString(pair.value) })),
      });
      requireRow(change.rowsAffected);
    }
    const firstInserted = source.rowCount - ops.inserts.length;
    for (const [index, values] of ops.inserts.entries()) {
      at = { row: firstInserted + index, col: null };
      await sock.insertRow(conn, {
        session: result.queryId,
        table,
        values: values.map((entry) => ({
          column: meta.columns[entry.col],
          value: entry.value,
          ...(entry.expr !== undefined ? { expr: entry.expr } : {}),
        })),
      });
    }
    at = null;
    if (ownTx) {
      phase = "commit";
      await sock.commit(conn);
    }
  } catch (error) {
    let message = errorOf(error);
    const failed = (shown: AppError): void => {
      setState({
        error: shown,
        editFailure: at === null ? null : { result, row: at.row, col: at.col, error: shown },
      });
    };
    if (error instanceof TablePeekSocketError && error.rolledBack) {
      // COMMIT found the transaction failed and the server rolled it back.
      setState({ tx: ownTx ? state.tx : "none" });
      failed(message);
      return null;
    }
    if (ownTx && phase !== "begin") {
      try {
        await sock.rollback(conn);
      } catch {
        // The server may still hold the transaction open; surface the TX controls.
        setState({ tx: "active" });
        message = { ...message, message: t("{message} — 롤백하지 못했습니다. 트랜잭션을 확인하세요.", { message: message.message }) };
      }
    } else if (!ownTx && phase === "write") {
      message = {
        ...message,
        message: t("{message} — 일부 변경이 진행 중인 트랜잭션에 반영되었을 수 있습니다. 롤백 후 다시 적용하세요.", {
          message: message.message,
        }),
      };
    }
    failed(message);
    return null;
  } finally {
    applying = false;
  }
  for (const entry of applied) {
    source.setCell(entry.row, entry.col, entry.value);
  }
  source.discardPending();
  setState({ editFailure: null });
  // The server filed the committed statements under this connection's history.
  historyChanged(conn);
  // Rows added, removed, or holding values only the database knows yet are
  // read again.
  return { structural: ops.inserts.length > 0 || ops.deletes.length > 0 || expressions };
}

// The History tab reloads on this; editor runs bump their own version instead.
function historyChanged(conn: string): void {
  window.dispatchEvent(new CustomEvent("tablepeek:history-changed", { detail: conn }));
}

function setActiveRunner(runner: (() => void) | null): void {
  activeRunner = runner;
}

function activeConnOrThrow(): string {
  if (state.connId === null) {
    throw new Error(t("열린 연결이 없습니다"));
  }
  return state.connId;
}

async function beginTx(): Promise<void> {
  if (refuseWhileJob()) {
    return;
  }
  try {
    await ensureSocket().begin(activeConnOrThrow());
    setState({ tx: "active" });
  } catch (error) {
    notifyError(error);
  }
}

async function commitTx(): Promise<void> {
  if (refuseWhileJob()) {
    return;
  }
  try {
    const conn = activeConnOrThrow();
    await ensureSocket().commit(conn);
    setState({ tx: "none" });
    // Changes held for the transaction go to History now.
    historyChanged(conn);
  } catch (error) {
    if (error instanceof TablePeekSocketError && error.rolledBack) {
      // The server rolled the failed transaction back instead.
      setState({ tx: "none" });
      notifyError(error);
      state.result?.source.clearWindows();
      return;
    }
    notifyError(error);
  }
}

async function rollbackTx(): Promise<void> {
  if (refuseWhileJob()) {
    return;
  }
  try {
    await ensureSocket().rollback(activeConnOrThrow());
    setState({ tx: "none" });
    state.result?.source.clearWindows();
  } catch (error) {
    notifyError(error);
  }
}

// Connections a background job (an import, a restore) holds, from its first
// statement to its last. Its statements share the connection's one session
// with the page's, so while it runs nothing else may write there: a write
// would join an import's transaction (and be undone with it), its COMMIT or
// ROLLBACK would end that transaction, and MySQL's DDL would commit it. The
// page's reads carry on.
const ownTxConns = new Set<string>();

const BUSY_ERROR = "가져오기가 진행 중입니다. 끝난 뒤 다시 실행하세요.";

function inOwnTx(conn: string): boolean {
  return ownTxConns.has(conn);
}

// The TX controls act on the active connection.
function refuseWhileJob(): boolean {
  if (state.connId !== null && inOwnTx(state.connId)) {
    notifyError(t(BUSY_ERROR));
    return true;
  }
  return false;
}

// Before a job's first statement. Refused while a transaction is open there
// (the job's COMMIT or ROLLBACK, or MySQL's CREATE TABLE, would end it) or
// another job holds the connection; the server checks too, for what other
// tabs have open.
async function claimConn(conn: string): Promise<void> {
  if (state.connId === conn && state.tx === "active") {
    throw new Error(t("트랜잭션이 열려 있습니다. 커밋하거나 롤백한 뒤 다시 시도하세요."));
  }
  if (inOwnTx(conn)) {
    throw new Error(t(BUSY_ERROR));
  }
  ownTxConns.add(conn);
  try {
    await jobOnServer(conn, "start");
  } catch (error) {
    ownTxConns.delete(conn);
    throw error;
  }
}

// After a job's last statement. A transaction it leaves open (a ROLLBACK
// that failed) is the user's from now on, on the server as here.
async function releaseConn(conn: string): Promise<void> {
  try {
    await jobOnServer(conn, "end");
  } catch {
    // The server lets a job go by itself a minute after its last statement.
  } finally {
    ownTxConns.delete(conn);
  }
}

async function jobOnServer(conn: string, action: "start" | "end"): Promise<void> {
  await api<{ ok: boolean }>(`/api/job?conn=${encodeURIComponent(conn)}`, {
    method: "POST",
    body: JSON.stringify({ action }),
  });
}

// A claimed job's own transaction, on the connection's one session as
// applyPending's is; the TX controls don't show it. A ROLLBACK that fails
// (refused, the socket gone) may leave it open: it becomes the user's to
// see in the TX controls and end there, once the job lets go.
async function ownTx(conn: string, action: "begin" | "commit" | "rollback"): Promise<void> {
  const sock = ensureSocket();
  if (action === "begin") {
    await sock.begin(conn, true);
    return;
  }
  if (action === "commit") {
    await sock.commit(conn, true);
    return;
  }
  try {
    await sock.rollback(conn, true);
  } catch (error) {
    if (state.connId === conn) {
      setState({ tx: "active" });
    }
    throw error;
  }
}

function activate(
  conn: string | null,
  meta: EngineMeta | null,
  snapshot: TabSnapshot | null,
  tx: TxState,
): void {
  setState({ connId: conn, meta, tx });
  if (snapshot) {
    showSnapshot(conn as string, snapshot);
  } else {
    setState({
      tabId: null,
      result: null,
      info: null,
      error: null,
      editFailure: null,
      status: "idle",
    });
  }
}

function warmSocket(): void {
  void ensureSocket()
    .connect()
    .catch(() => {});
}

async function openDb(path: string | null): Promise<LiveConn> {
  return api<LiveConn>("/api/open", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

async function connect(input: ConnectInput): Promise<LiveConn> {
  return api<LiveConn>("/api/connect", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// Every engine the server can connect to, as it describes them.
async function listEngines(): Promise<EngineDescriptor[]> {
  const body = await api<{ engines: EngineDescriptor[] }>("/api/engines");
  return body.engines;
}

export interface ConnectSecrets {
  password?: string;
  ssh_password?: string;
  http_password?: string;
}

// Secrets passed here are used for this connect only and never stored.
async function connectSaved(id: string, secrets?: ConnectSecrets): Promise<LiveConn> {
  return api<LiveConn>(`/api/connections/${encodeURIComponent(id)}/connect`, {
    method: "POST",
    ...(secrets !== undefined ? { body: JSON.stringify(secrets) } : {}),
  });
}

async function listConns(): Promise<ConnSummary[]> {
  const body = await api<{ conns: ConnSummary[] }>("/api/conns");
  return body.conns;
}

// The font families installed on this machine (Settings lists them all).
async function listFonts(): Promise<InstalledFont[]> {
  const body = await api<{ families: InstalledFont[] }>("/api/fonts");
  return body.families;
}

async function closeConn(id: string): Promise<void> {
  await api<{ ok: boolean }>(`/api/conns/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

async function listConnections(): Promise<SavedConnection[]> {
  const body = await api<{ connections: SavedConnection[] }>(
    "/api/connections",
  );
  return body.connections;
}

async function createConnection(
  name: string,
  input: ConnectInput,
  persistPassword: boolean,
): Promise<string> {
  const body = await api<{ id: string }>("/api/connections", {
    method: "POST",
    body: JSON.stringify({
      name,
      connect: input,
      persist_password: persistPassword,
    }),
  });
  return body.id;
}

export interface ExportConnectionsRequest {
  ids: string[];
  // Color, tags and group name per saved id (the page keeps these, not the server).
  meta: Record<string, { color: string; tags: string[]; group: string }>;
  groups: { name: string; color: string }[];
  include_passwords: boolean;
  passphrase: string;
}

export interface ImportedConnection {
  id: string;
  name: string;
  color: string;
  tags: string[];
  // Group name, or "" for none.
  group: string;
}

export interface ImportConnectionsResult {
  groups: { name: string; color: string }[];
  connections: ImportedConnection[];
}

export interface ExportConnectionsResult {
  // The sealed ".tablepeek" file's text.
  file: string;
  count: number;
  // How many connections carried a password into the file.
  secrets: number;
}

async function exportConnections(request: ExportConnectionsRequest): Promise<ExportConnectionsResult> {
  return api<ExportConnectionsResult>("/api/connections/export", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

// label: the word put after a clashing name ("가져옴" → "name (가져옴)").
async function importConnections(file: string, passphrase: string, label: string): Promise<ImportConnectionsResult> {
  return api<ImportConnectionsResult>("/api/connections/import", {
    method: "POST",
    body: JSON.stringify({ file, passphrase, label }),
  });
}

async function updateConnection(
  id: string,
  name: string,
  input: ConnectInput,
  persistPassword: boolean,
): Promise<void> {
  await api<{ id: string }>(`/api/connections/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({
      name,
      connect: input,
      persist_password: persistPassword,
    }),
  });
}

export interface ConnectionTestResult {
  ok: boolean;
  elapsed_ms: number;
  kind: string;
  tables: number;
}

async function testConnection(
  input: ConnectInput,
  savedId?: string,
): Promise<ConnectionTestResult> {
  return api<ConnectionTestResult>("/api/connections/test", {
    method: "POST",
    body: JSON.stringify({ connect: input, saved_id: savedId }),
  });
}

async function deleteConnection(id: string): Promise<void> {
  await api<{ ok: boolean }>(`/api/connections/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

async function fetchSchema(
  conn: string,
  includeSystem = false,
): Promise<TableSchema[]> {
  const system = includeSystem ? "&system=1" : "";
  return api<TableSchema[]>(
    `/api/schema?conn=${encodeURIComponent(conn)}${system}`,
  );
}

// Every foreign key of the connection at once (autocomplete's joins, the ER diagram).
async function fetchRelations(conn: string, includeSystem = false): Promise<Relation[]> {
  const system = includeSystem ? "&system=1" : "";
  const body = await api<{ relations: Relation[] }>(
    `/api/relations?conn=${encodeURIComponent(conn)}${system}`,
  );
  return body.relations;
}

async function fetchTableDetail(
  conn: string,
  name: string,
): Promise<TableDetail> {
  return api<TableDetail>(
    `/api/table?name=${encodeURIComponent(name)}&conn=${encodeURIComponent(conn)}`,
  );
}

async function fetchServer(conn: string): Promise<ServerInfo> {
  return api<ServerInfo>(`/api/server?conn=${encodeURIComponent(conn)}`);
}

async function fetchObjects(
  conn: string,
  includeSystem = false,
): Promise<ObjectList> {
  const system = includeSystem ? "&system=1" : "";
  return api<ObjectList>(
    `/api/objects?conn=${encodeURIComponent(conn)}${system}`,
  );
}

async function fetchCount(conn: string, table: string): Promise<number> {
  const body = await api<{ count: number }>(
    `/api/count?table=${encodeURIComponent(table)}&conn=${encodeURIComponent(conn)}`,
  );
  return body.count;
}

async function fetchDatabases(conn: string): Promise<string[]> {
  const body = await api<{ databases: string[] }>(
    `/api/databases?conn=${encodeURIComponent(conn)}`,
  );
  return body.databases;
}

async function switchDatabase(
  conn: string,
  database: string,
): Promise<LiveConn> {
  // The switch reconnects the session the job is running on.
  if (inOwnTx(conn)) {
    throw new Error(t(BUSY_ERROR));
  }
  return api<LiveConn>(`/api/switch-db?conn=${encodeURIComponent(conn)}`, {
    method: "POST",
    body: JSON.stringify({ database }),
  });
}

export interface ExecResult {
  ok: boolean;
  columns: string[];
  rows: unknown[][];
  row_count: number;
  // The rows stop at the server's cap (10,000) and more were there.
  truncated: boolean;
  elapsed_ms: number;
}

// history: file the statement under the connection's history, as a change the
// user committed from a view (structure, table actions, users).
// job: a claimed job's own statement (see claimConn); anything else is
// refused while a job holds the connection.
async function exec(conn: string, sql: string, options?: { history?: boolean; job?: boolean }): Promise<ExecResult> {
  const history = options?.history ?? false;
  const job = options?.job ?? false;
  if (!job && inOwnTx(conn)) {
    throw new Error(t(BUSY_ERROR));
  }
  try {
    return await api<ExecResult>(`/api/exec?conn=${encodeURIComponent(conn)}`, {
      method: "POST",
      body: JSON.stringify({ sql, history, ...(job ? { job: true } : {}) }),
    });
  } finally {
    if (history) {
      historyChanged(conn);
    }
  }
}

async function fetchDefinition(
  conn: string,
  kind: DefinitionKind,
  name: string,
): Promise<DefinitionDetail> {
  return api<DefinitionDetail>(
    `/api/definition?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name)}&conn=${encodeURIComponent(conn)}`,
  );
}

async function killSession(conn: string, sessionId: string): Promise<void> {
  await api<{ ok: boolean }>(`/api/kill?conn=${encodeURIComponent(conn)}`, {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId }),
  });
}

async function fetchHistory(conn: string, limit?: number): Promise<HistoryEntry[]> {
  const query = limit === undefined ? "" : `&limit=${limit}`;
  const body = await api<{ history: HistoryEntry[] }>(
    `/api/history?conn=${encodeURIComponent(conn)}${query}`,
  );
  return body.history;
}

async function clearHistory(conn: string): Promise<void> {
  await api<{ ok: boolean }>(`/api/history?conn=${encodeURIComponent(conn)}`, { method: "DELETE" });
}

async function deleteHistoryEntry(conn: string, id: string): Promise<void> {
  await api<{ ok: boolean }>(
    `/api/history/${encodeURIComponent(id)}?conn=${encodeURIComponent(conn)}`,
    { method: "DELETE" },
  );
}

async function clearConsole(conn: string): Promise<void> {
  await api<{ ok: boolean }>(`/api/console?conn=${encodeURIComponent(conn)}`, { method: "DELETE" });
}

function watchConsole(conn: string, since: number | null): Promise<void> {
  return ensureSocket().watchConsole(conn, since);
}

function unwatchConsole(conn: string): void {
  socket?.unwatchConsole(conn);
}

function onConsole(listener: (update: ConsoleUpdate) => void): () => void {
  return ensureSocket().onConsole(listener);
}

// null returns the connection to the app-wide default.
async function setSafeMode(conn: string, mode: number | null): Promise<void> {
  await api<{ ok: boolean }>("/api/safe-mode", {
    method: "PUT",
    body: JSON.stringify({ conn, mode }),
  });
}

async function fetchFavorites(): Promise<Favorite[]> {
  return (await fetchSavedQueries()).favorites;
}

async function fetchSavedQueries(): Promise<{ favorites: Favorite[]; folders: FavoriteFolder[] }> {
  const body = await api<{ favorites: Favorite[]; folders?: FavoriteFolder[] }>("/api/favorites");
  return { favorites: body.favorites, folders: body.folders ?? [] };
}

// Saved queries feed the editor's keyword completion: tell it they changed.
function favoritesChanged(): void {
  window.dispatchEvent(new Event("tablepeek:favorites-changed"));
}

async function createFavorite(
  name: string,
  sql: string,
  keyword?: string,
  folder?: string | null,
): Promise<string> {
  const body = await api<{ id: string }>("/api/favorites", {
    method: "POST",
    body: JSON.stringify({ name, sql, keyword: keyword ?? null, folder: folder ?? null }),
  });
  favoritesChanged();
  return body.id;
}

// keepalive: still sent while the page unloads.
async function updateFavorite(
  id: string,
  changes: FavoriteChanges,
  options?: { keepalive?: boolean },
): Promise<Favorite> {
  const updated = await api<Favorite>(`/api/favorites/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(changes),
    keepalive: options?.keepalive ?? false,
  });
  favoritesChanged();
  return updated;
}

async function deleteFavorite(id: string): Promise<void> {
  await api<{ ok: boolean }>(`/api/favorites/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  favoritesChanged();
}

async function createFavoriteFolder(name: string): Promise<string> {
  const body = await api<{ id: string }>("/api/favorite-folders", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  favoritesChanged();
  return body.id;
}

async function renameFavoriteFolder(id: string, name: string): Promise<void> {
  await api<{ ok: boolean }>(`/api/favorite-folders/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ name }),
  });
  favoritesChanged();
}

// Takes the queries inside with it.
async function deleteFavoriteFolder(id: string): Promise<void> {
  await api<{ ok: boolean }>(`/api/favorite-folders/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  favoritesChanged();
}

async function listDir(path?: string, hidden = false): Promise<FsListing> {
  const params = new URLSearchParams();
  if (path !== undefined) {
    params.set("path", path);
  }
  if (hidden) {
    params.set("hidden", "true");
  }
  const query = params.toString();
  return api<FsListing>(`/api/fs/list${query === "" ? "" : `?${query}`}`);
}

async function statPath(path: string): Promise<PathStat> {
  return api<PathStat>(`/api/fs/stat?path=${encodeURIComponent(path)}`);
}

export interface PickFileOptions {
  title: string;
  filter?: { name: string; extensions: string[] };
  // Folder to open in; a leading "~" is the home folder.
  dir?: string;
  hidden?: boolean;
}

type PickLine =
  | { shown: true }
  | { path: string | null }
  | { error: { code: string; message: string } };

// The system's own open-file dialog, shown by the server on this machine:
// the picked path, or null when cancelled. `filePickOpening` holds until the
// dialog is on screen. Fails with code "native_picker_unavailable" where the
// system has no such dialog, "picker_busy" while one is already up.
async function pickFile(options: PickFileOptions): Promise<string | null> {
  setState({ filePickOpening: true });
  try {
    const response = await serverFetch("/api/fs/pick", { method: "POST", body: JSON.stringify(options) });
    if (!response.ok || response.body === null) {
      throw new ApiRequestError(appErrorFromBody(await response.json().catch(() => null), response.status));
    }
    // One JSON line as the dialog comes up, one when it closes.
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let pending = "";
    for (;;) {
      let chunk: ReadableStreamReadResult<string>;
      try {
        chunk = await reader.read();
      } catch {
        throw networkError();
      }
      if (chunk.done) {
        throw networkError();
      }
      pending += chunk.value;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = JSON.parse(pending.slice(0, newline)) as PickLine;
        pending = pending.slice(newline + 1);
        if ("shown" in line) {
          setState({ filePickOpening: false });
        } else if ("error" in line) {
          throw new ApiRequestError({ code: line.error.code, message: line.error.message });
        } else {
          return line.path;
        }
        newline = pending.indexOf("\n");
      }
    }
  } finally {
    setState({ filePickOpening: false });
  }
}

// The tab in front's error is done with (closed, its changes discarded).
function clearError(): void {
  setState({ error: null, editFailure: null, status: state.status === "error" ? "idle" : state.status });
}

function setInfo(message: string | null): void {
  setState({ info: message });
}

export const store = {
  token,
  getState,
  subscribe,
  refreshMeta,
  showSnapshot,
  activate,
  runQuery,
  runDetached,
  cancelQuery,
  editCell,
  setCellExpr,
  revertCell,
  stageInsert,
  stageDelete,
  applyPending,
  isApplying,
  setActiveRunner,
  beginTx,
  commitTx,
  rollbackTx,
  ownTx,
  inOwnTx,
  claimConn,
  releaseConn,
  cancelJobStatement,
  isDefiniteRollback,
  openDb,
  listDir,
  statPath,
  pickFile,
  reconnect,
  openNewAddress,
  serverUnreachable,
  serverRestarted,
  setInfo,
  clearError,
  warmSocket,
  connect,
  listEngines,
  connectSaved,
  listConns,
  closeConn,
  listFonts,
  listConnections,
  createConnection,
  exportConnections,
  importConnections,
  updateConnection,
  testConnection,
  deleteConnection,
  fetchSchema,
  fetchRelations,
  fetchTableDetail,
  fetchServer,
  fetchObjects,
  fetchCount,
  fetchDatabases,
  switchDatabase,
  exec,
  fetchDefinition,
  killSession,
  fetchHistory,
  clearHistory,
  deleteHistoryEntry,
  clearConsole,
  watchConsole,
  unwatchConsole,
  onConsole,
  setSafeMode,
  fetchFavorites,
  fetchSavedQueries,
  createFavorite,
  updateFavorite,
  deleteFavorite,
  createFavoriteFolder,
  renameFavoriteFolder,
  deleteFavoriteFolder,
};
