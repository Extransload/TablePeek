import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import { languageLabel, t, type Language } from "../i18n";
import { THEMES, palette, type ValueKind } from "../palette";
import { fontGroups, fontListLabel, pickedFace, type FontGroup, type InstalledFont } from "../fonts";
import { store, type VersionInfo } from "../store";
import { checkUpdateNow, configureUpdate, getUpdate, loadUpdate, refreshUpdate, subscribeUpdate } from "../update";
import {
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
  ChevronIcon,
  CodeIcon,
  ColumnsIcon,
  DownloadIcon,
  ExternalIcon,
  KeyIcon,
  PanelLeftIcon,
  PlusIcon,
  RefreshIcon,
  SettingsIcon,
  ShieldIcon,
  TableIcon,
  UpDownIcon,
} from "./icons";
import { ErrorNotice, notifyError } from "./ErrorNotice";
import { Spinner } from "./Spinner";
import { UpdateHowDialog } from "./UpdateBanner";
import { gridHeightsAt } from "../grid/CanvasGrid";
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
  disabled = false,
  onChange,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange(checked: boolean): void;
  children: ReactNode;
}) {
  return (
    <label className="settings-check">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {children}
    </label>
  );
}

// One of the three fonts: its face (a saved list no longer offered shows
// under its first family's name) and its size.
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
          {known || updated !== undefined ? null : <option value={value}>{fontListLabel(value)}</option>}
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

