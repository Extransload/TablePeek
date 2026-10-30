// The Dev Tools console's text (docs/engines/elasticsearch.md §4.6): requests
// written as Kibana writes them, a `METHOD /path?query` line followed by an
// optional JSON body (NDJSON lines for `_bulk` and `_msearch`), with `#` and
// `//` comments around them and """triple-quoted""" strings in bodies. Here:
// splitting the text into requests with their ranges, the request under the
// caret, auto-indent, cURL text, and completion of methods, paths, query
// parameters and bodies.

import { t } from "../../i18n";
import { jsonObject, stringifyJson } from "../mongodb/bson";
import { ELEMENT, completeDsl, jsonCaret, tokenizeJson, type DslCompletion, type DslContext, type DslItem, type ItemKind, type JsonCaret, type MappedField, type Token } from "./dsl";
import { rec, type Json } from "./json";

// ---- Requests ----

export const CONSOLE_METHODS = ["GET", "POST", "PUT", "DELETE", "HEAD"];

export interface ConsoleParseError {
  message: string;
  from: number;
  to: number;
}

export interface ConsoleRequest {
  // From the method line's start to the body's end.
  from: number;
  to: number;
  // Where the next request starts (blank and comment lines after the body
  // still count as this request for the caret).
  end: number;
  // The method line (1-based) and where it ends.
  line: number;
  headEnd: number;
  method: string;
  // With its leading `/` and the query string as written.
  path: string;
  pathFrom: number;
  pathTo: number;
  // Equal (at `headEnd`) without a body.
  bodyFrom: number;
  bodyTo: number;
  // `_bulk` / `_msearch`: the body is NDJSON, one value per line.
  ndjson: boolean;
  // The body as sent: JSON, an NDJSON string, or undefined without one (or
  // when it does not parse).
  body: Json | string | undefined;
  // The NDJSON body's values in order (the bulk `delete` check).
  values: Json[];
  error: ConsoleParseError | null;
}

const METHOD_LINE = /^(GET|HEAD|POST|PUT|DELETE|PATCH)(?=\s|$)/i;
const COMMENT_LINE = /^\s*(#|\/\/)/;

// `_bulk` and `_msearch` (with or without an index, `_msearch/template`)
// take NDJSON.
export function isNdjsonPath(path: string): boolean {
  return /(^|\/)(_bulk|_msearch)(\/|$)/.test(path.split("?")[0]);
}

// The index part and the rest of a path: `/shop/_doc/1` → shop, [_doc, 1];
// `/_cat/indices` → null, [_cat, indices].
export function endpointOf(path: string): { index: string | null; rest: string[] } {
  const segs = path.split("?")[0].split("/").filter((s) => s !== "");
  if (segs.length > 0 && (!segs[0].startsWith("_") || segs[0] === "_all")) {
    return { index: segs[0], rest: segs.slice(1) };
  }
  return { index: null, rest: segs };
}

// What an endpoint is for parameters and bodies: `_search`, `_cat`,
// `_cluster/health`, `_doc` (also `_create`, `_source`), `` for the index
// itself.
function familyOf(rest: string[]): string {
  const [a = "", b = ""] = rest;
  if (["_cluster", "_nodes", "_search", "_validate", "_sql", "_ilm", "_security", "_plugins"].includes(a)) {
    return b !== "" ? `${a}/${b}` : a;
  }
  if (a === "_doc" || a === "_create" || a === "_source") {
    return "_doc";
  }
  return a;
}

class BodyError {
  constructor(
    readonly message: string,
    readonly from: number,
    readonly to: number,
  ) {}
}

// JSON values read from console tokens: comments skipped, triple-quoted
// strings as strings, a trailing comma forgiven, object keys in their order.
class BodyReader {
  private readonly toks: Token[];
  private i = 0;

  constructor(
    src: string,
    from: number,
    private readonly end: number,
  ) {
    this.toks = tokenizeJson(src, from, end).filter((tok) => tok.type !== "comment");
  }

  more(): boolean {
    return this.i < this.toks.length;
  }

  peek(): Token | undefined {
    return this.toks[this.i];
  }

  private fail(message: string, tok: Token | undefined): never {
    const at = tok?.from ?? Math.max(0, this.end - 1);
    throw new BodyError(message, at, tok === undefined ? this.end : Math.max(tok.to, at + 1));
  }

  private isPunc(tok: Token | undefined, text: string): boolean {
    return tok?.type === "punc" && tok.text === text;
  }

  value(): Json {
    const tok = this.toks[this.i++];
    if (tok === undefined) {
      return this.fail(t("값이 와야 하는데 본문이 끝났습니다"), undefined);
    }
    switch (tok.type) {
      case "str":
        if (tok.open) {
          return this.fail(t("닫히지 않은 문자열입니다"), tok);
        }
        return tok.text;
      case "num": {
        // A whole number past 2^53 goes out exactly as written.
        const n = Number(tok.text);
        return Number.isSafeInteger(n) || !/^-?\d+$/.test(tok.text) ? n : BigInt(tok.text);
      }
      case "word":
        if (tok.text === "true" || tok.text === "false") {
          return tok.text === "true";
        }
        if (tok.text === "null") {
          return null;
        }
        return this.fail(t("알 수 없는 값입니다: {text}", { text: tok.text }), tok);
      case "punc":
        if (tok.text === "{") {
          return this.object();
        }
        if (tok.text === "[") {
          return this.array();
        }
        break;
    }
    return this.fail(t("여기에 올 수 없는 글자입니다: {text}", { text: tok.text }), tok);
  }

  private object(): Json {
    const entries: [string, Json][] = [];
    for (;;) {
      const key = this.toks[this.i++];
      if (this.isPunc(key, "}")) {
        return jsonObject(entries);
      }
      if (key === undefined) {
        return this.fail(t("'}'로 닫히지 않았습니다"), undefined);
      }
      if (key.type !== "str" || key.open) {
        return this.fail(key.type === "str" ? t("닫히지 않은 문자열입니다") : t("키는 큰따옴표로 감싸야 합니다"), key);
      }
      const colon = this.toks[this.i++];
      if (!this.isPunc(colon, ":")) {
        return this.fail(t("키 뒤에 ':'가 와야 합니다"), colon);
      }
      entries.push([key.text, this.value()]);
      const next = this.toks[this.i++];
      if (this.isPunc(next, "}")) {
        return jsonObject(entries);
      }
      if (!this.isPunc(next, ",")) {
        return this.fail(t("',' 또는 '}'가 와야 합니다"), next);
      }
    }
  }

  private array(): Json {
    const items: Json[] = [];
    for (;;) {
      if (this.isPunc(this.peek(), "]")) {
        this.i++;
        return items;
      }
      items.push(this.value());
      const next = this.toks[this.i++];
      if (this.isPunc(next, "]")) {
        return items;
      }
      if (!this.isPunc(next, ",")) {
        return this.fail(t("',' 또는 ']'가 와야 합니다"), next);
      }
    }
  }
}

interface Line {
  from: number;
  to: number;
  text: string;
  // Starts inside a triple-quoted string (a script running over lines).
  inTriple: boolean;
}

function splitLines(src: string): Line[] {
  const lines: Line[] = [];
  let at = 0;
  let inTriple = false;
  for (;;) {
    const nl = src.indexOf("\n", at);
    const to = nl < 0 ? src.length : nl;
    const text = src.slice(at, to);
    lines.push({ from: at, to, text, inTriple });
    if (inTriple || !COMMENT_LINE.test(text)) {
      const quotes = text.split('"""').length - 1;
      if (quotes % 2 === 1) {
        inTriple = !inTriple;
      }
    }
    if (nl < 0) {
      return lines;
    }
    at = nl + 1;
  }
}

// The requests of the console text, in order. Text before the first
// method line (comments) belongs to none.
export function parseConsole(src: string): ConsoleRequest[] {
  const lines = splitLines(src);
  const heads: number[] = [];
  lines.forEach((line, i) => {
    if (!line.inTriple && METHOD_LINE.test(line.text)) {
      heads.push(i);
    }
  });
  return heads.map((head, n) => {
    const next = heads[n + 1] ?? lines.length;
    const line = lines[head];
    const method = METHOD_LINE.exec(line.text)![1];
    const after = line.text.slice(method.length);
    const gap = /^\s*/.exec(after)![0].length;
    const rawPath = /^\S*/.exec(after.slice(gap))![0];
    const tail = after.slice(gap + rawPath.length).trim();
    const pathFrom = line.from + method.length + gap;
    let error: ConsoleParseError | null = null;
    if (method.toUpperCase() === "PATCH") {
      error = { message: t("{method} 메서드는 보낼 수 없습니다 (GET·HEAD·POST·PUT·DELETE)", { method: "PATCH" }), from: line.from, to: line.from + method.length };
    } else if (rawPath === "") {
      error = { message: t("요청 줄에 경로가 없습니다"), from: line.from, to: line.to };
    } else if (tail !== "" && !tail.startsWith("#") && !tail.startsWith("//")) {
      const at = line.text.indexOf(tail, method.length + gap + rawPath.length);
      error = { message: t("경로 뒤에는 주석만 쓸 수 있습니다 (공백은 %20으로)"), from: line.from + at, to: line.to };
    }
    // The body: from the first line that is not blank or a comment to the
    // last such line before the next request.
    let first = -1;
    let last = -1;
    for (let i = head + 1; i < next; i++) {
      const l = lines[i];
      if (l.inTriple || (l.text.trim() !== "" && !COMMENT_LINE.test(l.text))) {
        if (first < 0) {
          first = i;
        }
        last = i;
      }
    }
    const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    const ndjson = isNdjsonPath(path);
    const bodyFrom = first < 0 ? line.to : lines[first].from;
    const bodyTo = first < 0 ? line.to : lines[last].to;
    const req: ConsoleRequest = {
      from: line.from,
      to: bodyTo,
      end: next < lines.length ? lines[next].from - 1 : src.length,
      line: head + 1,
      headEnd: line.to,
      method: method.toUpperCase(),
      path,
      pathFrom,
      pathTo: pathFrom + rawPath.length,
      bodyFrom,
      bodyTo,
      ndjson,
      body: undefined,
      values: [],
      error,
    };
    if (first >= 0 && error === null) {
      try {
        const reader = new BodyReader(src, bodyFrom, bodyTo);
        if (ndjson) {
          while (reader.more()) {
            req.values.push(reader.value());
          }
          req.body = req.values.length === 0 ? undefined : `${req.values.map((v) => stringifyJson(v)).join("\n")}\n`;
        } else if (reader.more()) {
          req.body = reader.value();
          const extra = reader.peek();
          if (extra !== undefined) {
            throw new BodyError(t("본문에는 JSON 값 하나만 씁니다 (여러 줄 NDJSON은 _bulk·_msearch만)"), extra.from, extra.to);
          }
        }
      } catch (e) {
        if (!(e instanceof BodyError)) {
          throw e;
        }
        req.body = undefined;
        req.error = { message: e.message, from: e.from, to: e.to };
      }
    }
    return req;
  });
}

// The request the caret is in (or after, up to the next one).
export function requestAt(src: string, caret: number): ConsoleRequest | null {
  return parseConsole(src).find((r) => r.from <= caret && caret <= r.end) ?? null;
}

// The requests a selection touches (the one under the caret when empty).
export function requestsIn(src: string, from: number, to: number): ConsoleRequest[] {
  const all = parseConsole(src);
  if (from === to) {
    const one = all.find((r) => r.from <= from && from <= r.end);
    return one === undefined ? [] : [one];
  }
  return all.filter((r) => r.from < to && r.end >= from);
}

// `GET /shop/_search`
export function requestLine(req: { method: string; path: string }): string {
  return `${req.method} ${req.path}`;
}

// A `_bulk` body with a `delete` action (danger, like the server counts it).
export function bulkDeletes(req: ConsoleRequest): boolean {
  if (!/(^|\/)_bulk(\/|$)/.test(req.path.split("?")[0])) {
    return false;
  }
  let expectAction = true;
  for (const value of req.values) {
    if (!expectAction) {
      expectAction = true;
      continue;
    }
    const action = Object.keys(rec(value))[0];
    if (action === "delete") {
      return true;
    }
    expectAction = !(action === "index" || action === "create" || action === "update");
  }
  return false;
}

// ---- Auto-indent and cURL ----

// Body tokens laid out again: two-space indents with comments and
// triple-quoted strings kept, or for NDJSON one compact value per line
// (comments inside a value dropped, triple quotes as JSON strings).
function layout(src: string, toks: Token[], compact: boolean): string {
  let out = "";
  let depth = 0;
  let pending = false;
  const put = (s: string) => {
    if (pending && out !== "") {
      out += `\n${compact ? "" : "  ".repeat(depth)}`;
    }
    pending = false;
    out += s;
  };
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    const raw = src.slice(tok.from, tok.to);
    if (tok.type === "comment") {
      if (compact && depth > 0) {
        continue;
      }
      const lineComment = !raw.startsWith("/*");
      // A comma after a line comment goes before it.
      const next = toks[i + 1];
      if (lineComment && next?.type === "punc" && next.text === ",") {
        put(",");
        i++;
      }
      put(pending || out === "" ? raw : ` ${raw}`);
      pending = lineComment || depth === 0;
      continue;
    }
    if (tok.type === "punc") {
      if (tok.text === "{" || tok.text === "[") {
        const close = tok.text === "{" ? "}" : "]";
        const next = toks[i + 1];
        if (next?.type === "punc" && next.text === close) {
          put(raw + close);
          i++;
          pending = depth === 0;
          continue;
        }
        put(raw);
        depth++;
        pending = !compact;
        continue;
      }
      if (tok.text === "}" || tok.text === "]") {
        depth = Math.max(0, depth - 1);
        pending = pending || !compact;
        put(raw);
        pending = depth === 0;
        continue;
      }
      if (tok.text === ",") {
        put(",");
        pending = !compact || depth === 0;
        continue;
      }
      if (tok.text === ":") {
        put(compact ? ":" : ": ");
        continue;
      }
    }
    put(tok.type === "str" && compact && src.startsWith('"""', tok.from) ? JSON.stringify(tok.text) : raw);
    pending = depth === 0;
  }
  return out;
}

