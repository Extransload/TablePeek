import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { languageLabel, t, type Language } from "../i18n";
import { getThemesVersion, subscribeThemes, THEMES, type Theme } from "../palette";
import { slotUses, TABLE_SLOTS, themeTable, type TablePicks, type TableSlot } from "../termTheme";
import { importTernFile, loadTernThemes, removeTernFile } from "../ternThemes";
import { fontGroups, fontListLabel, pickedFace, type FontGroup, type InstalledFont } from "../fonts";
import { store, type VersionInfo } from "../store";
import { checkUpdateNow, configureUpdate, getInstall, getUpdate, loadUpdate, refreshUpdate, subscribeInstall, subscribeUpdate } from "../update";
import { MATERIAL_BLUR_MAX, subscribeMaterial, transparencyReduced, windowTranslucent, type Material } from "../material";
import { dragPanelEdge, keyPanelEdge, storedWidth, storeWidth } from "../panelEdge";
import {
  DEFAULT_SETTINGS,
  MAX_QUERY_TIMEOUT,
  MAX_ROWS_LIMIT,
  currentGridColors,
  currentSyntaxColors,
  getPasscodeHash,
  setPasscodeHash,
  sha256Hex,
  EDITOR_FONT_MAX,
  EDITOR_FONT_MIN,
  GRID_FONT_MAX,
  GRID_FONT_MIN,
  SIDEBAR_FONT_MAX,
  SIDEBAR_FONT_MIN,
  type AppSettings,
  type GridColorKey,
} from "../settings";
import {
  DEFAULT_KEYMAP,
  KEY_ACTIONS,
  KEY_ACTION_LABELS,
  bindingFromEvent,
  formatBinding,
  isEditingBinding,
  isReservedBinding,
  type KeyAction,
  type Keymap,
} from "../shortcuts";
import { SYNTAX_PRESETS, type SyntaxColorKey, type SyntaxPresetId } from "../syntax";
import {
  AlertIcon,
  CheckIcon,
  CloseIcon,
  CodeIcon,
  DownloadIcon,
  ExternalIcon,
  KeyboardIcon,
  LockIcon,
  PanelLeftIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
  TableIcon,
  TransferIcon,
} from "./icons";
import { notifyError } from "./ErrorNotice";
import { Spinner } from "./Spinner";
import { UpdateHowDialog, UpdateInstallAction } from "./UpdateBanner";
import { openSelect, Select } from "./Select";
import { SqlPreview } from "./SqlEditor";

// Settings as a sheet docked to the right edge, beside the app so a change
// shows in it at once, and run from the keyboard as Tern's is: ↑↓ move from
// setting to setting, ←→ switch pages, ⏎ or Space flips a switch, steps a
// choice or opens a menu (or goes into a field or a row of buttons, where ←→
// move between them), typing searches every page, ⌫ puts a changed setting
// back to its default, and Esc goes back one step (out of a field, then the
// search, then the sheet). Tab stays in the sheet: the search, the page tabs,
// the settings, the theme gallery, the close button and the sheet's edge are
// one stop each, with arrows inside. The edge drags (or ←→ on it) to resize.

interface SettingsSheetProps {
  settings: AppSettings;
  onChange(patch: Partial<AppSettings>): void;
  onLock(): void;
  onClose(): void;
}

type SettingsPage = "general" | "theme" | "editor" | "grid" | "sidebar" | "transfer" | "shortcuts" | "security";

interface PageItem {
  id: SettingsPage;
  label: string;
  icon: (props: { size?: number }) => ReactElement;
}

// The screen's areas each have their own page (its font and what it shows),
// as TablePlus splits its fonts into SQL Editor, Data Table and Sidebars.
const PAGES: PageItem[] = [
  { id: "general", label: "일반", icon: SettingsIcon },
  { id: "theme", label: "테마", icon: SunIcon },
  { id: "editor", label: "SQL 에디터", icon: CodeIcon },
  { id: "grid", label: "데이터 테이블", icon: TableIcon },
  { id: "sidebar", label: "사이드바", icon: PanelLeftIcon },
  { id: "transfer", label: "가져오기·내보내기", icon: TransferIcon },
  { id: "shortcuts", label: "단축키", icon: KeyboardIcon },
  { id: "security", label: "보안", icon: LockIcon },
];

const SHEET_WIDTH_KEY = "tablepeek.settings-width";
const SHEET_DEFAULT = 480;
const SHEET_MIN = 380;
const SHEET_MAX = 880;

// Wide enough for a row's name beside its control, and leaving the app room.
function clampSheet(width: number): number {
  const max = Math.max(SHEET_MIN, Math.min(SHEET_MAX, window.innerWidth - 240));
  return Math.round(Math.min(Math.max(width, SHEET_MIN), max));
}

// Fields whose keys (letters, arrows) are their own while they have focus.
const FIELD_TYPES: Record<string, true> = {
  text: true,
  number: true,
  password: true,
  search: true,
  email: true,
  url: true,
  tel: true,
  range: true,
};

function isField(element: Element): boolean {
  return (
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement && Object.hasOwn(FIELD_TYPES, element.type)) ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}

// A row's controls, in order, that can be used now.
function rowControls(row: HTMLElement): HTMLElement[] {
  return Array.from(
    row.querySelectorAll<HTMLElement>(".settings-row-control :is(input, select, textarea, button, a[href])"),
  ).filter((control) => !(control as HTMLInputElement).disabled);
}

// ⏎ or Space on a row: a lone switch flips, a menu opens, a field or a
// colour takes it; a row of several controls is gone into, at its first.
function activateRow(row: HTMLElement): void {
  const controls = rowControls(row);
  const control = controls[0];
  if (control === undefined) {
    return;
  }
  if (controls.length > 1) {
    control.focus();
  } else if (control instanceof HTMLSelectElement) {
    openSelect(control);
  } else if (control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "color")) {
    control.click();
  } else if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
    control.focus();
    if (control.type !== "range") {
      control.select();
    }
  } else {
    control.click();
  }
}

function focusRow(row: HTMLElement): void {
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: "nearest" });
}

// What the rows inside are matched against while searching: the words typed,
// and the page and group they are in.
interface Scope {
  terms: string[];
  page: string;
  group: string;
}

const ScopeContext = createContext<Scope>({ terms: [], page: "", group: "" });

// The installed families, asked of the server once a session.
let installedFonts: Promise<InstalledFont[]> | null = null;

function loadInstalledFonts(): Promise<InstalledFont[]> {
  installedFonts ??= store.listFonts().catch(() => {
    installedFonts = null;
    return [];
  });
  return installedFonts;
}

// A titled run of rows, with a note under its title.
function SettingsGroup({ title, hint, children }: { title?: string; hint?: string; children: ReactNode }) {
  const scope = useContext(ScopeContext);
  return (
    <ScopeContext.Provider value={{ ...scope, group: title ?? "" }}>
      <section className="settings-group">
        {title ? <h4>{title}</h4> : null}
        {hint ? <p className="settings-hint settings-group-hint">{hint}</p> : null}
        <div className="settings-box">{children}</div>
      </section>
    </ScopeContext.Provider>
  );
}

