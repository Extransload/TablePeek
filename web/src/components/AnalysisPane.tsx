import { useEffect, useMemo, useState } from "react";
import {
  ANALYSIS_ROW_CAP,
  inferColumns,
  resolveChart,
  resolvePivot,
  type AnalysisState,
  type ChartSettings,
  type PivotSettings,
} from "../chartData";
import { buildDataSqlUnlimited, buildWhere, type FilterState, type SortState } from "../dataQuery";
import type { WindowedRowSource } from "../grid/windowSource";
import { t } from "../i18n";
import { store, type GridResult } from "../store";
import { PivotView } from "./PivotView";
import { ResultChart } from "./ResultChart";
import { LoadingState } from "./Spinner";

// A table tab charts its whole table under its filter, read apart from the
// page the grid shows.
export interface AnalysisTable {
  conn: string;
  kind: string;
  table: string;
  filter: FilterState | null;
  sorts: SortState[] | null;
  pk: string[] | null;
  columns: string[] | null;
}

export interface AnalysisRows {
  columns: string[];
  kinds?: (string | null)[];
  rows: unknown[][];
  // More rows than ANALYSIS_ROW_CAP: only the first were read.
  capped: boolean;
  // The query itself stopped at the row limit (Settings → Data).
  truncated: boolean;
  // Rows of the whole table rather than of the result in front.
  wholeTable: boolean;
}

type LoadState =
  | { status: "idle" }
  | { status: "loading"; done: number; total: number | null }
  | { status: "error"; error: string }
  | { status: "ready"; data: AnalysisRows };

// Rows read once per result, so switching views or tabs and back doesn't
// read them again. The key tells apart a table's reads of different filters
// made while the grid showed the same page.
const loaded = new WeakMap<WindowedRowSource, { key: string; data: AnalysisRows }>();

function errorOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

// Up to `cap` rows as the database returned them (staged edits aside), a
// window at a time, reporting every thousand and giving the page a turn.
async function readAll(
  source: WindowedRowSource,
  cap: number,
  alive: () => boolean,
  onProgress: (done: number, total: number) => void,
): Promise<unknown[][]> {
  const total = Math.min(source.baseRowCount, cap);
  const width = source.columns.length;
  const rows = new Array<unknown[]>(width === 0 ? 0 : total);
  for (let r = 0; r < rows.length; r += 1) {
    if (source.baseCell(r, 0) === undefined) {
      await source.ensureRow(r);
    }
    const row = new Array<unknown>(width);
    for (let c = 0; c < width; c += 1) {
      const value = source.baseCell(r, c, false);
      row[c] = value === undefined ? null : value;
    }
    rows[r] = row;
    if ((r + 1) % 1000 === 0) {
      onProgress(r + 1, total);
      await yieldToUi();
      if (!alive()) {
        throw new Error("stale");
      }
    }
  }
  return rows;
}

