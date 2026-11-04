import { contrastInk, mixHex, saturation, withAlpha } from "./color";
import * as uiState from "./persist";
import type { SyntaxColors } from "./syntax";
import { THEME_CATALOG, type ThemeSpec } from "./themeCatalog";
import { LIGHT_NOIR, DARK_NOIR, readTernFiles, termTheme, type TermSource } from "./termTheme";

export type ValueKind =
  | "string"
  | "integer"
  | "float"
  | "bigint"
  | "boolean"
  | "json"
  | "list"
  | "date"
  | "time"
  | "enum"
  | "uuid"
  | "binary";

// The colours a theme's author picks; the later kinds (time, enum, uuid,
// binary) are worked out from the theme when it doesn't (see withAllInks).
export interface BaseTypeInks {
  string: string;
  integer: string;
  float: string;
  bigint: string;
  boolean: string;
  json: string;
  list: string;
  date: string;
}

export interface TypeInks extends BaseTypeInks {
  time: string;
  enum: string;
  uuid: string;
  binary: string;
}

export const VALUE_KINDS: ValueKind[] = [
  "string",
  "integer",
  "float",
  "bigint",
  "boolean",
  "json",
  "list",
  "date",
  "time",
  "enum",
  "uuid",
  "binary",
];

export interface Palette {
  bg: string;
  panel: string;
  head: string;
  line: string;
  ink: string;
  muted: string;
  faint: string;
  accent: string;
  accentHover: string;
  onAccent: string;
  error: string;
  ok: string;
  warn: string;
  rowAlt: string;
  hoverFill: string;
  selFill: string;
  selFillFocus: string;
  selLine: string;
  nullInk: string;
  typeInks: TypeInks;
  btn: string;
  btnHover: string;
}

export type ThemeId = string;

export interface Theme {
  id: ThemeId;
  label: string;
  mode: "dark" | "light";
  accent: string;
  palette: Palette;
  // Editor colors for the "follow the theme" syntax preset; without them the
  // preset derives keywords and literals from the accent and status colors.
  syntax?: SyntaxColors;
  // A theme made from a terminal's colour table (Tern's): what it is made
  // from, so a colour picked in its table makes it again (see termTheme.ts).
  source?: TermSource;
  // "tern": shown in the gallery's Tern group (Tern's own themes, and the
  // ones imported from a Tern theme file, which are `imported`).
  group?: "tern";
  imported?: boolean;
  custom?: boolean;
}

function makePalette(
  base: Omit<Palette, "accent" | "accentHover" | "onAccent">,
  accent: string,
  mode: "dark" | "light",
): Palette {
  return {
    ...base,
    accent,
    accentHover: mixHex(accent, mode === "light" ? "#000000" : "#ffffff", 0.14),
    onAccent: contrastInk(accent),
  };
}

