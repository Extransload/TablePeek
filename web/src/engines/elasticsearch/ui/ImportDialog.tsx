// 가져오기: an NDJSON, JSON, `_bulk` (or dump) or CSV/TSV file (dropped,
// picked or pasted) into an index. The first 20 documents are previewed as
// they will go in; CSV columns get a type and dotted headers can make nested
// objects; a field can become `_id`. Documents go in through `_bulk` about
// 1,000 at a time (and under ~5 MB a request), the last request refreshing
// the index; refused documents are listed with their line, and the import
// either goes on past them or stops after the request that had them. A dump
// can make its index from the definition in its head first. 취소 stops
// after the request in flight.

import { useEffect, useMemo, useRef, useState } from "react";
import { writeClipboard } from "../../../clipboard";
import { Select } from "../../../components/Select";
import { Spinner } from "../../../components/Spinner";
import { SuggestInput } from "../../../components/SuggestInput";
import { formatBytes } from "../../../format";
import { t } from "../../../i18n";
import { stringifyJson } from "../../mongodb/bson";
import { AdminModal } from "../../mongodb/ui/AdminModal";
import { readCsvRows } from "../../mongodb/transfer";
import { bulk, createIndex, isAbort } from "../api";
import type { Json } from "../json";
import {
  CSV_TYPES,
  bulkEntry,
  csvDoc,
  guessColumnType,
  guessImport,
  indexNameProblem,
  readDumpHeader,
  readRecords,
  type BulkOptions,
  type CsvBlanks,
  type CsvColumn,
  type DumpHeader,
  type ImportFormat,
  type ImportRecord,
} from "../transfer";
import { needsConfirm, requestText } from "./common";
import { DialogFailure, ReadOnlyNote, RequestPreview, askFirst, nameTaken, targetNames, useTargets, type DialogProps } from "./IndexDialogs";

// Documents and text size per `_bulk` request. The size counts UTF-16 units,
// well under the servers' 100 MB request limit even for wide characters.
const BATCH_DOCS = 1000;
const BATCH_SIZE = 5_000_000;
const PREVIEW_ROWS = 20;
// Rows read to guess CSV column types.
const SAMPLE_ROWS = 1000;
// How much of the file the preview reads.
const PREVIEW_BYTES = 1 << 20;
// Failures kept for the list; the count goes on past it.
const FAILURES_KEPT = 100;
// Columns the preview table shows at most.
const PREVIEW_COLUMNS = 30;

const DELIMITERS: { value: string; label: string }[] = [
  { value: ",", label: "쉼표 ," },
  { value: "\t", label: "탭" },
  { value: ";", label: "세미콜론 ;" },
  { value: "|", label: "세로줄 |" },
];

interface Source {
  blob: Blob;
  // The file's name; "" for pasted text.
  name: string;
}

type Preview = { kind: "records"; records: ImportRecord[] } | { kind: "csv"; rows: { line: number; cells: string[] }[] } | { kind: "error"; error: unknown };

interface Failed {
  line: number;
  id: string;
  type: string;
  reason: string;
}

interface Progress {
  bytes: number;
  read: number;
  ok: number;
  failed: number;
  started: number;
  elapsed: number;
  // The index was made from the dump's definition.
  created: boolean;
  state: "running" | "done" | "stopped" | "cancelled" | "error";
  error: unknown;
}

