// Fonts to pick from in Settings, for the SQL editor, the data table and the
// sidebar: the system's own, then every face installed on this machine by
// its PostScript name (JetBrainsMonoNF-Regular), as TablePlus lists them.

export interface FontChoice {
  label: string;
  // A CSS font-family list, as stored in the settings.
  value: string;
}

export const SYSTEM_UI_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
export const SYSTEM_CODE_FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

const SYSTEM_CODE_CHOICE: FontChoice = { label: "시스템 고정폭", value: SYSTEM_CODE_FONT };
const SYSTEM_UI_CHOICE: FontChoice = { label: "시스템 기본", value: SYSTEM_UI_FONT };

// CSS picks fonts by family, so a face is named as a family of its own,
// declared with @font-face from the font the system has under that name:
// "tablepeek-face:<face>/<bold>/<italic>/<bold italic>", the face picked
// and the family's faces bold and italic text take (see companions).
const FACE_PREFIX = "tablepeek-face:";
// PostScript names never hold a slash.
const FACE_SEPARATOR = "/";
const FACE_PATTERN = /"tablepeek-face:((?:[^"\\]|\\.)*)"/g;
const FACE_STYLE_ID = "tablepeek-faces";

// A family name as a CSS string: a quote or backslash in it would end it early.
function cssName(family: string): string {
  return `"${family.replace(/[\\"]/g, "\\$&")}"`;
}

// One face of an installed family, as the server lists it.
export interface InstalledFace {
  // Its PostScript name.
  name: string;
  weight: number;
  italic: boolean;
}

// A font family installed on this machine, as the server lists them.
export interface InstalledFont {
  name: string;
  // Its Korean name, when the font has one (HYwulM is HY울릉도M).
  korean: string | null;
  monospace: boolean;
  faces: InstalledFace[];
}

export interface FontGroup {
  // None for the list's first, ungrouped entry.
  label: string | null;
  choices: FontChoice[];
}

// The face bold text takes in place of `face`, from `pool`: the face
// itself when it is bold already (so it isn't thickened again), else the
// family's bold (700, or the nearest heavier), or "" for none, which the
// browser fakes.
function boldOf(face: InstalledFace, pool: InstalledFace[]): string {
  if (face.weight >= 600) {
    return face.name;
  }
  const heavier = pool.filter((other) => other.weight > face.weight && other.weight >= 600);
  heavier.sort((a, b) => a.weight - b.weight);
  return (heavier.find((other) => other.weight >= 700) ?? heavier[heavier.length - 1])?.name ?? "";
}

// What a picked face draws bold, italic and bold italic text in, as
// TablePlus converts a font to its bold or italic trait: the family's own
// faces, nearest the picked weight. An italic face is its own italic.
function companions(face: InstalledFace, family: InstalledFont): string[] {
  const upright = family.faces.filter((other) => !other.italic);
  const slanted = family.faces.filter((other) => other.italic);
  const italic = face.italic
    ? face
    : slanted.reduce<InstalledFace | null>(
        (best, other) =>
          best === null || Math.abs(other.weight - face.weight) < Math.abs(best.weight - face.weight) ? other : best,
        null,
      );
  return [
    face.name,
    boldOf(face, face.italic ? slanted : upright),
    italic?.name ?? "",
    italic === null ? "" : boldOf(italic, slanted),
  ];
}

// A face to pick: the face itself (with its family's bold and italic), then
// its family should the system not find it by name, then the system's own.
function faceChoice(face: InstalledFace, family: InstalledFont, monospaced: boolean): FontChoice {
  const alias = FACE_PREFIX + companions(face, family).join(FACE_SEPARATOR);
  return {
    label: family.korean ? `${face.name} (${family.korean})` : face.name,
    value: `${cssName(alias)}, ${cssName(family.name)}, ${monospaced ? SYSTEM_CODE_FONT : SYSTEM_UI_FONT}`,
  };
}

const evenWidths = new Map<string, boolean>();

// Whether a family's letters all take one width, measured as drawn: plenty
// of code fonts leave their own fixed-pitch flag unset.
function drawsMonospace(family: string): boolean {
  const known = evenWidths.get(family);
  if (known !== undefined) {
    return known;
  }
  const ctx = document.createElement("canvas").getContext("2d");
  if (ctx === null) {
    return false;
  }
  ctx.font = `32px ${cssName(family)}, sans-serif`;
  const even = ctx.measureText("iiiiiiiiii").width === ctx.measureText("MMMMMMMMMM").width;
  evenWidths.set(family, even);
  return even;
}

