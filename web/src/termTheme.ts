import { contrastInk, contrastRatio, mixHex, parseHex, readableOn, toHex, withAlpha } from "./color";
import { t } from "./i18n";
import type { Palette, Theme, TypeInks } from "./palette";
import * as uiState from "./persist";
import { paletteSyntax, type SyntaxColors } from "./syntax";

// Themes made the way a terminal's are, as Tern (and oh-my-pi, whose themes
// Tern uses) makes them: a colour table (the background, the foreground and
// the 16 ANSI colours) and a few colours for the window around it. Every
// colour TablePeek draws text in comes from a slot of the table, so a colour
// picked in the table (Settings → Appearance) carries to all the parts it colours.

export const ANSI_SLOTS = [
  "ansi0",
  "ansi1",
  "ansi2",
  "ansi3",
  "ansi4",
  "ansi5",
  "ansi6",
  "ansi7",
  "ansi8",
  "ansi9",
  "ansi10",
  "ansi11",
  "ansi12",
  "ansi13",
  "ansi14",
  "ansi15",
] as const;

export type AnsiSlot = (typeof ANSI_SLOTS)[number];
// Named as Tern's CSS variables are: --tv-bg, --tv-fg, --ansi0 … --ansi15.
export type TableSlot = "bg" | "fg" | AnsiSlot;
export const TABLE_SLOTS: TableSlot[] = ["bg", "fg", ...ANSI_SLOTS];
export type ColorTable = Record<TableSlot, string>;
export type TablePicks = Partial<ColorTable>;

// Tern's surfaces (--tn-page, --card, --raise, --code-bg, --tn-pop): the
// sidebars, striped rows, buttons, headers and a button under the pointer.
export type Surface = "page" | "card" | "raise" | "codeBg" | "pop";

export interface TermSource {
  id: string;
  label: string;
  table: ColorTable;
  accent: string;
  // Secondary and faint text, and the lines between parts.
  muted: string;
  faint: string;
  border: string;
  // Those not given are mixed from the background and the foreground.
  surfaces: Partial<Record<Surface, string>>;
}

// Tern's themes are "tern-<name>"; those imported from a Tern theme file are
// "tern-file-<file name>".
export const TERN_PREFIX = "tern-";
export const TERN_FILE_PREFIX = "tern-file-";

type PaletteRole = "ink" | "error" | "ok" | "warn" | "nullInk";
type Role = PaletteRole | `syntax.${keyof SyntaxColors}` | `ink.${keyof TypeInks}`;

// What each slot colours. The neutral slots trade places by mode: a dark
// table's white (15) is its strong text and black (0) its faintest, a light
// table's the other way round.
function slotRoles(mode: "dark" | "light"): Record<TableSlot, Role[]> {
  const dark = mode === "dark";
  return {
    bg: [],
    fg: ["ink"],
    ansi0: [dark ? "syntax.punctuation" : "syntax.variable"],
    ansi1: ["error", "syntax.bool", "syntax.null"],
    ansi2: ["ok", "syntax.string", "ink.string"],
    ansi3: ["warn", "syntax.number", "ink.integer"],
    ansi4: ["syntax.type", "ink.json"],
    ansi5: ["syntax.keyword", "ink.boolean"],
    ansi6: ["syntax.function", "ink.date"],
    ansi7: [dark ? "ink.binary" : "syntax.punctuation"],
    ansi8: ["syntax.comment", "nullInk"],
    ansi9: ["syntax.label"],
    ansi10: ["ink.uuid"],
    ansi11: ["ink.float", "ink.bigint"],
    ansi12: ["ink.list"],
    ansi13: ["syntax.operator", "ink.enum"],
    ansi14: ["ink.time"],
    ansi15: [dark ? "syntax.variable" : "ink.binary"],
  };
}

// Text that is meant to recede reads at 3:1; all other text at 4.5:1 (WCAG AA).
const FAINT_ROLES: Partial<Record<Role, true>> = { "syntax.comment": true, "syntax.punctuation": true, nullInk: true };

