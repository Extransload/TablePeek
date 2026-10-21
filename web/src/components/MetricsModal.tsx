import { useEffect, useState } from "react";
import { t } from "../i18n";
import { store, type HistoryEntry } from "../store";
import { ErrorNotice } from "./ErrorNotice";

interface MetricsModalProps {
  conn: string;
  onClose(): void;
}

// Figures for the statements run on one connection, read from its history.
export function MetricsModal({ conn, onClose }: MetricsModalProps) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    store
      .fetchHistory(conn, 200)
      // History arrives newest first; the chart reads left to right in time.
      .then((history) => alive && setEntries(history.slice().reverse()))
      .catch((err: unknown) => {
        if (alive) {
          setEntries([]);
          setError(err instanceof Error && err.message ? err.message : t("기록을 불러오지 못했습니다"));
        }
      });
    return () => {
      alive = false;
    };
  }, [conn]);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const total = entries.length;
  const errors = entries.filter((entry) => !entry.ok).length;
  const totalMs = entries.reduce((sum, entry) => sum + entry.ms, 0);
  const avg = total === 0 ? 0 : Math.round(totalMs / total);
  const max = entries.reduce((value, entry) => Math.max(value, entry.ms), 0);
  const rows = entries.reduce((sum, entry) => sum + entry.rows, 0);
  const recent = entries.slice(-30);
  const peak = Math.max(1, ...recent.map((entry) => entry.ms));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal metrics-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">Metrics</span>
          <span className="modal-path">{t("최근 쿼리 기준")}</span>
        </div>
        <div className="modal-body metrics-body">
          <div className="metrics-cards">
            <div className="metrics-card">
              <span className="metrics-value">{total.toLocaleString()}</span>
              <span className="dim">{t("쿼리 수")}</span>
            </div>
            <div className="metrics-card">
              <span className="metrics-value">{avg.toLocaleString()}ms</span>
              <span className="dim">{t("평균 시간")}</span>
            </div>
            <div className="metrics-card">
              <span className="metrics-value">{max.toLocaleString()}ms</span>
              <span className="dim">{t("최대 시간")}</span>
            </div>
            <div className="metrics-card">
              <span className="metrics-value">{rows.toLocaleString()}</span>
              <span className="dim">{t("반환 행")}</span>
            </div>
            <div className="metrics-card">
              <span className={`metrics-value${errors > 0 ? " error" : ""}`}>
                {errors.toLocaleString()}
              </span>
              <span className="dim">{t("오류")}</span>
            </div>
          </div>
          <div className="metrics-chart">
            {recent.length === 0 ? (
              <div className="log-empty">{t("쿼리를 실행하면 차트가 표시됩니다")}</div>
            ) : (
              <svg viewBox={`0 0 ${recent.length * 12} 100`} preserveAspectRatio="none">
                {recent.map((entry, index) => {
                  const height = Math.max(2, Math.round((entry.ms / peak) * 96));
                  return (
                    <rect
                      key={`${entry.at}-${index}`}
                      x={index * 12 + 1}
                      y={100 - height}
                      width={9}
                      height={height}
                      rx={1}
                      fill={entry.ok ? "var(--accent)" : "var(--error)"}
                    >
                      <title>{`${entry.ms}ms · ${entry.sql.slice(0, 120)}`}</title>
                    </rect>
                  );
                })}
              </svg>
            )}
          </div>
          {error !== null ? <ErrorNotice message={error} variant="compact" /> : null}
          <p className="helper">{t("이 연결에서 최근 실행한 쿼리 30개의 실행 시간입니다.")}</p>
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
