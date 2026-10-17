import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ConnectModal } from "./components/ConnectModal";
import { ContextMenu, type ContextMenuItem } from "./components/ContextMenu";
import { DataTabToolbar } from "./components/DataToolbar";
import { ExportModal } from "./components/ExportModal";
import { FilterBar } from "./components/FilterBar";
import { FavoritesMenu, HistoryMenu } from "./components/Dropdowns";
import { FsModal } from "./components/FsModal";
import { GridHost, type GridHostHandle } from "./components/GridHost";
import { RowDetailPanel } from "./components/RowDetailPanel";
import { SchemaSidebar } from "./components/SchemaSidebar";
import { SqlEditor, type SqlEditorHandle } from "./components/SqlEditor";
import { TabStrip } from "./components/TabStrip";
import {
  DatabaseIcon,
  DownloadIcon,
  PanelIcon,
  PlayIcon,
  PlusIcon,
  RefreshIcon,
  StopIcon,
} from "./components/icons";
import { buildDataSql, cycleSort, EMPTY_FILTER, type FilterState, type SortState } from "./dataQuery";
import { buildUpdateSql, toSqlInserts } from "./export";
import type { SortIndicator } from "./grid/CanvasGrid";
import type { WindowedRowSource } from "./grid/windowSource";
import { store, type GridResult, type QueryOutcome } from "./store";
import {
  activeTabOf,
  addTab,
  activateTab,
  closeTab,
  createDataTab,
  createQueryTab,
  dataPageInfo,
  patchFromOutcome,
  patchTab,
  renameTab,
  seedSqlForMeta,
  snapshotOf,
  tabById,
  type DataTab,
  type TabsState,
} from "./tabs";

const EMPTY_TABLES: string[] = [];
const MAX_ROWS_LIMIT = 500000;

interface DataRunSpec {
  page: number;
  pageSize: number;
  filter: FilterState | null;
  sorts: SortState[] | null;
}

interface ExportTarget {
  title: string;
  result: GridResult;
  dataTab: DataTab | null;
}

interface MenuState {
  row: number;
  col: number;
  x: number;
  y: number;
}

function clampRows(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(MAX_ROWS_LIMIT, Math.max(1, Math.trunc(value)));
}

function quoteIdentifier(name: string): string {
  return `"${name.split('"').join('""')}"`;
}

function cellToText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

async function rowValues(source: WindowedRowSource, row: number): Promise<unknown[]> {
  const count = source.columns.length;
  if (source.cell(row, 0) === undefined) {
    await source.ensureRow(row);
  }
  const values = new Array<unknown>(count);
  for (let c = 0; c < count; c += 1) {
    const value = source.cell(row, c);
    values[c] = value === undefined ? null : value;
  }
  return values;
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    store.setError("클립보드에 복사하지 못했습니다");
  }
}

