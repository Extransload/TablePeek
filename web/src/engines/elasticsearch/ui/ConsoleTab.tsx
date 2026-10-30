// The Dev Tools console tab (docs/engines/elasticsearch.md §4.6), as Kibana
// has it: an editor holding many requests (`METHOD /path` and a JSON or
// NDJSON body), the response beside it (below when the tab is narrow).
// ⌘↩ runs the request under the caret (or every request the selection
// touches), ⇧⌘↩ all of them in order, ⌘I auto-indents the body. Each
// request is classified first; safe mode asks before writes and dangerous
// requests, a read-only connection refuses them, and a dangerous one is
// always sent `confirmed` (the server refuses it otherwise). Recent runs are
// kept per connection to insert again.

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { writeClipboard } from "../../../clipboard";
import { ErrorNotice, notifyError } from "../../../components/ErrorNotice";
import { CopyIcon, HistoryIcon, PlayIcon } from "../../../components/icons";
import { Spinner } from "../../../components/Spinner";
import { useMenuDismiss } from "../../../components/useMenuDismiss";
import { t } from "../../../i18n";
import { stringifyJson } from "../../mongodb/bson";
import * as api from "../api";
import { bulkDeletes, completeConsole, curlCommand, endpointOf, formatBody, parseConsole, requestLine, requestsIn, type ConsoleNames, type ConsoleRequest } from "../console";
import { mappingFields, type MappedField } from "../dsl";
import { ConsoleText, consoleSpans, needsConfirm, requestText } from "./common";
import { SearchEditor, type SearchEditorHandle } from "./SearchEditor";
import { ServerTasks } from "./ServerTasks";
import type { ConsoleTabProps } from "./types";
import "../../mongodb/mongodb.css";
import "./console.css";

// What became of one request of a run.
type Outcome =
  | { kind: "pending" }
  | { kind: "reply"; status: number; cls: api.RequestClass; elapsedMs: number; text: string; json: boolean }
  | { kind: "failed"; error: unknown }
  | { kind: "refused"; cls: api.RequestClass }
  | { kind: "declined" }
  // `report`: what the server still runs for it (null when it couldn't say).
  | { kind: "stopped"; report?: api.StopReport | "loading" | null }
  | { kind: "syntax"; message: string; line: number; column: number; lineText: string };

interface RunResult {
  // The request line as run (`GET /shop/_search`) and where it was.
  line: string;
  from: number;
  to: number;
  outcome: Outcome;
}

interface HistoryEntry {
  // The request as written (method line and body).
  text: string;
  at: number;
  status: number | null;
}

const HISTORY_KEY = "tablepeek.search.console-history";
const HISTORY_CAP = 50;
// Text is saved this long after the last keystroke.
const SAVE_DELAY_MS = 400;
// Narrower than this, the response goes below the editor.
const NARROW_PX = 760;

// Results and layout per tab, kept across remounts.
const memory = new Map<string, { results: RunResult[]; selected: number; ratio: number }>();

function readHistory(key: string): HistoryEntry[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(HISTORY_KEY) ?? "{}");
    const list = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>)[key] : null;
    return Array.isArray(list) ? list.filter((e): e is HistoryEntry => typeof e?.text === "string" && typeof e?.at === "number") : [];
  } catch {
    return [];
  }
}

function writeHistory(key: string, list: HistoryEntry[]): void {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(HISTORY_KEY) ?? "{}");
    const all = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify({ ...all, [key]: list }));
  } catch {
    // Not remembered; the request still ran.
  }
}