// What a slot colours, in words, for Settings to show over its swatch.
const ROLE_LABELS: Record<Role, string> = {
  ink: "글자",
  error: "오류",
  ok: "성공",
  warn: "경고",
  nullInk: "NULL",
  "syntax.keyword": "키워드",
  "syntax.string": "SQL 문자열",
  "syntax.number": "SQL 숫자",
  "syntax.comment": "주석",
  "syntax.variable": "이름",
  "syntax.type": "타입",
  "syntax.operator": "연산자",
  "syntax.punctuation": "기호",
  "syntax.bool": "참거짓",
  "syntax.null": "SQL NULL",
  "syntax.function": "함수",
  "syntax.label": "레이블",
  "ink.string": "문자열 값",
  "ink.integer": "정수",
  "ink.float": "실수",
  "ink.bigint": "큰 정수",
  "ink.boolean": "불리언",
  "ink.json": "JSON",
  "ink.list": "배열",
  "ink.date": "날짜·시각",
  "ink.time": "시간(TIME)",
  "ink.enum": "열거형",
  "ink.uuid": "UUID",
  "ink.binary": "이진",
};

export function slotUses(slot: TableSlot, mode: "dark" | "light"): string[] {
  return slot === "bg" ? ["바탕"] : slotRoles(mode)[slot].map((role) => ROLE_LABELS[role]);
}

export function tableMode(bg: string): "dark" | "light" {
  return contrastRatio(bg, "#000000") < contrastRatio(bg, "#ffffff") ? "dark" : "light";
}

function setRole(palette: Palette, syntax: SyntaxColors, role: Role, color: string): void {
  if (role.startsWith("syntax.")) {
    syntax[role.slice(7) as keyof SyntaxColors] = color;
  } else if (role.startsWith("ink.")) {
    palette.typeInks[role.slice(4) as keyof TypeInks] = color;
  } else {
    palette[role as PaletteRole] = color;
  }
}

function roleColor(palette: Palette, syntax: SyntaxColors, role: Role): string {
  if (role.startsWith("syntax.")) {
    return syntax[role.slice(7) as keyof SyntaxColors];
  }
  if (role.startsWith("ink.")) {
    return palette.typeInks[role.slice(4) as keyof TypeInks];
  }
  return palette[role as PaletteRole];
}

// A slot's colour made to read where its role is drawn: values and code on
// the background and striped rows, the app's own text also on the sidebars
// and headers.
function readableRole(role: Role, color: string, palette: Palette, mode: "dark" | "light"): string {
  const app = role === "ink" || role === "error" || role === "ok" || role === "warn";
  const grounds = app ? [palette.bg, palette.panel, palette.head] : [palette.bg, palette.rowAlt];
  return readableOn(color, grounds, FAINT_ROLES[role] ? 3 : 4.5, mode);
}

