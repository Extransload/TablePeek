// A GridFS bucket's tab (MONGODB.md §8.1): the files of `<bucket>.files`
// with name, size, upload date, content type and metadata, searched by name
// (or by a filter written as a document), sorted by a header click and paged.
// Files download straight from the server, upload from the file picker or by
// dropping them on the list (with progress, one request each), delete after
// confirmation, and open to their whole file document.

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { ErrorNotice, notifyError } from "../../../components/ErrorNotice";
import { CloseIcon, DownloadIcon, EyeIcon, RefreshIcon, SearchIcon, TrashIcon, UploadIcon } from "../../../components/icons";
import { LoadingState, Spinner } from "../../../components/Spinner";
import { formatBytes } from "../../../format";
import { say, t } from "../../../i18n";
import { count, gridFsDelete, gridFsDownloadUrl, gridFsFiles, gridFsUpload, isAbort, toNumber, type Namespace } from "../api";
import { BsonDate, Int32, bsonDoc, isDocument, stringifyJson, toEJSON, type BsonDocument, type BsonValue } from "../bson";
import { toShell, toShellPretty } from "../format";
import { parseFilter } from "../shell/parse";
import { AdminModal } from "./AdminModal";
import { DocFields, docKey } from "./CardView";
import { DocDetailPanel, ItemDetail, NothingSelected, useCollectionFacts } from "./DocDetailPanel";
import { ConfirmModal, type ConfirmRequest } from "./DocModals";
import { arrowStep, selectsItem } from "./selection";
import "./streams.css";

export interface GridFsTabProps {
  conn: string;
  db: string;
  bucket: string;
  tabKey: string;
  notify(message: string): void;
  // Files were stored or deleted: the sidebar reads its collections (and
  // the bucket's file count) again.
  onChanged(): void;
}

const PAGE_SIZE = 50;

type SortField = "filename" | "length" | "uploadDate";

interface TabMemory {
  search: string;
  sort: { field: SortField; dir: 1 | -1 };
  page: number;
}

const memory = new Map<string, TabMemory>();

interface Upload {
  id: number;
  name: string;
  size: number;
  sent: number;
  state: "waiting" | "sending" | "done" | "failed";
  error: unknown;
  controller: AbortController;
}

// The search box as a filter: a document (`{ … }`, mongosh notation) as
// written, anything else a case-insensitive match on the file name.
function searchFilter(text: string): { ok: true; filter: BsonDocument } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: true, filter: new Map() };
  }
  if (trimmed.startsWith("{")) {
    const parsed = parseFilter(trimmed);
    return parsed.ok ? { ok: true, filter: parsed.value } : { ok: false, message: say(parsed.error.message) };
  }
  const pattern = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return { ok: true, filter: bsonDoc({ filename: bsonDoc({ $regex: pattern, $options: "i" }) }) };
}

// The content type a file says it has: the legacy top-level field, else
// `metadata.contentType` (where TablePeek and current drivers put it).
function contentTypeOf(file: BsonDocument): string {
  const top = file.get("contentType");
  if (typeof top === "string") {
    return top;
  }
  const meta = file.get("metadata");
  const inMeta = isDocument(meta) ? meta.get("contentType") : undefined;
  return typeof inMeta === "string" ? inMeta : "";
}

function mongofiles(db: string, bucket: string, command: string): string {
  return `mongofiles --db=${db} --prefix=${bucket} ${command}`;
}