// A theme's inks for every kind, each its own colour. Kinds go in order of how
// often they're seen; one its author didn't pick, or picked in a colour an
// earlier kind has (or a grey, or the red key columns are drawn in), gets the
// first free colour from the theme's own palette, syntax colours first. With
// nothing free, TablePeek's own ink for it, tinted toward the theme. Strings
// keep the author's colour whatever it is (Xcode writes them in red).
function withAllInks(
  base: BaseTypeInks & Partial<TypeInks>,
  colors: { ink: string; muted: string; faint: string; warn: string; ok: string; error: string },
  accent: string,
  syntax: SyntaxColors | undefined,
  mode: "dark" | "light",
): TypeInks {
  const fallback = (mode === "light" ? tablepeekLight : tablepeekDark).typeInks;
  const candidates: Record<keyof TypeInks, (string | undefined)[]> = {
    string: [],
    integer: [syntax?.number, syntax?.type, accent],
    boolean: [syntax?.bool, syntax?.keyword, syntax?.label, accent],
    date: [syntax?.function, syntax?.label, syntax?.type, colors.warn, accent],
    json: [syntax?.keyword, syntax?.label, accent],
    float: [syntax?.number, syntax?.type, syntax?.operator],
    bigint: [colors.warn, syntax?.function, syntax?.number],
    list: [syntax?.label, syntax?.punctuation, syntax?.operator],
    time: [syntax?.label, syntax?.type, syntax?.function, accent],
    enum: [syntax?.type, syntax?.keyword, colors.ok, accent],
    uuid: [syntax?.keyword, accent, syntax?.type, syntax?.operator],
    binary: [syntax?.operator, syntax?.punctuation, colors.warn],
  };
  const order: (keyof TypeInks)[] = [
    "string",
    "integer",
    "boolean",
    "date",
    "json",
    "float",
    "bigint",
    "list",
    "time",
    "enum",
    "uuid",
    "binary",
  ];
  const used = new Set([colors.ink, colors.muted, colors.faint].map((value) => value.toLowerCase()));
  const free = (value: string | undefined): value is string =>
    value !== undefined && !used.has(value.toLowerCase()) && saturation(value) >= 0.15;
  const inks = {} as TypeInks;
  for (const kind of order) {
    const given = base[kind];
    const ink =
      kind === "string" && given !== undefined
        ? given
        : free(given)
          ? given
          : (candidates[kind].find(free) ?? mixHex(fallback[kind], colors.ink, 0.15));
    inks[kind] = ink;
    used.add(ink.toLowerCase());
    if (kind === "string") {
      used.add(colors.error.toLowerCase());
    }
  }
  return inks;
}

function themeFromSpec(spec: ThemeSpec): Theme {
  const { colors, accent, mode } = spec;
  const light = mode === "light";
  return {
    id: spec.id,
    label: spec.label,
    mode,
    accent,
    syntax: spec.syntax,
    palette: makePalette(
      {
        ...colors,
        rowAlt: colors.rowAlt ?? mixHex(colors.bg, colors.ink, 0.03),
        hoverFill: withAlpha(colors.ink, light ? 0.05 : 0.06),
        selFill: withAlpha(accent, light ? 0.13 : 0.2),
        selFillFocus: withAlpha(accent, light ? 0.21 : 0.32),
        selLine: accent,
        nullInk: colors.faint,
        typeInks: withAllInks(spec.typeInks, colors, accent, spec.syntax, mode),
      },
      accent,
      mode,
    ),
  };
}

const tablepeekDark: Palette = makePalette(
  {
    bg: "#1c1c1f",
    panel: "#242428",
    head: "#2b2b30",
    line: "#37373d",
    ink: "#dedee3",
    muted: "#a3a3ad",
    faint: "#73737e",
    error: "#f29b8f",
    ok: "#9bd7a0",
    warn: "#e8c98a",
    rowAlt: "#212125",
    hoverFill: "rgba(255, 255, 255, 0.055)",
    selFill: "rgba(79, 140, 255, 0.2)",
    selFillFocus: "rgba(79, 140, 255, 0.32)",
    selLine: "#4f8cff",
    nullInk: "#73737e",
    typeInks: {
      string: "#9bd7a0",
      integer: "#6cb6ff",
      float: "#7fd6d0",
      bigint: "#f5a97f",
      boolean: "#f28fe0",
      json: "#c6a3ff",
      list: "#ddb8ff",
      date: "#e8c98a",
      time: "#f2dfae",
      enum: "#c5e478",
      uuid: "#9fa8ff",
      binary: "#b9a389",
    },
    btn: "#33333a",
    btnHover: "#3e3e46",
  },
  "#4f8cff",
  "dark",
);

