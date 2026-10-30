import {
  applyPalette,
  contrastInk,
  defaultTypeInks,
  mixHex,
  themeById,
  VALUE_KINDS,
  type Palette,
  type Theme,
  type ThemeId,
  type ValueKind,
} from "./palette";
import { SYSTEM_CODE_FONT, SYSTEM_UI_FONT, declareFaces } from "./fonts";
import { setLanguage, type Language } from "./i18n";
import { KEYMAP_VERSION, normalizeKeymap, type Keymap } from "./shortcuts";
import {
  EXTRA_SYNTAX_VARIABLES,
  SYNTAX_COLOR_KEYS,
  syntaxColors,
  syntaxPresetById,
  SYNTAX_VARIABLES,
  type SyntaxColorKey,
  type SyntaxColorPicks,
  type SyntaxPresetId,
} from "./syntax";

export type ThemeMode = ThemeId;
export type CsvEncoding = "utf-8" | "euc-kr" | "utf-16le";
// The parts of the data table a colour can be picked for: each kind of value
// and NULL.
export type GridColorKey = ValueKind | "null";
export type GridColorPicks = Partial<Record<GridColorKey, string>>;
export const GRID_COLOR_KEYS: GridColorKey[] = [...VALUE_KINDS, "null"];

export interface AppSettings {
  language: Language;
  theme: ThemeMode;
  accent: string;
  // Fonts and sizes (px) in three places, as TablePlus has them; menus,
  // tabs, toolbars and dialogs keep the system's font at its usual size.
  // The SQL editor's, the console's and code shown elsewhere.
  fontFamily: string;
  fontSize: number;
  // Every table: the data grid, structure, previews.
  gridFontFamily: string;
  gridFontSize: number;
  // The left sidebar and the right detail panel.
  sidebarFontFamily: string;
  sidebarFontSize: number;
  rowAlt: boolean;
  typeColors: boolean;
  // The grid's and the editor's scrollbars kept in view on each axis,
  // instead of the system's, which may show only while scrolling.
  scrollbarX: boolean;
  scrollbarY: boolean;
  uppercaseKeywords: boolean;
  syntaxPreset: SyntaxPresetId;
  // Colours picked in Settings → Theme over the syntax colours, by theme:
  // like TablePlus's, a theme's colours stay with it.
  syntaxColors: Record<string, SyntaxColorPicks>;
  // The same for the data table's colours by kind of value, by theme.
  gridColors: Record<string, GridColorPicks>;
  activityDays: number;
  csvDelimiter: string;
  csvHeader: boolean;
  csvEncoding: CsvEncoding;
  // Rows a query run fetches at most.
  maxRows: number;
  // Seconds a MongoDB query (its maxTimeMS), a mongosh script or a ClickHouse
  // statement (its max_execution_time) may run; 0 for no limit.
  queryTimeout: number;
  keymap: Keymap;
  // The keymap defaults this was saved under (see KEYMAP_VERSION).
  keymapVersion: number;
}

export const MAX_ROWS_LIMIT = 500000;
// A day: the longest query time limit Settings takes.
export const MAX_QUERY_TIMEOUT = 86400;
export const EDITOR_FONT_MIN = 10;
export const EDITOR_FONT_MAX = 24;
export const GRID_FONT_MIN = 10;
export const GRID_FONT_MAX = 24;
export const SIDEBAR_FONT_MIN = 10;
export const SIDEBAR_FONT_MAX = 18;
// The size the app is drawn at: every px size in styles.css is for it.
const BASE_UI_PX = 12;

