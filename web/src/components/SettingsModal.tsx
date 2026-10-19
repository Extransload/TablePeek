import { useEffect, useState, type ReactElement } from "react";
import { languageLabel, t, type Language } from "../i18n";
import { THEMES, themeFromJson } from "../palette";
import {
  DEFAULT_KEYMAP,
  KEY_ACTION_LABELS,
  getPasscodeHash,
  setPasscodeHash,
  sha256Hex,
  type AppSettings,
  type KeyAction,
} from "../settings";
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

const KEY_ACTIONS: KeyAction[] = [
  "run",
  "newTab",
  "closeTab",
  "palette",
  "dbSwitch",
];

const FONT_CHOICES = [
  {
    label: "시스템 고정폭",
    value: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  },
  { label: "Menlo", value: "Menlo, Monaco, monospace" },
  { label: "SF Mono", value: '"SF Mono", ui-monospace, monospace' },
  { label: "Courier New", value: '"Courier New", Courier, monospace' },
];

function bindingFromEvent(event: KeyboardEvent): string | null {
  if (["Meta", "Control", "Shift", "Alt"].includes(event.key)) {
    return null;
  }
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) {
    parts.push("Mod");
  }
  if (event.shiftKey) {
    parts.push("Shift");
  }
  if (event.altKey) {
    parts.push("Alt");
  }
  let key = event.key;
  if (key === " ") {
    key = "Space";
  } else if (key.length === 1) {
    key = key.toLowerCase();
  }
  parts.push(key);
  return parts.join("+");
}

export function SettingsModal({
  settings,
  onChange,
  onLock,
  onClose,
}: SettingsModalProps) {
  const [capturing, setCapturing] = useState<KeyAction | null>(null);
  const [passcode, setPasscode] = useState("");
  const [passcodeConfirm, setPasscodeConfirm] = useState("");
  const [passcodeMessage, setPasscodeMessage] = useState<string | null>(null);
  const [hasPasscode, setHasPasscode] = useState(
    () => getPasscodeHash() !== null,
  );
  const [themeUrl, setThemeUrl] = useState("");
  const [themeMessage, setThemeMessage] = useState<string | null>(null);
  const [themeBusy, setThemeBusy] = useState(false);
  const [category, setCategory] = useState<SettingsCategory>("general");

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
        return;
      }
      const binding = bindingFromEvent(event);
      if (binding === null) {
        return;
      }
      onChange({ keymap: { ...settings.keymap, [action]: binding } });
      setCapturing(null);
    }
    window.addEventListener("keydown", onCapture, true);
    return () => window.removeEventListener("keydown", onCapture, true);
  }, [capturing, settings.keymap, onChange]);

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
          ? `가져오지 못했습니다: ${err.message}`
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
          <span className="modal-path">wrendb</span>
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
                    <div className="theme-grid">
                      {THEMES.map((theme) => (
                        <button
                          key={theme.id}
                          type="button"
                          data-theme-id={theme.id}
                          className={`theme-card${settings.theme === theme.id ? " active" : ""}`}
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
                          <span className="theme-mode">
                            {theme.mode === "light" ? "Light" : "Dark"}
                          </span>
                        </button>
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
                      {t("Base16, VS Code 색상 테마 JSON 또는 WrenDB 테마 JSON을 Git 원본 URL에서 가져옵니다.")}
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
                      <span className="settings-label">{t("폰트")}</span>
                      <select
                        value={settings.fontFamily}
                        onChange={(event) =>
                          onChange({ fontFamily: event.target.value })
                        }
                      >
                        {FONT_CHOICES.map((choice) => (
                          <option key={choice.value} value={choice.value}>
                            {t(choice.label)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="settings-row">
                      <span className="settings-label">{t("글자 크기")}</span>
                      <input
                        type="number"
                        min={10}
                        max={18}
                        value={settings.fontSize}
                        onChange={(event) =>
                          onChange({
                            fontSize: Math.min(
                              18,
                              Math.max(10, Number(event.target.value) || 12),
                            ),
                          })
                        }
                      />
                    </div>
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
                    <select
                      value={settings.syntaxPreset}
                      onChange={(event) =>
                        onChange({
                          syntaxPreset: event.target.value as SyntaxPresetId,
                        })
                      }
                    >
                      {SYNTAX_PRESETS.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="syntax-preview" aria-hidden="true">
                    <span className="syntax-preview-keyword">SELECT</span>
                    <span className="syntax-preview-variable"> name</span>
                    <span className="syntax-preview-operator">,</span>
                    <span className="syntax-preview-string"> 'wrendb'</span>
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
                  <h4>{t("가져오기 · 내보내기 기본값")}</h4>
                  <div className="settings-row">
                    <span className="settings-label">{t("CSV 구분자")}</span>
                    <select
                      value={settings.csvDelimiter}
                      onChange={(event) =>
                        onChange({ csvDelimiter: event.target.value })
                      }
                    >
                      <option value=",">{t(", (쉼표)")}</option>
                      <option value={"	"}>Tab</option>
                      <option value=";">{t("; (세미콜론)")}</option>
                      <option value="|">{t("| (파이프)")}</option>
                    </select>
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
                    <select
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
                    </select>
                  </div>
                </section>
              </div>

              <div className="settings-category" hidden={category !== "shortcuts"}>
                <section className="settings-section">
                  <h4>{t("단축키")}</h4>
                  {KEY_ACTIONS.map((action) => (
                    <div className="settings-row" key={action}>
                      <span className="settings-label">
                        {t(KEY_ACTION_LABELS[action])}
                      </span>
                      <button
                        type="button"
                        className={capturing === action ? "active" : ""}
                        onClick={() => setCapturing(action)}
                      >
                        {capturing === action
                          ? t("키 입력 대기…")
                          : settings.keymap[action]}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          onChange({
                            keymap: {
                              ...settings.keymap,
                              [action]: DEFAULT_KEYMAP[action],
                            },
                          })
                        }
                        className="settings-reset"
                        title={t("기본값")}
                      >
                        {t("기본")}
                      </button>
                    </div>
                  ))}
                  <p className="helper">
                    {t("버튼을 누른 뒤 원하는 키 조합을 누르세요. Esc로 취소합니다.")}
                  </p>
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
                  <div className="settings-row">
                    <button type="button" onClick={() => void applyPasscode()}>
                      {hasPasscode ? t("변경") : t("설정")}
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