// "Shop Orders 2024.csv" → "shop-orders-2024".
function indexNameOf(fileName: string): string {
  return (
    fileName
      .replace(/\.(dump|bulk)?\.?[^.]*$/i, "")
      .toLowerCase()
      .replace(/[\\/*?"<>| ,#:]+/g, "-")
      .replace(/^[-_+.]+|[-.]+$/g, "") || "imported"
  );
}

// Dotted paths of a document's leaves: objects open into their fields.
function leafPaths(doc: Record<string, unknown>, prefix: string, out: Set<string>): void {
  for (const [key, value] of Object.entries(doc)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      leafPaths(value as Record<string, unknown>, path, out);
    } else {
      out.add(path);
    }
  }
}

export function ImportDialog({ host, index, onEffect, onClose }: DialogProps & { index: string | null }) {
  const [source, setSource] = useState<Source | null>(null);
  const [pasted, setPasted] = useState("");
  const [dragging, setDragging] = useState(false);
  const [format, setFormat] = useState<ImportFormat>("json");
  const [delimiter, setDelimiter] = useState(",");
  const [dump, setDump] = useState<DumpHeader | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [columns, setColumns] = useState<CsvColumn[]>([]);
  const [nested, setNested] = useState(true);
  const [blanks, setBlanks] = useState<CsvBlanks>("omit");
  const [idField, setIdField] = useState("");
  const [dropIdField, setDropIdField] = useState(false);
  const [op, setOp] = useState<"index" | "create">("index");
  const [keepIndex, setKeepIndex] = useState(false);
  const [onError, setOnError] = useState<"skip" | "stop">("skip");
  const [makeIndex, setMakeIndex] = useState(true);
  const [target, setTarget] = useState(index ?? "");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [failures, setFailures] = useState<Failed[]>([]);
  const controllerRef = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const targets = useTargets(host.conn);
  const names = useMemo(() => targetNames(targets.data), [targets.data]);
  const running = progress?.state === "running";

  // Stops a running import when the dialog goes away.
  useEffect(() => () => controllerRef.current?.abort(), []);

  const choose = async (next: Source) => {
    const head = await next.blob.slice(0, 64 * 1024).text();
    const guess = guessImport(next.name, head);
    const header = guess.format === "csv" ? null : await readDumpHeader(next.blob).catch(() => null);
    setFormat(header !== null ? "bulk" : guess.format);
    setDelimiter(guess.delimiter);
    setDump(header);
    setSource(next);
    setProgress(null);
    setFailures([]);
    setIdField("");
    if (index === null) {
      setTarget((current) => current || (header !== null ? header.index : next.name !== "" ? indexNameOf(next.name) : ""));
    }
  };

  // The first records of the file, and for CSV the guessed column types.
  useEffect(() => {
    if (source === null) {
      setPreview(null);
      return;
    }
    const controller = new AbortController();
    const cut = source.blob.size > PREVIEW_BYTES;
    const head = source.blob.slice(0, PREVIEW_BYTES);
    (async (): Promise<Preview> => {
      if (format !== "csv") {
        const records: ImportRecord[] = [];
        for await (const record of readRecords(head, format, controller.signal)) {
          records.push(record);
          if (records.length >= PREVIEW_ROWS) {
            break;
          }
        }
        // The slice may end inside a value.
        if (cut && records.length < PREVIEW_ROWS && records.at(-1)?.error !== null) {
          records.pop();
        }
        return { kind: "records", records };
      }
      const rows: { line: number; cells: string[] }[] = [];
      for await (const row of readCsvRows(head, delimiter, controller.signal)) {
        rows.push({ line: row.line, cells: row.cells });
        if (rows.length > SAMPLE_ROWS) {
          break;
        }
      }
      if (cut && rows.length <= SAMPLE_ROWS) {
        rows.pop();
      }
      const header = (rows.shift()?.cells ?? []).map((name) => name.trim());
      setColumns(header.map((name, i) => ({ name, type: guessColumnType(rows.map((r) => r.cells[i] ?? "")) })));
      return { kind: "csv", rows };
    })().then(
      (next) => {
        if (!controller.signal.aborted) {
          setPreview(next);
        }
      },
      (error: unknown) => {
        if (!isAbort(error)) {
          setPreview({ kind: "error", error });
        }
      },
    );
    return () => controller.abort();
  }, [source, format, delimiter]);

  const csvOptions = useMemo(() => ({ nested, blanks }), [nested, blanks]);
  const options = useMemo((): BulkOptions => ({ op, idField, dropIdField, keepIndex }), [op, idField, dropIdField, keepIndex]);

  // The first records as they will go in.
  const previewRecords = useMemo((): ImportRecord[] => {
    if (preview === null || preview.kind === "error") {
      return [];
    }
    if (preview.kind === "records") {
      return preview.records;
    }
    return preview.rows.slice(0, PREVIEW_ROWS).map(({ line, cells }) => {
      try {
        return { line, bytes: 0, op: null, meta: {}, doc: csvDoc(columns, cells, csvOptions), text: null, error: null };
      } catch (error) {
        return { line, bytes: 0, op: null, meta: {}, doc: null, text: null, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }, [preview, columns, csvOptions]);

  const previewRows = useMemo(
    () =>
      previewRecords.map((record) => {
        if (record.error !== null) {
          return { record, id: "", error: record.error };
        }
        try {
          return { record, id: bulkEntry(record, options).id, error: null };
        } catch (error) {
          return { record, id: "", error: error instanceof Error ? error.message : String(error) };
        }
      }),
    [previewRecords, options],
  );

  // Fields the `_id` can come from, and the preview table's columns.
  const paths = useMemo(() => {
    const leaves = new Set<string>();
    const top = new Set<string>();
    for (const record of previewRecords) {
      if (record.doc !== null) {
        leafPaths(record.doc, "", leaves);
        for (const key of Object.keys(record.doc)) {
          top.add(key);
        }
      }
    }
    return { leaves: [...leaves], top: [...top].slice(0, PREVIEW_COLUMNS) };
  }, [previewRecords]);
  const hasOps = previewRecords.some((r) => r.op !== null);

  const targetName = target.trim();
  const targetExists = nameTaken(targets.data, targetName);
  const fromDump = dump !== null && dump.definition !== null && makeIndex && !targetExists && targets.data !== null;
  const bareBulk = format === "bulk" && keepIndex && targetName === "";
  const problem =
    source === null
      ? t("파일을 고르거나 끌어다 놓으세요")
      : preview?.kind === "error"
        ? t("파일을 읽을 수 없습니다")
        : format === "csv" && columns.every((c) => c.type === "skip" || c.name === "")
          ? t("가져올 컬럼이 없습니다")
          : bareBulk
            ? null
            : targetName === ""
              ? t("대상 인덱스를 쓰세요")
              : targetExists
                ? null
                : indexNameProblem(targetName);

  const sample = previewRows
    .filter((row) => row.error === null)
    .slice(0, 2)
    .map((row) => bulkEntry(row.record, options).text)
    .join("");
  const bulkPath = bareBulk ? "/_bulk" : `/${targetName || "…"}/_bulk`;
  const command = [fromDump && dump?.definition ? requestText("PUT", `/${targetName}`, dump.definition as Json) : null, requestText("POST", bulkPath, `${sample}… ${t("({count}건씩)", { count: BATCH_DOCS.toLocaleString() })}`)].filter((x) => x !== null).join("\n\n");

  const run = async () => {
    if (source === null || problem !== null || running || host.readOnly) {
      return;
    }
    const definition = fromDump ? (dump?.definition ?? null) : null;
    const asked = await askFirst(host, "write", {
      title: t("가져오기"),
      message: definition !== null ? t("{index} 인덱스를 덤프의 정의로 만들고 문서를 넣습니다.", { index: targetName }) : t("{file}의 문서를 {index}에 넣습니다.", { file: source.name || t("붙여 넣은 텍스트"), index: targetName || "_bulk" }),
      command,
      okLabel: t("가져오기"),
    });
    if (!asked) {
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    const signal = controller.signal;
    const kept: Failed[] = [];
    const state: Progress = { bytes: 0, read: 0, ok: 0, failed: 0, started: performance.now(), elapsed: 0, created: false, state: "running", error: null };
    const keep = (failure: Failed) => {
      if (kept.length < FAILURES_KEPT) {
        kept.push(failure);
      }
    };
    const show = () => {
      state.elapsed = performance.now() - state.started;
      setProgress({ ...state });
      setFailures(kept.slice());
    };
    setFailures([]);
    show();
    let parts: string[] = [];
    let entries: { line: number; id: string }[] = [];
    let size = 0;
    let deletes = false;
    // `delete` actions were allowed (asked once under safe mode).
    let deletesAllowed = false;
    // Sends the batch; true when the import must stop.
    const send = async (refresh: boolean): Promise<boolean> => {
      if (parts.length === 0) {
        return false;
      }
      if (deletes && !deletesAllowed) {
        const ok =
          !needsConfirm("danger", host.safeMode) ||
          (await host.confirm({ title: t("문서 삭제"), message: t("파일에 delete 동작이 있습니다. 대상 인덱스의 문서를 지웁니다."), command: requestText("POST", bulkPath, `${parts.slice(0, 3).join("")}…`), okLabel: t("계속") }));
        if (!ok) {
          controller.abort();
          signal.throwIfAborted();
        }
        deletesAllowed = true;
      }
      const reply = await bulk(host.conn, parts.join(""), { index: bareBulk ? undefined : targetName, refresh, confirmed: deletes }, signal);
      state.ok += reply.count - reply.failed;
      state.failed += reply.failed;
      for (const f of reply.failures) {
        const at = entries[f.position];
        keep({ line: at?.line ?? 0, id: f.id || at?.id || "", type: f.type || (f.status !== null ? String(f.status) : ""), reason: f.reason });
      }
      parts = [];
      entries = [];
      size = 0;
      deletes = false;
      show();
      return onError === "stop" && reply.failed > 0;
    };
    const records = async function* (): AsyncGenerator<ImportRecord> {
      if (format !== "csv") {
        yield* readRecords(source.blob, format, signal);
        return;
      }
      let header = true;
      for await (const row of readCsvRows(source.blob, delimiter, signal)) {
        if (header) {
          header = false;
          continue;
        }
        try {
          yield { line: row.line, bytes: row.bytes, op: null, meta: {}, doc: csvDoc(columns, row.cells, csvOptions), text: null, error: null };
        } catch (error) {
          yield { line: row.line, bytes: row.bytes, op: null, meta: {}, doc: null, text: null, error: error instanceof Error ? error.message : String(error) };
        }
      }
    };
    let stop = false;
    try {
      if (definition !== null) {
        await createIndex(host.conn, targetName, definition as Json);
        state.created = true;
        show();
      }
      for await (const record of records()) {
        state.read++;
        state.bytes = record.bytes;
        let entry: { text: string; id: string } | null = null;
        let reason = record.error;
        if (reason === null) {
          try {
            entry = bulkEntry(record, options);
          } catch (error) {
            reason = error instanceof Error ? error.message : String(error);
          }
        }
        if (entry === null) {
          state.failed++;
          keep({ line: record.line, id: typeof record.meta._id === "string" ? record.meta._id : "", type: t("읽기"), reason: reason ?? "" });
          if (onError === "stop") {
            stop = true;
            break;
          }
          continue;
        }
        if (parts.length > 0 && (parts.length >= BATCH_DOCS || size + entry.text.length > BATCH_SIZE) && (await send(false))) {
          stop = true;
          break;
        }
        parts.push(entry.text);
        entries.push({ line: record.line, id: entry.id });
        size += entry.text.length;
        deletes ||= record.op === "delete";
        if (state.read % 500 === 0) {
          show();
        }
      }
      // Under 멈추기, what came before the bad record still goes in.
      if ((await send(true)) || stop) {
        state.state = "stopped";
      } else {
        state.state = "done";
        state.bytes = source.blob.size;
      }
    } catch (error) {
      if (isAbort(error) || signal.aborted) {
        state.state = "cancelled";
      } else {
        state.state = "error";
        state.error = error;
      }
    }
    controllerRef.current = null;
    show();
    if (state.ok > 0 || state.created) {
      onEffect({ kind: "changed" });
    }
    if (state.state === "done" || state.state === "stopped") {
      host.notify(t("{index}에 문서 {count}개를 가져왔습니다", { index: targetName || "_bulk", count: state.ok.toLocaleString() }));
    }
  };

  const total = source?.blob.size ?? 0;
  const percent = progress === null || total === 0 ? 0 : Math.min(100, Math.round((progress.bytes / total) * 100));
  const rate = progress !== null && progress.elapsed > 0 ? Math.round(((progress.ok + progress.failed) * 1000) / progress.elapsed) : null;
  const finished = progress !== null && !running;

  return (
    <AdminModal
      title={t("가져오기")}
      path={index ?? undefined}
      className="mg-import-modal"
      busy={running}
      onClose={onClose}
      foot={
        <>
          {source !== null ? (
            <span className="panel-dim">
              {source.name || t("붙여 넣은 텍스트")} · {formatBytes(source.blob.size)}
            </span>
          ) : null}
          <span className="spacer" />
          {running ? (
            <button type="button" onClick={() => controllerRef.current?.abort()}>
              {t("취소")}
            </button>
          ) : (
            <button type="button" onClick={onClose}>
              {finished ? t("닫기") : t("취소")}
            </button>
          )}
          {finished ? null : (
            <button type="button" className="primary" disabled={running || problem !== null || host.readOnly} onClick={() => void run()}>
              {running ? <Spinner size={10} /> : null}
              {t("가져오기 (_bulk)")}
            </button>
          )}
        </>
      }
    >
      {host.readOnly ? <ReadOnlyNote /> : null}
      <div
        className={`es-drop${dragging ? " over" : ""}`}
        onDragOver={(event) => {
          if (!running && event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files[0];
          if (!running && file !== undefined) {
            setPasted("");
            void choose({ blob: file, name: file.name });
          }
        }}
      >
        <input
          ref={fileInput}
          type="file"
          hidden
          accept=".json,.ndjson,.jsonl,.bulk,.csv,.tsv,.txt,application/json,application/x-ndjson,text/csv"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file !== undefined) {
              setPasted("");
              void choose({ blob: file, name: file.name });
            }
          }}
        />
        <button type="button" className="mg-qbtn" disabled={running} onClick={() => fileInput.current?.click()}>
          {t("파일 고르기…")}
        </button>
        <span className="panel-dim">{t("또는 여기에 끌어다 놓으세요 — NDJSON · JSON · _bulk · 덤프 · CSV/TSV")}</span>
      </div>
      {source === null || source.name === "" ? (
        <textarea
          className="mg-input mono mg-import-paste"
          placeholder={t("또는 여기에 붙여 넣으세요 — [ { … } ] · 한 줄에 문서 하나 · CSV (첫 줄은 필드 이름)")}
          spellCheck={false}
          disabled={running}
          value={pasted}
          onChange={(event) => {
            setPasted(event.target.value);
            if (event.target.value.trim() === "") {
              setSource(null);
            } else {
              void choose({ blob: new Blob([event.target.value]), name: "" });
            }
          }}
        />
      ) : null}
      {source !== null ? (
        <div className="mg-form-grid">
          <label className="mg-form-row">
            <span className="mg-form-label">{targetName === "" ? t("대상 인덱스") : targetExists ? t("대상 인덱스 (있는 인덱스에 더합니다)") : fromDump ? t("대상 인덱스 (덤프의 정의로 만듭니다)") : t("대상 인덱스 (없으면 동적 매핑으로 만들어집니다)")}</span>
            <SuggestInput type="text" className="mg-input mono" suggestions={names} spellCheck={false} disabled={running || index !== null} value={target} onChange={(event) => setTarget(event.target.value)} />
          </label>
          <label className="mg-form-row">
            <span className="mg-form-label">{t("형식")}</span>
            <Select className="mg-input" disabled={running} value={format} onChange={(event) => setFormat(event.target.value as ImportFormat)}>
              <option value="json">{t("문서 — JSON 배열 · NDJSON · 검색 결과 · 내보낸 줄")}</option>
              <option value="bulk">{t("_bulk (동작 줄 + 문서 줄) · 덤프")}</option>
              <option value="csv">CSV / TSV</option>
            </Select>
          </label>
          {format === "csv" ? (
            <label className="mg-form-row">
              <span className="mg-form-label">{t("구분자")}</span>
              <Select className="mg-input" disabled={running} value={delimiter} onChange={(event) => setDelimiter(event.target.value)}>
                {DELIMITERS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {t(d.label)}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          {format !== "bulk" ? (
            <label className="mg-form-row">
              <span className="mg-form-label">_id</span>
              <Select className="mg-input" disabled={running} value={idField} onChange={(event) => setIdField(event.target.value)}>
                <option value="">{t("파일의 _id, 없으면 자동")}</option>
                {(format === "csv" ? columns.filter((c) => c.type !== "skip" && c.name !== "").map((c) => c.name) : paths.leaves).map((path) => (
                  <option key={path} value={path}>
                    {t("필드 {field}", { field: path })}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          {format !== "bulk" ? (
            <label className="mg-form-row">
              <span className="mg-form-label">{t("동작")}</span>
              <Select className="mg-input" disabled={running} value={op} onChange={(event) => setOp(event.target.value as "index" | "create")}>
                <option value="index">{t("index — 같은 _id가 있으면 덮어쓰기")}</option>
                <option value="create">{t("create — 같은 _id가 있으면 실패로 남기기")}</option>
              </Select>
            </label>
          ) : null}
        </div>
      ) : null}
      {source !== null ? (
        <div className="mg-checks">
          {format !== "bulk" && idField !== "" ? (
            <label>
              <input type="checkbox" checked={dropIdField} disabled={running} onChange={(event) => setDropIdField(event.target.checked)} />
              {t("_id로 쓴 필드는 문서에서 빼기")}
            </label>
          ) : null}
          {format === "bulk" ? (
            <label title={t("끄면 모든 문서가 대상 인덱스로 갑니다")}>
              <input type="checkbox" checked={keepIndex} disabled={running} onChange={(event) => setKeepIndex(event.target.checked)} />
              {t("동작 줄의 _index 따르기")}
            </label>
          ) : null}
          {format === "csv" ? (
            <>
              <label>
                <input type="checkbox" checked={nested} disabled={running} onChange={(event) => setNested(event.target.checked)} />
                {t("점 경로(a.b)로 중첩 필드 만들기")}
              </label>
              <label>
                {t("빈 칸")}
                <Select className="mg-input" disabled={running} value={blanks} onChange={(event) => setBlanks(event.target.value as CsvBlanks)}>
                  <option value="omit">{t("필드를 만들지 않음")}</option>
                  <option value="empty">{t("빈 문자열 (타입이 있으면 null)")}</option>
                  <option value="null">null</option>
                </Select>
              </label>
            </>
          ) : null}
        </div>
      ) : null}
      {dump !== null ? (
        <div className="es-admin-note">
          {dump.error !== null
            ? t("덤프 머리의 인덱스 정의를 읽을 수 없습니다: {message}", { message: dump.error })
            : t("덤프 파일입니다 — 원래 인덱스 {index}.", { index: dump.index })}
          {dump.definition !== null && !targetExists && targetName !== "" ? (
            <label className="es-inline-check">
              <input type="checkbox" checked={makeIndex} disabled={running} onChange={(event) => setMakeIndex(event.target.checked)} />
              {t("{index}가 없으니 덤프의 정의(설정·매핑)로 먼저 만들기", { index: targetName })}
            </label>
          ) : null}
        </div>
      ) : null}
      {format === "csv" && columns.length > 0 ? (
        <>
          <div className="mg-form-label">{t("컬럼 타입")}</div>
          <div className="es-csv-columns">
            {columns.map((column, i) => (
              <label key={i} className={column.type === "skip" ? "mg-import-skip" : undefined}>
                <span className="mono mg-import-colname">{column.name || t("(이름 없음)")}</span>
                <Select
                  className="mg-input"
                  aria-label={t("{name}의 타입", { name: column.name })}
                  disabled={running}
                  value={column.type}
                  onChange={(event) => setColumns((all) => all.map((c, j) => (j === i ? { ...c, type: event.target.value as CsvColumn["type"] } : c)))}
                >
                  {CSV_TYPES.map((type) => (
                    <option key={type.value} value={type.value}>
                      {t(type.label)}
                    </option>
                  ))}
                </Select>
              </label>
            ))}
          </div>
        </>
      ) : null}
      {preview?.kind === "error" ? <DialogFailure error={preview.error} context="import" /> : null}
      {previewRows.length > 0 ? (
        <>
          <div className="mg-form-label">{t("미리보기 (앞 {count}건)", { count: previewRows.length })}</div>
          <div className="mg-import-table-wrap">
            <table className="panel-table es-import-table">
              <thead>
                <tr>
                  <th className="num">{t("줄")}</th>
                  {hasOps ? <th>{t("동작")}</th> : null}
                  <th>_id</th>
                  {paths.top.map((key) => (
                    <th key={key} className="mono">
                      {key}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewRows.map(({ record, id, error }, r) => (
                  <tr key={r} className={error !== null ? "bad" : undefined}>
                    <td className="num mono">{record.line}</td>
                    {hasOps ? <td className="mono">{record.op ?? ""}</td> : null}
                    {error !== null ? (
                      <td className="mg-danger-text" colSpan={paths.top.length + 1}>
                        {error}
                      </td>
                    ) : (
                      <>
                        <td className="mono">{id || <span className="panel-dim">{t("자동")}</span>}</td>
                        {paths.top.map((key) => {
                          // Strings as they are, the rest as JSON.
                          const value = record.doc?.[key];
                          return (
                            <td key={key} className="mono">
                              {value === undefined ? "" : typeof value === "string" ? value : stringifyJson(value)}
                            </td>
                          );
                        })}
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      {source !== null ? (
        <div className="mg-checks" role="radiogroup" aria-label={t("오류가 나면")}>
          <span className="mg-form-label">{t("오류가 나면")}</span>
          <label>
            <input type="radio" name="es-import-onerror" checked={onError === "skip"} disabled={running} onChange={() => setOnError("skip")} />
            {t("건너뛰고 계속")}
          </label>
          <label>
            <input type="radio" name="es-import-onerror" checked={onError === "stop"} disabled={running} onChange={() => setOnError("stop")} />
            {t("멈추기 (그 앞까지는 들어갑니다)")}
          </label>
        </div>
      ) : null}
      {progress === null ? <RequestPreview text={command} problem={problem} /> : null}
      {progress !== null ? (
        <div className="mg-transfer-progress" role="status">
          <div className="job-bar">
            <div className={`job-bar-fill${progress.state === "error" ? " error" : progress.state === "cancelled" ? " cancelled" : ""}`} style={{ width: `${percent}%` }} />
          </div>
          <div className="mg-transfer-stats">
            <span>{t("읽음 {count}", { count: progress.read.toLocaleString() })}</span>
            <span>{t("들어감 {count}", { count: progress.ok.toLocaleString() })}</span>
            <span className={progress.failed > 0 ? "mg-danger-text" : undefined}>{t("실패 {count}", { count: progress.failed.toLocaleString() })}</span>
            {rate !== null ? <span className="panel-dim">{t("초당 {count}건", { count: rate.toLocaleString() })}</span> : null}
            <span className="spacer" />
            <span className="panel-dim">
              {progress.state === "running"
                ? `${percent}%`
                : progress.state === "done"
                  ? t("끝났습니다")
                  : progress.state === "stopped"
                    ? t("오류로 멈췄습니다")
                    : progress.state === "cancelled"
                      ? t("취소했습니다 — 보내던 묶음은 들어갔을 수 있습니다")
                      : t("실패했습니다")}
            </span>
          </div>
          {progress.created ? <span className="panel-dim">{t("{index} 인덱스를 덤프의 정의로 만들었습니다", { index: targetName })}</span> : null}
          <DialogFailure error={progress.error} context="import" />
        </div>
      ) : null}
      {failures.length > 0 ? (
        <>
          <div className="mg-import-failhead">
            <span className="mg-form-label">{progress !== null && progress.failed > failures.length ? t("실패 목록 (앞 {shown}건 / {count}건)", { shown: failures.length, count: progress.failed.toLocaleString() }) : t("실패 목록")}</span>
            <span className="spacer" />
            <button type="button" className="mg-qbtn" onClick={() => void writeClipboard(failures.map((f) => `${f.line}\t${f.id}\t${f.type}\t${f.reason}`).join("\n"), host.notify).then(() => host.notify(t("실패 목록을 복사했습니다")))}>
              {t("복사")}
            </button>
          </div>
          <div className="mg-import-preview mono mg-import-failures">
            {failures.map((f, i) => (
              <div key={i} className="mg-import-line bad">
                <span className="mg-import-ln">{f.line}</span>
                {f.id !== "" ? <span className="es-fail-id">{f.id}</span> : null}
                <span className="mg-import-text">
                  {f.type !== "" ? `${f.type}: ` : ""}
                  {f.reason}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </AdminModal>
  );
}
