// Query DSL text: a tolerant JSON tokenizer (for colouring and for finding
// where the caret is), the mapping's field paths, and completion of the
// search body's keys and values from where the caret sits (inside
// `query.bool.filter[0].range`, the value of `"order"`, …). The Dev Tools
// console reuses it for request bodies.

import { t } from "../../i18n";
import { rec } from "./json";

export type TokenType = "str" | "num" | "word" | "punc" | "comment" | "bad";

export interface Token {
  type: TokenType;
  from: number;
  to: number;
  // Strings: the decoded text (without quotes); the rest: the source text.
  text: string;
  // A string still open at the end of the text (the caret is inside it).
  open?: boolean;
}

// JSON as Kibana's console accepts it: also `#` and `//` line comments,
// `/* */` blocks and """triple-quoted""" strings (scripts).
export function tokenizeJson(src: string, offset = 0, end = src.length): Token[] {
  const out: Token[] = [];
  let i = offset;
  while (i < end) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    const start = i;
    if (c === "#" || (c === "/" && src[i + 1] === "/")) {
      while (i < end && src[i] !== "\n") i++;
      out.push({ type: "comment", from: start, to: i, text: src.slice(start, i) });
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      i = close < 0 || close + 2 > end ? end : close + 2;
      out.push({ type: "comment", from: start, to: i, text: src.slice(start, i) });
      continue;
    }
    if (c === '"' && src.startsWith('"""', i)) {
      const close = src.indexOf('"""', i + 3);
      const stop = close < 0 || close + 3 > end ? end : close + 3;
      out.push({ type: "str", from: start, to: stop, text: src.slice(i + 3, close < 0 || close + 3 > end ? end : close), open: close < 0 || close + 3 > end });
      i = stop;
      continue;
    }
    if (c === '"') {
      let text = "";
      i++;
      let closed = false;
      while (i < end) {
        const d = src[i];
        if (d === "\\") {
          const e = src[i + 1];
          if (e === "u") {
            text += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16) || 0);
            i += 6;
          } else {
            text += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e === "b" ? "\b" : e === "f" ? "\f" : (e ?? "");
            i += 2;
          }
          continue;
        }
        if (d === '"') {
          i++;
          closed = true;
          break;
        }
        if (d === "\n") {
          break;
        }
        text += d;
        i++;
      }
      out.push({ type: "str", from: start, to: i, text, open: !closed });
      continue;
    }
    if ("{}[]:,".includes(c)) {
      out.push({ type: "punc", from: i, to: i + 1, text: c });
      i++;
      continue;
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i, Math.min(end, i + 64)));
      if (m !== null) {
        i += m[0].length;
        out.push({ type: "num", from: start, to: i, text: m[0] });
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(c)) {
      while (i < end && /[\w$.-]/.test(src[i])) i++;
      out.push({ type: "word", from: start, to: i, text: src.slice(start, i) });
      continue;
    }
    i++;
    out.push({ type: "bad", from: start, to: i, text: c });
  }
  return out;
}

// One step of the path from the body's root to the caret: an object's key,
// or `[]` for an array element.
export type PathStep = string;
export const ELEMENT = "[]";

export interface JsonCaret {
  // Containers around the caret, outermost first: the key each one is the
  // value of (`["query", "bool", "filter", "[]", "range"]`).
  path: PathStep[];
  // Typing an object key, or a value.
  at: "key" | "value";
  // The key whose value is being typed (at "value" in an object).
  key: string | null;
  // The word typed so far and where it starts (a string's text after its
  // opening quote, or a bare word).
  prefix: string;
  from: number;
  // The prefix sits inside a string (completion adds no quotes).
  quoted: boolean;
  // Keys already present in the object around the caret.
  siblings: string[];
}

interface Frame {
  kind: "object" | "array";
  // The key this container is the value of ([] inside an array).
  of: PathStep;
  keys: string[];
  // In an object: waiting for a key (after `{` or `,`) or a value (after `:`).
  expect: "key" | "value";
  key: string | null;
}

