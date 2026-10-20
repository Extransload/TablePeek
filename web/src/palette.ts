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
  return luminance > 0.45 ? "#1f2230" : "#ffffff";
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

const latte: Palette = makePalette(
  {
    bg: "#eff1f5",
    panel: "#ffffff",
    head: "#e6e9ef",
    line: "#ccd0da",
    ink: "#4c4f69",
    muted: "#6c6f85",
    faint: "#9ca0b0",
    error: "#d20f39",
    ok: "#40a02b",
    warn: "#df8e1d",
    rowAlt: "#e9ebf2",
    hoverFill: "rgba(76, 79, 105, 0.055)",
    selFill: "rgba(136, 57, 239, 0.12)",
    selFillFocus: "rgba(136, 57, 239, 0.2)",
    selLine: "#8839ef",
    nullInk: "#9ca0b0",
    typeInks: {
      string: "#2f7d22",
      integer: "#1a5fe0",
      float: "#0d7a72",
      bigint: "#8a5a00",
      boolean: "#d20f39",
      json: "#8839ef",
      list: "#c2410c",
      date: "#5c5f77",
    },
    btn: "#dce0e8",
    btnHover: "#ccd0da",
  },
  "#8839ef",
  "light",
);

const frappe: Palette = makePalette(
  {
    bg: "#303446",
    panel: "#292c3c",
    head: "#414559",
    line: "#51576d",
    ink: "#c6d0f5",
    muted: "#a5adce",
    faint: "#838ba7",
    error: "#e78284",
    ok: "#a6d189",
    warn: "#e5c890",
    rowAlt: "#2c3040",
    hoverFill: "rgba(198, 208, 245, 0.07)",
    selFill: "rgba(202, 158, 230, 0.18)",
    selFillFocus: "rgba(202, 158, 230, 0.28)",
    selLine: "#ca9ee6",
    nullInk: "#838ba7",
    typeInks: {
      string: "#a6d189",
      integer: "#8caaee",
      float: "#81c8be",
      bigint: "#e5c890",
      boolean: "#e78284",
      json: "#ca9ee6",
      list: "#ef9f76",
      date: "#a5adce",
    },
    btn: "#414559",
    btnHover: "#51576d",
  },
  "#ca9ee6",
  "dark",
);

const macchiato: Palette = makePalette(
  {
    bg: "#24273a",
    panel: "#1e2030",
    head: "#363a4f",
    line: "#494d64",
    ink: "#cad3f5",
    muted: "#a5adcb",
    faint: "#8087a2",
    error: "#ed8796",
    ok: "#a6da95",
    warn: "#eed49f",
    rowAlt: "#292c3f",
    hoverFill: "rgba(202, 211, 245, 0.07)",
    selFill: "rgba(198, 160, 246, 0.18)",
    selFillFocus: "rgba(198, 160, 246, 0.28)",
    selLine: "#c6a0f6",
    nullInk: "#8087a2",
    typeInks: {
      string: "#a6da95",
      integer: "#8aadf4",
      float: "#8bd5ca",
      bigint: "#eed49f",
      boolean: "#ed8796",
      json: "#c6a0f6",
      list: "#f5a97f",
      date: "#a5adcb",
    },
    btn: "#363a4f",
    btnHover: "#494d64",
  },
  "#c6a0f6",
  "dark",
);

const mocha: Palette = makePalette(
  {
    bg: "#1e1e2e",
    panel: "#181825",
    head: "#313244",
    line: "#45475a",
    ink: "#cdd6f4",
    muted: "#a6adc8",
    faint: "#7f849c",
    error: "#f38ba8",
    ok: "#a6e3a1",
    warn: "#f9e2af",
    rowAlt: "#232334",
    hoverFill: "rgba(205, 214, 244, 0.07)",
    selFill: "rgba(203, 166, 247, 0.18)",
    selFillFocus: "rgba(203, 166, 247, 0.3)",
    selLine: "#cba6f7",
    nullInk: "#7f849c",
    typeInks: {
      string: "#a6e3a1",
      integer: "#89b4fa",
      float: "#94e2d5",
      bigint: "#f9e2af",
      boolean: "#f38ba8",
      json: "#cba6f7",
      list: "#fab387",
      date: "#a6adc8",
    },
    btn: "#313244",
    btnHover: "#45475a",
  },
  "#cba6f7",
  "dark",
);