// One setting: its name (and a note under it) on the left, its control on
// the right, or under it when `wide`. Changed from its default, it shows a
// dot and Reset (⌫ on the row). Rows not matching the search aren't drawn.
function SettingRow({
  label,
  hint,
  keywords,
  changed = false,
  wide = false,
  onReset,
  onActivate,
  children,
}: {
  label: string;
  hint?: string | null;
  keywords?: string;
  changed?: boolean;
  wide?: boolean;
  onReset?(): void;
  // ⏎ or Space on the row, instead of its control's own (a choice steps).
  onActivate?(): void;
  children: ReactNode;
}) {
  const scope = useContext(ScopeContext);
  const id = useId();
  if (scope.terms.length > 0) {
    const text = [scope.page, scope.group, label, hint ?? "", keywords ?? ""].join(" ").toLowerCase();
    if (!scope.terms.every((term) => text.includes(term))) {
      return null;
    }
  }
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (onActivate) {
        onActivate();
      } else {
        activateRow(event.currentTarget);
      }
    } else if ((event.key === "Backspace" || event.key === "Delete") && changed && onReset) {
      event.preventDefault();
      onReset();
    }
  }
  return (
    <div
      className={`settings-row${wide ? " wide" : ""}`}
      data-row=""
      data-changed={changed ? "" : undefined}
      tabIndex={-1}
      role="group"
      aria-labelledby={`${id}-label`}
      aria-describedby={hint ? `${id}-hint` : undefined}
      onKeyDown={onKeyDown}
    >
      <div className="settings-row-text">
        <div className="settings-row-title">
          <span className="settings-row-label" id={`${id}-label`}>
            {label}
          </span>
          {changed ? (
            <>
              <span className="settings-row-dot" title={t("기본값에서 바뀜")} aria-label={t("기본값에서 바뀜")} />
              {onReset ? (
                <button type="button" className="settings-row-reset" tabIndex={-1} onClick={onReset}>
                  {t("재설정")}
                </button>
              ) : null}
            </>
          ) : null}
        </div>
        {hint ? (
          <p className="settings-hint" id={`${id}-hint`}>
            {hint}
          </p>
        ) : null}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

// A few choices side by side; ⏎ on the row steps to the next.
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange(value: T): void;
}) {
  return (
    <div className="segmented settings-choice" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={value === option.value ? "active" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function nextChoice<T extends string>(options: { value: T }[], value: T): T {
  const index = options.findIndex((option) => option.value === value);
  return options[(index + 1) % options.length].value;
}

function Switch({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <input
      type="checkbox"
      role="switch"
      className="settings-switch"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

// A slider and the value it is at.
function Slider({
  label,
  value,
  max,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  unit: string;
  onChange(value: number): void;
}) {
  return (
    <>
      <input
        type="range"
        className="settings-range"
        aria-label={label}
        min={0}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="settings-range-value mono">
        {value}
        {unit}
      </span>
    </>
  );
}

// One of the three fonts: its face (a saved list no longer offered shows
// under its first family's name) and its size, a row each.
function FontRows({
  label,
  hint,
  groups,
  value,
  size,
  sizes,
  defaultValue,
  defaultSize,
  onChange,
  onSize,
}: {
  label: string;
  hint: string;
  groups: FontGroup[];
  value: string;
  size: number;
  sizes: number[];
  defaultValue: string;
  defaultSize: number;
  onChange(value: string): void;
  onSize(size: number): void;
}) {
  const choices = groups.flatMap((group) => group.choices);
  const known = choices.some((choice) => choice.value === value);
  // A face picked before its family changed (its bold installed or removed,
  // say) is still that face: its saved list is brought up to date.
  const face = known ? null : pickedFace(value);
  const updated = face === null ? undefined : choices.find((choice) => pickedFace(choice.value) === face)?.value;
  useEffect(() => {
    if (updated !== undefined) {
      onChange(updated);
    }
    // onChange is a new function each render; the update is all that matters.
  }, [updated]);
  const options = (group: FontGroup) =>
    group.choices.map((choice) => (
      <option key={choice.value} value={choice.value}>
        {t(choice.label)}
      </option>
    ));
  return (
    <SettingsGroup title={t("글꼴")}>
      <SettingRow label={t("글꼴")} hint={hint} changed={value !== defaultValue} onReset={() => onChange(defaultValue)}>
        <Select
          className="settings-font-family"
          aria-label={t("{name} 글꼴", { name: label })}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          {groups.map((group) =>
            group.label === null ? (
              options(group)
            ) : (
              <optgroup key={group.label} label={t(group.label)}>
                {options(group)}
              </optgroup>
            ),
          )}
          {known || updated !== undefined ? null : <option value={value}>{fontListLabel(value)}</option>}
        </Select>
      </SettingRow>
      <SettingRow label={t("크기")} changed={size !== defaultSize} onReset={() => onSize(defaultSize)}>
        <Select
          aria-label={t("{name} 글자 크기", { name: label })}
          value={size}
          onChange={(event) => onSize(Number(event.target.value))}
        >
          {sizes.map((choice) => (
            <option key={choice} value={choice}>
              {choice}px
            </option>
          ))}
        </Select>
      </SettingRow>
    </SettingsGroup>
  );
}

// Whole px sizes to pick from (a list, so a size never lands half typed), plus
// the current one if older settings saved one off the steps.
function sizeChoices(min: number, max: number, current: number): number[] {
  const sizes = Array.from({ length: max - min + 1 }, (_, index) => min + index);
  return sizes.includes(current) ? sizes : [...sizes, current].sort((a, b) => a - b);
}

// The SQL editor's every coloured part, drawn as the editor draws it: the
// live app may have no editor open. Not shown among search results.
function EditorPreview() {
  const scope = useContext(ScopeContext);
  if (scope.terms.length > 0) {
    return null;
  }
  return (
    <section className="settings-group">
      <h4>{t("미리보기")}</h4>
      <div className="settings-preview" aria-hidden="true">
        <SqlPreview doc={EDITOR_SAMPLE} />
      </div>
    </section>
  );
}

// Every part the SQL editor colours, and letters that look alike in a font.
const EDITOR_SAMPLE = [
  "-- comment · 0O 1lI",
  "SELECT id, \"Name\", `code`, count(*) AS total, NULL, TRUE",
  "FROM users WHERE email LIKE '%@example.com' AND age >= 30;",
].join("\n");

// The colours Settings → SQL Editor offers, as TablePlus lists them; a row may
// set parts that read as one (NULL and booleans, operators and punctuation).
const SYNTAX_COLOR_ROWS: { label: string; keys: SyntaxColorKey[] }[] = [
  { label: "키워드", keys: ["keyword"] },
  { label: "함수", keys: ["function"] },
  { label: "타입", keys: ["type"] },
  { label: "숫자", keys: ["number"] },
  { label: "NULL·참거짓", keys: ["null", "bool"] },
  { label: "연산자·기호", keys: ["operator", "punctuation"] },
  { label: "작은따옴표 문자열", keys: ["string"] },
  { label: "큰따옴표 문자열", keys: ["stringDouble"] },
  { label: "백틱 문자열", keys: ["stringBacktick"] },
  { label: "주석", keys: ["comment"] },
  { label: "그 밖의 글자", keys: ["text"] },
];

// Data table colours by kind of value, in the order the grid shows them most.
const GRID_COLOR_ROWS: { label: string; keys: GridColorKey[] }[] = [
  { label: "문자열", keys: ["string"] },
  { label: "정수", keys: ["integer"] },
  { label: "실수", keys: ["float"] },
  { label: "큰 정수", keys: ["bigint"] },
  { label: "불리언", keys: ["boolean"] },
  { label: "날짜·시각", keys: ["date"] },
  { label: "시간(TIME)", keys: ["time"] },
  { label: "JSON", keys: ["json"] },
  { label: "배열", keys: ["list"] },
  { label: "열거형", keys: ["enum"] },
  { label: "UUID", keys: ["uuid"] },
  { label: "이진", keys: ["binary"] },
  { label: "NULL", keys: ["null"] },
];

// The colour picks for the theme in use, a row each, then one putting them
// all back.
function ColorRows<K extends string>({
  rows,
  colors,
  picked,
  hint,
  onPick,
}: {
  rows: { label: string; keys: K[] }[];
  colors: Record<K, string>;
  picked: Partial<Record<K, string>>;
  hint: string;
  onPick(keys: K[], color: string | null): void;
}) {
  return (
    <>
      {rows.map((row) => {
        const color = colors[row.keys[0]];
        return (
          <SettingRow
            key={row.label}
            label={t(row.label)}
            changed={row.keys.some((key) => picked[key] !== undefined)}
            onReset={() => onPick(row.keys, null)}
          >
            <span className="settings-color-value mono">{color}</span>
            <input
              type="color"
              aria-label={t(row.label)}
              value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#000000"}
              onChange={(event) => onPick(row.keys, event.target.value)}
            />
          </SettingRow>
        );
      })}
      <SettingRow label={t("색 재설정")} hint={hint}>
        <button
          type="button"
          disabled={Object.keys(picked).length === 0}
          onClick={() => onPick(rows.flatMap((row) => row.keys), null)}
        >
          {t("모두 기본값으로")}
        </button>
      </SettingRow>
    </>
  );
}

// The colour table's slots by the names terminals give them.
const SLOT_NAMES: Record<TableSlot, string> = {
  bg: "바탕",
  fg: "글자",
  ansi0: "검정",
  ansi1: "빨강",
  ansi2: "초록",
  ansi3: "노랑",
  ansi4: "파랑",
  ansi5: "자홍",
  ansi6: "청록",
  ansi7: "흰색",
  ansi8: "밝은 검정",
  ansi9: "밝은 빨강",
  ansi10: "밝은 초록",
  ansi11: "밝은 노랑",
  ansi12: "밝은 파랑",
  ansi13: "밝은 자홍",
  ansi14: "밝은 청록",
  ansi15: "밝은 흰색",
};

// The table in two lines: the background, the foreground and the 8 colours,
// then the 8 bright ones under the colours.
const TABLE_LINES: TableSlot[][] = [TABLE_SLOTS.slice(0, 10), TABLE_SLOTS.slice(10)];

// The theme's colour table as swatches, one setting: ⏎ goes in, ←→ (↑↓
// between the lines) move between swatches, ⏎ opens one's colour picker and
// ⌫ puts a picked one back to the theme's; ⌫ on the row puts them all back.
function ColorTableRow({
  theme,
  picks,
  hint,
  onPick,
}: {
  theme: Theme;
  picks: TablePicks;
  hint: string;
  onPick(slots: TableSlot[], color: string | null): void;
}) {
  const table = themeTable(theme);
  function onSwatchKey(event: ReactKeyboardEvent<HTMLInputElement>, slot: TableSlot, line: number, column: number): void {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.click();
    } else if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      if (picks[slot] !== undefined) {
        onPick([slot], null);
      }
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      // The bright line sits under the colours, two columns in.
      const target = TABLE_LINES[line === 0 ? 1 : 0][line === 0 ? column - 2 : column + 2];
      const swatch =
        (line === 0) === (event.key === "ArrowDown") && target !== undefined
          ? event.currentTarget.closest(".color-table")?.querySelector<HTMLInputElement>(`[data-slot="${target}"]`)
          : null;
      if (swatch) {
        event.preventDefault();
        event.stopPropagation();
        swatch.focus();
      }
    }
  }
  return (
    <SettingRow
      label={t("색 표")}
      hint={hint}
      keywords="color table palette ansi terminal tern 16 팔레트 터미널"
      wide
      changed={Object.keys(picks).length > 0}
      onReset={() => onPick(TABLE_SLOTS, null)}
    >
      <div className="color-table">
        {TABLE_LINES.map((slots, line) => (
          <div key={line} className={`color-table-line${line === 1 ? " bright" : ""}`}>
            {slots.map((slot, column) => {
              const color = picks[slot] ?? table[slot];
              const uses = slotUses(slot, theme.mode).map((use) => t(use));
              return (
                <label key={slot} className={`color-table-cell${picks[slot] !== undefined ? " picked" : ""}`}>
                  <input
                    type="color"
                    data-slot={slot}
                    aria-label={`${t(SLOT_NAMES[slot])} ${color}`}
                    title={`${t(SLOT_NAMES[slot])} ${color} — ${uses.join(", ")}`}
                    value={color}
                    onChange={(event) => onPick([slot], event.target.value)}
                    onKeyDown={(event) => onSwatchKey(event, slot, line, column)}
                  />
                  <span className="color-table-name">{slot.startsWith("ansi") ? slot.slice(4) : t(SLOT_NAMES[slot])}</span>
                </label>
              );
            })}
          </div>
        ))}
      </div>
    </SettingRow>
  );
}

// The themes as cards, TablePeek's dark then light, then Tern's (and those
// imported from Tern theme files): one Tab stop, the arrows move between
// cards (↑ on the top line and ↓ on the bottom one leave for the rows around
// it), and ⏎, Space or a click takes one.
function ThemeGallery({
  value,
  tern,
  galleryRef,
  onPick,
}: {
  value: string;
  // Whether Tern's themes are in yet.
  tern: "loading" | "ready" | "failed";
  galleryRef: RefObject<HTMLDivElement | null>;
  onPick(theme: Theme): void;
}) {
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
      return;
    }
    const cards = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(".theme-card"));
    const current = (event.target as HTMLElement).closest<HTMLElement>(".theme-card");
    const index = current === null ? -1 : cards.indexOf(current);
    if (index < 0) {
      return;
    }
    let next: HTMLElement | undefined;
    switch (event.key) {
      case "ArrowLeft":
        next = cards[index - 1];
        break;
      case "ArrowRight":
        next = cards[index + 1];
        break;
      case "Home":
        next = cards[0];
        break;
      case "End":
        next = cards[cards.length - 1];
        break;
      case "ArrowUp":
      case "ArrowDown": {
        // The nearest card on the line above or below, by where it sits.
        const from = cards[index].getBoundingClientRect();
        const down = event.key === "ArrowDown";
        let lineTop: number | null = null;
        let bestGap = Infinity;
        for (const card of cards) {
          const box = card.getBoundingClientRect();
          const beyond = down ? box.top > from.top + 2 : box.top < from.top - 2;
          if (!beyond) {
            continue;
          }
          if (lineTop === null || (down ? box.top < lineTop - 2 : box.top > lineTop + 2)) {
            lineTop = box.top;
            bestGap = Infinity;
          }
          if (Math.abs(box.top - lineTop) <= 2) {
            const gap = Math.abs(box.left + box.width / 2 - (from.left + from.width / 2));
            if (gap < bestGap) {
              bestGap = gap;
              next = card;
            }
          }
        }
        if (next === undefined) {
          // Past the first or last line: the sheet moves to the row around.
          return;
        }
        break;
      }
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (next !== undefined) {
      next.focus({ preventScroll: true });
      next.scrollIntoView({ block: "nearest" });
    }
  }
  const picked = THEMES.some((theme) => theme.id === value) ? value : THEMES[0]?.id;
  const byLabel = (a: Theme, b: Theme): number => a.label.localeCompare(b.label, "en");
  const groups: { key: string; caption: string; themes: Theme[]; note?: string }[] = [
    { key: "dark", caption: t("다크"), themes: THEMES.filter((theme) => !theme.group && theme.mode === "dark") },
    { key: "light", caption: t("라이트"), themes: THEMES.filter((theme) => !theme.group && theme.mode === "light") },
    ...(["dark", "light"] as const).map((mode) => ({
      key: `tern-${mode}`,
      caption: mode === "dark" ? t("Tern 다크") : t("Tern 라이트"),
      themes: THEMES.filter((theme) => theme.group === "tern" && !theme.imported && theme.mode === mode).sort(byLabel),
      note: tern === "loading" ? t("불러오는 중…") : tern === "failed" ? t("Tern 테마를 불러오지 못했습니다.") : undefined,
    })),
    { key: "tern-files", caption: t("Tern 파일에서 가져옴"), themes: THEMES.filter((theme) => theme.imported).sort(byLabel) },
  ];
  return (
    <div className="theme-gallery" ref={galleryRef} onKeyDown={onKeyDown}>
      {groups
        .filter((group) => group.themes.length > 0 || group.note !== undefined)
        .map((group) => (
          <div key={group.key} className="theme-gallery-group">
            <span className="theme-gallery-caption">{group.caption}</span>
            {group.themes.length === 0 ? <p className="settings-hint">{group.note}</p> : null}
            <div className="theme-grid">
              {group.themes.map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  data-theme-id={theme.id}
                  className={`theme-card${value === theme.id ? " active" : ""}`}
                  aria-pressed={value === theme.id}
                  tabIndex={theme.id === picked ? 0 : -1}
                  title={t(theme.label)}
                  onClick={() => onPick(theme)}
                >
                  <span
                    className="theme-preview"
                    style={{
                      background: theme.palette.bg,
                      borderColor: theme.palette.line,
                    }}
                  >
                    <span className="theme-preview-head" style={{ background: theme.palette.head }} />
                    <span className="theme-preview-body">
                      <span className="theme-preview-panel" style={{ background: theme.palette.panel }} />
                      <span className="theme-preview-lines">
                        <span style={{ background: theme.palette.ink }} />
                        <span style={{ background: theme.palette.muted }} />
                        <span style={{ background: theme.palette.accent }} />
                      </span>
                    </span>
                  </span>
                  <span className="theme-name">{t(theme.label)}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
    </div>
  );
}

// Why the last update check failed, by the server's code: the status's second line.
function updateErrorText(code: string): string {
  if (code === "network") {
    return t("네트워크에 연결할 수 없습니다");
  }
  if (code === "timeout") {
    return t("GitHub가 5초 안에 답하지 않았습니다");
  }
  if (code === "rate_limited") {
    return t("GitHub 요청 한도에 걸렸습니다");
  }
  if (code.startsWith("http_")) {
    return t("GitHub가 HTTP {status}로 답했습니다", { status: code.slice(5) });
  }
  return t("GitHub의 릴리스 정보를 읽지 못했습니다");
}

// General: what this build is, and the check for a newer release.
function VersionSettings() {
  const update = useSyncExternalStore(subscribeUpdate, getUpdate);
  const install = useSyncExternalStore(subscribeInstall, getInstall);
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [howOpen, setHowOpen] = useState(false);

  useEffect(() => {
    store.fetchVersion().then(setVersion, (error: unknown) => notifyError(error));
    loadUpdate().catch((error: unknown) => notifyError(error));
  }, []);

  async function checkNow(): Promise<void> {
    setChecking(true);
    try {
      await checkUpdateNow();
    } catch (error) {
      notifyError(error);
    } finally {
      setChecking(false);
    }
  }

  async function setEnabled(enabled: boolean): Promise<void> {
    try {
      await configureUpdate({ enabled });
      // Turned on: the server checks now if the last check is a day old.
      if (enabled) {
        setChecking(true);
        await refreshUpdate();
      }
    } catch (error) {
      notifyError(error);
    } finally {
      setChecking(false);
    }
  }

  const checkedAt = update !== null && update.checked_at !== null ? new Date(update.checked_at * 1000).toLocaleString() : null;
  const lastChecked = checkedAt === null ? null : t("마지막 확인: {time}", { time: checkedAt });
  // One status line in the tone of what it says: green when this is the
  // newest release, orange when a newer one is out, the accent for a build
  // ahead of the newest release, red when the check failed, muted otherwise.
  let tone: "ok" | "new" | "ahead" | "error" | "muted" = "muted";
  let icon: ReactNode = <RefreshIcon size={13} />;
  let title: string;
  let detail: string | null = lastChecked;
  if (update === null || (checking && update.enabled)) {
    icon = <Spinner size={11} />;
    title = t("확인하는 중…");
    detail = null;
  } else if (!update.enabled) {
    title = t("새 버전 확인이 꺼져 있습니다");
    detail = null;
  } else if (update.newer && update.latest !== null) {
    tone = "new";
    icon = <DownloadIcon size={13} />;
    title = update.latest === update.skipped ? t("{latest}이 나왔습니다 (건너뛴 버전)", { latest: update.latest }) : t("{latest}이 나왔습니다", { latest: update.latest });
    detail = update.published_at !== null ? t("지금 {current} · {date} 공개", { current: update.current, date: new Date(update.published_at).toLocaleDateString() }) : t("지금 {current}", { current: update.current });
  } else if (update.error !== null) {
    tone = "error";
    icon = <AlertIcon size={13} />;
    title = t("새 버전을 확인하지 못했습니다");
    detail = updateErrorText(update.error);
  } else if (update.checked_at === null) {
    title = t("아직 확인하지 않았습니다");
  } else if (update.latest === null) {
    title = t("아직 공개된 릴리스가 없습니다");
  } else if (update.latest !== update.current) {
    tone = "ahead";
    icon = <CodeIcon size={13} />;
    title = t("최신 릴리스보다 앞선 빌드입니다");
    detail = [t("최신 릴리스 {latest}", { latest: update.latest }), lastChecked].filter(Boolean).join(" · ");
  } else {
    tone = "ok";
    icon = <CheckIcon size={13} />;
    title = t("최신 버전입니다");
  }

  return (
    <SettingsGroup title={t("버전")}>
      <SettingRow label="TablePeek" keywords={`${t("버전")} 버전 업데이트 version update`} wide>
        <div className="version-head">
          {version === null ? (
            <Spinner size={10} />
          ) : (
            <>
              <span className="version-number mono" data-testid="settings-version">
                v{version.version}
              </span>
              <span className="version-chip mono" title={t("커밋")}>
                {version.commit}
              </span>
              <span className="version-chip">
                {version.dist === "release" ? t("릴리스 바이너리") : version.dist === "desktop" ? t("데스크톱 앱") : t("소스 빌드")}
              </span>
            </>
          )}
        </div>
        <div className={`version-status ${tone}`} role="status">
          <span className="version-status-icon">{icon}</span>
          <div className="version-status-text">
            <span className="version-status-title">{title}</span>
            {detail !== null ? <span className="version-status-detail">{detail}</span> : null}
          </div>
          <div className="version-status-actions">
            {update?.enabled && update.newer && update.latest !== null ? (
              <>
                {update.url !== null ? (
                  <a className="link-button" href={update.url} target="_blank" rel="noreferrer">
                    {t("변경 내역")}
                    <ExternalIcon size={10} />
                  </a>
                ) : null}
                {update.skipped !== null && update.skipped === update.latest ? (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => {
                      configureUpdate({ skipped: null }).catch((error: unknown) => notifyError(error));
                    }}
                  >
                    {t("다시 알리기")}
                  </button>
                ) : null}
                {update.installable ? (
                  <UpdateInstallAction install={install} className="version-update-button" />
                ) : (
                  <button type="button" className="version-update-button" onClick={() => setHowOpen(true)}>
                    {t("업데이트 방법")}
                  </button>
                )}
              </>
            ) : null}
            {update?.enabled ? (
              <button type="button" onClick={() => void checkNow()} disabled={checking}>
                <RefreshIcon size={11} />
                {t("지금 확인")}
              </button>
            ) : null}
          </div>
        </div>
      </SettingRow>
      <SettingRow
        label={t("새 버전 확인")}
        hint={update?.env_disabled ? t("TABLEPEEK_NO_UPDATE_CHECK 환경 변수가 확인을 껐습니다.") : undefined}
        changed={update !== null && !update.enabled && !update.env_disabled}
        onReset={() => void setEnabled(true)}
      >
        <Switch
          label={t("새 버전 확인")}
          checked={update?.enabled ?? true}
          disabled={update === null || update.env_disabled}
          onChange={(enabled) => void setEnabled(enabled)}
        />
      </SettingRow>
      {/* Over the app, not inside the sheet (which may be glass, and so
          holds what is fixed inside it). */}
      {howOpen && update !== null && update.latest !== null
        ? createPortal(<UpdateHowDialog update={update} latest={update.latest} onClose={() => setHowOpen(false)} />, document.body)
        : null}
    </SettingsGroup>
  );
}

const MATERIAL_OPTIONS: { value: Material; label: string }[] = [
  { value: "solid", label: "불투명" },
  { value: "glass", label: "유리" },
  { value: "clear", label: "투명" },
];

// The material's state, to word its note: whether this window can be
// see-through, and whether the system reduces transparency.
function materialState(): string {
  return `${windowTranslucent()}:${transparencyReduced()}`;
}

// Which part of the sheet has the keys, for the hints along its foot.
interface FocusHint {
  esc: string;
  changed: boolean;
}

export function SettingsSheet({ settings, onChange, onLock, onClose }: SettingsSheetProps) {
  // Where the keys were before the sheet took them: they go back on close.
  const [opener] = useState(() => document.activeElement);
  const sheetRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const edgeRef = useRef<HTMLDivElement>(null);
  const galleryRef = useRef<HTMLDivElement>(null);
  // The row the keys were last on: Tab comes back to it.
  const currentRow = useRef<HTMLElement | null>(null);
  // Where the keys go once a page is drawn: its first row when the sheet
  // opens or ←→ switch pages from a row, the page's tab from the tabs.
  const focusAfter = useRef<"row" | "tab" | null>("row");
  const [page, setPage] = useState<SettingsPage>("general");
  // Counts switches to a page (the same one again too, leaving a search).
  const [visit, setVisit] = useState(0);
  const [query, setQuery] = useState("");
  const [noMatch, setNoMatch] = useState(false);
  const [hint, setHint] = useState<FocusHint>({ esc: "", changed: false });
  const [width, setWidth] = useState<number | null>(() => storedWidth(SHEET_WIDTH_KEY, clampSheet));
  const material = useSyncExternalStore(subscribeMaterial, materialState);
  // The gallery redraws as themes come in (Tern's, an imported file).
  useSyncExternalStore(subscribeThemes, getThemesVersion);
  const [ternState, setTernState] = useState<"loading" | "ready" | "failed">("loading");
  const ternFileRef = useRef<HTMLInputElement>(null);
  // How the last Tern theme file import went, under its row.
  const [ternNote, setTernNote] = useState<{ error: boolean; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    loadTernThemes().then(
      () => live && setTernState("ready"),
      () => live && setTernState("failed"),
    );
    return () => {
      live = false;
    };
  }, []);

  const [capturing, setCapturing] = useState<KeyAction | null>(null);
  const [captureHint, setCaptureHint] = useState<string | null>(null);
  const [passcode, setPasscode] = useState("");
  const [passcodeConfirm, setPasscodeConfirm] = useState("");
  const [passcodeMessage, setPasscodeMessage] = useState<string | null>(null);
  const [hasPasscode, setHasPasscode] = useState(() => getPasscodeHash() !== null);
  // Empty until the server answers: the suggested fonts show meanwhile.
  const [fontFamilies, setFontFamilies] = useState<InstalledFont[]>([]);

  useEffect(() => {
    let live = true;
    void loadInstalledFonts().then((families) => {
      if (live) {
        setFontFamilies(families);
      }
    });
    return () => {
      live = false;
    };
  }, []);
  const editorFontGroups = useMemo(() => fontGroups("editor", fontFamilies), [fontFamilies]);
  const gridFontGroups = useMemo(() => fontGroups("grid", fontFamilies), [fontFamilies]);
  const sidebarFontGroups = useMemo(() => fontGroups("sidebar", fontFamilies), [fontFamilies]);

  useEffect(() => {
    const sheet = sheetRef.current;
    return () => {
      // Still up: StrictMode trying the effect again, not a close.
      if (sheet?.isConnected) {
        return;
      }
      // Something the close put up took the keys (the lock screen's field).
      const active = document.activeElement;
      if (active !== null && active !== document.body) {
        return;
      }
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [opener]);

  function rows(): HTMLElement[] {
    return Array.from(bodyRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? []);
  }

  function activeTab(): HTMLElement | null {
    return tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? null;
  }

  // Each page starts at its top, with the keys where the switch asked.
  useLayoutEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
    const after = focusAfter.current;
    focusAfter.current = null;
    if (after === "tab") {
      activeTab()?.focus();
    } else if (after === "row") {
      const first = rows()[0];
      if (first !== undefined) {
        focusRow(first);
      } else {
        searchRef.current?.focus();
      }
    }
  }, [visit]);

  function focusHint(element: Element | null): FocusHint {
    const row = element instanceof HTMLElement ? element.closest<HTMLElement>("[data-row]") : null;
    const inside = row !== null && element !== row;
    return {
      esc: inside ? t("필드에서 나가기") : query !== "" ? t("검색 지우기") : t("설정 닫기"),
      changed: row !== null && !inside && row.dataset.changed !== undefined,
    };
  }

  // After each change: whether the search found nothing, and the foot's
  // hints for where the keys are (a reset changes the row they are on). The
  // keys never drop out of the sheet when what had them goes (a search's
  // results, a row a choice hides): they go to the search.
  useLayoutEffect(() => {
    const none = query.trim() !== "" && rows().length === 0;
    if (none !== noMatch) {
      setNoMatch(none);
    }
    if (document.activeElement === document.body) {
      searchRef.current?.focus();
    }
    const next = focusHint(document.activeElement);
    if (next.esc !== hint.esc || next.changed !== hint.changed) {
      setHint(next);
    }
  });

  function onSheetFocus(event: ReactFocusEvent<HTMLDivElement>): void {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>("[data-row]");
    if (row !== null) {
      currentRow.current = row;
    }
    setHint(focusHint(target));
  }

  function switchPage(next: SettingsPage, focus: "row" | "tab" | null): void {
    setQuery("");
    focusAfter.current = focus;
    setPage(next);
    setVisit((count) => count + 1);
  }

  function stepPage(by: 1 | -1, focus: "row" | "tab"): void {
    const index = PAGES.findIndex((item) => item.id === page);
    switchPage(PAGES[(index + by + PAGES.length) % PAGES.length].id, focus);
  }

  // ↑↓ from a row (or the tabs, or nowhere yet): the next row, or up past
  // the first to the tabs (the search while searching) and on to the search.
  function stepRow(row: HTMLElement | null, by: 1 | -1, fromTabs: boolean): void {
    const list = rows();
    if (fromTabs) {
      if (by > 0 && list[0] !== undefined) {
        focusRow(list[0]);
      } else if (by < 0) {
        searchRef.current?.focus();
      }
      return;
    }
    const index = row === null ? -1 : list.indexOf(row);
    const next = index < 0 ? (by > 0 ? list[0] : list[list.length - 1]) : list[index + by];
    if (next !== undefined) {
      focusRow(next);
    } else if (by < 0) {
      (query !== "" ? searchRef.current : activeTab())?.focus();
    }
  }

  // ←→ inside a row of several controls.
  function stepControl(row: HTMLElement, target: HTMLElement, by: 1 | -1): void {
    const controls = rowControls(row);
    const index = controls.findIndex((control) => control === target || control.contains(target));
    controls[index + by]?.focus();
  }

  // The sheet's Tab stops, in order: each a box the keys can be inside and
  // where Tab puts them.
  function tabStops(): { box: HTMLElement; focus(): void }[] {
    const stops: { box: HTMLElement; focus(): void }[] = [];
    const search = searchRef.current;
    const tabs = tabsRef.current;
    const body = bodyRef.current;
    const gallery = galleryRef.current;
    if (search !== null) {
      stops.push({ box: search, focus: () => search.focus() });
    }
    if (tabs !== null) {
      stops.push({ box: tabs, focus: () => (activeTab() ?? tabs.querySelector<HTMLElement>('[role="tab"]'))?.focus() });
    }
    const list = rows();
    if (body !== null && list.length > 0) {
      stops.push({
        box: body,
        focus: () => {
          const row = currentRow.current;
          focusRow(row !== null && row.isConnected && body.contains(row) ? row : list[0]);
        },
      });
    }
    if (gallery !== null && gallery.isConnected) {
      stops.push({
        box: gallery,
        focus: () => {
          const card = gallery.querySelector<HTMLElement>('.theme-card[tabindex="0"]');
          card?.focus({ preventScroll: true });
          card?.scrollIntoView({ block: "nearest" });
        },
      });
    }
    for (const element of [closeRef.current, edgeRef.current]) {
      if (element !== null) {
        stops.push({ box: element, focus: () => element.focus() });
      }
    }
    return stops;
  }

  function cycleStops(target: HTMLElement, by: 1 | -1): void {
    const stops = tabStops();
    // The innermost stop holding the keys: the gallery sits among the rows.
    let index = -1;
    stops.forEach((stop, at) => {
      if (stop.box.contains(target)) {
        index = at;
      }
    });
    const next = index < 0 ? (by > 0 ? 0 : stops.length - 1) : (index + by + stops.length) % stops.length;
    stops[next]?.focus();
  }

  // A closed menu field keeps ↑↓ for moving between rows, not for opening.
  function onSheetKeyDownCapture(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const target = event.target;
    if (
      target instanceof HTMLSelectElement &&
      target.getAttribute("aria-expanded") !== "true" &&
      (event.key === "ArrowDown" || event.key === "ArrowUp") &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      stepRow(target.closest<HTMLElement>("[data-row]"), event.key === "ArrowDown" ? 1 : -1, false);
    }
  }

  function onSheetKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const sheet = sheetRef.current;
    const target = event.target as HTMLElement;
    // A dialog opened from the sheet sits outside it, over the app.
    if (sheet === null || !sheet.contains(target) || event.defaultPrevented || event.nativeEvent.isComposing) {
      return;
    }
    const row = target.closest<HTMLElement>("[data-row]");
    const onRow = row !== null && target === row;
    if (event.key === "Tab") {
      event.preventDefault();
      cycleStops(target, event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (row !== null && !onRow) {
        focusRow(row);
      } else if (query !== "") {
        setQuery("");
      } else {
        onClose();
      }
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (target === searchRef.current) {
      if (event.key === "ArrowDown" || event.key === "Enter") {
        event.preventDefault();
        const first = rows()[0];
        if (first !== undefined) {
          focusRow(first);
        } else if (query === "") {
          activeTab()?.focus();
        }
      }
      return;
    }
    if (isField(target)) {
      // ⏎ is done with the field (its value is already in).
      if (event.key === "Enter" && row !== null && !(target instanceof HTMLTextAreaElement)) {
        event.preventDefault();
        focusRow(row);
      }
      return;
    }
    const fromTabs = target.closest('[role="tablist"]') !== null;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        stepRow(row, event.key === "ArrowDown" ? 1 : -1, fromTabs);
        return;
      case "ArrowLeft":
      case "ArrowRight": {
        event.preventDefault();
        const by = event.key === "ArrowLeft" ? -1 : 1;
        if (row !== null && !onRow) {
          stepControl(row, target, by);
        } else {
          stepPage(by, fromTabs ? "tab" : "row");
        }
        return;
      }
      case "Home":
      case "End": {
        if (fromTabs) {
          event.preventDefault();
          switchPage(event.key === "Home" ? PAGES[0].id : PAGES[PAGES.length - 1].id, "tab");
          return;
        }
        const list = rows();
        const edge = event.key === "Home" ? list[0] : list[list.length - 1];
        if (edge !== undefined) {
          event.preventDefault();
          focusRow(edge);
        }
        return;
      }
    }
    // Typing searches: the keys move to the search field before the key
    // lands, so the browser types it there itself, and an input method
    // (Korean, Japanese) composes there from the first key ("Process" while
    // it holds the key). A closed menu keeps the letters: they pick an option.
    const typed = (event.key.length === 1 && event.key !== " ") || event.key === "Process" || event.keyCode === 229;
    const search = searchRef.current;
    if (typed && search !== null && !(target instanceof HTMLSelectElement)) {
      search.setSelectionRange(search.value.length, search.value.length);
      search.focus();
    }
  }

  function saveWidth(next: number | null): void {
    setWidth(next);
    storeWidth(SHEET_WIDTH_KEY, next);
  }

  useEffect(() => {
    if (capturing === null) {
      return;
    }
    const action: KeyAction = capturing;
    function onCapture(event: KeyboardEvent): void {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapturing(null);
        setCaptureHint(null);
        return;
      }
      const binding = bindingFromEvent(event);
      if (binding === null) {
        if (!["Meta", "Control", "Shift", "Alt"].includes(event.key)) {
          setCaptureHint(t("⌘/Ctrl 또는 ⌥/Alt와 함께 누르세요"));
        }
        return;
      }
      if (isEditingBinding(binding)) {
        setCaptureHint(t("복사·붙여넣기·실행 취소 같은 편집 키는 쓸 수 없습니다"));
        return;
      }
      if (!settings.keymap[action].includes(binding)) {
        setBindings(action, [...settings.keymap[action], binding]);
      }
      setCapturing(null);
      setCaptureHint(null);
    }
    // Clicking anywhere else stops waiting for a key; the add button toggles itself.
    function onPointerDown(event: PointerEvent): void {
      if (!(event.target instanceof Element && event.target.closest(".shortcut-add"))) {
        setCapturing(null);
        setCaptureHint(null);
      }
    }
    window.addEventListener("keydown", onCapture, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onCapture, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [capturing, settings.keymap, onChange]);

  // A combination belongs to one action: giving it to `action` takes it away
  // from any other.
  function setBindings(action: KeyAction, bindings: string[]): void {
    const next = {} as Keymap;
    for (const key of KEY_ACTIONS) {
      next[key] = key === action ? bindings : settings.keymap[key].filter((entry) => !bindings.includes(entry));
    }
    onChange({ keymap: next });
  }

  // A colour picked for parts of the current theme's syntax, data table or
  // colour table, or none to go back to the theme's own.
  function pickThemeColor(field: "syntaxColors" | "gridColors" | "tableColors", keys: string[], color: string | null): void {
    const picks: Record<string, string | undefined> = { ...settings[field][settings.theme] };
    for (const key of keys) {
      if (color === null) {
        delete picks[key];
      } else {
        picks[key] = color;
      }
    }
    const next: Record<string, Record<string, string | undefined>> = { ...settings[field] };
    if (Object.keys(picks).length === 0) {
      delete next[settings.theme];
    } else {
      next[settings.theme] = picks;
    }
    onChange({ [field]: next });
  }

  async function importTernTheme(file: File): Promise<void> {
    try {
      const imported = await importTernFile(file);
      onChange({ theme: imported.id, accent: imported.accent });
      setTernNote({ error: false, text: t("“{name}”을(를) 가져와 테마로 정했습니다.", { name: imported.label }) });
    } catch (error) {
      setTernNote({ error: true, text: error instanceof Error ? error.message : String(error) });
    }
  }

  // An imported theme removed, with the colours picked for it; the default
  // theme takes its place.
  function removeImported(theme: Theme): void {
    removeTernFile(theme.id);
    const drop = <T,>(picks: Record<string, T>): Record<string, T> =>
      Object.fromEntries(Object.entries(picks).filter(([id]) => id !== theme.id));
    onChange({
      theme: DEFAULT_SETTINGS.theme,
      accent: DEFAULT_SETTINGS.accent,
      syntaxColors: drop(settings.syntaxColors),
      gridColors: drop(settings.gridColors),
      tableColors: drop(settings.tableColors),
    });
    setTernNote(null);
  }

  async function applyPasscode(): Promise<void> {
    if (passcode.trim().length < 4) {
      setPasscodeMessage(t("4자 이상 입력하세요"));
      return;
    }
    if (passcode !== passcodeConfirm) {
      setPasscodeMessage(t("입력한 값이 서로 다릅니다"));
      return;
    }
    setPasscodeHash(await sha256Hex(passcode));
    setHasPasscode(true);
    setPasscode("");
    setPasscodeConfirm("");
    setPasscodeMessage(t("잠금 암호를 설정했습니다"));
  }

  async function removePasscode(): Promise<void> {
    const hash = getPasscodeHash();
    if (hash === null) {
      setHasPasscode(false);
      return;
    }
    if ((await sha256Hex(passcode)) !== hash) {
      setPasscodeMessage(t("현재 암호가 올바르지 않습니다"));
      return;
    }
    setPasscodeHash(null);
    setHasPasscode(false);
    setPasscode("");
    setPasscodeConfirm("");
    setPasscodeMessage(t("잠금 암호를 해제했습니다"));
  }

  // A setting's row props for "changed from its default" and Reset.
  function fromDefault<K extends keyof AppSettings>(key: K): { changed: boolean; onReset(): void } {
    return {
      changed: settings[key] !== DEFAULT_SETTINGS[key],
      onReset: () => onChange({ [key]: DEFAULT_SETTINGS[key] }),
    };
  }

  function renderPage(id: SettingsPage): ReactNode {
    const theme = THEMES.find((item) => item.id === settings.theme);
    // The theme whose colours the SQL Editor and Data Table pages pick.
    const themeLabel = theme?.label ?? settings.theme;
    switch (id) {
      case "general": {
        const languages: { value: Language; label: string }[] = (["ko", "en"] as Language[]).map((language) => ({
          value: language,
          label: languageLabel(language),
        }));
        return (
          <>
            <SettingsGroup>
              <SettingRow
                label={t("언어")}
                keywords="language"
                {...fromDefault("language")}
                onActivate={() => onChange({ language: nextChoice(languages, settings.language) })}
              >
                <Choice
                  label={t("언어")}
                  value={settings.language}
                  options={languages}
                  onChange={(language) => onChange({ language })}
                />
              </SettingRow>
            </SettingsGroup>
            <VersionSettings />
          </>
        );
      }

      case "theme": {
        const [translucent, reduced] = material.split(":");
        const options = MATERIAL_OPTIONS.map((option) => ({ ...option, label: t(option.label) }));
        const darkTheme = THEMES.find((item) => item.id === DEFAULT_SETTINGS.theme);
        // The accent is the theme's own (taken with it), or the default's
        // under the default theme.
        const accent = settings.accent.toLowerCase();
        const accentChanged =
          theme !== undefined &&
          accent !== theme.accent.toLowerCase() &&
          !(theme.id === DEFAULT_SETTINGS.theme && accent === DEFAULT_SETTINGS.accent.toLowerCase());
        return (
          <>
            <SettingsGroup>
              <SettingRow
                label={t("재질")}
                keywords="material solid glass clear 투명도"
                hint={
                  reduced === "true"
                    ? t("시스템의 ‘투명도 줄이기’가 켜져 있어 불투명하게 그립니다.")
                    : translucent === "true"
                      ? t("유리는 시스템의 반투명 재질을, 투명은 색을 입히지 않고 흐리게 한 바탕화면을 창 뒤에 둡니다. 대화상자, 팔레트, 메뉴도 유리가 됩니다.")
                      : t("브라우저 탭 뒤에는 바탕화면이 없어 대화상자, 팔레트, 메뉴 같은 떠 있는 면만 유리가 됩니다. 창이 비쳐 보이는 것은 데스크톱 앱에서만입니다.")
                }
                {...fromDefault("material")}
                onActivate={() => onChange({ material: nextChoice(options, settings.material) })}
              >
                <Choice
                  label={t("재질")}
                  value={settings.material}
                  options={options}
                  onChange={(next) => onChange({ material: next })}
                />
              </SettingRow>
              {settings.material !== "solid" ? (
                <SettingRow
                  label={t("불투명도")}
                  keywords="opacity"
                  hint={
                    translucent === "true"
                      ? t("창 바탕이 얼마나 비치지 않는지입니다. 떠 있는 면은 글자가 읽히도록 조금 더 불투명합니다.")
                      : t("떠 있는 면의 바탕이 얼마나 비치지 않는지입니다. 글자가 읽히도록 아주 투명해지지는 않습니다.")
                  }
                  {...fromDefault("materialOpacity")}
                >
                  <Slider
                    label={t("불투명도")}
                    value={settings.materialOpacity}
                    max={100}
                    unit="%"
                    onChange={(materialOpacity) => onChange({ materialOpacity })}
                  />
                </SettingRow>
              ) : null}
              {settings.material === "clear" ? (
                <SettingRow
                  label={t("흐림")}
                  keywords="blur radius"
                  hint={t("투명 재질의 뒤를 흐리게 하는 반경입니다.")}
                  {...fromDefault("materialBlur")}
                >
                  <Slider
                    label={t("흐림")}
                    value={settings.materialBlur}
                    max={MATERIAL_BLUR_MAX}
                    unit="px"
                    onChange={(materialBlur) => onChange({ materialBlur })}
                  />
                </SettingRow>
              ) : null}
            </SettingsGroup>
            <SettingsGroup title={t("색")}>
              <SettingRow
                label={t("강조 색")}
                keywords="accent"
                hint={t("SQL 에디터와 데이터 테이블의 색은 각 화면 설정에서 고릅니다.")}
                changed={accentChanged}
                onReset={() => theme && onChange({ accent: theme.accent })}
              >
                <span className="settings-color-value mono">{settings.accent}</span>
                <input
                  type="color"
                  aria-label={t("강조 색")}
                  value={settings.accent}
                  onChange={(event) => onChange({ accent: event.target.value })}
                />
              </SettingRow>
              {theme !== undefined ? (
                <ColorTableRow
                  theme={theme}
                  picks={settings.tableColors[theme.id] ?? {}}
                  hint={t(
                    "터미널의 바탕·글자와 16색입니다. 구문 강조와 값 색이 이 색에서 나오며, 고른 색은 지금 테마({theme})에만 저장됩니다. ⏎로 고르고 ⌫로 테마의 색으로 되돌립니다.",
                    { theme: t(themeLabel) },
                  )}
                  onPick={(slots, color) => pickThemeColor("tableColors", slots, color)}
                />
              ) : null}
              <SettingRow
                label={t("테마")}
                keywords={`tern ${THEMES.map((item) => t(item.label)).join(" ")}`}
                wide
                changed={settings.theme !== DEFAULT_SETTINGS.theme}
                onReset={() => darkTheme && onChange({ theme: darkTheme.id, accent: darkTheme.accent })}
                onActivate={() => tabStops().find((stop) => stop.box === galleryRef.current)?.focus()}
              >
                <ThemeGallery
                  value={settings.theme}
                  tern={ternState}
                  galleryRef={galleryRef}
                  onPick={(picked) => onChange({ theme: picked.id, accent: picked.accent })}
                />
              </SettingRow>
            </SettingsGroup>
            <SettingsGroup title="Tern">
              <SettingRow
                label={t("Tern 테마 파일 가져오기")}
                keywords="import css gyu"
                hint={
                  ternNote?.text ??
                  t("Tern의 테마 CSS(~/Library/Application Support/Tern/themes)를 고르면, @import한 기본 테마에 그 파일의 바탕·글자·16색과 면 색을 덮어 파일 이름의 테마로 더합니다. 다른 규칙은 건너뜁니다.")
                }
              >
                <button type="button" onClick={() => ternFileRef.current?.click()}>
                  {t("파일 선택…")}
                </button>
              </SettingRow>
              {theme?.imported ? (
                <SettingRow label={t("가져온 테마 지우기")} hint={t("“{name}”과(와) 이 테마에 고른 색을 지웁니다.", { name: theme.label })}>
                  <button type="button" onClick={() => removeImported(theme)}>
                    {t("지우기")}
                  </button>
                </SettingRow>
              ) : null}
            </SettingsGroup>
            {/* Outside the rows: a row's controls are the ones it shows. */}
            <input
              ref={ternFileRef}
              type="file"
              accept=".css,text/css"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file !== undefined) {
                  void importTernTheme(file);
                }
              }}
            />
          </>
        );
      }

      case "editor":
        return (
          <>
            <FontRows
              label={t("SQL 에디터")}
              hint={t("에디터와 콘솔에 쓰입니다.")}
              groups={editorFontGroups}
              value={settings.fontFamily}
              size={settings.fontSize}
              sizes={sizeChoices(EDITOR_FONT_MIN, EDITOR_FONT_MAX, settings.fontSize)}
              defaultValue={DEFAULT_SETTINGS.fontFamily}
              defaultSize={DEFAULT_SETTINGS.fontSize}
              onChange={(fontFamily) => onChange({ fontFamily })}
              onSize={(fontSize) => onChange({ fontSize })}
            />
            <SettingsGroup title={t("편집")}>
              <SettingRow label={t("정리·축약할 때 키워드를 대문자로")} {...fromDefault("uppercaseKeywords")}>
                <Switch
                  label={t("정리·축약할 때 키워드를 대문자로")}
                  checked={settings.uppercaseKeywords}
                  onChange={(uppercaseKeywords) => onChange({ uppercaseKeywords })}
                />
              </SettingRow>
            </SettingsGroup>
            {/* The colours picked here belong to the theme in use. */}
            <SettingsGroup title={t("색")}>
              <SettingRow
                label={t("구문 강조")}
                hint={t(SYNTAX_PRESETS.find((preset) => preset.id === settings.syntaxPreset)?.description ?? "")}
                {...fromDefault("syntaxPreset")}
              >
                <Select
                  aria-label={t("구문 강조")}
                  value={settings.syntaxPreset}
                  onChange={(event) => onChange({ syntaxPreset: event.target.value as SyntaxPresetId })}
                >
                  {SYNTAX_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {t(preset.label)}
                    </option>
                  ))}
                </Select>
              </SettingRow>
              <ColorRows
                rows={SYNTAX_COLOR_ROWS}
                colors={currentSyntaxColors(settings)}
                picked={settings.syntaxColors[settings.theme] ?? {}}
                hint={t("지금 테마({theme})에만 저장되며, 구문 강조 위에 덮입니다.", { theme: t(themeLabel) })}
                onPick={(keys, color) => pickThemeColor("syntaxColors", keys, color)}
              />
            </SettingsGroup>
            <EditorPreview />
          </>
        );

      case "grid":
        return (
          <>
            <FontRows
              label={t("데이터 테이블")}
              hint={t("모든 표와 셀 편집에 쓰입니다.")}
              groups={gridFontGroups}
              value={settings.gridFontFamily}
              size={settings.gridFontSize}
              sizes={sizeChoices(GRID_FONT_MIN, GRID_FONT_MAX, settings.gridFontSize)}
              defaultValue={DEFAULT_SETTINGS.gridFontFamily}
              defaultSize={DEFAULT_SETTINGS.gridFontSize}
              onChange={(gridFontFamily) => onChange({ gridFontFamily })}
              onSize={(gridFontSize) => onChange({ gridFontSize })}
            />
            <SettingsGroup title={t("표시")}>
              <SettingRow label={t("최대 행")} hint={t("쿼리 한 번에 가져오는 최대 행 수입니다.")} {...fromDefault("maxRows")}>
                <input
                  type="number"
                  min={1}
                  max={MAX_ROWS_LIMIT}
                  value={settings.maxRows}
                  aria-label={t("최대 행")}
                  onChange={(event) =>
                    onChange({
                      maxRows: Math.min(MAX_ROWS_LIMIT, Math.max(1, Math.trunc(Number(event.target.value)) || 1)),
                    })
                  }
                />
              </SettingRow>
              <SettingRow
                label={t("쿼리 시간 제한(초)")}
                hint={t("MongoDB 쿼리, mongosh 스크립트, ClickHouse 문장에 쓰입니다. 0이면 제한이 없습니다.")}
                {...fromDefault("queryTimeout")}
              >
                <input
                  type="number"
                  min={0}
                  max={MAX_QUERY_TIMEOUT}
                  value={settings.queryTimeout}
                  aria-label={t("쿼리 시간 제한(초)")}
                  onChange={(event) =>
                    onChange({
                      queryTimeout: Math.min(MAX_QUERY_TIMEOUT, Math.max(0, Math.trunc(Number(event.target.value)) || 0)),
                    })
                  }
                />
              </SettingRow>
              <SettingRow label={t("줄무늬 행 배경")} {...fromDefault("rowAlt")}>
                <Switch label={t("줄무늬 행 배경")} checked={settings.rowAlt} onChange={(rowAlt) => onChange({ rowAlt })} />
              </SettingRow>
              <SettingRow
                label={t("가로 스크롤바 항상 표시")}
                hint={t("SQL 에디터에도 적용됩니다.")}
                keywords="scrollbar"
                {...fromDefault("scrollbarX")}
              >
                <Switch
                  label={t("가로 스크롤바 항상 표시")}
                  checked={settings.scrollbarX}
                  onChange={(scrollbarX) => onChange({ scrollbarX })}
                />
              </SettingRow>
              <SettingRow
                label={t("세로 스크롤바 항상 표시")}
                hint={t("SQL 에디터에도 적용됩니다.")}
                keywords="scrollbar"
                {...fromDefault("scrollbarY")}
              >
                <Switch
                  label={t("세로 스크롤바 항상 표시")}
                  checked={settings.scrollbarY}
                  onChange={(scrollbarY) => onChange({ scrollbarY })}
                />
              </SettingRow>
            </SettingsGroup>
            {/* The colours picked here belong to the theme in use. */}
            <SettingsGroup title={t("색")}>
              <SettingRow label={t("타입별 색상")} {...fromDefault("typeColors")}>
                <Switch
                  label={t("타입별 색상")}
                  checked={settings.typeColors}
                  onChange={(typeColors) => onChange({ typeColors })}
                />
              </SettingRow>
              <ColorRows
                rows={GRID_COLOR_ROWS}
                colors={currentGridColors(settings)}
                picked={settings.gridColors[settings.theme] ?? {}}
                hint={
                  settings.typeColors
                    ? t("지금 테마({theme})에만 저장되며, 표와 MongoDB 문서의 값 색에 쓰입니다.", { theme: t(themeLabel) })
                    : t("‘타입별 색상’이 꺼져 있어 NULL 말고는 지금 쓰이지 않습니다.")
                }
                onPick={(keys, color) => pickThemeColor("gridColors", keys, color)}
              />
            </SettingsGroup>
          </>
        );

      case "sidebar":
        return (
          <FontRows
            label={t("사이드바")}
            hint={t("왼쪽 사이드바와 오른쪽 상세 패널에 쓰입니다.")}
            groups={sidebarFontGroups}
            value={settings.sidebarFontFamily}
            size={settings.sidebarFontSize}
            sizes={sizeChoices(SIDEBAR_FONT_MIN, SIDEBAR_FONT_MAX, settings.sidebarFontSize)}
            defaultValue={DEFAULT_SETTINGS.sidebarFontFamily}
            defaultSize={DEFAULT_SETTINGS.sidebarFontSize}
            onChange={(sidebarFontFamily) => onChange({ sidebarFontFamily })}
            onSize={(sidebarFontSize) => onChange({ sidebarFontSize })}
          />
        );

      case "transfer":
        return (
          <SettingsGroup title="CSV">
            <SettingRow label={t("CSV 구분자")} {...fromDefault("csvDelimiter")}>
              <Select
                aria-label={t("CSV 구분자")}
                value={settings.csvDelimiter}
                onChange={(event) => onChange({ csvDelimiter: event.target.value })}
              >
                <option value=",">{t(", (쉼표)")}</option>
                <option value={"\t"}>Tab</option>
                <option value=";">{t("; (세미콜론)")}</option>
                <option value="|">{t("| (파이프)")}</option>
              </Select>
            </SettingRow>
            <SettingRow label={t("첫 행을 헤더로 사용")} {...fromDefault("csvHeader")}>
              <Switch label={t("첫 행을 헤더로 사용")} checked={settings.csvHeader} onChange={(csvHeader) => onChange({ csvHeader })} />
            </SettingRow>
            <SettingRow label={t("인코딩")} keywords="encoding" {...fromDefault("csvEncoding")}>
              <Select
                aria-label={t("인코딩")}
                value={settings.csvEncoding}
                onChange={(event) => onChange({ csvEncoding: event.target.value as AppSettings["csvEncoding"] })}
              >
                <option value="utf-8">UTF-8</option>
                <option value="euc-kr">EUC-KR</option>
                <option value="utf-16le">UTF-16LE</option>
              </Select>
            </SettingRow>
          </SettingsGroup>
        );

      case "shortcuts": {
        const anyChanged = KEY_ACTIONS.some((action) => settings.keymap[action].join("\n") !== DEFAULT_KEYMAP[action].join("\n"));
        return (
          <SettingsGroup
            hint={t("TablePeek 단축키가 브라우저 단축키보다 먼저 실행됩니다. {keys}는 브라우저가 먼저 처리합니다.", {
              keys: ["Mod+w", "Mod+t", "Mod+n"].map(formatBinding).join(" · "),
            })}
          >
            {KEY_ACTIONS.map((action) => {
              const changed = settings.keymap[action].join("\n") !== DEFAULT_KEYMAP[action].join("\n");
              const startCapture = () => {
                setCaptureHint(null);
                setCapturing(capturing === action ? null : action);
              };
              return (
                <SettingRow
                  key={action}
                  label={t(KEY_ACTION_LABELS[action])}
                  keywords={settings.keymap[action].map(formatBinding).join(" ")}
                  changed={changed}
                  onReset={() => setBindings(action, [...DEFAULT_KEYMAP[action]])}
                  onActivate={startCapture}
                >
                  <div className="shortcut-bindings">
                    {settings.keymap[action].map((binding) => {
                      const reserved = isReservedBinding(binding);
                      return (
                        <span
                          key={binding}
                          className={`shortcut-chip${reserved ? " reserved" : ""}`}
                          title={
                            reserved
                              ? t("브라우저가 예약한 조합이라 브라우저 탭에서는 브라우저 동작이 먼저 실행됩니다")
                              : undefined
                          }
                        >
                          <kbd>{formatBinding(binding)}</kbd>
                          {reserved ? (
                            <span className="shortcut-warn" aria-hidden="true">
                              !
                            </span>
                          ) : null}
                          <button
                            type="button"
                            className="shortcut-remove"
                            onClick={() =>
                              setBindings(
                                action,
                                settings.keymap[action].filter((entry) => entry !== binding),
                              )
                            }
                            title={t("이 단축키 지우기")}
                            aria-label={t("이 단축키 지우기")}
                          >
                            ×
                          </button>
                        </span>
                      );
                    })}
                    <button
                      type="button"
                      className={`shortcut-add${capturing === action ? " active" : ""}`}
                      title={t("누른 뒤 키 조합을 누르세요. Esc로 취소합니다. 다른 동작에 쓰이던 조합은 이쪽으로 옮겨집니다.")}
                      aria-label={capturing === action ? undefined : t("단축키 추가")}
                      onClick={startCapture}
                    >
                      {capturing === action ? (captureHint ?? t("키 입력 대기…")) : <PlusIcon size={10} />}
                    </button>
                  </div>
                </SettingRow>
              );
            })}
            <SettingRow label={t("모든 단축키를 기본값으로")}>
              <button
                type="button"
                disabled={!anyChanged}
                onClick={() => {
                  const next = {} as Keymap;
                  for (const action of KEY_ACTIONS) {
                    next[action] = [...DEFAULT_KEYMAP[action]];
                  }
                  onChange({ keymap: next });
                }}
              >
                {t("기본값으로")}
              </button>
            </SettingRow>
          </SettingsGroup>
        );
      }

      case "security":
        return (
          <>
            <SettingsGroup title={t("잠금 암호")}>
              <SettingRow label={t("암호")} keywords="passcode lock">
                <input
                  type="password"
                  aria-label={t("암호")}
                  placeholder={t("암호")}
                  value={passcode}
                  onChange={(event) => setPasscode(event.target.value)}
                />
              </SettingRow>
              <SettingRow label={t("확인")}>
                <input
                  type="password"
                  aria-label={t("확인")}
                  placeholder={t("확인")}
                  value={passcodeConfirm}
                  onChange={(event) => setPasscodeConfirm(event.target.value)}
                />
              </SettingRow>
              <SettingRow label={hasPasscode ? t("암호 변경/해제") : t("새 암호")} hint={passcodeMessage}>
                <button type="button" onClick={() => void applyPasscode()}>
                  {hasPasscode ? t("변경") : t("저장")}
                </button>
                {hasPasscode ? (
                  <>
                    <button type="button" onClick={() => void removePasscode()}>
                      {t("해제")}
                    </button>
                    <button type="button" onClick={onLock}>
                      {t("지금 잠금")}
                    </button>
                  </>
                ) : null}
              </SettingRow>
            </SettingsGroup>
            <SettingsGroup title={t("활동 로그")}>
              <SettingRow label={t("보관 기간(일)")} {...fromDefault("activityDays")}>
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={settings.activityDays}
                  aria-label={t("보관 기간(일)")}
                  onChange={(event) =>
                    onChange({
                      activityDays: Math.min(90, Math.max(1, Number(event.target.value) || 7)),
                    })
                  }
                />
              </SettingRow>
            </SettingsGroup>
          </>
        );
    }
  }

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const sheetWidth = clampSheet(width ?? SHEET_DEFAULT);

  return (
    <>
      {/* The app stays in sight beside the sheet; a click on it closes the sheet. */}
      <div className="settings-scrim" onPointerDown={onClose} />
      <div
        ref={sheetRef}
        className="settings-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t("설정")}
        tabIndex={-1}
        style={{ width: sheetWidth }}
        onKeyDownCapture={onSheetKeyDownCapture}
        onKeyDown={onSheetKeyDown}
        onFocus={onSheetFocus}
      >
        <div
          ref={edgeRef}
          className="settings-sheet-edge"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("설정 너비")}
          aria-valuenow={sheetWidth}
          aria-valuemin={SHEET_MIN}
          aria-valuemax={SHEET_MAX}
          tabIndex={0}
          title={t("끌어서 너비 조절 · 두 번 누르면 원래대로")}
          onPointerDown={(event) => dragPanelEdge(event, sheetRef.current, -1, clampSheet, setWidth, saveWidth)}
          onDoubleClick={() => saveWidth(null)}
          onKeyDown={(event) => keyPanelEdge(event, sheetRef.current, -1, clampSheet, saveWidth)}
        />
        <header className="settings-sheet-head">
          <span className="settings-sheet-title">{t("설정")}</span>
          <button
            ref={closeRef}
            type="button"
            className="icon-button settings-sheet-close"
            title={t("닫기")}
            aria-label={t("닫기")}
            onClick={onClose}
          >
            <CloseIcon size={12} />
          </button>
        </header>
        <label className="settings-search">
          <SearchIcon size={12} />
          <input
            ref={searchRef}
            type="text"
            value={query}
            placeholder={t("입력해서 검색")}
            aria-label={t("설정 검색")}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div
          ref={tabsRef}
          className={`settings-tabs${terms.length > 0 ? " searching" : ""}`}
          role="tablist"
          aria-label={t("설정 페이지")}
        >
          {PAGES.map((item) => {
            const Icon = item.icon;
            const selected = page === item.id;
            const name = t(item.label);
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-label={name}
                title={name}
                tabIndex={selected ? 0 : -1}
                className={selected ? "active" : ""}
                onClick={() => switchPage(item.id, null)}
              >
                <Icon size={13} />
              </button>
            );
          })}
        </div>
        <div className="settings-sheet-body" ref={bodyRef} role="tabpanel">
          {terms.length === 0 ? (
            <ScopeContext.Provider value={{ terms, page: "", group: "" }}>{renderPage(page)}</ScopeContext.Provider>
          ) : (
            <>
              {PAGES.map((item) => (
                <ScopeContext.Provider key={item.id} value={{ terms, page: t(item.label), group: "" }}>
                  <section className="settings-results">
                    <h3 className="settings-results-title">{t(item.label)}</h3>
                    {renderPage(item.id)}
                  </section>
                </ScopeContext.Provider>
              ))}
              {noMatch ? <p className="settings-empty">{t("‘{query}’에 맞는 설정이 없습니다", { query })}</p> : null}
            </>
          )}
        </div>
        <footer className="settings-sheet-foot" aria-hidden="true">
          <span>
            <kbd>↑↓</kbd>
            {t("설정 이동")}
          </span>
          <span>
            <kbd>←→</kbd>
            {t("페이지 전환")}
          </span>
          <span>
            <kbd>⏎</kbd>
            {t("설정 바꾸기")}
          </span>
          {hint.changed ? (
            <span>
              <kbd>⌫</kbd>
              {t("재설정")}
            </span>
          ) : null}
          <span className="spacer" />
          <span>
            <kbd>esc</kbd>
            {hint.esc}
          </span>
        </footer>
      </div>
    </>
  );
}