// Where the caret is inside the JSON text `src` (from `start`), or null when
// it is outside any object (before the first `{`).
export function jsonCaret(src: string, caret: number, start = 0): JsonCaret | null {
  const toks = tokenizeJson(src, start, caret);
  const stack: Frame[] = [];
  let lastKey: string | null = null;
  let last: Token | null = null;
  for (const tok of toks) {
    last = tok;
    if (tok.type === "comment") {
      continue;
    }
    const top = stack[stack.length - 1];
    if (tok.type === "punc") {
      switch (tok.text) {
        case "{":
        case "[": {
          const of = top === undefined ? "" : top.kind === "array" ? ELEMENT : (top.key ?? "");
          stack.push({ kind: tok.text === "{" ? "object" : "array", of, keys: [], expect: "key", key: null });
          break;
        }
        case "}":
        case "]":
          stack.pop();
          break;
        case ":":
          if (top?.kind === "object") {
            top.expect = "value";
            top.key = lastKey;
          }
          break;
        case ",":
          if (top?.kind === "object") {
            top.expect = "key";
            top.key = null;
          }
          break;
      }
      continue;
    }
    if (tok.type === "str" && top?.kind === "object" && top.expect === "key") {
      lastKey = tok.text;
      if (!tok.open) {
        top.keys.push(tok.text);
      }
    }
  }
  const top = stack[stack.length - 1];
  if (top === undefined) {
    return null;
  }
  // The word under the caret.
  let prefix = "";
  let from = caret;
  let quoted = false;
  if (last !== null && last.to === caret && (last.type === "str" || last.type === "word" || last.type === "num")) {
    if (last.type === "str") {
      if (last.open) {
        prefix = last.text;
        from = last.from + 1;
        quoted = true;
      }
    } else {
      prefix = last.text;
      from = last.from;
    }
  }
  if (last !== null && last.type === "str" && !last.open && last.to === caret) {
    // Just after a closed string: nothing to complete here.
    return null;
  }
  const path = stack.slice(1).map((f) => f.of);
  if (top.kind === "array") {
    return { path: [...path], at: "value", key: ELEMENT, prefix, from, quoted, siblings: [] };
  }
  const typingKey = top.expect === "key";
  return {
    path,
    at: typingKey ? "key" : "value",
    key: typingKey ? null : top.key,
    prefix,
    from,
    quoted,
    siblings: typingKey && quoted ? top.keys.filter((k) => k !== prefix) : top.keys,
  };
}

// ---- Mapping fields ----

export interface MappedField {
  // Dotted path as queries name it (`customer.name`, `title.keyword`).
  path: string;
  type: string;
  // A multi-field of another (`title.keyword` under `title`).
  multi: boolean;
}

// Field paths of a mapping (`{ properties: … }`, or the index → mappings
// reply around it), objects and nested included, multi-fields after their
// parent.
export function mappingFields(mapping: unknown): MappedField[] {
  let root = rec(mapping);
  if (root.properties === undefined) {
    const inner = Object.values(root)[0];
    const mappings = rec(rec(inner).mappings);
    if (mappings.properties !== undefined) {
      root = mappings;
    } else if (rec(root.mappings).properties !== undefined) {
      root = rec(root.mappings);
    }
  }
  const out: MappedField[] = [];
  const walk = (props: Record<string, unknown>, prefix: string) => {
    for (const [name, raw] of Object.entries(props)) {
      const def = rec(raw);
      const path = prefix === "" ? name : `${prefix}.${name}`;
      const type = typeof def.type === "string" ? def.type : def.properties !== undefined ? "object" : "object";
      out.push({ path, type, multi: false });
      for (const [sub, subRaw] of Object.entries(rec(def.fields))) {
        const subType = rec(subRaw).type;
        out.push({ path: `${path}.${sub}`, type: typeof subType === "string" ? subType : "keyword", multi: true });
      }
      if (def.properties !== undefined) {
        walk(rec(def.properties), path);
      }
    }
  };
  walk(rec(root.properties), "");
  return out;
}

const TEXTUAL = new Set(["text", "match_only_text", "search_as_you_type", "semantic_text"]);
const EXACT = new Set(["keyword", "constant_keyword", "wildcard", "ip", "version", "boolean"]);
const NUMERIC = new Set(["long", "integer", "short", "byte", "double", "float", "half_float", "scaled_float", "unsigned_long", "date", "date_nanos"]);

// ---- Completion ----

export type ItemKind = "field" | "keyword" | "query" | "agg" | "value" | "path" | "param" | "method" | "index";

export interface DslItem {
  label: string;
  kind: ItemKind;
  // Short text beside the label (a field's type, what a keyword does).
  detail?: string;
  // Inserted in place of the prefix; a key gets its quotes and `: ` from
  // `completeAt` (and a value template such as `{ }`).
  insert?: string;
  // Where the caret ends, counted back from the end of the insert.
  caretBack?: number;
}

export interface DslCompletion {
  from: number;
  to: number;
  // Typed inside a string: applying also swallows the string's closing quote
  // after the caret (the insert brings its own).
  quoted: boolean;
  items: DslItem[];
}

