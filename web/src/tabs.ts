import type { QueryMeta } from "./net/socket";
import type { EngineMeta, QueryOutcome, TabSnapshot } from "./store";
import type { WindowedRowSource } from "./grid/windowSource";
import { buildDataSql, type FilterState, type SortState } from "./dataQuery";

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
  page: number;
  pageSize: number;
}

export type WorkbenchTab = QueryTab | DataTab;

export type TabPatch = Partial<Omit<QueryTab, "id" | "kind">> &
  Partial<Omit<DataTab, "id" | "kind">>;

export interface TabsState {
  tabs: WorkbenchTab[];
  activeId: string;
}

export const DEFAULT_PAGE_SIZE = 100;
export const PAGE_SIZE_OPTIONS = [100, 500, 1000, 5000];

let idCounter = 0;

function nextId(): string {
  idCounter += 1;
  return `tab-${idCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createQueryTab(seq: number, sql = ""): QueryTab {
  return {
    id: nextId(),
    kind: "query",
    title: `쿼리 ${seq}`,
    sql,
  };
}

export function createDataTab(table: string, pageSize = DEFAULT_PAGE_SIZE): DataTab {
  const tab: DataTab = {
    id: nextId(),
    kind: "data",
    title: table,
    table,
    sql: "",
    page: 0,
    pageSize,
  };
  tab.sql = buildDataSql({ table, pageSize, page: 0 });
  return tab;
}

export interface DataPageInfo {
  page: number;
  pages: number | null;
  rows: number | null;
  truncated: boolean;
}

export function dataPageInfo(tab: DataTab): DataPageInfo {
  const meta = tab.meta;
  if (!meta) {
    return { page: tab.page, pages: null, rows: null, truncated: false };
  }
  const size = Math.max(1, tab.pageSize);
  const start = tab.page * size;
  const full = meta.rowCount >= size;
  if (meta.truncated || full) {
    return { page: tab.page, pages: null, rows: start + meta.rowCount, truncated: true };
  }
  const rows = start + meta.rowCount;
  return { page: tab.page, pages: Math.max(1, Math.ceil(rows / size)), rows, truncated: false };
}

export function createTabs(seq: number): TabsState {
  const tab = createQueryTab(seq);
  return { tabs: [tab], activeId: tab.id };
}

export function addTab(state: TabsState, seq: number): TabsState {
  const tab = createQueryTab(seq);
  return { tabs: [...state.tabs, tab], activeId: tab.id };
}

export function closeTab(state: TabsState, id: string, seq: number): TabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) {
    return state;
  }
  const remaining = state.tabs.filter((tab) => tab.id !== id);
  if (remaining.length === 0) {
    const tab = createQueryTab(seq);
    return { tabs: [tab], activeId: tab.id };
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
  return {
    id: tab.id,
    sql: tab.sql,
    source: tab.source ?? null,
    meta: tab.meta ?? null,
    info: tab.info ?? null,
    error: tab.error ?? null,
  };
}

export function seedSqlForMeta(meta: EngineMeta | null): string {
  if (!meta) {
    return "";
  }
  if (meta.demo) {
    return "SELECT * FROM demo LIMIT 100;";
  }
  if (meta.tables.length > 0) {
    const quoted = meta.tables[0].split('"').join('""');
    return `SELECT * FROM "${quoted}" LIMIT 100;`;
  }
  return "";
}
