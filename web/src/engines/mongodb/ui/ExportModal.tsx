// 내보내기 (MONGODB.md §6.2): the collection tab's query (filter,
// projection, sort, limit) or an aggregation pipeline, through the server's
// `/api/doc/export` stream, into a JSON array or NDJSON file (relaxed or
// canonical Extended JSON) or CSV. CSV fields are picked from a sample of
// the result: nested documents spread to dotted paths, arrays are written
// as JSON text. The file is built as the stream arrives (in Blob parts, so a
// large export does not sit in one string) and saved when it ends; 취소
// closes the stream.

import { useEffect, useMemo, useRef, useState } from "react";
import { Select } from "../../../components/Select";
import { Spinner } from "../../../components/Spinner";
import { TextBlobBuilder, downloadBlob, exportBaseName } from "../../../export";
import { t } from "../../../i18n";
import { aggregate, count, exportDocs, find, isAbort, type ExportRequest, type Namespace, type QueryOptions } from "../api";
import { Int32, Int64, bsonDoc, type BsonDocument } from "../bson";
import { shellCursorOptions } from "../codegen";
import { toShell, toShellPretty } from "../format";
import { EXPORT_FILE_MIME, exportWriter, samplePaths, type ExportFileFormat } from "../transfer";
import { AdminModal, CommandPreview, Failure, errorText, shellNamespace } from "./AdminModal";

// `limit` null or positive; `skip` (the query bar's) makes the export run as
// a pipeline, since the export route has no skip. `options` (collation,
// hint, maxTimeMS) go with either.
export type ExportSource =
  | { kind: "find"; filter: BsonDocument; projection: BsonDocument | null; sort: BsonDocument | null; skip?: number; limit: number | null; options?: QueryOptions }
  | { kind: "aggregate"; pipeline: BsonDocument[] };

interface ExportModalProps {
  ns: Namespace;
  source: ExportSource;
  notify(message: string): void;
  onClose(): void;
}

// Documents sampled for the CSV field list.
const SAMPLE = 200;

const FORMATS: { value: ExportFileFormat; label: string }[] = [
  { value: "json", label: "JSON 배열" },
  { value: "ndjson", label: "NDJSON (한 줄에 문서 하나)" },
  { value: "csv", label: "CSV (중첩은 점 경로)" },
];

interface Progress {
  done: number;
  state: "running" | "done" | "cancelled" | "error";
  message: string | null;
}

// Whether a find source narrows the collection at all.
function narrowed(source: ExportSource): boolean {
  return source.kind === "aggregate" || source.filter.size > 0 || source.projection !== null || source.sort !== null || (source.skip ?? 0) > 0 || source.limit !== null;
}

