// The 클러스터 tab's arithmetic (docs/engines/elasticsearch.md §4.1): per-
// second rates and average latencies from two `_nodes/stats` samples, the
// running tasks without the tab's own polls, and `_cat/shards` rows grouped
// by index. Plain data in and out; the tab draws it. The window, polling
// interval and axis steps are the MongoDB 성능 tab's (mongodb/perf.ts).

import { WINDOW_MS } from "../mongodb/perf";
import type { PerfSample, TaskRow } from "./api";

// Two samples further apart than this (the tab was hidden or paused) are
// not averaged into one rate; the lines break there instead. A poll that
// timed out breaks them too (the caller passes no previous sample).
const MAX_GAP_MS = 10_000;

export interface PoolPoint {
  active: number;
  queue: number;
  // Rejections per second; null when the point is a gap.
  rejected: number | null;
}

export interface ClusterPoint {
  time: number;
  // No line joins this point to the one before: the first sample, or the
  // first after a pause, a missed poll, a node joining or leaving, or a
  // restart.
  gap: boolean;
  // Operations per second; null when `gap`.
  query: number | null;
  fetch: number | null;
  index: number | null;
  delete: number | null;
  get: number | null;
  refresh: number | null;
  // Average milliseconds per operation over the interval; null when `gap`
  // or when none ran.
  queryMs: number | null;
  indexMs: number | null;
  heapUsed: number;
  heapMax: number;
  cpu: number;
  search: PoolPoint;
  write: PoolPoint;
  http: number;
  docs: number;
  store: number;
}

// Counters are cumulative since each node started; a sum that went down (a
// restart, a node leaving) gives no rate.
function rate(prev: number, cur: number, seconds: number): number | null {
  return cur >= prev ? (cur - prev) / seconds : null;
}

// Time spent per operation between two samples.
function latency(prevCount: number, curCount: number, prevMs: number, curMs: number): number | null {
  const count = curCount - prevCount;
  return count > 0 && curMs >= prevMs ? (curMs - prevMs) / count : null;
}

const NO_POOL = { active: 0, queue: 0, rejected: 0 };

export function clusterPoint(prev: PerfSample | null, cur: PerfSample): ClusterPoint {
  const dt = prev === null ? 0 : cur.time - prev.time;
  const usable = prev !== null && dt > 0 && dt <= MAX_GAP_MS && cur.nodes === prev.nodes;
  const seconds = dt / 1000;
  const r = (pick: (s: PerfSample) => number): number | null => (usable && prev !== null ? rate(pick(prev), pick(cur), seconds) : null);
  const pool = (name: string): PoolPoint => {
    const now = cur.thread_pools[name] ?? NO_POOL;
    const before = prev?.thread_pools[name] ?? NO_POOL;
    return { active: now.active, queue: now.queue, rejected: usable ? rate(before.rejected, now.rejected, seconds) : null };
  };
  return {
    time: cur.time,
    gap: !usable,
    query: r((s) => s.search.query_total),
    fetch: r((s) => s.search.fetch_total),
    index: r((s) => s.indexing.index_total),
    delete: r((s) => s.indexing.delete_total),
    get: r((s) => s.get_total),
    refresh: r((s) => s.refresh_total),
    queryMs: usable ? latency(prev.search.query_total, cur.search.query_total, prev.search.query_time_ms, cur.search.query_time_ms) : null,
    indexMs: usable ? latency(prev.indexing.index_total, cur.indexing.index_total, prev.indexing.index_time_ms, cur.indexing.index_time_ms) : null,
    heapUsed: cur.heap_used_bytes,
    heapMax: cur.heap_max_bytes,
    cpu: cur.cpu_percent,
    search: pool("search"),
    write: pool("write"),
    http: cur.http_open,
    docs: cur.docs,
    store: cur.store_bytes,
  };
}

// The points still inside the window ending at `point`, plus `point`.
export function appendPoint(points: ClusterPoint[], point: ClusterPoint): ClusterPoint[] {
  const from = point.time - WINDOW_MS;
  return [...points.filter((p) => p.time >= from && p.time < point.time), point];
}

// What the actions filter sends: a pattern as typed when it has a
// wildcard or a comma list, otherwise the text anywhere in the action
// (`search` → `*search*`).
export function actionsPattern(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  return /[*,]/.test(trimmed) ? trimmed.replace(/\s+/g, "") : `*${trimmed}*`;
}

