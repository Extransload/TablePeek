import type { PkPair, WindowedRowSource } from "./grid/windowSource";
import { cellToString } from "./rowOps";
import { TablePeekSocket, TablePeekSocketError, type QueryMeta } from "./net/socket";
import type { DefinitionKind } from "./sqlTools";
import { t } from "./i18n";

export interface EngineMeta {
  kind: string;
  path: string | null;
  demo: boolean;
  tables: string[];
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

export interface TableDetailColumn {
  name: string;
  decl_type: string | null;
  not_null: boolean;
  pk: boolean;
  default: string | null;
}

export interface TableDetailIndex {
  name: string;
  unique: boolean;
  primary: boolean;
  columns: string[];
}

export interface TableDetailForeignKey {
  name: string;
  columns: string[];
  ref_table: string;
  ref_columns: string[];
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

export type SslMode = "disable" | "prefer" | "require";
export type Driver = "postgres" | "mysql" | "cockroach" | "mssql";

export interface DbInput {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  ssl_mode: SslMode;
  ssl_root_cert?: string;
  ssl_client_cert?: string;
  ssl_client_key?: string;
}

export interface PostgresInput extends DbInput {}

export interface MysqlInput extends DbInput {}

export interface CockroachInput extends DbInput {}

export interface MssqlInput {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  encrypt: boolean;
}

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
  driver: Driver;
  postgres?: PostgresInput;
  mysql?: MysqlInput;
  cockroach?: CockroachInput;
  mssql?: MssqlInput;
  ssh?: SshInput;
  http_tunnel?: HttpTunnelInput;
}

export interface SavedDb {
  host: string;
  port: number;
  user: string;
  database: string;
  ssl_mode: SslMode;
  ssl_root_cert?: string | null;
  ssl_client_cert?: string | null;
  ssl_client_key?: string | null;
}

export interface SavedPostgres extends SavedDb {}

export interface SavedMysql extends SavedDb {}

export interface SavedCockroach extends SavedDb {}

export interface SavedMssql extends SavedDb {
  encrypt?: boolean;
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

export interface SavedConnection {
  id: string;
  name: string;
  driver: string;
  postgres?: SavedPostgres;
  mysql?: SavedMysql;
  cockroach?: SavedCockroach;
  mssql?: SavedMssql;
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

// One statement run from the editor on a connection; `at` is in seconds.
export interface HistoryEntry {
  sql: string;
  at: number;
  ms: number;
  ok: boolean;
  rows: number;
  error?: string;
}

export interface Favorite {
  id: string;
  name: string;
  sql: string;
  keyword?: string | null;
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

export interface StoreState {
  status: Status;
  error: string | null;
  info: string | null;
  meta: EngineMeta | null;
  result: GridResult | null;
  connection: Connection;
  tx: TxState;
  connId: string | null;
  tabId: string | null;
}

export interface TabSnapshot {
  id: string;
  sql: string;
  source: WindowedRowSource | null;
  meta: QueryMeta | null;
  info: string | null;
  error: string | null;
}

export type QueryOutcome =
  | { kind: "ok"; result: GridResult }
  | { kind: "cancelled" }
  | { kind: "error"; error: string };

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
  info: null,
  meta: null,
  result: null,
  connection: "closed",
  tx: "none",
  connId: null,
  tabId: null,
};

const listeners = new Set<() => void>();

function setState(patch: Partial<StoreState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) {
    listener();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : t(UNKNOWN_ERROR);
}

export class ApiRequestError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
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

async function api<T>(path: string, init?: RequestInit): Promise<T> {
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
  } catch {
    throw new Error(t(NETWORK_ERROR));
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message =
      body !== null && typeof body === "object" && "message" in body
        ? String(
            (body as { message?: unknown }).message ??
              `HTTP ${response.status}`,
          )
        : `HTTP ${response.status}`;
    const code =
      body !== null && typeof body === "object" && "code" in body
        ? String((body as { code?: unknown }).code ?? "")
        : "";
    throw new ApiRequestError(message, code);
  }
  return body as T;
}

let socket: TablePeekSocket | null = null;
let activeRunner: (() => void) | null = null;

function ensureSocket(): TablePeekSocket {
  if (!socket) {
    const created = new TablePeekSocket(tokenValue);
    created.onStatus((status) => {
      setState({ connection: status });
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
    setState({ status: "running", error: null, info: null });
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
    if (isView()) {
      setState({ status: "idle", error: null, info: null, result });
    } else if (state.connId === conn) {
      setState({ status: "idle" });
    }
    return { kind: "ok", result };
  } catch (error) {
    inflight.delete(conn);
    if (error instanceof TablePeekSocketError && error.cancelled) {
      if (isView()) {
        setState({ status: "idle", error: null, info: t(CANCELLED_INFO) });
      } else if (state.connId === conn) {
        setState({ status: "idle" });
      }
      return { kind: "cancelled" };
    }
    const message = messageOf(error);
    if (isView()) {
      setState({ status: "error", error: message, info: null });
    } else if (state.connId === conn) {
      setState({ status: "idle" });
    }
    return { kind: "error", error: message };
  }
}

function cancelQuery(conn?: string): void {
  const target = conn === undefined ? state.connId : conn;
  if (target !== null) {
    socket?.cancel(target);
  }
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
  return ensureSocket().query(conn, sql, { maxRows, window: QUERY_WINDOW });
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
  const ops = source.pendingOps();
  const pkNames = new Set(meta.pk ?? []);
  const conn = result.conn;
  const sock = ensureSocket();
  const ownTx = !(state.connId === conn && state.tx === "active");
  const applied: { row: number; col: number; value: string | null }[] = [];
  let phase: "begin" | "write" | "commit" = "begin";
  applying = true;
  try {
    if (ownTx) {
      await sock.begin(conn);
    }
    phase = "write";
    for (const edit of ops.edits) {
      let key = edit.key;
      // Key columns go last so the other edits still find the row by its original key.
      const cells = [...edit.cells].sort(
        (a, b) =>
          Number(pkNames.has(meta.columns[a.col])) - Number(pkNames.has(meta.columns[b.col])),
      );
      for (const cell of cells) {
        const column = meta.columns[cell.col];
        const outcome = await sock.edit(conn, {
          session: result.queryId,
          table,
          pk: key,
          column,
          value: cell.value,
          row: edit.row,
          col: cell.col,
        });
        requireRow(outcome.rowsAffected);
        applied.push({ row: edit.row, col: cell.col, value: cell.value });
        if (pkNames.has(column)) {
          key = key.map((pair) => (pair.column === column ? { column, value: cell.value } : pair));
        }
      }
    }
    // Deletes before inserts, so a deleted key can be re-used by a new row.
    for (const entry of ops.deletes) {
      const change = await sock.deleteRow(conn, {
        session: result.queryId,
        table,
        pk: entry.key.map((pair) => ({ column: pair.column, value: cellToString(pair.value) })),
      });
      requireRow(change.rowsAffected);
    }
    for (const values of ops.inserts) {
      await sock.insertRow(conn, {
        session: result.queryId,
        table,
        values: values.map((entry) => ({ column: meta.columns[entry.col], value: entry.value })),
      });
    }
    if (ownTx) {
      phase = "commit";
      await sock.commit(conn);
    }
  } catch (error) {
    let message = messageOf(error);
    if (ownTx && phase !== "begin") {
      try {
        await sock.rollback(conn);
      } catch {
        // The server may still hold the transaction open; surface the TX controls.
        setState({ tx: "active" });
        message = t("{message} — 롤백하지 못했습니다. 트랜잭션을 확인하세요.", { message });
      }
    } else if (!ownTx && phase === "write") {
      message = t("{message} — 일부 변경이 진행 중인 트랜잭션에 반영되었을 수 있습니다. 롤백 후 다시 적용하세요.", { message });
    }
    setState({ error: message });
    return null;
  } finally {
    applying = false;
  }
  for (const entry of applied) {
    source.setCell(entry.row, entry.col, entry.value);
  }
  source.discardPending();
  return { structural: ops.inserts.length > 0 || ops.deletes.length > 0 };
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
  try {
    await ensureSocket().begin(activeConnOrThrow());
    setState({ tx: "active" });
  } catch (error) {
    setState({ status: "error", error: messageOf(error) });
  }
}

async function commitTx(): Promise<void> {
  try {
    await ensureSocket().commit(activeConnOrThrow());
    setState({ tx: "none" });
  } catch (error) {
    setState({ status: "error", error: messageOf(error) });
  }
}

async function rollbackTx(): Promise<void> {
  try {
    await ensureSocket().rollback(activeConnOrThrow());
    setState({ tx: "none" });
    state.result?.source.clearWindows();
  } catch (error) {
    setState({ status: "error", error: messageOf(error) });
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

const connectPostgres = connect;

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
  elapsed_ms: number;
}

async function exec(conn: string, sql: string): Promise<ExecResult> {
  return api<ExecResult>(`/api/exec?conn=${encodeURIComponent(conn)}`, {
    method: "POST",
    body: JSON.stringify({ sql }),
  });
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

// null returns the connection to the app-wide default.
async function setSafeMode(conn: string, mode: number | null): Promise<void> {
  await api<{ ok: boolean }>("/api/safe-mode", {
    method: "PUT",
    body: JSON.stringify({ conn, mode }),
  });
}

async function fetchFavorites(): Promise<Favorite[]> {
  const body = await api<{ favorites: Favorite[] }>("/api/favorites");
  return body.favorites;
}

async function createFavorite(
  name: string,
  sql: string,
  keyword?: string,
): Promise<string> {
  const body = await api<{ id: string }>("/api/favorites", {
    method: "POST",
    body: JSON.stringify({ name, sql, keyword: keyword ?? null }),
  });
  return body.id;
}

async function deleteFavorite(id: string): Promise<void> {
  await api<{ ok: boolean }>(`/api/favorites/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
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

function setError(message: string | null): void {
  setState({ error: message });
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
  stageInsert,
  stageDelete,
  applyPending,
  isApplying,
  setActiveRunner,
  beginTx,
  commitTx,
  rollbackTx,
  openDb,
  listDir,
  statPath,
  setError,
  setInfo,
  warmSocket,
  connect,
  connectPostgres,
  connectSaved,
  listConns,
  closeConn,
  listConnections,
  createConnection,
  exportConnections,
  importConnections,
  updateConnection,
  testConnection,
  deleteConnection,
  fetchSchema,
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
  setSafeMode,
  fetchFavorites,
  createFavorite,
  deleteFavorite,
};
