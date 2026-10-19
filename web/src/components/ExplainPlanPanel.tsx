import { useEffect, useMemo, useState } from "react";
import { parseExplainPlan, type PlanNode } from "../explainPlan";
import type { GridResult } from "../store";

interface ExplainPlanPanelProps {
  result: GridResult;
  kind: string;
}

function flatten(nodes: PlanNode[]): PlanNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function PlanNodeView({
  node,
  maxCost,
  depth,
}: {
  node: PlanNode;
  maxCost: number;
  depth: number;
}) {
  const pct =
    node.cost !== undefined && maxCost > 0
      ? Math.max(2, Math.min(100, (node.cost / maxCost) * 100))
      : 0;
  return (
    <div className="plan-node">
      <div
        className={`plan-card${node.severity && node.severity !== "ok" ? ` ${node.severity}` : ""}`}
      >
        <div className="plan-card-head">
          <span className="plan-card-label">{node.label}</span>
          {node.subtitle ? (
            <span className="plan-card-sub">{node.subtitle}</span>
          ) : null}
        </div>
        <div className="plan-metrics">
          {node.costLabel ? (
            <span className="plan-metric">cost {node.costLabel}</span>
          ) : null}
          {node.rows !== undefined ? (
            <span className="plan-metric">
              예상 {node.rows.toLocaleString()}행
            </span>
          ) : null}
          {node.actualRows !== undefined ? (
            <span className="plan-metric actual">
              실제 {node.actualRows.toLocaleString()}행
              {node.actualMs !== undefined
                ? ` · ${node.actualMs.toFixed(2)}ms`
                : ""}
            </span>
          ) : null}
        </div>
        {pct > 0 ? (
          <div className="plan-bar" title={`상대 비용 ${pct.toFixed(0)}%`}>
            <span style={{ width: `${pct}%` }} />
          </div>
        ) : null}
        {node.detail ? <pre className="plan-detail">{node.detail}</pre> : null}
      </div>
      {node.children.length > 0 ? (
        <div className="plan-children">
          {node.children.map((child, index) => (
            <PlanNodeView
              key={`${depth}-${index}-${child.label}`}
              node={child}
              maxCost={maxCost}
              depth={depth + 1}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ExplainPlanPanel({ result, kind }: ExplainPlanPanelProps) {
  const [rows, setRows] = useState<unknown[][] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rawOpen, setRawOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    setRows(null);
    setError(null);
    setRawOpen(false);
    void (async () => {
      try {
        const count = Math.min(result.source.rowCount, 500);
        const loaded: unknown[][] = [];
        for (let row = 0; row < count; row += 1) {
          await result.source.ensureRow(row);
          loaded.push(
            result.source.columns.map((_, col) => result.source.cell(row, col)),
          );
        }
        if (alive) {
          setRows(loaded);
        }
      } catch (err) {
        if (alive) {
          setError(
            err instanceof Error ? err.message : "실행 계획을 읽지 못했습니다",
          );
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [result]);

  const plan = useMemo(
    () =>
      rows === null
        ? null
        : parseExplainPlan(kind, result.source.columns, rows),
    [kind, result.source.columns, rows],
  );
  const maxCost = useMemo(
    () =>
      Math.max(0, ...flatten(plan?.nodes ?? []).map((node) => node.cost ?? 0)),
    [plan],
  );

  if (error) {
    return <div className="plan-empty">{error}</div>;
  }
  if (rows === null) {
    return <div className="plan-empty">실행 계획을 분석하는 중…</div>;
  }
  if (plan === null) {
    return (
      <div className="plan-empty">
        이 실행 계획 형식은 시각화할 수 없습니다. 그리드에서 원본을 확인하세요.
      </div>
    );
  }

  return (
    <div className="plan-panel">
      <div className="plan-head">
        <div>
          <div className="plan-title">실행 계획</div>
          <div className="plan-engine">{plan.engine}</div>
        </div>
        <div className="plan-summary">
          {plan.costLabel ? <span>총 비용 {plan.costLabel}</span> : null}
          {plan.rowsLabel ? <span>예상 {plan.rowsLabel}행</span> : null}
          {plan.actualLabel ? <span>실제 {plan.actualLabel}</span> : null}
        </div>
        <span className="spacer" />
        {plan.raw ? (
          <button
            type="button"
            className="icon-text-button"
            onClick={() => setRawOpen((v) => !v)}
          >
            {rawOpen ? "원본 숨기기" : "원본 JSON"}
          </button>
        ) : null}
      </div>
      <div className="plan-scroll">
        {plan.nodes.map((node, index) => (
          <PlanNodeView
            key={`${index}-${node.label}`}
            node={node}
            maxCost={maxCost}
            depth={0}
          />
        ))}
        {rawOpen && plan.raw ? (
          <pre className="plan-raw">{plan.raw}</pre>
        ) : null}
      </div>
    </div>
  );
}
