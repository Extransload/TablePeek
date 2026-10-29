// The 집계 sub-tab (MONGODB.md §6.2): the pipeline as stage cards stacked
// top to bottom. Each card has its operator (picked from a searchable list
// with what it does and a starting template), a code editor with
// completion, an on/off switch, a grip to drag it elsewhere, duplicate and
// delete, and beside the editor the first 10 documents the pipeline gives up
// to that stage — asked for again 0.6 s after an edit, stale requests
// aborted, errors on the card. A text mode edits the whole array and comes
// back to the cards. Pipelines are saved per collection, turned into driver
// or mongosh code (코드로), saved as a view, explained, exported and run (`$out`/`$merge` after
// the safe-mode confirmation) with the result in the ☰ / {} / ⊞ views.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { ErrorNotice, FieldError, fieldErrorProps, notifyError } from "../../../components/ErrorNotice";
import { ChevronDownIcon, CloseIcon, CodeIcon, DownloadIcon, HistoryIcon, PlayIcon, PlusIcon, RefreshIcon, TableIcon, TrashIcon } from "../../../components/icons";
import { Spinner } from "../../../components/Spinner";
import { useMenuDismiss } from "../../../components/useMenuDismiss";
import { t } from "../../../i18n";
import { aggregate, command, explain, isAbort, listCollections, type Namespace } from "../api";
import { bsonDoc, compareForSort, Int32, stringifyJson, toEJSON, type BsonDocument } from "../bson";
import { STAGES, sampleFields, type CompletionContext, type FieldStat } from "../complete";
import { summarizeExplain, type PlanSummary } from "../explain";
import { toShell, toShellPretty } from "../format";
import {
  WRITE_STAGES,
  aggregateCode,
  buildPipeline,
  leadingQuery,
  newStage,
  parseStage,
  pipelineText,
  savedPipelines,
  stageOp,
  stageTemplate,
  stagesFromText,
  writeSavedPipelines,
  writeTarget,
  type AggDraft,
  type SavedPipeline,
  type Stage,
} from "../pipeline";
import type { ShellError } from "../shell/parse";
import { CardView } from "./CardView";
import { CodeExportModal } from "./CodeExportModal";
import { useEscape } from "./DocModals";
import { DocTableView } from "./DocTableView";
import { ExportModal } from "./ExportModal";
import { StageTree, Summary } from "./ExplainPanel";
import { CloneIcon, CollapseIcon, ExpandIcon, PlanIcon } from "./icons";
import { JsonView, SyntaxErrorNotice } from "./JsonView";
import { MongoEditor } from "./MongoEditor";
import { ShellText } from "./ShellText";
import type { DocHost, DocQuery } from "./types";
import { ViewSwitch, type DocView } from "./ViewSwitch";
import "./panels.css";
import "./aggregation.css";

const PREVIEW_LIMIT = 10;
const PREVIEW_DELAY_MS = 600;
// Documents read from a collection to name its fields (templates, completion).
const SAMPLE_SIZE = 50;
// The drag data of a card's grip, so text dragged in an editor is not
// taken for a card.
const STAGE_DRAG_TYPE = "application/x-tablepeek-stage";

// A failed run says where the error is shown when a card or the text editor
// already shows it (`card` is its index), so it is not shown twice.
type Outcome =
  | { kind: "docs"; docs: BsonDocument[]; elapsedMs: number; wrote: string | null }
  | { kind: "plan"; raw: BsonDocument; summary: PlanSummary; query: DocQuery; withoutWrite: boolean }
  | { kind: "error"; error: unknown; shownAt: { card: number } | "text" | null };

// The last result, its view and the saved pipeline's name, kept per tab
// across sub-tab switches (the pipeline itself lives with the tab).
interface AggMemory {
  outcome: Outcome | null;
  view: DocView;
  name: string;
}

const memory = new Map<string, AggMemory>();

// A preview request's answer, by the pipeline it ran.
type Fetched = { docs: BsonDocument[]; elapsedMs: number } | { error: unknown };

// What a card shows beside its editor.
type Preview =
  | { kind: "off" }
  | { kind: "invalid"; message: string }
  | { kind: "blocked" }
  | { kind: "write"; target: string }
  | { kind: "after-write" }
  | { kind: "loading"; last: Fetched | null }
  | { kind: "fetched"; fetched: Fetched };

// Each card's pipeline up to it (null when it is not previewed) and what it
// shows when that does not depend on the server.
interface StagePlan {
  key: string | null;
  pipeline: BsonDocument[] | null;
  fixed: Preview | null;
  error: ShellError | null;
}

function planStages(stages: Stage[]): StagePlan[] {
  const out: StagePlan[] = [];
  const prefix: BsonDocument[] = [];
  let broken = false;
  let wrote = false;
  for (const stage of stages) {
    if (!stage.on) {
      out.push({ key: null, pipeline: null, fixed: { kind: "off" }, error: null });
      continue;
    }
    const checked = parseStage(stage);
    if (!checked.ok) {
      broken = true;
      out.push({ key: null, pipeline: null, fixed: { kind: "invalid", message: checked.error.message }, error: checked.error });
      continue;
    }
    if (broken || wrote) {
      out.push({ key: null, pipeline: null, fixed: { kind: broken ? "blocked" : "after-write" }, error: null });
      continue;
    }
    if (WRITE_STAGES.includes(stage.op)) {
      wrote = true;
      out.push({ key: null, pipeline: null, fixed: { kind: "write", target: writeTarget(checked.stage) ?? "" }, error: null });
      continue;
    }
    prefix.push(checked.stage);
    const pipeline = [...prefix];
    out.push({ key: stringifyJson(pipeline.map(toEJSON)), pipeline, fixed: null, error: null });
  }
  return out;
}

export interface AggregationPanelProps {
  ns: Namespace;
  connKey: string;
  // The collection tab, so results survive switching sub-tabs.
  tabKey: string;
  // The pipeline being edited, kept with the tab (restored after a page
  // reload); every change is handed back.
  draft?: AggDraft;
  onDraftChange(draft: AggDraft): void;
  // Collection names of the database ($lookup completion).
  collections?: string[];
  maxTimeMS?: number;
  host: DocHost;
  // The ⊞ result view's detail panel (App owns its toggle).
  panelOpen: boolean;
  onPanelOpenChange(open: boolean): void;
  // The plan's index suggestion: switch to 인덱스 with the dialog open.
  onCreateIndex(keys: BsonDocument): void;
  // A view was made or a $out/$merge wrote: the sidebar reads again.
  onCollectionsChanged?(): void;
  onOpenCollection?(db: string, coll: string, view: boolean): void;
  onOpenShell?(db: string, text: string): void;
  // Bumped by the app's refresh (F5): previews are asked for again.
  refreshSeq: number;
}

