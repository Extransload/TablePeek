// The 실행 계획 sub-tab (MONGODB.md §3.7): the query bar's find run with
// explain("executionStats") on the server, shown as the stage tree with each
// stage's counts, the totals and warnings beside it, the raw output on
// demand, and an index suggestion that opens the create dialog.

import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { PlusIcon } from "../../../components/icons";
import { LoadingState } from "../../../components/Spinner";
import { t } from "../../../i18n";
import { explain, isAbort } from "../api";
import type { BsonDocument } from "../bson";
import { summarizeExplain, suggestIndex, type PlanStage, type PlanSummary } from "../explain";
import { shellCollection, toShell, toShellPretty } from "../format";
import { PlanIcon } from "./icons";
import { ShellText } from "./ShellText";
import type { DocQuery, ExplainPanelProps } from "./types";
import "./panels.css";

// What each stage does, for the line beside its name.
const STAGE_TEXT: Record<string, string> = {
  COLLSCAN: "컬렉션의 모든 문서를 훑습니다",
  IXSCAN: "인덱스에서 범위만 읽습니다",
  FETCH: "인덱스가 가리킨 문서를 가져옵니다",
  SORT: "메모리에서 정렬합니다 (인덱스로 정렬하지 못함)",
  SORT_KEY_GENERATOR: "정렬 키를 만듭니다",
  SKIP: "앞의 문서를 건너뜁니다",
  LIMIT: "개수를 자릅니다",
  PROJECTION_DEFAULT: "필드를 고릅니다",
  PROJECTION_SIMPLE: "필드를 고릅니다",
  PROJECTION_COVERED: "인덱스만으로 필드를 채웁니다",
  IDHACK: "_id로 바로 찾습니다",
  EXPRESS_IXSCAN: "인덱스로 문서 하나를 바로 찾습니다",
  OR: "여러 인덱스 결과를 합칩니다",
  SORT_MERGE: "정렬된 여러 입력을 합칩니다",
  COUNT_SCAN: "인덱스에서 개수만 셉니다",
  EOF: "읽을 것이 없습니다",
  SHARD_MERGE: "샤드 결과를 합칩니다",
  SINGLE_SHARD: "샤드 하나에서 읽습니다",
};

const OK_STAGES: Record<string, true> = { IXSCAN: true, IDHACK: true, EXPRESS_IXSCAN: true, COUNT_SCAN: true, PROJECTION_COVERED: true };

// The mongosh text of the explained find.
function findCommand(coll: string, q: DocQuery): string {
  let cmd = `${shellCollection(coll)}.find(${toShell(q.filter)}${q.projection ? `, ${toShell(q.projection)}` : ""})`;
  if (q.sort) {
    cmd += `.sort(${toShell(q.sort)})`;
  }
  if (q.skip > 0) {
    cmd += `.skip(${q.skip})`;
  }
  if (q.limit > 0) {
    cmd += `.limit(${q.limit})`;
  }
  return `${cmd}.explain("executionStats")`;
}

function count(n: number | null): string {
  return n === null ? "—" : n.toLocaleString();
}

