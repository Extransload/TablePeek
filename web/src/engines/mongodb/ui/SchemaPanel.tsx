// The 스키마 sub-tab (MONGODB.md §6.2): a sample of the documents matching a
// filter (`$match` + `$sample`, 100 · 500 · 1,000) analysed field by field —
// the path tree with nested documents and the documents inside arrays, how
// many documents have each path, the type mix, and a summary per kind of
// value (histograms of numbers, dates and array lengths, frequent strings,
// boolean ratio, ObjectId creation times). Clicking a value or a bar filters
// the documents by it; the analysis exports as JSON and drafts a
// `$jsonSchema` for the 검증 tab.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { ChevronIcon, DownloadIcon, RefreshIcon, ShieldIcon } from "../../../components/icons";
import { LoadingState } from "../../../components/Spinner";
import { downloadBlob } from "../../../export";
import { t } from "../../../i18n";
import { aggregate, count, isAbort, type CountResult, type Namespace } from "../api";
import { BsonDate, Int32, ObjectId, type BsonDocument, type BsonTypeName, type BsonValue } from "../bson";
import { sampleFields, type CompletionContext } from "../complete";
import { shellCollection, toShell } from "../format";
import { SAMPLE_SIZES, analyzeSchema, draftJsonSchema, filterNumber, schemaExport, typesByCount, type SchemaAnalysis, type SchemaField } from "../schema";
import { parseFilter } from "../shell/parse";
import { MongoEditor } from "./MongoEditor";
import type { DocHost } from "./types";
import "./panels.css";
import "./schema.css";

export interface SchemaPanelProps {
  ns: Namespace;
  // The query bar's filter text; the analysis starts from it.
  filterText: string;
  // False while another sub-tab is in front.
  active: boolean;
  host: DocHost;
  // A clicked value or bar: `value` goes at `path` in the filter (a value,
  // or an operator document such as { $gte, $lt } or { $size }) and the
  // workbench shows the documents.
  onFilter(path: string, value: BsonValue): void;
  // "검증 규칙 초안": the workbench opens 검증 with this `$jsonSchema`.
  onDraft?(schema: BsonDocument): void;
}

interface Analysed {
  filter: BsonDocument;
  size: number;
  command: string;
  analysis: SchemaAnalysis;
  docs: BsonDocument[];
  elapsedMs: number;
  at: Date;
}

// What a collection's 스키마 tab shows, kept across remounts (the panel is
// mounted again each time its tab is shown).
interface SchemaMemory {
  // The query bar text the filter box was seeded from; a different one
  // seeds it again.
  seededFrom: string;
  filterText: string;
  size: number;
  open: Set<string>;
  shown: Analysed | { error: unknown } | null;
  matched: CountResult | null;
}

const memory = new Map<string, SchemaMemory>();

const HIST_W = 360;
const HIST_H = 64;

function percent(share: number): string {
  const pct = share * 100;
  return `${pct >= 99.95 ? "100" : pct > 0 && pct < 1 ? "<1" : pct.toFixed(pct < 10 ? 1 : 0)}%`;
}

function numberText(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function dayText(ms: number, withTime: boolean): string {
  const iso = new Date(ms).toISOString();
  return withTime ? iso.slice(0, 16).replace("T", " ") : iso.slice(0, 10);
}

interface Bar {
  count: number;
  label: string;
  onClick(): void;
}

// A small bar chart; each bar (and the full-height strip above it) filters
// by its range.
function Histogram({ bars, type, minLabel, maxLabel, extra }: { bars: Bar[]; type: BsonTypeName; minLabel: string; maxLabel: string; extra: string }) {
  const max = Math.max(1, ...bars.map((b) => b.count));
  const w = HIST_W / bars.length;
  return (
    <div className="mg-viz">
      <svg className={`mg-hist-svg t-${type}`} viewBox={`0 0 ${HIST_W} ${HIST_H}`} preserveAspectRatio="none" role="img" aria-label={`${minLabel} – ${maxLabel}`}>
        {bars.map((b, i) => {
          const h = b.count > 0 ? Math.max(2, (b.count / max) * (HIST_H - 4)) : 0;
          const title = t("{label} — {count}개 · 눌러서 거르기", { label: b.label, count: b.count.toLocaleString() });
          return (
            <g key={i} className="mg-hist-col" onClick={b.onClick}>
              <title>{title}</title>
              <rect className="mg-hist-hit" x={i * w} y={0} width={w} height={HIST_H} />
              <rect className="mg-hist-bar" x={i * w + 1} y={HIST_H - h} width={Math.max(1, w - 2)} height={h} rx={1.5} />
            </g>
          );
        })}
      </svg>
      <div className="mg-hist-axis">
        <span>{minLabel}</span>
        <span className="panel-dim">{extra}</span>
        <span>{maxLabel}</span>
      </div>
    </div>
  );
}

// Rows of label · bar · count, one per value.
function ValueBars({ rows, type }: { rows: { label: string; count: number; onClick(): void }[]; type: BsonTypeName }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className={`mg-hbars t-${type}`}>
      {rows.map((r) => (
        <button key={r.label} type="button" className="mg-hbar" title={t("{label} — {count}개 · 눌러서 거르기", { label: r.label, count: r.count.toLocaleString() })} onClick={r.onClick}>
          <span className="mg-hbar-label mono">{r.label}</span>
          <span className="mg-hbar-track">
            <span style={{ width: `${(r.count / max) * 100}%` }} />
          </span>
          <span className="mg-hbar-n">{r.count.toLocaleString()}</span>
        </button>
      ))}
    </div>
  );
}

