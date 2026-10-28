import { useEffect, useMemo, useState } from "react";
import {
  PIVOT_AGGREGATES,
  TIME_BUCKETS,
  buildPivot,
  pivotTable,
  toTsv,
  type ColumnInfo,
  type PivotAggregate,
  type PivotSettings,
  type TimeBucket,
} from "../chartData";
import { writeClipboard } from "../clipboard";
import type { RowSource } from "../grid/rowSource";
import { t } from "../i18n";
import { CloseIcon, CopyIcon } from "./icons";
import { AGGREGATE_LABELS, BUCKET_LABELS, columnOptions, useThemeColors } from "./ResultChart";
import { Select } from "./Select";
import { TableGrid } from "./TableGrid";

// The pivot's cells for the grid, the totals (the last row, and the last
// column when a dimension runs across) in the accent colour.
class PivotSource implements RowSource {
  readonly columns: string[];
  readonly rowCount: number;
  private readonly rows: unknown[][];
  private readonly totalColumn: number;
  private readonly ink: string;

  constructor(columns: string[], rows: unknown[][], spread: boolean, ink: string) {
    this.columns = columns;
    this.rows = rows;
    this.rowCount = rows.length;
    this.totalColumn = spread ? columns.length - 1 : -1;
    this.ink = ink;
  }

  cell(row: number, col: number): unknown {
    const value = this.rows[row]?.[col];
    return value === undefined ? null : value;
  }

  cellInk(row: number, col: number): string | null {
    return row === this.rowCount - 1 || col === this.totalColumn ? this.ink : null;
  }
}

interface PivotViewProps {
  columns: ColumnInfo[];
  rows: unknown[][];
  settings: PivotSettings;
  scope: string;
  warn: string | null;
  themeKey: string;
  onChange(next: PivotSettings): void;
}

// The Pivot view: row dimensions, an optional column dimension and the value
// with its aggregate along the top, the table in the grid (select and ⌘C as
// anywhere) and Copy TSV for all of it.
export function PivotView({ columns, rows, settings, scope, warn, themeKey, onChange }: PivotViewProps) {
  const accent = useThemeColors(themeKey).series[0] ?? "#4082ee";
  const model = useMemo(
    () => buildPivot(rows, columns, settings, { other: t("기타"), nul: "NULL" }),
    [rows, columns, settings],
  );
  const table = useMemo(() => pivotTable(model, t("합계")), [model]);
  const source = useMemo(
    () => new PivotSource(table.columns, table.rows, model.column !== null, accent),
    [table, model.column, accent],
  );
  // What the last Copy TSV did, shown on the button a moment.
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  useEffect(() => {
    if (copied === null) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(null), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const set = (patch: Partial<PivotSettings>): void => onChange({ ...settings, ...patch });
  const used = new Set([...settings.rows, ...(settings.column === null ? [] : [settings.column])]);
  const hasTime = columns.some((column) => column.type === "time" && used.has(column.name));
  const notes = [
    scope,
    t("{rows}행 × {cols}열", {
      rows: model.rows.length.toLocaleString(),
      cols: Math.max(1, model.columnLabels.length).toLocaleString(),
    }),
  ];
  if (model.mergedColumns > 0) {
    notes.push(t("{count}개 열 값을 기타로 묶음", { count: model.mergedColumns.toLocaleString() }));
  }

  return (
    <div className="analysis-view">
      <div className="analysis-controls">
        <div className="analysis-field">
          <span>{t("행")}</span>
          <span className="analysis-chips">
            {settings.rows.map((name) => (
              <span className="analysis-chip" key={name}>
                {name}
                {settings.rows.length > 1 ? (
                  <button
                    type="button"
                    className="icon-button"
                    title={t("빼기")}
                    aria-label={t("빼기")}
                    onClick={() => set({ rows: settings.rows.filter((entry) => entry !== name) })}
                  >
                    <CloseIcon size={9} />
                  </button>
                ) : null}
              </span>
            ))}
            <Select
              value=""
              className="analysis-add"
              aria-label={t("행 추가")}
              onChange={(event) => {
                const name = event.target.value;
                if (name !== "") {
                  set({
                    rows: [...settings.rows, name],
                    column: settings.column === name ? null : settings.column,
                  });
                }
              }}
            >
              <option value="">{t("+ 추가")}</option>
              {columnOptions(columns, (column) => !used.has(column.name))}
            </Select>
          </span>
        </div>
        <label className="analysis-field">
          <span>{t("열")}</span>
          <Select
            value={settings.column ?? ""}
            onChange={(event) => set({ column: event.target.value === "" ? null : event.target.value })}
          >
            <option value="">{t("없음")}</option>
            {columnOptions(columns, (column) => !settings.rows.includes(column.name))}
          </Select>
        </label>
        <label className="analysis-field">
          <span>{t("값")}</span>
          <Select
            value={settings.value ?? ""}
            onChange={(event) => {
              const value = event.target.value === "" ? null : event.target.value;
              // From counting rows to a number column: its sum, not its count.
              const agg = value === null ? "count" : settings.value === null ? "sum" : settings.agg;
              set({ value, agg });
            }}
          >
            <option value="">{t("행 수")}</option>
            {columnOptions(columns, (column) => column.type === "number")}
          </Select>
        </label>
        <label className="analysis-field">
          <span>{t("집계")}</span>
          <Select
            value={settings.agg}
            disabled={settings.value === null}
            onChange={(event) => set({ agg: event.target.value as PivotAggregate })}
          >
            {PIVOT_AGGREGATES.map((agg) => (
              <option key={agg} value={agg}>
                {t(AGGREGATE_LABELS[agg])}
              </option>
            ))}
          </Select>
        </label>
        {hasTime ? (
          <label className="analysis-field">
            <span>{t("단위")}</span>
            <Select value={settings.bucket} onChange={(event) => set({ bucket: event.target.value as TimeBucket })}>
              {TIME_BUCKETS.map((bucket) => (
                <option key={bucket} value={bucket}>
                  {t(BUCKET_LABELS[bucket])}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
        <button
          type="button"
          className="analysis-copy"
          onClick={() => {
            let ok = true;
            void writeClipboard(toTsv(table.columns, table.rows), () => {
              ok = false;
            }).then(() => setCopied(ok ? "ok" : "failed"));
          }}
          title={t("피벗 표 전체를 탭으로 구분한 텍스트로 복사합니다")}
        >
          <CopyIcon size={11} />
          {copied === "ok" ? t("복사됨") : copied === "failed" ? t("복사 실패") : t("TSV 복사")}
        </button>
        <span className="analysis-meta" title={[...notes, warn ?? ""].filter(Boolean).join("\n")}>
          {warn !== null ? <span className="warn">{warn}</span> : null}
          <span>{notes.join(" · ")}</span>
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="analysis-empty">{t("결과에 행이 없습니다")}</div>
      ) : (
        <div className="pivot-body">
          <TableGrid source={source} themeKey={themeKey} />
        </div>
      )}
    </div>
  );
}
