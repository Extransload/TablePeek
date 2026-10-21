import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { store, type HistoryEntry } from "../store";
import { ErrorNotice } from "./ErrorNotice";
import { CloseIcon } from "./icons";

interface ConsolePanelProps {
  conn: string;
  // Bumped after each editor run so the list picks up the new entries.
  version: number;
  height: number;
  onOpenSql(sql: string): void;
  onClose(): void;
}

// HH:MM:SS for statements run today; older ones lead with the month and day.
function timeText(at: number): string {
  const date = new Date(at * 1000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (date.getTime() >= startOfToday) {
    return time;
  }
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

// TablePlus-style console docked under the workbench: every statement run from
// the editor on this connection, oldest first so the newest sits at the bottom.
export function ConsolePanel({ conn, version, height, onOpenSql, onClose }: ConsolePanelProps) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  // Follow new entries only while the list is already scrolled to the end.
  const pinnedRef = useRef(true);
  // Only the latest request may land: switching connections quickly must not
  // let an older connection's answer fill this one's console.
  const requestRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const request = ++requestRef.current;
    try {
      const history = await store.fetchHistory(conn, 200);
      if (request === requestRef.current) {
        setEntries(history.slice().reverse());
        setError(null);
      }
    } catch (err) {
      if (request === requestRef.current) {
        setError(err instanceof Error && err.message ? err.message : t("기록을 불러오지 못했습니다"));
      }
    }
  }, [conn]);

  useEffect(() => {
    setEntries(null);
    pinnedRef.current = true;
  }, [conn]);

  useEffect(() => {
    void load();
  }, [load, version]);

  useEffect(() => {
    const list = listRef.current;
    if (list !== null && pinnedRef.current) {
      list.scrollTop = list.scrollHeight;
    }
  }, [entries, query]);

  async function clearAll(): Promise<void> {
    if (!window.confirm(t("이 연결의 실행 기록을 모두 지울까요?"))) {
      return;
    }
    try {
      await store.clearHistory(conn);
      await load();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("기록을 지우지 못했습니다"));
    }
  }

  const needle = query.trim().toLowerCase();
  const filtered = (entries ?? []).filter(
    (entry) => needle === "" || entry.sql.toLowerCase().includes(needle),
  );

  return (
    <section className="console-panel" style={{ height }} aria-label={t("콘솔")}>
      <div className="console-head">
        <span className="console-title">{t("콘솔")}</span>
        <span className="console-count">
          {entries === null ? "" : t("{count}건", { count: entries.length })}
        </span>
        <span className="spacer" />
        <input
          className="console-search"
          placeholder={t("SQL 검색")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="console-clear"
          disabled={entries === null || entries.length === 0}
          onClick={() => void clearAll()}
        >
          {t("기록 지우기")}
        </button>
        <button type="button" className="icon-button" onClick={onClose} title={t("닫기")}>
          <CloseIcon size={10} />
        </button>
      </div>
      {error !== null ? <ErrorNotice message={error} variant="compact" /> : null}
      <div
        className="console-list"
        ref={listRef}
        onScroll={(event) => {
          const list = event.currentTarget;
          pinnedRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
        }}
      >
        {entries === null ? null : filtered.length === 0 ? (
          <div className="console-empty">
            {entries.length === 0
              ? t("콘솔 로그 — 쿼리를 실행하면 이 연결의 실행 기록이 여기에 남습니다")
              : t("검색 결과가 없습니다")}
          </div>
        ) : (
          filtered.map((entry, index) => (
            <div
              className={`console-row${entry.ok ? "" : " failed"}`}
              key={`${entry.at}-${index}`}
              title={t("두 번 누르면 에디터로 불러옵니다")}
              onDoubleClick={() => onOpenSql(entry.sql)}
            >
              <span className="console-time">{timeText(entry.at)}</span>
              <span className={`console-ms${entry.ms > 1000 ? " slow" : ""}`}>
                {entry.ms.toLocaleString()}ms
              </span>
              <span className="console-rows">
                {entry.ok ? t("{count}행", { count: entry.rows.toLocaleString() }) : t("오류")}
              </span>
              <span className="console-sql">
                {entry.sql.replace(/\s+/g, " ")}
                {entry.error !== undefined ? <span className="console-error">{entry.error}</span> : null}
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
