// Charts and pivot tables of a result's rows, worked out in the page: what
// each column holds (numbers, dates and times, or text), the groups a chart or
// pivot shows and their numbers, and the axis ticks to draw them on. Nothing
// here touches the DOM, so it runs the same under a plain script.

export type ColumnType = "number" | "time" | "text";
// What a time column's values are: a day, a day and a time, or a time of day.
export type TimeKind = "date" | "datetime" | "time";

export interface ColumnInfo {
  name: string;
  index: number;
  type: ColumnType;
  time?: TimeKind;
}

export type ChartType = "bar" | "line" | "area" | "pie" | "scatter";
export type Aggregate = "none" | "count" | "sum" | "avg" | "min" | "max";
export type PivotAggregate = Exclude<Aggregate, "none">;
export type TimeBucket = "auto" | "none" | "minute" | "hour" | "day" | "week" | "month" | "year";
export type ConcreteBucket = Exclude<TimeBucket, "auto">;
export type ChartSort = "x" | "value-desc" | "value-asc";

export interface ChartSettings {
  type: ChartType;
  x: string | null;
  y: string[];
  agg: Aggregate;
  bucket: TimeBucket;
  sort: ChartSort;
  // Categories kept before the rest fold into one "other"; 0 keeps all.
  limit: number;
  // Bars and areas of several series on top of each other.
  stacked: boolean;
  // A pie with a hole.
  donut: boolean;
}

export interface PivotSettings {
  rows: string[];
  column: string | null;
  // null counts rows.
  value: string | null;
  agg: PivotAggregate;
  // How time dimensions group.
  bucket: TimeBucket;
}

// A tab's Chart or Pivot view and how each was last set up.
export interface AnalysisState {
  view: "chart" | "pivot" | null;
  chart?: ChartSettings;
  pivot?: PivotSettings;
}

// Rows a chart or pivot reads at most.
export const ANALYSIS_ROW_CAP = 50_000;
export const CHART_TYPES: ChartType[] = ["bar", "line", "area", "pie", "scatter"];
export const AGGREGATES: Aggregate[] = ["none", "count", "sum", "avg", "min", "max"];
export const PIVOT_AGGREGATES: PivotAggregate[] = ["count", "sum", "avg", "min", "max"];
export const TIME_BUCKETS: TimeBucket[] = ["auto", "none", "minute", "hour", "day", "week", "month", "year"];
export const CHART_SORTS: ChartSort[] = ["x", "value-desc", "value-asc"];
export const CATEGORY_LIMITS = [5, 10, 20, 50, 100, 0];
// Column values a pivot spreads across before the rest fold into "other".
export const PIVOT_COLUMN_CAP = 100;
// Groups the automatic time bucket aims to stay under.
const AUTO_BUCKET_GROUPS = 60;
// Values per column looked at to tell what the column holds.
const SAMPLE_VALUES = 2000;

const NUMBER_TEXT = /^\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?\s*$/;
const DATE_TEXT =
  /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;
const TIME_TEXT = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;
const ID_LIKE = /^(?:id|.*_id|.*[a-z]Id)$/;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// A cell as a number: numbers, big integers and the decimal text drivers send
// for big integers and DECIMALs; anything else (NULL included) is no number.
export function toNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && NUMBER_TEXT.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function fractionMs(digits: string | undefined): number {
  return digits === undefined ? 0 : Number(digits.slice(0, 3).padEnd(3, "0"));
}

// A date or time cell as milliseconds of its wall-clock reading, kept on the
// UTC scale: "2024-03-05 14:00:00+09" groups and reads as 14:00 on the 5th,
// as the grid shows it, whatever the offset. Times of day sit on 1970-01-01.
export function toTime(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const date = DATE_TEXT.exec(value);
  if (date !== null) {
    const [, y, mo, d, h, mi, s, frac] = date;
    const month = Number(mo);
    const day = Number(d);
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return null;
    }
    return Date.UTC(
      Number(y),
      month - 1,
      day,
      h === undefined ? 0 : Number(h),
      mi === undefined ? 0 : Number(mi),
      s === undefined ? 0 : Number(s),
      fractionMs(frac),
    );
  }
  const time = TIME_TEXT.exec(value);
  if (time !== null) {
    const [, h, mi, s, frac] = time;
    return Number(h) * HOUR + Number(mi) * MINUTE + Number(s) * 1000 + fractionMs(frac);
  }
  return null;
}

