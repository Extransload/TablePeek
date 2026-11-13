import { describe, expect, it } from "vitest";
import { sql as cassandra } from "./engines/cassandra/sql";
import { sql as mssql } from "./engines/mssql/sql";
import { sql as mysql } from "./engines/mysql/sql";
import { sql as oracle } from "./engines/oracle/sql";
import { sql as postgres } from "./engines/postgres/sql";
import { sql as sqlite } from "./engines/sqlite/sql";
import { scriptStatement, splitSqlRanges, splitSqlStatements, statementAt } from "./sqlSplit";

describe("splitSqlStatements", () => {
  it("splits on semicolons and drops empty statements", () => {
    expect(splitSqlStatements("SELECT 1;\n\n;SELECT 2;  SELECT 3")).toEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
  });

  it("does not split inside strings, quoted names or comments", () => {
    const script = [
      "SELECT 'a;b', \"c;d\", `e;f` FROM t; -- x;y",
      "/* one; two */ SELECT 2;",
      "SELECT 'it''s; fine'",
    ].join("\n");
    expect(splitSqlStatements(script)).toEqual([
      "SELECT 'a;b', \"c;d\", `e;f` FROM t",
      "-- x;y\n/* one; two */ SELECT 2",
      "SELECT 'it''s; fine'",
    ]);
  });

  it("drops a stretch holding only comments", () => {
    expect(splitSqlStatements("SELECT 1;\n-- the end;\n/* nothing */")).toEqual(["SELECT 1"]);
  });

  it("keeps PostgreSQL's dollar-quoted function bodies whole", () => {
    const fn = "CREATE FUNCTION f() RETURNS int AS $body$ BEGIN RETURN 1; END; $body$ LANGUAGE plpgsql";
    expect(splitSqlStatements(`${fn};\nSELECT f();`, postgres)).toEqual([fn, "SELECT f()"]);
  });

  it("reads backslash escapes only where the dialect has them", () => {
    const text = "SELECT 'a\\'; SELECT 1; '";
    // MySQL: \' is an escaped quote, so the string runs to the last quote.
    expect(splitSqlStatements(text, mysql)).toEqual([text]);
    // PostgreSQL: a backslash is a plain character in a standard string.
    expect(splitSqlStatements(text, postgres)).toEqual(["SELECT 'a\\'", "SELECT 1", "'"]);
    // ...but escapes in an E'' string.
    expect(splitSqlStatements("SELECT E'a\\'; b'; SELECT 2", postgres)).toEqual(["SELECT E'a\\'; b'", "SELECT 2"]);
  });

  it("reads # as a comment only in MySQL", () => {
    expect(splitSqlStatements("SELECT 1 # x; y\n;", mysql)).toEqual(["SELECT 1 # x; y"]);
    expect(splitSqlStatements("SELECT '{a}'::jsonb #> '{a}'; SELECT 2", postgres)).toEqual([
      "SELECT '{a}'::jsonb #> '{a}'",
      "SELECT 2",
    ]);
  });

  it("keeps SQL Server and SQLite [bracketed; names] whole", () => {
    expect(splitSqlStatements("SELECT [a;b] FROM t; SELECT 2", mssql)).toEqual(["SELECT [a;b] FROM t", "SELECT 2"]);
    expect(splitSqlStatements("SELECT [a;b] FROM t; SELECT 2", sqlite)).toEqual(["SELECT [a;b] FROM t", "SELECT 2"]);
  });

  it("keeps a trigger's BEGIN … END body as one statement", () => {
    const trigger = [
      "CREATE TRIGGER trg AFTER INSERT ON t FOR EACH ROW",
      "BEGIN",
      "  UPDATE counts SET n = n + 1;",
      "  IF NEW.x > 0 THEN",
      "    INSERT INTO log VALUES (NEW.x);",
      "  END IF;",
      "END",
    ].join("\n");
    expect(splitSqlStatements(`${trigger};\nSELECT 1;`, mysql)).toEqual([trigger, "SELECT 1"]);
  });

  it("reads BEGIN; as a transaction, not a block", () => {
    expect(splitSqlStatements("BEGIN; UPDATE t SET a = 1; COMMIT;", postgres)).toEqual([
      "BEGIN",
      "UPDATE t SET a = 1",
      "COMMIT",
    ]);
  });

  it("closes a CASE expression with its END", () => {
    expect(splitSqlStatements("SELECT CASE WHEN a THEN 1 ELSE 2 END FROM t; SELECT 2", postgres)).toEqual([
      "SELECT CASE WHEN a THEN 1 ELSE 2 END FROM t",
      "SELECT 2",
    ]);
  });

  it("does not take a column named begin or end for a block", () => {
    expect(splitSqlStatements("SELECT t.begin, t.end FROM t; SELECT 2", postgres)).toEqual([
      "SELECT t.begin, t.end FROM t",
      "SELECT 2",
    ]);
  });

  it("runs a SQL Server TRY/CATCH block to its last END", () => {
    const block = "BEGIN TRY\n  SELECT 1/0;\nEND TRY\nBEGIN CATCH\n  SELECT ERROR_MESSAGE();\nEND CATCH";
    expect(splitSqlStatements(`${block};\nSELECT 2;`, mssql)).toEqual([block, "SELECT 2"]);
  });

  it("ends Oracle PL/SQL units only at a / line, and keeps their END;", () => {
    const script = [
      "CREATE OR REPLACE PROCEDURE p AS",
      "BEGIN",
      "  UPDATE t SET a = 1;",
      "END;",
      "/",
      "SELECT 1 FROM dual;",
      "SELECT 2 FROM dual",
      "/",
    ].join("\n");
    expect(splitSqlStatements(script, oracle)).toEqual([
      "CREATE OR REPLACE PROCEDURE p AS\nBEGIN\n  UPDATE t SET a = 1;\nEND;",
      "SELECT 1 FROM dual",
      "SELECT 2 FROM dual",
    ]);
  });

  it("reads Oracle q'[…]' strings, whose quotes and ;s are text", () => {
    expect(splitSqlStatements("SELECT q'[it's; here]' FROM dual; SELECT 2 FROM dual", oracle)).toEqual([
      "SELECT q'[it's; here]' FROM dual",
      "SELECT 2 FROM dual",
    ]);
  });

  it("keeps a CQL batch as one statement", () => {
    const batch = "BEGIN BATCH\n  INSERT INTO t (k) VALUES (1);\n  INSERT INTO t (k) VALUES (2);\nAPPLY BATCH";
    expect(splitSqlStatements(`${batch};\nSELECT * FROM t;`, cassandra)).toEqual([batch, "SELECT * FROM t"]);
  });

  it("reads // as a comment in CQL", () => {
    expect(splitSqlStatements("SELECT 1 // a; b\n;", cassandra)).toEqual(["SELECT 1 // a; b"]);
  });

  it("runs MySQL's /*! … */ executable comments as code", () => {
    expect(splitSqlStatements("/*!40101 SET NAMES utf8 */;\n/* plain */;", mysql)).toEqual(["/*!40101 SET NAMES utf8 */"]);
  });
});

