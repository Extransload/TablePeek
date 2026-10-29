// 가져오기 (MONGODB.md §6.2): a JSON array, NDJSON, Extended JSON or
// CSV/TSV file (or pasted text) into a collection. The first 20 records are
// previewed; for CSV each column gets a type (guessed from the first rows,
// changeable) and dotted headers can make nested fields. Documents go in
// 1,000 per `insert`; on a bad record or a refused document the import
// either stops (what came before stays in) or skips it and goes on with
// `ordered: false`, listing every failure with its line. The file streams
// through, so its size is not bounded by memory; progress follows the bytes
// read, and 취소 stops after the batch in flight.

import { useEffect, useMemo, useRef, useState } from "react";
import { writeClipboard } from "../../../clipboard";
import { Select } from "../../../components/Select";
import { Spinner } from "../../../components/Spinner";
import { SuggestInput } from "../../../components/SuggestInput";
import { formatBytes } from "../../../format";
import { t } from "../../../i18n";
import { insertMany, isAbort, listCollections } from "../api";
import type { BsonDocument } from "../bson";
import { toShell } from "../format";
import { CSV_TYPES, csvDoc, guessColumnType, guessFormat, readCsvRows, readJsonDocs, type CsvBlanks, type CsvColumn, type ImportFormat, type ImportItem } from "../transfer";
import { AdminModal, CommandPreview, Failure, collectionNameProblem, errorText, shellNamespace } from "./AdminModal";

interface ImportModalProps {
  conn: string;
  db: string;
  // Null: the dialog asks for the collection (an existing one or a new name).
  coll: string | null;
  notify(message: string): void;
  // After documents went in (some or all), with the collection's name.
  onImported(coll: string): void;
  onClose(): void;
}

const BATCH = 1000;
const PREVIEW_ROWS = 20;
// Rows read to guess CSV column types.
const SAMPLE_ROWS = 1000;
// How much of the file the preview reads.
const PREVIEW_BYTES = 1 << 20;
// Failures kept for the list; the count goes on past it.
const FAILURES_KEPT = 1000;

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

type Preview =
  | { kind: "json"; items: ImportItem[] }
  | { kind: "csv"; header: string[]; rows: { line: number; cells: string[] }[] }
  | { kind: "error"; message: string };

interface Failed {
  line: number;
  message: string;
}

interface Progress {
  bytes: number;
  read: number;
  inserted: number;
  failed: number;
  state: "running" | "done" | "stopped" | "cancelled" | "error";
  message: string | null;
}

// "people 2024.csv" → "people_2024".
function collectionOf(fileName: string): string {
  return fileName.replace(/\.[^.]*$/, "").replace(/[^\w.-]+/g, "_").replace(/^[._]+|[._]+$/g, "") || "imported";
}