export function ExportModal(props: ExportModalProps) {
  const { notify, onClose } = props;
  // What to export is fixed when the dialog opens; callers may pass new
  // objects on every render.
  const [ns] = useState(props.ns);
  const [source] = useState(props.source);
  const [whole, setWhole] = useState(false);
  const [format, setFormat] = useState<ExportFileFormat>("json");
  const [relaxed, setRelaxed] = useState(true);
  const [fields, setFields] = useState<string[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [extra, setExtra] = useState("");
  const [expected, setExpected] = useState<number | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const running = progress?.state === "running";
  const active = useMemo((): ExportSource => (whole ? { kind: "find", filter: new Map(), projection: null, sort: null, limit: null } : source), [whole, source]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  // How many documents to expect (a find only; a pipeline's size is known at its end).
  useEffect(() => {
    setExpected(null);
    if (active.kind !== "find") {
      return;
    }
    const controller = new AbortController();
    const skip = active.skip ?? 0;
    // The count keeps its own time limit; collation and hint change what it counts.
    count(ns, active.filter, controller.signal, { collation: active.options?.collation, hint: active.options?.hint }).then(
      (r) => setExpected(r.count === null ? null : Math.min(Math.max(0, r.count - skip), active.limit ?? Infinity)),
      () => setExpected(null),
    );
    return () => controller.abort();
  }, [ns, active]);

  // The CSV field list, from a sample of what will be exported.
  useEffect(() => {
    if (format !== "csv") {
      return;
    }
    const controller = new AbortController();
    setFields(null);
    const sample =
      active.kind === "find"
        ? find(ns, { filter: active.filter, projection: active.projection, sort: active.sort, skip: active.skip, limit: Math.min(active.limit ?? SAMPLE, SAMPLE), ...active.options }, controller.signal)
        : aggregate(ns, [...active.pipeline, bsonDoc({ $limit: new Int32(SAMPLE) })], undefined, controller.signal);
    sample.then(
      (batch) => {
        const paths = samplePaths(batch.docs);
        setFields(paths);
        setPicked(new Set(paths));
      },
      (error: unknown) => {
        if (!isAbort(error)) {
          setFields([]);
          setProgress({ done: 0, state: "error", message: errorText(error) });
        }
      },
    );
    return () => controller.abort();
  }, [ns, active, format]);

  const columns = useMemo(() => {
    const list = (fields ?? []).filter((f) => picked.has(f));
    for (const f of extra.split(",").map((x) => x.trim())) {
      if (f !== "" && !list.includes(f)) {
        list.push(f);
      }
    }
    return list;
  }, [fields, picked, extra]);

  const ext = format === "csv" ? "csv" : format === "ndjson" ? "ndjson" : "json";
  const fileName = `${exportBaseName(ns.coll)}.${ext}`;
  const base = shellNamespace(ns.db, ns.coll);
  let command: string;
  if (active.kind === "aggregate") {
    command = `${base}.aggregate(${toShellPretty(active.pipeline)})`;
  } else {
    command = `${base}.find(${toShell(active.filter)}${active.projection !== null ? `, ${toShell(active.projection)}` : ""})`;
    if (active.sort !== null) {
      command += `.sort(${toShell(active.sort)})`;
    }
    if (active.skip !== undefined && active.skip > 0) {
      command += `.skip(${active.skip})`;
    }
    if (active.limit !== null) {
      command += `.limit(${active.limit})`;
    }
    command += shellCursorOptions(active.options).join("");
  }
  const problem = format === "csv" && fields !== null && columns.length === 0 ? t("CSV에 쓸 필드를 하나 이상 고르세요") : null;

  const run = async () => {
    if (running || problem !== null || (format === "csv" && fields === null)) {
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    const writer = exportWriter(format, relaxed, columns);
    const out = new TextBlobBuilder();
    out.push(writer.start);
    let done = 0;
    setProgress({ done, state: "running", message: null });
    try {
      let request: ExportRequest;
      if (active.kind === "aggregate") {
        request = { pipeline: active.pipeline };
      } else if (active.skip !== undefined && active.skip > 0) {
        const pipeline: BsonDocument[] = [bsonDoc({ $match: active.filter })];
        if (active.sort !== null) {
          pipeline.push(bsonDoc({ $sort: active.sort }));
        }
        pipeline.push(bsonDoc({ $skip: new Int64(active.skip) }));
        if (active.limit !== null) {
          pipeline.push(bsonDoc({ $limit: new Int64(active.limit) }));
        }
        if (active.projection !== null) {
          pipeline.push(bsonDoc({ $project: active.projection }));
        }
        request = { pipeline, options: active.options };
      } else {
        request = { filter: active.filter, projection: active.projection, sort: active.sort, limit: active.limit, options: active.options };
      }
      const sent = await exportDocs(
        ns,
        request,
        (line) => {
          out.push(writer.line(line));
          done++;
          if (done % 1000 === 0) {
            setProgress({ done, state: "running", message: null });
          }
        },
        controller.signal,
      );
      out.push(writer.end());
      downloadBlob(fileName, out.blob(EXPORT_FILE_MIME[format]));
      setProgress({ done, state: "done", message: sent !== done ? t("서버는 {sent}개라고 알렸지만 {done}개를 받았습니다", { sent: sent.toLocaleString(), done: done.toLocaleString() }) : null });
      notify(t("문서 {count}개를 내보냈습니다 — {file}", { count: done.toLocaleString(), file: fileName }));
    } catch (error) {
      setProgress(isAbort(error) || controller.signal.aborted ? { done, state: "cancelled", message: null } : { done, state: "error", message: errorText(error) });
    } finally {
      controllerRef.current = null;
    }
  };

  const percent = progress === null || expected === null || expected === 0 ? null : Math.min(100, Math.round((progress.done / expected) * 100));
  const finished = progress !== null && (progress.state === "done" || progress.state === "cancelled");

  return (
    <AdminModal
      title={t("내보내기")}
      path={`${ns.db}.${ns.coll}`}
      className="mg-export-modal"
      busy={running}
      onClose={onClose}
      foot={
        <>
          <span className="panel-dim mono">{fileName}</span>
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
          <button type="button" className="primary" disabled={running || problem !== null || (format === "csv" && fields === null)} onClick={() => void run()}>
            {running ? <Spinner size={10} /> : null}
            {finished ? t("다시 내려받기") : t("내려받기")}
          </button>
        </>
      }
    >
      {narrowed(source) ? (
        <div className="mg-checks mg-col" role="radiogroup" aria-label={t("범위")}>
          <label>
            <input type="radio" name="mg-export-scope" checked={!whole} disabled={running} onChange={() => setWhole(false)} />
            {source.kind === "aggregate" ? t("집계 결과") : t("지금 쿼리 결과")}
          </label>
          <label>
            <input type="radio" name="mg-export-scope" checked={whole} disabled={running} onChange={() => setWhole(true)} />
            {t("컬렉션 전체")}
          </label>
        </div>
      ) : null}
      <div className="mg-form-grid">
        <label className="mg-form-row">
          <span className="mg-form-label">{t("형식")}</span>
          <Select className="mg-input" disabled={running} value={format} onChange={(event) => setFormat(event.target.value as ExportFileFormat)}>
            {FORMATS.map((f) => (
              <option key={f.value} value={f.value}>
                {t(f.label)}
              </option>
            ))}
          </Select>
        </label>
        {format !== "csv" ? (
          <label className="mg-form-row">
            <span className="mg-form-label">Extended JSON</span>
            <Select className="mg-input" disabled={running} value={relaxed ? "relaxed" : "canonical"} onChange={(event) => setRelaxed(event.target.value === "relaxed")}>
              <option value="relaxed">{t("완화 (relaxed) — 수와 날짜를 읽기 쉽게")}</option>
              <option value="canonical">{t("canonical — 타입을 그대로 (Int64·Decimal128·Double)")}</option>
            </Select>
          </label>
        ) : null}
      </div>
      {format === "csv" ? (
        <>
          <div className="mg-export-fieldhead">
            <span className="mg-form-label">{fields === null ? t("필드를 표본에서 찾는 중…") : t("필드 (앞 {count}건 표본에서 {fields}개)", { count: SAMPLE, fields: fields.length })}</span>
            <span className="spacer" />
            <button type="button" className="mg-qbtn" disabled={running || fields === null} onClick={() => setPicked(new Set(fields ?? []))}>
              {t("모두")}
            </button>
            <button type="button" className="mg-qbtn" disabled={running || fields === null} onClick={() => setPicked(new Set())}>
              {t("없음")}
            </button>
          </div>
          <div className="mg-export-fields">
            {fields === null ? <Spinner size={12} /> : null}
            {(fields ?? []).map((f) => (
              <label key={f} className="mono">
                <input
                  type="checkbox"
                  checked={picked.has(f)}
                  disabled={running}
                  onChange={(event) => {
                    const next = new Set(picked);
                    if (event.target.checked) {
                      next.add(f);
                    } else {
                      next.delete(f);
                    }
                    setPicked(next);
                  }}
                />
                {f}
              </label>
            ))}
          </div>
          <label className="mg-form-row">
            <span className="mg-form-label">{t("표본에 없는 필드 더하기 (쉼표로 구분, 점 경로)")}</span>
            <input type="text" className="mg-input mono" spellCheck={false} disabled={running} value={extra} onChange={(event) => setExtra(event.target.value)} />
          </label>
        </>
      ) : null}
      <CommandPreview command={command} problem={problem} />
      {expected !== null && progress === null ? <span className="panel-dim">{t("문서 {count}개를 내보냅니다", { count: expected.toLocaleString() })}</span> : null}
      {progress !== null ? (
        <div className="mg-transfer-progress" role="status">
          <div className="job-bar">
            <div className={`job-bar-fill${progress.state === "error" ? " error" : progress.state === "cancelled" ? " cancelled" : ""}`} style={{ width: `${progress.state === "done" ? 100 : (percent ?? 0)}%` }} />
          </div>
          <div className="mg-transfer-stats">
            <span>{expected !== null ? t("{done} / {total}개", { done: progress.done.toLocaleString(), total: expected.toLocaleString() }) : t("{done}개", { done: progress.done.toLocaleString() })}</span>
            <span className="spacer" />
            <span className="panel-dim">{progress.state === "running" ? (percent !== null ? `${percent}%` : "…") : progress.state === "done" ? t("저장했습니다") : progress.state === "cancelled" ? t("취소했습니다") : t("실패했습니다")}</span>
          </div>
          <Failure error={progress.message} />
        </div>
      ) : null}
    </AdminModal>
  );
}
