import { describe, expect, it } from "vitest";
import { sql as mysql } from "./engines/mysql/sql";
import { sql as postgres } from "./engines/postgres/sql";
import { sql as sqlite } from "./engines/sqlite/sql";
import { parseExplainPlan, parseMysqlPlan, parseOraclePlan, parsePostgresPlan, parseSqlitePlan } from "./explainPlan";

describe("parsePostgresPlan", () => {
  const plan = [
    {
      Plan: {
        "Node Type": "Hash Join",
        "Join Type": "Inner",
        "Startup Cost": 1.5,
        "Total Cost": 42.25,
        "Plan Rows": 100,
        "Actual Rows": 2000,
        "Actual Total Time": 3.456,
        "Hash Cond": "(o.user_id = u.id)",
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Relation Name": "orders",
            Alias: "o",
            "Total Cost": 20,
            "Plan Rows": 1000,
            "Actual Rows": 1000,
            Filter: "(total > 10)",
          },
          {
            "Node Type": "Index Scan",
            "Relation Name": "users",
            Alias: "users",
            "Index Name": "users_pkey",
            "Plan Rows": "10",
            "Actual Rows": 4,
          },
        ],
      },
    },
  ];

  it("builds the node tree with costs, rows and conditions", () => {
    const parsed = parsePostgresPlan([[JSON.stringify(plan)]]);
    expect(parsed).not.toBeNull();
    const [root] = parsed!.nodes;
    expect(root.label).toBe("Hash Join");
    expect(root.subtitle).toBe("Inner");
    expect(root.costLabel).toBe("1.50..42.25");
    expect(root.detail).toBe("Hash Cond: (o.user_id = u.id)");
    expect(root.children.map((child) => child.label)).toEqual(["Seq Scan", "Index Scan"]);
    const [scan, index] = root.children;
    expect(scan.subtitle).toBe("orders · as o");
    expect(scan.costLabel).toBe("?..20.00");
    expect(scan.detail).toBe("Filter: (total > 10)");
    // An alias equal to the table name isn't repeated.
    expect(index.subtitle).toBe("users · users_pkey");
    expect(index.rows).toBe(10);
  });

  it("flags estimates far off the actual row counts", () => {
    const [root] = parsePostgresPlan([[JSON.stringify(plan)]])!.nodes;
    // 2000 actual against 100 estimated: twenty times off.
    expect(root.severity).toBe("hot");
    expect(root.children[0].severity).toBe("ok");
    // 4 of 10: off by 2.5×, under the warning's 3×.
    expect(root.children[1].severity).toBe("ok");
  });

  it("returns null for anything that isn't a JSON plan", () => {
    expect(parsePostgresPlan([["Seq Scan on t  (cost=0.00..1.00 rows=1 width=4)"]])).toBeNull();
    expect(parsePostgresPlan([[JSON.stringify([{ NoPlan: true }])]])).toBeNull();
    expect(parsePostgresPlan([[42]])).toBeNull();
    expect(parsePostgresPlan([])).toBeNull();
  });
});

describe("parseMysqlPlan", () => {
  const plan = {
    query_block: {
      select_id: 1,
      cost_info: { query_cost: "12.50" },
      ordering_operation: {
        using_filesort: true,
        nested_loop: [
          {
            table: {
              table_name: "o",
              access_type: "ALL",
              rows_examined_per_scan: 1000,
              cost_info: { read_cost: "1.00", prefix_cost: "3.25" },
              attached_condition: "(`o`.`total` > 10)",
            },
          },
          {
            table: {
              table_name: "u",
              access_type: "eq_ref",
              key: "PRIMARY",
              rows_examined_per_scan: 1,
            },
          },
        ],
      },
    },
  };

  it("walks query blocks, operations and nested loops", () => {
    const parsed = parseMysqlPlan([[JSON.stringify(plan)]]);
    expect(parsed).not.toBeNull();
    const [block] = parsed!.nodes;
    expect(block.label).toBe("쿼리 블록 #1");
    expect(block.cost).toBe(12.5);
    const [ordering] = block.children;
    expect(ordering.label).toBe("ordering operation");
    expect(ordering.children.map((node) => node.subtitle)).toEqual(["ALL", "eq_ref · key PRIMARY"]);
    const [orders] = ordering.children;
    expect(orders.costLabel).toBe("read 1.00 · prefix 3.25");
    expect(orders.detail).toBe("condition: (`o`.`total` > 10)");
    expect(parsed!.costLabel).toBe("12.50");
    // The first estimate found, in tree order.
    expect(parsed!.rowsLabel).toBe((1000).toLocaleString());
  });

  it("returns null without a plan in it", () => {
    expect(parseMysqlPlan([["{}"]])).toBeNull();
    expect(parseMysqlPlan([["not json"]])).toBeNull();
  });
});

