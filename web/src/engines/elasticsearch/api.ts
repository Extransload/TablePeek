// Client for the search routes (docs/engines/elasticsearch.md §4). Bodies
// and replies are the server's JSON as Elasticsearch / OpenSearch gave it;
// replies are read with `parseJson` so object keys keep their order. Errors
// arrive as `SearchError` with the server's code (`es_index_not_found_exception`,
// `es_version_conflict_engine_exception`, `bad_request`, …).

import { t } from "../../i18n";
import { store } from "../../store";
import { isAbort } from "../mongodb/api";
import { parseJson, stringifyJson, type BsonDocument, type BsonValue } from "../mongodb/bson";
import { docFromJson, list, num, rec, str, type Json } from "./json";

export { isAbort };

// The optional fields a server error adds to `{ code, message }` (ERRORS.md §2).
export interface SearchErrorFields {
  server_code?: number;
  code_name?: string;
  details?: unknown;
  raw?: string;
  position?: { offset?: number; line?: number; column?: number };
}

export class SearchError extends Error implements SearchErrorFields {
  readonly code: string;
  server_code?: number;
  code_name?: string;
  details?: unknown;
  raw?: string;
  position?: { offset?: number; line?: number; column?: number };

  constructor(code: string, message: string, fields: SearchErrorFields = {}) {
    super(message);
    this.code = code;
    for (const key of ["server_code", "code_name", "details", "raw", "position"] as const) {
      if (fields[key] !== undefined && fields[key] !== null) {
        Object.assign(this, { [key]: fields[key] });
      }
    }
  }
}

// A save refused because the document changed since it was read.
export function isVersionConflict(error: unknown): boolean {
  return error instanceof SearchError && (error.code === "es_version_conflict_engine_exception" || error.server_code === 409);
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

function failure(status: number, json: unknown): SearchError {
  const raw = rec(json);
  const inner = raw.error !== null && typeof raw.error === "object" ? rec(raw.error) : raw;
  if (status === 401) {
    store.serverRestarted();
  }
  return new SearchError(str(inner.code) || `http_${status}`, str(inner.message) || `HTTP ${status}`, inner as SearchErrorFields);
}

async function send(conn: string, method: Method, route: string, query: Record<string, string>, body: BodyInit | undefined, contentType: string, signal?: AbortSignal): Promise<Response> {
  const params = new URLSearchParams({ conn, ...query });
  try {
    return await fetch(`/api/search/${route}?${params}`, {
      method,
      signal,
      headers: { "content-type": contentType, "x-tablepeek-token": store.token() },
      body,
    });
  } catch (error) {
    if (isAbort(error)) {
      throw error;
    }
    store.serverUnreachable();
    throw new SearchError("network", t("서버에 연결할 수 없습니다"));
  }
}

async function call(conn: string, method: Method, route: string, query: Record<string, string>, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await send(conn, method, route, query, body === undefined ? undefined : stringifyJson(body), "application/json", signal);
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text === "" ? null : parseJson(text, { bigints: true });
  } catch {
    json = null;
  }
  if (!response.ok) {
    throw failure(response.status, json);
  }
  return json;
}

// ---- Cluster ----

export interface ClusterInfo {
  flavor: "elasticsearch" | "opensearch";
  version: string;
  distribution: string;
  build_flavor: string;
  lucene_version: string;
  cluster_name: string;
  cluster_uuid: string;
  node_name: string;
  tagline: string;
  // `_cluster/health` as the server gave it.
  health: Record<string, unknown>;
  // The nodes the connection knows and the one answering now.
  connection: ConnectionNodes;
}

export interface ConnectionNode {
  address: string;
  name: string | null;
  // The address the connection settings name.
  seed: boolean;
  current: boolean;
  // Refused a connection lately; passed over for a while.
  down: boolean;
}

export interface ConnectionNodes {
  // Whether the cluster's other nodes are looked up (`_nodes/http`).
  sniff: boolean;
  current: string;
  failovers: number;
  sniff_error: string | null;
  nodes: ConnectionNode[];
}

