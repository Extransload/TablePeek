// A collection tab (MONGODB.md §3.2, §6.2, §8.1): sub-tabs 문서 | 집계 |
// 스키마 | 검증 | 인덱스 | 실행 계획 | 변경 보기 with the collection's stats, the query bar (문서
// and 실행 계획), the results toolbar (+ 문서, fold all, EJSON, copy page,
// the ☰ / {} / ⊞ switch), the documents in the chosen view and the pager.
// What the tab shows (sub-tab, query, view, page, drill path) is remembered
// per tab across remounts.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { writeClipboard } from "../../../clipboard";
import { ContextMenu } from "../../../components/ContextMenu";
import { ErrorNotice, notifyError } from "../../../components/ErrorNotice";
import { isAppServerDown } from "../../../errorHelp";
import { ChevronDownIcon, CodeIcon, CopyIcon, DownloadIcon, PencilIcon, PlusIcon, RefreshIcon, TrashIcon } from "../../../components/icons";
import { Spinner } from "../../../components/Spinner";
import { formatBytes } from "../../../format";
import { say, t } from "../../../i18n";
import type { SafeMode } from "../../../sqlTools";
import { store } from "../../../store";
import { collStats, count as countDocs, find, insert, isAbort, remove, type CollStats, type Namespace } from "../api";
import { ObjectId, bsonDoc, stringifyJson, toEJSON, type BsonDocument, type BsonValue } from "../bson";
import { sampleFields, type CompletionContext } from "../complete";
import { toShell, toShellPretty } from "../format";
import { idFilter } from "../guard";
import type { AggDraft } from "../pipeline";
import { AggregationPanel } from "./AggregationPanel";
import { BulkModal, type BulkMode } from "./BulkModal";
import { CardView, docKey } from "./CardView";
import { DocDetail, DocDetailPanel, FactsList, NothingSelected, useCollectionFacts } from "./DocDetailPanel";
import { ConfirmModal, ConflictModal, type ConfirmRequest } from "./DocModals";
import { DocTableView } from "./DocTableView";
import { ExplainPanel } from "./ExplainPanel";
import { CodeExportModal } from "./CodeExportModal";
import { ExportModal } from "./ExportModal";
import { CollapseIcon, ExpandIcon } from "./icons";
import { IndexesPanel } from "./IndexesPanel";
import { InsertDocModal, templateDoc } from "./InsertDocModal";
import { JsonView } from "./JsonView";
import { EMPTY_QUERY, QueryBar, normalizeQuery, parseQuery, recordQuery, withFilterValue, type QueryError, type QueryText } from "./QueryBar";
import { SchemaPanel } from "./SchemaPanel";
import type { DocHost, DocQuery, IndexCreateRequest } from "./types";
import { useDocEdits } from "./useDocEdits";
import { ValidationPanel } from "./ValidationPanel";
import { ChangeStreamPanel } from "./ChangeStreamPanel";
import { ViewSwitch, viewForKey, type DocView } from "./ViewSwitch";
import { OpenValidationContext, asError } from "./writeErrors";
import "../mongodb.css";

export type DocSubTab = "docs" | "agg" | "schema" | "validation" | "indexes" | "explain" | "changes";

// What a collection tab keeps across a page reload.
export interface DocTabState {
  sub: DocSubTab;
  view: DocView;
  query: QueryText;
  applied: QueryText;
}

const SUBTABS: { id: DocSubTab; label: string }[] = [
  { id: "docs", label: "문서" },
  { id: "agg", label: "집계" },
  { id: "schema", label: "스키마" },
  { id: "validation", label: "검증" },
  { id: "indexes", label: "인덱스" },
  { id: "explain", label: "실행 계획" },
  { id: "changes", label: "변경 보기" },
];

const PAGE_SIZES = [10, 20, 50, 100];

// What a collection tab shows, kept per tab so a remount (tab switch)
// comes back to the same place.
interface TabMemory {
  sub: DocSubTab;
  query: QueryText;
  optsOpen: boolean;
  // The query last run (what the page shows).
  applied: QueryText;
  view: DocView;
  page: number;
  pageSize: number;
  path: string[];
  canonical: boolean;
}

const memory = new Map<string, TabMemory>();

