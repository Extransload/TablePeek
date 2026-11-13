import { describe, expect, it } from "vitest";
import {
  type ChartSettings,
  type PivotSettings,
  autoBucket,
  buildChart,
  buildPivot,
  cleanNumber,
  defaultChart,
  floorTime,
  formatTime,
  inferColumns,
  niceTicks,
  pivotTable,
  resolveChart,
  toNumber,
  toTime,
  toTsv,
} from "./chartData";

function chart(overrides: Partial<ChartSettings>): ChartSettings {
  return {
    type: "bar",
    x: null,
    y: [],
    agg: "sum",
    bucket: "auto",
    sort: "x",
    limit: 0,
    stacked: false,
    donut: false,
    ...overrides,
  };
}

function pivot(overrides: Partial<PivotSettings>): PivotSettings {
  return { rows: [], column: null, value: null, agg: "sum", bucket: "auto", ...overrides };
}

describe("toNumber", () => {
  it("reads numbers, big integers and the decimal text drivers send", () => {
    expect(toNumber(3)).toBe(3);
    expect(toNumber(10n)).toBe(10);
    expect(toNumber(" -1.5e2 ")).toBe(-150);
    expect(toNumber(".5")).toBe(0.5);
  });

  it("reads nothing else as a number", () => {
    expect(toNumber(null)).toBeNull();
    expect(toNumber("")).toBeNull();
    expect(toNumber("12abc")).toBeNull();
    expect(toNumber("0x10")).toBeNull();
    expect(toNumber(Number.NaN)).toBeNull();
    expect(toNumber(true)).toBeNull();
  });
});

describe("toTime", () => {
  it("keeps the wall-clock reading, whatever the offset", () => {
    expect(toTime("2024-03-05 14:00:00+09")).toBe(Date.UTC(2024, 2, 5, 14));
    expect(toTime("2024-03-05T14:00:00Z")).toBe(Date.UTC(2024, 2, 5, 14));
    expect(toTime("2024-03-05")).toBe(Date.UTC(2024, 2, 5));
  });

  it("keeps milliseconds of a longer fraction", () => {
    expect(toTime("2024-03-05 14:00:00.123456")).toBe(Date.UTC(2024, 2, 5, 14, 0, 0, 123));
  });

  it("places a time of day on 1970-01-01", () => {
    expect(toTime("01:02:03.5")).toBe(3_723_500);
  });

  it("rejects impossible months and days", () => {
    expect(toTime("2024-13-01")).toBeNull();
    expect(toTime("2024-01-00")).toBeNull();
    expect(toTime("yesterday")).toBeNull();
  });
});

describe("inferColumns", () => {
  it("tells numbers, dates, datetimes, times and text apart", () => {
    const rows = [
      [1, "2024-01-01", "2024-01-01", "10:00:00", "a", null],
      ["2.5", "2024-01-02", "2024-01-02 10:00", "11:00:00", "b", null],
      [null, null, null, null, "3", null],
    ];
    const kinds = inferColumns(["n", "d", "dt", "t", "s", "empty"], rows).map((column) => [column.type, column.time]);
    expect(kinds).toEqual([
      ["number", undefined],
      ["time", "date"],
      // Days with a timestamp or two among them read as datetimes.
      ["time", "datetime"],
      ["time", "time"],
      ["text", undefined],
      ["text", undefined],
    ]);
  });

  it("reads a boolean column as categories, even when its values are 0 and 1", () => {
    expect(inferColumns(["flag"], [[0], [1]], ["boolean"])[0].type).toBe("text");
  });

  it("does not mix dates and times of day", () => {
    expect(inferColumns(["x"], [["2024-01-01"], ["10:00:00"]])[0].type).toBe("text");
  });
});

describe("floorTime", () => {
  it("starts weeks on Monday", () => {
    // 2024-03-07 was a Thursday.
    expect(floorTime(Date.UTC(2024, 2, 7, 15, 30), "week")).toBe(Date.UTC(2024, 2, 4));
    // Sunday belongs to the week before.
    expect(floorTime(Date.UTC(2024, 2, 10), "week")).toBe(Date.UTC(2024, 2, 4));
  });

  it("floors to the month and year", () => {
    expect(floorTime(Date.UTC(2024, 1, 29, 23), "month")).toBe(Date.UTC(2024, 1, 1));
    expect(floorTime(Date.UTC(2024, 11, 31), "year")).toBe(Date.UTC(2024, 0, 1));
  });

  it("floors times before 1970 too", () => {
    expect(floorTime(Date.UTC(1969, 11, 31, 23, 59, 30), "minute")).toBe(Date.UTC(1969, 11, 31, 23, 59));
  });
});