function clampSize(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export const DEFAULT_SETTINGS: AppSettings = {
  language: "ko",
  theme: "dark",
  accent: "#4082ee",
  fontFamily: SYSTEM_CODE_FONT,
  fontSize: 12,
  gridFontFamily: SYSTEM_CODE_FONT,
  gridFontSize: 12,
  sidebarFontFamily: SYSTEM_CODE_FONT,
  sidebarFontSize: 12,
  rowAlt: true,
  typeColors: true,
  scrollbarX: true,
  scrollbarY: true,
  uppercaseKeywords: true,
  syntaxPreset: "tablepeek",
  syntaxColors: {},
  gridColors: {},
  activityDays: 7,
  csvDelimiter: ",",
  csvHeader: true,
  csvEncoding: "utf-8",
  maxRows: 10000,
  queryTimeout: 60,
  keymap: normalizeKeymap(null),
  keymapVersion: KEYMAP_VERSION,
};

const STORAGE_KEY = "tablepeek.settings";
const PASSCODE_KEY = "tablepeek.passcode-hash";
const ACCENT_SOFT = "rgba(64, 130, 238, 0.18)";

type Listener = (settings: AppSettings) => void;
const listeners = new Set<Listener>();
let current = readSettings();

function readSettings(): AppSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return { ...DEFAULT_SETTINGS, keymap: normalizeKeymap(null) };
    }
    const { hideScroller, uiFontFamily: _appFont, uiFontSize, ...parsed } = JSON.parse(raw) as Partial<AppSettings> & {
      hideScroller?: boolean;
      uiFontFamily?: string;
      uiFontSize?: number;
    };
    // "Hide scrollbars" from earlier versions: neither kept in view.
    const shown = hideScroller === true ? false : DEFAULT_SETTINGS.scrollbarX;
    // Earlier versions drew the grid and the sidebar's names in the code
    // font, at the one size the whole app took: they start from those.
    const codeFont = typeof parsed.fontFamily === "string" ? parsed.fontFamily : DEFAULT_SETTINGS.fontFamily;
    return {
      ...DEFAULT_SETTINGS,
      scrollbarX: shown,
      scrollbarY: shown,
      gridFontFamily: codeFont,
      sidebarFontFamily: codeFont,
      ...parsed,
      language: parsed.language === "en" ? "en" : "ko",
      theme: themeById(parsed.theme ?? DEFAULT_SETTINGS.theme).id,
      syntaxPreset: syntaxPresetById(parsed.syntaxPreset).id,
      syntaxColors: readColorPicks(parsed.syntaxColors, SYNTAX_COLOR_KEYS),
      gridColors: readColorPicks(parsed.gridColors, GRID_COLOR_KEYS),
      fontSize: clampSize(parsed.fontSize, EDITOR_FONT_MIN, EDITOR_FONT_MAX, DEFAULT_SETTINGS.fontSize),
      gridFontSize: clampSize(
        parsed.gridFontSize ?? uiFontSize,
        GRID_FONT_MIN,
        GRID_FONT_MAX,
        DEFAULT_SETTINGS.gridFontSize,
      ),
      sidebarFontSize: clampSize(
        parsed.sidebarFontSize ?? uiFontSize,
        SIDEBAR_FONT_MIN,
        SIDEBAR_FONT_MAX,
        DEFAULT_SETTINGS.sidebarFontSize,
      ),
      maxRows:
        typeof parsed.maxRows === "number" && Number.isFinite(parsed.maxRows)
          ? Math.min(MAX_ROWS_LIMIT, Math.max(1, Math.trunc(parsed.maxRows)))
          : DEFAULT_SETTINGS.maxRows,
      queryTimeout:
        typeof parsed.queryTimeout === "number" && Number.isFinite(parsed.queryTimeout)
          ? Math.min(MAX_QUERY_TIMEOUT, Math.max(0, Math.trunc(parsed.queryTimeout)))
          : DEFAULT_SETTINGS.queryTimeout,
      // Settings saved before keymapVersion existed count as version 1.
      keymap: normalizeKeymap(parsed.keymap, typeof parsed.keymapVersion === "number" ? parsed.keymapVersion : 1),
      keymapVersion: KEYMAP_VERSION,
    };
  } catch {
    return { ...DEFAULT_SETTINGS, keymap: normalizeKeymap(null) };
  }
}

