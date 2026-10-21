import { useCallback, useRef, useState } from "react";
import { t } from "../i18n";
import type { SafeMode } from "../sqlTools";
import { useMenuDismiss } from "./Dropdowns";
import { CheckIcon, ChevronDownIcon, ShieldIcon } from "./icons";

export const SAFE_MODE_LABELS: Record<SafeMode, { short: string; title: string; description: string }> = {
  0: {
    short: "끔",
    title: "안전 모드 끔",
    description: "모든 쿼리를 확인 없이 바로 실행합니다.",
  },
  1: {
    short: "위험만 확인",
    title: "위험한 쿼리만 확인",
    description: "WHERE 없는 UPDATE·DELETE, DROP, TRUNCATE, ALTER를 실행하기 전에 검토 창을 띄웁니다.",
  },
  2: {
    short: "모든 변경 확인",
    title: "모든 변경 확인",
    description:
      "조회(SELECT·EXPLAIN·SHOW)를 뺀 모든 쿼리와 그리드 변경사항 적용 전에 확인합니다.",
  },
};

const LEVELS: SafeMode[] = [0, 1, 2];

interface SafeModeMenuProps {
  mode: SafeMode;
  onChange(mode: SafeMode): void;
  // Shield only, for the tab bar; the level shows as its colour.
  compact?: boolean;
}

export function SafeModeMenu({ mode, onChange, compact = false }: SafeModeMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dismiss = useCallback(() => setOpen(false), []);
  useMenuDismiss(open, rootRef, dismiss);

  return (
    <div className="safe-mode" ref={rootRef}>
      <button
        type="button"
        className={`safe-mode-button level-${mode}${open ? " open" : ""}${compact ? " compact" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={`${t("안전 모드")}: ${t(SAFE_MODE_LABELS[mode].title)}`}
      >
        <ShieldIcon size={compact ? 13 : 12} />
        {compact ? null : (
          <>
            <span>{t(SAFE_MODE_LABELS[mode].short)}</span>
            <ChevronDownIcon size={9} />
          </>
        )}
      </button>
      {open ? (
        <div className="menu-panel safe-mode-panel" role="menu" aria-label={t("안전 모드")}>
          <div className="safe-mode-heading">
            {t("안전 모드")}
            <span className="safe-mode-scope">{t("이 연결에만 적용")}</span>
          </div>
          {LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              role="menuitemradio"
              aria-checked={mode === level}
              className={`safe-mode-option level-${level}${mode === level ? " active" : ""}`}
              onClick={() => {
                onChange(level);
                setOpen(false);
              }}
            >
              <span className="safe-mode-option-mark" aria-hidden="true">
                <ShieldIcon size={12} />
              </span>
              <span className="safe-mode-option-text">
                <span className="safe-mode-option-title">{t(SAFE_MODE_LABELS[level].title)}</span>
                <span className="safe-mode-option-desc">{t(SAFE_MODE_LABELS[level].description)}</span>
              </span>
              {mode === level ? <CheckIcon size={11} className="safe-mode-option-check" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