function connectionNodes(raw: unknown): ConnectionNodes {
  const r = rec(raw);
  return {
    sniff: r.sniff === true,
    current: str(r.current),
    failovers: num(r.failovers) ?? 0,
    sniff_error: r.sniff_error ? str(r.sniff_error) : null,
    nodes: list(r.nodes).map((x) => {
      const node = rec(x);
      return { address: str(node.address), name: node.name ? str(node.name) : null, seed: node.seed === true, current: node.current === true, down: node.down === true };
    }),
  };
}

export async function clusterInfo(conn: string, signal?: AbortSignal): Promise<ClusterInfo> {
  const r = rec(await call(conn, "GET", "cluster", {}, undefined, signal));
  return {
    flavor: r.flavor === "opensearch" ? "opensearch" : "elasticsearch",
    version: str(r.version),
    distribution: str(r.distribution),
    build_flavor: str(r.build_flavor),
    lucene_version: str(r.lucene_version),
    cluster_name: str(r.cluster_name),
    cluster_uuid: str(r.cluster_uuid),
    node_name: str(r.node_name),
    tagline: str(r.tagline),
    health: rec(r.health),
    connection: connectionNodes(r.connection),
  };
}

export interface NodeRow {
  id: string;
  name: string;
  ip: string;
  roles: string;
  master: boolean;
  version: string;
  heap_percent: number | null;
  ram_percent: number | null;
  cpu: number | null;
  load_1m: number | null;
  disk_used_percent: number | null;
  uptime: string;
}

export async function nodes(conn: string, signal?: AbortSignal): Promise<NodeRow[]> {
  return list(await call(conn, "GET", "nodes", {}, undefined, signal)).map((x) => {
    const r = rec(x);
    return {
      id: str(r.id),
      name: str(r.name),
      ip: str(r.ip),
      roles: Array.isArray(r.roles) ? r.roles.map(str).join(",") : str(r.roles),
      master: r.master === true || r.master === "*",
      version: str(r.version),
      heap_percent: num(r.heap_percent),
      ram_percent: num(r.ram_percent),
      cpu: num(r.cpu),
      load_1m: num(r.load_1m),
      disk_used_percent: num(r.disk_used_percent),
      uptime: str(r.uptime),
    };
  });
}

// One `_nodes/stats` sample summed over the nodes; counters are cumulative,
// the perf tab turns two samples into rates.
export interface PerfSample {
  time: number;
  nodes: number;
  docs: number;
  store_bytes: number;
  search: { query_total: number; query_time_ms: number; fetch_total: number; scroll_total: number; current: number };
  indexing: { index_total: number; index_time_ms: number; delete_total: number; current: number };
  get_total: number;
  refresh_total: number;
  merges_current: number;
  heap_used_bytes: number;
  heap_max_bytes: number;
  cpu_percent: number;
  open_fds: number;
  http_open: number;
  thread_pools: Record<string, { active: number; queue: number; rejected: number }>;
}

export async function perf(conn: string, signal?: AbortSignal): Promise<PerfSample> {
  const r = rec(await call(conn, "GET", "perf", {}, undefined, signal));
  const n = (v: unknown) => num(v) ?? 0;
  const s = rec(r.search);
  const i = rec(r.indexing);
  const pools: PerfSample["thread_pools"] = {};
  for (const [name, raw] of Object.entries(rec(r.thread_pools))) {
    const p = rec(raw);
    pools[name] = { active: n(p.active), queue: n(p.queue), rejected: n(p.rejected) };
  }
  return {
    time: n(r.time) || Date.now(),
    nodes: n(r.nodes),
    docs: n(r.docs),
    store_bytes: n(r.store_bytes),
    search: { query_total: n(s.query_total), query_time_ms: n(s.query_time_ms), fetch_total: n(s.fetch_total), scroll_total: n(s.scroll_total), current: n(s.current) },
    indexing: { index_total: n(i.index_total), index_time_ms: n(i.index_time_ms), delete_total: n(i.delete_total), current: n(i.current) },
    get_total: n(r.get_total),
    refresh_total: n(r.refresh_total),
    merges_current: n(r.merges_current),
    heap_used_bytes: n(r.heap_used_bytes),
    heap_max_bytes: n(r.heap_max_bytes),
    cpu_percent: n(r.cpu_percent),
    open_fds: n(r.open_fds),
    http_open: n(r.http_open),
    thread_pools: pools,
  };
}

