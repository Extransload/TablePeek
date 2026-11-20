// Peek: a query result read for its shape and summed up above the grid,
// worked out here by fixed rules (no AI, nothing leaves the page), so the
// same rows always give the same summary. Shapes:
//   single    one row of numbers: each as a big number
//   category  a label column and number columns: the biggest share and the
//             highest values, a share bar, bars in the number cells
//   time      a date, month or year column and number columns: the value that
//             stands out from the rest, a small line, bars in the cells
// Anything else (many rows, several label columns, no numbers) has no summary.
import { inferColumns, isKeyColumn, textOf, toNumber, toTime } from "./chartData";
import type { GridPeek } from "./grid/CanvasGrid";

// Results with more rows are lists to read, not summaries to see.
export const PEEK_ROW_CAP = 50;
// Big numbers shown for a one-row result, at most.
const CARD_CAP = 6;
// How far above the middle value a value stands out.
const SPIKE_RATIO = 1.5;
// A year or a month as GROUP BY names one ("2025", "2025-01"): text, but in
// time order.
const PERIOD_TEXT = /^\d{4}(?:-\d{2})?$/;
// Names of values that don't add up to a whole (an average, a rate): no share.
const NOT_ADDITIVE = /avg|mean|average|rate|ratio|pct|percent|평균|비율/i;

export type PeekShape = "single" | "category" | "time";

export interface PeekMeasure {
  index: number;
  name: string;
  // By result row; null where the cell isn't a number.
  values: (number | null)[];
  min: number;
  max: number;
  median: number;
  total: number;
  // The row holding the largest value when it is SPIKE_RATIO× the median or
  // more (values of zero or above only).
  spike: number | null;
  // The values are parts of a whole (counts, sums), so shares mean something.
  additive: boolean;
}

export type PeekFinding =
  | { kind: "share"; label: string; measure: string; value: number; total: number }
  | { kind: "top"; label: string; measure: string; value: number; median: number }
  | { kind: "spike"; label: string; measure: string; value: number; median: number }
  | { kind: "even"; measure: string; min: number; max: number };

export interface PeekAxis {
  index: number;
  name: string;
  // By result row.
  labels: string[];
}

export interface PeekModel {
  shape: PeekShape;
  rowCount: number;
  axis: PeekAxis | null;
  // Result rows in the order to draw them: time order for a time axis,
  // as returned otherwise.
  order: number[];
  measures: PeekMeasure[];
  cards: { name: string; value: number }[];
  findings: PeekFinding[];
}

function median(sorted: number[]): number {
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function measureOf(index: number, name: string, rows: unknown[][]): PeekMeasure | null {
  const values = rows.map((row) => toNumber(row[index]));
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) {
    return null;
  }
  const sorted = [...present].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mid = median(sorted);
  const spikeRow = values.indexOf(max);
  return {
    index,
    name,
    values,
    min,
    max,
    median: mid,
    total: present.reduce((sum, value) => sum + value, 0),
    spike: min >= 0 && mid > 0 && max >= mid * SPIKE_RATIO ? spikeRow : null,
    additive: min >= 0 && !NOT_ADDITIVE.test(name),
  };
}

// The summary of a result, or null when its shape has none.
export function peekModel(columns: string[], rows: unknown[][], kinds?: (string | null)[]): PeekModel | null {
  if (rows.length === 0 || columns.length === 0) {
    return null;
  }
  const infos = inferColumns(columns, rows, kinds);
  if (rows.length === 1) {
    if (columns.length > CARD_CAP || infos.some((info) => info.type !== "number")) {
      return null;
    }
    const cards = infos.map((info) => ({ name: info.name, value: toNumber(rows[0][info.index]) }));
    if (cards.some((card) => card.value === null)) {
      return null;
    }
    return {
      shape: "single",
      rowCount: 1,
      axis: null,
      order: [0],
      measures: [],
      cards: cards as { name: string; value: number }[],
      findings: [],
    };
  }
  if (rows.length > PEEK_ROW_CAP) {
    return null;
  }
  const measured = infos.filter((info) => info.type === "number" && !isKeyColumn(info.name));
  const others = infos.filter((info) => !measured.includes(info));
  if (others.length !== 1 || measured.length === 0) {
    return null;
  }
  const measures = measured
    .map((info) => measureOf(info.index, info.name, rows))
    .filter((measure): measure is PeekMeasure => measure !== null);
  if (measures.length === 0) {
    return null;
  }
  const axisInfo = others[0];
  const labels = rows.map((row) => (row[axisInfo.index] === null ? "NULL" : textOf(row[axisInfo.index])));
  const axis: PeekAxis = { index: axisInfo.index, name: axisInfo.name, labels };
  const timed =
    axisInfo.type === "time" || labels.every((label) => PERIOD_TEXT.test(label));
  const order = rows.map((_, index) => index);
  if (timed) {
    const key = (row: number): number | string =>
      axisInfo.type === "time" ? (toTime(rows[row][axisInfo.index]) ?? Number.POSITIVE_INFINITY) : labels[row];
    order.sort((a, b) => {
      const x = key(a);
      const y = key(b);
      return x < y ? -1 : x > y ? 1 : a - b;
    });
  }
  return {
    shape: timed ? "time" : "category",
    rowCount: rows.length,
    axis,
    order,
    measures,
    cards: [],
    findings: timed ? timeFindings(measures, labels) : categoryFindings(measures, labels),
  };
}

// The first measure's biggest share (or its highest value, for an average),
// then the highest value of up to two more.
function categoryFindings(measures: PeekMeasure[], labels: string[]): PeekFinding[] {
  const findings: PeekFinding[] = [];
  measures.slice(0, 3).forEach((measure, index) => {
    const row = measure.values.indexOf(measure.max);
    if (index === 0 && measure.additive && measure.total > 0) {
      findings.push({ kind: "share", label: labels[row], measure: measure.name, value: measure.max, total: measure.total });
    } else {
      findings.push({ kind: "top", label: labels[row], measure: measure.name, value: measure.max, median: measure.median });
    }
  });
  return findings;
}

// Each measure's value that stands out, or for the first, that none does.
function timeFindings(measures: PeekMeasure[], labels: string[]): PeekFinding[] {
  const spikes: PeekFinding[] = measures.flatMap((measure) =>
    measure.spike === null
      ? []
      : [{ kind: "spike" as const, label: labels[measure.spike], measure: measure.name, value: measure.max, median: measure.median }],
  );
  if (spikes.length > 0) {
    return spikes.slice(0, 3);
  }
  const first = measures[0];
  return [{ kind: "even", measure: first.name, min: first.min, max: first.max }];
}

// What the grid draws for Peek: bars in the measured columns (when all their
// values are zero or above), the standing-out cells, and floats tidied. With
// no model, floats are still tidied.
export function gridPeek(model: PeekModel | null, columnCount: number): GridPeek {
  const barMax = new Array<number | null>(columnCount).fill(null);
  const hot = new Set<string>();
  if (model !== null && model.shape !== "single") {
    for (const measure of model.measures) {
      if (measure.min >= 0 && measure.max > 0 && measure.index < columnCount) {
        barMax[measure.index] = measure.max;
      }
      if (measure.spike !== null) {
        hot.add(`${measure.spike}:${measure.index}`);
      }
    }
  }
  return { barMax, hot, tidyNumbers: true };
}
