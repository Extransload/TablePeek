import { useMemo, useState, type ReactNode } from "react";
import { ChevronIcon, CopyIcon } from "./icons";

interface JsonTreeProps {
  value: unknown;
}

const MAX_EXPAND_PATHS = 800;

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === "object";
}

function childPath(parent: string, key: string, array: boolean): string {
  return array ? `${parent}[${key}]` : `${parent}[${JSON.stringify(key)}]`;
}

function collectPaths(
  value: unknown,
  path: string,
  paths: string[],
  limit: number,
): boolean {
  if (!isContainer(value) || paths.length >= limit) {
    return paths.length >= limit;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return false;
  }
  paths.push(path);
  for (const [key, child] of entries) {
    if (collectPaths(child, childPath(path, key, Array.isArray(value)), paths, limit)) {
      return true;
    }
  }
  return false;
}

export function JsonTree({ value }: JsonTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["$"]));
  const [copied, setCopied] = useState<string | null>(null);
  const [limited, setLimited] = useState(false);
  const rootSummary = useMemo(() => {
    if (!isContainer(value)) {
      return "";
    }
    return Array.isArray(value) ? `[] ${value.length} items` : `{} ${Object.keys(value).length} fields`;
  }, [value]);

  function toggle(path: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  function expandAll(): void {
    const paths: string[] = [];
    const truncated = collectPaths(value, "$", paths, MAX_EXPAND_PATHS);
    setExpanded(new Set(paths));
    setLimited(truncated);
  }

  function collapseAll(): void {
    setExpanded(new Set());
    setLimited(false);
  }

  async function copyPath(path: string): Promise<void> {
    try {
      await navigator.clipboard?.writeText(path);
      setCopied(path);
    } catch {
      setCopied(null);
    }
  }

  function renderNode(node: unknown, path: string, depth: number, label: string | null): ReactNode {
    const container = isContainer(node);
    const array = Array.isArray(node);
    const entries = container ? Object.entries(node) : [];
    const open = container && expanded.has(path);
    const empty = container && entries.length === 0;
    return (
      <div className="json-node" key={path}>
        <div
          className="json-row"
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          title={container ? path : String(node)}
        >
          {container && !empty ? (
            <button
              type="button"
              className={`json-chevron${open ? " open" : ""}`}
              aria-label={open ? "접기" : "펼치기"}
              onClick={() => toggle(path)}
            >
              <ChevronIcon size={9} />
            </button>
          ) : (
            <span className="json-chevron-space" />
          )}
          {label !== null ? (
            <>
              <span className={`json-key${array ? " index" : ""}`}>{label}</span>
              <span className="json-colon">:</span>
            </>
          ) : null}
          {container ? (
            <span className="json-summary">
              {empty
                ? array
                  ? "[]"
                  : "{}"
                : array
                  ? `[ ${entries.length} ]`
                  : `{ ${entries.length} }`}
            </span>
          ) : node === null ? (
            <span className="json-value null">null</span>
          ) : (
            <span className={`json-value ${typeof node}`}>
              {typeof node === "string" ? JSON.stringify(node) : String(node)}
            </span>
          )}
          <button
            type="button"
            className="json-copy"
            title="JSON 경로 복사"
            onClick={() => void copyPath(path)}
          >
            {copied === path ? <span className="json-copied">복사됨</span> : <CopyIcon size={10} />}
          </button>
        </div>
        {open
          ? entries.map(([key, child]) =>
              renderNode(child, childPath(path, key, array), depth + 1, key),
            )
          : null}
      </div>
    );
  }

  return (
    <div className="json-tree">
      <div className="json-tree-head">
        <span className="json-tree-summary">
          {isContainer(value) ? `root ${rootSummary}` : typeof value}
        </span>
        <span className="spacer" />
        <button type="button" className="quicklook-text-button" onClick={expandAll}>
          모두 펼치기
        </button>
        <button type="button" className="quicklook-text-button" onClick={collapseAll}>
          모두 접기
        </button>
      </div>
      {limited ? (
        <div className="json-tree-note">
          큰 문서라 앞쪽 {MAX_EXPAND_PATHS.toLocaleString()}개 컨테이너만 펼쳤습니다
        </div>
      ) : null}
      <div className="json-tree-scroll">
        {renderNode(value, "$", 0, null)}
      </div>
    </div>
  );
}