describe("splitSqlRanges", () => {
  it("gives each statement's place, its leading comment included", () => {
    const text = "SELECT 1;\n-- why\nSELECT 2;";
    const ranges = splitSqlRanges(text);
    expect(ranges).toHaveLength(2);
    expect(ranges[1]).toEqual({ from: 10, codeFrom: 17, to: text.length, text: "-- why\nSELECT 2" });
    expect(text.slice(ranges[0].from, ranges[0].to)).toBe("SELECT 1;");
  });
});

describe("statementAt", () => {
  const text = "SELECT 1;\n\nSELECT 2; -- note\n-- SELECT 3;\nSELECT 4";

  it("finds the statement the cursor is in", () => {
    expect(statementAt(text, text.indexOf("2"))?.text).toBe("SELECT 2");
    // Comments just before a statement are part of it.
    const last = statementAt(text, text.length);
    expect(last?.codeFrom).toBe(text.indexOf("SELECT 4"));
    expect(last?.text).toBe("-- note\n-- SELECT 3;\nSELECT 4");
  });

  it("takes the statement before when only the rest of its line follows", () => {
    expect(statementAt(text, text.indexOf("note"))?.text).toBe("SELECT 2");
  });

  it("takes the statement before across blank lines", () => {
    expect(statementAt(text, text.indexOf("\n\n") + 1)?.text).toBe("SELECT 1");
  });

  it("runs nothing for a cursor on a commented-out line", () => {
    expect(statementAt(text, text.indexOf("-- SELECT 3"))).toBeNull();
  });
});

describe("scriptStatement", () => {
  it("ends Oracle PL/SQL with a / line and other statements with ;", () => {
    expect(scriptStatement("BEGIN NULL; END;", oracle)).toBe("BEGIN NULL; END;\n/");
    expect(scriptStatement("SELECT 1 FROM dual", oracle)).toBe("SELECT 1 FROM dual;");
    expect(scriptStatement("BEGIN NULL; END", postgres)).toBe("BEGIN NULL; END;");
  });
});
