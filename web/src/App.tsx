import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { CommandPalette, type PaletteAction, type PaletteSource } from "./components/CommandPalette";
import { ColumnPicker, type ColumnEntry } from "./components/ColumnPicker";
import { ConnectModal } from "./components/ConnectModal";
import { CreateTableModal } from "./components/CreateTableModal";
import { ConnSwitcher } from "./components/ConnSwitcher";
import { ContextMenu, type ContextMenuItem } from "./components/ContextMenu";
import { DataTabToolbar } from "./components/DataToolbar";
import {
  dropTableSql,
  laravelSchemaScript,
  quoteIdent,
  renameTableSql,
  truncateTableSql,
} from "./ddl";
import { listDrafts, removeDraft, saveDraft } from "./drafts";
import { subscribeConnMeta } from "./connMeta";
import { DefinitionPanel } from "./components/DefinitionPanel";
import { ExplainPlanPanel } from "./components/ExplainPlanPanel";
import { ConnectionPickerModal, type PickTarget } from "./components/ConnectionPickerModal";
import { DumpModal } from "./components/DumpModal";
import { EmptyWorkspace } from "./components/EmptyWorkspace";
import { ErrorNotice } from "./components/ErrorNotice";
import { ExportModal } from "./components/ExportModal";
import { FilterBar } from "./components/FilterBar";
import { FavoritesMenu, HistoryMenu } from "./components/Dropdowns";
import { FsModal } from "./components/FsModal";
import { GridHost, type GridHostHandle } from "./components/GridHost";
import { HomeScreen, type NewConnectionOptions } from "./components/HomeScreen";
import { HoverTooltip } from "./components/HoverTooltip";
import { t, tTableCount } from "./i18n";
import { ImportModal } from "./components/ImportModal";
import { JobsModal } from "./components/JobsModal";
import { ParamModal } from "./components/ParamModal";
import { ReviewModal } from "./components/ReviewModal";
import { SAFE_MODE_LABELS, SafeModeMenu } from "./components/SafeModeMenu";
import { SettingsModal } from "./components/SettingsModal";
import { ConsoleLogModal } from "./components/ConsoleLogModal";
import { ActivityModal } from "./components/ActivityModal";
import { BrandLogo } from "./components/BrandLogo";
import { MetricsModal } from "./components/MetricsModal";
import { LockScreen } from "./components/LockScreen";
import { OverviewPanel } from "./components/OverviewPanel";
import { CellQuickLook } from "./components/CellQuickLook";
import { RowDetailPanel } from "./components/RowDetailPanel";
import { Spinner } from "./components/Spinner";
import { SchemaSidebar, type TableAction } from "./components/SchemaSidebar";
import { ServerInfoPanel } from "./components/ServerInfoPanel";
import { SqlEditor, type SqlEditorHandle } from "./components/SqlEditor";
import { StructurePanel } from "./components/StructurePanel";
import { UserManagerModal } from "./components/UserManagerModal";
import { TabStrip } from "./components/TabStrip";
import {
  CheckIcon,
  DatabaseIcon,
  JobsIcon,
  MoreIcon,
  LogIcon,
  PanelIcon,
  PanelLeftIcon,
  PlayIcon,
  PlusIcon,
  RefreshIcon,
  SettingsIcon,
  SnippetIcon,
  StopIcon,
} from "./components/icons";
import {
  buildDataSql,
  cycleSort,
  EMPTY_FILTER,
  quoteLiteral,
  selectList,
  type FilterState,
  type SortState,
} from "./dataQuery";
import { buildUpdateSql, toSqlInserts } from "./export";
import { subscribeJobs } from "./jobs";
import { addQueryLog } from "./consoleLog";
import {
  getPasscodeHash,
  getSettings,
  saveSettings,
  subscribeSettings,
  type AppSettings,
} from "./settings";
import { cellToString, fkFilterFor } from "./rowOps";
import {
  bindParams,
  explainPrefixFor,
  extractParams,
  formatSql,
  isExplainSql,
  uppercaseSql,
  planSqlFor,
  snippetList,
  reviewStatements,
  type DefinitionKind,
  type ReviewItem,
  type SafeMode,
} from "./sqlTools";
import { forgetSchema, loadSchema } from "./schemaCache";
import { splitSqlStatements } from "./sqlSplit";
import { IS_MAC, actionForEvent, shortcutHint, type KeyAction } from "./shortcuts";
import type { SortIndicator } from "./grid/CanvasGrid";
import { subscribePendingChanges, type WindowedRowSource } from "./grid/windowSource";
import {
  missingSecretOf,
  store,
  type ConnSummary,
  type EngineMeta,
  type Favorite,
  type GridResult,
  type LiveConn,
  type QueryOutcome,
  type MissingSecret,
  type SavedConnection,
  type TableDetail,
  type TxState,
} from "./store";
import {
  activeTabOf,
  addTab,
  activateTab,
  closeTab,
  createDataTab,
  createDefinitionTab,
  createOverviewTab,
  createQueryTab,
  createServerTab,
  dataPageInfo,
  migrateTabsState,
  patchFromOutcome,
  patchTab,
  renameTab,
  seedSqlForMeta,
  snapshotOf,
  tabById,
  type DataTab,
  type DefinitionTab,
  type TableView,
  type TabsState,
  type WorkbenchTab,
} from "./tabs";

const EMPTY_TABLES: string[] = [];
const MAX_ROWS_LIMIT = 500000;
const WORKSPACES_KEY = "tablepeek.workspaces";
const PINNED_KEY = "tablepeek.pinned-tables";
const PERSIST_DROP_KEYS = new Set(["source", "data", "detail"]);
const TABLE_VIEWS: TableView[] = ["data", "structure", "ddl"];

interface DataRunSpec {
  offset: number;
  pageSize: number;
  filter: FilterState | null;
  sorts: SortState[] | null;
}

interface DbMenuState {
  x: number;
  y: number;
  databases: string[];
}

