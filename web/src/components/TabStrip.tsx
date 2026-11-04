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
  ShieldIcon,
  StructureIcon,
  TableIcon,
} from "./icons";
import { Gauge, useTabWorkOf, type GaugeOutcome } from "./Gauge";
import { useTabMotion } from "./tabMotion";
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
    case "searchIndex":
      return <TableIcon {...props} />;
    case "searchConsole":
      return <CodeIcon {...props} />;
    case "searchCluster":
      return <GaugeIcon {...props} />;
    case "searchSecurity":
      return <ShieldIcon {...props} />;
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
    case "searchIndex":
      return tab.target === "alias" ? t("별칭") : tab.target === "data_stream" ? t("데이터 스트림") : t("인덱스");
    case "searchConsole":
      return t("콘솔");
    case "searchCluster":
      return t("클러스터");
    case "searchSecurity":
      return t("보안");
  }
}

// A walk in steps (a far page, a count) running for one tab: how far it has
// got when it knows, and the step it is on.
export interface TabProgress {
  tabId: string;
  value: number | null;
  step: string;
}

interface TabStripProps {
  tabs: WorkbenchTab[];
  activeId: string;
  // The connection the tabs belong to, whose views report their work by
  // `${connId}:${tab id}` (useTabWork).
  connId: string;
  // The tab whose query or rows are on their way; it fills as a gauge.
  runningTabId: string | null;
  progress: TabProgress | null;
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

// How a tab's run ended, as its outcome left it (tabs.patchFromOutcome): an
// error, the cancel notice, or rows.
function runOutcome(tab: WorkbenchTab): GaugeOutcome {
  if (tab.kind !== "query" && tab.kind !== "data") {
    return "ok";
  }
  return tab.error !== undefined ? "error" : tab.info !== undefined ? "cancel" : "ok";
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
  const searchConsole = /^(?:콘솔|Console) (\d+)$/.exec(title);
  if (searchConsole) {
    return t("콘솔 {n}", { n: searchConsole[1] });
  }
  if (title === "클러스터" || title === "Cluster") {
    return t("클러스터");
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

// The temporary tab keeps its element when it shows another table, so it
// doesn't replay the opening animation (or pour the highlight onto itself).
function elementKey(tab: WorkbenchTab): string {
  return tab.kind === "data" && tab.slot !== undefined ? tab.slot : tab.id;
}

export function TabStrip({
  tabs,
  activeId,
  connId,
  runningTabId,
  progress,
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
  const indicatorRef = useRef<HTMLSpanElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cancelledRef = useRef(false);
  const activeTab = tabs.find((tab) => tab.id === activeId);
  const workOf = useTabWorkOf();

  useTabMotion(stripRef, indicatorRef, tabs.map(elementKey), activeTab === undefined ? null : elementKey(activeTab));

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
    // Not a closed tab's stand-in, still melting away where it was.
    const active = strip?.querySelector<HTMLElement>(".tab.active:not(.motion-ghost)");
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

  const activeBusy =
    activeTab !== undefined &&
    (activeTab.id === runningTabId ||
      (progress !== null && progress.tabId === activeTab.id) ||
      workOf(`${connId}:${activeTab.id}`)?.busy === true);

  return (
    <div
      ref={stripRef}
      // While the active tab works, the highlight under it empties and the
      // tab's gauge fills back up in the highlight's own colour.
      className={`tab-strip${activeBusy ? " active-busy" : ""}`}
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
        const work = workOf(`${connId}:${tab.id}`);
        const stepping = progress !== null && progress.tabId === tab.id ? progress : null;
        const running = tab.id === runningTabId || stepping !== null;
        const busy = running || work?.busy === true;
        return (
          <div
            key={elementKey(tab)}
            data-motion-key={elementKey(tab)}
            role="tab"
            aria-selected={active}
            aria-busy={busy}
            className={`tab tab-${tab.kind} gauge-host${active ? " active" : ""}${(tab.kind === "query" || tab.kind === "data") && tab.error ? " has-error" : ""}${tab.kind === "data" && tab.preview ? " preview" : ""}`}
            data-kind={tab.kind}
            title={(() => {
              const digit = digitOf(index, tabs.length);
              const label = `${tabKindLabel(tab)} · ${titleOf(tab)}${busy ? ` — ${t("실행 중…")}` : ""}`;
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
            <Gauge
              busy={busy}
              id={`tab:${connId}:${tab.id}`}
              value={stepping?.value ?? null}
              step={stepping?.step}
              outcome={work !== undefined && !running ? work.outcome : runOutcome(tab)}
            />
            <span className="tab-icon">{tabIcon(tab)}</span>
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
      <span ref={indicatorRef} className="tab-indicator" aria-hidden="true" />
    </div>
  );
}
