import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { languageLabel, t, type Language } from "../i18n";
import { THEMES, palette, themeFromJson, type ValueKind } from "../palette";
import { fontGroups, fontInstalled, type FontGroup, type InstalledFont } from "../fonts";
import { store } from "../store";
import {
  MAX_ROWS_LIMIT,
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
import { SYNTAX_PRESETS, type SyntaxPresetId } from "../syntax";
import {
  ChevronIcon,
  CodeIcon,
  ColumnsIcon,
  KeyIcon,
  PanelLeftIcon,
  PlusIcon,
  SettingsIcon,
  ShieldIcon,
  TableIcon,
  UpDownIcon,
} from "./icons";
import { gridHeightsAt } from "../grid/CanvasGrid";
import { Spinner } from "./Spinner";
import { Select } from "./Select";
import { SqlPreview } from "./SqlEditor";

interface SettingsModalProps {
  settings: AppSettings;
  onChange(patch: Partial<AppSettings>): void;
  onLock(): void;
  onClose(): void;
}

type SettingsCategory =
  | "general"
  | "theme"
  | "editor"
  | "grid"
  | "sidebar"
  | "transfer"
  | "shortcuts"
  | "security";

interface CategoryItem {
  id: SettingsCategory;
  label: string;
  icon: (props: { size?: number }) => ReactElement;
}

// The list on the left, in groups. The screen's areas each have their own
// pane (its font and what it shows), as TablePlus splits its fonts into SQL
// Editor, Data Table and Sidebars.
const SETTINGS_GROUPS: { label: string | null; items: CategoryItem[] }[] = [
  {
    label: null,
    items: [
      { id: "general", label: "일반", icon: SettingsIcon },
      { id: "theme", label: "테마", icon: ColumnsIcon },
    ],
  },
  {
    label: "화면",
    items: [
      { id: "editor", label: "SQL 에디터", icon: CodeIcon },
      { id: "grid", label: "데이터 테이블", icon: TableIcon },
      { id: "sidebar", label: "사이드바", icon: PanelLeftIcon },
    ],
  },
  {
    label: null,
    items: [
      { id: "transfer", label: "가져오기·내보내기", icon: UpDownIcon },
      { id: "shortcuts", label: "단축키", icon: KeyIcon },
      { id: "security", label: "보안", icon: ShieldIcon },
    ],
  },
];

// The installed families, asked of the server once a session.
let installedFonts: Promise<InstalledFont[]> | null = null;

function loadInstalledFonts(): Promise<InstalledFont[]> {
  installedFonts ??= store.listFonts().catch(() => {
    installedFonts = null;
    return [];
  });
  return installedFonts;
}

// A titled box of settings.
function SettingsGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="settings-group">
      {title ? <h4>{title}</h4> : null}
      <div className="settings-box">{children}</div>
    </section>
  );
}

// One setting: its name in the label column, and its control beside it. A
// checkbox names itself and leaves the label empty.
function SettingsField({
  label,
  hint,
  children,
}: {
  label?: string;
  hint?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="settings-field">
      <span className="settings-label">{label ?? ""}</span>
      <div className="settings-control">
        <div className="settings-inline">{children}</div>
        {hint ? <p className="settings-hint">{hint}</p> : null}
      </div>
    </div>
  );
}

function SettingsCheck({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange(checked: boolean): void;
  children: ReactNode;
}) {
  return (
    <label className="settings-check">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {children}
    </label>
  );
}

