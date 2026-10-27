// Font families to pick from in Settings: one for the app (menus, panels,
// tabs, the sidebar) and one for code (the SQL editor, the console and the
// data grid). Each falls back to the system's own when it isn't installed.

export interface FontChoice {
  label: string;
  // A CSS font-family list, as stored in the settings.
  value: string;
  // The family to look for on this machine; none for a system stack.
  family?: string;
}

export const SYSTEM_UI_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
export const SYSTEM_CODE_FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

// A family name as a CSS string: a quote or backslash in it would end it early.
function cssName(family: string): string {
  return `"${family.replace(/[\\"]/g, "\\$&")}"`;
}

function uiFont(label: string, families: string[]): FontChoice {
  return {
    label,
    value: `${families.map(cssName).join(", ")}, ${SYSTEM_UI_FONT}`,
    family: families[0],
  };
}

function codeFont(label: string, families: string[]): FontChoice {
  return {
    label,
    value: `${families.map(cssName).join(", ")}, ${SYSTEM_CODE_FONT}`,
    family: families[0],
  };
}

export const UI_FONTS: FontChoice[] = [
  { label: "시스템 기본", value: SYSTEM_UI_FONT },
  uiFont("Pretendard", ["Pretendard", "Pretendard Variable"]),
  uiFont("Apple SD Gothic Neo", ["Apple SD Gothic Neo"]),
  uiFont("Noto Sans KR", ["Noto Sans KR", "Noto Sans CJK KR"]),
  uiFont("나눔고딕", ["NanumGothic", "Nanum Gothic"]),
  uiFont("나눔스퀘어", ["NanumSquare", "NanumSquareOTF"]),
  uiFont("Spoqa Han Sans Neo", ["Spoqa Han Sans Neo"]),
  uiFont("SUIT", ["SUIT", "SUIT Variable"]),
  uiFont("IBM Plex Sans KR", ["IBM Plex Sans KR"]),
  uiFont("맑은 고딕", ["Malgun Gothic"]),
  uiFont("SF Pro", ["SF Pro Text", "SF Pro Display", "SF Pro"]),
  uiFont("Helvetica Neue", ["Helvetica Neue"]),
  uiFont("Inter", ["Inter", "Inter Variable"]),
  uiFont("Segoe UI", ["Segoe UI"]),
  uiFont("Roboto", ["Roboto"]),
  uiFont("Open Sans", ["Open Sans"]),
  uiFont("Lato", ["Lato"]),
  uiFont("Source Sans 3", ["Source Sans 3", "Source Sans Pro"]),
  uiFont("IBM Plex Sans", ["IBM Plex Sans"]),
  uiFont("Ubuntu", ["Ubuntu"]),
];

export const CODE_FONTS: FontChoice[] = [
  { label: "시스템 고정폭", value: SYSTEM_CODE_FONT },
  // The four lists earlier versions offered, kept as written so saved
  // settings still match them.
  { label: "SF Mono", value: '"SF Mono", ui-monospace, monospace', family: "SF Mono" },
  { label: "Menlo", value: "Menlo, Monaco, monospace", family: "Menlo" },
  codeFont("Monaco", ["Monaco"]),
  codeFont("JetBrains Mono", ["JetBrains Mono"]),
  codeFont("Fira Code", ["Fira Code"]),
  codeFont("Fira Mono", ["Fira Mono"]),
  codeFont("Source Code Pro", ["Source Code Pro"]),
  codeFont("Cascadia Code", ["Cascadia Code"]),
  codeFont("Cascadia Mono", ["Cascadia Mono"]),
  codeFont("IBM Plex Mono", ["IBM Plex Mono"]),
  codeFont("Roboto Mono", ["Roboto Mono"]),
  codeFont("Ubuntu Mono", ["Ubuntu Mono"]),
  codeFont("Hack", ["Hack"]),
  codeFont("Inconsolata", ["Inconsolata"]),
  codeFont("D2Coding", ["D2Coding", "D2Coding ligature"]),
  codeFont("나눔고딕코딩", ["NanumGothicCoding", "Nanum Gothic Coding"]),
  codeFont("Noto Sans Mono", ["Noto Sans Mono"]),
  codeFont("DejaVu Sans Mono", ["DejaVu Sans Mono"]),
  codeFont("Consolas", ["Consolas"]),
  { label: "Courier New", value: '"Courier New", Courier, monospace', family: "Courier New" },
];

const installed = new Map<string, boolean>();

// Whether this machine has the font: text drawn in it, falling back to a
// generic family, measures differently from the generic family alone.
export function fontInstalled(family: string): boolean {
  const known = installed.get(family);
  if (known !== undefined) {
    return known;
  }
  const ctx = document.createElement("canvas").getContext("2d");
  if (ctx === null) {
    return true;
  }
  const sample = "mmmmmmmmmlli1WWW 가나다라 0123";
  const found = ["monospace", "serif", "sans-serif"].some((generic) => {
    ctx.font = `32px ${generic}`;
    const plain = ctx.measureText(sample).width;
    ctx.font = `32px ${cssName(family)}, ${generic}`;
    return ctx.measureText(sample).width !== plain;
  });
  installed.set(family, found);
  return found;
}

// A font family installed on this machine, as the server lists them.
export interface InstalledFont {
  name: string;
  // Its Korean name, when the font has one (HYwulM is HY울릉도M).
  korean: string | null;
  monospace: boolean;
}

export interface FontGroup {
  // None for the list's first, ungrouped entry.
  label: string | null;
  choices: FontChoice[];
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

// What Settings offers: the system's own font first, then the suggested ones
// this machine has (and the saved pick, even when it hasn't), then every
// other installed family; for code, the monospaced ones before the rest.
export function fontGroups(kind: "ui" | "code", families: InstalledFont[], current: string): FontGroup[] {
  const [system, ...suggested] = kind === "ui" ? UI_FONTS : CODE_FONTS;
  const offered = suggested.filter(
    (choice) => choice.family === undefined || fontInstalled(choice.family) || choice.value === current,
  );
  const covered = new Set(offered.map((choice) => choice.family?.toLowerCase()));
  const make = kind === "ui" ? uiFont : codeFont;
  const rest = families
    .filter((font) => !covered.has(font.name.toLowerCase()))
    .map((font) => ({
      choice: make(font.korean ? `${font.korean} (${font.name})` : font.name, [font.name]),
      // Measured for the code list only: the app list doesn't split on it.
      monospace: kind === "code" && (font.monospace || drawsMonospace(font.name)),
    }));
  const groups: FontGroup[] = [
    { label: null, choices: [system] },
    { label: "추천", choices: offered },
  ];
  if (kind === "ui") {
    groups.push({ label: "설치된 글꼴", choices: rest.map((font) => font.choice) });
  } else {
    groups.push(
      { label: "고정폭 글꼴", choices: rest.filter((font) => font.monospace).map((font) => font.choice) },
      { label: "그 밖의 글꼴", choices: rest.filter((font) => !font.monospace).map((font) => font.choice) },
    );
  }
  return groups.filter((group) => group.choices.length > 0);
}
