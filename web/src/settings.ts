import { contrastInk, mixHex } from "./color";
import {
  applyPalette,
  defaultTypeInks,
  subscribeThemes,
  themeById,
  THEMES,
  VALUE_KINDS,
  type Palette,
  type Theme,
  type ThemeId,
  type ValueKind,
} from "./palette";
import { SYSTEM_CODE_FONT, SYSTEM_UI_FONT, declareFaces } from "./fonts";
import { setLanguage, type Language } from "./i18n";
import {
  applyMaterial,
  MATERIAL_BLUR_MAX,
  MATERIALS,
  seeThrough,
  seeThroughColors,
  subscribeMaterial,
  type Material,
} from "./material";
import * as uiState from "./persist";
import { KEYMAP_VERSION, normalizeKeymap, type Keymap } from "./shortcuts";
import {
  EXTRA_SYNTAX_VARIABLES,
  paletteSyntax,
  SYNTAX_COLOR_KEYS,
  syntaxColors,
  syntaxPresetById,
  SYNTAX_VARIABLES,
  type SyntaxColorKey,
  type SyntaxColorPicks,
  type SyntaxPresetId,
} from "./syntax";
import { TABLE_SLOTS, withTable, type TablePicks } from "./termTheme";
import { awaitsTernThemes, loadTernThemes } from "./ternThemes";

// Light, dark, or the system's, as Tern has it: each with a theme of its own.
export type ThemeMode = "light" | "dark" | "system";
export const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "system"];
export type CsvEncoding = "utf-8" | "euc-kr" | "utf-16le";
// The parts of the data table a colour can be picked for: each kind of value
// and NULL.
export type GridColorKey = ValueKind | "null";
export type GridColorPicks = Partial<Record<GridColorKey, string>>;
export const GRID_COLOR_KEYS: GridColorKey[] = [...VALUE_KINDS, "null"];