export function termTheme(source: TermSource): Theme {
  const { table, surfaces } = source;
  const { bg, fg } = table;
  const mode = tableMode(bg);
  const dark = mode === "dark";
  const toward = (amount: number): string => mixHex(bg, fg, amount);
  const panel = surfaces.page ?? toward(dark ? 0.04 : 0.035);
  const head = surfaces.codeBg ?? toward(dark ? 0.08 : 0.06);
  const card = surfaces.card;
  // A card barely off the background stripes the rows; one far off it
  // (a white card on a cream page) would shout.
  const rowAlt =
    card !== undefined && card.toLowerCase() !== bg.toLowerCase() && contrastRatio(card, bg) < 1.15 ? card : toward(0.03);
  // Borders that vanish into the background, or shout, give way to a mix.
  const borderContrast = contrastRatio(source.border, bg);
  const line = borderContrast >= 1.25 && borderContrast <= 4.5 ? source.border : toward(dark ? 0.16 : 0.14);
  const grounds = [bg, panel, head];
  const accent = readableOn(source.accent, [bg], 3, mode);
  const palette: Palette = {
    bg,
    panel,
    head,
    line,
    ink: fg,
    muted: readableOn(source.muted, grounds, 4.5, mode),
    faint: readableOn(source.faint, grounds, 3, mode),
    accent,
    accentHover: mixHex(accent, dark ? "#ffffff" : "#000000", 0.14),
    onAccent: contrastInk(accent),
    error: fg,
    ok: fg,
    warn: fg,
    rowAlt,
    hoverFill: withAlpha(fg, dark ? 0.06 : 0.05),
    selFill: withAlpha(accent, dark ? 0.2 : 0.13),
    selFillFocus: withAlpha(accent, dark ? 0.32 : 0.21),
    selLine: accent,
    nullInk: fg,
    typeInks: {} as TypeInks,
    btn: surfaces.raise ?? toward(dark ? 0.12 : 0.09),
    btnHover: surfaces.pop ?? toward(dark ? 0.18 : 0.14),
  };
  const syntax = {} as SyntaxColors;
  for (const [slot, roles] of Object.entries(slotRoles(mode)) as [TableSlot, Role[]][]) {
    for (const role of roles) {
      setRole(palette, syntax, role, readableRole(role, table[slot], palette, mode));
    }
  }
  return {
    id: source.id,
    label: source.id.startsWith(TERN_PREFIX) && !source.id.startsWith(TERN_FILE_PREFIX) ? ternLabel(source.label) : source.label,
    mode,
    accent,
    palette,
    syntax,
    source,
    group: source.id.startsWith(TERN_PREFIX) ? "tern" : undefined,
    imported: source.id.startsWith(TERN_FILE_PREFIX) || undefined,
  };
}

// Tern's own themes go by their omp file names ("dark-tokyo-night"); the
// pickers already split dark from light, so they read as "Tokyo Night".
const NAME_CASE: Record<string, string> = { github: "GitHub" };