export interface TaskRow {
  id: string;
  node: string;
  action: string;
  description: string;
  start_time_ms: number | null;
  running_time_ms: number | null;
  cancellable: boolean;
  cancelled: boolean;
  parent_task_id: string | null;
  opaque_id: string | null;
}

function taskRow(x: unknown): TaskRow {
  const r = rec(x);
  return {
    id: str(r.id),
    node: str(r.node),
    action: str(r.action),
    description: str(r.description),
    start_time_ms: num(r.start_time_ms),
    running_time_ms: num(r.running_time_ms),
    cancellable: r.cancellable === true,
    cancelled: r.cancelled === true,
    parent_task_id: r.parent_task_id ? str(r.parent_task_id) : null,
    opaque_id: r.opaque_id ? str(r.opaque_id) : null,
  };
}

export async function tasks(conn: string, actions?: string, signal?: AbortSignal): Promise<TaskRow[]> {
  return list(await call(conn, "GET", "tasks", actions ? { actions } : {}, undefined, signal)).map(taskRow);
}

export async function cancelTask(conn: string, id: string): Promise<unknown> {
  return call(conn, "POST", "tasks/cancel", {}, { id, confirmed: true });
}

// A task the server still runs after a Stop, with the tasks of its tree
// that can be cancelled.
export interface RunningTask extends TaskRow {
  related: TaskRow[];
}

// What a Stop left: the request it stopped, the tasks it cancelled, and
// what the server keeps running (a write, or a task it can't cancel).
export interface StopReport {
  stopped: boolean;
  request: string | null;
  cancelled: TaskRow[];
  running: RunningTask[];
}

// The page's Stop (docs/engines/elasticsearch.md §4.1): stops waiting for
// the read and asks the server about the stopped request's tasks.
export async function stopRunning(conn: string): Promise<StopReport> {
  const r = rec(await call(conn, "POST", "stop", {}));
  return {
    stopped: r.stopped === true,
    request: r.request ? str(r.request) : null,
    cancelled: list(r.cancelled).map(taskRow),
    running: list(r.running).map((x) => ({ ...taskRow(x), related: list(rec(x).related).map(taskRow) })),
  };
}

// ---- Security (users, roles, role mappings, API keys) ----

export type SecurityKind = "users" | "roles" | "role_mappings" | "api_keys";

export interface SecurityOverview {
  flavor: "elasticsearch" | "opensearch";
  enabled: boolean;
  // Why security can't be managed (off, no plugin).
  reason: string | null;
  // The signed-in user: its realm on Elasticsearch, its backend roles on
  // OpenSearch.
  user: { name: string; roles: string[]; realm: string | null; backendRoles: string[] } | null;
  // Whether the user may manage security; null when the server can't say.
  manage: boolean | null;
  // Whether the user may make and invalidate API keys (its own at least);
  // Elasticsearch only, null when the server can't say.
  manageApiKeys: boolean | null;
  kinds: Partial<Record<SecurityKind, { available: boolean; reason: string | null }>>;
  // Whether users can be turned off (not on OpenSearch), and why not.
  userEnabled: { available: boolean; reason: string | null };
}

export async function securityOverview(conn: string, signal?: AbortSignal): Promise<SecurityOverview> {
  const r = rec(await call(conn, "GET", "security", {}, undefined, signal));
  const user = r.user ? rec(r.user) : null;
  const switchable = rec(r.user_enabled);
  const kinds: SecurityOverview["kinds"] = {};
  for (const [key, value] of Object.entries(rec(r.kinds))) {
    const kind = rec(value);
    kinds[key as SecurityKind] = { available: kind.available === true, reason: kind.reason ? str(kind.reason) : null };
  }
  return {
    flavor: r.flavor === "opensearch" ? "opensearch" : "elasticsearch",
    enabled: r.enabled === true,
    reason: r.reason ? str(r.reason) : null,
    user: user
      ? {
          name: str(user.name),
          roles: list(user.roles).map((role) => str(role)),
          realm: user.realm ? str(user.realm) : null,
          backendRoles: list(user.backend_roles).map((role) => str(role)),
        }
      : null,
    manage: typeof r.manage === "boolean" ? r.manage : null,
    manageApiKeys: typeof r.manage_api_keys === "boolean" ? r.manage_api_keys : null,
    kinds,
    userEnabled: { available: switchable.available !== false, reason: switchable.reason ? str(switchable.reason) : null },
  };
}

