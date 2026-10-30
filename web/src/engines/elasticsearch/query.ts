// The 문서 tab's query bar as text (what the boxes hold, saved with the tab)
// and as the search it sends: a Lucene query string, a Query DSL `query`
// object, the sort and the `_source` filter.

import { t } from "../../i18n";
import { JsonSyntaxError, jsonObject, parseJson } from "../mongodb/bson";
import type { Json } from "./json";

export interface QueryText {
  // Lucene syntax (`status:paid AND total:>100`), sent as `query_string`.
  q: string;
  // A Query DSL `query` object (`{ "term": { "status": "paid" } }`).
  dsl: string;
  // `price:desc, _score`.
  sort: string;
  // `name, price, -internal.*`: fields to return (a leading `-` excludes).
  source: string;
}

export const EMPTY_QUERY: QueryText = { q: "", dsl: "", sort: "", source: "" };

export function normalizeQuery(text: Partial<QueryText> | undefined): QueryText {
  return { q: text?.q ?? "", dsl: text?.dsl ?? "", sort: text?.sort ?? "", source: text?.source ?? "" };
}

export interface BuiltQuery {
  // Null: every document.
  query: Json | null;
  sort: Json[] | null;
  source: Json | null;
  // The query string, for highlighting what matched.
  highlight: boolean;
}

export interface QueryError {
  key: keyof QueryText;
  message: string;
  from: number;
  to: number;
}

export type ParsedQuery = { ok: true; value: BuiltQuery } | { ok: false; error: QueryError };

// The sort box as a `sort` array: `field`, `field:asc|desc`, comma-separated.
export function parseSort(text: string): { ok: true; sort: Json[] | null } | { ok: false; error: QueryError } {
  const sort: Json[] = [];
  let at = 0;
  for (const part of text.split(",")) {
    const from = at + (part.length - part.trimStart().length);
    at += part.length + 1;
    const item = part.trim();
    if (item === "") {
      continue;
    }
    const m = /^([^\s:]+)(?:\s*:\s*(asc|desc))?$/i.exec(item);
    if (m === null) {
      return { ok: false, error: { key: "sort", message: t("정렬은 필드 또는 필드:asc / 필드:desc를 쉼표로 이어 씁니다"), from, to: from + item.length } };
    }
    sort.push(m[2] ? jsonObject([[m[1], jsonObject([["order", m[2].toLowerCase()]])]]) : m[1]);
  }
  return { ok: true, sort: sort.length > 0 ? sort : null };
}

// The fields box as a `_source` filter.
function parseSource(text: string): Json | null {
  const includes: string[] = [];
  const excludes: string[] = [];
  for (const part of text.split(",")) {
    const item = part.trim();
    if (item.startsWith("-") && item.length > 1) {
      excludes.push(item.slice(1).trim());
    } else if (item !== "") {
      includes.push(item);
    }
  }
  if (includes.length === 0 && excludes.length === 0) {
    return null;
  }
  return excludes.length === 0 ? includes : jsonObject<Json>([["includes", includes], ["excludes", excludes]]);
}

export function parseQuery(text: QueryText): ParsedQuery {
  let dsl: Json | null = null;
  if (text.dsl.trim() !== "") {
    try {
      dsl = parseJson(text.dsl, { bigints: true }) as Json;
    } catch (error) {
      const at = error instanceof JsonSyntaxError ? error.offset : 0;
      return { ok: false, error: { key: "dsl", message: error instanceof Error ? error.message : String(error), from: at, to: at + 1 } };
    }
    if (dsl === null || typeof dsl !== "object" || Array.isArray(dsl)) {
      return { ok: false, error: { key: "dsl", message: t("Query DSL은 { \"match\": … } 같은 객체여야 합니다"), from: 0, to: text.dsl.length } };
    }
  }
  const q = text.q.trim();
  const queryString: Json | null = q === "" ? null : jsonObject([["query_string", jsonObject<Json>([["query", q], ["lenient", true]])]]);
  let query: Json | null = queryString ?? dsl;
  if (queryString !== null && dsl !== null) {
    query = jsonObject([["bool", jsonObject([["must", [queryString, dsl]]])]]);
  }
  const sort = parseSort(text.sort);
  if (!sort.ok) {
    return sort;
  }
  return { ok: true, value: { query, sort: sort.sort, source: parseSource(text.source), highlight: q !== "" } };
}

// The search body the query bar stands for (the 실행 계획 tab profiles it).
export function searchBody(query: BuiltQuery): Json {
  const entries: [string, Json][] = [];
  if (query.query !== null) entries.push(["query", query.query]);
  if (query.sort !== null) entries.push(["sort", query.sort]);
  if (query.source !== null) entries.push(["_source", query.source]);
  return jsonObject(entries);
}

// Saved and recent queries per index, newest first (localStorage).
const RECENT_KEY = "tablepeek.es.recentQueries";
const RECENT_MAX = 20;

export function recentQueries(index: string): QueryText[] {
  try {
    const all = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "{}") as Record<string, Partial<QueryText>[]>;
    return Array.isArray(all[index]) ? all[index].map(normalizeQuery) : [];
  } catch {
    return [];
  }
}

export function recordQuery(index: string, text: QueryText): void {
  if (text.q.trim() === "" && text.dsl.trim() === "" && text.sort.trim() === "" && text.source.trim() === "") {
    return;
  }
  try {
    const all = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "{}") as Record<string, QueryText[]>;
    const same = (a: QueryText) => a.q === text.q && a.dsl === text.dsl && a.sort === text.sort && a.source === text.source;
    all[index] = [text, ...(Array.isArray(all[index]) ? all[index].filter((a) => !same(normalizeQuery(a))) : [])].slice(0, RECENT_MAX);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(all));
  } catch {
    // Storage full or off: the recent list is a convenience.
  }
}
