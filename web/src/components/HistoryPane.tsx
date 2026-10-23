import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { writeClipboard } from "../clipboard";
import { getLanguage, t } from "../i18n";
import { downloadSql } from "../savedQueries";
import { store, type HistoryEntry } from "../store";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { ErrorNotice } from "./ErrorNotice";
import { PromptModal } from "./PromptModal";
import { LoadingState } from "./Spinner";
import { SqlText } from "./SqlText";
import { ChevronIcon, SearchIcon } from "./icons";

interface HistoryPaneProps {
  conn: string;
  // Bumped after each editor run.
  version: number;
  // The tab is showing: reload what may have changed while it was hidden.
  active: boolean;
  onOpen(sql: string): void;
  onRun(sql: string): void;
  onInsert(sql: string): void;
}

const HISTORY_LIMIT = 1000;

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function locale(): string {
  return getLanguage() === "ko" ? "ko-KR" : "en-US";
}

interface Day {
  key: string;
  label: string;
  entries: HistoryEntry[];
}

// TablePlus's History tab: this connection's statements, newest first, under a
// heading per day; today's day starts open.
export function HistoryPane({ conn, version, active, onOpen, onRun, onInsert }: HistoryPaneProps) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; entry: HistoryEntry } | null>(null);
  const [saving, setSaving] = useState<HistoryEntry | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const request = ++requestRef.current;
    try {
      const next = await store.fetchHistory(conn, HISTORY_LIMIT);
      if (request === requestRef.current) {
        setEntries(next);
        setError(null);
      }
    } catch (err) {
      if (request === requestRef.current) {
        setError(err instanceof Error && err.message ? err.message : t("기록을 불러오지 못했습니다"));
      }
    }
  }, [conn]);

  useEffect(() => {
    if (active) {
      void load();
    }
  }, [load, version, active]);

  // Changes committed from the grid and other views land here too. The server
  // files them in the background, a moment after the change itself returns, so
  // look once soon and once more a little later.
  useEffect(() => {
    let timers: number[] = [];
    function onChanged(event: Event): void {
      if ((event as CustomEvent<string>).detail !== conn) {
        return;
      }
      timers.forEach((timer) => window.clearTimeout(timer));
      timers = [300, 1200].map((delay) => window.setTimeout(() => void load(), delay));
    }
    window.addEventListener("tablepeek:history-changed", onChanged);
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener("tablepeek:history-changed", onChanged);
    };
  }, [conn, load]);

  const needle = filter.trim().toLowerCase();
  const days = useMemo((): Day[] => {
    const result: Day[] = [];
    const lang = locale();
    for (const entry of entries ?? []) {
      if (needle !== "" && !entry.sql.toLowerCase().includes(needle)) {
        continue;
      }
      const date = new Date(entry.at * 1000);
      const key = dayKey(date);
      let day = result[result.length - 1];
      if (day === undefined || day.key !== key) {
        day = {
          key,
          label: date.toLocaleDateString(lang, { year: "numeric", month: "long", day: "numeric" }),
          entries: [],
        };
        result.push(day);
      }
      day.entries.push(entry);
    }
    return result;
  }, [entries, needle]);

  const today = dayKey(new Date());
  // A search shows every match without opening days by hand.
  const isOpen = (key: string): boolean => needle !== "" || (opened[key] ?? key === today);
  const visible = days.flatMap((day) => (isOpen(day.key) ? day.entries : []));

  useEffect(() => {
    if (selected !== null) {
      listRef.current
        ?.querySelector(`[data-history-id="${CSS.escape(selected)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
  }, [selected]);

  async function remove(entry: HistoryEntry): Promise<void> {
    try {
      await store.deleteHistoryEntry(conn, entry.id);
      setEntries((current) => (current ?? []).filter((existing) => existing.id !== entry.id));
      if (selected === entry.id) {
        setSelected(null);
      }
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("기록을 지우지 못했습니다"));
    }
  }

  async function clearAll(): Promise<void> {
    if (!window.confirm(t("이 연결의 실행 기록을 모두 지울까요?"))) {
      return;
    }
    try {
      await store.clearHistory(conn);
      setEntries([]);
      setSelected(null);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("기록을 지우지 못했습니다"));
    }
  }

  function menuItems(entry: HistoryEntry): ContextMenuItem[] {
    return [
      { label: t("실행"), onSelect: () => onRun(entry.sql) },
      { label: t("복사"), onSelect: () => void writeClipboard(entry.sql, setError) },
      { label: t("다른 이름으로 저장…"), onSelect: () => downloadSql("query", entry.sql) },
      { label: t("SQL 에디터에 넣기"), onSelect: () => onInsert(entry.sql) },
      { label: t("쿼리에 추가…"), separatorBefore: true, onSelect: () => setSaving(entry) },
      { label: t("삭제"), separatorBefore: true, danger: true, onSelect: () => void remove(entry) },
      { label: t("기록 모두 지우기"), danger: true, onSelect: () => void clearAll() },
    ];
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const index = visible.findIndex((entry) => entry.id === selected);
    const current = index >= 0 ? visible[index] : null;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = visible[Math.min(visible.length - 1, Math.max(0, index + step))];
      if (next !== undefined) {
        setSelected(next.id);
      }
    } else if (event.key === "Enter" && current !== null) {
      event.preventDefault();
      onOpen(current.sql);
    } else if ((event.key === "Delete" || event.key === "Backspace") && current !== null) {
      event.preventDefault();
      const after = visible[index + 1] ?? visible[index - 1] ?? null;
      void remove(current).then(() => setSelected(after?.id ?? null));
    }
  }

  const timeFormat = { hour: "numeric", minute: "2-digit", second: "2-digit" } as const;

  return (
    <div className="sidebar-pane">
      <div className="schema-search">
        <SearchIcon size={11} className="schema-search-icon" />
        <input
          value={filter}
          placeholder={t("기록 검색")}
          spellCheck={false}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      <div className="schema-list history-list" ref={listRef} tabIndex={0} onKeyDown={onKeyDown}>
        {error !== null ? (
          <div className="schema-error-slot">
            <ErrorNotice message={error} variant="compact" />
          </div>
        ) : null}
        {entries === null ? (
          error === null ? <LoadingState variant="compact" /> : null
        ) : days.length === 0 ? (
          <div className="panel-empty">
            {needle === "" ? t("SQL 에디터에서 실행한 쿼리가 여기에 기록됩니다") : t("검색 결과가 없습니다")}
          </div>
        ) : (
          days.map((day) => (
            <div className="history-day" key={day.key}>
              <div
                className="schema-section-head"
                onClick={() => setOpened((current) => ({ ...current, [day.key]: !isOpen(day.key) }))}
              >
                <span className={`schema-toggle${isOpen(day.key) ? " open" : ""}`}>
                  <ChevronIcon size={10} />
                </span>
                <span className="schema-section-label">{day.label}</span>
              </div>
              {isOpen(day.key)
                ? day.entries.map((entry) => (
                    <div
                      className={`history-item${entry.id === selected ? " selected" : ""}${entry.ok ? "" : " failed"}`}
                      key={entry.id}
                      data-history-id={entry.id}
                      title={entry.error ?? undefined}
                      onClick={() => setSelected(entry.id)}
                      onDoubleClick={() => onOpen(entry.sql)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setSelected(entry.id);
                        setMenu({ x: event.clientX, y: event.clientY, entry });
                      }}
                    >
                      <div className="history-time">
                        {new Date(entry.at * 1000).toLocaleTimeString(locale(), timeFormat)}
                      </div>
                      <div className="history-sql">
                        <SqlText sql={entry.sql} />
                      </div>
                    </div>
                  ))
                : null}
            </div>
          ))
        )}
      </div>
      {menu !== null ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.entry)} onClose={() => setMenu(null)} />
      ) : null}
      {saving !== null ? (
        <PromptModal
          title={t("쿼리에 추가")}
          label={t("이름")}
          placeholder={t("쿼리 이름")}
          confirmLabel={t("저장")}
          onSubmit={async (name) => {
            try {
              await store.createFavorite(name, saving.sql);
              return null;
            } catch (err) {
              return err instanceof Error && err.message ? err.message : t("쿼리를 저장하지 못했습니다");
            }
          }}
          onClose={() => setSaving(null)}
        />
      ) : null}
    </div>
  );
}