// The request's body auto-indented, or null without a body. Throws nothing;
// callers check `req.error` first.
export function formatBody(src: string, req: ConsoleRequest): { from: number; to: number; text: string } | null {
  if (req.bodyFrom === req.bodyTo) {
    return null;
  }
  const toks = tokenizeJson(src, req.bodyFrom, req.bodyTo);
  return { from: req.bodyFrom, to: req.bodyTo, text: layout(src, toks, req.ndjson) };
}

const shellSingle = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// The request as a cURL command against `$ES_URL` (no credentials).
export function curlCommand(req: ConsoleRequest): string {
  // The path inside double quotes: backslash, quote, `$` and backtick escaped.
  const quotedPath = req.path.replace(/[\\"$`]/g, "\\$&");
  const url = `"$ES_URL${quotedPath}"`;
  if (req.method === "HEAD") {
    return `curl -I ${url}`;
  }
  let cmd = `curl -X ${req.method} ${url}`;
  if (req.body !== undefined) {
    cmd +=
      typeof req.body === "string"
        ? ` -H 'Content-Type: application/x-ndjson' --data-binary ${shellSingle(req.body)}`
        : ` -H 'Content-Type: application/json' -d ${shellSingle(stringifyJson(req.body, 2))}`;
  }
  return cmd;
}

// ---- Completion: paths ----

interface PathSpec {
  label: string;
  doc: string;
}

const p = (label: string, doc: string): PathSpec => ({ label, doc });

const TOP_PATHS: PathSpec[] = [
  p("_search", "모든 인덱스 검색"),
  p("_msearch", "여러 검색을 한 번에 (NDJSON)"),
  p("_count", "문서 수"),
  p("_mapping", "매핑"),
  p("_settings", "인덱스 설정"),
  p("_aliases", "별칭 목록·바꾸기"),
  p("_alias", "별칭 보기"),
  p("_cat/indices?v", "인덱스 목록 (표)"),
  p("_cat/", "_cat 표 API"),
  p("_cluster/health", "클러스터 상태"),
  p("_cluster/settings", "클러스터 설정"),
  p("_cluster/stats", "클러스터 통계"),
  p("_cluster/", "클러스터 API"),
  p("_nodes/stats", "노드 통계"),
  p("_nodes", "노드 정보"),
  p("_nodes/hot_threads", "바쁜 스레드"),
  p("_tasks", "실행 중인 작업"),
  p("_bulk", "여러 문서 쓰기 (NDJSON)"),
  p("_mget", "여러 문서 읽기"),
  p("_reindex", "다른 인덱스로 복사"),
  p("_analyze", "분석기 시험"),
  p("_sql", "SQL 실행 (Elasticsearch)"),
  p("_sql/translate", "SQL을 Query DSL로"),
  p("_plugins/_sql", "SQL 실행 (OpenSearch)"),
  p("_plugins/_ppl", "PPL 실행 (OpenSearch)"),
  p("_query", "ES|QL 실행"),
  p("_pit", "PIT 닫기"),
  p("_search/scroll", "다음 스크롤 페이지·스크롤 닫기"),
  p("_search/point_in_time", "PIT 닫기 (OpenSearch)"),
  p("_field_caps", "필드 기능"),
  p("_validate/query", "쿼리 검사"),
  p("_stats", "인덱스 통계"),
  p("_refresh", "새로 고침 (검색에 보이게)"),
  p("_flush", "디스크에 기록"),
  p("_forcemerge", "세그먼트 합치기"),
  p("_data_stream", "데이터 스트림"),
  p("_index_template", "인덱스 템플릿"),
  p("_component_template", "구성 요소 템플릿"),
  p("_ingest/pipeline", "수집 파이프라인"),
  p("_ilm/policy", "ILM 정책"),
  p("_ilm/status", "ILM 상태"),
  p("_snapshot", "스냅숏 저장소"),
  p("_scripts", "저장된 스크립트"),
  p("_resolve/index", "이름이 가리키는 인덱스"),
  p("_security/_authenticate", "지금 사용자"),
  p("_security/user", "사용자"),
  p("_security/role", "역할"),
  p("_security/role_mapping", "역할 매핑"),
  p("_security/api_key", "API 키"),
  p("_plugins/_security/api/internalusers", "사용자 (OpenSearch)"),
  p("_plugins/_security/api/roles", "역할 (OpenSearch)"),
  p("_plugins/_ism/policies", "ISM 정책 (OpenSearch)"),
  p("_license", "라이선스"),
];

const INDEX_PATHS: PathSpec[] = [
  p("_search", "검색"),
  p("_count", "문서 수"),
  p("_doc/", "문서 넣기·읽기·지우기 (_doc/<id>)"),
  p("_create/", "새 문서 넣기 (있으면 실패)"),
  p("_update/", "문서 일부 바꾸기"),
  p("_source/", "문서 _source만"),
  p("_mapping", "매핑"),
  p("_settings", "설정"),
  p("_bulk", "여러 문서 쓰기 (NDJSON)"),
  p("_msearch", "여러 검색을 한 번에 (NDJSON)"),
  p("_mget", "여러 문서 읽기"),
  p("_delete_by_query", "쿼리에 맞는 문서 지우기"),
  p("_update_by_query", "쿼리에 맞는 문서 바꾸기"),
  p("_explain/", "문서 점수 설명 (_explain/<id>)"),
  p("_validate/query", "쿼리 검사"),
  p("_analyze", "분석기 시험"),
  p("_field_caps", "필드 기능"),
  p("_termvectors/", "용어 벡터"),
  p("_stats", "인덱스 통계"),
  p("_segments", "세그먼트"),
  p("_recovery", "복구 상태"),
  p("_refresh", "새로 고침 (검색에 보이게)"),
  p("_flush", "디스크에 기록"),
  p("_forcemerge", "세그먼트 합치기"),
  p("_cache/clear", "캐시 비우기"),
  p("_open", "인덱스 열기"),
  p("_close", "인덱스 닫기"),
  p("_block/write", "쓰기 막기"),
  p("_alias/", "별칭"),
  p("_aliases", "별칭 목록"),
  p("_pit", "PIT 열기 (Elasticsearch)"),
  p("_search/point_in_time", "PIT 열기 (OpenSearch)"),
  p("_rollover", "새 인덱스로 넘기기"),
  p("_shrink/", "샤드 줄인 복사본"),
  p("_split/", "샤드 늘린 복사본"),
  p("_clone/", "복사본"),
  p("_ilm/explain", "ILM 단계"),
];

const SUB_PATHS: Record<string, PathSpec[]> = {
  _cat: [
    p("indices", "인덱스"),
    p("aliases", "별칭"),
    p("nodes", "노드"),
    p("shards", "샤드"),
    p("health", "클러스터 상태"),
    p("count", "문서 수"),
    p("allocation", "노드별 디스크"),
    p("thread_pool", "스레드 풀"),
    p("segments", "세그먼트"),
    p("recovery", "복구"),
    p("tasks", "작업"),
    p("templates", "템플릿"),
    p("plugins", "플러그인"),
    p("master", "마스터 노드"),
    p("pending_tasks", "대기 중인 클러스터 작업"),
    p("fielddata", "fielddata 메모리"),
    p("nodeattrs", "노드 속성"),
    p("repositories", "스냅숏 저장소"),
    p("snapshots", "스냅숏"),
  ],
  _cluster: [
    p("health", "클러스터 상태"),
    p("settings", "클러스터 설정"),
    p("stats", "클러스터 통계"),
    p("state", "클러스터 상태 전체"),
    p("pending_tasks", "대기 중인 클러스터 작업"),
    p("allocation/explain", "샤드가 그 자리에 있는 이유"),
    p("reroute", "샤드 옮기기"),
  ],
  _nodes: [p("stats", "노드 통계"), p("hot_threads", "바쁜 스레드"), p("usage", "API 사용량"), p("_local", "이 노드"), p("reload_secure_settings", "보안 설정 다시 읽기")],
  _search: [p("scroll", "다음 스크롤 페이지"), p("template", "템플릿 검색"), p("point_in_time", "PIT 닫기 (OpenSearch)")],
  _sql: [p("translate", "SQL을 Query DSL로"), p("close", "커서 닫기")],
  _validate: [p("query", "쿼리 검사")],
  _ilm: [p("policy", "ILM 정책"), p("status", "ILM 상태"), p("start", "ILM 시작"), p("stop", "ILM 멈춤")],
  _ingest: [p("pipeline", "수집 파이프라인"), p("pipeline/_simulate", "파이프라인 시험")],
  _resolve: [p("index", "이름이 가리키는 인덱스")],
  _security: [p("_authenticate", "지금 사용자"), p("user", "사용자"), p("role", "역할"), p("role_mapping", "역할 매핑"), p("api_key", "API 키"), p("privilege", "권한")],
  _plugins: [p("_sql", "SQL 실행"), p("_ppl", "PPL 실행"), p("_security/api/internalusers", "사용자"), p("_security/api/roles", "역할"), p("_security/authinfo", "지금 사용자"), p("_ism/policies", "ISM 정책")],
};

// Index-level second segments followed by names or sub-endpoints.
const INDEX_SUB_PATHS: Record<string, PathSpec[]> = {
  _validate: [p("query", "쿼리 검사")],
  _search: [p("template", "템플릿 검색"), p("point_in_time", "PIT 열기 (OpenSearch)")],
  _ilm: [p("explain", "ILM 단계")],
  _cache: [p("clear", "캐시 비우기")],
  _block: [p("write", "쓰기 막기"), p("read_only", "읽기 전용"), p("read", "읽기 막기"), p("metadata", "메타데이터 막기")],
};

// `_cat` tables that take an index (or alias) name after them.
const CAT_WITH_NAME = new Set(["indices", "shards", "aliases", "count", "segments", "recovery"]);

// ---- Completion: query parameters ----

const COMMON_PARAMS = ["pretty", "human", "filter_path", "error_trace"];
const SEARCH_PARAMS = ["q", "size", "from", "sort", "_source", "_source_includes", "_source_excludes", "track_total_hits", "timeout", "routing", "preference", "scroll", "search_type", "request_cache", "df", "default_operator", "analyzer", "lenient", "terminate_after", "stored_fields", "explain", "version", "seq_no_primary_term", "typed_keys", "rest_total_hits_as_int", "allow_partial_search_results", "expand_wildcards", "ignore_unavailable", "allow_no_indices"];
const DOC_PARAMS = ["refresh", "routing", "timeout", "version", "version_type", "if_seq_no", "if_primary_term", "op_type", "pipeline", "wait_for_active_shards", "require_alias", "_source", "_source_includes", "_source_excludes", "realtime", "stored_fields", "preference"];
const BY_QUERY_PARAMS = ["conflicts", "refresh", "wait_for_completion", "slices", "max_docs", "requests_per_second", "scroll_size", "q", "routing", "timeout", "expand_wildcards", "ignore_unavailable", "allow_no_indices"];
const INDEX_ADMIN_PARAMS = ["expand_wildcards", "ignore_unavailable", "allow_no_indices", "master_timeout", "timeout", "wait_for_active_shards"];

const PARAMS: Record<string, string[]> = {
  _search: SEARCH_PARAMS,
  _async_search: SEARCH_PARAMS,
  _msearch: ["max_concurrent_searches", "search_type", "typed_keys", "rest_total_hits_as_int"],
  _count: ["q", "df", "default_operator", "analyzer", "lenient", "routing", "preference", "terminate_after", "min_score", "expand_wildcards", "ignore_unavailable", "allow_no_indices"],
  _doc: DOC_PARAMS,
  _update: ["refresh", "routing", "timeout", "retry_on_conflict", "if_seq_no", "if_primary_term", "require_alias", "wait_for_active_shards", "_source"],
  _bulk: ["refresh", "routing", "timeout", "pipeline", "wait_for_active_shards", "require_alias", "_source"],
  _mget: ["refresh", "routing", "preference", "realtime", "_source", "stored_fields"],
  _delete_by_query: BY_QUERY_PARAMS,
  _update_by_query: [...BY_QUERY_PARAMS, "pipeline"],
  _reindex: ["wait_for_completion", "refresh", "slices", "max_docs", "requests_per_second", "timeout", "scroll", "require_alias"],
  _cat: ["v", "h", "s", "format", "help", "bytes", "time", "health", "pri", "expand_wildcards", "local", "master_timeout"],
  "_cluster/health": ["level", "wait_for_status", "wait_for_nodes", "wait_for_active_shards", "wait_for_no_relocating_shards", "wait_for_events", "timeout", "local", "master_timeout"],
  "_cluster/settings": ["include_defaults", "flat_settings", "timeout", "master_timeout"],
  "_cluster/state": ["local", "wait_for_metadata_version", "expand_wildcards"],
  _nodes: ["level", "timeout"],
  "_nodes/stats": ["level", "groups", "fields", "types", "timeout"],
  "_nodes/hot_threads": ["threads", "interval", "snapshots", "type", "ignore_idle_threads"],
  _tasks: ["actions", "detailed", "nodes", "parent_task_id", "group_by", "wait_for_completion", "timeout"],
  _mapping: ["include_defaults", "local", "master_timeout", "write_index_only", ...INDEX_ADMIN_PARAMS],
  _settings: ["include_defaults", "flat_settings", "local", "preserve_existing", "master_timeout", ...INDEX_ADMIN_PARAMS],
  "": ["wait_for_active_shards", "master_timeout", "timeout", "include_defaults", "flat_settings", ...INDEX_ADMIN_PARAMS],
  _forcemerge: ["max_num_segments", "only_expunge_deletes", "flush", "wait_for_completion", "expand_wildcards"],
  _refresh: ["expand_wildcards", "ignore_unavailable", "allow_no_indices"],
  _flush: ["wait_if_ongoing", "force", "expand_wildcards", "ignore_unavailable"],
  _open: INDEX_ADMIN_PARAMS,
  _close: INDEX_ADMIN_PARAMS,
  _stats: ["level", "fields", "completion_fields", "fielddata_fields", "groups", "expand_wildcards"],
  _pit: ["keep_alive", "routing", "preference", "expand_wildcards"],
  "_search/point_in_time": ["keep_alive", "routing", "preference", "expand_wildcards"],
  "_search/scroll": ["scroll", "scroll_id", "rest_total_hits_as_int"],
  _sql: ["format", "delimiter"],
  "_plugins/_sql": ["format"],
  _explain: ["q", "df", "routing", "preference", "_source", "stored_fields"],
  _validate: ["explain", "rewrite", "all_shards", "q", "df"],
  "_validate/query": ["explain", "rewrite", "all_shards", "q", "df"],
  _analyze: [],
  _field_caps: ["fields", "include_unmapped", "expand_wildcards", "filters", "types"],
  _rollover: ["dry_run", "wait_for_active_shards", "master_timeout", "timeout"],
  _data_stream: ["expand_wildcards"],
  _alias: ["expand_wildcards", "local"],
  _aliases: ["master_timeout", "timeout"],
};
const DEFAULT_PARAMS = ["timeout", "master_timeout", "wait_for_completion", "refresh", "wait_for_active_shards"];

// Flags that need no value (`?v`, `?pretty`).
const FLAG_PARAMS = new Set(["pretty", "human", "error_trace", "v", "help", "explain", "version", "seq_no_primary_term", "typed_keys", "detailed", "flat_settings", "include_defaults", "local", "pri", "rest_total_hits_as_int", "lenient", "dry_run", "rewrite", "all_shards", "include_unmapped", "only_expunge_deletes", "preserve_existing"]);

const BOOL = ["true", "false"];
const PARAM_VALUES: Record<string, string[]> = {
  format: ["json", "yaml", "txt", "csv", "tsv"],
  refresh: ["true", "false", "wait_for"],
  wait_for_completion: BOOL,
  pretty: BOOL,
  human: BOOL,
  error_trace: BOOL,
  v: BOOL,
  explain: BOOL,
  detailed: BOOL,
  local: BOOL,
  flat_settings: BOOL,
  include_defaults: BOOL,
  ignore_unavailable: BOOL,
  allow_no_indices: BOOL,
  request_cache: BOOL,
  require_alias: BOOL,
  realtime: BOOL,
  lenient: BOOL,
  conflicts: ["abort", "proceed"],
  expand_wildcards: ["all", "open", "closed", "hidden", "none"],
  level: ["cluster", "indices", "shards"],
  wait_for_status: ["green", "yellow", "red"],
  health: ["green", "yellow", "red"],
  bytes: ["b", "kb", "mb", "gb", "tb"],
  time: ["ms", "s", "m", "h", "d"],
  scroll: ["1m", "5m", "10m"],
  keep_alive: ["1m", "5m", "10m"],
  timeout: ["30s", "1m", "5m"],
  master_timeout: ["30s", "1m"],
  search_type: ["query_then_fetch", "dfs_query_then_fetch"],
  op_type: ["index", "create"],
  default_operator: ["AND", "OR"],
  version_type: ["internal", "external", "external_gte"],
  track_total_hits: ["true", "false", "10000"],
  size: ["10", "100", "1000"],
  group_by: ["nodes", "parents", "none"],
  wait_for_active_shards: ["1", "all"],
  slices: ["auto", "1", "2", "4"],
  type: ["cpu", "wait", "block", "mem"],
};
// Parameters taking a comma list.
const MULTI_PARAMS = new Set(["h", "s", "expand_wildcards", "filter_path", "actions", "_source", "fields"]);

const CAT_COLUMNS: Record<string, string[]> = {
  indices: ["health", "status", "index", "uuid", "pri", "rep", "docs.count", "docs.deleted", "store.size", "pri.store.size", "creation.date.string"],
  nodes: ["ip", "name", "node.role", "master", "heap.percent", "ram.percent", "cpu", "load_1m", "load_5m", "disk.used_percent", "version", "uptime"],
  shards: ["index", "shard", "prirep", "state", "docs", "store", "ip", "node", "unassigned.reason"],
  aliases: ["alias", "index", "filter", "routing.index", "routing.search", "is_write_index"],
  health: ["epoch", "timestamp", "cluster", "status", "node.total", "node.data", "shards", "pri", "relo", "init", "unassign", "active_shards_percent"],
  allocation: ["shards", "disk.indices", "disk.used", "disk.avail", "disk.total", "disk.percent", "host", "ip", "node"],
  thread_pool: ["node_name", "name", "active", "queue", "rejected", "size", "type"],
  count: ["epoch", "timestamp", "count"],
  segments: ["index", "shard", "prirep", "segment", "docs.count", "size", "committed", "searchable"],
  recovery: ["index", "shard", "time", "type", "stage", "source_node", "target_node", "bytes_percent"],
  tasks: ["action", "task_id", "parent_task_id", "type", "start_time", "running_time", "node"],
};

const PARAM_DOCS: Record<string, string> = {
  pretty: "보기 좋게 들여쓰기",
  human: "사람이 읽는 단위",
  filter_path: "응답에서 남길 경로",
  error_trace: "오류에 스택 추적",
  v: "머리글 줄",
  h: "보여 줄 열",
  s: "정렬할 열",
  help: "열 설명",
  format: "응답 형식",
  bytes: "크기 단위",
  time: "시간 단위",
  health: "상태로 거르기",
  pri: "주 샤드 값만",
  q: "Lucene 쿼리 문자열",
  size: "결과 수",
  from: "건너뛸 결과 수",
  sort: "정렬 (field:asc)",
  _source: "가져올 _source 필드",
  track_total_hits: "전체 건수 정확히 세기",
  timeout: "시간 제한",
  routing: "라우팅 값",
  preference: "샤드 선택",
  scroll: "스크롤 유지 시간",
  keep_alive: "PIT 유지 시간",
  refresh: "쓰기 뒤 새로 고침",
  wait_for_completion: "끝날 때까지 기다림",
  conflicts: "버전 충돌 때 멈춤·계속",
  slices: "병렬 조각 수",
  max_docs: "최대 문서 수",
  requests_per_second: "초당 요청 제한",
  expand_wildcards: "와일드카드가 가리킬 인덱스",
  ignore_unavailable: "없는 인덱스 무시",
  allow_no_indices: "맞는 인덱스가 없어도 성공",
  level: "자세한 정도",
  wait_for_status: "이 상태가 될 때까지 기다림",
  include_defaults: "기본값도 보기",
  flat_settings: "설정을 점 키로",
  detailed: "자세히",
  actions: "작업 종류 거르기",
  op_type: "create면 있을 때 실패",
  pipeline: "수집 파이프라인",
  max_num_segments: "합친 뒤 세그먼트 수",
  default_operator: "AND / OR",
  df: "기본 필드",
  analyzer: "분석기",
  if_seq_no: "이 _seq_no일 때만",
  if_primary_term: "이 _primary_term일 때만",
  wait_for_active_shards: "활성 샤드 수",
  master_timeout: "마스터 응답 시간 제한",
  dry_run: "바꾸지 않고 시험",
  retry_on_conflict: "충돌 때 다시 시도 횟수",
};

// ---- Completion: bodies ----

// What a key's value looks like, for the template inserted with it.
type Shape = "object" | "array" | "string" | "scalar";

// Names the console knows: offered for values naming an index or alias.
export interface ConsoleNames {
  indices: string[];
  aliases: string[];
  dataStreams: string[];
}

export interface ConsoleCompletionContext {
  names: ConsoleNames;
  // The mapped fields of an index (a name, list or pattern); empty while
  // they load.
  fieldsOf(index: string): MappedField[];
}

type ValueSource = string[] | "index" | "alias" | "field";

// A body's shape for completion: the keys an object takes, free-named
// children (`properties.<field>`), array elements, a key's values, a
// document (the mapping's fields as keys) or a query (Query DSL).
interface Node {
  doc?: string;
  shape?: Shape;
  keys?: Record<string, Node>;
  any?: Node;
  items?: Node;
  values?: ValueSource;
  fieldKeys?: "doc" | "mapping";
  query?: boolean;
}

const str = (doc?: string, values?: ValueSource): Node => ({ doc, shape: "string", values });
const num = (doc?: string, values?: string[]): Node => ({ doc, shape: "scalar", values });
const flag = (doc?: string): Node => ({ doc, shape: "scalar", values: BOOL });
const arr = (doc?: string, items?: Node): Node => ({ doc, shape: "array", items });
const obj = (doc?: string, keys?: Record<string, Node>): Node => ({ doc, keys });

const FIELD_TYPES = ["text", "keyword", "long", "integer", "short", "byte", "double", "float", "half_float", "scaled_float", "unsigned_long", "date", "date_nanos", "boolean", "binary", "ip", "object", "nested", "flattened", "geo_point", "geo_shape", "point", "shape", "completion", "search_as_you_type", "token_count", "dense_vector", "sparse_vector", "rank_feature", "rank_features", "wildcard", "constant_keyword", "match_only_text", "version", "alias", "join", "percolator", "integer_range", "long_range", "float_range", "double_range", "date_range", "ip_range", "semantic_text"];
const ANALYZERS = ["standard", "simple", "whitespace", "stop", "keyword", "pattern", "fingerprint", "english", "cjk", "nori"];
const TOKENIZERS = ["standard", "whitespace", "keyword", "letter", "lowercase", "classic", "ngram", "edge_ngram", "pattern", "simple_pattern", "char_group", "path_hierarchy", "uax_url_email", "nori_tokenizer"];
const TOKEN_FILTERS = ["lowercase", "uppercase", "asciifolding", "stop", "stemmer", "porter_stem", "synonym", "synonym_graph", "trim", "unique", "length", "ngram", "edge_ngram", "shingle", "word_delimiter_graph", "elision", "cjk_width", "cjk_bigram", "nori_part_of_speech", "nori_readingform"];
const CHAR_FILTERS = ["html_strip", "mapping", "pattern_replace"];
const DATE_FORMATS = ["strict_date_optional_time", "strict_date_optional_time||epoch_millis", "epoch_millis", "epoch_second", "yyyy-MM-dd", "yyyy-MM-dd HH:mm:ss", "basic_date"];
const DYNAMIC = ["true", "false", "strict", "runtime"];
const EXPAND = ["all", "open", "closed", "hidden", "none"];

const SCRIPT: Node = obj("스크립트", { source: str("Painless 코드"), lang: str(undefined, ["painless"]), params: obj("매개변수"), id: str("저장된 스크립트 id") });

const FIELD_DEF: Node = {};
const PROPERTIES: Node = { doc: "필드 정의", any: FIELD_DEF, fieldKeys: "mapping" };
FIELD_DEF.keys = {
  type: str("필드 타입", FIELD_TYPES),
  fields: { doc: "다중 필드 (title.keyword 같은)", any: FIELD_DEF },
  properties: PROPERTIES,
  analyzer: str("색인 분석기", ANALYZERS),
  search_analyzer: str("검색 분석기", ANALYZERS),
  normalizer: str("keyword 정규화"),
  format: str("날짜 형식", DATE_FORMATS),
  index: flag("검색할 수 있게 색인"),
  doc_values: flag("정렬·집계용 열 저장"),
  store: flag("_source와 따로 저장"),
  enabled: flag("이 객체를 색인"),
  dynamic: str("새 필드를 만날 때", DYNAMIC),
  null_value: num("null 대신 색인할 값"),
  copy_to: str("값을 복사할 필드", "field"),
  ignore_above: num("이보다 긴 값은 색인 안 함", ["256"]),
  coerce: flag("문자열 숫자를 받아들임"),
  ignore_malformed: flag("잘못된 값을 무시"),
  scaling_factor: num("scaled_float 배율", ["100"]),
  dims: num("벡터 차원"),
  similarity: str("점수 방식", ["BM25", "boolean", "cosine", "dot_product", "l2_norm"]),
  index_options: str("색인할 정보", ["docs", "freqs", "positions", "offsets"]),
  term_vector: str("용어 벡터", ["no", "yes", "with_positions", "with_offsets", "with_positions_offsets"]),
  norms: flag("길이 정규화"),
  eager_global_ordinals: flag("전역 서수를 미리"),
  fielddata: flag("text 필드 집계 (메모리 많이 씀)"),
  path: str("alias가 가리킬 필드", "field"),
  meta: obj("메타데이터"),
};

const MAPPING: Node = obj("매핑", {
  properties: PROPERTIES,
  dynamic: str("새 필드를 만날 때", DYNAMIC),
  _source: obj("_source 저장", { enabled: flag(), includes: arr(undefined, { values: "field" }), excludes: arr(undefined, { values: "field" }) }),
  _routing: obj("라우팅", { required: flag() }),
  dynamic_templates: arr("동적 템플릿"),
  runtime: { doc: "런타임 필드", any: obj(undefined, { type: str("타입", ["keyword", "long", "double", "date", "boolean", "ip", "geo_point", "composite", "lookup"]), script: SCRIPT }) },
  _meta: obj("메타데이터"),
  date_detection: flag("날짜 문자열을 date로"),
  numeric_detection: flag("숫자 문자열을 숫자로"),
  subobjects: flag("점 이름을 객체로"),
});

const ANALYSIS: Node = obj("분석기 정의", {
  analyzer: { doc: "분석기", any: obj(undefined, { type: str("타입", ["custom", ...ANALYZERS]), tokenizer: str("토크나이저", TOKENIZERS), filter: arr("토큰 필터", { values: TOKEN_FILTERS }), char_filter: arr("문자 필터", { values: CHAR_FILTERS }), stopwords: str("불용어", ["_english_", "_none_"]) }) },
  tokenizer: { doc: "토크나이저", any: obj(undefined, { type: str("타입", TOKENIZERS), min_gram: num(), max_gram: num(), token_chars: arr(undefined, { values: ["letter", "digit", "whitespace", "punctuation", "symbol"] }), pattern: str() }) },
  filter: { doc: "토큰 필터", any: obj(undefined, { type: str("타입", TOKEN_FILTERS), synonyms: arr(), stopwords: arr(), language: str(), min_gram: num(), max_gram: num() }) },
  char_filter: { doc: "문자 필터", any: obj(undefined, { type: str("타입", CHAR_FILTERS), mappings: arr(), pattern: str(), replacement: str() }) },
  normalizer: { doc: "keyword 정규화", any: obj(undefined, { type: str(undefined, ["custom"]), filter: arr(undefined, { values: TOKEN_FILTERS }), char_filter: arr(undefined, { values: CHAR_FILTERS }) }) },
});

const INDEX_SETTINGS: Record<string, Node> = {
  number_of_shards: num("주 샤드 수 (만들 때만)", ["1", "3"]),
  number_of_replicas: num("복제본 수", ["0", "1", "2"]),
  refresh_interval: str("새로 고침 간격", ["1s", "30s", "-1"]),
  max_result_window: num("from + size 한도", ["10000", "50000"]),
  auto_expand_replicas: str("노드 수에 따라 복제본", ["0-1", "0-all", "false"]),
  "mapping.total_fields.limit": num("필드 수 한도", ["1000", "2000"]),
  "blocks.write": flag("쓰기 막기"),
  "blocks.read_only": flag("읽기 전용"),
  "blocks.read_only_allow_delete": flag("읽기 전용 (지우기는 허용)"),
  codec: str("저장 압축", ["default", "best_compression"]),
  default_pipeline: str("기본 수집 파이프라인"),
  "lifecycle.name": str("ILM 정책"),
  "lifecycle.rollover_alias": str("롤오버 별칭", "alias"),
  max_inner_result_window: num(),
  "translog.durability": str("트랜스로그 기록", ["request", "async"]),
  "routing.allocation.require._name": str("이 노드에만 배치"),
  hidden: flag("숨은 인덱스"),
  analysis: ANALYSIS,
};
const SETTINGS: Node = obj("설정", { index: obj("인덱스 설정", INDEX_SETTINGS), ...INDEX_SETTINGS });

const ALIAS_DEF: Node = obj(undefined, { filter: { doc: "이 별칭으로 볼 문서", query: true }, routing: str(), index_routing: str(), search_routing: str(), is_write_index: flag("쓰기 대상"), is_hidden: flag() });
const ALIASES_DEF: Node = { doc: "별칭", any: ALIAS_DEF };
const CREATE_INDEX: Node = obj(undefined, { settings: SETTINGS, mappings: MAPPING, aliases: ALIASES_DEF });

const ALIAS_ACTION: Node = obj(undefined, {
  index: str("인덱스", "index"),
  indices: arr("인덱스들", { values: "index" }),
  alias: str("별칭", "alias"),
  aliases: arr("별칭들", { values: "alias" }),
  filter: { doc: "이 별칭으로 볼 문서", query: true },
  routing: str(),
  index_routing: str(),
  search_routing: str(),
  is_write_index: flag("쓰기 대상"),
  is_hidden: flag(),
  must_exist: flag(),
});

const DOC: Node = { fieldKeys: "doc" };
const UPDATE: Node = obj(undefined, { doc: { doc: "바꿀 필드", fieldKeys: "doc" }, upsert: { doc: "없을 때 넣을 문서", fieldKeys: "doc" }, doc_as_upsert: flag("없으면 doc을 넣음"), script: SCRIPT, scripted_upsert: flag(), detect_noop: flag(), _source: flag() });

const BULK_META: Record<string, Node> = {
  _index: str("인덱스", "index"),
  _id: str("문서 id"),
  routing: str(),
  if_seq_no: num(),
  if_primary_term: num(),
  version: num(),
  version_type: str(undefined, ["internal", "external", "external_gte"]),
  pipeline: str(),
  require_alias: flag(),
  dynamic_templates: obj(),
};
const BULK_ACTION: Node = obj(undefined, {
  index: obj("넣기 (있으면 덮어씀)", BULK_META),
  create: obj("새로 넣기 (있으면 실패)", BULK_META),
  update: obj("일부 바꾸기", { ...BULK_META, retry_on_conflict: num(), _source: flag() }),
  delete: obj("지우기", BULK_META),
});
const MSEARCH_HEADER: Node = obj(undefined, {
  index: str("인덱스", "index"),
  preference: str(),
  routing: str(),
  search_type: str(undefined, ["query_then_fetch", "dfs_query_then_fetch"]),
  request_cache: flag(),
  allow_no_indices: flag(),
  expand_wildcards: str(undefined, EXPAND),
  ignore_unavailable: flag(),
  allow_partial_search_results: flag(),
});

const PHASE: Node = obj(undefined, {
  min_age: str("단계에 들어갈 나이", ["0ms", "7d", "30d"]),
  actions: obj("동작", {
    rollover: obj("롤오버", { max_age: str(undefined, ["1d", "7d"]), max_primary_shard_size: str(undefined, ["50gb"]), max_docs: num(), max_size: str(), min_docs: num() }),
    set_priority: obj(undefined, { priority: num() }),
    shrink: obj(undefined, { number_of_shards: num() }),
    forcemerge: obj(undefined, { max_num_segments: num(undefined, ["1"]) }),
    readonly: obj(),
    delete: obj(),
    allocate: obj(undefined, { number_of_replicas: num(), require: obj(), include: obj(), exclude: obj() }),
    migrate: obj(undefined, { enabled: flag() }),
    searchable_snapshot: obj(undefined, { snapshot_repository: str() }),
    downsample: obj(undefined, { fixed_interval: str(undefined, ["1h", "1d"]) }),
  }),
});

const CLUSTER_SETTING_KEYS: Node = obj(undefined, {
  "cluster.routing.allocation.enable": str("샤드 배치", ["all", "primaries", "new_primaries", "none"]),
  "cluster.routing.rebalance.enable": str("재배치", ["all", "primaries", "replicas", "none"]),
  "cluster.routing.allocation.disk.watermark.low": str(undefined, ["85%"]),
  "cluster.routing.allocation.disk.watermark.high": str(undefined, ["90%"]),
  "cluster.routing.allocation.disk.watermark.flood_stage": str(undefined, ["95%"]),
  "cluster.max_shards_per_node": num("노드당 샤드 한도"),
  "cluster.blocks.read_only": flag("클러스터 읽기 전용"),
  "action.destructive_requires_name": flag("와일드카드 지우기 막기"),
  "indices.recovery.max_bytes_per_sec": str("복구 속도", ["40mb", "100mb"]),
  "search.max_buckets": num("집계 버킷 한도"),
  "action.auto_create_index": str("자동 인덱스 만들기", ["true", "false"]),
});

const SQL: Node = obj(undefined, { query: str("SQL 문"), fetch_size: num("한 번에 받을 행", ["1000"]), cursor: str("다음 페이지 커서"), filter: { doc: "먼저 거를 Query DSL", query: true }, time_zone: str(undefined, ["Z", "Asia/Seoul"]), params: arr(), columnar: flag(), page_timeout: str(), request_timeout: str() });

// The body shape by endpoint family (Query DSL bodies go to completeDsl).
function bodyNode(family: string, method: string, rest: string[], index: string | null): Node | null {
  switch (family) {
    case "_doc":
      return rest[0] === "_source" ? null : DOC;
    case "_update":
      return UPDATE;
    case "_mapping":
      return MAPPING;
    case "_settings":
      return SETTINGS;
    case "":
      return index !== null && method === "PUT" ? CREATE_INDEX : null;
    case "_index_template":
      return obj(undefined, { index_patterns: arr("이름 패턴"), template: CREATE_INDEX, priority: num(), composed_of: arr("구성 요소 템플릿"), data_stream: obj("데이터 스트림으로"), _meta: obj(), version: num(), allow_auto_create: flag() });
    case "_component_template":
      return obj(undefined, { template: CREATE_INDEX, version: num(), _meta: obj() });
    case "_aliases":
      return obj(undefined, { actions: arr("동작", obj(undefined, { add: obj("별칭 붙이기", ALIAS_ACTION.keys), remove: obj("별칭 떼기", ALIAS_ACTION.keys), remove_index: obj("인덱스 지우기", { index: str(undefined, "index"), indices: arr(undefined, { values: "index" }), must_exist: flag() }) })) });
    case "_alias":
      return ALIAS_DEF;
    case "_reindex":
      return obj(undefined, {
        source: obj("읽을 곳", { index: str("인덱스", "index"), query: { doc: "복사할 문서", query: true }, size: num("한 번에 읽을 수"), _source: arr(undefined, { values: "field" }), remote: obj("다른 클러스터", { host: str(), username: str(), password: str(), socket_timeout: str(), connect_timeout: str() }), slice: obj(), sort: arr() }),
        dest: obj("쓸 곳", { index: str("인덱스", "index"), op_type: str(undefined, ["index", "create"]), pipeline: str(), version_type: str(undefined, ["internal", "external", "external_gte"]), routing: str() }),
        script: SCRIPT,
        conflicts: str("버전 충돌 때", ["abort", "proceed"]),
        max_docs: num("최대 문서 수"),
      });
    case "_analyze":
      return obj(undefined, { analyzer: str("분석기", ANALYZERS), tokenizer: str("토크나이저", TOKENIZERS), filter: arr("토큰 필터", { values: TOKEN_FILTERS }), char_filter: arr("문자 필터", { values: CHAR_FILTERS }), normalizer: str(), text: str("분석할 글"), field: str("이 필드의 분석기로", "field"), explain: flag("단계별로"), attributes: arr() });
    case "_sql":
    case "_sql/translate":
    case "_plugins/_sql":
    case "_plugins/_ppl":
    case "_query":
      return SQL;
    case "_sql/close":
      return obj(undefined, { cursor: str("닫을 커서") });
    case "_search/scroll":
      return obj(undefined, { scroll: str("유지 시간", ["1m", "5m"]), scroll_id: str("스크롤 id") });
    case "_pit":
    case "_search/point_in_time":
      return obj(undefined, { id: str("PIT id"), pit_id: arr("PIT id (OpenSearch)") });
    case "_cluster/settings":
      return obj(undefined, { persistent: CLUSTER_SETTING_KEYS, transient: CLUSTER_SETTING_KEYS });
    case "_ilm/policy":
      return obj(undefined, { policy: obj("정책", { phases: obj("단계", { hot: PHASE, warm: PHASE, cold: PHASE, frozen: PHASE, delete: PHASE }), _meta: obj() }) });
    case "_rollover":
      return obj(undefined, { conditions: obj("넘길 조건", { max_age: str(undefined, ["1d", "7d"]), max_docs: num(), max_size: str(), max_primary_shard_size: str(undefined, ["50gb"]), max_primary_shard_docs: num(), min_docs: num() }), settings: SETTINGS, mappings: MAPPING, aliases: ALIASES_DEF });
    case "_shrink":
    case "_split":
    case "_clone":
      return obj(undefined, { settings: SETTINGS, aliases: ALIASES_DEF });
    case "_mget":
      return obj(undefined, { docs: arr("문서들", obj(undefined, { _index: str("인덱스", "index"), _id: str(), _source: flag(), routing: str() })), ids: arr("id들") });
    case "_field_caps":
      return obj(undefined, { index_filter: { doc: "인덱스 거르기", query: true }, runtime_mappings: obj() });
  }
  return null;
}

// Query DSL bodies and their root.
const DSL_ROOTS: Record<string, DslContext["root"]> = {
  _search: "search",
  _async_search: "search",
  _knn_search: "search",
  _count: "count",
  _explain: "count",
  "_validate/query": "count",
  _delete_by_query: "delete_by_query",
  _update_by_query: "update_by_query",
};

const TEMPLATES: Record<Shape, string> = { object: "{ }", array: "[ ]", string: '""', scalar: "" };

// Items whose label starts with the typed word first, then those that
// contain it.
function rank(items: DslItem[], prefix: string, limit = 200): DslItem[] {
  const lower = prefix.toLowerCase();
  return items
    .map((item, index) => ({ item, index, pos: item.label.toLowerCase().indexOf(lower) }))
    .filter((x) => lower === "" || x.pos >= 0)
    .sort((a, b) => Number(a.pos !== 0) - Number(b.pos !== 0) || a.index - b.index)
    .slice(0, limit)
    .map((x) => x.item);
}

function result(from: number, to: number, quoted: boolean, items: DslItem[], prefix: string): DslCompletion | null {
  const ranked = rank(items, prefix);
  return ranked.length === 0 ? null : { from, to, quoted, items: ranked };
}

function shapeOfType(type: string): Shape {
  if (type === "object" || type === "nested" || type === "flattened" || type === "geo_point" || type.endsWith("_range")) {
    return "object";
  }
  if (["long", "integer", "short", "byte", "double", "float", "half_float", "scaled_float", "unsigned_long", "boolean", "token_count", "rank_feature"].includes(type)) {
    return "scalar";
  }
  return "string";
}

// The names an `index` value or path segment may take; hidden ones only
// once the typed word starts with a dot.
function nameItems(names: ConsoleNames, prefix: string, which: "index" | "alias"): DslItem[] {
  const hidden = prefix.startsWith(".");
  const seen = new Set<string>();
  const out: DslItem[] = [];
  const add = (list: string[], detail: string) => {
    for (const name of list) {
      if (!seen.has(name) && (hidden || !name.startsWith("."))) {
        seen.add(name);
        out.push({ label: name, kind: "index", detail: t(detail) });
      }
    }
  };
  if (which === "index") {
    add(names.indices, "인덱스");
    add(names.dataStreams, "데이터 스트림");
  }
  add(names.aliases, "별칭");
  return out;
}

function keyItem(at: JsonCaret, label: string, kind: ItemKind, shape: Shape, detail?: string): DslItem {
  const body = TEMPLATES[shape];
  const head = at.quoted ? `${label}": ` : `"${label}": `;
  // The caret goes inside the template's quotes or brackets.
  return { label, kind, detail, insert: head + body, caretBack: shape === "scalar" ? 0 : 1 };
}

function valueItem(at: JsonCaret, label: string, kind: ItemKind, detail?: string): DslItem {
  const bare = !at.quoted && /^(?:true|false|null|-?\d+(?:\.\d+)?)$/.test(label);
  return { label, kind, detail, insert: bare ? label : at.quoted ? `${label}"` : `"${label}"` };
}

// Where each container around the caret opens, outermost first.
function containerStarts(src: string, start: number, caret: number): number[] {
  const stack: number[] = [];
  for (const tok of tokenizeJson(src, start, caret)) {
    if (tok.type === "punc") {
      if (tok.text === "{" || tok.text === "[") {
        stack.push(tok.from);
      } else if (tok.text === "}" || tok.text === "]") {
        stack.pop();
      }
    }
  }
  return stack;
}

// Completion inside a body described by `root`.
function completeSchema(src: string, caret: number, start: number, root: Node, names: ConsoleNames, fields: MappedField[]): DslCompletion | null {
  const at = jsonCaret(src, caret, start);
  if (at === null) {
    return null;
  }
  let node: Node | undefined = root;
  const docPath: string[] = [];
  const mapPath: string[] = [];
  for (let k = 0; k < at.path.length; k++) {
    const step = at.path[k];
    if (node === undefined) {
      return null;
    }
    if (node.fieldKeys === "doc") {
      if (step !== ELEMENT) {
        docPath.push(step);
      }
      continue;
    }
    if (step === ELEMENT) {
      node = node.items;
      continue;
    }
    const next: Node | undefined = node.keys?.[step];
    if (next !== undefined) {
      node = next;
    } else if (node.any !== undefined) {
      if (node.fieldKeys === "mapping") {
        mapPath.push(step);
      }
      node = node.any;
    } else {
      return null;
    }
    if (node.query) {
      // A query below: the DSL completion from the object holding its key.
      const starts = containerStarts(src, start, caret);
      return starts[k] === undefined ? null : completeDsl(src, caret, { fields, root: "none" }, starts[k]);
    }
  }
  if (node === undefined) {
    return null;
  }
  if (at.at === "key") {
    const items: DslItem[] = [];
    for (const [key, child] of Object.entries(node.keys ?? {})) {
      if (!at.siblings.includes(key)) {
        items.push(keyItem(at, key, child.query ? "query" : "keyword", child.shape ?? "object", child.doc ? t(child.doc) : undefined));
      }
    }
    if (node.fieldKeys !== undefined) {
      const prefix = (node.fieldKeys === "doc" ? docPath : mapPath).join(".");
      for (const f of fields) {
        if (f.multi || at.siblings.includes(f.path)) {
          continue;
        }
        const rel = prefix === "" ? f.path : f.path.startsWith(`${prefix}.`) ? f.path.slice(prefix.length + 1) : null;
        if (rel !== null && rel !== "" && !rel.includes(".")) {
          items.push(keyItem(at, rel, "field", node.fieldKeys === "doc" ? shapeOfType(f.type) : "object", f.type));
        }
      }
    }
    return result(at.from, caret, at.quoted, items, at.prefix);
  }
  const target = at.key === ELEMENT ? node.items : node.fieldKeys === "doc" ? undefined : node.keys?.[at.key ?? ""];
  const source = target?.values;
  if (source === undefined) {
    return null;
  }
  let items: DslItem[];
  if (source === "index" || source === "alias") {
    items = nameItems(names, at.prefix, source).map((item) => valueItem(at, item.label, "index", item.detail));
  } else if (source === "field") {
    items = fields.filter((f) => f.type !== "object").map((f) => valueItem(at, f.path, "field", f.type));
  } else {
    items = source.map((v) => valueItem(at, v, "value"));
  }
  return result(at.from, caret, at.quoted, items, at.prefix);
}

// An NDJSON body: the value the caret is in and what it is (a bulk action
// or document, an msearch header or query).
function completeNdjson(src: string, caret: number, req: ConsoleRequest, family: string, ctx: ConsoleCompletionContext, fields: MappedField[]): DslCompletion | null {
  let depth = 0;
  let valueStart = -1;
  const firstKeys: string[] = [];
  let firstKey: string | null = null;
  for (const tok of tokenizeJson(src, req.headEnd, caret)) {
    if (tok.type === "punc" && (tok.text === "{" || tok.text === "[")) {
      if (depth === 0) {
        valueStart = tok.from;
        firstKey = null;
      }
      depth++;
    } else if (tok.type === "punc" && (tok.text === "}" || tok.text === "]")) {
      depth--;
      if (depth === 0) {
        firstKeys.push(firstKey ?? "");
        valueStart = -1;
      }
    } else if (depth === 1 && firstKey === null && tok.type === "str") {
      firstKey = tok.text;
    }
  }
  if (valueStart < 0) {
    return null;
  }
  if (family === "_msearch") {
    if (firstKeys.length % 2 === 0) {
      return completeSchema(src, caret, valueStart, MSEARCH_HEADER, ctx.names, fields);
    }
    return completeDsl(src, caret, { fields, root: "search" }, valueStart);
  }
  // _bulk: an action line, or the document after index/create/update.
  let expectAction = true;
  let action = "";
  for (const key of firstKeys) {
    if (expectAction) {
      action = key;
      expectAction = !(key === "index" || key === "create" || key === "update");
    } else {
      expectAction = true;
    }
  }
  if (expectAction) {
    return completeSchema(src, caret, valueStart, BULK_ACTION, ctx.names, fields);
  }
  return completeSchema(src, caret, valueStart, action === "update" ? UPDATE : DOC, ctx.names, fields);
}

function completeBody(src: string, caret: number, req: ConsoleRequest, ctx: ConsoleCompletionContext): DslCompletion | null {
  const { index, rest } = endpointOf(req.path);
  const family = familyOf(rest);
  const fields = index !== null && !index.startsWith("_") ? ctx.fieldsOf(index) : [];
  if (req.ndjson) {
    return completeNdjson(src, caret, req, family.startsWith("_msearch") ? "_msearch" : "_bulk", ctx, fields);
  }
  const dslRoot = DSL_ROOTS[family];
  if (dslRoot !== undefined) {
    return completeDsl(src, caret, { fields, root: dslRoot }, req.headEnd);
  }
  const node = bodyNode(family, req.method, rest, index);
  if (node !== null) {
    return completeSchema(src, caret, req.headEnd, node, ctx.names, fields);
  }
  return index !== null ? completeDsl(src, caret, { fields, root: "none" }, req.headEnd) : null;
}

function pathItem(spec: PathSpec): DslItem {
  return { label: spec.label, kind: "path", detail: t(spec.doc), insert: spec.label };
}

// The path on a method line, up to the caret.
function completePath(part: string, caret: number, ctx: ConsoleCompletionContext): DslCompletion | null {
  const q = part.indexOf("?");
  if (q >= 0) {
    return completeParams(part.slice(0, q), part.slice(q + 1), caret);
  }
  const segs = part.replace(/^\//, "").split("/");
  const current = segs.pop() ?? "";
  const done = segs.filter((s) => s !== "");
  const comma = current.lastIndexOf(",");
  const word = current.slice(comma + 1);
  const from = caret - word.length;
  const names = (which: "index" | "alias") => nameItems(ctx.names, word, which);
  let items: DslItem[] = [];
  if (done.length === 0) {
    items = comma >= 0 ? names("index") : [...TOP_PATHS.map(pathItem), ...names("index")];
  } else if (!done[0].startsWith("_") || done[0] === "_all") {
    if (done.length === 1) {
      items = comma >= 0 ? [] : INDEX_PATHS.map(pathItem);
    } else if (done.length === 2) {
      if (done[1] === "_alias") {
        items = names("alias");
      } else {
        items = (INDEX_SUB_PATHS[done[1]] ?? []).map(pathItem);
      }
    }
  } else {
    const head = done[0];
    if (done.length === 1) {
      if (head === "_data_stream") {
        items = ctx.names.dataStreams.map((name) => ({ label: name, kind: "index", detail: t("데이터 스트림") }));
      } else if (head === "_alias") {
        items = names("alias");
      } else {
        items = (SUB_PATHS[head] ?? []).map(pathItem);
      }
    } else if (done.length === 2 && head === "_cat" && CAT_WITH_NAME.has(done[1])) {
      items = names(done[1] === "aliases" ? "alias" : "index");
    } else if (done.length === 2 && head === "_tasks") {
      items = [{ label: "_cancel", kind: "path", detail: t("작업 취소") }];
    }
  }
  return result(from, caret, false, items, word);
}

function completeParams(pathname: string, query: string, caret: number): DslCompletion | null {
  const { rest } = endpointOf(pathname);
  const family = familyOf(rest);
  const current = query.slice(query.lastIndexOf("&") + 1);
  const eq = current.indexOf("=");
  if (eq < 0) {
    const present = new Set(query.split("&").map((part) => part.split("=")[0]));
    present.delete(current);
    const list = [...(PARAMS[family] ?? PARAMS[rest[0] ?? ""] ?? DEFAULT_PARAMS), ...COMMON_PARAMS];
    const items = [...new Set(list)]
      .filter((name) => !present.has(name))
      .map((name): DslItem => ({ label: name, kind: "param", detail: PARAM_DOCS[name] ? t(PARAM_DOCS[name]) : undefined, insert: FLAG_PARAMS.has(name) ? name : `${name}=` }));
    return result(caret - current.length, caret, false, items, current);
  }
  const name = current.slice(0, eq);
  const value = current.slice(eq + 1);
  const word = MULTI_PARAMS.has(name) ? value.slice(value.lastIndexOf(",") + 1) : value;
  const values = name === "h" || name === "s" ? (CAT_COLUMNS[rest[1] ?? ""] ?? []) : (PARAM_VALUES[name] ?? []);
  return result(caret - word.length, caret, false, values.map((v) => ({ label: v, kind: "value" })), word);
}

const METHOD_HEAD = /^(GET|HEAD|POST|PUT|DELETE|PATCH)(\s+)/i;

// Completion at `caret`: a method at a line's start, the path and its
// parameters on a method line, or the body below it.
export function completeConsole(src: string, caret: number, ctx: ConsoleCompletionContext): DslCompletion | null {
  const lineStart = src.lastIndexOf("\n", caret - 1) + 1;
  const nl = src.indexOf("\n", caret);
  const before = src.slice(lineStart, caret);
  const after = src.slice(caret, nl < 0 ? src.length : nl);
  const requests = parseConsole(src);
  const head = METHOD_HEAD.exec(before);
  if (head !== null && requests.some((r) => r.from === lineStart)) {
    const part = before.slice(head[0].length);
    return /\s/.test(part) ? null : completePath(part, caret, ctx);
  }
  const owner = [...requests].reverse().find((r) => r.from < lineStart);
  const inBody = owner !== undefined && jsonCaret(src, lineStart, owner.headEnd) !== null;
  if (/^[A-Za-z]*$/.test(before) && !inBody) {
    // Text after the word (`GE|T /x`): the method alone.
    const alone = after.trim() !== "";
    const items = CONSOLE_METHODS.map((m): DslItem => ({ label: m, kind: "method", insert: alone ? m : `${m} /` }));
    return result(lineStart, caret, false, items, before);
  }
  return owner === undefined ? null : completeBody(src, caret, owner, ctx);
}
