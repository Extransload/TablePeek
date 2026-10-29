// The 성능 tab's arithmetic (MONGODB.md §6.2): per-second rates from two
// `serverStatus` samples, the five-minute window the charts show, axis
// steps, and the rows of `currentOp` and `top` replies. Plain data in and
// out; the tab draws it.

import { toNumber as numberOf, type PerfSample } from "./api";
import { isDocument, type BsonDocument, type BsonValue } from "./bson";

export const OP_KINDS = ["insert", "query", "update", "delete", "getmore", "command"] as const;
export type OpKind = (typeof OP_KINDS)[number];

// How long the charts look back, and the polling interval.
export const WINDOW_MS = 5 * 60_000;
export const POLL_MS = 2_000;
// A poll's requests are given up after this long, so a struggling server
// leaves a gap in the charts instead of stopping them.
export const POLL_TIMEOUT_MS = 8_000;
// Two samples further apart than this (the tab was hidden or paused) are
// not averaged into one rate; the lines break there instead. A poll that
// timed out breaks them too (the caller passes no previous sample).
const MAX_GAP_MS = 10_000;

export interface PerfPoint {
  time: number;
  // No line joins this point to the one before: the first sample, or the
  // first after a pause, a missed poll or a restart.
  gap: boolean;
  // Operations per second by type; null when `gap`.
  ops: Record<OpKind, number> | null;
  connections: number;
  // Bytes per second; null like `ops`.
  netIn: number | null;
  netOut: number | null;
  // Bytes.
  resident: number;
  cache: number | null;
  dirty: number | null;
}

// Counters are cumulative since the server started; a counter that went
// down (a restart, a wrap) gives no rate.
function rate(prev: number, cur: number, seconds: number): number | null {
  return cur >= prev ? (cur - prev) / seconds : null;
}

export function perfPoint(prev: PerfSample | null, cur: PerfSample): PerfPoint {
  const dt = prev === null ? 0 : cur.time - prev.time;
  const usable = prev !== null && dt > 0 && dt <= MAX_GAP_MS && cur.uptime >= prev.uptime;
  let ops: Record<OpKind, number> | null = null;
  if (usable) {
    const out = {} as Record<OpKind, number>;
    let ok = true;
    for (const kind of OP_KINDS) {
      const r = rate(prev.opcounters[kind], cur.opcounters[kind], dt / 1000);
      ok &&= r !== null;
      out[kind] = r ?? 0;
    }
    ops = ok ? out : null;
  }
  return {
    time: cur.time,
    gap: !usable,
    ops,
    connections: cur.connections.current,
    netIn: usable ? rate(prev.network.bytesIn, cur.network.bytesIn, dt / 1000) : null,
    netOut: usable ? rate(prev.network.bytesOut, cur.network.bytesOut, dt / 1000) : null,
    resident: cur.mem.resident * 1024 * 1024,
    cache: cur.wiredTiger?.cacheBytes ?? null,
    dirty: cur.wiredTiger?.dirtyBytes ?? null,
  };
}

// The points still inside the window ending at `point`, plus `point`.
export function appendPoint(points: PerfPoint[], point: PerfPoint): PerfPoint[] {
  const from = point.time - WINDOW_MS;
  return [...points.filter((p) => p.time >= from && p.time < point.time), point];
}

// A y axis from 0 to a round top above `max`, in about `count` steps of
// 1, 2 or 5 × 10ⁿ (or of 1024ⁿ multiples for bytes).
export function axisSteps(max: number, count: number, bytes = false): number[] {
  const target = Math.max(max, bytes ? 1024 : 1) / Math.max(1, count);
  let base = 1;
  if (bytes) {
    while (base * 1024 <= target) base *= 1024;
  } else {
    base = 10 ** Math.floor(Math.log10(target));
  }
  const step = [1, 2, 5, 10, 20, 50, 100, 200, 500].map((m) => m * base).find((s) => s >= target) ?? target;
  const top = Math.max(step, Math.ceil(Math.max(max, 0) / step) * step);
  const out: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) out.push(v);
  return out;
}

