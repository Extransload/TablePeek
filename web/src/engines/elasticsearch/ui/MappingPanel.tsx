// The 매핑 sub-tab of an index tab: the mapping as a field tree (objects and
// nested fields open and close, multi-fields under their parent) with each
// field's type coloured by family and its key parameters as chips, a filter,
// the raw JSON, and a dialog that adds a field with `PUT /<index>/_mapping`.
// An alias, a data stream or a pattern answers with each backing index's
// mapping; a picker chooses which one shows.
//
// Also here, shared by the other index panels: the raw JSON view with its
// copy button, the backing index picker, the fields of a mapping reply and
// the analysis names an index's settings define.

import { useEffect, useMemo, useState } from "react";
import { writeClipboard } from "../../../clipboard";
import { ErrorNotice, FieldError, fieldErrorProps, notifyError } from "../../../components/ErrorNotice";
import { ChevronIcon, CopyIcon, PlusIcon, RefreshIcon, SearchIcon } from "../../../components/icons";
import { Select } from "../../../components/Select";
import { LoadingState, Spinner } from "../../../components/Spinner";
import { SuggestInput } from "../../../components/SuggestInput";
import { t } from "../../../i18n";
import { jsonKeys, stringifyJson } from "../../mongodb/bson";
import { AdminModal } from "../../mongodb/ui/AdminModal";
import { aliases, getMapping, getSettings, isAbort, putMapping } from "../api";
import { mappingFields, type MappedField } from "../dsl";
import { rec, type Json } from "../json";
import { ConsoleText, needsConfirm, requestText, type SearchHost } from "./common";
import { SearchEditor } from "./SearchEditor";
import type { IndexPanelProps, TargetKind } from "./types";
import "../../mongodb/mongodb.css";
import "../../mongodb/ui/panels.css";
import "./panels.css";

// ---- Shared with the other index panels ----

// Copies text and says so; a refused clipboard says that instead.
async function copyText(host: SearchHost, text: string): Promise<void> {
  let failed = false;
  await writeClipboard(text, (message) => {
    failed = true;
    notifyError(message);
  });
  if (!failed) {
    host.notify(t("복사했습니다"));
  }
}

// A reply as pretty JSON in a read-only editor, with a copy button.
export function RawJson({ host, value, label }: { host: SearchHost; value: unknown; label: string }) {
  const text = useMemo(() => stringifyJson(value, 2), [value]);
  return (
    <div className="es-raw">
      <div className="es-raw-bar">
        <span className="panel-dim">{label}</span>
        <span className="spacer" />
        <button type="button" className="mg-qbtn" onClick={() => void copyText(host, text)}>
          <CopyIcon size={10} />
          {t("복사")}
        </button>
      </div>
      <SearchEditor value={text} readOnly className="es-raw-editor" ariaLabel={label} />
    </div>
  );
}

// The backing index a panel shows: the one picked if still there, else the
// newest of a data stream (its write index) or the first of the others.
export function backingIndex(names: string[], picked: string | null, kind: TargetKind): string | null {
  if (picked !== null && names.includes(picked)) {
    return picked;
  }
  return names.length === 0 ? null : kind === "data_stream" ? names[names.length - 1] : names[0];
}

