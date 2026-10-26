import { useEffect, useRef, useState } from "react";
import {
  FILTER_OPS,
  type FilterLogic,
  type FilterOp,
  type FilterRow,
  type FilterState,
} from "../dataQuery";
import { t } from "../i18n";
import { CloseIcon, PlusIcon } from "./icons";

interface FilterBarProps {
  columns: string[];
  filter: FilterState;
  running: boolean;
  // Bumped to put the keyboard in the first value, after adding a condition
  // on `defaultColumn` when there is none; the owner clears it once handled.
  focusRequest?: number | null;
  defaultColumn?: string | null;
  onFocusHandled?(): void;
  onApply(next: FilterState): void;
  onReset(): void;
}

// The column list's Raw SQL entry: no column can be named this.
const RAW_SQL = "\u0000raw-sql";

let rowSeq = 0;

function nextRowId(): string {
  rowSeq += 1;
  return `fr-${rowSeq}-${Math.random().toString(36).slice(2, 7)}`;
}

function newRow(column: string): FilterRow {
  return { id: nextRowId(), column, op: "=", value: "", enabled: true };
}

function cloneFilter(filter: FilterState): FilterState {
  return {
    logic: filter.logic,
    rows: filter.rows.map((row) => ({ ...row })),
  };
}

function needsValue(row: FilterRow): boolean {
  return row.raw === true || (row.op !== "IS NULL" && row.op !== "IS NOT NULL");
}

function valuePlaceholder(row: FilterRow): string {
  if (row.raw) {
    return t("WHERE 조건 (SQL)");
  }
  switch (row.op) {
    case "BETWEEN":
    case "NOT BETWEEN":
      return "a,b";
    case "IN":
    case "NOT IN":
      return t("쉼표로 구분");
    case "LIKE":
    case "NOT LIKE":
      return t("%패턴%");
    default:
      return t("값");
  }
}

// TablePlus's names for the operators that aren't SQL as written.
function opLabel(op: FilterOp): string {
  switch (op) {
    case "CONTAINS":
      return t("다음을 포함");
    case "NOT CONTAINS":
      return t("다음을 포함하지 않음");
    case "HAS PREFIX":
      return t("다음으로 시작");
    case "HAS SUFFIX":
      return t("다음으로 끝남");
    default:
      return op;
  }
}

export function FilterBar({
  columns,
  filter,
  running,
  focusRequest,
  defaultColumn,
  onFocusHandled,
  onApply,
  onReset,
}: FilterBarProps) {
  const [draft, setDraft] = useState<FilterState>(() => cloneFilter(filter));
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const [focusTick, setFocusTick] = useState(0);

  useEffect(() => {
    setDraft(cloneFilter(filter));
  }, [filter]);

  // Opened from its button or ⌘F, as in TablePlus: a bar with no conditions
  // starts with one, ready for its value.
  useEffect(() => {
    if (focusRequest === null || focusRequest === undefined) {
      return;
    }
    setDraft((prev) =>
      prev.rows.length > 0 ? prev : { ...prev, rows: [newRow(defaultColumn ?? columns[0] ?? "")] },
    );
    setFocusTick((tick) => tick + 1);
    onFocusHandled?.();
  }, [focusRequest]);

  useEffect(() => {
    if (focusTick === 0) {
      return;
    }
    const rows = rowsRef.current;
    const target =
      rows?.querySelector<HTMLInputElement>(".filter-value") ?? rows?.querySelector<HTMLSelectElement>(".filter-column");
    target?.focus();
    if (target instanceof HTMLInputElement) {
      target.select();
    }
  }, [focusTick]);

  function patchRow(id: string, patch: Partial<FilterRow>): void {
    setDraft((prev) => ({
      ...prev,
      rows: prev.rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    }));
  }

  function removeRow(id: string): void {
    setDraft((prev) => ({ ...prev, rows: prev.rows.filter((row) => row.id !== id) }));
  }

  function addRow(): void {
    setDraft((prev) => ({ ...prev, rows: [...prev.rows, newRow(columns[0] ?? "")] }));
  }

  function setLogic(logic: FilterLogic): void {
    setDraft((prev) => ({ ...prev, logic }));
  }

  return (
    <div className="filter-bar">
      <div className="filter-head">
        <div className="filter-logic" role="group" aria-label={t("조건 결합")}>
          <button
            type="button"
            className={draft.logic === "AND" ? "active" : ""}
            onClick={() => setLogic("AND")}
          >
            AND
          </button>
          <button
            type="button"
            className={draft.logic === "OR" ? "active" : ""}
            onClick={() => setLogic("OR")}
          >
            OR
          </button>
        </div>
        <button type="button" className="icon-text-button" onClick={addRow}>
          <PlusIcon size={11} />
          {t("조건 추가")}
        </button>
        <span className="spacer" />
        <span className="filter-hint">{t("적용 시 즉시 재실행됩니다")}</span>
        <button type="button" disabled={running} onClick={() => onReset()}>
          {t("초기화")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={running}
          onClick={() => onApply(cloneFilter(draft))}
        >
          {t("적용")}
        </button>
      </div>
      {draft.rows.length === 0 ? (
        <div className="filter-empty">{t("조건이 없습니다 — \"조건 추가\"로 필터를 만드세요")}</div>
      ) : (
        <div className="filter-rows" ref={rowsRef}>
          {draft.rows.map((row) => (
            <div className={`filter-row${row.enabled ? "" : " off"}`} key={row.id}>
              <input
                type="checkbox"
                className="filter-enabled"
                title={t("조건 사용")}
                checked={row.enabled}
                onChange={(event) => patchRow(row.id, { enabled: event.target.checked })}
              />
              <select
                className="filter-column"
                value={row.raw ? RAW_SQL : row.column}
                onChange={(event) =>
                  patchRow(
                    row.id,
                    event.target.value === RAW_SQL
                      ? { raw: true }
                      : { raw: undefined, text: undefined, column: event.target.value },
                  )
                }
              >
                {!row.raw && !columns.includes(row.column) && row.column !== "" ? (
                  <option value={row.column}>{row.column}</option>
                ) : null}
                {columns.map((column) => (
                  <option key={column} value={column}>
                    {column}
                  </option>
                ))}
                <option value={RAW_SQL}>{t("SQL 직접 입력")}</option>
              </select>
              {row.raw ? null : (
                <select
                  className="filter-op"
                  value={row.op}
                  onChange={(event) => patchRow(row.id, { op: event.target.value as FilterOp })}
                >
                  {FILTER_OPS.map((op) => (
                    <option key={op} value={op}>
                      {opLabel(op)}
                    </option>
                  ))}
                </select>
              )}
              {needsValue(row) ? (
                <input
                  className={row.raw ? "filter-value raw" : "filter-value"}
                  placeholder={valuePlaceholder(row)}
                  spellCheck={false}
                  value={row.value}
                  onChange={(event) => patchRow(row.id, { value: event.target.value })}
                  onKeyDown={(event) => {
                    // Return applies the filter, as TablePlus does.
                    if (event.key === "Enter" && !event.nativeEvent.isComposing && !running) {
                      event.preventDefault();
                      onApply(cloneFilter(draft));
                    }
                  }}
                />
              ) : (
                <span className="filter-value-space" />
              )}
              <button
                type="button"
                className="filter-remove"
                title={t("조건 삭제")}
                onClick={() => removeRow(row.id)}
              >
                <CloseIcon size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
