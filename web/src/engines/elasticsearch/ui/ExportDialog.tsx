// 내보내기 and 덤프: the 문서 tab's query (or the whole index) through the
// server's export stream (PIT + search_after or scroll, 1,000 at a time)
// into NDJSON (sources, or with `_index`/`_id`), a JSON array, CSV (fields
// picked from the mapping, nested ones as dotted paths, arrays as JSON) or
// `_bulk` lines that import again. 덤프 is the `_bulk` file with the index's
// definition in its head, which 가져오기 can make the index from. The file
// is built as the stream arrives (in Blob parts) and saved when it ends;
// 취소 closes the stream.

import { useEffect, useMemo, useRef, useState } from "react";
import { Select } from "../../../components/Select";
import { Spinner } from "../../../components/Spinner";
import { TextBlobBuilder, downloadBlob, exportBaseName } from "../../../export";
import { formatBytes } from "../../../format";
import { t } from "../../../i18n";
import { AdminModal } from "../../mongodb/ui/AdminModal";
import { count, definition, exportLines, isAbort, type ExportRequest } from "../api";
import type { Json } from "../json";
import { EXPORT_EXTENSION, EXPORT_MIME, dumpHead, exportWriter, type ExportFormat } from "../transfer";
import { requestText, type SearchHost } from "./common";
import { DialogFailure, RequestPreview, useIndexFields } from "./IndexDialogs";

interface ExportDialogProps {
  host: SearchHost;
  index: string;
  query?: Json;
  sort?: Json;
  source?: Json;
  onClose(): void;
}

const FORMATS: { value: ExportFormat; label: string }[] = [
  { value: "ndjson", label: "NDJSON (한 줄에 _source 하나)" },
  { value: "ndjson-meta", label: "NDJSON (_index · _id · _source)" },
  { value: "json", label: "JSON 배열" },
  { value: "csv", label: "CSV (중첩은 점 경로)" },
  { value: "bulk", label: "_bulk (다시 가져올 수 있는 동작 + 문서 줄)" },
  { value: "dump", label: "덤프 (인덱스 정의 + _bulk)" },
];

interface Progress {
  docs: number;
  bytes: number;
  state: "running" | "done" | "cancelled" | "error";
  error: unknown;
  // The server's count at the end, when it differs from what arrived.
  sent: number | null;
}

