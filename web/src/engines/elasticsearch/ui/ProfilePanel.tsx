// The 실행 계획 sub-tab of an index tab: the 문서 tab's search run with the
// Profile API. Per shard the Lucene query tree the DSL became (each node's
// time, its share of the shard's query time, and on opening the breakdown:
// build_scorer, next_doc, score…), the rewrite time, the collectors, the
// aggregations and the fetch phase, with the slowest node marked. Beside it
// `_validate/query` says whether the query is valid and how it was
// rewritten. The raw profile is a toggle away.

import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { ChevronIcon } from "../../../components/icons";
import { Select } from "../../../components/Select";
import { LoadingState } from "../../../components/Spinner";
import { t } from "../../../i18n";
import { stringifyJson } from "../../mongodb/bson";
import { PlanIcon } from "../../mongodb/ui/icons";
import { isAbort, profile, validateQuery } from "../api";
import { list, rec, str, type Json } from "../json";
import { msText, parseProfile, type CollectorNode, type ProfileNode, type ShardProfile } from "../profile";
import { ConsoleText, requestText } from "./common";
import { RawJson } from "./MappingPanel";
import type { ProfilePanelProps } from "./types";
import "../../mongodb/mongodb.css";
import "../../mongodb/ui/panels.css";
import "./panels.css";

// Hits fetched with the profile: enough to profile the fetch phase, no more.
const PROFILE_SIZE = 10;

interface Validation {
  valid: boolean;
  error: string | null;
  // The rewritten Lucene query, per index (identical ones once).
  explanations: { index: string; text: string }[];
}

type Outcome = { shards: ShardProfile[]; raw: unknown; took: number | null; validation: Validation | { failure: unknown } } | { error: unknown };

// The last profile of each index tab and the run request it answered; the
// profile runs the search again, so coming back with the same query shows
// this instead.
interface Profiled {
  command: string;
  runSeq: number;
  outcome: Outcome;
}
const lastProfiled = new Map<string, Profiled>();

function validationOf(raw: Record<string, unknown>): Validation {
  const seen = new Set<string>();
  const explanations: Validation["explanations"] = [];
  for (const e of list(raw.explanations)) {
    const r = rec(e);
    const text = str(r.explanation) || str(r.error);
    if (text !== "" && !seen.has(text)) {
      seen.add(text);
      explanations.push({ index: str(r.index), text });
    }
  }
  return { valid: raw.valid === true, error: raw.error ? str(raw.error) : null, explanations };
}

