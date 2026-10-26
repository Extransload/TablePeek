// Keyboard shortcuts: bindings look like "Mod+Shift+Alt+w". "Mod" is ⌘ on macOS
// and Ctrl elsewhere; ⌃ on macOS is left to text editing (⌃K, ⌃T, …). Letters
// and digits follow the keyboard layout, so AZERTY ⌘Z stays undo; keys that
// type something else (⌥ characters, the Korean IME) fall back to the
// physical key.

export type KeyAction =
  | "run"
  | "runAll"
  | "applyChanges"
  | "newTab"
  | "closeTab"
  | "nextTab"
  | "prevTab"
  | "refresh"
  | "toggleSidebar"
  | "toggleDetail"
  | "toggleConsole"
  | "palette"
  | "dbSwitch"
  | "openSettings"
  | "openFilter"
  | "duplicateRows";

export type Keymap = Record<KeyAction, string[]>;

export const KEY_ACTIONS: KeyAction[] = [
  "run",
  "runAll",
  "applyChanges",
  "newTab",
  "closeTab",
  "nextTab",
  "prevTab",
  "refresh",
  "toggleSidebar",
  "toggleDetail",
  "toggleConsole",
  "palette",
  "dbSwitch",
  "openSettings",
  "openFilter",
  "duplicateRows",
];

// Browsers reserve ⌘/Ctrl + W, T, N for themselves, so each of those actions
// also gets an Alt alternative that pages are allowed to handle.
export const DEFAULT_KEYMAP: Keymap = {
  // ⌘↵ runs the statement at the cursor (or the selection), ⇧⌘↵ all of them,
  // as in TablePlus.
  run: ["Mod+Enter"],
  runAll: ["Mod+Shift+Enter"],
  applyChanges: ["Mod+s"],
  newTab: ["Mod+t", "Alt+t"],
  closeTab: ["Mod+w", "Alt+w"],
  nextTab: ["Alt+]"],
  prevTab: ["Alt+["],
  // TablePlus refreshes with ⌘R, but in a browser that key reloads the page.
  refresh: ["F5"],
  toggleSidebar: ["Mod+b"],
  toggleDetail: ["Mod+i"],
  // TablePlus uses ⇧⌘C, but Chrome keeps that for its element picker.
  toggleConsole: ["Mod+j"],
  palette: ["Mod+p"],
  dbSwitch: ["Mod+k"],
  openSettings: ["Mod+,"],
  // Only in a Data tab and the focused grid; anywhere else the browser's find
  // and the SQL editor's ⌘D (select the next match) keep the key.
  openFilter: ["Mod+f"],
  duplicateRows: ["Mod+d"],
};

export const KEY_ACTION_LABELS: Record<KeyAction, string> = {
  run: "현재 쿼리 실행",
  runAll: "모든 쿼리 실행",
  applyChanges: "변경사항 적용",
  newTab: "새 쿼리 탭",
  closeTab: "현재 탭 닫기",
  nextTab: "다음 탭",
  prevTab: "이전 탭",
  refresh: "새로고침",
  toggleSidebar: "왼쪽 스키마 패널 열기/닫기",
  toggleDetail: "오른쪽 행 상세 패널 열기/닫기",
  toggleConsole: "아래 콘솔 패널 열기/닫기",
  palette: "명령 팔레트",
  dbSwitch: "DB 전환",
  openSettings: "설정 열기",
  openFilter: "데이터 필터 열기",
  duplicateRows: "선택한 행 복제",
};

const CODE_KEYS: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  Space: "Space",
};

const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt", "AltGraph", "CapsLock", "Fn"]);

export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

function eventKey(event: KeyboardEvent): string {
  if (/^[a-zA-Z0-9]$/.test(event.key)) {
    return event.key.toLowerCase();
  }
  const letter = /^Key([A-Z])$/.exec(event.code);
  if (letter !== null) {
    return letter[1].toLowerCase();
  }
  const digit = /^Digit(\d)$/.exec(event.code);
  if (digit !== null) {
    return digit[1];
  }
  const punctuation = CODE_KEYS[event.code];
  if (punctuation !== undefined) {
    return punctuation;
  }
  if (event.key === " ") {
    return "Space";
  }
  return event.key.length === 1 ? event.key.toLowerCase() : event.key;
}

