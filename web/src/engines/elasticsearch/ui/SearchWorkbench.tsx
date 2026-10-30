// An index tab of the search workbench (docs/engines/elasticsearch.md):
// sub-tabs 문서 | 매핑 | 설정 | 별칭 | SQL | 분석 | 실행 계획 with the index's
// stats, the query bar (Lucene query string, Query DSL, sort, fields), the
// results toolbar (+ 문서, fold all, copy page, export, by-query writes,
// the ☰ / {} / ⊞ switch shared with MongoDB), the hits in the chosen view and
// the pager. What the tab shows is remembered per tab across remounts and
// saved with the tab across reloads. A picked hit (or with none, the index's
// facts) shows in the app's detail panel, as in a MongoDB collection tab.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { writeClipboard } from "../../../clipboard";
import { ContextMenu } from "../../../components/ContextMenu";
import { ErrorNotice, notifyError } from "../../../components/ErrorNotice";
import { ChevronDownIcon, CopyIcon, DownloadIcon, PencilIcon, PlusIcon, RefreshIcon, TrashIcon, UploadIcon } from "../../../components/icons";
import { Spinner } from "../../../components/Spinner";
import { isAppServerDown } from "../../../errorHelp";
import { formatBytes } from "../../../format";
import { t } from "../../../i18n";
import { store } from "../../../store";
import { Int32, isNumber, jsonObject, type BsonDocument, type BsonValue } from "../../mongodb/bson";
import { CardView, docKey } from "../../mongodb/ui/CardView";
import { DocDetail, DocDetailPanel, FactsList, NothingSelected, type Fact } from "../../mongodb/ui/DocDetailPanel";
import { DocActionsContext, type DocActions } from "../../mongodb/ui/docMenus";
import { ConflictModal } from "../../mongodb/ui/DocModals";
import { DocTableView } from "../../mongodb/ui/DocTableView";
import { CollapseIcon, ExpandIcon } from "../../mongodb/ui/icons";
import { JsonView } from "../../mongodb/ui/JsonView";
import type { SaveEdits } from "../../mongodb/ui/types";
import { ViewSwitch, viewForKey, type DocView } from "../../mongodb/ui/ViewSwitch";
import { deleteDoc, getDoc, getMapping, guardOf, hitOf, indexDoc, indices, isAbort, isForbidden, isVersionConflict, privileges, search, type IndexRow, type SearchResult } from "../api";
import { mappingFields, type MappedField } from "../dsl";
import { docFromJson, jsonText, type Json } from "../json";
import { EMPTY_QUERY, normalizeQuery, parseQuery, recordQuery, searchBody, withHiddenSource, withLuceneCondition, type QueryError, type QueryText } from "../query";
import { AliasesPanel } from "./AliasesPanel";
import { AnalyzePanel } from "./AnalyzePanel";
import { requestText, type SearchHost } from "./common";
import { ByQueryModal, DocEditorModal, type ByQueryMode, type DocEditorRequest } from "./DocModals";
import { MappingPanel } from "./MappingPanel";
import { ProfilePanel } from "./ProfilePanel";
import { QueryBar } from "./QueryBar";
import { SettingsPanel } from "./SettingsPanel";
import { SqlPanel } from "./SqlPanel";
import type { SearchAdminRequest, SearchQuery, TargetKind } from "./types";
import { useSearchEdits } from "./useSearchEdits";
import "../../mongodb/mongodb.css";
import "./search.css";

export type SearchSubTab = "docs" | "mapping" | "settings" | "aliases" | "sql" | "analyze" | "profile";

// What an index tab keeps across a page reload.
export interface SearchTabState {
  sub: SearchSubTab;
  view: DocView;
  query: QueryText;
  applied: QueryText;
  dslOpen: boolean;
}

const SUBTABS: { id: SearchSubTab; label: string }[] = [
  { id: "docs", label: "문서" },
  { id: "mapping", label: "매핑" },
  { id: "settings", label: "설정" },
  { id: "aliases", label: "별칭" },
  { id: "sql", label: "SQL" },
  { id: "analyze", label: "분석" },
  { id: "profile", label: "실행 계획" },
];

const PAGE_SIZES = [10, 20, 50, 100];
// `from + size` beyond this fails (index.max_result_window's default); later
// pages continue after the previous page's last sort values.
const RESULT_WINDOW = 10_000;

interface TabMemory {
  sub: SearchSubTab;
  query: QueryText;
  applied: QueryText;
  dslOpen: boolean;
  view: DocView;
  page: number;
  pageSize: number;
  path: string[];
}