describe("autoBucket", () => {
  it("keeps few values as they are", () => {
    expect(autoBucket([1, 2, 3])).toBe("none");
  });

  it("picks the finest bucket under sixty groups", () => {
    const days = Array.from({ length: 90 }, (_, i) => Date.UTC(2024, 0, 1 + i, 12));
    expect(autoBucket(days)).toBe("week");
    const hours = Array.from({ length: 200 }, (_, i) => Date.UTC(2024, 0, 1, 0, i * 5));
    expect(autoBucket(hours)).toBe("hour");
  });
});

describe("formatTime", () => {
  it("reads as precisely as the bucket", () => {
    const at = Date.UTC(2024, 2, 5, 14, 7, 9, 50);
    expect(formatTime(at, "year")).toBe("2024");
    expect(formatTime(at, "month")).toBe("2024-03");
    expect(formatTime(at, "day")).toBe("2024-03-05");
    expect(formatTime(at, "hour")).toBe("2024-03-05 14:07");
    expect(formatTime(at, "none")).toBe("2024-03-05 14:07:09.050");
    expect(formatTime(at, "none", "date")).toBe("2024-03-05");
    expect(formatTime(3_723_000, "none", "time")).toBe("01:02:03");
  });
});

describe("cleanNumber", () => {
  it("trims float noise", () => {
    expect(cleanNumber(0.1 + 0.2)).toBe(0.3);
    expect(cleanNumber(7)).toBe(7);
  });
});

describe("buildChart", () => {
  const columns = inferColumns(
    ["region", "sales", "cost"],
    [
      ["east", 10, 1],
      ["west", 5, null],
    ],
  );
  const rows = [
    ["east", 10, 1],
    ["west", 5, null],
    ["east", "2.5", 3],
    [null, 1, 1],
    ["west", null, null],
    ["north", 7, 2],
  ];

  it("sums per category, skipping NULL values", () => {
    const model = buildChart(rows, columns, chart({ x: "region", y: ["sales", "cost"], agg: "sum" }));
    expect(model.series).toEqual(["sum(sales)", "sum(cost)"]);
    expect(model.points.map((point) => [point.label, point.values, point.rows])).toEqual([
      ["east", [12.5, 4], 2],
      ["north", [7, 2], 1],
      ["west", [5, null], 2],
      ["NULL", [1, 1], 1],
    ]);
  });

  it("averages over non-NULL values only and counts them", () => {
    const avg = buildChart(rows, columns, chart({ x: "region", y: ["sales"], agg: "avg" }));
    expect(avg.points.find((point) => point.label === "west")?.values).toEqual([5]);
    const count = buildChart(rows, columns, chart({ x: "region", y: ["sales"], agg: "count" }));
    expect(count.points.find((point) => point.label === "west")?.values).toEqual([1]);
  });

  it("counts rows when no value column is picked", () => {
    const model = buildChart(rows, columns, chart({ x: "region", y: [], agg: "count" }));
    expect(model.series).toEqual(["count(*)"]);
    expect(model.points.find((point) => point.label === "west")?.values).toEqual([2]);
  });

  it("has nothing to draw without a series and without COUNT", () => {
    expect(buildChart(rows, columns, chart({ x: "region", y: [], agg: "sum" })).noSeries).toBe(true);
  });

  it("sorts categories by value and folds those past the limit into one point", () => {
    const model = buildChart(
      rows,
      columns,
      chart({ x: "region", y: ["sales"], agg: "sum", sort: "value-desc", limit: 2 }),
      { other: "other", nul: "NULL" },
    );
    expect(model.points.map((point) => [point.label, point.values])).toEqual([
      ["east", [12.5]],
      ["north", [7]],
      ["other", [6]],
    ]);
    expect(model.merged).toBe(2);
    expect(model.points[2].other).toBe(true);
    expect(model.points[2].rows).toBe(3);
  });

  it("folds the right average: of the merged rows, not of their averages", () => {
    const data = [["a", 100], ["b", 1], ["b", 2], ["b", 3], ["c", 10]];
    const cols = inferColumns(["k", "v"], data);
    const model = buildChart(data, cols, chart({ x: "k", y: ["v"], agg: "avg", sort: "value-desc", limit: 1 }), {
      other: "other",
      nul: "NULL",
    });
    // b's rows (1, 2, 3) and c's (10): 16 / 4.
    expect(model.points.map((point) => [point.label, point.values])).toEqual([
      ["a", [100]],
      ["other", [4]],
    ]);
  });

  it("buckets times and skips rows whose X isn't one", () => {
    const data = [
      ["2024-01-01 10:00", 1],
      ["2024-01-01 23:59", 2],
      ["2024-01-03 00:00", 4],
      ["not a date", 8],
      [null, 16],
    ];
    const cols = inferColumns(["at", "v"], [data[0], data[1]]);
    const model = buildChart(data, cols, chart({ type: "line", x: "at", y: ["v"], agg: "sum", bucket: "day" }));
    expect(model.bucket).toBe("day");
    expect(model.points.map((point) => [point.label, point.values])).toEqual([
      ["2024-01-01", [3]],
      ["2024-01-03", [4]],
    ]);
    expect(model.skipped).toBe(2);
  });

  it("orders a line over numbers by X", () => {
    const data = [[3, 30], [1, 10], [2, 20]];
    const cols = inferColumns(["x", "y"], data);
    const model = buildChart(data, cols, chart({ type: "line", x: "x", y: ["y"], agg: "none", sort: "value-desc" }));
    expect(model.points.map((point) => point.x)).toEqual([1, 2, 3]);
  });
});