// Which backing index a reply shows, when there are several.
export function IndexPicker({ names, value, onChange }: { names: string[]; value: string | null; onChange(name: string): void }) {
  if (names.length < 2 || value === null) {
    return null;
  }
  return (
    <Select className="mg-input es-picker" aria-label={t("인덱스 [하나]")} title={t("뒤에 있는 인덱스 {count}개", { count: names.length })} value={value} onChange={(event) => onChange(event.target.value)}>
      {names.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </Select>
  );
}

// Analyzers every node knows without settings.
export const BUILTIN_ANALYZERS = ["standard", "simple", "whitespace", "stop", "keyword", "pattern", "fingerprint"];
export const LANGUAGE_ANALYZERS = [
  "english",
  "arabic",
  "armenian",
  "basque",
  "bengali",
  "brazilian",
  "bulgarian",
  "catalan",
  "cjk",
  "czech",
  "danish",
  "dutch",
  "estonian",
  "finnish",
  "french",
  "galician",
  "german",
  "greek",
  "hindi",
  "hungarian",
  "indonesian",
  "irish",
  "italian",
  "latvian",
  "lithuanian",
  "norwegian",
  "persian",
  "portuguese",
  "romanian",
  "russian",
  "serbian",
  "sorani",
  "spanish",
  "swedish",
  "thai",
  "turkish",
];

// The fields of every index a mapping reply names, once each (an alias or
// a pattern answers with several).
export function allMappedFields(reply: Record<string, unknown>): MappedField[] {
  const seen = new Set<string>();
  const out: MappedField[] = [];
  for (const [name, entry] of Object.entries(reply)) {
    for (const field of mappingFields({ [name]: entry })) {
      if (!seen.has(field.path)) {
        seen.add(field.path);
        out.push(field);
      }
    }
  }
  return out;
}

// The analysis components an index's settings define (`index.analysis`):
// custom analyzers, tokenizers, token filters, character filters and
// normalizers by name.
export interface CustomAnalysis {
  analyzers: string[];
  tokenizers: string[];
  filters: string[];
  charFilters: string[];
  normalizers: string[];
}

export function customAnalysis(settingsReply: Record<string, unknown>, index: string): CustomAnalysis {
  const analysis = rec(rec(rec(rec(settingsReply[index]).settings).index).analysis);
  const names = (key: string) => jsonKeys(rec(analysis[key]));
  return { analyzers: names("analyzer"), tokenizers: names("tokenizer"), filters: names("filter"), charFilters: names("char_filter"), normalizers: names("normalizer") };
}

// ---- The field tree ----

interface FieldNode {
  name: string;
  path: string;
  type: string;
  def: Record<string, unknown>;
  children: FieldNode[];
  // Multi-fields (`fields`): `title.keyword` under `title`.
  multi: FieldNode[];
}

function fieldTree(props: Record<string, unknown>, prefix: string): FieldNode[] {
  return jsonKeys(props).map((name): FieldNode => {
    const def = rec(props[name]);
    const path = prefix === "" ? name : `${prefix}.${name}`;
    const subs = rec(def.fields);
    return {
      name,
      path,
      type: typeof def.type === "string" ? def.type : "object",
      def,
      children: def.properties !== undefined ? fieldTree(rec(def.properties), path) : [],
      multi: jsonKeys(subs).map((sub): FieldNode => {
        const subDef = rec(subs[sub]);
        return { name: sub, path: `${path}.${sub}`, type: typeof subDef.type === "string" ? subDef.type : "keyword", def: subDef, children: [], multi: [] };
      }),
    };
  });
}

function countFields(nodes: FieldNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + node.multi.length + countFields(node.children), 0);
}

// The tree cut to what matches the filter: a matching field keeps all of
// its subtree, the others stay only as the way to a match.
function filterTree(nodes: FieldNode[], q: string): FieldNode[] {
  const out: FieldNode[] = [];
  for (const node of nodes) {
    if (node.path.toLowerCase().includes(q) || node.type.toLowerCase().includes(q)) {
      out.push(node);
      continue;
    }
    const children = filterTree(node.children, q);
    const multi = node.multi.filter((m) => m.path.toLowerCase().includes(q) || m.type.toLowerCase().includes(q));
    if (children.length > 0 || multi.length > 0) {
      out.push({ ...node, children, multi });
    }
  }
  return out;
}

// Type families the badges are coloured by.
const FAMILIES: Record<string, string> = {};
for (const [family, types] of Object.entries({
  text: ["text", "match_only_text", "search_as_you_type", "semantic_text", "annotated_text", "completion"],
  keyword: ["keyword", "constant_keyword", "wildcard", "version"],
  numeric: ["long", "integer", "short", "byte", "double", "float", "half_float", "scaled_float", "unsigned_long", "token_count", "integer_range", "long_range", "float_range", "double_range"],
  date: ["date", "date_nanos", "date_range"],
  boolean: ["boolean"],
  geo: ["geo_point", "geo_shape", "point", "shape", "xy_point", "xy_shape"],
  object: ["object", "nested", "flattened", "flat_object", "join", "passthrough"],
  vector: ["dense_vector", "sparse_vector", "rank_feature", "rank_features", "knn_vector", "semantic_text"],
  ip: ["ip", "ip_range"],
  binary: ["binary", "histogram", "aggregate_metric_double"],
})) {
  for (const type of types) {
    FAMILIES[type] ??= family;
  }
}

function TypeBadge({ type }: { type: string }) {
  return <span className={`es-type fam-${FAMILIES[type] ?? "other"}`}>{type}</span>;
}

