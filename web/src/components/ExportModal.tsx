import { useEffect, useState } from "react";
import { buildDataSqlUnlimited } from "../dataQuery";
import {
  collectRows,
  downloadBlob,
  EXPORT_MAX_ROWS,
  EXPORT_MIME,
  suggestFilename,
  toCsv,
  toJson,
  toSqlInserts,
  toXml,
  type ExportFormat,
} from "../export";
import { store, type GridResult } from "../store";
import { dataPageInfo, type DataTab } from "../tabs";
import { getSettings } from "../settings";
import type { WindowedRowSource } from "../grid/windowSource";

interface ExportModalProps {
  conn: string;
  title: string;
  result: GridResult;
  dataTab: DataTab | null;
  kind: string;
  onClose(): void;
}

type Scope = "loaded" | "all";

function errorOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function ExportModal({ conn, title, result, dataTab, kind, onClose }: ExportModalProps) {
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [scope, setScope] = useState<Scope>("loaded");
  const [csvHeader, setCsvHeader] = useState(() => getSettings().csvHeader);
  const [csvBom, setCsvBom] = useState(false);
  const [csvDelimiter, setCsvDelimiter] = useState(() => getSettings().csvDelimiter);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const table = dataTab ? dataTab.table : result.meta.sourceTable;
  const loadedRows = result.meta.rowCount;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape" && !busy) {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [busy, onClose]);

  function maxRowsForAll(): number {
    if (!dataTab) {
      return Math.min(Math.max(1, result.meta.rowCount), EXPORT_MAX_ROWS);
    }
    const info = dataPageInfo(dataTab, dataTab.count ?? null);
    if (info.rows !== null && !info.truncated) {
      return Math.min(Math.max(1, info.rows), EXPORT_MAX_ROWS);
    }
    return EXPORT_MAX_ROWS;
  }

  async function run(): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    setProgress(null);
    let detached: WindowedRowSource | null = null;
    try {
      let source = result.source;
      let columns = result.meta.columns;
      if (scope === "all") {
        const sql = dataTab
          ? buildDataSqlUnlimited({
              kind,
              table: dataTab.table,
              filter: dataTab.filter,
              sorts: dataTab.sorts,
              pk: dataTab.pkColumns ?? dataTab.meta?.pk ?? null,
              columns: dataTab.columns ?? null,
            })
          : result.sql;
        const detachedResult = await store.runDetached(conn, sql, maxRowsForAll());
        detached = detachedResult.source;
        source = detachedResult.source;
        columns = detachedResult.meta.columns;
      }
      const rows = await collectRows(source, (done, total) => setProgress({ done, total }));
      const text =
        format === "csv"
          ? toCsv(columns, rows, { header: csvHeader, bom: csvBom, delimiter: csvDelimiter })
          : format === "json"
            ? toJson(columns, rows)
            : format === "xml"
              ? toXml(columns, rows)
              : toSqlInserts(table ?? "exported", columns, rows, kind);
      downloadBlob(suggestFilename(title, format), text, EXPORT_MIME[format]);
      if (detached) {
        detached.dispose();
      }
      onClose();
    } catch (err) {
      if (detached) {
        detached.dispose();
      }
      setError(errorOf(err, "내보내기에 실패했습니다"));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const sqlDisabled = table === null;

  return (
    <div className="modal-backdrop" onClick={() => (busy ? undefined : onClose())}>
      <div className="modal export-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">내보내기</span>
          <span className="modal-path">{title}</span>
        </div>
        <div className="export-body">
          <section className="export-section">
            <div className="section-title">형식</div>
            <div className="export-options">
              {(
                [
                  ["csv", "CSV"],
                  ["json", "JSON"],
                  ["xml", "XML"],
                  ["sql", "SQL INSERT"],
                ] as [ExportFormat, string][]
              ).map(([value, label]) => (
                <label className="check-row" key={value}>
                  <input
                    type="radio"
                    name="export-format"
                    checked={format === value}
                    disabled={busy}
                    onChange={() => setFormat(value)}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </section>
          <section className="export-section">
            <div className="section-title">범위</div>
            <div className="export-options">
              <label className="check-row">
                <input
                  type="radio"
                  name="export-scope"
                  checked={scope === "loaded"}
                  disabled={busy}
                  onChange={() => setScope("loaded")}
                />
                <span>{`로드된 행 (${loadedRows.toLocaleString()}행)`}</span>
              </label>
              <label className="check-row">
                <input
                  type="radio"
                  name="export-scope"
                  checked={scope === "all"}
                  disabled={busy}
                  onChange={() => setScope("all")}
                />
                <span>{dataTab ? "전체 (필터·정렬 적용해 재실행)" : "전체 (SQL 재실행)"}</span>
              </label>
            </div>
            <p className="helper">
              {dataTab
                ? "전체는 현재 필터·정렬로 최대 200,000행까지 다시 실행합니다"
                : "전체는 현재 SQL을 최대 200,000행까지 다시 실행합니다"}
            </p>
          </section>
          {format === "csv" ? (
            <section className="export-section">
              <div className="section-title">CSV 옵션</div>
              <div className="export-options">
                <label className="field">
                  <span>구분자</span>
                  <select
                    value={csvDelimiter}
                    disabled={busy}
                    onChange={(event) => setCsvDelimiter(event.target.value)}
                  >
                    <option value=",">쉼표 (,)</option>
                    <option value={"\t"}>탭</option>
                    <option value=";">세미콜론 (;)</option>
                    <option value="|">파이프 (|)</option>
                  </select>
                </label>
              </div>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={csvHeader}
                  disabled={busy}
                  onChange={(event) => setCsvHeader(event.target.checked)}
                />
                <span>헤더 포함</span>
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={csvBom}
                  disabled={busy}
                  onChange={(event) => setCsvBom(event.target.checked)}
                />
                <span>UTF-8 BOM</span>
              </label>
            </section>
          ) : null}
          {format === "sql" && sqlDisabled ? (
            <p className="helper">테이블 이름을 알 수 없어 SQL INSERT를 만들 수 없습니다</p>
          ) : null}
          {progress !== null ? (
            <p className="helper">{`${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}행 수집 중…`}</p>
          ) : null}
        </div>
        <div className="modal-foot">
          {error ? <span className="connect-error">{error}</span> : null}
          <span className="spacer" />
          <button type="button" disabled={busy} onClick={onClose}>
            닫기
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || (format === "sql" && sqlDisabled)}
            onClick={() => void run()}
          >
            다운로드
          </button>
        </div>
      </div>
    </div>
  );
}
