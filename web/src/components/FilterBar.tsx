import { useEffect, useState } from "react";
import {
  FILTER_OPS,
  type FilterLogic,
  type FilterOp,
  type FilterRow,
  type FilterState,
} from "../dataQuery";
import { CloseIcon, PlusIcon } from "./icons";

interface FilterBarProps {
  columns: string[];
  filter: FilterState;
  running: boolean;
  onApply(next: FilterState): void;
  onReset(): void;
}

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

function needsValue(op: FilterOp): boolean {
  return op !== "IS NULL" && op !== "IS NOT NULL";
}

function valuePlaceholder(op: FilterOp): string {
  if (op === "BETWEEN") {
    return "a,b";
  }
  if (op === "IN") {
    return "쉼표로 구분";
  }
  if (op === "LIKE" || op === "NOT LIKE") {
    return "%패턴%";
  }
  return "값";
}

export function FilterBar({ columns, filter, running, onApply, onReset }: FilterBarProps) {
  const [draft, setDraft] = useState<FilterState>(() => cloneFilter(filter));

  useEffect(() => {
    setDraft(cloneFilter(filter));
  }, [filter]);

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
        <div className="filter-logic" role="group" aria-label="조건 결합">
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
          조건 추가
        </button>
        <span className="spacer" />
        <span className="filter-hint">적용 시 즉시 재실행됩니다</span>
        <button type="button" disabled={running} onClick={() => onReset()}>
          초기화
        </button>
        <button
          type="button"
          className="primary"
          disabled={running}
          onClick={() => onApply(cloneFilter(draft))}
        >
          적용
        </button>
      </div>
      {draft.rows.length === 0 ? (
        <div className="filter-empty">조건이 없습니다 — "조건 추가"로 필터를 만드세요</div>
      ) : (
        <div className="filter-rows">
          {draft.rows.map((row) => (
            <div className={`filter-row${row.enabled ? "" : " off"}`} key={row.id}>
              <input
                type="checkbox"
                className="filter-enabled"
                title="조건 사용"
                checked={row.enabled}
                onChange={(event) => patchRow(row.id, { enabled: event.target.checked })}
              />
              <select
                className="filter-column"
                value={row.column}
                onChange={(event) => patchRow(row.id, { column: event.target.value })}
              >
                {!columns.includes(row.column) && row.column !== "" ? (
                  <option value={row.column}>{row.column}</option>
                ) : null}
                {columns.map((column) => (
                  <option key={column} value={column}>
                    {column}
                  </option>
                ))}
              </select>
              <select
                className="filter-op"
                value={row.op}
                onChange={(event) => patchRow(row.id, { op: event.target.value as FilterOp })}
              >
                {FILTER_OPS.map((op) => (
                  <option key={op} value={op}>
                    {op}
                  </option>
                ))}
              </select>
              {needsValue(row.op) ? (
                <input
                  className="filter-value"
                  placeholder={valuePlaceholder(row.op)}
                  spellCheck={false}
                  value={row.value}
                  onChange={(event) => patchRow(row.id, { value: event.target.value })}
                />
              ) : (
                <span className="filter-value-space" />
              )}
              <button
                type="button"
                className="filter-remove"
                title="조건 삭제"
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
