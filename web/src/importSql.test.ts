import { describe, expect, it } from "vitest";
import { sql as cassandra } from "./engines/cassandra/sql";
import { sql as mssql } from "./engines/mssql/sql";
import { sql as mysql } from "./engines/mysql/sql";
import { sql as postgres } from "./engines/postgres/sql";
import { sql as sqlite } from "./engines/sqlite/sql";
import type { SqlDialect } from "./engines/sqlDialect";
import { JsonNumber } from "./importParse";
import { type InsertSpec, collapseRepeats, importLiteral, insertStatement, modeNeedsKey } from "./importSql";

function spec(dialect: SqlDialect, mode: InsertSpec["mode"]): InsertSpec {
  return { dialect, table: "app.users", columns: ["id", "name"], pk: ["id"], mode };
}

const rows = [
  ["1", "'a'"],
  ["2", "'b'"],
];

describe("importLiteral", () => {
  it("writes NULL, booleans, numbers and text in the dialect's form", () => {
    expect(importLiteral(null, postgres)).toBe("NULL");
    expect(importLiteral(true, postgres)).toBe("TRUE");
    expect(importLiteral(1.5, postgres)).toBe("1.5");
    expect(importLiteral(Number.POSITIVE_INFINITY, postgres)).toBe("'Infinity'");
    expect(importLiteral("it's", postgres)).toBe("'it''s'");
    expect(importLiteral({ a: 1 }, postgres)).toBe(`'{"a":1}'`);
  });

  it("writes a big JSON number's digits without an exponent", () => {
    expect(importLiteral(new JsonNumber("12345678901234567890"), postgres)).toBe("12345678901234567890");
    expect(importLiteral(new JsonNumber("1.5e20"), mysql)).toBe("150000000000000000000");
  });

  it("writes a number the engine can't hold as text", () => {
    // Past a 64-bit integer, SQLite would round it to a float.
    expect(importLiteral(new JsonNumber("99999999999999999999"), sqlite)).toBe("'99999999999999999999'");
    expect(importLiteral(new JsonNumber("9223372036854775807"), sqlite)).toBe("9223372036854775807");
    // SQL Server's DECIMAL holds 38 digits.
    expect(importLiteral(new JsonNumber(`1${"0".repeat(38)}`), mssql)).toBe(`N'1${"0".repeat(38)}'`);
  });
});

describe("insertStatement", () => {
  it("writes one multi-row INSERT", () => {
    expect(insertStatement(spec(postgres, "insert"), rows)).toBe(
      'INSERT INTO "app"."users" ("id", "name") VALUES\n  (1, \'a\'),\n  (2, \'b\')',
    );
  });

  it("upserts with ON CONFLICT on the key, or DO NOTHING when only key columns are written", () => {
    expect(insertStatement(spec(postgres, "upsert"), rows)).toBe(
      'INSERT INTO "app"."users" ("id", "name") VALUES\n  (1, \'a\'),\n  (2, \'b\')\nON CONFLICT ("id") DO UPDATE SET "name" = excluded."name"',
    );
    expect(insertStatement({ ...spec(postgres, "upsert"), columns: ["id"] }, [["1"]])).toBe(
      'INSERT INTO "app"."users" ("id") VALUES\n  (1)\nON CONFLICT ("id") DO NOTHING',
    );
  });

  it("uses MySQL's ON DUPLICATE KEY UPDATE and each engine's REPLACE", () => {
    expect(insertStatement(spec(mysql, "upsert"), rows)).toMatch(/\nON DUPLICATE KEY UPDATE `name` = /);
    expect(insertStatement(spec(sqlite, "replace"), rows)).toMatch(/^INSERT OR REPLACE INTO "app"\."users"/);
    expect(insertStatement(spec(mysql, "replace"), rows)).toMatch(/^REPLACE INTO `app`\.`users`/);
  });

  it("batches one-row INSERTs where VALUES takes one row", () => {
    expect(insertStatement({ ...spec(cassandra, "insert"), table: "ks.users" }, rows)).toBe(
      [
        "BEGIN UNLOGGED BATCH",
        '  INSERT INTO "ks"."users" ("id", "name") VALUES (1, \'a\');',
        '  INSERT INTO "ks"."users" ("id", "name") VALUES (2, \'b\');',
        "APPLY BATCH",
      ].join("\n"),
    );
  });
});

describe("collapseRepeats", () => {
  it("keeps only the last row of each key for a PostgreSQL upsert", () => {
    const repeated = [
      ["1", "'a'"],
      ["2", "'b'"],
      ["1", "'c'"],
    ];
    expect(collapseRepeats(spec(postgres, "upsert"), repeated)).toEqual([
      ["2", "'b'"],
      ["1", "'c'"],
    ]);
    expect(collapseRepeats(spec(postgres, "insert"), repeated)).toBe(repeated);
    expect(collapseRepeats(spec(mysql, "upsert"), repeated)).toBe(repeated);
  });

  it("matches key columns ignoring case", () => {
    const upper = { ...spec(postgres, "upsert"), columns: ["ID", "name"] };
    expect(collapseRepeats(upper, [["1", "'a'"], ["1", "'b'"]])).toEqual([["1", "'b'"]]);
  });
});

describe("modeNeedsKey", () => {
  it("asks for a key only where the engine's upsert names one", () => {
    expect(modeNeedsKey("upsert", postgres)).toBe(true);
    expect(modeNeedsKey("upsert", mysql)).toBe(false);
    expect(modeNeedsKey("replace", postgres)).toBe(false);
  });
});
