import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { CommandPalette, type PaletteAction, type PaletteSource } from "./components/CommandPalette";
import { ColumnPicker, type ColumnEntry } from "./components/ColumnPicker";
import { ConnectModal } from "./components/ConnectModal";
import { CreateTableModal } from "./components/CreateTableModal";
import { ConnSwitcher } from "./components/ConnSwitcher";
import { ContextMenu, type ContextMenuItem } from "./components/ContextMenu";
import { DataTabToolbar, type DataTotal } from "./components/DataToolbar";
import { EditorActions } from "./components/EditorActions";
import {
  dropTableSql,
  laravelSchemaScript,
  quoteIdent,
  renameTableSql,
  sqliteDefaultSql,
  truncateTableSql,
} from "./ddl";
import { adoptDrafts, listDrafts, removeDraft, saveDraft, type QueryDraft } from "./drafts";
import { subscribeConnMeta } from "./connMeta";
import { DefinitionPanel } from "./components/DefinitionPanel";
import { ExplainPlanPanel } from "./components/ExplainPlanPanel";
import { ConnectionPickerModal, type PickTarget } from "./components/ConnectionPickerModal";
import { DumpModal } from "./components/DumpModal";
import { EmptyWorkspace } from "./components/EmptyWorkspace";
import { ErrorNotice } from "./components/ErrorNotice";
import { ExportModal, type ExportTarget } from "./components/ExportModal";
import { FilterBar } from "./components/FilterBar";
import { FsModal } from "./components/FsModal";
import { GridHost, type GridHostHandle } from "./components/GridHost";
import type { SelectedRows } from "./grid/CanvasGrid";
import type { RowSource } from "./grid/rowSource";
import { HomeScreen, type NewConnectionOptions } from "./components/HomeScreen";
import { HoverTooltip } from "./components/HoverTooltip";
import { t, tServer, tTableCount } from "./i18n";
import { ImportModal, type ImportFormat } from "./components/ImportModal";
import { JobsModal } from "./components/JobsModal";
import { ParamModal } from "./components/ParamModal";
import { ReviewModal } from "./components/ReviewModal";
import { SAFE_MODE_LABELS, SafeModeMenu } from "./components/SafeModeMenu";
import { SettingsModal } from "./components/SettingsModal";
import { ConsolePanel } from "./components/ConsolePanel";
import { ActivityModal } from "./components/ActivityModal";
import { BrandLogo } from "./components/BrandLogo";
import { MetricsModal } from "./components/MetricsModal";
import { LockScreen } from "./components/LockScreen";
import { OverviewPanel } from "./components/OverviewPanel";
import { CellInspector, type CellAnchor } from "./components/CellInspector";
import { RowDetailPanel } from "./components/RowDetailPanel";
import { ResultBar, StatementMessages, statementStatus, type ShownResult, type StatementMessage } from "./components/ResultBar";
import { LoadingState, Spinner } from "./components/Spinner";
import { SchemaSidebar, type TableAction } from "./components/SchemaSidebar";
import { SidebarPanel } from "./components/SidebarPanel";
import { QueriesPane } from "./components/QueriesPane";
import { HistoryPane } from "./components/HistoryPane";
import { PromptModal } from "./components/PromptModal";
import { DiscardModal } from "./components/DiscardModal";
import { ServerInfoPanel } from "./components/ServerInfoPanel";
import { SqlEditor, type SqlEditorHandle } from "./components/SqlEditor";
import { StructurePanel } from "./components/StructurePanel";
import { UserManagerModal } from "./components/UserManagerModal";
import { TabStrip } from "./components/TabStrip";
import {
  CheckIcon,
  JobsIcon,
  MoreIcon,
  PanelIcon,
  PanelLeftIcon,
  PanelBottomIcon,
  PlusIcon,
  SettingsIcon,
  SnippetIcon,
  StarIcon,
  StopIcon,
} from "./components/icons";
import {
  buildCountSql,
  buildDataSql,
  firstRowsSql,
  buildWhere,
  cycleSort,
  EMPTY_FILTER,
  quoteLiteral,
  selectList,
  type FilterState,
  type SortState,
} from "./dataQuery";
import { buildUpdateSql, SqlExpression } from "./export";
import { COPY_MAX_ROWS, copyValue, formatCopy, type CopyFormat } from "./copyFormats";
import { subscribeJobs } from "./jobs";
import {
  loadTableColors,
  moveTableColor,
  saveTableColors,
  withTableColor,
  type TableColorMap,
} from "./tableColors";
import {
  getPasscodeHash,
  getSettings,
  saveSettings,
  subscribeSettings,
  type AppSettings,
} from "./settings";
import { cellToString, fkFilterFor, quickFilterFor } from "./rowOps";
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
  changesSchema,
  type DefinitionKind,
  type ReviewItem,
  type SafeMode,
} from "./sqlTools";
import { forgetSchema, loadSchema } from "./schemaCache";
import { splitSqlStatements } from "./sqlSplit";
import { loadAutoSave } from "./savedQueries";
import { isDateKind, specsForTable, withResultKinds } from "./grid/columns";
import { cellMenuItems, deleteRowsLabel, type CellValueChoice } from "./grid/cellMenu";
import { IS_MAC, actionForEvent, formatBinding, matchesBinding, shortcutHint, withHint, type KeyAction } from "./shortcuts";
import type { GridSelection, SortIndicator } from "./grid/CanvasGrid";
import { subscribePendingChanges, type StagedExpr, type WindowedRowSource } from "./grid/windowSource";
import {
  ApiRequestError,
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
  countFor,
  createDataTab,
  createDefinitionTab,
  createOverviewTab,
  createQueryTab,
  createServerTab,
  freeQueryNumber,
  migrateTabsState,
  patchFromOutcome,
  patchTab,
  queryNumberOf,
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
// TablePlus's Beautify; only in the SQL editor, so ⌘I keeps its keymap action elsewhere.
const BEAUTIFY_KEY = "Mod+i";
// Past this many rows (by the driver's estimate) a table's total isn't counted
// on its own: COUNT(*) would hold the connection too long.
const AUTO_COUNT_MAX = 1_000_000;
// With no row estimate (a view, a table never analyzed), a table this small
// on disk is still counted.
const AUTO_COUNT_BYTES = 128 * 1024 * 1024;
const CONSOLE_HEIGHT_KEY = "tablepeek.console-height";
// Which connections have the bottom console and the right panel open, kept
// across reloads.
const CONSOLE_PANELS_KEY = "tablepeek.console-panels";
const DETAIL_PANELS_KEY = "tablepeek.detail-panels";
const CONSOLE_DEFAULT = 180;
const CONSOLE_MIN = 90;
const SIDEBAR_WIDTH_KEY = "tablepeek.sidebar-width";
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 560;

const DETAIL_WIDTH_KEY = "tablepeek.detail-width";
const DETAIL_MIN = 260;
const DETAIL_MAX = 720;

// Keeps the schema sidebar wide enough to read and the editor wide enough to use.
function clampSidebar(width: number): number {
  const max = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, window.innerWidth - 420));
  return Math.round(Math.min(Math.max(width, SIDEBAR_MIN), max));
}

// Same for the row detail panel on the right, which leaves the grid room.
function clampDetail(width: number): number {
  const max = Math.max(DETAIL_MIN, Math.min(DETAIL_MAX, window.innerWidth - 480));
  return Math.round(Math.min(Math.max(width, DETAIL_MIN), max));
}

function storedWidth(key: string, clamp: (width: number) => number): number | null {
  const saved = Number(window.localStorage.getItem(key));
  return Number.isFinite(saved) && saved > 0 ? clamp(saved) : null;
}

function storeWidth(key: string, width: number | null): void {
  try {
    if (width === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, String(width));
    }
  } catch {}
}

// Drags a side panel's edge. `grow` is 1 when moving right widens the panel
// (left sidebar) and -1 when moving left does (right panel).
function dragPanelEdge(
  event: ReactPointerEvent<HTMLDivElement>,
  panel: Element | null,
  grow: 1 | -1,
  clamp: (width: number) => number,
  onMove: (width: number) => void,
  onDone: (width: number) => void,
): void {
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  const handle = event.currentTarget;
  const startX = event.clientX;
  const startWidth = panel instanceof HTMLElement ? panel.getBoundingClientRect().width : 0;
  let width = startWidth;
  handle.classList.add("dragging");
  document.body.classList.add("col-resizing");
  const move = (next: PointerEvent): void => {
    width = clamp(startWidth + grow * (next.clientX - startX));
    onMove(width);
  };
  const up = (): void => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    handle.classList.remove("dragging");
    document.body.classList.remove("col-resizing");
    onDone(width);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// Arrow keys resize a focused panel edge (Shift for bigger steps); Home or
// Enter returns it to its default width.
function keyPanelEdge(
  event: ReactKeyboardEvent<HTMLDivElement>,
  panel: Element | null,
  grow: 1 | -1,
  clamp: (width: number) => number,
  save: (width: number | null) => void,
): void {
  const current = panel instanceof HTMLElement ? panel.getBoundingClientRect().width : 0;
  const step = event.shiftKey ? 64 : 16;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    save(clamp(current + grow * (event.key === "ArrowLeft" ? -step : step)));
  } else if (event.key === "Home" || event.key === "Enter") {
    event.preventDefault();
    save(null);
  }
}
const WORKSPACES_KEY = "tablepeek.workspaces";
const PINNED_KEY = "tablepeek.pinned-tables";
const PERSIST_DROP_KEYS = new Set(["source", "data", "detail"]);
const TABLE_VIEWS: TableView[] = ["data", "structure", "index"];

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

interface MenuState {
  row: number;
  col: number;
  x: number;
  y: number;
  // What the menu acts on; the clicked cell is inside it.
  selection: GridSelection;
  // The rows it was opened on: another result closes it.
  result: GridResult;
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

async function rowValues(source: WindowedRowSource, row: number, keywords = false): Promise<unknown[]> {
  if (source.cell(row, 0) === undefined) {
    await source.ensureRow(row);
  }
  return source.columns.map((_, c) => copyValue(source, row, c, keywords));
}

// Rows `from`…`to` (at most COPY_MAX_ROWS of them) in the columns `cols`,
// each window fetched as the walk reaches it.
async function rangeValues(
  source: WindowedRowSource,
  from: number,
  to: number,
  cols: number[],
  keywords = false,
): Promise<unknown[][]> {
  const rows: unknown[][] = [];
  const last = Math.min(to, from + COPY_MAX_ROWS - 1, source.rowCount - 1);
  for (let row = from; row <= last; row += 1) {
    if (source.cell(row, 0) === undefined) {
      await source.ensureRow(row);
    }
    rows.push(cols.map((col) => copyValue(source, row, col, keywords)));
  }
  return rows;
}

// Copies and row actions stop at COPY_MAX_ROWS; this says so when they did.
function noteCapped(rows: number, message: string): void {
  if (rows > COPY_MAX_ROWS) {
    store.setInfo(message);
  }
}

function rangeOf(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index);
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    store.setError(t("클립보드에 복사하지 못했습니다"));
  }
}

function errorOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

// The pane a statement's outcome opens on: an EXPLAIN's plan, its rows, or
// the Message view for a failure or a statement without result columns
// (UPDATE, DDL), whose empty grid would say nothing. Null leaves it as it is.
function viewOfOutcome(outcome: QueryOutcome): "grid" | "message" | "plan" | null {
  if (outcome.kind === "cancelled") {
    return null;
  }
  if (outcome.kind === "error" || outcome.result.meta.columns.length === 0) {
    return "message";
  }
  return isExplainSql(outcome.result.sql) ? "plan" : "grid";
}

function sameSql(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "").trim() === (b ?? "").trim();
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

