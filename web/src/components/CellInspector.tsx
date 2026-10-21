import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { t } from "../i18n";
import type { GridResult } from "../store";
import { FieldBox } from "./FieldBox";
import { ChevronIcon } from "./icons";
import { Spinner } from "./Spinner";

/** A cell's box in client coordinates. */
export interface CellAnchor {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface CellInspectorProps {
  result: GridResult;
  row: number;
  col: number;
  table: string | null;
  // Where the cell sits on screen; null (scrolled out of view) centers the popover.
  anchor: CellAnchor | null;
  onClose(): void;
}

type Kind = "object" | "array" | "string" | "number" | "boolean" | "null";

interface TreeRow {
  path: string;
  key: string;
  value: unknown;
  kind: Kind;
  depth: number;
  parent: string | null;
}

interface MoreRow {
  more: number;
  parent: string;
  depth: number;
}

const ROOT = "$";
// Children listed per container before a "show more" row.
const CHILD_PAGE = 500;
// Fields shown on the right for one picked container.
const FIELD_LIMIT = 300;
const ARROW = 8;
const MARGIN = 12;

const KIND_ICON: Record<Kind, string> = {
  object: "{}",
  array: "[]",
  string: "Aa",
  number: "#",
  boolean: "✓",
  null: "∅",
};

function kindOf(value: unknown): Kind {
  if (value === null || value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  switch (typeof value) {
    case "object":
      return "object";
    case "number":
    case "bigint":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "string";
  }
}

function rawText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// The JSON object or array a cell holds, whether stored as text or already parsed.
function documentOf(value: unknown): Record<string, unknown> | unknown[] | null {
  if (value !== null && typeof value === "object") {
    return value as Record<string, unknown> | unknown[];
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown> | unknown[]) : null;
  } catch {
    return null;
  }
}

function childPath(parent: string, key: string, array: boolean): string {
  return array ? `${parent}[${key}]` : `${parent}[${JSON.stringify(key)}]`;
}

function childrenOf(value: unknown): [string, unknown][] {
  if (Array.isArray(value)) {
    return value.map((child, index) => [String(index), child]);
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>);
  }
  return [];
}

// The rows the tree shows: every node whose ancestors are all expanded.
function visibleRows(
  doc: unknown,
  expanded: Set<string>,
  limits: Record<string, number>,
): (TreeRow | MoreRow)[] {
  const rows: (TreeRow | MoreRow)[] = [];
  const walk = (value: unknown, path: string, key: string, depth: number, parent: string | null): void => {
    const kind = kindOf(value);
    rows.push({ path, key, value, kind, depth, parent });
    if ((kind !== "object" && kind !== "array") || !expanded.has(path)) {
      return;
    }
    const children = childrenOf(value);
    const limit = limits[path] ?? CHILD_PAGE;
    for (const [childKey, child] of children.slice(0, limit)) {
      walk(child, childPath(path, childKey, kind === "array"), childKey, depth + 1, path);
    }
    if (children.length > limit) {
      rows.push({ more: children.length - limit, parent: path, depth: depth + 1 });
    }
  };
  walk(doc, ROOT, "ROOT", 0, null);
  return rows;
}

function detailText(row: TreeRow): string {
  if (row.kind === "object" || row.kind === "array") {
    return JSON.stringify(row.value, null, 2);
  }
  return row.kind === "null" ? "null" : String(row.value);
}

function inlineValue(row: TreeRow): string {
  if (row.kind === "string") {
    const text = String(row.value);
    return `"${text.length > 300 ? `${text.slice(0, 300)}…` : text}"`;
  }
  return row.kind === "null" ? "null" : String(row.value);
}

