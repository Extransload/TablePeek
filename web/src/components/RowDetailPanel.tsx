import { useEffect, useMemo, useState, type ReactElement } from "react";
import type { SelectedRows } from "../grid/CanvasGrid";
import { formatBytes } from "../format";
import { t } from "../i18n";
import type { GridResult, TableDetail } from "../store";
import { FieldBox } from "./FieldBox";
import { LinkIcon, SearchIcon } from "./icons";
import { Spinner } from "./Spinner";

interface RowDetailPanelProps {
  // The grid the current tab shows, if any.
  result: GridResult | null;
  // The selected rows; one row shows its values, several show what they share.
  rows: SelectedRows | null;
  // The table behind the current tab, if any.
  table: string | null;
  detail: TableDetail | null;
  detailLoading: boolean;
  onOpenReference(row: number, col: number): void;
}

function sizeText(bytes: number | null | undefined): string | null {
  return bytes === null || bytes === undefined ? null : formatBytes(bytes);
}

// Past this many selected rows the panel stops comparing values (each row
// that isn't loaded yet would be fetched just to compare it).
const COMPARE_MAX_ROWS = 5000;

// What every selected row holds in one column: the shared value, "mixed" when
// rows differ, or "unknown" while some row is still loading or the span is too
// large to compare.
type Shared = { value: unknown } | "mixed" | "unknown";

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

function sharedValues(result: GridResult, rows: SelectedRows): Shared[] {
  const span = rows.to - rows.from + 1;
  return result.meta.columns.map((_, col) => {
    if (span > COMPARE_MAX_ROWS) {
      return "unknown";
    }
    const first = result.source.cell(rows.from, col);
    if (first === undefined) {
      return "unknown";
    }
    for (let row = rows.from + 1; row <= rows.to; row += 1) {
      const value = result.source.cell(row, col);
      if (value === undefined) {
        return "unknown";
      }
      if (!sameValue(value, first)) {
        return "mixed";
      }
    }
    return { value: first };
  });
}

// TablePlus-style right panel: the picked row's fields, or with no row the
// table's sizes and comment, or nothing when the tab has no table either.
export function RowDetailPanel({
  result,
  rows,
  table,
  detail,
  detailLoading,
  onOpenReference,
}: RowDetailPanelProps) {
  const [version, setVersion] = useState(0);
  const [query, setQuery] = useState("");

  // Cells still loading arrive through the source's update stream.
  useEffect(() => {
    if (!result) {
      return;
    }
    return result.source.onUpdate?.(() => setVersion((value) => value + 1));
  }, [result]);

  const showRow =
    result !== null && rows !== null && rows.from >= 0 && rows.to < result.source.rowCount;
  const single = rows !== null && rows.from === rows.to;
  // Recomputed when the selection moves or rows finish loading.
  const shared = useMemo(
    () => (showRow && result !== null && rows !== null ? sharedValues(result, rows) : []),
    [showRow, result, rows, version],
  );
  const tableDetail = table !== null ? detail : null;
  // MySQL, SQL Server and SQLite match column names case-insensitively, so a
  // result labelled "ID" still finds the table's "id".
  const types = new Map(
    (tableDetail?.columns ?? []).map((column) => [column.name.toLowerCase(), column.decl_type]),
  );
  const foreignKeys = tableDetail?.foreign_keys ?? [];
  const needle = query.trim().toLowerCase();
  const matches = (name: string): boolean => needle === "" || name.toLowerCase().includes(needle);

  let fields: ReactElement[] | null = null;
  if (showRow && rows.to - rows.from + 1 > COMPARE_MAX_ROWS) {
    fields = [
      <div className="panel-empty" key="too-many">
        {t("{count}개 행을 선택했습니다", { count: (rows.to - rows.from + 1).toLocaleString() })}
      </div>,
    ];
  } else if (showRow) {
    fields = result.meta.columns.flatMap((column, index) => {
      if (!matches(column)) {
        return [];
      }
      const common = shared[index] ?? "unknown";
      const value = typeof common === "object" ? common.value : undefined;
      const foreignKey = foreignKeys.find((entry) => entry.columns.includes(column));
      return [
        <FieldBox
          key={index}
          name={column}
          type={types.get(column.toLowerCase())?.toLowerCase() ?? null}
          value={value}
          note={common === "mixed" ? t("여러 값") : undefined}
          action={
            single && foreignKey !== undefined && value !== null && value !== undefined ? (
              <button
                type="button"
                className="field-box-link"
                title={t("참조 행 열기 — {table}", { table: foreignKey.ref_table })}
                onClick={() => onOpenReference(rows.from, index)}
              >
                <LinkIcon size={10} />
              </button>
            ) : undefined
          }
        />,
      ];
    });
  } else if (tableDetail !== null) {
    const info: [string, string | null][] = [
      ["data_size", sizeText(tableDetail.data_bytes)],
      ["index_size", sizeText(tableDetail.index_bytes)],
      ["total_size", sizeText(tableDetail.size_bytes)],
      ["comment", tableDetail.comment ?? ""],
    ];
    fields = info
      .filter(([name]) => matches(name))
      .map(([name, value]) => <FieldBox key={name} name={name} value={value} />);
  }

  return (
    <aside className="row-detail" aria-label={t("행 상세")}>
      {fields !== null ? (
        <>
          <label className="field-search">
            <SearchIcon size={12} />
            <input
              placeholder={t("필드 검색…")}
              value={query}
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="field-list">{fields}</div>
        </>
      ) : table !== null && detailLoading ? (
        <div className="panel-empty">
          <Spinner size={14} label={t("불러오는 중…")} />
        </div>
      ) : null}
    </aside>
  );
}