// One of the three fonts: its family (a saved list no longer offered shows
// as "custom", a suggested font this machine lacks is marked: it falls back
// to the system's) and its size.
function FontFields({
  label,
  hint,
  groups,
  value,
  size,
  sizes,
  onChange,
  onSize,
}: {
  label: string;
  hint: string;
  groups: FontGroup[];
  value: string;
  size: number;
  sizes: number[];
  onChange(value: string): void;
  onSize(size: number): void;
}) {
  const known = groups.some((group) => group.choices.some((choice) => choice.value === value));
  const options = (group: FontGroup) =>
    group.choices.map((choice) => (
      <option key={choice.value} value={choice.value}>
        {choice.family !== undefined && !fontInstalled(choice.family)
          ? `${t(choice.label)} — ${t("미설치")}`
          : t(choice.label)}
      </option>
    ));
  return (
    <SettingsGroup title={t("글꼴")}>
      <SettingsField label={t("글꼴")} hint={hint}>
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
          {known ? null : <option value={value}>{t("사용자 지정")}</option>}
        </Select>
      </SettingsField>
      <SettingsField label={t("크기")}>
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
      </SettingsField>
    </SettingsGroup>
  );
}

// Whole px sizes to pick from (a list, so a size never lands half typed), plus
// the current one if older settings saved one off the steps.
function sizeChoices(min: number, max: number, current: number): number[] {
  const sizes = Array.from({ length: max - min + 1 }, (_, index) => min + index);
  return sizes.includes(current) ? sizes : [...sizes, current].sort((a, b) => a - b);
}

// What a pane's settings look like, drawn as the app draws that area.
function Preview({ children }: { children: ReactNode }) {
  return (
    <section className="settings-group">
      <h4>{t("미리보기")}</h4>
      <div className="settings-preview" aria-hidden="true">
        {children}
      </div>
    </section>
  );
}

const EDITOR_SAMPLE = [
  "SELECT id, name, count(*) AS orders",
  "FROM users WHERE email LIKE '%@example.com'",
  "GROUP BY id, name LIMIT 100; -- 0O 1lI",
].join("\n");

const GRID_COLUMNS = ["id", "name", "active", "price", "created_at"];
// Each cell's kind (none for NULL) and its text; the first column is the key.
const GRID_SAMPLE: [ValueKind | null, string][][] = [
  [["integer", "1"], ["string", "user_1"], ["boolean", "true"], ["float", "12.5"], ["date", "2026-10-27"]],
  [["integer", "2"], ["string", "사용자_2"], ["boolean", "false"], ["float", "8"], ["date", "2026-10-26"]],
  [["integer", "3"], [null, "NULL"], ["boolean", "true"], ["float", "99.9"], ["date", "2026-10-25"]],
];