interface ParsedBinding {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

function parseBinding(binding: string): ParsedBinding {
  // "Mod++" style bindings can't occur: "+" is recorded as "=" with Shift.
  const parts = binding.split("+");
  const key = parts.pop() ?? "";
  return {
    mod: parts.includes("Mod"),
    shift: parts.includes("Shift"),
    alt: parts.includes("Alt"),
    key: key.length === 1 ? key.toLowerCase() : key,
  };
}

// The platform's command modifier, and whether the other one (⌃ on macOS,
// the Windows/Super key elsewhere) is held, which no binding uses.
function modOf(event: KeyboardEvent): boolean {
  return IS_MAC ? event.metaKey : event.ctrlKey;
}

function foreignModOf(event: KeyboardEvent): boolean {
  return IS_MAC ? event.ctrlKey : event.metaKey;
}

function isFunctionKey(key: string): boolean {
  return /^F\d{1,2}$/.test(key);
}

export function matchesBinding(event: KeyboardEvent, binding: string): boolean {
  const want = parseBinding(binding);
  if (foreignModOf(event)) {
    return false;
  }
  if (want.mod !== modOf(event) || want.shift !== event.shiftKey || want.alt !== event.altKey) {
    return false;
  }
  return eventKey(event) === want.key;
}

export function actionForEvent(event: KeyboardEvent, keymap: Keymap): KeyAction | null {
  for (const action of KEY_ACTIONS) {
    if (keymap[action].some((binding) => matchesBinding(event, binding))) {
      return action;
    }
  }
  return null;
}

// The binding a key press would record, or null for a lone modifier. Plain keys
// need a modifier (except function keys) so typing is never swallowed.
export function bindingFromEvent(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key) || foreignModOf(event)) {
    return null;
  }
  // AltGr (Ctrl+Alt on Windows) types characters such as @ on many layouts.
  if (event.getModifierState("AltGraph") || (!IS_MAC && event.ctrlKey && event.altKey)) {
    return null;
  }
  const key = eventKey(event);
  const mod = modOf(event);
  // "+" would make the binding unparseable ("Mod++").
  if (key === "+" || (!mod && !event.altKey && !isFunctionKey(key))) {
    return null;
  }
  const parts: string[] = [];
  if (mod) {
    parts.push("Mod");
  }
  if (event.shiftKey) {
    parts.push("Shift");
  }
  if (event.altKey) {
    parts.push("Alt");
  }
  parts.push(key);
  return parts.join("+");
}

const KEY_NAMES_MAC: Record<string, string> = {
  Enter: "↩",
  Escape: "⎋",
  Backspace: "⌫",
  Delete: "⌦",
  Tab: "⇥",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Space: "Space",
};

export function formatBinding(binding: string): string {
  const parsed = parseBinding(binding);
  const key = parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key;
  if (IS_MAC) {
    return `${parsed.alt ? "⌥" : ""}${parsed.shift ? "⇧" : ""}${parsed.mod ? "⌘" : ""}${KEY_NAMES_MAC[key] ?? key}`;
  }
  return [parsed.mod ? "Ctrl" : null, parsed.shift ? "Shift" : null, parsed.alt ? "Alt" : null, key]
    .filter((part): part is string => part !== null)
    .join("+");
}

// Clipboard, undo and select-all: taking these over would break editing.
export function isEditingBinding(binding: string): boolean {
  const parsed = parseBinding(binding);
  return parsed.mod && !parsed.alt && ["a", "c", "v", "x", "y", "z"].includes(parsed.key);
}

// Whether the binding needs ⌘/Ctrl or is a function key, i.e. never types text.
export function isCommandBinding(binding: string): boolean {
  const parsed = parseBinding(binding);
  return parsed.mod || isFunctionKey(parsed.key);
}