const memory = new Map<string, TabMemory>();

export interface SearchWorkbenchProps {
  host: SearchHost;
  // The connection's stable key (as App keys column widths by).
  connKey: string;
  index: string;
  kind: TargetKind;
  tabKey: string;
  persisted?: SearchTabState;
  onPersist(state: SearchTabState): void;
  active: boolean;
  // Bumped by the app's refresh (F5).
  refreshSeq: number;
  // Indices, aliases or fields changed here: the sidebar reads again.
  onChanged(): void;
  // Opens a management dialog (import, export).
  onAdmin(request: SearchAdminRequest): void;
}

interface PageResult {
  result: SearchResult;
  start: number;
}

// The stats of what the tab opened: the index itself, every index behind an
// alias, or a data stream's backing indices.
function rowsOf(all: IndexRow[], index: string, kind: TargetKind): IndexRow[] {
  if (kind === "alias") {
    return all.filter((row) => row.aliases.includes(index));
  }
  if (kind === "data_stream") {
    return all.filter((row) => row.data_stream === index);
  }
  return all.filter((row) => row.name === index);
}

const HEALTH_RANK: Record<string, number> = { green: 0, yellow: 1, red: 2 };

export function SearchWorkbench({ host, connKey, index, kind, tabKey, persisted, onPersist, active, refreshSeq, onChanged, onAdmin }: SearchWorkbenchProps) {
  const { conn, notify } = host;
  const remembered = memory.get(tabKey);
  const [sub, setSub] = useState<SearchSubTab>(remembered?.sub ?? persisted?.sub ?? "docs");
  const [query, setQuery] = useState<QueryText>(remembered?.query ?? normalizeQuery(persisted?.query));
  const [applied, setApplied] = useState<QueryText>(remembered?.applied ?? normalizeQuery(persisted?.applied));
  const [dslOpen, setDslOpen] = useState(remembered?.dslOpen ?? persisted?.dslOpen ?? false);
  const [view, setView] = useState<DocView>(remembered?.view ?? persisted?.view ?? "cards");
  const [page, setPage] = useState(remembered?.page ?? 0);
  const [pageSize, setPageSize] = useState(remembered?.pageSize ?? 20);
  const [path, setPath] = useState<string[]>(remembered?.path ?? []);
  const [allOpen, setAllOpen] = useState(false);
  const [jsonFolded, setJsonFolded] = useState(false);
  const expanded = view === "json" ? !jsonFolded : allOpen;

  const [pageResult, setPageResult] = useState<PageResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const serverEpoch = useSyncExternalStore(store.subscribe, () => store.getState().server.epoch);
  const [queryError, setQueryError] = useState<QueryError | null>(null);
  const [rows, setRows] = useState<IndexRow[] | null>(null);
  const [fields, setFields] = useState<MappedField[]>([]);
  const [dirtyCount, setDirtyCount] = useState(0);
  const [reloadSeq, setReloadSeq] = useState(0);
  const [statsSeq, setStatsSeq] = useState(0);
  const [profileSeq, setProfileSeq] = useState(0);
  const [sizeMenu, setSizeMenu] = useState<{ x: number; y: number } | null>(null);
  const [editor, setEditor] = useState<DocEditorRequest | null>(null);
  const [byQuery, setByQuery] = useState<ByQueryMode | null>(null);
  // The card or JSON block in the app's detail panel (its docKey).
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    memory.set(tabKey, { sub, query, applied, dslOpen, view, page, pageSize, path });
  }, [tabKey, sub, query, applied, dslOpen, view, page, pageSize, path]);

  const persistedText = JSON.stringify(persisted ?? null);
  useEffect(() => {
    const next: SearchTabState = { sub, view, query, applied, dslOpen };
    if (JSON.stringify(next) !== persistedText) {
      onPersist(next);
    }
    // onPersist is a fresh closure each render; the values are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub, view, query, applied, dslOpen]);

  const parsedApplied = useMemo(() => parseQuery(applied), [applied]);
  const appliedQuery = parsedApplied.ok ? parsedApplied.value : null;
  const liveQuery = useMemo(() => parseQuery(query), [query]);
  const projected = appliedQuery?.source != null;

  const reload = useCallback(() => {
    setReloadSeq((n) => n + 1);
    setStatsSeq((n) => n + 1);
  }, []);

  const edits = useSearchEdits(conn, projected, reload, notify);
  // The user may not write here: the server's privilege check said so, or a
  // write was refused for the user's rights. Edit affordances then hide.
  const [denied, setDenied] = useState(false);
  const tabHost: SearchHost = denied && !host.readOnly ? { ...host, readOnly: true } : host;
  const noteRefusal = useCallback((failure: Error | null): Error | null => {
    if (failure !== null && isForbidden(failure)) {
      setDenied(true);
    }
    return failure;
  }, []);
  const save = useCallback<SaveEdits>((original, list) => edits.save(original, list).then(noteRefusal), [edits.save, noteRefusal]);
  const replace = useCallback((original: BsonDocument, value: BsonDocument) => edits.replace(original, value).then(noteRefusal), [edits.replace, noteRefusal]);

  useEffect(() => {
    const controller = new AbortController();
    setDenied(false);
    privileges(conn, index, controller.signal).then(
      (p) => setDenied(p.known && !p.index.write),
      () => undefined,
    );
    return () => controller.abort();
  }, [conn, index, serverEpoch]);

  // The mapping type of a field path (array positions dropped), shown on
  // cards and in the detail panel instead of the JSON value's type.
  const fieldTypes = useMemo(() => new Map(fields.map((f) => [f.path, f.type])), [fields]);
  const typeLabel = useCallback(
    (path: string) => (path === "_id" ? "_id" : (fieldTypes.get(path.split(".").filter((part) => !/^\d+$/.test(part)).join(".")) ?? (fields.length > 0 ? t("매핑 없음") : null))),
    [fieldTypes, fields.length],
  );

  // ---- Loading ----

  // Stats chips and the detail panel's facts.
  useEffect(() => {
    const controller = new AbortController();
    indices(conn, true, controller.signal).then(
      (all) => setRows(rowsOf(all, index, kind)),
      (error: unknown) => {
        if (!isAbort(error)) {
          setRows(null);
        }
      },
    );
    return () => controller.abort();
  }, [conn, index, kind, statsSeq, serverEpoch]);

  // Field paths of every index behind the name, for completion.
  useEffect(() => {
    const controller = new AbortController();
    getMapping(conn, index, controller.signal).then(
      (mapping) => {
        const seen = new Map<string, MappedField>();
        for (const name of Object.keys(mapping)) {
          for (const field of mappingFields({ [name]: mapping[name] })) {
            if (!seen.has(field.path)) {
              seen.set(field.path, field);
            }
          }
        }
        setFields([...seen.values()]);
      },
      (error: unknown) => {
        if (!isAbort(error)) {
          setFields([]);
        }
      },
    );
    return () => controller.abort();
  }, [conn, index, statsSeq, serverEpoch]);

  // The page: `from` within the result window; past it, `search_after` the
  // previous page's last sort values (the sort then must be set).
  const anchorRef = useRef<{ key: string; page: number; after: Json[] } | null>(null);
  useEffect(() => {
    if (sub !== "docs" || appliedQuery === null) {
      return;
    }
    const q = appliedQuery;
    const controller = new AbortController();
    const start = page * pageSize;
    const queryKey = `${JSON.stringify(applied)}|${pageSize}`;
    const anchor = anchorRef.current;
    const pastWindow = start + pageSize > RESULT_WINDOW;
    const after = pastWindow && anchor !== null && anchor.key === queryKey && anchor.page === page - 1 ? anchor.after : null;
    if (pastWindow && after === null) {
      setLoadError(new Error(t("{count}번째 문서 뒤로는 정렬을 정하고 한 페이지씩 넘기세요 (search_after). 또는 내보내기를 쓰세요.", { count: RESULT_WINDOW.toLocaleString() })));
      return;
    }
    setLoading(true);
    setLoadError(null);
    const body = jsonObject<Json>([
      ...(q.query !== null ? ([["query", q.query]] as [string, Json][]) : []),
      ["seq_no_primary_term", true],
      ...(q.highlight ? ([["highlight", jsonObject<Json>([["fields", jsonObject([["*", jsonObject([])]])], ["require_field_match", false], ["number_of_fragments", 2], ["fragment_size", 80]])]] as [string, Json][]) : []),
    ]);
    search(
      conn,
      {
        index,
        body,
        from: after === null ? start : undefined,
        size: pageSize,
        sort: q.sort ?? undefined,
        search_after: after ?? undefined,
        source: q.source ?? undefined,
        track_total_hits: true,
      },
      controller.signal,
    ).then(
      (result) => {
        setPageResult({ result, start });
        setLoading(false);
        const last = result.hits[result.hits.length - 1];
        anchorRef.current = last?.sort ? { key: queryKey, page, after: last.sort } : null;
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
  }, [conn, index, sub, applied, appliedQuery, page, pageSize, reloadSeq, serverEpoch]);

  // ---- Running ----

  const run = useCallback(
    (next: QueryText) => {
      const parsed = parseQuery(next);
      setQuery(next);
      if (!parsed.ok) {
        setQueryError(parsed.error);
        if (parsed.error.key === "dsl") {
          setDslOpen(true);
        }
        return;
      }
      setQueryError(null);
      recordQuery(`${connKey}|${index}`, next);
      if (sub === "profile") {
        setProfileSeq((n) => n + 1);
        return;
      }
      setSub("docs");
      setApplied(next);
      setPage(0);
      setPath([]);
      setReloadSeq((n) => n + 1);
    },
    [connKey, index, sub],
  );

  // ---- Document actions ----

  const editable = !tabHost.readOnly;
  const docs = pageResult?.result.hits.map((hit) => hit.doc) ?? [];

  const openEditor = (mode: DocEditorRequest["mode"], doc: BsonDocument | null) => {
    const hit = doc === null ? undefined : hitOf(doc);
    if (mode === "insert" || hit === undefined) {
      const sample = fields.filter((f) => !f.multi && !f.path.includes(".") && f.type !== "object" && f.type !== "nested").slice(0, 8);
      const template = sample.length === 0 ? "{\n  \n}" : `{\n${sample.map((f) => `  "${f.path}": ${["text", "keyword", "date", "ip", "match_only_text", "wildcard"].includes(f.type) ? '""' : f.type === "boolean" ? "false" : "null"}`).join(",\n")}\n}`;
      setEditor({ mode: "insert", index, initial: template });
      return;
    }
    const load = async () => {
      // A filtered page holds only some fields; edit the stored document.
      const source = projected ? (await getDoc(conn, hit.index, hit.id, hit.routing)).source : hit.source;
      setEditor({ mode, index: hit.index, hit, initial: mode === "clone" ? jsonText(source) : jsonText(new Map<string, BsonValue>([["_id", hit.id], ...source])) });
    };
    load().catch((error: unknown) => notifyError(error, { context: "document" }));
  };

  const submitEditor = async (id: string | null, source: Json): Promise<Error | null> => {
    if (editor === null) {
      return null;
    }
    if (editor.mode === "replace" && editor.hit !== undefined) {
      const failure = await replace(editor.hit.doc, new Map<string, BsonValue>([["_id", editor.hit.id], ...docFromJson(source)]));
      if (failure === null) {
        setEditor(null);
      }
      return failure;
    }
    try {
      const written = await indexDoc(conn, { index: editor.index, id: id ?? undefined, doc: source, op_type: id !== null ? "create" : "index" });
      setEditor(null);
      notify(editor.mode === "clone" ? t("복제했습니다 — 필터로 새 문서만 보여 줍니다") : t("추가했습니다 — 필터로 새 문서만 보여 줍니다"));
      run({ ...EMPTY_QUERY, dsl: `{ "ids": { "values": [${JSON.stringify(written.id)}] } }` });
      setDslOpen(true);
      setStatsSeq((n) => n + 1);
      onChanged();
      return null;
    } catch (error) {
      return noteRefusal(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const removeDoc = async (doc: BsonDocument) => {
    const hit = hitOf(doc);
    if (hit === undefined) {
      return;
    }
    const ok = await host.confirm({
      title: t("문서 삭제"),
      message: t("이 문서를 삭제할까요?\n_id: {id}\n되돌릴 수 없습니다.", { id: hit.id }),
      command: requestText("DELETE", `/${hit.index}/_doc/${encodeURIComponent(hit.id)}`),
      okLabel: t("삭제"),
    });
    if (!ok) {
      return;
    }
    try {
      await deleteDoc(conn, { index: hit.index, id: hit.id, routing: hit.routing, ...guardOf(hit) });
      notify(t("문서를 삭제했습니다"));
    } catch (error) {
      if (isVersionConflict(error)) {
        notify(t("다른 곳에서 바뀌어 지우지 않았습니다 — 다시 불러왔습니다"));
      } else {
        if (isForbidden(error)) {
          setDenied(true);
        }
        notifyError(error, { context: "document" });
        return;
      }
    }
    reload();
    onChanged();
  };

  const copyPage = () => {
    const text = `[\n${(pageResult?.result.hits ?? []).map((hit) => jsonText(hit.doc)).join(",\n")}\n]`;
    void writeClipboard(text, notify);
    notify(t("문서 {count}개를 복사했습니다", { count: docs.length }));
  };

  // ---- Shortcuts ----

  useEffect(() => {
    if (!active) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      const next = sub === "docs" ? viewForKey(event) : null;
      if (next !== null) {
        event.preventDefault();
        setView(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, sub]);

  const firstRefresh = useRef(refreshSeq);
  useEffect(() => {
    if (refreshSeq !== firstRefresh.current) {
      reload();
    }
  }, [refreshSeq, reload]);

  // ---- Rendering ----

  const result = pageResult?.result ?? null;
  const start = pageResult?.start ?? page * pageSize;
  const total = result?.total ?? null;
  const pages = total === null ? null : Math.max(1, Math.ceil(total.value / pageSize));
  const sorted = appliedQuery?.sort != null;
  const nextPastWindow = (page + 2) * pageSize > RESULT_WINDOW;
  const hasNext = (pages !== null ? page < pages - 1 || total?.relation === "gte" : docs.length === pageSize) && (!nextPastWindow || sorted);
  let rangeText: string;
  if (loadError !== null && result === null) {
    rangeText = t("불러오지 못했습니다");
  } else if (loading && result === null) {
    rangeText = t("불러오는 중…");
  } else if (docs.length === 0 && page === 0) {
    rangeText = t("문서 없음");
  } else {
    const range = { from: (start + 1).toLocaleString(), to: (start + docs.length).toLocaleString() };
    rangeText = total === null ? t("{from}–{to} / …", range) : t("{from}–{to} / {total}개 문서", { ...range, total: `${total.relation === "gte" ? "≥ " : ""}${total.value.toLocaleString()}` });
  }

  const statRows = rows ?? [];
  const sum = (pick: (row: IndexRow) => number | null) => statRows.reduce((acc, row) => acc + (pick(row) ?? 0), 0);
  const worst = statRows.reduce<string | null>((acc, row) => (acc === null || (HEALTH_RANK[row.health] ?? 0) > (HEALTH_RANK[acc] ?? 0) ? row.health : acc), null);
  const closed = statRows.some((row) => row.status === "close");
  const chips =
    rows === null || rows.length === 0 ? null : (
      <>
        {worst !== null ? <span className={`es-health es-health-${worst}`} title={t("상태")}>{worst}</span> : null}
        {closed ? <span className="es-badge es-badge-warn">{t("닫힘")}</span> : null}
        {tabHost.readOnly ? <span className="es-badge" title={t("이 사용자에게는 이 인덱스에 쓸 권한이 없습니다")}>{t("읽기 전용")}</span> : null}
        {kind !== "index" ? (
          <span className="mg-stat" title={statRows.map((row) => row.name).join("\n")}>
            <span className="mg-stat-k">{t("인덱스")}</span>
            <span className="mg-stat-v">{statRows.length}</span>
          </span>
        ) : null}
        <span className="mg-stat">
          <span className="mg-stat-k">{t("문서")}</span>
          <span className="mg-stat-v">{sum((row) => row.docs).toLocaleString()}</span>
        </span>
        <span className="mg-stat" title={t("복제본 포함 / 주 샤드만")}>
          <span className="mg-stat-k">{t("크기")}</span>
          <span className="mg-stat-v">
            {formatBytes(sum((row) => row.size))} / {formatBytes(sum((row) => row.pri_size))}
          </span>
        </span>
        {kind === "index" && statRows[0] ? (
          <span className="mg-stat">
            <span className="mg-stat-k">{t("샤드")}</span>
            <span className="mg-stat-v">
              {statRows[0].primaries ?? "?"} × {(statRows[0].replicas ?? 0) + 1}
            </span>
          </span>
        ) : null}
      </>
    );

  const facts: Fact[] | null =
    rows === null
      ? null
      : [
          { name: kind === "index" ? "index" : kind === "alias" ? "alias" : "data_stream", value: index },
          { name: "docs.count", value: sum((row) => row.docs).toLocaleString() },
          { name: "docs.deleted", value: sum((row) => row.deleted).toLocaleString() },
          { name: "store.size", value: formatBytes(sum((row) => row.size)) },
          { name: "pri.store.size", value: formatBytes(sum((row) => row.pri_size)) },
          { name: "health", value: worst ?? "" },
          ...(kind !== "index" ? [{ name: "indices", value: statRows.map((row) => row.name).join(", ") }] : []),
        ];

  const tableSort: BsonDocument | null = useMemo(() => {
    const list = appliedQuery?.sort;
    if (!list) {
      return null;
    }
    const doc: BsonDocument = new Map();
    for (const item of list) {
      if (typeof item === "string") {
        doc.set(item, new Int32(1));
      } else if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const [field, spec] = Object.entries(item)[0] ?? [];
        if (field !== undefined) {
          const order = spec !== null && typeof spec === "object" && !Array.isArray(spec) ? (spec as Record<string, unknown>).order : spec;
          doc.set(field, new Int32(order === "desc" ? -1 : 1));
        }
      }
    }
    return doc;
  }, [appliedQuery]);

  // A new sort, run at once (a table header, a menu's 정렬), as the sort
  // box's `field:asc, field:desc`.
  const sortBy = (sort: BsonDocument | null) =>
    run({
      ...applied,
      sort: sort === null ? "" : [...sort].map(([field, dir]) => (isNumber(dir) && Number(dir.value) < 0 ? `${field}:desc` : `${field}:asc`)).join(", "),
    });

  // What the views' right-click menus put in the query: a condition ANDed
  // onto the query string, a field left out of the fields box, a sort in
  // place of the applied one; each runs at once.
  const docActions: DocActions = {
    json: true,
    filter: (field, value, how) => run({ ...query, q: withLuceneCondition(query.q, field, value, how) }),
    sort: (field, dir) => {
      const rest: BsonDocument = new Map([...(tableSort ?? [])].filter(([key]) => key !== field));
      sortBy(dir !== null ? new Map<string, BsonValue>([[field, new Int32(dir)]]) : rest.size === 0 ? null : rest);
    },
    sortOf: (field) => {
      const v = tableSort?.get(field);
      return isNumber(v) ? (Number(v.value) < 0 ? -1 : 1) : null;
    },
    hide: (field) => {
      const next = withHiddenSource(query.source, field);
      if (next === null) {
        notify(t("필드 칸이 고른 필드만 돌려주고 있어 {path}만 숨길 수 없습니다. 필드 칸에서 빼세요.", { path: field }));
        return;
      }
      run({ ...query, source: next });
    },
  };

  const headExtra = (doc: BsonDocument) => {
    const hit = hitOf(doc);
    if (hit === undefined) {
      return null;
    }
    const snippets = hit.highlight === null ? [] : Object.entries(hit.highlight).flatMap(([field, parts]) => (Array.isArray(parts) ? parts.map((part) => `${field}: ${part.replace(/<\/?em>/g, "")}`) : []));
    return (
      <>
        {hit.index !== index ? <span className="es-hit-index mono" title={t("이 문서가 있는 인덱스")}>{hit.index}</span> : null}
        {hit.score !== null ? <span className="es-hit-score mono" title={t("점수 (_score)")}>{hit.score.toFixed(3)}</span> : null}
        {snippets.length > 0 ? (
          <span className="es-hit-hl" title={snippets.join("\n")}>
            {snippets[0].length > 60 ? `${snippets[0].slice(0, 59)}…` : snippets[0]}
          </span>
        ) : null}
      </>
    );
  };

  let body;
  if (view === "cards") {
    body = (
      <CardView
        docs={docs}
        offset={start}
        readOnly={!editable}
        allOpen={allOpen}
        onSave={editable ? save : undefined}
        onEditJson={(doc) => openEditor("replace", doc)}
        onClone={(doc) => openEditor("clone", doc)}
        onDelete={(doc) => void removeDoc(doc)}
        notify={notify}
        onDirtyCount={setDirtyCount}
        emptyText={loadError !== null ? t("불러오지 못했습니다") : undefined}
        json
        headExtra={headExtra}
        typeLabel={typeLabel}
        selected={picked}
        onSelect={setPicked}
      />
    );
  } else if (view === "json") {
    body = (
      <JsonView
        docs={docs}
        offset={start}
        canonical={false}
        json
        allFolded={jsonFolded}
        readOnly={!editable}
        onSave={editable ? replace : undefined}
        onClone={(doc) => openEditor("clone", doc)}
        onDelete={(doc) => void removeDoc(doc)}
        notify={notify}
        emptyText={loadError !== null ? t("불러오지 못했습니다") : undefined}
        selected={picked}
        onSelect={setPicked}
      />
    );
  } else {
    body = (
      <DocTableView
        ns={{ conn, db: "", coll: index }}
        connKey={connKey}
        docs={docs}
        readOnly={!editable}
        sort={tableSort}
        onSort={sortBy}
        save={save}
        path={path}
        onPathChange={setPath}
        facts={facts}
        typeLabel={typeLabel}
        onEditJson={editable ? (doc) => openEditor("replace", doc) : undefined}
        onClone={editable ? (doc) => openEditor("clone", doc) : undefined}
        onDelete={editable ? (doc) => void removeDoc(doc) : undefined}
      />
    );
  }
  const pickedAt = picked === null ? -1 : docs.findIndex((doc, i) => docKey(doc, start + i) === picked);

  const profileQuery: SearchQuery = liveQuery.ok ? { body: searchBody(liveQuery.value) } : { error: liveQuery.error.message };
  const panelProps = { host: tabHost, index, kind, refreshSeq, onChanged: () => {
    setStatsSeq((n) => n + 1);
    onChanged();
  } };

  return (
    <div className="mg-root mg-coll es-root">
      <div className="mg-subbar">
        <div className="mg-subtabs" role="tablist">
          {SUBTABS.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={sub === s.id} className={sub === s.id ? "active" : undefined} onClick={() => setSub(s.id)}>
              {t(s.label)}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <div className="mg-substats">{chips}</div>
      </div>
      {sub === "docs" || sub === "profile" ? (
        <QueryBar
          index={index}
          query={query}
          onChange={setQuery}
          dslOpen={dslOpen}
          onDslOpenChange={setDslOpen}
          error={queryError}
          fields={fields}
          onRun={() => run(query)}
          onApply={run}
          onReset={() => {
            setQueryError(null);
            run(EMPTY_QUERY);
          }}
          onProfile={() => {
            setSub("profile");
            setProfileSeq((n) => n + 1);
          }}
        />
      ) : null}
      <div className="mg-panes">
        {sub === "docs" ? (
          <div className="mg-pane mg-docs-pane">
            <div className="data-toolbar mg-docbar">
              <div className="footer-start">
                {editable ? (
                  <button type="button" className="footer-button" title={t("문서 추가 (JSON)")} onClick={() => openEditor("insert", null)}>
                    <PlusIcon size={11} />
                    <span className="footer-label">{t("문서")}</span>
                  </button>
                ) : null}
                {view !== "table" ? (
                  <button type="button" className="footer-button" title={t("모든 하위 값 펼치기/접기")} onClick={() => (view === "json" ? setJsonFolded(!jsonFolded) : setAllOpen(!allOpen))}>
                    {expanded ? <CollapseIcon size={10} /> : <ExpandIcon size={10} />}
                    <span className="footer-label">{expanded ? t("모두 접기") : t("모두 펼치기")}</span>
                  </button>
                ) : null}
                <button type="button" className="footer-button" title={t("이 페이지의 문서를 모두 복사")} onClick={copyPage} disabled={docs.length === 0}>
                  <CopyIcon size={10} />
                  <span className="footer-label">{t("페이지 복사")}</span>
                </button>
                {dirtyCount > 0 && view === "cards" ? <span className="mg-dirty-note">{t("저장하지 않은 문서 {count}개", { count: dirtyCount })}</span> : null}
                <button
                  type="button"
                  className="footer-button"
                  title={t("이 쿼리의 결과를 파일로 내보내기 (NDJSON·JSON·CSV·_bulk)")}
                  disabled={appliedQuery === null}
                  onClick={() => appliedQuery !== null && onAdmin({ kind: "export", index, query: appliedQuery.query ?? undefined, sort: appliedQuery.sort ?? undefined, source: appliedQuery.source ?? undefined })}
                >
                  <DownloadIcon size={11} />
                  <span className="footer-label">{t("내보내기")}</span>
                </button>
                {editable ? (
                  <>
                    <button type="button" className="footer-button" title={t("파일에서 문서 가져오기 (NDJSON·JSON·CSV)")} onClick={() => onAdmin({ kind: "import", index })}>
                      <UploadIcon size={11} />
                      <span className="footer-label">{t("가져오기")}</span>
                    </button>
                    <button type="button" className="footer-button" title={t("지금 쿼리에 맞는 문서를 한꺼번에 고치기 (_update_by_query)")} disabled={appliedQuery === null} onClick={() => setByQuery("update")}>
                      <PencilIcon size={10} />
                      <span className="footer-label">{t("일괄 수정")}</span>
                    </button>
                    <button type="button" className="footer-button" title={t("지금 쿼리에 맞는 문서를 한꺼번에 지우기 (_delete_by_query)")} disabled={appliedQuery === null} onClick={() => setByQuery("delete")}>
                      <TrashIcon size={10} />
                      <span className="footer-label">{t("일괄 삭제")}</span>
                    </button>
                  </>
                ) : null}
              </div>
              <div className="footer-end">
                <ViewSwitch view={view} onChange={setView} />
              </div>
            </div>
            <div className="result-body mg-result-body">
              <div className={`mg-docbody${loadError !== null ? " stale" : ""}`}>
                <DocActionsContext.Provider value={docActions}>{body}</DocActionsContext.Provider>
              </div>
              {loadError !== null && !isAppServerDown(loadError) ? (
                <div className="mg-load-error">
                  <ErrorNotice error={loadError} context="data" engine="elasticsearch" variant="banner" onRetry={reload} onFix={{ "refresh-schema": onChanged }} onClose={() => setLoadError(null)} />
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
                <span className="row-range" title={result ? `${Math.round(result.elapsedMs)} ms${result.took !== null ? ` · took ${result.took} ms` : ""}` : undefined}>
                  {rangeText}
                </span>
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
                  <ChevronDownIcon size={7} />
                </button>
                <span className="page-nav">
                  <button type="button" title={t("이전 페이지")} aria-label={t("이전 페이지")} disabled={page === 0} onClick={() => setPage(page - 1)}>
                    ‹
                  </button>
                  <span className="page-label" title={t("페이지")}>
                    {page + 1} / {pages === null ? "…" : `${total?.relation === "gte" ? "≥" : ""}${pages.toLocaleString()}`}
                  </span>
                  <button
                    type="button"
                    title={nextPastWindow && !sorted ? t("{count}번째 문서 뒤로는 정렬을 정해야 넘길 수 있습니다", { count: RESULT_WINDOW.toLocaleString() }) : t("다음 페이지")}
                    aria-label={t("다음 페이지")}
                    disabled={!hasNext}
                    onClick={() => setPage(page + 1)}
                  >
                    ›
                  </button>
                </span>
              </div>
            </div>
          </div>
        ) : null}
        {sub === "mapping" ? (
          <div className="mg-pane">
            <MappingPanel {...panelProps} active={active && sub === "mapping"} />
          </div>
        ) : null}
        {sub === "settings" ? (
          <div className="mg-pane">
            <SettingsPanel {...panelProps} active={active && sub === "settings"} />
          </div>
        ) : null}
        {sub === "aliases" ? (
          <div className="mg-pane">
            <AliasesPanel {...panelProps} active={active && sub === "aliases"} />
          </div>
        ) : null}
        {sub === "sql" ? (
          <div className="mg-pane">
            <SqlPanel {...panelProps} active={active && sub === "sql"} connKey={connKey} />
          </div>
        ) : null}
        {sub === "analyze" ? (
          <div className="mg-pane">
            <AnalyzePanel {...panelProps} active={active && sub === "analyze"} />
          </div>
        ) : null}
        {sub === "profile" ? (
          <div className="mg-pane">
            <ProfilePanel {...panelProps} active={active && sub === "profile"} query={profileQuery} runSeq={profileSeq} />
          </div>
        ) : null}
      </div>
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
      {editor !== null ? <DocEditorModal request={editor} fields={fields} onSubmit={submitEditor} onClose={() => setEditor(null)} /> : null}
      {byQuery !== null && appliedQuery !== null ? (
        <ByQueryModal
          host={tabHost}
          index={index}
          mode={byQuery}
          query={appliedQuery.query}
          onDone={() => {
            reload();
            onChanged();
          }}
          onClose={() => setByQuery(null)}
        />
      ) : null}
      {edits.conflict !== null ? <ConflictModal conflict={edits.conflict} /> : null}
      {sub === "docs" && view === "table" ? null : (
        <DocActionsContext.Provider value={docActions}>
          <DocDetailPanel>
            {(search) =>
              sub !== "docs" ? (
                <FactsList title={<span className="mg-detail-path mono">{index}</span>} facts={facts} query={search} />
              ) : pickedAt >= 0 ? (
                <DocDetail ns={{ conn, db: "", coll: index }} doc={docs[pickedAt]} position={start + pickedAt} save={editable ? save : undefined} typeLabel={typeLabel} query={search} />
              ) : (
                <NothingSelected facts={facts} query={search} />
              )
            }
          </DocDetailPanel>
        </DocActionsContext.Provider>
      )}
    </div>
  );
}