function timeKindOf(value: unknown): TimeKind | null {
  if (value instanceof Date) {
    return "datetime";
  }
  if (typeof value !== "string") {
    return null;
  }
  const date = DATE_TEXT.exec(value);
  if (date !== null) {
    return date[4] === undefined ? "date" : "datetime";
  }
  return TIME_TEXT.test(value) ? "time" : null;
}

// A cell as category text.
export function textOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// What each column holds, from its first non-NULL values: all numbers, all
// dates or times (of one kind), or else text. A column the driver calls a
// boolean (MySQL's TINYINT(1)) is text, true and false being categories.
export function inferColumns(
  columns: string[],
  rows: unknown[][],
  kinds?: (string | null)[],
): ColumnInfo[] {
  return columns.map((name, index) => {
    if (kinds?.[index] === "boolean") {
      return { name, index, type: "text" };
    }
    let seen = 0;
    let numbers = true;
    let time: TimeKind | null | undefined;
    for (let r = 0; r < rows.length && seen < SAMPLE_VALUES; r += 1) {
      const value = rows[r][index];
      if (value === null || value === undefined) {
        continue;
      }
      seen += 1;
      if (numbers && toNumber(value) === null) {
        numbers = false;
      }
      if (time !== null) {
        const kind = timeKindOf(value);
        // A date column with a timestamp or two among its days reads as times.
        if (kind === null || (time !== undefined && (kind === "time") !== (time === "time"))) {
          time = null;
        } else if (time === undefined || kind === "datetime") {
          time = kind;
        }
      }
      if (!numbers && time === null) {
        break;
      }
    }
    if (seen === 0) {
      return { name, index, type: "text" };
    }
    if (numbers) {
      return { name, index, type: "number" };
    }
    if (time !== null && time !== undefined) {
      return { name, index, type: "time", time };
    }
    return { name, index, type: "text" };
  });
}

function mod(value: number, by: number): number {
  return ((value % by) + by) % by;
}

// The start of the bucket a time falls in; weeks start on Monday.
export function floorTime(ms: number, bucket: ConcreteBucket): number {
  switch (bucket) {
    case "minute":
      return ms - mod(ms, MINUTE);
    case "hour":
      return ms - mod(ms, HOUR);
    case "day":
      return ms - mod(ms, DAY);
    case "week": {
      const day = ms - mod(ms, DAY);
      return day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
    }
    case "month": {
      const date = new Date(ms);
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    }
    case "year":
      return Date.UTC(new Date(ms).getUTCFullYear(), 0, 1);
    default:
      return ms;
  }
}

const AUTO_ORDER: ConcreteBucket[] = ["minute", "hour", "day", "week", "month", "year"];