export interface AppSettings {
  // The shape these settings are saved in (see SETTINGS_VERSION).
  version: number;
  language: Language;
  themeMode: ThemeMode;
  themeLight: ThemeId;
  themeDark: ThemeId;
  // "" takes the theme's own accent.
  accent: string;
  // The window material (see material.ts): how opaque the background is
  // (0–100) over what shows through, a clear surface's blur (points), and
  // how opaque the floating surfaces (Quick Look, dialogs, the command
  // palette, menus, this sheet) are (0–100).
  material: Material;
  materialOpacity: number;
  materialBlur: number;
  floatingOpacity: number;
  // Fonts, each following the one above it as Tern's do: the interface's
  // (the sidebars, menus, dialogs), the code font every monospaced text
  // takes (the SQL editor and console, the data table, code labels), then
  // the SQL editor's and the data table's own over it. A font of "" and a
  // size of null follow; sizes are px.
  uiFont: string;
  uiFontSize: number;
  codeFont: string;
  codeFontSize: number | null;
  editorFont: string;
  editorFontSize: number | null;
  gridFont: string;
  gridFontSize: number | null;
  rowAlt: boolean;
  typeColors: boolean;
  // The grid's and the editor's scrollbars kept in view on each axis,
  // instead of the system's, which may show only while scrolling.
  scrollbarX: boolean;
  scrollbarY: boolean;
  // Motion kept to a minimum: transitions and animations jump to their end
  // (see motion.ts). Only this decides; the system's preference isn't read.
  reduceMotion: boolean;
  uppercaseKeywords: boolean;
  syntaxPreset: SyntaxPresetId;
  // Colours picked in Settings → Appearance over the syntax colours, by theme:
  // like TablePlus's, a theme's colours stay with it.
  syntaxColors: Record<string, SyntaxColorPicks>;
  // The same for the data table's colours by kind of value, by theme.
  gridColors: Record<string, GridColorPicks>;
  // Colours picked in a theme's colour table (its terminal colours), by
  // theme: they carry to the syntax and data table colours they map to.
  tableColors: Record<string, TablePicks>;
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
export const UI_FONT_MIN = 10;
export const UI_FONT_MAX = 18;
export const CODE_FONT_MIN = 10;
export const CODE_FONT_MAX = 24;
// The size the app is drawn at: every px size in styles.css is for it.
const BASE_UI_PX = 12;
// Settings saved before version 2 had one theme and a font per area (the
// SQL editor, the data table, the sidebar): see migrateLegacy.
const SETTINGS_VERSION = 2;

function clampSize(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

// A size that may follow another: null, or a size in range.
function clampFollowing(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  version: SETTINGS_VERSION,
  language: "ko",
  themeMode: "system",
  themeLight: "light",
  themeDark: "dark",
  accent: "",
  material: "solid",
  materialOpacity: 80,
  materialBlur: 20,
  floatingOpacity: 90,
  uiFont: "",
  uiFontSize: BASE_UI_PX,
  codeFont: "",
  codeFontSize: null,
  editorFont: "",
  editorFontSize: null,
  gridFont: "",
  gridFontSize: null,
  rowAlt: true,
  typeColors: true,
  scrollbarX: true,
  scrollbarY: true,
  reduceMotion: false,
  uppercaseKeywords: true,
  syntaxPreset: "tablepeek",
  syntaxColors: {},
  gridColors: {},
  tableColors: {},
  activityDays: 7,
  csvDelimiter: ",",
  csvHeader: true,
  csvEncoding: "utf-8",
  maxRows: 10000,
  queryTimeout: 60,
  keymap: normalizeKeymap(null),
  keymapVersion: KEYMAP_VERSION,
};

const PASSCODE_KEY = "tablepeek.passcode-hash";
const ACCENT_SOFT = "rgba(64, 130, 238, 0.18)";

type Listener = (settings: AppSettings) => void;
const listeners = new Set<Listener>();
let current = readSettings();
// A look tried on from a Settings menu (a theme or font highlighted there),
// drawn over the saved settings until the menu closes: never saved, sent to
// other windows or handed to listeners. `drawn` is what the app draws.
let preview: Partial<AppSettings> | null = null;
let drawn = current;

function readSettings(): AppSettings {
  try {
    const raw = uiState.getItem(uiState.SETTINGS_KEY);
    if (raw === null) {
      return { ...DEFAULT_SETTINGS, keymap: normalizeKeymap(null) };
    }
    const saved = JSON.parse(raw) as Record<string, unknown>;
    const legacy = typeof saved.version !== "number" || saved.version < SETTINGS_VERSION;
    const merged: Record<string, unknown> = legacy ? { ...saved, ...migrateLegacy(saved) } : saved;
    // Only today's settings: those earlier versions saved are dropped.
    const parsed = Object.fromEntries(
      Object.entries(merged).filter(([key]) => Object.hasOwn(DEFAULT_SETTINGS, key)),
    ) as Partial<AppSettings>;
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      version: SETTINGS_VERSION,
      language: parsed.language === "en" ? "en" : "ko",
      reduceMotion: parsed.reduceMotion === true,
      themeMode: THEME_MODES.includes(parsed.themeMode as ThemeMode) ? (parsed.themeMode as ThemeMode) : DEFAULT_SETTINGS.themeMode,
      themeLight: readThemeId(parsed.themeLight, DEFAULT_SETTINGS.themeLight),
      themeDark: readThemeId(parsed.themeDark, DEFAULT_SETTINGS.themeDark),
      accent: typeof parsed.accent === "string" && /^#[0-9a-f]{6}$/i.test(parsed.accent) ? parsed.accent : "",
      material: MATERIALS.includes(parsed.material as Material) ? (parsed.material as Material) : DEFAULT_SETTINGS.material,
      materialOpacity: Math.round(clampSize(parsed.materialOpacity, 0, 100, DEFAULT_SETTINGS.materialOpacity)),
      materialBlur: Math.round(clampSize(parsed.materialBlur, 0, MATERIAL_BLUR_MAX, DEFAULT_SETTINGS.materialBlur)),
      floatingOpacity: Math.round(clampSize(parsed.floatingOpacity, 0, 100, DEFAULT_SETTINGS.floatingOpacity)),
      uiFont: typeof parsed.uiFont === "string" ? parsed.uiFont : "",
      uiFontSize: clampSize(parsed.uiFontSize, UI_FONT_MIN, UI_FONT_MAX, DEFAULT_SETTINGS.uiFontSize),
      codeFont: typeof parsed.codeFont === "string" ? parsed.codeFont : "",
      codeFontSize: clampFollowing(parsed.codeFontSize, CODE_FONT_MIN, CODE_FONT_MAX),
      editorFont: typeof parsed.editorFont === "string" ? parsed.editorFont : "",
      editorFontSize: clampFollowing(parsed.editorFontSize, CODE_FONT_MIN, CODE_FONT_MAX),
      gridFont: typeof parsed.gridFont === "string" ? parsed.gridFont : "",
      gridFontSize: clampFollowing(parsed.gridFontSize, CODE_FONT_MIN, CODE_FONT_MAX),
      syntaxPreset: syntaxPresetById(parsed.syntaxPreset).id,
      syntaxColors: readColorPicks(parsed.syntaxColors, SYNTAX_COLOR_KEYS),
      gridColors: readColorPicks(parsed.gridColors, GRID_COLOR_KEYS),
      tableColors: readColorPicks(parsed.tableColors, TABLE_SLOTS),
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
    // Saved back in today's shape at once, so they are moved over once.
    if (legacy) {
      uiState.setItem(uiState.SETTINGS_KEY, JSON.stringify(settings));
    }
    return settings;
  } catch {
    return { ...DEFAULT_SETTINGS, keymap: normalizeKeymap(null) };
  }
}

// A saved theme still offered (one of Tern's is kept while they load, see
// ternThemes.ts), or `fallback`.
function readThemeId(value: unknown, fallback: ThemeId): ThemeId {
  return typeof value === "string" && (awaitsTernThemes(value) || THEMES.some((theme) => theme.id === value))
    ? value
    : fallback;
}

// Settings saved before version 2, moved over. Their one theme is the
// theme of its mode and the mode is that one (System for the default dark
// theme, never picked), and an accent that was that theme's own follows
// whichever theme shows. Each of the SQL editor, the data table and the
// sidebar had a font and a size: the editor's becomes the code font, the
// data table's its own where it differs, and the sidebar's, now in the
// interface's font, that font where it differs and isn't a system face.
function migrateLegacy(old: Record<string, unknown>): Partial<AppSettings> {
  const id = typeof old.theme === "string" ? old.theme : "dark";
  const theme = THEMES.find((item) => item.id === id);
  const mode = theme?.mode ?? "dark";
  const accent = typeof old.accent === "string" ? old.accent.toLowerCase() : "";
  // The default theme's accent was #4f8cff when picked from the gallery.
  const themesOwn = accent === theme?.accent.toLowerCase() || (id === "dark" && accent === "#4f8cff");
  const family = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback);
  const editor = family(old.fontFamily, SYSTEM_CODE_FONT);
  const grid = family(old.gridFontFamily, editor);
  const sidebar = family(old.sidebarFontFamily, editor);
  // The oldest versions had one size for the whole app.
  const editorSize = clampSize(old.fontSize, CODE_FONT_MIN, CODE_FONT_MAX, BASE_UI_PX);
  const gridSize = clampSize(old.gridFontSize ?? old.uiFontSize, CODE_FONT_MIN, CODE_FONT_MAX, BASE_UI_PX);
  const uiFontSize = clampSize(old.sidebarFontSize ?? old.uiFontSize, UI_FONT_MIN, UI_FONT_MAX, BASE_UI_PX);
  // "Hide scrollbars" from earlier still: neither kept in view.
  const shown = old.hideScroller !== true;
  return {
    themeMode: id === "dark" ? "system" : mode,
    themeLight: mode === "light" ? id : DEFAULT_SETTINGS.themeLight,
    themeDark: mode === "dark" ? id : DEFAULT_SETTINGS.themeDark,
    accent: themesOwn ? "" : accent,
    uiFont: sidebar === editor || sidebar === SYSTEM_CODE_FONT || sidebar === SYSTEM_UI_FONT ? "" : sidebar,
    uiFontSize,
    codeFont: editor === SYSTEM_CODE_FONT ? "" : editor,
    codeFontSize: editorSize === uiFontSize ? null : editorSize,
    editorFont: "",
    editorFontSize: null,
    gridFont: grid === editor ? "" : grid,
    gridFontSize: gridSize === editorSize ? null : gridSize,
    ...(typeof old.scrollbarX === "boolean" ? {} : { scrollbarX: shown, scrollbarY: shown }),
  };
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

// The theme's palette as `settings` draw it: their accent (or the theme's),
// the alternate row background or not, and the data table colours picked
// for this theme.
function themePalette(theme: Theme, settings: AppSettings): Palette {
  const { rowAlt } = settings;
  const accent = settings.accent || theme.accent;
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

const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");

// Whether the system is in dark mode, which System follows as it changes.
export function systemDark(): boolean {
  return darkScheme.matches;
}

export function subscribeSystemDark(listener: () => void): () => void {
  darkScheme.addEventListener("change", listener);
  return () => darkScheme.removeEventListener("change", listener);
}

// Whether the theme shown is the dark one: by the mode (the system's under
// System).
export function showsDark(settings: AppSettings): boolean {
  return settings.themeMode === "system" ? darkScheme.matches : settings.themeMode === "dark";
}

// The theme shown: the light or the dark one, by the mode.
export function activeThemeId(settings: AppSettings): ThemeId {
  return showsDark(settings) ? settings.themeDark : settings.themeLight;
}

// The theme `settings` draw: the one shown, with the colours picked in its
// colour table. One of Tern's themes still loading draws as the default
// until it is in, then the settings are drawn again.
function drawnTheme(settings: AppSettings): Theme {
  const id = activeThemeId(settings);
  if (awaitsTernThemes(id)) {
    void loadTernThemes().catch(() => {});
  }
  const theme = themeById(id);
  return withTable(theme, settings.tableColors[theme.id]);
}

// The accent drawn: the one picked, or the shown theme's own.
export function currentAccent(settings: AppSettings): string {
  return settings.accent || drawnTheme(settings).accent;
}

export interface DrawnFonts {
  ui: string;
  uiSize: number;
  code: string;
  codeSize: number;
  editor: string;
  editorSize: number;
  grid: string;
  gridSize: number;
}

// Each font as drawn, following the one above it where it isn't set: the
// system's faces at the top, the code font's size the interface's.
export function drawnFonts(settings: AppSettings): DrawnFonts {
  const code = settings.codeFont || SYSTEM_CODE_FONT;
  const codeSize = settings.codeFontSize ?? settings.uiFontSize;
  return {
    ui: settings.uiFont || SYSTEM_UI_FONT,
    uiSize: settings.uiFontSize,
    code,
    codeSize,
    editor: settings.editorFont || code,
    editorSize: settings.editorFontSize ?? codeSize,
    grid: settings.gridFont || code,
    gridSize: settings.gridFontSize ?? codeSize,
  };
}

export function applySettings(settings: AppSettings): void {
  const root = document.documentElement;
  setLanguage(settings.language);
  const theme = drawnTheme(settings);
  const opaque = themePalette(theme, settings);
  // In a see-through window the page's own surfaces take the picked opacity;
  // the colours mixed from them below stay those of the opaque ones.
  const palette = seeThrough(settings) ? seeThroughColors(opaque, settings) : opaque;
  applyPalette(palette);
  root.dataset.theme = theme.id;
  root.dataset.mode = theme.mode;
  root.style.colorScheme = theme.mode;
  root.style.setProperty("--bg", palette.bg);
  root.style.setProperty("--panel", palette.panel);
  root.style.setProperty("--head", palette.head);
  root.style.setProperty("--line", palette.line);
  root.style.setProperty("--line-soft", mixHex(opaque.line, opaque.bg, 0.4));
  root.style.setProperty("--ink", palette.ink);
  root.style.setProperty("--muted", palette.muted);
  root.style.setProperty("--faint", palette.faint);
  root.style.setProperty("--accent", palette.accent);
  root.style.setProperty("--accent-hover", palette.accentHover);
  root.style.setProperty("--accent-contrast", palette.onAccent);
  root.style.setProperty("--accent-soft", hexToRgba(opaque.accent, 0.18));
  root.style.setProperty("--accent-line", hexToRgba(opaque.accent, 0.5));
  root.style.setProperty("--error", palette.error);
  root.style.setProperty("--ok", palette.ok);
  root.style.setProperty("--warn", palette.warn);
  root.style.setProperty("--btn", palette.btn);
  root.style.setProperty("--btn-hover", palette.btnHover);
  root.style.setProperty("--scrollbar", mixHex(opaque.faint, opaque.bg, 0.25));
  root.style.setProperty("--scrollbar-hover", palette.muted);
  root.style.setProperty("--hover-fill", palette.hoverFill);
  const fonts = drawnFonts(settings);
  declareFaces([fonts.ui, fonts.code, fonts.editor, fonts.grid]);
  root.style.setProperty("--ui", fonts.ui);
  root.style.setProperty("--mono", fonts.code);
  root.style.setProperty("--editor-font", fonts.editor);
  root.style.setProperty("--editor-font-size", `${fonts.editorSize}px`);
  // Every px font size in styles.css is for the default 12px, multiplied by
  // --ui-scale: the interface's font size, the data table's in its editor.
  root.style.setProperty("--ui-scale", String(fonts.uiSize / BASE_UI_PX));
  root.style.setProperty("--grid-font", fonts.grid);
  root.style.setProperty("--grid-scale", String(fonts.gridSize / BASE_UI_PX));
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
  if (root.classList.contains("reduce-motion") !== settings.reduceMotion) {
    root.classList.toggle("reduce-motion", settings.reduceMotion);
    window.dispatchEvent(new CustomEvent("tablepeek:motion"));
  }
  applyMaterial(settings, { ...opaque, mode: theme.mode }, settings.themeMode === "system");
  window.dispatchEvent(new CustomEvent("tablepeek:theme"));
}

// The syntax colours in use: the preset's (the theme's own for "theme
// default"), then the colours picked for this theme over them.
function syntaxColorsWith(settings: AppSettings, theme: Theme, palette: Palette): Record<SyntaxColorKey, string> {
  const syntax = { ...syntaxColors(settings.syntaxPreset, theme.mode) };
  if (settings.syntaxPreset === "tablepeek") {
    Object.assign(syntax, theme.syntax ?? paletteSyntax(palette));
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
  const theme = drawnTheme(settings);
  return syntaxColorsWith(settings, theme, themePalette(theme, settings));
}

// The data table colours `settings` draw in, for Settings to show.
export function currentGridColors(settings: AppSettings): Record<GridColorKey, string> {
  const palette = themePalette(drawnTheme(settings), settings);
  return { ...palette.typeInks, null: palette.nullInk };
}

export function getSettings(): AppSettings {
  return current;
}

// The settings the app is drawn with: the saved ones, with a look being
// tried on from a Settings menu over them. What draws (the data table)
// reads these; what acts on the settings reads getSettings.
export function drawnSettings(): AppSettings {
  return drawn;
}

function redraw(): void {
  drawn = preview === null ? current : { ...current, ...preview };
  applySettings(drawn);
}

// Draws the app as if `patch` were saved, or as saved again (null).
export function previewSettings(patch: Partial<AppSettings> | null): void {
  if (patch === null && preview === null) {
    return;
  }
  preview = patch;
  redraw();
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  current = { ...current, ...patch };
  uiState.setItem(uiState.SETTINGS_KEY, JSON.stringify(current));
  redraw();
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
  return uiState.getItem(PASSCODE_KEY);
}

export function setPasscodeHash(hash: string | null): void {
  if (hash === null) {
    uiState.removeItem(PASSCODE_KEY);
    return;
  }
  uiState.setItem(PASSCODE_KEY, hash);
}

applySettings(current);
// The window turned out see-through or not: the material is drawn again.
subscribeMaterial(redraw);
// Tern's themes came in, or a theme file was imported: the saved theme may
// be one of them.
subscribeThemes(redraw);
// The system turned light or dark: System follows it.
subscribeSystemDark(redraw);
// Another window changed the settings: this one follows, so every window
// draws (and asks the desktop app for) the same look. Only saveSettings
// writes them back, so following never echoes a change.
uiState.subscribeChangesElsewhere((key) => {
  if (key !== uiState.SETTINGS_KEY) {
    return;
  }
  current = readSettings();
  redraw();
  for (const listener of listeners) {
    listener(current);
  }
});