export function ImportModal({ conn, db, coll, notify, onImported, onClose }: ImportModalProps) {
  const [source, setSource] = useState<Source | null>(null);
  const [pasted, setPasted] = useState("");
  const [format, setFormat] = useState<ImportFormat>("json");
  const [delimiter, setDelimiter] = useState(",");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [columns, setColumns] = useState<CsvColumn[]>([]);
  const [nested, setNested] = useState(true);
  const [blanks, setBlanks] = useState<CsvBlanks>("omit");
  const [onError, setOnError] = useState<"skip" | "stop">("skip");
  const [target, setTarget] = useState(coll ?? "");
  const [existing, setExisting] = useState<string[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [failures, setFailures] = useState<Failed[]>([]);
  const controllerRef = useRef<AbortController | null>(null);
  const running = progress?.state === "running";

  useEffect(() => {
    if (coll !== null) {
      return;
    }
    const controller = new AbortController();
    listCollections(conn, db, controller.signal).then(
      (list) => setExisting(list.filter((c) => c.type !== "view" && !c.name.startsWith("system.")).map((c) => c.name)),
      () => setExisting([]),
    );
    return () => controller.abort();
  }, [conn, db, coll]);

  // Stops a running import when the dialog goes away.
  useEffect(() => () => controllerRef.current?.abort(), []);

  const choose = async (next: Source) => {
    const head = await next.blob.slice(0, 64 * 1024).text();
    const guess = guessFormat(next.name, head);
    setFormat(guess.format);
    setDelimiter(guess.delimiter);
    setSource(next);
    setProgress(null);
    setFailures([]);
    if (coll === null && next.name !== "") {
      setTarget((current) => current || collectionOf(next.name));
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
    (async () => {
      if (format === "json") {
        const items: ImportItem[] = [];
        for await (const item of readJsonDocs(head, controller.signal)) {
          items.push(item);
          if (items.length >= PREVIEW_ROWS) {
            break;
          }
        }
        // The slice may end inside a document.
        if (cut && items.length < PREVIEW_ROWS && items.at(-1)?.error !== null) {
          items.pop();
        }
        return { kind: "json" as const, items };
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
      return { kind: "csv" as const, header, rows };
    })().then(
      (next) => {
        if (!controller.signal.aborted) {
          setPreview(next);
        }
      },
      (error: unknown) => {
        if (!isAbort(error)) {
          setPreview({ kind: "error", message: errorText(error) });
        }
      },
    );
    return () => controller.abort();
  }, [source, format, delimiter]);

  const csvOptions = useMemo(() => ({ nested, blanks }), [nested, blanks]);

  // The first documents as they will be inserted.
  const previewDocs = useMemo((): { line: number; doc: BsonDocument | null; error: string | null }[] => {
    if (preview === null || preview.kind === "error") {
      return [];
    }
    if (preview.kind === "json") {
      return preview.items;
    }
    return preview.rows.slice(0, PREVIEW_ROWS).map(({ line, cells }) => {
      try {
        return { line, doc: csvDoc(columns, cells, csvOptions), error: null };
      } catch (error) {
        return { line, doc: null, error: errorText(error) };
      }
    });
  }, [preview, columns, csvOptions]);

  const targetName = target.trim();
  const problem =
    source === null
      ? t("파일을 고르거나 붙여 넣으세요")
      : preview?.kind === "error"
        ? preview.message
        : format === "csv" && columns.every((c) => c.type === "skip" || c.name === "")
          ? t("가져올 컬럼이 없습니다")
          : collectionNameProblem(targetName);
  const command = `${shellNamespace(db, targetName || "…")}.insertMany([ /* ${t("{count}건씩", { count: BATCH.toLocaleString() })} */ ]${onError === "skip" ? ", { ordered: false }" : ""})`;

  const run = async () => {
    if (source === null || problem !== null || running) {
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    const signal = controller.signal;
    const ns = { conn, db, coll: targetName };
    const kept: Failed[] = [];
    const state: Progress = { bytes: 0, read: 0, inserted: 0, failed: 0, state: "running", message: null };
    const fail = (line: number, message: string) => {
      state.failed++;
      if (kept.length < FAILURES_KEPT) {
        kept.push({ line, message });
      }
    };
    const show = () => {
      setProgress({ ...state });
      setFailures(kept.slice());
    };
    setFailures([]);
    show();
    let batch: BsonDocument[] = [];
    let lines: number[] = [];
    let stop = false;
    // Sends the batch; true when the import must stop.
    const flush = async (): Promise<boolean> => {
      if (batch.length === 0) {
        return false;
      }
      const ordered = onError === "stop";
      const r = await insertMany(ns, batch, ordered, signal);
      const firstFailure = r.errors[0];
      state.inserted += ordered ? (firstFailure !== undefined ? firstFailure.index : batch.length) : batch.length - r.errors.length;
      for (const e of r.errors) {
        fail(lines[e.index] ?? 0, `${e.code}: ${e.message}`);
      }
      batch = [];
      lines = [];
      show();
      return ordered && firstFailure !== undefined;
    };
    const records = async function* (): AsyncGenerator<ImportItem> {
      if (format === "json") {
        yield* readJsonDocs(source.blob, signal);
        return;
      }
      let header = true;
      for await (const row of readCsvRows(source.blob, delimiter, signal)) {
        if (header) {
          header = false;
          continue;
        }
        try {
          yield { line: row.line, doc: csvDoc(columns, row.cells, csvOptions), error: null, bytes: row.bytes };
        } catch (error) {
          yield { line: row.line, doc: null, error: errorText(error), bytes: row.bytes };
        }
      }
    };
    try {
      for await (const item of records()) {
        state.read++;
        state.bytes = item.bytes;
        if (item.doc === null) {
          fail(item.line, item.error ?? "");
          if (onError === "stop") {
            stop = true;
            break;
          }
          continue;
        }
        batch.push(item.doc);
        lines.push(item.line);
        if (batch.length >= BATCH && (await flush())) {
          stop = true;
          break;
        }
      }
      // Under 멈추기, what came before the bad record still goes in.
      if ((await flush()) || stop) {
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
        state.message = errorText(error);
      }
    }
    controllerRef.current = null;
    show();
    if (state.inserted > 0) {
      onImported(targetName);
    }
    notify(t("{coll}에 문서 {count}개를 가져왔습니다", { coll: targetName, count: state.inserted.toLocaleString() }));
  };

  const fileInput = useRef<HTMLInputElement | null>(null);
  const total = source?.blob.size ?? 0;
  const percent = progress === null || total === 0 ? 0 : Math.min(100, Math.round((progress.bytes / total) * 100));
  const finished = progress !== null && !running;

  return (
    <AdminModal
      title={t("가져오기")}
      path={coll !== null ? `${db}.${coll}` : db}
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
            <button type="button" className="primary" disabled={running || problem !== null} onClick={() => void run()}>
              {running ? <Spinner size={10} /> : null}
              {t("가져오기 (insertMany)")}
            </button>
          )}
        </>
      }
    >
      <div className="mg-import-source">
        <input
          ref={fileInput}
          type="file"
          hidden
          accept=".json,.ndjson,.jsonl,.csv,.tsv,.txt,application/json,text/csv"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) {
              setPasted("");
              void choose({ blob: file, name: file.name });
            }
          }}
        />
        <button type="button" className="mg-qbtn" disabled={running} onClick={() => fileInput.current?.click()}>
          {t("파일 고르기…")}
        </button>
        <span className="panel-dim">{t("JSON 배열 · NDJSON · Extended JSON · CSV/TSV")}</span>
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
          {coll === null ? (
            <label className="mg-form-row">
              <span className="mg-form-label">{existing.includes(targetName) ? t("컬렉션 (있는 컬렉션에 더합니다)") : t("컬렉션 (없으면 새로 만듭니다)")}</span>
              <SuggestInput type="text" className="mg-input mono" suggestions={existing} spellCheck={false} disabled={running} value={target} onChange={(event) => setTarget(event.target.value)} />
            </label>
          ) : null}
          <label className="mg-form-row">
            <span className="mg-form-label">{t("형식")}</span>
            <Select className="mg-input" disabled={running} value={format} onChange={(event) => setFormat(event.target.value as ImportFormat)}>
              <option value="json">{t("JSON · NDJSON · Extended JSON")}</option>
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
        </div>
      ) : null}
      {format === "csv" && source !== null ? (
        <div className="mg-checks">
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
        </div>
      ) : null}
      {preview !== null && preview.kind === "csv" ? (
        <div className="mg-import-table-wrap">
          <table className="panel-table mg-import-table">
            <thead>
              <tr>
                {columns.map((column, i) => (
                  <th key={i} className={column.type === "skip" ? "mg-import-skip" : undefined}>
                    <div className="mono mg-import-colname">{column.name || t("(이름 없음)")}</div>
                    <Select
                      className="mg-input"
                      aria-label={t("{name}의 타입", { name: column.name })}
                      disabled={running}
                      value={column.type}
                      onChange={(event) => setColumns((list) => list.map((c, j) => (j === i ? { ...c, type: event.target.value as CsvColumn["type"] } : c)))}
                    >
                      {CSV_TYPES.map((type) => (
                        <option key={type.value} value={type.value}>
                          {t(type.label)}
                        </option>
                      ))}
                    </Select>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.slice(0, PREVIEW_ROWS).map(({ cells }, r) => (
                <tr key={r}>
                  {columns.map((column, i) => (
                    <td key={i} className={`mono${column.type === "skip" ? " mg-import-skip" : ""}`}>
                      {cells[i] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {previewDocs.length > 0 ? (
        <>
          <div className="mg-form-label">{t("미리보기 (앞 {count}건)", { count: Math.min(previewDocs.length, PREVIEW_ROWS) })}</div>
          <div className="mg-import-preview mono">
            {previewDocs.map((item, i) => (
              <div key={i} className={`mg-import-line${item.doc === null ? " bad" : ""}`}>
                <span className="mg-import-ln">{item.line}</span>
                <span className="mg-import-text">{item.doc !== null ? toShell(item.doc) : item.error}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
      {source !== null ? (
        <div className="mg-checks" role="radiogroup" aria-label={t("오류가 나면")}>
          <span className="mg-form-label">{t("오류가 나면")}</span>
          <label>
            <input type="radio" name="mg-import-onerror" checked={onError === "skip"} disabled={running} onChange={() => setOnError("skip")} />
            {t("건너뛰고 계속 (ordered: false)")}
          </label>
          <label>
            <input type="radio" name="mg-import-onerror" checked={onError === "stop"} disabled={running} onChange={() => setOnError("stop")} />
            {t("멈추기 (그 앞까지는 들어갑니다)")}
          </label>
        </div>
      ) : null}
      {progress === null ? <CommandPreview command={command} problem={problem} /> : null}
      {progress !== null ? (
        <div className="mg-transfer-progress" role="status">
          <div className="job-bar">
            <div className={`job-bar-fill${progress.state === "error" ? " error" : progress.state === "cancelled" ? " cancelled" : ""}`} style={{ width: `${percent}%` }} />
          </div>
          <div className="mg-transfer-stats">
            <span>{t("읽음 {count}", { count: progress.read.toLocaleString() })}</span>
            <span>{t("들어감 {count}", { count: progress.inserted.toLocaleString() })}</span>
            <span className={progress.failed > 0 ? "mg-danger-text" : undefined}>{t("실패 {count}", { count: progress.failed.toLocaleString() })}</span>
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
          <Failure error={progress.message} />
        </div>
      ) : null}
      {failures.length > 0 ? (
        <>
          <div className="mg-import-failhead">
            <span className="mg-form-label">{progress !== null && progress.failed > failures.length ? t("실패 목록 (앞 {shown}건 / {count}건)", { shown: failures.length, count: progress.failed.toLocaleString() }) : t("실패 목록")}</span>
            <span className="spacer" />
            <button type="button" className="mg-qbtn" onClick={() => void writeClipboard(failures.map((f) => `${f.line}\t${f.message}`).join("\n"), notify).then(() => notify(t("실패 목록을 복사했습니다")))}>
              {t("복사")}
            </button>
          </div>
          <div className="mg-import-preview mono mg-import-failures">
            {failures.map((f, i) => (
              <div key={i} className="mg-import-line bad">
                <span className="mg-import-ln">{f.line}</span>
                <span className="mg-import-text">{f.message}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </AdminModal>
  );
}