// What a key's value looks like, for the template inserted with it.
type Shape = "object" | "array" | "scalar" | "string" | "objectOrArray";

interface KeyDoc {
  doc: string;
  shape: Shape;
}

const k = (doc: string, shape: Shape = "object"): KeyDoc => ({ doc, shape });

export const BODY_KEYS: Record<string, KeyDoc> = {
  query: k("검색 조건 (점수를 매김)"),
  size: k("돌려줄 문서 수 (기본 10)", "scalar"),
  from: k("건너뛸 문서 수", "scalar"),
  sort: k("정렬 기준 필드", "array"),
  _source: k("돌려줄 _source 필드 (includes·excludes, false)", "objectOrArray"),
  aggs: k("집계"),
  highlight: k("일치한 부분 강조"),
  track_total_hits: k("전체 일치 수를 정확히 셈 (true 또는 상한)", "scalar"),
  search_after: k("이전 페이지 마지막 문서의 sort 값", "array"),
  pit: k("특정 시점(PIT) 검색: { id, keep_alive }"),
  post_filter: k("집계 뒤에 거르는 조건"),
  fields: k("가져올 필드 (런타임·doc values 포함)", "array"),
  docvalue_fields: k("doc values로 가져올 필드", "array"),
  stored_fields: k("저장된 필드", "array"),
  script_fields: k("스크립트로 계산한 필드"),
  runtime_mappings: k("이 검색에서만 쓰는 런타임 필드"),
  min_score: k("이 점수보다 낮은 문서 제외", "scalar"),
  collapse: k("필드 값마다 한 문서만"),
  rescore: k("상위 결과 다시 점수 매기기"),
  suggest: k("검색어 제안"),
  knn: k("벡터 근접 이웃 검색"),
  timeout: k("샤드마다 기다릴 시간 (예: \"2s\")", "string"),
  terminate_after: k("샤드마다 이만큼 모으면 멈춤", "scalar"),
  explain: k("점수 계산 설명 포함", "scalar"),
  profile: k("실행 프로파일 포함", "scalar"),
  version: k("문서 버전 포함", "scalar"),
  seq_no_primary_term: k("_seq_no·_primary_term 포함", "scalar"),
  indices_boost: k("인덱스별 점수 가중치", "array"),
};

// Query types with what each does and the template inserted with it.
export const QUERIES: Record<string, { doc: string; template: (field: string) => string }> = {
  match: { doc: "분석한 전문 검색", template: (f) => `{ "${f}": "" }` },
  match_phrase: { doc: "구절 그대로 일치", template: (f) => `{ "${f}": "" }` },
  match_phrase_prefix: { doc: "마지막 단어는 접두어로 구절 일치", template: (f) => `{ "${f}": "" }` },
  multi_match: { doc: "여러 필드에서 전문 검색", template: (f) => `{ "query": "", "fields": ["${f}"] }` },
  combined_fields: { doc: "여러 필드를 한 필드처럼 검색", template: (f) => `{ "query": "", "fields": ["${f}"] }` },
  query_string: { doc: "Lucene 문법 검색 (AND·OR·필드:값)", template: () => `{ "query": "" }` },
  simple_query_string: { doc: "오류를 내지 않는 간단한 문법 검색", template: () => `{ "query": "" }` },
  term: { doc: "분석하지 않은 정확한 값", template: (f) => `{ "${f}": "" }` },
  terms: { doc: "여러 정확한 값 중 하나", template: (f) => `{ "${f}": [] }` },
  terms_set: { doc: "목록 값 중 최소 개수 일치", template: (f) => `{ "${f}": { "terms": [] } }` },
  range: { doc: "범위 (gte·gt·lte·lt)", template: (f) => `{ "${f}": { "gte": "" } }` },
  exists: { doc: "필드에 값이 있음", template: (f) => `{ "field": "${f}" }` },
  prefix: { doc: "접두어 일치", template: (f) => `{ "${f}": "" }` },
  wildcard: { doc: "와일드카드 (* ?)", template: (f) => `{ "${f}": "" }` },
  regexp: { doc: "정규식", template: (f) => `{ "${f}": "" }` },
  fuzzy: { doc: "철자가 비슷한 값", template: (f) => `{ "${f}": "" }` },
  ids: { doc: "_id 목록", template: () => `{ "values": [] }` },
  bool: { doc: "조건 조합 (must·filter·should·must_not)", template: () => `{ "filter": [] }` },
  match_all: { doc: "모든 문서", template: () => "{}" },
  match_none: { doc: "아무 문서도 없음", template: () => "{}" },
  constant_score: { doc: "점수 없이 거르기", template: () => `{ "filter": {} }` },
  dis_max: { doc: "가장 높은 점수의 조건", template: () => `{ "queries": [] }` },
  boosting: { doc: "일치하면 점수를 깎음", template: () => `{ "positive": {}, "negative": {}, "negative_boost": 0.5 }` },
  function_score: { doc: "점수를 함수로 바꿈", template: () => `{ "query": {}, "functions": [] }` },
  nested: { doc: "nested 필드 안 문서 검색", template: (f) => `{ "path": "${f}", "query": {} }` },
  has_child: { doc: "자식 문서가 일치하는 부모", template: () => `{ "type": "", "query": {} }` },
  has_parent: { doc: "부모 문서가 일치하는 자식", template: () => `{ "parent_type": "", "query": {} }` },
  geo_distance: { doc: "지점에서 거리 안", template: (f) => `{ "distance": "10km", "${f}": { "lat": 0, "lon": 0 } }` },
  geo_bounding_box: { doc: "사각형 안", template: (f) => `{ "${f}": { "top_left": { "lat": 0, "lon": 0 }, "bottom_right": { "lat": 0, "lon": 0 } } }` },
  geo_shape: { doc: "도형과의 관계", template: (f) => `{ "${f}": { "shape": {}, "relation": "intersects" } }` },
  more_like_this: { doc: "비슷한 문서", template: (f) => `{ "fields": ["${f}"], "like": "" }` },
  script: { doc: "스크립트 조건", template: () => `{ "script": { "source": "" } }` },
  intervals: { doc: "단어 순서·간격 조건", template: (f) => `{ "${f}": { "match": { "query": "" } } }` },
  knn: { doc: "벡터 근접 이웃", template: (f) => `{ "field": "${f}", "query_vector": [], "k": 10 }` },
};

