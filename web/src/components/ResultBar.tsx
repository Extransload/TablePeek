import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { QueryMeta } from "../net/socket";
import type { AppError, ErrorAction } from "../errorHelp";
import { t, tServer } from "../i18n";
import { DURATION, EASE, animate, useExitGhost } from "../motion";
import { ErrorNotice } from "./ErrorNotice";
import { CheckIcon, DownloadIcon } from "./icons";
import { RollingNumber } from "./RollingNumber";
import { Spinner } from "./Spinner";

// Chart and Pivot show the same rows as the Data grid, summarised.
export type ResultView = "grid" | "chart" | "pivot" | "message" | "plan";

// What the query tab in front last ran to: rows, a failure, or a note in
// place of rows (cancelled, expired).
export type ShownResult =
  | { kind: "ok"; meta: QueryMeta }
  | { kind: "error" }
  | { kind: "note"; text: string };

// One executed statement, as the Message view lists it.
export interface StatementMessage {
  label: string;
  // Shown on hover; empty when the editor already holds it.
  sql: string;
  outcome: { kind: "ok"; meta: QueryMeta } | { kind: "error"; error: AppError } | { kind: "cancelled" };
}

// "12 ms", or seconds from one second up.
export function elapsedText(ms: number): string {
  if (ms < 1) {
    return "< 1 ms";
  }
  if (ms < 999.5) {
    return `${Math.round(ms)} ms`;
  }
  const seconds = ms / 1000;
  return `${seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1)} s`;
}

// "2행" ("10,000+행" when cut at the row limit), or for a statement with no
// result columns its affected rows, "완료" where the driver gives no count.
export function statementStatus(meta: QueryMeta): string {
  if (meta.columns.length > 0) {
    const count = meta.rowCount.toLocaleString();
    return meta.truncated ? t("{count}+행", { count }) : t("{count}행", { count });
  }
  return meta.rowsAffected !== undefined
    ? t("{count}행 영향", { count: meta.rowsAffected.toLocaleString() })
    : t("완료");
}

interface ResultBarProps {
  view: ResultView;
  // An EXPLAIN's result also has its plan to switch to.
  planAvailable: boolean;
  shown: ShownResult | null;
  // The tab's query is running: the status says so, then turns into its result.
  running: boolean;
  canExport: boolean;
  onView(view: ResultView): void;
  onExport(): void;
}

// One status turning into the next: the old words lift away and blur out as
// the new ones rise into focus in their place.
const STATUS_ENTER: Keyframe[] = [
  { opacity: 0, transform: "translateY(5px)", filter: "blur(4px)" },
  { opacity: 1, transform: "none", filter: "blur(0)" },
];
const STATUS_LEAVE: Keyframe[] = [
  { opacity: 1, transform: "none", filter: "blur(0)" },
  { opacity: 0, transform: "translateY(-5px)", filter: "blur(4px)" },
];

