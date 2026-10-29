import { memo, useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import type { ConsoleEntry } from "../net/socket";
import { store } from "../store";
import { ErrorNotice } from "./ErrorNotice";
import { SqlText } from "./SqlText";
import { TrashIcon } from "./icons";

interface ConsolePanelProps {
  conn: string;
  height: number;
}

// The server keeps this many too; anything older has scrolled away.
const CONSOLE_CAP = 1000;
const HIGHLIGHT_KEY = "tablepeek.console-highlight";

function loadHighlight(): boolean {
  try {
    return localStorage.getItem(HIGHLIGHT_KEY) !== "0";
  } catch {
    return true;
  }
}

function saveHighlight(on: boolean): void {
  try {
    localStorage.setItem(HIGHLIGHT_KEY, on ? "1" : "0");
  } catch {
    // Not remembered, still applied.
  }
}

// "-- 2026-10-23 10:05:50.7580", TablePlus's stamp: local time, four places.
function stamp(atMs: number): string {
  const date = new Date(atMs);
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return (
    `-- ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    `${pad(date.getMilliseconds(), 3)}0`
  );
}

const ConsoleLine = memo(function ConsoleLine({
  entry,
  highlight,
}: {
  entry: ConsoleEntry;
  highlight: boolean;
}) {
  return (
    <div className="console-entry">
      <span className={highlight ? "sx-comment" : undefined}>{stamp(entry.atMs)}</span>
      {"\n"}
      <SqlText sql={entry.sql} highlight={highlight} />
    </div>
  );
});

// TablePlus's console log docked under the workbench: every statement sent to
// this connection's database, the app's own lookups included, oldest first.
export function ConsolePanel({ conn, height }: ConsolePanelProps) {
  const [entries, setEntries] = useState<ConsoleEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(loadHighlight);
  const logRef = useRef<HTMLDivElement | null>(null);
  // Follow new entries only while the log is already scrolled to the end.
  const pinnedRef = useRef(true);
  // What's shown, readable from the socket listener without waiting a render.
  const listRef = useRef<ConsoleEntry[] | null>(null);

  useEffect(() => {
    let alive = true;
    const show = (next: ConsoleEntry[] | null): void => {
      const capped = next !== null && next.length > CONSOLE_CAP ? next.slice(next.length - CONSOLE_CAP) : next;
      listRef.current = capped;
      setEntries(capped);
    };
    show(null);
    setError(null);
    pinnedRef.current = true;
    // A request is out and its answer not yet in: the socket opening while it
    // waits must not send a second one.
    let awaiting = false;
    const watch = (since: number | null): void => {
      awaiting = true;
      store.watchConsole(conn, since).catch((err: unknown) => {
        awaiting = false;
        if (alive) {
          setError(err instanceof Error && err.message ? err.message : t("콘솔을 불러오지 못했습니다"));
        }
      });
    };
    const offConsole = store.onConsole((update) => {
      // A closed connection sends nothing more; its slot is gone for good.
      if (!alive || update.conn !== conn || update.closed) {
        return;
      }
      awaiting = false;
      setError(null);
      const current = listRef.current ?? [];
      if (update.reset) {
        // A full answer can land after pushes it doesn't carry (it raced
        // them): keep whatever is newer than its last entry.
        const tail = update.entries.length > 0 ? update.entries[update.entries.length - 1].seq : 0;
        show(update.entries.concat(current.filter((entry) => entry.seq > tail)));
        return;
      }
      const last = current.length > 0 ? current[current.length - 1].seq : 0;
      const fresh = update.entries.filter((entry) => entry.seq > last);
      if (fresh.length > 0 || listRef.current === null) {
        show(current.concat(fresh));
      }
    });
    // The server stops pushing when the socket drops, and may have restarted
    // with its numbering from one: start over from what it holds now.
    let socketOpen = store.getState().connection === "open";
    const offStatus = store.subscribe(() => {
      const open = store.getState().connection === "open";
      if (!open) {
        // Whatever was asked on the old socket won't be answered.
        awaiting = false;
      } else if (!socketOpen && alive && !awaiting) {
        show(null);
        watch(null);
      }
      socketOpen = open;
    });
    watch(null);
    return () => {
      alive = false;
      offConsole();
      offStatus();
      store.unwatchConsole(conn);
    };
  }, [conn]);

  useEffect(() => {
    const log = logRef.current;
    if (log !== null && pinnedRef.current) {
      log.scrollTop = log.scrollHeight;
    }
  }, [entries, highlight]);

  async function clear(): Promise<void> {
    try {
      await store.clearConsole(conn);
      listRef.current = [];
      setEntries([]);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("콘솔을 비우지 못했습니다"));
    }
  }

  return (
    <section className="console-panel" style={{ height }} aria-label={t("콘솔")}>
      {error !== null ? <ErrorNotice error={error} variant="compact" /> : null}
      {entries !== null && entries.length === 0 ? (
        <div className="console-empty">{t("이 연결에서 실행되는 SQL이 여기에 기록됩니다")}</div>
      ) : (
        <div
          className="console-log"
          ref={logRef}
          tabIndex={0}
          onScroll={(event) => {
            const log = event.currentTarget;
            pinnedRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
          }}
          onKeyDown={(event) => {
            // ⌘A selects the log, not the whole page.
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
              event.preventDefault();
              const selection = window.getSelection();
              selection?.selectAllChildren(event.currentTarget);
            }
          }}
        >
          {(entries ?? []).map((entry) => (
            <ConsoleLine entry={entry} highlight={highlight} key={entry.seq} />
          ))}
        </div>
      )}
      <div className="console-foot">
        <button
          type="button"
          className="icon-button"
          title={t("콘솔 비우기")}
          aria-label={t("콘솔 비우기")}
          disabled={entries === null || entries.length === 0}
          onClick={() => void clear()}
        >
          <TrashIcon size={11} />
        </button>
        <label className="console-highlight">
          <input
            type="checkbox"
            checked={highlight}
            onChange={(event) => {
              setHighlight(event.target.checked);
              saveHighlight(event.target.checked);
            }}
          />
          {t("구문 강조")}
        </label>
      </div>
    </section>
  );
}