function StageBox({ stage }: { stage: PlanStage }) {
  const facts: { key: string; value: string; warn?: boolean }[] = [];
  if (stage.shard !== null) {
    facts.push({ key: t("샤드"), value: stage.shard });
  }
  facts.push({ key: t("반환"), value: count(stage.nReturned) });
  if (stage.keysExamined !== null) {
    facts.push({ key: t("검사한 키"), value: count(stage.keysExamined) });
  }
  if (stage.docsExamined !== null) {
    facts.push({ key: t("검사한 문서"), value: count(stage.docsExamined), warn: stage.stage === "COLLSCAN" });
  }
  if (stage.timeMs !== null) {
    facts.push({ key: t("시간"), value: `${stage.timeMs.toLocaleString()} ms` });
  }
  if (stage.indexName !== null) {
    facts.push({ key: t("인덱스"), value: stage.keyPattern ? `${stage.indexName}  ${toShell(stage.keyPattern)}` : stage.indexName });
  }
  if (stage.bounds.length > 0) {
    facts.push({ key: t("범위"), value: stage.bounds.map((b) => `${b.field}: ${b.intervals.join(", ")}`).join("  ") });
  }
  if (stage.direction !== null && stage.indexName !== null) {
    facts.push({ key: t("방향"), value: stage.direction === "forward" ? t("앞으로") : t("뒤로") });
  }
  if (stage.multiKey) {
    facts.push({ key: t("다중 키"), value: t("예") });
  }
  if (stage.filter) {
    facts.push({ key: t("필터"), value: toShell(stage.filter) });
  }
  if (stage.sortPattern) {
    facts.push({ key: t("정렬"), value: toShell(stage.sortPattern), warn: stage.stage === "SORT" });
  }
  if (stage.usedDisk) {
    facts.push({ key: t("디스크"), value: t("정렬에 디스크를 썼습니다"), warn: true });
  }
  if (stage.skipAmount !== null) {
    facts.push({ key: t("건너뛰기"), value: count(stage.skipAmount) });
  }
  if (stage.limitAmount !== null) {
    facts.push({ key: t("개수"), value: count(stage.limitAmount) });
  }
  if (stage.transformBy) {
    facts.push({ key: t("프로젝션"), value: toShell(stage.transformBy) });
  }
  const tone = stage.stage === "COLLSCAN" || stage.stage === "SORT" ? " warn" : Object.hasOwn(OK_STAGES, stage.stage) ? " ok" : "";
  const text = STAGE_TEXT[stage.stage];
  return (
    <div className={`mg-pstage${tone}`}>
      <div className="mg-pstage-head">
        <span className="mg-pstage-name mono">{stage.stage}</span>
        <span className="panel-dim">{text !== undefined ? t(text) : ""}</span>
      </div>
      <div className="mg-pfacts">
        {facts.map((fact) => (
          <div key={fact.key} className={`mg-pfact${fact.warn ? " warn" : ""}`}>
            <span className="mg-pfact-k">{fact.key}</span>
            <span className="mg-pfact-v mono">{fact.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// A stage above its inputs: results flow up from the leaves. The 집계 tab
// shows a pipeline's plan with it too.
export function StageTree({ stage }: { stage: PlanStage }) {
  return (
    <div className="mg-pnode">
      <StageBox stage={stage} />
      {stage.children.length > 0 ? (
        <div className="mg-pchildren">
          {stage.children.map((child, i) => (
            <div key={i} className="mg-pchild">
              <div className="mg-parrow" aria-hidden="true">
                ▲
              </div>
              <StageTree stage={child} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Summary({ summary, query, coll, onCreateIndex }: { summary: PlanSummary; query: DocQuery; coll: string; onCreateIndex(keys: BsonDocument): void }) {
  const suggestion = useMemo(() => suggestIndex(query, summary), [query, summary]);
  const verdicts: { tone: "ok" | "warn"; text: string }[] = [];
  if (summary.indexes.length > 0) {
    verdicts.push({ tone: "ok", text: t("인덱스 {name}를 씁니다", { name: summary.indexes.join(", ") }) });
  }
  for (const warning of summary.warnings) {
    if (warning.kind === "collscan") {
      verdicts.push({ tone: "warn", text: t("인덱스 없이 컬렉션 전체를 훑습니다 (COLLSCAN)") });
    } else if (warning.kind === "sort") {
      verdicts.push({ tone: "warn", text: t("정렬을 메모리에서 합니다 — 정렬 필드가 들어간 인덱스가 있으면 피할 수 있습니다") });
    } else {
      verdicts.push({
        tone: "warn",
        text: t("돌려준 문서 {returned}개를 위해 {examined}개를 읽었습니다 ({ratio}배)", {
          returned: warning.returned.toLocaleString(),
          examined: warning.examined.toLocaleString(),
          ratio: warning.ratio.toFixed(1),
        }),
      });
    }
  }
  const cards: [string, string][] = [
    [t("돌려준 문서"), count(summary.nReturned)],
    [t("검사한 문서"), count(summary.docsExamined)],
    [t("검사한 인덱스 키"), count(summary.keysExamined)],
    [t("실행 시간"), summary.timeMs === null ? "—" : `${summary.timeMs.toLocaleString()} ms`],
    [t("사용 인덱스"), summary.indexes.length > 0 ? summary.indexes.join(", ") : t("없음")],
    [t("정렬"), summary.inMemorySort ? t("메모리") : query.sort ? t("인덱스") : "—"],
  ];
  if (summary.rejectedPlans > 0) {
    cards.push([t("버린 계획"), summary.rejectedPlans.toLocaleString()]);
  }
  return (
    <div className="mg-psummary">
      {verdicts.map((v, i) => (
        <div key={i} className={`mg-verdict ${v.tone}`}>
          {v.text}
        </div>
      ))}
      <div className="info-cards mg-pcards">
        {cards.map(([name, value]) => (
          <div key={name} className="info-card">
            <div className="info-card-name">{name}</div>
            <div className="info-card-value">{value}</div>
          </div>
        ))}
      </div>
      {suggestion !== null ? (
        <div className="mg-suggest">
          <div className="mg-suggest-head">{t("제안 (같음 → 정렬 → 범위)")}</div>
          <pre className="mg-suggest-code">
            <ShellText text={`${shellCollection(coll)}.createIndex(${toShell(suggestion)})`} />
          </pre>
          <button type="button" className="primary" onClick={() => onCreateIndex(suggestion)}>
            <PlusIcon size={9} />
            {t("이 인덱스 만들기…")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

type Outcome = { query: DocQuery; raw: BsonDocument; summary: PlanSummary } | { error: unknown };

// The last explain of each collection, and the run request it answered.
// explain("executionStats") runs the query on the server, so coming back to
// the tab with the same query shows this instead of running it again.
interface Explained {
  command: string;
  runSeq: number;
  outcome: Outcome;
}
const lastExplained = new Map<string, Explained>();

export function ExplainPanel({ ns, query, active, runSeq, onCreateIndex }: ExplainPanelProps) {
  const key = `${ns.conn}\u0000${ns.db}\u0000${ns.coll}`;
  const [shown, setShown] = useState<Explained | null>(() => lastExplained.get(key) ?? null);
  const [loading, setLoading] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [ownSeq, setOwnSeq] = useState(0);
  const q = "error" in query ? null : query;
  const command = q === null ? null : findCommand(ns.coll, q);
  // Read when a run starts, so typing in the query bar never starts one.
  const latest = useRef({ q, command, runSeq });
  latest.current = { q, command, runSeq };
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  function runExplain(): void {
    const { q: cur, command: text, runSeq: seq } = latest.current;
    if (cur === null || text === null) {
      return;
    }
    controller.current?.abort();
    const ctl = new AbortController();
    controller.current = ctl;
    setLoading(true);
    const settle = (outcome: Outcome): void => {
      const entry = { command: text, runSeq: seq, outcome };
      lastExplained.set(key, entry);
      setShown(entry);
      setLoading(false);
    };
    explain(
      ns,
      {
        find: {
          filter: cur.filter,
          projection: cur.projection,
          sort: cur.sort,
          skip: cur.skip > 0 ? cur.skip : null,
          limit: cur.limit > 0 ? cur.limit : null,
        },
      },
      "executionStats",
      ctl.signal,
    ).then(
      (raw) => settle({ query: cur, raw, summary: summarizeExplain(raw) }),
      (e: unknown) => {
        if (!isAbort(e)) {
          settle({ error: e });
        }
      },
    );
  }

  // Opening the tab runs the query unless its explain is already on show
  // and no run was asked for since (계획, ⌘↩ and 찾기 bump runSeq); after
  // that only run requests and 계획 다시 계산 run it, never edits to the text.
  const opened = useRef(false);
  useEffect(() => {
    if (!active) {
      opened.current = false;
      return;
    }
    if (!opened.current) {
      opened.current = true;
      const last = lastExplained.get(key);
      if (last === undefined || last.runSeq !== runSeq || last.command !== latest.current.command) {
        runExplain();
      }
      return;
    }
    runExplain();
  }, [active, key, runSeq, ownSeq]);

  const outcome = shown?.outcome ?? null;
  // The query bar no longer says what the plan on show explains.
  const stale = shown !== null && command !== shown.command;

  let body;
  if (outcome === null) {
    // A query that does not parse is shown at the query bar.
    body = q === null && "error" in query ? <div className="panel-empty">{t("쿼리의 오류를 고치면 실행 계획을 봅니다")}</div> : <LoadingState />;
  } else if ("error" in outcome) {
    body = <ErrorNotice error={outcome.error} context="document" engine="mongodb" />;
  } else if (showRaw) {
    body = (
      <pre className="panel-pre mg-explain-raw">
        <ShellText text={toShellPretty(outcome.raw)} />
      </pre>
    );
  } else {
    body = (
      <div className="mg-explain-grid">
        <div className="mg-ptree-wrap">
          <div className="mg-ptree-title panel-dim">{t("위에서 아래로: 결과 ← 입력")}</div>
          {outcome.summary.root !== null ? <StageTree stage={outcome.summary.root} /> : <div className="panel-empty">{t("계획에 단계가 없습니다")}</div>}
        </div>
        <Summary summary={outcome.summary} query={outcome.query} coll={ns.coll} onCreateIndex={onCreateIndex} />
      </div>
    );
  }

  return (
    <div className="mg-pane mg-explain">
      <div className="mg-agg-bar">
        <span className="mg-agg-count">{t("실행 계획")}</span>
        {shown !== null ? <ShellText className="panel-dim mg-explain-cmd mono" text={shown.command} /> : null}
        {stale ? (
          q === null && "error" in query ? (
            <span className="mg-explain-stale" role="status">
              {query.error}
            </span>
          ) : (
            <button type="button" className="mg-explain-stale" disabled={loading} onClick={() => setOwnSeq((n) => n + 1)}>
              {t("필터가 바뀌었습니다 · 다시 계산")}
            </button>
          )
        ) : null}
        <span className="spacer" />
        {loading ? <span className="panel-dim">{t("계산 중…")}</span> : null}
        <button
          type="button"
          className={`mg-qbtn${showRaw ? " active" : ""}`}
          aria-pressed={showRaw}
          title={t("explain() 결과 원문")}
          onClick={() => setShowRaw((v) => !v)}
        >
          {t("원문")}
        </button>
        <button type="button" className="primary mg-find" disabled={q === null} onClick={() => setOwnSeq((n) => n + 1)}>
          <PlanIcon size={9} />
          {t("계획 다시 계산")}
        </button>
      </div>
      <div className="mg-explain-body">{body}</div>
    </div>
  );
}