// Drawn as CanvasGrid draws the grid: its row and header heights, lines,
// row numbers and header, a key in the error colour, NULL faint, the rest
// by kind, and numbers to the right.
function GridPreview({ settings }: { settings: AppSettings }) {
  const ink = (kind: ValueKind | null, column: number): string | undefined => {
    if (kind === null) {
      return palette.nullInk;
    }
    if (!settings.typeColors) {
      return undefined;
    }
    return column === 0 ? palette.error : palette.typeInks[kind];
  };
  const heights = gridHeightsAt(settings.gridFontSize);
  return (
    <Preview>
      <table
        className="settings-preview-grid"
        style={{ fontFamily: settings.gridFontFamily, fontSize: `${settings.gridFontSize}px` }}
      >
        <thead>
          <tr style={{ height: heights.header }}>
            <th className="gutter" />
            {GRID_COLUMNS.map((name) => (
              <th key={name}>{name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {GRID_SAMPLE.map((cells, row) => (
            <tr
              key={row}
              style={{
                height: heights.row,
                background: settings.rowAlt && row % 2 === 1 ? palette.rowAlt : undefined,
              }}
            >
              <td className="gutter">{row + 1}</td>
              {cells.map(([kind, text], column) => (
                <td
                  key={column}
                  className={kind === "integer" || kind === "float" ? "numeric" : undefined}
                  style={{ color: ink(kind, column) }}
                >
                  {text}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Preview>
  );
}

const SIDEBAR_SAMPLE = ["customers", "orders", "주문_상세"];

// The sidebar's own tree markup, so it draws with the sidebar's styles and
// takes its font and size as the sidebar does (see .schema-sidebar).
function SidebarPreview() {
  return (
    <Preview>
      <div className="schema-list settings-preview-sidebar">
        <div className="schema-section-head">
          <span className="schema-toggle open">
            <ChevronIcon size={10} />
          </span>
          <span className="schema-section-label">{t("테이블")}</span>
          <span className="schema-section-count">{SIDEBAR_SAMPLE.length}</span>
        </div>
        {SIDEBAR_SAMPLE.map((name) => (
          <div className="schema-table" key={name}>
            <div className="schema-table-row">
              <span className="schema-toggle">
                <ChevronIcon size={10} />
              </span>
              <TableIcon size={11} className="schema-table-icon" />
              <span className="schema-table-name">{name}</span>
            </div>
          </div>
        ))}
      </div>
    </Preview>
  );
}

export function SettingsModal({
  settings,
  onChange,
  onLock,
  onClose,
}: SettingsModalProps) {
  const [capturing, setCapturing] = useState<KeyAction | null>(null);
  const [captureHint, setCaptureHint] = useState<string | null>(null);
  const [passcode, setPasscode] = useState("");
  const [passcodeConfirm, setPasscodeConfirm] = useState("");
  const [passcodeMessage, setPasscodeMessage] = useState<string | null>(null);
  const [hasPasscode, setHasPasscode] = useState(
    () => getPasscodeHash() !== null,
  );
  const [themeUrl, setThemeUrl] = useState("");
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
  const editorFontGroups = useMemo(
    () => fontGroups("editor", fontFamilies, settings.fontFamily),
    [fontFamilies, settings.fontFamily],
  );
  const gridFontGroups = useMemo(
    () => fontGroups("grid", fontFamilies, settings.gridFontFamily),
    [fontFamilies, settings.gridFontFamily],
  );
  const sidebarFontGroups = useMemo(
    () => fontGroups("sidebar", fontFamilies, settings.sidebarFontFamily),
    [fontFamilies, settings.sidebarFontFamily],
  );
  const [themeMessage, setThemeMessage] = useState<string | null>(null);
  const [themeBusy, setThemeBusy] = useState(false);
  const [category, setCategory] = useState<SettingsCategory>("general");
  const paneRef = useRef<HTMLDivElement>(null);

  // Each pane starts at its top; declared first, so the theme pane's
  // centring below runs after it.
  useEffect(() => {
    if (paneRef.current) {
      paneRef.current.scrollTop = 0;
    }
  }, [category]);

  // The theme list runs past the pane; bring the theme in use into view when
  // the pane opens or a Git import adds and selects one off-screen.
  useEffect(() => {
    if (category !== "theme") {
      return;
    }
    const pane = paneRef.current;
    const card = pane?.querySelector<HTMLElement>(".theme-card.active");
    if (!pane || !card) {
      return;
    }
    const paneBox = pane.getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    if (cardBox.top < paneBox.top || cardBox.bottom > paneBox.bottom) {
      pane.scrollTop += cardBox.top - paneBox.top - (pane.clientHeight - cardBox.height) / 2;
    }
  }, [category, settings.theme]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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
      next[key] =
        key === action ? bindings : settings.keymap[key].filter((entry) => !bindings.includes(entry));
    }
    onChange({ keymap: next });
  }

  async function importTheme(): Promise<void> {
    if (themeBusy) {
      return;
    }
    let url: URL;
    try {
      url = new URL(themeUrl.trim());
    } catch {
      setThemeMessage(t("올바른 URL을 입력하세요"));
      return;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      setThemeMessage(t("http(s) URL만 가져올 수 있습니다"));
      return;
    }
    setThemeBusy(true);
    setThemeMessage(null);
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const theme = themeFromJson(await response.json());
      onChange({ theme: theme.id, accent: theme.accent });
      setThemeUrl("");
      setThemeMessage(t("{name} 테마를 가져왔습니다", { name: t(theme.label) }));
    } catch (err) {
      setThemeMessage(
        err instanceof Error && err.message
          ? t("가져오지 못했습니다: {message}", { message: err.message })
          : t("가져오지 못했습니다"),
      );
    } finally {
      setThemeBusy(false);
    }
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

  function renderPane(): ReactNode {
    switch (category) {
      case "general":
        return (
          <SettingsGroup>
            <SettingsField label={t("언어")}>
              <div className="segmented settings-language">
                {(["ko", "en"] as Language[]).map((language) => (
                  <button
                    key={language}
                    type="button"
                    className={settings.language === language ? "active" : ""}
                    onClick={() => onChange({ language })}
                  >
                    {languageLabel(language)}
                  </button>
                ))}
              </div>
            </SettingsField>
          </SettingsGroup>
        );

      case "theme":
        return (
          <>
            <SettingsGroup>
              <SettingsField label={t("강조 색")}>
                <input
                  type="color"
                  value={settings.accent}
                  onChange={(event) => onChange({ accent: event.target.value })}
                />
                <span className="mono dim">{settings.accent}</span>
              </SettingsField>
              <SettingsField label={t("Git 테마")} hint={themeMessage}>
                <input
                  className="settings-theme-url"
                  value={themeUrl}
                  spellCheck={false}
                  placeholder="https://raw.githubusercontent.com/.../theme.json"
                  title={t("Base16, VS Code 색상 테마 JSON 또는 TablePeek 테마 JSON을 Git 원본 URL에서 가져옵니다.")}
                  onChange={(event) => setThemeUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void importTheme();
                    }
                  }}
                />
                <button type="button" disabled={themeBusy} onClick={() => void importTheme()}>
                  {themeBusy ? (
                    <>
                      <Spinner size={10} />
                      {t("가져오는 중")}
                    </>
                  ) : (
                    t("가져오기")
                  )}
                </button>
              </SettingsField>
            </SettingsGroup>
            {(["dark", "light"] as const).map((mode) => (
              <section key={mode} className="settings-group">
                <h4>{mode === "dark" ? t("다크") : t("라이트")}</h4>
                <div className="theme-grid">
                  {THEMES.filter((theme) => theme.mode === mode).map((theme) => (
                    <button
                      key={theme.id}
                      type="button"
                      data-theme-id={theme.id}
                      className={`theme-card${settings.theme === theme.id ? " active" : ""}`}
                      title={t(theme.label)}
                      onClick={() => onChange({ theme: theme.id, accent: theme.accent })}
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
              </section>
            ))}
          </>
        );

      case "editor":
        return (
          <>
            <FontFields
              label={t("SQL 에디터")}
              hint={t("에디터와 콘솔에 쓰입니다.")}
              groups={editorFontGroups}
              value={settings.fontFamily}
              size={settings.fontSize}
              sizes={sizeChoices(EDITOR_FONT_MIN, EDITOR_FONT_MAX, settings.fontSize)}
              onChange={(fontFamily) => onChange({ fontFamily })}
              onSize={(fontSize) => onChange({ fontSize })}
            />
            <SettingsGroup title={t("편집")}>
              <SettingsField
                label={t("구문 강조")}
                hint={t(SYNTAX_PRESETS.find((preset) => preset.id === settings.syntaxPreset)?.description ?? "")}
              >
                <Select
                  value={settings.syntaxPreset}
                  onChange={(event) => onChange({ syntaxPreset: event.target.value as SyntaxPresetId })}
                >
                  {SYNTAX_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {t(preset.label)}
                    </option>
                  ))}
                </Select>
              </SettingsField>
              <SettingsField>
                <SettingsCheck
                  checked={settings.uppercaseKeywords}
                  onChange={(uppercaseKeywords) => onChange({ uppercaseKeywords })}
                >
                  {t("정리·축약할 때 키워드를 대문자로")}
                </SettingsCheck>
              </SettingsField>
            </SettingsGroup>
            <Preview>
              <SqlPreview doc={EDITOR_SAMPLE} />
            </Preview>
          </>
        );

      case "grid":
        return (
          <>
            <FontFields
              label={t("데이터 테이블")}
              hint={t("모든 표와 셀 편집에 쓰입니다.")}
              groups={gridFontGroups}
              value={settings.gridFontFamily}
              size={settings.gridFontSize}
              sizes={sizeChoices(GRID_FONT_MIN, GRID_FONT_MAX, settings.gridFontSize)}
              onChange={(gridFontFamily) => onChange({ gridFontFamily })}
              onSize={(gridFontSize) => onChange({ gridFontSize })}
            />
            <SettingsGroup title={t("표시")}>
              <SettingsField label={t("최대 행")}>
                <input
                  type="number"
                  min={1}
                  max={MAX_ROWS_LIMIT}
                  value={settings.maxRows}
                  title={t("쿼리 한 번에 가져오는 최대 행 수입니다.")}
                  onChange={(event) =>
                    onChange({
                      maxRows: Math.min(
                        MAX_ROWS_LIMIT,
                        Math.max(1, Math.trunc(Number(event.target.value)) || 1),
                      ),
                    })
                  }
                />
              </SettingsField>
              <SettingsField>
                <SettingsCheck checked={settings.rowAlt} onChange={(rowAlt) => onChange({ rowAlt })}>
                  {t("줄무늬 행 배경")}
                </SettingsCheck>
              </SettingsField>
              <SettingsField>
                <SettingsCheck checked={settings.typeColors} onChange={(typeColors) => onChange({ typeColors })}>
                  {t("타입별 색상")}
                </SettingsCheck>
              </SettingsField>
              <SettingsField label={t("스크롤바 항상 표시")} hint={t("SQL 에디터에도 적용됩니다.")}>
                <SettingsCheck checked={settings.scrollbarX} onChange={(scrollbarX) => onChange({ scrollbarX })}>
                  {t("가로")}
                </SettingsCheck>
                <SettingsCheck checked={settings.scrollbarY} onChange={(scrollbarY) => onChange({ scrollbarY })}>
                  {t("세로")}
                </SettingsCheck>
              </SettingsField>
            </SettingsGroup>
            <GridPreview settings={settings} />
          </>
        );

      case "sidebar":
        return (
          <>
            <FontFields
              label={t("사이드바")}
              hint={t("왼쪽 사이드바와 오른쪽 상세 패널에 쓰입니다.")}
              groups={sidebarFontGroups}
              value={settings.sidebarFontFamily}
              size={settings.sidebarFontSize}
              sizes={sizeChoices(SIDEBAR_FONT_MIN, SIDEBAR_FONT_MAX, settings.sidebarFontSize)}
              onChange={(sidebarFontFamily) => onChange({ sidebarFontFamily })}
              onSize={(sidebarFontSize) => onChange({ sidebarFontSize })}
            />
            <SidebarPreview />
          </>
        );

      case "transfer":
        return (
          <SettingsGroup title="CSV">
            <SettingsField label={t("CSV 구분자")}>
              <Select value={settings.csvDelimiter} onChange={(event) => onChange({ csvDelimiter: event.target.value })}>
                <option value=",">{t(", (쉼표)")}</option>
                <option value={"	"}>Tab</option>
                <option value=";">{t("; (세미콜론)")}</option>
                <option value="|">{t("| (파이프)")}</option>
              </Select>
            </SettingsField>
            <SettingsField>
              <SettingsCheck checked={settings.csvHeader} onChange={(csvHeader) => onChange({ csvHeader })}>
                {t("첫 행을 헤더로 사용")}
              </SettingsCheck>
            </SettingsField>
            <SettingsField label={t("인코딩")}>
              <Select
                value={settings.csvEncoding}
                onChange={(event) => onChange({ csvEncoding: event.target.value as AppSettings["csvEncoding"] })}
              >
                <option value="utf-8">UTF-8</option>
                <option value="euc-kr">EUC-KR</option>
                <option value="utf-16le">UTF-16LE</option>
              </Select>
            </SettingsField>
          </SettingsGroup>
        );

      case "shortcuts":
        return (
          <>
            <p className="settings-hint settings-lead">
              {t("TablePeek 단축키가 브라우저 단축키보다 먼저 실행됩니다. {keys}는 브라우저가 먼저 처리합니다.", {
                keys: ["Mod+w", "Mod+t", "Mod+n"].map(formatBinding).join(" · "),
              })}
            </p>
            <div className="settings-box shortcut-list">
              {KEY_ACTIONS.map((action) => {
                const changed = settings.keymap[action].join("\n") !== DEFAULT_KEYMAP[action].join("\n");
                return (
                  <div className="shortcut-row" key={action}>
                    <span className="shortcut-label">{t(KEY_ACTION_LABELS[action])}</span>
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
                            {reserved ? <span className="shortcut-warn" aria-hidden="true">!</span> : null}
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
                        onClick={() => {
                          setCaptureHint(null);
                          setCapturing(capturing === action ? null : action);
                        }}
                      >
                        {capturing === action ? (captureHint ?? t("키 입력 대기…")) : <PlusIcon size={10} />}
                      </button>
                    </div>
                    {/* Kept in its place when hidden, so the rows line up. */}
                    <button
                      type="button"
                      onClick={() => setBindings(action, [...DEFAULT_KEYMAP[action]])}
                      disabled={!changed}
                      className={`settings-reset${changed ? "" : " unchanged"}`}
                      title={t("기본값으로")}
                    >
                      {t("기본")}
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="settings-actions">
              <button
                type="button"
                onClick={() => {
                  const next = {} as Keymap;
                  for (const action of KEY_ACTIONS) {
                    next[action] = [...DEFAULT_KEYMAP[action]];
                  }
                  onChange({ keymap: next });
                }}
              >
                {t("모든 단축키를 기본값으로")}
              </button>
            </div>
          </>
        );

      case "security":
        return (
          <>
            <SettingsGroup title={t("잠금 암호")}>
              <SettingsField label={hasPasscode ? t("암호 변경/해제") : t("새 암호")}>
                <input
                  type="password"
                  placeholder={t("암호")}
                  value={passcode}
                  onChange={(event) => setPasscode(event.target.value)}
                />
                <input
                  type="password"
                  placeholder={t("확인")}
                  value={passcodeConfirm}
                  onChange={(event) => setPasscodeConfirm(event.target.value)}
                />
              </SettingsField>
              <SettingsField hint={passcodeMessage}>
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
              </SettingsField>
            </SettingsGroup>
            <SettingsGroup title={t("활동 로그")}>
              <SettingsField label={t("보관 기간(일)")}>
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={settings.activityDays}
                  onChange={(event) =>
                    onChange({
                      activityDays: Math.min(90, Math.max(1, Number(event.target.value) || 7)),
                    })
                  }
                />
              </SettingsField>
            </SettingsGroup>
          </>
        );
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal settings-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title">{t("설정")}</span>
        </div>
        <div className="settings-shell">
          <nav className="settings-nav" aria-label={t("설정")}>
            {SETTINGS_GROUPS.map((group, index) => (
              <div key={index} className="settings-nav-group">
                {group.label !== null ? (
                  <span className="settings-nav-caption">{t(group.label)}</span>
                ) : index > 0 ? (
                  <span className="settings-nav-sep" aria-hidden="true" />
                ) : null}
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      type="button"
                      key={item.id}
                      className={category === item.id ? "active" : ""}
                      aria-current={category === item.id ? "true" : undefined}
                      onClick={() => setCategory(item.id)}
                    >
                      <Icon size={12} />
                      <span>{t(item.label)}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
          <div className="settings-pane" ref={paneRef}>
            {renderPane()}
          </div>
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            {t("닫기")}
          </button>
        </div>
      </div>
    </div>
  );
}