const tablepeekLight: Palette = makePalette(
  {
    bg: "#f4f4f1",
    panel: "#ffffff",
    head: "#ededea",
    line: "#dededa",
    ink: "#25272c",
    muted: "#5f6369",
    faint: "#92969d",
    error: "#b3392f",
    ok: "#1f7a3d",
    warn: "#946200",
    rowAlt: "#f0f0ed",
    hoverFill: "rgba(30, 34, 40, 0.045)",
    selFill: "rgba(59, 130, 246, 0.14)",
    selFillFocus: "rgba(59, 130, 246, 0.22)",
    selLine: "#3b82f6",
    nullInk: "#92969d",
    typeInks: {
      string: "#1f7a3d",
      integer: "#1d4ed8",
      float: "#0f766e",
      bigint: "#c2410c",
      boolean: "#a21caf",
      json: "#7e22ce",
      list: "#9333ea",
      date: "#8a5a00",
      time: "#a16207",
      enum: "#4d7c0f",
      uuid: "#4338ca",
      binary: "#78716c",
    },
    btn: "#e8e8e4",
    btnHover: "#deded9",
  },
  "#3b82f6",
  "light",
);

export const THEMES: Theme[] = [
  {
    id: "dark",
    label: "TablePeek 다크",
    mode: "dark",
    accent: "#4f8cff",
    palette: tablepeekDark,
  },
  {
    id: "light",
    label: "TablePeek 라이트",
    mode: "light",
    accent: "#3b82f6",
    palette: tablepeekLight,
  },
  // The two Noir themes are made from a terminal's colour table, as Tern's.
  ...[...THEME_CATALOG.map(themeFromSpec), termTheme(DARK_NOIR), termTheme(LIGHT_NOIR)].sort((a, b) =>
    a.label.localeCompare(b.label, "en"),
  ),
];

export const DARK_PALETTE: Palette = tablepeekDark;
export const LIGHT_PALETTE: Palette = tablepeekLight;

export function defaultTypeInks(mode: "dark" | "light"): TypeInks {
  return { ...(mode === "light" ? tablepeekLight : tablepeekDark).typeInks };
}

export const palette: Palette = { ...tablepeekDark };

export function themeById(id: string): Theme {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0];
}

export function applyPalette(next: Palette): void {
  Object.assign(palette, next);
}

// Themes earlier versions imported from Git: still offered.
const CUSTOM_THEME_KEY = "tablepeek.custom-themes";

interface CustomThemeRecord {
  id: string;
  label: string;
  mode: "dark" | "light";
  accent: string;
  palette: Palette;
}

function readCustomThemes(): CustomThemeRecord[] {
  try {
    const raw = uiState.getItem(CUSTOM_THEME_KEY);
    if (raw === null) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item): item is CustomThemeRecord =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as CustomThemeRecord).id === "string" &&
        typeof (item as CustomThemeRecord).label === "string" &&
        typeof (item as CustomThemeRecord).palette === "object",
    );
  } catch {
    return [];
  }
}

for (const record of readCustomThemes()) {
  const existing = THEMES.findIndex((theme) => theme.id === record.id);
  if (existing < 0) {
    THEMES.push({ ...record, custom: true });
  }
}

// Themes imported from Tern theme files are kept whole (see termTheme.ts), so
// they are offered from the start; Tern's own load later (ternThemes.ts).
for (const source of readTernFiles()) {
  THEMES.push(termTheme(source));
}

// THEMES grows while the app runs (Tern's themes load, a file is imported):
// the gallery redraws on each change.
const themeListeners = new Set<() => void>();
let themesVersion = 0;

export function subscribeThemes(listener: () => void): () => void {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}

export function getThemesVersion(): number {
  return themesVersion;
}

// Adds `themes`, each in place of one with its id.
export function addThemes(themes: Theme[]): void {
  for (const theme of themes) {
    const at = THEMES.findIndex((item) => item.id === theme.id);
    if (at >= 0) {
      THEMES[at] = theme;
    } else {
      THEMES.push(theme);
    }
  }
  themesVersion += 1;
  themeListeners.forEach((listener) => listener());
}

export function removeTheme(id: string): void {
  const at = THEMES.findIndex((item) => item.id === id);
  if (at >= 0) {
    THEMES.splice(at, 1);
    themesVersion += 1;
    themeListeners.forEach((listener) => listener());
  }
}
