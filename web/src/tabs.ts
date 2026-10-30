import type { QueryMeta } from "./net/socket";
import type { DefinitionDetail, EngineMeta, QueryOutcome, TabSnapshot, TableDetail } from "./store";
import type { AppError } from "./errorHelp";
import type { WindowedRowSource } from "./grid/windowSource";
import type { AnalysisState } from "./chartData";
import type { AggDraft } from "./engines/mongodb/pipeline";
import type { DocTabState } from "./engines/mongodb/ui/DocumentWorkbench";
import type { SearchTabState } from "./engines/elasticsearch/ui/SearchWorkbench";
import type { SecuritySection, TargetKind } from "./engines/elasticsearch/ui/types";
import { buildDataSql, filterKey, firstRowsSql, type FilterState, type SortState } from "./dataQuery";
import { quoteIdent } from "./ddl";
import { engineById, type SqlDialect } from "./engines";
import { definitionTabTitle, type DefinitionKind } from "./sqlTools";
import { t } from "./i18n";

export type ErrorFrom = "filter" | "apply";

export interface QueryTab {
  id: string;
  kind: "query";
  title: string;
  sql: string;
  // A saved query opened in its own tab: edits are written back to it.
  favoriteId?: string;
  // The saved query's SQL as this tab last wrote or read it.
  favoriteSql?: string;
  source?: WindowedRowSource;
  meta?: QueryMeta;
  info?: string;
  error?: AppError;
  // What failed: the tab's run (unset), its filter, or applying its edits.
  errorFrom?: ErrorFrom;
  // The Chart or Pivot view of the result, and how each is set up.
  analysis?: AnalysisState;
}

// TablePlus's Data | Structure | Index, one grid each.
export type TableView = "data" | "structure" | "index";

export interface DataTab {
  id: string;
  kind: "data";
  title: string;
  table: string;
  sql: string;
  source?: WindowedRowSource;
  meta?: QueryMeta;
  info?: string;
  error?: AppError;
  errorFrom?: ErrorFrom;
  filter?: FilterState;
  sorts?: SortState[];
  pkColumns?: string[];
  offset: number;
  pageSize: number;
  // On an engine that pages by the server's token (cursor_paging): the
  // tokens known for `sql`, by the row they lead to (a result's next page,
  // the marks a far jump noted on the way). Any page starts from the
  // nearest one at or before it; offset 0 needs none.
  pageMarks?: PageMarks;
  view?: TableView;
  detail?: TableDetail;
  columns?: string[];
  // The rows the filter keeps, and the WHERE they were counted under ("" for
  // none), so a count is only shown for the filter it belongs to.
  count?: number;
  countFilter?: string;
  // TablePlus's temporary tab (italic): a single click opened it, and the next
  // single click on another table reuses it. A double-click or a staged change
  // keeps it.
  preview?: boolean;
  // The strip element of the temporary tab this one replaced, so the strip
  // updates that element in place instead of animating a new one in.
  slot?: string;
  // The Chart or Pivot view in place of the Data view's grid, and how each
  // is set up.
  analysis?: AnalysisState;
}

// Paging tokens of one data statement, by the row offset each leads to.
// Never changed in place: a tab gets a new map with the marks added.
export interface PageMarks {
  sql: string;
  at: ReadonlyMap<number, string>;
}

export interface StructureTab {
  id: string;
  kind: "structure";
  title: string;
  table: string;
  data?: TableDetail;
}

export interface ServerTab {
  id: string;
  kind: "server";
  title: string;
}

export interface OverviewTab {
  id: string;
  kind: "overview";
  title: string;
}

// The connection's ER diagram. `focus` is a table to centre on; each new
// request bumps `focusSeq` so the open diagram moves to it again.
export interface DiagramTab {
  id: string;
  kind: "diagram";
  title: string;
  focus?: string;
  focusSeq?: number;
}

export interface DefinitionTab {
  id: string;
  kind: "definition";
  title: string;
  obj: DefinitionKind;
  name: string;
  definition?: DefinitionDetail;
}

// A MongoDB collection (or view) in the document workbench; what it shows
// inside (query, view, page) the workbench keeps per tab id.
export interface CollectionTab {
  id: string;
  kind: "collection";
  title: string;
  db: string;
  coll: string;
  // A MongoDB view: read-only.
  isView?: boolean;
  // The 집계 sub-tab's pipeline being edited (restored after a reload).
  agg?: AggDraft;
  // The sub-tab, documents view and query last shown (restored after a reload).
  doc?: DocTabState;
}

