// The Profile API's reply (`profile: true` on a search) as typed trees with
// times in milliseconds: per shard the query tree (Lucene queries the DSL
// became), the rewrite time, the collectors, the aggregations and the fetch
// phase. Elasticsearch and OpenSearch give the same shape; times are
// nanoseconds there.

import { list, num, rec, str } from "./json";

// One timed step of a breakdown (`score`, `next_doc`, `build_aggregation`…)
// with how often it ran (`score_count`).
export interface BreakdownStep {
  key: string;
  ms: number;
  count: number | null;
}

// A query, aggregation or fetch sub-phase.
export interface ProfileNode {
  type: string;
  description: string;
  timeMs: number;
  // The time spent in this node itself, its children's time taken off.
  selfMs: number;
  breakdown: BreakdownStep[];
  debug: Record<string, unknown> | null;
  children: ProfileNode[];
}

export interface CollectorNode {
  name: string;
  reason: string;
  timeMs: number;
  children: CollectorNode[];
}

export interface ShardSearch {
  query: ProfileNode[];
  rewriteMs: number;
  collectors: CollectorNode[];
}

export interface ShardProfile {
  // `[node][index][shard]` as the server named it.
  id: string;
  node: string;
  index: string;
  shard: number | null;
  searches: ShardSearch[];
  aggregations: ProfileNode[];
  fetch: ProfileNode | null;
  // The query trees' time plus their rewrites: what the bars are a share of.
  queryMs: number;
  aggregationMs: number;
  fetchMs: number;
  // The node that spent the most time itself, among the query trees.
  slowest: ProfileNode | null;
}

const NS_PER_MS = 1_000_000;

function ms(ns: unknown): number {
  return (num(ns) ?? 0) / NS_PER_MS;
}

function breakdownOf(raw: unknown): BreakdownStep[] {
  const b = rec(raw);
  const out: BreakdownStep[] = [];
  for (const [key, value] of Object.entries(b)) {
    if (key.endsWith("_count") || typeof value !== "number") {
      continue;
    }
    const count = num(b[`${key}_count`]);
    out.push({ key, ms: value / NS_PER_MS, count });
  }
  return out.sort((a, b) => b.ms - a.ms);
}

function nodeOf(raw: unknown): ProfileNode {
  const r = rec(raw);
  const children = list(r.children).map(nodeOf);
  const timeMs = ms(r.time_in_nanos);
  const childMs = children.reduce((sum, c) => sum + c.timeMs, 0);
  const debug = r.debug !== undefined && r.debug !== null && typeof r.debug === "object" ? rec(r.debug) : null;
  return {
    type: str(r.type),
    description: str(r.description),
    timeMs,
    selfMs: Math.max(0, timeMs - childMs),
    breakdown: breakdownOf(r.breakdown),
    debug: debug !== null && Object.keys(debug).length > 0 ? debug : null,
    children,
  };
}

function collectorOf(raw: unknown): CollectorNode {
  const r = rec(raw);
  return { name: str(r.name), reason: str(r.reason), timeMs: ms(r.time_in_nanos), children: list(r.children).map(collectorOf) };
}

function walk(nodes: ProfileNode[], visit: (node: ProfileNode) => void): void {
  for (const node of nodes) {
    visit(node);
    walk(node.children, visit);
  }
}

const SHARD_ID = /^\[([^\]]*)\]\[([^\]]*)\]\[(\d+)\]$/;

function shardOf(raw: unknown): ShardProfile {
  const r = rec(raw);
  const id = str(r.id);
  const m = SHARD_ID.exec(id);
  const searches = list(r.searches).map((s): ShardSearch => {
    const search = rec(s);
    return { query: list(search.query).map(nodeOf), rewriteMs: ms(search.rewrite_time), collectors: list(search.collector).map(collectorOf) };
  });
  const aggregations = list(r.aggregations).map(nodeOf);
  const fetch = r.fetch !== undefined && r.fetch !== null ? nodeOf(r.fetch) : null;
  let slowest: ProfileNode | null = null;
  for (const search of searches) {
    walk(search.query, (node) => {
      if (slowest === null || node.selfMs > slowest.selfMs) {
        slowest = node;
      }
    });
  }
  return {
    id,
    node: str(r.node_id) || (m?.[1] ?? ""),
    index: str(r.index) || (m?.[2] ?? ""),
    shard: num(r.shard_id) ?? (m ? Number(m[3]) : null),
    searches,
    aggregations,
    fetch,
    queryMs: searches.reduce((sum, s) => sum + s.rewriteMs + s.query.reduce((t, q) => t + q.timeMs, 0), 0),
    aggregationMs: aggregations.reduce((sum, a) => sum + a.timeMs, 0),
    fetchMs: fetch?.timeMs ?? 0,
    slowest,
  };
}

// The shards of a profile reply (`profile` of the search response), slowest
// first.
export function parseProfile(profile: unknown): ShardProfile[] {
  return list(rec(profile).shards)
    .map(shardOf)
    .sort((a, b) => b.queryMs + b.aggregationMs + b.fetchMs - (a.queryMs + a.aggregationMs + a.fetchMs));
}

// A time as the panel prints it: three significant places below 10 ms.
export function msText(value: number): string {
  if (value === 0) {
    return "0 ms";
  }
  if (value < 0.001) {
    return "<0.001 ms";
  }
  return `${value < 10 ? value.toPrecision(3) : value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ms`;
}