export interface RunningOp {
  // As the server gave it (a number, or "shard:n" text through mongos);
  // sent back unchanged to killOp.
  opid: BsonValue;
  op: string;
  ns: string;
  micros: number;
  client: string;
  appName: string;
  plan: string;
  desc: string;
  // The command or query being run, for its preview.
  command: BsonDocument | null;
}

function text(v: BsonValue | undefined): string {
  return typeof v === "string" ? v : "";
}

// The 성능 tab's own polls, as the app (appName "TablePeek") sends them.
const POLL_COMMANDS = ["serverStatus", "currentOp", "top"];

// The operations of a `currentOp` reply, longest-running first. Left out:
// the tab's own polls (serverStatus, currentOp, top and its reads of
// system.profile; the app's other queries stay; a mongos runs currentOp as
// a `$currentOp` aggregate, whose command it may truncate), the server's
// idle background threads (op "none") and drivers' awaitable `hello`s,
// which sit waiting for a topology change rather than doing work.
export function runningOps(reply: BsonDocument): RunningOp[] {
  const inprog = reply.get("inprog");
  const list = Array.isArray(inprog) ? inprog.filter(isDocument) : [];
  return list
    .filter((op) => {
      const command = op.get("command");
      const cmd: BsonDocument = isDocument(command) ? command : new Map();
      const waitingHello = (cmd.has("hello") || cmd.has("isMaster") || cmd.has("ismaster")) && cmd.has("topologyVersion");
      const pipeline = cmd.get("pipeline");
      const currentOpAggregate =
        (Array.isArray(pipeline) && isDocument(pipeline[0]) && pipeline[0].has("$currentOp")) ||
        text(cmd.get("$truncated")).startsWith("{ aggregate: 1, pipeline: [ { $currentOp");
      const ownPoll =
        op.get("appName") === "TablePeek" &&
        (POLL_COMMANDS.some((name) => cmd.has(name)) || cmd.get("find") === "system.profile" || currentOpAggregate);
      return op.get("op") !== "none" && !ownPoll && !waitingHello;
    })
    .map((op) => {
      const command = op.get("command");
      const query = op.get("query");
      const micros = op.get("microsecs_running");
      return {
        opid: op.get("opid") ?? null,
        op: text(op.get("op")),
        ns: text(op.get("ns")),
        micros: micros !== undefined ? numberOf(micros) : numberOf(op.get("secs_running")) * 1e6,
        client: text(op.get("client")) || text(op.get("client_s")),
        appName: text(op.get("appName")),
        plan: text(op.get("planSummary")),
        desc: text(op.get("desc")),
        command: isDocument(command) ? command : isDocument(query) ? query : null,
      };
    })
    .sort((a, b) => b.micros - a.micros);
}

export interface TopRow {
  ns: string;
  // Milliseconds and operation counts since the server started.
  totalMs: number;
  readMs: number;
  readCount: number;
  writeMs: number;
  writeCount: number;
  // Milliseconds spent since the previous reply; null without one.
  recentMs: number | null;
}

// The namespaces of a `top` reply that have seen any operation, busiest
// first. Times arrive in microseconds.
export function topRows(reply: BsonDocument, prev: TopRow[] | null): TopRow[] {
  const totals = reply.get("totals");
  const before = new Map((prev ?? []).map((row) => [row.ns, row.totalMs]));
  const rows: TopRow[] = [];
  if (!isDocument(totals)) return rows;
  for (const [ns, v] of totals) {
    if (!isDocument(v) || ns === "note") continue;
    const part = (key: string): BsonDocument => {
      const sub = v.get(key);
      return isDocument(sub) ? sub : new Map();
    };
    const total = part("total");
    if (numberOf(total.get("count")) === 0) continue;
    const totalMs = numberOf(total.get("time")) / 1000;
    const was = before.get(ns);
    rows.push({
      ns,
      totalMs,
      readMs: numberOf(part("readLock").get("time")) / 1000,
      readCount: numberOf(part("readLock").get("count")),
      writeMs: numberOf(part("writeLock").get("time")) / 1000,
      writeCount: numberOf(part("writeLock").get("count")),
      recentMs: prev === null ? null : Math.max(0, totalMs - (was ?? 0)),
    });
  }
  return rows.sort((a, b) => b.totalMs - a.totalMs);
}