export const AGGS: Record<string, { doc: string; template: (field: string) => string }> = {
  terms: { doc: "값마다 버킷", template: (f) => `{ "field": "${f}", "size": 10 }` },
  date_histogram: { doc: "날짜 구간마다 버킷", template: (f) => `{ "field": "${f}", "calendar_interval": "month" }` },
  histogram: { doc: "수 구간마다 버킷", template: (f) => `{ "field": "${f}", "interval": 10 }` },
  range: { doc: "정한 범위마다 버킷", template: (f) => `{ "field": "${f}", "ranges": [{ "to": 100 }, { "from": 100 }] }` },
  date_range: { doc: "날짜 범위마다 버킷", template: (f) => `{ "field": "${f}", "ranges": [{ "to": "now-1M" }, { "from": "now-1M" }] }` },
  filter: { doc: "조건에 맞는 문서 버킷", template: () => `{ "term": {} }` },
  filters: { doc: "조건마다 버킷", template: () => `{ "filters": {} }` },
  missing: { doc: "값이 없는 문서", template: (f) => `{ "field": "${f}" }` },
  nested: { doc: "nested 문서로 들어감", template: (f) => `{ "path": "${f}" }` },
  composite: { doc: "여러 소스로 페이지 나눈 버킷", template: (f) => `{ "sources": [{ "${f}": { "terms": { "field": "${f}" } } }] }` },
  significant_terms: { doc: "특이하게 많은 값", template: (f) => `{ "field": "${f}" }` },
  top_hits: { doc: "버킷마다 상위 문서", template: () => `{ "size": 3 }` },
  avg: { doc: "평균", template: (f) => `{ "field": "${f}" }` },
  sum: { doc: "합계", template: (f) => `{ "field": "${f}" }` },
  min: { doc: "최솟값", template: (f) => `{ "field": "${f}" }` },
  max: { doc: "최댓값", template: (f) => `{ "field": "${f}" }` },
  value_count: { doc: "값 개수", template: (f) => `{ "field": "${f}" }` },
  cardinality: { doc: "서로 다른 값 수 (근사)", template: (f) => `{ "field": "${f}" }` },
  stats: { doc: "수·최소·최대·평균·합", template: (f) => `{ "field": "${f}" }` },
  extended_stats: { doc: "분산·표준편차 포함 통계", template: (f) => `{ "field": "${f}" }` },
  percentiles: { doc: "백분위수", template: (f) => `{ "field": "${f}", "percents": [50, 95, 99] }` },
  geo_bounds: { doc: "위치 값을 감싸는 사각형", template: (f) => `{ "field": "${f}" }` },
  scripted_metric: { doc: "스크립트 집계", template: () => `{ "map_script": "" }` },
};