// A mongosh tab: its text, and the database `db` refers to (`use` changes it).
export interface MongoshTab {
  id: string;
  kind: "mongosh";
  title: string;
  db: string;
  text: string;
}

// A document connection's 성능 tab (one per connection); the charts'
// history lives with the open page, not in the saved tabs.
export interface PerfTab {
  id: string;
  kind: "perf";
  title: string;
}

// A database's 변경 보기 tab (a change stream on every collection); its
// events live with the open page, not in the saved tabs.
export interface WatchTab {
  id: string;
  kind: "watch";
  title: string;
  db: string;
}

// A GridFS bucket (`<bucket>.files` + `<bucket>.chunks`) of a database.
export interface GridFsTab {
  id: string;
  kind: "gridfs";
  title: string;
  db: string;
  bucket: string;
}

// An index, alias or data stream of a search connection (Elasticsearch,
// OpenSearch); what it shows inside the workbench keeps per tab id.
export interface SearchIndexTab {
  id: string;
  kind: "searchIndex";
  title: string;
  index: string;
  target: TargetKind;
  // The sub-tab, view and query last shown (restored after a reload).
  search?: SearchTabState;
}

// A search connection's Dev Tools console: its requests as typed.
export interface SearchConsoleTab {
  id: string;
  kind: "searchConsole";
  title: string;
  text: string;
}

// A search connection's 클러스터 tab (one per connection); the charts'
// history lives with the open page, not in the saved tabs.
export interface SearchClusterTab {
  id: string;
  kind: "searchCluster";
  title: string;
}

// A search connection's 보안 tab (one per connection): users, roles, role
// mappings and API keys; `section` is the one last shown.
export interface SearchSecurityTab {
  id: string;
  kind: "searchSecurity";
  title: string;
  section: SecuritySection;
}

export type WorkbenchTab =
  | QueryTab
  | DataTab
  | StructureTab
  | ServerTab
  | OverviewTab
  | DiagramTab
  | DefinitionTab
  | CollectionTab
  | MongoshTab
  | PerfTab
  | WatchTab
  | GridFsTab
  | SearchIndexTab
  | SearchConsoleTab
  | SearchClusterTab
  | SearchSecurityTab;

export type TabPatch = Partial<Omit<QueryTab, "id" | "kind">> &
  Partial<Omit<DataTab, "id" | "kind">> &
  Partial<Omit<StructureTab, "id" | "kind">> &
  Partial<Omit<ServerTab, "id" | "kind">> &
  Partial<Omit<OverviewTab, "id" | "kind">> &
  Partial<Omit<DiagramTab, "id" | "kind">> &
  Partial<Omit<DefinitionTab, "id" | "kind">> &
  Partial<Omit<CollectionTab, "id" | "kind">> &
  Partial<Omit<MongoshTab, "id" | "kind">> &
  Partial<Omit<SearchIndexTab, "id" | "kind">> &
  Partial<Omit<SearchConsoleTab, "id" | "kind">> &
  Partial<Omit<SearchSecurityTab, "id" | "kind">>;

export interface TabsState {
  tabs: WorkbenchTab[];
  activeId: string;
}

export const DEFAULT_PAGE_SIZE = 300;
export const PAGE_SIZE_OPTIONS = [100, 300, 500, 1000, 5000];

let idCounter = 0;

