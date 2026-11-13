import { describe, expect, it } from "vitest";
import {
  type FilterRow,
  buildCountSql,
  buildDataSql,
  buildFragment,
  buildWhere,
  cycleSort,
  literalValue,
} from "./dataQuery";
import { sql as mssql } from "./engines/mssql/sql";
import { sql as mysql } from "./engines/mysql/sql";
import { sql as oracle } from "./engines/oracle/sql";
import { sql as postgres } from "./engines/postgres/sql";

function row(overrides: Partial<FilterRow>): FilterRow {
  return { id: "r", column: "name", op: "=", value: "", enabled: true, ...overrides };
}

describe("literalValue", () => {
  it("reads numbers, NULL and booleans as such, and quotes the rest", () => {
    expect(literalValue("42", postgres)).toBe("42");
    expect(literalValue(" -1.5e3 ", postgres)).toBe("-1.5e3");
    expect(literalValue("null", postgres)).toBe("NULL");
    expect(literalValue("O'Brien", postgres)).toBe("'O''Brien'");
    expect(literalValue("1a", postgres)).toBe("'1a'");
  });

  it("writes text in the dialect's own literal", () => {
    expect(literalValue("a\\b", mysql)).toBe("'a\\\\b'");
    expect(literalValue("한글", mssql)).toBe("N'한글'");
  });
});

describe("buildFragment", () => {
  it("quotes the column and compares with a literal", () => {
    expect(buildFragment(row({ column: "user name", op: "≥", value: "10" }), postgres)).toBe('"user name" >= 10');
    expect(buildFragment(row({ op: "≠", value: "x" }), mysql)).toBe("`name` <> 'x'");
  });

  it("quotes the value of a text column even when it looks like a number", () => {
    expect(buildFragment(row({ op: "=", value: "00123", text: true }), postgres)).toBe("\"name\" = '00123'");
  });

  it("matches LIKE anywhere unless the value has its own %", () => {
    expect(buildFragment(row({ op: "LIKE", value: "ann" }), postgres)).toBe("\"name\" LIKE '%ann%'");
    expect(buildFragment(row({ op: "NOT LIKE", value: "ann%" }), postgres)).toBe("\"name\" NOT LIKE 'ann%'");
  });

  it("escapes the value's own wildcards for CONTAINS, prefix and suffix", () => {
    expect(buildFragment(row({ op: "CONTAINS", value: "50%_off!" }), postgres)).toBe(
      "CAST(\"name\" AS TEXT) LIKE '%50!%!_off!!%' ESCAPE '!'",
    );
    expect(buildFragment(row({ op: "HAS PREFIX", value: "[a]" }), mssql)).toBe("[name] LIKE N'![a]%' ESCAPE '!'");
    expect(buildFragment(row({ op: "HAS SUFFIX", value: "_x" }), mysql)).toBe("`name` LIKE '%!_x' ESCAPE '!'");
    expect(buildFragment(row({ op: "NOT CONTAINS", value: "a" }), oracle)).toBe("\"name\" NOT LIKE '%a%' ESCAPE '!'");
  });

  it("splits IN lists and BETWEEN bounds, and drops them when empty", () => {
    expect(buildFragment(row({ op: "IN", value: "1, two, ,3" }), postgres)).toBe("\"name\" IN (1, 'two', 3)");
    expect(buildFragment(row({ op: "NOT IN", value: " , " }), postgres)).toBeNull();
    expect(buildFragment(row({ op: "BETWEEN", value: "2024-01-01, 2024-12-31" }), postgres)).toBe(
      "\"name\" BETWEEN '2024-01-01' AND '2024-12-31'",
    );
    expect(buildFragment(row({ op: "BETWEEN", value: "5" }), postgres)).toBeNull();
  });

  it("wraps raw SQL, keeping a trailing -- comment from swallowing the parenthesis", () => {
    expect(buildFragment(row({ raw: true, value: " a = 1 OR b = 2 " }), postgres)).toBe("(a = 1 OR b = 2)");
    expect(buildFragment(row({ raw: true, value: "a = 1 -- note" }), postgres)).toBe("(a = 1 -- note\n)");
    expect(buildFragment(row({ raw: true, value: "  " }), postgres)).toBeNull();
  });
});

describe("buildWhere", () => {
  it("joins the rows in effect with the filter's logic", () => {
    const filter = {
      logic: "OR" as const,
      rows: [
        row({ id: "a", column: "a", op: "IS NULL" }),
        row({ id: "b", column: "b", op: "=", value: "1", enabled: false }),
        // Applied before it was unchecked: still in effect.
        row({ id: "c", column: "c", op: "=", value: "2", enabled: false, applied: true }),
        row({ id: "d", column: "d", op: "IN", value: "" }),
      ],
    };
    expect(buildWhere(filter, postgres)).toBe('"a" IS NULL OR "c" = 2');
    expect(buildWhere({ logic: "AND", rows: [] }, postgres)).toBeNull();
  });
});

describe("buildDataSql", () => {
  it("pages each dialect its own way", () => {
    const input = { table: "app.users", limit: 50, offset: 100, sorts: [{ column: "id", dir: "desc" as const }] };
    expect(buildDataSql({ ...input, dialect: postgres })).toBe(
      'SELECT * FROM "app"."users" ORDER BY "id" DESC LIMIT 50 OFFSET 100',
    );
    expect(buildDataSql({ ...input, dialect: mssql })).toBe(
      "SELECT * FROM [app].[users] ORDER BY [id] DESC OFFSET 100 ROWS FETCH NEXT 50 ROWS ONLY",
    );
    expect(buildDataSql({ ...input, dialect: oracle })).toBe(
      'SELECT * FROM "app"."users" ORDER BY "id" DESC OFFSET 100 ROWS FETCH NEXT 50 ROWS ONLY',
    );
  });

  it("orders by the primary key when nothing else is asked, and keeps the limit sane", () => {
    expect(buildDataSql({ dialect: postgres, table: "t", pk: ["a", "b"], limit: Number.NaN, offset: -5 })).toBe(
      'SELECT * FROM "t" ORDER BY "a", "b" LIMIT 100',
    );
    expect(buildDataSql({ dialect: mssql, table: "t", limit: 10 })).toBe(
      "SELECT * FROM [t] ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY",
    );
  });

  it("counts under the same filter", () => {
    const filter = { logic: "AND" as const, rows: [row({ op: "=", value: "x" })] };
    expect(buildCountSql({ dialect: mysql, table: "t", filter })).toBe("SELECT COUNT(*) FROM `t` WHERE `name` = 'x'");
  });
});

describe("cycleSort", () => {
  it("cycles one column ascending, descending, then off", () => {
    const asc = cycleSort([], "a", false);
    expect(asc).toEqual([{ column: "a", dir: "asc" }]);
    const desc = cycleSort(asc, "a", false);
    expect(desc).toEqual([{ column: "a", dir: "desc" }]);
    expect(cycleSort(desc, "a", false)).toEqual([]);
  });

  it("adds, flips and removes columns of a multi-column sort in place", () => {
    const two = cycleSort([{ column: "a", dir: "asc" }], "b", true);
    expect(two).toEqual([
      { column: "a", dir: "asc" },
      { column: "b", dir: "asc" },
    ]);
    const flipped = cycleSort(two, "a", true);
    expect(flipped).toEqual([
      { column: "a", dir: "desc" },
      { column: "b", dir: "asc" },
    ]);
    expect(cycleSort(flipped, "a", true)).toEqual([{ column: "b", dir: "asc" }]);
  });
});