interface ExportTarget {
  conn: string;
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

interface Workspace {
  tabs: TabsState;
  meta: EngineMeta;
  tx: TxState;
}

interface PersistedPayload {
  activeConnId: string | null;
  workspaces: Record<string, Workspace>;
}

function clampRows(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(MAX_ROWS_LIMIT, Math.max(1, Math.trunc(value)));
}

function primaryKeyOf(detail: TableDetail | undefined): string[] | null {
  if (!detail) {
    return null;
  }
  const primary = detail.indexes.find((index) => index.primary);
  if (primary && primary.columns.length > 0) {
    return primary.columns;
  }
  const pkColumns = detail.columns
    .filter((column) => column.pk)
    .map((column) => column.name);
  return pkColumns.length > 0 ? pkColumns : null;
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

function errorOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function pendingTotal(tabs: WorkbenchTab[]): number {
  let total = 0;
  for (const tab of tabs) {
    if ((tab.kind === "query" || tab.kind === "data") && tab.source) {
      total += tab.source.pendingSummary().total;
    }
  }
  return total;
}

function discardAllPending(tabs: WorkbenchTab[]): void {
  for (const tab of tabs) {
    if (tab.kind === "query" || tab.kind === "data") {
      tab.source?.discardPending();
    }
  }
}

// Staged grid changes are dropped only after the user agrees to lose them.
function confirmDropPending(source: WindowedRowSource | null | undefined): boolean {
  if (!source || !source.hasPending()) {
    return true;
  }
  const count = source.pendingSummary().total;
  if (!window.confirm(t("적용하지 않은 변경 {count}건이 있습니다. 버리고 계속할까요?", { count }))) {
    return false;
  }
  source.discardPending();
  return true;
}

function persistReplacer(key: string, value: unknown): unknown {
  if (PERSIST_DROP_KEYS.has(key)) {
    return undefined;
  }
  return value;
}

function loadParamValues(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem("tablepeek.param-values");
    if (raw === null) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function loadTableMap(key: string): Record<string, string[]> {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, string[]>;
    if (parsed === null || typeof parsed !== "object") {
      return {};
    }
    const out: Record<string, string[]> = {};
    for (const [conn, list] of Object.entries(parsed)) {
      if (Array.isArray(list)) {
        out[conn] = list.filter((entry) => typeof entry === "string");
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveTableMap(key: string, map: Record<string, string[]>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(map));
  } catch {}
}

function loadPersisted(): PersistedPayload | null {
  try {
    const raw = window.localStorage.getItem(WORKSPACES_KEY);
    if (raw === null) {
      return null;
    }
    const parsed = JSON.parse(raw) as PersistedPayload;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    if (typeof parsed.workspaces !== "object" || parsed.workspaces === null) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export default function App() {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const [conns, setConns] = useState<ConnSummary[]>([]);
  const [, setConnMetaVersion] = useState(0);
  const [workspaces, setWorkspaces] = useState<Record<string, Workspace>>({});
  const [activeConnId, setActiveConnId] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [busySaved, setBusySaved] = useState<string | null>(null);
  const [maxRows, setMaxRows] = useState(10000);
  const [fsOpen, setFsOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectEditing, setConnectEditing] = useState<{
    saved: SavedConnection;
    notice: string | null;
    missingSecret: MissingSecret | null;
  } | null>(null);
  // What the home screen picked for a new connection (driver, group, URL).
  const [newConnOptions, setNewConnOptions] = useState<NewConnectionOptions | null>(null);
  const [savedVersion, setSavedVersion] = useState(0);
  const [schemaOpen, setSchemaOpen] = useState(true);
  const [resultView, setResultView] = useState<"grid" | "message" | "plan">("grid");
  const [runningTabId, setRunningTabId] = useState<string | null>(null);
  const [editorHeight, setEditorHeight] = useState<number | null>(null);
  const [filterOpen, setFilterOpen] = useState<Record<string, boolean>>({});
  const [detailRow, setDetailRow] = useState<number | null>(null);
  const [rowDetailInfo, setRowDetailInfo] = useState<TableDetail | null>(null);
  const [rowDetailLoading, setRowDetailLoading] = useState(false);
  const [cellQuickLook, setCellQuickLook] = useState<{ row: number; col: number } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [exportTarget, setExportTarget] = useState<ExportTarget | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [alertMode, setAlertMode] = useState<SafeMode>(() => {
    const raw = window.localStorage.getItem("tablepeek.alert-mode");
    if (raw === "0" || raw === "1" || raw === "2") {
      return Number(raw) as 0 | 1 | 2;
    }
    return window.localStorage.getItem("tablepeek.safe-mode") === "0" ? 0 : 1;
  });
  const [snippetMenu, setSnippetMenu] = useState<{ x: number; y: number } | null>(null);
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number; anchor: Element } | null>(null);
  const [metaNonce, setMetaNonce] = useState(0);
  const [pinnedTables, setPinnedTables] = useState<Record<string, string[]>>(() =>
    loadTableMap(PINNED_KEY),
  );
  const [countingTabId, setCountingTabId] = useState<string | null>(null);
  const [columnsPickOpen, setColumnsPickOpen] = useState(false);
  const [createTableOpen, setCreateTableOpen] = useState(false);
  const [userMgrOpen, setUserMgrOpen] = useState(false);
  const [dbMenu, setDbMenu] = useState<DbMenuState | null>(null);
  const [importTarget, setImportTarget] = useState<{ kind: string; table: string } | null>(null);
  const [dumpTab, setDumpTab] = useState<"backup" | "restore" | null>(null);
  // Home's backup/restore: choosing which connection, then waiting for it to open.
  const [dumpPicker, setDumpPicker] = useState<{ kind: "backup" | "restore"; saved: SavedConnection[] } | null>(
    null,
  );
  const pendingDumpRef = useRef<{ target: PickTarget; kind: "backup" | "restore" } | null>(null);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [jobsRunning, setJobsRunning] = useState(0);
  const [settings, setSettings] = useState<AppSettings>(() => getSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [, setPendingVersion] = useState(0);
  const [locked, setLocked] = useState<boolean>(() => getPasscodeHash() !== null);
  const [logOpen, setLogOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [paramPrompt, setParamPrompt] = useState<{
    conn: string;
    tabId: string;
    sql: string;
    params: string[];
  } | null>(null);
  const [reviewPrompt, setReviewPrompt] = useState<{
    conn: string;
    tabId: string;
    sql: string;
    items: ReviewItem[];
  } | null>(null);
  const [resultChips, setResultChips] = useState<{
    conn: string;
    tabId: string;
    entries: { label: string; outcome: QueryOutcome }[];
  } | null>(null);
  const [schemaMap, setSchemaMap] = useState<Record<string, string[]>>({});
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [splitSide, setSplitSide] = useState<"bottom" | "right">(() =>
    window.localStorage.getItem("tablepeek.split-side") === "right" ? "right" : "bottom",
  );
  const favoriteSnippets = useMemo(
    () =>
      favorites
        .filter((favorite) => (favorite.keyword ?? "") !== "")
        .map((favorite) => ({
          keyword: favorite.keyword ?? "",
          name: favorite.name,
          sql: favorite.sql,
        })),
    [favorites],
  );
  useEffect(
    () =>
      subscribeJobs((jobs) =>
        setJobsRunning(jobs.filter((job) => job.status === "running").length),
      ),
    [],
  );
  useEffect(() => subscribeSettings(setSettings), []);
  useEffect(() => {
    store.setActiveRunner(() => invalidateRef.current());
    return () => store.setActiveRunner(null);
  }, []);
  useEffect(
    () => subscribePendingChanges(() => setPendingVersion((value) => value + 1)),
    [],
  );
  useEffect(
    () => subscribeConnMeta(() => setConnMetaVersion((value) => value + 1)),
    [],
  );
  useEffect(() => {
    if (activeConnId !== null) {
      store.warmSocket();
    }
  }, [activeConnId]);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  useEffect(() => {
    window.localStorage.setItem("tablepeek.alert-mode", String(alertMode));
  }, [alertMode]);
  useEffect(() => {
    window.localStorage.setItem("tablepeek.split-side", splitSide);
  }, [splitSide]);
  useEffect(() => {
    let alive = true;
    function load(): void {
      void store
        .fetchFavorites()
        .then((next) => {
          if (alive) {
            setFavorites(next);
          }
        })
        .catch(() => {});
    }
    load();
    window.addEventListener("tablepeek:favorites-changed", load);
    return () => {
      alive = false;
      window.removeEventListener("tablepeek:favorites-changed", load);
    };
  }, []);
  const editorRef = useRef<SqlEditorHandle | null>(null);
  const gridHostRef = useRef<GridHostHandle | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const seqRef = useRef(2);
  const workspacesRef = useRef(workspaces);
  const activeConnIdRef = useRef(activeConnId);
  const prevConnRef = useRef<string | null>(null);
  const runningTabRef = useRef(runningTabId);
  const closedDuringRunRef = useRef<string | null>(null);
  const focusRequestRef = useRef(false);
  const pendingEditorSqlRef = useRef<string | null>(null);
  const connectOpenRef = useRef(connectOpen);
  const fsOpenRef = useRef(fsOpen);
  const detailRowRef = useRef(detailRow);
  const cellQuickLookRef = useRef(cellQuickLook);
  const menuRef = useRef(menu);
  const exportTargetRef = useRef(exportTarget);
  const importTargetRef = useRef(importTarget);
  const paramPromptRef = useRef(paramPrompt);
  const reviewPromptRef = useRef(reviewPrompt);
  const dumpTabRef = useRef(dumpTab);
  const jobsOpenRef = useRef(jobsOpen);
  const historyReadyRef = useRef(false);
  const historyNavRef = useRef(false);
  const paletteOpenRef = useRef(paletteOpen);
  const settingsOpenRef = useRef(settingsOpen);
  const lockedRef = useRef(locked);
  const logOpenRef = useRef(logOpen);
  const activityOpenRef = useRef(activityOpen);
  const metricsOpenRef = useRef(metricsOpen);
  const detailCacheRef = useRef(new Map<string, TableDetail>());
  const shortcutRef = useRef<(action: KeyAction) => void>(() => {});
  const lastSelectedRowRef = useRef<number | null>(null);
  const invalidateRef = useRef<() => void>(() => {});
  const applyingRef = useRef(false);
  const cycleViewRef = useRef<(delta: -1 | 1) => void>(() => {});
  const serverConnRef = useRef(false);

  workspacesRef.current = workspaces;
  activeConnIdRef.current = activeConnId;
  runningTabRef.current = runningTabId;
  connectOpenRef.current = connectOpen;
  fsOpenRef.current = fsOpen;
  detailRowRef.current = detailRow;
  cellQuickLookRef.current = cellQuickLook;
  menuRef.current = menu;
  exportTargetRef.current = exportTarget;
  importTargetRef.current = importTarget;
  paramPromptRef.current = paramPrompt;
  reviewPromptRef.current = reviewPrompt;
  dumpTabRef.current = dumpTab;
  jobsOpenRef.current = jobsOpen;
  paletteOpenRef.current = paletteOpen;
  settingsOpenRef.current = settingsOpen;
  lockedRef.current = locked;
  logOpenRef.current = logOpen;
  activityOpenRef.current = activityOpen;
  metricsOpenRef.current = metricsOpen;

  const workspace = activeConnId !== null ? (workspaces[activeConnId] ?? null) : null;
  const tabs = workspace?.tabs ?? null;
  const meta = workspace?.meta ?? null;
  const home = activeConnId === null || workspace === null;
  const activeTab = tabs !== null ? activeTabOf(tabs) : null;
  const activeDataTab = activeTab !== null && activeTab.kind === "data" ? activeTab : null;
  const dataView = activeDataTab !== null && (activeDataTab.view ?? "data") === "data";
  const schemaKey = meta
    ? `${meta.kind}:${meta.path ?? ""}:${meta.tables.length}:${metaNonce}`
    : `none:${metaNonce}`;
  useEffect(() => {
    if (activeConnId === null) {
      setSchemaMap({});
      return;
    }
    let alive = true;
    // Shares the sidebar's cached/in-flight schema instead of a second request.
    void loadSchema(activeConnId, false, schemaKey)
      .then((tables) => {
        if (!alive) {
          return;
        }
        const map: Record<string, string[]> = {};
        for (const table of tables) {
          map[table.name] = table.columns.map((column) => column.name);
        }
        setSchemaMap(map);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [activeConnId, schemaKey]);

  // The connection picked for backup/restore is now active with its schema: open the dump window.
  useEffect(() => {
    const pending = pendingDumpRef.current;
    if (pending === null || activeConnId === null || meta === null) {
      return;
    }
    const active = conns.find((conn) => conn.id === activeConnId);
    const { connId, savedId } = pending.target;
    if (connId === activeConnId || (savedId !== undefined && active?.saved_id === savedId)) {
      pendingDumpRef.current = null;
      setDumpTab(pending.kind);
    }
  }, [activeConnId, meta, conns]);

  const serverConn =
    meta !== null && ["postgres", "cockroach", "mysql", "mssql"].includes(meta.kind);
  const tabIds = tabs !== null ? tabs.tabs.map((tab) => tab.id) : EMPTY_TABLES;
  const dataMeta = activeDataTab ? (activeDataTab.meta ?? null) : null;
  const sortIndicators: SortIndicator[] | undefined = dataMeta
    ? (activeDataTab?.sorts ?? [])
        .map((sort) => ({ columnIndex: dataMeta.columns.indexOf(sort.column), dir: sort.dir }))
        .filter((indicator) => indicator.columnIndex >= 0)
    : undefined;
  const pageInfo = activeDataTab
    ? dataPageInfo(activeDataTab, activeDataTab.count ?? null)
    : null;
  const columnEntries: ColumnEntry[] = (() => {
    if (!activeDataTab) {
      return [];
    }
    const detailCols = (activeDataTab.detail?.columns ?? []).map((column) => ({
      name: column.name,
      pk: column.pk,
    }));
    const metaPk = activeDataTab.meta?.pk ?? [];
    const metaCols = (activeDataTab.meta?.columns ?? []).map((name) => ({
      name,
      pk: metaPk.includes(name),
    }));
    const base = detailCols.length > 0 ? detailCols : metaCols;
    if (base.length === 0) {
      return [];
    }
    const visible = activeDataTab.columns ?? null;
    if (visible === null) {
      return base.map((column) => ({ name: column.name, visible: true, pk: column.pk }));
    }
    const pkByName = new Map(base.map((column) => [column.name, column.pk]));
    const entries: ColumnEntry[] = visible.map((name) => ({
      name,
      visible: true,
      pk: pkByName.get(name) ?? false,
    }));
    for (const column of base) {
      if (!visible.includes(column.name)) {
        entries.push({ name: column.name, visible: false, pk: column.pk });
      }
    }
    return entries;
  })();

  function nextSeq(): number {
    const value = seqRef.current;
    seqRef.current += 1;
    return value;
  }

  function tabsOf(conn: string): TabsState | null {
    return workspacesRef.current[conn]?.tabs ?? null;
  }

  function commitWorkspaces(next: Record<string, Workspace>): void {
    workspacesRef.current = next;
    setWorkspaces(next);
  }

  function setTabsFor(conn: string, next: TabsState): void {
    const ws = workspacesRef.current[conn];
    if (ws === undefined) {
      return;
    }
    commitWorkspaces({ ...workspacesRef.current, [conn]: { ...ws, tabs: next } });
  }

  function updateActiveTabs(updater: (tabsState: TabsState) => TabsState): void {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      return;
    }
    const current = tabsOf(conn);
    if (current === null) {
      return;
    }
    setTabsFor(conn, updater(current));
  }

  function handleOutcome(conn: string, tabId: string, outcome: QueryOutcome): boolean {
    if (closedDuringRunRef.current === tabId) {
      closedDuringRunRef.current = null;
      if (outcome.kind === "ok") {
        outcome.result.source.dispose();
      }
      return false;
    }
    const current = tabsOf(conn);
    if (current === null) {
      if (outcome.kind === "ok") {
        outcome.result.source.dispose();
      }
      return false;
    }
    if (activeConnIdRef.current === conn && current.activeId === tabId) {
      if (outcome.kind === "error") {
        setResultView(tabById(tabsOf(conn) ?? { tabs: [], activeId: "" }, tabId)?.kind === "data" ? "grid" : "message");
      } else if (outcome.kind === "ok") {
        setResultView(isExplainSql(outcome.result.sql) ? "plan" : "grid");
      }
    }
    const existing = tabById(current, tabId);
    if (
      existing &&
      (existing.kind === "query" || existing.kind === "data") &&
      existing.source &&
      outcome.kind === "ok" &&
      existing.source !== outcome.result.source
    ) {
      existing.source.dispose();
    }
    setTabsFor(conn, patchFromOutcome(current, tabId, outcome));
    return true;
  }

  function runDataWith(conn: string, tab: DataTab, spec: DataRunSpec): void {
    const current = store.getState();
    if (current.status === "running" && current.connId === conn) {
      return;
    }
    const known = tabsOf(conn);
    const live = known !== null ? tabById(known, tab.id) : null;
    if (live !== null && live.kind === "data" && !confirmDropPending(live.source)) {
      return;
    }
    const pk =
      tab.pkColumns ??
      primaryKeyOf(detailCacheRef.current.get(`${conn}:${tab.table}`)) ??
      tab.meta?.pk ??
      null;
    const sql = buildDataSql({
      kind: meta?.kind ?? "",
      table: tab.table,
      filter: spec.filter,
      sorts: spec.sorts,
      pk,
      columns: tab.columns ?? null,
      limit: spec.pageSize,
      offset: spec.offset,
    });
    const tabsState = tabsOf(conn);
    if (tabsState === null) {
      return;
    }
    setTabsFor(
      conn,
      patchTab(tabsState, tab.id, {
        sql,
        offset: spec.offset,
        pageSize: spec.pageSize,
        filter: spec.filter ?? undefined,
        sorts: spec.sorts ?? undefined,
      }),
    );
    setRunningTabId(tab.id);
    const wantsCount = tab.count !== undefined;
    void store.runQuery(conn, sql, spec.pageSize, tab.id).then((outcome) => {
      setRunningTabId(null);
      const applied = handleOutcome(conn, tab.id, outcome);
      if (!applied || outcome.kind !== "ok") {
        return;
      }
      if (outcome.result.meta.rowCount === 0 && spec.offset > 0) {
        const back = Math.max(0, spec.offset - spec.pageSize);
        runDataWith(conn, { ...tab, meta: outcome.result.meta }, { ...spec, offset: back });
        return;
      }
      if (wantsCount) {
        void refreshCount(conn, tab.id);
      }
    });
  }

  function dataSpecOf(tab: DataTab, offset: number, pageSize: number): DataRunSpec {
    return { offset, pageSize, filter: tab.filter ?? null, sorts: tab.sorts ?? null };
  }

  async function refreshCount(conn: string, tabId: string): Promise<void> {
    const current = tabsOf(conn);
    const tab = current !== null ? tabById(current, tabId) : null;
    if (tab === null || tab.kind !== "data") {
      return;
    }
    setCountingTabId(tabId);
    try {
      const count = await store.fetchCount(conn, tab.table);
      const latest = tabsOf(conn);
      const latestTab = latest !== null ? tabById(latest, tabId) : null;
      if (latest !== null && latestTab !== null && latestTab.kind === "data") {
        setTabsFor(conn, patchTab(latest, tabId, { count }));
      }
    } catch (err) {
      store.setError(errorOf(err, "행 수를 계산하지 못했습니다"));
    } finally {
      setCountingTabId((value) => (value === tabId ? null : value));
    }
  }

  function applyColumns(tab: DataTab, columns: string[] | undefined): void {
    const conn = activeConnIdRef.current;
    if (conn === null || !confirmDropPending(tab.source)) {
      return;
    }
    const current = tabsOf(conn);
    if (current === null) {
      return;
    }
    const updated: DataTab = { ...tab, columns };
    setTabsFor(conn, patchTab(current, tab.id, { columns }));
    runDataWith(conn, updated, dataSpecOf(updated, updated.offset, updated.pageSize));
  }

  function toggleColumn(name: string): void {
    const tab = currentTab();
    if (!tab || tab.kind !== "data") {
      return;
    }
    const base = columnEntries.map((entry) => entry.name);
    if (base.length === 0) {
      return;
    }
    const visible = columnEntries.filter((entry) => entry.visible).map((entry) => entry.name);
    const next = base.filter((entry) =>
      entry === name ? !visible.includes(entry) : visible.includes(entry),
    );
    if (next.length === 0) {
      store.setInfo("최소 한 개의 컬럼이 필요합니다");
      return;
    }
    const normalized =
      next.length === base.length && next.every((entry, index) => entry === base[index])
        ? undefined
        : next;
    applyColumns(tab, normalized);
  }

  function moveColumn(name: string, delta: -1 | 1): void {
    const tab = currentTab();
    if (!tab || tab.kind !== "data") {
      return;
    }
    const visible = columnEntries.filter((entry) => entry.visible).map((entry) => entry.name);
    const index = visible.indexOf(name);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= visible.length) {
      return;
    }
    const next = visible.slice();
    next[index] = visible[target];
    next[target] = name;
    applyColumns(tab, next);
  }

  function resetColumns(): void {
    const tab = currentTab();
    if (!tab || tab.kind !== "data") {
      return;
    }
    applyColumns(tab, undefined);
  }

  function currentTab(): WorkbenchTab | null {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      return null;
    }
    const current = tabsOf(conn);
    return current !== null ? activeTabOf(current) : null;
  }

  function executeStatements(
    conn: string,
    tabId: string,
    statements: string[],
    wrapTx = false,
  ): void {
    if (statements.length === 0 || store.getState().status === "running") {
      return;
    }
    const owners = tabsOf(conn);
    const owner = owners !== null ? tabById(owners, tabId) : null;
    if (owner !== null && owner.kind === "query" && !confirmDropPending(owner.source)) {
      return;
    }
    setRunningTabId(tabId);
    setResultChips(null);
    void (async () => {
      const outcomes: QueryOutcome[] = [];
      try {
        if (wrapTx) {
          await store.beginTx();
        }
        for (const statement of statements) {
          const started = performance.now();
          const outcome = await store.runQuery(conn, statement, maxRows, tabId);
          const elapsed = performance.now() - started;
          addQueryLog(
            conn,
            statement,
            elapsed,
            outcome.kind === "ok"
              ? { ok: true, rows: outcome.result.meta.rowCount }
              : outcome.kind === "error"
                ? { ok: false, rows: 0, error: outcome.error }
                : { ok: false, rows: 0, error: "취소됨" },
          );
          outcomes.push(outcome);
          if (outcome.kind !== "ok") {
            break;
          }
        }
      } catch (err) {
        setRunningTabId(null);
        store.setError(errorOf(err, "쿼리를 실행하지 못했습니다"));
        return;
      }
      setRunningTabId(null);
      const last = outcomes[outcomes.length - 1];
      if (last !== undefined) {
        handleOutcome(conn, tabId, last);
      }
      if (statements.length > 1 && outcomes.length > 0) {
        setResultChips({
          conn,
          tabId,
          entries: outcomes.map((outcome, index) => ({
            label: `결과 ${index + 1}`,
            outcome,
          })),
        });
      }
    })();
  }

  function startRun(conn: string, tabId: string, sqlText: string): void {
    const statements = splitSqlStatements(sqlText);
    // Every statement is checked, not just the first one.
    const items = reviewStatements(statements, alertMode);
    if (items.length > 0) {
      setReviewPrompt({ conn, tabId, sql: sqlText, items });
      return;
    }
    executeStatements(conn, tabId, statements);
  }

  function run(): void {
    const conn = activeConnIdRef.current;
    const tab = currentTab();
    if (conn === null || !tab || store.getState().status === "running") {
      return;
    }
    if (tab.kind === "data") {
      runDataWith(conn, tab, dataSpecOf(tab, tab.offset, tab.pageSize));
      return;
    }
    if (tab.kind !== "query") {
      return;
    }
    const sqlText = (editorRef.current?.getSql() ?? tab.sql).trim();
    if (sqlText === "") {
      return;
    }
    const params = extractParams(sqlText);
    if (params.length > 0) {
      setParamPrompt({ conn, tabId: tab.id, sql: sqlText, params });
      return;
    }
    startRun(conn, tab.id, sqlText);
  }

  function runWithParams(values: Record<string, string>): void {
    const prompt = paramPrompt;
    setParamPrompt(null);
    if (prompt === null) {
      return;
    }
    try {
      const stored = loadParamValues();
      window.localStorage.setItem(
        "tablepeek.param-values",
        JSON.stringify({ ...stored, ...values }),
      );
    } catch {}
    startRun(prompt.conn, prompt.tabId, bindParams(prompt.sql, values, quoteLiteral));
  }

  function runReviewed(wrapTx: boolean): void {
    const review = reviewPrompt;
    setReviewPrompt(null);
    if (review === null) {
      return;
    }
    executeStatements(review.conn, review.tabId, splitSqlStatements(review.sql), wrapTx);
  }

  function cycleAlertMode(): void {
    setAlertMode((value) => ((value + 1) % 3) as 0 | 1 | 2);
  }

  function formatCurrent(mode: "beautify" | "minify"): void {
    const tab = currentTab();
    if (tab === null || tab.kind !== "query") {
      return;
    }
    const sqlText = editorRef.current?.getDoc() ?? tab.sql;
    if (sqlText.trim() === "") {
      return;
    }
    const prepared =
      mode === "minify" && settingsRef.current.uppercaseKeywords
        ? uppercaseSql(sqlText)
        : sqlText;
    editorRef.current?.setSql(formatSql(prepared, mode));
  }

  function showResultChip(entry: { label: string; outcome: QueryOutcome }): void {
    if (resultChips === null) {
      return;
    }
    const current = tabsOf(resultChips.conn);
    if (current === null) {
      return;
    }
    const owner = tabById(current, resultChips.tabId);
    if (owner !== null && owner.kind === "query" && !confirmDropPending(owner.source)) {
      return;
    }
    const next = patchFromOutcome(current, resultChips.tabId, entry.outcome);
    setTabsFor(resultChips.conn, next);
    const tab = tabById(next, resultChips.tabId);
    if (tab !== null) {
      store.showSnapshot(resultChips.conn, snapshotOf(tab));
    }
  }

  function openDraftTab(tabId: string, sql: string, title: string): void {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      return;
    }
    const current = tabsOf(conn);
    if (current === null) {
      return;
    }
    const tab = { ...createQueryTab(nextSeq(), sql), title };
    setTabsFor(conn, { tabs: [...current.tabs, tab], activeId: tab.id });
    store.showSnapshot(conn, snapshotOf(tab));
    removeDraft(conn, tabId);
    focusRequestRef.current = true;
  }

  function activate(id: string): void {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      return;
    }
    const current = tabsOf(conn);
    if (current === null) {
      return;
    }
    const next = activateTab(current, id);
    if (next === current) {
      return;
    }
    setTabsFor(conn, next);
    const tab = tabById(next, id);
    if (tab) {
      store.showSnapshot(conn, snapshotOf(tab));
    }
  }

  function createNewTab(): void {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      return;
    }
    const current = tabsOf(conn);
    if (current === null) {
      return;
    }
    const next = addTab(current, nextSeq());
    setTabsFor(conn, next);
    const tab = activeTabOf(next);
    if (tab) {
      store.showSnapshot(conn, snapshotOf(tab));
    }
    focusRequestRef.current = true;
  }

  function closeTabById(id: string): void {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      return;
    }
    const current = tabsOf(conn);
    if (current === null) {
      return;
    }
    const tab = tabById(current, id);
    if (!tab) {
      return;
    }
    if ((tab.kind === "query" || tab.kind === "data") && !confirmDropPending(tab.source)) {
      return;
    }
    if (runningTabRef.current === id) {
      closedDuringRunRef.current = id;
      store.cancelQuery(conn);
      setRunningTabId(null);
    }
    const wasActive = current.activeId === id;
    if (tab.kind === "query") {
      const sql = wasActive ? (editorRef.current?.getDoc() ?? tab.sql) : tab.sql;
      if (sql.trim() !== "") {
        saveDraft(conn, id, sql, tab.title);
      } else {
        removeDraft(conn, id);
      }
    }
    const next = closeTab(current, id);
    setTabsFor(conn, next);
    if (wasActive) {
      const active = activeTabOf(next);
      if (active) {
        store.showSnapshot(conn, snapshotOf(active));
      } else {
        const ws = workspacesRef.current[conn];
        if (ws !== undefined) {
          store.activate(conn, ws.meta, null, ws.tx);
        }
      }
    }
    if (tab.kind === "query" || tab.kind === "data") {
      tab.source?.dispose();
    }
  }

  function renameTabById(id: string, title: string): void {
    updateActiveTabs((current) => renameTab(current, id, title));
  }

  function handleSqlChange(tabId: string, sql: string): void {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      return;
    }
    const current = tabsOf(conn);
    if (current === null) {
      return;
    }
    const tab = tabById(current, tabId);
    if (!tab || tab.kind !== "query" || tab.sql === sql) {
      return;
    }
    saveDraft(conn, tabId, sql, tab.title);
    setTabsFor(conn, patchTab(current, tabId, { sql }));
  }

  function openInQueryEditor(sql: string): void {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      return;
    }
    const current = tabsOf(conn);
    if (current === null) {
      return;
    }
    let target = activeTabOf(current);
    if (target === null || target.kind === "data") {
      const queryTabs = current.tabs.filter((tab) => tab.kind === "query");
      target = queryTabs.length > 0 ? queryTabs[queryTabs.length - 1] : null;
    }
    if (target === null) {
      const tab = createQueryTab(nextSeq(), sql);
      setTabsFor(conn, { tabs: [...current.tabs, tab], activeId: tab.id });
      focusRequestRef.current = true;
      return;
    }
    if (target.id === current.activeId) {
      setTabsFor(conn, patchTab(current, target.id, { sql }));
      editorRef.current?.setSql(sql);
      editorRef.current?.focus();
      return;
    }
    const activated = activateTab(current, target.id);
    const next = patchTab(activated, target.id, { sql });
    setTabsFor(conn, next);
    const tab = tabById(next, target.id);
    if (tab) {
      store.showSnapshot(conn, snapshotOf(tab));
    }
    pendingEditorSqlRef.current = sql;
  }

  function pickSql(sql: string): void {
    openInQueryEditor(sql);
  }

  function pickTable(table: string): void {
    const quoted = quoteIdent(meta?.kind ?? "", table);
    openInQueryEditor(`SELECT * FROM ${quoted} LIMIT 100;`);
  }

  function openSqlTab(sql: string, title: string): void {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      return;
    }
    const current = tabsOf(conn);
    if (current === null) {
      return;
    }
    const tab: WorkbenchTab = { ...createQueryTab(nextSeq(), sql), title };
    setTabsFor(conn, { tabs: [...current.tabs, tab], activeId: tab.id });
    store.showSnapshot(conn, snapshotOf(tab));
    focusRequestRef.current = true;
  }

