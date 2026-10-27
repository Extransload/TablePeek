import { useEffect, useRef, useState } from "react";
import {
  FILTER_OPS,
  inEffect,
  type FilterLogic,
  type FilterOp,
  type FilterRow,
  type FilterState,
} from "../dataQuery";
import { t } from "../i18n";
import { formatBinding } from "../shortcuts";
import { ContextMenu } from "./ContextMenu";
import { ChevronDownIcon, MinusIcon, PlusIcon } from "./icons";
import { Select } from "./Select";

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
}

// The column list's Raw SQL entry: no column can be named this.
const RAW_SQL = "\u0000raw-sql";

let rowSeq = 0;

function nextRowId(): string {
  rowSeq += 1;
  return `fr-${rowSeq}-${Math.random().toString(36).slice(2, 7)}`;
}

function newRow(column: string): FilterRow {
  return { id: nextRowId(), column, op: "=", value: "", enabled: true, applied: false };
}

function cloneFilter(filter: FilterState): FilterState {
  return {
    logic: filter.logic,
    rows: filter.rows.map((row) => ({ ...row })),
  };
}

// The same condition: what a row filters by, its check and state aside.
function sameCondition(a: FilterRow, b: FilterRow): boolean {
  return a.column === b.column && a.op === b.op && a.value === b.value && (a.raw ?? false) === (b.raw ?? false);
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

// TablePlus's filter: conditions in rows, each applied on its own with its
// Apply button (or Return), which then reads Applied; or all the checked
// ones at once with Apply All (⌘↩), AND by default, OR from its menu. A
// row's + adds a copy below it, its − removes it; Clear shows the table
// unfiltered and keeps the conditions.
export function FilterBar({
  columns,
  filter,
  running,
  focusRequest,
  defaultColumn,
  onFocusHandled,
  onApply,
}: FilterBarProps) {
  const [draft, setDraft] = useState<FilterState>(() => cloneFilter(filter));
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; anchor: Element } | null>(null);

  useEffect(() => {
    setDraft(cloneFilter(filter));
  }, [filter]);

  // The bar always holds a row to fill in.
  useEffect(() => {
    if (draft.rows.length === 0) {
      setDraft((prev) =>
        prev.rows.length > 0 ? prev : { ...prev, rows: [newRow(defaultColumn ?? columns[0] ?? "")] },
      );
    }
  }, [draft.rows.length]);

  // Opened from its button or ⌘F, as in TablePlus: a bar with no conditions
  // starts with one, ready for its value, on the picked column; so does a
  // lone row not yet filled in.
  useEffect(() => {
    if (focusRequest === null || focusRequest === undefined) {
      return;
    }
    setDraft((prev) => {
      const column = defaultColumn ?? columns[0] ?? "";
      if (prev.rows.length === 0) {
        return { ...prev, rows: [newRow(column)] };
      }
      const [only] = prev.rows;
      const untouched = prev.rows.length === 1 && only.value === "" && !only.raw && only.applied === false;
      return untouched && defaultColumn ? { ...prev, rows: [{ ...only, column: defaultColumn }] } : prev;
    });
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

  // A row reads Applied while the data is filtered by it as it stands.
  function isApplied(row: FilterRow): boolean {
    const shown = filter.rows.find((entry) => entry.id === row.id);
    return shown !== undefined && inEffect(shown) && sameCondition(shown, row);
  }

  function patchRow(id: string, patch: Partial<FilterRow>): void {
    setDraft((prev) => ({
      ...prev,
      rows: prev.rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    }));
  }

  function applyRow(id: string): void {
    onApply({ logic: "AND", rows: draft.rows.map((row) => ({ ...row, applied: row.id === id })) });
  }

  function applyAll(logic: FilterLogic): void {
    onApply({ logic, rows: draft.rows.map((row) => ({ ...row, applied: row.enabled })) });
  }

  function clear(): void {
    onApply({ ...draft, rows: draft.rows.map((row) => ({ ...row, applied: false })) });
  }

  function cloneRow(id: string): void {
    setDraft((prev) => {
      const at = prev.rows.findIndex((row) => row.id === id);
      const copy = { ...prev.rows[at], id: nextRowId(), applied: false };
      return { ...prev, rows: [...prev.rows.slice(0, at + 1), copy, ...prev.rows.slice(at + 1)] };
    });
  }

  // The last row goes back to an empty one, as the bar keeps a row. A row in
  // effect runs the filter again without it: the rows that read Applied
  // stay in effect, and edits not yet applied stay unapplied.
  function removeRow(id: string): void {
    const left = draft.rows.filter((row) => row.id !== id);
    const rows = left.length > 0 ? left : [newRow(columns[0] ?? "")];
    const removed = draft.rows.find((row) => row.id === id);
    if (removed !== undefined && isApplied(removed)) {
      onApply({ ...draft, rows: rows.map((row) => ({ ...row, applied: isApplied(row) })) });
    } else {
      setDraft({ ...draft, rows });
    }
  }

  return (
    <div
      className="filter-bar"
      onKeyDown={(event) => {
        // ⌘↩ applies every checked condition, as TablePlus's Apply All.
        if (
          event.key === "Enter" &&
          (event.metaKey || event.ctrlKey) &&
          !event.shiftKey &&
          !event.altKey &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          if (!running) {
            applyAll("AND");
          }
        }
      }}
    >
      <div className="filter-rows" ref={rowsRef}>
        {draft.rows.map((row) => {
          const applied = isApplied(row);
          return (
            <div className={`filter-row${row.enabled ? "" : " off"}`} key={row.id}>
              <input
                type="checkbox"
                className="filter-enabled"
                title={t("모두 적용할 때 이 조건을 넣거나 뺍니다")}
                checked={row.enabled}
                onChange={(event) => patchRow(row.id, { enabled: event.target.checked })}
              />
              <Select
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
              </Select>
              {row.raw ? null : (
                <Select
                  className="filter-op"
                  value={row.op}
                  onChange={(event) => patchRow(row.id, { op: event.target.value as FilterOp })}
                >
                  {FILTER_OPS.map((op) => (
                    <option key={op} value={op}>
                      {opLabel(op)}
                    </option>
                  ))}
                </Select>
              )}
              {needsValue(row) ? (
                <input
                  className={row.raw ? "filter-value raw" : "filter-value"}
                  placeholder={valuePlaceholder(row)}
                  spellCheck={false}
                  value={row.value}
                  onChange={(event) => patchRow(row.id, { value: event.target.value })}
                  onKeyDown={(event) => {
                    // Return applies this condition, as TablePlus does.
                    if (
                      event.key === "Enter" &&
                      !event.metaKey &&
                      !event.ctrlKey &&
                      !event.nativeEvent.isComposing &&
                      !running
                    ) {
                      event.preventDefault();
                      applyRow(row.id);
                    }
                  }}
                />
              ) : (
                <span className="filter-value-space" />
              )}
              <button
                type="button"
                className={`filter-apply${applied ? " applied" : ""}`}
                disabled={running}
                title={t("이 조건만 적용합니다")}
                onClick={() => applyRow(row.id)}
              >
                {applied ? t("적용됨") : t("적용")}
              </button>
              <button
                type="button"
                className="filter-icon"
                title={t("이 조건 복제")}
                aria-label={t("이 조건 복제")}
                onClick={() => cloneRow(row.id)}
              >
                <PlusIcon size={11} />
              </button>
              <button
                type="button"
                className="filter-icon"
                disabled={running && applied}
                title={t("이 조건 삭제")}
                aria-label={t("이 조건 삭제")}
                onClick={() => removeRow(row.id)}
              >
                <MinusIcon size={11} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="filter-actions">
        <button type="button" disabled={running} onClick={clear}>
          {t("필터 해제")}
        </button>
        <span className="filter-apply-all">
          <button
            type="button"
            className="primary"
            disabled={running}
            title={t("체크한 조건을 모두 적용합니다 ({key})", { key: formatBinding("Mod+Enter") })}
            onClick={() => applyAll("AND")}
          >
            {t("모두 적용")}
          </button>
          <button
            type="button"
            className="primary filter-apply-more"
            disabled={running}
            aria-label={t("모두 적용 방식")}
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              setMenu(menu === null ? { x: box.left, y: box.bottom + 2, anchor: event.currentTarget } : null);
            }}
          >
            <ChevronDownIcon size={10} />
          </button>
        </span>
      </div>
      {menu !== null ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          anchor={menu.anchor}
          items={[
            { label: t("체크한 조건을 모두 AND로 적용"), onSelect: () => applyAll("AND") },
            { label: t("체크한 조건을 모두 OR로 적용"), onSelect: () => applyAll("OR") },
          ]}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
