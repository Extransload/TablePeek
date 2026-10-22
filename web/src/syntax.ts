export type SyntaxPresetId =
  | "tablepeek"
  | "palenight"
  | "solarized"
  | "monokai"
  | "github"
  | "nord";

export interface SyntaxColors {
  keyword: string;
  string: string;
  number: string;
  comment: string;
  variable: string;
  type: string;
  operator: string;
  punctuation: string;
  bool: string;
  null: string;
  function: string;
  label: string;
}

export interface SyntaxPreset {
  id: SyntaxPresetId;
  label: string;
  description: string;
  dark: SyntaxColors;
  light: SyntaxColors;
}

export const SYNTAX_PRESETS: SyntaxPreset[] = [
  {
    id: "tablepeek",
    label: "테마 기본",
    description: "현재 테마의 구문 색상을 따릅니다.",
    dark: {
      keyword: "#7aa2ff",
      string: "#9bd7a0",
      number: "#e8c98a",
      comment: "#73737e",
      variable: "#dedee3",
      type: "#a3a3ad",
      operator: "#a3a3ad",
      punctuation: "#a3a3ad",
      bool: "#f29b8f",
      null: "#f29b8f",
      function: "#8fc7ff",
      label: "#d8b4fe",
    },
    light: {
      keyword: "#2f63c8",
      string: "#24753d",
      number: "#8a5b00",
      comment: "#8a8f98",
      variable: "#25272c",
      type: "#5f6369",
      operator: "#5f6369",
      punctuation: "#5f6369",
      bool: "#b3392f",
      null: "#b3392f",
      function: "#1959b8",
      label: "#7b3fb2",
    },
  },
  {
    id: "palenight",
    label: "Palenight",
    description: "선명한 보라·청록 계열의 Material Palenight 색상입니다.",
    dark: {
      keyword: "#c792ea",
      string: "#c3e88d",
      number: "#f78c6c",
      comment: "#697098",
      variable: "#d6deeb",
      type: "#82aaff",
      operator: "#89ddff",
      punctuation: "#8b9bb4",
      bool: "#ff9cac",
      null: "#ff9cac",
      function: "#82aaff",
      label: "#ffcb6b",
    },
    light: {
      keyword: "#7c3aed",
      string: "#3f7d20",
      number: "#b45309",
      comment: "#8b93a7",
      variable: "#263238",
      type: "#1d4ed8",
      operator: "#0e7490",
      punctuation: "#64748b",
      bool: "#be123c",
      null: "#be123c",
      function: "#1d4ed8",
      label: "#a16207",
    },
  },
  {
    id: "solarized",
    label: "Solarized",
    description: "낮은 대비와 안정적인 색조의 Solarized 팔레트입니다.",
    dark: {
      keyword: "#859900",
      string: "#2aa198",
      number: "#d33682",
      comment: "#586e75",
      variable: "#93a1a1",
      type: "#b58900",
      operator: "#6c71c4",
      punctuation: "#839496",
      bool: "#cb4b16",
      null: "#cb4b16",
      function: "#268bd2",
      label: "#b58900",
    },
    light: {
      keyword: "#6c7d00",
      string: "#147f76",
      number: "#b62b6e",
      comment: "#93a1a1",
      variable: "#586e75",
      type: "#8a6800",
      operator: "#5458a8",
      punctuation: "#657b83",
      bool: "#a63d12",
      null: "#a63d12",
      function: "#1e6fa8",
      label: "#8a6800",
    },
  },
  {
    id: "monokai",
    label: "Monokai",
    description: "핑크·노랑·초록의 고대비 Monokai 스타일입니다.",
    dark: {
      keyword: "#f92672",
      string: "#e6db74",
      number: "#ae81ff",
      comment: "#75715e",
      variable: "#f8f8f2",
      type: "#66d9ef",
      operator: "#f92672",
      punctuation: "#c5c8c6",
      bool: "#ae81ff",
      null: "#ae81ff",
      function: "#a6e22e",
      label: "#fd971f",
    },
    light: {
      keyword: "#c2185b",
      string: "#7c6f00",
      number: "#6d28d9",
      comment: "#8a857d",
      variable: "#272822",
      type: "#0b7285",
      operator: "#c2185b",
      punctuation: "#6b6b64",
      bool: "#6d28d9",
      null: "#6d28d9",
      function: "#4d7c0f",
      label: "#b45309",
    },
  },
  {
    id: "github",
    label: "GitHub",
    description: "GitHub의 밝고 명확한 구문 강조 색상입니다.",
    dark: {
      keyword: "#ff7b72",
      string: "#a5d6ff",
      number: "#79c0ff",
      comment: "#8b949e",
      variable: "#c9d1d9",
      type: "#ffa657",
      operator: "#ff7b72",
      punctuation: "#8b949e",
      bool: "#79c0ff",
      null: "#79c0ff",
      function: "#d2a8ff",
      label: "#7ee787",
    },
    light: {
      keyword: "#cf222e",
      string: "#0a3069",
      number: "#0550ae",
      comment: "#6e7781",
      variable: "#24292f",
      type: "#953800",
      operator: "#cf222e",
      punctuation: "#6e7781",
      bool: "#0550ae",
      null: "#0550ae",
      function: "#8250df",
      label: "#116329",
    },
  },
  {
    id: "nord",
    label: "Nord",
    description: "차가운 블루·그린 계열의 Nord 팔레트입니다.",
    dark: {
      keyword: "#81a1c1",
      string: "#a3be8c",
      number: "#b48ead",
      comment: "#616e88",
      variable: "#d8dee9",
      type: "#8fbcbb",
      operator: "#81a1c1",
      punctuation: "#a0aec0",
      bool: "#5e81ac",
      null: "#5e81ac",
      function: "#88c0d0",
      label: "#ebcb8b",
    },
    light: {
      keyword: "#4c6a92",
      string: "#5c7a3f",
      number: "#8a5a86",
      comment: "#8a93a5",
      variable: "#2e3440",
      type: "#4f7d7c",
      operator: "#4c6a92",
      punctuation: "#65758b",
      bool: "#405f86",
      null: "#405f86",
      function: "#3f7f8e",
      label: "#8a6a1f",
    },
  },
];

export function syntaxPresetById(id: string | undefined): SyntaxPreset {
  return SYNTAX_PRESETS.find((preset) => preset.id === id) ?? SYNTAX_PRESETS[0];
}

export function syntaxColors(
  id: string | undefined,
  mode: "dark" | "light",
): SyntaxColors {
  const preset = syntaxPresetById(id);
  return mode === "light" ? preset.light : preset.dark;
}

export const SYNTAX_VARIABLES: Record<keyof SyntaxColors, string> = {
  keyword: "--syntax-keyword",
  string: "--syntax-string",
  number: "--syntax-number",
  comment: "--syntax-comment",
  variable: "--syntax-variable",
  type: "--syntax-type",
  operator: "--syntax-operator",
  punctuation: "--syntax-punctuation",
  bool: "--syntax-bool",
  null: "--syntax-null",
  function: "--syntax-function",
  label: "--syntax-label",
};
