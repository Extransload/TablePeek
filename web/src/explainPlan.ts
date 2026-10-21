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

function parsePostgres(rows: unknown[][]): ParsedPlan | null {
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

function parseMysql(rows: unknown[][]): ParsedPlan | null {
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

function parseSqlite(columns: string[], rows: unknown[][]): ParsedPlan | null {
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

export function parseExplainPlan(
  kind: string,
  columns: string[],
  rows: unknown[][],
): ParsedPlan | null {
  if (rows.length === 0) {
    return null;
  }
  const normalized = kind.toLowerCase();
  if (normalized === "sqlite") {
    return parseSqlite(columns, rows);
  }
  if (normalized === "mysql") {
    return parseMysql(rows);
  }
  if (
    normalized === "postgres" ||
    normalized === "postgresql" ||
    normalized === "cockroach" ||
    normalized === "cockroachdb"
  ) {
    return parsePostgres(rows);
  }
  return null;
}
