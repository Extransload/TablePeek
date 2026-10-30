// A binary cell's whole value (capabilities.binary_cells): downloaded as a
// file, or replaced from typed text, hex, or a file dropped or pasted on the
// dialog. Both stream through /api/sql/cell, so a value past what the grid
// shows (a BLOB over 16 KiB shows only its size) still goes whole. Callers
// `binaryCellDialog({...})`; the one <BinaryCellDialogHost /> in App draws it.

import { useEffect, useRef, useState } from "react";
import { downloadBlob } from "../export";
import { t } from "../i18n";
import { store, type CellRef } from "../store";
import { ErrorNotice, FieldError, fieldErrorProps } from "./ErrorNotice";
import { Select } from "./Select";
import { Spinner } from "./Spinner";

export interface BinaryCellOptions {
  conn: string;
  cell: CellRef;
  // The grid's value: `<blob N bytes>`, hex, or null.
  shown: unknown;
  // Which part the dialog starts on: the download starts right away.
  start: "download" | "replace";
  // Called once the value was replaced, to read the rows again.
  onReplaced(): void;
}

type Source = "text" | "hex" | "file";

let listener: ((options: BinaryCellOptions | null) => void) | null = null;
let current: BinaryCellOptions | null = null;

export function binaryCellDialog(options: BinaryCellOptions): void {
  current = options;
  listener?.(options);
}

export function BinaryCellDialogHost() {
  const [options, setOptions] = useState<BinaryCellOptions | null>(current);
  const [key, setKey] = useState(0);
  useEffect(() => {
    listener = (next) => {
      setOptions(next);
      setKey((now) => now + 1);
    };
    return () => {
      listener = null;
    };
  }, []);
  if (options === null) {
    return null;
  }
  return (
    <BinaryCellModal
      key={key}
      options={options}
      onClose={() => {
        current = null;
        setOptions(null);
      }}
    />
  );
}

// The size the grid's value stands for, in bytes; null for NULL or unknown.
function shownSize(shown: unknown): number | null {
  if (typeof shown !== "string") {
    return null;
  }
  const placeholder = /^<blob (\d+) bytes>$/.exec(shown);
  if (placeholder !== null) {
    return Number(placeholder[1]);
  }
  const hex = shown.replace(/^(0x|\\x)/i, "");
  return /^[0-9a-f]*$/i.test(hex) ? hex.length / 2 : null;
}

// Hex as typed (0x/\x prefix, spaces and line breaks allowed) as bytes, or
// null when it isn't hex.
export function hexToBytes(text: string): Uint8Array | null {
  const digits = text.trim().replace(/^(0x|\\x)/i, "").replace(/\s+/g, "");
  if (digits.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(digits)) {
    return null;
  }
  const bytes = new Uint8Array(digits.length / 2);
  for (let at = 0; at < bytes.length; at += 1) {
    bytes[at] = parseInt(digits.slice(at * 2, at * 2 + 2), 16);
  }
  return bytes;
}