const GRID_COLUMNS = ["id", "name", "active", "price", "tags", "meta", "created_at"];
// Each cell's kind (none for NULL) and its text; the first column is the key.
const GRID_SAMPLE: [ValueKind | null, string][][] = [
  [["integer", "1"], ["string", "user_1"], ["boolean", "true"], ["float", "12.5"], ["list", "{a,b}"], ["json", '{"v":1}'], ["date", "2026-10-27"]],
  [["integer", "2"], ["string", "사용자_2"], ["boolean", "false"], ["float", "8"], ["list", "{}"], ["json", '{"v":2}'], ["date", "2026-10-26"]],
  [["integer", "3"], [null, "NULL"], ["boolean", "true"], ["float", "99.9"], [null, "NULL"], ["json", "[]"], ["date", "2026-10-25"]],
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

// A box of colour picks for the theme in use: each part's colour, its value
// and a reset, then a note and "reset all" under them.
function ColorPicks<K extends string>({
  rows,
  colors,
  picked,
  hint,
  className,
  onPick,
}: {
  rows: { label: string; keys: K[] }[];
  colors: Record<K, string>;
  picked: Partial<Record<K, string>>;
  hint: string;
  className?: string;
  onPick(keys: K[], color: string | null): void;
}) {
  return (
    <>
      <div className={`syntax-colors${className ? ` ${className}` : ""}`}>
        {rows.map((row) => {
          const color = colors[row.keys[0]];
          const changed = row.keys.some((key) => picked[key] !== undefined);
          return (
            <div className="syntax-color" key={row.label}>
              <span className="settings-label">{t(row.label)}</span>
              <input
                type="color"
                aria-label={t(row.label)}
                value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#000000"}
                onChange={(event) => onPick(row.keys, event.target.value)}
              />
              <span className="mono dim">{color}</span>
              <button
                type="button"
                className={`settings-reset${changed ? "" : " unchanged"}`}
                disabled={!changed}
                title={t("기본값으로")}
                onClick={() => onPick(row.keys, null)}
              >
                {t("기본")}
              </button>
            </div>
          );
        })}
      </div>
      <div className="settings-box-actions">
        <span className="settings-hint">{hint}</span>
        <button
          type="button"
          disabled={Object.keys(picked).length === 0}
          onClick={() => onPick(rows.flatMap((row) => row.keys), null)}
        >
          {t("모두 기본값으로")}
        </button>
      </div>
    </>
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

// Why the last update check failed, by the server's code.
function updateErrorText(code: string): string {
  if (code === "network") {
    return t("네트워크에 연결할 수 없어 새 버전을 확인하지 못했습니다");
  }
  if (code === "timeout") {
    return t("GitHub가 5초 안에 답하지 않아 새 버전을 확인하지 못했습니다");
  }
  if (code === "rate_limited") {
    return t("GitHub 요청 한도에 걸려 새 버전을 확인하지 못했습니다. 잠시 뒤 다시 확인하세요");
  }
  if (code.startsWith("http_")) {
    return t("GitHub가 HTTP {status}로 답해 새 버전을 확인하지 못했습니다", { status: code.slice(5) });
  }
  return t("GitHub의 릴리스 정보를 읽지 못했습니다");
}

// General: what this build is, and the check for a newer release.
function VersionSettings() {
  const update = useSyncExternalStore(subscribeUpdate, getUpdate);
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
      <div className="version-head">
        <span className="version-name">TablePeek</span>
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
            <span className="version-chip">{version.dist === "release" ? t("릴리스 바이너리") : t("소스 빌드")}</span>
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
              <button type="button" className="version-update-button" onClick={() => setHowOpen(true)}>
                {t("업데이트 방법")}
              </button>
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
      {update?.enabled && update.error !== null && !checking ? (
        <div className="settings-update-error">
          <ErrorNotice error={updateErrorText(update.error)} variant="compact" onRetry={() => void checkNow()} />
        </div>
      ) : null}
      <div className="version-check">
        <SettingsCheck
          checked={update?.enabled ?? true}
          disabled={update === null || update.env_disabled}
          onChange={(enabled) => void setEnabled(enabled)}
        >
          {t("새 버전 확인")}
        </SettingsCheck>
        <p className="settings-hint">
          {update?.env_disabled
            ? t("TABLEPEEK_NO_UPDATE_CHECK 환경 변수가 확인을 껐습니다.")
            : t("하루에 한 번 GitHub에서 최신 릴리스를 확인합니다. 지금 버전(User-Agent) 말고는 아무것도 보내지 않습니다.")}
        </p>
      </div>
      {howOpen && update !== null && update.latest !== null ? (
        <UpdateHowDialog update={update} latest={update.latest} onClose={() => setHowOpen(false)} />
      ) : null}
    </SettingsGroup>
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
    () => fontGroups("editor", fontFamilies),
    [fontFamilies],
  );
  const gridFontGroups = useMemo(
    () => fontGroups("grid", fontFamilies),
    [fontFamilies],
  );
  const sidebarFontGroups = useMemo(
    () => fontGroups("sidebar", fontFamilies),
    [fontFamilies],
  );
  const [category, setCategory] = useState<SettingsCategory>("general");
  const paneRef = useRef<HTMLDivElement>(null);

  // Each pane starts at its top.
  useEffect(() => {
    if (paneRef.current) {
      paneRef.current.scrollTop = 0;
    }
  }, [category]);

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

  // A colour picked for parts of the current theme's syntax or data table, or
  // none to go back to the theme's own.
  function pickThemeColor(field: "syntaxColors" | "gridColors", keys: string[], color: string | null): void {
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
    // The theme whose colours the SQL Editor and Data Table panes pick.
    const themeLabel = THEMES.find((theme) => theme.id === settings.theme)?.label ?? settings.theme;
    switch (category) {
      case "general":
        return (
          <>
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
            <VersionSettings />
          </>
        );

      case "theme":
        return (
          <>
            <SettingsGroup>
              <SettingsField label={t("강조 색")} hint={t("SQL 에디터와 데이터 테이블의 색은 각 화면 설정에서 고릅니다.")}>
                <input
                  type="color"
                  value={settings.accent}
                  onChange={(event) => onChange({ accent: event.target.value })}
                />
                <span className="mono dim">{settings.accent}</span>
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
              <SettingsField>
                <SettingsCheck
                  checked={settings.uppercaseKeywords}
                  onChange={(uppercaseKeywords) => onChange({ uppercaseKeywords })}
                >
                  {t("정리·축약할 때 키워드를 대문자로")}
                </SettingsCheck>
              </SettingsField>
            </SettingsGroup>
            {/* The colours picked here belong to the theme in use. */}
            <SettingsGroup title={t("색")}>
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
              <ColorPicks
                rows={SYNTAX_COLOR_ROWS}
                colors={currentSyntaxColors(settings)}
                picked={settings.syntaxColors[settings.theme] ?? {}}
                hint={t("지금 테마({theme})에만 저장되며, 구문 강조 위에 덮입니다.", { theme: t(themeLabel) })}
                onPick={(keys, color) => pickThemeColor("syntaxColors", keys, color)}
              />
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
              <SettingsField label={t("쿼리 시간 제한(초)")} hint={t("MongoDB 쿼리, mongosh 스크립트, ClickHouse 문장에 쓰입니다. 0이면 제한이 없습니다.")}>
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
              </SettingsField>
              <SettingsField>
                <SettingsCheck checked={settings.rowAlt} onChange={(rowAlt) => onChange({ rowAlt })}>
                  {t("줄무늬 행 배경")}
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
            {/* The colours picked here belong to the theme in use. */}
            <SettingsGroup title={t("색")}>
              <SettingsField>
                <SettingsCheck checked={settings.typeColors} onChange={(typeColors) => onChange({ typeColors })}>
                  {t("타입별 색상")}
                </SettingsCheck>
              </SettingsField>
              <ColorPicks
                rows={GRID_COLOR_ROWS}
                colors={currentGridColors(settings)}
                picked={settings.gridColors[settings.theme] ?? {}}
                className="grid-colors"
                hint={
                  settings.typeColors
                    ? t("지금 테마({theme})에만 저장되며, 표와 MongoDB 문서의 값 색에 쓰입니다.", { theme: t(themeLabel) })
                    : t("‘타입별 색상’이 꺼져 있어 NULL 말고는 지금 쓰이지 않습니다.")
                }
                onPick={(keys, color) => pickThemeColor("gridColors", keys, color)}
              />
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