function stamp(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  408: "Request Timeout",
  409: "Conflict",
  413: "Payload Too Large",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

const CLASS_LABEL: Record<api.RequestClass, string> = { read: "읽기", write: "쓰기", danger: "위험" };

function elapsedText(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

// A syntax error at `at` in the console text, with its line and column.
function syntaxOutcome(src: string, message: string, at: number): Extract<Outcome, { kind: "syntax" }> {
  const before = src.slice(0, at);
  const lineStart = before.lastIndexOf("\n") + 1;
  const nl = src.indexOf("\n", at);
  return { kind: "syntax", message, line: before.split("\n").length, column: at - lineStart + 1, lineText: src.slice(lineStart, nl < 0 ? src.length : nl) };
}

// Why the server classed a request as it did, as a sentence. The server's
// reason is the method or the endpoint that decided (`DELETE`,
// `_delete_by_query`, `_bulk delete`); a plain write needs no more than the
// dialog's first line.
function reasonSentence(cls: { class: api.RequestClass; reason: string }): string | null {
  const reason = cls.reason.trim();
  if (reason === "DELETE") {
    return t("DELETE 요청은 인덱스나 문서를 지웁니다.");
  }
  if (reason === "_bulk delete") {
    return t("_bulk 본문에 delete 동작이 있습니다");
  }
  if (reason === "_plugins/_security") {
    return t("보안 설정을 바꾸거나 노드를 멈추는 요청입니다.");
  }
  if (cls.class === "danger" && reason.startsWith("_")) {
    return t("{endpoint} 요청은 많은 문서나 클러스터 설정을 한꺼번에 바꿉니다.", { endpoint: reason });
  }
  // A sentence the page made itself (it has spaces); a bare method or endpoint adds nothing.
  return /\s/.test(reason) ? reason : null;
}

// The text a new console starts with: comments on how it works and three
// requests to run.
function sampleText(index: string): string {
  return [
    `# ${t("Dev Tools 콘솔 — 요청 줄(METHOD /경로) 다음 줄부터 JSON 본문을 씁니다")}`,
    `# ${t("⌘↩ 커서의 요청 실행 · ⇧⌘↩ 모두 실행 · ⌘I 본문 정리")}`,
    "",
    "GET _cluster/health",
    "",
    "GET /_cat/indices?v",
    "",
    `GET /${index}/_search`,
    "{",
    '  "query": {',
    '    "match_all": {}',
    "  }",
    "}",
    "",
  ].join("\n");
}

const SAMPLE_INDEX = "my-index";

export function ConsoleTab({ host, tabKey, connKey, text, onTextChange, active }: ConsoleTabProps) {
  const remembered = memory.get(tabKey);
  const [results, setResults] = useState<RunResult[]>(remembered?.results ?? []);
  const [selected, setSelected] = useState(remembered?.selected ?? 0);
  const [ratio, setRatio] = useState(remembered?.ratio ?? 0.5);
  const [running, setRunning] = useState(false);
  const [errorRange, setErrorRange] = useState<{ from: number; to: number } | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [names, setNames] = useState<ConsoleNames>({ indices: [], aliases: [], dataStreams: [] });
  const [namesSeq, setNamesSeq] = useState(0);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<SearchEditorHandle | null>(null);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  // The Stop's question to the server, answered once the run has stopped.
  const stopReportRef = useRef<Promise<api.StopReport> | null>(null);
  const runningRef = useRef(false);
  const hostRef = useRef(host);
  hostRef.current = host;
  const namesRef = useRef(names);
  namesRef.current = names;
  // Classes by `METHOD path` (the server decides by those alone).
  const classCache = useRef(new Map<string, { class: api.RequestClass; reason: string }>());
  // Mapped fields per index for body completion; empty after a failed read.
  const mappingCache = useRef(new Map<string, MappedField[] | "loading">());

  // The editor's first text: the tab's, or the sample (whose index is
  // filled in once the names load, if the sample is still untouched).
  const [initialText] = useState(() => (text !== "" ? text : sampleText(SAMPLE_INDEX)));
  const sampleRef = useRef<string | null>(text === "" ? initialText : null);
  const [requestCount, setRequestCount] = useState(() => parseConsole(initialText).length);

  // Saving: the latest text, written after a pause and when the tab goes.
  const onTextChangeRef = useRef(onTextChange);
  onTextChangeRef.current = onTextChange;
  const saveTimer = useRef<number | null>(null);
  const pendingText = useRef<string | null>(text === "" ? initialText : null);
  const flushSave = useCallback(() => {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (pendingText.current !== null) {
      onTextChangeRef.current(pendingText.current);
      pendingText.current = null;
    }
  }, []);
  useEffect(() => {
    flushSave();
    return flushSave;
  }, [flushSave]);

  const onEditorChange = (next: string) => {
    pendingText.current = next;
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
    }
    saveTimer.current = window.setTimeout(flushSave, SAVE_DELAY_MS);
    setRequestCount(parseConsole(next).length);
  };

  useEffect(() => {
    memory.set(tabKey, { results, selected, ratio });
  }, [tabKey, results, selected, ratio]);

  // A run still going when the tab goes away stops with it.
  useEffect(() => () => controllerRef.current?.abort(), []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const observer = new ResizeObserver(() => setNarrow(root.getBoundingClientRect().width < NARROW_PX));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // Index, alias and data stream names for completion: read when the tab
  // comes to the front and after a write ran. Completion is a convenience;
  // a failed read leaves the lists as they were.
  useEffect(() => {
    if (!active) {
      return;
    }
    const controller = new AbortController();
    const conn = host.conn;
    void Promise.allSettled([api.indices(conn, true, controller.signal), api.aliases(conn, controller.signal), api.dataStreams(conn, controller.signal)]).then(([indices, aliases, streams]) => {
      if (controller.signal.aborted) {
        return;
      }
      const prev = namesRef.current;
      const next: ConsoleNames = {
        indices: indices.status === "fulfilled" ? indices.value.map((row) => row.name).sort() : prev.indices,
        aliases: aliases.status === "fulfilled" ? [...new Set(aliases.value.map((row) => row.alias))].sort() : prev.aliases,
        dataStreams: streams.status === "fulfilled" ? streams.value.map((row) => row.name).sort() : prev.dataStreams,
      };
      setNames(next);
      // The sample searches a user's index: not hidden, not a system,
      // security, audit or query-insights index, not a data stream's backing.
      const userIndices = indices.status === "fulfilled" ? indices.value.filter((row) => !row.hidden && row.data_stream === null && !/^(?:\.|security-auditlog-|top_queries-|ilm-history-|\.?kibana|apm-|logs-|metrics-|traces-|opensearch-|ml-)/.test(row.name)).map((row) => row.name).sort() : [];
      const first = userIndices[0] ?? next.aliases.find((name) => !name.startsWith(".")) ?? next.dataStreams.find((name) => !name.startsWith(".")) ?? next.indices.find((name) => !name.startsWith("."));
      const editor = editorRef.current;
      if (first !== undefined && sampleRef.current !== null && editor !== null && editor.text() === sampleRef.current) {
        editor.setText(sampleText(first));
      }
      sampleRef.current = null;
    });
    return () => controller.abort();
  }, [active, host.conn, namesSeq]);

  const complete = useCallback(
    (src: string, pos: number) =>
      completeConsole(src, pos, {
        names: namesRef.current,
        fieldsOf: (index) => {
          const hit = mappingCache.current.get(index);
          if (hit === undefined) {
            mappingCache.current.set(index, "loading");
            api.getMapping(hostRef.current.conn, index).then(
              (mapping) => mappingCache.current.set(index, mappingFields(mapping)),
              () => mappingCache.current.set(index, []),
            );
          }
          return hit === undefined || hit === "loading" ? [] : hit;
        },
      }),
    [],
  );

  const lineClass = useCallback((src: string) => parseConsole(src).map((req) => ({ line: req.line, cls: "es-console-request" })), []);

  // A request that does not parse: underlined in the editor, and in a toast
  // for the actions that have no result of their own (copy, indent).
  const reportSyntax = (src: string, req: ConsoleRequest) => {
    const error = req.error!;
    setErrorRange({ from: error.from, to: error.to });
    const o = syntaxOutcome(src, error.message, error.from);
    notifyError({ code: "parse_error", message: error.message, position: { line: o.line, column: o.column } }, { context: "shell" });
  };

  // The class a request is sent as: the server's by method and path, and
  // danger for a `_bulk` body with a delete.
  const classOf = async (req: ConsoleRequest, signal: AbortSignal): Promise<{ class: api.RequestClass; reason: string }> => {
    const key = `${req.method} ${req.path}`;
    let known = classCache.current.get(key);
    if (known === undefined) {
      known = await api.classify(hostRef.current.conn, req.method, req.path, signal);
      classCache.current.set(key, known);
    }
    if (known.class !== "danger" && bulkDeletes(req)) {
      return { class: "danger", reason: t("_bulk 본문에 delete 동작이 있습니다") };
    }
    return known;
  };

  const record = (entry: HistoryEntry) => {
    const list = [entry, ...readHistory(connKey).filter((e) => e.text !== entry.text)].slice(0, HISTORY_CAP);
    writeHistory(connKey, list);
  };

  // Runs requests in order. A refusal (read-only), a declined confirmation,
  // a failure to reach the server or a stop ends the run; an error status
  // from the cluster is a response like any other.
  const runRequests = async (reqs: ConsoleRequest[], src: string) => {
    if (runningRef.current) {
      return;
    }
    if (reqs.length === 0) {
      host.notify(t("실행할 요청이 없습니다"));
      return;
    }
    const bad = reqs.find((req) => req.error !== null);
    if (bad !== undefined) {
      const error = bad.error!;
      setErrorRange({ from: error.from, to: error.to });
      setResults([{ line: requestLine(bad), from: bad.from, to: bad.to, outcome: syntaxOutcome(src, error.message, error.from) }]);
      setSelected(0);
      return;
    }
    setErrorRange(null);
    const controller = new AbortController();
    controllerRef.current = controller;
    runningRef.current = true;
    setRunning(true);
    const out: RunResult[] = [];
    let changed = false;
    const settle = (outcome: Outcome) => {
      out[out.length - 1] = { ...out[out.length - 1], outcome };
      setResults([...out]);
    };
    for (const req of reqs) {
      out.push({ line: requestLine(req), from: req.from, to: req.to, outcome: { kind: "pending" } });
      setResults([...out]);
      setSelected(out.length - 1);
      editorRef.current?.flash(req.from, req.to);
      try {
        const cls = await classOf(req, controller.signal);
        const current = hostRef.current;
        if (current.readOnly && cls.class !== "read") {
          settle({ kind: "refused", cls: cls.class });
          break;
        }
        let confirmed = cls.class === "danger";
        if (needsConfirm(cls.class, current.safeMode)) {
          const { index, rest } = endpointOf(req.path);
          const single = req.method === "DELETE" && index !== null && index !== "_all" && rest.length === 0 && !/[*,]/.test(index);
          const lead = cls.class === "danger" ? t("이 요청은 데이터나 인덱스를 지우거나 되돌리기 어렵게 바꿉니다.") : t("이 요청은 데이터나 설정을 바꿉니다.");
          const ok = await current.confirm({
            title: cls.class === "danger" ? t("위험한 요청을 보낼까요?") : t("쓰기 요청을 보낼까요?"),
            message: [lead, reasonSentence(cls)].filter((line) => line !== null).join("\n"),
            command: requestText(req.method, req.path, req.body ?? null),
            okLabel: t("실행"),
            typeToConfirm: single && index !== null ? index : undefined,
          });
          if (!ok) {
            settle({ kind: "declined" });
            break;
          }
          confirmed = true;
        }
        if (controller.signal.aborted) {
          stopReportRef.current = null;
          settle({ kind: "stopped" });
          break;
        }
        const reply = await api.consoleRequest(current.conn, { method: req.method, path: req.path, body: req.body, confirmed: confirmed || undefined }, controller.signal);
        const body = reply.body;
        settle({
          kind: "reply",
          status: reply.status,
          cls: reply.class,
          elapsedMs: reply.elapsedMs,
          text: typeof body === "string" ? body : body === null ? "" : stringifyJson(body, 2),
          json: typeof body !== "string",
        });
        record({ text: src.slice(req.from, req.to), at: Date.now(), status: reply.status });
        if (reply.class !== "read" && reply.status < 300) {
          changed = true;
        }
      } catch (error) {
        if (!api.isAbort(error)) {
          settle({ kind: "failed", error });
          break;
        }
        // A Stop asked the server what the request left running.
        const pending = stopReportRef.current;
        stopReportRef.current = null;
        settle({ kind: "stopped", report: pending ? "loading" : null });
        const entry = out[out.length - 1];
        void pending
          ?.catch(() => null)
          .then((report) =>
            setResults((list) => list.map((r) => (r === entry ? { ...r, outcome: { kind: "stopped", report } } : r))),
          );
        break;
      }
    }
    if (controllerRef.current === controller) {
      controllerRef.current = null;
    }
    runningRef.current = false;
    setRunning(false);
    setSelected(out.length - 1);
    if (changed) {
      mappingCache.current.clear();
      setNamesSeq((n) => n + 1);
    }
  };

  // Stop: the page stops waiting at once, and the server is asked what the
  // request left running (cancelling a read's tasks).
  const stopRun = () => {
    stopReportRef.current = api.stopRunning(hostRef.current.conn);
    controllerRef.current?.abort();
  };

  const runCurrent = () => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    const src = editor.text();
    const sel = editor.selection();
    void runRequests(requestsIn(src, sel.from, sel.to), src);
  };

  const runAll = () => {
    const src = editorRef.current?.text() ?? "";
    void runRequests(parseConsole(src), src);
  };

  // Auto-indent: the bodies of the requests under the caret or selection.
  const formatCurrent = () => {
    const editor = editorRef.current;
    const view = editor?.view();
    if (!editor || !view) {
      return;
    }
    const src = editor.text();
    const sel = editor.selection();
    const reqs = requestsIn(src, sel.from, sel.to);
    if (reqs.length === 0) {
      host.notify(t("정리할 요청이 없습니다"));
      return;
    }
    const bad = reqs.find((req) => req.error !== null);
    if (bad !== undefined) {
      reportSyntax(src, bad);
      return;
    }
    setErrorRange(null);
    const changes = reqs.flatMap((req) => {
      const formatted = formatBody(src, req);
      return formatted === null || src.slice(formatted.from, formatted.to) === formatted.text ? [] : [{ from: formatted.from, to: formatted.to, insert: formatted.text }];
    });
    if (changes.length > 0) {
      view.dispatch({ changes });
    }
    editor.focus();
  };

  const copyCurl = async () => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    const src = editor.text();
    const sel = editor.selection();
    const reqs = requestsIn(src, sel.from, sel.to);
    if (reqs.length === 0) {
      host.notify(t("복사할 요청이 없습니다"));
      return;
    }
    const bad = reqs.find((req) => req.error !== null);
    if (bad !== undefined) {
      reportSyntax(src, bad);
      return;
    }
    let failed = false;
    await writeClipboard(reqs.map(curlCommand).join("\n\n"), (message) => {
      failed = true;
      notifyError(new Error(message));
    });
    if (!failed) {
      host.notify(reqs.length === 1 ? t("cURL 명령을 복사했습니다") : t("cURL 명령 {count}개를 복사했습니다", { count: reqs.length }));
    }
  };

  const copyResponse = async (value: string) => {
    let failed = false;
    await writeClipboard(value, (message) => {
      failed = true;
      notifyError(new Error(message));
    });
    if (!failed) {
      host.notify(t("응답을 복사했습니다"));
    }
  };

  // A request from history goes in after the one under the caret (or at
  // the end), and the caret moves to it.
  const insertHistory = (entry: HistoryEntry) => {
    setHistoryOpen(false);
    const editor = editorRef.current;
    const view = editor?.view();
    if (!editor || !view) {
      return;
    }
    const src = view.state.doc.toString();
    const head = view.state.selection.main.head;
    const current = requestsIn(src, head, head)[0];
    const at = current?.end ?? src.length;
    const before = src.slice(0, at);
    const lead = before === "" || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    const insert = `${lead}${entry.text}\n`;
    const start = at + lead.length;
    view.dispatch({ changes: { from: at, insert }, selection: { anchor: start }, scrollIntoView: true });
    editor.focus();
    editor.flash(start, start + entry.text.length);
  };

  const closeHistory = useCallback(() => setHistoryOpen(false), []);
  useMenuDismiss(historyOpen, historyRef, closeHistory);

  // ⇧⌘↩ runs everything, ⌘I indents (⌘↩ is the editor's).
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !active) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.shiftKey && event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        runAll();
      } else if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "i") {
        event.preventDefault();
        event.stopPropagation();
        formatCurrent();
      }
    };
    root.addEventListener("keydown", onKey, true);
    return () => root.removeEventListener("keydown", onKey, true);
  });

  const shown = results[selected] ?? results[results.length - 1] ?? null;
  const shownText = shown !== null && shown.outcome.kind === "reply" ? shown.outcome.text : "";

  const statusChip = (outcome: Outcome) => {
    switch (outcome.kind) {
      case "pending":
        return (
          <span className="es-status pending">
            <Spinner size={10} />
          </span>
        );
      case "reply": {
        const tone = outcome.status >= 500 ? "err" : outcome.status >= 400 ? "warn" : outcome.status >= 200 && outcome.status < 300 ? "ok" : "info";
        return (
          <span className={`es-status ${tone}`}>
            {outcome.status}
            {STATUS_TEXT[outcome.status] ? ` ${STATUS_TEXT[outcome.status]}` : ""}
          </span>
        );
      }
      case "failed":
        return <span className="es-status err">{t("오류")}</span>;
      case "refused":
        return <span className="es-status err">{t("거절")}</span>;
      case "declined":
        return <span className="es-status info">{t("취소")}</span>;
      case "stopped":
        return <span className="es-status info">{t("멈춤")}</span>;
      case "syntax":
        return <span className="es-status err">{t("구문 오류")}</span>;
    }
  };

  const responseBody = useMemo(() => {
    if (shown === null) {
      return <div className="panel-empty es-console-hint">{t("요청을 실행하세요 (⌘↩)")}</div>;
    }
    const o = shown.outcome;
    switch (o.kind) {
      case "pending":
        return null;
      case "reply":
        if (o.text === "") {
          return <div className="panel-empty es-console-hint">{t("응답 본문이 없습니다")}</div>;
        }
        return o.json ? (
          <SearchEditor value={o.text} readOnly className="es-console-reply" ariaLabel={t("응답")} />
        ) : (
          <pre className="es-console-text mono" aria-label={t("응답")}>
            {o.text}
          </pre>
        );
      case "failed":
        return (
          <div className="es-console-notice">
            <ErrorNotice error={o.error} context="shell" engine="elasticsearch" />
          </div>
        );
      case "refused":
        return (
          <div className="es-console-notice">
            <ErrorNotice error={t("읽기 전용 연결이라 {cls} 요청은 보내지 않았습니다", { cls: t(CLASS_LABEL[o.cls]) })} context="shell" engine="elasticsearch" />
          </div>
        );
      case "declined":
        return <div className="panel-empty es-console-hint">{t("실행을 취소했습니다")}</div>;
      case "stopped":
        return (
          <div className="es-console-stopped">
            <p className="panel-dim">{t("멈췄습니다")}</p>
            <ServerTasks host={host} report={o.report ?? null} />
          </div>
        );
      case "syntax": {
        const where = t("{line}행 {col}열", { line: o.line, col: o.column });
        return (
          <div className="es-console-notice mg-syntax-error">
            <ErrorNotice error={{ code: "parse_error", message: o.message, position: { line: o.line, column: o.column } }} context="shell" engine="elasticsearch" />
            <pre className="mg-error-at" aria-label={where}>
              <span className="mg-error-where">{where}</span>
              {`\n${o.lineText}\n${" ".repeat(Math.max(0, o.column - 1))}^`}
            </pre>
          </div>
        );
      }
    }
  }, [shown, host]);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const rect = root.getBoundingClientRect();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      const at = narrow ? (e.clientY - rect.top) / rect.height : (e.clientX - rect.left) / rect.width;
      setRatio(Math.min(0.85, Math.max(0.15, at)));
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  const runningIndex = running ? results.length : 0;

  return (
    <div className={`mg-root es-console${narrow ? " narrow" : ""}`} ref={rootRef}>
      <div className="es-console-editor" style={{ flexBasis: `${ratio * 100}%` }}>
        <div className="es-console-code">
          <SearchEditor
            ref={editorRef}
            value={initialText}
            onChange={onEditorChange}
            onRun={runCurrent}
            complete={complete}
            spans={consoleSpans}
            lineClass={lineClass}
            error={errorRange}
            placeholder="GET /_search"
            ariaLabel={t("Dev Tools 콘솔 편집기")}
          />
        </div>
        <div className="editor-bar">
          <span className="es-console-count">{t("요청 {count}개", { count: requestCount })}</span>
          <span className="spacer" />
          <div className="editor-actions">
            <div className="mg-pop-anchor" ref={historyOpen ? historyRef : undefined}>
              <button
                type="button"
                className={historyOpen ? "active" : undefined}
                title={t("최근 실행한 요청")}
                aria-expanded={historyOpen}
                onClick={(event) => {
                  event.stopPropagation();
                  setHistory(readHistory(connKey));
                  setHistoryOpen(!historyOpen);
                }}
              >
                <HistoryIcon size={11} />
                {t("기록")}
              </button>
              {historyOpen ? (
                <div className="menu-panel mg-popover mg-hist-pop es-console-hist" onClick={(event) => event.stopPropagation()}>
                  <div className="mg-hist-head">
                    <span>{t("최근 실행")}</span>
                    <span className="panel-dim">{t("{count}개", { count: history.length })}</span>
                    <span className="spacer" />
                    {history.length > 0 ? (
                      <button
                        type="button"
                        className="es-console-hist-clear"
                        onClick={() => {
                          writeHistory(connKey, []);
                          setHistory([]);
                        }}
                      >
                        {t("기록 지우기")}
                      </button>
                    ) : null}
                  </div>
                  {history.length === 0 ? (
                    <div className="mg-hist-empty">{t("요청을 실행하면 여기에 쌓입니다")}</div>
                  ) : (
                    history.map((entry, i) => (
                      <div
                        key={i}
                        className="mg-hist-item es-console-hist-item"
                        role="button"
                        tabIndex={0}
                        title={entry.text}
                        onClick={() => insertHistory(entry)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            insertHistory(entry);
                          }
                        }}
                      >
                        <div className="mg-hist-text mono">
                          <ConsoleText text={entry.text.split("\n")[0]} />
                        </div>
                        <div className="mg-hist-meta">
                          {stamp(entry.at)}
                          {entry.status !== null ? ` · ${entry.status}` : ""}
                          {entry.text.includes("\n") ? ` · ${t("본문 {count}줄", { count: entry.text.split("\n").length - 1 })}` : ""}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              ) : null}
            </div>
            <button type="button" title={t("커서의 요청을 cURL 명령으로 복사 ($ES_URL)")} onClick={() => void copyCurl()}>
              <CopyIcon size={11} />
              {t("cURL 복사")}
            </button>
            <button type="button" title={t("본문 정리 (⌘I)")} onClick={formatCurrent}>
              {t("정리")} <span className="split-hint">⌘I</span>
            </button>
            {running ? (
              <button type="button" onClick={stopRun}>
                {t("정지")}
              </button>
            ) : null}
            <button type="button" title={t("모든 요청을 차례로 실행 (⇧⌘↩)")} onClick={runAll} disabled={running}>
              {t("모두 실행")} <span className="split-hint">⇧⌘↩</span>
            </button>
            <button type="button" className="primary" title={t("커서의 요청 실행 (⌘↩)")} onClick={runCurrent} disabled={running}>
              <PlayIcon size={10} />
              {t("실행")} <span className="split-hint">⌘↩</span>
            </button>
          </div>
        </div>
      </div>
      <div className={narrow ? "h-splitter" : "v-splitter"} role="separator" aria-orientation={narrow ? "horizontal" : "vertical"} onPointerDown={startDrag} />
      <div className="es-console-response">
        {shown !== null ? (
          <div className="data-toolbar es-console-bar">
            <div className="footer-start es-console-head">
              {statusChip(shown.outcome)}
              {shown.outcome.kind === "reply" ? (
                <>
                  <span className="es-console-ms">{elapsedText(shown.outcome.elapsedMs)}</span>
                  <span className={`es-class ${shown.outcome.cls}`}>{t(CLASS_LABEL[shown.outcome.cls])}</span>
                </>
              ) : null}
              <span className="es-console-line mono" title={shown.line}>
                <ConsoleText text={shown.line} />
              </span>
            </div>
            <div className="footer-end">
              {shownText !== "" ? (
                <button type="button" className="footer-button" onClick={() => void copyResponse(shownText)}>
                  <CopyIcon size={11} />
                  {t("응답 복사")}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        {results.length > 1 ? (
          <ol className="es-console-runs" aria-label={t("실행한 요청")}>
            {results.map((r, i) => (
              <li key={i}>
                <button
                  type="button"
                  className={`es-console-run${i === selected ? " active" : ""}`}
                  aria-current={i === selected}
                  onClick={() => {
                    setSelected(i);
                    editorRef.current?.flash(r.from, r.to);
                  }}
                >
                  <span className="es-console-run-n">{i + 1}</span>
                  {statusChip(r.outcome)}
                  <span className="es-console-line mono">
                    <ConsoleText text={r.line} />
                  </span>
                  {r.outcome.kind === "reply" ? <span className="es-console-ms">{elapsedText(r.outcome.elapsedMs)}</span> : null}
                </button>
              </li>
            ))}
          </ol>
        ) : null}
        <div className="result-body es-console-body">
          {responseBody}
          {running ? (
            <div className="result-loading" role="status">
              <Spinner size={12} />
              {results.length > 1 ? t("실행 중… ({n}번째)", { n: runningIndex }) : t("실행 중…")}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
