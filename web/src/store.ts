import type { WindowedRowSource } from "./grid/windowSource";
import { ProdbSocket, ProdbSocketError, type QueryMeta } from "./net/socket";

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

export type SslMode = "disable" | "prefer" | "require";
export type Driver = "postgres" | "mysql" | "cockroach" | "mssql";

export interface DbInput {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  ssl_mode: SslMode;
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

export interface ConnectInput {
  driver: Driver;
  postgres?: PostgresInput;
  mysql?: MysqlInput;
  cockroach?: CockroachInput;
  mssql?: MssqlInput;
  ssh?: SshInput;
}

export interface SavedDb {
  host: string;
  port: number;
  user: string;
  database: string;
  ssl_mode: SslMode;
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

export interface SavedConnection {
  id: string;
  name: string;
  driver: string;
  postgres?: SavedPostgres;
  mysql?: SavedMysql;
  cockroach?: SavedCockroach;
  mssql?: SavedMssql;
  ssh?: SavedSsh;
  persist_password: boolean;
  has_password: boolean;
}

export interface HistoryEntry {
  sql: string;
  at: number;
}

export interface Favorite {
  id: string;
  name: string;
  sql: string;
}

export interface GridResult {
  queryId: string;
  sql: string;
  meta: QueryMeta;
  source: WindowedRowSource;
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
  generation: number;
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

const TOKEN_KEY = "prodb.token";
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
  generation: 0,
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
  return error instanceof Error && error.message ? error.message : UNKNOWN_ERROR;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-prodb-token": tokenValue,
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
        ? String((body as { message?: unknown }).message ?? `HTTP ${response.status}`)
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

let socket: ProdbSocket | null = null;

function ensureSocket(): ProdbSocket {
  if (!socket) {
    const created = new ProdbSocket(tokenValue);
    created.onStatus((status) => {
      setState({ connection: status });
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

async function refreshMeta(): Promise<void> {
  try {
    const meta = await api<EngineMeta>("/api/meta");
    setState({ meta });
  } catch (error) {
    setState({ status: "error", error: messageOf(error) });
  }
}

async function init(): Promise<void> {
  await refreshMeta();
}

const resultCache = new WeakMap<WindowedRowSource, GridResult>();

function showSnapshot(snapshot: TabSnapshot): void {
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
      };
      resultCache.set(snapshot.source, result);
    }
  }
  const status: Status =
    state.status === "running"
      ? "running"
      : snapshot.error !== null
        ? "error"
        : "idle";
  setState({
    tabId: snapshot.id,
    result,
    info: snapshot.info,
    error: snapshot.error,
    status,
  });
}

async function runQuery(
  sql: string,
  maxRows: number,
  ownerId?: string,
): Promise<QueryOutcome> {
  setState({ status: "running", error: null, info: null });
  try {
    const { meta, source, queryId } = await ensureSocket().query(sql, {
      maxRows,
      window: QUERY_WINDOW,
    });
    const result: GridResult = { queryId, sql, meta, source };
    resultCache.set(source, result);
    if (ownerId === undefined || state.tabId === ownerId) {
      setState({ status: "idle", error: null, info: null, result });
    } else {
      setState({ status: "idle" });
    }
    return { kind: "ok", result };
  } catch (error) {
    if (error instanceof ProdbSocketError && error.cancelled) {
      if (ownerId === undefined || state.tabId === ownerId) {
        setState({ status: "idle", error: null, info: CANCELLED_INFO });
      } else {
        setState({ status: "idle" });
      }
      return { kind: "cancelled" };
    }
    const message = messageOf(error);
    if (ownerId === undefined || state.tabId === ownerId) {
      setState({ status: "error", error: message, info: null });
    } else {
      setState({ status: "idle" });
    }
    return { kind: "error", error: message };
  }
}

function cancelQuery(): void {
  socket?.cancel();
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
  if (!result || !meta || !meta.sourceTable || !meta.pk || meta.pk.length === 0) {
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
    const edited = await ensureSocket().edit({
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
  sql: string,
  maxRows: number,
): Promise<{ meta: QueryMeta; source: WindowedRowSource }> {
  return ensureSocket().query(sql, { maxRows, window: QUERY_WINDOW });
}

async function beginTx(): Promise<void> {
  try {
    await ensureSocket().begin();
    setState({ tx: "active" });
  } catch (error) {
    setState({ status: "error", error: messageOf(error) });
  }
}

async function commitTx(): Promise<void> {
  try {
    await ensureSocket().commit();
    setState({ tx: "none" });
  } catch (error) {
    setState({ status: "error", error: messageOf(error) });
  }
}

async function rollbackTx(): Promise<void> {
  try {
    await ensureSocket().rollback();
    setState({ tx: "none" });
    state.result?.source.clearWindows();
  } catch (error) {
    setState({ status: "error", error: messageOf(error) });
  }
}

function applyMeta(meta: EngineMeta): void {
  const previous = state.result;
  if (previous) {
    previous.source.dispose();
  }
  setState({
    status: "idle",
    meta,
    result: null,
    error: null,
    info: null,
    tx: "none",
    generation: state.generation + 1,
    tabId: null,
  });
}

async function openDb(path: string | null): Promise<void> {
  try {
    const meta = await api<EngineMeta>("/api/open", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
    applyMeta(meta);
  } catch (error) {
    setState({ status: "error", error: messageOf(error) });
  }
}

async function connect(input: ConnectInput): Promise<EngineMeta> {
  const meta = await api<EngineMeta>("/api/connect", {
    method: "POST",
    body: JSON.stringify(input),
  });
  applyMeta(meta);
  return meta;
}

const connectPostgres = connect;

async function connectSaved(id: string): Promise<EngineMeta> {
  const meta = await api<EngineMeta>(
    `/api/connections/${encodeURIComponent(id)}/connect`,
    { method: "POST" },
  );
  applyMeta(meta);
  return meta;
}

async function listConnections(): Promise<SavedConnection[]> {
  const body = await api<{ connections: SavedConnection[] }>("/api/connections");
  return body.connections;
}

async function createConnection(
  name: string,
  input: ConnectInput,
  persistPassword: boolean,
): Promise<string> {
  const body = await api<{ id: string }>("/api/connections", {
    method: "POST",
    body: JSON.stringify({ name, connect: input, persist_password: persistPassword }),
  });
  return body.id;
}

async function deleteConnection(id: string): Promise<void> {
  await api<{ ok: boolean }>(`/api/connections/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

async function fetchSchema(): Promise<TableSchema[]> {
  return api<TableSchema[]>("/api/schema");
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

async function createFavorite(name: string, sql: string): Promise<string> {
  const body = await api<{ id: string }>("/api/favorites", {
    method: "POST",
    body: JSON.stringify({ name, sql }),
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

function setError(message: string | null): void {
  setState({ error: message });
}

export const store = {
  token,
  getState,
  subscribe,
  init,
  refreshMeta,
  showSnapshot,
  runQuery,
  runDetached,
  cancelQuery,
  editCell,
  beginTx,
  commitTx,
  rollbackTx,
  openDb,
  listDir,
  setError,
  connect,
  connectPostgres,
  connectSaved,
  listConnections,
  createConnection,
  deleteConnection,
  fetchSchema,
  fetchHistory,
  clearHistory,
  fetchFavorites,
  createFavorite,
  deleteFavorite,
};