// Keys inside a query type's object, by type; a field-keyed type's per-field
// object takes FIELD_OPTIONS.
const QUERY_KEYS: Record<string, string[]> = {
  bool: ["must", "filter", "should", "must_not", "minimum_should_match", "boost"],
  multi_match: ["query", "fields", "type", "operator", "fuzziness", "tie_breaker", "minimum_should_match", "analyzer", "boost"],
  combined_fields: ["query", "fields", "operator", "minimum_should_match"],
  query_string: ["query", "default_field", "fields", "default_operator", "analyze_wildcard", "lenient", "fuzziness", "boost"],
  simple_query_string: ["query", "fields", "default_operator", "flags", "analyze_wildcard", "lenient"],
  exists: ["field"],
  ids: ["values"],
  constant_score: ["filter", "boost"],
  dis_max: ["queries", "tie_breaker"],
  boosting: ["positive", "negative", "negative_boost"],
  function_score: ["query", "functions", "score_mode", "boost_mode", "max_boost", "min_score", "field_value_factor", "random_score", "script_score"],
  nested: ["path", "query", "score_mode", "ignore_unmapped", "inner_hits"],
  has_child: ["type", "query", "score_mode", "min_children", "max_children", "inner_hits"],
  has_parent: ["parent_type", "query", "score", "inner_hits"],
  geo_distance: ["distance", "distance_type", "validation_method"],
  more_like_this: ["fields", "like", "unlike", "min_term_freq", "max_query_terms", "min_doc_freq"],
  script: ["script"],
  knn: ["field", "query_vector", "k", "num_candidates", "filter", "similarity"],
};

const FIELD_OPTIONS: Record<string, string[]> = {
  match: ["query", "operator", "fuzziness", "analyzer", "minimum_should_match", "zero_terms_query", "lenient", "boost"],
  match_phrase: ["query", "slop", "analyzer", "boost"],
  match_phrase_prefix: ["query", "slop", "max_expansions", "analyzer"],
  term: ["value", "case_insensitive", "boost"],
  range: ["gte", "gt", "lte", "lt", "format", "time_zone", "relation", "boost"],
  prefix: ["value", "case_insensitive", "rewrite"],
  wildcard: ["value", "case_insensitive", "rewrite", "boost"],
  regexp: ["value", "flags", "case_insensitive", "max_determinized_states"],
  fuzzy: ["value", "fuzziness", "prefix_length", "max_expansions", "transpositions"],
};

const AGG_KEYS: Record<string, string[]> = {
  terms: ["field", "size", "order", "min_doc_count", "missing", "include", "exclude", "shard_size", "script"],
  date_histogram: ["field", "calendar_interval", "fixed_interval", "format", "time_zone", "min_doc_count", "extended_bounds", "order", "offset", "missing"],
  histogram: ["field", "interval", "min_doc_count", "extended_bounds", "offset", "order", "missing"],
  range: ["field", "ranges", "keyed", "script"],
  date_range: ["field", "ranges", "format", "time_zone", "keyed"],
  missing: ["field"],
  nested: ["path"],
  composite: ["sources", "size", "after"],
  significant_terms: ["field", "size", "min_doc_count", "background_filter"],
  top_hits: ["size", "sort", "_source", "from", "highlight"],
  avg: ["field", "missing", "script", "format"],
  sum: ["field", "missing", "script", "format"],
  min: ["field", "missing", "script", "format"],
  max: ["field", "missing", "script", "format"],
  value_count: ["field", "script"],
  cardinality: ["field", "precision_threshold", "missing"],
  stats: ["field", "missing", "script"],
  extended_stats: ["field", "sigma", "missing"],
  percentiles: ["field", "percents", "keyed", "missing"],
  geo_bounds: ["field", "wrap_longitude"],
};

// Values a key takes from a fixed set.
const ENUM_VALUES: Record<string, string[]> = {
  order: ["asc", "desc"],
  operator: ["and", "or"],
  default_operator: ["AND", "OR"],
  mode: ["min", "max", "sum", "avg", "median"],
  type: ["best_fields", "most_fields", "cross_fields", "phrase", "phrase_prefix", "bool_prefix"],
  zero_terms_query: ["none", "all"],
  relation: ["intersects", "contains", "within", "disjoint"],
  calendar_interval: ["minute", "hour", "day", "week", "month", "quarter", "year"],
  score_mode: ["multiply", "sum", "avg", "first", "max", "min", "none"],
  boost_mode: ["multiply", "replace", "sum", "avg", "max", "min"],
  fuzziness: ["AUTO", "0", "1", "2"],
  unmapped_type: ["keyword", "long", "date", "double", "boolean"],
  track_total_hits: ["true", "false"],
  explain: ["true", "false"],
  profile: ["true", "false"],
  version: ["true", "false"],
  seq_no_primary_term: ["true", "false"],
  keyed: ["true", "false"],
  case_insensitive: ["true", "false"],
};