// One user, role or role mapping (`name`), or API key (`id`), with the
// fields the screen shows and `body`, the definition as the server takes
// it back.
export type SecurityEntry = Record<string, Json> & { name: string; reserved?: boolean; hidden?: boolean; body: Json };

export async function securityList(conn: string, kind: SecurityKind, signal?: AbortSignal): Promise<SecurityEntry[]> {
  return list(await call(conn, "GET", "security/list", { kind }, undefined, signal)).map((x) => {
    const r = rec(x) as Record<string, Json>;
    return { ...r, name: str(r.name), body: r.body ?? null } as SecurityEntry;
  });
}

export async function securityPut(conn: string, kind: SecurityKind, name: string, body: Json): Promise<unknown> {
  return call(conn, "POST", "security/put", {}, { kind, name, body, confirmed: true });
}

export async function securityDelete(conn: string, kind: SecurityKind, names: string[]): Promise<unknown> {
  return call(conn, "POST", "security/delete", {}, { kind, names, confirmed: true });
}

export async function userPassword(conn: string, name: string, password: string): Promise<unknown> {
  return call(conn, "POST", "security/password", {}, { name, password, confirmed: true });
}

export async function userEnabled(conn: string, name: string, enabled: boolean): Promise<unknown> {
  return call(conn, "POST", "security/enabled", {}, { name, enabled, confirmed: true });
}

// The new key as the server answers it, once: its secret is not shown again.
export async function createApiKey(conn: string, body: Json): Promise<Record<string, unknown>> {
  return rec(await call(conn, "POST", "security/api-key", {}, { body, confirmed: true }));
}

export async function hotThreads(conn: string, threads = 3, interval = "500ms", signal?: AbortSignal): Promise<string> {
  const response = await send(conn, "GET", "hot-threads", { threads: String(threads), interval }, undefined, "application/json", signal);
  const text = await response.text();
  if (!response.ok) {
    let json: unknown = null;
    try {
      json = parseJson(text);
    } catch {
      json = null;
    }
    throw failure(response.status, json);
  }
  return text;
}

// `_cat/shards` rows as the server gave them (sizes in bytes).
export async function shards(conn: string, index?: string, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
  return list(await call(conn, "GET", "shards", index ? { index } : {}, undefined, signal)).map(rec);
}

// ---- Indices, aliases, data streams ----

export interface IndexRow {
  name: string;
  health: string;
  status: string;
  uuid: string;
  // Null for a closed index.
  docs: number | null;
  deleted: number | null;
  size: number | null;
  pri_size: number | null;
  primaries: number | null;
  replicas: number | null;
  aliases: string[];
  data_stream: string | null;
  hidden: boolean;
}

export async function indices(conn: string, hidden: boolean, signal?: AbortSignal): Promise<IndexRow[]> {
  return list(await call(conn, "GET", "indices", { hidden: String(hidden) }, undefined, signal)).map((x) => {
    const r = rec(x);
    return {
      name: str(r.name),
      health: str(r.health),
      status: str(r.status),
      uuid: str(r.uuid),
      docs: num(r.docs),
      deleted: num(r.deleted),
      size: num(r.size),
      pri_size: num(r.pri_size),
      primaries: num(r.primaries),
      replicas: num(r.replicas),
      aliases: list(r.aliases).map(str),
      data_stream: r.data_stream ? str(r.data_stream) : null,
      hidden: r.hidden === true,
    };
  });
}

export interface AliasRow {
  alias: string;
  index: string;
  filter: unknown;
  index_routing: string | null;
  search_routing: string | null;
  is_write_index: boolean | null;
  is_hidden: boolean;
}

export async function aliases(conn: string, signal?: AbortSignal): Promise<AliasRow[]> {
  return list(await call(conn, "GET", "aliases", {}, undefined, signal)).map((x) => {
    const r = rec(x);
    return {
      alias: str(r.alias),
      index: str(r.index),
      filter: r.filter ?? null,
      index_routing: r.index_routing ? str(r.index_routing) : null,
      search_routing: r.search_routing ? str(r.search_routing) : null,
      is_write_index: typeof r.is_write_index === "boolean" ? r.is_write_index : null,
      is_hidden: r.is_hidden === true,
    };
  });
}

