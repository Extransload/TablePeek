import { t } from "./i18n";
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
  | "date";

export interface TypeInks {
  string: string;
  integer: string;
  float: string;
  bigint: string;
  boolean: string;
  json: string;
  list: string;
  date: string;
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
        typeInks: spec.typeInks,
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
      bigint: "#e8c98a",
      boolean: "#f29b8f",
      json: "#c6a3ff",
      list: "#f5b98a",
      date: "#a3a3ad",
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
      bigint: "#8a5a00",
      boolean: "#b3392f",
      json: "#7e22ce",
      list: "#c2410c",
      date: "#5f6369",
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

const CUSTOM_THEME_KEY = "tablepeek.custom-themes";

function isHex(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value.trim());
}

function colorOf(
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key];
  return isHex(value) ? value.trim() : undefined;
}

function customId(label: string, current: string[]): string {
  const base =
    "custom-" +
    (label
      .toLowerCase()
      .replace(/[^a-z0-9가-힣]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "theme");
  let id = base;
  let index = 2;
  while (current.includes(id)) {
    id = `${base}-${index}`;
    index += 1;
  }
  return id;
}

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

function writeCustomThemes(): void {
  try {
    const records = THEMES.filter((theme) => theme.custom).map((theme) => ({
      id: theme.id,
      label: theme.label,
      mode: theme.mode,
      accent: theme.accent,
      palette: theme.palette,
    }));
    window.localStorage.setItem(CUSTOM_THEME_KEY, JSON.stringify(records));
  } catch {}
}

function registerRecord(record: CustomThemeRecord): Theme {
  const existing = THEMES.findIndex((theme) => theme.id === record.id);
  const theme: Theme = { ...record, custom: true };
  if (existing >= 0) {
    THEMES[existing] = theme;
  } else {
    THEMES.push(theme);
  }
  writeCustomThemes();
  return theme;
}

export function removeCustomTheme(id: string): void {
  const index = THEMES.findIndex((theme) => theme.id === id && theme.custom);
  if (index >= 0) {
    THEMES.splice(index, 1);
    writeCustomThemes();
  }
}

export function isCustomTheme(id: string): boolean {
  return THEMES.some((theme) => theme.id === id && theme.custom);
}

export function themeFromJson(input: unknown): Theme {
  if (typeof input !== "object" || input === null) {
    throw new Error(t("테마 JSON 객체가 아닙니다"));
  }
  const source = input as Record<string, unknown>;
  const label =
    (typeof source.label === "string" && source.label.trim()) ||
    (typeof source.name === "string" && source.name.trim()) ||
    "가져온 테마";
  const mode =
    source.mode === "light" ||
    source.variant === "light" ||
    source.type === "light"
      ? "light"
      : "dark";
  const base = mode === "light" ? tablepeekLight : tablepeekDark;
  const explicit =
    typeof source.palette === "object" && source.palette !== null
      ? (source.palette as Record<string, unknown>)
      : typeof source.colors === "object" && source.colors !== null
        ? (source.colors as Record<string, unknown>)
        : {};
  const hasBase16 = Object.keys(explicit).some((key) =>
    /^base0[0-9a-f]$/i.test(key),
  );
  const vscode =
    typeof source.colors === "object" && source.colors !== null
      ? (source.colors as Record<string, unknown>)
      : {};
  const next: Palette = { ...base };
  const override = (key: keyof Palette, value: string | undefined): void => {
    if (value !== undefined) {
      (next as unknown as Record<string, unknown>)[key] = value;
    }
  };
  if (hasBase16) {
    override("bg", colorOf(explicit, "base00"));
    override("panel", colorOf(explicit, "base01"));
    override("head", colorOf(explicit, "base01"));
    override("line", colorOf(explicit, "base02"));
    override("faint", colorOf(explicit, "base03"));
    override("muted", colorOf(explicit, "base04"));
    override("ink", colorOf(explicit, "base05"));
    override("error", colorOf(explicit, "base08"));
    override("warn", colorOf(explicit, "base0A"));
    override("ok", colorOf(explicit, "base0B"));
    override("accent", colorOf(explicit, "base0D"));
    override("btn", colorOf(explicit, "base02"));
    override("btnHover", colorOf(explicit, "base03"));
    override("rowAlt", colorOf(explicit, "base01"));
  } else {
    const vscodeMap: [keyof Palette, string[]][] = [
      ["bg", ["editor.background", "background"]],
      ["panel", ["sideBar.background", "panel.background"]],
      ["head", ["activityBar.background", "titleBar.activeBackground"]],
      ["line", ["panel.border", "editorGroup.border"]],
      ["ink", ["editor.foreground", "foreground"]],
      ["muted", ["descriptionForeground"]],
      ["faint", ["disabledForeground"]],
      ["accent", ["focusBorder", "button.background", "textLink.foreground"]],
      ["error", ["errorForeground"]],
      ["ok", ["terminal.ansiGreen"]],
      ["warn", ["terminal.ansiYellow"]],
    ];
    for (const [key, keys] of vscodeMap) {
      const value = keys.map((name) => colorOf(vscode, name)).find(Boolean);
      override(key, value);
    }
    for (const key of [
      "bg",
      "panel",
      "head",
      "line",
      "ink",
      "muted",
      "faint",
      "error",
      "ok",
      "warn",
      "accent",
      "rowAlt",
      "btn",
      "btnHover",
    ] as (keyof Palette)[]) {
      override(key, colorOf(explicit, key));
    }
  }
  const typeInks: TypeInks = { ...base.typeInks };
  const setInk = (kind: ValueKind, value: string | undefined): void => {
    if (value !== undefined) {
      typeInks[kind] = value;
    }
  };
  if (hasBase16) {
    setInk("string", colorOf(explicit, "base0B"));
    setInk("integer", colorOf(explicit, "base0D"));
    setInk("float", colorOf(explicit, "base0C"));
    setInk("bigint", colorOf(explicit, "base0A"));
    setInk("boolean", colorOf(explicit, "base08"));
    setInk("json", colorOf(explicit, "base0E"));
    setInk("list", colorOf(explicit, "base09"));
    setInk("date", colorOf(explicit, "base04") ?? colorOf(explicit, "base03"));
  } else {
    const pick = (keys: string[]): string | undefined =>
      keys.map((name) => colorOf(vscode, name)).find(Boolean);
    setInk("string", pick(["terminal.ansiGreen", "terminal.ansiBrightGreen"]));
    setInk("integer", pick(["terminal.ansiBlue", "terminal.ansiBrightBlue"]));
    setInk("float", pick(["terminal.ansiCyan", "terminal.ansiBrightCyan"]));
    setInk("bigint", pick(["terminal.ansiYellow", "terminal.ansiBrightYellow"]));
    setInk("boolean", pick(["terminal.ansiRed", "terminal.ansiBrightRed"]));
    setInk("json", pick(["terminal.ansiMagenta", "terminal.ansiBrightMagenta"]));
    setInk("list", pick(["terminal.ansiBrightRed", "terminal.ansiRed"]));
    setInk(
      "date",
      pick(["descriptionForeground", "disabledForeground"]) ??
        colorOf(explicit, "muted"),
    );
  }
  const themeTypes =
    typeof source.typeInks === "object" && source.typeInks !== null
      ? (source.typeInks as Record<string, unknown>)
      : typeof explicit.typeInks === "object" && explicit.typeInks !== null
        ? (explicit.typeInks as Record<string, unknown>)
        : undefined;
  if (themeTypes !== undefined) {
    for (const kind of VALUE_KINDS) {
      setInk(kind, colorOf(themeTypes, kind));
    }
  }
  next.typeInks = typeInks;
  const accent =
    colorOf(explicit, "accent") ??
    (isHex(source.accent) ? source.accent.trim() : undefined) ??
    next.accent;
  next.accent = accent;
  next.accentHover = mixHex(
    accent,
    mode === "light" ? "#000000" : "#ffffff",
    0.14,
  );
  next.onAccent = contrastInk(accent);
  const id = customId(
    label,
    THEMES.map((theme) => theme.id),
  );
  return registerRecord({ id, label, mode, accent, palette: next });
}

for (const record of readCustomThemes()) {
  const existing = THEMES.findIndex((theme) => theme.id === record.id);
  if (existing < 0) {
    THEMES.push({ ...record, custom: true });
  }
}
