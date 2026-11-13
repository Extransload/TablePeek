import { describe, expect, it } from "vitest";
import { sql as cassandra } from "./engines/cassandra/sql";
import { sql as mysql } from "./engines/mysql/sql";
import { sql as oracle } from "./engines/oracle/sql";
import { sql as postgres } from "./engines/postgres/sql";
import {
  bindParams,
  changesSchema,
  classifyStatement,
  extractParams,
  formatSql,
  isExplainSql,
  planSqlFor,
  reviewStatements,
  uppercaseSql,
} from "./sqlTools";

function severity(sql: string, dialect = postgres): string | null {
  return classifyStatement(sql, dialect)?.severity ?? null;
}

describe("classifyStatement", () => {
  it("lets reads and session statements through", () => {
    expect(severity("SELECT * FROM t")).toBeNull();
    expect(severity("  (SELECT 1) UNION (SELECT 2)")).toBeNull();
    expect(severity("BEGIN")).toBeNull();
    expect(severity("SET search_path TO app")).toBeNull();
    expect(severity("EXPLAIN SELECT 1")).toBeNull();
  });

  it("flags UPDATE and DELETE without WHERE as dangerous, with WHERE as writes", () => {
    expect(severity("UPDATE t SET a = 1")).toBe("danger");
    expect(severity("update t set a = 1 where id = 2")).toBe("write");
    expect(severity("DELETE FROM t")).toBe("danger");
    expect(severity("DELETE FROM t WHERE id = 1")).toBe("write");
  });

  it("is not fooled by WHERE in a string or a comment", () => {
    expect(severity("UPDATE t SET note = 'where' -- where\n")).toBe("danger");
    expect(severity("DELETE FROM t /* WHERE id = 1 */")).toBe("danger");
  });

  it("does not take keywords from a comment before the statement", () => {
    expect(severity("-- DROP TABLE t\nSELECT 1")).toBeNull();
    expect(severity("# note\nDROP TABLE t", mysql)).toBe("danger");
  });

  it("treats DDL as dangerous or a write", () => {
    expect(severity("DROP TABLE t")).toBe("danger");
    expect(severity("TRUNCATE t")).toBe("danger");
    expect(severity("ALTER TABLE t ADD c int")).toBe("danger");
    expect(severity("CREATE TABLE t (a int)")).toBe("write");
  });

  it("sees the data change in a CTE and in EXPLAIN ANALYZE", () => {
    expect(severity("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x")).toBe("write");
    expect(severity("WITH x AS (SELECT 1) SELECT * FROM x")).toBeNull();
    expect(severity("EXPLAIN (ANALYZE, BUFFERS) UPDATE t SET a = 1")).toBe("write");
    expect(severity("EXPLAIN (FORMAT JSON, ANALYZE) DELETE FROM t")).toBe("write");
    expect(severity("EXPLAIN ANALYZE DELETE FROM t", mysql)).toBe("write");
    expect(severity("EXPLAIN UPDATE t SET a = 1")).toBeNull();
    expect(severity("EXPLAIN (ANALYZE false, COSTS) UPDATE t SET a = 1")).toBeNull();
    expect(severity("EXPLAIN (FORMAT JSON) DELETE FROM t")).toBeNull();
  });

  it("judges an Oracle block by the statements in it", () => {
    expect(severity("BEGIN\n  DBMS_OUTPUT.PUT_LINE('x');\nEND;", oracle)).toBeNull();
    expect(severity("BEGIN\n  UPDATE t SET a = 1 WHERE id = 1;\n  DELETE FROM u;\nEND;", oracle)).toBe("danger");
    expect(severity("BEGIN EXECUTE IMMEDIATE 'DROP TABLE t'; END;", oracle)).toBe("danger");
    expect(severity("EXEC my_proc", oracle)).toBe("write");
  });

  it("treats a CQL batch as a write and cqlsh commands as session settings", () => {
    expect(severity("BEGIN BATCH INSERT INTO t (k) VALUES (1); APPLY BATCH", cassandra)).toBe("write");
    expect(severity("CONSISTENCY QUORUM", cassandra)).toBeNull();
  });
});

describe("reviewStatements", () => {
  const statements = ["SELECT 1", "INSERT INTO t VALUES (1)", "DELETE FROM t"];

  it("asks about nothing, dangerous statements only, or every write, by mode", () => {
    expect(reviewStatements(statements, 0, postgres)).toEqual([]);
    expect(reviewStatements(statements, 1, postgres).map((item) => item.keyword)).toEqual(["DELETE"]);
    expect(reviewStatements(statements, 2, postgres).map((item) => item.keyword)).toEqual(["INSERT", "DELETE"]);
  });
});

describe("changesSchema", () => {
  it("is true for DDL only", () => {
    expect(changesSchema("/* x */ create index i on t (a)")).toBe(true);
    expect(changesSchema("INSERT INTO t VALUES (1)")).toBe(false);
  });
});

describe("parameters", () => {
  const sql = "SELECT * FROM t WHERE a = :a AND b IN (:b, :a) AND c = ':skip' AND d::text = :d -- :nope";

  it("finds :named parameters outside strings, comments and :: casts", () => {
    expect(extractParams(sql, postgres)).toEqual(["a", "b", "d"]);
  });

  it("binds the values as literals and leaves unknown names alone", () => {
    const bound = bindParams(sql, { a: "x'y", b: "2" }, (value) => `'${value.replace(/'/g, "''")}'`, postgres);
    expect(bound).toBe(
      "SELECT * FROM t WHERE a = 'x''y' AND b IN ('2', 'x''y') AND c = ':skip' AND d::text = :d -- :nope",
    );
  });
});

describe("formatSql", () => {
  it("puts each clause on its own line, keeping strings and nested queries as written", () => {
    expect(
      formatSql("select a, 'from x' as s from t where a = 1 and b in (select b from u where c) order by a", "beautify", postgres),
    ).toBe(["SELECT a, 'from x' AS s", "FROM t", "WHERE a = 1", "  AND b IN (SELECT b FROM u WHERE c)", "ORDER BY a"].join("\n"));
  });

  it("minifies to one line, turning line comments into block comments", () => {
    expect(formatSql("SELECT a -- the a\nFROM t\n\n WHERE b = 'x  y'", "minify", postgres)).toBe(
      "SELECT a /* the a */ FROM t WHERE b = 'x  y'",
    );
  });

  it("keeps a string continued on the next line as one literal", () => {
    expect(formatSql("SELECT 'a'\n'b'", "minify", postgres)).toBe("SELECT 'a'\n'b'");
  });
});

describe("uppercaseSql", () => {
  it("upper-cases keywords only", () => {
    expect(uppercaseSql("select name, 'select' from users -- from", postgres)).toBe(
      "SELECT name, 'select' FROM users -- from",
    );
  });
});

describe("explain helpers", () => {
  it("sees EXPLAIN past leading comments", () => {
    expect(isExplainSql("-- why\n/* more */\n  explain select 1")).toBe(true);
    expect(isExplainSql("# note\nEXPLAIN SELECT 1")).toBe(true);
    expect(isExplainSql("SELECT 'explain'")).toBe(false);
    expect(isExplainSql("explained")).toBe(false);
  });

  it("adds the prefix only when the query isn't an EXPLAIN already", () => {
    expect(planSqlFor(" SELECT 1 ", "EXPLAIN (FORMAT JSON) ")).toBe("EXPLAIN (FORMAT JSON) SELECT 1");
    expect(planSqlFor("EXPLAIN SELECT 1", "EXPLAIN (FORMAT JSON) ")).toBe("EXPLAIN SELECT 1");
  });
});