export function ExportDialog(props: ExportDialogProps) {
  const { host, onClose } = props;
  // What to export is fixed when the dialog opens; callers may pass new
  // objects on every render.
  const [initial] = useState({ index: props.index, query: props.query, sort: props.sort, source: props.source });
  const index = initial.index;
  const narrowed = initial.query !== undefined || initial.sort !== undefined || initial.source !== undefined;
  const [whole, setWhole] = useState(!narrowed);
  const [format, setFormat] = useState<ExportFormat>("ndjson");
  const [limit, setLimit] = useState("");
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [extra, setExtra] = useState("");
  const [withId, setWithId] = useState(true);
  const [expected, setExpected] = useState<number | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const running = progress?.state === "running";
  const mapped = useIndexFields(host.conn, format === "csv" ? index : "");
  // Leaves of the mapping as `_source` holds them: no multi-fields, no
  // object containers (nested arrays are one JSON cell).
  const fields = useMemo(() => (format !== "csv" || mapped.fields === null ? null : mapped.fields.filter((f) => !f.multi && f.type !== "object").map((f) => f.path)), [format, mapped.fields]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  // Every field starts picked once the list arrives.
  useEffect(() => {
    if (fields !== null && picked === null) {
      setPicked(new Set(fields));
    }
  }, [fields, picked]);

  const request = useMemo((): ExportRequest | { error: string } => {
    const req: ExportRequest = { index };
    if (!whole) {
      if (initial.query !== undefined) {
        req.query = initial.query;
      }
      if (initial.sort !== undefined) {
        req.sort = initial.sort;
      }
      if (initial.source !== undefined) {
        req.source = initial.source;
      }
    }
    if (limit.trim() !== "") {
      if (!/^\d+$/.test(limit.trim()) || Number(limit) < 1) {
        return { error: t("최대 문서 수: 1 이상의 정수를 쓰세요") };
      }
      req.limit = Number(limit);
    }
    return req;
  }, [index, whole, initial, limit]);

  // How many documents to expect.
  const countQuery = whole ? undefined : initial.query;
  useEffect(() => {
    setExpected(null);
    const controller = new AbortController();
    count(host.conn, index, countQuery, controller.signal).then(setExpected, () => setExpected(null));
    return () => controller.abort();
  }, [host.conn, index, countQuery]);
  const total = expected === null ? null : "error" in request || request.limit === undefined ? expected : Math.min(expected, request.limit);

  const columns = useMemo(() => {
    const out = (fields ?? []).filter((f) => picked?.has(f) ?? true);
    for (const f of extra.split(",").map((x) => x.trim())) {
      if (f !== "" && !out.includes(f)) {
        out.push(f);
      }
    }
    return out;
  }, [fields, picked, extra]);

  const fileName = `${exportBaseName(index)}.${EXPORT_EXTENSION[format]}`;
  const problem = "error" in request ? request.error : format === "csv" && fields !== null && columns.length === 0 && !withId ? t("CSV에 쓸 필드를 하나 이상 고르세요") : null;
  let command: string | null = null;
  if (!("error" in request)) {
    const body: Record<string, Json> = { size: 1000 };
    if (request.query !== undefined) {
      body.query = request.query;
    }
    if (request.sort !== undefined) {
      body.sort = request.sort;
    }
    if (request.source !== undefined) {
      body._source = request.source;
    }
    command = `${format === "dump" ? `${requestText("GET", `/${index}`)}\n\n` : ""}${requestText("POST", `/${index}/_search`, body)}`;
  }

  const run = async () => {
    if (running || problem !== null || "error" in request || (format === "csv" && fields === null && mapped.error === null)) {
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    const writer = exportWriter(format, columns, withId);
    const out = new TextBlobBuilder();
    let docs = 0;
    let bytes = 0;
    setProgress({ docs, bytes, state: "running", error: null, sent: null });
    try {
      if (format === "dump") {
        out.push(dumpHead(index, await definition(host.conn, index, controller.signal)));
      }
      out.push(writer.start);
      let sent: number | null = null;
      for await (const item of exportLines(host.conn, request, controller.signal)) {
        if ("end" in item) {
          sent = item.end;
          break;
        }
        out.push(writer.line(item.line));
        docs++;
        bytes = item.bytes;
        if (docs % 1000 === 0) {
          setProgress({ docs, bytes, state: "running", error: null, sent: null });
        }
      }
      out.push(writer.end());
      downloadBlob(fileName, out.blob(EXPORT_MIME[format]));
      setProgress({ docs, bytes, state: "done", error: null, sent: sent !== null && sent !== docs ? sent : null });
      host.notify(t("문서 {count}개를 내보냈습니다 — {file}", { count: docs.toLocaleString(), file: fileName }));
    } catch (error) {
      setProgress(isAbort(error) || controller.signal.aborted ? { docs, bytes, state: "cancelled", error: null, sent: null } : { docs, bytes, state: "error", error, sent: null });
    } finally {
      controllerRef.current = null;
    }
  };

  const percent = progress === null || total === null || total === 0 ? null : Math.min(100, Math.round((progress.docs / total) * 100));
  const finished = progress !== null && (progress.state === "done" || progress.state === "cancelled");
  const waitingFields = format === "csv" && fields === null && mapped.error === null;

  return (
    <AdminModal
      title={format === "dump" ? t("덤프") : t("내보내기")}
      path={index}
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
          <button type="button" className="primary" disabled={running || problem !== null || waitingFields} onClick={() => void run()}>
            {running ? <Spinner size={10} /> : null}
            {finished ? t("다시 내려받기") : t("내려받기")}
          </button>
        </>
      }
    >
      {narrowed ? (
        <div className="mg-checks mg-col" role="radiogroup" aria-label={t("범위")}>
          <label>
            <input type="radio" name="es-export-scope" checked={!whole} disabled={running} onChange={() => setWhole(false)} />
            {t("지금 쿼리 결과")}
          </label>
          <label>
            <input type="radio" name="es-export-scope" checked={whole} disabled={running} onChange={() => setWhole(true)} />
            {t("인덱스 전체")}
          </label>
        </div>
      ) : null}
      <div className="mg-form-grid">
        <label className="mg-form-row">
          <span className="mg-form-label">{t("형식")}</span>
          <Select className="mg-input" disabled={running} value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}>
            {FORMATS.map((f) => (
              <option key={f.value} value={f.value}>
                {t(f.label)}
              </option>
            ))}
          </Select>
        </label>
        <label className="mg-form-row">
          <span className="mg-form-label">{t("최대 문서 수")}</span>
          <input type="number" min={1} className="mg-input mono" placeholder={t("전체")} disabled={running} value={limit} onChange={(event) => setLimit(event.target.value)} />
        </label>
      </div>
      {format === "dump" ? <p className="panel-dim">{t("첫 줄에 # PUT /{index}와 인덱스 정의(설정·매핑·별칭)를 쓰고 그 뒤에 _bulk 줄을 씁니다. 가져오기가 이 파일로 인덱스를 다시 만들 수 있습니다.", { index })}</p> : null}
      {format === "bulk" ? <p className="panel-dim">{t("동작 줄에 _index를 쓰지 않아 어느 인덱스로든 다시 가져올 수 있습니다.")}</p> : null}
      {format === "csv" ? (
        <>
          <div className="mg-export-fieldhead">
            <span className="mg-form-label">{fields === null ? t("매핑에서 필드를 읽는 중…") : t("필드 (매핑에서 {fields}개)", { fields: fields.length })}</span>
            <span className="spacer" />
            <button type="button" className="mg-qbtn" disabled={running || fields === null} onClick={() => setPicked(new Set(fields ?? []))}>
              {t("모두")}
            </button>
            <button type="button" className="mg-qbtn" disabled={running || fields === null} onClick={() => setPicked(new Set())}>
              {t("없음")}
            </button>
          </div>
          {mapped.error !== null ? <DialogFailure error={mapped.error} context="export" /> : null}
          <div className="mg-export-fields">
            {waitingFields ? <Spinner size={12} /> : null}
            <label className="mono">
              <input type="checkbox" checked={withId} disabled={running} onChange={(event) => setWithId(event.target.checked)} />
              _id
            </label>
            {(fields ?? []).map((f) => (
              <label key={f} className="mono">
                <input
                  type="checkbox"
                  checked={picked?.has(f) ?? true}
                  disabled={running}
                  onChange={(event) => {
                    const next = new Set(picked ?? fields ?? []);
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
            <span className="mg-form-label">{t("매핑에 없는 필드 더하기 (쉼표로 구분, 점 경로)")}</span>
            <input type="text" className="mg-input mono" spellCheck={false} disabled={running} value={extra} onChange={(event) => setExtra(event.target.value)} />
          </label>
        </>
      ) : null}
      <RequestPreview text={command} problem={problem} />
      <span className="panel-dim">{t("서버가 1,000건씩 끝까지 읽습니다 (PIT + search_after, 또는 scroll).")}</span>
      {total !== null && progress === null ? <span className="panel-dim">{t("문서 {count}개를 내보냅니다", { count: total.toLocaleString() })}</span> : null}
      {progress !== null ? (
        <div className="mg-transfer-progress" role="status">
          <div className="job-bar">
            <div className={`job-bar-fill${progress.state === "error" ? " error" : progress.state === "cancelled" ? " cancelled" : ""}`} style={{ width: `${progress.state === "done" ? 100 : (percent ?? 0)}%` }} />
          </div>
          <div className="mg-transfer-stats">
            <span>{total !== null ? t("{done} / {total}개", { done: progress.docs.toLocaleString(), total: total.toLocaleString() }) : t("{done}개", { done: progress.docs.toLocaleString() })}</span>
            <span className="panel-dim">{formatBytes(progress.bytes)}</span>
            <span className="spacer" />
            <span className="panel-dim">{progress.state === "running" ? (percent !== null ? `${percent}%` : "…") : progress.state === "done" ? t("저장했습니다") : progress.state === "cancelled" ? t("취소했습니다") : t("실패했습니다")}</span>
          </div>
          {progress.sent !== null ? <span className="panel-dim">{t("서버는 {sent}개라고 알렸지만 {done}개를 받았습니다", { sent: progress.sent.toLocaleString(), done: progress.docs.toLocaleString() })}</span> : null}
          <DialogFailure error={progress.error} context="export" />
        </div>
      ) : null}
    </AdminModal>
  );
}