// Saved colour picks: hex colours of known parts only, under each theme.
function readColorPicks<K extends string>(value: unknown, keys: readonly K[]): Record<string, Partial<Record<K, string>>> {
  const picks: Record<string, Partial<Record<K, string>>> = {};
  if (typeof value !== "object" || value === null) {
    return picks;
  }
  for (const [theme, colors] of Object.entries(value)) {
    if (typeof colors !== "object" || colors === null) {
      continue;
    }
    const kept: Partial<Record<K, string>> = {};
    for (const [key, color] of Object.entries(colors)) {
      if (keys.includes(key as K) && typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)) {
        kept[key as K] = color;
      }
    }
    if (Object.keys(kept).length > 0) {
      picks[theme] = kept;
    }
  }
  return picks;
}

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  if (![r, g, b].every((n) => Number.isFinite(n))) {
    return ACCENT_SOFT;
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// The theme's palette as `settings` draw it: their accent, the alternate row
// background or not, and the data table colours picked for this theme.
function themePalette(theme: Theme, settings: AppSettings): Palette {
  const { accent, rowAlt } = settings;
  const palette = { ...theme.palette };
  const { null: nullInk, ...kinds } = settings.gridColors[theme.id] ?? {};
  palette.typeInks = {
    ...defaultTypeInks(theme.mode),
    ...(theme.palette.typeInks ?? {}),
    ...kinds,
  };
  if (nullInk !== undefined) {
    palette.nullInk = nullInk;
  }
  palette.accent = accent;
  palette.accentHover = mixHex(accent, theme.mode === "light" ? "#000000" : "#ffffff", 0.14);
  palette.onAccent = contrastInk(accent);
  if (!rowAlt) {
    palette.rowAlt = palette.bg;
  }
  palette.selLine = accent;
  palette.selFill = hexToRgba(accent, theme.mode === "light" ? 0.13 : 0.2);
  palette.selFillFocus = hexToRgba(accent, theme.mode === "light" ? 0.21 : 0.32);
  return palette;
}

export function applySettings(settings: AppSettings): void {
  const root = document.documentElement;
  setLanguage(settings.language);
  const theme = themeById(settings.theme);
  const palette = themePalette(theme, settings);
  applyPalette(palette);
  root.dataset.theme = theme.id;
  root.dataset.mode = theme.mode;
  root.style.colorScheme = theme.mode;
  root.style.setProperty("--bg", palette.bg);
  root.style.setProperty("--panel", palette.panel);
  root.style.setProperty("--head", palette.head);
  root.style.setProperty("--line", palette.line);
  root.style.setProperty("--line-soft", mixHex(palette.line, palette.bg, 0.4));
  root.style.setProperty("--ink", palette.ink);
  root.style.setProperty("--muted", palette.muted);
  root.style.setProperty("--faint", palette.faint);
  root.style.setProperty("--accent", palette.accent);
  root.style.setProperty("--accent-hover", palette.accentHover);
  root.style.setProperty("--accent-contrast", palette.onAccent);
  root.style.setProperty("--accent-soft", hexToRgba(settings.accent, 0.18));
  root.style.setProperty("--accent-line", hexToRgba(settings.accent, 0.5));
  root.style.setProperty("--error", palette.error);
  root.style.setProperty("--ok", palette.ok);
  root.style.setProperty("--warn", palette.warn);
  root.style.setProperty("--btn", palette.btn);
  root.style.setProperty("--btn-hover", palette.btnHover);
  root.style.setProperty("--scrollbar", mixHex(palette.faint, palette.bg, 0.25));
  root.style.setProperty("--scrollbar-hover", palette.muted);
  root.style.setProperty("--hover-fill", palette.hoverFill);
  declareFaces([settings.fontFamily, settings.gridFontFamily, settings.sidebarFontFamily]);
  root.style.setProperty("--mono", settings.fontFamily);
  root.style.setProperty("--ui", SYSTEM_UI_FONT);
  root.style.setProperty("--editor-font-size", `${settings.fontSize}px`);
  // Every px font size in styles.css is multiplied by --ui-scale: 1 for the
  // app, the sidebar's own inside the sidebars (see styles.css).
  root.style.setProperty("--ui-scale", "1");
  root.style.setProperty("--sidebar-font", settings.sidebarFontFamily);
  root.style.setProperty("--sidebar-scale", String(settings.sidebarFontSize / BASE_UI_PX));
  root.style.setProperty("--grid-font", settings.gridFontFamily);
  root.style.setProperty("--grid-scale", String(settings.gridFontSize / BASE_UI_PX));
  const syntax = syntaxColorsWith(settings, theme, palette);
  for (const [key, variable] of Object.entries({ ...SYNTAX_VARIABLES, ...EXTRA_SYNTAX_VARIABLES })) {
    root.style.setProperty(variable, syntax[key as SyntaxColorKey]);
  }
  // The data table's colours by kind of value, for views drawn in HTML (the
  // MongoDB cards and type badges) to colour values as the grid does; with
  // type colours off they read in the ordinary ink, as the grid's do.
  for (const kind of VALUE_KINDS) {
    root.style.setProperty(`--type-${kind}`, settings.typeColors ? palette.typeInks[kind] : palette.ink);
  }
  root.style.setProperty("--type-null", palette.nullInk);
  root.classList.toggle("scrollbar-x-always", settings.scrollbarX);
  root.classList.toggle("scrollbar-y-always", settings.scrollbarY);
  window.dispatchEvent(new CustomEvent("tablepeek:theme"));
}

// The syntax colours in use: the preset's (the theme's own for "theme
// default"), then the colours picked for this theme over them.
function syntaxColorsWith(settings: AppSettings, theme: Theme, palette: Palette): Record<SyntaxColorKey, string> {
  const syntax = { ...syntaxColors(settings.syntaxPreset, theme.mode) };
  if (settings.syntaxPreset === "tablepeek") {
    Object.assign(syntax, theme.syntax ?? {
      keyword: palette.accent,
      string: palette.ok,
      number: palette.warn,
      comment: palette.faint,
      variable: palette.ink,
      type: palette.muted,
      operator: palette.muted,
      punctuation: palette.muted,
      bool: palette.error,
      null: palette.error,
      function: palette.accent,
      label: palette.warn,
    });
  }
  return {
    ...syntax,
    stringDouble: syntax.string,
    stringBacktick: syntax.string,
    text: palette.ink,
    ...settings.syntaxColors[theme.id],
  };
}

// The syntax colours `settings` draw in, for Settings to show.
export function currentSyntaxColors(settings: AppSettings): Record<SyntaxColorKey, string> {
  const theme = themeById(settings.theme);
  return syntaxColorsWith(settings, theme, themePalette(theme, settings));
}

// The data table colours `settings` draw in, for Settings to show.
export function currentGridColors(settings: AppSettings): Record<GridColorKey, string> {
  const palette = themePalette(themeById(settings.theme), settings);
  return { ...palette.typeInks, null: palette.nullInk };
}

export function getSettings(): AppSettings {
  return current;
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  current = { ...current, ...patch };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {}
  applySettings(current);
  for (const listener of listeners) {
    listener(current);
  }
  return current;
}

export function subscribeSettings(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function getPasscodeHash(): string | null {
  return window.localStorage.getItem(PASSCODE_KEY);
}

export function setPasscodeHash(hash: string | null): void {
  if (hash === null) {
    window.localStorage.removeItem(PASSCODE_KEY);
    return;
  }
  window.localStorage.setItem(PASSCODE_KEY, hash);
}

applySettings(current);