export interface DataStreamRow {
  name: string;
  status: string;
  template: string;
  generation: number | null;
  indices: string[];
  hidden: boolean;
  raw: Record<string, unknown>;
}

export async function dataStreams(conn: string, signal?: AbortSignal): Promise<DataStreamRow[]> {
  return list(await call(conn, "GET", "data-streams", {}, undefined, signal)).map((x) => {
    const r = rec(x);
    return {
      name: str(r.name),
      status: str(r.status),
      template: str(r.template),
      generation: num(r.generation),
      indices: list(r.indices).map((i) => str(rec(i).index_name)),
      hidden: r.hidden === true,
      raw: r,
    };
  });
}

// `_mapping` as the server gave it (index names as keys).
export async function getMapping(conn: string, index: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return rec(await call(conn, "GET", "mapping", { index }, undefined, signal));
}

// `_settings` as the server gave it (index names as keys).
export async function getSettings(conn: string, index: string, defaults = false, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return rec(await call(conn, "GET", "settings", { index, defaults: String(defaults) }, undefined, signal));
}

export interface IndexDefinition {
  settings: unknown;
  mappings: unknown;
  aliases: unknown;
}

// A body that makes the index again (its DDL).
export async function definition(conn: string, index: string, signal?: AbortSignal): Promise<IndexDefinition> {
  const r = rec(await call(conn, "GET", "definition", { index }, undefined, signal));
  return { settings: r.settings ?? {}, mappings: r.mappings ?? {}, aliases: r.aliases ?? {} };
}

export async function putMapping(conn: string, index: string, body: Json): Promise<unknown> {
  return call(conn, "PUT", "mapping", {}, { index, body });
}

export async function putSettings(conn: string, index: string, body: Json): Promise<unknown> {
  return call(conn, "PUT", "settings", {}, { index, body });
}

export async function createIndex(conn: string, index: string, body?: Json): Promise<unknown> {
  return call(conn, "POST", "index/create", {}, { index, body });
}

// `delete` and `close` are refused without `confirmed`; callers ask first.
export async function indexAction(conn: string, action: "delete" | "open" | "close" | "refresh", index: string): Promise<unknown> {
  return call(conn, "POST", `index/${action}`, {}, action === "delete" || action === "close" ? { index, confirmed: true } : { index });
}

export async function reindex(conn: string, body: Json, wait = true): Promise<Record<string, unknown>> {
  return rec(await call(conn, "POST", "reindex", {}, { body, confirmed: true, wait }));
}

// `_aliases` actions; `remove_index` needs `confirmed`.
export async function updateAliases(conn: string, actions: Json[], confirmed = false): Promise<unknown> {
  return call(conn, "POST", "aliases", {}, { actions, confirmed: confirmed || undefined });
}

// ---- Search and documents ----

export interface SearchRequest {
  index?: string;
  body?: Json;
  from?: number;
  size?: number;
  sort?: Json;
  search_after?: Json[];
  source?: Json;
  highlight?: Json;
  track_total_hits?: boolean | number;
  pit?: { id: string; keep_alive?: string };
}

// A hit with its source as a document the shared views show: `_id` first,
// then the source fields.
export interface Hit {
  index: string;
  id: string;
  score: number | null;
  seqNo: number | null;
  primaryTerm: number | null;
  version: number | null;
  routing: string | null;
  // The `_source` as stored, without `_id`.
  source: BsonDocument;
  // `_id` followed by the source's fields, for the views.
  doc: BsonDocument;
  highlight: Record<string, string[]> | null;
  sort: Json[] | null;
}

export interface SearchResult {
  hits: Hit[];
  // Null when the server did not count (`track_total_hits: false`).
  total: { value: number; relation: "eq" | "gte" } | null;
  aggregations: unknown;
  profile: unknown;
  pitId: string | null;
  took: number | null;
  elapsedMs: number;
  // The reply as the server gave it.
  raw: Record<string, unknown>;
}

// Each view document's hit, for saving and deleting by `_id`.
const hitOfDoc = new WeakMap<BsonDocument, Hit>();

export function hitOf(doc: BsonDocument): Hit | undefined {
  return hitOfDoc.get(doc);
}