export function AggregationPanel({ ns, connKey, tabKey, draft, onDraftChange, collections, maxTimeMS, host, panelOpen, onPanelOpenChange, onCreateIndex, onCollectionsChanged, onOpenCollection, onOpenShell, refreshSeq }: AggregationPanelProps) {
  const nsText = `${ns.db}.${ns.coll}`;
  const remembered = memory.get(tabKey);
  const [stages, setStages] = useState<Stage[]>(() => {
    // A stored draft may come from an older page: keep only well-formed stages.
    const kept = (draft?.stages ?? []).filter((s) => typeof s?.op === "string" && typeof s.text === "string");
    return draft !== undefined ? kept.map((s) => newStage(s.op, s.text, s.on !== false)) : [newStage("$match", "{ }")];
  });
  const [mode, setMode] = useState<"stages" | "text">(draft?.mode === "text" ? "text" : "stages");
  const [text, setText] = useState(typeof draft?.text === "string" ? draft.text : "");
  const [textError, setTextError] = useState<ShellError | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(remembered?.outcome ?? null);
  const [view, setView] = useState<DocView>(remembered?.view ?? "cards");
  const [name, setName] = useState(remembered?.name ?? "");
  const [running, setRunning] = useState<"run" | "explain" | null>(null);
  const [allOpen, setAllOpen] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [tableSort, setTableSort] = useState<BsonDocument | null>(null);
  const [tablePath, setTablePath] = useState<string[]>([]);
  const [picker, setPicker] = useState<{ x: number; y: number; at: number; replace: number | null } | null>(null);
  const [shelfOpen, setShelfOpen] = useState(false);
  const [dialog, setDialog] = useState<"code" | "view" | "export" | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<{ id: number; after: boolean } | null>(null);

  useEffect(() => {
    memory.set(tabKey, { outcome, view, name });
  }, [tabKey, outcome, view, name]);

  // Hands the draft to the tab when it changed (not on mount).
  const draftSent = useRef<string | null>(null);
  useEffect(() => {
    const next: AggDraft = { stages: stages.map(({ op, text: body, on }) => ({ op, text: body, on })), mode, text };
    const json = JSON.stringify(next);
    if (draftSent.current !== null && draftSent.current !== json) {
      onDraftChange(next);
    }
    draftSent.current = json;
  }, [stages, mode, text, onDraftChange]);

  // ---- Previews ----

  const plans = useMemo(() => planStages(stages), [stages]);
  const wanted = plans.flatMap((p) => (p.key === null ? [] : [p.key]));
  const wantedKey = wanted.join("\u0000");
  const [fetched, setFetched] = useState<Record<string, Fetched>>({});
  const fetchedRef = useRef(fetched);
  fetchedRef.current = fetched;
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;
  const [previewSeq, setPreviewSeq] = useState(0);
  // The first previews (and those after a refresh) go out at once; later
  // ones wait until typing pauses.
  const immediate = useRef(true);
  // The last answer each card showed, kept on screen while its new
  // preview loads.
  const lastShown = useRef(new Map<number, Fetched>());

  useEffect(() => {
    if (mode !== "stages") {
      return;
    }
    const missing = plans.filter((p) => p.key !== null && !Object.hasOwn(fetchedRef.current, p.key));
    if (missing.length === 0) {
      return;
    }
    const controller = new AbortController();
    const settle = (key: string, value: Fetched) =>
      setFetched((prev) => {
        // Only answers for pipelines still on screen are kept.
        const next: Record<string, Fetched> = {};
        for (const k of wantedRef.current) {
          if (Object.hasOwn(prev, k)) {
            next[k] = prev[k];
          }
        }
        next[key] = value;
        return next;
      });
    const timer = window.setTimeout(
      () => {
        for (const plan of missing) {
          const key = plan.key as string;
          aggregate(ns, [...(plan.pipeline ?? []), bsonDoc({ $limit: new Int32(PREVIEW_LIMIT) })], maxTimeMS, controller.signal).then(
            (batch) => settle(key, { docs: batch.docs, elapsedMs: batch.elapsedMs }),
            (error: unknown) => {
              if (!isAbort(error)) {
                settle(key, { error });
              }
            },
          );
        }
      },
      immediate.current ? 0 : PREVIEW_DELAY_MS,
    );
    immediate.current = false;
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // `plans` follows `wantedKey`; the rest restart the requests.
  }, [wantedKey, mode, ns, maxTimeMS, previewSeq]);

  const refreshPreviews = useCallback(() => {
    immediate.current = true;
    setFetched({});
    setPreviewSeq((n) => n + 1);
  }, []);

  const firstRefresh = useRef(refreshSeq);
  useEffect(() => {
    if (refreshSeq !== firstRefresh.current) {
      refreshPreviews();
    }
  }, [refreshSeq, refreshPreviews]);

  // What each card shows; a stage after one the server refused says so
  // instead of repeating the same error.
  const previews: Preview[] = [];
  let failedBefore = false;
  for (const [i, plan] of plans.entries()) {
    const id = stages[i].id;
    if (plan.fixed !== null) {
      previews.push(plan.fixed);
      continue;
    }
    if (failedBefore) {
      previews.push({ kind: "blocked" });
      continue;
    }
    const answer = plan.key !== null ? fetched[plan.key] : undefined;
    if (answer === undefined) {
      previews.push({ kind: "loading", last: lastShown.current.get(id) ?? null });
      continue;
    }
    lastShown.current.set(id, answer);
    failedBefore = "error" in answer;
    previews.push({ kind: "fetched", fetched: answer });
  }

  // ---- Fields (templates and completion) ----

  // A sample of the collection names the fields of the first stage's input.
  const [sample, setSample] = useState<FieldStat[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    aggregate(ns, [bsonDoc({ $limit: new Int32(SAMPLE_SIZE) })], maxTimeMS, controller.signal).then(
      (batch) => setSample(sampleFields(batch.docs)),
      () => undefined,
    );
    return () => controller.abort();
  }, [ns, maxTimeMS]);

  // The documents a stage receives: the preview of the nearest stage above
  // it that has one, else the collection's sample.
  const inputFields = (index: number): FieldStat[] => {
    for (let i = index - 1; i >= 0; i--) {
      const p = previews[i];
      if (p?.kind === "fetched" && "docs" in p.fetched && p.fetched.docs.length > 0) {
        return sampleFields(p.fetched.docs);
      }
      if (p?.kind === "loading" && p.last !== null && "docs" in p.last && p.last.docs.length > 0) {
        return sampleFields(p.last.docs);
      }
    }
    return sample;
  };
  const inputFieldsRef = useRef(inputFields);
  inputFieldsRef.current = inputFields;

  // Fields of other collections ($lookup's foreignField), sampled on first
  // use; completion asks again while the sample loads.
  const otherFields = useRef(new Map<string, FieldStat[] | null>());
  const fieldsOf = useCallback(
    (coll: string, db: string | null): FieldStat[] | null => {
      if (db !== null && db !== ns.db) {
        return null;
      }
      const known = otherFields.current.get(coll);
      if (known === undefined) {
        otherFields.current.set(coll, null);
        aggregate({ ...ns, coll }, [bsonDoc({ $limit: new Int32(SAMPLE_SIZE) })]).then(
          (batch) => otherFields.current.set(coll, sampleFields(batch.docs)),
          () => otherFields.current.delete(coll),
        );
      }
      return known ?? null;
    },
    [ns],
  );

  const completionFor = (index: number) => (): CompletionContext => ({ fields: inputFieldsRef.current(index), collections, fieldsOf });

  // ---- Editing the cards ----

  const patchStage = (id: number, patch: Partial<Stage>) => setStages((list) => list.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const pickOp = (op: string) => {
    if (picker === null) {
      return;
    }
    if (picker.replace !== null) {
      const index = picker.replace;
      const stage = stages[index];
      const fields = inputFields(index);
      // A body still as its template (or empty) follows the new operator.
      const untouched = stage.text.trim() === "" || stage.text.trim() === "{ }" || stage.text.trim() === stageTemplate(stage.op, fields, ns.coll).trim();
      patchStage(stage.id, { op, text: untouched ? stageTemplate(op, fields, ns.coll) : stage.text });
    } else {
      const stage = newStage(op, stageTemplate(op, inputFields(picker.at), ns.coll));
      setStages((list) => [...list.slice(0, picker.at), stage, ...list.slice(picker.at)]);
    }
    setPicker(null);
  };

  // The click that opens the list must not reach the list's outside-click
  // dismissal. Near the bottom of the window the list opens upwards.
  const openPicker = (event: ReactMouseEvent<HTMLElement>, at: number, replace: number | null) => {
    event.stopPropagation();
    const r = event.currentTarget.getBoundingClientRect();
    const height = 430;
    setPicker({ x: Math.min(r.left, window.innerWidth - 440), y: r.bottom + 4 + height > window.innerHeight ? Math.max(8, r.top - 4 - height) : r.bottom + 4, at, replace });
  };

  const moveStage = (fromId: number, toId: number, after: boolean) =>
    setStages((list) => {
      const moved = list.find((s) => s.id === fromId);
      const rest = list.filter((s) => s.id !== fromId);
      const to = rest.findIndex((s) => s.id === toId);
      if (moved === undefined || to < 0) {
        return list;
      }
      rest.splice(after ? to + 1 : to, 0, moved);
      return rest;
    });

  // ---- Modes ----

  const toText = () => {
    setText(pipelineText(stages));
    setTextError(null);
    setMode("text");
  };

  const toStages = () => {
    const parsed = stagesFromText(text, stages);
    if (!parsed.ok) {
      // Shown under the text editor; the mode stays.
      setTextError(parsed.error);
      return;
    }
    setStages(parsed.stages);
    setTextError(null);
    immediate.current = true;
    setMode("stages");
  };

  // The pipeline to send (the stages that are on, or the text), or null
  // after showing why there is none: on its card or under the text, with
  // the last run's result replaced by a pointer there.
  const currentPipeline = (): BsonDocument[] | null => {
    let cards = stages;
    if (mode === "text") {
      const parsed = stagesFromText(text, []);
      if (!parsed.ok) {
        setTextError(parsed.error);
        setOutcome({ kind: "error", error: parsed.error.message, shownAt: "text" });
        return null;
      }
      cards = parsed.stages;
    }
    const built = buildPipeline(cards);
    if (!built.ok) {
      setOutcome({ kind: "error", error: built.message, shownAt: mode === "stages" ? { card: built.index } : null });
      return null;
    }
    return built.pipeline;
  };

  // ---- Running ----

  const runController = useRef<AbortController | null>(null);
  useEffect(() => () => runController.current?.abort(), []);

  const startRun = (kind: "run" | "explain"): AbortSignal => {
    runController.current?.abort();
    const controller = new AbortController();
    runController.current = controller;
    setRunning(kind);
    return controller.signal;
  };

  // A run the server refused. The cards preview the same pipeline, so the
  // error is usually already on the first card that failed.
  const failed = (error: unknown) => {
    if (!isAbort(error)) {
      const message = error instanceof Error ? error.message : String(error);
      const card = mode === "stages" ? previews.findIndex((p) => p.kind === "fetched" && "error" in p.fetched && p.fetched.error instanceof Error && p.fetched.error.message === message) : -1;
      setOutcome({ kind: "error", error, shownAt: card >= 0 ? { card } : null });
      setRunning(null);
    }
  };

  const runAll = async () => {
    const pipeline = currentPipeline();
    if (pipeline === null) {
      return;
    }
    const writer = pipeline.find((stage) => WRITE_STAGES.includes(stageOp(stage)));
    const target = writer === undefined ? null : writeTarget(writer);
    if (writer !== undefined && host.safeMode !== 0) {
      const ok = await host.confirm({
        title: t("집계 결과를 컬렉션에 씁니다"),
        message:
          stageOp(writer) === "$out"
            ? t("$out은 {target} 컬렉션을 이 결과로 통째로 바꿉니다. 그 컬렉션의 지금 문서는 사라집니다.", { target: target ?? "" })
            : t("$merge는 이 결과를 {target} 컬렉션에 합칩니다. 같은 문서는 설정대로 바뀝니다.", { target: target ?? "" }),
        command: aggregateCode(ns.coll, pipeline),
        okLabel: t("실행"),
      });
      if (!ok) {
        return;
      }
    }
    const signal = startRun("run");
    try {
      const batch = await aggregate(ns, pipeline, maxTimeMS, signal, writer !== undefined);
      setOutcome({ kind: "docs", docs: batch.docs, elapsedMs: batch.elapsedMs, wrote: target });
      setTableSort(null);
      setTablePath([]);
      setRunning(null);
      if (target !== null) {
        host.notify(t("결과를 {target}에 썼습니다", { target }));
        onCollectionsChanged?.();
      }
    } catch (error) {
      failed(error);
    }
  };

  const explainAll = async () => {
    const pipeline = currentPipeline();
    if (pipeline === null) {
      return;
    }
    // A plan never writes: the $out/$merge stage is left out.
    const reads = pipeline.filter((stage) => !WRITE_STAGES.includes(stageOp(stage)));
    const signal = startRun("explain");
    try {
      const raw = await explain(ns, { aggregate: { pipeline: reads } }, "executionStats", signal);
      const lead = leadingQuery(reads);
      setOutcome({ kind: "plan", raw, summary: summarizeExplain(raw), query: { ...lead, projection: null, skip: 0, limit: 0 }, withoutWrite: reads.length !== pipeline.length });
      setRunning(null);
    } catch (error) {
      failed(error);
    }
  };

  const runRef = useRef(runAll);
  runRef.current = runAll;
  const onRun = useCallback(() => void runRef.current(), []);

  // 뷰로 저장 and 내보내기 take a reading pipeline only.
  const openReadingDialog = (kind: "view" | "export") => {
    const pipeline = currentPipeline();
    if (pipeline === null) {
      return;
    }
    if (pipeline.some((stage) => WRITE_STAGES.includes(stageOp(stage)))) {
      notifyError(kind === "view" ? t("$out·$merge가 있는 파이프라인은 뷰로 저장할 수 없습니다") : t("$out·$merge가 있는 파이프라인은 내보낼 수 없습니다"), { context: "aggregation" });
      return;
    }
    setDialog(kind);
  };

  // ---- Saved pipelines ----

  const [shelf, setShelf] = useState<SavedPipeline[]>(() => savedPipelines(nsText));
  const shelfRef = useRef<HTMLDivElement | null>(null);
  const closeShelf = useCallback(() => setShelfOpen(false), []);
  useMenuDismiss(shelfOpen, shelfRef, closeShelf);

  const savePipeline = () => {
    let cards = stages;
    if (mode === "text") {
      const parsed = stagesFromText(text, stages);
      if (!parsed.ok) {
        setTextError(parsed.error);
        return;
      }
      cards = parsed.stages;
    }
    const label = name.trim() || t("파이프라인 {n}", { n: shelf.length + 1 });
    const entry: SavedPipeline = { name: label, stages: cards.map(({ op, text: body, on }) => ({ op, text: body, on })), at: Date.now() };
    const next = [entry, ...savedPipelines(nsText).filter((p) => p.name !== label)];
    writeSavedPipelines(nsText, next);
    setShelf(next);
    setName(label);
    host.notify(t("파이프라인 {name}을(를) 저장했습니다", { name: label }));
  };

  const loadPipeline = (saved: SavedPipeline) => {
    setStages(saved.stages.map((s) => newStage(s.op, s.text, s.on)));
    setName(saved.name);
    setMode("stages");
    setTextError(null);
    immediate.current = true;
    setShelfOpen(false);
  };

  const forgetPipeline = (saved: SavedPipeline) => {
    const next = savedPipelines(nsText).filter((p) => p.name !== saved.name);
    writeSavedPipelines(nsText, next);
    setShelf(next);
  };

  // ---- Rendering ----

  const onCount = stages.filter((s) => s.on).length;
  const codePipeline = dialog !== null ? currentPipelineQuiet(mode, stages, text) : null;

  let results = null;
  if (outcome !== null) {
    let head;
    let body;
    if (outcome.kind === "error") {
      head = <span className="mg-stage-err">{t("실행하지 못했습니다")}</span>;
      body = (
        <div className="mg-agg-results-body">
          {outcome.shownAt === null ? (
            <ErrorNotice error={outcome.error} context="aggregation" engine="mongodb" />
          ) : (
            <p className="mg-stage-msg">{outcome.shownAt === "text" ? t("위 편집기의 오류를 고친 뒤 다시 실행하세요") : t("{n}단계 카드의 오류를 고친 뒤 다시 실행하세요", { n: outcome.shownAt.card + 1 })}</p>
          )}
        </div>
      );
    } else if (outcome.kind === "plan") {
      head = (
        <>
          <strong>{t("실행 계획")}</strong>
          {outcome.withoutWrite ? <span className="panel-dim">{t("$out·$merge 단계 제외")}</span> : null}
          <span className="spacer" />
          <button type="button" className={`mg-qbtn${showRaw ? " active" : ""}`} aria-pressed={showRaw} title={t("explain() 결과 원문")} onClick={() => setShowRaw(!showRaw)}>
            {t("원문")}
          </button>
        </>
      );
      body = (
        <div className="mg-agg-results-body">
          {showRaw ? (
            <pre className="panel-pre mg-explain-raw">
              <ShellText text={toShellPretty(outcome.raw)} />
            </pre>
          ) : (
            <div className="mg-explain-grid">
              <div className="mg-ptree-wrap">
                <div className="mg-ptree-title panel-dim">{t("위에서 아래로: 결과 ← 입력")}</div>
                {outcome.summary.root !== null ? <StageTree stage={outcome.summary.root} /> : <div className="panel-empty">{t("계획에 단계가 없습니다")}</div>}
              </div>
              <Summary summary={outcome.summary} query={outcome.query} coll={ns.coll} onCreateIndex={onCreateIndex} />
            </div>
          )}
        </div>
      );
    } else {
      const docs = tableSort === null ? outcome.docs : sortedDocs(outcome.docs, tableSort);
      head = (
        <>
          <strong>{t("결과")}</strong>
          <span className="panel-dim">
            {outcome.wrote !== null
              ? t("{target}에 썼습니다 · {ms} ms", { target: outcome.wrote, ms: Math.round(outcome.elapsedMs) })
              : t("문서 {count}개 · {ms} ms", { count: outcome.docs.length.toLocaleString(), ms: Math.round(outcome.elapsedMs) })}
          </span>
          <span className="spacer" />
          {view !== "table" ? (
            <button type="button" className="footer-button" title={t("모든 하위 값 펼치기/접기")} onClick={() => setAllOpen(!allOpen)}>
              {allOpen ? <CollapseIcon size={10} /> : <ExpandIcon size={10} />}
              <span className="footer-label">{allOpen ? t("모두 접기") : t("모두 펼치기")}</span>
            </button>
          ) : null}
          <ViewSwitch view={view} onChange={setView} />
        </>
      );
      body =
        view === "cards" ? (
          <CardView docs={docs} offset={0} readOnly allOpen={allOpen} notify={host.notify} emptyText={t("결과 문서가 없습니다")} />
        ) : view === "json" ? (
          <JsonView docs={docs} offset={0} canonical={false} allFolded={!allOpen} readOnly notify={host.notify} emptyText={t("결과 문서가 없습니다")} />
        ) : (
          <DocTableView
            ns={{ ...ns, coll: `${ns.coll}.$aggregate` }}
            connKey={connKey}
            docs={docs}
            readOnly
            sort={tableSort}
            onSort={setTableSort}
            save={async () => new Error(t("집계 결과는 읽기 전용입니다 — 문서 탭에서 편집하세요"))}
            panelOpen={panelOpen}
            onPanelOpenChange={onPanelOpenChange}
            path={tablePath}
            onPathChange={setTablePath}
          />
        );
      body = <div className="result-body mg-result-body">{<div className="mg-docbody">{body}</div>}</div>;
    }
    results = (
      <div className="mg-agg-results">
        <div className="mg-agg-results-head">
          {head}
          <button type="button" className="icon-button" title={t("닫기")} aria-label={t("닫기")} onClick={() => setOutcome(null)}>
            <CloseIcon size={10} />
          </button>
        </div>
        {body}
      </div>
    );
  }

  return (
    <div className="mg-pane mg-agg">
      <div className="mg-agg-bar">
        <span className="mg-agg-count">
          {mode === "stages" ? t("{coll}에서 시작 · 단계 {count}개", { coll: ns.coll, count: `${onCount}/${stages.length}` }) : t("{coll}에서 시작", { coll: ns.coll })}
        </span>
        <button type="button" className={`mg-qbtn${mode === "text" ? " active" : ""}`} aria-pressed={mode === "text"} title={t("단계 카드 ↔ 파이프라인 전체를 텍스트로")} onClick={mode === "stages" ? toText : toStages}>
          <CodeIcon size={10} />
          {mode === "stages" ? t("텍스트로 편집") : t("단계로 편집")}
        </button>
        <div className="mg-pop-anchor" ref={shelfOpen ? shelfRef : undefined}>
          <button
            type="button"
            className={`mg-qbtn${shelfOpen ? " active" : ""}`}
            title={t("이 컬렉션에 저장한 파이프라인")}
            onClick={(event) => {
              event.stopPropagation();
              setShelf(savedPipelines(nsText));
              setShelfOpen(!shelfOpen);
            }}
          >
            <HistoryIcon size={10} />
            {name !== "" ? name : t("저장된 파이프라인")}
            {shelf.length > 0 ? <span className="mg-opt-badge">{shelf.length}</span> : null}
            <span className="mg-chev">
              <ChevronDownIcon size={8} />
            </span>
          </button>
          {shelfOpen ? (
            <div className="menu-panel mg-popover mg-hist-pop" onClick={(event) => event.stopPropagation()}>
              <form
                className="mg-agg-saverow"
                onSubmit={(event) => {
                  event.preventDefault();
                  savePipeline();
                }}
              >
                <input className="mg-pop-search" placeholder={t("이름 (같은 이름은 덮어씁니다)")} spellCheck={false} autoFocus value={name} onChange={(event) => setName(event.target.value)} />
                <button type="submit" className="mg-qbtn">
                  {t("지금 파이프라인 저장")}
                </button>
              </form>
              <div className="mg-hist-head">
                <span>{t("저장된 파이프라인")}</span>
                <span className="spacer" />
                <span className="panel-dim">{nsText}</span>
              </div>
              {shelf.length === 0 ? <div className="mg-hist-empty">{t("아직 없습니다")}</div> : null}
              {shelf.map((saved) => (
                <div key={saved.name} className="mg-hist-item" role="button" tabIndex={0} onClick={() => loadPipeline(saved)} onKeyDown={(event) => event.key === "Enter" && loadPipeline(saved)}>
                  <div className="mg-hist-text">{saved.name}</div>
                  <div className="mg-hist-meta mono">
                    {saved.stages.map((s) => (s.on ? s.op : `(${s.op})`)).join(" → ")} · {new Date(saved.at).toLocaleString()}
                  </div>
                  <button
                    type="button"
                    className="icon-button mg-agg-forget"
                    title={t("지우기")}
                    aria-label={t("지우기")}
                    onClick={(event) => {
                      event.stopPropagation();
                      forgetPipeline(saved);
                    }}
                  >
                    <TrashIcon size={10} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <span className="spacer" />
        {mode === "stages" ? (
          <button type="button" className="icon-button" title={t("미리보기 다시 읽기")} aria-label={t("미리보기 다시 읽기")} onClick={refreshPreviews}>
            <RefreshIcon size={11} />
          </button>
        ) : null}
        <button type="button" className="mg-qbtn" title={t("이 파이프라인을 드라이버 코드로 (mongosh·Python·Node.js·Java·C#·Go·Rust·PHP·Ruby)")} onClick={() => currentPipeline() !== null && setDialog("code")}>
          <CodeIcon size={10} />
          {t("코드로")}
        </button>
        <button type="button" className="mg-qbtn" title={t("이 파이프라인으로 뷰 만들기 (create viewOn)")} onClick={() => openReadingDialog("view")}>
          <TableIcon size={10} />
          {t("뷰로 저장…")}
        </button>
        <button type="button" className="mg-qbtn" title={t("집계 결과를 파일로 내보내기")} onClick={() => openReadingDialog("export")}>
          <DownloadIcon size={10} />
          {t("내보내기…")}
        </button>
        <button type="button" className="mg-qbtn" title={t("이 파이프라인의 실행 계획")} disabled={running !== null} onClick={() => void explainAll()}>
          <PlanIcon size={10} />
          {t("계획")}
        </button>
        {running !== null ? (
          <button
            type="button"
            className="mg-qbtn"
            onClick={() => {
              runController.current?.abort();
              setRunning(null);
            }}
          >
            <Spinner size={10} />
            {t("정지")}
          </button>
        ) : null}
        <button type="button" className="primary mg-find" title={t("파이프라인 실행 (⌘↩)")} disabled={running !== null} onClick={onRun}>
          <PlayIcon size={9} />
          {t("실행")}
          <span className="split-hint">⌘↩</span>
        </button>
      </div>
      <div className="mg-agg-list">
        {mode === "text" ? (
          <div className="mg-agg-text">
            <MongoEditor
              value={text}
              onChange={(value) => {
                setText(value);
                setTextError(null);
              }}
              onRun={onRun}
              role="pipeline"
              completion={() => ({ fields: sample, collections, fieldsOf })}
              error={textError !== null && textError.to > textError.from ? textError : null}
              ariaLabel={t("파이프라인")}
            />
            {textError !== null ? <SyntaxErrorNotice src={text} message={textError.message} at={textError.from} context="aggregation" /> : null}
          </div>
        ) : (
          <>
            {stages.map((stage, i) => (
              <div key={stage.id}>
                <button type="button" className="mg-add-stage" title={t("여기에 단계 추가")} aria-label={t("여기에 단계 추가")} onClick={(event) => openPicker(event, i, null)}>
                  <PlusIcon size={9} />
                </button>
                <StageCard
                  stage={stage}
                  index={i}
                  preview={previews[i]}
                  error={plans[i].error}
                  completion={completionFor(i)}
                  dragging={drag === stage.id}
                  drop={dropAt !== null && dropAt.id === stage.id && drag !== stage.id ? (dropAt.after ? "after" : "before") : null}
                  onChange={(patch) => patchStage(stage.id, patch)}
                  onPickOp={(event) => openPicker(event, i, i)}
                  onDuplicate={() => setStages((list) => [...list.slice(0, i + 1), newStage(stage.op, stage.text, stage.on), ...list.slice(i + 1)])}
                  onDelete={() => setStages((list) => list.filter((s) => s.id !== stage.id))}
                  onMove={(step) => {
                    const other = stages[i + step];
                    if (other !== undefined) {
                      moveStage(stage.id, other.id, step > 0);
                    }
                  }}
                  onDragStart={() => setDrag(stage.id)}
                  onDragEnd={() => {
                    setDrag(null);
                    setDropAt(null);
                  }}
                  onDragOver={(after) => {
                    if (drag !== null && (dropAt?.id !== stage.id || dropAt.after !== after)) {
                      setDropAt({ id: stage.id, after });
                    }
                  }}
                  onDrop={(after) => {
                    if (drag !== null && drag !== stage.id) {
                      moveStage(drag, stage.id, after);
                    }
                    setDrag(null);
                    setDropAt(null);
                  }}
                  onRun={onRun}
                />
              </div>
            ))}
            <button type="button" className="mg-add-stage last" onClick={(event) => openPicker(event, stages.length, null)}>
              <PlusIcon size={9} />
              {t("단계 추가")}
            </button>
          </>
        )}
      </div>
      {results}
      {picker !== null ? <StagePicker x={picker.x} y={picker.y} current={picker.replace !== null ? stages[picker.replace]?.op : undefined} onPick={pickOp} onClose={() => setPicker(null)} /> : null}
      {dialog === "code" && codePipeline !== null ? (
        <CodeExportModal
          ns={ns}
          source={{ kind: "aggregate", pipeline: codePipeline }}
          note={mode === "stages" && onCount < stages.length ? t("꺼진 단계는 빠집니다") : undefined}
          onOpenShell={
            onOpenShell === undefined
              ? undefined
              : (code) => {
                  onOpenShell(ns.db, code);
                  setDialog(null);
                }
          }
          notify={host.notify}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "view" && codePipeline !== null ? (
        <SaveViewDialog
          ns={ns}
          pipeline={codePipeline}
          host={host}
          onClose={() => setDialog(null)}
          onSaved={(view, replaced) => {
            setDialog(null);
            host.notify(replaced ? t("뷰 {name}의 파이프라인을 바꿨습니다", { name: view }) : t("뷰 {name}을(를) 만들었습니다", { name: view }));
            onCollectionsChanged?.();
            onOpenCollection?.(ns.db, view, true);
          }}
        />
      ) : null}
      {dialog === "export" && codePipeline !== null ? <ExportModal ns={ns} source={{ kind: "aggregate", pipeline: codePipeline }} notify={host.notify} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

// The pipeline for a dialog already opened (it was checked when opening).
function currentPipelineQuiet(mode: "stages" | "text", stages: Stage[], text: string): BsonDocument[] | null {
  const cards = mode === "text" ? stagesFromText(text, []) : { ok: true as const, stages };
  if (!cards.ok) {
    return null;
  }
  const built = buildPipeline(cards.stages);
  return built.ok ? built.pipeline : null;
}

function sortedDocs(docs: BsonDocument[], sort: BsonDocument): BsonDocument[] {
  const key = sort.keys().next().value ?? "";
  const dir = toShell(sort.get(key) ?? null) === "-1" ? -1 : 1;
  return [...docs].sort((a, b) => compareForSort(a.get(key), b.get(key)) * dir);
}

// ---- One stage card ----

interface StageCardProps {
  stage: Stage;
  index: number;
  preview: Preview;
  // Where the text does not parse, for the underline.
  error: ShellError | null;
  completion: () => CompletionContext;
  dragging: boolean;
  drop: "before" | "after" | null;
  onChange(patch: Partial<Stage>): void;
  onPickOp(event: ReactMouseEvent<HTMLElement>): void;
  onDuplicate(): void;
  onDelete(): void;
  // Keyboard reordering from the grip: -1 up, 1 down.
  onMove(step: -1 | 1): void;
  onDragStart(): void;
  onDragEnd(): void;
  onDragOver(after: boolean): void;
  onDrop(after: boolean): void;
  onRun(): void;
}

function StageCard({ stage, index, preview, error, completion, dragging, drop, onChange, onPickOp, onDuplicate, onDelete, onMove, onDragStart, onDragEnd, onDragOver, onDrop, onRun }: StageCardProps) {
  const description = STAGES[stage.op]?.[0];
  const below = (event: { clientY: number; currentTarget: HTMLElement }) => {
    const r = event.currentTarget.getBoundingClientRect();
    return event.clientY >= r.top + r.height / 2;
  };

  let status;
  let body;
  const shown = preview.kind === "fetched" ? preview.fetched : preview.kind === "loading" ? preview.last : null;
  switch (preview.kind) {
    case "off":
      status = <span className="panel-dim">{t("꺼짐 — 그대로 통과")}</span>;
      body = <div className="mg-stage-msg">{t("꺼진 단계는 보내지 않습니다")}</div>;
      break;
    case "invalid":
      status = <span className="mg-stage-err">{t("구문 오류")}</span>;
      body = error !== null ? <SyntaxErrorNotice src={stage.text} message={error.message} at={error.from} context="aggregation" /> : <ErrorNotice error={preview.message} context="aggregation" engine="mongodb" variant="compact" />;
      break;
    case "blocked":
      status = <span className="mg-stage-err">{t("앞 단계 오류")}</span>;
      body = <div className="mg-stage-msg">{t("앞 단계를 고치면 미리 봅니다")}</div>;
      break;
    case "write":
      status = <span className="mg-stage-write">{t("쓰기 → {target}", { target: preview.target })}</span>;
      body = <div className="mg-stage-msg">{t("미리 보지 않습니다 — 실행하면 확인한 뒤 {target}에 씁니다", { target: preview.target })}</div>;
      break;
    case "after-write":
      status = <span className="mg-stage-err">{t("순서 오류")}</span>;
      body = <ErrorNotice error={t("$out·$merge는 마지막 단계여야 합니다")} context="aggregation" engine="mongodb" variant="compact" />;
      break;
    default:
      if (shown === null) {
        status = <Spinner size={10} />;
        body = <div className="mg-stage-msg">{t("불러오는 중…")}</div>;
      } else if ("error" in shown) {
        // The error once, in the preview; the status only says there is one.
        status = <span className="mg-stage-err">{t("서버 오류")}</span>;
        body = <ErrorNotice error={shown.error} context="aggregation" engine="mongodb" variant="compact" />;
      } else {
        status = (
          <span className="mg-stage-n">
            {preview.kind === "loading" ? <Spinner size={9} /> : null}
            {shown.docs.length >= PREVIEW_LIMIT ? t("→ 앞 {count}건", { count: shown.docs.length }) : t("→ 문서 {count}개", { count: shown.docs.length })}
            <span className="panel-dim"> · {Math.round(shown.elapsedMs)} ms</span>
          </span>
        );
        body =
          shown.docs.length === 0 ? (
            <div className="mg-stage-msg">{t("이 단계 뒤에 남는 문서가 없습니다")}</div>
          ) : (
            shown.docs.map((doc, i) => (
              <pre key={i} className="mg-mini">
                <ShellText text={toShellPretty(doc)} />
              </pre>
            ))
          );
      }
  }
  const failedCard = preview.kind === "invalid" || preview.kind === "after-write" || (shown !== null && "error" in shown);

  return (
    <div
      className={`mg-stage${stage.on ? "" : " off"}${failedCard ? " err" : ""}${dragging ? " dragging" : ""}${drop !== null ? ` drop-${drop}` : ""}`}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(STAGE_DRAG_TYPE)) {
          event.preventDefault();
          onDragOver(below(event));
        }
      }}
      onDrop={(event) => {
        if (event.dataTransfer.types.includes(STAGE_DRAG_TYPE)) {
          event.preventDefault();
          onDrop(below(event));
        }
      }}
    >
      <div className="mg-stage-head">
        <button
          type="button"
          className="mg-grip"
          draggable
          title={t("끌어서 순서 바꾸기 (↑↓)")}
          aria-label={t("{n}단계 순서 바꾸기", { n: index + 1 })}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(STAGE_DRAG_TYPE, String(stage.id));
            const card = event.currentTarget.closest(".mg-stage");
            if (card instanceof HTMLElement) {
              event.dataTransfer.setDragImage(card, 24, 18);
            }
            onDragStart();
          }}
          onDragEnd={onDragEnd}
          onKeyDown={(event: ReactKeyboardEvent) => {
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              onMove(event.key === "ArrowUp" ? -1 : 1);
            }
          }}
        >
          <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true" fill="currentColor">
            <circle cx="3" cy="3" r="1.2" />
            <circle cx="7" cy="3" r="1.2" />
            <circle cx="3" cy="7" r="1.2" />
            <circle cx="7" cy="7" r="1.2" />
            <circle cx="3" cy="11" r="1.2" />
            <circle cx="7" cy="11" r="1.2" />
          </svg>
        </button>
        <span className="mg-stage-no">{index + 1}</span>
        <button type="button" className="mg-stage-op" title={t("단계 연산자 바꾸기")} onClick={onPickOp}>
          {stage.op}
          <ChevronDownIcon size={7} />
        </button>
        <button
          type="button"
          className={`mg-switch${stage.on ? " on" : ""}`}
          role="switch"
          aria-checked={stage.on}
          title={stage.on ? t("이 단계 끄기") : t("이 단계 켜기")}
          onClick={() => onChange({ on: !stage.on })}
        >
          <span />
        </button>
        <span className="mg-stage-desc">{description !== undefined ? t(description) : ""}</span>
        <span className="spacer" />
        {status}
        <button type="button" className="icon-button" title={t("단계 복제")} aria-label={t("단계 복제")} onClick={onDuplicate}>
          <CloneIcon size={10} />
        </button>
        <button type="button" className="icon-button" title={t("단계 삭제")} aria-label={t("단계 삭제")} onClick={onDelete}>
          <TrashIcon size={10} />
        </button>
      </div>
      <div className="mg-stage-body">
        <div className="mg-stage-editor">
          <MongoEditor
            value={stage.text}
            onChange={(value) => onChange({ text: value })}
            onRun={onRun}
            role="pipeline"
            contextPrefix={`[{ ${stage.op}: `}
            completion={completion}
            error={error !== null && error.to > error.from ? error : null}
            ariaLabel={t("{n}단계 {op}", { n: index + 1, op: stage.op })}
          />
        </div>
        <div className={`mg-stage-preview${preview.kind === "loading" ? " stale" : ""}`}>{body}</div>
      </div>
    </div>
  );
}

// ---- Stage picker ----

const PICKER_OPS = Object.keys(STAGES);

function StagePicker({ x, y, current, onPick, onClose }: { x: number; y: number; current?: string; onPick(op: string): void; onClose(): void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement | null>(null);
  useMenuDismiss(true, ref, onClose);
  const needle = query.trim().toLowerCase().replace(/^\$/, "");
  const ops = PICKER_OPS.filter((op) => needle === "" || op.toLowerCase().includes(needle) || t(STAGES[op][0]).toLowerCase().includes(needle));
  const chosen = Math.min(active, Math.max(0, ops.length - 1));
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    listRef.current?.children[chosen]?.scrollIntoView({ block: "nearest" });
  }, [chosen]);

  return (
    <div ref={ref} className="menu-panel mg-popover mg-stagepick" style={{ position: "fixed", left: x, top: y }} onClick={(event) => event.stopPropagation()}>
      <input
        className="mg-pop-search"
        placeholder={t("단계 검색…")}
        spellCheck={false}
        autoFocus
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActive((n) => Math.max(0, Math.min(ops.length - 1, n + (event.key === "ArrowDown" ? 1 : -1))));
          } else if (event.key === "Enter" && ops[chosen] !== undefined) {
            event.preventDefault();
            onPick(ops[chosen]);
          }
        }}
      />
      <div className="mg-stagepick-list" ref={listRef} role="listbox" aria-label={t("단계")}>
        {ops.map((op, i) => (
          <div
            key={op}
            role="option"
            aria-selected={i === chosen}
            className={`mg-stagepick-row${i === chosen ? " active" : ""}${op === current ? " current" : ""}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => onPick(op)}
          >
            <span className="mg-stagepick-op mono">{op}</span>
            <span className="mg-stagepick-desc">{t(STAGES[op][0])}</span>
            <span className="mg-stagepick-example mono">
              <ShellText text={STAGES[op][1]} />
            </span>
          </div>
        ))}
        {ops.length === 0 ? <div className="mg-hist-empty">{t("맞는 단계가 없습니다")}</div> : null}
      </div>
    </div>
  );
}

// ---- Dialogs ----

// 뷰로 저장: `create` with viewOn and the pipeline. A view of the same name
// is replaced (`collMod`, after the safe-mode confirmation); a collection of
// that name is left alone.
function SaveViewDialog({ ns, pipeline, host, onSaved, onClose }: { ns: Namespace; pipeline: BsonDocument[]; host: DocHost; onSaved(name: string, replaced: boolean): void; onClose(): void }) {
  const [name, setName] = useState(`${ns.coll}_view`);
  const [busy, setBusy] = useState(false);
  // The name taken by a collection, or the server's refusal.
  const [nameTaken, setNameTaken] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  useEscape(() => !busy && onClose());
  const viewName = name.trim();
  const code = `db.createView(${JSON.stringify(viewName)}, ${JSON.stringify(ns.coll)}, ${toShellPretty(pipeline)})`;

  async function submit(): Promise<void> {
    if (busy || viewName === "") {
      return;
    }
    setBusy(true);
    setFailure(null);
    setNameTaken(false);
    try {
      const existing = (await listCollections(ns.conn, ns.db)).find((c) => c.name === viewName);
      if (existing !== undefined && existing.type !== "view") {
        setNameTaken(true);
        return;
      }
      if (existing !== undefined) {
        const replace = bsonDoc({ collMod: viewName, viewOn: ns.coll, pipeline });
        if (host.safeMode !== 0) {
          const ok = await host.confirm({
            title: t("뷰 바꾸기"),
            message: t("뷰 {name}이(가) 이미 있습니다. 그 파이프라인을 이것으로 바꿉니다.", { name: viewName }),
            command: `db.runCommand(${toShellPretty(replace)})`,
            okLabel: t("바꾸기"),
          });
          if (!ok) {
            return;
          }
        }
        await command(ns.conn, ns.db, replace, true);
        onSaved(viewName, true);
        return;
      }
      await command(ns.conn, ns.db, bsonDoc({ create: viewName, viewOn: ns.coll, pipeline }));
      onSaved(viewName, false);
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <form
        className="modal mg-ix-modal"
        role="dialog"
        aria-label={t("뷰로 저장")}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="modal-head">
          <span className="modal-title">{t("뷰로 저장")}</span>
          <span className="modal-path">{t("{db} · {coll} 기반", { db: ns.db, coll: ns.coll })}</span>
        </div>
        <div className="modal-body mg-form">
          <label className="mg-form-row">
            <span className="mg-form-label">{t("뷰 이름")}</span>
            <input type="text" className="mg-input" spellCheck={false} autoFocus value={name} {...fieldErrorProps("mg-view-name-error", nameTaken ? "taken" : null)} onChange={(event) => (setName(event.target.value), setNameTaken(false))} />
          </label>
          <FieldError id="mg-view-name-error" error={nameTaken ? t("같은 이름의 컬렉션이 있습니다 — 다른 이름을 고르세요") : null} />
          <div className="mg-form-label">{t("보낼 명령")}</div>
          <pre className="panel-pre mg-export-code">
            <ShellText text={code} />
          </pre>
          <span className="panel-dim">{t("꺼진 단계는 빠집니다 · 같은 이름의 뷰가 있으면 그 파이프라인을 바꿉니다")}</span>
          {failure !== null ? <ErrorNotice error={failure} context="aggregation" engine="mongodb" variant="compact" /> : null}
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" onClick={onClose} disabled={busy}>
            {t("취소")}
          </button>
          <button type="submit" className="primary" disabled={busy || viewName === ""}>
            {busy ? <Spinner size={10} /> : null}
            {t("만들기")}
          </button>
        </div>
      </form>
    </div>
  );
}