// The finest bucket that leaves at most AUTO_BUCKET_GROUPS groups: the values
// as they are when that few, else minutes, hours, days… up to years.
export function autoBucket(times: number[]): ConcreteBucket {
  const distinct = new Set(times);
  if (distinct.size <= AUTO_BUCKET_GROUPS) {
    return "none";
  }
  for (const bucket of AUTO_ORDER) {
    const groups = new Set<number>();
    for (const time of distinct) {
      groups.add(floorTime(time, bucket));
      if (groups.size > AUTO_BUCKET_GROUPS) {
        break;
      }
    }
    if (groups.size <= AUTO_BUCKET_GROUPS) {
      return bucket;
    }
  }
  return "year";
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

// A time as its bucket reads: "2024", "2024-03", "2024-03-05",
// "2024-03-05 14:00"; unbucketed, as precise as the column's values.
export function formatTime(ms: number, bucket: ConcreteBucket, kind: TimeKind = "datetime"): string {
  const date = new Date(ms);
  const day = `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const hm = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  switch (bucket) {
    case "year":
      return day.slice(0, 4);
    case "month":
      return day.slice(0, 7);
    case "week":
    case "day":
      return day;
    case "hour":
    case "minute":
      return kind === "time" ? hm : `${day} ${hm}`;
    default: {
      if (kind === "date") {
        return day;
      }
      const ms3 = date.getUTCMilliseconds();
      const clock = `${hm}:${pad(date.getUTCSeconds())}${ms3 === 0 ? "" : `.${pad(ms3, 3)}`}`;
      return kind === "time" ? clock : `${day} ${clock}`;
    }
  }
}

// Float noise (0.1 + 0.2) trimmed off a computed number.
export function cleanNumber(value: number): number {
  return Number.isInteger(value) ? value : Number(value.toPrecision(12));
}

// Running numbers of one group and series: rows seen, non-NULL values, and
// their sum, least and greatest. Kept whole so folded groups and totals come
// out exact (an average of the merged rows, not of their averages).
interface Acc {
  rows: number;
  n: number;
  sum: number;
  min: number;
  max: number;
}

function newAcc(): Acc {
  return { rows: 0, n: 0, sum: 0, min: Infinity, max: -Infinity };
}

function addValue(acc: Acc, value: number | null): void {
  acc.rows += 1;
  if (value === null) {
    return;
  }
  acc.n += 1;
  acc.sum += value;
  if (value < acc.min) {
    acc.min = value;
  }
  if (value > acc.max) {
    acc.max = value;
  }
}

function mergeAcc(into: Acc, from: Acc): void {
  into.rows += from.rows;
  into.n += from.n;
  into.sum += from.sum;
  into.min = Math.min(into.min, from.min);
  into.max = Math.max(into.max, from.max);
}

// What an aggregate makes of a group: COUNT counts non-NULL values, or rows
// when there is no value column; the others skip NULLs and are NULL when
// there was nothing to take. No aggregate (one row a point) reads as a sum.
function valueOf(acc: Acc, agg: Aggregate, countRows: boolean): number | null {
  switch (agg) {
    case "count":
      return countRows ? acc.rows : acc.n;
    case "avg":
      return acc.n === 0 ? null : cleanNumber(acc.sum / acc.n);
    case "min":
      return acc.n === 0 ? null : acc.min;
    case "max":
      return acc.n === 0 ? null : acc.max;
    default:
      return acc.n === 0 ? null : cleanNumber(acc.sum);
  }
}

const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function hasRepeats(rows: unknown[][], column: ColumnInfo): boolean {
  const seen = new Set<string>();
  const limit = Math.min(rows.length, SAMPLE_VALUES * 5);
  for (let r = 0; r < limit; r += 1) {
    const key = textOf(rows[r][column.index]);
    if (seen.has(key)) {
      return true;
    }
    seen.add(key);
  }
  return false;
}

function distinctCount(rows: unknown[][], column: ColumnInfo, cap: number): number {
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(textOf(row[column.index]));
    if (seen.size > cap) {
      break;
    }
  }
  return seen.size;
}

function timesOf(rows: unknown[][], column: ColumnInfo): number[] {
  const times: number[] = [];
  for (const row of rows) {
    const time = toTime(row[column.index]);
    if (time !== null) {
      times.push(time);
    }
  }
  return times;
}

function valueColumns(columns: ColumnInfo[], x: ColumnInfo | null): ColumnInfo[] {
  const numbers = columns.filter((column) => column.type === "number" && column !== x);
  // Key columns (id, user_id) are numbers but nothing to add up.
  const measures = numbers.filter((column) => !ID_LIKE.test(column.name));
  return measures.length > 0 ? measures : numbers;
}

// A chart that fits the columns: over the first date or time column (a line),
// else across the first text column (bars) or the first number (a scatter),
// of the number columns that aren't keys; counting rows when there are none.
export function defaultChart(columns: ColumnInfo[], rows: unknown[][]): ChartSettings {
  const x =
    columns.find((column) => column.type === "time") ??
    columns.find((column) => column.type === "text") ??
    columns[0] ??
    null;
  const y = valueColumns(columns, x).slice(0, 3);
  const type: ChartType =
    x === null || x.type === "text" ? "bar" : x.type === "time" ? "line" : y.length > 0 ? "scatter" : "bar";
  const agg: Aggregate =
    y.length === 0
      ? "count"
      : type === "scatter"
        ? "none"
        : x !== null && (x.type === "time" || hasRepeats(rows, x))
          ? "sum"
          : "none";
  return {
    type,
    x: x?.name ?? null,
    y: y.map((column) => column.name),
    agg,
    bucket: "auto",
    sort: x?.type === "text" ? "value-desc" : "x",
    limit: 20,
    stacked: false,
    donut: false,
  };
}

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

// Saved settings checked against the result in front: columns it no longer
// has are dropped (the defaults fill in), and values from a damaged save
// fall back to the defaults.
export function resolveChart(
  saved: Partial<ChartSettings> | undefined,
  columns: ColumnInfo[],
  rows: unknown[][],
): ChartSettings {
  const fallback = defaultChart(columns, rows);
  if (saved === undefined || saved === null || typeof saved !== "object") {
    return fallback;
  }
  const x = columns.find((column) => column.name === saved.x) ?? null;
  if (x === null) {
    return fallback;
  }
  const savedY = Array.isArray(saved.y) ? saved.y : [];
  const y = savedY.filter((name) =>
    columns.some((column) => column.name === name && column.type === "number" && column !== x),
  );
  const agg = pick(saved.agg, AGGREGATES, fallback.agg);
  return {
    type: pick(saved.type, CHART_TYPES, fallback.type),
    x: x.name,
    // Series all gone (a new query): the defaults' series, if any are left.
    y: y.length > 0 || savedY.length === 0 ? y : valueColumns(columns, x).slice(0, 3).map((column) => column.name),
    agg,
    bucket: pick(saved.bucket, TIME_BUCKETS, "auto"),
    sort: pick(saved.sort, CHART_SORTS, fallback.sort),
    limit: pick(saved.limit, CATEGORY_LIMITS, fallback.limit),
    stacked: saved.stacked === true,
    donut: saved.donut === true,
  };
}

export interface ChartPoint {
  key: string;
  label: string;
  // Where a time or number X sits; null for categories.
  x: number | null;
  values: (number | null)[];
  // Source rows that went into it.
  rows: number;
  // The categories past the limit, folded together.
  other?: boolean;
}

export interface ChartModel {
  xType: ColumnType;
  timeKind: TimeKind;
  bucket: ConcreteBucket;
  series: string[];
  points: ChartPoint[];
  // Categories folded into the "other" point.
  merged: number;
  // Rows left out: their X is NULL or not a time or number.
  skipped: number;
  // No series to draw: no number column picked and the aggregate isn't COUNT.
  noSeries: boolean;
}

interface GroupDraft {
  key: string;
  label: string;
  x: number | null;
  accs: Acc[];
  // The cell's number, for a point that is one row (no aggregate).
  raw: (number | null)[] | null;
  rows: number;
}

export function seriesLabel(agg: Aggregate, column: string | null): string {
  if (column === null) {
    return "count(*)";
  }
  return agg === "none" ? column : `${agg}(${column})`;
}

function draftTotal(draft: GroupDraft, agg: Aggregate, countRows: boolean): number {
  let total = 0;
  if (draft.raw !== null) {
    for (const value of draft.raw) {
      total += value ?? 0;
    }
    return total;
  }
  for (const acc of draft.accs) {
    total += valueOf(acc, agg, countRows) ?? 0;
  }
  return total;
}

function compareKeys(a: { x: number | null; label: string; nul?: boolean }, b: { x: number | null; label: string; nul?: boolean }): number {
  if (a.nul !== b.nul) {
    return a.nul ? 1 : -1;
  }
  if (a.x !== null && b.x !== null) {
    return a.x - b.x;
  }
  return naturalCollator.compare(a.label, b.label);
}

const NULL_KEY = "\u0000null";

// The points a chart draws. Rows group on X (times on their bucket) when there
// is an aggregate; each row is its own point when there isn't. Categories (a
// text X, or any pie) past the limit fold into one "other" point, the biggest
// kept. Lines, areas and scatters over times or numbers run in X order; bars
// and pies in the order picked.
export function buildChart(
  rows: unknown[][],
  columns: ColumnInfo[],
  settings: ChartSettings,
  labels: { other: string; nul: string } = { other: "기타", nul: "NULL" },
): ChartModel {
  const x = columns.find((column) => column.name === settings.x) ?? null;
  const ys = settings.y
    .map((name) => columns.find((column) => column.name === name && column.type === "number"))
    .filter((column): column is ColumnInfo => column !== undefined);
  const countRows = ys.length === 0;
  const empty: ChartModel = {
    xType: x?.type ?? "text",
    timeKind: x?.time ?? "datetime",
    bucket: "none",
    series: [],
    points: [],
    merged: 0,
    skipped: 0,
    noSeries: countRows && settings.agg !== "count",
  };
  if (x === null || empty.noSeries) {
    return empty;
  }
  const agg = settings.agg;
  const bucket: ConcreteBucket =
    x.type !== "time" ? "none" : settings.bucket === "auto" ? autoBucket(timesOf(rows, x)) : settings.bucket;
  const series = countRows ? [seriesLabel("count", null)] : ys.map((column) => seriesLabel(agg, column.name));
  const groups = new Map<string, GroupDraft>();
  const drafts: GroupDraft[] = [];
  let skipped = 0;
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    const cell = row[x.index];
    let key: string;
    let label: string;
    let at: number | null = null;
    if (x.type === "time") {
      const time = toTime(cell);
      if (time === null) {
        skipped += 1;
        continue;
      }
      at = floorTime(time, bucket);
      key = String(at);
      label = formatTime(at, bucket, x.time);
    } else if (x.type === "number") {
      const value = toNumber(cell);
      if (value === null) {
        skipped += 1;
        continue;
      }
      at = value;
      key = String(value);
      label = String(value);
    } else if (cell === null || cell === undefined) {
      key = NULL_KEY;
      label = labels.nul;
    } else {
      label = textOf(cell);
      key = `s:${label}`;
    }
    const values = countRows ? null : ys.map((column) => toNumber(row[column.index]));
    if (agg === "none") {
      drafts.push({ key: `r${r}`, label, x: at, accs: [], raw: values ?? [1], rows: 1 });
      continue;
    }
    let draft = groups.get(key);
    if (draft === undefined) {
      draft = { key, label, x: at, accs: series.map(() => newAcc()), raw: null, rows: 0 };
      groups.set(key, draft);
      drafts.push(draft);
    }
    draft.rows += 1;
    if (values === null) {
      addValue(draft.accs[0], null);
    } else {
      for (let s = 0; s < values.length; s += 1) {
        addValue(draft.accs[s], values[s]);
      }
    }
  }

  let kept = drafts;
  let other: GroupDraft | null = null;
  let merged = 0;
  const capped = x.type === "text" || settings.type === "pie";
  if (capped && settings.limit > 0 && drafts.length > settings.limit) {
    const totals = new Map(drafts.map((draft) => [draft, draftTotal(draft, agg, countRows)]));
    const ranked = drafts.slice().sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
    const keep = new Set(ranked.slice(0, settings.limit));
    kept = drafts.filter((draft) => keep.has(draft));
    const rest = ranked.slice(settings.limit);
    merged = rest.length;
    other = { key: "\u0000other", label: labels.other, x: null, accs: series.map(() => newAcc()), raw: null, rows: 0 };
    for (const draft of rest) {
      other.rows += draft.rows;
      if (draft.raw !== null) {
        draft.raw.forEach((value, s) => addValue(other!.accs[s], value));
      } else {
        draft.accs.forEach((acc, s) => mergeAcc(other!.accs[s], acc));
      }
    }
  }

  // With no aggregate the folded rows add up; else they take the aggregate.
  const otherAgg: Aggregate = agg === "none" ? "sum" : agg;
  const toPoint = (draft: GroupDraft, isOther = false): ChartPoint => ({
    key: draft.key,
    label: draft.label,
    x: draft.x,
    values:
      draft.raw !== null
        ? draft.raw
        : draft.accs.map((acc) => valueOf(acc, isOther ? otherAgg : agg, countRows)),
    rows: draft.rows,
    ...(isOther ? { other: true } : {}),
  });
  const points = kept.map((draft) => toPoint(draft));
  const positional = x.type !== "text" && settings.type !== "bar" && settings.type !== "pie";
  const byX = (a: ChartPoint, b: ChartPoint): number =>
    compareKeys(
      { x: a.x, label: a.label, nul: a.key === NULL_KEY },
      { x: b.x, label: b.label, nul: b.key === NULL_KEY },
    );
  const total = (point: ChartPoint): number => point.values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  if (positional || settings.sort === "x") {
    points.sort(byX);
  } else {
    const direction = settings.sort === "value-asc" ? 1 : -1;
    points.sort((a, b) => (total(a) - total(b)) * direction || byX(a, b));
  }
  if (other !== null) {
    points.push(toPoint(other, true));
  }
  return {
    xType: x.type,
    timeKind: x.time ?? "datetime",
    bucket,
    series,
    points,
    merged,
    skipped,
    noSeries: false,
  };
}

// ---- Pivot ----

// Rows down the text or time column with the fewest values (times grouped as
// the automatic bucket would), summing the first number that isn't a key, or
// counting rows when there is none.
export function defaultPivot(columns: ColumnInfo[], rows: unknown[][]): PivotSettings {
  let best: ColumnInfo | null = null;
  let bestCount = Infinity;
  for (const column of columns) {
    if (column.type === "number") {
      continue;
    }
    let count: number;
    if (column.type === "time") {
      const times = timesOf(rows, column);
      const bucket = autoBucket(times);
      count = new Set(times.map((time) => floorTime(time, bucket))).size;
    } else {
      count = distinctCount(rows, column, bestCount);
    }
    if (count > 1 && count < bestCount) {
      best = column;
      bestCount = count;
    }
  }
  best ??= columns.find((column) => column.type !== "number") ?? columns[0] ?? null;
  const value = valueColumns(columns, best)[0] ?? null;
  return {
    rows: best === null ? [] : [best.name],
    column: null,
    value: value?.name ?? null,
    agg: value === null ? "count" : "sum",
    bucket: "auto",
  };
}

export function resolvePivot(
  saved: Partial<PivotSettings> | undefined,
  columns: ColumnInfo[],
  rows: unknown[][],
): PivotSettings {
  const fallback = defaultPivot(columns, rows);
  if (saved === undefined || saved === null || typeof saved !== "object") {
    return fallback;
  }
  const has = (name: unknown): boolean => columns.some((column) => column.name === name);
  const dims = (Array.isArray(saved.rows) ? saved.rows : []).filter(has);
  if (dims.length === 0) {
    return fallback;
  }
  const value =
    saved.value === null
      ? null
      : columns.find((column) => column.name === saved.value && column.type === "number")?.name ?? fallback.value;
  return {
    rows: dims,
    column: has(saved.column) && !dims.includes(saved.column as string) ? (saved.column as string) : null,
    value,
    agg: value === null ? "count" : pick(saved.agg, PIVOT_AGGREGATES, fallback.agg),
    bucket: pick(saved.bucket, TIME_BUCKETS, "auto"),
  };
}

export interface PivotRow {
  labels: string[];
  cells: (number | null)[];
  total: number | null;
}

export interface PivotModel {
  dims: string[];
  column: string | null;
  valueLabel: string;
  // The column dimension's values across; empty with none.
  columnLabels: string[];
  rows: PivotRow[];
  // Down each column, and of everything.
  totals: (number | null)[];
  grand: number | null;
  // Column values past PIVOT_COLUMN_CAP, folded into one "other" column.
  mergedColumns: number;
}

interface DimKey {
  key: string;
  label: string;
  x: number | null;
  nul: boolean;
}

function dimKeyOf(value: unknown, column: ColumnInfo, bucket: ConcreteBucket, nul: string): DimKey {
  if (column.type === "time") {
    const time = toTime(value);
    if (time !== null) {
      const at = floorTime(time, bucket);
      return { key: `t${at}`, label: formatTime(at, bucket, column.time), x: at, nul: false };
    }
  } else if (column.type === "number") {
    const number = toNumber(value);
    if (number !== null) {
      return { key: `n${number}`, label: String(number), x: number, nul: false };
    }
  }
  if (value === null || value === undefined) {
    return { key: NULL_KEY, label: nul, x: null, nul: true };
  }
  const label = textOf(value);
  return { key: `s:${label}`, label, x: null, nul: false };
}

// A pivot table: a row per combination of the row dimensions (NULL is a
// value of its own, as GROUP BY has it), a column per value of the column
// dimension, the aggregate in each cell and of each row, column and all.
export function buildPivot(
  rows: unknown[][],
  columns: ColumnInfo[],
  settings: PivotSettings,
  labels: { other: string; nul: string } = { other: "기타", nul: "NULL" },
): PivotModel {
  const find = (name: string | null): ColumnInfo | null =>
    name === null ? null : (columns.find((column) => column.name === name) ?? null);
  const dims = settings.rows.map(find).filter((column): column is ColumnInfo => column !== null);
  const across = find(settings.column);
  const value = settings.value === null ? null : find(settings.value);
  const countRows = value === null;
  const agg: PivotAggregate = countRows ? "count" : settings.agg;
  const bucketOf = (column: ColumnInfo): ConcreteBucket =>
    column.type !== "time" ? "none" : settings.bucket === "auto" ? autoBucket(timesOf(rows, column)) : settings.bucket;
  const dimBuckets = dims.map(bucketOf);
  const acrossBucket = across === null ? "none" : bucketOf(across);

  interface RowDraft {
    keys: DimKey[];
    cells: Map<string, Acc>;
    total: Acc;
  }
  const rowDrafts = new Map<string, RowDraft>();
  const columnKeys = new Map<string, { key: DimKey; total: Acc }>();
  const grand = newAcc();
  for (const row of rows) {
    const keys = dims.map((dim, i) => dimKeyOf(row[dim.index], dim, dimBuckets[i], labels.nul));
    const rowKey = keys.map((key) => key.key).join("\u0001");
    const colKey = across === null ? null : dimKeyOf(row[across.index], across, acrossBucket, labels.nul);
    const number = value === null ? null : toNumber(row[value.index]);
    let draft = rowDrafts.get(rowKey);
    if (draft === undefined) {
      draft = { keys, cells: new Map(), total: newAcc() };
      rowDrafts.set(rowKey, draft);
    }
    addValue(draft.total, number);
    addValue(grand, number);
    if (colKey !== null) {
      let cell = draft.cells.get(colKey.key);
      if (cell === undefined) {
        cell = newAcc();
        draft.cells.set(colKey.key, cell);
      }
      addValue(cell, number);
      let col = columnKeys.get(colKey.key);
      if (col === undefined) {
        col = { key: colKey, total: newAcc() };
        columnKeys.set(colKey.key, col);
      }
      addValue(col.total, number);
    }
  }

  let acrossKeys = [...columnKeys.values()];
  let mergedColumns = 0;
  let otherColumn: { key: DimKey; total: Acc; members: Set<string> } | null = null;
  if (acrossKeys.length > PIVOT_COLUMN_CAP) {
    const ranked = acrossKeys.slice().sort((a, b) => b.total.rows - a.total.rows);
    const rest = ranked.slice(PIVOT_COLUMN_CAP - 1);
    mergedColumns = rest.length;
    const keep = new Set(ranked.slice(0, PIVOT_COLUMN_CAP - 1));
    acrossKeys = acrossKeys.filter((col) => keep.has(col));
    otherColumn = {
      key: { key: "\u0000other", label: labels.other, x: null, nul: false },
      total: newAcc(),
      members: new Set(rest.map((col) => col.key.key)),
    };
    for (const col of rest) {
      mergeAcc(otherColumn.total, col.total);
    }
  }
  acrossKeys.sort((a, b) => compareKeys(a.key, b.key));
  const orderedColumns = otherColumn === null ? acrossKeys : [...acrossKeys, otherColumn];

  const drafts = [...rowDrafts.values()].sort((a, b) => {
    for (let i = 0; i < a.keys.length; i += 1) {
      const order = compareKeys(a.keys[i], b.keys[i]);
      if (order !== 0) {
        return order;
      }
    }
    return 0;
  });
  const pivotRows: PivotRow[] = drafts.map((draft) => {
    const cells = orderedColumns.map((col) => {
      if (otherColumn !== null && col === otherColumn) {
        const acc = newAcc();
        for (const member of otherColumn.members) {
          const cell = draft.cells.get(member);
          if (cell !== undefined) {
            mergeAcc(acc, cell);
          }
        }
        return acc.rows === 0 ? null : valueOf(acc, agg, countRows);
      }
      const cell = draft.cells.get(col.key.key);
      return cell === undefined ? null : valueOf(cell, agg, countRows);
    });
    return { labels: draft.keys.map((key) => key.label), cells, total: valueOf(draft.total, agg, countRows) };
  });
  return {
    dims: dims.map((dim) => dim.name),
    column: across?.name ?? null,
    valueLabel: seriesLabel(agg, value?.name ?? null),
    columnLabels: orderedColumns.map((col) => col.key.label),
    rows: pivotRows,
    totals: orderedColumns.map((col) => valueOf(col.total, agg, countRows)),
    grand: rows.length === 0 ? null : valueOf(grand, agg, countRows),
    mergedColumns,
  };
}

// The pivot as a plain table: the row dimensions, then a column per value
// across and their total (or the one value column), and a totals row last.
export function pivotTable(model: PivotModel, totalLabel: string): { columns: string[]; rows: unknown[][] } {
  const dims = model.dims.length > 0 ? model.dims : [""];
  const spread = model.column !== null;
  const columns = spread ? [...dims, ...model.columnLabels, totalLabel] : [...dims, model.valueLabel];
  const rows: unknown[][] = model.rows.map((row) =>
    spread ? [...row.labels, ...row.cells, row.total] : [...row.labels, row.total],
  );
  const totalsRow: unknown[] = [totalLabel, ...dims.slice(1).map(() => null)];
  if (spread) {
    totalsRow.push(...model.totals, model.grand);
  } else {
    totalsRow.push(model.grand);
  }
  rows.push(totalsRow);
  return { columns, rows };
}

function tsvField(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return textOf(value).replace(/[\t\r\n]+/g, " ");
}

// Tab-separated text of a table, a header line first, for pasting into a
// spreadsheet.
export function toTsv(columns: string[], rows: unknown[][]): string {
  return [columns, ...rows].map((row) => row.map(tsvField).join("\t")).join("\n");
}

// ---- Axes ----

export interface Ticks {
  domain: [number, number];
  ticks: number[];
  step: number;
}

// Round-numbered ticks (1, 2 or 5 × a power of ten apart) over a range,
// about `target` of them, the range widened to the ticks at either end.
export function niceTicks(min: number, max: number, target = 5): Ticks {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { domain: [0, 1], ticks: [0, 1], step: 1 };
  }
  if (min === max) {
    const pad = min === 0 ? 1 : Math.abs(min) * 0.1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * magnitude;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let i = 0, v = lo; v <= hi + step / 2 && i < 100; i += 1, v = lo + i * step) {
    ticks.push(cleanNumber(v));
  }
  return { domain: [lo, hi], ticks, step };
}

export type TickUnit = "second" | "minute" | "hour" | "day" | "month" | "year";

const TIME_STEPS: [TickUnit, number][] = [
  ["second", 1],
  ["second", 5],
  ["second", 15],
  ["second", 30],
  ["minute", 1],
  ["minute", 5],
  ["minute", 15],
  ["minute", 30],
  ["hour", 1],
  ["hour", 3],
  ["hour", 6],
  ["hour", 12],
  ["day", 1],
  ["day", 2],
  ["day", 7],
  ["month", 1],
  ["month", 3],
  ["month", 6],
  ["year", 1],
  ["year", 2],
  ["year", 5],
  ["year", 10],
  ["year", 25],
  ["year", 50],
  ["year", 100],
];

const UNIT_MS: Record<"second" | "minute" | "hour" | "day", number> = {
  second: 1000,
  minute: MINUTE,
  hour: HOUR,
  day: DAY,
};

// Ticks on calendar steps (every 15 minutes, 6 hours, day, week, quarter,
// year…), about `target` of them within [min, max].
export function timeTicks(min: number, max: number, target = 6): { ticks: number[]; unit: TickUnit } {
  const span = Math.max(1, max - min);
  const approx = (unit: TickUnit, count: number): number =>
    unit === "month" ? count * 30 * DAY : unit === "year" ? count * 365 * DAY : count * UNIT_MS[unit];
  const [unit, count] =
    TIME_STEPS.find(([u, c]) => span / approx(u, c) <= target) ?? TIME_STEPS[TIME_STEPS.length - 1];
  const ticks: number[] = [];
  if (unit === "month" || unit === "year") {
    const start = new Date(min);
    let year = start.getUTCFullYear();
    let month = unit === "year" ? 0 : start.getUTCMonth() - (start.getUTCMonth() % count);
    if (unit === "year") {
      year -= year % count;
    }
    for (let i = 0; i < 200; i += 1) {
      const at = Date.UTC(year, month, 1);
      if (at > max) {
        break;
      }
      if (at >= min) {
        ticks.push(at);
      }
      if (unit === "year") {
        year += count;
      } else {
        month += count;
      }
    }
  } else {
    const step = approx(unit, count);
    // Weeks start on Monday; other steps line up from midnight.
    let first = count === 7 && unit === "day" ? floorTime(min, "week") : min - mod(min, step);
    if (first < min) {
      first += step;
    }
    for (let at = first, i = 0; at <= max && i < 200; at += step, i += 1) {
      ticks.push(at);
    }
  }
  return { ticks, unit };
}

// A time tick's label: as short as its step allows, the day kept where the
// ticks run across days.
export function formatTimeTick(ms: number, unit: TickUnit, spanMs: number, kind: TimeKind): string {
  const full = formatTime(ms, "none", "datetime");
  const day = full.slice(0, 10);
  const clock = full.slice(11, 16);
  if (kind === "time") {
    return unit === "second" ? full.slice(11, 19) : clock;
  }
  switch (unit) {
    case "year":
      return day.slice(0, 4);
    case "month":
      return day.slice(0, 7);
    case "day":
      return spanMs > 300 * DAY ? day : day.slice(5);
    case "second":
      return full.slice(11, 19);
    default:
      return spanMs > DAY ? `${day.slice(5)} ${clock}` : clock;
  }
}

// A number in full, for tooltips and the pivot: grouped, up to six decimals.
export function formatNumber(value: number, locale?: string): string {
  return value.toLocaleString(locale, { maximumFractionDigits: 6 });
}

// An axis label: compact (12만, 120K) on an axis reaching a hundred thousand,
// so all its labels read alike, else in full with the decimals the tick step
// needs.
export function formatTick(
  value: number,
  step: number,
  locale?: string,
  compact = Math.abs(value) >= 100_000,
): string {
  if (compact) {
    return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
  }
  const decimals = step > 0 && step < 1 ? Math.min(6, Math.ceil(-Math.log10(step))) : 0;
  return value.toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// Whether an axis over `domain` labels its ticks compactly.
export function compactAxis(domain: [number, number]): boolean {
  return Math.max(Math.abs(domain[0]), Math.abs(domain[1])) >= 100_000;
}