// The status line, keyed by what it says (running, rows, failure, note), so a
// new kind of status morphs in over the one it replaces.
function MorphStatus({ className, title, children }: { className: string; title?: string; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  useExitGhost(ref, STATUS_LEAVE, { duration: DURATION.slow, easing: EASE.out });
  useLayoutEffect(() => {
    const element = ref.current;
    const entering =
      element === null ? null : animate(element, STATUS_ENTER, { duration: DURATION.slower, easing: EASE.spring });
    return () => entering?.cancel();
  }, []);
  return (
    <span ref={ref} className={className} title={title}>
      {children}
    </span>
  );
}

// The query result's footer, laid out as the Data view's: TablePlus's
// Data | Message switch (with Chart and Pivot of the rows beside Data), the
// rows and time of the result shown, and Export.
export function ResultBar({ view, planAvailable, shown, running, canExport, onView, onExport }: ResultBarProps) {
  const views: [ResultView, string][] = [
    ["grid", t("데이터")],
    ["chart", t("차트")],
    ["pivot", t("피벗")],
    ...(planAvailable ? ([["plan", t("계획")]] as [ResultView, string][]) : []),
    ["message", t("메시지")],
  ];
  return (
    <div className="data-toolbar result-bar">
      <div className="footer-start">
        <div className="view-tabs">
          {views.map(([key, label]) => (
            <button
              type="button"
              key={key}
              className={view === key ? "active" : ""}
              aria-pressed={view === key}
              onClick={() => onView(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="footer-middle">
        {running ? (
          <MorphStatus key="running" className="row-range result-bar-status running">
            <Spinner size={10} />
            <span>{t("실행 중…")}</span>
          </MorphStatus>
        ) : shown === null ? null : shown.kind === "error" ? (
          <MorphStatus key="error" className="row-range result-bar-status failed">
            {t("오류")}
          </MorphStatus>
        ) : shown.kind === "note" ? (
          <MorphStatus key={`note:${shown.text}`} className="row-range result-bar-status" title={tServer(shown.text)}>
            {tServer(shown.text)}
          </MorphStatus>
        ) : (
          <MorphStatus key="ok" className="row-range result-bar-status done">
            <CheckIcon size={11} className="result-bar-done" />
            <span
              className={shown.meta.truncated ? "warn" : undefined}
              title={
                shown.meta.truncated
                  ? t("최대 {count}행까지만 가져왔습니다", { count: shown.meta.rowCount.toLocaleString() })
                  : undefined
              }
            >
              <RollingNumber value={statementStatus(shown.meta)} />
            </span>
            <RollingNumber className="result-bar-time" value={elapsedText(shown.meta.elapsedMs)} />
          </MorphStatus>
        )}
      </div>
      <div className="footer-end">
        <button
          type="button"
          className="icon-button"
          disabled={!canExport}
          onClick={onExport}
          title={t("결과 내보내기…")}
          aria-label={t("결과 내보내기…")}
        >
          <DownloadIcon size={12} />
        </button>
      </div>
    </div>
  );
}

// The Message view: a line per executed statement ("결과 2: 1행 영향 · 3 ms"),
// a failure's explanation under its line, and where in the editor it failed
// when the server says (a click puts the cursor there).
export function StatementMessages({
  entries,
  errorSpot,
  onRevealError,
  onFix,
}: {
  entries: StatementMessage[];
  errorSpot?(error: AppError): { line: number; column: number } | undefined;
  onRevealError?(): void;
  // One-click fixes the editor can apply (refresh the schema, say).
  onFix?: Partial<Record<ErrorAction, () => void>>;
}) {
  if (entries.length === 0) {
    return null;
  }
  return (
    <ol className="result-messages">
      {entries.map((entry) => {
        const { outcome } = entry;
        return (
          <li
            key={entry.label}
            className={`result-message${outcome.kind === "error" ? " failed" : ""}`}
            title={entry.sql.length > 400 ? `${entry.sql.slice(0, 400)}…` : entry.sql || undefined}
          >
            <div className="result-message-line">
              <span className="result-message-label">{entry.label}:</span>
              {outcome.kind === "ok" ? (
                <>
                  <span>{statementStatus(outcome.meta)}</span>
                  <span className="result-message-time">· {elapsedText(outcome.meta.elapsedMs)}</span>
                </>
              ) : outcome.kind === "error" ? (
                <>
                  <span className="result-message-error">{t("오류")}</span>
                  {(() => {
                    const spot = errorSpot?.(outcome.error);
                    return spot === undefined ? null : (
                      <button type="button" className="result-message-spot" onClick={onRevealError}>
                        {t("{line}번째 줄, {column}번째 글자", spot)}
                      </button>
                    );
                  })()}
                </>
              ) : (
                <span>{t("취소됨")}</span>
              )}
            </div>
            {outcome.kind === "error" ? <ErrorNotice error={outcome.error} context="editor" onFix={onFix} /> : null}
          </li>
        );
      })}
    </ol>
  );
}