export function makeHit(raw: Record<string, unknown>): Hit {
  const source = docFromJson(raw._source);
  const id = str(raw._id);
  const doc: BsonDocument = new Map<string, BsonValue>([["_id", id]]);
  for (const [key, value] of source) {
    if (key !== "_id") {
      doc.set(key, value);
    }
  }
  const highlight = raw.highlight !== undefined ? (rec(raw.highlight) as Record<string, string[]>) : null;
  const hit: Hit = {
    index: str(raw._index),
    id,
    score: num(raw._score),
    seqNo: num(raw._seq_no),
    primaryTerm: num(raw._primary_term),
    version: num(raw._version),
    routing: raw._routing ? str(raw._routing) : null,
    source,
    doc,
    highlight,
    sort: Array.isArray(raw.sort) ? (raw.sort as Json[]) : null,
  };
  hitOfDoc.set(doc, hit);
  return hit;
}

function searchResult(raw: Record<string, unknown>): SearchResult {
  const hits = rec(raw.hits);
  const total = hits.total;
  let parsedTotal: SearchResult["total"] = null;
  if (typeof total === "number") {
    parsedTotal = { value: total, relation: "eq" };
  } else if (total !== null && typeof total === "object") {
    const t = rec(total);
    parsedTotal = { value: num(t.value) ?? 0, relation: t.relation === "gte" ? "gte" : "eq" };
  }
  return {
    hits: list(hits.hits).map((h) => makeHit(rec(h))),
    total: parsedTotal,
    aggregations: raw.aggregations ?? null,
    profile: raw.profile ?? null,
    pitId: raw.pit_id ? str(raw.pit_id) : null,
    took: num(raw.took),
    elapsedMs: num(raw.elapsed_ms) ?? 0,
    raw,
  };
}

export async function search(conn: string, req: SearchRequest, signal?: AbortSignal): Promise<SearchResult> {
  return searchResult(rec(await call(conn, "POST", "search", {}, req, signal)));
}

// The same search run with `profile: true`.
export async function profile(conn: string, req: SearchRequest, signal?: AbortSignal): Promise<SearchResult> {
  return searchResult(rec(await call(conn, "POST", "profile", {}, req, signal)));
}

export async function count(conn: string, index: string, query?: Json, signal?: AbortSignal): Promise<number> {
  const r = rec(await call(conn, "POST", "count", {}, { index, query }, signal));
  return num(r.count) ?? 0;
}

export async function openPit(conn: string, index: string, keepAlive = "1m", signal?: AbortSignal): Promise<string> {
  return str(rec(await call(conn, "POST", "pit", {}, { index, keep_alive: keepAlive }, signal)).id);
}

export async function closePit(conn: string, id: string): Promise<void> {
  await call(conn, "DELETE", "pit", {}, { id });
}

export interface StoredDoc {
  index: string;
  id: string;
  version: number | null;
  seqNo: number | null;
  primaryTerm: number | null;
  found: boolean;
  source: BsonDocument;
}

export async function getDoc(conn: string, index: string, id: string, routing?: string | null, signal?: AbortSignal): Promise<StoredDoc> {
  const r = rec(await call(conn, "POST", "doc/get", {}, { index, id, routing: routing ?? undefined }, signal));
  return {
    index: str(r._index) || index,
    id: str(r._id) || id,
    version: num(r._version),
    seqNo: num(r._seq_no),
    primaryTerm: num(r._primary_term),
    found: r.found !== false,
    source: docFromJson(r._source),
  };
}

export interface WriteResult {
  index: string;
  id: string;
  version: number | null;
  result: string;
  seqNo: number | null;
  primaryTerm: number | null;
}

function writeResult(raw: unknown): WriteResult {
  const r = rec(raw);
  return { index: str(r._index), id: str(r._id), version: num(r._version), result: str(r.result), seqNo: num(r._seq_no), primaryTerm: num(r._primary_term) };
}

// Optimistic concurrency: the `_seq_no`/`_primary_term` the document was read
// with; a change elsewhere since then fails with a version conflict.
export interface Guard {
  if_seq_no?: number;
  if_primary_term?: number;
}

export function guardOf(hit: { seqNo: number | null; primaryTerm: number | null }): Guard {
  return hit.seqNo !== null && hit.primaryTerm !== null ? { if_seq_no: hit.seqNo, if_primary_term: hit.primaryTerm } : {};
}