function useAnalysisRows(result: GridResult | null, table: AnalysisTable | null): LoadState {
  const sql =
    table === null
      ? null
      : buildDataSqlUnlimited({
          kind: table.kind,
          table: table.table,
          filter: table.filter,
          sorts: table.sorts,
          pk: table.pk,
          columns: table.columns,
        });
  const source = result?.source ?? null;
  const key = sql ?? "";
  const [state, setState] = useState<LoadState>({ status: "idle" });

  useEffect(() => {
    if (source === null || result === null) {
      setState({ status: "idle" });
      return;
    }
    const hit = loaded.get(source);
    if (hit !== undefined && hit.key === key) {
      setState({ status: "ready", data: hit.data });
      return;
    }
    let alive = true;
    setState({ status: "loading", done: 0, total: null });
    const progress = (done: number, total: number): void => {
      if (alive) {
        setState({ status: "loading", done, total });
      }
    };
    void (async () => {
      try {
        let data: AnalysisRows;
        if (table !== null && sql !== null) {
          const detached = await store.runDetached(table.conn, sql, ANALYSIS_ROW_CAP);
          try {
            if (!alive) {
              return;
            }
            const rows = await readAll(detached.source, ANALYSIS_ROW_CAP, () => alive, progress);
            data = {
              columns: detached.meta.columns,
              kinds: detached.meta.columnKinds,
              rows,
              capped: detached.meta.truncated,
              truncated: false,
              wholeTable: true,
            };
          } finally {
            detached.source.dispose();
          }
        } else {
          const rows = await readAll(source, ANALYSIS_ROW_CAP, () => alive, progress);
          data = {
            columns: result.meta.columns,
            kinds: result.meta.columnKinds,
            rows,
            capped: source.baseRowCount > ANALYSIS_ROW_CAP,
            truncated: result.meta.truncated,
            wholeTable: false,
          };
        }
        if (!alive) {
          return;
        }
        loaded.set(source, { key, data });
        setState({ status: "ready", data });
      } catch (error) {
        if (alive) {
          setState({ status: "error", error: errorOf(error, t("행을 불러오지 못했습니다")) });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [source, key]);

  return state;
}

interface AnalysisPaneProps {
  view: "chart" | "pivot";
  state: AnalysisState | undefined;
  result: GridResult | null;
  table: AnalysisTable | null;
  // The result is on its way (a run or a table's first read).
  awaiting: boolean;
  themeKey: string;
  onChange(next: AnalysisState): void;
}

// The Chart and Pivot views of the rows in front: all of them (up to
// ANALYSIS_ROW_CAP) are read first, with progress, then the view is set up
// from the tab's saved settings or, for settings never picked, defaults that
// fit the columns.
export function AnalysisPane({ view, state, result, table, awaiting, themeKey, onChange }: AnalysisPaneProps) {
  const load = useAnalysisRows(result, table);
  const data = load.status === "ready" ? load.data : null;
  const columns = useMemo(
    () => (data === null ? [] : inferColumns(data.columns, data.rows, data.kinds)),
    [data],
  );
  const chart = useMemo(
    () => (data === null ? null : resolveChart(state?.chart, columns, data.rows)),
    [data, columns, state?.chart],
  );
  const pivot = useMemo(
    () => (data === null ? null : resolvePivot(state?.pivot, columns, data.rows)),
    [data, columns, state?.pivot],
  );

  if (result === null) {
    return (
      <div className="analysis-pane">
        {awaiting ? (
          <LoadingState variant="overlay" />
        ) : (
          <div className="analysis-empty">{t("차트나 피벗으로 볼 결과가 없습니다. 쿼리를 실행하세요")}</div>
        )}
      </div>
    );
  }
  if (result.meta.columns.length === 0) {
    return (
      <div className="analysis-pane">
        <div className="analysis-empty">{t("이 결과에는 행이 없습니다")}</div>
      </div>
    );
  }
  if (load.status === "error") {
    return (
      <div className="analysis-pane">
        <div className="analysis-empty err">{load.error}</div>
      </div>
    );
  }
  if (data === null || chart === null || pivot === null) {
    const label =
      load.status === "loading" && load.total !== null
        ? t("행 불러오는 중… {done} / {total}", {
            done: load.done.toLocaleString(),
            total: load.total.toLocaleString(),
          })
        : table !== null
          ? t("테이블 행 읽는 중…")
          : t("행 불러오는 중…");
    return (
      <div className="analysis-pane">
        <LoadingState variant="overlay" label={label} />
      </div>
    );
  }

  // What the rows are; a cut short read says so in the warning beside it.
  const count = data.rows.length.toLocaleString();
  const scope = !data.wholeTable
    ? t("{count}행", { count })
    : table !== null && buildWhere(table.filter, table.kind) !== null
      ? t("필터를 적용한 테이블 전체 {count}행", { count })
      : t("테이블 전체 {count}행", { count });
  const warn = data.capped
    ? t("행이 {count}개보다 많아 처음 {count}행만 집계했습니다", { count: ANALYSIS_ROW_CAP.toLocaleString() })
    : data.truncated
      ? t("쿼리 결과가 최대 행 수에서 잘렸습니다: 가져온 행만 집계했습니다")
      : null;

  const setChart = (next: ChartSettings): void => onChange({ ...state, view, chart: next });
  const setPivot = (next: PivotSettings): void => onChange({ ...state, view, pivot: next });
  return (
    <div className="analysis-pane">
      {view === "chart" ? (
        <ResultChart
          columns={columns}
          rows={data.rows}
          settings={chart}
          scope={scope}
          warn={warn}
          themeKey={themeKey}
          onChange={setChart}
        />
      ) : (
        <PivotView
          columns={columns}
          rows={data.rows}
          settings={pivot}
          scope={scope}
          warn={warn}
          themeKey={themeKey}
          onChange={setPivot}
        />
      )}
    </div>
  );
}