function loadFlagMap(key: string): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? "{}");
    if (parsed === null || typeof parsed !== "object") {
      return {};
    }
    const out: Record<string, boolean> = {};
    for (const [conn, open] of Object.entries(parsed)) {
      if (typeof open === "boolean") {
        out[conn] = open;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveFlagMap(key: string, map: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(map));
  } catch {}
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
  // A filter bar asked to take the keyboard (its button, ⌘F), with the column
  // a new condition starts on; cleared once the bar has done it.
  const [filterFocus, setFilterFocus] = useState<{ tab: string; seq: number; column: string | null } | null>(
    null,
  );
  // The row detail panel stays open or closed per connection, across its
  // tables; detailRows is the span of rows it describes (null until picked).
  const [detailPanels, setDetailPanels] = useState<Record<string, boolean>>(() => loadFlagMap(DETAIL_PANELS_KEY));
  const [detailRows, setDetailRows] = useState<SelectedRows | null>(null);
  // The same for the Structure and Index views' grids, with the rows they
  // read from; keyed "tab:view" so it only describes the grid it came from.
  const [structurePick, setStructurePick] = useState<{
    key: string;
    source: RowSource;
    rows: SelectedRows;
  } | null>(null);
  // Keyed by "conn:table" so a panel never shows another table's detail.
  const [rowDetailInfo, setRowDetailInfo] = useState<{ key: string; detail: TableDetail | null } | null>(
    null,
  );
  // Bumped whenever cached table details may be out of date.
  const [detailNonce, setDetailNonce] = useState(0);
  const [rowDetailLoading, setRowDetailLoading] = useState(false);
  const [cellQuickLook, setCellQuickLook] = useState<{ row: number; col: number; anchor: CellAnchor | null } | null>(
    null,
  );
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [exportTarget, setExportTarget] = useState<ExportTarget | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Safe mode belongs to each connection (kept by the server). One that never
  // chose its own follows the single app-wide setting older versions kept.
  const [defaultSafeMode] = useState<SafeMode>(() => {
    const raw = window.localStorage.getItem("tablepeek.alert-mode");
    if (raw === "0" || raw === "1" || raw === "2") {
      return Number(raw) as SafeMode;
    }
    return window.localStorage.getItem("tablepeek.safe-mode") === "0" ? 0 : 1;
  });
  // Choices made in this window win over connection lists fetched before the
  // server stored them; a failed save rolls its choice back.
  const [safeModeChoices, setSafeModeChoices] = useState<Record<string, SafeMode>>({});
  const safeModeSeqRef = useRef<Record<string, number>>({});
  const ownSafeMode =
    activeConnId === null
      ? undefined
      : (safeModeChoices[activeConnId] ?? conns.find((conn) => conn.id === activeConnId)?.safe_mode);
  const alertMode: SafeMode =
    ownSafeMode === 0 || ownSafeMode === 1 || ownSafeMode === 2 ? ownSafeMode : defaultSafeMode;
  const [snippetMenu, setSnippetMenu] = useState<{ x: number; y: number } | null>(null);
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number; anchor: Element } | null>(null);
  const [metaNonce, setMetaNonce] = useState(0);
  const [pinnedTables, setPinnedTables] = useState<Record<string, string[]>>(() =>
    loadTableMap(PINNED_KEY),
  );
  const [countingTabId, setCountingTabId] = useState<string | null>(null);
  const countSeqRef = useRef(new Map<string, number>());
  // Tables whose structure couldn't be read: no automatic count asks again.
  const detailFailedRef = useRef(new Set<string>());
  const [columnsPickOpen, setColumnsPickOpen] = useState(false);
  const [createTableOpen, setCreateTableOpen] = useState(false);
  const [userMgrOpen, setUserMgrOpen] = useState(false);
  const [addQueryOpen, setAddQueryOpen] = useState(false);
  // Staged changes waiting on the discard warning, and what runs once dropped.
  const [discardPrompt, setDiscardPrompt] = useState<{
    sources: WindowedRowSource[];
    proceed(): void;
  } | null>(null);
  const [dbMenu, setDbMenu] = useState<DbMenuState | null>(null);
  // The import wizard: the format, and the destination when one was picked.
  const [importTarget, setImportTarget] = useState<{ format: ImportFormat; table: string | null } | null>(null);
  const [dumpTab, setDumpTab] = useState<"backup" | "restore" | null>(null);
  // Home's backup/restore: choosing which connection, then waiting for it to open.
  const [dumpPicker, setDumpPicker] = useState<{ kind: "backup" | "restore"; saved: SavedConnection[] } | null>(
    null,
  );
  const pendingDumpRef = useRef<{ target: PickTarget; kind: "backup" | "restore" } | null>(null);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [jobsRunning, setJobsRunning] = useState(0);
  const [settings, setSettings] = useState<AppSettings>(() => getSettings());
  // Rows a query run fetches at most (Settings → Data).
  const maxRows = settings.maxRows;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [, setPendingVersion] = useState(0);
  const [locked, setLocked] = useState<boolean>(() => getPasscodeHash() !== null);
  // The bottom console stays open or closed per connection, like the row
  // detail panel. historyVersion bumps after each editor run so it refetches.
  const [consolePanels, setConsolePanels] = useState<Record<string, boolean>>(() =>
    loadFlagMap(CONSOLE_PANELS_KEY),
  );
  // Font colours picked for tables, per connection (sidebar names and tabs).
  const [tableColors, setTableColors] = useState<TableColorMap>(loadTableColors);
  const [consoleHeight, setConsoleHeight] = useState<number>(() => {
    const saved = Number(window.localStorage.getItem(CONSOLE_HEIGHT_KEY));
    return Number.isFinite(saved) && saved >= CONSOLE_MIN ? saved : CONSOLE_DEFAULT;
  });
  const [historyVersion, setHistoryVersion] = useState(0);
  const [activityOpen, setActivityOpen] = useState(false);
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [paramPrompt, setParamPrompt] = useState<{
    conn: string;
    tabId: string;
    sql: string;
    params: string[];
    dialect: string;
  } | null>(null);
  const [reviewPrompt, setReviewPrompt] = useState<{
    conn: string;
    tabId: string;
    sql: string;
    items: ReviewItem[];
  } | null>(null);
  // Several statements run at once in a tab: each one's result, and which is
  // shown. Per tab, so a run in another tab leaves them.
  const [resultSets, setResultSets] = useState<
    Record<
      string,
      {
        conn: string;
        tabId: string;
        entries: { label: string; sql: string; outcome: QueryOutcome }[];
        active: number;
      }
    >
  >({});
  // Statement results go with their tab (closed, or its connection closed).
  useEffect(() => {
    setResultSets((prev) => {
      const kept = Object.fromEntries(
        Object.entries(prev).filter(([tabId, set]) => {
          const tabs = workspaces[set.conn]?.tabs;
          return tabs !== undefined && tabById(tabs, tabId) !== null;
        }),
      );
      return Object.keys(kept).length === Object.keys(prev).length ? prev : kept;
    });
  }, [workspaces]);
  // A short note shown over the window for a moment ("nothing to run"): where
  // the result pane shows rows, the message view's note wouldn't be seen.
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimerRef = useRef(0);
  const [schemaMap, setSchemaMap] = useState<Record<string, string[]>>({});
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  // null keeps the stylesheet's default width.
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(() =>
    storedWidth(SIDEBAR_WIDTH_KEY, clampSidebar),
  );
  const [detailWidth, setDetailWidth] = useState<number | null>(() =>
    storedWidth(DETAIL_WIDTH_KEY, clampDetail),
  );
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
    () =>
      subscribePendingChanges(() => {
        setPendingVersion((value) => value + 1);
        keepChangedTabsRef.current();
      }),
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
  useEffect(() => {
    // The console log used to live in this browser; history is on the server now.
    try {
      window.localStorage.removeItem("tablepeek.query-log");
    } catch {}
  }, []);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
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
            syncSavedQueryTabsRef.current(next);
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
  const workspacesRef = useRef(workspaces);
  const activeConnIdRef = useRef(activeConnId);
  const prevConnRef = useRef<string | null>(null);
  const runningTabRef = useRef(runningTabId);
  const closedDuringRunRef = useRef<string | null>(null);
  // Data tabs whose open is still reading the table's structure.
  const openingTabsRef = useRef(new Set<string>());
  const focusRequestRef = useRef(false);
  const pendingEditorSqlRef = useRef<string | null>(null);
  // Saved-query write-backs waiting for typing to stop, by saved query id.
  const savedQueryWritesRef = useRef(new Map<string, { timer: number; sql: string }>());
  const syncSavedQueryTabsRef = useRef<(queries: Favorite[]) => void>(() => undefined);
  // The text a saved query's write last failed with, so a catch-up doesn't
  // retry (and report) it on every change.
  const failedWritesRef = useRef(new Map<string, string>());
  const keepChangedTabsRef = useRef<() => void>(() => undefined);
  // Closing the page mustn't lose the last edit to a saved query's tab.
  useEffect(() => {
    function onPageHide(): void {
      editorRef.current?.flush();
      for (const [id, pending] of savedQueryWritesRef.current) {
        window.clearTimeout(pending.timer);
        void store.updateFavorite(id, { sql: pending.sql }, { keepalive: true }).catch(() => undefined);
      }
      savedQueryWritesRef.current.clear();
    }
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);
  const connectOpenRef = useRef(connectOpen);
  const fsOpenRef = useRef(fsOpen);
  const detailPanelOpenRef = useRef(false);
  const cellQuickLookRef = useRef(cellQuickLook);
  const menuRef = useRef(menu);
  const exportTargetRef = useRef(exportTarget);
  const importTargetRef = useRef(importTarget);
  const paramPromptRef = useRef(paramPrompt);
  const resultSetsRef = useRef(resultSets);
  const reviewPromptRef = useRef(reviewPrompt);
  const dumpTabRef = useRef(dumpTab);
  const jobsOpenRef = useRef(jobsOpen);
  const historyReadyRef = useRef(false);
  const historyNavRef = useRef(false);
  const paletteOpenRef = useRef(paletteOpen);
  const settingsOpenRef = useRef(settingsOpen);
  const lockedRef = useRef(locked);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const activityOpenRef = useRef(activityOpen);
  const metricsOpenRef = useRef(metricsOpen);
  const detailCacheRef = useRef(new Map<string, TableDetail>());
  const detailLoadsRef = useRef(new Map<string, Promise<TableDetail | null>>());
  const shortcutRef = useRef<(action: KeyAction) => void>(() => {});
  // Whether the app takes a key that is only its own in some places.
  const claimsKeyRef = useRef<(action: KeyAction, target: Element | null, modal: boolean) => boolean>(
    () => true,
  );
  // A result dropped by the server while changes were being applied.
  const missedInvalidateRef = useRef(false);
  const lastSelectionRef = useRef<SelectedRows | null>(null);
  // A drag changes the selection many times a frame; the panel follows once per frame.
  const selectionFrameRef = useRef(0);
  const lastStructurePickRef = useRef<{ key: string; source: RowSource; rows: SelectedRows } | null>(null);
  const structureFrameRef = useRef(0);
  const invalidateRef = useRef<() => void>(() => {});
  const applyingRef = useRef(false);
  const cycleViewRef = useRef<(delta: -1 | 1) => void>(() => {});
  const tabAtRef = useRef<(position: number) => boolean>(() => false);
  const formatRef = useRef<(mode: "beautify" | "minify") => void>(() => {});
  const serverConnRef = useRef(false);

  workspacesRef.current = workspaces;
  // What a connection's own UI state (panels, table colours) is kept under:
  // its saved connection (and the database it's on: tables of one database
  // aren't another's), else its file, which outlive the id a session gets
  // each time it opens.
  function stableKeyOf(connId: string): string {
    const conn = connsRef.current.find((entry) => entry.id === connId);
    if (conn?.saved_id) {
      const at = workspacesRef.current[connId]?.meta.path;
      return at ? `saved:${conn.saved_id}@${at}` : `saved:${conn.saved_id}`;
    }
    if (conn?.demo) {
      return "demo";
    }
    return conn?.path ? `file:${conn.path}` : connId;
  }
  const connsRef = useRef(conns);
  // Connections whose close is on its way to the server: no list fetched
  // meanwhile brings their tabs back.
  const closingConnsRef = useRef(new Set<string>());
  connsRef.current = conns;

  // A fetched connection list, seen at once by code that runs before the next
  // render (entering a connection just opened).
  function commitConns(list: ConnSummary[]): void {
    const shown = list.filter((conn) => !closingConnsRef.current.has(conn.id));
    connsRef.current = shown;
    setConns(shown);
  }

  // Where a connection's query drafts are kept: its saved connection, any
  // database on it (query tabs belong to the connection), else its stable key.
  function draftKeyOf(connId: string): string {
    const conn = connsRef.current.find((entry) => entry.id === connId);
    return conn?.saved_id ? `saved:${conn.saved_id}` : stableKeyOf(connId);
  }
  const activeKey = activeConnId !== null ? stableKeyOf(activeConnId) : null;

  activeConnIdRef.current = activeConnId;
  runningTabRef.current = runningTabId;
  connectOpenRef.current = connectOpen;
  fsOpenRef.current = fsOpen;
  // The side and bottom panels start open; closing one is what's remembered.
  detailPanelOpenRef.current = activeKey !== null && detailPanels[activeKey] !== false;
  cellQuickLookRef.current = cellQuickLook;
  menuRef.current = menu;
  exportTargetRef.current = exportTarget;
  importTargetRef.current = importTarget;
  paramPromptRef.current = paramPrompt;
  resultSetsRef.current = resultSets;
  reviewPromptRef.current = reviewPrompt;
  dumpTabRef.current = dumpTab;
  jobsOpenRef.current = jobsOpen;
  paletteOpenRef.current = paletteOpen;
  settingsOpenRef.current = settingsOpen;
  lockedRef.current = locked;
  activityOpenRef.current = activityOpen;
  metricsOpenRef.current = metricsOpen;

  const workspace = activeConnId !== null ? (workspaces[activeConnId] ?? null) : null;
  const tabs = workspace?.tabs ?? null;
  const meta = workspace?.meta ?? null;
  const home = activeConnId === null || workspace === null;
  const activeTab = tabs !== null ? activeTabOf(tabs) : null;
  const activeDataTab = activeTab !== null && activeTab.kind === "data" ? activeTab : null;
  // What the result's table says about each column (key, type, foreign key):
  // the grid colours keys and puts ⌃⌄ and → on the cells that take them.
  const resultTable = activeDataTab?.table ?? state.result?.meta.sourceTable ?? null;
  const resultDetail =
    activeDataTab?.detail ??
    (activeConnId !== null && resultTable !== null
      ? detailCacheRef.current.get(`${activeConnId}:${resultTable}`)
      : undefined);
  // A transaction the editor ended: data tabs whose rows the server dropped load
  // again when shown; rolled-back ones read their reverted rows again.
  useEffect(() => {
    function onTxEnded(event: Event): void {
      const detail = (event as CustomEvent<{
        conn: string;
        ownerId: string | null;
        rolledBack: boolean;
        invalidated: boolean;
      }>).detail;
      const ws = workspacesRef.current[detail.conn];
      if (ws === undefined || (!detail.rolledBack && !detail.invalidated)) {
        return;
      }
      let tabsState = ws.tabs;
      for (const tab of ws.tabs.tabs) {
        if ((tab.kind !== "data" && tab.kind !== "query") || tab.id === detail.ownerId || tab.source === undefined) {
          continue;
        }
        // Staged edits stay: they target rows by key, and the next reload of
        // that tab asks before dropping them.
        if (tab.source.hasPending()) {
          continue;
        }
        if (detail.invalidated && tab.kind === "data") {
          tab.source.dispose();
          tabsState = patchTab(tabsState, tab.id, { source: undefined, meta: undefined });
          autoHydratedRef.current.delete(`${detail.conn}:${tab.id}`);
        } else if (detail.invalidated) {
          // A query's rows can't be read again from a dropped session, and a
          // query isn't re-run behind the user's back: it says so instead.
          tab.source.dispose();
          tabsState = patchTab(tabsState, tab.id, {
            source: undefined,
            meta: undefined,
            info: t("결과가 만료되었습니다. 다시 실행하세요"),
          });
        } else if (detail.rolledBack) {
          // Rows read again from the server's reverted copy.
          tab.source.clearWindows();
        }
      }
      if (tabsState !== ws.tabs) {
        commitWorkspaces({ ...workspacesRef.current, [detail.conn]: { ...ws, tabs: tabsState } });
      }
      // A run's other statements' results went with their sessions, or hold
      // rows the rollback reverted.
      if (detail.invalidated) {
        dropResultSets(detail.conn);
      } else {
        for (const set of Object.values(resultSetsRef.current)) {
          if (set.conn !== detail.conn || set.tabId === detail.ownerId) {
            continue;
          }
          for (const entry of set.entries) {
            if (entry.outcome.kind === "ok" && !entry.outcome.result.source.hasPending()) {
              entry.outcome.result.source.clearWindows();
            }
          }
        }
      }
    }
    window.addEventListener("tablepeek:tx-ended", onTxEnded);
    return () => window.removeEventListener("tablepeek:tx-ended", onTxEnded);
  }, []);

  // The connection's open transaction follows the store, so re-activating the
  // workspace (a refresh, a connection switch) brings the TX controls back.
  useEffect(() => {
    const conn = state.connId;
    const ws = conn !== null ? workspacesRef.current[conn] : undefined;
    if (conn !== null && ws !== undefined && ws.tx !== state.tx) {
      commitWorkspaces({ ...workspacesRef.current, [conn]: { ...ws, tx: state.tx } });
    }
  }, [state.connId, state.tx]);

  // A data tab without its table's structure (restored after a reload, opened
  // by a foreign key) reads it, so keys and cell buttons show.
  const missingDetail = activeDataTab !== null && activeDataTab.detail === undefined;
  useEffect(() => {
    const conn = activeConnId;
    const tab = activeDataTab;
    // A tab still being opened reads its structure itself.
    if (conn === null || tab === null || !missingDetail || openingTabsRef.current.has(tab.id)) {
      return;
    }
    void ensureDetail(conn, tab.table).then((detail) => {
      const latest = detail === null ? null : tabsOf(conn);
      const target = latest !== null ? tabById(latest, tab.id) : null;
      if (latest !== null && target !== null && target.kind === "data" && target.detail === undefined) {
        setTabsFor(conn, patchTab(latest, tab.id, { detail: detail ?? undefined }));
      }
    });
    // ensureDetail and the tab helpers read refs; the tab's id is what matters.
  }, [activeConnId, activeDataTab?.id, missingDetail]);
  // A menu belongs to the rows it was opened on.
  useEffect(() => {
    setMenu((current) => (current !== null && current.result !== state.result ? null : current));
  }, [state.result]);
  const gridSpecs = useMemo(
    () =>
      state.result === null
        ? null
        : withResultKinds(
            specsForTable(state.result.meta.columns, resultDetail, meta?.kind ?? ""),
            state.result.meta.columnKinds,
            state.result.meta.columns.length,
          ),
    [state.result, resultDetail, meta?.kind],
  );
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

  // Closed query tabs this connection can bring back: SQL saved when they
  // closed (or last typed), not open now.
  function closedDrafts(conn: string): { tabId: string; draft: QueryDraft }[] {
    const key = draftKeyOf(conn);
    adoptDrafts(conn, key);
    const open = new Set((tabsOf(conn)?.tabs ?? []).map((tab) => tab.id));
    return listDrafts(key).filter((entry) => !open.has(entry.tabId));
  }

  // The closed numbered query tabs a new tab brings back, lowest number first;
  // renamed tabs, plans and saved queries stay in the palette's drafts.
  function reopenableDrafts(conn: string): { tabId: string; draft: QueryDraft }[] {
    return closedDrafts(conn)
      .filter((entry) => !entry.draft.favorite && queryNumberOf(entry.draft.title) !== null)
      .sort((a, b) => (queryNumberOf(a.draft.title) ?? 0) - (queryNumberOf(b.draft.title) ?? 0));
  }

  // A new query tab's number: the smallest one neither an open tab nor a
  // closed tab waiting to come back uses.
  function nextQueryNumber(conn: string): number {
    const open = (tabsOf(conn)?.tabs ?? []).filter((tab) => tab.kind === "query").map((tab) => tab.title);
    return freeQueryNumber([...open, ...reopenableDrafts(conn).map((entry) => entry.draft.title)]);
  }

  // The tab a connection opens with: the first closed query tab, else a new
  // one seeded with a query on its first table.
  function firstTabOf(conn: string, meta: EngineMeta): WorkbenchTab {
    const reopen = reopenableDrafts(conn)[0];
    if (reopen === undefined) {
      return createQueryTab(nextQueryNumber(conn), seedSqlForMeta(meta));
    }
    removeDraft(draftKeyOf(conn), reopen.tabId);
    return { ...createQueryTab(1, reopen.draft.sql), title: reopen.draft.title };
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
      const view = tabById(current, tabId)?.kind === "data" ? "grid" : viewOfOutcome(outcome);
      if (view !== null) {
        setResultView(view);
      }
    }
    const existing = tabById(current, tabId);
    // The tab closed (or was replaced) while its run was out: nothing shows it.
    if (existing === null) {
      if (outcome.kind === "ok") {
        outcome.result.source.dispose();
      }
      return false;
    }
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

  // False when nothing started: the connection is busy, staged changes are
  // waiting on the discard warning, or the workspace is gone.
  function runDataWith(conn: string, tab: DataTab, spec: DataRunSpec): boolean {
    const current = store.getState();
    if (current.status === "running" && current.connId === conn) {
      return false;
    }
    const known = tabsOf(conn);
    const live = known !== null ? tabById(known, tab.id) : null;
    if (live !== null && live.kind === "data" && !guardPending([live.source], () => runDataWith(conn, tab, spec))) {
      return false;
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
      return false;
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
    // A reload of what the tab shows (Refresh, F5) counts again; paging or
    // sorting keeps the count of the same filter.
    const reload =
      spec.offset === tab.offset &&
      spec.pageSize === tab.pageSize &&
      JSON.stringify(spec.filter ?? null) === JSON.stringify(tab.filter ?? null) &&
      JSON.stringify(spec.sorts ?? null) === JSON.stringify(tab.sorts ?? null);
    const countKey = buildWhere(spec.filter, meta?.kind ?? "") ?? "";
    void store.runQuery(conn, sql, spec.pageSize, tab.id).then((outcome) => {
      // A run for another tab may already have started (the next table's load).
      setRunningTabId((value) => (value === tab.id ? null : value));
      const applied = handleOutcome(conn, tab.id, outcome);
      if (!applied || outcome.kind !== "ok") {
        return;
      }
      if (outcome.result.meta.rowCount === 0 && spec.offset > 0) {
        const back = Math.max(0, spec.offset - spec.pageSize);
        runDataWith(conn, { ...tab, meta: outcome.result.meta }, { ...spec, offset: back });
        return;
      }
      const rows = outcome.result.meta.rowCount;
      if (!outcome.result.meta.truncated && rows < spec.pageSize) {
        // The last page: the total needs no count.
        const latest = tabsOf(conn);
        if (latest !== null) {
          setTabsFor(conn, patchTab(latest, tab.id, { count: spec.offset + rows, countFilter: countKey }));
        }
      } else if (tab.count !== undefined && (tab.countFilter ?? "") === countKey) {
        // Counted already: a reload (Refresh, the rerun after Apply) brings
        // the count up to date; paging or sorting doesn't change it.
        if (reload) {
          void refreshCount(conn, tab.id, false);
        }
      } else {
        autoCount(conn, tab.id, tab.table);
      }
    });
    return true;
  }

  // Counts a table's rows as TablePlus does when it opens, unless its size
  // says COUNT(*) would hold the connection long; the footer offers it then.
  function autoCount(conn: string, tabId: string, table: string): void {
    const key = `${conn}:${table}`;
    if (detailFailedRef.current.has(key)) {
      return;
    }
    void ensureDetail(conn, table).then((detail) => {
      if (detail === null) {
        detailFailedRef.current.add(key);
        return;
      }
      // No estimate (or 0, which an unanalyzed or partitioned Postgres table
      // reports) leaves its size to judge by, and a size of 0 (a partitioned
      // parent has no storage of its own) says nothing.
      const estimate = detail.row_count_estimate;
      const bytes = detail.size_bytes;
      const small =
        estimate !== null && estimate > 0
          ? estimate <= AUTO_COUNT_MAX
          : bytes !== null && bytes > 0 && bytes <= AUTO_COUNT_BYTES;
      if (small) {
        void refreshCount(conn, tabId, false);
      }
    });
  }

  function dataSpecOf(tab: DataTab, offset: number, pageSize: number): DataRunSpec {
    return { offset, pageSize, filter: tab.filter ?? null, sorts: tab.sorts ?? null };
  }

  // Counts the rows the tab's filter keeps. `asked`: the user clicked for it,
  // so a failure says so (an automatic count fails quietly).
  async function refreshCount(conn: string, tabId: string, asked = true): Promise<void> {
    const current = tabsOf(conn);
    const tab = current !== null ? tabById(current, tabId) : null;
    if (tab === null || tab.kind !== "data") {
      return;
    }
    const kind = meta?.kind ?? "";
    const countKey = buildWhere(tab.filter ?? null, kind) ?? "";
    if (!asked && (workspacesRef.current[conn]?.tx === "active" || store.inOwnTx(conn))) {
      // Inside a transaction a count cut short by the next query would abort
      // it (Postgres), so none runs on its own; the one shown may be stale.
      // While an import or restore holds the connection, likewise.
      if (tab.count !== undefined && current !== null) {
        setTabsFor(conn, patchTab(current, tabId, { count: undefined, countFilter: undefined }));
      }
      return;
    }
    // Only the latest count of a tab lands; an older one finishing late is dropped.
    const seq = (countSeqRef.current.get(tabId) ?? 0) + 1;
    countSeqRef.current.set(tabId, seq);
    setCountingTabId(tabId);
    try {
      const result = await store.exec(conn, buildCountSql({ kind, table: tab.table, filter: tab.filter ?? null }));
      const count = Number(result.rows[0]?.[0]);
      if (!Number.isFinite(count)) {
        throw new Error(t("행 수를 계산하지 못했습니다"));
      }
      const latest = tabsOf(conn);
      const latestTab = latest !== null ? tabById(latest, tabId) : null;
      // A filter changed meanwhile has its own count coming.
      if (
        countSeqRef.current.get(tabId) === seq &&
        latest !== null &&
        latestTab !== null &&
        latestTab.kind === "data" &&
        (buildWhere(latestTab.filter ?? null, kind) ?? "") === countKey
      ) {
        setTabsFor(conn, patchTab(latest, tabId, { count, countFilter: countKey }));
      }
    } catch (err) {
      if (asked && countSeqRef.current.get(tabId) === seq) {
        store.setError(errorOf(err, t("행 수를 계산하지 못했습니다")));
      }
    } finally {
      if (countSeqRef.current.get(tabId) === seq) {
        setCountingTabId((value) => (value === tabId ? null : value));
      }
    }
  }

  // The footer's total: the count for the filter shown, else (no filter) the
  // driver's estimate.
  function totalOf(conn: string, tab: DataTab): DataTotal | null {
    const counted = countFor(tab, meta?.kind ?? "");
    if (counted !== null) {
      return { rows: counted, exact: true };
    }
    const unfiltered = (buildWhere(tab.filter ?? null, meta?.kind ?? "") ?? "") === "";
    const estimate = unfiltered ? detailCacheRef.current.get(`${conn}:${tab.table}`)?.row_count_estimate : null;
    return estimate !== null && estimate !== undefined && estimate >= 0 ? { rows: estimate, exact: false } : null;
  }

  function applyColumns(tab: DataTab, columns: string[] | undefined): void {
    const conn = activeConnIdRef.current;
    if (conn === null || !guardPending([tab.source], () => applyColumns(tab, columns))) {
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
      store.setInfo(t("최소 한 개의 컬럼이 필요합니다"));
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
    if (
      owner !== null &&
      owner.kind === "query" &&
      !guardPending([owner.source], () => executeStatements(conn, tabId, statements, wrapTx))
    ) {
      return;
    }
    setRunningTabId(tabId);
    setResultSets((prev) => {
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    void (async () => {
      const outcomes: QueryOutcome[] = [];
      try {
        if (wrapTx) {
          await store.beginTx();
        }
        for (const statement of statements) {
          const outcome = await store.runQuery(conn, statement, maxRows, tabId, true);
          outcomes.push(outcome);
          if (outcome.kind !== "ok") {
            break;
          }
        }
      } catch (err) {
        setRunningTabId((value) => (value === tabId ? null : value));
        setHistoryVersion((value) => value + 1);
        store.setError(errorOf(err, t("쿼리를 실행하지 못했습니다")));
        return;
      }
      setRunningTabId((value) => (value === tabId ? null : value));
      setHistoryVersion((value) => value + 1);
      // A statement may have changed rows, structure or sizes.
      forgetTableDetails();
      // A table or view made, dropped or altered shows in the sidebar at once.
      const dialect = meta?.kind ?? "";
      if (
        conn === activeConnIdRef.current &&
        statements.slice(0, outcomes.length).some((sql) => changesSchema(sql, dialect))
      ) {
        setMetaNonce((value) => value + 1);
        void refreshActiveMeta();
      }
      const last = outcomes[outcomes.length - 1];
      if (last !== undefined) {
        handleOutcome(conn, tabId, last);
      }
      if (statements.length > 1 && outcomes.length > 0) {
        setResultSets((prev) => ({
          ...prev,
          [tabId]: {
            conn,
            tabId,
            entries: outcomes.map((outcome, index) => ({
              // Not "쿼리 N": that's how query tabs are named.
              label: t("결과 {count}", { count: index + 1 }),
              sql: statements[index] ?? "",
              outcome,
            })),
            // The last statement's result is the one shown first.
            active: outcomes.length - 1,
          },
        }));
      }
    })();
  }

  function startRun(conn: string, tabId: string, sqlText: string): void {
    if (store.inOwnTx(conn)) {
      store.setError(t("가져오기가 진행 중입니다. 끝난 뒤 다시 실행하세요."));
      return;
    }
    const dialect = meta?.kind ?? "";
    const statements = splitSqlStatements(sqlText, dialect);
    // Every statement is checked, not just the first one.
    const items = reviewStatements(statements, alertMode, dialect);
    if (items.length > 0) {
      setReviewPrompt({ conn, tabId, sql: sqlText, items });
      return;
    }
    executeStatements(conn, tabId, statements);
  }

  // ⌘↵ (Run Current) runs the selection, else the statement the cursor is in;
  // ⇧⌘↵ (Run All) every statement in the editor. Comments alone never run.
  function run(scope: "current" | "all" = "current"): void {
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
    const editor = editorRef.current;
    const picked =
      editor === null ? tab.sql : scope === "all" ? editor.getDoc() : editor.currentStatement();
    const sqlText = (picked ?? "").trim();
    if (sqlText === "" || splitSqlStatements(sqlText, meta?.kind ?? "").length === 0) {
      notify(t("실행할 쿼리가 없습니다"));
      return;
    }
    const dialect = meta?.kind ?? "";
    const params = extractParams(sqlText, dialect);
    if (params.length > 0) {
      setParamPrompt({ conn, tabId: tab.id, sql: sqlText, params, dialect });
      return;
    }
    startRun(conn, tab.id, sqlText);
  }

  // A connection's statement results, once their sessions are gone.
  function dropResultSets(conn: string): void {
    setResultSets((prev) => {
      const kept = Object.fromEntries(Object.entries(prev).filter(([, set]) => set.conn !== conn));
      return Object.keys(kept).length === Object.keys(prev).length ? prev : kept;
    });
  }

  function notify(message: string): void {
    window.clearTimeout(flashTimerRef.current);
    setFlash(message);
    flashTimerRef.current = window.setTimeout(() => setFlash(null), 2400);
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
    startRun(prompt.conn, prompt.tabId, bindParams(prompt.sql, values, quoteLiteral, prompt.dialect));
  }

  function runReviewed(wrapTx: boolean): void {
    const review = reviewPrompt;
    setReviewPrompt(null);
    if (review === null) {
      return;
    }
    executeStatements(review.conn, review.tabId, splitSqlStatements(review.sql, meta?.kind ?? ""), wrapTx);
  }

  function setAlertMode(mode: SafeMode): void {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      return;
    }
    const previous = safeModeChoices[conn];
    const seq = (safeModeSeqRef.current[conn] ?? 0) + 1;
    safeModeSeqRef.current[conn] = seq;
    setSafeModeChoices((prev) => ({ ...prev, [conn]: mode }));
    store.setSafeMode(conn, mode).catch((err: unknown) => {
      // A newer choice already replaced this one; leave it be.
      if (safeModeSeqRef.current[conn] !== seq) {
        return;
      }
      setSafeModeChoices((prev) => {
        const next = { ...prev };
        if (previous === undefined) {
          delete next[conn];
        } else {
          next[conn] = previous;
        }
        return next;
      });
      store.setError(errorOf(err, t("안전 모드를 저장하지 못했습니다")));
    });
  }

  function cycleAlertMode(): void {
    setAlertMode(((alertMode + 1) % 3) as SafeMode);
  }

  function formatCurrent(mode: "beautify" | "minify"): void {
    const tab = currentTab();
    if (tab === null || tab.kind !== "query") {
      return;
    }
    const dialect = meta?.kind ?? "";
    editorRef.current?.format((sqlText) => {
      if (sqlText.trim() === "") {
        return sqlText;
      }
      const prepared =
        mode === "minify" && settingsRef.current.uppercaseKeywords ? uppercaseSql(sqlText, dialect) : sqlText;
      return formatSql(prepared, mode, dialect);
    });
  }

  function showResultChip(index: number): void {
    const resultChips = activeTab !== null ? (resultSets[activeTab.id] ?? null) : null;
    const entry = resultChips?.entries[index];
    if (resultChips === null || entry === undefined) {
      return;
    }
    const current = tabsOf(resultChips.conn);
    if (current === null) {
      return;
    }
    const owner = tabById(current, resultChips.tabId);
    if (owner !== null && owner.kind === "query" && !guardPending([owner.source], () => showResultChip(index))) {
      return;
    }
    setResultSets((prev) => ({ ...prev, [resultChips.tabId]: { ...resultChips, active: index } }));
    // The pane follows: a failed statement's message, a plan, or the rows.
    setResultView(viewOfOutcome(entry.outcome) ?? "grid");
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
    // A number an open tab took meanwhile goes to the next free one.
    const taken = queryNumberOf(title) !== null && current.tabs.some((tab) => tab.title === title);
    const tab = taken ? createQueryTab(nextQueryNumber(conn), sql) : { ...createQueryTab(1, sql), title };
    setTabsFor(conn, { tabs: [...current.tabs, tab], activeId: tab.id });
    store.showSnapshot(conn, snapshotOf(tab));
    removeDraft(draftKeyOf(conn), tabId);
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
    // As TablePlus does: the query tabs closed earlier come back first, lowest
    // number first, with their SQL; a fresh one only when none is left.
    const reopen = reopenableDrafts(conn)[0];
    if (reopen !== undefined) {
      openDraftTab(reopen.tabId, reopen.draft.sql, reopen.draft.title);
      return;
    }
    const next = addTab(current, nextQueryNumber(conn));
    setTabsFor(conn, next);
    const tab = activeTabOf(next);
    if (tab) {
      store.showSnapshot(conn, snapshotOf(tab));
    }
    focusRequestRef.current = true;
  }

  // `force` closes without asking about staged changes: their table is gone.
  function closeTabById(id: string, force = false): void {
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
    if (force) {
      stagedSources([tab]).forEach((source) => source?.discardPending());
    } else if (!guardPending(stagedSources([tab]), () => closeTabById(id))) {
      return;
    }
    if (runningTabRef.current === id) {
      stopRunOf(conn, id);
    }
    const wasActive = current.activeId === id;
    if (tab.kind === "query") {
      const sql = wasActive ? (editorRef.current?.getDoc() ?? tab.sql) : tab.sql;
      if (sql.trim() !== "") {
        saveDraft(draftKeyOf(conn), id, sql, tab.title, 0, tab.favoriteId !== undefined);
      } else {
        removeDraft(draftKeyOf(conn), id);
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

  // Refresh (F5) as in TablePlus: the schema is read again, and a table in
  // front reloads its rows, after asking about any staged changes.
  function refreshView(): void {
    const conn = activeConnIdRef.current;
    const tab = currentTab();
    if (conn === null || tab === null || tab.kind !== "data" || (tab.view ?? "data") !== "data") {
      void refreshActiveMeta();
      return;
    }
    if (!guardPending([tab.source], refreshView)) {
      return;
    }
    const tabId = tab.id;
    void refreshActiveMeta().then(() => {
      const latest = tabsOf(conn);
      const target = latest !== null ? tabById(latest, tabId) : null;
      if (target !== null && target.kind === "data") {
        runDataWith(conn, target, dataSpecOf(target, target.offset, target.pageSize));
      }
    });
  }

  // A row added, edited or deleted in the temporary tab keeps it.
  function keepChangedTabs(): void {
    let next = workspacesRef.current;
    for (const [conn, ws] of Object.entries(workspacesRef.current)) {
      let tabsState = ws.tabs;
      for (const tab of ws.tabs.tabs) {
        if (tab.kind === "data" && tab.preview && (tab.source?.hasPending() ?? false)) {
          tabsState = patchTab(tabsState, tab.id, { preview: false });
        }
      }
      if (tabsState !== ws.tabs) {
        next = { ...next, [conn]: { ...ws, tabs: tabsState } };
      }
    }
    if (next !== workspacesRef.current) {
      commitWorkspaces(next);
    }
  }
  keepChangedTabsRef.current = keepChangedTabs;

  // Staged grid changes are dropped only after the user agrees (TablePlus's
  // "Discard all changes?"). True when there are none; otherwise asks, and on
  // Discard drops them and runs `proceed`, which repeats the interrupted action.
  function guardPending(sources: (WindowedRowSource | null | undefined)[], proceed: () => void): boolean {
    const staged = sources.filter((source): source is WindowedRowSource => source?.hasPending() ?? false);
    if (staged.length === 0) {
      return true;
    }
    setDiscardPrompt({ sources: staged, proceed });
    return false;
  }

  function stagedSources(tabs: WorkbenchTab[]): (WindowedRowSource | undefined)[] {
    return tabs.map((tab) => (tab.kind === "query" || tab.kind === "data" ? tab.source : undefined));
  }

  // A tab going away mid-run: its result is dropped when it lands. The query
  // is cancelled too, except inside a transaction, where a cancel would abort
  // it (PostgreSQL) or end the session (SQL Server); there it runs out.
  function stopRunOf(conn: string, tabId: string): void {
    closedDuringRunRef.current = tabId;
    if (store.getState().tx !== "active") {
      store.cancelQuery(conn);
    }
    setRunningTabId(null);
  }

  // The temporary tab becomes a kept one: a double-click, or a change in it.
  function pinTab(id: string, conn = activeConnIdRef.current): void {
    if (conn === null) {
      return;
    }
    const current = tabsOf(conn);
    const tab = current !== null ? tabById(current, id) : null;
    if (current !== null && tab !== null && tab.kind === "data" && tab.preview) {
      setTabsFor(conn, patchTab(current, id, { preview: false }));
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
    saveDraft(draftKeyOf(conn), tabId, sql, tab.title, 400, tab.favoriteId !== undefined);
    setTabsFor(conn, patchTab(current, tabId, { sql }));
    if (tab.favoriteId !== undefined && loadAutoSave()) {
      queueSavedQueryWrite(conn, tabId, tab.favoriteId, sql);
    }
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
    // A saved query's own tab keeps its text: the SQL goes elsewhere.
    const bound = (tab: WorkbenchTab): boolean => tab.kind === "query" && tab.favoriteId !== undefined;
    let target = activeTabOf(current);
    if (target === null || target.kind === "data" || bound(target)) {
      const queryTabs = current.tabs.filter((tab) => tab.kind === "query" && !bound(tab));
      target = queryTabs.length > 0 ? queryTabs[queryTabs.length - 1] : null;
    }
    if (target === null) {
      const tab = createQueryTab(nextQueryNumber(conn), sql);
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
    openInQueryEditor(firstRowsSql(meta?.kind ?? "", quoted));
  }

  function openSqlTab(sql: string, title: string): void {
    openQueryTab(sql, { title });
  }

  // A new editor tab holding `sql`; returns its id.
  function openQueryTab(sql: string, options?: { title?: string; favoriteId?: string }): string | null {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      return null;
    }
    const current = tabsOf(conn);
    if (current === null) {
      return null;
    }
    const created = createQueryTab(nextQueryNumber(conn), sql);
    const tab: WorkbenchTab = {
      ...created,
      title: options?.title ?? created.title,
      favoriteId: options?.favoriteId,
      favoriteSql: options?.favoriteId === undefined ? undefined : sql,
    };
    setTabsFor(conn, { tabs: [...current.tabs, tab], activeId: tab.id });
    store.showSnapshot(conn, snapshotOf(tab));
    focusRequestRef.current = true;
    return tab.id;
  }

  // History's and Queries' "Run": a new tab that runs straight away.
  function runInNewTab(sql: string): void {
    const conn = activeConnIdRef.current;
    const text = sql.trim();
    if (conn === null) {
      return;
    }
    if (splitSqlStatements(text, meta?.kind ?? "").length === 0) {
      notify(t("실행할 쿼리가 없습니다"));
      return;
    }
    const tabId = openQueryTab(sql);
    if (tabId === null) {
      return;
    }
    if (store.getState().status === "running") {
      notify(t("다른 쿼리가 실행 중입니다. 끝난 뒤 실행하세요"));
      return;
    }
    const dialect = meta?.kind ?? "";
    const params = extractParams(text, dialect);
    if (params.length > 0) {
      setParamPrompt({ conn, tabId, sql: text, params, dialect });
      return;
    }
    startRun(conn, tabId, text);
  }

  // At the cursor of the editor in front, or in a new tab when none is.
  function insertIntoEditor(sql: string): void {
    const tab = currentTab();
    if (tab !== null && tab.kind === "query" && editorRef.current !== null) {
      editorRef.current.insertText(sql);
      return;
    }
    openQueryTab(sql);
  }

  // A saved query's own tab: brought forward when already open.
  function openSavedQuery(query: Favorite): void {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      return;
    }
    const current = tabsOf(conn);
    if (current === null) {
      return;
    }
    const open = current.tabs.find((tab) => tab.kind === "query" && tab.favoriteId === query.id);
    if (open === undefined) {
      openQueryTab(query.sql, { title: query.name, favoriteId: query.id });
      return;
    }
    if (open.id !== current.activeId) {
      const next = activateTab(current, open.id);
      setTabsFor(conn, next);
      store.showSnapshot(conn, snapshotOf(open));
    }
    focusRequestRef.current = true;
  }

  // Writes a saved query's tab back to it shortly after typing stops.
  function queueSavedQueryWrite(conn: string, tabId: string, favoriteId: string, sql: string): void {
    const pending = savedQueryWritesRef.current;
    window.clearTimeout(pending.get(favoriteId)?.timer);
    const timer = window.setTimeout(() => {
      pending.delete(favoriteId);
      store
        .updateFavorite(favoriteId, { sql })
        .then(() => {
          failedWritesRef.current.delete(favoriteId);
          const tabs = tabsOf(conn);
          if (tabs !== null) {
            setTabsFor(conn, patchTab(tabs, tabId, { favoriteSql: sql }));
          }
        })
        .catch((err: unknown) => {
          // Deleted meanwhile: the tab goes on as a plain query.
          if (err instanceof ApiRequestError && err.code === "not_found") {
            const tabs = tabsOf(conn);
            if (tabs !== null) {
              setTabsFor(conn, patchTab(tabs, tabId, { favoriteId: undefined, favoriteSql: undefined }));
            }
            return;
          }
          failedWritesRef.current.set(favoriteId, sql);
          store.setError(errorOf(err, t("쿼리를 저장하지 못했습니다")));
        });
    }, 600);
    pending.set(favoriteId, { timer, sql });
  }

  function hasStagedRows(): boolean {
    return store.getState().result?.source.hasPending() ?? false;
  }

  // ⌘S in a saved query's tab: written back now, auto-save or not.
  function saveQueryTab(tabId: string, favoriteId: string): void {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      return;
    }
    editorRef.current?.flush();
    const tabs = tabsOf(conn);
    const tab = tabs !== null ? tabById(tabs, tabId) : null;
    if (tab === null || tab.kind !== "query") {
      return;
    }
    const pending = savedQueryWritesRef.current.get(favoriteId);
    if (pending !== undefined) {
      window.clearTimeout(pending.timer);
      savedQueryWritesRef.current.delete(favoriteId);
    }
    const sql = tab.sql;
    store
      .updateFavorite(favoriteId, { sql })
      .then(() => {
        const latest = tabsOf(conn);
        if (latest !== null) {
          setTabsFor(conn, patchTab(latest, tabId, { favoriteSql: sql }));
        }
        store.setInfo(t("쿼리를 저장했습니다: {name}", { name: tab.title }));
      })
      .catch((err: unknown) => store.setError(errorOf(err, t("쿼리를 저장하지 못했습니다"))));
  }

  // Saved queries changed (edited, renamed or deleted from the Queries tab):
  // their tabs follow, unless they hold edits not yet written back.
  function syncSavedQueryTabs(queries: Favorite[]): void {
    const byId = new Map(queries.map((query) => [query.id, query]));
    const activeConn = activeConnIdRef.current;
    let next = workspacesRef.current;
    let activeSql: string | null = null;
    for (const [conn, ws] of Object.entries(workspacesRef.current)) {
      let tabsState = ws.tabs;
      for (const tab of ws.tabs.tabs) {
        if (tab.kind !== "query" || tab.favoriteId === undefined) {
          continue;
        }
        const saved = byId.get(tab.favoriteId);
        if (saved === undefined) {
          tabsState = patchTab(tabsState, tab.id, { favoriteId: undefined, favoriteSql: undefined });
          continue;
        }
        if (saved.name !== tab.title) {
          tabsState = patchTab(tabsState, tab.id, { title: saved.name });
        }
        // Compared without surrounding whitespace: the server trims a new
        // query's text, and a trailing newline is no edit worth undoing.
        const writing = savedQueryWritesRef.current.has(saved.id);
        const untouched = sameSql(tab.sql, tab.favoriteSql) && !writing;
        if (!sameSql(saved.sql, tab.favoriteSql) && untouched) {
          tabsState = patchTab(tabsState, tab.id, { sql: saved.sql, favoriteSql: saved.sql });
          saveDraft(draftKeyOf(conn), tab.id, saved.sql, saved.name, 400, true);
          if (conn === activeConn && tab.id === ws.tabs.activeId) {
            activeSql = saved.sql;
          } else {
            editorRef.current?.forget(tab.id);
          }
        } else if (
          !sameSql(tab.sql, tab.favoriteSql) &&
          !writing &&
          failedWritesRef.current.get(saved.id) !== tab.sql &&
          loadAutoSave()
        ) {
          // An edit that never reached the server (the page closed first, or
          // the write was too large to send while closing) catches up now.
          queueSavedQueryWrite(conn, tab.id, saved.id, tab.sql);
        }
      }
      if (tabsState !== ws.tabs) {
        next = { ...next, [conn]: { ...ws, tabs: tabsState } };
      }
    }
    if (next !== workspacesRef.current) {
      commitWorkspaces(next);
    }
    if (activeSql !== null) {
      editorRef.current?.setSql(activeSql);
    }
  }
  syncSavedQueryTabsRef.current = syncSavedQueryTabs;

  // The editor's "Add to Queries": the whole editor becomes a saved query this
  // tab then writes back to; a selection is saved on its own.
  async function addEditorToQueries(name: string): Promise<string | null> {
    const conn = activeConnIdRef.current;
    const tab = currentTab();
    const editor = editorRef.current;
    if (conn === null || tab === null || tab.kind !== "query" || editor === null) {
      return null;
    }
    const whole = editor.getDoc();
    const picked = editor.getSql();
    const sql = picked.trim() === "" ? whole : picked;
    try {
      const id = await store.createFavorite(name, sql);
      if (sql === whole) {
        const tabs = tabsOf(conn);
        if (tabs !== null) {
          setTabsFor(conn, patchTab(tabs, tab.id, { favoriteId: id, favoriteSql: sql, title: name }));
        }
      }
      return null;
    } catch (err) {
      return errorOf(err, t("쿼리를 저장하지 못했습니다"));
    }
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

  // A plain open goes to the temporary tab (TablePlus's italic one), replacing
  // the table it showed; `pin` (a double-click) and `newTab` keep a tab.
  function openDataTab(table: string, options?: { view?: TableView; newTab?: boolean; pin?: boolean }): void {
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
      let next = current;
      if (options?.view !== undefined && (existing.view ?? "data") !== options.view) {
        next = patchTab(next, existing.id, { view: options.view });
        if (options.view !== "data") {
          void ensureDetail(conn, table);
        }
      }
      if (options?.pin && existing.preview) {
        next = patchTab(next, existing.id, { preview: false });
      }
      if (next !== current) {
        setTabsFor(conn, next);
      }
      activate(existing.id);
      // A tab restored before its rows ever came (a reload mid-load) loads now,
      // unless its own open is still under way (the second click of a double).
      if (
        existing.source === undefined &&
        existing.meta === undefined &&
        !openingTabsRef.current.has(existing.id) &&
        (options?.view ?? existing.view ?? "data") === "data"
      ) {
        runDataWith(conn, existing, dataSpecOf(existing, existing.offset, existing.pageSize));
      }
      return;
    }
    const keep = options?.newTab === true || options?.pin === true;
    // The temporary tab takes the new table in its place, unless it holds
    // staged changes (those keep it). A load still running in it is cancelled.
    const reused = keep
      ? undefined
      : current.tabs.find(
          (entry): entry is DataTab =>
            entry.kind === "data" && entry.preview === true && !(entry.source?.hasPending() ?? false),
        );
    const created = createDataTab(table, undefined, meta?.kind ?? "postgres");
    const tab: DataTab = {
      ...created,
      ...(options?.view !== undefined ? { view: options.view } : {}),
      ...(reused !== undefined ? { slot: reused.slot ?? reused.id } : {}),
      preview: !keep,
    };
    let next: TabsState;
    if (reused !== undefined) {
      if (runningTabRef.current === reused.id) {
        stopRunOf(conn, reused.id);
      }
      reused.source?.dispose();
      next = {
        tabs: current.tabs.map((entry) => (entry.id === reused.id ? tab : entry)),
        activeId: tab.id,
      };
    } else {
      next = { tabs: [...current.tabs, tab], activeId: tab.id };
    }
    setTabsFor(conn, next);
    store.showSnapshot(conn, snapshotOf(tab));
    openingTabsRef.current.add(tab.id);
    void ensureDetail(conn, table).then((detail) => {
      openingTabsRef.current.delete(tab.id);
      if (detail !== null) {
        const latestDetail = tabsOf(conn);
        const targetDetail = latestDetail !== null ? tabById(latestDetail, tab.id) : null;
        if (latestDetail !== null && targetDetail !== null && targetDetail.kind === "data") {
          setTabsFor(conn, patchTab(latestDetail, tab.id, { detail }));
        }
      }
      // Rows load on the Data view: the one the tab is on now, which may not
      // be the one it opened on (switched while the structure was read).
      const latest = tabsOf(conn);
      const target = latest !== null ? tabById(latest, tab.id) : null;
      // Rows a refresh already brought (while the structure was read) stay,
      // with whatever filter that refresh used.
      if (
        target === null ||
        target.kind !== "data" ||
        (target.view ?? "data") !== "data" ||
        target.source !== undefined
      ) {
        return;
      }
      // This is the tab's load; the auto-load below must not run it again
      // (after a failure, say). If the connection was busy it didn't start,
      // and the auto-load picks the tab up once the connection is free.
      const started = runDataWith(conn, target, {
        offset: 0,
        pageSize: target.pageSize,
        filter: null,
        sorts: null,
      });
      if (started) {
        autoHydratedRef.current.add(`${conn}:${tab.id}`);
      }
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
    // One read per table at a time: a second ask waits for the first.
    const pending = detailLoadsRef.current.get(key);
    if (pending !== undefined) {
      return pending;
    }
    const load = store
      .fetchTableDetail(conn, table)
      .then((detail) => {
        cache.set(key, detail);
        return detail;
      })
      .catch(() => null)
      .finally(() => {
        if (detailLoadsRef.current.get(key) === load) {
          detailLoadsRef.current.delete(key);
        }
      });
    detailLoadsRef.current.set(key, load);
    return load;
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

  // Staged inserts copying rows `from`…`to` (TablePlus's Duplicate); key
  // columns are left to their defaults.
  async function duplicateRows(from: number, to: number): Promise<void> {
    const result = store.getState().result;
    if (!result || result.meta.sourceTable === null) {
      store.setInfo(t("행을 추가할 수 없는 결과입니다"));
      return;
    }
    const source = result.source;
    const pkNames = new Set(result.meta.pk ?? []);
    let values: unknown[][];
    try {
      values = await rangeValues(source, from, to, rangeOf(0, result.meta.columns.length - 1));
    } catch (err) {
      store.setError(errorOf(err, t("행을 불러오지 못했습니다")));
      return;
    }
    // Another result came while the rows loaded: the copies belong to this one.
    if (store.getState().result !== result) {
      return;
    }
    let first: number | null = null;
    let last: number | null = null;
    for (let offset = 0; offset < values.length; offset += 1) {
      const row = from + offset;
      const fromInsert = source.isInserted(row);
      const staged = new Map<number, string | null>();
      const exprs: [number, StagedExpr][] = [];
      result.meta.columns.forEach((column, index) => {
        // Columns still at DEFAULT on a staged row stay DEFAULT on the copy,
        // and a staged DEFAULT or NOW() stays that, not its label.
        const untouched = fromInsert && source.cellState(row, index) === "default";
        const expr = source.stagedExpr(row, index);
        if (pkNames.has(column) || untouched) {
          return;
        }
        if (expr !== null) {
          exprs.push([index, expr]);
        } else {
          staged.set(index, cellToString(values[offset][index]));
        }
      });
      const created = store.stageInsert(staged);
      if (created === null) {
        break;
      }
      for (const [index, expr] of exprs) {
        // DEFAULT on a new row is the column left out.
        if (expr.expr === "now") {
          store.setCellExpr(created, index, expr);
        }
      }
      first ??= created;
      last = created;
    }
    if (first !== null && last !== null) {
      if (first === last) {
        gridHostRef.current?.selectCell(first, 0);
      } else {
        gridHostRef.current?.selectRows(first, last);
      }
    }
    noteCapped(to - from + 1, t("처음 {count}행만 복제했습니다", { count: COPY_MAX_ROWS.toLocaleString() }));
  }

  // Whole rows pasted over whole rows: added as new rows, as Duplicate does
  // (an empty field is NULL, key columns are left to their defaults).
  function pasteRows(lines: string[][]): void {
    const result = store.getState().result;
    if (!result || result.meta.sourceTable === null) {
      return;
    }
    const pkNames = new Set(result.meta.pk ?? []);
    let first: number | null = null;
    let last: number | null = null;
    for (const line of lines) {
      const staged = new Map<number, string | null>();
      result.meta.columns.forEach((column, index) => {
        if (!pkNames.has(column)) {
          staged.set(index, line[index] === "" ? null : line[index]);
        }
      });
      const created = store.stageInsert(staged);
      if (created === null) {
        break;
      }
      first ??= created;
      last = created;
    }
    if (first !== null && last !== null) {
      gridHostRef.current?.selectRows(first, last);
    }
  }

  // Shows the filter bar of the Data tab on screen with the keyboard in its
  // first value; a bar with no conditions gets one, on the selected cell's
  // column.
  function openFilterBar(): void {
    const tab = currentTab();
    if (!tab || tab.kind !== "data" || (tab.view ?? "data") !== "data") {
      return;
    }
    const col = gridHostRef.current?.selection()?.c0;
    const column = col === undefined ? null : (store.getState().result?.meta.columns[col] ?? null);
    setFilterOpen((prev) => (prev[tab.id] ? prev : { ...prev, [tab.id]: true }));
    setFilterFocus((prev) => ({ tab: tab.id, seq: (prev?.seq ?? 0) + 1, column }));
  }

  function quickFilter(row: number, col: number): void {
    const conn = activeConnIdRef.current;
    const tab = currentTab();
    const result = store.getState().result;
    const column = result?.meta.columns[col];
    if (conn === null || !tab || tab.kind !== "data" || !result || column === undefined) {
      return;
    }
    const value = result.source.cell(row, col);
    // Text columns compare as text: "12345" in a varchar isn't a number.
    const spec = gridSpecs?.[col] ?? null;
    const isText = spec !== null ? spec.kind !== "number" && spec.kind !== "boolean" : typeof value === "string";
    const filter = quickFilterFor(column, value, isText);
    runDataWith(conn, tab, { offset: 0, pageSize: tab.pageSize, filter, sorts: tab.sorts ?? null });
    // The condition shows in the filter bar, as TablePlus's quick filter does.
    setFilterOpen((prev) => ({ ...prev, [tab.id]: true }));
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
    missedInvalidateRef.current = false;
    let failed = true;
    try {
      const outcome = await store.applyPending(result);
      if (outcome === null) {
        return;
      }
      failed = false;
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
          setRunningTabId((value) => (value === tab.id ? null : value));
          handleOutcome(conn, tab.id, next);
        });
      } else {
        store.setInfo(t("변경사항을 적용했습니다"));
      }
    } finally {
      applyingRef.current = false;
      setApplying(false);
      // A failed batch the server rolled back may have dropped the results
      // (rows added or removed, a DEFAULT or NOW() written): the notice it
      // sent meanwhile is acted on now. A successful one reads its rows anyway.
      if (failed && missedInvalidateRef.current) {
        missedInvalidateRef.current = false;
        invalidateRef.current();
      }
    }
  }

  // Server-side invalidation (a structural rollback clears every result session):
  // reload the active data tab; a query tab is not re-run automatically.
  invalidateRef.current = () => {
    if (store.isApplying()) {
      // Settled once the apply ends (a failed one leaves the rows as they were).
      missedInvalidateRef.current = true;
      return;
    }
    const conn = activeConnIdRef.current;
    if (conn !== null) {
      dropResultSets(conn);
    }
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

  // ⌥1…⌥8 bring that tab forward and ⌥9 the last, as ⌘1…⌘9 do in a browser.
  // False when there's no such tab, so the key does what it would otherwise.
  function activateTabAt(position: number): boolean {
    const conn = activeConnIdRef.current;
    const current = conn !== null ? tabsOf(conn) : null;
    if (current === null || current.tabs.length === 0) {
      return false;
    }
    const tab = position === 9 ? current.tabs[current.tabs.length - 1] : current.tabs[position - 1];
    if (tab === undefined) {
      return false;
    }
    activate(tab.id);
    return true;
  }

  function setDetailPanelOpen(open: boolean): void {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      return;
    }
    const key = stableKeyOf(conn);
    setDetailPanels((prev) => (prev[key] === open ? prev : { ...prev, [key]: open }));
  }

  // The panel opens on any tab: the selected row, else the table's info.
  function toggleDetailPanel(): void {
    if (detailPanelOpenRef.current) {
      setDetailPanelOpen(false);
    } else {
      setDetailRows(lastSelectionRef.current);
      setStructurePick(lastStructurePickRef.current);
      setDetailPanelOpen(true);
    }
  }

  // ⌘F is a Data tab's filter and ⌘D the focused grid's rows; anywhere else
  // the browser's find and the SQL editor's ⌘D (select the next match) keep them.
  claimsKeyRef.current = (action, target, modal) => {
    // Under a dialog (export, import, the palette, …) the browser keeps them.
    if ((action === "openFilter" || action === "duplicateRows") && modal) {
      return false;
    }
    if (action === "openFilter") {
      const tab = currentTab();
      return activeConnIdRef.current !== null && tab?.kind === "data" && (tab.view ?? "data") === "data";
    }
    if (action === "duplicateRows") {
      return target instanceof HTMLCanvasElement && target.closest(".grid-host") !== null;
    }
    return true;
  };

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
        refreshView();
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
      case "runAll":
        run("all");
        return;
      case "applyChanges":
        // The structure editor saves its own changes on ⌘S. A saved query's
        // tab with no staged rows saves the query, as TablePlus does.
        if (activeTab?.kind === "query" && activeTab.favoriteId !== undefined && !hasStagedRows()) {
          saveQueryTab(activeTab.id, activeTab.favoriteId);
        } else if (activeTab?.kind === "query" || dataView) {
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
      case "openFilter":
        openFilterBar();
        return;
      case "duplicateRows": {
        const selection = gridHostRef.current?.selection() ?? null;
        if (selection !== null && selection.mode !== "col") {
          void duplicateRows(selection.r0, selection.r1);
        }
        return;
      }
      case "toggleConsole":
        if (inWorkspace) {
          setConsoleOpen(!consoleOpen);
        }
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
      store.setInfo(t("외래 키 컬럼이 아닙니다"));
      return;
    }
    const value = result.source.cell(row, col);
    const index = fk.columns.indexOf(column);
    const refColumn = fk.ref_columns[index] ?? fk.ref_columns[0];
    const filter = fkFilterFor(refColumn, value);
    if (filter === null) {
      store.setInfo(t("NULL 값은 참조 행이 없습니다"));
      return;
    }
    // A key of several columns matches on all of them, when the row has them.
    if (fk.columns.length > 1) {
      const parts = fk.columns.map((local, part) => ({
        ref: fk.ref_columns[part] ?? fk.ref_columns[0],
        value: result.source.cell(row, result.meta.columns.indexOf(local)),
      }));
      if (parts.every((part) => part.value !== undefined && part.value !== null)) {
        filter.rows = parts.flatMap((part, partIndex) => fkFilterFor(part.ref, part.value, `fk${partIndex}`)?.rows ?? []);
      }
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
      // A tab showing the table's structure goes to its rows.
      if ((existing.view ?? "data") !== "data") {
        setTabsFor(conn, patchTab(current, existing.id, { view: "data" }));
      }
      runDataWith(conn, existing, {
        offset: 0,
        pageSize: existing.pageSize,
        filter,
        sorts: existing.sorts ?? null,
      });
      activate(existing.id);
      // The condition shows in the filter bar, as TablePlus's quick filter does.
      setFilterOpen((prev) => ({ ...prev, [existing.id]: true }));
      return;
    }
    const tab: DataTab = { ...createDataTab(table, undefined, meta?.kind ?? "postgres"), filter };
    activateNewTab(conn, tab);
    setFilterOpen((prev) => ({ ...prev, [tab.id]: true }));
    runDataWith(conn, tab, { offset: 0, pageSize: tab.pageSize, filter, sorts: null });
  }

  function explain(): void {
    const conn = activeConnIdRef.current;
    const tab = currentTab();
    if (conn === null || !tab || store.getState().status === "running") {
      return;
    }
    // An EXPLAIN written out (EXPLAIN ANALYZE …) runs its statement.
    if (store.inOwnTx(conn)) {
      store.setError(t("가져오기가 진행 중입니다. 끝난 뒤 다시 실행하세요."));
      return;
    }
    let sqlText: string;
    if (tab.kind === "query") {
      sqlText = (editorRef.current?.currentStatement() ?? "").trim();
    } else if (tab.kind === "data") {
      sqlText = tab.sql.trim();
    } else {
      return;
    }
    if (sqlText === "" || splitSqlStatements(sqlText, meta?.kind ?? "").length === 0) {
      notify(t("실행할 쿼리가 없습니다"));
      return;
    }
    if (splitSqlStatements(sqlText, meta?.kind ?? "").length > 1) {
      notify(t("실행 계획은 쿼리 하나씩 볼 수 있습니다"));
      return;
    }
    // An EXPLAIN already written runs as it is.
    const prefix = explainPrefixFor(meta?.kind ?? "");
    if (prefix === null && !isExplainSql(sqlText)) {
      notify(t("이 드라이버는 실행 계획 보기를 지원하지 않습니다"));
      return;
    }
    const planSql = prefix === null ? sqlText : planSqlFor(sqlText, prefix);
    const planTab = { ...createQueryTab(1), title: t("실행 계획 — {title}", { title: tab.title }), sql: planSql };
    activateNewTab(conn, planTab);
    focusRequestRef.current = true;
    setRunningTabId(planTab.id);
    void store.runQuery(conn, planSql, maxRows, planTab.id).then((outcome) => {
      setRunningTabId((value) => (value === planTab.id ? null : value));
      handleOutcome(conn, planTab.id, outcome);
    });
  }

  function snippetItems(): ContextMenuItem[] {
    const tab = currentTab();
    const table =
      tab && tab.kind === "data" ? tab.table : (meta?.tables[0] ?? "table");
    const prefix = explainPrefixFor(meta?.kind ?? "") ?? "EXPLAIN ";
    return [
      { label: t("SQL 정리 (Beautify)"), onSelect: () => formatCurrent("beautify") },
      { label: t("SQL 축약 (Minify)"), onSelect: () => formatCurrent("minify") },
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
        store.setInfo(t("이 연결은 데이터베이스 전환을 지원하지 않습니다"));
        return;
      }
      setDbMenu({ x, y, databases });
    } catch (err) {
      store.setError(errorOf(err, t("데이터베이스 목록을 불러오지 못했습니다")));
    }
  }

  async function switchToDatabase(database: string): Promise<void> {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      return;
    }
    setDbMenu(null);
    const staged = workspacesRef.current[conn]?.tabs.tabs ?? [];
    if (!guardPending(stagedSources(staged), () => void switchToDatabase(database))) {
      return;
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
      forgetTableDetails();
      setMetaNonce((value) => value + 1);
      store.setInfo(t("데이터베이스: {name}", { name: database }));
    } catch (err) {
      store.setError(errorOf(err, t("데이터베이스를 전환하지 못했습니다")));
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
    const name = window.prompt(t("새 데이터베이스 이름"), "");
    const trimmed = name?.trim() ?? "";
    if (trimmed === "") {
      return;
    }
    setDbMenu(null);
    try {
      await store.exec(conn, `CREATE DATABASE ${quoteIdent(kind, trimmed)}`, { history: true });
      store.setInfo(t("데이터베이스 생성됨: {name}", { name: trimmed }));
    } catch (err) {
      store.setError(errorOf(err, t("데이터베이스를 만들지 못했습니다")));
    }
  }

  async function dropDatabase(): Promise<void> {
    const conn = activeConnIdRef.current;
    const kind = meta?.kind ?? "";
    if (conn === null || !serverConn) {
      return;
    }
    const name = window.prompt(t("삭제할 데이터베이스 이름"), "");
    const trimmed = name?.trim() ?? "";
    if (trimmed === "") {
      return;
    }
    if (trimmed === currentDatabase()) {
      store.setError(t("현재 사용 중인 데이터베이스는 삭제할 수 없습니다"));
      return;
    }
    if (!window.confirm(t('데이터베이스 "{name}"를 삭제할까요? 이 작업은 되돌릴 수 없습니다.', { name: trimmed }))) {
      return;
    }
    setDbMenu(null);
    try {
      await store.exec(conn, `DROP DATABASE ${quoteIdent(kind, trimmed)}`, { history: true });
      store.setInfo(t("데이터베이스 삭제됨: {name}", { name: trimmed }));
    } catch (err) {
      store.setError(errorOf(err, t("데이터베이스를 삭제하지 못했습니다")));
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

  // One statement per table. A table that another picked table still depends
  // on fails until that one has gone, so failures are tried again while a pass
  // gets anything done; what still fails is returned with its error.
  async function eachTable(
    conn: string,
    tables: string[],
    statement: (table: string) => string,
  ): Promise<{ done: string[]; failed: { table: string; error: unknown }[] }> {
    const done: string[] = [];
    let rest = tables;
    for (;;) {
      const failed: { table: string; error: unknown }[] = [];
      for (const table of rest) {
        try {
          await store.exec(conn, statement(table), { history: true });
          done.push(table);
        } catch (error) {
          failed.push({ table, error });
        }
      }
      if (failed.length === 0 || failed.length === rest.length) {
        return { done, failed };
      }
      rest = failed.map((entry) => entry.table);
    }
  }

  // Renames a table (the sidebar's Rename…, the Structure view's Name field)
  // and the tabs showing it. True once renamed.
  async function renameTable(conn: string, table: string, name: string): Promise<boolean> {
    const typed = name.trim();
    // A name typed without its schema stays in the table's own schema.
    const dot = table.lastIndexOf(".");
    const nextName = typed !== "" && !typed.includes(".") && dot > 0 ? `${table.slice(0, dot + 1)}${typed}` : typed;
    if (typed === "" || nextName === table) {
      store.setInfo(t("테이블 이름을 확인하세요"));
      return false;
    }
    // RENAME keeps a table in its schema; another schema would only be a title.
    if (typed.includes(".") && typed.slice(0, typed.lastIndexOf(".")) !== (dot > 0 ? table.slice(0, dot) : "")) {
      store.setError(t("이름 변경으로 다른 스키마로 옮길 수는 없습니다"));
      return false;
    }
    const showing = tabsOf(conn)?.tabs.filter((tab): tab is DataTab => tab.kind === "data" && tab.table === table) ?? [];
    // Staged rows name the table they were read from.
    if (showing.some((tab) => tab.source?.hasPending() ?? false)) {
      store.setError(t("저장하지 않은 변경 사항을 먼저 적용하거나 취소하세요"));
      return false;
    }
    try {
      await store.exec(conn, renameTableSql(meta?.kind ?? "", table, nextName), { history: true });
      store.setInfo(t("테이블 이름을 변경했습니다: {from} → {to}", { from: table, to: nextName }));
      const current = tabsOf(conn);
      if (current !== null) {
        let next = current;
        for (const tab of current.tabs) {
          if (tab.kind === "structure" && tab.table === table) {
            next = patchTab(next, tab.id, { table: nextName, title: `${t("구조")}: ${nextName}`, data: undefined });
          }
          if (tab.kind === "data" && tab.table === table) {
            // Its rows are read again under the new name.
            tab.source?.dispose();
            autoHydratedRef.current.delete(`${conn}:${tab.id}`);
            next = patchTab(next, tab.id, {
              table: nextName,
              title: nextName,
              source: undefined,
              meta: undefined,
              detail: undefined,
            });
          }
        }
        if (next !== current) {
          setTabsFor(conn, next);
          const active = activeTabOf(next);
          if (active !== null && active.kind === "data" && active.table === nextName) {
            store.showSnapshot(conn, snapshotOf(active));
          }
        }
      }
      setTableColors((prev) => moveTableColor(prev, stableKeyOf(conn), table, nextName));
      setPinnedTables((prev) =>
        prev[conn]?.includes(table)
          ? { ...prev, [conn]: prev[conn].map((entry) => (entry === table ? nextName : entry)) }
          : prev,
      );
      forgetTableDetails();
      setMetaNonce((value) => value + 1);
      return true;
    } catch (err) {
      store.setError(errorOf(err, t("테이블 이름을 변경하지 못했습니다")));
      return false;
    }
  }

  // Copies, truncates and drops cover every table picked in the sidebar; the
  // other actions take the first.
  async function tableAction(action: TableAction, tables: string[]): Promise<void> {
    const conn = activeConnIdRef.current;
    const table = tables[0];
    if (conn === null || table === undefined) {
      return;
    }
    const kind = meta?.kind ?? "";
    const quoted = quoteIdent(meta?.kind ?? "", table);
    const several = tables.length > 1;
    if (action === "copyDrop") {
      await writeClipboard(
        several
          ? tables.map((name) => `${dropTableSql(kind, name)};`).join("\n")
          : dropTableSql(kind, table),
      );
      return;
    }
    if (action === "copyTruncate") {
      await writeClipboard(tables.map((name) => `${truncateTableSql(kind, name)};`).join("\n"));
      return;
    }
    if (action === "importCsv" || action === "importJson" || action === "importSql") {
      openImport(action === "importCsv" ? "csv" : action === "importJson" ? "json" : "sql", table);
      return;
    }
    if (action === "rename") {
      const name = window.prompt(t("새 테이블 이름"), table);
      if (name !== null) {
        await renameTable(conn, table, name);
      }
      return;
    }
    if (action === "copyCreate") {
      const ddls: string[] = [];
      for (const name of tables) {
        const ddl = (await ensureDetail(conn, name))?.ddl;
        if (ddl) {
          // Several statements need their own terminators to run as one script.
          ddls.push(several && !ddl.trimEnd().endsWith(";") ? `${ddl.trimEnd()};` : ddl);
        }
      }
      if (ddls.length > 0) {
        await writeClipboard(ddls.join("\n\n"));
      } else {
        store.setInfo(t("DDL을 가져올 수 없습니다"));
      }
      return;
    }
    if (action === "copySelect") {
      const lines: string[] = [];
      for (const name of tables) {
        const detail = await ensureDetail(conn, name);
        const columns = detail?.columns.map((column) => column.name) ?? null;
        lines.push(firstRowsSql(kind, quoteIdent(kind, name), selectList(columns, kind)));
      }
      await writeClipboard(lines.join("\n"));
      return;
    }
    if (action === "copyLaravel") {
      const detail = await ensureDetail(conn, table);
      if (detail === null) {
        store.setInfo(t("테이블 정보를 가져올 수 없습니다"));
        return;
      }
      await writeClipboard(laravelSchemaScript(detail, kind));
      store.setInfo(t("Laravel 스키마 코드를 복사했습니다"));
      return;
    }
    if (action === "duplicate") {
      const name = window.prompt(t("복제할 테이블 이름"), `${table.replace(/\./g, "_")}_copy`);
      if (name === null) {
        return;
      }
      const target = name.trim();
      if (target === "" || target === table) {
        store.setInfo(t("테이블 이름을 확인하세요"));
        return;
      }
      const targetQuoted = quoteIdent(kind, target);
      const sql =
        kind === "mssql"
          ? `SELECT * INTO ${targetQuoted} FROM ${quoted};`
          : `CREATE TABLE ${targetQuoted} AS SELECT * FROM ${quoted};`;
      try {
        await store.exec(conn, sql, { history: true });
        store.setInfo(t("테이블을 복제했습니다: {name}", { name: target }));
        await refreshActiveMeta();
      } catch (err) {
        store.setError(errorOf(err, t("테이블을 복제하지 못했습니다")));
      }
      return;
    }
    // The confirmation names the first few tables only.
    const shown = tables.slice(0, 10).join(", ");
    const names =
      tables.length > 10 ? `${shown} ${t("외 {count}개", { count: tables.length - 10 })}` : shown;
    if (action === "truncate") {
      const question = several
        ? t("테이블 {count}개의 모든 행을 삭제할까요?\n{tables}", { count: tables.length, tables: names })
        : t("{table} 테이블의 모든 행을 삭제할까요?", { table });
      if (!window.confirm(question)) {
        return;
      }
      // Postgres won't empty a table another one references unless both go in
      // one TRUNCATE; elsewhere it is one table at a time.
      const together = several && (kind === "postgres" || kind === "cockroach");
      const { done: emptied, failed } = together
        ? await store
            .exec(conn, `TRUNCATE TABLE ${tables.map((name) => quoteIdent(kind, name)).join(", ")};`, {
              history: true,
            })
            .then(
              () => ({ done: tables, failed: [] }),
              (error: unknown) => ({ done: [], failed: [{ table: names, error }] }),
            )
        : await eachTable(conn, tables, (name) => `${truncateTableSql(kind, name)};`);
      if (failed.length === 0) {
        store.setInfo(
          several
            ? t("테이블 {count}개를 비웠습니다", { count: emptied.length })
            : t("테이블을 비웠습니다: {table}", { table }),
        );
      } else if (!several || together) {
        store.setError(errorOf(failed[0].error, t("테이블을 비우지 못했습니다")));
      } else {
        store.setError(
          t("테이블 {done}개를 비웠고 {failed}개는 실패했습니다 — {table}: {error}", {
            done: emptied.length,
            failed: failed.length,
            table: failed[0].table,
            error: errorOf(failed[0].error, t("테이블을 비우지 못했습니다")),
          }),
        );
      }
      const ws = workspacesRef.current[conn];
      const tab = ws !== undefined ? activeTabOf(ws.tabs) : null;
      if (ws !== undefined && tab !== null && tab.kind === "data" && emptied.includes(tab.table ?? "")) {
        runDataWith(conn, tab, dataSpecOf(tab, 0, tab.pageSize));
      }
      return;
    }
    if (action === "delete") {
      const question = several
        ? t("테이블 {count}개를 삭제하면 되돌릴 수 없습니다. 삭제할까요?\n{tables}", {
            count: tables.length,
            tables: names,
          })
        : t("테이블 {table}을(를) 삭제하면 되돌릴 수 없습니다. 삭제할까요?", { table });
      if (!window.confirm(question)) {
        return;
      }
      const { done: dropped, failed } = await eachTable(
        conn,
        tables,
        (name) => `DROP TABLE ${quoteIdent(kind, name)};`,
      );
      if (failed.length === 0) {
        store.setInfo(
          several
            ? t("테이블 {count}개를 삭제했습니다", { count: dropped.length })
            : t("테이블을 삭제했습니다: {table}", { table }),
        );
      } else if (!several) {
        store.setError(errorOf(failed[0].error, t("테이블을 삭제하지 못했습니다")));
      } else {
        store.setError(
          t("테이블 {done}개를 삭제했고 {failed}개는 실패했습니다 — {table}: {error}", {
            done: dropped.length,
            failed: failed.length,
            table: failed[0].table,
            error: errorOf(failed[0].error, t("테이블을 삭제하지 못했습니다")),
          }),
        );
      }
      if (dropped.length > 0) {
        setTableColors((prev) => withTableColor(prev, stableKeyOf(conn), dropped, null));
        setPinnedTables((prev) =>
          prev[conn] === undefined ? prev : { ...prev, [conn]: prev[conn].filter((entry) => !dropped.includes(entry)) },
        );
        const current = tabsOf(conn);
        if (current !== null) {
          const doomed = current.tabs.filter(
            (tab) => tab.kind === "data" && dropped.includes(tab.table ?? ""),
          );
          for (const tab of doomed) {
            closeTabById(tab.id, true);
          }
        }
        await refreshActiveMeta();
      }
    }
  }

  // Structure, data or sizes may have changed; details are fetched again.
  function forgetTableDetails(): void {
    detailCacheRef.current = new Map();
    detailFailedRef.current = new Set();
    // A read started before the change would bring the old structure back.
    detailLoadsRef.current = new Map();
    setDetailNonce((value) => value + 1);
  }

  async function refreshActiveMeta(): Promise<void> {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      try {
        commitConns(await store.listConns());
      } catch (err) {
        store.setError(errorOf(err, t("연결 목록을 불러오지 못했습니다")));
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
      forgetTableDetails();
    } catch (err) {
      store.setError(errorOf(err, t("메타를 새로고침하지 못했습니다")));
    }
  }

  async function afterOpen(live: LiveConn): Promise<void> {
    try {
      commitConns(await store.listConns());
    } catch {
      setConns((prev) => prev);
    }
    enterFresh(live);
  }

  function enterFresh(live: LiveConn): void {
    if (workspacesRef.current[live.conn] === undefined) {
      const fresh = firstTabOf(live.conn, live.meta);
      const ws: Workspace = {
        tabs: { tabs: [fresh], activeId: fresh.id },
        meta: live.meta,
        tx: "none",
      };
      commitWorkspaces({ ...workspacesRef.current, [live.conn]: ws });
    }
    setActiveConnId(live.conn);
  }

  // Entering a connection, or connecting a saved one, while under way, by id:
  // the two clicks of a double-click share one. Two would each build a
  // workspace, the second replacing the first (its query tab "Query 2").
  const enteringRef = useRef(new Map<string, Promise<boolean>>());
  const connectingRef = useRef(new Map<string, Promise<"entered" | "asking" | "failed">>());

  function shared<T>(calls: Map<string, Promise<T>>, id: string, start: () => Promise<T>): Promise<T> {
    const pending = calls.get(id);
    if (pending !== undefined) {
      return pending;
    }
    const call = start().finally(() => calls.delete(id));
    calls.set(id, call);
    return call;
  }

  // Resolves false when the connection could not be entered.
  function enterConn(id: string): Promise<boolean> {
    return shared(enteringRef.current, id, () => enterConnNow(id));
  }

  async function enterConnNow(id: string): Promise<boolean> {
    if (workspacesRef.current[id] !== undefined) {
      setActiveConnId(id);
      return true;
    }
    try {
      const nextMeta = await store.refreshMeta(id);
      // Opened another way meanwhile: keep that workspace.
      if (workspacesRef.current[id] === undefined) {
        const fresh = firstTabOf(id, nextMeta);
        const ws: Workspace = {
          tabs: { tabs: [fresh], activeId: fresh.id },
          meta: nextMeta,
          tx: "none",
        };
        commitWorkspaces({ ...workspacesRef.current, [id]: ws });
      }
      setActiveConnId(id);
      return true;
    } catch (err) {
      store.setError(errorOf(err, t("연결에 들어가지 못했습니다")));
      try {
        commitConns(await store.listConns());
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
      store.setError(errorOf(err, t("데모를 열지 못했습니다")));
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
      store.setError(errorOf(err, t("파일을 열지 못했습니다")));
    }
  }

  // "asking": the connection dialog now asks for a password. A profile that keeps
  // its password connects at once; one that doesn't asks first, since a try
  // without the password only logs a failed login.
  // A second call while the first is connecting shares it (busySaved, the
  // state that hides a second click, isn't set until the next render).
  function connectSavedById(id: string): Promise<"entered" | "asking" | "failed"> {
    return shared(connectingRef.current, id, () => connectSavedNow(id));
  }

  async function connectSavedNow(id: string): Promise<"entered" | "asking" | "failed"> {
    const existing = conns.find((conn) => conn.saved_id === id);
    if (existing !== undefined) {
      return (await enterConn(existing.id)) ? "entered" : "failed";
    }
    setBusySaved(id);
    try {
      const saved = (await store.listConnections()).find((entry) => entry.id === id);
      if (saved === undefined) {
        store.setError(t("연결을 찾을 수 없습니다"));
        return "failed";
      }
      if (!saved.has_password) {
        openConnectionEditor(saved, t("비밀번호를 입력해 연결하세요 (없으면 비워 두세요)"), "db");
        return "asking";
      }
      try {
        const live = await store.connectSaved(id);
        await afterOpen(live);
        return "entered";
      } catch (err) {
        // The keychain had nothing for it after all: ask in the dialog instead of failing.
        const missing = missingSecretOf(err);
        if (missing !== null) {
          openConnectionEditor(saved, t(errorOf(err, t("비밀번호를 입력하세요"))), missing);
          return "asking";
        }
        store.setError(errorOf(err, t("연결에 실패했습니다")));
        return "failed";
      }
    } catch (err) {
      store.setError(errorOf(err, t("저장된 연결을 불러오지 못했습니다")));
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
    if (closingConnsRef.current.has(id)) {
      return;
    }
    const summary = connsRef.current.find((conn) => conn.id === id);
    if (summary?.is_default) {
      store.setError(t("기본 연결은 닫을 수 없습니다"));
      return;
    }
    const ws = workspacesRef.current[id];
    if (ws !== undefined && !guardPending(stagedSources(ws.tabs.tabs), () => void closeConn(id))) {
      return;
    }
    // Its tab goes at once, and the neighbour takes over as a browser tab's
    // does: home only once no connection is left open.
    closingConnsRef.current.add(id);
    const order = connsRef.current;
    const at = order.findIndex((conn) => conn.id === id);
    const left = order.filter((conn) => conn.id !== id && !closingConnsRef.current.has(conn.id));
    const successor = left.find((conn) => order.indexOf(conn) > at) ?? left[left.length - 1] ?? null;
    commitConns(order.filter((conn) => conn.id !== id));
    // Marked until the server answers, whatever happens on the way.
    let closed = false;
    try {
      if (ws !== undefined) {
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
        // One already open takes over at once; one not yet opened loads from
        // home, where a failed load leaves the app (never on the closed one).
        if (successor !== null && workspacesRef.current[successor.id] !== undefined) {
          setActiveConnId(successor.id);
        } else {
          setActiveConnId(null);
          if (successor !== null) {
            void enterConn(successor.id);
          }
        }
      }
      forgetSchema(id);
      try {
        await store.closeConn(id);
        closed = true;
      } catch (err) {
        store.setError(errorOf(err, t("연결을 닫지 못했습니다")));
      }
    } finally {
      closingConnsRef.current.delete(id);
    }
    try {
      // commitConns keeps any other close still on its way hidden.
      commitConns(await store.listConns());
    } catch {
      // A connection the server still holds comes back to the bar.
      if (!closed) {
        commitConns(order);
      }
    }
  }

  // File → Import, as TablePlus has it: CSV and JSON open the wizard (on the
  // table, when one was picked); an SQL dump runs from the dump window.
  function openImport(format: ImportFormat | "sql", table: string | null): void {
    if (format === "sql") {
      setDumpTab("restore");
      return;
    }
    setImportTarget({ format, table });
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
      {
        id: "export-tables",
        label: t("테이블 내보내기"),
        disabled: meta === null,
        run: () => openTableExport(activeDataTab !== null ? [activeDataTab.table] : []),
      },
      { id: "refresh-meta", label: t("새로고침"), hint: shortcutHint(settings.keymap, "refresh"), run: refreshView },
      {
        id: "alert-mode",
        label: t("안전 모드 바꾸기 (끔 → 위험만 → 모든 변경)"),
        hint: t(SAFE_MODE_LABELS[alertMode].title),
        disabled: activeConnIdRef.current === null,
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
        id: "import-csv",
        label: t("CSV에서 가져오기"),
        disabled: meta === null,
        run: () => openImport("csv", active !== null && active.kind === "data" ? active.table : null),
      },
      {
        id: "import-json",
        label: t("JSON에서 가져오기"),
        disabled: meta === null,
        run: () => openImport("json", active !== null && active.kind === "data" ? active.table : null),
      },
      {
        id: "import-sql",
        label: t("SQL 덤프에서 가져오기"),
        disabled: meta === null,
        run: () => openImport("sql", null),
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
      {
        id: "console",
        label: t("콘솔 열기"),
        hint: t("이 연결에서 실행한 쿼리"),
        disabled: activeConnIdRef.current === null,
        run: () => setConsoleOpen(true),
      },
      { id: "activity", label: "Activity", hint: t("작업 로그"), run: () => setActivityOpen(true) },
      {
        id: "metrics",
        label: "Metrics",
        hint: t("쿼리 지표"),
        disabled: activeConnIdRef.current === null,
        run: () => setMetricsOpen(true),
      },
      ...(getPasscodeHash() !== null
        ? [{ id: "lock", label: t("지금 잠금"), run: () => setLocked(true) }]
        : []),
      { id: "connect", label: t("서버 연결"), run: () => openConnectionEditor(null) },
      { id: "demo", label: t("데모 열기"), run: () => void openDemo() },
      { id: "history", label: t("실행 기록"), sourceId: "history" },
      { id: "favorites", label: t("저장한 쿼리"), sourceId: "favorites" },
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
          const history = await store.fetchHistory(conn, 200);
          // The window keeps every run; picking only needs each statement once.
          const seen = new Set<string>();
          return history
            .filter((entry) => !seen.has(entry.sql) && seen.add(entry.sql))
            .slice(0, 50)
            .map((entry) => ({
              label: entry.sql,
              run: () => pickSql(entry.sql),
            }));
        },
      },
      {
        id: "favorites",
        title: t("저장한 쿼리"),
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
          return closedDrafts(conn).map((entry) => ({
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
    setCellQuickLook({ row, col, anchor: gridHostRef.current?.cellRect(row, col) ?? null });
  }

  function openRowDetail(from: number, to = from): void {
    setCellQuickLook(null);
    setDetailRows({ from, to });
    setDetailPanelOpen(true);
  }

  function pickStructureRows(pick: { key: string; source: RowSource; rows: SelectedRows } | null): void {
    lastStructurePickRef.current = pick;
    // As with the data grid, only an open panel follows the selection.
    if (detailPanelOpenRef.current && structureFrameRef.current === 0) {
      structureFrameRef.current = requestAnimationFrame(() => {
        structureFrameRef.current = 0;
        setStructurePick(lastStructurePickRef.current);
      });
    }
  }

  function handleSelectionChange(row: number | null, rows: SelectedRows | null): void {
    if (row === null || rows === null) {
      return;
    }
    lastSelectionRef.current = rows;
    // Only an open panel follows the selection; opening it reads the ref.
    if (detailPanelOpenRef.current && selectionFrameRef.current === 0) {
      selectionFrameRef.current = requestAnimationFrame(() => {
        selectionFrameRef.current = 0;
        setDetailRows(lastSelectionRef.current);
      });
    }
  }

  function handleCellContextMenu(row: number, col: number, x: number, y: number, selection: GridSelection): void {
    if (state.result === null) {
      return;
    }
    const conn = activeConnIdRef.current;
    const tab = currentTab();
    const table = tab && tab.kind === "data" ? tab.table : state.result.meta.sourceTable;
    const opened: MenuState = { row, col, x, y, selection, result: state.result };
    setMenu(opened);
    // Set Value and the referenced row follow the table's columns (defaults,
    // date types, foreign keys). Read in the background, which can wait
    // behind a running query; the same menu, still open, then shows them.
    if (conn !== null && table !== null && !detailCacheRef.current.has(`${conn}:${table}`)) {
      void ensureDetail(conn, table).then(() =>
        setMenu((current) => (current === opened ? { ...opened } : current)),
      );
    }
  }

  // The data and results grids' cell menu, in TablePlus's order. It acts on
  // the whole selection; column and cell entries on the cell clicked.
  function menuItems(menuState: MenuState): ContextMenuItem[] {
    const result = menuState.result;
    if (result !== state.result) {
      return [];
    }
    const source = result.source;
    const columns = result.meta.columns;
    const { row, col, selection } = menuState;
    const editableTable = result.meta.sourceTable !== null;
    const keyed = editableTable && result.meta.pk !== null && result.meta.pk.length > 0;
    const tab = currentTab();
    const dataTab = tab && tab.kind === "data" ? tab : null;
    const table = result.meta.sourceTable ?? dataTab?.table ?? null;
    const dialect = meta?.kind ?? "postgres";
    const editableRow = (r: number): boolean =>
      editableTable && (keyed || source.isInserted(r)) && !source.isDeleted(r);
    const selectedCols = rangeOf(selection.c0, selection.c1);
    // Whole columns take every row; the row actions leave them alone, as the
    // Delete key does.
    const rowCount = selection.mode === "col" ? 0 : selection.r1 - selection.r0 + 1;
    // Actions that read or write cell by cell stop at the copy limit.
    const lastRow = Math.min(selection.r1, selection.r0 + COPY_MAX_ROWS - 1);

    const copyAs = (cols: number[]) => (format: CopyFormat) => {
      void (async () => {
        try {
          // INSERT writes a staged DEFAULT or NOW() as SQL; the rest show its label.
          const values = await rangeValues(source, selection.r0, selection.r1, cols, format === "insert");
          const target = table !== null ? { table, dialect } : null;
          await writeClipboard(formatCopy(format, { columns: cols.map((c) => columns[c]), rows: values }, target));
          noteCapped(
            selection.r1 - selection.r0 + 1,
            t("처음 {count}행만 복사했습니다", { count: COPY_MAX_ROWS.toLocaleString() }),
          );
        } catch (err) {
          store.setError(errorOf(err, t("행을 불러오지 못했습니다")));
        }
      })();
    };

    const specsOf = selectedCols.map((c) => gridSpecs?.[c] ?? null);
    let anyEditable = false;
    let allInserted = true;
    for (let r = selection.r0; r <= lastRow; r += 1) {
      anyEditable ||= editableRow(r);
      allInserted &&= source.isInserted(r);
    }
    const single = selection.r0 === selection.r1 && selection.c0 === selection.c1;
    const value = source.cell(row, col);
    const nowLabel = dialect === "mssql" ? "GETDATE()" : dialect === "sqlite" ? "CURRENT_TIMESTAMP" : "NOW()";
    const setValue = (choice: CellValueChoice): void => {
      for (let r = selection.r0; r <= lastRow; r += 1) {
        if (!editableRow(r) || source.cell(r, selection.c0) === undefined) {
          continue;
        }
        for (const c of selectedCols) {
          if (choice === "default" && source.isInserted(r)) {
            // A new row's cell back at DEFAULT: left out of its INSERT.
            store.revertCell(r, c);
          } else if (choice === "default" || choice === "now") {
            // Written by the database (UPDATE … SET col = DEFAULT / NOW()).
            store.setCellExpr(r, c, choice === "now" ? { expr: "now", label: nowLabel } : { expr: "default", label: "DEFAULT" });
          } else {
            void store.editCell(r, c, choice === "null" ? null : "");
          }
        }
      }
      noteCapped(
        selection.r1 - selection.r0 + 1,
        t("처음 {count}행만 바꿨습니다", { count: COPY_MAX_ROWS.toLocaleString() }),
      );
    };

    const views: ContextMenuItem[] = [
      {
        label: t("행 상세 보기"),
        onSelect: () => (rowCount > 0 ? openRowDetail(selection.r0, selection.r1) : openRowDetail(row)),
      },
    ];
    if (dataTab !== null) {
      const columnName = columns[col];
      const conn = activeConnIdRef.current;
      const cached = conn !== null ? detailCacheRef.current.get(`${conn}:${dataTab.table}`) : undefined;
      const hasFk =
        cached !== undefined &&
        columnName !== undefined &&
        cached.foreign_keys.some((entry) => entry.columns.includes(columnName));
      if (hasFk) {
        views.push({
          label: t("참조 행 열기"),
          onSelect: () => {
            void fkJump(row, col);
          },
        });
      }
    }

    const items = cellMenuItems({
      column: columns[col] ?? "",
      copySelection: () => gridHostRef.current?.copySelection(),
      copyText: writeClipboard,
      copyRowsAs: copyAs(rangeOf(0, columns.length - 1)),
      copyCellsAs: copyAs(selectedCols),
      canInsert: table !== null,
      copyColumnValues: () => {
        void (async () => {
          try {
            const values = await rangeValues(source, 0, source.rowCount - 1, [col]);
            await writeClipboard(values.map((line) => cellToString(line[0]) ?? "").join("\n"));
            noteCapped(
              source.rowCount,
              t("처음 {count}행만 복사했습니다", { count: COPY_MAX_ROWS.toLocaleString() }),
            );
          } catch (err) {
            store.setError(errorOf(err, t("행을 불러오지 못했습니다")));
          }
        })();
      },
      quickLook: () => openCellQuickLook(row, col),
      views,
      edit: editableRow(row) ? () => gridHostRef.current?.beginEdit(row, col) : undefined,
      setValue: anyEditable ? setValue : undefined,
      // Without the table's structure, any column may take either.
      nullable: specsOf.every((spec) => spec?.nullable ?? true),
      allowsEmpty: specsOf.every(
        (spec) => spec === null || spec.kind === "text" || spec.kind === "enum" || spec.kind === "set",
      ),
      // As TablePlus: DEFAULT where the column has a default or may be NULL
      // (unknown without the table's structure, so offered); the time only on
      // date and time columns.
      // A new row's DEFAULT is the column left out, which every column takes
      // (an identity or auto-increment one has no declared default).
      allowsDefault:
        allInserted ||
        specsOf.every((spec) => spec === null || spec.hasDefault === true || spec.nullable === true),
      allowsNow: specsOf.every((spec) => spec !== null && isDateKind(spec.kind)),
      nowLabel,
      isNull: single && (value === undefined || (value === null && !source.isInserted(row))),
    });

    let anyEdited = false;
    for (let r = selection.r0; r <= lastRow && !anyEdited; r += 1) {
      if (editableRow(r)) {
        anyEdited = selectedCols.some((c) => source.cellState(r, c) === "edited");
      }
    }
    if (anyEdited) {
      items.push({
        label: t("변경 되돌리기"),
        onSelect: () => {
          for (let r = selection.r0; r <= lastRow; r += 1) {
            for (const c of selectedCols) {
              if (source.cellState(r, c) === "edited") {
                store.revertCell(r, c);
              }
            }
          }
          noteCapped(
            selection.r1 - selection.r0 + 1,
            t("처음 {count}행만 바꿨습니다", { count: COPY_MAX_ROWS.toLocaleString() }),
          );
        },
      });
    }

    if (editableTable && rowCount > 0) {
      let newRows = 0;
      let allDeleted = true;
      for (let r = selection.r0; r <= selection.r1; r += 1) {
        if (source.isInserted(r)) {
          newRows += 1;
        } else {
          allDeleted &&= source.isDeleted(r);
        }
      }
      const copies = lastRow - selection.r0 + 1;
      items.push({
        label: copies === 1 ? t("행 복제") : t("{count}행 복제", { count: copies.toLocaleString() }),
        separatorBefore: true,
        onSelect: () => {
          void duplicateRows(selection.r0, selection.r1);
        },
      });
      items.push({
        label: deleteRowsLabel(rowCount, newRows === rowCount ? "cancel" : allDeleted ? "undo" : "delete"),
        disabled: !keyed && newRows === 0,
        onSelect: () => deleteRows(rangeOf(selection.r0, selection.r1)),
      });
    }

    if (dataTab !== null) {
      items.push({ label: t("빠른 필터"), separatorBefore: true, onSelect: () => quickFilter(row, col) });
    }

    if (table !== null) {
      let updatable = false;
      for (let r = selection.r0; r < selection.r0 + rowCount && !updatable; r += 1) {
        updatable = !source.isInserted(r);
      }
      items.push({
        label: t("UPDATE 문 복사"),
        separatorBefore: dataTab === null,
        disabled: !keyed || !updatable,
        onSelect: () => {
          void (async () => {
            try {
              const statements: string[] = [];
              const detail = dialect === "sqlite" ? await ensureDetail(result.conn, table) : null;
              // SQLite's UPDATE takes no DEFAULT: the column's declared one instead.
              const asSql = (value: unknown, c: number): unknown => {
                if (detail === null || !(value instanceof SqlExpression) || value.expr !== "default") {
                  return value;
                }
                const declared = sqliteDefaultSql(detail.columns.find((column) => column.name === columns[c])?.default ?? null);
                if (declared === null) {
                  throw new Error(t("기본값에 바인드 매개변수가 있어 DEFAULT로 쓸 수 없습니다"));
                }
                return new SqlExpression("default", declared);
              };
              for (let r = selection.r0; r < selection.r0 + Math.min(rowCount, COPY_MAX_ROWS); r += 1) {
                if (source.isInserted(r)) {
                  continue;
                }
                const values = (await rowValues(source, r, true)).map(asSql);
                // The row is found by the key the database has; a staged key goes in SET.
                const original = columns.map((_, c) => source.baseCell(r, c) ?? null);
                const sql = buildUpdateSql(table, columns, values, result.meta.pk ?? [], dialect, original);
                if (sql === null) {
                  store.setError(t("기본 키가 없어 UPDATE 문을 만들 수 없습니다"));
                  return;
                }
                statements.push(sql);
              }
              await writeClipboard(statements.join("\n"));
              noteCapped(
                rowCount,
                t("처음 {count}행만 복사했습니다", { count: COPY_MAX_ROWS.toLocaleString() }),
              );
            } catch (err) {
              store.setError(errorOf(err, t("행을 불러오지 못했습니다")));
            }
          })();
        },
      });
    }

    // Refresh reloads a Data tab's rows; in a query tab F5 only reloads the
    // sidebar, which is not what a result's Refresh promises.
    if (dataTab !== null) {
      items.push({ label: t("새로고침"), separatorBefore: true, onSelect: refreshView });
    }
    items.push({ label: t("현재 페이지 내보내기…"), separatorBefore: dataTab === null, onSelect: openExport });
    return items;
  }

  function openExport(): void {
    const conn = activeConnIdRef.current;
    const result = state.result;
    if (!result || conn === null) {
      return;
    }
    // A multi-statement run offers every result that has rows to write.
    const chips = activeTab !== null ? (resultSets[activeTab.id] ?? null) : null;
    const results =
      chips !== null && chips.conn === conn
        ? chips.entries.flatMap((entry) =>
            entry.outcome.kind === "ok" && entry.outcome.result.meta.columns.length > 0
              ? [{ label: entry.label, result: entry.outcome.result }]
              : [],
          )
        : [];
    setExportTarget({
      mode: "results",
      conn,
      title: activeTab ? activeTab.title : "export",
      result,
      dataTab: activeDataTab,
      results: results.length > 1 ? results : null,
    });
  }

  // TablePlus's Export Tables window: the picked tables and views checked, or
  // one table with its fields to choose.
  function openTableExport(picked: string[], columnPick = false): void {
    const conn = activeConnIdRef.current;
    if (conn === null || meta === null) {
      return;
    }
    setExportTarget({ mode: "tables", conn, picked, columnPick });
  }

  function saveSidebarWidth(width: number | null): void {
    setSidebarWidth(width);
    storeWidth(SIDEBAR_WIDTH_KEY, width);
  }

  function saveDetailWidth(width: number | null): void {
    setDetailWidth(width);
    storeWidth(DETAIL_WIDTH_KEY, width);
  }

  const consoleOpen = activeKey !== null && consolePanels[activeKey] !== false;

  function setConsoleOpen(open: boolean): void {
    const conn = activeConnIdRef.current;
    if (conn === null) {
      return;
    }
    const key = stableKeyOf(conn);
    setConsolePanels((prev) => (prev[key] === open ? prev : { ...prev, [key]: open }));
  }

  function saveConsoleHeight(height: number): void {
    setConsoleHeight(height);
    try {
      window.localStorage.setItem(CONSOLE_HEIGHT_KEY, String(height));
    } catch {}
  }

  function onConsoleSplitterDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const stack = stackRef.current;
    const startY = event.clientY;
    const startHeight = consoleHeight;
    // The panes above keep at least 160px.
    const max = Math.max(CONSOLE_MIN, (stack?.clientHeight ?? 600) - 160);
    let height = startHeight;
    document.body.classList.add("row-resizing");
    const onMove = (move: PointerEvent): void => {
      height = Math.round(Math.min(Math.max(startHeight - (move.clientY - startY), CONSOLE_MIN), max));
      setConsoleHeight(height);
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("row-resizing");
      saveConsoleHeight(height);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
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
      }
      let list: ConnSummary[] = [];
      try {
        list = await store.listConns();
        commitConns(list);
      } catch (err) {
        store.setError(errorOf(err, t("연결 목록을 불러오지 못했습니다")));
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
  formatRef.current = formatCurrent;
  tabAtRef.current = activateTabAt;
  serverConnRef.current = serverConn;

  useEffect(() => {
    saveTableMap(PINNED_KEY, pinnedTables);
  }, [pinnedTables]);

  useEffect(() => {
    saveFlagMap(CONSOLE_PANELS_KEY, consolePanels);
  }, [consolePanels]);

  useEffect(() => {
    saveTableColors(tableColors);
  }, [tableColors]);

  useEffect(() => {
    saveFlagMap(DETAIL_PANELS_KEY, detailPanels);
  }, [detailPanels]);

  useEffect(() => {
    if (prevConnRef.current === activeConnId) {
      return;
    }
    prevConnRef.current = activeConnId;
    setResultView("grid");
    setDetailRows(null);
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
        activityOpenRef.current ||
        metricsOpenRef.current ||
        paletteOpenRef.current ||
        cellQuickLookRef.current !== null ||
        lockedRef.current ||
        document.querySelector(".modal-backdrop") !== null
      );
    }
    // Escape closes the right panel unless something else takes it. An open
    // menu or dialog is seen here, in the capture phase, before it closes
    // itself; what a focused text field does with the key (the SQL editor
    // closing its autocomplete or search, an input cancelling an edit) shows
    // only once the event is through, as its default prevented.
    let panelEscape: KeyboardEvent | null = null;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        // An open dialog owns Escape; don't also close panels behind it.
        if (
          exportTargetRef.current !== null ||
          menuRef.current !== null ||
          document.querySelector(
            ".context-menu, .menu-panel, .cell-menu, .date-picker, .column-picker, .page-size-panel",
          ) !== null ||
          // The structure grid uses Escape to leave a cell, and the bar over
          // it to clear its search or put the name back.
          (document.activeElement instanceof Element &&
            document.activeElement.closest(".structure-grid, .structure-bar") !== null) ||
          modalOpen()
        ) {
          return;
        }
        panelEscape = event;
        return;
      }
      if (event.metaKey && event.ctrlKey && (event.key === "[" || event.key === "]")) {
        event.preventDefault();
        if (!modalOpen()) {
          cycleViewRef.current(event.key === "[" ? -1 : 1);
        }
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      // ⌥1…⌥9 pick a tab. Text fields keep the key: on macOS ⌥ digits type
      // characters (¡ ™ £); the SQL editor isn't one here.
      // On German, Nordic or UK layouts ⌥ digits type [ ] { } | #, which SQL
      // needs: a key that gives plain ASCII is left to the editor.
      if (
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.isComposing &&
        /^Digit[1-9]$/.test(event.code) &&
        !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
        !(target?.closest(".cm-editor") != null && /^[\x20-\x7E]$/.test(event.key)) &&
        document.querySelector(".context-menu") === null &&
        !modalOpen() &&
        tabAtRef.current(Number(event.code.slice(5)))
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // ⌘I in the SQL editor beautifies it, as in TablePlus; elsewhere it
      // stays whatever the keymap gives it (the right panel by default).
      if (matchesBinding(event, BEAUTIFY_KEY) && target?.closest(".sql-editor") != null && !modalOpen()) {
        event.preventDefault();
        event.stopPropagation();
        formatRef.current("beautify");
        return;
      }
      const action = actionForEvent(event, settingsRef.current.keymap);
      if (action === null) {
        return;
      }
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
      // Keys the app takes only in some places (⌘F, ⌘D) are left alone
      // everywhere else, dialogs included.
      if (!claimsKeyRef.current(action, target, modalOpen())) {
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
      // In the grid ⌘↩ opens the cell popover or commits the cell being edited;
      // on a sidebar table it opens the table in a kept tab.
      if (
        action === "run" &&
        event.key === "Enter" &&
        target?.closest(".table-grid, .schema-table-row, .schema-object-row, .date-picker") != null
      ) {
        return;
      }
      // Runs in the capture phase: an app shortcut wins over the browser's
      // default action and over the focused editor's own binding.
      event.preventDefault();
      event.stopPropagation();
      shortcutRef.current(action);
    }
    function onEscape(event: KeyboardEvent): void {
      if (event !== panelEscape) {
        return;
      }
      panelEscape = null;
      const target = event.target instanceof Element ? event.target : null;
      const field = target?.closest("input, textarea, select, [contenteditable], .cm-editor") != null;
      // A Hangul (or other IME) composition is cancelled by it, too.
      if (event.isComposing || (field && event.defaultPrevented)) {
        return;
      }
      // The cell popover counts as a dialog and closes itself.
      if (detailPanelOpenRef.current) {
        setDetailPanelOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keydown", onEscape);
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

  // The result sets of the tab in front, when it ran several statements.
  const resultChips = activeTab !== null ? (resultSets[activeTab.id] ?? null) : null;
  const chipsShown = resultChips !== null && resultChips.conn === activeConnId;
  const planAvailable = state.result !== null && isExplainSql(state.result.sql);
  // The query tab's last run as its result bar reports it. Picking one of
  // several statements' results patches the tab, so this is the one shown.
  const activeQueryTab = activeTab !== null && activeTab.kind === "query" ? activeTab : null;
  const shownResult: ShownResult | null =
    activeQueryTab === null
      ? null
      : activeQueryTab.error !== undefined
        ? { kind: "error" }
        : activeQueryTab.info !== undefined
          ? { kind: "note", text: activeQueryTab.info }
          : activeQueryTab.meta !== undefined
            ? { kind: "ok", meta: activeQueryTab.meta }
            : null;
  // The Message view's lines: every statement of the run, or its only one.
  const statementMessages: StatementMessage[] =
    chipsShown && resultChips !== null
      ? resultChips.entries.map((entry) => ({
          label: entry.label,
          sql: entry.sql,
          outcome: entry.outcome.kind === "ok" ? { kind: "ok", meta: entry.outcome.result.meta } : entry.outcome,
        }))
      : activeQueryTab?.error !== undefined
        ? [{ label: t("결과 {count}", { count: 1 }), sql: "", outcome: { kind: "error", error: activeQueryTab.error } }]
        : shownResult?.kind === "ok"
          ? [{ label: t("결과 {count}", { count: 1 }), sql: "", outcome: { kind: "ok", meta: shownResult.meta } }]
          : [];
  // Notes with no statement line of their own: a lone statement's cancel or
  // expired result, "changes applied". Several statements' lines already say
  // which one was cancelled.
  const tabNote = activeQueryTab?.info ?? null;
  const messageNotes = [chipsShown ? null : tabNote, state.info].filter(
    (note, index, all): note is string =>
      note !== null && all.indexOf(note) === index && !(chipsShown && note === tabNote),
  );
  const detailPanelOpen = activeKey !== null && detailPanels[activeKey] !== false;
  // TablePlus's Data | Structure | Index switch, which leads each view's footer.
  const tableViewTabs =
    activeDataTab !== null ? (
      <div className="view-tabs">
        {(
          [
            ["data", t("데이터")],
            ["structure", t("구조")],
            ["index", t("인덱스")],
          ] as const
        ).map(([view, label]) => (
          <button
            type="button"
            key={view}
            className={(activeDataTab.view ?? "data") === view ? "active" : ""}
            onClick={() => setTableView(view)}
            title={`${label} (⌘⌃[ / ⌘⌃])`}
          >
            {label}
          </button>
        ))}
      </div>
    ) : null;
  // The Structure or Index view's picked rows, which the panel shows instead
  // of the table's info.
  const structureRows =
    structurePick !== null && activeDataTab !== null && structurePick.key === `${activeDataTab.id}:${activeDataTab.view}`
      ? structurePick
      : null;
  // The grid row the panel can describe, if the current tab shows a grid.
  const gridTab =
    activeTab !== null && (activeTab.kind === "query" || (activeTab.kind === "data" && dataView));
  const detailResult = gridTab && resultView === "grid" ? state.result : null;
  // The table the panel describes when no row is picked.
  const detailTable =
    activeTab !== null && (activeTab.kind === "data" || activeTab.kind === "structure")
      ? activeTab.table
      : (detailResult?.meta.sourceTable ?? null);
  const detailOpen = detailPanelOpen && (detailResult !== null || detailTable !== null);

  const detailKey = activeConnId !== null && detailTable !== null ? `${activeConnId}:${detailTable}` : null;
  // Only the current table's detail reaches the panel; a cached one shows at once.
  const panelDetail =
    detailKey === null
      ? null
      : rowDetailInfo?.key === detailKey
        ? rowDetailInfo.detail
        : (detailCacheRef.current.get(detailKey) ?? null);

  useEffect(() => {
    if (!detailOpen || activeConnId === null || detailTable === null || detailKey === null) {
      setRowDetailLoading(false);
      return;
    }
    let alive = true;
    setRowDetailLoading(true);
    void ensureDetail(activeConnId, detailTable)
      .then((detail) => {
        if (alive) {
          setRowDetailInfo({ key: detailKey, detail });
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
  }, [detailOpen, activeConnId, detailTable, detailKey, detailNonce]);

  // The cell popover belongs to the grid result it was opened on.
  useEffect(() => {
    setCellQuickLook(null);
  }, [state.result, resultView]);

  // A new table keeps the panel as it was but has no row picked yet.
  useEffect(() => {
    setCellQuickLook(null);
    setDetailRows(null);
    lastSelectionRef.current = null;
    setStructurePick(null);
    lastStructurePickRef.current = null;
  }, [tabs?.activeId]);

  // A query tab comes back on the pane its last run opened, so an UPDATE's
  // tab shows its message again rather than an empty grid.
  useEffect(() => {
    if (activeQueryTab === null) {
      return;
    }
    setResultView(
      activeQueryTab.error !== undefined || activeQueryTab.meta?.columns.length === 0
        ? "message"
        : planAvailable
          ? "plan"
          : "grid",
    );
  }, [activeConnId, tabs?.activeId]);

  // The column list belongs to the Data view it was opened on.
  useEffect(() => {
    setColumnsPickOpen(false);
  }, [tabs?.activeId, activeDataTab?.view]);
  const filterVisible = activeDataTab !== null && (filterOpen[activeDataTab.id] ?? false);
  const connRunning = state.status === "running" && state.connId === activeConnId;
  // The tab in front is waiting for its rows: its query is running, or its
  // table (just opened, restored or expired) is about to be read, as the
  // auto-load below does for a Data view with no rows, error or cancel.
  const resultLoading =
    activeTab !== null &&
    ((connRunning && runningTabId === activeTab.id) ||
      (activeTab.kind === "data" &&
        (activeTab.view ?? "data") === "data" &&
        activeTab.source === undefined &&
        activeTab.error === undefined &&
        activeTab.info === undefined));
  // The run spinner belongs to this connection's tabs only; a table still
  // opening (reading its structure first) spins too.
  const spinningTabId =
    runningTabId !== null && tabs !== null && tabs.tabs.some((tab) => tab.id === runningTabId)
      ? runningTabId
      : resultLoading && activeTab !== null
        ? activeTab.id
        : null;
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
      // Its own open is still reading the structure and will load it.
      openingTabsRef.current.has(activeDataTab.id) ||
      activeDataTab.error !== undefined ||
      (activeDataTab.view ?? "data") !== "data" ||
      connRunning
    ) {
      return;
    }
    const key = `${activeConnId}:${activeDataTab.id}`;
    if (autoHydratedRef.current.has(key)) {
      return;
    }
    const started = runDataWith(
      activeConnId,
      activeDataTab,
      dataSpecOf(activeDataTab, activeDataTab.offset, activeDataTab.pageSize),
    );
    if (started) {
      autoHydratedRef.current.add(key);
    }
  }, [booting, activeConnId, activeDataTab, connRunning]);

  useEffect(() => {
    if (dataView && resultView !== "grid") {
      setResultView("grid");
    }
  }, [dataView, resultView]);

  if (booting) {
    return (
      <div className="app">
        <div className="home">
          <div className="home-loading">{t("불러오는 중…")}</div>
        </div>
      </div>
    );
  }

  return (
    <>
    <div className="app">
      {/* Home is its own welcome page; the bar belongs to the workspace. */}
      {!home ? (
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
          <button
            type="button"
            className="icon-button appbar-icon"
            onClick={() => setSettingsOpen(true)}
            title={withHint(t("설정"), shortcutHint(settings.keymap, "openSettings"))}
          >
            <SettingsIcon size={13} />
            <span className="sr-only">{t("설정")}</span>
          </button>
        </header>
      ) : null}
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
          onOpenSettings={() => setSettingsOpen(true)}
          paletteHint={shortcutHint(settings.keymap, "palette")}
          settingsHint={shortcutHint(settings.keymap, "openSettings")}
          onConnectSaved={(id) => void connectSavedById(id)}
          onEditConnection={(saved) => openConnectionEditor(saved)}
          savedVersion={savedVersion}
          appError={state.error}
          onDismissAppError={() => store.setError(null)}
        />
      ) : (
        <>
          <div className="tabbar">
            <button
              type="button"
              className={`icon-button tabbar-side${schemaOpen ? " active" : ""}`}
              onClick={() => setSchemaOpen((value) => !value)}
              title={withHint(schemaOpen ? t("스키마 패널 숨기기") : t("스키마 패널 표시"), shortcutHint(settings.keymap, "toggleSidebar"))}
            >
              <PanelLeftIcon size={13} />
            </button>
            {tabs !== null ? (
              <TabStrip
                tabs={tabs.tabs}
                activeId={tabs.activeId}
                runningTabId={spinningTabId}
                onActivate={activate}
                onClose={closeTabById}
                onRename={renameTabById}
                tableColors={activeKey !== null ? tableColors[activeKey] : undefined}
                closeHint={shortcutHint(settings.keymap, "closeTab")}
                onPin={pinTab}
              />
            ) : null}
            <button
              type="button"
              className="icon-button tabbar-new"
              onClick={createNewTab}
              title={withHint(t("새 탭"), shortcutHint(settings.keymap, "newTab"))}
            >
              <PlusIcon size={12} />
            </button>
            <div className="tabbar-actions">
              {jobsRunning > 0 ? (
                <button
                  type="button"
                  className="icon-button tabbar-side tabbar-jobs"
                  title={t("작업 큐 (가져오기·내보내기·덤프)")}
                  onClick={() => setJobsOpen(true)}
                >
                  <JobsIcon size={13} />
                  <span className="toolbar-badge">{jobsRunning}</span>
                </button>
              ) : null}
              {/* An open transaction (BEGIN in the editor, or Run in transaction)
                  shows here until it's committed or rolled back. */}
              {state.tx === "active" ? (
                <div className="tx-slot compact" role="group" aria-label={t("트랜잭션 진행 중")}>
                  <span className="tx-state" title={t("트랜잭션 진행 중")}>
                    <span className="tx-dot" aria-hidden="true" />
                    {t("트랜잭션")}
                  </span>
                  <button
                    type="button"
                    className="primary"
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
                </div>
              ) : null}
              <SafeModeMenu mode={alertMode} onChange={setAlertMode} compact />
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
                className={`icon-button tabbar-side${consoleOpen ? " active" : ""}`}
                onClick={() => setConsoleOpen(!consoleOpen)}
                title={withHint(consoleOpen ? t("아래 콘솔 닫기") : t("아래 콘솔 열기"), shortcutHint(settings.keymap, "toggleConsole"))}
              >
                <PanelBottomIcon size={13} />
              </button>
              <button
                type="button"
                className={`icon-button tabbar-side${detailPanelOpen ? " active" : ""}`}
                onClick={toggleDetailPanel}
                title={withHint(detailPanelOpen ? t("행 상세 패널 닫기") : t("행 상세 패널 열기"), shortcutHint(settings.keymap, "toggleDetail"))}
              >
                <PanelIcon size={13} />
              </button>
            </div>
          </div>
          <div
            className="workbench"
            style={
              {
                ...(sidebarWidth === null ? {} : { "--sidebar-w": `${sidebarWidth}px` }),
                ...(detailWidth === null ? {} : { "--detail-w": `${detailWidth}px` }),
              } as CSSProperties
            }
          >
            {schemaOpen && activeConnId !== null ? (
              <>
                <SidebarPanel
                  key={activeConnId}
                  conn={activeConnId}
                  queries={
                    <QueriesPane onOpen={openSavedQuery} onRun={runInNewTab} onInsert={insertIntoEditor} />
                  }
                  history={(active) => (
                    <HistoryPane
                      conn={activeConnId}
                      version={historyVersion}
                      active={active}
                      onOpen={(sqlText) => void openQueryTab(sqlText)}
                      onRun={runInNewTab}
                      onInsert={insertIntoEditor}
                    />
                  )}
                  items={
                <SchemaSidebar
                  conn={activeConnId}
                  kind={meta?.kind ?? ""}
                  refreshKey={schemaKey}
                  pinned={pinnedTables[activeConnId] ?? EMPTY_TABLES}
                  activeTable={
                    activeTab !== null && (activeTab.kind === "data" || activeTab.kind === "structure")
                      ? activeTab.table
                      : null
                  }
                  onOpenData={(table) => openDataTab(table)}
                  onPinData={(table) => openDataTab(table, { pin: true })}
                  onOpenDataNewTab={(table) => openDataTab(table, { newTab: true })}
                  onOpenInEditor={pickTable}
                  onOpenStructure={(table) => openDataTab(table, { view: "structure" })}
                  onOpenOverview={openOverviewTab}
                  onOpenServer={openServerTab}
                  onOpenDefinition={openDefinitionTab}
                  onTogglePin={togglePin}
                  onTableAction={(action, tables) => void tableAction(action, tables)}
                  onExport={openTableExport}
                  onOpenCreateTable={() => setCreateTableOpen(true)}
                  onImport={(format) => openImport(format, null)}
                  onOpenSql={openSqlTab}
                  onOpenUsers={() => setUserMgrOpen(true)}
                  onSwitchDatabase={serverConn ? (x, y) => void openDbMenu(x, y) : undefined}
                  loadTableDetail={(table) => ensureDetail(activeConnId, table)}
                  tableColors={activeKey !== null ? tableColors[activeKey] : undefined}
                  onSetTableColor={(tables, color) =>
                    setTableColors((prev) => withTableColor(prev, stableKeyOf(activeConnId), tables, color))
                  }
                  onResetTableColors={() => setTableColors((prev) => ({ ...prev, [stableKeyOf(activeConnId)]: {} }))}
                />
                  }
                />
                <div
                  className="sidebar-splitter"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t("스키마 패널 너비")}
                  aria-valuemin={SIDEBAR_MIN}
                  aria-valuemax={SIDEBAR_MAX}
                  aria-valuenow={sidebarWidth ?? undefined}
                  tabIndex={0}
                  title={t("끌어서 너비 조절 · 두 번 누르면 원래대로")}
                  onPointerDown={(event) =>
                    dragPanelEdge(
                      event,
                      event.currentTarget.previousElementSibling,
                      1,
                      clampSidebar,
                      setSidebarWidth,
                      saveSidebarWidth,
                    )
                  }
                  onDoubleClick={() => saveSidebarWidth(null)}
                  onKeyDown={(event) =>
                    keyPanelEdge(event, event.currentTarget.previousElementSibling, 1, clampSidebar, saveSidebarWidth)
                  }
                />
              </>
            ) : null}
            <div className="workbench-stack" ref={stackRef}>
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
                        dialect={meta?.kind}
                      />
                      {/* What acts on the editor lives with it, as in TablePlus. */}
                      <div className="editor-bar">
                        <button
                          type="button"
                          className="icon-text-button"
                          title={t("에디터의 SQL(선택한 부분)을 쿼리 탭에 저장")}
                          onClick={() => setAddQueryOpen(true)}
                        >
                          <StarIcon size={11} />
                          {t("쿼리에 추가")}
                        </button>
                        <button
                          type="button"
                          className="icon-text-button"
                          title={t("SQL 스니펫")}
                          onClick={(event) => {
                            const rect = event.currentTarget.getBoundingClientRect();
                            setSnippetMenu({ x: rect.right - 220, y: rect.top - 4 });
                          }}
                        >
                          <SnippetIcon size={11} />
                          {t("스니펫")}
                        </button>
                        <span className="spacer" />
                        <EditorActions
                          limit={maxRows}
                          running={connRunning}
                          runHint={shortcutHint(settings.keymap, "run")}
                          runAllHint={shortcutHint(settings.keymap, "runAll")}
                          beautifyHint={formatBinding(BEAUTIFY_KEY)}
                          onLimit={(limit) => setSettings(saveSettings({ maxRows: limit }))}
                          onRun={run}
                          onStop={() => store.cancelQuery()}
                          onFormat={formatCurrent}
                          onExplain={explain}
                        />
                      </div>
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
                  {/* Staged edits wait here until applied or dropped. */}
                {pendingSummary !== null && pendingSummary.total > 0 ? (
                  <div className="pending-bar floating" role="status">
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
                      title={withHint(t("변경사항 적용"), shortcutHint(settings.keymap, "applyChanges"))}
                    >
                      {applying ? <Spinner size={13} /> : <CheckIcon size={12} />}
                      {t("변경사항 적용")}
                    </button>
                  </div>
                ) : null}
                  {activeTab === null ? (
                    <EmptyWorkspace onNewQuery={createNewTab} onHome={goHome} />
                  ) : activeTab.kind === "structure" && activeConnId !== null ? (
                    <StructurePanel
                      key={`${activeConnId}:${activeTab.id}`}
                      conn={activeConnId}
                      kind={meta?.kind ?? ""}
                      table={activeTab.table}
                      data={activeTab.data}
                      onRename={(name) => renameTable(activeConnId, activeTab.table, name)}
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
                      {activeDataTab && activeConnId !== null && (activeDataTab.view ?? "data") === "data" ? (
                        <div className="data-toolbar">
                              <DataTabToolbar
                                tab={activeDataTab}
                                viewTabs={tableViewTabs}
                                total={totalOf(activeConnId, activeDataTab)}
                                refreshHint={shortcutHint(settings.keymap, "refresh")}
                                filterHint={shortcutHint(settings.keymap, "openFilter")}
                                running={connRunning}
                                loading={resultLoading}
                                counting={countingTabId === activeDataTab.id}
                                filterOpen={filterVisible}
                                columnsOpen={columnsPickOpen}
                                columnsPicker={
                                  columnsPickOpen ? (
                                    <ColumnPicker
                                      columns={columnEntries}
                                      onToggle={toggleColumn}
                                      onMove={moveColumn}
                                      onAll={resetColumns}
                                      onReset={resetColumns}
                                      onClose={() => setColumnsPickOpen(false)}
                                    />
                                  ) : null
                                }
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
                                onToggleFilter={() => {
                                  if (filterVisible) {
                                    setFilterOpen((prev) => ({ ...prev, [activeDataTab.id]: false }));
                                  } else {
                                    openFilterBar();
                                  }
                                }}
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
                        </div>
                      ) : null}
                      {activeDataTab &&
                      activeConnId !== null &&
                      (activeDataTab.view === "structure" || activeDataTab.view === "index") ? (
                        // One panel for both views, so edits made in either stay
                        // put while switching between them.
                        <StructurePanel
                          key={`${activeConnId}:${activeDataTab.id}:schema`}
                          section={activeDataTab.view === "index" ? "indexes" : "columns"}
                          conn={activeConnId}
                          kind={meta?.kind ?? ""}
                          table={activeDataTab.table}
                          data={activeDataTab.detail}
                          viewTabs={tableViewTabs}
                          onRename={(name) => renameTable(activeConnId, activeDataTab.table, name)}
                          onSelectRows={(pick) =>
                            pickStructureRows(
                              pick === null ? null : { ...pick, key: `${activeDataTab.id}:${activeDataTab.view}` },
                            )
                          }
                          onPending={() => pinTab(activeDataTab.id)}
                          onData={(detail) =>
                            updateActiveTabs((current) =>
                              patchTab(current, activeDataTab.id, { detail }),
                            )
                          }
                          onChanged={() => {
                            void refreshActiveMeta();
                          }}
                        />
                      ) : (
                        <>
                      {activeDataTab && activeConnId !== null && filterVisible ? (
                        <FilterBar
                          columns={dataMeta?.columns ?? EMPTY_TABLES}
                          filter={activeDataTab.filter ?? EMPTY_FILTER}
                          running={connRunning}
                          focusRequest={filterFocus?.tab === activeDataTab.id ? filterFocus.seq : null}
                          defaultColumn={filterFocus?.tab === activeDataTab.id ? filterFocus.column : null}
                          onFocusHandled={() => setFilterFocus(null)}
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
                      {/* Several statements' results: one segment each, the
                          one shown marked, so it's plain which result this is. */}
                      {!dataView && chipsShown && resultChips !== null ? (
                        <div className="result-sets" role="tablist" aria-label={t("쿼리 결과")}>
                          {resultChips.entries.map((entry, index) => {
                            const status =
                              entry.outcome.kind === "ok"
                                ? statementStatus(entry.outcome.result.meta)
                                : entry.outcome.kind === "error"
                                  ? t("오류")
                                  : t("취소됨");
                            return (
                              <button
                                type="button"
                                role="tab"
                                aria-selected={resultChips.active === index}
                                key={entry.label}
                                className={`result-set${resultChips.active === index ? " active" : ""}${entry.outcome.kind === "error" ? " failed" : ""}`}
                                title={(() => {
                                  // A long statement (an INSERT batch) is cut short.
                                  const sql = entry.sql.length > 400 ? `${entry.sql.slice(0, 400)}…` : entry.sql;
                                  return entry.outcome.kind === "error" ? `${sql}\n\n${entry.outcome.error}` : sql;
                                })()}
                                onClick={() => showResultChip(index)}
                              >
                                <span className="result-set-name">{entry.label}</span>
                                <span className="result-set-status">{status}</span>
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
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
                        <div className="data-notice info">{tServer(state.info)}</div>
                      ) : null}
                      <div className="result-body">
                        <div className={`result-layer${resultView === "grid" ? "" : " hidden"}`}>
                          <GridHost
                            ref={gridHostRef}
                            result={state.result}
                            awaitingRows={resultLoading}
                            sortColumns={sortIndicators}
                            onHeaderClick={activeDataTab ? handleHeaderClick : undefined}
                            onSelectionChange={handleSelectionChange}
                            onCellContextMenu={handleCellContextMenu}
                            onDeleteRows={deleteRows}
                            onPasteRows={pasteRows}
                            onQuickLook={(row) => openRowDetail(row)}
                            onCellQuickLook={(row, col) => openCellQuickLook(row, col)}
                            specs={gridSpecs}
                            onLink={(row, col) => void fkJump(row, col)}
                            themeKey={`${settings.theme}:${settings.accent}:${settings.rowAlt}`}
                          />
                          {state.result !== null ? null : resultLoading ? (
                            <LoadingState
                              variant="overlay"
                              label={activeTab?.kind === "data" ? t("불러오는 중…") : t("실행 중…")}
                            >
                              {activeTab?.kind === "data" && connRunning && runningTabId === activeTab.id ? (
                                <button type="button" onClick={() => store.cancelQuery()}>
                                  <StopIcon size={10} />
                                  {t("정지")}
                                </button>
                              ) : null}
                            </LoadingState>
                          ) : activeTab?.kind === "data" ? null : (
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
                          <CellInspector
                            source={state.result.source}
                            columns={state.result.meta.columns}
                            row={cellQuickLook.row}
                            col={cellQuickLook.col}
                            anchor={cellQuickLook.anchor}
                            table={activeDataTab ? activeDataTab.table : state.result.meta.sourceTable}
                            onClose={() => {
                              setCellQuickLook(null);
                              gridHostRef.current?.focus();
                            }}
                          />
                        ) : null}
                        {resultView === "message" && (
                          <div className="message-pane">
                            <StatementMessages entries={statementMessages} />
                            {/* An error no statement line holds (applying edits, say). */}
                            {state.error !== null &&
                            !statementMessages.some(
                              (entry) => entry.outcome.kind === "error" && entry.outcome.error === state.error,
                            ) ? (
                              <ErrorNotice message={state.error} />
                            ) : null}
                            {messageNotes.map((note) => (
                              <div className="message-info" key={note}>
                                {tServer(note)}
                              </div>
                            ))}
                            {statementMessages.length === 0 && state.error === null && messageNotes.length === 0 ? (
                              <div className="message-empty">{t("메시지가 없습니다")}</div>
                            ) : null}
                          </div>
                        )}
                        {/* Rows already shown stay while new ones load; the
                            empty case has the loading state in the middle. */}
                        {connRunning &&
                        state.result !== null &&
                        (runningTabId === null || runningTabId === activeTab?.id) ? (
                          <div className="result-loading" role="status">
                            <Spinner size={12} />
                            {activeTab?.kind === "data" && runningTabId === activeTab.id
                              ? t("불러오는 중…")
                              : t("실행 중…")}
                            {activeTab?.kind === "data" && runningTabId === activeTab.id ? (
                              <button type="button" onClick={() => store.cancelQuery()} title={t("정지")}>
                                {t("정지")}
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      {/* Under the result, as the Data view's footer is (CSS order). */}
                      {activeQueryTab !== null ? (
                        <ResultBar
                          view={resultView}
                          planAvailable={planAvailable}
                          shown={shownResult}
                          canExport={state.result !== null && state.result.meta.columns.length > 0}
                          onView={setResultView}
                          onExport={openExport}
                        />
                      ) : null}
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
              {consoleOpen && activeConnId !== null ? (
                <>
                  <div
                    className="console-splitter"
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label={t("콘솔 높이")}
                    onPointerDown={onConsoleSplitterDown}
                    onDoubleClick={() => saveConsoleHeight(CONSOLE_DEFAULT)}
                  />
                  <ConsolePanel conn={activeConnId} height={consoleHeight} />
                </>
              ) : null}
            </div>
            {detailPanelOpen ? (
              <>
                <div
                  className="detail-splitter"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t("행 상세 패널 너비")}
                  tabIndex={0}
                  title={t("끌어서 너비 조절 · 두 번 누르면 원래대로")}
                  onPointerDown={(event) =>
                    dragPanelEdge(
                      event,
                      event.currentTarget.nextElementSibling,
                      -1,
                      clampDetail,
                      setDetailWidth,
                      saveDetailWidth,
                    )
                  }
                  onDoubleClick={() => saveDetailWidth(null)}
                  onKeyDown={(event) =>
                    keyPanelEdge(event, event.currentTarget.nextElementSibling, -1, clampDetail, saveDetailWidth)
                  }
                />
                <RowDetailPanel
                  source={structureRows?.source ?? detailResult?.source ?? null}
                  columns={structureRows?.source.columns ?? detailResult?.meta.columns ?? EMPTY_TABLES}
                  rows={structureRows?.rows ?? detailRows}
                  tableRows={structureRows === null}
                  table={detailTable}
                  detail={panelDetail}
                  detailLoading={rowDetailLoading}
                  exactRows={meta?.kind === "sqlite"}
                  onOpenReference={(row, col) => void fkJump(row, col)}
                />
              </>
            ) : null}
          </div>
        </>
      )}
      <div className="flash-toast" role="status">
        {flash}
      </div>
      {state.error !== null && !errorInline ? (
        <ErrorNotice message={state.error} variant="toast" onClose={() => store.setError(null)} />
      ) : null}
      {menu !== null && menu.result === state.result ? (
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
            forgetTableDetails();
            setMetaNonce((value) => value + 1);
            void refreshActiveMeta();
            openDataTab(table);
          }}
        />
      ) : null}
      {discardPrompt !== null ? (
        <DiscardModal
          applyHint={shortcutHint(settings.keymap, "applyChanges")}
          onCancel={() => setDiscardPrompt(null)}
          onDiscard={() => {
            setDiscardPrompt(null);
            for (const source of discardPrompt.sources) {
              source.discardPending();
            }
            discardPrompt.proceed();
          }}
        />
      ) : null}
      {addQueryOpen ? (
        <PromptModal
          title={t("쿼리에 추가")}
          label={t("이름")}
          placeholder={t("쿼리 이름")}
          confirmLabel={t("저장")}
          onSubmit={addEditorToQueries}
          onClose={() => setAddQueryOpen(false)}
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
              label: t("데이터베이스 만들기…"),
              separatorBefore: true,
              onSelect: () => {
                void createDatabase();
              },
            },
            {
              label: t("데이터베이스 삭제…"),
              onSelect: () => {
                void dropDatabase();
              },
            },
            {
              label: t("백업 (SQL 덤프)…"),
              separatorBefore: true,
              onSelect: () => {
                setDbMenu(null);
                setDumpTab("backup");
              },
            },
            {
              label: t("복원 (SQL 실행)…"),
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
              label: t("테이블 내보내기…"),
              disabled: meta === null,
              onSelect: () => openTableExport(activeDataTab !== null ? [activeDataTab.table] : []),
            },
            {
              label: t("가져오기"),
              disabled: meta === null,
              submenu: [
                { label: t("CSV에서…"), onSelect: () => openImport("csv", activeDataTab?.table ?? null) },
                { label: t("JSON에서…"), onSelect: () => openImport("json", activeDataTab?.table ?? null) },
                { label: t("SQL 덤프에서…"), onSelect: () => openImport("sql", null) },
              ],
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
      {exportTarget !== null && meta !== null && (
        <ExportModal target={exportTarget} meta={meta} onClose={() => setExportTarget(null)} />
      )}
      {importTarget !== null && activeConnId !== null && meta !== null && (
        <ImportModal
          conn={activeConnId}
          kind={meta.kind}
          format={importTarget.format}
          tables={meta.tables}
          table={importTarget.table}
          onImported={(table) => {
            // Row counts, and a new table in the list; an open tab on the
            // table shows what came in (the import may finish in the background).
            const conn = activeConnId;
            forgetTableDetails();
            setMetaNonce((value) => value + 1);
            void refreshActiveMeta();
            const ws = workspacesRef.current[conn];
            const tab = ws !== undefined ? activeTabOf(ws.tabs) : null;
            if (tab !== null && tab.kind === "data" && tab.table === table) {
              runDataWith(conn, tab, dataSpecOf(tab, 0, tab.pageSize));
            }
          }}
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
            forgetTableDetails();
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
      {activityOpen && <ActivityModal onClose={() => setActivityOpen(false)} />}
      {metricsOpen && activeConnId !== null && (
        <MetricsModal conn={activeConnId} onClose={() => setMetricsOpen(false)} />
      )}
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