export async function indexDoc(conn: string, args: { index: string; id?: string; doc: Json; op_type?: "index" | "create"; routing?: string | null } & Guard): Promise<WriteResult> {
  return writeResult(await call(conn, "POST", "doc/index", {}, { ...args, routing: args.routing ?? undefined, refresh: "wait_for" }));
}

export async function updateDoc(conn: string, args: { index: string; id: string; doc: Json; routing?: string | null } & Guard): Promise<WriteResult> {
  return writeResult(await call(conn, "POST", "doc/update", {}, { ...args, routing: args.routing ?? undefined, refresh: "wait_for" }));
}

export async function deleteDoc(conn: string, args: { index: string; id: string; routing?: string | null } & Guard): Promise<WriteResult> {
  return writeResult(await call(conn, "POST", "doc/delete", {}, { ...args, routing: args.routing ?? undefined, refresh: "wait_for" }));
}

// By-query writes run once confirmed (the caller asks first under safe mode).
export async function deleteByQuery(conn: string, args: { index: string; query?: Json; conflicts?: "abort" | "proceed"; max_docs?: number }): Promise<Record<string, unknown>> {
  return rec(await call(conn, "POST", "delete-by-query", {}, { ...args, confirmed: true, refresh: true }));
}

export async function updateByQuery(conn: string, args: { index: string; query?: Json; script?: Json; conflicts?: "abort" | "proceed"; max_docs?: number }): Promise<Record<string, unknown>> {
  return rec(await call(conn, "POST", "update-by-query", {}, { ...args, confirmed: true, refresh: true }));
}

// ---- Analysis and plans ----

// What the connection's user may do on an index (`known: false` when the
// server could not tell; callers then fall back to a refused write).
export interface Privileges {
  known: boolean;
  cluster: { monitor: boolean; manage: boolean };
  index: { read: boolean; write: boolean; create_index: boolean; delete_index: boolean; manage: boolean };
}

export async function privileges(conn: string, index: string, signal?: AbortSignal): Promise<Privileges> {
  const r = rec(await call(conn, "GET", "privileges", { index }, undefined, signal));
  const c = rec(r.cluster);
  const i = rec(r.index);
  const yes = (v: unknown) => v !== false;
  return {
    known: r.known === true,
    cluster: { monitor: yes(c.monitor), manage: yes(c.manage) },
    index: { read: yes(i.read), write: yes(i.write), create_index: yes(i.create_index), delete_index: yes(i.delete_index), manage: yes(i.manage) },
  };
}

// A write refused for the user's rights (the fallback read-only signal).
export function isForbidden(error: unknown): boolean {
  return error instanceof SearchError && (error.code === "es_security_exception" || error.server_code === 403);
}

export async function explainDoc(conn: string, index: string, id: string, query: Json, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return rec(await call(conn, "POST", "explain", {}, { index, id, query }, signal));
}

export async function validateQuery(conn: string, index: string | undefined, query: Json, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return rec(await call(conn, "POST", "validate", {}, { index, query }, signal));
}

export interface AnalyzeToken {
  token: string;
  start_offset: number | null;
  end_offset: number | null;
  type: string;
  position: number | null;
}

export async function analyze(conn: string, index: string | undefined, body: Json, signal?: AbortSignal): Promise<{ tokens: AnalyzeToken[]; raw: Record<string, unknown> }> {
  const r = rec(await call(conn, "POST", "analyze", {}, { index, body }, signal));
  return {
    tokens: list(r.tokens).map((x) => {
      const tok = rec(x);
      return { token: str(tok.token), start_offset: num(tok.start_offset), end_offset: num(tok.end_offset), type: str(tok.type), position: num(tok.position) };
    }),
    raw: r,
  };
}

// ---- SQL ----

export interface SqlResult {
  columns: { name: string; type: string }[];
  rows: unknown[][];
  cursor: string | null;
  elapsedMs: number;
}

export async function sql(conn: string, args: { query?: string; fetch_size?: number; cursor?: string }, signal?: AbortSignal): Promise<SqlResult> {
  const r = rec(await call(conn, "POST", "sql", {}, args, signal));
  return {
    columns: list(r.columns).map((c) => ({ name: str(rec(c).name), type: str(rec(c).type) })),
    rows: list(r.rows).map((row) => list(row)),
    cursor: r.cursor ? str(r.cursor) : null,
    elapsedMs: num(r.elapsed_ms) ?? 0,
  };
}

