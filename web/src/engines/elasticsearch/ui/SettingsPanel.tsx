// The 설정 sub-tab of an index tab: the index's settings grouped (shards and
// replicas, refresh, result window, analysis, routing, blocks, lifecycle…),
// with the server's defaults on request and the raw JSON; 편집 sends dynamic
// settings with `PUT /<index>/_settings`. Static ones (shards, codec,
// analysis…) change only on a closed index, which the editor says.

import { useEffect, useMemo, useState } from "react";
import { ErrorNotice, FieldError } from "../../../components/ErrorNotice";
import { PencilIcon, RefreshIcon, SearchIcon } from "../../../components/icons";
import { Select } from "../../../components/Select";
import { LoadingState, Spinner } from "../../../components/Spinner";
import { t } from "../../../i18n";
import { JsonSyntaxError, jsonKeys, parseJson, stringifyJson } from "../../mongodb/bson";
import { AdminModal } from "../../mongodb/ui/AdminModal";
import { getSettings, isAbort, putSettings } from "../api";
import { jsonCaret, type DslCompletion, type DslItem } from "../dsl";
import { rec, type Json } from "../json";
import { ConsoleText, needsConfirm, requestText, type SearchHost } from "./common";
import { IndexPicker, RawJson, backingIndex } from "./MappingPanel";
import { SearchEditor } from "./SearchEditor";
import type { IndexPanelProps } from "./types";
import "../../mongodb/mongodb.css";
import "../../mongodb/ui/panels.css";
import "./panels.css";

interface SettingRow {
  // Without the leading `index.`.
  key: string;
  value: unknown;
  // From the server's defaults, not set on the index.
  isDefault: boolean;
}

function flatten(obj: Record<string, unknown>, prefix: string, out: [string, unknown][]): [string, unknown][] {
  for (const key of jsonKeys(obj)) {
    const v = obj[key];
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      flatten(rec(v), path, out);
    } else {
      out.push([path, v]);
    }
  }
  return out;
}

// Settings only a closed index (or index creation) takes.
const STATIC_KEYS: Record<string, true> = {
  number_of_shards: true,
  number_of_routing_shards: true,
  codec: true,
  routing_partition_size: true,
  "soft_deletes.enabled": true,
  "shard.check_on_startup": true,
  load_fixed_bitset_filters_eagerly: true,
  mode: true,
};

function isStatic(key: string): boolean {
  return Object.hasOwn(STATIC_KEYS, key) || key.startsWith("analysis.") || key.startsWith("sort.") || key === "analysis" || key === "sort";
}

// What the grouped view sorts the keys into, in order; the first that
// matches takes a key.
const GENERAL = ["number_of_shards", "number_of_replicas", "auto_expand_replicas", "refresh_interval", "max_result_window", "codec", "hidden", "mode", "default_pipeline", "final_pipeline", "creation_date", "uuid", "version.created", "provided_name"];
const GROUPS: { label: string; match(key: string): boolean }[] = [
  { label: "일반", match: (key) => GENERAL.includes(key) },
  { label: "분석", match: (key) => key.startsWith("analysis.") },
  { label: "라우팅·할당", match: (key) => key.startsWith("routing.") || key.startsWith("routing_") || key.startsWith("number_of_routing") },
  { label: "블록", match: (key) => key.startsWith("blocks.") },
  { label: "수명 주기", match: (key) => key.startsWith("lifecycle.") || key.startsWith("plugins.index_state_management") || key.startsWith("opendistro.") },
  { label: "검색 한도", match: (key) => key.startsWith("max_") || key.startsWith("search.") || key.startsWith("query.") || key.startsWith("highlight.") },
  { label: "저장·트랜스로그·병합", match: (key) => key.startsWith("translog.") || key.startsWith("merge.") || key.startsWith("store.") || key.startsWith("refresh") || key.startsWith("flush") },
  { label: "기타", match: () => true },
];

function valueText(key: string, value: unknown): string {
  if (typeof value === "string") {
    if (key === "creation_date" && /^\d+$/.test(value)) {
      return `${value}  (${new Date(Number(value)).toLocaleString()})`;
    }
    return value;
  }
  return Array.isArray(value) ? value.map((v) => (typeof v === "string" ? v : stringifyJson(v))).join(", ") : stringifyJson(value);
}

// A setting as the editor seeds it: the server's "1" and "true" as JSON
// numbers and booleans.
function typedValue(value: unknown): Json {
  if (typeof value === "string") {
    if (value === "true" || value === "false") {
      return value === "true";
    }
    if (/^-?\d+$/.test(value) && Number.isSafeInteger(Number(value))) {
      return Number(value);
    }
    return value;
  }
  return value === undefined ? null : (value as Json);
}