const nord: Palette = makePalette(
  {
    bg: "#2e3440",
    panel: "#343b48",
    head: "#3b4252",
    line: "#4c566a",
    ink: "#eceff4",
    muted: "#c2cbd9",
    faint: "#8b95a7",
    error: "#bf616a",
    ok: "#a3be8c",
    warn: "#ebcb8b",
    rowAlt: "#323947",
    hoverFill: "rgba(236, 239, 244, 0.06)",
    selFill: "rgba(136, 192, 208, 0.18)",
    selFillFocus: "rgba(136, 192, 208, 0.3)",
    selLine: "#88c0d0",
    nullInk: "#8b95a7",
    typeInks: {
      string: "#a3be8c",
      integer: "#81a1c1",
      float: "#8fbcbb",
      bigint: "#ebcb8b",
      boolean: "#e08a96",
      json: "#c3a6bf",
      list: "#e09a86",
      date: "#9aa5b8",
    },
    btn: "#3b4252",
    btnHover: "#4c566a",
  },
  "#88c0d0",
  "dark",
);

const dracula: Palette = makePalette(
  {
    bg: "#282a36",
    panel: "#21222c",
    head: "#343746",
    line: "#44475a",
    ink: "#f8f8f2",
    muted: "#bfc2d0",
    faint: "#7f8296",
    error: "#ff6e7a",
    ok: "#69f0a0",
    warn: "#f1fa8c",
    rowAlt: "#2d2f3c",
    hoverFill: "rgba(248, 248, 242, 0.06)",
    selFill: "rgba(189, 147, 249, 0.2)",
    selFillFocus: "rgba(189, 147, 249, 0.32)",
    selLine: "#bd93f9",
    nullInk: "#7f8296",
    typeInks: {
      string: "#50fa7b",
      integer: "#8be9fd",
      float: "#a4e8ff",
      bigint: "#f1fa8c",
      boolean: "#ff5555",
      json: "#bd93f9",
      list: "#ffb86c",
      date: "#9296b4",
    },
    btn: "#343746",
    btnHover: "#44475a",
  },
  "#bd93f9",
  "dark",
);

const tokyo: Palette = makePalette(
  {
    bg: "#1a1b26",
    panel: "#1f2335",
    head: "#24283b",
    line: "#414868",
    ink: "#c0caf5",
    muted: "#9aa5ce",
    faint: "#6d789e",
    error: "#f7768e",
    ok: "#9ece6a",
    warn: "#e0af68",
    rowAlt: "#1e2030",
    hoverFill: "rgba(192, 202, 245, 0.06)",
    selFill: "rgba(122, 162, 247, 0.2)",
    selFillFocus: "rgba(122, 162, 247, 0.32)",
    selLine: "#7aa2f7",
    nullInk: "#6d789e",
    typeInks: {
      string: "#9ece6a",
      integer: "#7aa2f7",
      float: "#7dcfff",
      bigint: "#e0af68",
      boolean: "#f7768e",
      json: "#bb9af7",
      list: "#ff9e64",
      date: "#8b96c0",
    },
    btn: "#292e42",
    btnHover: "#343b58",
  },
  "#7aa2f7",
  "dark",
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
  {
    id: "catppuccin-latte",
    label: "Catppuccin Latte",
    mode: "light",
    accent: "#8839ef",
    palette: latte,
  },
  {
    id: "catppuccin-frappe",
    label: "Catppuccin Frappé",
    mode: "dark",
    accent: "#ca9ee6",
    palette: frappe,
  },
  {
    id: "catppuccin-macchiato",
    label: "Catppuccin Macchiato",
    mode: "dark",
    accent: "#c6a0f6",
    palette: macchiato,
  },
  {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    mode: "dark",
    accent: "#cba6f7",
    palette: mocha,
  },
  { id: "nord", label: "Nord", mode: "dark", accent: "#88c0d0", palette: nord },
  {
    id: "dracula",
    label: "Dracula",
    mode: "dark",
    accent: "#bd93f9",
    palette: dracula,
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    mode: "dark",
    accent: "#7aa2f7",
    palette: tokyo,
  },
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
    throw new Error("테마 JSON 객체가 아닙니다");
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
