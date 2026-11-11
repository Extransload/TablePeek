import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { bothLanguages, languageLabel, t, type Language } from "../i18n";
import { getThemesVersion, subscribeThemes, THEMES, type Theme } from "../palette";
import { type TableSlot } from "../termTheme";
import { importTernFile, loadTernThemes, removeTernFile } from "../ternThemes";
import { fontGroups, fontListLabel, SYSTEM_CODE_FONT, SYSTEM_UI_FONT, type InstalledFont } from "../fonts";
import { store } from "../store";
import { setSettingsDock } from "../dock";
import { BACKGROUND_ACCEPT, BACKGROUND_BLUR_MAX, BUILTIN_BACKGROUNDS, builtinBackground, type BackgroundFit } from "../background";
import { MATERIAL_BLUR_MAX, subscribeMaterial, windowTranslucent, type Material } from "../material";
import { dragPanelEdge, keyPanelEdge, storedWidth, storeWidth } from "../panelEdge";
import {
  activeThemeId,
  CODE_FONT_MAX,
  CODE_FONT_MIN,
  currentAccent,
  currentGridColors,
  currentSyntaxColors,
  DEFAULT_SETTINGS,
  drawnFonts,
  getPasscodeHash,
  MAX_QUERY_TIMEOUT,
  MAX_ROWS_LIMIT,
  previewSettings,
  setPasscodeHash,
  sha256Hex,
  showsDark,
  subscribeSystemDark,
  systemDark,
  UI_FONT_MAX,
  UI_FONT_MIN,
  type AppSettings,
  type ThemeMode,
} from "../settings";
import {
  DEFAULT_KEYMAP,
  formatBinding,
  KEY_ACTIONS,
  KEY_ACTION_LABELS,
  bindingFromEvent,
  isEditingBinding,
  isReservedBinding,
  matchesBinding,
  type KeyAction,
  type Keymap,
} from "../shortcuts";
import { SYNTAX_PRESETS, type SyntaxPresetId } from "../syntax";
import {
  CloseIcon,
  CodeIcon,
  KeyboardIcon,
  LockIcon,
  PlusIcon,
  SearchIcon,
  SlidersIcon,
  SparkleIcon,
  SunIcon,
  TableIcon,
  TransferIcon,
} from "./icons";
import { notifyError } from "./ErrorNotice";
import { Select } from "./Select";
import { ColorRows, ColorTableRow, EditorPreview, GRID_COLOR_ROWS, SYNTAX_COLOR_ROWS } from "./settings/colorRows";
import { FontRow, SizeRow, ThemeRow } from "./settings/pickerRows";
import {
  Choice,
  focusRow,
  Highlight,
  isField,
  nextChoice,
  rowControls,
  ScopeContext,
  SettingRow,
  SettingsGroup,
  Slider,
  Switch,
} from "./settings/rows";
import { VersionSettings } from "./settings/VersionSettings";
import { AiSettings } from "./settings/AiSettings";

// Settings as a sheet docked to the right edge, beside the app so a change
// shows in it at once, and run from the keyboard as Tern's is: ↑↓ move from
// setting to setting, ←→ switch pages, ⏎ or Space flips a switch, steps a
// choice or opens a menu or picker (or goes into a field or a row of
// buttons, where ←→ move between them), typing (or ⌘F) searches every page,
// ⌫ puts a changed setting back to its default, and Esc goes back one step
// (out of a field, then the search, then the sheet). Tab stays in the sheet:
// the search, the page tabs, the settings, the close button and the sheet's
// edge are one stop each, with arrows inside. The edge drags (or ←→ on it)
// to resize.

interface SettingsSheetProps {
  settings: AppSettings;
  // A page to show: the one it opens on, and where it goes on each new
  // request (a fresh object each time, so asking again after moving away works).
  page?: { id: SettingsPage };
  onChange(patch: Partial<AppSettings>): void;
  onLock(): void;
  onClose(): void;
}

export type SettingsPage = "general" | "appearance" | "editor" | "data" | "transfer" | "keyboard" | "ai" | "privacy";

interface PageItem {
  id: SettingsPage;
  // A message key.
  label: string;
  icon: (props: { size?: number }) => ReactElement;
}

// Tern's pages: what the app looks like in one place (themes, colours,
// fonts), then what only the SQL editor and only the data table take.
const PAGES: PageItem[] = [
  { id: "general", label: "일반", icon: SlidersIcon },
  { id: "appearance", label: "모양", icon: SunIcon },
  { id: "editor", label: "SQL 에디터", icon: CodeIcon },
  { id: "data", label: "데이터 테이블", icon: TableIcon },
  { id: "transfer", label: "가져오기·내보내기", icon: TransferIcon },
  { id: "keyboard", label: "단축키", icon: KeyboardIcon },
  { id: "ai", label: "AI", icon: SparkleIcon },
  { id: "privacy", label: "보안", icon: LockIcon },
];

const SHEET_WIDTH_KEY = "tablepeek.settings-width";
const SHEET_DEFAULT = 480;
const SHEET_MIN = 380;
const SHEET_MAX = 880;
const SEARCH_KEY = "Mod+f";

// Wide enough for a row's name beside its control, and leaving the app room.
function clampSheet(width: number): number {
  const max = Math.max(SHEET_MIN, Math.min(SHEET_MAX, window.innerWidth - 240));
  return Math.round(Math.min(Math.max(width, SHEET_MIN), max));
}

const MATERIAL_OPTIONS: { value: Material; label: string }[] = [
  { value: "solid", label: "불투명" },
  { value: "glass", label: "유리" },
  { value: "clear", label: "투명" },
];

const FIT_OPTIONS: { value: BackgroundFit; label: string }[] = [
  { value: "cover", label: "채우기" },
  { value: "contain", label: "맞추기" },
  { value: "tile", label: "바둑판" },
];

// The docked parts' own colour over a translucent page (settings.ts).
type SurfaceKey = "surfaceTop" | "surfaceLeft" | "surfaceRight" | "surfaceBottom" | "surfaceBars" | "surfaceSheet";
const SURFACE_ROWS: { key: SurfaceKey; label: string; keywords: string }[] = [
  { key: "surfaceTop", label: "상단 바", keywords: "surface top bar tab strip app bar 탭" },
  { key: "surfaceLeft", label: "왼쪽 사이드바", keywords: "surface left sidebar schema tables 테이블 목록" },
  { key: "surfaceRight", label: "오른쪽 사이드바", keywords: "surface right sidebar row detail 행 상세" },
  { key: "surfaceBottom", label: "하단 콘솔", keywords: "surface bottom console log 콘솔" },
  { key: "surfaceBars", label: "도구 막대", keywords: "surface toolbar result bar 결과 막대" },
  { key: "surfaceSheet", label: "설정 창", keywords: "surface settings sheet 설정" },
];

// The floating surfaces' own opacities when they turn to glass (material.ts).
type FloatingKey = "floatingOpacity" | "noticeOpacity";
const READABLE_HINT =
  "글자가 읽히도록 뒤가 8px 이상 흐려지면 60% 아래로 내려가지 않고, 덜 흐려지면 불투명합니다.";
