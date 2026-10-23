import { useState } from "react";
import { t } from "../i18n";
import { MAX_ROWS_LIMIT } from "../settings";
import { withHint } from "../shortcuts";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { ChevronIcon, PlayIcon, StopIcon } from "./icons";

interface EditorActionsProps {
  // Rows a run fetches at most; MAX_ROWS_LIMIT reads as "No limit".
  limit: number;
  running: boolean;
  runHint: string;
  runAllHint: string;
  beautifyHint: string;
  onLimit(limit: number): void;
  onRun(scope: "current" | "all"): void;
  onStop(): void;
  onFormat(mode: "beautify" | "minify"): void;
  onExplain(): void;
}

const LIMITS = [100, 300, 500, 1000, 5000, 10000, 50000];

interface OpenMenu {
  x: number;
  y: number;
  anchor: Element;
  items: ContextMenuItem[];
}

// The editor bar's right end, as in TablePlus: the row limit, Beautify and
// Run Current, each with the rest of its choices behind ⌄.
export function EditorActions({
  limit,
  running,
  runHint,
  runAllHint,
  beautifyHint,
  onLimit,
  onRun,
  onStop,
  onFormat,
  onExplain,
}: EditorActionsProps) {
  const [menu, setMenu] = useState<OpenMenu | null>(null);

  function open(anchor: Element, items: ContextMenuItem[]): void {
    if (menu?.anchor === anchor) {
      setMenu(null);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    setMenu({ x: rect.left, y: rect.bottom + 4, anchor, items });
  }

  const limitLabel = limit >= MAX_ROWS_LIMIT ? t("제한 없음") : t("최대 {count}행", { count: limit.toLocaleString() });
  const choices = [MAX_ROWS_LIMIT, ...(LIMITS.includes(limit) || limit >= MAX_ROWS_LIMIT ? [] : [limit]), ...LIMITS]
    .filter((value, index, list) => list.indexOf(value) === index)
    .sort((a, b) => (a === MAX_ROWS_LIMIT ? -1 : b === MAX_ROWS_LIMIT ? 1 : a - b));

  return (
    <div className="editor-actions">
      <button
        type="button"
        className="split-button"
        title={t("한 번에 가져올 최대 행 수 (제한 없음도 {count}행에서 멈춤)", { count: MAX_ROWS_LIMIT.toLocaleString() })}
        onClick={(event) =>
          open(
            event.currentTarget,
            choices.map((value) => ({
              label:
                value >= MAX_ROWS_LIMIT
                  ? t("제한 없음 (최대 {count}행)", { count: MAX_ROWS_LIMIT.toLocaleString() })
                  : t("최대 {count}행", { count: value.toLocaleString() }),
              checked: value === limit,
              onSelect: () => onLimit(value),
            })),
          )
        }
      >
        <span className="split-main">{limitLabel}</span>
        <span className="split-arrow" aria-hidden="true">
          <ChevronIcon size={9} />
        </span>
      </button>
      <span className="split-button">
        <button
          type="button"
          className="split-main"
          onClick={() => onFormat("beautify")}
          title={withHint(t("SQL 정리 (Beautify)"), beautifyHint)}
        >
          {t("포맷")}
          <span className="split-hint">{beautifyHint}</span>
        </button>
        <button
          type="button"
          className="split-arrow"
          aria-label={t("포맷 방식")}
          onClick={(event) =>
            open(event.currentTarget, [
              { label: `${t("SQL 정리 (Beautify)")}  ${beautifyHint}`, onSelect: () => onFormat("beautify") },
              { label: t("SQL 축약 (Minify)"), onSelect: () => onFormat("minify") },
            ])
          }
        >
          <ChevronIcon size={9} />
        </button>
      </span>
      <span className="split-button primary">
        {running ? (
          <button type="button" className="split-main" onClick={onStop} title={t("정지")}>
            <StopIcon size={10} />
            {t("정지")}
          </button>
        ) : (
          <button
            type="button"
            className="split-main"
            onClick={() => onRun("current")}
            title={withHint(t("현재 쿼리 실행"), runHint)}
          >
            <PlayIcon size={10} />
            {t("현재 쿼리 실행")}
            <span className="split-hint">{runHint}</span>
          </button>
        )}
        <button
          type="button"
          className="split-arrow"
          aria-label={t("실행 방식")}
          onClick={(event) =>
            open(event.currentTarget, [
              { label: `${t("현재 쿼리 실행")}  ${runHint}`, disabled: running, onSelect: () => onRun("current") },
              { label: `${t("모든 쿼리 실행")}  ${runAllHint}`, disabled: running, onSelect: () => onRun("all") },
              { label: t("실행 계획"), separatorBefore: true, disabled: running, onSelect: onExplain },
            ])
          }
        >
          <ChevronIcon size={9} />
        </button>
      </span>
      {menu !== null ? (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} anchor={menu.anchor} onClose={() => setMenu(null)} />
      ) : null}
    </div>
  );
}
