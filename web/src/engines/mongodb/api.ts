// Client for the document routes (MONGODB.md §6). Bodies and replies are
// canonical Extended JSON; this module turns them into `BsonValue`s both
// ways, so callers never see EJSON wrappers. Errors arrive as `MongoError`
// with the server's code (`mongo_11000`, `mongo_121`, `bad_request`, …).

import { t } from "../../i18n";
import { store } from "../../store";
import { BsonDate, Decimal128, Double, Int32, Int64, fromEJSON, isDocument, toEJSON, type BsonDocument, type BsonValue } from "./bson";

// The optional fields a server error reply adds to `{ code, message }`
// (ERRORS.md §2), kept on the error under the same names so the app's error
// help reads them.
export interface MongoErrorFields {
  server_code?: number;
  code_name?: string;
  details?: unknown;
  raw?: string;
  position?: { offset?: number; line?: number; column?: number };
}

export class MongoError extends Error implements MongoErrorFields {
  readonly code: string;
  server_code?: number;
  code_name?: string;
  details?: unknown;
  raw?: string;
  position?: { offset?: number; line?: number; column?: number };

  constructor(code: string, message: string, fields: MongoErrorFields = {}) {
    super(message);
    this.code = code;
    for (const key of ["server_code", "code_name", "details", "raw", "position"] as const) {
      if (fields[key] !== undefined && fields[key] !== null) {
        Object.assign(this, { [key]: fields[key] });
      }
    }
  }

  // The MongoDB error number: the reply's, else from a `mongo_<n>` code.
  get serverCode(): number | null {
    if (typeof this.server_code === "number") {
      return this.server_code;
    }
    const m = /^mongo_(\d+)$/.exec(this.code);
    return m ? Number(m[1]) : null;
  }
}

// Whether a request failed because the caller aborted it.
export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export interface DocDatabase {
  name: string;
  sizeOnDisk: number | null;
  empty: boolean;
}

export interface CollectionInfo {
  name: string;
  type: "collection" | "view" | "timeseries";
  options: BsonDocument;
  count: number | null;
}

export interface CollStats {
  count: number;
  size: number;
  avgObjSize: number;
  storageSize: number;
  nindexes: number;
  totalIndexSize: number;
  indexSizes: Record<string, number>;
}

export interface IndexInfo {
  name: string;
  key: BsonDocument;
  unique?: boolean;
  sparse?: boolean;
  expireAfterSeconds?: number;
  partialFilterExpression?: BsonDocument;
  size?: number;
  ops?: number;
}

export interface FindArgs {
  filter: BsonDocument;
  projection?: BsonDocument | null;
  sort?: BsonDocument | null;
  skip?: number;
  limit: number;
  maxTimeMS?: number;
  // An automatic refresh (the 성능 tab's system.profile reads): the server
  // leaves it out of the console.
  poll?: boolean;
}

export interface DocBatch {
  docs: BsonDocument[];
  elapsedMs: number;
}

export interface CountResult {
  // Null when counting took too long (shown as "많음").
  count: number | null;
  exact: boolean;
}

export interface UpdateResult {
  matched: number;
  modified: number;
}

export interface Namespace {
  conn: string;
  db: string;
  coll: string;
}

// A plain number from an EJSON number of any width (stats, counts).
export function toNumber(v: BsonValue | undefined): number {
  if (typeof v === "boolean") {
    return v ? 1 : 0;
  }
  if (v instanceof Int32 || v instanceof Double) {
    return v.value;
  }
  if (v instanceof Int64) {
    return Number(v.value);
  }
  if (v instanceof Decimal128) {
    return Number(v.value);
  }
  return 0;
}

