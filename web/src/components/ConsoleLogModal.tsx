import { useEffect, useState } from "react";
import { clearQueryLog, subscribeQueryLog, type QueryLogEntry } from "../consoleLog";

interface ConsoleLogModalProps {
  onOpenSql(sql: string): void;
  onClose(): void;
}

function timeText(at: number): string {
  const date = new Date(at);
  return date.toLocaleTimeString("ko-KR", { hour12: false });
}

export function ConsoleLogModal({ onOpenSql, onClose }: ConsoleLogModalProps) {
  const [entries, setEntries] = useState<QueryLogEntry[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => subscribeQueryLog(setEntries), []);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const filtered = entries
    .filter(
      (entry) =>
        query.trim() === "" ||
        entry.sql.toLowerCase().includes(query.trim().toLowerCase()),
    )
    .slice()
    .reverse();

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal log-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">콘솔 로그</span>
          <span className="modal-path">{`${entries.length}개`}</span>
        </div>
        <div className="modal-body log-body">
          <div className="log-tools">
            <input
              placeholder="SQL 검색"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <span className="spacer" />
            <button type="button" onClick={() => clearQueryLog()}>
              비우기
            </button>
          </div>
          <div className="log-list">
            {filtered.length === 0 ? (
              <div className="log-empty">기록된 쿼리가 없습니다</div>
            ) : (
              filtered.map((entry) => (
                <button
                  type="button"
                  className={`log-row${entry.ok ? "" : " failed"}`}
                  key={entry.id}
                  onClick={() => {
                    onOpenSql(entry.sql);
                    onClose();
                  }}
                  title="클릭하여 에디터로 불러오기"
                >
                  <span className="log-time mono">{timeText(entry.at)}</span>
                  <span className={`log-ms mono${entry.ms > 1000 ? " slow" : ""}`}>
                    {entry.ms.toLocaleString()}ms
                  </span>
                  <span className="log-rows mono">
                    {entry.ok ? `${entry.rows.toLocaleString()}행` : "오류"}
                  </span>
                  <span className="log-sql mono">{entry.sql.replace(/\s+/g, " ")}</span>
                </button>
              ))
            )}
          </div>
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
