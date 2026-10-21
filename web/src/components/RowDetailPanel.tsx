import { t } from "../i18n";
import { useEffect, useState } from "react";
import { buildUpdateSql, toSqlInserts } from "../export";
import { store, type GridResult, type TableDetail } from "../store";
import { CloseIcon, CopyIcon, LinkIcon } from "./icons";
import { Spinner } from "./Spinner";

interface RowDetailPanelProps {
  result: GridResult | null;
  row: number | null;
  table: string | null;
  kind: string;
  detail: TableDetail | null;
  detailLoading: boolean;
  onOpenReference(row: number, col: number): void;
  onClose(): void;
}

type DetailView = "fields" | "relations" | "json" | "sql";

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

function normalizeEdit(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return String(value);
  }
}

export function RowDetailPanel({
  result,
  row,
  table,
  kind,
  detail,
  detailLoading,
  onOpenReference,
  onClose,
}: RowDetailPanelProps) {
  const [view, setView] = useState<DetailView>("fields");
  const [, setVersion] = useState(0);
  const [jsonText, setJsonText] = useState<string | null>(null);
  const [jsonBusy, setJsonBusy] = useState(false);

  useEffect(() => {
    if (!result) {
      return;
    }
    return result.source.onUpdate?.(() => setVersion((value) => value + 1));
  }, [result]);

  useEffect(() => {
    setJsonText(null);
  }, [result, row, view]);

  const meta = result ? result.meta : null;
  const columns = meta ? meta.columns : [];
  const valid =
    result !== null && meta !== null && row !== null && row >= 0 && row < result.source.rowCount;

  const values: unknown[] = valid
    ? columns.map((_, index) => result.source.cell(row, index))
    : [];
  const foreignKeys = detail?.foreign_keys ?? [];
  const fkColumns = new Set(foreignKeys.flatMap((entry) => entry.columns));
  const loadedValues = values.map((value) => (value === undefined ? null : value));

  let content;
  if (!valid) {
    content = <div className="panel-empty">{t("선택된 행이 없습니다")}</div>;
  } else if (view === "fields") {
    content = (
      <div className="detail-fields">
        {columns.map((column, index) => {
          const value = values[index];
          const pending = value === undefined;
          const text = pending ? "불러오는 중…" : valueText(value);
          const foreignKey = foreignKeys.find((entry) => entry.columns.includes(column));
          return (
            <div className="detail-field" key={column}>
              <div className="detail-field-name" title={column}>
                {column}
                {fkColumns.has(column) ? <span className="detail-fk-badge">FK</span> : null}
              </div>
              <div className={`detail-field-value${value === null ? " null" : ""}`}>
                {text}
              </div>
              {foreignKey !== undefined && !pending && value !== null ? (
                <button
                  type="button"
                  className="detail-copy detail-relation-jump"
                  title={`참조 행 열기 — ${foreignKey.ref_table}`}
                  onClick={() => {
                    if (row !== null) {
                      onOpenReference(row, index);
                    }
                  }}
                >
                  <LinkIcon size={11} />
                </button>
              ) : null}
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
  } else if (view === "relations") {
    content = detailLoading ? (
      <div className="row-detail-empty">
        <Spinner size={16} label="관계 정보 불러오는 중" />
        <div>관계 정보를 불러오는 중…</div>
      </div>
    ) : table === null ? (
      <div className="row-detail-empty">이 결과에서는 관계 정보를 사용할 수 없습니다</div>
    ) : detail === null ? (
      <div className="row-detail-empty">관계 정보를 불러오지 못했습니다</div>
    ) : (
      <div className="detail-relations">
        <div className="relation-summary">
          <span>{detail.columns.length}개 컬럼</span>
          <span>{detail.indexes.length}개 인덱스</span>
          <span>{foreignKeys.length}개 외래 키</span>
        </div>
        {foreignKeys.length === 0 ? (
          <div className="row-detail-empty">이 테이블에는 외래 키가 없습니다</div>
        ) : (
          foreignKeys.map((foreignKey) => (
            <div className="relation-card" key={foreignKey.name}>
              <div className="relation-card-head">
                <LinkIcon size={11} />
                <span className="relation-name" title={foreignKey.name}>
                  {foreignKey.name}
                </span>
                <span className="relation-target">
                  {foreignKey.ref_table}
                </span>
              </div>
              <div className="relation-pairs">
                {foreignKey.columns.map((column, index) => {
                  const columnIndex = columns.indexOf(column);
                  const pending =
                    columnIndex >= 0 ? values[columnIndex] === undefined : false;
                  const value = columnIndex >= 0 ? values[columnIndex] : undefined;
                  const refColumn = foreignKey.ref_columns[index] ?? foreignKey.ref_columns[0];
                  return (
                    <button
                      type="button"
                      className="relation-pair"
                      key={column}
                      disabled={columnIndex < 0 || pending || value === null || row === null}
                      title={`${foreignKey.ref_table}.${refColumn} 참조 행 열기`}
                      onClick={() => {
                        if (row !== null && columnIndex >= 0) {
                          onOpenReference(row, columnIndex);
                        }
                      }}
                    >
                      <span className="relation-local">{column}</span>
                      <span className="relation-op">=</span>
                      <span className="relation-value">
                        {pending ? "…" : value === null || value === undefined ? "NULL" : valueText(value)}
                      </span>
                      <span className="relation-arrow">→</span>
                      <span className="relation-ref">
                        {foreignKey.ref_table}.{refColumn}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    );
  } else if (view === "json") {
    const object: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      const value = values[index];
      object[column] = value === undefined ? null : value;
    });
    const text = jsonText ?? JSON.stringify(object, null, 2);
    const loaded = values.every((value) => value !== undefined);
    const editable =
      loaded &&
      result !== null &&
      row !== null &&
      result.meta.sourceTable !== null &&
      !result.source.isDeleted(row) &&
      (result.source.isInserted(row) ||
        (result.meta.pk !== null && result.meta.pk.length > 0));
    const dirty = jsonText !== null && jsonText !== JSON.stringify(object, null, 2);
    const save = async (): Promise<void> => {
      if (!editable || result === null || row === null) {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        store.setError("JSON 문법을 확인하세요");
        return;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        store.setError("JSON 객체 형식이어야 합니다");
        return;
      }
      const changes: { col: number; value: string | null }[] = [];
      columns.forEach((column, index) => {
        const nextValue = (parsed as Record<string, unknown>)[column];
        if (normalizeEdit(values[index]) === normalizeEdit(nextValue)) {
          return;
        }
        changes.push({ col: index, value: normalizeEdit(nextValue) });
      });
      if (changes.length === 0) {
        setJsonText(null);
        return;
      }
      setJsonBusy(true);
      try {
        for (const change of changes) {
          const outcome = await store.editCell(row, change.col, change.value);
          if (outcome === null) {
            return;
          }
        }
        setJsonText(null);
        store.setInfo(t("변경 대기 중 ({count}개 컬럼) — ⌘S로 적용", { count: changes.length }));
      } finally {
        setJsonBusy(false);
      }
    };
    content = (
      <div className="detail-blocks">
        <div className="detail-block">
          <div className="detail-block-head">
            <span>JSON</span>
            {editable ? <span className="dim">편집 가능</span> : null}
            <span className="spacer" />
            {dirty ? (
              <button
                type="button"
                className="icon-text-button"
                disabled={jsonBusy}
                onClick={() => void save()}
                title={t("변경 대기열에 추가 (⌘S로 적용)")}
              >
                {jsonBusy ? t("저장 중") : t("변경 대기")}
              </button>
            ) : null}
            <button
              type="button"
              className="icon-text-button"
              disabled={jsonBusy || jsonText === null}
              onClick={() => setJsonText(null)}
              title="되돌리기"
            >
              되돌리기
            </button>
            <button type="button" className="detail-copy" title="복사" onClick={() => copyText(text)}>
              <CopyIcon size={11} />
            </button>
          </div>
          {editable ? (
            <textarea
              className="detail-json-editor"
              value={text}
              spellCheck={false}
              disabled={jsonBusy}
              onChange={(event) => setJsonText(event.target.value)}
            />
          ) : (
            <pre className="detail-pre">{text}</pre>
          )}
        </div>
      </div>
    );
  } else {
    const sqlTable = table;
    const insert = sqlTable ? toSqlInserts(sqlTable, columns, [loadedValues], kind) : null;
    const update =
      sqlTable && meta && meta.pk
        ? buildUpdateSql(sqlTable, columns, loadedValues, meta.pk, kind)
        : null;
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
            className={view === "relations" ? "active" : ""}
            onClick={() => setView("relations")}
          >
            관계{foreignKeys.length > 0 ? ` ${foreignKeys.length}` : ""}
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