  function activateNewTab(conn: string, tab: WorkbenchTab): void {
    const current = tabsOf(conn);
    if (current === null) {
      return;
    }
    const next: TabsState = { tabs: [...current.tabs, tab], activeId: tab.id };
    setTabsFor(conn, next);
    store.showSnapshot(conn, snapshotOf(tab));
  }

  function openDataTab(table: string, options?: { view?: TableView; newTab?: boolean }): void {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      return;
    }
    const current = tabsOf(conn);
    if (current === null) {
      return;
    }
    const existing = options?.newTab
      ? undefined
      : current.tabs.find((tab): tab is DataTab => tab.kind === "data" && tab.table === table);
    if (existing) {
      if (options?.view !== undefined && (existing.view ?? "data") !== options.view) {
        setTabsFor(conn, patchTab(current, existing.id, { view: options.view }));
        if (options.view !== "data") {
          void ensureDetail(conn, table);
        }
      }
      activate(existing.id);
      return;
    }
    const created = createDataTab(table, undefined, meta?.kind ?? "postgres");
    const tab: DataTab = options?.view !== undefined ? { ...created, view: options.view } : created;
    const next: TabsState = { tabs: [...current.tabs, tab], activeId: tab.id };
    setTabsFor(conn, next);
    store.showSnapshot(conn, snapshotOf(tab));
    void ensureDetail(conn, table).then((detail) => {
      if (detail !== null) {
        const latestDetail = tabsOf(conn);
        const targetDetail = latestDetail !== null ? tabById(latestDetail, tab.id) : null;
        if (latestDetail !== null && targetDetail !== null && targetDetail.kind === "data") {
          setTabsFor(conn, patchTab(latestDetail, tab.id, { detail }));
        }
      }
      if ((options?.view ?? "data") !== "data") {
        return;
      }
      const latest = tabsOf(conn);
      const target = latest !== null ? tabById(latest, tab.id) : null;
      if (target === null || target.kind !== "data") {
        return;
      }
      runDataWith(conn, target, {
        offset: 0,
        pageSize: target.pageSize,
        filter: null,
        sorts: null,
      });
    });
  }

  function openOverviewTab(): void {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      return;
    }
    const current = tabsOf(conn);
    if (current === null) {
      return;
    }
    const existing = current.tabs.find((tab) => tab.kind === "overview");
    if (existing) {
      activate(existing.id);
      return;
    }
    activateNewTab(conn, createOverviewTab());
  }

  function setTableView(view: TableView): void {
    const conn = activeConnIdRef.current;
    const tab = currentTab();
    if (conn === null || !tab || tab.kind !== "data") {
      return;
    }
    const current = tabsOf(conn);
    if (current === null || (tab.view ?? "data") === view) {
      return;
    }
    setTabsFor(conn, patchTab(current, tab.id, { view }));
    if (view !== "data") {
      void ensureDetail(conn, tab.table).then((detail) => {
        if (detail === null) {
          return;
        }
        const latest = tabsOf(conn);
        const target = latest !== null ? tabById(latest, tab.id) : null;
        if (latest !== null && target !== null && target.kind === "data") {
          setTabsFor(conn, patchTab(latest, tab.id, { detail }));
        }
      });
    }
  }

  function cycleTableView(delta: -1 | 1): void {
    const tab = currentTab();
    if (!tab || tab.kind !== "data") {
      return;
    }
    const current = tab.view ?? "data";
    const index = TABLE_VIEWS.indexOf(current);
    const nextIndex = (index + delta + TABLE_VIEWS.length) % TABLE_VIEWS.length;
    setTableView(TABLE_VIEWS[nextIndex]);
  }

  async function ensureDetail(conn: string, table: string): Promise<TableDetail | null> {
    const cache = detailCacheRef.current;
    const key = `${conn}:${table}`;
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const detail = await store.fetchTableDetail(conn, table);
      cache.set(key, detail);
      return detail;
    } catch {
      return null;
    }
  }

  function openServerTab(): void {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      return;
    }
    const current = tabsOf(conn);
    if (current === null) {
      return;
    }
    const existing = current.tabs.find((tab) => tab.kind === "server");
    if (existing) {
      activate(existing.id);
      return;
    }
    activateNewTab(conn, createServerTab());
  }

  function openDefinitionTab(obj: DefinitionKind, name: string): void {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      return;
    }
    const current = tabsOf(conn);
    if (current === null) {
      return;
    }
    const existing = current.tabs.find(
      (tab): tab is DefinitionTab =>
        tab.kind === "definition" && tab.obj === obj && tab.name === name,
    );
    if (existing) {
      activate(existing.id);
      return;
    }
    activateNewTab(conn, createDefinitionTab(obj, name));
  }

  function insertDefaultRow(): void {
    const tab = currentTab();
    const result = store.getState().result;
    if (!tab || tab.kind !== "data" || store.getState().status === "running") {
      return;
    }
    if (!result || result.meta.sourceTable === null) {
      store.setInfo(t("행을 추가할 수 없는 결과입니다"));
      return;
    }
    const row = store.stageInsert();
    if (row !== null) {
      gridHostRef.current?.selectCell(row, 0);
    }
  }

  function deleteRows(rows: number[]): void {
    const result = store.getState().result;
    if (!result || result.meta.sourceTable === null || rows.length === 0) {
      return;
    }
    const outcome = store.stageDelete(rows);
    if (outcome !== null && outcome.skipped > 0) {
      store.setInfo(
        t("{count}개 행은 기본 키가 없거나 아직 로드되지 않아 삭제 대상에서 제외했습니다", {
          count: outcome.skipped,
        }),
      );
    }
  }

  async function duplicateRowAt(row: number): Promise<void> {
    const result = store.getState().result;
    if (!result || result.meta.sourceTable === null) {
      return;
    }
    const values = await rowValues(result.source, row);
    const pkNames = new Set(result.meta.pk ?? []);
    const fromInsert = result.source.isInserted(row);
    const staged = new Map<number, string | null>();
    result.meta.columns.forEach((column, index) => {
      // Columns still at DEFAULT on a staged row stay DEFAULT on the copy.
      const untouched = fromInsert && result.source.cellState(row, index) === "default";
      if (!pkNames.has(column) && !untouched) {
        staged.set(index, cellToString(values[index]));
      }
    });
    const created = store.stageInsert(staged);
    if (created !== null) {
      gridHostRef.current?.selectCell(created, 0);
    }
  }

  async function applyChanges(): Promise<void> {
    const editor = document.activeElement;
    if (editor instanceof HTMLInputElement && editor.classList.contains("cell-editor")) {
      // Commit an open cell edit first so ⌘S includes it.
      editor.blur();
    }
    const conn = activeConnIdRef.current;
    const result = store.getState().result;
    if (
      conn === null ||
      result === null ||
      applyingRef.current ||
      store.getState().status === "running" ||
      !result.source.hasPending()
    ) {
      return;
    }
    if (alertMode === 2) {
      const summary = result.source.pendingSummary();
      const ok = window.confirm(
        t("변경 {count}건을 데이터베이스에 적용할까요?\n수정 {edits} · 추가 {inserts} · 삭제 {deletes}", {
          count: summary.total,
          edits: summary.edits,
          inserts: summary.inserts,
          deletes: summary.deletes,
        }),
      );
      if (!ok) {
        return;
      }
    }
    const tabId = tabsOf(conn)?.activeId ?? null;
    applyingRef.current = true;
    setApplying(true);
    try {
      const outcome = await store.applyPending(result);
      if (outcome === null) {
        return;
      }
      const latest = tabsOf(conn);
      const tab = latest !== null && tabId !== null ? tabById(latest, tabId) : null;
      const sameResult =
        tab !== null && (tab.kind === "data" || tab.kind === "query") && tab.source === result.source;
      const stillActive = activeConnIdRef.current === conn && latest?.activeId === tabId;
      if (sameResult && tab.kind === "data") {
        if (stillActive) {
          gridHostRef.current?.keepViewOnNextResult();
        }
        runDataWith(conn, tab, dataSpecOf(tab, tab.offset, tab.pageSize));
      } else if (sameResult && tab.kind === "query" && outcome.structural) {
        if (stillActive) {
          gridHostRef.current?.keepViewOnNextResult();
        }
        setRunningTabId(tab.id);
        void store.runQuery(conn, result.sql, maxRows, tab.id).then((next) => {
          setRunningTabId(null);
          handleOutcome(conn, tab.id, next);
        });
      } else {
        store.setInfo(t("변경사항을 적용했습니다"));
      }
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  }

  // Server-side invalidation (a structural rollback clears every result session):
  // reload the active data tab; a query tab is not re-run automatically.
  invalidateRef.current = () => {
    if (store.isApplying()) {
      return;
    }
    const conn = activeConnIdRef.current;
    const tab = currentTab();
    if (conn === null || tab === null || (tab.kind !== "data" && tab.kind !== "query")) {
      return;
    }
    if (tab.kind === "query" || tab.source?.hasPending()) {
      if (tab.source) {
        store.setInfo(t("결과가 만료되었습니다. 다시 실행하세요"));
      }
      return;
    }
    gridHostRef.current?.keepViewOnNextResult();
    runDataWith(conn, tab, dataSpecOf(tab, tab.offset, tab.pageSize));
  };

  function cycleTab(delta: 1 | -1): void {
    const conn = activeConnIdRef.current;
    const current = conn !== null ? tabsOf(conn) : null;
    if (current === null || current.tabs.length < 2) {
      return;
    }
    const index = current.tabs.findIndex((tab) => tab.id === current.activeId);
    const next = current.tabs[(index + delta + current.tabs.length) % current.tabs.length];
    activate(next.id);
  }

  function toggleDetailPanel(): void {
    if (detailRowRef.current !== null) {
      setDetailRow(null);
    } else if (store.getState().result !== null && resultView === "grid") {
      openRowDetail(lastSelectedRowRef.current ?? 0);
    }
  }

  shortcutRef.current = (action) => {
    const inWorkspace = activeConnIdRef.current !== null;
    switch (action) {
      case "palette":
        setPaletteOpen(true);
        return;
      case "openSettings":
        setSettingsOpen(true);
        return;
      case "refresh":
        void refreshActiveMeta();
        return;
      default:
        break;
    }
    if (!inWorkspace) {
      return;
    }
    switch (action) {
      case "run":
        run();
        return;
      case "applyChanges":
        // The structure editor saves its own changes on ⌘S.
        if (activeTab?.kind === "query" || dataView) {
          void applyChanges();
        }
        return;
      case "newTab":
        createNewTab();
        return;
      case "closeTab": {
        const activeId = tabsRefActive();
        if (activeId !== null) {
          closeTabById(activeId);
        }
        return;
      }
      case "nextTab":
        cycleTab(1);
        return;
      case "prevTab":
        cycleTab(-1);
        return;
      case "toggleSidebar":
        setSchemaOpen((value) => !value);
        return;
      case "toggleDetail":
        toggleDetailPanel();
        return;
      case "dbSwitch":
        if (serverConnRef.current) {
          void openDbMenu(window.innerWidth / 2 - 110, 92);
        } else {
          editorRef.current?.focus();
        }
        return;
    }
  };

  function discardChanges(): void {
    store.getState().result?.source.discardPending();
  }

  async function fkJump(row: number, col: number): Promise<void> {
    const conn = activeConnIdRef.current;
    const tab = currentTab();
    const result = store.getState().result;
    if (conn === null || !result) {
      return;
    }
    const sourceTable = tab?.kind === "data" ? tab.table : result.meta.sourceTable;
    if (sourceTable === null) {
      return;
    }
    const column = result.meta.columns[col];
    if (column === undefined) {
      return;
    }
    const detail = await ensureDetail(conn, sourceTable);
    const fk = detail?.foreign_keys.find((entry) => entry.columns.includes(column));
    if (!fk) {
      store.setInfo("외래 키 컬럼이 아닙니다");
      return;
    }
    const value = result.source.cell(row, col);
    const index = fk.columns.indexOf(column);
    const refColumn = fk.ref_columns[index] ?? fk.ref_columns[0];
    const filter = fkFilterFor(refColumn, value);
    if (filter === null) {
      store.setInfo("NULL 값은 참조 행이 없습니다");
      return;
    }
    openDataTabFiltered(fk.ref_table, filter);
  }

  function openDataTabFiltered(table: string, filter: FilterState): void {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      return;
    }
    const current = tabsOf(conn);
    if (current === null) {
      return;
    }
    const existing = current.tabs.find(
      (tab): tab is DataTab => tab.kind === "data" && tab.table === table,
    );
    if (existing) {
      runDataWith(conn, existing, {
        offset: 0,
        pageSize: existing.pageSize,
        filter,
        sorts: existing.sorts ?? null,
      });
      activate(existing.id);
      return;
    }
    const tab: DataTab = { ...createDataTab(table, undefined, meta?.kind ?? "postgres"), filter };
    activateNewTab(conn, tab);
    runDataWith(conn, tab, { offset: 0, pageSize: tab.pageSize, filter, sorts: null });
  }

  function explain(): void {
    const conn = activeConnIdRef.current;
    const tab = currentTab();
    if (conn === null || !tab || store.getState().status === "running") {
      return;
    }
    let sqlText: string;
    if (tab.kind === "query") {
      sqlText = (editorRef.current?.getSql() ?? tab.sql).trim();
    } else if (tab.kind === "data") {
      sqlText = tab.sql.trim();
    } else {
      return;
    }
    if (sqlText === "" || isExplainSql(sqlText)) {
      return;
    }
    const prefix = explainPrefixFor(meta?.kind ?? "");
    if (prefix === null) {
      store.setInfo("이 드라이버는 실행 계획 보기를 지원하지 않습니다");
      return;
    }
    const planSql = planSqlFor(sqlText, prefix);
    const planTab = { ...createQueryTab(nextSeq()), title: `실행 계획 — ${tab.title}`, sql: planSql };
    activateNewTab(conn, planTab);
    focusRequestRef.current = true;
    setRunningTabId(planTab.id);
    void store.runQuery(conn, planSql, maxRows, planTab.id).then((outcome) => {
      setRunningTabId(null);
      handleOutcome(conn, planTab.id, outcome);
    });
  }

  function snippetItems(): ContextMenuItem[] {
    const tab = currentTab();
    const table =
      tab && tab.kind === "data" ? tab.table : (meta?.tables[0] ?? "table");
    const prefix = explainPrefixFor(meta?.kind ?? "") ?? "EXPLAIN ";
    return [
      { label: "SQL 정리 (Beautify)", onSelect: () => formatCurrent("beautify") },
      { label: "SQL 축약 (Minify)", onSelect: () => formatCurrent("minify") },
      ...snippetList(table, prefix, meta?.kind ?? "postgres").map((snippet, index) => ({
        label: snippet.name,
        separatorBefore: index === 0,
        onSelect: () => pickSql(snippet.sql),
      })),
    ];
  }

  async function openDbMenu(x: number, y: number): Promise<void> {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      return;
    }
    try {
      const databases = await store.fetchDatabases(conn);
      if (databases.length === 0) {
        store.setInfo("이 연결은 데이터베이스 전환을 지원하지 않습니다");
        return;
      }
      setDbMenu({ x, y, databases });
    } catch (err) {
      store.setError(errorOf(err, "데이터베이스 목록을 불러오지 못했습니다"));
    }
  }

  async function switchToDatabase(database: string): Promise<void> {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      return;
    }
    setDbMenu(null);
    const staged = workspacesRef.current[conn]?.tabs.tabs ?? [];
    const pending = pendingTotal(staged);
    if (pending > 0) {
      if (
        !window.confirm(
          t("적용하지 않은 변경 {count}건이 있습니다. 버리고 계속할까요?", { count: pending }),
        )
      ) {
        return;
      }
      discardAllPending(staged);
    }
    try {
      const live = await store.switchDatabase(conn, database);
      const ws = workspacesRef.current[conn];
      if (ws !== undefined) {
        commitWorkspaces({
          ...workspacesRef.current,
          [conn]: { ...ws, meta: live.meta },
        });
        const tab = activeTabOf(ws.tabs);
        store.activate(conn, live.meta, tab ? snapshotOf(tab) : null, ws.tx);
      }
      detailCacheRef.current = new Map();
      setMetaNonce((value) => value + 1);
      store.setInfo(`데이터베이스: ${database}`);
    } catch (err) {
      store.setError(errorOf(err, "데이터베이스를 전환하지 못했습니다"));
    }
  }

  function currentDatabase(): string | null {
    if (meta?.path === null || meta?.path === undefined) {
      return null;
    }
    const parts = meta.path.split("/");
    return parts.length > 1 ? (parts[parts.length - 1] || null) : null;
  }

  async function createDatabase(): Promise<void> {
    const conn = activeConnIdRef.current;
    const kind = meta?.kind ?? "";
    if (conn === null || !serverConn) {
      return;
    }
    const name = window.prompt("새 데이터베이스 이름", "");
    const trimmed = name?.trim() ?? "";
    if (trimmed === "") {
      return;
    }
    setDbMenu(null);
    try {
      await store.exec(conn, `CREATE DATABASE ${quoteIdent(kind, trimmed)}`);
      store.setInfo(`데이터베이스 생성됨: ${trimmed}`);
    } catch (err) {
      store.setError(errorOf(err, "데이터베이스를 만들지 못했습니다"));
    }
  }

  async function dropDatabase(): Promise<void> {
    const conn = activeConnIdRef.current;
    const kind = meta?.kind ?? "";
    if (conn === null || !serverConn) {
      return;
    }
    const name = window.prompt("삭제할 데이터베이스 이름", "");
    const trimmed = name?.trim() ?? "";
    if (trimmed === "") {
      return;
    }
    if (trimmed === currentDatabase()) {
      store.setError("현재 사용 중인 데이터베이스는 삭제할 수 없습니다");
      return;
    }
    if (!window.confirm(`데이터베이스 "${trimmed}"를 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) {
      return;
    }
    setDbMenu(null);
    try {
      await store.exec(conn, `DROP DATABASE ${quoteIdent(kind, trimmed)}`);
      store.setInfo(`데이터베이스 삭제됨: ${trimmed}`);
    } catch (err) {
      store.setError(errorOf(err, "데이터베이스를 삭제하지 못했습니다"));
    }
  }

  function togglePin(table: string): void {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      return;
    }
    setPinnedTables((prev) => {
      const list = prev[conn] ?? [];
      const next = list.includes(table)
        ? list.filter((entry) => entry !== table)
        : [...list, table];
      return { ...prev, [conn]: next };
    });
  }

  async function tableAction(action: TableAction, table: string): Promise<void> {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      return;
    }
    const kind = meta?.kind ?? "";
    const quoted = quoteIdent(meta?.kind ?? "", table);
    if (action === "copyDrop") {
      await writeClipboard(dropTableSql(kind, table));
      return;
    }
    if (action === "copyTruncate") {
      await writeClipboard(`${truncateTableSql(kind, table)};`);
      return;
    }
    if (action === "import") {
      setImportTarget({ kind, table });
      return;
    }
    if (action === "rename") {
      const name = window.prompt("새 테이블 이름", table);
      if (name === null) {
        return;
      }
      const nextName = name.trim();
      if (nextName === "" || nextName === table) {
        store.setInfo("테이블 이름을 확인하세요");
        return;
      }
      try {
        await store.exec(conn, renameTableSql(kind, table, nextName));
        store.setInfo(`테이블 이름을 변경했습니다: ${table} → ${nextName}`);
        const current = tabsOf(conn);
        if (current !== null) {
          let next = current;
          for (const tab of current.tabs) {
            if (tab.kind === "data" && tab.table === table) {
              next = patchTab(next, tab.id, {
                table: nextName,
                title: nextName,
                meta: tab.meta === undefined ? undefined : { ...tab.meta, sourceTable: nextName },
                detail: undefined,
              });
            }
          }
          if (next !== current) {
            setTabsFor(conn, next);
          }
        }
        detailCacheRef.current = new Map();
        setMetaNonce((value) => value + 1);
      } catch (err) {
        store.setError(errorOf(err, "테이블 이름을 변경하지 못했습니다"));
      }
      return;
    }
    if (action === "copyCreate") {
      const detail = await ensureDetail(conn, table);
      if (detail?.ddl) {
        await writeClipboard(detail.ddl);
      } else {
        store.setInfo("DDL을 가져올 수 없습니다");
      }
      return;
    }
    if (action === "copySelect") {
      const detail = await ensureDetail(conn, table);
      const columns = detail?.columns.map((column) => column.name) ?? null;
      await writeClipboard(`SELECT ${selectList(columns, kind)} FROM ${quoted} LIMIT 100;`);
      return;
    }
    if (action === "copyLaravel") {
      const detail = await ensureDetail(conn, table);
      if (detail === null) {
        store.setInfo("테이블 정보를 가져올 수 없습니다");
        return;
      }
      await writeClipboard(laravelSchemaScript(detail, kind));
      store.setInfo("Laravel 스키마 코드를 복사했습니다");
      return;
    }
    if (action === "duplicate") {
      const name = window.prompt("복제할 테이블 이름", `${table.replace(/\./g, "_")}_copy`);
      if (name === null) {
        return;
      }
      const target = name.trim();
      if (target === "" || target === table) {
        store.setInfo("테이블 이름을 확인하세요");
        return;
      }
      const targetQuoted = quoteIdent(kind, target);
      const sql =
        kind === "mssql"
          ? `SELECT * INTO ${targetQuoted} FROM ${quoted};`
          : `CREATE TABLE ${targetQuoted} AS SELECT * FROM ${quoted};`;
      try {
        await store.exec(conn, sql);
        store.setInfo(`테이블을 복제했습니다: ${target}`);
        await refreshActiveMeta();
      } catch (err) {
        store.setError(errorOf(err, "테이블을 복제하지 못했습니다"));
      }
      return;
    }
    if (action === "truncate") {
      if (!window.confirm(`${table} 테이블의 모든 행을 삭제할까요?`)) {
        return;
      }
      const sql = kind === "sqlite" ? `DELETE FROM ${quoted};` : `TRUNCATE TABLE ${quoted};`;
      try {
        await store.exec(conn, sql);
        store.setInfo(`테이블을 비웠습니다: ${table}`);
        const ws = workspacesRef.current[conn];
        const tab = ws !== undefined ? activeTabOf(ws.tabs) : null;
        if (ws !== undefined && tab !== null && tab.kind === "data" && tab.table === table) {
          runDataWith(conn, tab, dataSpecOf(tab, 0, tab.pageSize));
        }
      } catch (err) {
        store.setError(errorOf(err, "테이블을 비우지 못했습니다"));
      }
      return;
    }
    if (action === "delete") {
      if (!window.confirm(`테이블 ${table}을(를) 삭제하면 되돌릴 수 없습니다. 삭제할까요?`)) {
        return;
      }
      const sql = `DROP TABLE ${quoted};`;
      try {
        await store.exec(conn, sql);
        store.setInfo(`테이블을 삭제했습니다: ${table}`);
        const current = tabsOf(conn);
        if (current !== null) {
          const doomed = current.tabs.filter(
            (tab) => tab.kind === "data" && tab.table === table,
          );
          for (const tab of doomed) {
            closeTabById(tab.id);
          }
        }
        await refreshActiveMeta();
      } catch (err) {
        store.setError(errorOf(err, "테이블을 삭제하지 못했습니다"));
      }
    }
  }

  async function refreshActiveMeta(): Promise<void> {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      try {
        setConns(await store.listConns());
      } catch (err) {
        store.setError(errorOf(err, "연결 목록을 불러오지 못했습니다"));
      }
      return;
    }
    try {
      const nextMeta = await store.refreshMeta(conn);
      const ws = workspacesRef.current[conn];
      if (ws === undefined) {
        return;
      }
      const next: Workspace = { ...ws, meta: nextMeta };
      commitWorkspaces({ ...workspacesRef.current, [conn]: next });
      const tab = activeTabOf(next.tabs);
      store.activate(conn, nextMeta, tab ? snapshotOf(tab) : null, next.tx);
    } catch (err) {
      store.setError(errorOf(err, "메타를 새로고침하지 못했습니다"));
    }
  }

  async function afterOpen(live: LiveConn): Promise<void> {
    try {
      setConns(await store.listConns());
    } catch {
      setConns((prev) => prev);
    }
    enterFresh(live);
  }

  function enterFresh(live: LiveConn): void {
    if (workspacesRef.current[live.conn] === undefined) {
      const fresh = createQueryTab(nextSeq(), seedSqlForMeta(live.meta));
      const ws: Workspace = {
        tabs: { tabs: [fresh], activeId: fresh.id },
        meta: live.meta,
        tx: "none",
      };
      commitWorkspaces({ ...workspacesRef.current, [live.conn]: ws });
    }
    setActiveConnId(live.conn);
  }

  // Resolves false when the connection could not be entered.
  async function enterConn(id: string): Promise<boolean> {
    if (workspacesRef.current[id] !== undefined) {
      setActiveConnId(id);
      return true;
    }
    try {
      const nextMeta = await store.refreshMeta(id);
      const fresh = createQueryTab(nextSeq(), seedSqlForMeta(nextMeta));
      const ws: Workspace = {
        tabs: { tabs: [fresh], activeId: fresh.id },
        meta: nextMeta,
        tx: "none",
      };
      commitWorkspaces({ ...workspacesRef.current, [id]: ws });
      setActiveConnId(id);
      return true;
    } catch (err) {
      store.setError(errorOf(err, "연결에 들어가지 못했습니다"));
      try {
        setConns(await store.listConns());
      } catch {}
      return false;
    }
  }

  function goHome(): void {
    setActiveConnId(null);
  }

  function openNewWindow(id: string): void {
    window.open(`/?conn=${encodeURIComponent(id)}`, "_blank");
  }

  async function openDemo(): Promise<void> {
    const existing = conns.find((conn) => conn.demo);
    if (existing !== undefined) {
      await enterConn(existing.id);
      return;
    }
    try {
      const live = await store.openDb(null);
      await afterOpen(live);
    } catch (err) {
      store.setError(errorOf(err, "데모를 열지 못했습니다"));
    }
  }

  async function openPathFile(path: string): Promise<void> {
    const existing = conns.find((conn) => conn.path === path);
    if (existing !== undefined) {
      await enterConn(existing.id);
      return;
    }
    try {
      const live = await store.openDb(path);
      await afterOpen(live);
    } catch (err) {
      store.setError(errorOf(err, "파일을 열지 못했습니다"));
    }
  }

  // "asking": a secret isn't stored and the connection dialog now asks for it.
  async function connectSavedById(id: string): Promise<"entered" | "asking" | "failed"> {
    const existing = conns.find((conn) => conn.saved_id === id);
    if (existing !== undefined) {
      return (await enterConn(existing.id)) ? "entered" : "failed";
    }
    setBusySaved(id);
    try {
      const live = await store.connectSaved(id);
      await afterOpen(live);
      return "entered";
    } catch (err) {
      // A secret isn't stored: ask for it in the connection dialog instead of failing.
      const missing = missingSecretOf(err);
      const saved =
        missing !== null
          ? (await store.listConnections().catch(() => [])).find((entry) => entry.id === id)
          : undefined;
      if (missing !== null && saved !== undefined) {
        openConnectionEditor(saved, errorOf(err, t("비밀번호를 입력하세요")), missing);
        return "asking";
      }
      store.setError(errorOf(err, "연결에 실패했습니다"));
      return "failed";
    } finally {
      setBusySaved(null);
    }
  }

  function openConnectionEditor(
    saved: SavedConnection | null,
    notice: string | null = null,
    missingSecret: MissingSecret | null = null,
  ): void {
    setConnectEditing(saved === null ? null : { saved, notice, missingSecret });
    setNewConnOptions(null);
    setConnectOpen(true);
  }

  function openNewConnection(options?: NewConnectionOptions): void {
    setConnectEditing(null);
    setNewConnOptions(options ?? null);
    setConnectOpen(true);
  }

  // Backup/restore from home: pick a connection, open it, then the dump window
  // opens once its workspace is ready (see the pendingDump effect).
  async function startBackupOrRestore(kind: "backup" | "restore"): Promise<void> {
    const saved = await store.listConnections().catch(() => []);
    setDumpPicker({ kind, saved });
  }

  async function pickForDump(target: PickTarget): Promise<void> {
    if (dumpPicker === null) {
      return;
    }
    const kind = dumpPicker.kind;
    setDumpPicker(null);
    pendingDumpRef.current = { target, kind };
    const outcome =
      target.connId !== undefined
        ? (await enterConn(target.connId))
          ? "entered"
          : "failed"
        : target.savedId !== undefined
          ? await connectSavedById(target.savedId)
          : "failed";
    // A failed open must not leave the dump window waiting for a later visit.
    if (outcome === "failed" && pendingDumpRef.current?.target === target) {
      pendingDumpRef.current = null;
    }
  }

  function closeConnectionDialog(): void {
    setConnectOpen(false);
    setConnectEditing(null);
  }

  async function closeConn(id: string): Promise<void> {
    const summary = conns.find((conn) => conn.id === id);
    if (summary?.is_default) {
      store.setError("기본 연결은 닫을 수 없습니다");
      return;
    }
    const ws = workspacesRef.current[id];
    if (ws !== undefined) {
      const pending = pendingTotal(ws.tabs.tabs);
      if (
        pending > 0 &&
        !window.confirm(t("적용하지 않은 변경 {count}건이 있습니다. 버리고 계속할까요?", { count: pending }))
      ) {
        return;
      }
      if (runningTabRef.current !== null && tabById(ws.tabs, runningTabRef.current) !== null) {
        closedDuringRunRef.current = runningTabRef.current;
        store.cancelQuery(id);
        setRunningTabId(null);
      }
      for (const tab of ws.tabs.tabs) {
        if (tab.kind === "query" || tab.kind === "data") {
          tab.source?.dispose();
        }
      }
      const next = { ...workspacesRef.current };
      delete next[id];
      commitWorkspaces(next);
    }
    if (activeConnIdRef.current === id) {
      setActiveConnId(null);
    }
    forgetSchema(id);
    try {
      await store.closeConn(id);
    } catch (err) {
      store.setError(errorOf(err, "연결을 닫지 못했습니다"));
    }
    try {
      setConns(await store.listConns());
    } catch {}
  }

  function paletteActions(): PaletteAction[] {
    const result = store.getState().result;
    const active = currentTab();
    return [
      { id: "new-tab", label: t("새 쿼리 탭"), hint: shortcutHint(settings.keymap, "newTab"), run: createNewTab },
      { id: "home", label: t("연결 홈"), run: goHome },
      { id: "open-tables", label: t("테이블 데이터 열기"), sourceId: "tables" },
      { id: "open-views", label: t("뷰 열기"), sourceId: "views" },
      { id: "open-structure", label: t("테이블 구조 보기"), sourceId: "structure" },
      { id: "server-info", label: t("서버 정보"), run: openServerTab },
      { id: "export", label: t("결과 내보내기"), disabled: result === null, run: openExport },
      { id: "refresh-meta", label: t("메타 새로고침"), hint: shortcutHint(settings.keymap, "refresh"), run: () => void refreshActiveMeta() },
      {
        id: "alert-mode",
        label: t("안전 모드 바꾸기 (끔 → 위험만 → 모든 변경)"),
        hint: t(SAFE_MODE_LABELS[alertMode].title),
        run: cycleAlertMode,
      },
      {
        id: "format-beautify",
        label: t("SQL 정리 (Beautify)"),
        disabled: active === null || active.kind !== "query",
        run: () => formatCurrent("beautify"),
      },
      {
        id: "format-minify",
        label: t("SQL 축약 (Minify)"),
        disabled: active === null || active.kind !== "query",
        run: () => formatCurrent("minify"),
      },
      {
        id: "split-side",
        label: splitSide === "right" ? t("결과 패널을 아래로") : t("결과 패널을 오른쪽으로"),
        run: () => setSplitSide((value) => (value === "right" ? "bottom" : "right")),
      },
      {
        id: "close-tab",
        label: t("현재 탭 닫기"),
        hint: shortcutHint(settings.keymap, "closeTab"),
        disabled: active === null,
        run: () => {
          const current = tabsRefActive();
          if (current !== null) {
            closeTabById(current);
          }
        },
      },
      { id: "open-file", label: t("SQLite 파일 열기"), run: () => setFsOpen(true) },
      { id: "create-table", label: t("새 테이블 생성"), run: () => setCreateTableOpen(true) },
      {
        id: "import-data",
        label: t("데이터 가져오기"),
        disabled: active === null || active.kind !== "data",
        run: () => {
          if (active !== null && active.kind === "data") {
            setImportTarget({ kind: meta?.kind ?? "", table: active.table });
          }
        },
      },
      {
        id: "dump-backup",
        label: t("백업 (SQL 덤프)"),
        disabled: meta === null,
        run: () => setDumpTab("backup"),
      },
      {
        id: "dump-restore",
        label: t("복원 (SQL 실행)"),
        disabled: meta === null,
        run: () => setDumpTab("restore"),
      },
      {
        id: "jobs",
        label: t("작업 큐"),
        hint: jobsRunning > 0 ? t("{count} 진행 중", { count: jobsRunning }) : undefined,
        run: () => setJobsOpen(true),
      },
      {
        id: "user-manager",
        label: t("사용자 관리"),
        disabled: (meta?.kind ?? "sqlite") === "sqlite",
        run: () => setUserMgrOpen(true),
      },
      { id: "settings", label: t("설정"), run: () => setSettingsOpen(true) },
      { id: "console-log", label: t("콘솔 로그"), hint: t("쿼리 실행 기록"), run: () => setLogOpen(true) },
      { id: "activity", label: "Activity", hint: t("작업 로그"), run: () => setActivityOpen(true) },
      { id: "metrics", label: "Metrics", hint: t("쿼리 지표"), run: () => setMetricsOpen(true) },
      ...(getPasscodeHash() !== null
        ? [{ id: "lock", label: t("지금 잠금"), run: () => setLocked(true) }]
        : []),
      { id: "connect", label: t("서버 연결"), run: () => openConnectionEditor(null) },
      { id: "demo", label: t("데모 열기"), run: () => void openDemo() },
      { id: "history", label: t("실행 기록"), sourceId: "history" },
      { id: "favorites", label: t("즐겨찾기"), sourceId: "favorites" },
      { id: "drafts", label: t("초안 복구"), sourceId: "drafts" },
    ];
  }

  function tabsRefActive(): string | null {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      return null;
    }
    return tabsOf(conn)?.activeId ?? null;
  }

  function paletteSources(): PaletteSource[] {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      return [];
    }
    return [
      {
        id: "tables",
        title: t("테이블"),
        load: async () =>
          (meta?.tables ?? []).map((name) => ({
            label: name,
            run: () => openDataTab(name),
          })),
      },
      {
        id: "views",
        title: t("뷰"),
        load: async () => {
          const objects = await store.fetchObjects(conn);
          return objects.views.map((name) => ({
            label: name,
            run: () => openDataTab(name),
          }));
        },
      },
      {
        id: "structure",
        title: t("구조"),
        load: async () =>
          (meta?.tables ?? []).map((name) => ({
            label: t("{name} 구조", { name }),
            run: () => openDataTab(name, { view: "structure" }),
          })),
      },
      {
        id: "history",
        title: t("기록"),
        load: async () => {
          const history = await store.fetchHistory(50);
          return history.map((entry) => ({
            label: entry.sql,
            run: () => pickSql(entry.sql),
          }));
        },
      },
      {
        id: "favorites",
        title: t("즐겨찾기"),
        load: async () => {
          const favorites = await store.fetchFavorites();
          return favorites.map((favorite) => ({
            label: favorite.name,
            hint: favorite.keyword ? `:${favorite.keyword} · ${favorite.sql}` : favorite.sql,
            run: () => pickSql(favorite.sql),
          }));
        },
      },
      {
        id: "drafts",
        title: t("초안"),
        load: async () => {
          const conn = activeConnIdRef.current;
          if (conn === null) {
            return [];
          }
          const open = new Set((tabsOf(conn)?.tabs ?? []).map((tab) => tab.id));
          return listDrafts(conn)
            .filter((entry) => !open.has(entry.tabId))
            .map((entry) => ({
              label: entry.draft.title,
              hint: entry.draft.sql,
              run: () => openDraftTab(entry.tabId, entry.draft.sql, entry.draft.title),
            }));
        },
      },
    ];
  }

  function handleHeaderClick(columnIndex: number, event: { shiftKey: boolean }): void {
    const conn = activeConnIdRef.current;
    const tab = currentTab();
    if (conn === null || !tab || tab.kind !== "data" || !tab.meta) {
      return;
    }
    const column = tab.meta.columns[columnIndex];
    if (column === undefined) {
      return;
    }
    const sorts = cycleSort(tab.sorts ?? [], column, event.shiftKey);
    runDataWith(conn, tab, { offset: 0, pageSize: tab.pageSize, filter: tab.filter ?? null, sorts });
  }

  function openCellQuickLook(row: number, col: number): void {
    setDetailRow(null);
    setCellQuickLook({ row, col });
  }

  function openRowDetail(row: number): void {
    setCellQuickLook(null);
    setDetailRow(row);
  }

  function handleSelectionChange(row: number | null): void {
    if (row !== null) {
      lastSelectedRowRef.current = row;
    }
    if (row !== null && detailRowRef.current !== null) {
      setDetailRow(row);
    }
  }

  function handleCellContextMenu(row: number, col: number, x: number, y: number): void {
    if (state.result === null) {
      return;
    }
    const conn = activeConnIdRef.current;
    const tab = currentTab();
    if (conn !== null && tab && tab.kind === "data") {
      void ensureDetail(conn, tab.table);
    }
    setMenu({ row, col, x, y });
  }

  function menuItems(menuState: MenuState): ContextMenuItem[] {
    const result = state.result;
    if (!result) {
      return [];
    }
    const source = result.source;
    const keyed =
      result.meta.sourceTable !== null && result.meta.pk !== null && result.meta.pk.length > 0;
    const inserted = source.isInserted(menuState.row);
    const deleted = source.isDeleted(menuState.row);
    const canEdit = result.meta.sourceTable !== null && (keyed || inserted) && !deleted;
    const value = source.cell(menuState.row, menuState.col);
    const tab = currentTab();
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
        label: t("값을 NULL로 설정"),
        disabled: value === undefined || (value === null && !inserted),
        onSelect: () => {
          void store.editCell(menuState.row, menuState.col, null);
        },
      });
      if (source.cellState(menuState.row, menuState.col) === "edited") {
        items.push({
          label: t("변경 되돌리기"),
          onSelect: () => source.revertCell(menuState.row, menuState.col),
        });
      }
    }
    items.push({
      label: "Quick Look",
      onSelect: () => openCellQuickLook(menuState.row, menuState.col),
    });
    items.push({
      label: "행 상세 보기",
      onSelect: () => openRowDetail(menuState.row),
    });
    if (result.meta.sourceTable !== null) {
      items.push({
        label: t("행 복제"),
        separatorBefore: true,
        onSelect: () => {
          void duplicateRowAt(menuState.row);
        },
      });
      items.push({
        label: inserted ? t("행 추가 취소") : deleted ? t("행 삭제 취소") : t("행 삭제"),
        disabled: !keyed && !inserted,
        onSelect: () => deleteRows([menuState.row]),
      });
    }
    if (tab && tab.kind === "data") {
      const columnName = result.meta.columns[menuState.col];
      const conn = activeConnIdRef.current;
      const cached =
        conn !== null ? detailCacheRef.current.get(`${conn}:${tab.table}`) : undefined;
      const hasFk =
        cached !== undefined &&
        columnName !== undefined &&
        cached.foreign_keys.some((entry) => entry.columns.includes(columnName));
      if (hasFk) {
        items.push({
          label: "참조 행 열기",
          onSelect: () => {
            void fkJump(menuState.row, menuState.col);
          },
        });
      }
    }
    if (table !== null) {
      items.push({
        label: "INSERT 문 복사",
        separatorBefore: true,
        onSelect: () => {
          void (async () => {
            const values = await rowValues(source, menuState.row);
            await writeClipboard(toSqlInserts(table, result.meta.columns, [values], meta?.kind ?? "postgres"));
          })();
        },
      });
      items.push({
        label: "UPDATE 문 복사",
        disabled: !keyed || inserted,
        onSelect: () => {
          void (async () => {
            const values = await rowValues(source, menuState.row);
            const sql = buildUpdateSql(
              table,
              result.meta.columns,
              values,
              result.meta.pk ?? [],
              meta?.kind ?? "postgres",
            );
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
    const conn = activeConnIdRef.current;
    const result = state.result;
    if (!result || conn === null) {
      return;
    }
    setExportTarget({
      conn,
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
    const horizontal = splitSide === "right";
    const start = horizontal ? event.clientX : event.clientY;
    const startSize = editorHeight ?? (horizontal ? rect.width * 0.45 : rect.height * 0.35);
    const onMove = (move: PointerEvent): void => {
      const delta = (horizontal ? move.clientX : move.clientY) - start;
      const next = startSize + delta;
      setEditorHeight(
        horizontal
          ? Math.min(Math.max(next, 180), rect.width - 260)
          : Math.min(Math.max(next, 90), rect.height - 140),
      );
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  useEffect(() => {
    void (async () => {
      const persisted = loadPersisted();
      if (persisted !== null) {
        const entries: Record<string, Workspace> = {};
        for (const [id, value] of Object.entries(persisted.workspaces)) {
          if (
            value !== null &&
            typeof value === "object" &&
            value.tabs !== undefined &&
            Array.isArray(value.tabs.tabs) &&
            value.meta !== undefined
          ) {
            entries[id] = {
              tabs: migrateTabsState(value.tabs),
              meta: value.meta,
              tx: value.tx === "active" ? "active" : "none",
            };
          }
        }
        commitWorkspaces(entries);
        let restoredSeq = 1;
        for (const workspace of Object.values(entries)) {
          for (const tab of workspace.tabs.tabs) {
            const match = /^(?:쿼리|Query) (\d+)$/.exec(tab.title);
            if (match !== null) {
              restoredSeq = Math.max(restoredSeq, Number.parseInt(match[1], 10));
            }
          }
        }
        seqRef.current = Math.max(seqRef.current, restoredSeq + 1);
      }
      let list: ConnSummary[] = [];
      try {
        list = await store.listConns();
        setConns(list);
      } catch (err) {
        store.setError(errorOf(err, "연결 목록을 불러오지 못했습니다"));
      }
      const kept: Record<string, Workspace> = {};
      for (const [id, ws] of Object.entries(workspacesRef.current)) {
        if (list.some((conn) => conn.id === id)) {
          kept[id] = ws;
        }
      }
      commitWorkspaces(kept);
      const params = new URLSearchParams(window.location.search);
      const want = params.get("conn");
      const wantTab = params.get("tab");
      if (want !== null && list.some((conn) => conn.id === want)) {
        if (workspacesRef.current[want] !== undefined) {
          setActiveConnId(want);
        } else {
          await enterConn(want);
        }
        const ws = workspacesRef.current[want];
        if (ws !== undefined && wantTab !== null) {
          const target = tabById(ws.tabs, wantTab);
          if (target !== null) {
            setTabsFor(want, { ...ws.tabs, activeId: target.id });
            store.showSnapshot(want, snapshotOf(target));
          }
        }
      }
      setBooting(false);
    })();
  }, []);

  useEffect(() => {
    if (booting) {
      return;
    }
    const url = new URL(window.location.href);
    const tabId = workspace?.tabs.activeId ?? null;
    if (activeConnId === null) {
      url.searchParams.delete("conn");
      url.searchParams.delete("tab");
    } else {
      url.searchParams.set("conn", activeConnId);
      if (tabId === null || tabId === "") {
        url.searchParams.delete("tab");
      } else {
        url.searchParams.set("tab", tabId);
      }
    }
    const nextUrl = url.toString();
    const navigating = historyNavRef.current;
    historyNavRef.current = false;
    if (nextUrl === window.location.href) {
      historyReadyRef.current = true;
      return;
    }
    if (navigating || !historyReadyRef.current) {
      historyReadyRef.current = true;
      window.history.replaceState(null, "", nextUrl);
      return;
    }
    window.history.pushState(null, "", nextUrl);
  }, [activeConnId, workspace?.tabs.activeId, booting]);

  useEffect(() => {
    function onPopState(): void {
      historyNavRef.current = true;
      const params = new URLSearchParams(window.location.search);
      const conn = params.get("conn");
      const tabId = params.get("tab");
      if (conn === null || workspacesRef.current[conn] === undefined) {
        setActiveConnId(null);
        return;
      }
      setActiveConnId(conn);
      const ws = workspacesRef.current[conn];
      if (tabId !== null) {
        const target = tabById(ws.tabs, tabId);
        if (target !== null) {
          setTabsFor(conn, { ...ws.tabs, activeId: target.id });
          store.showSnapshot(conn, snapshotOf(target));
        }
      }
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (booting) {
      return;
    }
    try {
      const payload: PersistedPayload = { activeConnId, workspaces };
      window.localStorage.setItem(WORKSPACES_KEY, JSON.stringify(payload, persistReplacer));
    } catch {}
  }, [workspaces, activeConnId, booting]);

  cycleViewRef.current = cycleTableView;
  serverConnRef.current = serverConn;

  useEffect(() => {
    saveTableMap(PINNED_KEY, pinnedTables);
  }, [pinnedTables]);

  useEffect(() => {
    if (prevConnRef.current === activeConnId) {
      return;
    }
    prevConnRef.current = activeConnId;
    setResultView("grid");
    setDetailRow(null);
    setCellQuickLook(null);
    setExportTarget(null);
    setMenu(null);
    if (activeConnId === null) {
      store.activate(null, null, null, "none");
      return;
    }
    const ws = workspacesRef.current[activeConnId];
    if (ws === undefined) {
      return;
    }
    const tab = activeTabOf(ws.tabs);
    store.activate(activeConnId, ws.meta, tab ? snapshotOf(tab) : null, ws.tx);
  }, [activeConnId]);

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
  }, [tabs?.activeId]);

  useEffect(() => {
    const tab = tabs !== null ? activeTabOf(tabs) : null;
    if (!tab || tab.kind !== "data") {
      return;
    }
    if (editorRef.current?.getDoc() !== tab.sql) {
      editorRef.current?.setSql(tab.sql);
    }
  }, [tabs]);

  useEffect(() => {
    function modalOpen(): boolean {
      return (
        connectOpenRef.current ||
        fsOpenRef.current ||
        exportTargetRef.current !== null ||
        importTargetRef.current !== null ||
        paramPromptRef.current !== null ||
        reviewPromptRef.current !== null ||
        dumpTabRef.current !== null ||
        jobsOpenRef.current ||
        settingsOpenRef.current ||
        logOpenRef.current ||
        activityOpenRef.current ||
        metricsOpenRef.current ||
        paletteOpenRef.current ||
        lockedRef.current ||
        document.querySelector(".modal-backdrop") !== null
      );
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        // An open dialog owns Escape; don't also close panels behind it.
        if (
          exportTargetRef.current !== null ||
          menuRef.current !== null ||
          document.querySelector(".context-menu, .menu-panel") !== null ||
          modalOpen()
        ) {
          return;
        }
        if (cellQuickLookRef.current !== null) {
          setCellQuickLook(null);
        } else if (detailRowRef.current !== null) {
          setDetailRow(null);
        }
        return;
      }
      if (event.metaKey && event.ctrlKey && (event.key === "[" || event.key === "]")) {
        event.preventDefault();
        if (!modalOpen()) {
          cycleViewRef.current(event.key === "[" ? -1 : 1);
        }
        return;
      }
      const action = actionForEvent(event, settingsRef.current.keymap);
      if (action === null) {
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      // ⌥ types characters on macOS (⌥T → †); text fields keep them. The SQL
      // editor is not a text field here, so ⌥W still closes the tab there.
      if (
        IS_MAC &&
        event.altKey &&
        !event.metaKey &&
        (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
      ) {
        return;
      }
      // While an IME is composing, or a dialog owns the keyboard, the action
      // doesn't run, but the browser's own action (reload, print, save page)
      // must not run behind it either. The dialog still sees the key.
      if (event.isComposing || modalOpen()) {
        if (event.metaKey || event.ctrlKey || /^F\d{1,2}$/.test(event.key)) {
          event.preventDefault();
        }
        return;
      }
      // In the grid ⌘↩ opens Quick Look or commits the cell being edited, and
      // in Quick Look it saves the value.
      if (
        action === "run" &&
        event.key === "Enter" &&
        target?.closest(".grid-host, [data-cell-quicklook]") != null
      ) {
        return;
      }
      // Runs in the capture phase: an app shortcut wins over the browser's
      // default action and over the focused editor's own binding.
      event.preventDefault();
      event.stopPropagation();
      shortcutRef.current(action);
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent): void {
      const pending = Object.values(workspacesRef.current).some(
        (ws) => pendingTotal(ws.tabs.tabs) > 0,
      );
      if (pending) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const canEditResult =
    state.result !== null &&
    state.result.meta.sourceTable !== null &&
    state.result.meta.pk !== null &&
    state.result.meta.pk.length > 0;
  const pendingSummary =
    state.result !== null && state.result.meta.sourceTable !== null
      ? state.result.source.pendingSummary()
      : null;
  // With the footer gone, errors not already shown inline (the home screen,
  // a data grid, the message view) get a dismissible toast.
  const errorInline =
    home ||
    (activeTab !== null &&
      (activeTab.kind === "query" || activeTab.kind === "data") &&
      ((activeTab.kind === "data" && (activeTab.view ?? "data") === "data") ||
        resultView === "message"));

  const messageAvailable = state.error !== null || state.info !== null;
  const planAvailable = state.result !== null && isExplainSql(state.result.sql);
  const detailOpen = resultView === "grid" && detailRow !== null && state.result !== null;
  const detailTable =
    activeDataTab !== null ? activeDataTab.table : state.result?.meta.sourceTable ?? null;

  useEffect(() => {
    if (!detailOpen || activeConnId === null || detailTable === null) {
      setRowDetailInfo(null);
      setRowDetailLoading(false);
      return;
    }
    let alive = true;
    setRowDetailLoading(true);
    void ensureDetail(activeConnId, detailTable)
      .then((detail) => {
        if (alive) {
          setRowDetailInfo(detail);
        }
      })
      .finally(() => {
        if (alive) {
          setRowDetailLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [detailOpen, activeConnId, detailTable]);

  useEffect(() => {
    setCellQuickLook(null);
    setDetailRow(null);
    lastSelectedRowRef.current = null;
  }, [tabs?.activeId]);
  const filterVisible = activeDataTab !== null && (filterOpen[activeDataTab.id] ?? false);
  const connRunning = state.status === "running" && state.connId === activeConnId;
  const autoHydratedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!planAvailable && resultView === "plan") {
      setResultView("grid");
    }
  }, [planAvailable, resultView]);

  useEffect(() => {
    if (
      booting ||
      activeConnId === null ||
      activeDataTab === null ||
      activeDataTab.source !== undefined ||
      activeDataTab.meta === undefined ||
      (activeDataTab.view ?? "data") !== "data" ||
      connRunning
    ) {
      return;
    }
    const key = `${activeConnId}:${activeDataTab.id}`;
    if (autoHydratedRef.current.has(key)) {
      return;
    }
    autoHydratedRef.current.add(key);
    runDataWith(
      activeConnId,
      activeDataTab,
      dataSpecOf(activeDataTab, activeDataTab.offset, activeDataTab.pageSize),
    );
  }, [booting, activeConnId, activeDataTab, connRunning]);

  useEffect(() => {
    if (dataView && resultView !== "grid") {
      setResultView("grid");
    }
  }, [dataView, resultView]);

  if (booting) {
    return (
      <div className="app">
        <header className="appbar">
          <BrandLogo />
          <span className="spacer" />
        </header>
        <div className="home">
          <div className="home-inner">
            <div className="home-loading">{t("불러오는 중…")}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
    <div className="app">
      <header className="appbar">
        <BrandLogo onClick={goHome} />
        <ConnSwitcher
          conns={conns}
          activeId={activeConnId}
          connection={state.connection}
          activeDetail={
            meta !== null
              ? `${meta.kind}${meta.demo ? ` (${t("데모")})` : ""} · ${tTableCount(meta.tables.length)}`
              : null
          }
          onSwitch={(id) => void enterConn(id)}
          onNewConnection={() => openConnectionEditor(null)}
          onClose={(id) => void closeConn(id)}
        />
        <span className="spacer" />
        {!home ? (
          <button
            type="button"
            className="icon-button appbar-icon"
            onClick={() => void refreshActiveMeta()}
            title={`${t("새로고침")} (${shortcutHint(settings.keymap, "refresh")})`}
          >
            <RefreshIcon size={12} />
          </button>
        ) : null}
        <button
          type="button"
          className="icon-button appbar-icon"
          onClick={() => setSettingsOpen(true)}
          title={t("설정")}
        >
          <SettingsIcon size={13} />
          <span className="sr-only">{t("설정")}</span>
        </button>
      </header>
      {home ? (
        <HomeScreen
          conns={conns}
          busySaved={busySaved}
          onOpenConn={(id) => void enterConn(id)}
          onOpenNewWindow={openNewWindow}
          onCloseConn={(id) => void closeConn(id)}
          onOpenFile={() => setFsOpen(true)}
          onNewConnection={openNewConnection}
          onBackupOrRestore={(kind) => void startBackupOrRestore(kind)}
          onConnectSaved={(id) => void connectSavedById(id)}
          onEditConnection={(saved) => openConnectionEditor(saved)}
          savedVersion={savedVersion}
          appError={state.error}
          onDismissAppError={() => store.setError(null)}
        />
      ) : (
        <>
          <div className="toolbar">
            <button
              type="button"
              className="primary run-button"
              disabled={connRunning}
              onClick={run}
              title={`${t("실행")} (${shortcutHint(settings.keymap, "run")})`}
            >
              <PlayIcon size={11} />
              {t("실행")}
            </button>
            {connRunning ? (
              <button type="button" onClick={() => store.cancelQuery()} title={t("정지")}>
                <StopIcon size={11} />
                {t("정지")}
              </button>
            ) : null}
            {activeTab !== null &&
            (activeTab.kind === "query" || activeTab.kind === "data") ? (
              <button
                type="button"
                className="icon-text-button"
                disabled={connRunning}
                onClick={explain}
                title={t("실행 계획")}
              >
                {t("실행 계획")}
              </button>
            ) : null}
            <button
              type="button"
              className="icon-text-button"
              title={t("SQL 스니펫")}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setSnippetMenu({ x: rect.left, y: rect.bottom + 2 });
              }}
            >
              <SnippetIcon size={11} />
              {t("스니펫")}
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={createNewTab}
              title={`${t("새 탭")} (${shortcutHint(settings.keymap, "newTab")})`}
            >
              <PlusIcon size={12} />
            </button>
            <div className="toolbar-right">
              {serverConn ? (
                <button
                  type="button"
                  className="icon-text-button"
                  title={`${t("데이터베이스 전환")} (${shortcutHint(settings.keymap, "dbSwitch")})`}
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    void openDbMenu(rect.left, rect.bottom + 2);
                  }}
                >
                  <DatabaseIcon size={11} />
                </button>
              ) : null}
              <button
                type="button"
                className="icon-button toolbar-icon"
                title={t("작업 큐 (가져오기·내보내기·덤프)")}
                onClick={() => setJobsOpen(true)}
              >
                <JobsIcon size={12} />
                {jobsRunning > 0 ? <span className="toolbar-badge">{jobsRunning}</span> : null}
              </button>
              <button
                type="button"
                className="icon-button toolbar-icon"
                title={t("콘솔 로그 (쿼리 실행 기록)")}
                onClick={() => setLogOpen(true)}
              >
                <LogIcon size={12} />
                <span className="sr-only">{t("로그")}</span>
              </button>
              <label className="max-rows" title={t("최대 행")}>
                {t("최대 행")}
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
              <SafeModeMenu mode={alertMode} onChange={setAlertMode} />
              {pendingSummary !== null && pendingSummary.total > 0 ? (
                <div className="pending-bar" role="status">
                  <span
                    className="pending-count"
                    title={t("수정 {edits} · 추가 {inserts} · 삭제 {deletes}", {
                      edits: pendingSummary.edits,
                      inserts: pendingSummary.inserts,
                      deletes: pendingSummary.deletes,
                    })}
                  >
                    <span className="pending-dot" aria-hidden="true" />
                    {t("변경 {count}건", { count: pendingSummary.total })}
                  </span>
                  <button
                    type="button"
                    className="pending-discard"
                    disabled={applying}
                    onClick={discardChanges}
                    title={t("적용하지 않은 변경사항 버리기")}
                  >
                    {t("버리기")}
                  </button>
                  <button
                    type="button"
                    className="primary pending-apply"
                    disabled={applying || connRunning}
                    onClick={() => void applyChanges()}
                    title={`${t("변경사항 적용")} (${shortcutHint(settings.keymap, "applyChanges")})`}
                  >
                    {applying ? <Spinner size={13} /> : <CheckIcon size={12} />}
                    {t("변경사항 적용")}
                  </button>
                </div>
              ) : null}
              <div className="tx-slot">
                {state.tx === "active" ? (
                  <>
                    <span className="tx-badge" title={t("트랜잭션 진행 중")}>
                      TX
                    </span>
                    <button
                      type="button"
                      disabled={connRunning}
                      onClick={() => void store.commitTx()}
                      title={t("커밋")}
                    >
                      {t("커밋")}
                    </button>
                    <button
                      type="button"
                      disabled={connRunning}
                      onClick={() => void store.rollbackTx()}
                      title={t("롤백")}
                    >
                      {t("롤백")}
                    </button>
                  </>
                ) : null}
                {canEditResult && state.tx !== "active" ? (
                  <button
                    type="button"
                    disabled={connRunning}
                    onClick={() => void store.beginTx()}
                    title={t("트랜잭션 시작")}
                  >
                    {t("트랜잭션 시작")}
                  </button>
                ) : null}
                {!canEditResult && state.tx !== "active" ? (
                  <span className="tx-auto" title={t("자동 커밋")}>
                    {t("자동 커밋")}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
          <div className="tabbar">
            <button
              type="button"
              className={`icon-button tabbar-side${schemaOpen ? " active" : ""}`}
              onClick={() => setSchemaOpen((value) => !value)}
              title={`${schemaOpen ? t("스키마 패널 숨기기") : t("스키마 패널 표시")} (${shortcutHint(settings.keymap, "toggleSidebar")})`}
            >
              <PanelLeftIcon size={13} />
            </button>
            {tabs !== null ? (
              <TabStrip
                tabs={tabs.tabs}
                activeId={tabs.activeId}
                runningTabId={runningTabId}
                onActivate={activate}
                onClose={closeTabById}
                onRename={renameTabById}
              />
            ) : null}
            <div className="tabbar-actions">
              <button
                type="button"
                className={`icon-button tabbar-side${moreMenu !== null ? " active" : ""}`}
                onClick={(event) => {
                  const anchor = event.currentTarget;
                  const rect = anchor.getBoundingClientRect();
                  setMoreMenu(moreMenu !== null ? null : { x: rect.right - 230, y: rect.bottom + 4, anchor });
                }}
                title={t("더 보기: 내보내기·가져오기·백업")}
              >
                <MoreIcon size={13} />
              </button>
              <button
                type="button"
                className={`icon-button tabbar-side${detailRow !== null ? " active" : ""}`}
                disabled={state.result === null || resultView !== "grid"}
                onClick={toggleDetailPanel}
                title={`${detailRow !== null ? t("행 상세 패널 닫기") : t("행 상세 패널 열기")} (${shortcutHint(settings.keymap, "toggleDetail")})`}
              >
                <PanelIcon size={13} />
              </button>
            </div>
          </div>
          <div className="workbench">
            {schemaOpen && activeConnId !== null ? (
              <SchemaSidebar
                key={activeConnId}
                conn={activeConnId}
                kind={meta?.kind ?? ""}
                refreshKey={schemaKey}
                pinned={pinnedTables[activeConnId] ?? EMPTY_TABLES}
                onOpenData={(table) => openDataTab(table)}
                onOpenDataNewTab={(table) => openDataTab(table, { newTab: true })}
                onOpenInEditor={pickTable}
                onOpenStructure={(table) => openDataTab(table, { view: "structure" })}
                onOpenDdl={(table) => openDataTab(table, { view: "ddl" })}
                onOpenOverview={openOverviewTab}
                onOpenServer={openServerTab}
                onOpenDefinition={openDefinitionTab}
                onTogglePin={togglePin}
                onTableAction={(action, table) => void tableAction(action, table)}
                onOpenCreateTable={() => setCreateTableOpen(true)}
                onOpenSql={openSqlTab}
                onOpenUsers={() => setUserMgrOpen(true)}
              />
            ) : null}
            <div
              className={`workbench-main${splitSide === "right" ? " right" : ""}`}
              ref={mainRef}
            >
              {activeTab?.kind === "query" ? (
                <>
                  <div
                    className="editor-pane"
                    style={editorHeight === null ? undefined : { flexBasis: `${editorHeight}px` }}
                  >
                    <SqlEditor
                      ref={editorRef}
                      tabId={tabs !== null ? tabs.activeId : "none"}
                      tabIds={tabIds}
                      initialSql={activeTab.sql}
                      onRun={run}
                      onSqlChange={handleSqlChange}
                      schema={schemaMap}
                      favorites={favoriteSnippets}
                      runKey={settings.keymap.run[0]?.replaceAll("+", "-") ?? null}
                    />
                  </div>
                  <div
                    className={splitSide === "right" ? "v-splitter" : "h-splitter"}
                    role="separator"
                    aria-orientation={splitSide === "right" ? "vertical" : "horizontal"}
                    onPointerDown={onSplitterDown}
                  />
                </>
              ) : null}
              <div className="result-pane">
                {activeTab === null ? (
                  <EmptyWorkspace onNewQuery={createNewTab} onHome={goHome} />
                ) : activeTab.kind === "structure" && activeConnId !== null ? (
                  <StructurePanel
                    key={`${activeConnId}:${activeTab.id}`}
                    conn={activeConnId}
                    kind={meta?.kind ?? ""}
                    table={activeTab.table}
                    data={activeTab.data}
                    exactRows={meta?.kind === "sqlite"}
                    onData={(detail) =>
                      updateActiveTabs((current) => patchTab(current, activeTab.id, { data: detail }))
                    }
                    onChanged={() => {
                      void refreshActiveMeta();
                    }}
                  />
                ) : activeTab?.kind === "overview" && activeConnId !== null && meta !== null ? (
                  <OverviewPanel
                    key={`${activeConnId}:${activeTab.id}`}
                    conn={activeConnId}
                    meta={meta}
                    refreshKey={schemaKey}
                    onOpenData={(table) => openDataTab(table)}
                    onOpenStructure={(table) => openDataTab(table, { view: "structure" })}
                  />
                ) : activeTab?.kind === "server" && activeConnId !== null ? (
                  <ServerInfoPanel key={`${activeConnId}:${activeTab.id}`} conn={activeConnId} />
                ) : activeTab?.kind === "definition" && activeConnId !== null ? (
                  <DefinitionPanel
                    key={`${activeConnId}:${activeTab.id}`}
                    conn={activeConnId}
                    tab={activeTab}
                    onDetail={(definition) =>
                      updateActiveTabs((current) =>
                        patchTab(current, activeTab.id, { definition }),
                      )
                    }
                  />
                ) : (
                  <>
                    {activeDataTab && activeConnId !== null ? (
                      <div className="data-toolbar">
                        <div className="view-tabs">
                          <button
                            type="button"
                            className={(activeDataTab.view ?? "data") === "data" ? "active" : ""}
                            onClick={() => setTableView("data")}
                            title={`${t("데이터")} (⌘⌃[ / ⌘⌃])`}
                          >
                            {t("데이터")}
                          </button>
                          <button
                            type="button"
                            className={activeDataTab.view === "structure" ? "active" : ""}
                            onClick={() => setTableView("structure")}
                            title={`${t("구조")} (⌘⌃[ / ⌘⌃])`}
                          >
                            {t("구조")}
                          </button>
                          <button
                            type="button"
                            className={activeDataTab.view === "ddl" ? "active" : ""}
                            onClick={() => setTableView("ddl")}
                            title={`DDL (⌘⌃[ / ⌘⌃])`}
                          >
                            DDL
                          </button>
                        </div>
                        {(activeDataTab.view ?? "data") === "data" ? (
                          <>
                            <DataTabToolbar
                              tab={activeDataTab}
                              running={connRunning}
                              counting={countingTabId === activeDataTab.id}
                              filterOpen={filterVisible}
                              columnsOpen={columnsPickOpen}
                              onRefresh={() =>
                                runDataWith(
                                  activeConnId,
                                  activeDataTab,
                                  dataSpecOf(
                                    activeDataTab,
                                    activeDataTab.offset,
                                    activeDataTab.pageSize,
                                  ),
                                )
                              }
                              onToggleFilter={() =>
                                setFilterOpen((prev) => ({
                                  ...prev,
                                  [activeDataTab.id]: !(prev[activeDataTab.id] ?? false),
                                }))
                              }
                              onToggleColumns={() => setColumnsPickOpen((value) => !value)}
                              onInsertRow={insertDefaultRow}
                              onLimit={(limit) =>
                                runDataWith(
                                  activeConnId,
                                  activeDataTab,
                                  dataSpecOf(activeDataTab, activeDataTab.offset, limit),
                                )
                              }
                              onOffset={(offset) =>
                                runDataWith(
                                  activeConnId,
                                  activeDataTab,
                                  dataSpecOf(activeDataTab, offset, activeDataTab.pageSize),
                                )
                              }
                              onCount={() => void refreshCount(activeConnId, activeDataTab.id)}
                              onFirst={() =>
                                runDataWith(
                                  activeConnId,
                                  activeDataTab,
                                  dataSpecOf(activeDataTab, 0, activeDataTab.pageSize),
                                )
                              }
                              onPrev={() =>
                                runDataWith(
                                  activeConnId,
                                  activeDataTab,
                                  dataSpecOf(
                                    activeDataTab,
                                    Math.max(0, activeDataTab.offset - activeDataTab.pageSize),
                                    activeDataTab.pageSize,
                                  ),
                                )
                              }
                              onNext={() =>
                                runDataWith(
                                  activeConnId,
                                  activeDataTab,
                                  dataSpecOf(
                                    activeDataTab,
                                    activeDataTab.offset + activeDataTab.pageSize,
                                    activeDataTab.pageSize,
                                  ),
                                )
                              }
                            />
                            {columnsPickOpen ? (
                              <ColumnPicker
                                columns={columnEntries}
                                onToggle={toggleColumn}
                                onMove={moveColumn}
                                onAll={resetColumns}
                                onReset={resetColumns}
                                onClose={() => setColumnsPickOpen(false)}
                              />
                            ) : null}
                          </>
                        ) : null}
                      </div>
                    ) : null}
                    {activeDataTab && activeConnId !== null && activeDataTab.view === "structure" ? (
                      <StructurePanel
                        key={`${activeConnId}:${activeDataTab.id}:structure`}
                        conn={activeConnId}
                        kind={meta?.kind ?? ""}
                        table={activeDataTab.table}
                        data={activeDataTab.detail}
                        exactRows={meta?.kind === "sqlite"}
                        onData={(detail) =>
                          updateActiveTabs((current) =>
                            patchTab(current, activeDataTab.id, { detail }),
                          )
                        }
                        onChanged={() => {
                          void refreshActiveMeta();
                        }}
                      />
                    ) : activeDataTab && activeConnId !== null && activeDataTab.view === "ddl" ? (
                      <div className="panel">
                        <div className="panel-head">
                          <span className="panel-title">{`DDL: ${activeDataTab.table}`}</span>
                          <span className="spacer" />
                          <button
                            type="button"
                            className="icon-text-button"
                            disabled={activeDataTab.detail?.ddl == null}
                            onClick={() => {
                              const ddl = activeDataTab.detail?.ddl;
                              if (ddl) {
                                void writeClipboard(ddl);
                              }
                            }}
                            title={t("복사")}
                          >
                            {t("복사")}
                          </button>
                        </div>
                        <div className="panel-body">
                          {activeDataTab.detail?.ddl == null ? (
                            <div className="panel-empty">DDL을 가져오는 중…</div>
                          ) : (
                            <div className="panel-code">
                              <pre className="panel-pre">{activeDataTab.detail.ddl}</pre>
                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <>
                    {activeDataTab && activeConnId !== null && filterVisible ? (
                      <FilterBar
                        columns={dataMeta?.columns ?? EMPTY_TABLES}
                        filter={activeDataTab.filter ?? EMPTY_FILTER}
                        running={connRunning}
                        onApply={(next) =>
                          runDataWith(activeConnId, activeDataTab, {
                            offset: 0,
                            pageSize: activeDataTab.pageSize,
                            filter: next,
                            sorts: activeDataTab.sorts ?? null,
                          })
                        }
                        onReset={() =>
                          runDataWith(activeConnId, activeDataTab, {
                            offset: 0,
                            pageSize: activeDataTab.pageSize,
                            filter: null,
                            sorts: activeDataTab.sorts ?? null,
                          })
                        }
                      />
                    ) : null}
                    {dataView ? null : (
                    <div className="result-tabs">
                      <button
                        type="button"
                        className={`result-tab${resultView === "grid" ? " active" : ""}`}
                        onClick={() => setResultView("grid")}
                      >
                        {t("그리드")}
                      </button>
                      <button
                        type="button"
                        className={`result-tab${resultView === "message" ? " active" : ""}`}
                        onClick={() => setResultView("message")}
                      >
                        {t("메시지")}
                        {messageAvailable ? <span className="dot" aria-hidden="true" /> : null}
                      </button>
                      {planAvailable ? (
                        <button
                          type="button"
                          className={`result-tab${resultView === "plan" ? " active" : ""}`}
                          onClick={() => setResultView("plan")}
                        >
                          {t("계획")}
                        </button>
                      ) : null}
                      {resultChips !== null &&
                      resultChips.conn === activeConnId &&
                      resultChips.tabId === activeTab?.id
                        ? resultChips.entries.map((entry) => (
                            <button
                              type="button"
                              className="result-tab chip"
                              key={entry.label}
                              title={
                                entry.outcome.kind === "ok"
                                  ? `${entry.outcome.result.meta.rowCount.toLocaleString()}행`
                                  : entry.outcome.kind === "error"
                                    ? entry.outcome.error
                                    : "취소됨"
                              }
                              onClick={() => showResultChip(entry)}
                            >
                              {entry.label}
                            </button>
                          ))
                        : null}
                    </div>
                    )}
                    {dataView && state.error ? (
                      <div className="data-error-slot">
                        <ErrorNotice
                          message={state.error}
                          variant="compact"
                          onClose={() => store.setError(null)}
                        />
                      </div>
                    ) : null}
                    {dataView && state.info && state.status !== "running" ? (
                      <div className="data-notice info">{state.info}</div>
                    ) : null}
                    <div
                      className={`result-body${detailOpen ? " with-detail" : ""}${cellQuickLook !== null ? " with-quicklook" : ""}`}
                    >
                      <div className={`result-layer${resultView === "grid" ? "" : " hidden"}`}>
                        <GridHost
                          ref={gridHostRef}
                          result={state.result}
                          sortColumns={sortIndicators}
                          onHeaderClick={activeDataTab ? handleHeaderClick : undefined}
                          onSelectionChange={handleSelectionChange}
                          onCellContextMenu={handleCellContextMenu}
                          onDeleteRows={deleteRows}
                          onQuickLook={(row) => openRowDetail(row)}
                          onCellQuickLook={(row, col) => openCellQuickLook(row, col)}
                          themeKey={`${settings.theme}:${settings.accent}:${settings.rowAlt}`}
                        />
                        {!state.result && (
                          <div className="grid-empty">
                            {meta
                              ? t("쿼리를 실행하세요 ({key})", { key: shortcutHint(settings.keymap, "run") })
                              : t("연결 또는 파일 열기로 시작하세요")}
                          </div>
                        )}
                      </div>
                      {planAvailable ? (
                        <div
                          className={`result-layer plan-layer${resultView === "plan" ? "" : " hidden"}`}
                        >
                          <ExplainPlanPanel result={state.result!} kind={meta?.kind ?? ""} />
                        </div>
                      ) : null}
                      {cellQuickLook && state.result && resultView === "grid" ? (
                        <CellQuickLook
                          result={state.result}
                          row={cellQuickLook.row}
                          col={cellQuickLook.col}
                          table={activeDataTab ? activeDataTab.table : state.result.meta.sourceTable}
                          onClose={() => setCellQuickLook(null)}
                        />
                      ) : null}
                      {detailOpen && state.result ? (
                        <RowDetailPanel
                          result={state.result}
                          row={detailRow}
                          table={activeDataTab ? activeDataTab.table : state.result.meta.sourceTable}
                          kind={meta?.kind ?? "postgres"}
                          detail={rowDetailInfo}
                          detailLoading={rowDetailLoading}
                          onOpenReference={(row, col) => void fkJump(row, col)}
                          onClose={() => setDetailRow(null)}
                        />
                      ) : null}
                      {resultView === "message" && (
                        <div className="message-pane">
                          {state.error ? (
                            <ErrorNotice message={state.error} />
                          ) : state.info ? (
                            <div className="message-info">{state.info}</div>
                          ) : (
                            <div className="message-empty">{t("메시지가 없습니다")}</div>
                          )}
                        </div>
                      )}
                      {state.status === "running" ? (
                        <div className="result-loading" role="status">
                          <Spinner size={12} />
                          {t("실행 중…")}
                        </div>
                      ) : null}
                    </div>
                    <div className="result-statusline">
                      <span>
                        {state.status === "running"
                          ? t("실행 중…")
                          : state.result
                            ? `${t("총 {count}행", { count: state.result.meta.rowCount.toLocaleString() })} · ${state.result.meta.elapsedMs.toFixed(1)}ms`
                            : t("준비됨")}
                      </span>
                      {state.result?.meta.truncated ? <span className="warn">{t("잘림")}</span> : null}
                      {activeDataTab && pageInfo ? (
                        <span className="dim">
                          {pageInfo.rows === null
                            ? t("{page} 페이지+", { page: pageInfo.page })
                            : pageInfo.exact
                              ? t("{page} / {pages} 페이지 · 총 {count}행", {
                                  page: pageInfo.page,
                                  pages: pageInfo.pages ?? 1,
                                  count: pageInfo.rows.toLocaleString(),
                                })
                              : t("{page} 페이지+ · {count}+행", {
                                  page: pageInfo.page,
                                  count: pageInfo.rows.toLocaleString(),
                                })}
                        </span>
                      ) : null}
                      {state.info && state.status !== "running" ? (
                        <span className="dim ellipsis">{state.info}</span>
                      ) : null}
                      <span className="spacer" />
                      {activeTab ? <span className="dim">{activeTab.title}</span> : null}
                    </div>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </>
      )}
      {state.error !== null && !errorInline ? (
        <ErrorNotice message={state.error} variant="toast" onClose={() => store.setError(null)} />
      ) : null}
      {menu !== null ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={() => setMenu(null)} />
      ) : null}
      {createTableOpen && activeConnId !== null && meta !== null ? (
        <CreateTableModal
          conn={activeConnId}
          kind={meta.kind}
          meta={meta}
          onClose={() => setCreateTableOpen(false)}
          onCreated={(table) => {
            setCreateTableOpen(false);
            detailCacheRef.current = new Map();
            setMetaNonce((value) => value + 1);
            void refreshActiveMeta();
            openDataTab(table);
          }}
        />
      ) : null}
      {userMgrOpen && activeConnId !== null && meta !== null ? (
        <UserManagerModal
          conn={activeConnId}
          meta={meta}
          onClose={() => setUserMgrOpen(false)}
        />
      ) : null}
      {dbMenu !== null ? (
        <ContextMenu
          x={dbMenu.x}
          y={dbMenu.y}
          items={[
            ...dbMenu.databases.map((database) => ({
              label: database === currentDatabase() ? `✓ ${database}` : database,
              onSelect: () => {
                void switchToDatabase(database);
              },
            })),
            {
              label: "데이터베이스 만들기…",
              separatorBefore: true,
              onSelect: () => {
                void createDatabase();
              },
            },
            {
              label: "데이터베이스 삭제…",
              onSelect: () => {
                void dropDatabase();
              },
            },
            {
              label: "백업 (SQL 덤프)…",
              separatorBefore: true,
              onSelect: () => {
                setDbMenu(null);
                setDumpTab("backup");
              },
            },
            {
              label: "복원 (SQL 실행)…",
              onSelect: () => {
                setDbMenu(null);
                setDumpTab("restore");
              },
            },
          ]}
          onClose={() => setDbMenu(null)}
        />
      ) : null}
      {moreMenu !== null ? (
        <ContextMenu
          x={moreMenu.x}
          y={moreMenu.y}
          anchor={moreMenu.anchor}
          items={[
            {
              label: t("결과 내보내기…"),
              disabled: state.result === null,
              onSelect: openExport,
            },
            {
              label: t("데이터 가져오기…"),
              disabled: activeDataTab === null,
              onSelect: () => {
                if (activeDataTab !== null) {
                  setImportTarget({ kind: meta?.kind ?? "", table: activeDataTab.table });
                }
              },
            },
            {
              label: t("백업 (SQL 덤프)…"),
              separatorBefore: true,
              disabled: meta === null,
              onSelect: () => setDumpTab("backup"),
            },
            {
              label: t("복원 (SQL 실행)…"),
              disabled: meta === null,
              onSelect: () => setDumpTab("restore"),
            },
          ]}
          onClose={() => setMoreMenu(null)}
        />
      ) : null}
      {snippetMenu !== null ? (
        <ContextMenu
          x={snippetMenu.x}
          y={snippetMenu.y}
          items={snippetItems()}
          onClose={() => setSnippetMenu(null)}
        />
      ) : null}
      {paletteOpen ? (
        <CommandPalette
          actions={paletteActions()}
          sources={paletteSources()}
          onClose={() => setPaletteOpen(false)}
        />
      ) : null}
      {fsOpen && (
        <FsModal
          onClose={() => setFsOpen(false)}
          onOpenDb={(path) => {
            setFsOpen(false);
            if (path === null) {
              void openDemo();
            } else {
              void openPathFile(path);
            }
          }}
        />
      )}
      {connectOpen && (
        <ConnectModal
          key={
            connectEditing?.saved.id ??
            `new:${newConnOptions?.driver ?? ""}:${newConnOptions?.group ?? ""}:${newConnOptions?.url ?? ""}`
          }
          editing={connectEditing?.saved ?? null}
          initialDriver={newConnOptions?.driver ?? null}
          initialGroup={newConnOptions?.group ?? null}
          initialUrl={newConnOptions?.url ?? null}
          notice={connectEditing?.notice ?? null}
          missingSecret={connectEditing?.missingSecret ?? null}
          openConnId={
            connectEditing !== null
              ? (conns.find((conn) => conn.saved_id === connectEditing.saved.id)?.id ?? null)
              : null
          }
          onClose={() => {
            // Closed without connecting: a pending backup/restore is dropped.
            pendingDumpRef.current = null;
            closeConnectionDialog();
          }}
          onSaved={() => setSavedVersion((value) => value + 1)}
          onSwitch={(connId) => {
            if (pendingDumpRef.current !== null) {
              pendingDumpRef.current = { ...pendingDumpRef.current, target: { connId } };
            }
            closeConnectionDialog();
            void enterConn(connId);
          }}
          onConnected={(live) => {
            // Connected from the dialog (e.g. after typing a password): the dump waits for this one.
            if (pendingDumpRef.current !== null) {
              pendingDumpRef.current = { ...pendingDumpRef.current, target: { connId: live.conn } };
            }
            closeConnectionDialog();
            void afterOpen(live);
          }}
        />
      )}
      {dumpPicker !== null && (
        <ConnectionPickerModal
          title={dumpPicker.kind === "backup" ? t("백업할 연결 선택") : t("복원할 연결 선택")}
          conns={conns}
          saved={dumpPicker.saved}
          onPick={(target) => void pickForDump(target)}
          onClose={() => setDumpPicker(null)}
        />
      )}
      {exportTarget !== null && (
        <ExportModal
          conn={exportTarget.conn}
          title={exportTarget.title}
          result={exportTarget.result}
          dataTab={exportTarget.dataTab}
          kind={meta?.kind ?? "postgres"}
          onClose={() => setExportTarget(null)}
        />
      )}
      {importTarget !== null && activeConnId !== null && (
        <ImportModal
          conn={activeConnId}
          kind={importTarget.kind}
          table={importTarget.table}
          onClose={() => setImportTarget(null)}
        />
      )}
      {dumpTab !== null && activeConnId !== null && meta !== null && (
        <DumpModal
          conn={activeConnId}
          meta={meta}
          initialTab={dumpTab}
          onClose={() => setDumpTab(null)}
          onRestored={() => {
            detailCacheRef.current = new Map();
            setMetaNonce((value) => value + 1);
            void refreshActiveMeta();
          }}
        />
      )}
      {jobsOpen && <JobsModal onClose={() => setJobsOpen(false)} />}
      {paramPrompt !== null && (
        <ParamModal
          params={paramPrompt.params}
          initial={loadParamValues()}
          onSubmit={runWithParams}
          onClose={() => setParamPrompt(null)}
        />
      )}
      {reviewPrompt !== null && (
        <ReviewModal
          mode={alertMode}
          items={reviewPrompt.items}
          txActive={state.tx === "active"}
          onRun={runReviewed}
          onClose={() => setReviewPrompt(null)}
        />
      )}
      {logOpen && (
        <ConsoleLogModal
          onOpenSql={(sqlText) => {
            openInQueryEditor(sqlText);
          }}
          onClose={() => setLogOpen(false)}
        />
      )}
      {activityOpen && <ActivityModal onClose={() => setActivityOpen(false)} />}
      {metricsOpen && <MetricsModal onClose={() => setMetricsOpen(false)} />}
      {settingsOpen && (
        <SettingsModal
          settings={settings}
          onChange={(patch) => setSettings(saveSettings(patch))}
          onLock={() => {
            setSettingsOpen(false);
            setLocked(true);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
    {locked ? <LockScreen onUnlock={() => setLocked(false)} /> : null}
    <HoverTooltip />
    </>
  );
}