function Breakdown({ node }: { node: ProfileNode }) {
  const steps = node.breakdown.filter((s) => s.ms > 0 || (s.count ?? 0) > 0);
  return (
    <div className="es-pbreak">
      {steps.length === 0 ? (
        <span className="panel-dim">{t("나눠 잰 시간이 없습니다")}</span>
      ) : (
        <table className="panel-table">
          <tbody>
            {steps.map((s) => (
              <tr key={s.key}>
                <td className="mono">{s.key}</td>
                <td className="num mono">{msText(s.ms)}</td>
                <td className="num mono panel-dim">{s.count !== null ? t("{count}회", { count: s.count.toLocaleString() }) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {node.debug !== null ? (
        <pre className="panel-pre es-pdebug">
          <ConsoleText text={stringifyJson(node.debug, 2)} />
        </pre>
      ) : null}
    </div>
  );
}

function Bar({ share }: { share: number }) {
  const pct = Math.max(0, Math.min(100, share * 100));
  return (
    <>
      <span className="es-pbar" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className="es-ppct mono">{pct < 0.1 && pct > 0 ? "<0.1%" : `${pct.toFixed(1)}%`}</span>
    </>
  );
}

function NodeRow({ node, total, depth, slowest }: { node: ProfileNode; total: number; depth: number; slowest: ProfileNode | null }) {
  const [open, setOpen] = useState(false);
  const slow = node === slowest && node.selfMs > 0;
  return (
    <>
      <div className={`es-prow${slow ? " slow" : ""}`} style={{ paddingLeft: 6 + depth * 18 }}>
        <button type="button" className={`es-fchev${open ? " open" : ""}`} aria-expanded={open} aria-label={t("시간 나눠 보기")} title={t("시간 나눠 보기")} onClick={() => setOpen((v) => !v)}>
          <ChevronIcon size={9} />
        </button>
        <span className="es-ptype mono">{node.type}</span>
        <span className="es-pdesc mono" title={node.description}>
          {node.description}
        </span>
        {slow ? (
          <span className="es-chip warn" title={t("자기 시간(하위 노드를 뺀 시간) {time}", { time: msText(node.selfMs) })}>
            {t("가장 느림")}
          </span>
        ) : null}
        <Bar share={total > 0 ? node.timeMs / total : 0} />
        <span className="es-ptime mono">{msText(node.timeMs)}</span>
      </div>
      {open ? (
        <div style={{ paddingLeft: 30 + depth * 18 }}>
          <Breakdown node={node} />
        </div>
      ) : null}
      {node.children.map((child, i) => (
        <NodeRow key={i} node={child} total={total} depth={depth + 1} slowest={slowest} />
      ))}
    </>
  );
}

function CollectorRow({ node, total, depth }: { node: CollectorNode; total: number; depth: number }) {
  return (
    <>
      <div className="es-prow" style={{ paddingLeft: 24 + depth * 18 }}>
        <span className="es-ptype mono">{node.name}</span>
        <span className="es-pdesc panel-dim mono">{node.reason}</span>
        <Bar share={total > 0 ? node.timeMs / total : 0} />
        <span className="es-ptime mono">{msText(node.timeMs)}</span>
      </div>
      {node.children.map((child, i) => (
        <CollectorRow key={i} node={child} total={total} depth={depth + 1} />
      ))}
    </>
  );
}

function ShardView({ shard }: { shard: ShardProfile }) {
  return (
    <>
      {shard.searches.map((search, i) => {
        const collectorTotal = search.collectors.reduce((sum, c) => sum + c.timeMs, 0);
        return (
          <div key={i}>
            <section className="structure-section es-psection">
              <div className="structure-section-head">
                <span className="structure-section-title">{shard.searches.length > 1 ? t("쿼리 (검색 {n})", { n: i + 1 }) : t("쿼리")}</span>
                <span className="panel-dim">{t("다시 쓰기 {time}", { time: msText(search.rewriteMs) })}</span>
              </div>
              <div className="es-ptree">
                {search.query.map((node, j) => (
                  <NodeRow key={j} node={node} total={shard.queryMs} depth={0} slowest={shard.slowest} />
                ))}
              </div>
            </section>
            {search.collectors.length > 0 ? (
              <section className="structure-section es-psection">
                <div className="structure-section-head">
                  <span className="structure-section-title">{t("수집기")}</span>
                  <span className="panel-dim">{msText(collectorTotal)}</span>
                </div>
                <div className="es-ptree">
                  {search.collectors.map((node, j) => (
                    <CollectorRow key={j} node={node} total={collectorTotal} depth={0} />
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        );
      })}
      {shard.aggregations.length > 0 ? (
        <section className="structure-section es-psection">
          <div className="structure-section-head">
            <span className="structure-section-title">{t("집계")}</span>
            <span className="panel-dim">{msText(shard.aggregationMs)}</span>
          </div>
          <div className="es-ptree">
            {shard.aggregations.map((node, j) => (
              <NodeRow key={j} node={node} total={shard.aggregationMs} depth={0} slowest={null} />
            ))}
          </div>
        </section>
      ) : null}
      {shard.fetch !== null ? (
        <section className="structure-section es-psection">
          <div className="structure-section-head">
            <span className="structure-section-title">{t("가져오기 (fetch)")}</span>
            <span className="panel-dim">{msText(shard.fetchMs)}</span>
          </div>
          <div className="es-ptree">
            <NodeRow node={shard.fetch} total={shard.fetchMs} depth={0} slowest={null} />
          </div>
        </section>
      ) : null}
    </>
  );
}

function shardLabel(shard: ShardProfile): string {
  return `[${shard.index}][${shard.shard ?? "?"}]${shard.node !== "" ? ` ${shard.node}` : ""} — ${msText(shard.queryMs + shard.aggregationMs + shard.fetchMs)}`;
}

export function ProfilePanel({ host, index, query, active, runSeq, refreshSeq }: ProfilePanelProps) {
  const key = `${host.conn}\u0000${index}`;
  const [shown, setShown] = useState<Profiled | null>(() => lastProfiled.get(key) ?? null);
  const [loading, setLoading] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [ownSeq, setOwnSeq] = useState(0);
  const [pickedShard, setPickedShard] = useState<string | null>(null);
  const body = "error" in query ? null : query.body;
  const command = body === null ? null : stringifyJson(body);
  // Read when a run starts, so typing in the query bar never starts one.
  const latest = useRef({ body, command, runSeq });
  latest.current = { body, command, runSeq };
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  function runProfile(): void {
    const { body: cur, command: text, runSeq: seq } = latest.current;
    if (cur === null || text === null) {
      return;
    }
    controller.current?.abort();
    const ctl = new AbortController();
    controller.current = ctl;
    setLoading(true);
    const settle = (outcome: Outcome): void => {
      const entry = { command: text, runSeq: seq, outcome };
      lastProfiled.set(key, entry);
      setShown(entry);
      setPickedShard(null);
      setLoading(false);
    };
    const asked = rec(cur).size;
    const size = typeof asked === "number" ? Math.min(asked, PROFILE_SIZE) : PROFILE_SIZE;
    const lucene = (rec(cur).query ?? { match_all: {} }) as Json;
    Promise.all([
      profile(host.conn, { index, body: cur, size, source: false }, ctl.signal),
      validateQuery(host.conn, index, lucene, ctl.signal).then(
        (raw): Validation | { failure: unknown } => validationOf(raw),
        (e: unknown): { failure: unknown } => ({ failure: e }),
      ),
    ]).then(
      ([result, validation]) => settle({ shards: parseProfile(result.profile), raw: result.profile, took: result.took, validation }),
      (e: unknown) => {
        if (!isAbort(e)) {
          settle({ error: e });
        }
      },
    );
  }

  // Opening the tab runs the query unless its profile is already on show and
  // no run was asked for since (계획 and ⌘↩ bump runSeq); after that only
  // run requests, F5 and 다시 실행 run it, never edits to the query.
  const opened = useRef(false);
  useEffect(() => {
    if (!active) {
      opened.current = false;
      return;
    }
    if (!opened.current) {
      opened.current = true;
      const last = lastProfiled.get(key);
      if (last === undefined || last.runSeq !== runSeq || last.command !== latest.current.command) {
        runProfile();
      }
      return;
    }
    runProfile();
  }, [active, key, runSeq, ownSeq, refreshSeq]);

  const outcome = shown?.outcome ?? null;
  const stale = shown !== null && command !== shown.command;
  const shards = outcome !== null && "shards" in outcome ? outcome.shards : [];
  const shard = useMemo(() => shards.find((s) => s.id === pickedShard) ?? shards[0] ?? null, [shards, pickedShard]);

  let content;
  if (outcome === null) {
    content = body === null ? <div className="panel-empty">{t("쿼리의 오류를 고치면 실행 계획을 봅니다")}</div> : <LoadingState />;
  } else if ("error" in outcome) {
    content = <ErrorNotice error={outcome.error} context="document" engine="elasticsearch" onRetry={body === null ? undefined : () => setOwnSeq((n) => n + 1)} />;
  } else if (showRaw) {
    content = <RawJson host={host} value={outcome.raw} label="profile" />;
  } else {
    const v = outcome.validation;
    const slowestShard = shards[0] ?? null;
    const cards: [string, string][] = [
      [t("걸린 시간 (took)"), outcome.took === null ? "—" : `${outcome.took.toLocaleString()} ms`],
      [t("샤드"), shards.length.toLocaleString()],
      [t("쿼리 시간 (가장 느린 샤드)"), slowestShard === null ? "—" : msText(slowestShard.queryMs)],
    ];
    if (slowestShard !== null && slowestShard.aggregationMs > 0) {
      cards.push([t("집계 시간"), msText(slowestShard.aggregationMs)]);
    }
    if (slowestShard !== null && slowestShard.fetchMs > 0) {
      cards.push([t("가져오기 시간"), msText(slowestShard.fetchMs)]);
    }
    content = (
      <div className={`es-profile${stale ? " stale" : ""}`}>
        <div className="es-psummary">
          {"failure" in v ? (
            <ErrorNotice error={v.failure} context="document" engine="elasticsearch" variant="compact" />
          ) : (
            <>
              <div className={`mg-verdict ${v.valid ? "ok" : "warn"}`}>{v.valid ? t("쿼리가 유효합니다") : v.error !== null ? t("쿼리가 유효하지 않습니다: {reason}", { reason: v.error }) : t("쿼리가 유효하지 않습니다")}</div>
              {v.explanations.map((e, i) => (
                <div key={i} className="es-rewrite">
                  <div className="mg-form-label">{v.explanations.length > 1 && e.index !== "" ? t("다시 쓴 Lucene 쿼리 · {index}", { index: e.index }) : t("다시 쓴 Lucene 쿼리")}</div>
                  <pre className="panel-pre mono">{e.text}</pre>
                </div>
              ))}
            </>
          )}
          <div className="info-cards mg-pcards">
            {cards.map(([name, value]) => (
              <div key={name} className="info-card">
                <div className="info-card-name">{name}</div>
                <div className="info-card-value">{value}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="es-pmain">
          {shards.length > 1 && shard !== null ? (
            <div className="es-pshards">
              <span className="mg-form-label">{t("샤드")}</span>
              <Select className="mg-input" value={shard.id} onChange={(event) => setPickedShard(event.target.value)}>
                {shards.map((s) => (
                  <option key={s.id} value={s.id}>
                    {shardLabel(s)}
                  </option>
                ))}
              </Select>
            </div>
          ) : shard !== null ? (
            <div className="es-pshards panel-dim mono">{shardLabel(shard)}</div>
          ) : null}
          {shard === null ? <div className="panel-empty">{t("프로필에 샤드가 없습니다")}</div> : <ShardView shard={shard} />}
        </div>
      </div>
    );
  }

  return (
    <div className="mg-pane es-pane">
      <div className="mg-agg-bar">
        <span className="mg-agg-count">{t("실행 계획")}</span>
        {shown !== null ? <span className="panel-dim mg-explain-cmd mono">{requestText("GET", `/${index}/_search`)}</span> : null}
        {stale && body !== null ? (
          <button type="button" className="mg-explain-stale" disabled={loading} onClick={() => setOwnSeq((n) => n + 1)}>
            {t("쿼리가 바뀌었습니다 · 다시 실행")}
          </button>
        ) : null}
        <span className="spacer" />
        {loading ? <span className="panel-dim">{t("계산 중…")}</span> : null}
        <button type="button" className={`mg-qbtn${showRaw ? " active" : ""}`} aria-pressed={showRaw} title={t("Profile API 결과 원문")} onClick={() => setShowRaw((v) => !v)}>
          {t("원문")}
        </button>
        <button type="button" className="primary mg-find" disabled={body === null || loading} onClick={() => setOwnSeq((n) => n + 1)}>
          <PlanIcon size={9} />
          {t("다시 실행")}
        </button>
      </div>
      <div className="es-body">
        {"error" in query ? <ErrorNotice error={query.error} context="editor" engine="elasticsearch" variant="compact" /> : null}
        {content}
      </div>
    </div>
  );
}
