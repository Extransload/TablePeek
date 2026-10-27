import type { SyntaxColors } from "./syntax";
import { THEME_CATALOG, type ThemeSpec } from "./themeCatalog";

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

export function mixHex(a: string, b: string, amount: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  if (pa === null || pb === null) {
    return a;
  }
  const mix = (x: number, y: number): number =>
    Math.round(x + (y - x) * amount);
  return `#${[mix(pa[0], pb[0]), mix(pa[1], pb[1]), mix(pa[2], pb[2])]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function contrastInk(hex: string): string {
  const rgb = parseHex(hex);
  if (rgb === null) {
    return "#ffffff";
  }
  const [r, g, b] = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // White stays on saturated accents until it drops under 3:1 contrast,
  // so pastel accents (Rosé Pine, Dracula) get dark text.
  return luminance > 0.3 ? "#1f2230" : "#ffffff";
}

function withAlpha(hex: string, alpha: number): string {
  const rgb = parseHex(hex) ?? [0, 0, 0];
  return `rgba(${rgb.join(", ")}, ${alpha})`;
}

function saturation(hex: string): number {
  const rgb = parseHex(hex);
  if (rgb === null) {
    return 0;
  }
  const max = Math.max(...rgb) / 255;
  const min = Math.min(...rgb) / 255;
  const lightness = (max + min) / 2;
  return max === min ? 0 : (max - min) / (1 - Math.abs(2 * lightness - 1));
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

function parseHex(hex: string): [number, number, number] | null {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    return null;
  }
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
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
  ...THEME_CATALOG.map(themeFromSpec).sort((a, b) =>
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
    const raw = window.localStorage.getItem(CUSTOM_THEME_KEY);
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