const SORT_OPTIONS = ["order", "mode", "missing", "unmapped_type", "nested", "format", "numeric_type"];
const HIGHLIGHT_KEYS = ["fields", "pre_tags", "post_tags", "fragment_size", "number_of_fragments", "type", "require_field_match", "order", "encoder"];
const SOURCE_KEYS = ["includes", "excludes"];
const PIT_KEYS = ["id", "keep_alive"];
const COLLAPSE_KEYS = ["field", "inner_hits", "max_concurrent_group_searches"];

// Keys whose value is a query (or an array of queries).
const QUERY_SLOTS = new Set(["query", "filter", "must", "should", "must_not", "post_filter", "positive", "negative", "queries"]);
// Keys whose string value names a field.
const FIELD_VALUE_KEYS = new Set(["field", "fields", "default_field", "path", "includes", "excludes", "_source", "docvalue_fields", "stored_fields"]);

export interface DslContext {
  fields: MappedField[];
  // A request body whose root is not a search (`_doc`, `_mapping`, …) gets
  // only field and value completion.
  root?: "search" | "count" | "update_by_query" | "delete_by_query" | "none";
}

// The query type (and field) owning the caret's object, if the path ends
// inside a query slot: `[…, "query", "match", "title"]` → { type: "match", field: "title" }.
function queryOwner(path: PathStep[]): { depth: number; type: string | null; field: string | null } | null {
  // Walk from the deepest step up to the nearest query slot.
  for (let i = path.length - 1; i >= 0; i--) {
    const step = path[i];
    const isSlot = QUERY_SLOTS.has(step) && !(i > 0 && AGG_PARENTS.has(path[i - 1]));
    const isSlotElement = step === ELEMENT && i > 0 && QUERY_SLOTS.has(path[i - 1]);
    if (isSlot || isSlotElement) {
      const rest = path.slice(i + 1);
      return { depth: rest.length, type: rest[0] ?? null, field: rest[1] ?? null };
    }
  }
  return null;
}

const AGG_PARENTS = new Set(["aggs", "aggregations"]);

function fieldItems(fields: MappedField[], filter?: (f: MappedField) => boolean): DslItem[] {
  return fields.filter((f) => f.type !== "object" && (filter === undefined || filter(f))).map((f) => ({ label: f.path, kind: "field", detail: f.type }));
}

// Fields a query type works on best.
function fieldsFor(type: string | null, fields: MappedField[]): DslItem[] {
  if (type === "match" || type === "match_phrase" || type === "match_phrase_prefix" || type === "intervals") {
    return [...fieldItems(fields, (f) => TEXTUAL.has(f.type)), ...fieldItems(fields, (f) => !TEXTUAL.has(f.type))];
  }
  if (type === "term" || type === "terms" || type === "prefix" || type === "wildcard" || type === "regexp" || type === "fuzzy") {
    return [...fieldItems(fields, (f) => EXACT.has(f.type) || NUMERIC.has(f.type)), ...fieldItems(fields, (f) => !(EXACT.has(f.type) || NUMERIC.has(f.type)))];
  }
  if (type === "range") {
    return [...fieldItems(fields, (f) => NUMERIC.has(f.type) || f.type === "ip" || f.type === "keyword"), ...fieldItems(fields, (f) => !(NUMERIC.has(f.type) || f.type === "ip" || f.type === "keyword"))];
  }
  if (type === "nested") {
    return fields.filter((f) => f.type === "nested").map((f) => ({ label: f.path, kind: "field", detail: f.type }));
  }
  if (type?.startsWith("geo_")) {
    return fieldItems(fields, (f) => f.type.startsWith("geo_"));
  }
  return fieldItems(fields);
}

function keyItems(keys: string[], kind: ItemKind = "keyword", docs?: Record<string, KeyDoc>): DslItem[] {
  return keys.map((key) => ({ label: key, kind, detail: docs?.[key] ? t(docs[key].doc) : undefined }));
}