function ternLabel(name: string): string {
  return name
    .replace(/^(dark|light)-/, "")
    .split("-")
    .map((word) => NAME_CASE[word] ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// A theme's colour table: its own, or for a theme not made from one, the
// colours it gives the parts each slot colours.
export function themeTable(theme: Theme): ColorTable {
  if (theme.source !== undefined) {
    return theme.source.table;
  }
  const { palette } = theme;
  const syntax = theme.syntax ?? paletteSyntax(palette);
  const table = { bg: palette.bg } as ColorTable;
  for (const [slot, roles] of Object.entries(slotRoles(theme.mode)) as [TableSlot, Role[]][]) {
    if (roles.length > 0) {
      table[slot] = roleColor(palette, syntax, roles[0]);
    }
  }
  return table;
}

// `theme` with colours picked in its table. One made from a table is made
// again from the table with them; any other takes each picked colour in the
// parts its slot colours, and a picked background moves its surfaces along.
export function withTable(theme: Theme, picks: TablePicks | undefined): Theme {
  if (picks === undefined || Object.keys(picks).length === 0) {
    return theme;
  }
  if (theme.source !== undefined) {
    const made = termTheme({ ...theme.source, table: { ...theme.source.table, ...picks } });
    return { ...theme, mode: made.mode, palette: made.palette, syntax: made.syntax };
  }
  const palette: Palette = { ...theme.palette, typeInks: { ...theme.palette.typeInks } };
  const syntax = { ...(theme.syntax ?? paletteSyntax(theme.palette)) };
  const from = parseHex(theme.palette.bg);
  const to = picks.bg === undefined ? null : parseHex(picks.bg);
  if (from !== null && to !== null) {
    for (const key of ["bg", "panel", "head", "line", "rowAlt", "btn", "btnHover"] as const) {
      const rgb = parseHex(palette[key]);
      if (rgb !== null) {
        palette[key] = toHex(rgb.map((value, channel) => value + to[channel] - from[channel]));
      }
    }
  }
  for (const [slot, roles] of Object.entries(slotRoles(theme.mode)) as [TableSlot, Role[]][]) {
    const picked = picks[slot];
    if (picked === undefined) {
      continue;
    }
    for (const role of roles) {
      setRole(palette, syntax, role, readableRole(role, picked, palette, theme.mode));
    }
  }
  return { ...theme, palette, syntax };
}

// The two Noir themes: the look of the author's Tern theme "gyu" (Tern's
// dark-neon-noir, its terminal colours replaced by an iTerm2 palette and its
// surfaces by Dracula's, the active tab filled #287D8E), and a light one with
// the same hue in each slot, each dark enough for 4.5:1 on every surface.
// Importing gyu.css makes the dark one but for the accent: the tab fill is
// set by a rule the importer passes over, so it keeps neon-noir's magenta.
const NOIR_DARK_TABLE: ColorTable = {
  bg: "#1e1f29",
  fg: "#ebece6",
  ansi0: "#000000",
  ansi1: "#fc4346",
  ansi2: "#50fb7c",
  ansi3: "#f0fb8c",
  ansi4: "#49baff",
  ansi5: "#fc4cb4",
  ansi6: "#8be9fe",
  ansi7: "#ededec",
  ansi8: "#555555",
  ansi9: "#fc4346",
  ansi10: "#50fb7c",
  ansi11: "#f0fb8c",
  ansi12: "#49baff",
  ansi13: "#fc4cb4",
  ansi14: "#8be9fe",
  ansi15: "#ededec",
};

export const DARK_NOIR: TermSource = {
  id: "dark-noir",
  label: "Dark Noir",
  table: NOIR_DARK_TABLE,
  accent: "#287d8e",
  muted: "#8a8a96",
  faint: "#4a4a55",
  border: "#4a4a55",
  surfaces: { page: "#21222c", card: "#20222e", raise: "#343642", codeBg: "#2e303c", pop: "#3c3e4b" },
};

export const LIGHT_NOIR: TermSource = {
  id: "light-noir",
  label: "Light Noir",
  table: {
    bg: "#f7f7fa",
    fg: "#1e1f29",
    ansi0: "#2a2b38",
    ansi1: "#c7171a",
    ansi2: "#0e7529",
    ansi3: "#606a06",
    ansi4: "#106aa0",
    ansi5: "#be167a",
    ansi6: "#0e6e83",
    ansi7: "#616377",
    ansi8: "#636471",
    ansi9: "#c7171a",
    ansi10: "#0e7529",
    ansi11: "#606a06",
    ansi12: "#106aa0",
    ansi13: "#be167a",
    ansi14: "#0e6e83",
    ansi15: "#383a4c",
  },
  // The dark one's #287d8e, darker to read as text on every surface.
  accent: "#236e7d",
  muted: "#545566",
  faint: "#636471",
  border: "#cfd1db",
  surfaces: { page: "#eeeff4", card: "#f1f2f6", raise: "#e2e3ea", codeBg: "#e8e9ef", pop: "#d8dae3" },
};

// Tern theme files imported in Settings, kept whole: they are offered without
// Tern's own themes loaded.
export const TERN_FILES_KEY = "tablepeek.tern-files";

function isSource(value: unknown): value is TermSource {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const source = value as TermSource;
  return (
    typeof source.id === "string" &&
    source.id.startsWith(TERN_FILE_PREFIX) &&
    typeof source.label === "string" &&
    typeof source.accent === "string" &&
    typeof source.muted === "string" &&
    typeof source.faint === "string" &&
    typeof source.border === "string" &&
    typeof source.surfaces === "object" &&
    source.surfaces !== null &&
    typeof source.table === "object" &&
    source.table !== null &&
    TABLE_SLOTS.every((slot) => typeof source.table[slot] === "string")
  );
}

export function readTernFiles(): TermSource[] {
  try {
    const parsed: unknown = JSON.parse(uiState.getItem(TERN_FILES_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isSource) : [];
  } catch {
    return [];
  }
}

export function writeTernFiles(sources: TermSource[]): void {
  if (sources.length === 0) {
    uiState.removeItem(TERN_FILES_KEY);
  } else {
    uiState.setItem(TERN_FILES_KEY, JSON.stringify(sources));
  }
}

// Tern's CSS variables a theme file may set, and where they go.
const CSS_VARIABLES: Record<string, { table: TableSlot } | { surface: Surface }> = {
  "--tv-bg": { table: "bg" },
  "--tv-fg": { table: "fg" },
  ...Object.fromEntries(ANSI_SLOTS.map((slot) => [`--${slot}`, { table: slot }])),
  "--tn-page": { surface: "page" },
  "--card": { surface: "card" },
  "--raise": { surface: "raise" },
  "--code-bg": { surface: "codeBg" },
  "--tn-pop": { surface: "pop" },
};

// A CSS colour as #rrggbb (any alpha dropped): hex, or rgb()/rgba().
function cssColor(value: string): string | null {
  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
  if (hex !== null) {
    const digits = hex[1].length <= 4 ? hex[1].slice(0, 3).replace(/./g, (c) => c + c) : hex[1].slice(0, 6);
    return `#${digits}`;
  }
  const rgb = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/.exec(text);
  if (rgb === null) {
    return null;
  }
  return toHex(
    rgb.slice(1, 4).map((part) => (part.endsWith("%") ? (Number.parseFloat(part) / 100) * 255 : Number.parseFloat(part))),
  );
}

// The top-level rules of a style sheet: each one's prelude (selectors, or an
// at-rule up to its block or semicolon) and block, nested blocks kept whole.
function cssRules(css: string): { prelude: string; block: string | null }[] {
  const rules: { prelude: string; block: string | null }[] = [];
  let start = 0;
  let index = 0;
  while (index < css.length) {
    const char = css[index];
    if (char === '"' || char === "'") {
      const end = css.indexOf(char, index + 1);
      index = end < 0 ? css.length : end + 1;
      continue;
    }
    if (char === ";") {
      rules.push({ prelude: css.slice(start, index).trim(), block: null });
      start = index + 1;
    } else if (char === "{") {
      let depth = 1;
      let end = index + 1;
      while (end < css.length && depth > 0) {
        if (css[end] === "{") {
          depth += 1;
        } else if (css[end] === "}") {
          depth -= 1;
        }
        end += 1;
      }
      rules.push({ prelude: css.slice(start, index).trim(), block: css.slice(index + 1, end - 1) });
      index = end;
      start = end;
      continue;
    }
    index += 1;
  }
  return rules;
}

// A Tern theme file made a theme: the oh-my-pi theme it @imports (one of
// `bases`), with the colour table and surfaces its :root rules set over it.
// Every other rule (Tern's own window, its tabs) is passed over.
export function parseTernCss(css: string, fileName: string, bases: TermSource[]): TermSource {
  const rules = cssRules(css.replace(/\/\*[\s\S]*?\*\//g, ""));
  let baseName: string | null = null;
  const table: TablePicks = {};
  const surfaces: Partial<Record<Surface, string>> = {};
  for (const { prelude, block } of rules) {
    const imported = /^@import\s+(?:url\(\s*)?["']?([^"')\s]+)["']?\s*\)?/i.exec(prelude);
    if (imported !== null && block === null) {
      baseName ??= imported[1].replace(/\.css$/i, "");
      continue;
    }
    const forRoot = prelude.split(",").some((selector) => [":root", "html", ".tv"].includes(selector.trim()));
    if (block === null || !forRoot) {
      continue;
    }
    for (const declaration of block.split(";")) {
      const colon = declaration.indexOf(":");
      const target = CSS_VARIABLES[declaration.slice(0, colon).trim()];
      const color = colon < 0 ? null : cssColor(declaration.slice(colon + 1).replace(/!important/i, ""));
      if (target === undefined || color === null) {
        continue;
      }
      if ("table" in target) {
        table[target.table] = color;
      } else {
        surfaces[target.surface] = color;
      }
    }
  }
  if (baseName === null) {
    throw new Error(t("Tern 테마 파일에 기반 테마(@import)가 없습니다."));
  }
  const name = baseName;
  const base = bases.find((item) => item.label === name);
  if (base === undefined) {
    throw new Error(t("기반 테마 “{name}”이(가) Tern 테마에 없습니다.", { name }));
  }
  const label = fileName.replace(/\.css$/i, "");
  return {
    ...base,
    id: `${TERN_FILE_PREFIX}${label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-")}`,
    label,
    table: { ...base.table, ...table },
    surfaces: { ...base.surfaces, ...surfaces },
  };
}
