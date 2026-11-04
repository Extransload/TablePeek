import { mixHex } from "../color";
import type { AnsiSlot, ColorTable, TermSource } from "../termTheme";

// The build reads these (vite.config.ts), so only colour arithmetic and types
// come in: termTheme.ts itself needs the page.

// An oh-my-pi theme file (the themes Tern offers, tern/*.json) as the build
// reads it: colours are #hex, a name from `vars`, an xterm 256-colour number,
// or "" for the terminal's own.
type OmpValue = string | number;

export interface OmpTheme {
  name: string;
  vars?: Record<string, OmpValue>;
  colors: Record<string, OmpValue>;
  terminal: {
    background: OmpValue;
    foreground: OmpValue;
    chrome?: OmpValue;
    widget?: OmpValue;
    ansi: OmpValue[];
  };
}

const XTERM_BASE = [
  "#000000",
  "#800000",
  "#008000",
  "#808000",
  "#000080",
  "#800080",
  "#008080",
  "#c0c0c0",
  "#808080",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#0000ff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
];
const XTERM_STEPS = [0, 95, 135, 175, 215, 255];

function xterm(index: number): string {
  if (index < 16) {
    return XTERM_BASE[index];
  }
  const hex = (value: number): string => value.toString(16).padStart(2, "0");
  if (index < 232) {
    const cube = index - 16;
    return `#${hex(XTERM_STEPS[Math.floor(cube / 36)])}${hex(XTERM_STEPS[Math.floor(cube / 6) % 6])}${hex(XTERM_STEPS[cube % 6])}`;
  }
  const grey = hex(8 + (index - 232) * 10);
  return `#${grey}${grey}${grey}`;
}

// The theme as TablePeek makes themes of terminal tables (termTheme.ts), but
// for its id, which the app gives it. The build fails on a theme whose table
// can't be read.
export function ompSource(theme: OmpTheme): Omit<TermSource, "id"> {
  const vars = theme.vars ?? {};
  const resolve = (value: OmpValue | undefined, depth = 0): string | undefined => {
    if (typeof value === "number") {
      return xterm(value);
    }
    if (value === undefined || value === "") {
      return undefined;
    }
    if (value.startsWith("#")) {
      const digits = value.slice(1).toLowerCase();
      return `#${digits.length === 3 ? digits.replace(/./g, (c) => c + c) : digits.slice(0, 6)}`;
    }
    return depth < 8 ? resolve(vars[value], depth + 1) : undefined;
  };
  const required = (value: OmpValue | undefined, what: string): string => {
    const color = resolve(value);
    if (color === undefined) {
      throw new Error(`Tern theme ${theme.name}: no colour for ${what}`);
    }
    return color;
  };
  const { terminal, colors } = theme;
  const bg = required(terminal.background, "terminal.background");
  const fg = resolve(terminal.foreground) ?? required(colors.text, "terminal.foreground");
  const table = { bg, fg } as ColorTable;
  for (let index = 0; index < 16; index += 1) {
    table[`ansi${index}` as AnsiSlot] = required(terminal.ansi[index], `terminal.ansi[${index}]`);
  }
  // The window's chrome and widgets: Tern's page and cards, when they differ
  // from the terminal's background.
  const differs = (value: OmpValue | undefined): string | undefined => {
    const color = resolve(value);
    return color === bg ? undefined : color;
  };
  const page = differs(terminal.chrome);
  const card = differs(terminal.widget);
  return {
    label: theme.name,
    table,
    accent: resolve(colors.accent) ?? resolve(colors.borderAccent) ?? table.ansi4,
    muted: resolve(colors.muted) ?? mixHex(fg, bg, 0.35),
    faint: resolve(colors.dim) ?? mixHex(fg, bg, 0.55),
    border: resolve(colors.borderMuted) ?? resolve(colors.border) ?? mixHex(bg, fg, 0.16),
    surfaces: { ...(page === undefined ? {} : { page }), ...(card === undefined ? {} : { card }) },
  };
}
