// Client for the document routes (MONGODB.md §6). Bodies and replies are
// canonical Extended JSON; this module turns them into `BsonValue`s both
// ways, so callers never see EJSON wrappers. Errors arrive as `MongoError`
// with the server's code (`mongo_11000`, `mongo_121`, `bad_request`, …).

import { t } from "../../i18n";
import { store } from "../../store";
import { BsonDate, Decimal128, Double, Int32, Int64, bsonDoc, fromEJSON, isDocument, parseJson, stringifyJson, toEJSON, type BsonDocument, type BsonValue } from "./bson";

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
  indexSizes: Map<string, number>;
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

export interface FindArgs extends QueryOptions {
  filter: BsonDocument;
  projection?: BsonDocument | null;
  sort?: BsonDocument | null;
  skip?: number;
  limit: number;
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

async function call(conn: string, method: "GET" | "POST" | "PUT" | "DELETE", route: string, query: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const params = new URLSearchParams({ conn, ...query });
  let response: Response;
  try {
    response = await fetch(`/api/doc/${route}?${params}`, {
      method,
      signal,
      headers: { "content-type": "application/json", "x-tablepeek-token": store.token() },
      body: body === undefined ? undefined : stringifyJson(body),
    });
  } catch (error) {
    if (isAbort(error)) {
      throw error;
    }
    store.serverUnreachable();
    throw new MongoError("network", t("서버에 연결할 수 없습니다"));
  }
  // Read as text: JSON.parse would move keys such as "2024" to the front.
  let json: unknown = null;
  try {
    json = parseJson(await response.text());
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
  return isDocument(value) ? value : new Map();
}

// A count or size field that may be missing or null.
function optionalNumber(v: BsonValue | undefined): number | null {
  return v === undefined || v === null ? null : toNumber(v);
}

export async function listDatabases(conn: string, signal?: AbortSignal): Promise<DocDatabase[]> {
  const list = (await call(conn, "GET", "databases", {}, undefined, signal)) as unknown[];
  return list.map((x) => {
    const d = plain(x);
    return { name: String(d.get("name")), sizeOnDisk: optionalNumber(d.get("sizeOnDisk")), empty: d.get("empty") === true };
  });
}

export async function listCollections(conn: string, db: string, signal?: AbortSignal): Promise<CollectionInfo[]> {
  const list = (await call(conn, "GET", "collections", { db }, undefined, signal)) as unknown[];
  return list.map((x) => {
    const d = plain(x);
    const kind = d.get("type");
    const type = kind === "view" || kind === "timeseries" ? kind : "collection";
    const options = d.get("options");
    return { name: String(d.get("name")), type, options: isDocument(options) ? options : new Map(), count: optionalNumber(d.get("count")) };
  });
}

export async function collStats(ns: Namespace, signal?: AbortSignal): Promise<CollStats> {
  const d = plain(await call(ns.conn, "GET", "stats", { db: ns.db, coll: ns.coll }, undefined, signal));
  const sizes = new Map<string, number>();
  const indexSizes = d.get("indexSizes");
  if (isDocument(indexSizes)) {
    for (const [k, v] of indexSizes) {
      sizes.set(k, toNumber(v));
    }
  }
  return {
    count: toNumber(d.get("count")),
    size: toNumber(d.get("size")),
    avgObjSize: toNumber(d.get("avgObjSize")),
    storageSize: toNumber(d.get("storageSize")),
    nindexes: toNumber(d.get("nindexes")),
    totalIndexSize: toNumber(d.get("totalIndexSize")),
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
    ...optionsBody(args),
    poll: args.poll || undefined,
  };
  const r = (await call(ns.conn, "POST", "find", {}, body, signal)) as { docs: unknown[]; elapsedMs: number };
  return { docs: docs(r.docs), elapsedMs: Number(r.elapsedMs) || 0 };
}

export async function count(ns: Namespace, filter: BsonDocument, signal?: AbortSignal, options?: QueryOptions): Promise<CountResult> {
  const r = (await call(ns.conn, "POST", "count", {}, { db: ns.db, coll: ns.coll, filter: toEJSON(filter), ...optionsBody(options) }, signal)) as { count: unknown; exact: boolean };
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
// the caller asks the user first (safe mode). `options` gives the filter a
// collation and the write a hint (a time limit is not used by writes).
export async function update(
  ns: Namespace,
  args: { filter: BsonDocument; update: BsonDocument | BsonDocument[]; many: boolean; upsert?: boolean; confirmed?: boolean; options?: QueryOptions },
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
    ...optionsBody(args.options),
  };
  const r = (await call(ns.conn, "POST", "update", {}, body, signal)) as UpdateResult;
  return { matched: Number(r.matched) || 0, modified: Number(r.modified) || 0 };
}

export async function replace(ns: Namespace, filter: BsonDocument, replacement: BsonDocument, confirmed = false, signal?: AbortSignal): Promise<UpdateResult> {
  const body = { db: ns.db, coll: ns.coll, filter: toEJSON(filter), replacement: toEJSON(replacement), confirmed: confirmed || undefined };
  const r = (await call(ns.conn, "POST", "replace", {}, body, signal)) as UpdateResult;
  return { matched: Number(r.matched) || 0, modified: Number(r.modified) || 0 };
}

export async function remove(ns: Namespace, filter: BsonDocument, many: boolean, confirmed = false, signal?: AbortSignal, options?: QueryOptions): Promise<number> {
  const body = { db: ns.db, coll: ns.coll, filter: toEJSON(filter), many, confirmed: confirmed || undefined, ...optionsBody(options) };
  const r = (await call(ns.conn, "POST", "delete", {}, body, signal)) as { deleted: number };
  return Number(r.deleted) || 0;
}

export async function listIndexes(ns: Namespace, signal?: AbortSignal): Promise<IndexInfo[]> {
  const list = (await call(ns.conn, "GET", "indexes", { db: ns.db, coll: ns.coll }, undefined, signal)) as unknown[];
  return list.map((x) => {
    const d = plain(x);
    const key = d.get("key");
    const info: IndexInfo = { name: String(d.get("name")), key: isDocument(key) ? key : new Map() };
    const ttl = optionalNumber(d.get("expireAfterSeconds"));
    const partial = d.get("partialFilterExpression");
    const size = optionalNumber(d.get("size"));
    const ops = optionalNumber(d.get("ops"));
    if (d.get("unique") === true) info.unique = true;
    if (d.get("sparse") === true) info.sparse = true;
    if (ttl !== null) info.expireAfterSeconds = ttl;
    if (isDocument(partial)) info.partialFilterExpression = partial;
    if (size !== null) info.size = size;
    if (ops !== null) info.ops = ops;
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
export async function explain(ns: Namespace, target: ExplainTarget, verbosity = "executionStats", signal?: AbortSignal, options?: QueryOptions): Promise<BsonDocument> {
  const body: Record<string, unknown> = { db: ns.db, coll: ns.coll, verbosity, ...optionsBody(options) };
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

export type ExportRequest = (
  | { filter: BsonDocument; projection: BsonDocument | null; sort: BsonDocument | null; limit: number | null }
  | { pipeline: BsonDocument[] }
) & { options?: QueryOptions };

// Streams `POST /api/doc/export`: `onLine` gets each document's canonical
// EJSON line as the server wrote it (writers that keep canonical form pass
// it through unparsed). Resolves with the server's count from the closing
// `{"$end": { count }}` line; a `{"$error": …}` line or a stream that stops
// before `$end` rejects. Aborting `signal` closes the connection, which
// ends the server's cursor.
export async function exportDocs(ns: Namespace, request: ExportRequest, onLine: (line: string) => void, signal?: AbortSignal): Promise<number> {
  const body: Record<string, unknown> = { db: ns.db, coll: ns.coll, ...optionsBody(request.options) };
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
      body: stringifyJson(body),
    });
  } catch (error) {
    if (isAbort(error)) {
      throw error;
    }
    store.serverUnreachable();
    throw new MongoError("network", t("서버에 연결할 수 없습니다"));
  }
  if (!response.ok || response.body === null) {
    throw responseError(response.status, await response.text().then(parseJson).catch(() => null));
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let rest = "";
  // The closing line's count; a `$error` line throws. Null for a document.
  const closing = (line: string): number | null => {
    if (!line.startsWith('{"$end"') && !line.startsWith('{"$error"')) {
      return null;
    }
    const d = plain(parseJson(line));
    const end = d.get("$end");
    const error = d.get("$error");
    if (isDocument(end)) {
      return toNumber(end.get("count"));
    }
    if (isDocument(error)) {
      throw new MongoError(String(error.get("code") ?? "mongodb_error"), String(error.get("message") ?? ""), toEJSON(error) as MongoErrorFields);
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
  await command(conn, db, new Map([["create", name], ...options]), false, signal);
}

// renameCollection runs against admin with full names.
export async function renameCollection(conn: string, db: string, from: string, to: string, dropTarget: boolean, signal?: AbortSignal): Promise<void> {
  await command(conn, "admin", bsonDoc({ renameCollection: `${db}.${from}`, to: `${db}.${to}`, dropTarget }), true, signal);
}

export async function dropCollection(conn: string, db: string, coll: string, signal?: AbortSignal): Promise<void> {
  await command(conn, db, bsonDoc({ drop: coll }), true, signal);
}

export async function dropDatabase(conn: string, db: string, signal?: AbortSignal): Promise<void> {
  await command(conn, db, bsonDoc({ dropDatabase: new Int32(1) }), true, signal);
}

// ---- 성능 tab (DocPerf) ----

// One `GET /api/doc/perf` sample: the parts of `serverStatus` the 성능 tab
// charts. Counters are cumulative; the tab turns two samples into rates.
export interface PerfSample {
  // Server clock, ms since the epoch.
  time: number;
  // Seconds since the server started.
  uptime: number;
  // The server is a mongos router (no `top`, no `system.profile`).
  mongos: boolean;
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
  const sub = (key: string): BsonDocument => {
    const v = d.get(key);
    return isDocument(v) ? v : new Map();
  };
  const ops = sub("opcounters");
  const wt = isDocument(d.get("wiredTiger")) ? sub("wiredTiger") : null;
  const lock = isDocument(d.get("globalLock")) ? sub("globalLock") : null;
  const time = d.get("time");
  const num = (doc: BsonDocument, key: string) => toNumber(doc.get(key));
  return {
    time: time instanceof BsonDate ? Number(time.ms) : toNumber(time) || Date.now(),
    uptime: num(d, "uptime"),
    mongos: d.get("process") === "mongos",
    opcounters: { insert: num(ops, "insert"), query: num(ops, "query"), update: num(ops, "update"), delete: num(ops, "delete"), getmore: num(ops, "getmore"), command: num(ops, "command") },
    connections: { current: num(sub("connections"), "current"), available: num(sub("connections"), "available") },
    network: { bytesIn: num(sub("network"), "bytesIn"), bytesOut: num(sub("network"), "bytesOut") },
    mem: { resident: num(sub("mem"), "resident"), virtual: num(sub("mem"), "virtual") },
    wiredTiger: wt && { cacheBytes: num(wt, "cacheBytes"), cacheMax: num(wt, "cacheMax"), dirtyBytes: num(wt, "dirtyBytes") },
    globalLock: lock && { activeReaders: num(lock, "activeReaders"), activeWriters: num(lock, "activeWriters"), queueReaders: num(lock, "queueReaders"), queueWriters: num(lock, "queueWriters") },
  };
}

// ---- 일괄 수정·삭제 (BulkUI) ----

// One previewed document: as stored, and as the update leaves it (null
// when the server could not read it back).
export interface PreviewSample {
  before: BsonDocument;
  after: BsonDocument | null;
}

export interface UpdatePreview {
  // null: counting took longer than the server's three seconds.
  matched: number | null;
  samples: PreviewSample[];
  // false: the server runs no transactions (a standalone server), so only
  // `matched` came back.
  previewed: boolean;
}

// `POST /api/doc/update/preview`: the first `limit` (1–20) matching
// documents before and after `update`, made inside a transaction the server
// aborts, so nothing stays changed. `options` as for `update`.
export async function updatePreview(ns: Namespace, filter: BsonDocument, update: BsonDocument | BsonDocument[], limit: number, signal?: AbortSignal, options?: QueryOptions): Promise<UpdatePreview> {
  const body = { db: ns.db, coll: ns.coll, filter: toEJSON(filter), update: Array.isArray(update) ? update.map(toEJSON) : toEJSON(update), limit, ...optionsBody(options) };
  const r = (await call(ns.conn, "POST", "update/preview", {}, body, signal)) as { matched: unknown; samples: unknown; previewed: unknown };
  const samples: PreviewSample[] = [];
  for (const s of Array.isArray(r.samples) ? (r.samples as { before?: unknown; after?: unknown }[]) : []) {
    const before = fromEJSON(s.before ?? null);
    const after = fromEJSON(s.after ?? null);
    if (isDocument(before)) {
      samples.push({ before, after: isDocument(after) ? after : null });
    }
  }
  return { matched: r.matched === null || r.matched === undefined ? null : toNumber(fromEJSON(r.matched)), samples, previewed: r.previewed === true };
}

// ---- end 일괄 수정·삭제 ----

// ---- Atlas Search indexes, change streams, GridFS (MONGODB.md §8.3) ----

// One Atlas Search index as `$listSearchIndexes` reports it. `status` is
// the server's word (PENDING, BUILDING, READY, FAILED, DELETING, …).
export interface SearchIndexInfo {
  name: string;
  type: string;
  status: string;
  queryable: boolean;
  // The definition the index is (being) built from; null if not reported.
  definition: BsonDocument | null;
  // The whole entry as the server gave it.
  raw: BsonDocument;
}

// A server without search answers `unsupported_capability`.
export async function listSearchIndexes(ns: Namespace, signal?: AbortSignal): Promise<SearchIndexInfo[]> {
  const list = docs(await call(ns.conn, "GET", "search-indexes", { db: ns.db, coll: ns.coll }, undefined, signal));
  return list.map((d) => {
    const latest = d.get("latestDefinition");
    return {
      name: String(d.get("name") ?? ""),
      type: String(d.get("type") ?? "search"),
      status: String(d.get("status") ?? ""),
      queryable: d.get("queryable") === true,
      definition: isDocument(latest) ? latest : null,
      raw: d,
    };
  });
}

export async function createSearchIndex(ns: Namespace, name: string, type: string, definition: BsonDocument, signal?: AbortSignal): Promise<string> {
  const d = plain(await call(ns.conn, "POST", "search-indexes", {}, { db: ns.db, coll: ns.coll, name, type, definition: toEJSON(definition) }, signal));
  return String(d.get("name") ?? name);
}

export async function updateSearchIndex(ns: Namespace, name: string, definition: BsonDocument, signal?: AbortSignal): Promise<void> {
  await call(ns.conn, "PUT", "search-indexes", {}, { db: ns.db, coll: ns.coll, name, definition: toEJSON(definition) }, signal);
}

// The caller has asked the user first.
export async function dropSearchIndex(ns: Namespace, name: string, signal?: AbortSignal): Promise<void> {
  await call(ns.conn, "DELETE", "search-indexes", {}, { db: ns.db, coll: ns.coll, name, confirmed: true }, signal);
}

export interface WatchRequest {
  db: string;
  // Without one, every collection of `db`.
  coll?: string;
  pipeline?: BsonDocument[];
  fullDocument?: "updateLookup" | "whenAvailable" | "required";
  fullDocumentBeforeChange?: "whenAvailable" | "required" | "off";
  // An event's `_id`: the stream starts after that event.
  resumeAfter?: BsonValue;
}

// Streams `POST /api/doc/watch`: `onEvent` gets each change event,
// `onHeartbeat` the server's clock on the line it sends when the stream
// opens and every 15 seconds after. Resolves when the server ends the
// stream (after an invalidate event, say); a `{"$error": …}` line or a
// broken connection rejects. Aborting `signal` closes it on the server.
export async function watchChanges(conn: string, request: WatchRequest, onEvent: (event: BsonDocument) => void, onHeartbeat: (ms: number) => void, signal?: AbortSignal): Promise<void> {
  const body: Record<string, unknown> = { db: request.db, coll: request.coll, fullDocument: request.fullDocument, fullDocumentBeforeChange: request.fullDocumentBeforeChange };
  if (request.pipeline !== undefined && request.pipeline.length > 0) {
    body.pipeline = request.pipeline.map(toEJSON);
  }
  if (request.resumeAfter !== undefined) {
    body.resumeAfter = toEJSON(request.resumeAfter);
  }
  let response: Response;
  try {
    response = await fetch(`/api/doc/watch?${new URLSearchParams({ conn })}`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", "x-tablepeek-token": store.token() },
      body: stringifyJson(body),
    });
  } catch (error) {
    if (isAbort(error)) {
      throw error;
    }
    store.serverUnreachable();
    throw new MongoError("network", t("서버에 연결할 수 없습니다"));
  }
  if (!response.ok || response.body === null) {
    throw responseError(response.status, await response.text().then(parseJson).catch(() => null));
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const handle = (line: string) => {
    const d = plain(parseJson(line));
    const beat = d.get("$heartbeat");
    if (beat !== undefined && d.size === 1) {
      onHeartbeat(toNumber(beat));
      return;
    }
    const error = d.get("$error");
    if (isDocument(error) && d.size === 1) {
      throw new MongoError(String(error.get("code") ?? "mongodb_error"), String(error.get("message") ?? ""), toEJSON(error) as MongoErrorFields);
    }
    onEvent(d);
  };
  let rest = "";
  for (;;) {
    let chunk: ReadableStreamReadResult<string>;
    try {
      chunk = await reader.read();
    } catch (error) {
      if (isAbort(error) || signal?.aborted === true) {
        throw error;
      }
      throw new MongoError("network", t("변경 스트림 연결이 끊겼습니다"));
    }
    if (chunk.done) {
      break;
    }
    rest += chunk.value;
    let from = 0;
    for (let nl = rest.indexOf("\n"); nl !== -1; nl = rest.indexOf("\n", from)) {
      const line = rest.slice(from, nl).trim();
      from = nl + 1;
      if (line !== "") {
        handle(line);
      }
    }
    rest = rest.slice(from);
  }
  if (rest.trim() !== "") {
    handle(rest.trim());
  }
}

export interface GridFsFilesArgs {
  filter: BsonDocument;
  sort: BsonDocument | null;
  skip: number;
  limit: number;
}

// The bucket's `.files` documents as stored.
export async function gridFsFiles(conn: string, db: string, bucket: string, args: GridFsFilesArgs, signal?: AbortSignal): Promise<BsonDocument[]> {
  const d = plain(await call(conn, "POST", "gridfs/files", {}, { db, bucket, filter: toEJSON(args.filter), sort: ejsonDoc(args.sort), skip: args.skip || undefined, limit: args.limit }, signal));
  const files = d.get("files");
  return Array.isArray(files) ? files.filter(isDocument) : [];
}

// A link the browser downloads the file from by itself (this route takes
// the token in the query), so the page never holds the file.
export function gridFsDownloadUrl(conn: string, db: string, bucket: string, id: BsonValue): string {
  return `/api/doc/gridfs/download?${new URLSearchParams({ conn, db, bucket, id: stringifyJson(toEJSON(id)), token: store.token() })}`;
}

// Sends `file` as the request body; the server stores it chunk by chunk as
// it arrives. XMLHttpRequest because fetch reports no upload progress:
// `onProgress` gets the bytes sent so far. Resolves with the new file's id.
export function gridFsUpload(
  conn: string,
  db: string,
  bucket: string,
  file: Blob,
  filename: string,
  metadata: BsonDocument | null,
  onProgress: (sent: number) => void,
  signal?: AbortSignal,
): Promise<BsonValue> {
  const query: Record<string, string> = { conn, db, bucket, filename };
  if (metadata !== null) {
    query.metadata = stringifyJson(toEJSON(metadata));
  }
  // Executor form: the lib target has no Promise.withResolvers.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/doc/gridfs/upload?${new URLSearchParams(query)}`);
    xhr.setRequestHeader("x-tablepeek-token", store.token());
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () => {
      let json: unknown = null;
      try {
        json = parseJson(xhr.responseText);
      } catch {
        json = null;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(responseError(xhr.status, json));
        return;
      }
      onProgress(file.size);
      resolve(plain(json).get("id") ?? null);
    };
    xhr.onerror = () => {
      store.serverUnreachable();
      reject(new MongoError("network", t("서버에 연결할 수 없습니다")));
    };
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

// The caller has asked the user first.
export async function gridFsDelete(conn: string, db: string, bucket: string, id: BsonValue, signal?: AbortSignal): Promise<void> {
  await call(conn, "DELETE", "gridfs/files", {}, { db, bucket, id: toEJSON(id), confirmed: true }, signal);
}

// ---- end Atlas Search, change streams, GridFS ----

// ---- Query options (QueryOptsCode) ----

// The query bar's 옵션 that change how the server runs a read (find,
// count, aggregate, explain, export): how strings compare, the index to
// use (its name or its keys), and the time limit.
export interface QueryOptions {
  collation?: BsonDocument | null;
  hint?: string | BsonDocument | null;
  maxTimeMS?: number;
}

// The options as body fields; missing ones are left out.
function optionsBody(options: QueryOptions | undefined): { collation?: unknown; hint?: unknown; maxTimeMS?: number } {
  if (options === undefined) {
    return {};
  }
  const { collation, hint, maxTimeMS } = options;
  return {
    collation: collation ? toEJSON(collation) : undefined,
    hint: typeof hint === "string" ? hint || undefined : hint ? toEJSON(hint) : undefined,
    maxTimeMS,
  };
}

// ---- end Query options ----
