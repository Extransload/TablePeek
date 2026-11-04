import { addThemes, removeTheme, THEMES, type Theme } from "./palette";
import * as uiState from "./persist";
import {
  parseTernCss,
  readTernFiles,
  TERN_FILE_PREFIX,
  TERN_FILES_KEY,
  TERN_PREFIX,
  termTheme,
  writeTernFiles,
  type TermSource,
} from "./termTheme";

// Tern's themes are a chunk of their own (see vite.config.ts), loaded the
// first time they're wanted: Settings → Theme shows them, a Tern theme file
// is imported on one of them, or the saved theme is one.
let loading: Promise<TermSource[]> | null = null;

export function loadTernThemes(): Promise<TermSource[]> {
  loading ??= import("virtual:tern-themes")
    .then(({ default: built }) => {
      const sources = built.map((source) => ({ ...source, id: `${TERN_PREFIX}${source.label}` }));
      addThemes(sources.map(termTheme));
      return sources;
    })
    .catch((error: unknown) => {
      loading = null;
      throw error;
    });
  return loading;
}

// Whether `id` names one of Tern's themes not loaded yet.
export function awaitsTernThemes(id: string): boolean {
  return id.startsWith(TERN_PREFIX) && !id.startsWith(TERN_FILE_PREFIX) && !THEMES.some((theme) => theme.id === id);
}

// Before the app draws: the saved theme's colours are in place, not the
// default's for a moment. A failed load leaves the default theme.
export async function loadSavedTheme(): Promise<void> {
  try {
    const saved = JSON.parse(uiState.getItem(uiState.SETTINGS_KEY) ?? "{}") as { theme?: unknown };
    if (typeof saved.theme === "string" && awaitsTernThemes(saved.theme)) {
      await loadTernThemes();
    }
  } catch {
    // Unreadable settings start from the defaults (settings.ts).
  }
}

// A Tern theme file (Tern/themes/*.css) added as a theme, in place of one
// imported from a file of that name before.
export async function importTernFile(file: File): Promise<Theme> {
  const [css, bases] = await Promise.all([file.text(), loadTernThemes()]);
  const source = parseTernCss(css, file.name, bases);
  writeTernFiles([...readTernFiles().filter((item) => item.id !== source.id), source]);
  const theme = termTheme(source);
  addThemes([theme]);
  return theme;
}

export function removeTernFile(id: string): void {
  writeTernFiles(readTernFiles().filter((item) => item.id !== id));
  removeTheme(id);
}

// Another window imported or removed a theme file: this one offers the same.
uiState.subscribeChangesElsewhere((key) => {
  if (key !== TERN_FILES_KEY) {
    return;
  }
  const files = readTernFiles();
  for (const theme of THEMES.filter((item) => item.imported && !files.some((file) => file.id === item.id))) {
    removeTheme(theme.id);
  }
  addThemes(files.map(termTheme));
});