// What Settings offers for one of its three fonts: the system's own first
// (for the data table and the sidebar both its monospaced and its plain
// one, as TablePlus offers), then every installed face, those of
// monospaced families before the rest.
export function fontGroups(place: "editor" | "grid" | "sidebar", families: InstalledFont[]): FontGroup[] {
  const systems = place === "editor" ? [SYSTEM_CODE_CHOICE] : [SYSTEM_CODE_CHOICE, SYSTEM_UI_CHOICE];
  const monospaced: FontChoice[] = [];
  const others: FontChoice[] = [];
  for (const family of families) {
    if (family.faces.length === 0) {
      continue;
    }
    const fixed = family.monospace || drawsMonospace(family.name);
    for (const face of family.faces) {
      (fixed ? monospaced : others).push(faceChoice(face, family, fixed));
    }
  }
  const groups: FontGroup[] = [
    { label: null, choices: systems },
    { label: "고정폭 글꼴", choices: monospaced },
    { label: "그 밖의 글꼴", choices: others },
  ];
  return groups.filter((group) => group.choices.length > 0);
}

// The name a saved font list goes by when no choice matches it (one saved by
// an earlier version, say): its first family, or the face it names.
export function fontListLabel(value: string): string {
  const first = /^\s*("(?:[^"\\]|\\.)*"|[^,]*)/.exec(value)?.[1].trim() ?? "";
  const unquoted = first.startsWith('"') ? first.slice(1, -1).replace(/\\(.)/g, "$1") : first;
  return unquoted.startsWith(FACE_PREFIX)
    ? unquoted.slice(FACE_PREFIX.length).split(FACE_SEPARATOR)[0]
    : unquoted;
}

// The face a font list picks, or null for a list of families.
export function pickedFace(value: string): string | null {
  const match = /^\s*"tablepeek-face:((?:[^"\\]|\\.)*)"/.exec(value);
  return match === null ? null : match[1].replace(/\\(.)/g, "$1").split(FACE_SEPARATOR)[0];
}

// One face under an alias, for text of one style and a range of weights.
function faceRule(alias: string, face: string, style: "normal" | "italic", weight: string): string {
  return `@font-face { font-family: ${cssName(alias)}; src: local(${cssName(face)}); font-style: ${style}; font-weight: ${weight}; }`;
}

// The rules for one style: the face, and its bold above 600 when it has
// one; a face that is its own bold covers every weight, and one with no
// bold stops short of 600, so the browser fakes bold from it.
function styleRules(alias: string, face: string, bold: string, style: "normal" | "italic"): string[] {
  if (face === "") {
    return [];
  }
  if (bold === face) {
    return [faceRule(alias, face, style, "1 1000")];
  }
  return bold === ""
    ? [faceRule(alias, face, style, "1 599")]
    : [faceRule(alias, face, style, "1 599"), faceRule(alias, bold, style, "600 1000")];
}

// Declares the faces the given font lists name, so they draw: each as a
// family of its own from the face the system has (local()). The canvas grid
// repaints once they load (see CanvasGrid).
export function declareFaces(values: string[]): void {
  const aliases = new Set<string>();
  for (const value of values) {
    for (const match of value.matchAll(FACE_PATTERN)) {
      aliases.add(match[1].replace(/\\(.)/g, "$1"));
    }
  }
  const css = [...aliases]
    .flatMap((faces) => {
      const alias = FACE_PREFIX + faces;
      const [face = "", bold = "", italic = "", boldItalic = ""] = faces.split(FACE_SEPARATOR);
      // An upright pick leaves italic text to its family's italic, or the
      // browser's slant where there is none.
      return [...styleRules(alias, face, bold, "normal"), ...styleRules(alias, italic, boldItalic, "italic")];
    })
    .join("\n");
  let style = document.getElementById(FACE_STYLE_ID);
  if (style === null) {
    if (css === "") {
      return;
    }
    style = document.createElement("style");
    style.id = FACE_STYLE_ID;
    document.head.append(style);
  }
  if (style.textContent !== css) {
    style.textContent = css;
  }
}
