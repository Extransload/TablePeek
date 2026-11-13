// The CLI section: commands typed as redis-cli takes them (quoted arguments,
// `\x..` escapes), one per line, each reply under it as redis-cli prints it
// and coloured by type. ↑ ↓ walk the connection's earlier commands, ⌘K
// clears, Stop ends a command that waits (BLPOP 0). Before sending, the
// server classifies the command: safe mode asks before a dangerous one (and
// at level 2 before any write); a dangerous one goes with `confirmed`. A
// read-only replica takes no writes from here either. The input line runs on
// right after the last reply, as in a terminal (Tern), or sits in a bar under
// the output: Settings › Appearance › CLI input.

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { confirmDialog } from "../../../components/ConfirmDialog";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { Gauge } from "../../../components/Gauge";
import { CopyIcon, PlayIcon, StopIcon, TrashIcon } from "../../../components/icons";
import { t, tServer } from "../../../i18n";
import { getSettings, subscribeSettings } from "../../../settings";
import { needsConfirm } from "../../elasticsearch/ui/common";
import { classify, consoleRun, consoleStop, KvError, type CommandClass } from "../api";
import { replyLines, replyText, type Reply } from "../reply";
import { copyText, type RedisHost } from "./common";

interface Entry {
  id: number;
  line: string;
  db: number;
  pending: boolean;
  reply?: Reply;
  error?: unknown;
  // Declined at the safe-mode question.
  declined?: boolean;
  elapsedMs?: number;
  class?: CommandClass;
}

// Per connection while the app runs; the typed text is saved with the workbench.
const transcripts = new Map<string, Entry[]>();
let nextId = 1;

const HISTORY_MAX = 300;

function historyKey(connKey: string): string {
  return `tablepeek.redis-history.${connKey}`;
}

function loadHistory(connKey: string): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(historyKey(connKey)) ?? "[]");
    return Array.isArray(raw) ? raw.filter((line): line is string => typeof line === "string") : [];
  } catch {
    return [];
  }
}

interface CliViewProps {
  host: RedisHost;
  // Where the console history is kept (the saved connection).
  connKey: string;
  // "127.0.0.1:6379", for the prompt.
  address: string;
  db: number;
  onDbChange(db: number): void;
  text: string;
  onTextChange(text: string): void;
  onBusy(busy: boolean): void;
}