// TablePlus-style popover beside a cell: a JSON tree on the left, the picked
// node's value on the right, and Raw for the cell text as stored.
export function CellInspector({ result, row, col, table, anchor, onClose }: CellInspectorProps) {
  const [, setNonce] = useState(0);
  const [raw, setRaw] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([ROOT]));
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState(ROOT);
  const [copied, setCopied] = useState(false);
  const treeRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const value = result.source.cell(row, col);
  const loading = value === undefined;
  const column = result.meta.columns[col] ?? `#${col + 1}`;
  const text = rawText(value);
  const doc = useMemo(() => documentOf(value), [value]);
  const rows = useMemo(
    () => (doc === null ? [] : visibleRows(doc, expanded, limits)),
    [doc, expanded, limits],
  );
  const nodes = rows.filter((entry): entry is TreeRow => "path" in entry);
  const current = nodes.find((node) => node.path === selected) ?? nodes[0] ?? null;
  const showTree = doc !== null && !raw;
  // Serializing a large document is not free; do it once per picked node.
  const detail = useMemo(() => (current !== null ? detailText(current) : ""), [current]);
  // The right side lists a picked object's or array's members as fields, or
  // the picked value alone.
  const fields = useMemo(() => {
    if (current === null) {
      return [];
    }
    if (current.kind === "object" || current.kind === "array") {
      return childrenOf(current.value).map(([key, value]) => ({ key, kind: kindOf(value), value }));
    }
    return [{ key: current.key, kind: current.kind, value: current.value }];
  }, [current]);

  useEffect(() => {
    setExpanded(new Set([ROOT]));
    setLimits({});
    setSelected(ROOT);
    setRaw(false);
  }, [result, row, col]);

  // Cells still loading arrive through the source's update stream.
  useEffect(() => result.source.onUpdate?.(() => setNonce((n) => n + 1)), [result]);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Keys belong to the popover, never to the grid underneath: the tree takes
  // focus, or the popover itself while the cell is still loading.
  useEffect(() => {
    if (showTree) {
      treeRef.current?.focus({ preventScroll: true });
    } else if (loading) {
      popRef.current?.focus({ preventScroll: true });
    }
  }, [showTree, loading]);

  useEffect(() => {
    treeRef.current?.querySelector(".cell-pop-row.selected")?.scrollIntoView({ block: "nearest" });
  }, [selected, rows]);

  function toggle(path: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  async function copy(): Promise<void> {
    try {
      // The whole document goes out as stored: re-serializing it would round
      // integers past 2^53 and lose the original formatting.
      await navigator.clipboard.writeText(
        showTree && current !== null && current.path !== ROOT ? detail : text,
      );
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {}
  }

  function onTreeKey(event: KeyboardEvent<HTMLDivElement>): void {
    if (current === null) {
      return;
    }
    const index = nodes.indexOf(current);
    const container = current.kind === "object" || current.kind === "array";
    const open = expanded.has(current.path);
    let handled = true;
    if (event.key === "ArrowDown") {
      setSelected(nodes[Math.min(nodes.length - 1, index + 1)].path);
    } else if (event.key === "ArrowUp") {
      setSelected(nodes[Math.max(0, index - 1)].path);
    } else if (event.key === "ArrowRight") {
      if (container && !open) {
        toggle(current.path);
      } else if (container && nodes[index + 1]?.parent === current.path) {
        setSelected(nodes[index + 1].path);
      }
    } else if (event.key === "ArrowLeft") {
      if (container && open) {
        toggle(current.path);
      } else if (current.parent !== null) {
        setSelected(current.parent);
      }
    } else if ((event.key === "Enter" || event.key === " ") && container) {
      toggle(current.path);
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
      void copy();
    } else {
      handled = false;
    }
    if (handled) {
      event.preventDefault();
    }
  }

  // Beside the cell, pointing at it: to the right when that leaves a usable
  // width (narrowing to fit), else to the left, else centered over the grid.
  const preferred = doc !== null ? 880 : 560;
  const minWidth = doc !== null ? 520 : 360;
  const height = Math.min(doc !== null ? 560 : 320, window.innerHeight - MARGIN * 2);
  let width = Math.min(preferred, window.innerWidth - MARGIN * 2);
  let left = (window.innerWidth - width) / 2;
  let top = (window.innerHeight - height) / 2;
  let side: "left" | "right" | null = null;
  let arrowTop = 0;
  if (anchor !== null) {
    const pointX = Math.min(anchor.right, anchor.left + 160);
    const pointY = (anchor.top + anchor.bottom) / 2;
    const roomRight = window.innerWidth - pointX - ARROW - MARGIN;
    const roomLeft = anchor.left - ARROW - MARGIN;
    if (roomRight >= minWidth) {
      side = "right";
      width = Math.min(preferred, roomRight);
      left = pointX + ARROW;
    } else if (roomLeft >= minWidth) {
      side = "left";
      width = Math.min(preferred, roomLeft);
      left = anchor.left - ARROW - width;
    }
    if (side !== null) {
      top = Math.min(Math.max(pointY - height / 2, MARGIN), window.innerHeight - height - MARGIN);
      arrowTop = Math.min(Math.max(pointY - top, 18), height - 18);
    }
  }
  const style: CSSProperties = { left, top, width, height };

  return (
    <div
      className="cell-pop-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div
        className="cell-pop"
        ref={popRef}
        style={style}
        role="dialog"
        aria-modal="true"
        aria-label={t("{column} 값", { column })}
        tabIndex={-1}
        onContextMenu={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          // Tab cycles inside the popover instead of reaching the editor behind it.
          if (event.key !== "Tab") {
            return;
          }
          const focusables = [
            ...(popRef.current?.querySelectorAll<HTMLElement>(
              '[tabindex="0"], textarea, button:not([disabled])',
            ) ?? []),
          ];
          if (focusables.length === 0) {
            event.preventDefault();
            return;
          }
          const index = focusables.indexOf(document.activeElement as HTMLElement);
          const next = event.shiftKey
            ? index <= 0
              ? focusables.length - 1
              : index - 1
            : index === -1 || index === focusables.length - 1
              ? 0
              : index + 1;
          event.preventDefault();
          focusables[next].focus();
        }}
      >
        {side !== null ? (
          <span className={`cell-pop-arrow ${side}`} style={{ top: arrowTop }} aria-hidden="true" />
        ) : null}
        <div className="cell-pop-main">
          {loading ? (
            <div className="cell-pop-loading">
              <Spinner size={16} label={t("셀 불러오는 중")} />
            </div>
          ) : showTree ? (
            <>
              <div
                className="cell-pop-tree"
                ref={treeRef}
                role="tree"
                tabIndex={0}
                onKeyDown={onTreeKey}
              >
                {rows.map((entry) =>
                  "more" in entry ? (
                    <button
                      type="button"
                      key={`${entry.parent}:more`}
                      className="cell-pop-more"
                      style={{ paddingLeft: 10 + entry.depth * 18 + 18 }}
                      onClick={() =>
                        setLimits((prev) => ({
                          ...prev,
                          [entry.parent]: (prev[entry.parent] ?? CHILD_PAGE) + CHILD_PAGE,
                        }))
                      }
                    >
                      {t("{count}개 더 보기", { count: entry.more.toLocaleString() })}
                    </button>
                  ) : (
                    <div
                      key={entry.path}
                      role="treeitem"
                      aria-selected={entry.path === current?.path}
                      aria-expanded={
                        entry.kind === "object" || entry.kind === "array" ? expanded.has(entry.path) : undefined
                      }
                      className={`cell-pop-row${entry.path === current?.path ? " selected" : ""}`}
                      style={{ paddingLeft: 10 + entry.depth * 18 }}
                      onMouseDown={() => setSelected(entry.path)}
                      onDoubleClick={() => {
                        if (entry.kind === "object" || entry.kind === "array") {
                          toggle(entry.path);
                        }
                      }}
                    >
                      {entry.kind === "object" || entry.kind === "array" ? (
                        <span
                          className={`cell-pop-chevron${expanded.has(entry.path) ? " open" : ""}`}
                          onMouseDown={(event) => {
                            event.stopPropagation();
                            setSelected(entry.path);
                            toggle(entry.path);
                          }}
                        >
                          <ChevronIcon size={10} />
                        </span>
                      ) : (
                        <span className="cell-pop-chevron-space" />
                      )}
                      <span className={`cell-pop-kind ${entry.kind}`}>{KIND_ICON[entry.kind]}</span>
                      <span className="cell-pop-key">{entry.key}</span>
                      {entry.kind === "object" || entry.kind === "array" ? null : (
                        <>
                          <span className="cell-pop-colon">:</span>
                          <span className={`cell-pop-value ${entry.kind}`}>{inlineValue(entry)}</span>
                        </>
                      )}
                    </div>
                  ),
                )}
              </div>
              <div className="cell-pop-detail">
                <div className="field-list">
                  {fields.slice(0, FIELD_LIMIT).map((field) => (
                    <FieldBox key={field.key} name={field.key} type={field.kind} value={field.value} />
                  ))}
                  {fields.length > FIELD_LIMIT ? (
                    <div className="cell-pop-fields-more">
                      {t("나머지 {count}개는 왼쪽 트리에서 고르세요", {
                        count: (fields.length - FIELD_LIMIT).toLocaleString(),
                      })}
                    </div>
                  ) : null}
                  {fields.length === 0 ? (
                    <div className="panel-empty">{current?.kind === "array" ? "[]" : "{}"}</div>
                  ) : null}
                </div>
              </div>
            </>
          ) : (
            <div className="cell-pop-detail full">
              <div className="cell-pop-detail-head">
                <span className="cell-pop-detail-key">{column}</span>
                <span className="cell-pop-detail-kind">
                  {value === null ? "NULL" : doc !== null ? "json" : kindOf(value)}
                </span>
              </div>
              <textarea
                className="cell-pop-text"
                readOnly
                autoFocus
                spellCheck={false}
                value={text}
                placeholder={value === null ? "NULL" : ""}
              />
            </div>
          )}
        </div>
        <div className="cell-pop-foot">
          <span className="cell-pop-where">
            {table !== null ? `${table}.` : ""}
            <strong>{column}</strong>
            {` · ${t("{count}번째 행", { count: (row + 1).toLocaleString() })}`}
          </span>
          <span className="spacer" />
          {doc !== null ? (
            <button
              type="button"
              className={raw ? "active" : ""}
              aria-pressed={raw}
              onClick={() => setRaw((value) => !value)}
            >
              Raw
            </button>
          ) : null}
          <button type="button" disabled={loading} onClick={() => void copy()}>
            {copied ? t("복사했습니다") : t("복사")}
          </button>
        </div>
      </div>
    </div>
  );
}
