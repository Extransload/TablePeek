import {
  applyPalette,
  contrastInk,
  defaultTypeInks,
  mixHex,
  themeById,
  type Palette,
  type Theme,
  type ThemeId,
} from "./palette";
import { setLanguage, type Language } from "./i18n";
import { normalizeKeymap, type Keymap } from "./shortcuts";
import {
  syntaxColors,
  syntaxPresetById,
  SYNTAX_VARIABLES,
  type SyntaxPresetId,
} from "./syntax";

export type ThemeMode = ThemeId;
export type CsvEncoding = "utf-8" | "euc-kr" | "utf-16le";

export interface AppSettings {
  language: Language;
  theme: ThemeMode;
  accent: string;
  fontFamily: string;
  fontSize: number;
  rowAlt: boolean;
  typeColors: boolean;
  hideScroller: boolean;
  uppercaseKeywords: boolean;
  syntaxPreset: SyntaxPresetId;
  activityDays: number;
  csvDelimiter: string;
  csvHeader: boolean;
  csvEncoding: CsvEncoding;
  // Rows a query run fetches at most.
  maxRows: number;
  keymap: Keymap;
}

export const MAX_ROWS_LIMIT = 500000;

export const DEFAULT_SETTINGS: AppSettings = {
  language: "ko",
  theme: "dark",
  accent: "#4082ee",
  fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  fontSize: 12,
  rowAlt: true,
  typeColors: true,
  hideScroller: false,
  uppercaseKeywords: true,
  syntaxPreset: "tablepeek",
  activityDays: 7,
  csvDelimiter: ",",
  csvHeader: true,
  csvEncoding: "utf-8",
  maxRows: 10000,
  keymap: normalizeKeymap(null),
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
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      language: parsed.language === "en" ? "en" : "ko",
      theme: themeById(parsed.theme ?? DEFAULT_SETTINGS.theme).id,
      syntaxPreset: syntaxPresetById(parsed.syntaxPreset).id,
      maxRows:
        typeof parsed.maxRows === "number" && Number.isFinite(parsed.maxRows)
          ? Math.min(MAX_ROWS_LIMIT, Math.max(1, Math.trunc(parsed.maxRows)))
          : DEFAULT_SETTINGS.maxRows,
      keymap: normalizeKeymap(parsed.keymap),
    };
  } catch {
    return { ...DEFAULT_SETTINGS, keymap: normalizeKeymap(null) };
  }
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

function themePalette(theme: Theme, accent: string, rowAlt: boolean): Palette {
  const palette = { ...theme.palette };
  palette.typeInks = {
    ...defaultTypeInks(theme.mode),
    ...(theme.palette.typeInks ?? {}),
  };
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
  const palette = themePalette(theme, settings.accent, settings.rowAlt);
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
  root.style.setProperty("--mono", settings.fontFamily);
  root.style.setProperty("--editor-font-size", `${settings.fontSize}px`);
  const syntax = { ...syntaxColors(settings.syntaxPreset, theme.mode) };
  if (settings.syntaxPreset === "tablepeek") {
    Object.assign(syntax, {
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
  for (const [key, variable] of Object.entries(SYNTAX_VARIABLES)) {
    root.style.setProperty(variable, syntax[key as keyof typeof syntax]);
  }
  root.classList.toggle("hide-scroller", settings.hideScroller);
  window.dispatchEvent(new CustomEvent("tablepeek:theme"));
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
