// Client for the key-value routes (/api/kv/*, docs/engines/redis.md §4).
// Shapes follow crates/tablepeek-engine/src/keyvalue.rs. Errors arrive as
// `KvError` with the server's code (`redis_WRONGTYPE`, `not_found`,
// `bad_request`, `interrupted`, …); a command's own error in the console
// comes back as a reply, not as an error.

import { t } from "../../i18n";
import { store } from "../../store";
import { isAbort } from "../mongodb/api";
import type { Bin } from "./bin";
import type { ScanKey } from "./keytree";
import type { Reply } from "./reply";

export { isAbort };

export class KvError extends Error {
  readonly code: string;
  server_code?: number;
  code_name?: string;
  details?: unknown;
  raw?: string;

  constructor(code: string, message: string, fields: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    for (const key of ["server_code", "code_name", "details", "raw"] as const) {
      if (fields[key] !== undefined && fields[key] !== null) {
        Object.assign(this, { [key]: fields[key] });
      }
    }
  }
}

async function send(conn: string, route: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(`/api/kv/${route}?${new URLSearchParams({ conn })}`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", "x-tablepeek-token": store.token() },
      body: JSON.stringify(body ?? {}),
    });
  } catch (error) {
    if (isAbort(error)) {
      throw error;
    }
    store.serverUnreachable();
    throw new KvError("network", t("서버에 연결할 수 없습니다"));
  }
}

async function failure(response: Response): Promise<KvError> {
  if (response.status === 401) {
    store.serverRestarted();
  }
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  const outer = json !== null && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const inner = outer.error !== null && typeof outer.error === "object" ? (outer.error as Record<string, unknown>) : outer;
  const code = typeof inner.code === "string" ? inner.code : `http_${response.status}`;
  const message = typeof inner.message === "string" && inner.message !== "" ? inner.message : `HTTP ${response.status}`;
  return new KvError(code, message, inner);
}

async function call<T>(conn: string, route: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await send(conn, route, body, signal);
  if (!response.ok) {
    throw await failure(response);
  }
  return (await response.json()) as T;
}

// ---- The key browser ----

export interface KvDatabase {
  index: number;
  keys: number;
  expires: number;
}

export interface ScanPage {
  // "0" once every key was visited.
  cursor: string;
  keys: ScanKey[];
}

export function scan(conn: string, req: { db: number; cursor: string; pattern?: Bin | null; type?: string | null; count?: number }, signal?: AbortSignal): Promise<ScanPage> {
  const body: Record<string, unknown> = { db: req.db, cursor: req.cursor, count: req.count ?? 500 };
  if (req.pattern !== undefined && req.pattern !== null) {
    body.pattern = req.pattern;
  }
  if (req.type !== undefined && req.type !== null && req.type !== "") {
    body.type = req.type;
  }
  return call(conn, "scan", body, signal);
}

// The time left and size of keys the list shows, in one request (at most 500).
export interface KeyMeta {
  key: Bin;
  // -1 without an expiry, -2 for a key that is gone.
  ttl_ms: number;
  memory: number | null;
}

export function keysMeta(conn: string, db: number, keys: Bin[], signal?: AbortSignal): Promise<KeyMeta[]> {
  return call(conn, "keys/meta", { db, keys }, signal);
}

// What the overview strip shows, from one INFO.
export interface Overview {
  flavor: "redis" | "valkey";
  version: string;
  used_memory: number;
  ops_per_sec: number;
  connected_clients: number;
  keys_total: number;
  current: number;
  databases: KvDatabase[];
}

export function overview(conn: string, signal?: AbortSignal): Promise<Overview> {
  return call(conn, "overview", {}, signal);
}

// ---- A key ----

export interface KeyInfo {
  exists: boolean;
  type: string;
  // -1 without an expiry, -2 for a key that is gone.
  ttl_ms: number;
  memory: number | null;
  encoding: string | null;
  length: number | null;
}

export function keyInfo(conn: string, db: number, key: Bin, signal?: AbortSignal): Promise<KeyInfo> {
  return call(conn, "key", { db, key }, signal);
}

export interface HashEntry {
  field: Bin;
  value: Bin;
}

export interface ListItem {
  index: number;
  value: Bin;
}

export interface ZsetEntry {
  member: Bin;
  score: string;
}

export interface StreamEntry {
  id: string;
  fields: [Bin, Bin][];
}

export type KeyPage =
  | { type: "string"; value: Bin; total: number; truncated: boolean }
  | { type: "hash"; entries: HashEntry[]; cursor: string; total: number }
  | { type: "list"; items: ListItem[]; offset: number; total: number }
  | { type: "set"; members: Bin[]; cursor: string; total: number }
  | { type: "zset"; entries: ZsetEntry[]; cursor: string | null; offset: number; total: number }
  | { type: "stream"; entries: StreamEntry[]; next: string | null; total: number }
  | { type: "json"; text: string }
  | { type: "other"; kind: string };