describe("parseSqlitePlan", () => {
  it("nests rows under their parent ids", () => {
    const parsed = parseSqlitePlan(
      ["id", "parent", "notused", "detail"],
      [
        [2, 0, 0, "SCAN t"],
        [5, 0, 0, "CORRELATED SCALAR SUBQUERY 1"],
        [9, 5, 0, "SEARCH u USING INTEGER PRIMARY KEY (rowid=?)"],
        [12, 0, 0, "USE TEMP B-TREE FOR ORDER BY"],
      ],
    );
    expect(parsed?.engine).toBe("sqlite");
    expect(parsed?.nodes.map((node) => node.label)).toEqual([
      "SCAN t",
      "CORRELATED SCALAR SUBQUERY 1",
      "USE TEMP B-TREE FOR ORDER BY",
    ]);
    expect(parsed?.nodes[1].children.map((node) => node.label)).toEqual([
      "SEARCH u USING INTEGER PRIMARY KEY (rowid=?)",
    ]);
  });

  it("needs a detail column", () => {
    expect(parseSqlitePlan(["id", "parent"], [[1, 0]])).toBeNull();
  });
});

describe("parseOraclePlan", () => {
  const lines = [
    "Plan hash value: 1234567890",
    "",
    "--------------------------------------------------------------------------------",
    "| Id  | Operation                    | Name    | Rows  | Bytes | Cost (%CPU)| Time     |",
    "--------------------------------------------------------------------------------",
    "|   0 | SELECT STATEMENT             |         |  2000K|    97M|  1219K  (1)| 00:00:48 |",
    "|*  1 |  HASH JOIN                   |         |  2000K|    97M|  1219K  (1)| 00:00:48 |",
    "|   2 |   TABLE ACCESS FULL          | DEPT    |     4 |    80 |     3   (0)| 00:00:01 |",
    "|*  3 |   TABLE ACCESS BY INDEX ROWID| EMP     |  1500M|    10G|   900   (2)| 00:00:01 |",
    "|   4 |    INDEX RANGE SCAN          | EMP_IX  |    10 |       |     1   (0)| 00:00:01 |",
    "--------------------------------------------------------------------------------",
    "",
    "Predicate Information (identified by operation id):",
    "---------------------------------------------------",
    "",
    '   1 - access("E"."DEPTNO"="D"."DEPTNO")',
    '   3 - filter("E"."SAL">1000 AND',
    '              "E"."JOB"=\'CLERK\')',
    "",
    "Note",
    "-----",
    "   - dynamic statistics used",
  ];
  const parsed = parseOraclePlan(
    ["PLAN_TABLE_OUTPUT"],
    lines.map((line) => [line]),
  );

  it("nests operations by their indent", () => {
    expect(parsed).not.toBeNull();
    const [root] = parsed!.nodes;
    expect(root.label).toBe("SELECT STATEMENT");
    const [join] = root.children;
    expect(join.label).toBe("HASH JOIN");
    expect(join.children.map((node) => [node.label, node.subtitle])).toEqual([
      ["TABLE ACCESS FULL", "DEPT"],
      ["TABLE ACCESS BY INDEX ROWID", "EMP"],
    ]);
    expect(join.children[1].children.map((node) => node.label)).toEqual(["INDEX RANGE SCAN"]);
  });

  it("reads DBMS_XPLAN's K/M/G figures for rows and cost", () => {
    const [root] = parsed!.nodes;
    expect(root.rows).toBe(2_000_000);
    expect(root.cost).toBe(1_219_000);
    expect(root.children[0].children[1].rows).toBe(1_500_000_000);
    expect(root.children[0].children[1].cost).toBe(900);
  });

  it("attaches predicates, continuation lines included, to their operations", () => {
    const join = parsed!.nodes[0].children[0];
    expect(join.detail).toBe('access("E"."DEPTNO"="D"."DEPTNO")');
    expect(join.children[1].detail).toBe('filter("E"."SAL">1000 AND\n"E"."JOB"=\'CLERK\')');
    expect(join.children[0].detail).toBeUndefined();
  });

  it("returns null for output that has no plan table", () => {
    expect(parseOraclePlan(["PLAN_TABLE_OUTPUT"], [["no plan"]])).toBeNull();
    expect(parseOraclePlan(["a", "b"], [[lines[3], ""]])).toBeNull();
  });
});

describe("parseExplainPlan", () => {
  it("parses with the dialect's own parser", () => {
    const pg = JSON.stringify([{ Plan: { "Node Type": "Result" } }]);
    expect(parseExplainPlan(postgres, ["QUERY PLAN"], [[pg]])?.engine).toBe("postgres");
    expect(parseExplainPlan(mysql, ["EXPLAIN"], [[JSON.stringify({ query_block: { select_id: 1 } })]])?.engine).toBe(
      "mysql",
    );
    expect(parseExplainPlan(sqlite, ["id", "parent", "notused", "detail"], [[1, 0, 0, "SCAN t"]])?.engine).toBe(
      "sqlite",
    );
    expect(parseExplainPlan(undefined, ["QUERY PLAN"], [[pg]])).toBeNull();
    expect(parseExplainPlan(postgres, ["QUERY PLAN"], [])).toBeNull();
  });
});
