import type { QueryMeta } from "./net/socket";
import type { DefinitionDetail, EngineMeta, QueryOutcome, TabSnapshot, TableDetail } from "./store";
import type { WindowedRowSource } from "./grid/windowSource";
import { buildDataSql, type FilterState, type SortState } from "./dataQuery";
import { quoteIdent } from "./ddl";
import { definitionTabTitle, type DefinitionKind } from "./sqlTools";
import { t } from "./i18n";

export interface QueryTab {
  id: string;
  kind: "query";
  title: string;
  sql: string;
  source?: WindowedRowSource;
  meta?: QueryMeta;
  info?: string;
  error?: string;
}

export type TableView = "data" | "structure" | "ddl";

export interface DataTab {
  id: string;
  kind: "data";
  title: string;
  table: string;
  sql: string;
  source?: WindowedRowSource;
  meta?: QueryMeta;
  info?: string;
  error?: string;
  filter?: FilterState;
  sorts?: SortState[];
  pkColumns?: string[];
  offset: number;
  pageSize: number;
  view?: TableView;
  detail?: TableDetail;
  columns?: string[];
  count?: number;
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

export interface DefinitionTab {
  id: string;
  kind: "definition";
  title: string;
  obj: DefinitionKind;
  name: string;
  definition?: DefinitionDetail;
}

export type WorkbenchTab =
  | QueryTab
  | DataTab
  | StructureTab
  | ServerTab
  | OverviewTab
  | DefinitionTab;

export type TabPatch = Partial<Omit<QueryTab, "id" | "kind">> &
  Partial<Omit<DataTab, "id" | "kind">> &
  Partial<Omit<StructureTab, "id" | "kind">> &
  Partial<Omit<ServerTab, "id" | "kind">> &
  Partial<Omit<OverviewTab, "id" | "kind">> &
  Partial<Omit<DefinitionTab, "id" | "kind">>;

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

export function createDataTab(table: string, pageSize = DEFAULT_PAGE_SIZE, kind = "postgres"): DataTab {
  const tab: DataTab = {
    id: nextId(),
    kind: "data",
    title: table,
    table,
    sql: "",
    offset: 0,
    pageSize,
  };
  tab.sql = buildDataSql({ kind, table, limit: pageSize, offset: 0 });
  return tab;
}

export function createOverviewTab(): OverviewTab {
  return {
    id: nextId(),
    kind: "overview",
    title: t("테이블 개요"),
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

export function migrateTabsState(state: TabsState): TabsState {
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.kind !== "data") {
      return tab;
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
    });
  }
  if (outcome.kind === "cancelled") {
    return patchTab(state, id, { info: "쿼리가 취소되었습니다", error: undefined });
  }
  return patchTab(state, id, { info: undefined, error: outcome.error });
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
  if (meta.tables.length > 0) {
    const quoted = quoteIdent(meta.kind, meta.tables[0]);
    return `SELECT * FROM ${quoted} LIMIT 100;`;
  }
  return "";
}