const FLOATING_ROWS: { key: FloatingKey; label: string; keywords: string; hint: string }[] = [
  {
    key: "floatingOpacity",
    label: "떠 있는 창",
    keywords: "floating surface opacity quick look dialog palette menu popover 퀵룩 대화 상자 메뉴",
    hint: `Quick Look, 대화 상자, 명령 팔레트, 메뉴, 툴팁의 바탕입니다. ${READABLE_HINT}`,
  },
  { key: "noticeOpacity", label: "알림", keywords: "notice toast banner opacity 토스트 배너", hint: READABLE_HINT },
];

const MODE_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "라이트" },
  { value: "dark", label: "다크" },
  { value: "system", label: "시스템" },
];

// Which part of the sheet has the keys, for the hints along its foot.
interface FocusHint {
  esc: string;
  changed: boolean;
}

export function SettingsSheet({ settings, page: requestedPage, onChange, onLock, onClose }: SettingsSheetProps) {
  // Where the keys were before the sheet took them: they go back on close.
  const [opener] = useState(() => document.activeElement);
  const sheetRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const edgeRef = useRef<HTMLDivElement>(null);
  // The row the keys were last on: Tab comes back to it.
  const currentRow = useRef<HTMLElement | null>(null);
  // Where the keys go once a page is drawn: its first row when the sheet
  // opens or ←→ switch pages from a row, the page's tab from the tabs.
  const focusAfter = useRef<"row" | "tab" | null>("row");
  const [page, setPage] = useState<SettingsPage>(requestedPage?.id ?? "general");
  // Counts switches to a page (the same one again too, leaving a search).
  const [visit, setVisit] = useState(0);
  const [query, setQuery] = useState("");
  const [noMatch, setNoMatch] = useState(false);
  const [hint, setHint] = useState<FocusHint>({ esc: "", changed: false });
  const [width, setWidth] = useState<number | null>(() => storedWidth(SHEET_WIDTH_KEY, clampSheet));
  // The AI shortcut is listed only while AI is on.
  const aiEnabled = useSyncExternalStore(store.subscribeAi, store.getAiStatus)?.enabled === true;
  // Whether this window can be see-through, to word the material's note.
  const translucent = useSyncExternalStore(subscribeMaterial, windowTranslucent);
  // The background picture's file chooser, opened by its row and button.
  const backgroundFileRef = useRef<HTMLInputElement>(null);
  // The pickers redraw as themes come in (Tern's, an imported file), and the
  // theme shown changes with the system's mode under System.
  useSyncExternalStore(subscribeThemes, getThemesVersion);
  useSyncExternalStore(subscribeSystemDark, systemDark);
  const [ternState, setTernState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    let live = true;
    loadTernThemes().then(
      () => live && setTernState("ready"),
      () => live && setTernState("failed"),
    );
    return () => {
      live = false;
    };
  }, []);

  const [capturing, setCapturing] = useState<KeyAction | null>(null);
  const [captureHint, setCaptureHint] = useState<string | null>(null);
  const [passcode, setPasscode] = useState("");
  const [passcodeConfirm, setPasscodeConfirm] = useState("");
  const [passcodeMessage, setPasscodeMessage] = useState<string | null>(null);
  const [hasPasscode, setHasPasscode] = useState(() => getPasscodeHash() !== null);
  // Empty until the server answers: the system's faces show meanwhile.
  const [fontFamilies, setFontFamilies] = useState<InstalledFont[]>([]);

  useEffect(() => {
    let live = true;
    // Asked each time the sheet opens: the server lists the fonts again when
    // one was installed or removed meanwhile.
    void store.listFonts().catch(() => []).then((families) => {
      if (live) {
        setFontFamilies(families);
      }
    });
    return () => {
      live = false;
    };
  }, []);
  const installedGroups = useMemo(() => fontGroups(fontFamilies), [fontFamilies]);

  useEffect(() => {
    const sheet = sheetRef.current;
    return () => {
      // Still up: StrictMode trying the effect again, not a close.
      if (sheet?.isConnected) {
        return;
      }
      // Something the close put up took the keys (the lock screen's field).
      const active = document.activeElement;
      if (active !== null && active !== document.body) {
        return;
      }
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [opener]);

  function rows(): HTMLElement[] {
    return Array.from(bodyRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? []);
  }

  function activeTab(): HTMLElement | null {
    return tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? null;
  }

  // Each page starts at its top, with the keys where the switch asked.
  useLayoutEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
    const after = focusAfter.current;
    focusAfter.current = null;
    if (after === "tab") {
      activeTab()?.focus();
    } else if (after === "row") {
      const first = rows()[0];
      if (first !== undefined) {
        focusRow(first);
      } else {
        searchRef.current?.focus();
      }
    }
  }, [visit]);

  function focusHint(element: Element | null): FocusHint {
    const row = element instanceof HTMLElement ? element.closest<HTMLElement>("[data-row]") : null;
    const inside = row !== null && element !== row;
    return {
      esc: inside ? t("필드에서 나가기") : query !== "" ? t("검색 지우기") : t("설정 닫기"),
      changed: row !== null && !inside && row.dataset.changed !== undefined,
    };
  }

  // After each change: whether the search found nothing, and the foot's
  // hints for where the keys are (a reset changes the row they are on). The
  // keys never drop out of the sheet when what had them goes (a search's
  // results, a row a choice hides): they go to the search.
  useLayoutEffect(() => {
    const none = query.trim() !== "" && rows().length === 0;
    if (none !== noMatch) {
      setNoMatch(none);
    }
    if (document.activeElement === document.body) {
      searchRef.current?.focus();
    }
    const next = focusHint(document.activeElement);
    if (next.esc !== hint.esc || next.changed !== hint.changed) {
      setHint(next);
    }
  });

  function onSheetFocus(event: ReactFocusEvent<HTMLDivElement>): void {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>("[data-row]");
    if (row !== null) {
      currentRow.current = row;
    }
    setHint(focusHint(target));
  }

  function switchPage(next: SettingsPage, focus: "row" | "tab" | null): void {
    setQuery("");
    focusAfter.current = focus;
    setPage(next);
    setVisit((count) => count + 1);
  }

  // Asked for a page while open (the AI prompt's "set up" button): go there.
  useEffect(() => {
    if (requestedPage !== undefined && requestedPage.id !== page) {
      switchPage(requestedPage.id, "row");
    }
    // Only a new request moves the sheet; switching pages by hand stays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedPage]);

  function stepPage(by: 1 | -1, focus: "row" | "tab"): void {
    const index = PAGES.findIndex((item) => item.id === page);
    switchPage(PAGES[(index + by + PAGES.length) % PAGES.length].id, focus);
  }

  // ↑↓ from a row (or the tabs, or nowhere yet): the next row, or up past
  // the first to the tabs (the search while searching) and on to the search.
  function stepRow(row: HTMLElement | null, by: 1 | -1, fromTabs: boolean): void {
    const list = rows();
    if (fromTabs) {
      if (by > 0 && list[0] !== undefined) {
        focusRow(list[0]);
      } else if (by < 0) {
        searchRef.current?.focus();
      }
      return;
    }
    const index = row === null ? -1 : list.indexOf(row);
    const next = index < 0 ? (by > 0 ? list[0] : list[list.length - 1]) : list[index + by];
    if (next !== undefined) {
      focusRow(next);
    } else if (by < 0) {
      (query !== "" ? searchRef.current : activeTab())?.focus();
    }
  }

  // ←→ inside a row of several controls.
  function stepControl(row: HTMLElement, target: HTMLElement, by: 1 | -1): void {
    const controls = rowControls(row);
    const index = controls.findIndex((control) => control === target || control.contains(target));
    controls[index + by]?.focus();
  }

  // The sheet's Tab stops, in order: each a box the keys can be inside and
  // where Tab puts them.
  function tabStops(): { box: HTMLElement; focus(): void }[] {
    const stops: { box: HTMLElement; focus(): void }[] = [];
    const search = searchRef.current;
    const tabs = tabsRef.current;
    const body = bodyRef.current;
    if (search !== null) {
      stops.push({ box: search, focus: () => search.focus() });
    }
    if (tabs !== null) {
      stops.push({ box: tabs, focus: () => (activeTab() ?? tabs.querySelector<HTMLElement>('[role="tab"]'))?.focus() });
    }
    const list = rows();
    if (body !== null && list.length > 0) {
      stops.push({
        box: body,
        focus: () => {
          const row = currentRow.current;
          focusRow(row !== null && row.isConnected && body.contains(row) ? row : list[0]);
        },
      });
    }
    for (const element of [closeRef.current, edgeRef.current]) {
      if (element !== null) {
        stops.push({ box: element, focus: () => element.focus() });
      }
    }
    return stops;
  }

  function cycleStops(target: HTMLElement, by: 1 | -1): void {
    const stops = tabStops();
    const index = stops.findIndex((stop) => stop.box.contains(target));
    const next = index < 0 ? (by > 0 ? 0 : stops.length - 1) : (index + by + stops.length) % stops.length;
    stops[next]?.focus();
  }

  // A closed menu field keeps ↑↓ for moving between rows, not for opening.
  function onSheetKeyDownCapture(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const target = event.target;
    if (
      target instanceof HTMLSelectElement &&
      target.getAttribute("aria-expanded") !== "true" &&
      (event.key === "ArrowDown" || event.key === "ArrowUp") &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      stepRow(target.closest<HTMLElement>("[data-row]"), event.key === "ArrowDown" ? 1 : -1, false);
    }
  }

  function onSheetKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const sheet = sheetRef.current;
    const target = event.target as HTMLElement;
    // ⌘F goes to the search from anywhere in the sheet, not to the
    // browser's find.
    if (sheet !== null && sheet.contains(target) && matchesBinding(event.nativeEvent, SEARCH_KEY)) {
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
      return;
    }
    // A dialog or picker opened from the sheet sits outside it, over the app.
    if (sheet === null || !sheet.contains(target) || event.defaultPrevented || event.nativeEvent.isComposing) {
      return;
    }
    const row = target.closest<HTMLElement>("[data-row]");
    const onRow = row !== null && target === row;
    if (event.key === "Tab") {
      event.preventDefault();
      cycleStops(target, event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (row !== null && !onRow) {
        focusRow(row);
      } else if (query !== "") {
        setQuery("");
        searchRef.current?.focus();
      } else {
        onClose();
      }
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (target === searchRef.current) {
      if (event.key === "ArrowDown" || event.key === "Enter") {
        event.preventDefault();
        const first = rows()[0];
        if (first !== undefined) {
          focusRow(first);
        } else if (query === "") {
          activeTab()?.focus();
        }
      }
      return;
    }
    if (isField(target)) {
      // ⏎ is done with the field (its value is already in).
      if (event.key === "Enter" && row !== null && !(target instanceof HTMLTextAreaElement)) {
        event.preventDefault();
        focusRow(row);
      }
      return;
    }
    const fromTabs = target.closest('[role="tablist"]') !== null;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        stepRow(row, event.key === "ArrowDown" ? 1 : -1, fromTabs);
        return;
      case "ArrowLeft":
      case "ArrowRight": {
        event.preventDefault();
        const by = event.key === "ArrowLeft" ? -1 : 1;
        if (row !== null && !onRow) {
          stepControl(row, target, by);
        } else {
          stepPage(by, fromTabs ? "tab" : "row");
        }
        return;
      }
      case "Home":
      case "End": {
        if (fromTabs) {
          event.preventDefault();
          switchPage(event.key === "Home" ? PAGES[0].id : PAGES[PAGES.length - 1].id, "tab");
          return;
        }
        const list = rows();
        const edge = event.key === "Home" ? list[0] : list[list.length - 1];
        if (edge !== undefined) {
          event.preventDefault();
          focusRow(edge);
        }
        return;
      }
    }
    // Typing searches: the keys move to the search field before the key
    // lands, so the browser types it there itself, and an input method
    // (Korean, Japanese) composes there from the first key ("Process" while
    // it holds the key). A closed menu keeps the letters: they pick an option.
    const typed = (event.key.length === 1 && event.key !== " ") || event.key === "Process" || event.keyCode === 229;
    const search = searchRef.current;
    if (typed && search !== null && !(target instanceof HTMLSelectElement)) {
      search.setSelectionRange(search.value.length, search.value.length);
      search.focus();
    }
  }

  function saveWidth(next: number | null): void {
    setWidth(next);
    storeWidth(SHEET_WIDTH_KEY, next);
  }

  useEffect(() => {
    if (capturing === null) {
      return;
    }
    const action: KeyAction = capturing;
    function onCapture(event: KeyboardEvent): void {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapturing(null);
        setCaptureHint(null);
        return;
      }
      const binding = bindingFromEvent(event);
      if (binding === null) {
        if (!["Meta", "Control", "Shift", "Alt"].includes(event.key)) {
          setCaptureHint(t("⌘/Ctrl 또는 ⌥/Alt와 함께 누르세요"));
        }
        return;
      }
      if (isEditingBinding(binding)) {
        setCaptureHint(t("복사·붙여넣기·실행 취소 같은 편집 키는 쓸 수 없습니다"));
        return;
      }
      if (!settings.keymap[action].includes(binding)) {
        setBindings(action, [...settings.keymap[action], binding]);
      }
      setCapturing(null);
      setCaptureHint(null);
    }
    // Clicking anywhere else stops waiting for a key; the add button toggles itself.
    function onPointerDown(event: PointerEvent): void {
      if (!(event.target instanceof Element && event.target.closest(".shortcut-add"))) {
        setCapturing(null);
        setCaptureHint(null);
      }
    }
    window.addEventListener("keydown", onCapture, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onCapture, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [capturing, settings.keymap, onChange]);

  // A combination belongs to one action: giving it to `action` takes it away
  // from any other.
  function setBindings(action: KeyAction, bindings: string[]): void {
    const next = {} as Keymap;
    for (const key of KEY_ACTIONS) {
      next[key] = key === action ? bindings : settings.keymap[key].filter((entry) => !bindings.includes(entry));
    }
    onChange({ keymap: next });
  }

  const shownId = activeThemeId(settings);
  // A theme tried on from the other mode's list shows in its mode meanwhile.
  const darkShown = showsDark(settings);

  // A colour picked for parts of the shown theme's syntax, data table or
  // colour table, or none to go back to the theme's own.
  function pickThemeColor(field: "syntaxColors" | "gridColors" | "tableColors", keys: string[], color: string | null): void {
    const picks: Record<string, string | undefined> = { ...settings[field][shownId] };
    for (const key of keys) {
      if (color === null) {
        delete picks[key];
      } else {
        picks[key] = color;
      }
    }
    const next: Record<string, Record<string, string | undefined>> = { ...settings[field] };
    if (Object.keys(picks).length === 0) {
      delete next[shownId];
    } else {
      next[shownId] = picks;
    }
    onChange({ [field]: next });
  }

  // A Tern theme file becomes the theme of its mode, shown at once unless
  // the mode follows the system.
  async function importTernTheme(file: File): Promise<void> {
    try {
      const imported = await importTernFile(file);
      onChange({
        [imported.mode === "light" ? "themeLight" : "themeDark"]: imported.id,
        ...(settings.themeMode === "system" ? {} : { themeMode: imported.mode }),
      });
    } catch (error) {
      notifyError(error);
    }
  }

  // A picture file becomes the background: the server keeps it, the
  // settings its stamp, so every window shows it.
  async function pickBackground(file: File): Promise<void> {
    try {
      onChange({ backgroundImage: await store.setBackgroundImage(file) });
    } catch (error) {
      notifyError(error);
    }
  }

  // No picture: a picked one is let go of on the server too; a built-in one
  // only leaves the settings.
  async function clearBackground(): Promise<void> {
    if (builtinBackground(settings.backgroundImage) !== null) {
      onChange({ backgroundImage: "" });
      return;
    }
    try {
      await store.clearBackgroundImage();
      onChange({ backgroundImage: "" });
    } catch (error) {
      notifyError(error);
    }
  }

  // An imported theme removed, with the colours picked for it; the default
  // theme of its mode takes its place.
  function removeImported(theme: Theme): void {
    removeTernFile(theme.id);
    const drop = <T,>(picks: Record<string, T>): Record<string, T> =>
      Object.fromEntries(Object.entries(picks).filter(([id]) => id !== theme.id));
    onChange({
      themeLight: settings.themeLight === theme.id ? DEFAULT_SETTINGS.themeLight : settings.themeLight,
      themeDark: settings.themeDark === theme.id ? DEFAULT_SETTINGS.themeDark : settings.themeDark,
      syntaxColors: drop(settings.syntaxColors),
      gridColors: drop(settings.gridColors),
      tableColors: drop(settings.tableColors),
    });
  }

  async function applyPasscode(): Promise<void> {
    if (passcode.trim().length < 4) {
      setPasscodeMessage(t("4자 이상 입력하세요"));
      return;
    }
    if (passcode !== passcodeConfirm) {
      setPasscodeMessage(t("입력한 값이 서로 다릅니다"));
      return;
    }
    setPasscodeHash(await sha256Hex(passcode));
    setHasPasscode(true);
    setPasscode("");
    setPasscodeConfirm("");
    setPasscodeMessage(t("잠금 암호를 설정했습니다"));
  }

  async function removePasscode(): Promise<void> {
    const hash = getPasscodeHash();
    if (hash === null) {
      setHasPasscode(false);
      return;
    }
    if ((await sha256Hex(passcode)) !== hash) {
      setPasscodeMessage(t("현재 암호가 올바르지 않습니다"));
      return;
    }
    setPasscodeHash(null);
    setHasPasscode(false);
    setPasscode("");
    setPasscodeConfirm("");
    setPasscodeMessage(t("잠금 암호를 해제했습니다"));
  }

  // A setting's row props for "changed from its default" and Reset.
  function fromDefault<K extends keyof AppSettings>(key: K): { changed: boolean; onReset(): void } {
    return {
      changed: settings[key] !== DEFAULT_SETTINGS[key],
      onReset: () => onChange({ [key]: DEFAULT_SETTINGS[key] }),
    };
  }

  // The code font's name, for the fonts following it.
  function codeFontName(): string {
    if (settings.codeFont === "") {
      return t("시스템 고정폭");
    }
    const choice = installedGroups.flatMap((group) => group.choices).find((item) => item.value === settings.codeFont);
    return choice?.label ?? fontListLabel(settings.codeFont);
  }

  function renderPage(id: SettingsPage): ReactNode {
    const theme = THEMES.find((item) => item.id === shownId);
    const fonts = drawnFonts(settings);
    switch (id) {
      case "general": {
        const languages: { value: Language; label: string }[] = (["ko", "en"] as Language[]).map((language) => ({
          value: language,
          label: languageLabel(language),
        }));
        return (
          <>
            <SettingsGroup>
              <SettingRow
                label="언어"
                keywords="language"
                {...fromDefault("language")}
                onActivate={() => onChange({ language: nextChoice(languages, settings.language) })}
              >
                <Choice
                  label={t("언어")}
                  value={settings.language}
                  options={languages}
                  onChange={(language) => onChange({ language })}
                />
              </SettingRow>
            </SettingsGroup>
            <VersionSettings />
            <SettingsGroup title="활동 로그">
              <SettingRow label="보관 기간(일)" keywords="activity log retention days" {...fromDefault("activityDays")}>
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={settings.activityDays}
                  aria-label={t("보관 기간(일)")}
                  onChange={(event) =>
                    onChange({
                      activityDays: Math.min(90, Math.max(1, Number(event.target.value) || 7)),
                    })
                  }
                />
              </SettingRow>
            </SettingsGroup>
          </>
        );
      }

      case "appearance": {
        const materials = MATERIAL_OPTIONS.map((option) => ({ ...option, label: t(option.label) }));
        const fits = FIT_OPTIONS.map((option) => ({ ...option, label: t(option.label) }));
        const modes = MODE_OPTIONS.map((option) => ({ ...option, label: t(option.label) }));
        const accent = currentAccent(settings);
        const onlyTheme = theme ? t("{theme}에만 저장됩니다.", { theme: t(theme.label) }) : undefined;
        // Over a picture or in a see-through window: the docked parts' rows;
        // with glass floating surfaces: theirs.
        const pageTranslucent = settings.backgroundImage !== "" || (translucent === true && settings.material !== "solid");
        const floatingGlass = settings.backgroundImage !== "" || settings.material !== "solid";
        return (
          <>
            <SettingsGroup title="테마">
              <SettingRow
                label="모드"
                keywords="appearance mode light dark system theme 라이트 다크 시스템 테마"
                {...fromDefault("themeMode")}
                onActivate={() => onChange({ themeMode: nextChoice(modes, settings.themeMode) })}
              >
                <Choice
                  label={t("모드")}
                  value={settings.themeMode}
                  options={modes}
                  onChange={(themeMode) => onChange({ themeMode })}
                />
              </SettingRow>
              <ThemeRow
                label="라이트 테마"
                mode="light"
                value={settings.themeLight}
                defaultValue={DEFAULT_SETTINGS.themeLight}
                tern={ternState}
                onPick={(themeLight) => onChange({ themeLight })}
                preview={(themeLight) => ({ themeLight, ...(darkShown ? { themeMode: "light" as const } : {}) })}
                onImport={(file) => void importTernTheme(file)}
                onRemove={removeImported}
              />
              <ThemeRow
                label="다크 테마"
                mode="dark"
                value={settings.themeDark}
                defaultValue={DEFAULT_SETTINGS.themeDark}
                tern={ternState}
                onPick={(themeDark) => onChange({ themeDark })}
                preview={(themeDark) => ({ themeDark, ...(darkShown ? {} : { themeMode: "dark" as const }) })}
                onImport={(file) => void importTernTheme(file)}
                onRemove={removeImported}
              />
            </SettingsGroup>
            {/* The colours picked here belong to the theme shown. */}
            <SettingsGroup title="색">
              <SettingRow
                label="강조 색"
                keywords="accent color colour"
                changed={settings.accent !== ""}
                onReset={() => onChange({ accent: "" })}
              >
                <span className="settings-color-value mono">{accent}</span>
                <input
                  type="color"
                  aria-label={t("강조 색")}
                  value={accent}
                  onChange={(event) => onChange({ accent: event.target.value })}
                />
              </SettingRow>
              {theme !== undefined ? (
                <ColorTableRow
                  theme={theme}
                  picks={settings.tableColors[theme.id] ?? {}}
                  onPick={(slots: TableSlot[], color) => pickThemeColor("tableColors", slots, color)}
                />
              ) : null}
            </SettingsGroup>
            <SettingsGroup title="구문 색">
              <SettingRow
                label="구문 강조"
                keywords="syntax highlight preset color colour sql editor 에디터"
                hint={t(SYNTAX_PRESETS.find((preset) => preset.id === settings.syntaxPreset)?.description ?? "")}
                {...fromDefault("syntaxPreset")}
              >
                <Select
                  aria-label={t("구문 강조")}
                  value={settings.syntaxPreset}
                  onChange={(event) => onChange({ syntaxPreset: event.target.value as SyntaxPresetId })}
                  onPreview={(id) => previewSettings(id === null ? null : { syntaxPreset: id as SyntaxPresetId })}
                >
                  {SYNTAX_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {t(preset.label)}
                    </option>
                  ))}
                </Select>
              </SettingRow>
              <ColorRows
                rows={SYNTAX_COLOR_ROWS}
                colors={currentSyntaxColors(settings)}
                picked={settings.syntaxColors[shownId] ?? {}}
                keywords="syntax color colour sql editor 에디터"
                hint={onlyTheme}
                onPick={(keys, color) => pickThemeColor("syntaxColors", keys, color)}
              />
            </SettingsGroup>
            <EditorPreview />
            <SettingsGroup title="값 색">
              <SettingRow
                label="타입별 색상"
                keywords="type colors colours value data table 데이터 테이블"
                {...fromDefault("typeColors")}
              >
                <Switch
                  label={t("타입별 색상")}
                  checked={settings.typeColors}
                  onChange={(typeColors) => onChange({ typeColors })}
                />
              </SettingRow>
              <ColorRows
                rows={GRID_COLOR_ROWS}
                colors={currentGridColors(settings)}
                picked={settings.gridColors[shownId] ?? {}}
                keywords="value type color colour data table 데이터 테이블"
                hint={!settings.typeColors ? t("‘타입별 색상’이 꺼져 있어 NULL 말고는 지금 쓰이지 않습니다.") : onlyTheme}
                onPick={(keys, color) => pickThemeColor("gridColors", keys, color)}
              />
            </SettingsGroup>
            <SettingsGroup title="글꼴">
              <FontRow
                label="글꼴"
                keywords="font typeface 폰트 interface ui 인터페이스 sidebar 사이드바"
                value={settings.uiFont}
                follow={{ label: t("시스템 기본"), value: SYSTEM_UI_FONT }}
                groups={installedGroups}
                onChange={(uiFont) => onChange({ uiFont })}
                preview={(uiFont) => ({ uiFont })}
              />
              <SizeRow
                label="글자 크기"
                keywords="font size 폰트 크기"
                value={settings.uiFontSize}
                follows={null}
                min={UI_FONT_MIN}
                max={UI_FONT_MAX}
                defaultValue={DEFAULT_SETTINGS.uiFontSize}
                onChange={(size) => onChange({ uiFontSize: size ?? DEFAULT_SETTINGS.uiFontSize })}
                preview={(size) => ({ uiFontSize: size ?? DEFAULT_SETTINGS.uiFontSize })}
              />
              <FontRow
                label="코드 글꼴"
                hint={t("SQL 에디터와 데이터 테이블이 따릅니다.")}
                keywords="code font monospace mono typeface 폰트 고정폭"
                value={settings.codeFont}
                follow={{ label: t("시스템 고정폭"), value: SYSTEM_CODE_FONT }}
                groups={installedGroups}
                onChange={(codeFont) => onChange({ codeFont })}
                preview={(codeFont) => ({ codeFont })}
              />
              <SizeRow
                label="코드 글자 크기"
                keywords="code font size 폰트 크기"
                value={settings.codeFontSize}
                follows={settings.uiFontSize}
                min={CODE_FONT_MIN}
                max={CODE_FONT_MAX}
                defaultValue={DEFAULT_SETTINGS.codeFontSize}
                onChange={(codeFontSize) => onChange({ codeFontSize })}
                preview={(codeFontSize) => ({ codeFontSize })}
              />
              <FontRow
                label="에디터 글꼴"
                keywords="editor font typeface 폰트 console 콘솔 sql 에디터"
                value={settings.editorFont}
                follow={{ label: t("코드 글꼴 · {name}", { name: codeFontName() }) }}
                groups={installedGroups}
                onChange={(editorFont) => onChange({ editorFont })}
                preview={(editorFont) => ({ editorFont })}
              />
              <SizeRow
                label="에디터 글자 크기"
                keywords="editor font size 폰트 크기 sql 에디터"
                value={settings.editorFontSize}
                follows={fonts.codeSize}
                min={CODE_FONT_MIN}
                max={CODE_FONT_MAX}
                defaultValue={DEFAULT_SETTINGS.editorFontSize}
                onChange={(editorFontSize) => onChange({ editorFontSize })}
                preview={(editorFontSize) => ({ editorFontSize })}
              />
              <FontRow
                label="표 글꼴"
                keywords="grid table data font typeface 폰트 데이터 테이블"
                value={settings.gridFont}
                follow={{ label: t("코드 글꼴 · {name}", { name: codeFontName() }) }}
                groups={installedGroups}
                onChange={(gridFont) => onChange({ gridFont })}
                preview={(gridFont) => ({ gridFont })}
              />
              <SizeRow
                label="표 글자 크기"
                keywords="grid table font size 폰트 크기 데이터 테이블"
                value={settings.gridFontSize}
                follows={fonts.codeSize}
                min={CODE_FONT_MIN}
                max={CODE_FONT_MAX}
                defaultValue={DEFAULT_SETTINGS.gridFontSize}
                onChange={(gridFontSize) => onChange({ gridFontSize })}
                preview={(gridFontSize) => ({ gridFontSize })}
              />
            </SettingsGroup>
            <SettingsGroup title="재질">
              <SettingRow
                label="재질"
                keywords="material solid glass clear transparency 투명도 유리"
                hint={translucent === true ? null : t("브라우저 탭에서는 떠 있는 면만 유리가 됩니다.")}
                {...fromDefault("material")}
                onActivate={() => onChange({ material: nextChoice(materials, settings.material) })}
              >
                <Choice
                  label={t("재질")}
                  value={settings.material}
                  options={materials}
                  onChange={(next) => onChange({ material: next })}
                />
              </SettingRow>
              {settings.material !== "solid" ? (
                <SettingRow label="불투명도" keywords="opacity window" {...fromDefault("materialOpacity")}>
                  <Slider
                    label={t("불투명도")}
                    value={settings.materialOpacity}
                    max={100}
                    unit="%"
                    onChange={(materialOpacity) => onChange({ materialOpacity })}
                  />
                </SettingRow>
              ) : null}
              {settings.material === "clear" ? (
                <SettingRow label="흐림" keywords="blur radius" {...fromDefault("materialBlur")}>
                  <Slider
                    label={t("흐림")}
                    value={settings.materialBlur}
                    max={MATERIAL_BLUR_MAX}
                    unit="px"
                    onChange={(materialBlur) => onChange({ materialBlur })}
                  />
                </SettingRow>
              ) : null}
            </SettingsGroup>
            <SettingsGroup title="배경 이미지">
              <SettingRow
                label="이미지"
                keywords="background wallpaper picture image photo 배경 화면 바탕 사진 기본 이미지 built-in"
                hint={t("TablePeek에 들어 있는 사진을 고르거나 내 이미지(PNG, JPEG, GIF, WebP)를 고릅니다. 내 이미지는 모든 창에 같이 깔립니다.")}
                wide
                changed={settings.backgroundImage !== ""}
                onReset={() => void clearBackground()}
                onActivate={() => backgroundFileRef.current?.click()}
              >
                <div className="settings-backdrop-gallery" role="group" aria-label={t("이미지")}>
                  <button
                    type="button"
                    className="settings-backdrop-tile none"
                    aria-pressed={settings.backgroundImage === ""}
                    title={t("없음")}
                    onClick={() => void clearBackground()}
                  >
                    {t("없음")}
                  </button>
                  {BUILTIN_BACKGROUNDS.map((picture) => (
                    <button
                      key={picture.stamp}
                      type="button"
                      className="settings-backdrop-tile"
                      aria-pressed={builtinBackground(settings.backgroundImage)?.stamp === picture.stamp}
                      aria-label={t(picture.label)}
                      title={t(picture.label)}
                      style={{ backgroundImage: `url("${picture.thumb}")` }}
                      onClick={() => onChange({ backgroundImage: picture.stamp })}
                    />
                  ))}
                  {settings.backgroundImage !== "" && builtinBackground(settings.backgroundImage) === null ? (
                    <button
                      type="button"
                      className="settings-backdrop-tile picked"
                      aria-pressed
                      aria-label={t("바꾸기…")}
                      title={t("바꾸기…")}
                      onClick={() => backgroundFileRef.current?.click()}
                    />
                  ) : (
                    <button
                      type="button"
                      className="settings-backdrop-tile none"
                      aria-pressed={false}
                      aria-label={t("이미지 선택…")}
                      title={t("이미지 선택…")}
                      onClick={() => backgroundFileRef.current?.click()}
                    >
                      <PlusIcon size={14} />
                    </button>
                  )}
                </div>
                <input
                  ref={backgroundFileRef}
                  type="file"
                  accept={BACKGROUND_ACCEPT}
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file !== undefined) {
                      void pickBackground(file);
                    }
                  }}
                />
              </SettingRow>
              {settings.backgroundImage !== "" ? (
                <>
                  {builtinBackground(settings.backgroundImage) === null ? (
                    <SettingRow
                      label="맞춤"
                      keywords="background fit cover contain tile repeat 채우기 맞추기 바둑판"
                      {...fromDefault("backgroundFit")}
                      onActivate={() => onChange({ backgroundFit: nextChoice(fits, settings.backgroundFit) })}
                    >
                      <Choice
                        label={t("맞춤")}
                        value={settings.backgroundFit}
                        options={fits}
                        onChange={(backgroundFit) => onChange({ backgroundFit })}
                      />
                    </SettingRow>
                  ) : null}
                  <SettingRow
                    label="이미지 위 불투명도"
                    keywords="background opacity 배경 불투명도"
                    hint={t("앱 바탕이 이미지 위에 깔리는 정도입니다. 낮을수록 이미지가 잘 보입니다. 영역마다 더 진하게 하려면 아래 영역별 불투명도를 올리세요.")}
                    {...fromDefault("backgroundOpacity")}
                  >
                    <Slider
                      label={t("이미지 위 불투명도")}
                      value={settings.backgroundOpacity}
                      max={100}
                      unit="%"
                      onChange={(backgroundOpacity) => onChange({ backgroundOpacity })}
                    />
                  </SettingRow>
                  <SettingRow label="이미지 흐림" keywords="background blur 배경 흐림" {...fromDefault("backgroundBlur")}>
                    <Slider
                      label={t("이미지 흐림")}
                      value={settings.backgroundBlur}
                      max={BACKGROUND_BLUR_MAX}
                      unit="px"
                      onChange={(backgroundBlur) => onChange({ backgroundBlur })}
                    />
                  </SettingRow>
                </>
              ) : null}
            </SettingsGroup>
            {pageTranslucent || floatingGlass ? (
              <SettingsGroup
                title="영역별 불투명도"
                hint={t("본문(편집기와 표) 위로 각 영역의 바탕이 깔리는 정도입니다. 0%면 본문과 같이 구분 없이 이어집니다.")}
              >
                {pageTranslucent
                  ? SURFACE_ROWS.map((row) => (
                      <SettingRow key={row.key} label={row.label} keywords={row.keywords} {...fromDefault(row.key)}>
                        <Slider
                          label={t(row.label)}
                          value={settings[row.key]}
                          max={100}
                          unit="%"
                          onChange={(value) => onChange({ [row.key]: value } as Pick<AppSettings, SurfaceKey>)}
                        />
                      </SettingRow>
                    ))
                  : null}
                {floatingGlass
                  ? FLOATING_ROWS.map((row) => (
                      <SettingRow
                        key={row.key}
                        label={row.label}
                        keywords={row.keywords}
                        hint={t(row.hint)}
                        {...fromDefault(row.key)}
                      >
                        <Slider
                          label={t(row.label)}
                          value={settings[row.key]}
                          max={100}
                          unit="%"
                          onChange={(value) => onChange({ [row.key]: value } as Pick<AppSettings, FloatingKey>)}
                        />
                      </SettingRow>
                    ))
                  : null}
              </SettingsGroup>
            ) : null}
            <SettingsGroup title="표시">
              <SettingRow label="줄무늬 행 배경" keywords="alternate row stripe zebra" {...fromDefault("rowAlt")}>
                <Switch label={t("줄무늬 행 배경")} checked={settings.rowAlt} onChange={(rowAlt) => onChange({ rowAlt })} />
              </SettingRow>
              <SettingRow label="가로 스크롤바 항상 표시" keywords="scrollbar" {...fromDefault("scrollbarX")}>
                <Switch
                  label={t("가로 스크롤바 항상 표시")}
                  checked={settings.scrollbarX}
                  onChange={(scrollbarX) => onChange({ scrollbarX })}
                />
              </SettingRow>
              <SettingRow label="세로 스크롤바 항상 표시" keywords="scrollbar" {...fromDefault("scrollbarY")}>
                <Switch
                  label={t("세로 스크롤바 항상 표시")}
                  checked={settings.scrollbarY}
                  onChange={(scrollbarY) => onChange({ scrollbarY })}
                />
              </SettingRow>
              <SettingRow
                label="동작 줄이기"
                keywords="reduce motion animation transition 애니메이션 동작 모션"
                {...fromDefault("reduceMotion")}
              >
                <Switch
                  label={t("동작 줄이기")}
                  checked={settings.reduceMotion}
                  onChange={(reduceMotion) => onChange({ reduceMotion })}
                />
              </SettingRow>
            </SettingsGroup>
          </>
        );
      }

      case "editor":
        return (
          <SettingsGroup title="편집">
            <SettingRow label="정리·축약할 때 키워드를 대문자로" keywords="uppercase keywords format" {...fromDefault("uppercaseKeywords")}>
              <Switch
                label={t("정리·축약할 때 키워드를 대문자로")}
                checked={settings.uppercaseKeywords}
                onChange={(uppercaseKeywords) => onChange({ uppercaseKeywords })}
              />
            </SettingRow>
          </SettingsGroup>
        );

      case "data":
        return (
          <SettingsGroup title="쿼리">
            <SettingRow label="최대 행" keywords="max rows limit" {...fromDefault("maxRows")}>
              <input
                type="number"
                min={1}
                max={MAX_ROWS_LIMIT}
                value={settings.maxRows}
                aria-label={t("최대 행")}
                onChange={(event) =>
                  onChange({
                    maxRows: Math.min(MAX_ROWS_LIMIT, Math.max(1, Math.trunc(Number(event.target.value)) || 1)),
                  })
                }
              />
            </SettingRow>
            <SettingRow
              label="쿼리 시간 제한(초)"
              keywords="query timeout seconds mongodb clickhouse"
              hint={t("MongoDB와 ClickHouse에 쓰입니다. 0이면 제한이 없습니다.")}
              {...fromDefault("queryTimeout")}
            >
              <input
                type="number"
                min={0}
                max={MAX_QUERY_TIMEOUT}
                value={settings.queryTimeout}
                aria-label={t("쿼리 시간 제한(초)")}
                onChange={(event) =>
                  onChange({
                    queryTimeout: Math.min(MAX_QUERY_TIMEOUT, Math.max(0, Math.trunc(Number(event.target.value)) || 0)),
                  })
                }
              />
            </SettingRow>
          </SettingsGroup>
        );

      case "transfer":
        return (
          <SettingsGroup title="CSV">
            <SettingRow label="CSV 구분자" keywords="delimiter separator" {...fromDefault("csvDelimiter")}>
              <Select
                aria-label={t("CSV 구분자")}
                value={settings.csvDelimiter}
                onChange={(event) => onChange({ csvDelimiter: event.target.value })}
              >
                <option value=",">{t(", (쉼표)")}</option>
                <option value={"\t"}>Tab</option>
                <option value=";">{t("; (세미콜론)")}</option>
                <option value="|">{t("| (파이프)")}</option>
              </Select>
            </SettingRow>
            <SettingRow label="첫 행을 헤더로 사용" keywords="header" {...fromDefault("csvHeader")}>
              <Switch label={t("첫 행을 헤더로 사용")} checked={settings.csvHeader} onChange={(csvHeader) => onChange({ csvHeader })} />
            </SettingRow>
            <SettingRow label="인코딩" keywords="encoding" {...fromDefault("csvEncoding")}>
              <Select
                aria-label={t("인코딩")}
                value={settings.csvEncoding}
                onChange={(event) => onChange({ csvEncoding: event.target.value as AppSettings["csvEncoding"] })}
              >
                <option value="utf-8">UTF-8</option>
                <option value="euc-kr">EUC-KR</option>
                <option value="utf-16le">UTF-16LE</option>
              </Select>
            </SettingRow>
          </SettingsGroup>
        );

      case "keyboard": {
        const anyChanged = KEY_ACTIONS.some((action) => settings.keymap[action].join("\n") !== DEFAULT_KEYMAP[action].join("\n"));
        return (
          <SettingsGroup
            hint={t("TablePeek 단축키가 브라우저 단축키보다 먼저 실행됩니다. {keys}는 브라우저가 먼저 처리합니다.", {
              keys: ["Mod+w", "Mod+t", "Mod+n"].map(formatBinding).join(" · "),
            })}
          >
            {KEY_ACTIONS.filter((action) => action !== "aiSql" || aiEnabled).map((action) => {
              const changed = settings.keymap[action].join("\n") !== DEFAULT_KEYMAP[action].join("\n");
              const startCapture = () => {
                setCaptureHint(null);
                setCapturing(capturing === action ? null : action);
              };
              return (
                <SettingRow
                  key={action}
                  label={KEY_ACTION_LABELS[action]}
                  keywords={`shortcut ${settings.keymap[action].map(formatBinding).join(" ")}`}
                  changed={changed}
                  onReset={() => setBindings(action, [...DEFAULT_KEYMAP[action]])}
                  onActivate={startCapture}
                >
                  <div className="shortcut-bindings">
                    {settings.keymap[action].map((binding) => {
                      const reserved = isReservedBinding(binding);
                      return (
                        <span
                          key={binding}
                          className={`shortcut-chip${reserved ? " reserved" : ""}`}
                          title={
                            reserved
                              ? t("브라우저가 예약한 조합이라 브라우저 탭에서는 브라우저 동작이 먼저 실행됩니다")
                              : undefined
                          }
                        >
                          <kbd>{formatBinding(binding)}</kbd>
                          {reserved ? (
                            <span className="shortcut-warn" aria-hidden="true">
                              !
                            </span>
                          ) : null}
                          <button
                            type="button"
                            className="shortcut-remove"
                            onClick={() =>
                              setBindings(
                                action,
                                settings.keymap[action].filter((entry) => entry !== binding),
                              )
                            }
                            title={t("이 단축키 지우기")}
                            aria-label={t("이 단축키 지우기")}
                          >
                            ×
                          </button>
                        </span>
                      );
                    })}
                    <button
                      type="button"
                      className={`shortcut-add${capturing === action ? " active" : ""}`}
                      title={t("누른 뒤 키 조합을 누르세요. Esc로 취소합니다. 다른 동작에 쓰이던 조합은 이쪽으로 옮겨집니다.")}
                      aria-label={capturing === action ? undefined : t("단축키 추가")}
                      onClick={startCapture}
                    >
                      {capturing === action ? (captureHint ?? t("키 입력 대기…")) : <PlusIcon size={10} />}
                    </button>
                  </div>
                </SettingRow>
              );
            })}
            <SettingRow label="모든 단축키를 기본값으로" keywords="shortcut reset">
              <button
                type="button"
                disabled={!anyChanged}
                onClick={() => {
                  const next = {} as Keymap;
                  for (const action of KEY_ACTIONS) {
                    next[action] = [...DEFAULT_KEYMAP[action]];
                  }
                  onChange({ keymap: next });
                }}
              >
                {t("기본값으로")}
              </button>
            </SettingRow>
          </SettingsGroup>
        );
      }

      case "ai":
        return <AiSettings />;

      case "privacy":
        return (
          <SettingsGroup title="잠금 암호">
            <SettingRow label="암호" keywords="passcode lock password">
              <input
                type="password"
                aria-label={t("암호")}
                placeholder={t("암호")}
                value={passcode}
                onChange={(event) => setPasscode(event.target.value)}
              />
            </SettingRow>
            <SettingRow label="확인" keywords="passcode confirm">
              <input
                type="password"
                aria-label={t("확인")}
                placeholder={t("확인")}
                value={passcodeConfirm}
                onChange={(event) => setPasscodeConfirm(event.target.value)}
              />
            </SettingRow>
            <SettingRow label={hasPasscode ? "암호 변경/해제" : "새 암호"} keywords="passcode lock" hint={passcodeMessage}>
              <button type="button" onClick={() => void applyPasscode()}>
                {hasPasscode ? t("변경") : t("저장")}
              </button>
              {hasPasscode ? (
                <>
                  <button type="button" onClick={() => void removePasscode()}>
                    {t("해제")}
                  </button>
                  <button type="button" onClick={onLock}>
                    {t("지금 잠금")}
                  </button>
                </>
              ) : null}
            </SettingRow>
          </SettingsGroup>
        );
    }
  }

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const sheetWidth = clampSheet(width ?? SHEET_DEFAULT);
  // Docked, not floating: the app gives up the sheet's width and keeps
  // working beside it, its overlays kept left of the sheet (dock.ts).
  useLayoutEffect(() => {
    setSettingsDock(sheetWidth);
  }, [sheetWidth]);
  useLayoutEffect(() => () => setSettingsDock(null), []);
  // Pages whose name is searched for: offered first, ⏎ opens one.
  const pageHits = terms.length === 0 ? [] : PAGES.filter((item) => {
    const name = bothLanguages(item.label).toLowerCase();
    return terms.every((term) => name.includes(term));
  });

  function onPageHitKey(event: ReactKeyboardEvent<HTMLDivElement>, id: SettingsPage): void {
    if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      switchPage(id, "row");
    }
  }

  return (
    <>
      <div
        ref={sheetRef}
        className="settings-sheet"
        role="dialog"
        aria-label={t("설정")}
        tabIndex={-1}
        style={{ width: sheetWidth }}
        onKeyDownCapture={onSheetKeyDownCapture}
        onKeyDown={onSheetKeyDown}
        onFocus={onSheetFocus}
      >
        <div
          ref={edgeRef}
          className="settings-sheet-edge"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("설정 너비")}
          aria-valuenow={sheetWidth}
          aria-valuemin={SHEET_MIN}
          aria-valuemax={SHEET_MAX}
          tabIndex={0}
          title={t("끌어서 너비 조절 · 두 번 누르면 원래대로")}
          onPointerDown={(event) => dragPanelEdge(event, sheetRef.current, -1, clampSheet, setWidth, saveWidth)}
          onDoubleClick={() => saveWidth(null)}
          onKeyDown={(event) => keyPanelEdge(event, sheetRef.current, -1, clampSheet, saveWidth)}
        />
        <header className="settings-sheet-head">
          <span className="settings-sheet-title">{t("설정")}</span>
          <button
            ref={closeRef}
            type="button"
            className="icon-button settings-sheet-close"
            title={t("닫기")}
            aria-label={t("닫기")}
            onClick={onClose}
          >
            <CloseIcon size={12} />
          </button>
        </header>
        <label className="settings-search">
          <SearchIcon size={12} />
          <input
            ref={searchRef}
            type="text"
            value={query}
            placeholder={t("설정 검색 {key}", { key: formatBinding(SEARCH_KEY) })}
            aria-label={t("설정 검색")}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div
          ref={tabsRef}
          className={`settings-tabs${terms.length > 0 ? " searching" : ""}`}
          role="tablist"
          aria-label={t("설정 페이지")}
        >
          {PAGES.map((item) => {
            const Icon = item.icon;
            const selected = page === item.id;
            const name = t(item.label);
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-label={name}
                title={name}
                tabIndex={selected ? 0 : -1}
                className={selected ? "active" : ""}
                onClick={() => switchPage(item.id, null)}
              >
                <Icon size={13} />
              </button>
            );
          })}
        </div>
        <div className="settings-sheet-body" ref={bodyRef} role="tabpanel">
          {terms.length === 0 ? (
            <ScopeContext.Provider value={{ terms, page: "", group: "" }}>{renderPage(page)}</ScopeContext.Provider>
          ) : (
            <>
              {pageHits.length > 0 ? (
                <section className="settings-results">
                  <h3 className="settings-results-title">{t("페이지")}</h3>
                  <div className="settings-box">
                    {pageHits.map((item) => {
                      const Icon = item.icon;
                      return (
                        <div
                          key={item.id}
                          className="settings-row settings-page-hit"
                          data-row=""
                          tabIndex={-1}
                          role="button"
                          onKeyDown={(event) => onPageHitKey(event, item.id)}
                          onClick={() => switchPage(item.id, "row")}
                        >
                          <Icon size={13} />
                          <span className="settings-row-label">
                            <Highlight text={t(item.label)} terms={terms} />
                          </span>
                          <span className="settings-page-hit-go" aria-hidden="true">
                            →
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : null}
              {PAGES.map((item) => (
                <ScopeContext.Provider key={item.id} value={{ terms, page: bothLanguages(item.label), group: "" }}>
                  <section className="settings-results">
                    <h3 className="settings-results-title">{t(item.label)}</h3>
                    {renderPage(item.id)}
                  </section>
                </ScopeContext.Provider>
              ))}
              {noMatch ? <p className="settings-empty">{t("더 짧은 단어나 페이지 이름으로 찾아 보세요")}</p> : null}
            </>
          )}
        </div>
        <footer className="settings-sheet-foot" aria-hidden="true">
          <span>
            <kbd>↑↓</kbd>
            {t("설정 이동")}
          </span>
          <span>
            <kbd>←→</kbd>
            {t("페이지 전환")}
          </span>
          <span>
            <kbd>⏎</kbd>
            {t("설정 바꾸기")}
          </span>
          {hint.changed ? (
            <span>
              <kbd>⌫</kbd>
              {t("재설정")}
            </span>
          ) : null}
          <span className="spacer" />
          <span>
            <kbd>esc</kbd>
            {hint.esc}
          </span>
        </footer>
      </div>
    </>
  );
}
