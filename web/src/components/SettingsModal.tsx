import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { languageLabel, t, type Language } from "../i18n";
import { THEMES, VALUE_KINDS, palette, themeFromJson } from "../palette";
import { fontGroups, fontInstalled, type FontGroup, type InstalledFont } from "../fonts";
import { store } from "../store";
import {
  MAX_ROWS_LIMIT,
  getPasscodeHash,
  setPasscodeHash,
  sha256Hex,
  EDITOR_FONT_MAX,
  EDITOR_FONT_MIN,
  UI_FONT_MAX,
  UI_FONT_MIN,
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
  CodeIcon,
  ColumnsIcon,
  KeyIcon,
  SettingsIcon,
  ShieldIcon,
  TableIcon,
} from "./icons";
import { Spinner } from "./Spinner";
import { Select } from "./Select";

interface SettingsModalProps {
  settings: AppSettings;
  onChange(patch: Partial<AppSettings>): void;
  onLock(): void;
  onClose(): void;
}

type SettingsCategory =
  | "general"
  | "appearance"
  | "editor"
  | "data"
  | "shortcuts"
  | "security";

const SETTINGS_CATEGORIES: {
  id: SettingsCategory;
  label: string;
  icon: (props: { size?: number }) => ReactElement;
}[] = [
  { id: "general", label: "일반", icon: SettingsIcon },
  { id: "appearance", label: "모양", icon: ColumnsIcon },
  { id: "editor", label: "에디터", icon: CodeIcon },
  { id: "data", label: "데이터", icon: TableIcon },
  { id: "shortcuts", label: "단축키", icon: KeyIcon },
  { id: "security", label: "보안", icon: ShieldIcon },
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

// A font list with the current pick, a saved list no longer offered shown as
// "custom"; a suggested font this machine lacks is marked (it falls back to
// the system's).
function FontSelect({
  groups,
  value,
  preview,
  onChange,
}: {
  groups: FontGroup[];
  value: string;
  preview: string;
  onChange(value: string): void;
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
    <div className="font-select">
      <Select value={value} onChange={(event) => onChange(event.target.value)}>
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
      <span className="font-preview" style={{ fontFamily: value }}>
        {preview}
      </span>
    </div>
  );
}

// Whole px sizes to pick from (a list, so a size never lands half typed), plus
// the current one if older settings saved one off the steps.
function sizeChoices(min: number, max: number, current: number): number[] {
  const sizes = Array.from({ length: max - min + 1 }, (_, index) => min + index);
  return sizes.includes(current) ? sizes : [...sizes, current].sort((a, b) => a - b);
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
  const uiFontGroups = useMemo(
    () => fontGroups("ui", fontFamilies, settings.uiFontFamily),
    [fontFamilies, settings.uiFontFamily],
  );
  const codeFontGroups = useMemo(
    () => fontGroups("code", fontFamilies, settings.fontFamily),
    [fontFamilies, settings.fontFamily],
  );
  const [themeMessage, setThemeMessage] = useState<string | null>(null);
  const [themeBusy, setThemeBusy] = useState(false);
  const [category, setCategory] = useState<SettingsCategory>("general");
  const themeListRef = useRef<HTMLDivElement>(null);

  // The theme list scrolls on its own; bring the theme in use into view when
  // the pane opens or a Git import adds and selects one off-screen.
  useEffect(() => {
    if (category !== "appearance") {
      return;
    }
    const list = themeListRef.current;
    const card = list?.querySelector<HTMLElement>(".theme-card.active");
    if (!list || !card) {
      return;
    }
    const visible =
      card.offsetTop >= list.scrollTop &&
      card.offsetTop + card.offsetHeight <= list.scrollTop + list.clientHeight;
    if (!visible) {
      list.scrollTop = card.offsetTop - list.clientHeight / 2 + card.offsetHeight / 2;
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

  const activeCategory =
    SETTINGS_CATEGORIES.find((item) => item.id === category) ??
    SETTINGS_CATEGORIES[0];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal settings-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title">{t("설정")}</span>
          <span className="modal-path">tablepeek</span>
        </div>
        <div className="settings-shell">
          <nav className="settings-nav" aria-label={t("설정")}>
            {SETTINGS_CATEGORIES.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  type="button"
                  key={item.id}
                  className={category === item.id ? "active" : ""}
                  onClick={() => setCategory(item.id)}
                >
                  <Icon size={12} />
                  <span>{t(item.label)}</span>
                </button>
              );
            })}
          </nav>
          <div className="settings-content">
            <div className="settings-pane-head">
              <h3>{t(activeCategory.label)}</h3>
            </div>
            <div className="settings-pane">
              <div className="settings-category" hidden={category !== "general"}>
                <>
                  <section className="settings-section">
                    <h4>{t("표시 언어")}</h4>
                    <div className="settings-row">
                      <span className="settings-label">{t("언어")}</span>
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
                    </div>
                  </section>
                </>
              </div>

              <div className="settings-category" hidden={category !== "appearance"}>
                <>
                  <section className="settings-section">
                    <h4>{t("테마")}</h4>
                    <div className="theme-list" ref={themeListRef}>
                      {(["dark", "light"] as const).map((mode) => (
                        <div key={mode} className="theme-group">
                          <div className="theme-group-title">
                            {mode === "dark" ? t("다크") : t("라이트")}
                          </div>
                          <div className="theme-grid">
                            {THEMES.filter((theme) => theme.mode === mode).map((theme) => (
                              <button
                                key={theme.id}
                                type="button"
                                data-theme-id={theme.id}
                                className={`theme-card${settings.theme === theme.id ? " active" : ""}`}
                                title={t(theme.label)}
                                onClick={() =>
                                  onChange({ theme: theme.id, accent: theme.accent })
                                }
                              >
                                <span
                                  className="theme-preview"
                                  style={{
                                    background: theme.palette.bg,
                                    borderColor: theme.palette.line,
                                  }}
                                >
                                  <span
                                    className="theme-preview-head"
                                    style={{ background: theme.palette.head }}
                                  />
                                  <span className="theme-preview-body">
                                    <span
                                      className="theme-preview-panel"
                                      style={{ background: theme.palette.panel }}
                                    />
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
                    <div className="settings-row">
                      <span className="settings-label">{t("Git 테마")}</span>
                      <div className="settings-inline theme-import">
                        <input
                          value={themeUrl}
                          spellCheck={false}
                          placeholder="https://raw.githubusercontent.com/.../theme.json"
                          onChange={(event) => setThemeUrl(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              void importTheme();
                            }
                          }}
                        />
                        <button
                          type="button"
                          disabled={themeBusy}
                          onClick={() => void importTheme()}
                        >
                          {themeBusy ? (
                            <>
                              <Spinner size={10} />
                              {t("가져오는 중")}
                            </>
                          ) : (
                            t("가져오기")
                          )}
                        </button>
                      </div>
                    </div>
                    {themeMessage ? (
                      <p className="helper theme-import-message">{themeMessage}</p>
                    ) : null}
                    <p className="helper">
                      {t("Base16, VS Code 색상 테마 JSON 또는 TablePeek 테마 JSON을 Git 원본 URL에서 가져옵니다.")}
                    </p>
                    <div className="settings-row">
                      <span className="settings-label">{t("강조 색")}</span>
                      <div className="settings-inline">
                        <input
                          type="color"
                          value={settings.accent}
                          onChange={(event) => onChange({ accent: event.target.value })}
                        />
                        <span className="mono dim">{settings.accent}</span>
                      </div>
                    </div>
                    <div className="settings-row">
                      <span className="settings-label">{t("앱 글꼴")}</span>
                      <FontSelect
                        groups={uiFontGroups}
                        value={settings.uiFontFamily}
                        preview={t("가나다 ABC 123 — 테이블과 메뉴")}
                        onChange={(uiFontFamily) => onChange({ uiFontFamily })}
                      />
                    </div>
                    <div className="settings-row">
                      <span className="settings-label">{t("에디터 글꼴")}</span>
                      <FontSelect
                        groups={codeFontGroups}
                        value={settings.fontFamily}
                        preview="SELECT id, name FROM users; -- 0O 1lI"
                        onChange={(fontFamily) => onChange({ fontFamily })}
                      />
                    </div>
                    <div className="settings-row">
                      <span className="settings-label">{t("에디터 글자 크기")}</span>
                      <Select
                        value={settings.fontSize}
                        onChange={(event) => onChange({ fontSize: Number(event.target.value) })}
                      >
                        {sizeChoices(EDITOR_FONT_MIN, EDITOR_FONT_MAX, settings.fontSize).map((size) => (
                          <option key={size} value={size}>
                            {size}px
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div className="settings-row">
                      <span className="settings-label">{t("시스템 글자 크기")}</span>
                      <Select
                        value={settings.uiFontSize}
                        onChange={(event) => onChange({ uiFontSize: Number(event.target.value) })}
                      >
                        {sizeChoices(UI_FONT_MIN, UI_FONT_MAX, settings.uiFontSize).map((size) => (
                          <option key={size} value={size}>
                            {size}px
                          </option>
                        ))}
                      </Select>
                    </div>
                    <p className="helper">
                      {t("에디터 글꼴은 SQL 에디터·콘솔·데이터 그리드에, 앱 글꼴은 메뉴·패널·탭·사이드바에 쓰입니다. 에디터 글자 크기는 SQL 에디터와 콘솔에, 시스템 글자 크기는 그 밖의 모든 곳(데이터 그리드 포함)에 적용됩니다.")}
                    </p>
                  </section>
                  <section className="settings-section">
                    <h4>{t("테이블")}</h4>
                    <label className="settings-check">
                      <input
                        type="checkbox"
                        checked={settings.rowAlt}
                        onChange={(event) => onChange({ rowAlt: event.target.checked })}
                      />
                      {t("줄무늬 행 배경")}
                    </label>
                    <label className="settings-check">
                      <input
                        type="checkbox"
                        checked={settings.typeColors}
                        onChange={(event) =>
                          onChange({ typeColors: event.target.checked })
                        }
                      />
                      {t("타입별 색상")}
                    </label>
                    <p className="helper">
                      {t("문자열·숫자·불리언·JSON·배열·날짜 값을 타입별 색으로 구분합니다.")}
                    </p>
                    {settings.typeColors ? (
                      <div className="type-preview" aria-hidden="true">
                        {VALUE_KINDS.map((kind) => (
                          <span key={kind} style={{ color: palette.typeInks[kind] }}>
                            {kind}
                          </span>
                        ))}
                        <span style={{ color: palette.nullInk }}>null</span>
                      </div>
                    ) : null}
                    <label className="settings-check">
                      <input
                        type="checkbox"
                        checked={settings.hideScroller}
                        onChange={(event) =>
                          onChange({ hideScroller: event.target.checked })
                        }
                      />
                      {t("스크롤바 자동 숨김")}
                    </label>
                  </section>
                </>
              </div>

              <div className="settings-category" hidden={category !== "editor"}>
                <section className="settings-section">
                  <h4>{t("에디터")}</h4>
                  <label className="settings-check">
                    <input
                      type="checkbox"
                      checked={settings.uppercaseKeywords}
                      onChange={(event) =>
                        onChange({ uppercaseKeywords: event.target.checked })
                      }
                    />
                    {t("SQL 정리/축약 시 키워드 대문자 변환")}
                  </label>
                  <div className="settings-row">
                    <span className="settings-label">{t("구문 강조")}</span>
                    <Select
                      value={settings.syntaxPreset}
                      onChange={(event) =>
                        onChange({
                          syntaxPreset: event.target.value as SyntaxPresetId,
                        })
                      }
                    >
                      {SYNTAX_PRESETS.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {t(preset.label)}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="syntax-preview" aria-hidden="true">
                    <span className="syntax-preview-keyword">SELECT</span>
                    <span className="syntax-preview-variable"> name</span>
                    <span className="syntax-preview-operator">,</span>
                    <span className="syntax-preview-string"> 'tablepeek'</span>
                    <span className="syntax-preview-keyword"> FROM</span>
                    <span className="syntax-preview-type"> users</span>
                    <span className="syntax-preview-comment"> -- preview</span>
                  </div>
                  <p className="helper">
                    {t(SYNTAX_PRESETS.find((preset) => preset.id === settings.syntaxPreset)?.description ?? "")}
                  </p>
                  <p className="helper">{t("자동 괄호는 기본으로 켜져 있습니다.")}</p>
                </section>
              </div>

              <div className="settings-category" hidden={category !== "data"}>
                <section className="settings-section">
                  <h4>{t("쿼리")}</h4>
                  <div className="settings-row">
                    <span className="settings-label">{t("최대 행")}</span>
                    <input
                      type="number"
                      min={1}
                      max={MAX_ROWS_LIMIT}
                      value={settings.maxRows}
                      onChange={(event) =>
                        onChange({
                          maxRows: Math.min(
                            MAX_ROWS_LIMIT,
                            Math.max(1, Math.trunc(Number(event.target.value)) || 1),
                          ),
                        })
                      }
                    />
                  </div>
                  <p className="helper">{t("쿼리 한 번에 가져오는 최대 행 수입니다.")}</p>
                </section>
                <section className="settings-section">
                  <h4>{t("가져오기 · 내보내기 기본값")}</h4>
                  <div className="settings-row">
                    <span className="settings-label">{t("CSV 구분자")}</span>
                    <Select
                      value={settings.csvDelimiter}
                      onChange={(event) =>
                        onChange({ csvDelimiter: event.target.value })
                      }
                    >
                      <option value=",">{t(", (쉼표)")}</option>
                      <option value={"	"}>Tab</option>
                      <option value=";">{t("; (세미콜론)")}</option>
                      <option value="|">{t("| (파이프)")}</option>
                    </Select>
                  </div>
                  <label className="settings-check">
                    <input
                      type="checkbox"
                      checked={settings.csvHeader}
                      onChange={(event) =>
                        onChange({ csvHeader: event.target.checked })
                      }
                    />
                    {t("첫 행을 헤더로 사용")}
                  </label>
                  <div className="settings-row">
                    <span className="settings-label">{t("인코딩")}</span>
                    <Select
                      value={settings.csvEncoding}
                      onChange={(event) =>
                        onChange({
                          csvEncoding: event.target
                            .value as AppSettings["csvEncoding"],
                        })
                      }
                    >
                      <option value="utf-8">UTF-8</option>
                      <option value="euc-kr">EUC-KR</option>
                      <option value="utf-16le">UTF-16LE</option>
                    </Select>
                  </div>
                </section>
              </div>

              <div className="settings-category" hidden={category !== "shortcuts"}>
                <section className="settings-section">
                  <h4>{t("단축키")}</h4>
                  <div className="shortcut-notice">
                    <strong>{t("TablePeek 단축키는 브라우저 기본 동작보다 먼저 실행됩니다.")}</strong>
                    <span>
                      {t("예: {save}는 페이지 저장 대신 변경사항을 적용하고, {palette}는 인쇄 대신 명령 팔레트를 엽니다.", {
                        save: formatBinding("Mod+s"),
                        palette: formatBinding("Mod+p"),
                      })}
                    </span>
                    <span>
                      {t("단, {keys}처럼 브라우저가 예약한 조합은 웹페이지가 가로챌 수 없어 브라우저 동작(탭 닫기·새 탭 등)이 먼저 실행됩니다. 이런 동작에는 대체 단축키가 함께 지정돼 있습니다.", {
                        keys: ["Mod+w", "Mod+t", "Mod+n"].map(formatBinding).join(" · "),
                      })}
                    </span>
                  </div>
                  <div className="shortcut-list">
                    {KEY_ACTIONS.map((action) => (
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
                            onClick={() => {
                              setCaptureHint(null);
                              setCapturing(capturing === action ? null : action);
                            }}
                          >
                            {capturing === action ? (captureHint ?? t("키 입력 대기…")) : t("+ 추가")}
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => setBindings(action, [...DEFAULT_KEYMAP[action]])}
                          disabled={settings.keymap[action].join("\n") === DEFAULT_KEYMAP[action].join("\n")}
                          className="settings-reset"
                          title={t("기본값으로")}
                        >
                          {t("기본")}
                        </button>
                      </div>
                    ))}
                  </div>
                  <p className="helper">
                    {t("‘+ 추가’를 누른 뒤 원하는 키 조합을 누르세요. Esc로 취소합니다. 다른 동작에 쓰이던 조합은 이쪽으로 옮겨집니다.")}
                  </p>
                  <div>
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
                </section>
              </div>

              <div className="settings-category" hidden={category !== "security"}>
                <>
                  <section className="settings-section">
                    <h4>{t("활동 로그")}</h4>
                    <div className="settings-row">
                      <span className="settings-label">{t("보관 기간(일)")}</span>
                      <input
                        type="number"
                        min={1}
                        max={90}
                        value={settings.activityDays}
                        onChange={(event) =>
                          onChange({
                            activityDays: Math.min(
                              90,
                              Math.max(1, Number(event.target.value) || 7),
                            ),
                          })
                        }
                      />
                    </div>
                  </section>
                  <section className="settings-section">
                    <h4>{t("보안")}</h4>
                  <div className="settings-row">
                    <span className="settings-label">
                      {hasPasscode ? t("암호 변경/해제") : t("잠금 암호 설정")}
                    </span>
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
                  </div>
                  <div className="settings-row settings-row-indent">
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
                    {passcodeMessage !== null ? (
                      <span className="helper">{passcodeMessage}</span>
                    ) : null}
                  </div>
                  </section>
                </>
              </div>
            </div>
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