export function CliView({ host, connKey, address, db, onDbChange, text, onTextChange, onBusy }: CliViewProps) {
  const [entries, setEntries] = useState<Entry[]>(() => transcripts.get(host.conn) ?? []);
  const [running, setRunning] = useState(false);
  const historyRef = useRef<string[]>(loadHistory(connKey));
  // Where ↑ ↓ are in the history; the history's length is "the line being typed".
  const [at, setAt] = useState(historyRef.current.length);
  const typedRef = useRef(text);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const dbRef = useRef(db);
  dbRef.current = db;
  useEffect(() => onBusy(running), [running, onBusy]);

  useEffect(() => {
    transcripts.set(host.conn, entries);
  }, [host.conn, entries]);

  const flow = useSyncExternalStore(subscribeSettings, () => getSettings().cliInput === "flow");

  useLayoutEffect(() => {
    const log = logRef.current;
    if (log !== null) {
      log.scrollTop = log.scrollHeight;
    }
  }, [entries, flow, running]);

  // The input comes back when a command is done (in the flow it is only
  // drawn while nothing runs), and on switching between flow and docked.
  useEffect(() => {
    if (!running) {
      inputRef.current?.focus({ preventScroll: true });
    }
  }, [running, flow]);

  const patch = (id: number, change: Partial<Entry>) => setEntries((prev) => prev.map((entry) => (entry.id === id ? { ...entry, ...change } : entry)));

  const remember = (line: string) => {
    const list = historyRef.current.filter((earlier) => earlier !== line);
    list.push(line);
    historyRef.current = list.slice(-HISTORY_MAX);
    try {
      localStorage.setItem(historyKey(connKey), JSON.stringify(historyRef.current));
    } catch {
      // A full storage only loses the history.
    }
    setAt(historyRef.current.length);
  };

  // One command: classified, asked about, sent. False stops the lines after it.
  const runLine = async (line: string): Promise<boolean> => {
    const id = nextId++;
    const lineDb = dbRef.current;
    setEntries((prev) => [...prev, { id, line, db: lineDb, pending: true }]);
    try {
      const cls = await classify(host.conn, lineDb, line);
      if (host.readOnly && cls.class !== "read") {
        patch(id, { pending: false, class: cls.class, error: new KvError("bad_request", t("읽기 전용 복제 서버(replica)라 바꿀 수 없습니다. 마스터에 접속하세요")) });
        return false;
      }
      if (needsConfirm(cls.class, host.safeMode)) {
        const ok = await confirmDialog({
          title: cls.class === "danger" ? t("위험한 명령 실행") : t("명령 실행"),
          message: `${cls.reason !== undefined && cls.reason !== "" ? `${tServer(cls.reason)}\n\n` : ""}${line}`,
          confirmLabel: t("실행"),
          danger: cls.class === "danger",
        });
        if (!ok) {
          patch(id, { pending: false, declined: true, class: cls.class });
          return false;
        }
      }
      const reply = await consoleRun(host.conn, { db: lineDb, line, confirmed: cls.class === "danger" });
      patch(id, { pending: false, reply: reply.reply, elapsedMs: reply.elapsed_ms, class: reply.class });
      if (reply.db !== dbRef.current) {
        dbRef.current = reply.db;
        onDbChange(reply.db);
      }
      return true;
    } catch (error) {
      patch(id, { pending: false, error });
      return false;
    }
  };

  const run = async () => {
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (lines.length === 0 || running) {
      return;
    }
    if (lines.length === 1 && /^clear$/i.test(lines[0])) {
      setEntries([]);
      onTextChange("");
      return;
    }
    setRunning(true);
    onTextChange("");
    typedRef.current = "";
    for (const line of lines) {
      remember(line);
      if (!(await runLine(line))) {
        break;
      }
    }
    setRunning(false);
    inputRef.current?.focus();
  };

  const stop = () => {
    void consoleStop(host.conn).catch(() => undefined);
  };

  const walk = (step: -1 | 1) => {
    const list = historyRef.current;
    const next = Math.max(0, Math.min(list.length, at + step));
    if (next === at) {
      return;
    }
    if (at === list.length) {
      typedRef.current = text;
    }
    setAt(next);
    onTextChange(next === list.length ? typedRef.current : list[next]);
  };

  const prompt = (
    <span className="kv-prompt mono">
      {address}
      {db !== 0 ? `[${db}]` : ""}&gt;
    </span>
  );
  const textarea = (
    <textarea
      ref={inputRef}
      className="mono"
      rows={Math.min(flow ? 12 : 6, Math.max(1, text.split("\n").length))}
      spellCheck={false}
      autoCapitalize="off"
      autoComplete="off"
      aria-label={t("명령")}
      placeholder={running || flow ? "" : "GET key"}
      value={text}
      onChange={(event) => {
        onTextChange(event.target.value);
        setAt(historyRef.current.length);
      }}
      onKeyDown={(event) => {
        const multi = text.includes("\n");
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          void run();
        } else if (event.key === "ArrowUp" && !multi) {
          event.preventDefault();
          walk(-1);
        } else if (event.key === "ArrowDown" && !multi) {
          event.preventDefault();
          walk(1);
        } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
          event.preventDefault();
          setEntries([]);
        } else if (event.key === "c" && event.ctrlKey && running) {
          event.preventDefault();
          stop();
        }
      }}
    />
  );
  const stopButton = (
    <button type="button" className="kv-btn danger" title={t("실행 중인 명령 멈추기 (⌃C)")} onClick={stop}>
      <StopIcon size={10} />
      {t("멈추기")}
    </button>
  );
  const clearButton = (
    <button type="button" className="kv-icon" title={t("출력 지우기 (⌘K)")} aria-label={t("출력 지우기 (⌘K)")} onClick={() => setEntries([])}>
      <TrashIcon size={11} />
    </button>
  );

  return (
    <div className={`kv-cli${flow ? " flow" : ""}`}>
      <div
        className="kv-cli-log surface-main"
        ref={logRef}
        onMouseUp={() => {
          if (window.getSelection()?.toString() === "") {
            inputRef.current?.focus();
          }
        }}
      >
        {flow ? (
          <div className="kv-cli-float">
            {running ? stopButton : null}
            {entries.length > 0 ? clearButton : null}
          </div>
        ) : null}
        {entries.length === 0 ? (
          <div className="kv-cli-hint panel-dim">
            {t("redis-cli처럼 명령을 입력하고 ↩로 실행합니다. ↑↓ 이전 명령 · ⌘K 지우기 · clear")}
          </div>
        ) : null}
        {entries.map((entry) => (
          <div className="kv-entry" key={entry.id}>
            <div className="kv-entry-head">
              <span className="kv-prompt mono">
                {address}
                {entry.db !== 0 ? `[${entry.db}]` : ""}&gt;
              </span>
              <span className="kv-entry-line mono">{entry.line}</span>
              <span className="spacer" />
              {entry.class !== undefined && entry.class !== "read" ? <span className={`kv-class kv-class-${entry.class}`}>{entry.class === "danger" ? t("위험") : t("쓰기")}</span> : null}
              {entry.elapsedMs !== undefined ? <span className="kv-entry-time panel-dim">{entry.elapsedMs < 1 ? "<1 ms" : `${entry.elapsedMs.toLocaleString()} ms`}</span> : null}
              {entry.reply !== undefined ? (
                <button type="button" className="kv-icon kv-entry-copy" title={t("응답 복사")} aria-label={t("응답 복사")} onClick={() => void copyText(host, replyText(entry.reply as Reply))}>
                  <CopyIcon size={10} />
                </button>
              ) : null}
            </div>
            {entry.pending ? (
              <div className="kv-entry-pending gauge-host">
                <Gauge busy />
                {t("실행 중…")}
              </div>
            ) : entry.declined === true ? (
              <div className="kv-reply panel-dim">{t("(실행하지 않음)")}</div>
            ) : entry.error !== undefined ? (
              entry.error instanceof KvError && entry.error.code === "interrupted" ? (
                <div className="kv-reply panel-dim">{t("(멈춤)")}</div>
              ) : (
                <div className="kv-entry-error">
                  <ErrorNotice error={entry.error} context="shell" engine="redis" variant="compact" />
                </div>
              )
            ) : entry.reply !== undefined ? (
              <pre className="kv-reply mono">
                {replyLines(entry.reply).map((line, i) => (
                  <div key={i}>
                    {line.map((seg, j) => (
                      <span key={j} className={`kv-r-${seg.kind}`}>
                        {seg.text}
                      </span>
                    ))}
                  </div>
                ))}
              </pre>
            ) : null}
          </div>
        ))}
        {/* A terminal's prompt: under the last reply, gone while a command runs. */}
        {flow && !running ? (
          <div className="kv-cli-line">
            {prompt}
            {textarea}
          </div>
        ) : null}
      </div>
      {flow ? null : (
        <div className="kv-cli-input surface-bottom">
          {prompt}
          {textarea}
          {running ? (
            stopButton
          ) : (
            <button type="button" className="kv-btn primary" title={t("실행 (↩)")} disabled={text.trim() === ""} onClick={() => void run()}>
              <PlayIcon size={10} />
              {t("실행")}
            </button>
          )}
          {clearButton}
        </div>
      )}
    </div>
  );
}
