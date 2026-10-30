import type { ParsedPlan, PlanNode } from "../../explainPlan";
import { t } from "../../i18n";

// The plan view's EXPLAIN: the query plan as JSON, with each step's actions
// and the indexes a table read uses.
export const EXPLAIN_PREFIX = "EXPLAIN json = 1, actions = 1, indexes = 1 ";

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// What a table read's index did: "PrimaryKey (id): parts 3/12, granules 5/100".
function indexLine(index: Record<string, unknown>): string {
  const keys = Array.isArray(index["Keys"]) ? (index["Keys"] as unknown[]).join(", ") : "";
  const name = typeof index["Name"] === "string" ? ` ${index["Name"]}` : "";
  const parts = [`${String(index["Type"] ?? "Index")}${name}${keys ? ` (${keys})` : ""}`];
  const selected = (what: string, label: string): void => {
    const initial = num(index[`Initial ${what}`]);
    const chosen = num(index[`Selected ${what}`]);
    if (initial !== undefined && chosen !== undefined) {
      parts.push(`${t(label)} ${chosen.toLocaleString()}/${initial.toLocaleString()}`);
    }
  };
  selected("Parts", "파트");
  selected("Granules", "그래뉼");
  const condition = typeof index["Condition"] === "string" ? `\n  ${index["Condition"]}` : "";
  return `${parts.join(" · ")}${condition}`;
}

function planNode(plan: Record<string, unknown>): PlanNode {
  const children = (Array.isArray(plan["Plans"]) ? (plan["Plans"] as unknown[]) : [])
    .map(record)
    .filter((child): child is Record<string, unknown> => child !== null)
    .map(planNode);
  const details: string[] = [];
  const indexes = Array.isArray(plan["Indexes"]) ? (plan["Indexes"] as unknown[]) : [];
  for (const index of indexes) {
    const found = record(index);
    if (found !== null) {
      details.push(indexLine(found));
    }
  }
  const expression = record(plan["Expression"]);
  const actions = expression !== null && Array.isArray(expression["Actions"]) ? (expression["Actions"] as unknown[]) : [];
  const shown = actions
    .map(record)
    .filter((action): action is Record<string, unknown> => action !== null && action["Node Type"] === "FUNCTION")
    .map((action) => String(action["Result Name"] ?? ""))
    .filter((name) => name !== "");
  if (shown.length > 0) {
    details.push(shown.join("\n"));
  }
  // A table read: its granules after the indexes are the rows it may read.
  const granules = indexes
    .map(record)
    .map((index) => num(index?.["Selected Granules"]))
    .filter((value): value is number => value !== undefined);
  const lastIndex = granules.length > 0 ? granules[granules.length - 1] : undefined;
  const worst = indexes
    .map(record)
    .some((index) => {
      const initial = num(index?.["Initial Granules"]);
      const chosen = num(index?.["Selected Granules"]);
      return initial !== undefined && chosen !== undefined && initial > 0 && chosen === initial && initial > 8;
    });
  return {
    label: String(plan["Node Type"] ?? "?"),
    subtitle: typeof plan["Description"] === "string" ? plan["Description"] : undefined,
    detail: details.length > 0 ? details.join("\n") : undefined,
    // An index that skipped nothing: the read goes through the whole table.
    severity: worst ? "warn" : undefined,
    costLabel: lastIndex !== undefined ? `${lastIndex.toLocaleString()} ${t("그래뉼")}` : undefined,
    children,
  };
}

// Lines indented two spaces per level (EXPLAIN PLAN or PIPELINE as text):
// a tree by indentation.
function indentedTree(lines: string[]): PlanNode[] {
  const roots: PlanNode[] = [];
  const stack: { depth: number; node: PlanNode }[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      continue;
    }
    const depth = line.length - line.trimStart().length;
    const text = line.trim();
    const open = text.indexOf(" (");
    const node: PlanNode =
      open > 0 && text.endsWith(")")
        ? { label: text.slice(0, open), subtitle: text.slice(open + 2, -1), children: [] }
        : { label: text, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      roots.push(node);
    } else {
      parent.node.children.push(node);
    }
    stack.push({ depth, node });
  }
  return roots;
}

// EXPLAIN's result as ClickHouse gives it: the JSON plan split over rows, a
// text plan or pipeline one line per row, or ESTIMATE's table of reads.
export function parseClickHousePlan(columns: string[], rows: unknown[][]): ParsedPlan | null {
  const lower = columns.map((column) => column.toLowerCase());
  if (lower.includes("marks") && lower.includes("rows") && lower.includes("table")) {
    const at = (name: string): number => lower.indexOf(name);
    const nodes: PlanNode[] = rows.map((row) => ({
      label: `${String(row[at("database")] ?? "")}.${String(row[at("table")] ?? "")}`,
      rows: num(row[at("rows")]),
      detail: `${t("파트")} ${String(row[at("parts")] ?? "?")} · marks ${String(row[at("marks")] ?? "?")}`,
      children: [],
    }));
    const total = nodes.reduce((sum, node) => sum + (node.rows ?? 0), 0);
    return { engine: "ClickHouse ESTIMATE", nodes, rowsLabel: total.toLocaleString() };
  }
  if (lower[0] !== "explain") {
    return null;
  }
  const lines = rows.map((row) => (row[0] === null || row[0] === undefined ? "" : String(row[0])));
  const raw = lines.join("\n");
  if (raw.trimStart().startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const plans = (Array.isArray(parsed) ? parsed : [parsed])
      .map(record)
      .map((entry) => record(entry?.["Plan"]))
      .filter((plan): plan is Record<string, unknown> => plan !== null);
    if (plans.length === 0) {
      return null;
    }
    return { engine: "ClickHouse", nodes: plans.map(planNode), raw };
  }
  const nodes = indentedTree(lines);
  return nodes.length === 0 ? null : { engine: "ClickHouse", nodes, raw };
}