export function SettingsPanel({ host, index, kind, refreshSeq, onChanged }: IndexPanelProps) {
  const [reply, setReply] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reloadSeq, setReloadSeq] = useState(0);
  const [withDefaults, setWithDefaults] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [raw, setRaw] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    setError(null);
    getSettings(host.conn, index, withDefaults, ctl.signal).then(
      (r) => setReply(r),
      (e: unknown) => {
        if (!isAbort(e)) {
          setError(e);
        }
      },
    );
    return () => ctl.abort();
  }, [host.conn, index, withDefaults, refreshSeq, reloadSeq]);

  const names = useMemo(() => (reply === null ? [] : jsonKeys(reply).sort()), [reply]);
  const current = backingIndex(names, picked, kind);
  const entry = current === null || reply === null ? null : rec(reply[current]);

  const rows = useMemo((): SettingRow[] => {
    if (entry === null) {
      return [];
    }
    const strip = (key: string) => (key.startsWith("index.") ? key.slice(6) : key);
    const own = flatten(rec(entry.settings), "", []).map(([key, value]): SettingRow => ({ key: strip(key), value, isDefault: false }));
    const seen = new Set(own.map((row) => row.key));
    const defaults = flatten(rec(entry.defaults), "", [])
      .map(([key, value]): SettingRow => ({ key: strip(key), value, isDefault: true }))
      .filter((row) => !seen.has(row.key));
    return [...own, ...defaults];
  }, [entry]);

  const q = filter.trim().toLowerCase();
  const groups = useMemo(() => {
    const out = GROUPS.map((g) => ({ label: g.label, rows: [] as SettingRow[] }));
    for (const row of rows) {
      if (q !== "" && !row.key.toLowerCase().includes(q) && !valueText(row.key, row.value).toLowerCase().includes(q)) {
        continue;
      }
      out[GROUPS.findIndex((g) => g.match(row.key))].rows.push(row);
    }
    for (const g of out) {
      g.rows.sort((a, b) => (GENERAL.includes(a.key) && GENERAL.includes(b.key) ? GENERAL.indexOf(a.key) - GENERAL.indexOf(b.key) : Number(a.isDefault) - Number(b.isDefault) || a.key.localeCompare(b.key)));
    }
    return out.filter((g) => g.rows.length > 0);
  }, [rows, q]);

  let body;
  if (error !== null) {
    body = <ErrorNotice error={error} context="structure" engine="elasticsearch" onRetry={() => setReloadSeq((n) => n + 1)} />;
  } else if (reply === null || entry === null) {
    body = reply === null ? <LoadingState /> : <div className="panel-empty">{t("설정을 돌려준 인덱스가 없습니다")}</div>;
  } else if (raw) {
    body = <RawJson host={host} value={entry} label={`GET /${current}/_settings${withDefaults ? "?include_defaults=true" : ""}`} />;
  } else if (groups.length === 0) {
    body = <div className="panel-empty">{t("“{text}”에 맞는 설정이 없습니다", { text: filter.trim() })}</div>;
  } else {
    body = groups.map((group) => (
      <section key={group.label} className="structure-section es-settings-group">
        <div className="structure-section-head">
          <span className="structure-section-title">{t(group.label)}</span>
          <span className="panel-dim">{group.rows.length.toLocaleString()}</span>
        </div>
        <table className="panel-table es-settings-table">
          <tbody>
            {group.rows.map((row) => (
              <tr key={row.key} className={row.isDefault ? "es-default" : undefined}>
                <td className="mono es-setting-key">
                  {row.key}
                  {isStatic(row.key) ? (
                    <span className="es-chip dim" title={t("닫힌 인덱스에서만 바꿀 수 있습니다")}>
                      {t("정적")}
                    </span>
                  ) : null}
                  {row.isDefault ? <span className="es-chip dim">{t("기본값")}</span> : null}
                </td>
                <td className="mono es-setting-value">{valueText(row.key, row.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    ));
  }

  // Seeds the editor with the commonly changed dynamic settings at their
  // current values.
  const seed = useMemo(() => {
    const value = (key: string, fallback: Json): Json => {
      const row = rows.find((r) => r.key === key);
      return row === undefined ? fallback : typedValue(row.value);
    };
    return stringifyJson(
      {
        index: {
          number_of_replicas: value("number_of_replicas", 1),
          refresh_interval: value("refresh_interval", "1s"),
          max_result_window: value("max_result_window", 10000),
          blocks: { write: value("blocks.write", false) },
        },
      },
      2,
    );
  }, [rows]);

  return (
    <div className="mg-pane es-pane">
      <div className="mg-agg-bar">
        <IndexPicker names={names} value={current} onChange={setPicked} />
        <span className="mg-agg-count">{reply === null ? t("설정") : t("설정 {count}개", { count: rows.length.toLocaleString() })}</span>
        <label className="es-check">
          <input type="checkbox" checked={withDefaults} onChange={(event) => setWithDefaults(event.target.checked)} />
          {t("기본값 포함")}
        </label>
        {!raw ? (
          <label className="es-search">
            <SearchIcon size={10} />
            <input type="search" className="mg-input" placeholder={t("설정 찾기")} aria-label={t("설정 찾기")} spellCheck={false} value={filter} onChange={(event) => setFilter(event.target.value)} />
          </label>
        ) : null}
        <span className="spacer" />
        <div className="segmented" role="group" aria-label={t("보기")}>
          <button type="button" className={raw ? "" : "active"} aria-pressed={!raw} onClick={() => setRaw(false)}>
            {t("표")}
          </button>
          <button type="button" className={raw ? "active" : ""} aria-pressed={raw} onClick={() => setRaw(true)}>
            JSON
          </button>
        </div>
        <button type="button" className="icon-button" title={t("새로고침")} aria-label={t("새로고침")} onClick={() => setReloadSeq((n) => n + 1)}>
          <RefreshIcon size={12} />
        </button>
        {!host.readOnly && current !== null ? (
          <button type="button" className="primary mg-find" onClick={() => setEditing(true)}>
            <PencilIcon size={10} />
            {t("편집 [버튼]")}
          </button>
        ) : null}
      </div>
      <div className="es-body">{body}</div>
      {editing && current !== null ? (
        <SettingsDialog
          host={host}
          targets={names.length > 1 ? [current, index] : [current]}
          count={names.length}
          seed={seed}
          onClose={() => setEditing(false)}
          onSaved={(target) => {
            setEditing(false);
            host.notify(t("{index}의 설정을 바꿨습니다", { index: target }));
            setReloadSeq((n) => n + 1);
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

// Keys the editor offers under `index`, with the template of their value.
const DYNAMIC_KEYS: Record<string, string> = {
  number_of_replicas: "1",
  auto_expand_replicas: '"0-1"',
  refresh_interval: '"1s"',
  max_result_window: "10000",
  max_inner_result_window: "100",
  max_terms_count: "65536",
  max_ngram_diff: "1",
  max_shingle_diff: "3",
  default_pipeline: '""',
  final_pipeline: '""',
  hidden: "false",
  blocks: "{ }",
  "blocks.write": "true",
  "blocks.read_only": "true",
  "blocks.read_only_allow_delete": "true",
  "blocks.read": "true",
  "blocks.metadata": "true",
  "routing.allocation.include._name": '""',
  "routing.allocation.exclude._name": '""',
  "routing.allocation.require._name": '""',
  "routing.allocation.total_shards_per_node": "-1",
  "routing.allocation.enable": '"all"',
  "routing.rebalance.enable": '"all"',
  "unassigned.node_left.delayed_timeout": '"1m"',
  "translog.durability": '"request"',
  "translog.sync_interval": '"5s"',
  "translog.flush_threshold_size": '"512mb"',
  "search.idle.after": '"30s"',
  "search.slowlog.threshold.query.warn": '"10s"',
  "search.slowlog.threshold.query.info": '"5s"',
  "search.slowlog.threshold.fetch.warn": '"1s"',
  "indexing.slowlog.threshold.index.warn": '"10s"',
  "lifecycle.name": '""',
  "lifecycle.rollover_alias": '""',
  "mapping.total_fields.limit": "1000",
  "mapping.depth.limit": "20",
  "mapping.nested_fields.limit": "50",
  "highlight.max_analyzed_offset": "1000000",
  "merge.scheduler.max_thread_count": "1",
};
const BLOCK_KEYS = ["write", "read_only", "read_only_allow_delete", "read", "metadata"];

// Key completion for the settings body: `index` at the top, the dynamic
// settings inside it, the block names inside `blocks`.
function completeSettings(src: string, pos: number): DslCompletion | null {
  const at = jsonCaret(src, pos);
  if (at === null || at.at !== "key") {
    return null;
  }
  const path = at.path.join(".");
  const keys: Record<string, string> = path === "" ? { index: "{ }" } : path === "index" ? DYNAMIC_KEYS : path === "index.blocks" ? Object.fromEntries(BLOCK_KEYS.map((k) => [k, "true"])) : {};
  const prefix = at.prefix.toLowerCase();
  const items = Object.entries(keys)
    .filter(([key]) => !at.siblings.includes(key) && key.toLowerCase().includes(prefix))
    .sort(([a], [b]) => Number(!a.toLowerCase().startsWith(prefix)) - Number(!b.toLowerCase().startsWith(prefix)))
    .map(([key, template]): DslItem => {
      const insert = `${at.quoted ? "" : '"'}${key}": ${template}`;
      const caretBack = template === "{ }" ? 2 : template.startsWith('"') ? template.length - 1 : 0;
      return { label: key, kind: "keyword", detail: isStatic(key) ? t("정적") : undefined, insert, caretBack };
    });
  return items.length === 0 ? null : { from: at.from, to: pos, quoted: at.quoted, items };
}

function SettingsDialog({
  host,
  targets,
  count,
  seed,
  onClose,
  onSaved,
}: {
  host: SearchHost;
  // The backing index on show, then (for an alias, a data stream or a
  // pattern) the tab's name, which reaches all of them.
  targets: string[];
  count: number;
  seed: string;
  onClose(): void;
  onSaved(target: string): void;
}) {
  const [text, setText] = useState(seed);
  const [target, setTarget] = useState(targets[0]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  const parsed = useMemo((): { body: Json; statics: string[] } | { error: string; at: number | null } => {
    let value: unknown;
    try {
      value = parseJson(text);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e), at: e instanceof JsonSyntaxError ? e.offset : null };
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { error: t("설정은 JSON 객체여야 합니다 (예: {\"index\": {\"number_of_replicas\": 1}})"), at: null };
    }
    const keys = flatten(rec(value), "", []).map(([key]) => (key.startsWith("index.") ? key.slice(6) : key));
    if (keys.length === 0) {
      return { error: t("바꿀 설정이 없습니다"), at: null };
    }
    return { body: value as Json, statics: keys.filter(isStatic) };
  }, [text]);

  const problem = "error" in parsed ? parsed.error : null;
  const command = "body" in parsed ? requestText("PUT", `/${target}/_settings`, parsed.body) : null;

  async function submit(): Promise<void> {
    if (busy || !("body" in parsed) || command === null) {
      return;
    }
    if (needsConfirm("write", host.safeMode)) {
      const ok = await host.confirm({
        title: t("설정 바꾸기"),
        message: target === targets[0] ? t("{index}의 설정을 바꿀까요?", { index: target }) : t("{name} 뒤의 인덱스 {count}개 모두의 설정을 바꿀까요?", { name: target, count }),
        command,
        okLabel: t("바꾸기"),
      });
      if (!ok) {
        return;
      }
    }
    setBusy(true);
    setFailure(null);
    try {
      await putSettings(host.conn, target, parsed.body);
      onSaved(target);
    } catch (e) {
      setFailure(e);
      setBusy(false);
    }
  }

  return (
    <AdminModal
      title={t("설정 편집")}
      path={target}
      className="es-modal wide"
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
            {t("바꾸기")}
          </button>
        </>
      }
    >
      {targets.length > 1 ? (
        <label className="mg-form-row">
          <span className="mg-form-label">{t("적용 대상")}</span>
          <Select className="mg-input" value={target} onChange={(event) => setTarget(event.target.value)}>
            <option value={targets[0]}>{targets[0]}</option>
            <option value={targets[1]}>{t("{name} (인덱스 {count}개 모두)", { name: targets[1], count })}</option>
          </Select>
        </label>
      ) : null}
      <div className="mg-form-label">{t("바꿀 설정 (동적 설정은 바로 적용됩니다)")}</div>
      <SearchEditor
        value={text}
        onChange={(next) => {
          setText(next);
          setFailure(null);
        }}
        onRun={() => void submit()}
        complete={completeSettings}
        error={"error" in parsed && parsed.at !== null ? { from: parsed.at, to: parsed.at + 1 } : null}
        className="es-settings-editor"
        ariaLabel={t("바꿀 설정")}
        autoFocus
      />
      <FieldError id="es-settings-error" error={problem} />
      {"body" in parsed && parsed.statics.length > 0 ? (
        <div className="mg-verdict warn">{t("{keys}은(는) 정적 설정이라 닫힌 인덱스에서만 바꿀 수 있습니다. 인덱스를 닫고 바꾼 뒤 다시 여세요.", { keys: parsed.statics.join(", ") })}</div>
      ) : (
        <div className="es-hint panel-dim">{t("샤드 수, codec, 분석기 같은 정적 설정은 닫힌 인덱스에서만 바꿀 수 있습니다.")}</div>
      )}
      <div className="mg-form-label">{t("보낼 요청")}</div>
      <pre className="panel-pre mg-ix-preview">{command !== null ? <ConsoleText text={command} /> : <span className="panel-dim">—</span>}</pre>
      {failure !== null ? <ErrorNotice error={failure} context="structure" engine="elasticsearch" variant="compact" /> : null}
    </AdminModal>
  );
}