// The summaries of a field, the kind seen most first.
function FieldViz({ field, onFilter }: { field: SchemaField; onFilter(path: string, value: BsonValue): void }) {
  const at = (value: BsonValue) => onFilter(field.path, value);
  const parts: { n: number; node: ReactNode }[] = [];
  const { number: num, date, string: str, objectId: oid, boolean: bool, array: arr } = field;
  if (arr) {
    const bars: Bar[] = arr.lengths.map((count, n) => ({ count, label: t("원소 {count}개", { count: n }), onClick: () => at({ $size: new Int32(n) }) }));
    if (arr.longer > 0) {
      const cap = arr.lengths.length - 1;
      bars.push({ count: arr.longer, label: t("원소 {count}개 넘게", { count: cap }), onClick: () => onFilter(`${field.path}.${cap}`, { $exists: true }) });
    }
    const elems = typesByCount(field.elemTypes).map(([type]) => type).join(", ");
    parts.push({
      n: arr.count,
      node: (
        <Histogram
          key="array"
          bars={bars}
          type="Array"
          minLabel={t("길이 {count}", { count: 0 })}
          maxLabel={t("길이 {count}", { count: arr.longer > 0 ? `${arr.lengths.length - 1}+` : arr.lengths.length - 1 })}
          extra={t("원소 타입: {types} · 평균 길이 {mean}", { types: elems || "—", mean: numberText(arr.meanLength) })}
        />
      ),
    });
  }
  if (num) {
    const exact = num.bins.every((b) => b.lo === b.hi);
    parts.push({
      n: num.count,
      node: (
        <Histogram
          key="number"
          bars={num.bins.map((b, i) => ({
            count: b.count,
            label: b.lo === b.hi ? numberText(b.lo) : `${numberText(b.lo)} ~ ${numberText(b.hi)}`,
            onClick: () => at(b.lo === b.hi ? filterNumber(b.lo) : { $gte: filterNumber(b.lo), [i === num.bins.length - 1 ? "$lte" : "$lt"]: filterNumber(b.hi) }),
          }))}
          type={typesByCount(field.types).find(([type]) => type === "Int32" || type === "Int64" || type === "Double" || type === "Decimal128")?.[0] ?? "Double"}
          minLabel={t("최소 {value}", { value: numberText(num.min) })}
          maxLabel={t("최대 {value}", { value: numberText(num.max) })}
          extra={exact ? t("서로 다른 값 {count}개", { count: num.distinct }) : t("평균 {mean} · 서로 다른 값 {count}개", { mean: numberText(num.mean), count: num.distinct.toLocaleString() })}
        />
      ),
    });
  }
  if (date) {
    const withTime = date.max - date.min < 2 * 86_400_000;
    parts.push({
      n: date.count,
      node: (
        <Histogram
          key="date"
          bars={date.bins.map((b, i) => ({
            count: b.count,
            label: `${dayText(b.lo, withTime)} ~ ${dayText(b.hi, withTime)}`,
            onClick: () => at({ $gte: new BsonDate(Math.floor(b.lo)), [i === date.bins.length - 1 ? "$lte" : "$lt"]: new BsonDate(Math.ceil(b.hi)) }),
          }))}
          type="Date"
          minLabel={dayText(date.min, withTime)}
          maxLabel={dayText(date.max, withTime)}
          extra={t("{count}개", { count: date.count.toLocaleString() })}
        />
      ),
    });
  }
  if (str) {
    const all = str.top.length === str.distinct;
    parts.push({
      n: str.count,
      node: (
        <div key="string" className="mg-viz">
          {all ? (
            <ValueBars type="String" rows={str.top.map((x) => ({ label: x.value === "" ? t("(빈 문자열)") : x.value, count: x.count, onClick: () => at(x.value) }))} />
          ) : (
            <>
              <div className="mg-viz-note">{t("서로 다른 값 {count}개 · 자주 나오는 값", { count: str.distinct.toLocaleString() })}</div>
              <div className="mg-chips">
                {str.top.slice(0, 10).map((x) => (
                  <button key={x.value} type="button" className="mg-vchip" title={t("{label} — {count}개 · 눌러서 거르기", { label: x.value, count: x.count.toLocaleString() })} onClick={() => at(x.value)}>
                    <span className="mg-vchip-v mono">{x.value === "" ? t("(빈 문자열)") : x.value.length > 28 ? `${x.value.slice(0, 28)}…` : x.value}</span>
                    <span className="mg-vchip-n">{x.count.toLocaleString()}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="mg-viz-note panel-dim">
            {str.minLength === str.maxLength
              ? t("길이 {count}자", { count: str.minLength })
              : t("길이 {min}–{max}자 · 평균 {mean}자", { min: str.minLength, max: str.maxLength, mean: numberText(str.meanLength) })}
          </div>
        </div>
      ),
    });
  }
  if (bool) {
    parts.push({
      n: bool.count,
      node: (
        <div key="boolean" className="mg-viz">
          <ValueBars
            type="Boolean"
            rows={[
              { label: "true", count: bool.trues, onClick: () => at(true) },
              { label: "false", count: bool.falses, onClick: () => at(false) },
            ]}
          />
          <div className="mg-viz-note panel-dim">{t("true {pct}", { pct: percent(bool.trues / bool.count) })}</div>
        </div>
      ),
    });
  }
  if (oid) {
    parts.push({
      n: oid.count,
      node: (
        <div key="oid" className="mg-viz">
          <div className="mg-viz-note">
            {t("고유 값 {distinct}개 / {count}개", { distinct: oid.distinct.toLocaleString(), count: oid.count.toLocaleString() })}
            <span className="panel-dim"> · {t("생성 시각 {from} ~ {to}", { from: dayText(oid.first, false), to: dayText(oid.last, false) })}</span>
          </div>
          <div className="mg-chips">
            {oid.examples.map((hex) => (
              <button key={hex} type="button" className="mg-vchip" title={t("{label} — 눌러서 거르기", { label: hex })} onClick={() => at(new ObjectId(hex))}>
                <span className="mg-vchip-v mono t-ObjectId">ObjectId('{hex}')</span>
              </button>
            ))}
          </div>
        </div>
      ),
    });
  }
  parts.sort((a, b) => b.n - a.n);
  const objects = field.types.Object;
  const notes: ReactNode[] = [];
  if (objects !== undefined && field.children.length > 0) {
    notes.push(
      <div key="object" className="mg-viz-note">
        {t("하위 필드 {count}개 — 왼쪽 ›를 눌러 펼치세요", { count: field.children.length })}
      </div>,
    );
  }
  if (parts.length === 0 && notes.length === 0) {
    notes.push(
      <div key="other" className="mg-viz-note">
        {typesByCount(field.types)
          .map(([type, n]) => t("{type} {count}개", { type, count: n.toLocaleString() }))
          .join(" · ")}
      </div>,
    );
  }
  return (
    <div className="mg-schema-viz">
      {notes}
      {parts.map((p) => p.node)}
    </div>
  );
}

function FieldRow({ field, sampleSize, open, onToggle, onFilter }: { field: SchemaField; sampleSize: number; open: boolean; onToggle(): void; onFilter(path: string, value: BsonValue): void }) {
  const types = typesByCount(field.types);
  const total = types.reduce((n, [, c]) => n + c, 0) || 1;
  const missing = sampleSize - field.count;
  return (
    <div className="mg-sfield">
      <div className="mg-schema-left" style={{ paddingLeft: field.depth * 18 }}>
        <div className="mg-schema-name">
          {field.children.length > 0 ? (
            <button type="button" className={`mg-schema-toggle${open ? " open" : ""}`} title={open ? t("하위 필드 접기") : t("하위 필드 펼치기")} aria-expanded={open} onClick={onToggle}>
              <ChevronIcon size={9} />
            </button>
          ) : (
            <span className="mg-schema-space" />
          )}
          {field.parent !== null ? <span className="panel-dim mono">{field.parent}.</span> : null}
          <span className="mono">{field.name}</span>
        </div>
        <div className="mg-schema-types">
          {types.map(([type, n]) => (
            <span key={type} className={`mg-type t-${type}`}>
              {type}
              {types.length > 1 ? ` ${percent(n / total)}` : ""}
            </span>
          ))}
        </div>
        <div className="mg-typebar">
          {types.map(([type, n]) => (
            <span key={type} className={`t-${type}`} style={{ width: `${(n / total) * 100}%` }} title={`${type} ${percent(n / total)} (${n.toLocaleString()})`} />
          ))}
        </div>
        <div className="mg-schema-presence">
          <span className="mg-bar">
            <span style={{ width: `${Math.max(1, field.presence * 100)}%` }} />
          </span>
          <span className="panel-dim">
            {missing > 0
              ? t("있음 {pct} · 없음 {count}개", { pct: percent(field.presence), count: missing.toLocaleString() })
              : t("있음 {pct}", { pct: percent(field.presence) })}
          </span>
        </div>
      </div>
      <FieldViz field={field} onFilter={onFilter} />
    </div>
  );
}

export function SchemaPanel({ ns, filterText, active, host, onFilter, onDraft }: SchemaPanelProps) {
  const key = `${ns.conn}\u0000${ns.db}\u0000${ns.coll}`;
  const mem = useMemo(() => {
    let m = memory.get(key);
    if (m === undefined) {
      m = { seededFrom: filterText, filterText, size: 500, open: new Set(), shown: null, matched: null };
      memory.set(key, m);
    } else if (m.seededFrom !== filterText) {
      // The query bar moved on: analyse its filter afresh.
      m.seededFrom = filterText;
      m.filterText = filterText;
      m.shown = null;
      m.matched = null;
    }
    return m;
  }, [key, filterText]);
  const [text, setText] = useState(mem.filterText);
  const [size, setSize] = useState(mem.size);
  const [open, setOpen] = useState<Set<string>>(mem.open);
  const [shown, setShown] = useState(mem.shown);
  const [matched, setMatched] = useState(mem.matched);
  const [loading, setLoading] = useState(false);
  const parsed = useMemo(() => parseFilter(text), [text]);

  useEffect(() => {
    mem.filterText = text;
    mem.size = size;
    mem.open = open;
    mem.shown = shown;
    mem.matched = matched;
  }, [mem, text, size, open, shown, matched]);

  // Read when a run starts, so typing never starts one.
  const latest = useRef({ parsed, size });
  latest.current = { parsed, size };
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  function analyse(): void {
    const { parsed: p, size: n } = latest.current;
    if (!p.ok) {
      return;
    }
    const filter = p.value;
    controller.current?.abort();
    const ctl = new AbortController();
    controller.current = ctl;
    setLoading(true);
    setMatched(null);
    const command = `${shellCollection(ns.coll)}.aggregate([{ $match: ${toShell(filter)} }, { $sample: { size: ${n} } }])`;
    count(ns, filter, ctl.signal).then(setMatched, () => setMatched(null));
    aggregate(ns, [{ $match: filter }, { $sample: { size: new Int32(n) } }], undefined, ctl.signal).then(
      (batch) => {
        setShown({ filter, size: n, command, analysis: analyzeSchema(batch.docs), docs: batch.docs, elapsedMs: batch.elapsedMs, at: new Date() });
        setLoading(false);
      },
      (e: unknown) => {
        if (!isAbort(e)) {
          setShown({ error: e });
          setLoading(false);
        }
      },
    );
  }

  // The first time the tab is shown for a collection it analyses; after that
  // only 분석, Return in the filter box and a sample size change do.
  useEffect(() => {
    if (active && memory.get(key)?.shown == null && !loading) {
      analyse();
    }
  }, [active, key]);

  const sampled = useMemo(() => sampleFields(shown !== null && "docs" in shown ? shown.docs : []), [shown]);
  const completionRef = useRef<CompletionContext>({ fields: sampled });
  completionRef.current = { fields: sampled };

  const toggle = (path: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const result = shown !== null && "analysis" in shown ? shown : null;
  const analysis = result?.analysis ?? null;

  let body;
  if (shown === null) {
    body = loading ? <LoadingState /> : !parsed.ok ? <ErrorNotice error={parsed.error.message} context="document" engine="mongodb" /> : null;
  } else if ("error" in shown) {
    body = <ErrorNotice error={shown.error} context="document" engine="mongodb" />;
  } else if (shown.analysis.sampleSize === 0) {
    body = <div className="panel-empty">{t("필터와 맞는 문서가 없습니다")}</div>;
  } else {
    const a = shown.analysis;
    const rows: ReactNode[] = [];
    const walk = (paths: string[]) => {
      for (const path of paths) {
        const f = a.fields.get(path);
        if (!f) {
          continue;
        }
        const isOpen = open.has(path);
        rows.push(<FieldRow key={path} field={f} sampleSize={a.sampleSize} open={isOpen} onToggle={() => toggle(path)} onFilter={onFilter} />);
        if (isOpen) {
          walk(f.children);
        }
      }
    };
    walk(a.roots);
    body = rows;
  }

  let summary = "";
  if (result !== null) {
    const fieldCount = result.analysis.fields.size;
    const sample = result.analysis.sampleSize.toLocaleString();
    summary =
      matched !== null && matched.count !== null
        ? t("일치 {matched}개 중 {sample}개 분석 · 필드 {fields}개 · {ms} ms", { matched: `${matched.exact ? "" : "≈ "}${matched.count.toLocaleString()}`, sample, fields: fieldCount, ms: Math.round(result.elapsedMs) })
        : t("{sample}개 분석 · 필드 {fields}개 · {ms} ms", { sample, fields: fieldCount, ms: Math.round(result.elapsedMs) });
  }

  return (
    <div className="mg-pane mg-schema">
      <div className="mg-agg-bar mg-schema-bar">
        <span className="mg-agg-count">{t("필터")}</span>
        <MongoEditor
          value={text}
          onChange={setText}
          onRun={analyse}
          role="filter"
          singleLine
          completion={() => completionRef.current}
          placeholder={t("{ } 모든 문서 · 예: status: \"paid\"")}
          error={parsed.ok ? null : { from: parsed.error.from, to: parsed.error.to }}
          className={`mg-schema-filter${parsed.ok ? "" : " invalid"}`}
          ariaLabel={t("스키마 분석 필터")}
        />
        <span className="mg-agg-count">{t("표본")}</span>
        <div className="view-tabs mg-schema-sizes" role="group" aria-label={t("표본 크기")}>
          {SAMPLE_SIZES.map((n) => (
            <button
              key={n}
              type="button"
              className={n === size ? "active" : undefined}
              aria-pressed={n === size}
              onClick={() => {
                setSize(n);
                latest.current = { parsed, size: n };
                analyse();
              }}
            >
              {n.toLocaleString()}
            </button>
          ))}
        </div>
        <button type="button" className="primary mg-find" disabled={!parsed.ok || loading} onClick={analyse}>
          <RefreshIcon size={9} />
          {t("분석")}
        </button>
      </div>
      <div className="mg-agg-bar mg-schema-sub">
        <span className="panel-dim mg-schema-sum" title={result?.command}>
          {loading ? t("분석 중…") : summary}
        </span>
        <span className="spacer" />
        <span className="panel-dim">{t("값이나 막대를 누르면 그 값으로 문서를 거릅니다")}</span>
        {onDraft !== undefined ? (
          <button type="button" className="mg-qbtn" disabled={analysis === null || analysis.sampleSize === 0} title={t("이 분석으로 $jsonSchema 검증 규칙 초안을 만들어 검증 탭에서 엽니다")} onClick={() => analysis !== null && onDraft(draftJsonSchema(analysis))}>
            <ShieldIcon size={10} />
            {t("검증 규칙 초안")}
          </button>
        ) : null}
        <button
          type="button"
          className="mg-qbtn"
          disabled={result === null}
          title={t("분석 결과를 JSON 파일로 저장")}
          onClick={() => {
            if (result === null) {
              return;
            }
            downloadBlob(`${ns.coll}-schema.json`, schemaExport(result.analysis, { db: ns.db, coll: ns.coll, filter: result.filter, at: result.at }), "application/json");
            host.notify(t("{name}을 저장했습니다", { name: `${ns.coll}-schema.json` }));
          }}
        >
          <DownloadIcon size={10} />
          {t("JSON 내보내기")}
        </button>
      </div>
      <div className="mg-schema-list">{body}</div>
    </div>
  );
}