// The template a key's value starts with, by the key.
function valueTemplate(key: string, kind: ItemKind): string {
  if (kind === "field") {
    return "{ }";
  }
  const shape = BODY_KEYS[key]?.shape;
  if (shape === "array" || key === "must" || key === "should" || key === "must_not" || key === "queries" || key === "values" || key === "ranges" || key === "functions" || key === "pre_tags" || key === "post_tags" || key === "percents" || key === "sources" || key === "indices_boost") {
    return "[ ]";
  }
  if (shape === "scalar") {
    return "";
  }
  if (shape === "string" || key in ENUM_VALUES || ["field", "path", "query", "default_field", "analyzer", "format", "time_zone", "value", "type", "parent_type", "distance", "keep_alive", "id", "fixed_interval", "minimum_should_match", "rewrite", "flags", "include", "exclude", "like"].includes(key)) {
    return '""';
  }
  if (["size", "from", "boost", "slop", "min_doc_count", "interval", "shard_size", "precision_threshold", "k", "num_candidates", "tie_breaker", "negative_boost", "max_expansions", "prefix_length", "fragment_size", "number_of_fragments", "min_score", "max_boost", "gte", "gt", "lte", "lt", "missing", "sigma", "terminate_after"].includes(key)) {
    return "";
  }
  return "{ }";
}

// Completion for a search body (the 문서 tab's Query DSL editor, and request
// bodies in the console). Null when nothing fits.
export function completeDsl(src: string, caret: number, ctx: DslContext, start = 0): DslCompletion | null {
  const at = jsonCaret(src, caret, start);
  if (at === null) {
    return null;
  }
  const items = suggest(at, ctx);
  if (items.length === 0) {
    return null;
  }
  // Keys come with their quotes, colon and value template; values with
  // quotes when not typed inside a string.
  const shaped = items.map((item): DslItem => {
    if (item.insert !== undefined) {
      return item;
    }
    if (at.at === "key") {
      // A field under match/term/prefix/… takes the value right away
      // (`"status": ""`); under range, geo and the like an options object.
      const ownerType = queryOwner(at.path)?.type ?? null;
      const fieldTemplate = ownerType !== null && ownerType !== "range" && !ownerType.startsWith("geo_") && ownerType !== "terms" ? '""' : ownerType === "terms" ? "[ ]" : valueTemplate(item.label, item.kind);
      // `query` holds a query object, except as the text of a text query
      // (multi_match, query_string, …, a match field's options).
      const textQuery = ownerType !== null && (["multi_match", "query_string", "simple_query_string", "combined_fields"].includes(ownerType) || ownerType in FIELD_OPTIONS);
      const rootShape = at.path.length === 0 ? BODY_KEYS[item.label]?.shape : undefined;
      const keyTemplate =
        rootShape !== undefined
          ? rootShape === "array" ? "[ ]" : rootShape === "scalar" ? "" : rootShape === "string" ? '""' : "{ }"
          : item.label === "query" && !textQuery
            ? "{ }"
            : valueTemplate(item.label, item.kind);
      const template = item.kind === "query" ? QUERIES[item.label].template(ctx.fields.find((f) => f.type !== "object")?.path ?? "field") : item.kind === "agg" ? AGGS[item.label].template(ctx.fields.find((f) => f.type !== "object")?.path ?? "field") : item.kind === "field" ? fieldTemplate : keyTemplate;
      const head = at.quoted ? `${item.label}": ` : `"${item.label}": `;
      const body = template;
      // The caret goes inside the template's first quotes or brackets.
      const inner = /""|\{ \}|\[ \]|\{\}|\[\]/.exec(body);
      const insert = head + body;
      const caretBack = inner === null ? 0 : body.length - inner.index - (inner[0].length === 3 ? 2 : 1);
      return { ...item, insert, caretBack: inner === null ? 0 : caretBack };
    }
    if (item.kind === "value" && /^(?:true|false|null|-?\d)/.test(item.label) && !at.quoted) {
      return { ...item, insert: item.label };
    }
    return { ...item, insert: at.quoted ? `${item.label}"` : `"${item.label}"` };
  });
  const prefix = at.prefix.toLowerCase();
  const matched = shaped
    .map((item, index) => ({ item, index, pos: item.label.toLowerCase().indexOf(prefix) }))
    .filter((x) => prefix === "" || x.pos >= 0)
    .sort((a, b) => Number(a.pos !== 0) - Number(b.pos !== 0) || a.index - b.index)
    .map((x) => x.item);
  if (matched.length === 0) {
    return null;
  }
  return { from: at.from, to: caret, quoted: at.quoted, items: matched };
}