export default function App() {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const [tabs, setTabs] = useState<TabsState>(() => {
    const tab = createQueryTab(1);
    return { tabs: [tab], activeId: tab.id };
  });
  const [maxRows, setMaxRows] = useState(10000);
  const [fsOpen, setFsOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [schemaOpen, setSchemaOpen] = useState(true);
  const [resultView, setResultView] = useState<"grid" | "message">("grid");
  const [runningTabId, setRunningTabId] = useState<string | null>(null);
  const [editorHeight, setEditorHeight] = useState<number | null>(null);
  const [filterOpen, setFilterOpen] = useState<Record<string, boolean>>({});
  const [detailRow, setDetailRow] = useState<number | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [exportTarget, setExportTarget] = useState<ExportTarget | null>(null);
  const editorRef = useRef<SqlEditorHandle | null>(null);
  const gridHostRef = useRef<GridHostHandle | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const seqRef = useRef(2);
  const tabsRef = useRef(tabs);
  const runningTabRef = useRef(runningTabId);
  const closedDuringRunRef = useRef<string | null>(null);
  const generationRef = useRef(state.generation);
  const seededGenRef = useRef(-1);
  const focusRequestRef = useRef(false);
  const pendingEditorSqlRef = useRef<string | null>(null);
  const connectOpenRef = useRef(connectOpen);
  const fsOpenRef = useRef(fsOpen);
  const detailRowRef = useRef(detailRow);
  const menuRef = useRef(menu);
  const exportTargetRef = useRef(exportTarget);
  const runRef = useRef<() => void>(() => {});
  const newTabRef = useRef<() => void>(() => {});
  const closeRef = useRef<(id: string) => void>(() => {});

  tabsRef.current = tabs;
  runningTabRef.current = runningTabId;
  connectOpenRef.current = connectOpen;
  fsOpenRef.current = fsOpen;
  detailRowRef.current = detailRow;
  menuRef.current = menu;
  exportTargetRef.current = exportTarget;

  const meta = state.meta;
  const activeTab = activeTabOf(tabs);
  const activeDataTab = activeTab !== null && activeTab.kind === "data" ? activeTab : null;
  const plainTables = meta?.tables ?? EMPTY_TABLES;
  const schemaKey = meta ? `${meta.kind}:${meta.path ?? ""}:${meta.tables.length}` : "none";
  const tabIds = tabs.tabs.map((tab) => tab.id);
  const dataMeta = activeDataTab ? (activeDataTab.meta ?? null) : null;
  const sortIndicators: SortIndicator[] | undefined = dataMeta
    ? (activeDataTab?.sorts ?? [])
        .map((sort) => ({ columnIndex: dataMeta.columns.indexOf(sort.column), dir: sort.dir }))
        .filter((indicator) => indicator.columnIndex >= 0)
    : undefined;
  const pageInfo = activeDataTab ? dataPageInfo(activeDataTab) : null;

  function nextSeq(): number {
    const value = seqRef.current;
    seqRef.current += 1;
    return value;
  }

  function handleOutcome(tabId: string, outcome: QueryOutcome): boolean {
    if (closedDuringRunRef.current === tabId) {
      closedDuringRunRef.current = null;
      if (outcome.kind === "ok") {
        outcome.result.source.dispose();
      }
      return false;
    }
    if (tabsRef.current.activeId === tabId) {
      setResultView(outcome.kind === "error" ? "message" : "grid");
    }
    const existing = tabById(tabsRef.current, tabId);
    if (
      existing &&
      existing.source &&
      outcome.kind === "ok" &&
      existing.source !== outcome.result.source
    ) {
      existing.source.dispose();
    }
    setTabs((prev) => patchFromOutcome(prev, tabId, outcome));
    return true;
  }

  function runDataWith(tab: DataTab, spec: DataRunSpec): void {
    if (store.getState().status === "running") {
      return;
    }
    const sql = buildDataSql({
      table: tab.table,
      filter: spec.filter,
      sorts: spec.sorts,
      pageSize: spec.pageSize,
      page: spec.page,
    });
    setTabs((prev) =>
      patchTab(prev, tab.id, {
        sql,
        page: spec.page,
        pageSize: spec.pageSize,
        filter: spec.filter ?? undefined,
        sorts: spec.sorts ?? undefined,
      }),
    );
    setRunningTabId(tab.id);
    void store.runQuery(sql, spec.pageSize, tab.id).then((outcome) => {
      setRunningTabId(null);
      const applied = handleOutcome(tab.id, outcome);
      if (
        applied &&
        outcome.kind === "ok" &&
        outcome.result.meta.rowCount === 0 &&
        spec.page > 0
      ) {
        runDataWith(tab, { ...spec, page: spec.page - 1 });
      }
    });
  }

  function dataSpecOf(tab: DataTab, page: number, pageSize: number): DataRunSpec {
    return { page, pageSize, filter: tab.filter ?? null, sorts: tab.sorts ?? null };
  }

  function run(): void {
    const current = tabsRef.current;
    const tab = activeTabOf(current);
    if (!tab || store.getState().status === "running") {
      return;
    }
    if (tab.kind === "data") {
      runDataWith(tab, dataSpecOf(tab, tab.page, tab.pageSize));
      return;
    }
    const sqlText = (editorRef.current?.getSql() ?? tab.sql).trim();
    if (sqlText === "") {
      return;
    }
    setRunningTabId(tab.id);
    void store.runQuery(sqlText, maxRows, tab.id).then((outcome) => {
      setRunningTabId(null);
      handleOutcome(tab.id, outcome);
    });
  }

  runRef.current = run;

  function activate(id: string): void {
    const next = activateTab(tabsRef.current, id);
    if (next === tabsRef.current) {
      return;
    }
    setTabs(next);
    const tab = tabById(next, id);
    if (tab) {
      store.showSnapshot(snapshotOf(tab));
    }
  }

  function createNewTab(): void {
    const next = addTab(tabsRef.current, nextSeq());
    setTabs(next);
    const tab = activeTabOf(next);
    if (tab) {
      store.showSnapshot(snapshotOf(tab));
    }
    focusRequestRef.current = true;
  }

  newTabRef.current = createNewTab;

  function closeTabById(id: string): void {
    const current = tabsRef.current;
    const tab = tabById(current, id);
    if (!tab) {
      return;
    }
    if (runningTabRef.current === id) {
      closedDuringRunRef.current = id;
      store.cancelQuery();
      setRunningTabId(null);
    }
    const wasActive = current.activeId === id;
    const next = closeTab(current, id, nextSeq());
    setTabs(next);
    if (wasActive) {
      const active = activeTabOf(next);
      if (active) {
        store.showSnapshot(snapshotOf(active));
      }
    }
    tab.source?.dispose();
  }

  closeRef.current = closeTabById;

  function renameTabById(id: string, title: string): void {
    setTabs((prev) => renameTab(prev, id, title));
  }

  function handleSqlChange(tabId: string, sql: string): void {
    setTabs((prev) => {
      const tab = tabById(prev, tabId);
      if (!tab || tab.kind !== "query" || tab.sql === sql) {
        return prev;
      }
      return patchTab(prev, tabId, { sql });
    });
  }

  function openInQueryEditor(sql: string): void {
    const current = tabsRef.current;
    let target = activeTabOf(current);
    if (target === null || target.kind === "data") {
      const queryTabs = current.tabs.filter((tab) => tab.kind === "query");
      target = queryTabs.length > 0 ? queryTabs[queryTabs.length - 1] : null;
    }
    if (target === null) {
      const tab = createQueryTab(nextSeq(), sql);
      setTabs({ tabs: [...current.tabs, tab], activeId: tab.id });
      focusRequestRef.current = true;
      return;
    }
    if (target.id === current.activeId) {
      setTabs((prev) => patchTab(prev, target.id, { sql }));
      editorRef.current?.setSql(sql);
      editorRef.current?.focus();
      return;
    }
    const activated = activateTab(current, target.id);
    const next = patchTab(activated, target.id, { sql });
    setTabs(next);
    const tab = tabById(next, target.id);
    if (tab) {
      store.showSnapshot(snapshotOf(tab));
    }
    pendingEditorSqlRef.current = sql;
  }

  function pickSql(sql: string): void {
    openInQueryEditor(sql);
  }

  function pickTable(table: string): void {
    const quoted = table.split(".").map(quoteIdentifier).join(".");
    openInQueryEditor(`SELECT * FROM ${quoted} LIMIT 100;`);
  }

  function openDataTab(table: string): void {
    const current = tabsRef.current;
    const existing = current.tabs.find(
      (tab): tab is DataTab => tab.kind === "data" && tab.table === table,
    );
    if (existing) {
      activate(existing.id);
      return;
    }
    const tab = createDataTab(table);
    const next: TabsState = { tabs: [...current.tabs, tab], activeId: tab.id };
    setTabs(next);
    tabsRef.current = next;
    store.showSnapshot(snapshotOf(tab));
    runDataWith(tab, { page: 0, pageSize: tab.pageSize, filter: null, sorts: null });
  }

  function handleHeaderClick(columnIndex: number, event: { shiftKey: boolean }): void {
    const tab = activeTabOf(tabsRef.current);
    if (!tab || tab.kind !== "data" || !tab.meta) {
      return;
    }
    const column = tab.meta.columns[columnIndex];
    if (column === undefined) {
      return;
    }
    const sorts = cycleSort(tab.sorts ?? [], column, event.shiftKey);
    runDataWith(tab, { page: 0, pageSize: tab.pageSize, filter: tab.filter ?? null, sorts });
  }

  function handleSelectionChange(row: number | null): void {
    if (row !== null && detailRowRef.current !== null) {
      setDetailRow(row);
    }
  }

  function handleCellContextMenu(row: number, col: number, x: number, y: number): void {
    if (state.result === null) {
      return;
    }
    setMenu({ row, col, x, y });
  }

  function handleCellEdited(_row: number, col: number): void {
    const tab = activeTabOf(tabsRef.current);
    if (!tab || tab.kind !== "data" || !tab.meta) {
      return;
    }
    const column = tab.meta.columns[col];
    if (column === undefined) {
      return;
    }
    const inFilter = (tab.filter?.rows ?? []).some((row) => row.enabled && row.column === column);
    const inSort = (tab.sorts ?? []).some((sort) => sort.column === column);
    if (inFilter || inSort) {
      runDataWith(tab, dataSpecOf(tab, tab.page, tab.pageSize));
    }
  }

  function menuItems(menuState: MenuState): ContextMenuItem[] {
    const result = state.result;
    if (!result) {
      return [];
    }
    const source = result.source;
    const canEdit =
      result.meta.sourceTable !== null && result.meta.pk !== null && result.meta.pk.length > 0;
    const value = source.cell(menuState.row, menuState.col);
    const tab = activeTabOf(tabsRef.current);
    const table =
      result.meta.sourceTable !== null
        ? result.meta.sourceTable
        : tab && tab.kind === "data"
          ? tab.table
          : null;
    const items: ContextMenuItem[] = [
      {
        label: "셀 값 복사",
        onSelect: () => {
          void (async () => {
            if (source.cell(menuState.row, menuState.col) === undefined) {
              await source.ensureRow(menuState.row);
            }
            const cell = source.cell(menuState.row, menuState.col);
            await writeClipboard(cell === null ? "NULL" : cellToText(cell));
          })();
        },
      },
      {
        label: "행 복사 (TSV)",
        onSelect: () => {
          void (async () => {
            const values = await rowValues(source, menuState.row);
            await writeClipboard(
              values.map((entry) => (entry === null ? "" : cellToText(entry))).join("\t"),
            );
          })();
        },
      },
    ];
    if (canEdit) {
      items.push({
        label: "값을 NULL로 설정",
        disabled: value === null || value === undefined,
        onSelect: () => {
          void store.editCell(menuState.row, menuState.col, null).then((outcome) => {
            if (outcome !== null) {
              handleCellEdited(outcome.row, outcome.col);
            }
          });
        },
      });
    }
    items.push({
      label: "행 상세 보기",
      onSelect: () => setDetailRow(menuState.row),
    });
    if (table !== null) {
      items.push({
        label: "INSERT 문 복사",
        separatorBefore: true,
        onSelect: () => {
          void (async () => {
            const values = await rowValues(source, menuState.row);
            await writeClipboard(toSqlInserts(table, result.meta.columns, [values]));
          })();
        },
      });
      items.push({
        label: "UPDATE 문 복사",
        disabled: !canEdit,
        onSelect: () => {
          void (async () => {
            const values = await rowValues(source, menuState.row);
            const sql = buildUpdateSql(table, result.meta.columns, values, result.meta.pk ?? []);
            if (sql === null) {
              store.setError("기본 키가 없어 UPDATE 문을 만들 수 없습니다");
              return;
            }
            await writeClipboard(sql);
          })();
        },
      });
    }
    if (canEdit) {
      items.push({
        label: "이 셀 편집",
        separatorBefore: true,
        onSelect: () => gridHostRef.current?.beginEdit(menuState.row, menuState.col),
      });
    }
    return items;
  }

  function openExport(): void {
    const result = state.result;
    if (!result) {
      return;
    }
    setExportTarget({
      title: activeTab ? activeTab.title : "export",
      result,
      dataTab: activeDataTab,
    });
  }

  function onSplitterDown(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    const main = mainRef.current;
    if (!main) {
      return;
    }
    const rect = main.getBoundingClientRect();
    const startY = event.clientY;
    const startHeight = editorHeight ?? rect.height * 0.35;
    const onMove = (move: PointerEvent): void => {
      const next = startHeight + (move.clientY - startY);
      setEditorHeight(Math.min(Math.max(next, 90), rect.height - 140));
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  useEffect(() => {
    void store.init();
  }, []);

  useEffect(() => {
    const tab = activeTabOf(tabsRef.current);
    if (tab) {
      store.showSnapshot(snapshotOf(tab));
    }
  }, []);

  useEffect(() => {
    if (generationRef.current === state.generation) {
      return;
    }
    generationRef.current = state.generation;
    seededGenRef.current = state.generation;
    if (runningTabRef.current !== null) {
      closedDuringRunRef.current = runningTabRef.current;
      store.cancelQuery();
      setRunningTabId(null);
    }
    for (const tab of tabsRef.current.tabs) {
      tab.source?.dispose();
    }
    const fresh = createQueryTab(nextSeq(), seedSqlForMeta(state.meta));
    const next: TabsState = { tabs: [fresh], activeId: fresh.id };
    setTabs(next);
    store.showSnapshot(snapshotOf(fresh));
    setResultView("grid");
    setDetailRow(null);
    setExportTarget(null);
    setMenu(null);
  }, [state.generation, state.meta]);

  useEffect(() => {
    const current = state.meta;
    if (!current || seededGenRef.current === state.generation) {
      return;
    }
    seededGenRef.current = state.generation;
    const tab = activeTabOf(tabsRef.current);
    if (!tab || tab.sql.trim() !== "") {
      return;
    }
    const sql = seedSqlForMeta(current);
    if (sql === "") {
      return;
    }
    editorRef.current?.setSql(sql);
    setTabs((prev) => patchTab(prev, tab.id, { sql }));
  }, [state.generation, state.meta]);

  useEffect(() => {
    const pending = pendingEditorSqlRef.current;
    if (pending !== null) {
      pendingEditorSqlRef.current = null;
      editorRef.current?.setSql(pending);
      editorRef.current?.focus();
      return;
    }
    if (focusRequestRef.current) {
      focusRequestRef.current = false;
      editorRef.current?.focus();
    }
  }, [tabs.activeId]);

  useEffect(() => {
    const tab = activeTabOf(tabs);
    if (!tab || tab.kind !== "data") {
      return;
    }
    if (editorRef.current?.getDoc() !== tab.sql) {
      editorRef.current?.setSql(tab.sql);
    }
  }, [tabs]);

  useEffect(() => {
    function modalOpen(): boolean {
      return connectOpenRef.current || fsOpenRef.current || exportTargetRef.current !== null;
    }
    function onKeyDown(event: KeyboardEvent): void {
      const mod = event.metaKey || event.ctrlKey;
      if (event.key === "F5") {
        event.preventDefault();
        if (!modalOpen()) {
          void store.refreshMeta();
        }
        return;
      }
      if (event.key === "Escape") {
        if (exportTargetRef.current !== null || menuRef.current !== null) {
          return;
        }
        if (detailRowRef.current !== null) {
          setDetailRow(null);
        }
        return;
      }
      if (!mod) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "enter") {
        if (event.defaultPrevented) {
          return;
        }
        event.preventDefault();
        if (!modalOpen()) {
          runRef.current();
        }
        return;
      }
      if (event.altKey || event.shiftKey) {
        return;
      }
      if (key === "t") {
        event.preventDefault();
        if (!modalOpen()) {
          newTabRef.current();
        }
        return;
      }
      if (key === "w") {
        event.preventDefault();
        if (!modalOpen()) {
          closeRef.current(tabsRef.current.activeId);
        }
        return;
      }
      if (key === "k") {
        event.preventDefault();
        if (!modalOpen()) {
          editorRef.current?.focus();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const canEditResult =
    state.result !== null &&
    state.result.meta.sourceTable !== null &&
    state.result.meta.pk !== null &&
    state.result.meta.pk.length > 0;

  const messageAvailable = state.error !== null || state.info !== null;
  const detailOpen = detailRow !== null && state.result !== null;
  const filterVisible = activeDataTab !== null && (filterOpen[activeDataTab.id] ?? false);

  return (
    <div className="app">
      <header className="appbar">
        <span className="brand">prodb</span>
        <span className="conn-badge">
          <DatabaseIcon size={11} className="conn-icon" />
          {meta ? (
            <>
              <span>{meta.demo ? "데모" : meta.kind}</span>
              {meta.path ? <span className="conn-path">{meta.path}</span> : null}
            </>
          ) : (
            <span className="conn-none">연결 없음</span>
          )}
        </span>
        <span className="spacer" />
        <button type="button" onClick={() => setConnectOpen(true)} title="서버 연결">
          연결
        </button>
        <button type="button" onClick={() => setFsOpen(true)} title="SQLite 파일 열기">
          파일 열기
        </button>
        <button type="button" onClick={() => void store.openDb(null)} title="인메모리 데모 열기">
          데모
        </button>
        <button
          type="button"
          className="icon-text-button"
          onClick={() => void store.refreshMeta()}
          title="새로고침 (F5)"
        >
          <RefreshIcon size={12} />
          새로고침
        </button>
      </header>
      <div className="toolbar">
        <button
          type="button"
          className="primary run-button"
          disabled={state.status === "running"}
          onClick={run}
          title="실행 (⌘Enter)"
        >
          <PlayIcon size={11} />
          실행
        </button>
        {state.status === "running" && (
          <button type="button" onClick={() => store.cancelQuery()} title="쿼리 취소">
            <StopIcon size={11} />
            정지
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          onClick={createNewTab}
          title="새 탭 (⌘T)"
        >
          <PlusIcon size={12} />
        </button>
        <TabStrip
          tabs={tabs.tabs}
          activeId={tabs.activeId}
          runningTabId={runningTabId}
          onActivate={activate}
          onClose={closeTabById}
          onRename={renameTabById}
        />
        <div className="toolbar-right">
          <label className="max-rows" title="최대 행 수">
            최대 행
            <input
              type="number"
              min={1}
              max={MAX_ROWS_LIMIT}
              value={maxRows}
              onChange={(event) => setMaxRows(clampRows(Number(event.target.value)))}
            />
          </label>
          <HistoryMenu onPickSql={pickSql} />
          <FavoritesMenu onPickSql={pickSql} getSql={() => editorRef.current?.getSql() ?? ""} />
          <button
            type="button"
            className={schemaOpen ? "active" : ""}
            onClick={() => setSchemaOpen((value) => !value)}
            title="스키마 패널"
          >
            스키마
          </button>
          {canEditResult ? (
            state.tx === "active" ? (
              <>
                <span className="tx-badge" title="트랜잭션 진행 중">
                  TX
                </span>
                <button
                  type="button"
                  disabled={state.status === "running"}
                  onClick={() => void store.commitTx()}
                  title="커밋"
                >
                  커밋
                </button>
                <button
                  type="button"
                  disabled={state.status === "running"}
                  onClick={() => void store.rollbackTx()}
                  title="롤백"
                >
                  롤백
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={state.status === "running"}
                onClick={() => void store.beginTx()}
                title="트랜잭션 시작"
              >
                트랜잭션 시작
              </button>
            )
          ) : null}
        </div>
      </div>
      <div className="workbench">
        {schemaOpen && (
          <SchemaSidebar
            refreshKey={schemaKey}
            onOpenData={openDataTab}
            onOpenInEditor={pickTable}
          />
        )}
        <div className="workbench-main" ref={mainRef}>
          <div
            className="editor-pane"
            style={editorHeight === null ? undefined : { flexBasis: `${editorHeight}px` }}
          >
            <SqlEditor
              ref={editorRef}
              tabId={tabs.activeId}
              tabIds={tabIds}
              initialSql={activeTab ? activeTab.sql : ""}
              readOnly={activeDataTab !== null}
              onRun={run}
              onSqlChange={handleSqlChange}
              tables={plainTables}
            />
          </div>
          <div
            className="h-splitter"
            role="separator"
            aria-orientation="horizontal"
            onPointerDown={onSplitterDown}
          />
          <div className="result-pane">
            {activeDataTab ? (
              <div className="data-toolbar">
                <DataTabToolbar
                  tab={activeDataTab}
                  running={state.status === "running"}
                  filterOpen={filterVisible}
                  onRefresh={() =>
                    runDataWith(activeDataTab, dataSpecOf(activeDataTab, activeDataTab.page, activeDataTab.pageSize))
                  }
                  onToggleFilter={() =>
                    setFilterOpen((prev) => ({
                      ...prev,
                      [activeDataTab.id]: !(prev[activeDataTab.id] ?? false),
                    }))
                  }
                  onPageSize={(size) => runDataWith(activeDataTab, dataSpecOf(activeDataTab, 0, size))}
                  onFirst={() => runDataWith(activeDataTab, dataSpecOf(activeDataTab, 0, activeDataTab.pageSize))}
                  onPrev={() =>
                    runDataWith(
                      activeDataTab,
                      dataSpecOf(activeDataTab, Math.max(0, activeDataTab.page - 1), activeDataTab.pageSize),
                    )
                  }
                  onNext={() =>
                    runDataWith(activeDataTab, dataSpecOf(activeDataTab, activeDataTab.page + 1, activeDataTab.pageSize))
                  }
                />
              </div>
            ) : null}
            {activeDataTab && filterVisible ? (
              <FilterBar
                columns={dataMeta?.columns ?? EMPTY_TABLES}
                filter={activeDataTab.filter ?? EMPTY_FILTER}
                running={state.status === "running"}
                onApply={(next) =>
                  runDataWith(activeDataTab, { page: 0, pageSize: activeDataTab.pageSize, filter: next, sorts: activeDataTab.sorts ?? null })
                }
                onReset={() =>
                  runDataWith(activeDataTab, { page: 0, pageSize: activeDataTab.pageSize, filter: null, sorts: activeDataTab.sorts ?? null })
                }
              />
            ) : null}
            <div className="result-tabs">
              <button
                type="button"
                className={`result-tab${resultView === "grid" ? " active" : ""}`}
                onClick={() => setResultView("grid")}
              >
                그리드
              </button>
              <button
                type="button"
                className={`result-tab${resultView === "message" ? " active" : ""}`}
                onClick={() => setResultView("message")}
              >
                메시지
                {messageAvailable ? <span className="dot" aria-hidden="true" /> : null}
              </button>
              <span className="spacer" />
              <button
                type="button"
                className="result-action"
                disabled={state.result === null}
                onClick={() => setDetailRow(detailRow === null ? 0 : null)}
                title="행 상세 패널"
              >
                <PanelIcon size={11} />
                행 상세
              </button>
              <button
                type="button"
                className="result-action"
                disabled={state.result === null}
                onClick={openExport}
                title="결과 내보내기"
              >
                <DownloadIcon size={11} />
                내보내기
              </button>
            </div>
            <div className={`result-body${detailOpen ? " with-detail" : ""}`}>
              <div className={`result-layer${resultView === "grid" ? "" : " hidden"}`}>
                <GridHost
                  ref={gridHostRef}
                  result={state.result}
                  sortColumns={sortIndicators}
                  onHeaderClick={activeDataTab ? handleHeaderClick : undefined}
                  onSelectionChange={handleSelectionChange}
                  onCellContextMenu={handleCellContextMenu}
                  onCellEdited={handleCellEdited}
                />
                {!state.result && (
                  <div className="grid-empty">
                    {meta ? "쿼리를 실행하세요 (⌘Enter)" : "연결 또는 파일 열기로 시작하세요"}
                  </div>
                )}
              </div>
              {detailOpen && state.result ? (
                <RowDetailPanel
                  result={state.result}
                  row={detailRow}
                  table={activeDataTab ? activeDataTab.table : state.result.meta.sourceTable}
                  onClose={() => setDetailRow(null)}
                />
              ) : null}
              {resultView === "message" && (
                <div className="message-pane">
                  {state.error ? (
                    <div className="message-error">{state.error}</div>
                  ) : state.info ? (
                    <div className="message-info">{state.info}</div>
                  ) : (
                    <div className="message-empty">메시지가 없습니다</div>
                  )}
                </div>
              )}
            </div>
            <div className="result-statusline">
              <span>
                {state.status === "running"
                  ? "실행 중…"
                  : state.result
                    ? `${state.result.meta.rowCount.toLocaleString()}행 · ${state.result.meta.elapsedMs.toFixed(1)}ms`
                    : "준비됨"}
              </span>
              {state.result?.meta.truncated ? <span className="warn">잘림</span> : null}
              {activeDataTab && pageInfo ? (
                <span className="dim">
                  {pageInfo.rows === null
                    ? `${pageInfo.page + 1} 페이지+`
                    : pageInfo.truncated
                      ? `${pageInfo.page + 1} 페이지+ · ${pageInfo.rows.toLocaleString()}+행`
                      : `${pageInfo.page + 1} / ${pageInfo.pages ?? 1} 페이지 · 총 ${pageInfo.rows.toLocaleString()}행`}
                </span>
              ) : null}
              {state.info && state.status !== "running" ? (
                <span className="dim ellipsis">{state.info}</span>
              ) : null}
              <span className="spacer" />
              {activeTab ? <span className="dim">{activeTab.title}</span> : null}
            </div>
          </div>
        </div>
      </div>
      <div className="statusbar">
        {state.error ? <span className="err ellipsis">{state.error}</span> : null}
        {state.tx === "active" ? <span className="warn">트랜잭션 진행 중</span> : null}
        <span className="spacer" />
        {state.connection === "connecting" ? (
          <span>연결 중…</span>
        ) : state.connection === "closed" && state.result !== null ? (
          <span>연결 끊김</span>
        ) : null}
        {meta ? (
          <span className="dim">{`${meta.kind}${meta.demo ? " (데모)" : ""} · 테이블 ${meta.tables.length}개`}</span>
        ) : null}
      </div>
      {menu !== null ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={() => setMenu(null)} />
      ) : null}
      {fsOpen && (
        <FsModal
          onClose={() => setFsOpen(false)}
          onOpenDb={(path) => {
            setFsOpen(false);
            void store.openDb(path);
          }}
        />
      )}
      {connectOpen && <ConnectModal onClose={() => setConnectOpen(false)} />}
      {exportTarget !== null && (
        <ExportModal
          title={exportTarget.title}
          result={exportTarget.result}
          dataTab={exportTarget.dataTab}
          onClose={() => setExportTarget(null)}
        />
      )}
    </div>
  );
}
