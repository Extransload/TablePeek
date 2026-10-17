import { useEffect, useState } from "react";
import { buildUpdateSql, toSqlInserts } from "../export";
import type { GridResult } from "../store";
import { CloseIcon, CopyIcon } from "./icons";

interface RowDetailPanelProps {
  result: GridResult | null;
  row: number | null;
  table: string | null;
  onClose(): void;
}

type DetailView = "fields" | "json" | "sql";

function valueText(value: unknown): string {
  if (value === null) {
    return "NULL";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {});
}

export function RowDetailPanel({ result, row, table, onClose }: RowDetailPanelProps) {
  const [view, setView] = useState<DetailView>("fields");
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (!result) {
      return;
    }
    return result.source.onUpdate?.(() => setVersion((value) => value + 1));
  }, [result]);

  const meta = result ? result.meta : null;
  const columns = meta ? meta.columns : [];
  const valid = result !== null && meta !== null && row !== null && row >= 0 && row < meta.rowCount;

  const values: unknown[] = valid
    ? columns.map((_, index) => result.source.cell(row, index))
    : [];
  const loadedValues = values.map((value) => (value === undefined ? null : value));

  let content;
  if (!valid) {
    content = (
      <div className="row-detail-empty">
        {result ? "그리드에서 행을 선택하세요" : "표시할 결과가 없습니다"}
      </div>
    );
  } else if (view === "fields") {
    content = (
      <div className="detail-fields">
        {columns.map((column, index) => {
          const value = values[index];
          const pending = value === undefined;
          const text = pending ? "불러오는 중…" : valueText(value);
          return (
            <div className="detail-field" key={column}>
              <div className="detail-field-name" title={column}>
                {column}
              </div>
              <div className={`detail-field-value${value === null ? " null" : ""}`}>
                {text}
              </div>
              <button
                type="button"
                className="detail-copy"
                title="값 복사"
                disabled={pending}
                onClick={() => copyText(value === null || value === undefined ? "" : text)}
              >
                <CopyIcon size={11} />
              </button>
            </div>
          );
        })}
      </div>
    );
  } else if (view === "json") {
    const object: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      const value = values[index];
      object[column] = value === undefined ? null : value;
    });
    const text = JSON.stringify(object, null, 2);
    content = (
      <div className="detail-blocks">
        <div className="detail-block">
          <div className="detail-block-head">
            <span>JSON</span>
            <button type="button" className="detail-copy" title="복사" onClick={() => copyText(text)}>
              <CopyIcon size={11} />
            </button>
          </div>
          <pre className="detail-pre">{text}</pre>
        </div>
      </div>
    );
  } else {
    const sqlTable = table;
    const insert = sqlTable ? toSqlInserts(sqlTable, columns, [loadedValues]) : null;
    const update = sqlTable && meta && meta.pk ? buildUpdateSql(sqlTable, columns, loadedValues, meta.pk) : null;
    content = (
      <div className="detail-blocks">
        {insert !== null ? (
          <div className="detail-block">
            <div className="detail-block-head">
              <span>INSERT</span>
              <button
                type="button"
                className="detail-copy"
                title="복사"
                onClick={() => copyText(insert)}
              >
                <CopyIcon size={11} />
              </button>
            </div>
            <pre className="detail-pre">{insert}</pre>
          </div>
        ) : (
          <div className="row-detail-empty">테이블 이름을 알 수 없어 SQL을 만들 수 없습니다</div>
        )}
        {sqlTable !== null ? (
          update !== null ? (
            <div className="detail-block">
              <div className="detail-block-head">
                <span>UPDATE</span>
                <button
                  type="button"
                  className="detail-copy"
                  title="복사"
                  onClick={() => copyText(update)}
                >
                  <CopyIcon size={11} />
                </button>
              </div>
              <pre className="detail-pre">{update}</pre>
            </div>
          ) : (
            <div className="row-detail-empty">기본 키가 없어 UPDATE 문을 만들 수 없습니다</div>
          )
        ) : null}
      </div>
    );
  }

  return (
    <div className="row-detail">
      <div className="row-detail-head">
        <span className="row-detail-title">
          행 상세{valid ? <span className="row-detail-row">{` · ${(row + 1).toLocaleString()}행`}</span> : null}
        </span>
        <div className="detail-tabs">
          <button
            type="button"
            className={view === "fields" ? "active" : ""}
            onClick={() => setView("fields")}
          >
            필드
          </button>
          <button
            type="button"
            className={view === "json" ? "active" : ""}
            onClick={() => setView("json")}
          >
            JSON
          </button>
          <button
            type="button"
            className={view === "sql" ? "active" : ""}
            onClick={() => setView("sql")}
          >
            SQL
          </button>
        </div>
        <span className="spacer" />
        <button type="button" className="icon-button" title="닫기 (Esc)" onClick={onClose}>
          <CloseIcon size={11} />
        </button>
      </div>
      <div className="row-detail-body">{content}</div>
    </div>
  );
}