async function call(conn: string, method: "GET" | "POST" | "DELETE", route: string, query: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const params = new URLSearchParams({ conn, ...query });
  let response: Response;
  try {
    response = await fetch(`/api/doc/${route}?${params}`, {
      method,
      signal,
      headers: { "content-type": "application/json", "x-tablepeek-token": store.token() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (isAbort(error)) {
      throw error;
    }
    store.serverUnreachable();
    throw new MongoError("network", t("서버에 연결할 수 없습니다"));
  }
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  if (!response.ok) {
    throw responseError(response.status, json);
  }
  return json;
}

// The error of a failed reply: `{ code, message }`, or the same nested under
// `error`. A 401 means the server restarted with a new token.
function responseError(status: number, json: unknown): MongoError {
  const raw = json !== null && typeof json === "object" ? json as Record<string, unknown> : {};
  const inner = raw.error !== null && typeof raw.error === "object" ? raw.error as Record<string, unknown> : raw;
  if (status === 401) {
    store.serverRestarted();
  }
  return new MongoError(String(inner.code ?? `http_${status}`), String(inner.message ?? `HTTP ${status}`), inner as MongoErrorFields);
}

function docs(list: unknown): BsonDocument[] {
  return Array.isArray(list) ? list.map((x) => fromEJSON(x)).filter(isDocument) : [];
}

function ejsonDoc(doc: BsonDocument | null | undefined): unknown {
  return doc ? toEJSON(doc) : undefined;
}

function plain(v: unknown): BsonDocument {
  const value = fromEJSON(v);
  return isDocument(value) ? value : {};
}

export async function listDatabases(conn: string, signal?: AbortSignal): Promise<DocDatabase[]> {
  const list = (await call(conn, "GET", "databases", {}, undefined, signal)) as unknown[];
  return list.map((x) => {
    const d = plain(x);
    return { name: String(d.name), sizeOnDisk: d.sizeOnDisk === undefined || d.sizeOnDisk === null ? null : toNumber(d.sizeOnDisk), empty: d.empty === true };
  });
}

export async function listCollections(conn: string, db: string, signal?: AbortSignal): Promise<CollectionInfo[]> {
  const list = (await call(conn, "GET", "collections", { db }, undefined, signal)) as unknown[];
  return list.map((x) => {
    const d = plain(x);
    const type = d.type === "view" || d.type === "timeseries" ? d.type : "collection";
    return { name: String(d.name), type, options: isDocument(d.options) ? d.options : {}, count: d.count === undefined || d.count === null ? null : toNumber(d.count) };
  });
}

export async function collStats(ns: Namespace, signal?: AbortSignal): Promise<CollStats> {
  const d = plain(await call(ns.conn, "GET", "stats", { db: ns.db, coll: ns.coll }, undefined, signal));
  const sizes: Record<string, number> = {};
  if (isDocument(d.indexSizes)) {
    for (const [k, v] of Object.entries(d.indexSizes)) {
      sizes[k] = toNumber(v);
    }
  }
  return {
    count: toNumber(d.count),
    size: toNumber(d.size),
    avgObjSize: toNumber(d.avgObjSize),
    storageSize: toNumber(d.storageSize),
    nindexes: toNumber(d.nindexes),
    totalIndexSize: toNumber(d.totalIndexSize),
    indexSizes: sizes,
  };
}

export async function find(ns: Namespace, args: FindArgs, signal?: AbortSignal): Promise<DocBatch> {
  const body = {
    db: ns.db,
    coll: ns.coll,
    filter: toEJSON(args.filter),
    projection: ejsonDoc(args.projection),
    sort: ejsonDoc(args.sort),
    skip: args.skip || undefined,
    limit: args.limit,
    maxTimeMS: args.maxTimeMS,
    poll: args.poll || undefined,
  };
  const r = (await call(ns.conn, "POST", "find", {}, body, signal)) as { docs: unknown[]; elapsedMs: number };
  return { docs: docs(r.docs), elapsedMs: Number(r.elapsedMs) || 0 };
}

export async function count(ns: Namespace, filter: BsonDocument, signal?: AbortSignal): Promise<CountResult> {
  const r = (await call(ns.conn, "POST", "count", {}, { db: ns.db, coll: ns.coll, filter: toEJSON(filter) }, signal)) as { count: unknown; exact: boolean };
  return { count: r.count === null || r.count === undefined ? null : toNumber(fromEJSON(r.count)), exact: r.exact === true };
}

// A pipeline with `$out` or `$merge` writes, and the server refuses it
// without `confirmed` (the caller asks first under safe mode).
export async function aggregate(ns: Namespace, pipeline: BsonDocument[], maxTimeMS?: number, signal?: AbortSignal, confirmed = false): Promise<DocBatch> {
  const r = (await call(ns.conn, "POST", "aggregate", {}, { db: ns.db, coll: ns.coll, pipeline: pipeline.map(toEJSON), maxTimeMS, confirmed: confirmed || undefined }, signal)) as { docs: unknown[]; elapsedMs: number };
  return { docs: docs(r.docs), elapsedMs: Number(r.elapsedMs) || 0 };
}

export async function distinct(ns: Namespace, key: string, filter: BsonDocument, signal?: AbortSignal): Promise<BsonValue[]> {
  const r = (await call(ns.conn, "POST", "distinct", {}, { db: ns.db, coll: ns.coll, key, filter: toEJSON(filter) }, signal)) as { values: unknown[] };
  return (r.values ?? []).map((x) => fromEJSON(x));
}

// A document the server refused within an insert (`index` into the batch).
export interface InsertError extends MongoErrorFields {
  index: number;
  code: string;
  message: string;
}

export interface InsertResult {
  insertedIds: BsonValue[];
  errors: InsertError[];
}

// `ordered: false` goes on past refused documents (import's skip mode);
// ordered stops at the first one. Refusals come back in `errors`.
export async function insertMany(ns: Namespace, list: BsonDocument[], ordered: boolean, signal?: AbortSignal): Promise<InsertResult> {
  const r = (await call(ns.conn, "POST", "insert", {}, { db: ns.db, coll: ns.coll, docs: list.map(toEJSON), ordered }, signal)) as { insertedIds?: unknown[]; errors?: ({ index: number; code: unknown; message: unknown } & MongoErrorFields)[] };
  return {
    insertedIds: (r.insertedIds ?? []).map((x) => fromEJSON(x)),
    // A bare MongoDB error number reads as the usual `mongo_<n>`.
    errors: (r.errors ?? []).map((e) => {
      const code = String(e.code ?? "mongodb_error");
      return { ...e, index: Number(e.index), code: /^\d+$/.test(code) ? `mongo_${code}` : code, message: String(e.message ?? "") };
    }),
  };
}

// The editors' insert: all or nothing, a refusal thrown as its MongoError.
export async function insert(ns: Namespace, list: BsonDocument[], signal?: AbortSignal): Promise<BsonValue[]> {
  const r = await insertMany(ns, list, true, signal);
  const failed = r.errors[0];
  if (failed !== undefined) {
    throw new MongoError(failed.code, failed.message, failed);
  }
  return r.insertedIds;
}

// `confirmed` is required by the server for any write with an empty filter;
// the caller asks the user first (safe mode).
export async function update(
  ns: Namespace,
  args: { filter: BsonDocument; update: BsonDocument | BsonDocument[]; many: boolean; upsert?: boolean; confirmed?: boolean },
  signal?: AbortSignal,
): Promise<UpdateResult> {
  const body = {
    db: ns.db,
    coll: ns.coll,
    filter: toEJSON(args.filter),
    update: Array.isArray(args.update) ? args.update.map(toEJSON) : toEJSON(args.update),
    many: args.many,
    upsert: args.upsert ?? false,
    confirmed: args.confirmed || undefined,
  };
  const r = (await call(ns.conn, "POST", "update", {}, body, signal)) as UpdateResult;
  return { matched: Number(r.matched) || 0, modified: Number(r.modified) || 0 };
}

export async function replace(ns: Namespace, filter: BsonDocument, replacement: BsonDocument, confirmed = false, signal?: AbortSignal): Promise<UpdateResult> {
  const body = { db: ns.db, coll: ns.coll, filter: toEJSON(filter), replacement: toEJSON(replacement), confirmed: confirmed || undefined };
  const r = (await call(ns.conn, "POST", "replace", {}, body, signal)) as UpdateResult;
  return { matched: Number(r.matched) || 0, modified: Number(r.modified) || 0 };
}

export async function remove(ns: Namespace, filter: BsonDocument, many: boolean, confirmed = false, signal?: AbortSignal): Promise<number> {
  const r = (await call(ns.conn, "POST", "delete", {}, { db: ns.db, coll: ns.coll, filter: toEJSON(filter), many, confirmed: confirmed || undefined }, signal)) as { deleted: number };
  return Number(r.deleted) || 0;
}

export async function listIndexes(ns: Namespace, signal?: AbortSignal): Promise<IndexInfo[]> {
  const list = (await call(ns.conn, "GET", "indexes", { db: ns.db, coll: ns.coll }, undefined, signal)) as unknown[];
  return list.map((x) => {
    const d = plain(x);
    const info: IndexInfo = { name: String(d.name), key: isDocument(d.key) ? d.key : {} };
    if (d.unique === true) info.unique = true;
    if (d.sparse === true) info.sparse = true;
    if (d.expireAfterSeconds !== undefined && d.expireAfterSeconds !== null) info.expireAfterSeconds = toNumber(d.expireAfterSeconds);
    if (isDocument(d.partialFilterExpression)) info.partialFilterExpression = d.partialFilterExpression;
    if (d.size !== undefined && d.size !== null) info.size = toNumber(d.size);
    if (d.ops !== undefined && d.ops !== null) info.ops = toNumber(d.ops);
    return info;
  });
}

export async function createIndex(ns: Namespace, keys: BsonDocument, options: BsonDocument, signal?: AbortSignal): Promise<string> {
  const r = (await call(ns.conn, "POST", "indexes", {}, { db: ns.db, coll: ns.coll, keys: toEJSON(keys), options: toEJSON(options) }, signal)) as { name: string };
  return String(r.name);
}

export async function dropIndex(ns: Namespace, name: string, signal?: AbortSignal): Promise<void> {
  await call(ns.conn, "DELETE", "indexes", {}, { db: ns.db, coll: ns.coll, name }, signal);
}

export type ExplainTarget =
  | { find: { filter: BsonDocument; projection?: BsonDocument | null; sort?: BsonDocument | null; skip?: number | null; limit?: number | null } }
  | { aggregate: { pipeline: BsonDocument[] } };

// The server's explain output as it came (converted from EJSON).
export async function explain(ns: Namespace, target: ExplainTarget, verbosity = "executionStats", signal?: AbortSignal): Promise<BsonDocument> {
  const body: Record<string, unknown> = { db: ns.db, coll: ns.coll, verbosity };
  if ("find" in target) {
    const f = target.find;
    body.find = { filter: toEJSON(f.filter), projection: ejsonDoc(f.projection), sort: ejsonDoc(f.sort), skip: f.skip ?? undefined, limit: f.limit ?? undefined };
  } else {
    body.aggregate = { pipeline: target.aggregate.pipeline.map(toEJSON) };
  }
  return plain(await call(ns.conn, "POST", "explain", {}, body, signal));
}

// One of the whitelisted commands (collStats, dbStats, drop, …). `poll`
// marks an automatic refresh (currentOp, top, profile -1, …) the server
// leaves out of the console.
export async function command(conn: string, db: string, cmd: BsonDocument, confirmed = false, signal?: AbortSignal, poll = false): Promise<BsonDocument> {
  return plain(await call(conn, "POST", "command", {}, { db, command: toEJSON(cmd), confirmed: confirmed || undefined, poll: poll || undefined }, signal));
}

// ---- Import, export, databases and collections (DocAdmin) ----

export type ExportRequest =
  | { filter: BsonDocument; projection: BsonDocument | null; sort: BsonDocument | null; limit: number | null }
  | { pipeline: BsonDocument[] };

// Streams `POST /api/doc/export`: `onLine` gets each document's canonical
// EJSON line as the server wrote it (writers that keep canonical form pass
// it through unparsed). Resolves with the server's count from the closing
// `{"$end": { count }}` line; a `{"$error": …}` line or a stream that stops
// before `$end` rejects. Aborting `signal` closes the connection, which
// ends the server's cursor.
export async function exportDocs(ns: Namespace, request: ExportRequest, onLine: (line: string) => void, signal?: AbortSignal): Promise<number> {
  const body: Record<string, unknown> = { db: ns.db, coll: ns.coll };
  if ("pipeline" in request) {
    body.pipeline = request.pipeline.map(toEJSON);
  } else {
    body.filter = toEJSON(request.filter);
    body.projection = ejsonDoc(request.projection);
    body.sort = ejsonDoc(request.sort);
    body.limit = request.limit ?? undefined;
  }
  let response: Response;
  try {
    response = await fetch(`/api/doc/export?${new URLSearchParams({ conn: ns.conn })}`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", "x-tablepeek-token": store.token() },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (isAbort(error)) {
      throw error;
    }
    store.serverUnreachable();
    throw new MongoError("network", t("서버에 연결할 수 없습니다"));
  }
  if (!response.ok || response.body === null) {
    throw responseError(response.status, await response.json().catch(() => null));
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let rest = "";
  // The closing line's count; a `$error` line throws. Null for a document.
  const closing = (line: string): number | null => {
    if (!line.startsWith('{"$end"') && !line.startsWith('{"$error"')) {
      return null;
    }
    const d = plain(JSON.parse(line));
    if (isDocument(d.$end)) {
      return toNumber(d.$end.count);
    }
    if (isDocument(d.$error)) {
      throw new MongoError(String(d.$error.code ?? "mongodb_error"), String(d.$error.message ?? ""), toEJSON(d.$error) as MongoErrorFields);
    }
    return null;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    rest += value;
    let from = 0;
    for (let nl = rest.indexOf("\n"); nl !== -1; nl = rest.indexOf("\n", from)) {
      const line = rest.slice(from, nl).trim();
      from = nl + 1;
      if (line === "") {
        continue;
      }
      const end = closing(line);
      if (end !== null) {
        void reader.cancel().catch(() => undefined);
        return end;
      }
      onLine(line);
    }
    rest = rest.slice(from);
  }
  const last = rest.trim();
  const end = last === "" ? null : closing(last);
  if (end !== null) {
    return end;
  }
  throw new MongoError("mongodb_error", t("내보내기가 끝나기 전에 연결이 끊겼습니다"));
}

// `create` options: capped, timeseries, viewOn + pipeline, collation,
// clusteredIndex, validator…
export async function createCollection(conn: string, db: string, name: string, options: BsonDocument, signal?: AbortSignal): Promise<void> {
  await command(conn, db, { create: name, ...options }, false, signal);
}

// renameCollection runs against admin with full names.
export async function renameCollection(conn: string, db: string, from: string, to: string, dropTarget: boolean, signal?: AbortSignal): Promise<void> {
  await command(conn, "admin", { renameCollection: `${db}.${from}`, to: `${db}.${to}`, dropTarget }, true, signal);
}

export async function dropCollection(conn: string, db: string, coll: string, signal?: AbortSignal): Promise<void> {
  await command(conn, db, { drop: coll }, true, signal);
}

export async function dropDatabase(conn: string, db: string, signal?: AbortSignal): Promise<void> {
  await command(conn, db, { dropDatabase: new Int32(1) }, true, signal);
}

// ---- 성능 tab (DocPerf) ----

// One `GET /api/doc/perf` sample: the parts of `serverStatus` the 성능 tab
// charts. Counters are cumulative; the tab turns two samples into rates.
export interface PerfSample {
  // Server clock, ms since the epoch.
  time: number;
  // Seconds since the server started.
  uptime: number;
  opcounters: Record<"insert" | "query" | "update" | "delete" | "getmore" | "command", number>;
  connections: { current: number; available: number };
  network: { bytesIn: number; bytesOut: number };
  // Megabytes, as serverStatus reports them.
  mem: { resident: number; virtual: number };
  wiredTiger: { cacheBytes: number; cacheMax: number; dirtyBytes: number } | null;
  globalLock: { activeReaders: number; activeWriters: number; queueReaders: number; queueWriters: number } | null;
}

export async function perf(conn: string, signal?: AbortSignal): Promise<PerfSample> {
  const d = plain(await call(conn, "GET", "perf", {}, undefined, signal));
  const sub = (v: BsonValue | undefined): BsonDocument => (isDocument(v) ? v : {});
  const ops = sub(d.opcounters);
  const wt = isDocument(d.wiredTiger) ? d.wiredTiger : null;
  const lock = isDocument(d.globalLock) ? d.globalLock : null;
  return {
    time: d.time instanceof BsonDate ? Number(d.time.ms) : toNumber(d.time) || Date.now(),
    uptime: toNumber(d.uptime),
    opcounters: { insert: toNumber(ops.insert), query: toNumber(ops.query), update: toNumber(ops.update), delete: toNumber(ops.delete), getmore: toNumber(ops.getmore), command: toNumber(ops.command) },
    connections: { current: toNumber(sub(d.connections).current), available: toNumber(sub(d.connections).available) },
    network: { bytesIn: toNumber(sub(d.network).bytesIn), bytesOut: toNumber(sub(d.network).bytesOut) },
    mem: { resident: toNumber(sub(d.mem).resident), virtual: toNumber(sub(d.mem).virtual) },
    wiredTiger: wt && { cacheBytes: toNumber(wt.cacheBytes), cacheMax: toNumber(wt.cacheMax), dirtyBytes: toNumber(wt.dirtyBytes) },
    globalLock: lock && { activeReaders: toNumber(lock.activeReaders), activeWriters: toNumber(lock.activeWriters), queueReaders: toNumber(lock.queueReaders), queueWriters: toNumber(lock.queueWriters) },
  };
}