function suggest(at: JsonCaret, ctx: DslContext): DslItem[] {
  const { path } = at;
  const last = path[path.length - 1];
  const fields = ctx.fields;
  const notPresent = (items: DslItem[]) => items.filter((item) => !at.siblings.includes(item.label));

  if (at.at === "value") {
    const key = at.key ?? "";
    if (key === ELEMENT) {
      // Array elements: field names in field lists, sort entries.
      if (FIELD_VALUE_KEYS.has(last) || last === "sort") {
        return fieldItems(fields);
      }
      return [];
    }
    if (key in ENUM_VALUES) {
      return ENUM_VALUES[key].map((v) => ({ label: v, kind: "value" }));
    }
    if (FIELD_VALUE_KEYS.has(key)) {
      return key === "path" ? fields.filter((f) => f.type === "nested" || f.type === "object").map((f) => ({ label: f.path, kind: "field", detail: f.type })) : fieldItems(fields);
    }
    return [];
  }

  // Keys.
  if (path.length === 0) {
    if (ctx.root === "none") {
      return [];
    }
    const keys = ctx.root === "count" ? ["query"] : ctx.root === "delete_by_query" ? ["query", "max_docs", "slice"] : ctx.root === "update_by_query" ? ["query", "script", "max_docs", "slice"] : Object.keys(BODY_KEYS);
    return notPresent(keyItems(keys, "keyword", BODY_KEYS));
  }
  // Aggregations: `aggs` holds names (free), each name an agg type plus `aggs`.
  for (let i = path.length - 1; i >= 0; i--) {
    if (AGG_PARENTS.has(path[i])) {
      const rest = path.slice(i + 1);
      if (rest.length === 0) {
        return [];
      }
      if (rest.length === 1) {
        return notPresent([...Object.entries(AGGS).map(([name, a]): DslItem => ({ label: name, kind: "agg", detail: t(a.doc) })), { label: "aggs", kind: "keyword", detail: t("하위 집계") }, { label: "meta", kind: "keyword" }]);
      }
      if (rest.length === 2 && rest[1] in AGG_KEYS) {
        return notPresent(keyItems(AGG_KEYS[rest[1]]));
      }
      if (rest.length === 2 && rest[1] === "filter") {
        break;
      }
      if (rest.length >= 2 && !QUERY_SLOTS.has(rest[1])) {
        return [];
      }
      break;
    }
  }
  const owner = queryOwner(path);
  if (owner !== null) {
    if (owner.depth === 0) {
      return notPresent(Object.entries(QUERIES).map(([name, q]) => ({ label: name, kind: "query", detail: t(q.doc) })));
    }
    const type = owner.type ?? "";
    if (owner.depth === 1) {
      if (type in FIELD_OPTIONS || type === "terms" || type === "terms_set" || type === "intervals") {
        return notPresent([...fieldsFor(type, fields), ...(type === "terms" ? keyItems(["boost"]) : [])]);
      }
      if (type in QUERY_KEYS) {
        return notPresent(keyItems(QUERY_KEYS[type]));
      }
      if (type === "geo_bounding_box" || type === "geo_shape") {
        return notPresent(fieldsFor(type, fields));
      }
      return [];
    }
    if (owner.depth === 2 && type in FIELD_OPTIONS && owner.field !== null && path[path.length - 1] === owner.field) {
      return notPresent(keyItems(FIELD_OPTIONS[type]));
    }
    return [];
  }
  switch (last) {
    case "sort":
    case ELEMENT:
      if (last === "sort" || path[path.length - 2] === "sort") {
        return notPresent([...fieldItems(fields), { label: "_score", kind: "field", detail: t("점수") }, { label: "_doc", kind: "field", detail: t("색인 순서") }]);
      }
      return [];
    case "_source":
      return notPresent(keyItems(SOURCE_KEYS));
    case "highlight":
      return notPresent(keyItems(HIGHLIGHT_KEYS));
    case "fields":
      if (path[path.length - 2] === "highlight") {
        return notPresent(fieldItems(fields, (f) => TEXTUAL.has(f.type) || f.type === "keyword"));
      }
      return [];
    case "pit":
      return notPresent(keyItems(PIT_KEYS));
    case "collapse":
      return notPresent(keyItems(COLLAPSE_KEYS));
    case "runtime_mappings":
      return [];
  }
  // A sort entry's field: its options.
  if (path.length >= 2 && (path[path.length - 2] === "sort" || (path[path.length - 2] === ELEMENT && path[path.length - 3] === "sort"))) {
    return notPresent(keyItems(SORT_OPTIONS));
  }
  return [];
}
