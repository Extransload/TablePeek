import { useEffect, useMemo, useState } from "react";
import { decodeWith, ENCODINGS, hexDump, textBytes } from "../encoding";
import { t } from "../i18n";
import { store, type GridResult } from "../store";
import { CloseIcon } from "./icons";
import { JsonTree } from "./JsonTree";
import { Spinner } from "./Spinner";

interface CellQuickLookProps {
  result: GridResult;
  row: number;
  col: number;
  table: string | null;
  onClose(): void;
}

type QuickTab = "value" | "json" | "encoding";

function valueText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function structuredJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (
    !(
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    )
  ) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function CellQuickLook({ result, row, col, table, onClose }: CellQuickLookProps) {
  const [tab, setTab] = useState<QuickTab>("value");
  const [encoding, setEncoding] = useState("utf-8");
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const value = result.source.cell(row, col);
  const loading = value === undefined;
  const column = result.meta.columns[col] ?? `#${col + 1}`;
  const editable =
    result.meta.sourceTable !== null && result.meta.pk !== null && result.meta.pk.length > 0;

  useEffect(() => {
    const initial = valueText(result.source.cell(row, col));
    setDraft(initial);
    setTab(structuredJson(initial) === null ? "value" : "json");
    setDirty(false);
    setMessage(null);
  }, [result, row, col]);

  useEffect(() => {
    if (!dirty) {
      setDraft(valueText(value));
    }
  }, [value, dirty]);

  useEffect(() => {
    const unsubscribe = result.source.onUpdate?.(() => setNonce((current) => current + 1));
    return unsubscribe;
  }, [result]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const bytes = useMemo(() => textBytes(valueText(value)), [value, nonce]);
  const decoded = useMemo(() => decodeWith(bytes, encoding), [bytes, encoding]);
  const dump = useMemo(() => hexDump(bytes), [bytes]);
  const jsonValue = useMemo(() => structuredJson(draft), [draft]);
  const jsonValid = jsonValue !== null;

  async function save(): Promise<void> {
    if (!editable || saving || loading || !dirty) {
      return;
    }
    setSaving(true);
    const outcome = await store.editCell(row, col, draft);
    setSaving(false);
    if (outcome !== null) {
      setDirty(false);
      setMessage(t("저장했습니다"));
    } else {
      setMessage(store.getState().error ?? store.getState().info ?? t("저장하지 못했습니다"));
    }
  }

  async function saveNull(): Promise<void> {
    if (!editable || saving || loading) {
      return;
    }
    setSaving(true);
    const outcome = await store.editCell(row, col, null);
    setSaving(false);
    if (outcome !== null) {
      setDraft("");
      setDirty(false);
      setMessage(t("NULL로 저장했습니다"));
    } else {
      setMessage(store.getState().error ?? store.getState().info ?? t("저장하지 못했습니다"));
    }
  }

  function prettify(): void {
    try {
      setDraft(JSON.stringify(JSON.parse(draft), null, 2));
      setDirty(true);
      setMessage(t("JSON을 정리했습니다"));
    } catch {
      setMessage(t("유효한 JSON이 아닙니다"));
    }
  }

  async function copy(text: string, label = t("복사했습니다")): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setMessage(label);
    } catch {
      setMessage(t("클립보드에 복사하지 못했습니다"));
    }
  }

  return (
    <aside className="quicklook-drawer" aria-label="Quick Look" data-cell-quicklook>
      <header className="quicklook-head">
        <div className="quicklook-heading">
          <span className="quicklook-title">Quick Look</span>
          <span className="quicklook-path">
            {table ? `${table}.` : ""}
            <strong>{column}</strong>
            <span className="quicklook-row">row {row + 1}</span>
          </span>
        </div>
        <button type="button" className="icon-button" onClick={onClose} title={t("닫기 (Esc)")}>
          <CloseIcon size={11} />
        </button>
      </header>

      <div className="quicklook-tabbar">
        <div className="quicklook-tabs">
          <button
            type="button"
            className={tab === "value" ? "active" : ""}
            onClick={() => {
              setTab("value");
              setMessage(null);
            }}
          >
            {t("값")}
          </button>
          <button
            type="button"
            className={tab === "json" ? "active" : ""}
            onClick={() => {
              setTab("json");
              setMessage(null);
            }}
          >
            JSON
          </button>
          <button
            type="button"
            className={tab === "encoding" ? "active" : ""}
            onClick={() => {
              setTab("encoding");
              setMessage(null);
            }}
          >
            {t("인코딩 / HEX")}
          </button>
        </div>
        <span className="spacer" />
        <span className={`quicklook-type${jsonValid ? " json" : ""}`}>
          {loading ? "loading" : value === null ? "NULL" : jsonValid ? "JSON" : typeof value}
        </span>
      </div>

      {tab === "value" ? (
        <div className="quicklook-body">
          <div className="quicklook-meta">
            <span>{loading ? t("불러오는 중…") : value === null ? "NULL" : typeof value}</span>
            <span>{t("{count}자", { count: draft.length.toLocaleString() })}</span>
            {jsonValid ? (
              <button type="button" className="quicklook-text-button" onClick={() => setTab("json")}>
                {t("트리 보기")}
              </button>
            ) : null}
            <span className="spacer" />
            {jsonValid ? (
              <button type="button" className="quicklook-text-button" onClick={prettify}>
                {t("JSON 정리")}
              </button>
            ) : null}
            <button type="button" className="quicklook-text-button" onClick={() => void copy(draft)}>
              {t("복사")}
            </button>
          </div>
          <textarea
            className="quicklook-editor"
            value={draft}
            placeholder={value === null ? "NULL" : ""}
            spellCheck={false}
            readOnly={!editable || loading}
            onChange={(event) => {
              setDraft(event.target.value);
              setDirty(true);
              setMessage(null);
            }}
          />
        </div>
      ) : tab === "json" ? (
        <div className="quicklook-body quicklook-json-body">
          <div className="quicklook-meta">
            <span>{t("구조화된 JSON")}</span>
            {jsonValid ? <span className="dim">{t("경로를 복사하려면 각 행의 복사 버튼을 사용하세요")}</span> : null}
            <span className="spacer" />
            {jsonValid ? (
              <>
                <button type="button" className="quicklook-text-button" onClick={prettify}>
                  {t("정리")}
                </button>
                <button
                  type="button"
                  className="quicklook-text-button"
                  onClick={() => void copy(JSON.stringify(jsonValue, null, 2), t("JSON 전체를 복사했습니다"))}
                >
                  {t("전체 복사")}
                </button>
              </>
            ) : null}
          </div>
          {jsonValid ? (
            <JsonTree value={jsonValue} />
          ) : (
            <div className="quicklook-empty">
              <span>{t("유효한 JSON 객체 또는 배열이 아닙니다.")}</span>
              <button type="button" className="quicklook-text-button" onClick={() => setTab("value")}>
                {t("값 탭에서 수정")}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="quicklook-body encoding-body">
          <div className="quicklook-meta">
            <label className="quicklook-encoding">
              <span>{t("보기 인코딩")}</span>
              <select value={encoding} onChange={(event) => setEncoding(event.target.value)}>
                {ENCODINGS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <span>{bytes.length.toLocaleString()} bytes</span>
            <span className="spacer" />
            <button type="button" className="quicklook-text-button" onClick={() => void copy(decoded)}>
              {t("텍스트 복사")}
            </button>
            <button type="button" className="quicklook-text-button" onClick={() => void copy(dump)}>
              {t("HEX 복사")}
            </button>
          </div>
          <div className="quicklook-encoding-grid">
            <div>
              <div className="quicklook-section-title">{t("텍스트")}</div>
              <pre className="quicklook-pre">{decoded || " "}</pre>
            </div>
            <div>
              <div className="quicklook-section-title">HEX</div>
              <pre className="quicklook-pre hex">{dump || " "}</pre>
            </div>
          </div>
          <p className="quicklook-note">
            {t("현재 표시 값의 UTF-8 바이트를 선택한 인코딩으로 다시 읽은 결과입니다. 원본 DB 바이트가 아닐 수 있습니다.")}
          </p>
        </div>
      )}

      <footer className="modal-foot quicklook-foot">
        <span className={message === null ? "quicklook-hint" : "quicklook-message"}>
          {message ??
            (editable
              ? t("⌘Enter 저장 · Esc 닫기 · 가운데 클릭으로 열기")
              : t("읽기 전용 · Esc 닫기 · 가운데 클릭으로 열기"))}
        </span>
        {tab !== "encoding" ? (
          <>
            <button
              type="button"
              onClick={() => void saveNull()}
              disabled={!editable || saving || loading}
            >
              NULL
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => void save()}
              disabled={!editable || saving || loading || !dirty}
            >
              {saving ? (
                <>
                  <Spinner size={10} />
                  {t("저장 중")}
                </>
              ) : (
                t("저장")
              )}
            </button>
          </>
        ) : null}
        {loading ? <Spinner size={12} label={t("셀 불러오는 중")} /> : null}
        <button type="button" className="icon-button" onClick={onClose} title={t("닫기")}>
          <CloseIcon size={11} />
        </button>
      </footer>
      {loading ? (
        <div className="quicklook-loading">
          <Spinner size={18} label={t("셀 불러오는 중")} />
        </div>
      ) : null}
    </aside>
  );
}