export interface DocumentWorkbenchProps {
  conn: string;
  // The connection's stable key (as App keys column widths by).
  connKey: string;
  db: string;
  coll: string;
  // Identifies the tab for view memory (a tab id).
  tabKey: string;
  // The sub-tab, view and query saved with the tab, used when this session has none.
  persisted?: DocTabState;
  onPersist(state: DocTabState): void;
  // A view, a read-only connection: no edits, no 문서 추가.
  readOnly?: boolean;
  notify(message: string): void;
  // Per-query time limit (the settings' query timeout).
  maxTimeMS?: number;
  // Collection names of the database, for completion.
  collections?: string[];
  // False while another tab is in front: shortcuts stay off.
  active?: boolean;
  // Bumped by the app's refresh (F5).
  refreshSeq?: number;
  // The connection's safe mode (confirm before writes the server needs
  // `confirmed` for).
  safeMode: SafeMode;
  // A view or collection was made (집계's 뷰로 저장, $out): the sidebar
  // reads again.
  onCollectionsChanged?(): void;
  onOpenCollection?(db: string, coll: string, view: boolean): void;
  onOpenShell?(db: string, text: string): void;
  // The 집계 pipeline being edited, persisted with the tab.
  aggDraft?: AggDraft;
  onAggDraftChange(draft: AggDraft): void;
}

interface PageResult {
  docs: BsonDocument[];
  elapsedMs: number;
  // Where the page starts in the whole result.
  start: number;
}

interface Total {
  // null: counting took too long ("많음"), or failed.
  count: number | null;
  exact: boolean;
  failed?: true;
}

// The sort when it is `_id` alone (paging may then continue after the last
// `_id` instead of skipping).
function idSortDirection(sort: BsonDocument | null): 1 | -1 | null {
  if (sort === null) {
    return null;
  }
  const id = sort.get("_id");
  if (sort.size !== 1 || id === undefined) {
    return null;
  }
  const text = toShell(id);
  return text === "1" ? 1 : text === "-1" ? -1 : null;
}

