import { useEffect, useState, type ReactNode } from "react";
import { getLanguage, t } from "../i18n";

export type SidebarTab = "items" | "queries" | "history";

interface SidebarPanelProps {
  conn: string;
  items: ReactNode;
  queries: ReactNode;
  // Told whether it is showing, so it can reload when it comes back.
  history(active: boolean): ReactNode;
}

// Spelled out per language: "쿼리" alone translates as the singular elsewhere.
const TABS: { id: SidebarTab; ko: string; en: string }[] = [
  { id: "items", ko: "항목", en: "Items" },
  { id: "queries", ko: "쿼리", en: "Queries" },
  { id: "history", ko: "기록", en: "History" },
];

// The tab each connection last showed, kept while the app runs.
const chosen = new Map<string, SidebarTab>();

// TablePlus's left sidebar: Items, Queries and History over one pane. A pane
// stays mounted once opened, so switching back keeps its scroll and search.
export function SidebarPanel({ conn, items, queries, history }: SidebarPanelProps) {
  const [tab, setTab] = useState<SidebarTab>(() => chosen.get(conn) ?? "items");
  const [visited, setVisited] = useState<Set<SidebarTab>>(() => new Set([tab]));

  useEffect(() => {
    chosen.set(conn, tab);
  }, [conn, tab]);

  function show(next: SidebarTab): void {
    setTab(next);
    setVisited((current) => (current.has(next) ? current : new Set(current).add(next)));
  }

  return (
    <aside className="schema-sidebar">
      <div className="sidebar-tabs" role="tablist" aria-label={t("사이드바")}>
        {TABS.map((entry) => (
          <button
            type="button"
            role="tab"
            key={entry.id}
            className={entry.id === tab ? "active" : undefined}
            aria-selected={entry.id === tab}
            onClick={() => show(entry.id)}
          >
            {getLanguage() === "en" ? entry.en : entry.ko}
          </button>
        ))}
      </div>
      <div className="sidebar-body" hidden={tab !== "items"}>
        {items}
      </div>
      {visited.has("queries") ? (
        <div className="sidebar-body" hidden={tab !== "queries"}>
          {queries}
        </div>
      ) : null}
      {visited.has("history") ? (
        <div className="sidebar-body" hidden={tab !== "history"}>
          {history(tab === "history")}
        </div>
      ) : null}
    </aside>
  );
}