// The parameters worth seeing beside a field, as `key: value` chips.
function paramChips(def: Record<string, unknown>): { text: string; warn: boolean }[] {
  const chips: { text: string; warn: boolean }[] = [];
  const add = (text: string, warn = false) => chips.push({ text, warn });
  for (const key of ["analyzer", "search_analyzer", "normalizer", "format", "similarity", "ignore_above", "scaling_factor", "dims", "dimension", "path", "null_value"]) {
    if (def[key] !== undefined && def[key] !== null) {
      add(`${key}: ${typeof def[key] === "string" ? def[key] : stringifyJson(def[key])}`);
    }
  }
  if (def.copy_to !== undefined) {
    add(`copy_to: ${Array.isArray(def.copy_to) ? def.copy_to.join(", ") : String(def.copy_to)}`);
  }
  if (def.index === false) {
    add("index: false", true);
  }
  if (def.doc_values === false) {
    add("doc_values: false", true);
  }
  if (def.enabled === false) {
    add("enabled: false", true);
  }
  if (def.dynamic !== undefined) {
    add(`dynamic: ${String(def.dynamic)}`);
  }
  if (def.store === true) {
    add("store: true");
  }
  if (def.fielddata === true) {
    add("fielddata: true", true);
  }
  if (def.eager_global_ordinals === true) {
    add("eager_global_ordinals");
  }
  return chips;
}