export function DocumentWorkbench({
  conn,
  connKey,
  db,
  coll,
  tabKey,
  persisted,
  onPersist,
  readOnly = false,
  notify,
  maxTimeMS,
  collections,
  active = true,
  refreshSeq = 0,
  safeMode,
  onCollectionsChanged,
  onOpenCollection,
  onOpenShell,
  aggDraft,
  onAggDraftChange,
}: DocumentWorkbenchProps) {
  const ns: Namespace = useMemo(() => ({ conn, db, coll }), [conn, db, coll]);
  const nsText = `${db}.${coll}`;
  const remembered = memory.get(tabKey);
  // A view has neither indexes, a validation rule nor a change stream: a
  // stored 인덱스, 검증 or 변경 보기 sub-tab falls back to 문서.
  const storedSub = remembered?.sub ?? persisted?.sub ?? "docs";
  const [sub, setSub] = useState<DocSubTab>(readOnly && (storedSub === "validation" || storedSub === "indexes" || storedSub === "changes") ? "docs" : storedSub);
  const [query, setQuery] = useState<QueryText>(remembered?.query ?? normalizeQuery(persisted?.query));
  const [optsOpen, setOptsOpen] = useState(remembered?.optsOpen ?? false);
  const [applied, setApplied] = useState<QueryText>(remembered?.applied ?? normalizeQuery(persisted?.applied));
  const [view, setView] = useState<DocView>(remembered?.view ?? persisted?.view ?? "cards");
  const [page, setPage] = useState(remembered?.page ?? 0);
  const [pageSize, setPageSize] = useState(remembered?.pageSize ?? 20);
  const [path, setPath] = useState<string[]>(remembered?.path ?? []);
  const [canonical, setCanonical] = useState(remembered?.canonical ?? false);
  // Cards start folded, JSON blocks open (as the prototype).
  const [allOpen, setAllOpen] = useState(false);
  const [jsonFolded, setJsonFolded] = useState(false);
  const expanded = view === "json" ? !jsonFolded : allOpen;

  const [result, setResult] = useState<PageResult | null>(null);
  const [total, setTotal] = useState<Total | null>(null);
  const [loading, setLoading] = useState(false);
  // The page's failure; the last page stays shown under it, dimmed.
  const [loadError, setLoadError] = useState<unknown>(null);
  // Bumps when the TablePeek server answers again after being down: the
  // page and its count load again.
  const serverEpoch = useSyncExternalStore(store.subscribe, () => store.getState().server.epoch);
  const [queryError, setQueryError] = useState<QueryError | null>(null);
  const [stats, setStats] = useState<CollStats | null>(null);
  const [dirtyCount, setDirtyCount] = useState(0);
  const [reloadSeq, setReloadSeq] = useState(0);
  const [statsSeq, setStatsSeq] = useState(0);
  const [explainSeq, setExplainSeq] = useState(0);
  const [indexRequest, setIndexRequest] = useState<IndexCreateRequest | null>(null);
  const [schemaDraft, setSchemaDraft] = useState<{ seq: number; schema: BsonDocument } | null>(null);
  const [sizeMenu, setSizeMenu] = useState<{ x: number; y: number } | null>(null);
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  const [editor, setEditor] = useState<{ mode: "insert" | "clone" | "replace"; doc: BsonDocument; initial: string } | null>(null);
  // A new document's text left for the 검증 tab; the next 문서 추가 opens with it.
  const insertDraftRef = useRef<string | null>(null);
  const [confirm, setConfirm] = useState<{ request: ConfirmRequest; resolve(ok: boolean): void } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  // 코드로: the query as it was when the dialog opened.
  const [codeQuery, setCodeQuery] = useState<DocQuery | null>(null);
  const [bulk, setBulk] = useState<BulkMode | null>(null);
  // The card or JSON block shown in the app's detail panel (its docKey).
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    memory.set(tabKey, { sub, query, optsOpen, applied, view, page, pageSize, path, canonical });
  }, [tabKey, sub, query, optsOpen, applied, view, page, pageSize, path, canonical]);

  // Save the parts worth keeping across a reload with the tab, only when they change.
  const persistedText = JSON.stringify(persisted ?? null);
  useEffect(() => {
    const next: DocTabState = { sub, view, query, applied };
    if (JSON.stringify(next) !== persistedText) {
      onPersist(next);
    }
    // onPersist is a fresh closure each render; the values are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub, view, query, applied]);

  const parsedApplied = useMemo(() => parseQuery(applied), [applied]);
  const appliedQuery: DocQuery | null = parsedApplied.ok ? parsedApplied.value : null;
  const liveQuery = useMemo(() => parseQuery(query), [query]);

  // Sampled fields of the page, for completion, the field list and the
  // insert template.
  const fields = useMemo(() => sampleFields(result?.docs ?? []), [result]);
  const completionRef = useRef<CompletionContext>({ fields, collections });
  completionRef.current = { fields, collections };
  const completion = useCallback(() => completionRef.current, []);

  const reload = useCallback(() => {
    setReloadSeq((n) => n + 1);
    setStatsSeq((n) => n + 1);
  }, []);

  const host: DocHost = useMemo(
    () => ({
      notify,
      confirm: (request) =>
        new Promise<boolean>((resolve) => {
          setConfirm({
            request,
            resolve: (ok) => {
              setConfirm(null);
              resolve(ok);
            },
          });
        }),
      safeMode,
    }),
    [notify, safeMode],
  );

  const edits = useDocEdits(ns, reload, notify);
  // What the detail panel lists with nothing selected.
  const facts = useCollectionFacts(ns, statsSeq);

  // ---- Loading ----

  useEffect(() => {
    const controller = new AbortController();
    collStats(ns, controller.signal).then(setStats, (error: unknown) => {
      if (!isAbort(error)) {
        setStats(null);
      }
    });
    return () => controller.abort();
  }, [ns, statsSeq]);

  // The page: skip + limit, or after the last `_id` when sorted by `_id`
  // alone and moving one page on.
  const anchorRef = useRef<{ key: string; page: number; lastId: BsonValue } | null>(null);
  useEffect(() => {
    if (sub !== "docs" || appliedQuery === null) {
      return;
    }
    const q = appliedQuery;
    const controller = new AbortController();
    const start = page * pageSize;
    const limit = q.limit > 0 ? Math.min(pageSize, q.limit - start) : pageSize;
    const queryKey = JSON.stringify(applied);
    const direction = idSortDirection(q.sort);
    const anchor = anchorRef.current;
    let filter = q.filter;
    let skip = q.skip + start;
    if (direction !== null && q.skip === 0 && anchor !== null && anchor.key === `${queryKey}|${pageSize}` && anchor.page === page - 1) {
      filter = bsonDoc({ $and: [q.filter, bsonDoc({ _id: bsonDoc({ [direction > 0 ? "$gt" : "$lt"]: anchor.lastId }) })] });
      skip = 0;
    }
    setLoading(true);
    setLoadError(null);
    if (limit <= 0) {
      setResult({ docs: [], elapsedMs: 0, start });
      setLoading(false);
      return;
    }
    // The query's own maxTimeMS (옵션) replaces the settings' timeout.
    find(ns, { filter, projection: q.projection, sort: q.sort, skip, limit, maxTimeMS: q.options?.maxTimeMS ?? maxTimeMS, collation: q.options?.collation, hint: q.options?.hint }, controller.signal).then(
      (batch) => {
        setResult({ docs: batch.docs, elapsedMs: batch.elapsedMs, start });
        setLoading(false);
        const last = batch.docs[batch.docs.length - 1];
        const lastId = last?.get("_id");
        anchorRef.current = lastId !== undefined ? { key: `${queryKey}|${pageSize}`, page, lastId } : null;
      },
      (error: unknown) => {
        if (isAbort(error)) {
          return;
        }
        setLoading(false);
        setLoadError(error);
      },
    );
    return () => controller.abort();
  }, [ns, sub, applied, appliedQuery, page, pageSize, reloadSeq, maxTimeMS, serverEpoch]);

  // The count runs beside the page; it may come late or not at all ("많음").
  useEffect(() => {
    if (sub !== "docs" || appliedQuery === null) {
      return;
    }
    const controller = new AbortController();
    setTotal(null);
    countDocs(ns, appliedQuery.filter, controller.signal, appliedQuery.options).then(
      (r) => setTotal(r),
      (error: unknown) => {
        if (!isAbort(error)) {
          setTotal({ count: null, exact: false, failed: true });
        }
      },
    );
    return () => controller.abort();
  }, [ns, sub, applied, appliedQuery, reloadSeq, serverEpoch]);

  // An estimate made exact on request: a filter matching every document
  // makes the server count instead of estimating.
  const countExactly = () => {
    if (appliedQuery === null) {
      return;
    }
    const filter = appliedQuery.filter.size === 0 ? bsonDoc({ _id: bsonDoc({ $exists: true }) }) : appliedQuery.filter;
    countDocs(ns, filter, undefined, appliedQuery.options).then(
      (r) => {
        setTotal({ count: r.count, exact: r.count !== null });
        if (r.count !== null) {
          notify(t("문서 {count}개", { count: r.count.toLocaleString() }));
        }
      },
      (error: unknown) => notifyError(error, { context: "document" }),
    );
  };

  // ---- Running ----

  const run = useCallback(
    (next: QueryText) => {
      const parsed = parseQuery(next);
      setQuery(next);
      if (!parsed.ok) {
        setQueryError(parsed.error);
        if (parsed.error.key !== "filter") {
          setOptsOpen(true);
        }
        return;
      }
      setQueryError(null);
      recordQuery(nsText, next);
      if (["projection", "sort", "skip", "limit", "locale", "strength", "hint", "maxTimeMS"].some((k) => next[k as keyof QueryText].trim() !== "")) {
        setOptsOpen(true);
      }
      if (sub === "explain") {
        setExplainSeq((n) => n + 1);
        return;
      }
      setSub("docs");
      setPicked(null);
      setApplied(next);
      setPage(0);
      setPath([]);
      setReloadSeq((n) => n + 1);
    },
    [nsText, sub],
  );

  const runCurrent = () => run(query);

  // ---- Document actions ----

  // The stored document for a projected row (edits that replace it must
  // start from all its fields).
  const fullDoc = async (doc: BsonDocument): Promise<BsonDocument> => {
    if (appliedQuery === null || appliedQuery.projection === null || !doc.has("_id")) {
      return doc;
    }
    return (await find(ns, { filter: idFilter(doc), limit: 1 })).docs[0] ?? doc;
  };

  const openEditor = async (mode: "insert" | "clone" | "replace", doc: BsonDocument | null) => {
    try {
      if (mode === "insert" || doc === null) {
        const template = templateDoc(fields);
        setEditor({ mode: "insert", doc: template, initial: insertDraftRef.current ?? toShellPretty(template) });
        insertDraftRef.current = null;
        return;
      }
      const full = await fullDoc(doc);
      const shown = mode === "clone" ? new Map([...full].filter(([k]) => k !== "_id")) : full;
      setEditor({ mode, doc: full, initial: toShellPretty(shown) });
    } catch (error) {
      notifyError(error, { context: "document" });
    }
  };

  const submitEditor = async (value: BsonDocument): Promise<Error | null> => {
    if (editor === null) {
      return null;
    }
    if (editor.mode === "replace") {
      const failure = await edits.replace(editor.doc, value);
      if (failure === null) {
        setEditor(null);
      }
      return failure;
    }
    try {
      const ids = await insert(ns, [value]);
      setEditor(null);
      const id = ids[0];
      // The new document alone, so it can be seen at once.
      if (id !== undefined) {
        run({ ...EMPTY_QUERY, filter: `{ _id: ${toShell(id)} }` });
      } else {
        reload();
      }
      notify(editor.mode === "clone" ? t("복제했습니다 — 필터로 새 문서만 보여 줍니다") : t("추가했습니다 — 필터로 새 문서만 보여 줍니다"));
      setStatsSeq((n) => n + 1);
      return null;
    } catch (error) {
      return asError(error);
    }
  };

  const deleteDoc = async (doc: BsonDocument) => {
    const id = doc.get("_id");
    if (id === undefined) {
      return;
    }
    const idText = id instanceof ObjectId ? id.hex : toShell(id);
    const ok = await host.confirm({
      title: t("문서 삭제"),
      message: t("이 문서를 삭제할까요?\n_id: {id}\n되돌릴 수 없습니다.", { id: idText }),
      command: `db.${coll}.deleteOne({ _id: ${toShell(id)} })`,
      okLabel: t("삭제"),
    });
    if (!ok) {
      return;
    }
    try {
      const deleted = await remove(ns, idFilter(doc), false);
      notify(deleted > 0 ? t("문서를 삭제했습니다") : t("다른 곳에서 삭제되었습니다"));
      reload();
    } catch (error) {
      notifyError(error, { context: "document" });
    }
  };

  const copyPage = () => {
    const docs = result?.docs ?? [];
    void writeClipboard(canonical ? stringifyJson(docs.map(toEJSON), 2) : toShellPretty(docs), notify);
    notify(t("문서 {count}개를 복사했습니다", { count: docs.length }));
  };

  // A plan's index suggestion (실행 계획, 집계): 인덱스 with the create
  // dialog open on those keys. A view has no indexes of its own; the index
  // belongs on the collection it reads.
  const requestIndex = (keys: BsonDocument) => {
    if (readOnly) {
      notify(t("뷰에는 인덱스를 만들 수 없습니다. 뷰가 읽는 컬렉션에 만드세요."));
      return;
    }
    setIndexRequest((prev) => ({ seq: (prev?.seq ?? 0) + 1, keys }));
    setSub("indexes");
  };

  // ---- Shortcuts ----

  const switchView = useCallback((next: DocView) => {
    setView(next);
  }, []);

  useEffect(() => {
    if (!active) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      const next = sub === "docs" ? viewForKey(event) : null;
      if (next !== null) {
        event.preventDefault();
        switchView(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, sub, switchView]);

  // The app's refresh (F5) reloads the page and the stats.
  const firstRefresh = useRef(refreshSeq);
  useEffect(() => {
    if (refreshSeq !== firstRefresh.current) {
      reload();
    }
  }, [refreshSeq, reload]);

  // ---- Rendering ----

  const docs = result?.docs ?? [];
  const start = result?.start ?? page * pageSize;
  const limitCap = appliedQuery !== null && appliedQuery.limit > 0 ? appliedQuery.limit : null;
  const skipped = appliedQuery?.skip ?? 0;
  const knownTotal = total?.count == null ? null : Math.max(0, total.count - skipped);
  const shownTotal = knownTotal === null ? null : limitCap === null ? knownTotal : Math.min(knownTotal, limitCap);
  const pages = shownTotal === null ? null : Math.max(1, Math.ceil(shownTotal / pageSize));
  const hasNext = pages !== null ? page < pages - 1 : docs.length === pageSize && (limitCap === null || start + pageSize < limitCap);
  let rangeText: string;
  if (loadError !== null) {
    rangeText = t("불러오지 못했습니다");
  } else if (loading && result === null) {
    rangeText = t("불러오는 중…");
  } else if (docs.length === 0 && page === 0) {
    rangeText = t("문서 없음");
  } else {
    const range = { from: (start + 1).toLocaleString(), to: (start + docs.length).toLocaleString() };
    if (total === null) {
      rangeText = t("{from}–{to} / …", range);
    } else if (total.failed === true) {
      // The count itself failed: say only which documents these are.
      rangeText = t("{from}–{to}번째 문서", range);
    } else if (shownTotal === null) {
      rangeText = t("{from}–{to} / 많은 문서 (세는 데 오래 걸림)", range);
    } else {
      rangeText = t("{from}–{to} / {total}개 문서", { ...range, total: `${total.exact ? "" : "≈ "}${shownTotal.toLocaleString()}` });
    }
  }
  const editable = !readOnly;
  const projected = appliedQuery?.projection != null;

  const chips = stats === null ? null : (
    <>
      <span className="mg-stat">
        <span className="mg-stat-k">{t("문서")}</span>
        <span className="mg-stat-v">{stats.count.toLocaleString()}</span>
      </span>
      <span className="mg-stat" title={t("BSON 크기")}>
        <span className="mg-stat-k">{t("크기")}</span>
        <span className="mg-stat-v">{formatBytes(stats.size)}</span>
      </span>
      <span className="mg-stat">
        <span className="mg-stat-k">{t("평균")}</span>
        <span className="mg-stat-v">{formatBytes(stats.avgObjSize)}</span>
      </span>
      {readOnly && stats.nindexes === 0 ? null : (
        <span className="mg-stat">
          <span className="mg-stat-k">{t("인덱스")}</span>
          <span className="mg-stat-v">
            {stats.nindexes} · {formatBytes(stats.totalIndexSize)}
          </span>
        </span>
      )}
    </>
  );

  let body;
  if (view === "cards") {
    body = (
      <CardView
        docs={docs}
        offset={start}
        readOnly={!editable}
        allOpen={allOpen}
        onSave={editable ? edits.save : undefined}
        onEditJson={(doc) => void openEditor("replace", doc)}
        onClone={(doc) => void openEditor("clone", doc)}
        onDelete={(doc) => void deleteDoc(doc)}
        notify={notify}
        onDirtyCount={setDirtyCount}
        emptyText={loadError !== null ? t("불러오지 못했습니다") : undefined}
        selected={picked}
        onSelect={setPicked}
      />
    );
  } else if (view === "json") {
    body = (
      <JsonView
        docs={docs}
        offset={start}
        canonical={canonical}
        allFolded={jsonFolded}
        readOnly={!editable || projected}
        completion={completion}
        onSave={editable && !projected ? edits.replace : undefined}
        onClone={(doc) => void openEditor("clone", doc)}
        onDelete={(doc) => void deleteDoc(doc)}
        notify={notify}
        emptyText={loadError !== null ? t("불러오지 못했습니다") : undefined}
        selected={picked}
        onSelect={setPicked}
      />
    );
  } else {
    body = (
      <DocTableView
        ns={ns}
        connKey={connKey}
        docs={docs}
        readOnly={!editable}
        sort={appliedQuery?.sort ?? null}
        onSort={(sort) => run({ ...applied, sort: sort === null ? "" : toShell(sort) })}
        save={edits.save}
        facts={facts}
        path={path}
        onPathChange={setPath}
      />
    );
  }
  const pickedAt = picked === null ? -1 : docs.findIndex((doc, i) => docKey(doc, start + i) === picked);

  // A validation failure's "검증 탭 열기"; views and read-only tabs have none.
  const openValidation = readOnly ? null : () => setSub("validation");

  return (
    <OpenValidationContext.Provider value={openValidation}>
    <div className="mg-root mg-coll">
      <div className="mg-subbar">
        <div className="mg-subtabs" role="tablist">
          {SUBTABS.filter((s) => !(readOnly && (s.id === "indexes" || s.id === "validation" || s.id === "changes"))).map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={sub === s.id} className={sub === s.id ? "active" : undefined} onClick={() => setSub(s.id)}>
              {t(s.label)}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <div className="mg-substats">{chips}</div>
      </div>
      {sub === "docs" || sub === "explain" ? (
        <QueryBar
          ns={nsText}
          namespace={ns}
          query={query}
          onChange={setQuery}
          optsOpen={optsOpen}
          onOptsOpenChange={setOptsOpen}
          error={queryError}
          completion={completion}
          fields={fields}
          onRun={runCurrent}
          onApply={run}
          onExplain={() => {
            setSub("explain");
            setExplainSeq((n) => n + 1);
          }}
        />
      ) : null}
      <div className="mg-panes">
        {sub === "docs" ? (
          <div className="mg-pane mg-docs-pane">
            <div className="data-toolbar mg-docbar">
              <div className="footer-start">
                {editable ? (
                  <button
                    type="button"
                    className="footer-button"
                    title={t("문서 추가")}
                    onClick={(event) => {
                      const r = event.currentTarget.getBoundingClientRect();
                      setAddMenu({ x: r.left, y: r.bottom + 4 });
                    }}
                  >
                    <PlusIcon size={11} />
                    <span className="footer-label">{t("문서")}</span>
                    <ChevronDownIcon size={7} />
                  </button>
                ) : null}
                {view !== "table" ? (
                  <button
                    type="button"
                    className="footer-button"
                    title={t("모든 하위 값 펼치기/접기")}
                    onClick={() => (view === "json" ? setJsonFolded(!jsonFolded) : setAllOpen(!allOpen))}
                  >
                    {expanded ? <CollapseIcon size={10} /> : <ExpandIcon size={10} />}
                    <span className="footer-label">{expanded ? t("모두 접기") : t("모두 펼치기")}</span>
                  </button>
                ) : null}
                {view === "json" ? (
                  <>
                    <button type="button" className={`footer-button${canonical ? " active" : ""}`} title={t("Extended JSON (canonical)로 보기")} aria-pressed={canonical} onClick={() => setCanonical(!canonical)}>
                      EJSON
                    </button>
                    <button type="button" className="footer-button" title={t("이 페이지의 문서를 모두 복사")} onClick={copyPage}>
                      <CopyIcon size={10} />
                      <span className="footer-label">{t("페이지 복사")}</span>
                    </button>
                  </>
                ) : null}
                {dirtyCount > 0 && view === "cards" ? <span className="mg-dirty-note">{t("저장하지 않은 문서 {count}개", { count: dirtyCount })}</span> : null}
                <button
                  type="button"
                  className="footer-button"
                  title={t("이 쿼리를 드라이버 코드로 (Python·Node.js·Java·C#·Go·Rust·PHP·Ruby·mongosh)")}
                  disabled={!liveQuery.ok && appliedQuery === null}
                  onClick={() => setCodeQuery(liveQuery.ok ? liveQuery.value : appliedQuery)}
                >
                  <CodeIcon size={11} />
                  <span className="footer-label">{t("코드로")}</span>
                </button>
                <button type="button" className="footer-button" title={t("이 쿼리의 결과를 파일로 내보내기 (JSON·NDJSON·CSV)")} disabled={appliedQuery === null} onClick={() => setExportOpen(true)}>
                  <DownloadIcon size={11} />
                  <span className="footer-label">{t("내보내기")}</span>
                </button>
                {editable ? (
                  <>
                    <button type="button" className="footer-button" title={t("지금 필터에 맞는 문서를 한꺼번에 고치기 (updateMany)")} onClick={() => setBulk("update")}>
                      <PencilIcon size={10} />
                      <span className="footer-label">{t("일괄 수정")}</span>
                    </button>
                    <button type="button" className="footer-button" title={t("지금 필터에 맞는 문서를 한꺼번에 지우기 (deleteMany)")} onClick={() => setBulk("delete")}>
                      <TrashIcon size={10} />
                      <span className="footer-label">{t("일괄 삭제")}</span>
                    </button>
                  </>
                ) : null}
              </div>
              <div className="footer-end">
                <ViewSwitch view={view} onChange={switchView} />
              </div>
            </div>
            <div className="result-body mg-result-body">
              <div className={`mg-docbody${loadError !== null ? " stale" : ""}`}>{body}</div>
              {/* Over the last page (dimmed), not above it; a dead TablePeek
                  server is the app banner's to tell. */}
              {loadError !== null && !isAppServerDown(loadError) ? (
                <div className="mg-load-error">
                  <ErrorNotice error={loadError} context="document" engine="mongodb" variant="banner" onRetry={reload} onClose={() => setLoadError(null)} />
                </div>
              ) : null}
              {loading ? (
                <div className="result-loading" role="status">
                  <Spinner size={12} />
                  {t("불러오는 중…")}
                </div>
              ) : null}
            </div>
            <div className="data-toolbar mg-pager">
              <div className="footer-start" />
              <div className="footer-middle">
                <button
                  type="button"
                  className="row-range"
                  title={`${result ? `${Math.round(result.elapsedMs)} ms · ` : ""}${total !== null && !total.exact ? t("추정치 — 눌러서 정확히 세기") : t("정확한 문서 수")}`}
                  onClick={() => total !== null && !total.exact && countExactly()}
                >
                  {rangeText}
                </button>
              </div>
              <div className="footer-end">
                <button type="button" className="icon-button" title={t("새로고침 (F5)")} aria-label={t("새로고침")} onClick={reload}>
                  <RefreshIcon size={12} />
                </button>
                <button
                  type="button"
                  className="footer-button mg-pagesize"
                  title={t("한 페이지 문서 수")}
                  onClick={(event) => {
                    const r = event.currentTarget.getBoundingClientRect();
                    setSizeMenu({ x: r.left, y: r.top - 4 - PAGE_SIZES.length * 28 });
                  }}
                >
                  {t("{count}개씩", { count: pageSize })}
                </button>
                <span className="page-nav">
                  <button type="button" title={t("이전 페이지")} aria-label={t("이전 페이지")} disabled={page === 0} onClick={() => setPage(page - 1)}>
                    ‹
                  </button>
                  <span className="page-label" title={t("페이지")}>
                    {page + 1} / {pages === null ? "…" : pages}
                  </span>
                  <button type="button" title={t("다음 페이지")} aria-label={t("다음 페이지")} disabled={!hasNext} onClick={() => setPage(page + 1)}>
                    ›
                  </button>
                </span>
              </div>
            </div>
          </div>
        ) : null}
        {sub === "agg" ? (
          <AggregationPanel
            ns={ns}
            connKey={connKey}
            tabKey={tabKey}
            draft={aggDraft}
            onDraftChange={onAggDraftChange}
            collections={collections}
            maxTimeMS={maxTimeMS}
            host={host}
            facts={facts}
            onCreateIndex={requestIndex}
            onCollectionsChanged={onCollectionsChanged}
            onOpenCollection={onOpenCollection}
            onOpenShell={onOpenShell}
            refreshSeq={refreshSeq}
          />
        ) : null}
        {sub === "schema" ? (
          <div className="mg-pane">
            <SchemaPanel
              ns={ns}
              facts={facts}
              filterText={query.filter}
              active={sub === "schema"}
              host={host}
              onFilter={(path, value) => run({ ...query, filter: withFilterValue(query.filter, path, value) })}
              onDraft={
                readOnly
                  ? undefined
                  : (schema) => {
                      setSchemaDraft((prev) => ({ seq: (prev?.seq ?? 0) + 1, schema }));
                      setSub("validation");
                    }
              }
            />
          </div>
        ) : null}
        {sub === "validation" ? (
          <div className="mg-pane">
            <ValidationPanel ns={ns} readOnly={readOnly} active={sub === "validation"} host={host} draft={schemaDraft} />
            <DocDetailPanel>{(q) => <FactsList title={<span className="mg-detail-path mono">{coll}</span>} facts={facts} query={q} />}</DocDetailPanel>
          </div>
        ) : null}
        {sub === "indexes" ? (
          <div className="mg-pane">
            <IndexesPanel ns={ns} readOnly={readOnly} fields={fields.map((f) => f.path)} createRequest={indexRequest} host={host} facts={facts} onChanged={() => setStatsSeq((n) => n + 1)} />
          </div>
        ) : null}
        {sub === "explain" ? (
          <div className="mg-pane">
            <ExplainPanel
              ns={ns}
              facts={facts}
              query={liveQuery.ok ? liveQuery.value : { error: say(liveQuery.error.message) }}
              active={sub === "explain"}
              runSeq={explainSeq}
              onCreateIndex={requestIndex}
            />
          </div>
        ) : null}
        {sub === "changes" ? <ChangeStreamPanel conn={conn} db={db} coll={coll} sessionKey={tabKey} notify={notify} facts={facts} /> : null}
      </div>
      {sub === "docs" && view !== "table" ? (
        <DocDetailPanel>
          {(q) =>
            pickedAt >= 0 ? (
              <DocDetail ns={ns} doc={docs[pickedAt]} position={start + pickedAt} save={editable ? edits.save : undefined} query={q} />
            ) : (
              <NothingSelected facts={facts} query={q} />
            )
          }
        </DocDetailPanel>
      ) : null}
      {sizeMenu !== null ? (
        <ContextMenu
          x={sizeMenu.x}
          y={sizeMenu.y}
          items={PAGE_SIZES.map((n) => ({
            label: t("{count}개씩", { count: n }),
            checked: n === pageSize,
            onSelect: () => {
              setPageSize(n);
              setPage(0);
            },
          }))}
          onClose={() => setSizeMenu(null)}
        />
      ) : null}
      {addMenu !== null ? <ContextMenu x={addMenu.x} y={addMenu.y} items={[{ label: t("문서 추가 (JSON)…"), onSelect: () => void openEditor("insert", null) }]} onClose={() => setAddMenu(null)} /> : null}
      {editor !== null ? (
        <InsertDocModal
          title={editor.mode === "insert" ? t("문서 추가") : editor.mode === "clone" ? t("문서 복제") : t("문서 편집")}
          path={editor.mode === "replace" && editor.doc.has("_id") ? `${nsText} · _id ${toShell(editor.doc.get("_id") ?? null)}` : nsText}
          initial={editor.initial}
          okLabel={editor.mode === "replace" ? t("저장 (replaceOne)") : t("추가 (insertOne)")}
          hint={editor.mode === "replace" ? t("_id는 바꿀 수 없습니다 · ⌘↩ 저장") : t("_id는 비워 두면 자동으로 만듭니다 · ⌘↩ 추가")}
          completion={completion}
          onSubmit={submitEditor}
          onClose={() => setEditor(null)}
          onOpenValidation={
            openValidation === null || editor.mode === "replace"
              ? undefined
              : (text) => {
                  insertDraftRef.current = text;
                  setEditor(null);
                  openValidation();
                }
          }
        />
      ) : null}
      {confirm !== null ? <ConfirmModal request={confirm.request} onResult={confirm.resolve} /> : null}
      {exportOpen && appliedQuery !== null ? (
        <ExportModal
          ns={ns}
          source={{ kind: "find", filter: appliedQuery.filter, projection: appliedQuery.projection, sort: appliedQuery.sort, skip: appliedQuery.skip, limit: appliedQuery.limit > 0 ? appliedQuery.limit : null, options: appliedQuery.options }}
          notify={notify}
          onClose={() => setExportOpen(false)}
        />
      ) : null}
      {codeQuery !== null ? (
        <CodeExportModal
          ns={ns}
          source={{ kind: "find", filter: codeQuery.filter, projection: codeQuery.projection, sort: codeQuery.sort, skip: codeQuery.skip, limit: codeQuery.limit }}
          options={codeQuery.options}
          onOpenShell={onOpenShell === undefined ? undefined : (code) => {
            onOpenShell(db, code);
            setCodeQuery(null);
          }}
          notify={notify}
          onClose={() => setCodeQuery(null)}
        />
      ) : null}
      {bulk !== null ? (
        <BulkModal
          ns={ns}
          mode={bulk}
          filterText={query.filter}
          options={liveQuery.ok ? liveQuery.value.options : appliedQuery?.options}
          safeMode={safeMode}
          completion={completion}
          notify={notify}
          onDone={reload}
          onClose={() => setBulk(null)}
        />
      ) : null}
      {edits.conflict !== null ? <ConflictModal conflict={edits.conflict} /> : null}
    </div>
    </OpenValidationContext.Provider>
  );
}