// Combinations the browser handles before the page can (tab/window management).
export function isReservedBinding(binding: string): boolean {
  const parsed = parseBinding(binding);
  if (parsed.mod && !parsed.alt && ["w", "t", "n", "q"].includes(parsed.key)) {
    return true;
  }
  if (parsed.key === "Tab" && parsed.mod) {
    return true;
  }
  return IS_MAC && parsed.mod && parsed.alt && (parsed.key === "ArrowLeft" || parsed.key === "ArrowRight");
}

export function shortcutHint(keymap: Keymap, action: KeyAction): string {
  const usable = keymap[action].filter((binding) => !isReservedBinding(binding));
  const binding = usable[0] ?? keymap[action][0];
  return binding === undefined ? "" : formatBinding(binding);
}

// A tooltip: the label, then its shortcut in parentheses when it has one.
export function withHint(label: string, hint: string | undefined): string {
  return hint ? `${label} (${hint})` : label;
}

// Stored keymaps from older versions hold one string per action; untouched
// defaults are upgraded to the current default list.
const LEGACY_DEFAULTS: Partial<Record<KeyAction, string>> = {
  run: "Mod+Enter",
  newTab: "Mod+t",
  closeTab: "Mod+w",
  palette: "Mod+p",
  dbSwitch: "Mod+k",
};

// Bumped when a default changes in a way stored keymaps should pick up once.
// 2: ⌘R joined Refresh. 3: ⌘R went back to reloading the page.
export const KEYMAP_VERSION = 3;

// Whole default lists earlier versions stored: on the first load after an
// upgrade, a stored list still equal to one was never changed, so it follows
// today's default. Later choices (⌘R recorded again) stay as made.
const OLD_DEFAULT_LISTS: Partial<Record<KeyAction, string[][]>> = {
  refresh: [["F5", "Mod+r"]],
};

function isOldDefault(action: KeyAction, entries: string[]): boolean {
  return (OLD_DEFAULT_LISTS[action] ?? []).some(
    (list) => list.length === entries.length && list.every((binding, index) => binding === entries[index]),
  );
}

// Only bindings the recorder could produce today: a parseable key with ⌘/Ctrl
// or Alt, or a function key. Older versions also recorded plain keys.
function isValidBinding(binding: string): boolean {
  const parsed = parseBinding(binding);
  return (
    parsed.key !== "" &&
    (parsed.mod || parsed.alt || isFunctionKey(parsed.key)) &&
    !isEditingBinding(binding)
  );
}

// The bindings not yet in `taken`, each once, marked as taken.
function claim(bindings: string[], taken: Set<string>): string[] {
  const kept: string[] = [];
  for (const binding of bindings) {
    if (!taken.has(binding)) {
      taken.add(binding);
      kept.push(binding);
    }
  }
  return kept;
}

export function normalizeKeymap(raw: unknown, storedVersion = KEYMAP_VERSION): Keymap {
  const stored = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const custom = new Map<KeyAction, string[]>();
  for (const action of KEY_ACTIONS) {
    const value = stored[action];
    const entries = Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : typeof value === "string" && value !== LEGACY_DEFAULTS[action]
        ? [value]
        : null;
    if (entries === null || (storedVersion < KEYMAP_VERSION && isOldDefault(action, entries))) {
      continue;
    }
    const valid = entries.filter(isValidBinding);
    // An action the user cleared stays cleared; one left with only unusable
    // entries goes back to its defaults.
    if (valid.length > 0 || entries.length === 0) {
      custom.set(action, valid);
    }
  }
  // A combination belongs to one action. The user's own choices win over
  // defaults filled in for actions they never changed.
  const taken = new Set<string>();
  const out = {} as Keymap;
  for (const action of KEY_ACTIONS) {
    const entries = custom.get(action);
    if (entries !== undefined) {
      out[action] = claim(entries, taken);
    }
  }
  for (const action of KEY_ACTIONS) {
    if (!custom.has(action)) {
      out[action] = claim(DEFAULT_KEYMAP[action], taken);
    }
  }
  return out;
}