function FieldRows({ nodes, depth, collapsed, filtering, onToggle }: { nodes: FieldNode[]; depth: number; collapsed: Set<string>; filtering: boolean; onToggle(path: string): void }) {
  return (
    <>
      {nodes.map((node) => {
        const openable = node.children.length > 0 || node.multi.length > 0;
        const open = filtering || !collapsed.has(node.path);
        return (
          <div key={node.path} role="none">
            <div className="es-frow" role="treeitem" aria-level={depth + 1} aria-expanded={openable ? open : undefined} style={{ paddingLeft: 8 + depth * 18 }} title={node.path}>
              {openable ? (
                <button type="button" className={`es-fchev${open ? " open" : ""}`} aria-label={open ? t("접기") : t("펼치기")} onClick={() => onToggle(node.path)}>
                  <ChevronIcon size={9} />
                </button>
              ) : (
                <span className="es-fchev-space" />
              )}
              <span className="es-fname mono">{node.name}</span>
              <TypeBadge type={node.type} />
              {paramChips(node.def).map((chip) => (
                <span key={chip.text} className={`es-chip mono${chip.warn ? " warn" : ""}`}>
                  {chip.text}
                </span>
              ))}
            </div>
            {openable && open ? (
              <div role="group">
                {node.multi.map((sub) => (
                  <div key={sub.path} className="es-frow multi" role="treeitem" aria-level={depth + 2} style={{ paddingLeft: 8 + (depth + 1) * 18 }} title={sub.path}>
                    <span className="es-fchev-space" />
                    <span className="es-fname mono">
                      <span className="panel-dim">{node.name}.</span>
                      {sub.name}
                    </span>
                    <TypeBadge type={sub.type} />
                    <span className="es-chip dim">{t("다중 필드")}</span>
                    {paramChips(sub.def).map((chip) => (
                      <span key={chip.text} className={`es-chip mono${chip.warn ? " warn" : ""}`}>
                        {chip.text}
                      </span>
                    ))}
                  </div>
                ))}
                <FieldRows nodes={node.children} depth={depth + 1} collapsed={collapsed} filtering={filtering} onToggle={onToggle} />
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function objectPaths(nodes: FieldNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.children.length > 0 || node.multi.length > 0) {
      out.push(node.path);
      objectPaths(node.children, out);
    }
  }
  return out;
}

export function MappingPanel({ host, index, kind, refreshSeq, onChanged }: IndexPanelProps) {
  const [reply, setReply] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reloadSeq, setReloadSeq] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [raw, setRaw] = useState(false);
  const [adding, setAdding] = useState(false);
  // The index an alias writes to: fields are added there.
  const [writeIndex, setWriteIndex] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    setError(null);
    getMapping(host.conn, index, ctl.signal).then(
      (r) => setReply(r),
      (e: unknown) => {
        if (!isAbort(e)) {
          setError(e);
        }
      },
    );
    return () => ctl.abort();
  }, [host.conn, index, refreshSeq, reloadSeq]);

  useEffect(() => {
    if (kind !== "alias") {
      setWriteIndex(null);
      return;
    }
    const ctl = new AbortController();
    aliases(host.conn, ctl.signal).then(
      (rows) => {
        const behind = rows.filter((row) => row.alias === index);
        const writer = behind.find((row) => row.is_write_index === true) ?? (behind.length === 1 && behind[0].is_write_index !== false ? behind[0] : undefined);
        setWriteIndex(writer?.index ?? null);
      },
      // Without the alias list the field dialog just stays off.
      () => setWriteIndex(null),
    );
    return () => ctl.abort();
  }, [host.conn, index, kind, refreshSeq, reloadSeq]);

  const names = useMemo(() => (reply === null ? [] : jsonKeys(reply).sort()), [reply]);
  const current = backingIndex(names, picked, kind);
  const mappings: Record<string, unknown> = current === null || reply === null ? {} : rec(rec(reply[current]).mappings);
  const tree = useMemo(() => fieldTree(rec(mappings.properties), ""), [mappings]);
  const q = filter.trim().toLowerCase();
  const shown = useMemo(() => (q === "" ? tree : filterTree(tree, q)), [tree, q]);
  const total = useMemo(() => countFields(tree), [tree]);

  const target = host.readOnly ? null : kind === "index" ? index : kind === "alias" ? writeIndex : null;
  const targetMapping = target === null || reply === null ? null : rec(rec(reply[target]).mappings);

  function toggle(path: string): void {
    setCollapsed((set) => {
      const next = new Set(set);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  const dynamic = mappings.dynamic === undefined ? "true" : String(mappings.dynamic);
  const sourceOff = rec(mappings._source).enabled === false;
  const templates = Array.isArray(mappings.dynamic_templates) ? mappings.dynamic_templates.length : 0;
  const paths = useMemo(() => objectPaths(tree), [tree]);

  let body;
  if (error !== null) {
    body = <ErrorNotice error={error} context="structure" engine="elasticsearch" onRetry={() => setReloadSeq((n) => n + 1)} />;
  } else if (reply === null) {
    body = <LoadingState />;
  } else if (current === null) {
    body = <div className="panel-empty">{t("매핑을 돌려준 인덱스가 없습니다")}</div>;
  } else if (raw) {
    body = <RawJson host={host} value={rec(reply[current])} label={`GET /${current}/_mapping`} />;
  } else if (tree.length === 0) {
    body = <div className="panel-empty">{t("매핑된 필드가 없습니다. 문서를 넣으면 동적 매핑이 필드를 만듭니다.")}</div>;
  } else {
    body = (
      <>
        {shown.length === 0 ? (
          <div className="panel-empty">{t("“{text}”에 맞는 필드가 없습니다", { text: filter.trim() })}</div>
        ) : (
          <div className="es-ftree" role="tree" aria-label={t("매핑")}>
            <FieldRows nodes={shown} depth={0} collapsed={collapsed} filtering={q !== ""} onToggle={toggle} />
          </div>
        )}
        <div className="es-hint panel-dim">{t("이미 있는 필드의 형식은 바꿀 수 없습니다. 바꾸려면 새 매핑으로 인덱스를 만들고 다시 색인하세요.")}</div>
      </>
    );
  }

  return (
    <div className="mg-pane es-pane">
      <div className="mg-agg-bar">
        <IndexPicker names={names} value={current} onChange={setPicked} />
        <span className="mg-agg-count">{reply === null ? t("매핑") : t("필드 {count}개", { count: total.toLocaleString() })}</span>
        {reply !== null && current !== null ? (
          <>
            <span className={`es-chip mono${dynamic === "strict" ? " warn" : ""}`} title={t("매핑에 없는 필드가 들어올 때: true 추가, false 무시, strict 거절, runtime 런타임 필드")}>
              dynamic: {dynamic}
            </span>
            {sourceOff ? <span className="es-chip mono warn">_source: false</span> : null}
            {templates > 0 ? <span className="es-chip">{t("동적 템플릿 {count}개", { count: templates })}</span> : null}
          </>
        ) : null}
        {!raw ? (
          <label className="es-search">
            <SearchIcon size={10} />
            <input type="search" className="mg-input" placeholder={t("필드 찾기")} aria-label={t("필드 찾기")} spellCheck={false} value={filter} onChange={(event) => setFilter(event.target.value)} />
          </label>
        ) : null}
        {!raw && paths.length > 0 && q === "" ? (
          <button type="button" className="mg-qbtn" onClick={() => setCollapsed(collapsed.size > 0 ? new Set() : new Set(paths))}>
            {collapsed.size > 0 ? t("모두 펼치기") : t("모두 접기")}
          </button>
        ) : null}
        <span className="spacer" />
        <div className="segmented" role="group" aria-label={t("보기")}>
          <button type="button" className={raw ? "" : "active"} aria-pressed={!raw} onClick={() => setRaw(false)}>
            {t("트리")}
          </button>
          <button type="button" className={raw ? "active" : ""} aria-pressed={raw} onClick={() => setRaw(true)}>
            JSON
          </button>
        </div>
        <button type="button" className="icon-button" title={t("새로고침")} aria-label={t("새로고침")} onClick={() => setReloadSeq((n) => n + 1)}>
          <RefreshIcon size={12} />
        </button>
        {target !== null && targetMapping !== null ? (
          <button type="button" className="primary mg-find" onClick={() => setAdding(true)}>
            <PlusIcon size={9} />
            {t("필드 추가")}
          </button>
        ) : null}
      </div>
      <div className="es-body">{body}</div>
      {adding && target !== null && targetMapping !== null ? (
        <AddFieldDialog
          host={host}
          target={target}
          viaAlias={kind === "alias" ? index : null}
          mapping={targetMapping}
          onClose={() => setAdding(false)}
          onAdded={(path) => {
            setAdding(false);
            host.notify(t("{field} 필드를 추가했습니다", { field: path }));
            setReloadSeq((n) => n + 1);
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

// ---- 필드 추가 ----

const TYPE_GROUPS: { label: string; types: string[] }[] = [
  { label: "텍스트", types: ["text", "match_only_text", "search_as_you_type", "completion"] },
  { label: "정확히 일치", types: ["keyword", "constant_keyword", "wildcard"] },
  { label: "숫자", types: ["long", "integer", "short", "byte", "double", "float", "half_float", "scaled_float", "unsigned_long"] },
  { label: "날짜", types: ["date", "date_nanos"] },
  { label: "기타", types: ["boolean", "ip", "binary", "version"] },
  { label: "구조", types: ["object", "nested", "flattened"] },
  { label: "위치", types: ["geo_point", "geo_shape"] },
  { label: "벡터", types: ["dense_vector", "sparse_vector", "knn_vector"] },
  { label: "범위", types: ["integer_range", "long_range", "float_range", "double_range", "date_range", "ip_range"] },
];

const ANALYZED: Record<string, true> = { text: true, match_only_text: true, search_as_you_type: true };
const DATED: Record<string, true> = { date: true, date_nanos: true, date_range: true };
const DATE_FORMATS = ["strict_date_optional_time||epoch_millis", "strict_date_optional_time", "epoch_millis", "epoch_second", "yyyy-MM-dd", "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ss.SSSZ", "basic_date", "date_time"];
const SIMILARITIES = ["cosine", "dot_product", "l2_norm", "max_inner_product"];

function AddFieldDialog({
  host,
  target,
  viaAlias,
  mapping,
  onClose,
  onAdded,
}: {
  host: SearchHost;
  target: string;
  // The alias the tab opened, when the field goes to its write index.
  viaAlias: string | null;
  mapping: Record<string, unknown>;
  onClose(): void;
  onAdded(path: string): void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState("keyword");
  const [analyzer, setAnalyzer] = useState("");
  const [keywordSub, setKeywordSub] = useState(true);
  const [format, setFormat] = useState("");
  const [scaling, setScaling] = useState("100");
  const [dims, setDims] = useState("");
  const [similarity, setSimilarity] = useState("");
  const [notIndexed, setNotIndexed] = useState(false);
  const [custom, setCustom] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  // The index's own analyzers join the built-in ones in the suggestions.
  useEffect(() => {
    const ctl = new AbortController();
    getSettings(host.conn, target, false, ctl.signal).then(
      (reply) => setCustom(customAnalysis(reply, target).analyzers),
      () => setCustom([]),
    );
    return () => ctl.abort();
  }, [host.conn, target]);

  const path = name.trim();
  const analyzed = Object.hasOwn(ANALYZED, type);
  const dated = Object.hasOwn(DATED, type);
  // Types that take `index: false` (objects and vectors do not, or not alike).
  const indexable = !["object", "nested", "binary", "flattened", "completion", "sparse_vector", "knn_vector", "dense_vector"].includes(type);

  // The `_mapping` body, or why it cannot be sent yet.
  const built = useMemo((): { body: Json } | { nameError: string } | { optionError: string } => {
    if (path === "") {
      return { nameError: t("필드 이름을 쓰세요") };
    }
    const segments = path.split(".");
    if (segments.some((s) => s === "")) {
      return { nameError: t("이름에 빈 부분이 있습니다 (점이 겹치거나 앞뒤에 있습니다)") };
    }
    // The existing parents decide the wrapping: a nested parent must say so,
    // a leaf field cannot hold fields.
    const nestedAt: boolean[] = [];
    let props = rec(mapping.properties);
    for (let i = 0; i < segments.length; i++) {
      const raw = props[segments[i]];
      if (raw === undefined) {
        break;
      }
      const def = rec(raw);
      const existing = typeof def.type === "string" ? def.type : "object";
      if (i === segments.length - 1) {
        return { nameError: t("{field} 필드는 이미 {type} 형식으로 있습니다. 기존 필드의 형식은 바꿀 수 없습니다 (다시 색인 필요).", { field: path, type: existing }) };
      }
      if (existing !== "object" && existing !== "nested") {
        return { nameError: t("{field}는 {type} 필드라 그 아래에 필드를 둘 수 없습니다", { field: segments.slice(0, i + 1).join("."), type: existing }) };
      }
      nestedAt[i] = existing === "nested";
      props = rec(def.properties);
    }
    const def: { [key: string]: Json } = { type };
    if (analyzed && analyzer.trim() !== "") {
      def.analyzer = analyzer.trim();
    }
    if (type === "text" && keywordSub) {
      def.fields = { keyword: { type: "keyword", ignore_above: 256 } };
    }
    if (dated && format.trim() !== "") {
      def.format = format.trim();
    }
    if (type === "scaled_float") {
      const factor = Number(scaling);
      if (scaling.trim() === "" || !Number.isFinite(factor) || factor <= 0) {
        return { optionError: t("scaling_factor는 0보다 큰 수여야 합니다") };
      }
      def.scaling_factor = factor;
    }
    if (type === "dense_vector" || type === "knn_vector") {
      const n = Number(dims);
      if (!Number.isInteger(n) || n < 1 || n > 16384) {
        return { optionError: t("차원 수는 1 이상의 정수여야 합니다") };
      }
      def[type === "knn_vector" ? "dimension" : "dims"] = n;
      if (type === "dense_vector" && similarity !== "") {
        def.similarity = similarity;
      }
    }
    if (indexable && notIndexed) {
      def.index = false;
    }
    let node: { [key: string]: Json } = def;
    for (let i = segments.length - 1; i > 0; i--) {
      node = { ...(nestedAt[i - 1] ? { type: "nested" } : {}), properties: { [segments[i]]: node } };
    }
    return { body: { properties: { [segments[0]]: node } } };
  }, [path, mapping, type, analyzed, dated, analyzer, keywordSub, format, scaling, dims, similarity, notIndexed, indexable]);

  const nameError = "nameError" in built ? built.nameError : null;
  const problem = "body" in built ? null : "nameError" in built ? built.nameError : built.optionError;
  const command = "body" in built ? requestText("PUT", `/${target}/_mapping`, built.body) : null;

  async function submit(): Promise<void> {
    if (busy || !("body" in built) || command === null) {
      return;
    }
    if (needsConfirm("write", host.safeMode)) {
      const ok = await host.confirm({
        title: t("필드 추가"),
        message: t("{index}에 {field} 필드({type})를 추가할까요?\n추가한 필드는 지울 수 없습니다.", { index: target, field: path, type }),
        command,
        okLabel: t("추가"),
      });
      if (!ok) {
        return;
      }
    }
    setBusy(true);
    setFailure(null);
    try {
      await putMapping(host.conn, target, built.body);
      onAdded(path);
    } catch (e) {
      setFailure(e);
      setBusy(false);
    }
  }

  return (
    <AdminModal
      title={t("필드 추가")}
      path={viaAlias === null ? target : `${viaAlias} → ${target}`}
      className="es-modal"
      busy={busy}
      onClose={onClose}
      foot={
        <>
          <span className="spacer" />
          <button type="button" onClick={onClose} disabled={busy}>
            {t("취소")}
          </button>
          <button type="button" className="primary" disabled={busy || problem !== null} onClick={() => void submit()}>
            {busy ? <Spinner size={10} /> : null}
            {t("추가")}
          </button>
        </>
      }
    >
      <div className="mg-form-grid">
        <label className="mg-form-row">
          <span className="mg-form-label">{t("이름 (점으로 하위 필드: customer.name)")}</span>
          <input
            type="text"
            className="mg-input mono"
            spellCheck={false}
            autoFocus
            value={name}
            {...fieldErrorProps("es-add-field-name", name.trim() === "" ? null : nameError)}
            onChange={(event) => {
              setName(event.target.value);
              setFailure(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <FieldError id="es-add-field-name" error={name.trim() === "" ? null : nameError} />
        </label>
        <label className="mg-form-row">
          <span className="mg-form-label">{t("형식")}</span>
          <Select className="mg-input" value={type} onChange={(event) => setType(event.target.value)}>
            {TYPE_GROUPS.map((group) => (
              <optgroup key={group.label} label={t(group.label)}>
                {group.types.map((ty) => (
                  <option key={ty} value={ty}>
                    {ty}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </label>
        {analyzed ? (
          <label className="mg-form-row">
            <span className="mg-form-label">{t("분석기 (비우면 standard)")}</span>
            <SuggestInput
              type="text"
              className="mg-input mono"
              spellCheck={false}
              suggestions={[...custom, ...BUILTIN_ANALYZERS, ...LANGUAGE_ANALYZERS]}
              placeholder="standard"
              value={analyzer}
              onChange={(event) => setAnalyzer(event.target.value)}
            />
          </label>
        ) : null}
        {dated ? (
          <label className="mg-form-row">
            <span className="mg-form-label">{t("날짜 형식 (비우면 strict_date_optional_time||epoch_millis)")}</span>
            <SuggestInput type="text" className="mg-input mono" spellCheck={false} suggestions={DATE_FORMATS} value={format} onChange={(event) => setFormat(event.target.value)} />
          </label>
        ) : null}
        {type === "scaled_float" ? (
          <label className="mg-form-row">
            <span className="mg-form-label">{t("scaling_factor (값에 곱해 정수로 저장)")}</span>
            <input type="number" className="mg-input mono" min={0} value={scaling} onChange={(event) => setScaling(event.target.value)} />
          </label>
        ) : null}
        {type === "dense_vector" || type === "knn_vector" ? (
          <label className="mg-form-row">
            <span className="mg-form-label">{t("차원 수")}</span>
            <input type="number" className="mg-input mono" min={1} placeholder="384" value={dims} onChange={(event) => setDims(event.target.value)} />
          </label>
        ) : null}
        {type === "dense_vector" ? (
          <label className="mg-form-row">
            <span className="mg-form-label">{t("유사도")}</span>
            <Select className="mg-input" value={similarity} onChange={(event) => setSimilarity(event.target.value)}>
              <option value="">{t("서버 기본값")}</option>
              {SIMILARITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
      </div>
      {type === "text" || indexable ? (
        <div className="mg-checks">
          {type === "text" ? (
            <label>
              <input type="checkbox" checked={keywordSub} onChange={(event) => setKeywordSub(event.target.checked)} />
              {t("정렬·집계용 keyword 다중 필드 (fields.keyword)")}
            </label>
          ) : null}
          {indexable ? (
            <label>
              <input type="checkbox" checked={notIndexed} onChange={(event) => setNotIndexed(event.target.checked)} />
              {t("검색하지 않음 (index: false)")}
            </label>
          ) : null}
        </div>
      ) : null}
      <div className="es-hint panel-dim">{t("이미 있는 필드의 형식은 바꿀 수 없습니다. 바꾸려면 새 매핑으로 인덱스를 만들고 다시 색인하세요.")}</div>
      <div className="mg-form-label">{t("보낼 요청")}</div>
      <pre className="panel-pre mg-ix-preview">
        {command !== null ? (
          <ConsoleText text={command} />
        ) : "optionError" in built ? (
          <span className="mg-danger-text">{built.optionError}</span>
        ) : (
          // A name problem shows under the name; an empty name just waits.
          <span className="panel-dim">{path === "" ? problem : "—"}</span>
        )}
      </pre>
      {failure !== null ? <ErrorNotice error={failure} context="structure" engine="elasticsearch" variant="compact" /> : null}
    </AdminModal>
  );
}