describe("defaultChart and resolveChart", () => {
  const rows = [
    [1, "east", 10],
    [2, "east", 20],
  ];
  const columns = inferColumns(["id", "region", "amount"], rows);

  it("charts the measure, not the key column, over the first text column", () => {
    const settings = defaultChart(columns, rows);
    expect(settings).toMatchObject({ type: "bar", x: "region", y: ["amount"], agg: "sum", sort: "value-desc" });
  });

  it("drops saved columns the result no longer has", () => {
    const resolved = resolveChart({ x: "region", y: ["gone"], agg: "max", limit: 7 as never }, columns, rows);
    expect(resolved.y).toEqual(["amount"]);
    expect(resolved.agg).toBe("max");
    // 7 isn't one of the offered limits.
    expect(resolved.limit).toBe(20);
    expect(resolveChart({ x: "gone" }, columns, rows)).toEqual(defaultChart(columns, rows));
  });
});

describe("buildPivot", () => {
  const rows = [
    ["east", "2024-01-05", 10],
    ["east", "2024-02-01", 5],
    ["west", "2024-01-20", 7],
    ["west", "2024-01-21", null],
    [null, "2024-02-02", 1],
  ];
  const columns = inferColumns(["region", "day", "amount"], rows);

  it("spreads a column dimension across, with row, column and grand totals", () => {
    const model = buildPivot(rows, columns, pivot({ rows: ["region"], column: "day", value: "amount", agg: "sum", bucket: "month" }));
    expect(model.valueLabel).toBe("sum(amount)");
    expect(model.columnLabels).toEqual(["2024-01", "2024-02"]);
    expect(model.rows).toEqual([
      { labels: ["east"], cells: [10, 5], total: 15 },
      { labels: ["west"], cells: [7, null], total: 7 },
      { labels: ["NULL"], cells: [null, 1], total: 1 },
    ]);
    expect(model.totals).toEqual([17, 6]);
    expect(model.grand).toBe(23);
  });

  it("averages totals over the underlying rows", () => {
    const model = buildPivot(rows, columns, pivot({ rows: ["region"], value: "amount", agg: "avg" }));
    expect(model.rows.map((row) => row.total)).toEqual([7.5, 7, 1]);
    // (10 + 5 + 7 + 1) / 4, the NULL left out.
    expect(model.grand).toBe(5.75);
  });

  it("counts rows without a value column", () => {
    const model = buildPivot(rows, columns, pivot({ rows: ["region"], value: null, agg: "sum" }));
    expect(model.valueLabel).toBe("count(*)");
    expect(model.rows.map((row) => row.total)).toEqual([2, 2, 1]);
    expect(model.grand).toBe(5);
  });

  it("writes out as a table with a totals row", () => {
    const model = buildPivot(rows, columns, pivot({ rows: ["region"], column: "day", value: "amount", bucket: "month" }));
    expect(pivotTable(model, "Total")).toEqual({
      columns: ["region", "2024-01", "2024-02", "Total"],
      rows: [
        ["east", 10, 5, 15],
        ["west", 7, null, 7],
        ["NULL", null, 1, 1],
        ["Total", 17, 6, 23],
      ],
    });
  });
});

describe("toTsv", () => {
  it("flattens tabs and line breaks inside values", () => {
    expect(toTsv(["a", "b"], [["x\ty", "1\n2"], [null, 3]])).toBe("a\tb\nx y\t1 2\n\t3");
  });
});

describe("niceTicks", () => {
  it("steps by 1, 2 or 5 times a power of ten over a widened range", () => {
    expect(niceTicks(0, 97)).toEqual({ domain: [0, 100], ticks: [0, 20, 40, 60, 80, 100], step: 20 });
    expect(niceTicks(0.1, 0.33).ticks).toEqual([0.1, 0.15, 0.2, 0.25, 0.3, 0.35]);
  });

  it("widens a single value into a range", () => {
    const ticks = niceTicks(5, 5);
    expect(ticks.domain[0]).toBeLessThan(5);
    expect(ticks.domain[1]).toBeGreaterThan(5);
  });
});