// Requests the app sends carry `X-Opaque-Id: tablepeek:<n>`.
export function isAppTask(task: TaskRow): boolean {
  return task.opaque_id !== null && task.opaque_id.startsWith("tablepeek:");
}

// The running tasks, longest-running first, without the tab's own status
// reads (stats, tasks, health, nodes, shards and their per-node children:
// app tasks whose action is `cluster:monitor…`). TablePeek's other requests
// stay and are marked by `isAppTask`. Without `children`, tasks whose
// parent is also listed are left out: a search's per-shard phases show as
// the one search.
export function taskRows(list: TaskRow[], children: boolean): TaskRow[] {
  const shown = list.filter((task) => !(isAppTask(task) && task.action.startsWith("cluster:monitor")));
  const ids = new Set(list.map((task) => task.id));
  return shown
    .filter((task) => children || task.parent_task_id === null || !ids.has(task.parent_task_id))
    .sort((a, b) => (b.running_time_ms ?? 0) - (a.running_time_ms ?? 0));
}

export type ShardState = "STARTED" | "UNASSIGNED" | "RELOCATING" | "INITIALIZING";

export interface ShardRow {
  index: string;
  shard: number;
  primary: boolean;
  // As `_cat/shards` gave it (one of ShardState on every current server).
  state: string;
  docs: number | null;
  // Bytes.
  store: number | null;
  ip: string;
  // For a relocating shard, `from -> ip id to` as the server writes it.
  node: string;
  // Why an unassigned shard is unassigned (`NODE_LEFT`, `INDEX_CREATED`, …).
  reason: string;
}

function cell(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return v === null || v === undefined ? "" : String(v);
}

function count(row: Record<string, unknown>, key: string): number | null {
  const text = cell(row, key);
  const n = text === "" ? NaN : Number(text);
  return Number.isFinite(n) ? n : null;
}

export function shardRow(row: Record<string, unknown>): ShardRow {
  const prirep = cell(row, "prirep");
  return {
    index: cell(row, "index"),
    shard: count(row, "shard") ?? 0,
    primary: prirep === "p" || prirep === "primary",
    state: cell(row, "state").toUpperCase(),
    docs: count(row, "docs"),
    store: count(row, "store"),
    ip: cell(row, "ip"),
    node: cell(row, "node"),
    reason: cell(row, "unassigned.reason"),
  };
}

export interface ShardGroup {
  index: string;
  shards: ShardRow[];
  primaries: number;
  replicas: number;
  // Shards per state.
  states: Record<string, number>;
  // Documents in the started primaries; bytes in every copy.
  docs: number;
  store: number;
  // red: a primary is unassigned; yellow: a replica is; moving: something
  // relocates or initializes; ok otherwise.
  health: "red" | "yellow" | "moving" | "ok";
}

// Shards grouped by index (names in order), each group's shards by number
// with the primary first. Groups with a problem come first.
export function shardGroups(rows: ShardRow[]): ShardGroup[] {
  const byIndex = new Map<string, ShardRow[]>();
  for (const row of rows) {
    const list = byIndex.get(row.index);
    if (list === undefined) byIndex.set(row.index, [row]);
    else list.push(row);
  }
  const rank = { red: 0, yellow: 1, moving: 2, ok: 3 };
  const groups: ShardGroup[] = [];
  for (const [index, shards] of byIndex) {
    shards.sort((a, b) => a.shard - b.shard || Number(b.primary) - Number(a.primary));
    const states: Record<string, number> = {};
    let docs = 0;
    let store = 0;
    let health: ShardGroup["health"] = "ok";
    for (const s of shards) {
      states[s.state] = (states[s.state] ?? 0) + 1;
      if (s.primary && s.state === "STARTED") docs += s.docs ?? 0;
      store += s.store ?? 0;
      if (s.state === "UNASSIGNED") {
        health = s.primary ? "red" : health === "red" ? "red" : "yellow";
      } else if (s.state !== "STARTED" && health === "ok") {
        health = "moving";
      }
    }
    const primaries = shards.filter((s) => s.primary).length;
    groups.push({ index, shards, primaries, replicas: shards.length - primaries, states, docs, store, health });
  }
  return groups.sort((a, b) => rank[a.health] - rank[b.health] || a.index.localeCompare(b.index));
}
