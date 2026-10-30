import type { SqlDialect } from "./engines/sqlDialect";
import { t } from "./i18n";

export interface PlanNode {
  label: string;
  subtitle?: string;
  cost?: number;
  costLabel?: string;
  rows?: number;
  actualRows?: number;
  actualMs?: number;
  detail?: string;
  severity?: "ok" | "warn" | "hot";
  children: PlanNode[];
}

export interface ParsedPlan {
  engine: string;
  nodes: PlanNode[];
  costLabel?: string;
  rowsLabel?: string;
  actualLabel?: string;
  raw?: string;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function flattenNodes(nodes: PlanNode[]): PlanNode[] {
  return nodes.flatMap((node) => [node, ...flattenNodes(node.children)]);
}

function severityFor(
  estimate: number | undefined,
  actual: number | undefined,
): PlanNode["severity"] {
  if (estimate === undefined || actual === undefined || estimate <= 0) {
    return "ok";
  }
  const ratio = actual / estimate;
  if (ratio >= 10 || ratio <= 0.1) {
    return "hot";
  }
  return ratio >= 3 || ratio <= 0.34 ? "warn" : "ok";
}

function pgNode(plan: Record<string, unknown>): PlanNode {
  const type = text(plan["Node Type"]) ?? "Plan";
  const relation = text(plan["Relation Name"]);
  const alias = text(plan["Alias"]);
  const index = text(plan["Index Name"]);
  const joinType = text(plan["Join Type"]);
  const startup = num(plan["Startup Cost"]);
  const total = num(plan["Total Cost"]);
  const estimate = num(plan["Plan Rows"]);
  const actualRows = num(plan["Actual Rows"]);
  const actualMs = num(plan["Actual Total Time"]);
  const details = [
    text(plan["Filter"]) ? `Filter: ${text(plan["Filter"])}` : null,
    text(plan["Index Cond"]) ? `Index Cond: ${text(plan["Index Cond"])}` : null,
    text(plan["Hash Cond"]) ? `Hash Cond: ${text(plan["Hash Cond"])}` : null,
    text(plan["Join Filter"])
      ? `Join Filter: ${text(plan["Join Filter"])}`
      : null,
    text(plan["Sort Key"]) ? `Sort: ${text(plan["Sort Key"])}` : null,
    text(plan["Group Key"]) ? `Group: ${text(plan["Group Key"])}` : null,
  ].filter((value): value is string => value !== null);
  const childrenRaw = plan["Plans"];
  const children = Array.isArray(childrenRaw)
    ? childrenRaw
        .filter(
          (item): item is Record<string, unknown> =>
            typeof item === "object" && item !== null,
        )
        .map(pgNode)
    : [];
  return {
    label: type,
    subtitle: [
      relation,
      alias && alias !== relation ? `as ${alias}` : null,
      index,
      joinType,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · "),
    cost: total,
    costLabel:
      startup !== undefined || total !== undefined
        ? `${startup?.toFixed(2) ?? "?"}..${total?.toFixed(2) ?? "?"}`
        : undefined,
    rows: estimate,
    actualRows,
    actualMs,
    detail: details.join("\n") || undefined,
    severity: severityFor(estimate, actualRows),
    children,
  };
}

function mysqlTable(table: Record<string, unknown>): PlanNode {
  const costInfo =
    typeof table.cost_info === "object" && table.cost_info !== null
      ? (table.cost_info as Record<string, unknown>)
      : {};
  const readCost = num(costInfo.read_cost);
  const prefixCost = num(costInfo.prefix_cost);
  const queryCost = num(costInfo.query_cost);
  const rows =
    num(table.rows_examined_per_scan) ?? num(table.rows_produced_per_join);
  const condition = text(table.attached_condition);
  const children: PlanNode[] = [];
  const materialized = table.materialized_from_subquery;
  if (typeof materialized === "object" && materialized !== null) {
    children.push(
      ...mysqlWalk(
        materialized as Record<string, unknown>,
        "materialized subquery",
      ),
    );
  }
  return {
    label: t("테이블 {name}", { name: text(table.table_name) ?? "?" }),
    subtitle: [
      text(table.access_type),
      text(table.key) ? `key ${text(table.key)}` : null,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · "),
    cost: queryCost ?? prefixCost ?? readCost,
    costLabel:
      queryCost !== undefined
        ? `query ${queryCost.toFixed(2)}`
        : readCost !== undefined || prefixCost !== undefined
          ? `read ${readCost?.toFixed(2) ?? "?"} · prefix ${prefixCost?.toFixed(2) ?? "?"}`
          : undefined,
    rows,
    detail: condition ? `condition: ${condition}` : undefined,
    children,
  };
}

function groupNode(
  label: string,
  value: Record<string, unknown>,
  sourceKey: string,
): PlanNode {
  const costInfo =
    typeof value.cost_info === "object" && value.cost_info !== null
      ? (value.cost_info as Record<string, unknown>)
      : {};
  const cost =
    num(costInfo.query_cost) ??
    num(costInfo.prefix_cost) ??
    num(costInfo.read_cost);
  return {
    label,
    subtitle: text(value.using_temporary_table) ? "temporary table" : undefined,
    cost,
    costLabel: cost !== undefined ? cost.toFixed(2) : undefined,
    children: mysqlWalk(value, sourceKey),
  };
}

function mysqlWalk(value: Record<string, unknown>, path: string): PlanNode[] {
  const nodes: PlanNode[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (child === null || typeof child !== "object" || Array.isArray(child)) {
      if (Array.isArray(child)) {
        if (key === "nested_loop" || key === "query_specifications") {
          for (const item of child) {
            if (typeof item === "object" && item !== null) {
              nodes.push(...mysqlWalk(item as Record<string, unknown>, key));
            }
          }
        }
      }
      continue;
    }
    const record = child as Record<string, unknown>;
    if (key === "query_block") {
      const selectId = record.select_id;
      nodes.push(
        groupNode(
          selectId !== undefined
            ? t("쿼리 블록 #{id}", { id: String(selectId) })
            : t("쿼리 블록"),
          record,
          path,
        ),
      );
    } else if (key === "table") {
      nodes.push(mysqlTable(record));
    } else if (key === "nested_loop") {
      nodes.push(...mysqlWalk(record, key));
    } else if (
      key === "ordering_operation" ||
      key === "grouping_operation" ||
      key === "duplicates_removal"
    ) {
      nodes.push(groupNode(key.replace(/_/g, " "), record, key));
    } else if (key === "union_result") {
      nodes.push(groupNode("union result", record, key));
    } else if (key === "materialized_from_subquery") {
      nodes.push(...mysqlWalk(record, key));
    }
  }
  return nodes;
}

// EXPLAIN (FORMAT JSON), as PostgreSQL and CockroachDB return it.
export function parsePostgresPlan(rows: unknown[][]): ParsedPlan | null {
  const raw = rows[0]?.[0];
  if (typeof raw !== "string") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const root = Array.isArray(parsed) ? parsed[0] : parsed;
  const plan =
    typeof root === "object" && root !== null
      ? (root as Record<string, unknown>)["Plan"]
      : null;
  if (typeof plan !== "object" || plan === null) {
    return null;
  }
  const node = pgNode(plan as Record<string, unknown>);
  return {
    engine: "postgres",
    nodes: [node],
    costLabel: node.costLabel,
    rowsLabel: node.rows?.toLocaleString(),
    actualLabel:
      node.actualRows !== undefined
        ? `${t("{count}행", { count: node.actualRows.toLocaleString() })}${node.actualMs !== undefined ? ` · ${node.actualMs.toFixed(2)}ms` : ""}`
        : undefined,
    raw,
  };
}

// EXPLAIN FORMAT=JSON, as MySQL returns it.
export function parseMysqlPlan(rows: unknown[][]): ParsedPlan | null {
  const raw = rows[0]?.[0];
  if (typeof raw !== "string") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const nodes = mysqlWalk(parsed as Record<string, unknown>, "root");
  if (nodes.length === 0) {
    return null;
  }
  const flat = flattenNodes(nodes);
  const estimate = flat.find((node) => node.rows !== undefined)?.rows;
  const cost = Math.max(0, ...flat.map((node) => node.cost ?? 0));
  return {
    engine: "mysql",
    nodes,
    costLabel: cost > 0 ? cost.toFixed(2) : undefined,
    rowsLabel: estimate !== undefined ? estimate.toLocaleString() : undefined,
    raw,
  };
}

// EXPLAIN QUERY PLAN's rows, as SQLite returns them.
export function parseSqlitePlan(columns: string[], rows: unknown[][]): ParsedPlan | null {
  const lower = columns.map((column) => column.toLowerCase());
  const idIndex = lower.indexOf("id");
  const parentIndex = lower.indexOf("parent");
  const detailIndex = lower.findIndex((column) => column === "detail");
  if (detailIndex < 0) {
    return null;
  }
  const byId = new Map<string, PlanNode>();
  const parents = new Map<string, string>();
  const nodes: PlanNode[] = [];
  for (const row of rows) {
    const id = idIndex >= 0 ? String(row[idIndex] ?? "") : String(byId.size);
    const parent = parentIndex >= 0 ? String(row[parentIndex] ?? "") : "0";
    const detail = text(row[detailIndex]) ?? t("(상세 없음)");
    const node: PlanNode = { label: detail, children: [] };
    byId.set(id, node);
    parents.set(id, parent);
    nodes.push(node);
  }
  const roots: PlanNode[] = [];
  for (const [id, node] of byId) {
    const parent = parents.get(id) ?? "0";
    const parentNode = parent !== "0" ? byId.get(parent) : undefined;
    if (parentNode) {
      parentNode.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return { engine: "sqlite", nodes: roots };
}

// DBMS_XPLAN's figures: 1000K, 10M, …
function xplanNumber(cell: string | undefined): number | undefined {
  const found = /^(\d+(?:\.\d+)?)([KMGTPE]?)$/.exec((cell ?? "").trim());
  if (found === null) {
    return undefined;
  }
  return Number(found[1]) * 1000 ** " KMGTPE".indexOf(found[2] || " ");
}

// EXPLAIN PLAN as DBMS_XPLAN.DISPLAY prints it (Oracle), a line per row: the
// table "| Id | Operation | Name | Rows | Bytes | Cost (%CPU)| Time |", whose
// Operation is indented by depth and whose ids carry a * when a predicate
// applies, then "Predicate Information" ("   1 - access(…)" and its
// continuation lines).
export function parseOraclePlan(columns: string[], rows: unknown[][]): ParsedPlan | null {
  if (columns.length !== 1) {
    return null;
  }
  const lines = rows.map((row) => (typeof row[0] === "string" ? row[0] : ""));
  const headerAt = lines.findIndex((line) => /^\|\s*Id\s*\|\s*Operation\s*\|/.test(line));
  if (headerAt < 0) {
    return null;
  }
  const header = lines[headerAt].split("|").map((cell) => cell.trim());
  const at = (name: RegExp): number => header.findIndex((cell) => name.test(cell));
  const nameAt = at(/^Name$/);
  const rowsAt = at(/^Rows$/);
  const costAt = at(/^Cost/);

  const predicates = new Map<string, string[]>();
  const predicatesAt = lines.findIndex((line) => line.startsWith("Predicate Information"));
  if (predicatesAt >= 0) {
    let id: string | null = null;
    for (const line of lines.slice(predicatesAt + 1)) {
      const start = /^\s+(\d+)\s+-\s+(.*)$/.exec(line);
      if (start !== null) {
        id = start[1];
        predicates.set(id, [...(predicates.get(id) ?? []), start[2].trim()]);
      } else if (/^\S/.test(line) && !/^-+$/.test(line)) {
        // The next section ("Note", "Column Projection Information", …).
        break;
      } else if (id !== null && line.trim() !== "" && !/^-+$/.test(line)) {
        predicates.get(id)?.push(line.trim());
      }
    }
  }

  const roots: PlanNode[] = [];
  // The open nodes, outermost first, with the indent of their operation.
  const stack: { indent: number; node: PlanNode }[] = [];
  for (const line of lines.slice(headerAt + 1)) {
    const cells = line.split("|");
    const id = /^\*?\s*(\d+)$/.exec((cells[1] ?? "").trim())?.[1];
    if (!line.startsWith("|") || id === undefined) {
      continue;
    }
    const operation = cells[2] ?? "";
    const indent = operation.length - operation.trimStart().length;
    const cost = xplanNumber(/^\s*(\d+)/.exec(cells[costAt] ?? "")?.[1]);
    const node: PlanNode = {
      label: operation.trim(),
      subtitle: nameAt > 0 ? text(cells[nameAt]) : undefined,
      cost,
      costLabel: cost?.toLocaleString(),
      rows: rowsAt > 0 ? xplanNumber(cells[rowsAt]) : undefined,
      detail: predicates.get(id)?.join("\n"),
      children: [],
    };
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    (stack.length > 0 ? stack[stack.length - 1].node.children : roots).push(node);
    stack.push({ indent, node });
  }
  if (roots.length === 0) {
    return null;
  }
  return {
    engine: "oracle",
    nodes: roots,
    costLabel: roots[0].costLabel,
    rowsLabel: roots[0].rows?.toLocaleString(),
    raw: lines.join("\n"),
  };
}

export function parseExplainPlan(
  dialect: SqlDialect | undefined,
  columns: string[],
  rows: unknown[][],
): ParsedPlan | null {
  if (rows.length === 0) {
    return null;
  }
  return dialect?.explain?.parse(columns, rows) ?? null;
}
