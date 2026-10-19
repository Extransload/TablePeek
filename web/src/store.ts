import type { WindowedRowSource } from "./grid/windowSource";
import { WrendbSocket, WrendbSocketError, type QueryMeta } from "./net/socket";
import type { DefinitionKind } from "./sqlTools";

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
  size_bytes: number | null;
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
}

export interface LiveConn {
  conn: string;
  meta: EngineMeta;
}

export interface HistoryEntry {
  sql: string;
  at: number;
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

const TOKEN_KEY = "wrendb.token";
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
    : UNKNOWN_ERROR;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-wrendb-token": tokenValue,
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new Error(NETWORK_ERROR);
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
    throw new Error(message);
  }
  return body as T;
}

let socket: WrendbSocket | null = null;
let activeRunner: (() => void) | null = null;

function ensureSocket(): WrendbSocket {
  if (!socket) {
    const created = new WrendbSocket(tokenValue);
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
    if (error instanceof WrendbSocketError && error.cancelled) {
      if (isView()) {
        setState({ status: "idle", error: null, info: CANCELLED_INFO });
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

async function editCell(
  row: number,
  col: number,
  value: string | null,
): Promise<EditOutcome | null> {
  const result = state.result;
  const meta = result ? result.meta : null;
  if (
    !result ||
    !meta ||
    !meta.sourceTable ||
    !meta.pk ||
    meta.pk.length === 0
  ) {
    setState({ info: "편집할 수 없는 결과입니다" });
    return null;
  }
  const pkIndexes: number[] = [];
  for (const name of meta.pk) {
    pkIndexes.push(meta.columns.indexOf(name));
  }
  if (pkIndexes.some((index) => index < 0)) {
    setState({ info: "편집할 수 없는 결과입니다" });
    return null;
  }
  const pk: { column: string; value: string | number | null }[] = [];
  for (let i = 0; i < meta.pk.length; i += 1) {
    const cellValue = result.source.cell(row, pkIndexes[i]);
    if (cellValue === undefined) {
      setState({ info: "아직 로드되지 않은 행입니다" });
      return null;
    }
    pk.push({ column: meta.pk[i], value: cellValue as string | number | null });
  }
  try {
    const edited = await ensureSocket().edit(result.conn, {
      session: result.queryId,
      table: meta.sourceTable,
      pk,
      column: meta.columns[col],
      value,
      row,
      col,
    });
    result.source.setCell(row, col, edited.value);
    if (state.result === result) {
      setState({ error: null, info: null });
    }
    return { row: edited.row, col: edited.col, value: edited.value };
  } catch (error) {
    if (state.result === result) {
      setState({ status: "error", error: messageOf(error) });
    }
    return null;
  }
}

async function runDetached(
  conn: string,
  sql: string,
  maxRows: number,
): Promise<{ meta: QueryMeta; source: WindowedRowSource }> {
  return ensureSocket().query(conn, sql, { maxRows, window: QUERY_WINDOW });
}

async function insertRow(
  table: string,
  values: { column: string; value: string | null }[],
): Promise<number> {
  const result = state.result;
  if (!result) {
    throw new Error("행을 추가할 결과가 없습니다");
  }
  const change = await ensureSocket().insertRow(result.conn, {
    session: result.queryId,
    table,
    values,
  });
  return change.rowsAffected;
}

async function deleteRow(
  table: string,
  pk: { column: string; value: string | null }[],
): Promise<number> {
  const result = state.result;
  if (!result) {
    throw new Error("행을 삭제할 결과가 없습니다");
  }
  const change = await ensureSocket().deleteRow(result.conn, {
    session: result.queryId,
    table,
    pk,
  });
  return change.rowsAffected;
}

function setActiveRunner(runner: (() => void) | null): void {
  activeRunner = runner;
}

function activeConnOrThrow(): string {
  if (state.connId === null) {
    throw new Error("열린 연결이 없습니다");
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

async function connectSaved(id: string): Promise<LiveConn> {
  return api<LiveConn>(`/api/connections/${encodeURIComponent(id)}/connect`, {
    method: "POST",
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

async function fetchHistory(limit?: number): Promise<HistoryEntry[]> {
  const query = limit === undefined ? "" : `?limit=${limit}`;
  const body = await api<{ history: HistoryEntry[] }>(`/api/history${query}`);
  return body.history;
}

async function clearHistory(): Promise<void> {
  await api<{ ok: boolean }>("/api/history", { method: "DELETE" });
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

async function listDir(path?: string): Promise<FsListing> {
  const query = path === undefined ? "" : `?path=${encodeURIComponent(path)}`;
  return api<FsListing>(`/api/fs/list${query}`);
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
  insertRow,
  deleteRow,
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
  fetchFavorites,
  createFavorite,
  deleteFavorite,
};