function fileName(cell: CellRef): string {
  const key = cell.pk.map((part) => String(part.value)).join("_");
  return `${cell.table}_${cell.column}_${key}.bin`.replace(/[\\/:*?"<>|\s]+/g, "_");
}

function bytesText(count: number): string {
  return t("{count}바이트", { count: count.toLocaleString() });
}

function BinaryCellModal({ options, onClose }: { options: BinaryCellOptions; onClose(): void }) {
  const { conn, cell, shown, start, onReplaced } = options;
  const size = shownSize(shown);
  const [source, setSource] = useState<Source>("text");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  // What runs now: its progress in bytes and, for an upload, the total.
  const [busy, setBusy] = useState<{ kind: "download" | "upload"; done: number; total: number | null } | null>(
    null,
  );
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pickerRef = useRef<HTMLInputElement | null>(null);

  const hexBytes = source === "hex" ? hexToBytes(text) : null;
  const hexProblem = source === "hex" && text.trim() !== "" && hexBytes === null ? t("16진수가 아닙니다") : null;
  const payload: Blob | null =
    source === "file"
      ? file
      : source === "hex"
        ? hexBytes === null
          ? null
          : new Blob([hexBytes as BlobPart])
        : new Blob([text]);

  function close(): void {
    abortRef.current?.abort();
    onClose();
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  async function download(): Promise<void> {
    const abort = new AbortController();
    abortRef.current = abort;
    setError(null);
    setNotice(null);
    setBusy({ kind: "download", done: 0, total: size });
    try {
      const blob = await store.readBinaryCell(
        conn,
        cell,
        (received) => setBusy({ kind: "download", done: received, total: size }),
        abort.signal,
      );
      downloadBlob(fileName(cell), blob);
      setNotice(t("{size}를 내려받았습니다", { size: bytesText(blob.size) }));
    } catch (err) {
      if (!abort.signal.aborted) {
        setError(err);
      }
    } finally {
      setBusy(null);
    }
  }

  async function replace(): Promise<void> {
    if (payload === null) {
      return;
    }
    const abort = new AbortController();
    abortRef.current = abort;
    setError(null);
    setNotice(null);
    setBusy({ kind: "upload", done: 0, total: payload.size });
    try {
      await store.writeBinaryCell(
        conn,
        cell,
        payload,
        (sent) => setBusy({ kind: "upload", done: sent, total: payload.size }),
        abort.signal,
      );
      onReplaced();
      onClose();
    } catch (err) {
      if (!abort.signal.aborted) {
        setError(err);
      }
    } finally {
      setBusy(null);
    }
  }

  // The download the menu asked for starts with the dialog.
  const started = useRef(false);
  useEffect(() => {
    if (start === "download" && !started.current) {
      started.current = true;
      void download();
    }
  });

  function takeFiles(files: FileList | null): boolean {
    const first = files?.[0];
    if (first === undefined) {
      return false;
    }
    setFile(first);
    setSource("file");
    return true;
  }

  const percent =
    busy !== null && busy.total !== null && busy.total > 0 ? Math.min(100, (busy.done / busy.total) * 100) : null;

  return (
    <div className="modal-backdrop" onClick={close}>
      <div
        className="modal binary-cell-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="binary-cell-title"
        onClick={(event) => event.stopPropagation()}
        onPaste={(event) => {
          if (takeFiles(event.clipboardData.files)) {
            event.preventDefault();
          }
        }}
      >
        <div className="modal-head">
          <span className="modal-title" id="binary-cell-title">
            {t("바이너리 값 — {column}", { column: cell.column })}
          </span>
        </div>
        <div className="modal-body binary-cell-body">
          <div className="binary-cell-row">
            <span className="binary-cell-label">{t("지금 값")}</span>
            <span>{shown === null ? "NULL" : size !== null ? bytesText(size) : t("알 수 없음")}</span>
            <span className="spacer" />
            <button type="button" disabled={busy !== null || shown === null} onClick={() => void download()}>
              {busy?.kind === "download" ? <Spinner size={10} /> : null}
              {t("전체 값 내려받기")}
            </button>
          </div>
          <div className="binary-cell-row">
            <span className="binary-cell-label">{t("새 값")}</span>
            <Select
              value={source}
              disabled={busy !== null}
              onChange={(event) => setSource(event.target.value as Source)}
              aria-label={t("새 값의 형식")}
            >
              <option value="text">{t("텍스트 (UTF-8)")}</option>
              <option value="hex">{t("16진수")}</option>
              <option value="file">{t("파일")}</option>
            </Select>
            <span className="spacer" />
            <span className="helper">{payload !== null ? bytesText(payload.size) : ""}</span>
          </div>
          {source === "file" ? (
            <div
              className={`binary-cell-drop${dragging ? " dragging" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                takeFiles(event.dataTransfer.files);
              }}
            >
              <span>
                {file !== null
                  ? `${file.name} — ${bytesText(file.size)}`
                  : t("파일을 여기에 끌어다 놓거나 붙여 넣으세요")}
              </span>
              <button type="button" disabled={busy !== null} onClick={() => pickerRef.current?.click()}>
                {t("파일 고르기…")}
              </button>
              <input
                ref={pickerRef}
                type="file"
                hidden
                onChange={(event) => {
                  takeFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </div>
          ) : (
            <textarea
              className="binary-cell-text"
              value={text}
              spellCheck={false}
              disabled={busy !== null}
              placeholder={source === "hex" ? "0x48656C6C6F" : t("값으로 쓸 글자")}
              aria-label={source === "hex" ? t("16진수") : t("텍스트 (UTF-8)")}
              {...fieldErrorProps("binary-cell-hex-error", hexProblem)}
              onChange={(event) => setText(event.target.value)}
            />
          )}
          {source === "hex" ? <FieldError id="binary-cell-hex-error" error={hexProblem} /> : null}
          {busy !== null ? (
            <div className="export-progress">
              <div className="job-bar">
                <div className="job-bar-fill" style={{ width: `${percent ?? 5}%` }} />
              </div>
              <span className="helper">
                {busy.kind === "download" ? t("받는 중") : t("보내는 중")} — {busy.done.toLocaleString()}
                {busy.total !== null ? ` / ${busy.total.toLocaleString()}` : ""}
              </span>
            </div>
          ) : null}
          {notice !== null ? <span className="helper">{notice}</span> : null}
          {error !== null ? <ErrorNotice error={error} context="data" /> : null}
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" onClick={close}>
            {busy !== null ? t("중지") : t("닫기")}
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy !== null || payload === null || payload.size === 0}
            onClick={() => void replace()}
          >
            {busy?.kind === "upload" ? <Spinner size={10} /> : null}
            {t("값 바꾸기")}
          </button>
        </div>
      </div>
    </div>
  );
}