function nextId(): string {
  idCounter += 1;
  return `tab-${idCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createQueryTab(seq: number, sql = ""): QueryTab {
  return {
    id: nextId(),
    kind: "query",
    title: t("쿼리 {count}", { count: seq }),
    sql,
  };
}

export function createCollectionTab(db: string, coll: string, isView = false): CollectionTab {
  return { id: nextId(), kind: "collection", title: coll, db, coll, ...(isView ? { isView } : {}) };
}

export function createMongoshTab(seq: number, db: string, text: string): MongoshTab {
  return { id: nextId(), kind: "mongosh", title: `mongosh ${seq}`, db, text };
}

export function createPerfTab(): PerfTab {
  return { id: nextId(), kind: "perf", title: t("성능") };
}

export function createWatchTab(db: string): WatchTab {
  return { id: nextId(), kind: "watch", title: t("변경 보기: {db}", { db }), db };
}

export function createGridFsTab(db: string, bucket: string): GridFsTab {
  return { id: nextId(), kind: "gridfs", title: bucket, db, bucket };
}

export function createSearchIndexTab(index: string, target: TargetKind): SearchIndexTab {
  return { id: nextId(), kind: "searchIndex", title: index, index, target };
}

// "콘솔 2": the smallest number the open console tabs leave free.
export function createSearchConsoleTab(seq: number, text: string): SearchConsoleTab {
  return { id: nextId(), kind: "searchConsole", title: t("콘솔 {n}", { n: seq }), text };
}

export function createSearchClusterTab(): SearchClusterTab {
  return { id: nextId(), kind: "searchCluster", title: t("클러스터") };
}

export function createSearchSecurityTab(section: SecuritySection = "users"): SearchSecurityTab {
  return { id: nextId(), kind: "searchSecurity", title: t("보안"), section };
}

// The number in a query tab's default name ("쿼리 3", "Query 3"); null for a
// name the user gave it.
export function queryNumberOf(title: string): number | null {
  const match = /^(?:쿼리|Query) (\d+)$/.exec(title);
  return match === null ? null : Number.parseInt(match[1], 10);
}

// The smallest number none of `titles` uses: closing every query tab starts
// again from 1.
export function freeQueryNumber(titles: string[]): number {
  const used = new Set(titles.map(queryNumberOf));
  let number = 1;
  while (used.has(number)) {
    number += 1;
  }
  return number;
}

// A table tab's first SQL, in the connection's dialect; none without one
// (a restored tab whose engine is unknown), until the tab first runs.
export function createDataTab(table: string, pageSize: number, dialect: SqlDialect | undefined): DataTab {
  const tab: DataTab = {
    id: nextId(),
    kind: "data",
    title: table,
    table,
    sql: "",
    offset: 0,
    pageSize,
  };
  tab.sql = dialect === undefined ? "" : buildDataSql({ dialect, table, limit: pageSize, offset: 0 });
  return tab;
}

export function createOverviewTab(): OverviewTab {
  return {
    id: nextId(),
    kind: "overview",
    title: t("테이블 개요"),
  };
}

export function createDiagramTab(focus?: string): DiagramTab {
  return {
    id: nextId(),
    kind: "diagram",
    title: t("ER 다이어그램"),
    ...(focus !== undefined ? { focus, focusSeq: 1 } : {}),
  };
}

export function createStructureTab(table: string): StructureTab {
  return {
    id: nextId(),
    kind: "structure",
    title: `${t("구조")}: ${table}`,
    table,
  };
}

export function createServerTab(): ServerTab {
  return {
    id: nextId(),
    kind: "server",
    title: t("서버 정보"),
  };
}

export function createDefinitionTab(obj: DefinitionKind, name: string): DefinitionTab {
  return {
    id: nextId(),
    kind: "definition",
    title: definitionTabTitle(obj, name),
    obj,
    name,
  };
}

// The tab's count, only when it was taken under the filter it shows now.
export function countFor(tab: DataTab, dialect: SqlDialect): number | null {
  const key = filterKey(tab.filter ?? null, dialect);
  return tab.count !== undefined && (tab.countFilter ?? "") === key ? tab.count : null;
}

export interface DataPageInfo {
  offset: number;
  page: number;
  pages: number | null;
  rows: number | null;
  truncated: boolean;
  exact: boolean;
}

export function dataPageInfo(tab: DataTab, exact?: number | null): DataPageInfo {
  const size = Math.max(1, tab.pageSize);
  const offset = Math.max(0, tab.offset ?? 0);
  const page = Math.floor(offset / size) + 1;
  if (exact !== undefined && exact !== null) {
    return {
      offset,
      page,
      pages: Math.max(1, Math.ceil(exact / size)),
      rows: exact,
      truncated: false,
      exact: true,
    };
  }
  const meta = tab.meta;
  if (!meta) {
    return { offset, page, pages: null, rows: null, truncated: false, exact: false };
  }
  const full = meta.rowCount >= size;
  if (meta.truncated || full) {
    return {
      offset,
      page,
      pages: null,
      rows: offset + meta.rowCount,
      truncated: true,
      exact: false,
    };
  }
  const rows = offset + meta.rowCount;
  return {
    offset,
    page,
    pages: Math.max(1, Math.ceil(rows / size)),
    rows,
    truncated: false,
    exact: true,
  };
}

export function migrateTabsState(state: TabsState, dialect: SqlDialect | undefined): TabsState {
  let changed = false;
  const tabs = state.tabs.map((saved): WorkbenchTab => {
    // A standalone structure tab from older versions becomes a table tab on
    // its Structure view, which has the Data and Index views beside it.
    if (saved.kind === "structure") {
      changed = true;
      return { ...createDataTab(saved.table, DEFAULT_PAGE_SIZE, dialect), id: saved.id, view: "structure" };
    }
    // A restored tab has no rows or staged edits yet: an error from reading
    // them (a data tab reads again on open) or from applying edits is stale.
    if (saved.kind === "query" && saved.errorFrom === "apply") {
      changed = true;
      return { ...saved, error: undefined, errorFrom: undefined };
    }
    if (saved.kind !== "data") {
      return saved;
    }
    let tab = saved;
    if (tab.error !== undefined) {
      tab = { ...tab, error: undefined, errorFrom: undefined };
      changed = true;
    }
    // The DDL view was folded into Structure, which ends with the DDL.
    if ((tab.view as string | undefined) === "ddl") {
      tab = { ...tab, view: "structure" };
      changed = true;
    }
    const legacy = tab as DataTab & { page?: number };
    if (typeof legacy.offset === "number") {
      if (legacy.page !== undefined) {
        delete legacy.page;
        changed = true;
      }
      return tab;
    }
    changed = true;
    const page = typeof legacy.page === "number" ? legacy.page : 0;
    const offset = Math.max(0, page) * Math.max(1, tab.pageSize);
    const next = { ...legacy, offset } as DataTab & { page?: number };
    delete next.page;
    return next;
  });
  return changed ? { ...state, tabs } : state;
}

export function createTabs(seq: number): TabsState {
  const tab = createQueryTab(seq);
  return { tabs: [tab], activeId: tab.id };
}

export function addTab(state: TabsState, seq: number): TabsState {
  const tab = createQueryTab(seq);
  return { tabs: [...state.tabs, tab], activeId: tab.id };
}

export function closeTab(state: TabsState, id: string): TabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) {
    return state;
  }
  const remaining = state.tabs.filter((tab) => tab.id !== id);
  if (remaining.length === 0) {
    return { tabs: [], activeId: "" };
  }
  if (state.activeId !== id) {
    return { tabs: remaining, activeId: state.activeId };
  }
  const neighbor = remaining[Math.min(index, remaining.length - 1)];
  return { tabs: remaining, activeId: neighbor.id };
}

export function activateTab(state: TabsState, id: string): TabsState {
  if (state.activeId === id || !state.tabs.some((tab) => tab.id === id)) {
    return state;
  }
  return { ...state, activeId: id };
}

export function renameTab(state: TabsState, id: string, title: string): TabsState {
  const trimmed = title.trim();
  if (trimmed === "") {
    return state;
  }
  return patchTab(state, id, { title: trimmed });
}

export function patchTab(state: TabsState, id: string, patch: TabPatch): TabsState {
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.id !== id) {
      return tab;
    }
    changed = true;
    return { ...tab, ...patch } as WorkbenchTab;
  });
  if (!changed) {
    return state;
  }
  return { ...state, tabs };
}

export function patchFromOutcome(state: TabsState, id: string, outcome: QueryOutcome): TabsState {
  if (outcome.kind === "ok") {
    return patchTab(state, id, {
      source: outcome.result.source,
      meta: outcome.result.meta,
      info: undefined,
      error: undefined,
      errorFrom: undefined,
    });
  }
  if (outcome.kind === "cancelled") {
    return patchTab(state, id, { info: t("쿼리가 취소되었습니다"), error: undefined, errorFrom: undefined });
  }
  return patchTab(state, id, { info: undefined, error: outcome.error, errorFrom: undefined });
}

export function tabById(state: TabsState, id: string): WorkbenchTab | null {
  return state.tabs.find((tab) => tab.id === id) ?? null;
}

export function activeTabOf(state: TabsState): WorkbenchTab | null {
  return tabById(state, state.activeId);
}

export function snapshotOf(tab: WorkbenchTab): TabSnapshot {
  if (tab.kind === "query" || tab.kind === "data") {
    return {
      id: tab.id,
      sql: tab.sql,
      source: tab.source ?? null,
      meta: tab.meta ?? null,
      info: tab.info ?? null,
      error: tab.error ?? null,
    };
  }
  return { id: tab.id, sql: "", source: null, meta: null, info: null, error: null };
}

export function seedSqlForMeta(meta: EngineMeta | null): string {
  if (!meta) {
    return "";
  }
  if (meta.demo) {
    return "SELECT * FROM demo LIMIT 100;";
  }
  // No SQL to seed for an engine without it (or one this page doesn't know).
  const dialect = engineById(meta.kind)?.sql;
  if (dialect !== undefined && meta.tables.length > 0) {
    return firstRowsSql(dialect, quoteIdent(dialect, meta.tables[0]));
  }
  return "";
}
