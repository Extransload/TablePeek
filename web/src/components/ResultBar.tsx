import type { QueryMeta } from "../net/socket";
import { t, tServer } from "../i18n";
import { ErrorNotice } from "./ErrorNotice";
import { DownloadIcon } from "./icons";

export type ResultView = "grid" | "message" | "plan";

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
  outcome: { kind: "ok"; meta: QueryMeta } | { kind: "error"; error: string } | { kind: "cancelled" };
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
  canExport: boolean;
  onView(view: ResultView): void;
  onExport(): void;
}

// The query result's footer, laid out as the Data view's: TablePlus's
// Data | Message switch, the rows and time of the result shown, and Export.
export function ResultBar({ view, planAvailable, shown, canExport, onView, onExport }: ResultBarProps) {
  const views: [ResultView, string][] = planAvailable
    ? [
        ["grid", t("데이터")],
        ["plan", t("계획")],
        ["message", t("메시지")],
      ]
    : [
        ["grid", t("데이터")],
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
        {shown === null ? null : shown.kind === "error" ? (
          <span className="row-range result-bar-status failed">{t("오류")}</span>
        ) : shown.kind === "note" ? (
          <span className="row-range result-bar-status" title={tServer(shown.text)}>
            {tServer(shown.text)}
          </span>
        ) : (
          <span className="row-range result-bar-status">
            <span
              className={shown.meta.truncated ? "warn" : undefined}
              title={
                shown.meta.truncated
                  ? t("최대 {count}행까지만 가져왔습니다", { count: shown.meta.rowCount.toLocaleString() })
                  : undefined
              }
            >
              {statementStatus(shown.meta)}
            </span>
            <span className="result-bar-time">{elapsedText(shown.meta.elapsedMs)}</span>
          </span>
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
// a failure's explanation under its line.
export function StatementMessages({ entries }: { entries: StatementMessage[] }) {
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
                <span className="result-message-error">{t("오류")}</span>
              ) : (
                <span>{t("취소됨")}</span>
              )}
            </div>
            {outcome.kind === "error" ? <ErrorNotice message={outcome.error} /> : null}
          </li>
        );
      })}
    </ol>
  );
}