export interface ReadRequest {
  db: number;
  key: Bin;
  cursor?: string;
  offset?: number;
  count?: number;
  pattern?: Bin | null;
  rev?: boolean;
  from?: string;
  max_bytes?: number;
}

export function read(conn: string, req: ReadRequest, signal?: AbortSignal): Promise<KeyPage> {
  const body: Record<string, unknown> = { ...req };
  if (req.pattern === null) {
    delete body.pattern;
  }
  return call(conn, "read", body, signal);
}

export type CreateKind = "string" | "hash" | "list" | "set" | "zset" | "stream" | "json";

export type EditOp =
  | { op: "set_string"; value: Bin }
  | { op: "hash_set"; field: Bin; value: Bin; only_new?: boolean }
  | { op: "hash_delete"; fields: Bin[] }
  | { op: "hash_rename"; field: Bin; to: Bin }
  | { op: "list_set"; index: number; value: Bin; expect?: Bin }
  | { op: "list_push"; values: Bin[]; head?: boolean }
  | { op: "list_remove"; index: number; expect?: Bin }
  | { op: "set_add"; members: Bin[] }
  | { op: "set_remove"; members: Bin[] }
  | { op: "set_replace"; member: Bin; to: Bin }
  | { op: "zset_add"; member: Bin; score: string; only_new?: boolean }
  | { op: "zset_remove"; members: Bin[] }
  | { op: "zset_rename"; member: Bin; to: Bin; score: string }
  | { op: "stream_add"; id?: string; fields: [Bin, Bin][] }
  | { op: "stream_delete"; ids: string[] }
  | { op: "json_set"; path?: string; value: string }
  | { op: "create"; kind: CreateKind; value?: Bin; field?: Bin; score?: string; fields?: [Bin, Bin][]; text?: string; ttl_secs?: number }
  | { op: "rename"; to: Bin; overwrite?: boolean }
  | { op: "delete" }
  | { op: "expire"; ttl_ms: number }
  | { op: "persist" };

export interface EditOutcome {
  changed: number;
  id?: string;
}

// A change to one key. Every change lands in the connection's history.
export async function edit(conn: string, db: number, key: Bin, op: EditOp): Promise<EditOutcome> {
  try {
    return await call<EditOutcome>(conn, "edit", { db, key, ...op });
  } finally {
    store.historyChanged(conn);
  }
}

// ---- Console ----

export type CommandClass = "read" | "write" | "danger";

export interface Classified {
  class: CommandClass;
  // The command's name as the server knows it ("CONFIG SET").
  command: string;
  reason?: string;
}

export function classify(conn: string, db: number, line: string, signal?: AbortSignal): Promise<Classified> {
  return call(conn, "classify", { db, line }, signal);
}

export interface ConsoleReply {
  reply: Reply;
  // The console's database after the command (SELECT moves it).
  db: number;
  elapsed_ms: number;
  class: CommandClass;
}

export async function consoleRun(conn: string, req: { db: number; line: string; confirmed?: boolean }): Promise<ConsoleReply> {
  try {
    return await call<ConsoleReply>(conn, "console", req);
  } finally {
    store.historyChanged(conn);
  }
}

export async function consoleStop(conn: string): Promise<void> {
  await call(conn, "stop", {});
}

// ---- Server ----

export interface InfoSection {
  name: string;
  entries: [string, string][];
}

export async function info(conn: string, section?: string, signal?: AbortSignal): Promise<InfoSection[]> {
  const reply = await call<{ sections: InfoSection[] }>(conn, "info", section === undefined ? {} : { section }, signal);
  return reply.sections;
}

export interface SlowEntry {
  id: number;
  // Unix seconds.
  at: number;
  duration_us: number;
  args: Bin[];
  client: string | null;
  client_name: string | null;
}

export async function slowlog(conn: string, count = 128, signal?: AbortSignal): Promise<SlowEntry[]> {
  const reply = await call<{ entries: SlowEntry[] }>(conn, "slowlog", { count }, signal);
  return reply.entries;
}

export async function slowlogReset(conn: string): Promise<void> {
  await call(conn, "slowlog/reset", {});
}

// ---- Export ----

function fileNameOf(disposition: string | null): string | null {
  if (disposition === null) {
    return null;
  }
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition);
  if (encoded !== null) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      return null;
    }
  }
  return /filename\s*=\s*"?([^";]+)"?/i.exec(disposition)?.[1] ?? null;
}

// A key's whole value as a file (JSON with its type and expiry, or the value
// as text), with the name the server gives it.
export async function exportKey(conn: string, db: number, key: Bin, format: "json" | "text", signal?: AbortSignal): Promise<{ name: string | null; blob: Blob }> {
  const response = await send(conn, "export", { db, key, format }, signal);
  if (!response.ok) {
    throw await failure(response);
  }
  return { name: fileNameOf(response.headers.get("content-disposition")), blob: await response.blob() };
}