export function GridFsTab({ conn, db, bucket, tabKey, notify, onChanged }: GridFsTabProps) {
  const remembered = memory.get(tabKey);
  const [search, setSearch] = useState(remembered?.search ?? "");
  const [applied, setApplied] = useState(remembered?.search ?? "");
  const [sort, setSort] = useState<TabMemory["sort"]>(remembered?.sort ?? { field: "uploadDate", dir: -1 });
  const [page, setPage] = useState(remembered?.page ?? 0);
  const [files, setFiles] = useState<BsonDocument[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [reloadSeq, setReloadSeq] = useState(0);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [shown, setShown] = useState<BsonDocument | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ request: ConfirmRequest; resolve(ok: boolean): void } | null>(null);
  const pickerRef = useRef<HTMLInputElement | null>(null);
  const uploadSeq = useRef(0);
  const filesNs: Namespace = { conn, db, coll: `${bucket}.files` };
  // The file in the detail panel (its docKey), and what the panel lists without one.
  const [picked, setPicked] = useState<string | null>(null);
  const facts = useCollectionFacts(filesNs, reloadSeq);

  useEffect(() => {
    memory.set(tabKey, { search: applied, sort, page });
  }, [tabKey, applied, sort, page]);

  const parsed = searchFilter(applied);

  useEffect(() => {
    if (!parsed.ok) {
      return;
    }
    const ctl = new AbortController();
    setLoading(true);
    setError(null);
    const sortDoc = new Map<string, BsonValue>([[sort.field, new Int32(sort.dir)]]);
    if (sort.field !== "uploadDate") {
      sortDoc.set("uploadDate", new Int32(-1));
    }
    Promise.all([
      gridFsFiles(conn, db, bucket, { filter: parsed.filter, sort: sortDoc, skip: page * PAGE_SIZE, limit: PAGE_SIZE }, ctl.signal),
      count(filesNs, parsed.filter, ctl.signal).catch(() => ({ count: null, exact: false })),
    ]).then(
      ([list, counted]) => {
        setFiles(list);
        setTotal(counted.count);
        setLoading(false);
      },
      (e: unknown) => {
        if (!isAbort(e)) {
          setError(e);
          setLoading(false);
        }
      },
    );
    return () => ctl.abort();
    // `parsed` follows `applied`; its identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, db, bucket, applied, sort, page, reloadSeq]);

  const reload = useCallback(() => setReloadSeq((n) => n + 1), []);

  // Abort uploads still running when the tab goes away.
  const uploadsRef = useRef(uploads);
  uploadsRef.current = uploads;
  useEffect(() => () => uploadsRef.current.forEach((u) => (u.state === "sending" || u.state === "waiting") && u.controller.abort()), []);

  const patchUpload = (id: number, patch: Partial<Upload>) => setUploads((list) => list.map((u) => (u.id === id ? { ...u, ...patch } : u)));

  // Resolves true once stored.
  async function uploadOne(id: number, file: File, controller: AbortController): Promise<boolean> {
    if (controller.signal.aborted) {
      return false;
    }
    patchUpload(id, { state: "sending" });
    try {
      await gridFsUpload(conn, db, bucket, file, file.name, file.type !== "" ? bsonDoc({ contentType: file.type }) : null, (sent) => patchUpload(id, { sent }), controller.signal);
      patchUpload(id, { state: "done", sent: file.size });
      reload();
      return true;
    } catch (e) {
      if (isAbort(e)) {
        setUploads((list) => list.filter((u) => u.id !== id));
      } else {
        patchUpload(id, { state: "failed", error: e });
      }
      return false;
    }
  }

  // All chosen files show at once, waiting; they go one at a time, which
  // keeps the server's connections free for the other tabs.
  function uploadAll(list: FileList | File[]): void {
    const queued = [...list].map((file) => ({ file, id: ++uploadSeq.current, controller: new AbortController() }));
    setUploads((prev) => [...prev, ...queued.map(({ file, id, controller }): Upload => ({ id, name: file.name, size: file.size, sent: 0, state: "waiting", error: null, controller }))]);
    void (async () => {
      let stored = 0;
      for (const { file, id, controller } of queued) {
        if (await uploadOne(id, file, controller)) {
          stored += 1;
        }
      }
      if (stored > 0) {
        notify(t("파일 {count}개를 올렸습니다", { count: stored }));
        onChanged();
      }
    })();
  }

  const ask = (request: ConfirmRequest) =>
    new Promise<boolean>((resolve) => {
      setConfirm({
        request,
        resolve: (ok) => {
          setConfirm(null);
          resolve(ok);
        },
      });
    });

  async function remove(file: BsonDocument): Promise<void> {
    const id = file.get("_id") ?? null;
    const name = String(file.get("filename") ?? "");
    const ok = await ask({
      title: t("파일 삭제"),
      message: t("{name} 파일과 그 조각(chunks)을 지울까요?\n되돌릴 수 없습니다.", { name }),
      command: mongofiles(db, bucket, `delete_id '${stringifyJson(toEJSON(id))}'`),
      okLabel: t("삭제"),
    });
    if (!ok) {
      return;
    }
    const key = toShell(id);
    setDeleting(key);
    try {
      await gridFsDelete(conn, db, bucket, id);
      notify(t("{name} 파일을 지웠습니다", { name }));
      onChanged();
      if (shown !== null && toShell(shown.get("_id") ?? null) === key) {
        setShown(null);
      }
      reload();
    } catch (e) {
      notifyError(e, { context: "document" });
    } finally {
      setDeleting(null);
    }
  }

  const setSortBy = (field: SortField) => {
    setSort((prev) => (prev.field === field ? { field, dir: prev.dir === 1 ? -1 : 1 } : { field, dir: field === "filename" ? 1 : -1 }));
    setPage(0);
  };

  const sortMark = (field: SortField) => (sort.field === field ? (sort.dir === 1 ? " ↑" : " ↓") : "");

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 0) {
      uploadAll(event.dataTransfer.files);
    }
  };

  const pages = total !== null ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : null;
  const fileKeys = (files ?? []).map((file, i) => docKey(file, page * PAGE_SIZE + i));
  const pickedAt = picked === null ? -1 : fileKeys.indexOf(picked);
  const pickedFile = pickedAt >= 0 ? files?.[pickedAt] : undefined;
  const pickAt = (table: HTMLTableElement | null, at: number) => {
    const key = fileKeys[at];
    if (key !== undefined) {
      setPicked(key);
      table?.tBodies[0]?.rows[at]?.scrollIntoView({ block: "nearest" });
    }
  };

  return (
    <div className="mg-root mg-gridfs">
      <div className="mg-agg-bar mg-gridfs-bar">
        <span className="mg-agg-count">
          GridFS · <span className="mono">{`${db}.${bucket}`}</span>
        </span>
        <form
          className="mg-gridfs-search"
          onSubmit={(event) => {
            event.preventDefault();
            setApplied(search);
            setPage(0);
          }}
        >
          <SearchIcon size={11} />
          <input
            type="text"
            className="mg-input"
            value={search}
            spellCheck={false}
            placeholder={t("파일 이름 검색, 또는 { metadata.kind: \"x\" } 같은 필터")}
            aria-label={t("파일 검색")}
            aria-invalid={!parsed.ok}
            onChange={(event) => setSearch(event.target.value)}
          />
        </form>
        <span className="spacer" />
        <button type="button" className="icon-button" title={t("새로고침")} aria-label={t("새로고침")} onClick={reload}>
          {loading ? <Spinner size={11} /> : <RefreshIcon size={12} />}
        </button>
        <button type="button" className="primary mg-find" onClick={() => pickerRef.current?.click()}>
          <UploadIcon size={10} />
          {t("올리기")}
        </button>
        <input
          ref={pickerRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files !== null) {
              uploadAll(event.target.files);
            }
            event.target.value = "";
          }}
        />
      </div>
      {uploads.length > 0 ? (
        <div className="mg-gridfs-uploads" aria-live="polite">
          {uploads.map((u) => (
            <div key={u.id} className={`mg-gridfs-upload ${u.state}`}>
              <span className="mono mg-gridfs-upname">{u.name}</span>
              <progress max={Math.max(1, u.size)} value={u.sent} aria-label={t("{name} 올리는 중", { name: u.name })} />
              <span className="panel-dim mono">
                {u.state === "done" ? t("완료") : u.state === "waiting" ? t("기다리는 중") : `${formatBytes(u.sent) ?? ""} / ${formatBytes(u.size) ?? ""}`}
              </span>
              {u.state === "sending" || u.state === "waiting" ? (
                <button
                  type="button"
                  className="icon-text-button"
                  onClick={() => {
                    u.controller.abort();
                    if (u.state === "waiting") {
                      setUploads((list) => list.filter((x) => x.id !== u.id));
                    }
                  }}
                >
                  {t("취소")}
                </button>
              ) : (
                <button type="button" className="icon-button" title={t("닫기")} aria-label={t("닫기")} onClick={() => setUploads((list) => list.filter((x) => x.id !== u.id))}>
                  <CloseIcon size={9} />
                </button>
              )}
              {u.state === "failed" ? <ErrorNotice error={u.error} context="document" engine="mongodb" variant="compact" /> : null}
            </div>
          ))}
        </div>
      ) : null}
      <div
        className={`mg-gridfs-body${dragging ? " dragging" : ""}`}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDragging(false);
          }
        }}
        onDrop={onDrop}
      >
        {!parsed.ok ? (
          <ErrorNotice error={{ code: "parse_error", message: parsed.message }} context="data" engine="mongodb" variant="compact" />
        ) : error !== null ? (
          <ErrorNotice error={error} context="data" engine="mongodb" onRetry={reload} />
        ) : files === null ? (
          <LoadingState />
        ) : files.length === 0 ? (
          <div className="panel-empty mg-gridfs-empty">{applied.trim() === "" ? t("파일이 없습니다. 올리기를 누르거나 파일을 여기에 끌어다 놓으세요") : t("검색 결과가 없습니다")}</div>
        ) : (
          <table
            className={`panel-table mg-struct-table mg-gridfs-table mg-pick-table${loading ? " stale" : ""}`}
            tabIndex={-1}
            onKeyDown={(event) => {
              const next = arrowStep(event, fileKeys.length, pickedAt);
              if (next !== null) {
                event.preventDefault();
                pickAt(event.currentTarget, next);
              }
            }}
          >
            <thead>
              <tr>
                <th>
                  <button type="button" className="mg-gridfs-sort" onClick={() => setSortBy("filename")}>
                    {t("이름")}
                    {sortMark("filename")}
                  </button>
                </th>
                <th className="num">
                  <button type="button" className="mg-gridfs-sort" onClick={() => setSortBy("length")}>
                    {t("크기")}
                    {sortMark("length")}
                  </button>
                </th>
                <th>
                  <button type="button" className="mg-gridfs-sort" onClick={() => setSortBy("uploadDate")}>
                    {t("올린 때")}
                    {sortMark("uploadDate")}
                  </button>
                </th>
                <th>{t("콘텐츠 유형")}</th>
                <th>{t("메타데이터")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {files.map((file, i) => {
                const id = file.get("_id") ?? null;
                const key = fileKeys[i];
                const uploaded = file.get("uploadDate");
                const meta = file.get("metadata");
                return (
                  <tr
                    key={key}
                    className={key === picked ? "selected" : undefined}
                    onClick={(event) => {
                      if (selectsItem(event.target)) {
                        pickAt(null, i);
                        event.currentTarget.closest("table")?.focus({ preventScroll: true });
                      }
                    }}
                  >
                    <td className="mono mg-gridfs-name" title={toShell(id)}>
                      {String(file.get("filename") ?? "")}
                    </td>
                    <td className="num mono">{formatBytes(toNumber(file.get("length"))) ?? ""}</td>
                    <td className="mono">{uploaded instanceof BsonDate ? uploaded.toDate().toLocaleString() : ""}</td>
                    <td className="mono">{contentTypeOf(file)}</td>
                    <td className="mono mg-gridfs-meta" title={meta !== undefined && meta !== null ? toShellPretty(meta) : undefined}>
                      {meta !== undefined && meta !== null ? toShell(meta) : ""}
                    </td>
                    <td className="num mg-gridfs-acts">
                      <button type="button" className="icon-text-button" onClick={() => setShown(file)}>
                        <EyeIcon size={10} />
                        {t("보기")}
                      </button>
                      <a className="icon-text-button" href={gridFsDownloadUrl(conn, db, bucket, id)} download>
                        <DownloadIcon size={10} />
                        {t("내려받기")}
                      </a>
                      <button type="button" className="icon-text-button mg-danger-text" disabled={deleting !== null} onClick={() => void remove(file)}>
                        {deleting === key ? <Spinner size={10} /> : <TrashIcon size={10} />}
                        {t("삭제")}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {dragging ? <div className="mg-gridfs-drop">{t("놓으면 {bucket} 버킷에 올립니다", { bucket })}</div> : null}
      </div>
      <div className="data-toolbar mg-pager mg-gridfs-pager">
        <span className="panel-dim">
          {total !== null ? t("파일 {count}개", { count: total.toLocaleString() }) : files !== null ? t("파일 {count}개 이상", { count: (page * PAGE_SIZE + files.length).toLocaleString() }) : ""}
        </span>
        <span className="spacer" />
        <button type="button" disabled={page === 0 || loading} onClick={() => setPage((p) => Math.max(0, p - 1))}>
          ‹
        </button>
        <span className="mono">{pages !== null ? `${page + 1} / ${pages}` : page + 1}</span>
        <button type="button" disabled={loading || files === null || files.length < PAGE_SIZE || (pages !== null && page + 1 >= pages)} onClick={() => setPage((p) => p + 1)}>
          ›
        </button>
      </div>
      {shown !== null ? (
        <AdminModal
          title={String(shown.get("filename") ?? t("파일"))}
          path={`${db}.${bucket}.files`}
          className="mg-gridfs-modal"
          busy={false}
          onClose={() => setShown(null)}
          foot={
            <>
              <span className="spacer" />
              <a className="icon-text-button mg-gridfs-link" href={gridFsDownloadUrl(conn, db, bucket, shown.get("_id") ?? null)} download>
                <DownloadIcon size={10} />
                {t("내려받기")}
              </a>
              <button type="button" className="primary" onClick={() => setShown(null)}>
                {t("닫기")}
              </button>
            </>
          }
        >
          <DocFields doc={shown} readOnly allOpen />
        </AdminModal>
      ) : null}
      {confirm !== null ? <ConfirmModal request={confirm.request} onResult={confirm.resolve} /> : null}
      <DocDetailPanel>
        {(query) =>
          pickedFile !== undefined ? (
            <ItemDetail
              key={picked ?? ""}
              title={String(pickedFile.get("filename") ?? t("파일"))}
              note={formatBytes(toNumber(pickedFile.get("length"))) ?? undefined}
              doc={pickedFile}
              query={query}
              foot={
                <div className="mg-detail-foot">
                  <a className="icon-text-button" href={gridFsDownloadUrl(conn, db, bucket, pickedFile.get("_id") ?? null)} download>
                    <DownloadIcon size={10} />
                    {t("내려받기")}
                  </a>
                </div>
              }
            />
          ) : (
            <NothingSelected facts={facts} query={query} empty={t("선택된 파일이 없습니다")} />
          )
        }
      </DocDetailPanel>
    </div>
  );
}
