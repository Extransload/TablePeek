import { useEffect, useRef, useState, type ReactElement } from "react";
import { t } from "../i18n";
import { formatBinding, withHint } from "../shortcuts";
import type { WorkbenchTab } from "../tabs";
import {
  CloseIcon,
  CodeIcon,
  DiagramIcon,
  EyeIcon,
  FileIcon,
  FolderIcon,
  GaugeIcon,
  ListIcon,
  ServerIcon,
  StructureIcon,
  TableIcon,
} from "./icons";
import { Spinner } from "./Spinner";
import { tableColorValue } from "../tableColors";

function tabIcon(tab: WorkbenchTab): ReactElement {
  const props = { size: 10, className: "tab-kind" };
  switch (tab.kind) {
    case "query":
      return <CodeIcon {...props} />;
    case "data":
      return <TableIcon {...props} />;
    case "structure":
      return <StructureIcon {...props} />;
    case "definition":
      return <FileIcon {...props} />;
    case "server":
      return <ServerIcon {...props} />;
    case "overview":
      return <ListIcon {...props} />;
    case "diagram":
      return <DiagramIcon {...props} />;
    case "collection":
      return <TableIcon {...props} />;
    case "mongosh":
      return <CodeIcon {...props} />;
    case "perf":
      return <GaugeIcon {...props} />;
    case "watch":
      return <EyeIcon {...props} />;
    case "gridfs":
      return <FolderIcon {...props} />;
  }
}

function tabKindLabel(tab: WorkbenchTab): string {
  switch (tab.kind) {
    case "query":
      return t("쿼리");
    case "data":
      return t("데이터");
    case "structure":
      return t("구조");
    case "definition":
      return t("정의");
    case "server":
      return t("서버");
    case "overview":
      return t("개요");
    case "diagram":
      return t("다이어그램");
    case "collection":
      return t("컬렉션");
    case "mongosh":
      return "mongosh";
    case "perf":
      return t("성능");
    case "watch":
      return t("변경 보기");
    case "gridfs":
      return "GridFS";
  }
}

interface TabStripProps {
  tabs: WorkbenchTab[];
  activeId: string;
  runningTabId: string | null;
  onActivate(id: string): void;
  onClose(id: string): void;
  onRename(id: string, title: string): void;
  // A double-click on a temporary tab keeps it instead of renaming it.
  onPin(id: string): void;
  // Font colours picked for tables in the sidebar (table → colour id).
  tableColors?: Record<string, string>;
  // The close shortcut as the keymap has it, for the × button's tooltip.
  closeHint?: string;
}

// The ⌥ digit that brings a tab forward: 1–8 by place, 9 for the last.
function digitOf(index: number, count: number): number | null {
  return index < 8 ? index + 1 : index === count - 1 ? 9 : null;
}

// Tabs keep the default name they were made with ("쿼리 3", "서버 정보",
// "Plan — Query 2"); show those defaults in the current language. Names the
// user typed come through as written.
function defaultTitle(title: string): string {
  const query = /^(?:쿼리|Query) (\d+)$/.exec(title);
  if (query) {
    return t("쿼리 {count}", { count: query[1] });
  }
  if (title === "테이블 개요" || title === "Table overview") {
    return t("테이블 개요");
  }
  if (title === "ER 다이어그램" || title === "ER diagram") {
    return t("ER 다이어그램");
  }
  if (title === "서버 정보" || title === "Server info") {
    return t("서버 정보");
  }
  const structure = /^(?:구조|Structure): (.+)$/.exec(title);
  if (structure) {
    return `${t("구조")}: ${structure[1]}`;
  }
  const plan = /^(?:실행 계획|Plan) — (.+)$/.exec(title);
  if (plan) {
    return t("실행 계획 — {title}", { title: defaultTitle(plan[1]) });
  }
  return title;
}

function titleOf(tab: WorkbenchTab): string {
  return defaultTitle(tab.title);
}

export function TabStrip({
  tabs,
  activeId,
  runningTabId,
  onActivate,
  onClose,
  onRename,
  onPin,
  tableColors,
  closeHint,
}: TabStripProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const stripRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (renamingId !== null) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [renamingId]);

  useEffect(() => {
    if (renamingId !== null && !tabs.some((tab) => tab.id === renamingId)) {
      setRenamingId(null);
    }
  }, [tabs, renamingId]);

  useEffect(() => {
    const strip = stripRef.current;
    const active = strip?.querySelector<HTMLElement>(".tab.active");
    if (!strip || !active) {
      return;
    }
    const stripRect = strip.getBoundingClientRect();
    const tabRect = active.getBoundingClientRect();
    if (tabRect.left < stripRect.left) {
      strip.scrollLeft -= stripRect.left - tabRect.left + 8;
    } else if (tabRect.right > stripRect.right) {
      strip.scrollLeft += tabRect.right - stripRect.right + 8;
    }
  }, [activeId, tabs.length]);

  function startRename(tab: WorkbenchTab): void {
    cancelledRef.current = false;
    setRenamingId(tab.id);
    setDraft(titleOf(tab));
  }

  function commitRename(): void {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      setRenamingId(null);
      return;
    }
    if (renamingId !== null) {
      onRename(renamingId, draft);
    }
    setRenamingId(null);
  }

  return (
    <div
      ref={stripRef}
      className="tab-strip"
      role="tablist"
      onWheel={(event) => {
        if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
          return;
        }
        event.currentTarget.scrollLeft += event.deltaY;
      }}
    >
      {tabs.map((tab, index) => {
        const active = tab.id === activeId;
        const renaming = tab.id === renamingId;
        return (
          <div
            // The temporary tab keeps its element when it shows another
            // table, so it doesn't replay the opening animation.
            key={tab.kind === "data" && tab.slot !== undefined ? tab.slot : tab.id}
            role="tab"
            aria-selected={active}
            className={`tab tab-${tab.kind}${active ? " active" : ""}${(tab.kind === "query" || tab.kind === "data") && tab.error ? " has-error" : ""}${tab.kind === "data" && tab.preview ? " preview" : ""}`}
            data-kind={tab.kind}
            title={(() => {
              const digit = digitOf(index, tabs.length);
              const label = `${tabKindLabel(tab)} · ${titleOf(tab)}`;
              return digit === null ? label : `${label} (${formatBinding(`Alt+${digit}`)})`;
            })()}
            onClick={() => onActivate(tab.id)}
            onDoubleClick={() => (tab.kind === "data" && tab.preview ? onPin(tab.id) : startRename(tab))}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                onClose(tab.id);
              }
            }}
          >
            <span className="tab-icon">
              {tabIcon(tab)}
              {tab.id === runningTabId ? <Spinner size={10} className="tab-running" label={t("실행 중…")} /> : null}
            </span>
            {renaming ? (
              <input
                ref={inputRef}
                className="tab-rename"
                value={draft}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitRename();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    cancelledRef.current = true;
                    setRenamingId(null);
                  }
                }}
              />
            ) : (
              <span
                className="tab-label"
                style={{ color: tab.kind === "data" ? tableColorValue(tableColors?.[tab.table]) : undefined }}
              >
                {titleOf(tab)}
              </span>
            )}
            <button
              type="button"
              className="tab-close"
              title={withHint(t("탭 닫기"), closeHint)}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.id);
              }}
            >
              <CloseIcon size={10} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
