import { describe, expect, it } from "vitest";
import { gridPeek, peekModel, PEEK_ROW_CAP } from "./peek";
import { tidyNumberText } from "./rowOps";

// The testdb shop (testdb/postgres-shop.sql) summed up three ways.
const BY_STATUS = [
  ["delivered", 2400, 1809.98],
  ["paid", 1200, 1578.95],
  ["shipped", 600, 2159.99],
  ["refunded", 600, 1655.73],
  ["pending", 600, 1775.88],
  ["cancelled", 600, 2707.2],
];
const BY_MONTH = [
  ["2025-01", 920, 1717815.4],
  ["2025-02", 537, 1013307.45],
  ["2025-03", 461, 860864.5],
  ["2025-04", 445, 829532.52],
  ["2025-05", 460, 855297.3],
  ["2025-06", 446, 838216.13],
  ["2025-07", 460, 866241.5],
  ["2025-08", 460, 858699.5],
  ["2025-09", 445, 831555.18],
  ["2025-10", 460, 854984.3],
  ["2025-11", 446, 834572.72],
  ["2025-12", 460, 856903.5],
];

describe("peekModel", () => {
  it("writes a one-row result of numbers as cards", () => {
    const model = peekModel(["orders", "revenue"], [[6000, "11217990.00"]]);
    expect(model?.shape).toBe("single");
    expect(model?.cards).toEqual([
      { name: "orders", value: 6000 },
      { name: "revenue", value: 11217990 },
    ]);
  });

  it("has nothing for a one-row result holding text", () => {
    expect(peekModel(["name", "orders"], [["kim", 3]])).toBeNull();
  });

  it("finds the biggest share and the highest average by category", () => {
    const model = peekModel(["status", "orders", "avg_total"], BY_STATUS);
    expect(model?.shape).toBe("category");
    expect(model?.findings).toEqual([
      { kind: "share", label: "delivered", measure: "orders", value: 2400, total: 6000 },
      { kind: "top", label: "cancelled", measure: "avg_total", value: 2707.2, median: (1775.88 + 1809.98) / 2 },
    ]);
  });

  it("gives no share for an average", () => {
    const model = peekModel(["status", "avg_total"], BY_STATUS.map(([status, , avg]) => [status, avg]));
    expect(model?.findings[0]).toMatchObject({ kind: "top", label: "cancelled" });
  });

  it("finds the month that stands out, in time order whatever the rows' order", () => {
    const model = peekModel(["month", "orders", "revenue"], [...BY_MONTH].reverse());
    expect(model?.shape).toBe("time");
    expect(model?.axis?.labels[model.order[0]]).toBe("2025-01");
    expect(model?.findings).toEqual([
      { kind: "spike", label: "2025-01", measure: "orders", value: 920, median: 460 },
      { kind: "spike", label: "2025-01", measure: "revenue", value: 1717815.4, median: (855297.3 + 856903.5) / 2 },
    ]);
  });

  it("says when nothing stands out over time", () => {
    const model = peekModel(
      ["day", "orders"],
      [
        ["2025-01-01", 10],
        ["2025-01-02", 12],
        ["2025-01-03", 11],
      ],
    );
    expect(model?.findings).toEqual([{ kind: "even", measure: "orders", min: 10, max: 12 }]);
  });

  it("leaves lists, several label columns and key-only numbers alone", () => {
    const long = Array.from({ length: PEEK_ROW_CAP + 1 }, (_, i) => [`s${i}`, i]);
    expect(peekModel(["status", "orders"], long)).toBeNull();
    expect(peekModel(["status", "city", "orders"], [["paid", "서울", 1], ["paid", "부산", 2]])).toBeNull();
    expect(peekModel(["status", "customer_id"], [["paid", 1], ["sent", 2]])).toBeNull();
  });
});

describe("gridPeek", () => {
  it("bars the measured columns and marks the cells that stand out", () => {
    const marks = gridPeek(peekModel(["month", "orders", "revenue"], BY_MONTH), 3);
    expect(marks.barMax).toEqual([null, 920, 1717815.4]);
    expect([...marks.hot].sort()).toEqual(["0:1", "0:2"]);
  });

  it("draws no bars across negative values", () => {
    const marks = gridPeek(peekModel(["team", "balance"], [["a", -5], ["b", 10]]), 2);
    expect(marks.barMax).toEqual([null, null]);
  });

  it("still tidies floats where there is no summary", () => {
    expect(gridPeek(null, 2)).toEqual({ barMax: [null, null], hot: new Set(), tidyNumbers: true });
  });
});

describe("tidyNumberText", () => {
  it("drops the binary rounding tail and keeps everything else", () => {
    expect(tidyNumberText(271.40999999999997)).toBe("271.41");
    expect(tidyNumberText(0.1 + 0.2)).toBe("0.3");
    expect(tidyNumberText(1e-7)).toBe("1e-7");
    expect(tidyNumberText(9007199254740993)).toBe(String(9007199254740993));
    expect(tidyNumberText(123456789.123456)).toBe("123456789.123456");
  });
});