export async function sqlClose(conn: string, cursor: string): Promise<void> {
  await call(conn, "POST", "sql/close", {}, { cursor });
}

export async function sqlTranslate(conn: string, query: string, signal?: AbortSignal): Promise<unknown> {
  return call(conn, "POST", "sql/translate", {}, { query }, signal);
}

// ---- Dev Tools console ----

export type RequestClass = "read" | "write" | "danger";

export interface ConsoleReply {
  status: number;
  // JSON when the server answered JSON, else its text.
  body: unknown;
  contentType: string;
  elapsedMs: number;
  class: RequestClass;
}

export async function consoleRequest(conn: string, req: { method: string; path: string; body?: Json | string; confirmed?: boolean }, signal?: AbortSignal): Promise<ConsoleReply> {
  const r = rec(await call(conn, "POST", "console", {}, req, signal));
  const cls = r.class === "write" || r.class === "danger" ? r.class : "read";
  return { status: num(r.status) ?? 0, body: r.body ?? null, contentType: str(r.content_type), elapsedMs: num(r.elapsed_ms) ?? 0, class: cls };
}

export async function classify(conn: string, method: string, path: string, signal?: AbortSignal): Promise<{ class: RequestClass; reason: string }> {
  const r = rec(await call(conn, "GET", "console/classify", { method, path }, undefined, signal));
  return { class: r.class === "write" || r.class === "danger" ? r.class : "read", reason: str(r.reason) };
}

// ---- Import and export ----

export interface BulkResult {
  took: number | null;
  errors: boolean;
  count: number;
  failed: number;
  failures: { position: number; index: string; id: string; status: number | null; type: string; reason: string }[];
}

// A `_bulk` NDJSON text (ending in a line break); `delete` actions need `confirmed`.
export async function bulk(conn: string, ndjson: string, opts: { index?: string; refresh?: boolean; confirmed?: boolean } = {}, signal?: AbortSignal): Promise<BulkResult> {
  const query: Record<string, string> = {};
  if (opts.index) query.index = opts.index;
  if (opts.refresh) query.refresh = "true";
  if (opts.confirmed) query.confirmed = "true";
  const response = await send(conn, "POST", "bulk", query, ndjson, "application/x-ndjson", signal);
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text === "" ? null : parseJson(text);
  } catch {
    json = null;
  }
  if (!response.ok) {
    throw failure(response.status, json);
  }
  const r = rec(json);
  return {
    took: num(r.took),
    errors: r.errors === true,
    count: num(r.count) ?? 0,
    failed: num(r.failed) ?? 0,
    failures: list(r.failures).map((x) => {
      const f = rec(x);
      return { position: num(f.position) ?? 0, index: str(f.index), id: str(f.id), status: num(f.status), type: str(f.type), reason: str(f.reason) };
    }),
  };
}

export interface ExportRequest {
  index: string;
  query?: Json;
  sort?: Json;
  source?: Json;
  limit?: number;
}

// The export stream's lines: `{ _index, _id, _source }` text as sent, until
// the end marker (its count) or a failure (thrown).
export async function* exportLines(conn: string, req: ExportRequest, signal?: AbortSignal): AsyncGenerator<{ line: string; bytes: number } | { end: number }> {
  const response = await send(conn, "POST", "export", {}, stringifyJson(req), "application/json", signal);
  if (!response.ok || response.body === null) {
    let json: unknown = null;
    try {
      json = parseJson(await response.text());
    } catch {
      json = null;
    }
    throw failure(response.status, json);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (value !== undefined) {
      bytes += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
    }
    let cut = buffer.indexOf("\n");
    while (cut >= 0) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      cut = buffer.indexOf("\n");
      if (line === "") {
        continue;
      }
      if (line.startsWith('{"$end"')) {
        yield { end: num(rec(rec(JSON.parse(line)).$end).count) ?? 0 };
        return;
      }
      if (line.startsWith('{"$error"')) {
        const e = rec(rec(JSON.parse(line)).$error);
        throw new SearchError(str(e.code) || "export_failed", str(e.message));
      }
      yield { line, bytes };
    }
    if (done) {
      break;
    }
  }
  throw new SearchError("export_cut", t("내보내기 스트림이 끝 표시 없이 끊겼습니다"));
}
