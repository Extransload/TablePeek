import { useEffect, useMemo, useRef, useState } from "react";
import { rowWindowSql } from "../dataQuery";
import { createTableSql, dependencyOrder, draftsFromDetail, dumpIndexSql, foreignKeySql, quoteIdent } from "../ddl";
import { collectRows, downloadBlob, EXPORT_MIME, suggestFilename, toSqlInserts } from "../export";
import { declaredAs } from "../grid/columns";
import { t } from "../i18n";
import { decodeText, ENCODING_LABELS, IMPORT_ENCODINGS } from "../importParse";
import { cancelJob, startJob } from "../jobs";
import type { SqlDialect } from "../engines/sqlDialect";
import { getSettings } from "../settings";
import { splitSqlRanges } from "../sqlSplit";
import { store, type EngineMeta, type TableDetail } from "../store";
import { ErrorNotice, notifyError } from "./ErrorNotice";
import { FolderIcon, StopIcon } from "./icons";
import { Select } from "./Select";

interface DumpModalProps {
  conn: string;
  meta: EngineMeta;
  dialect: SqlDialect;
  initialTab: "backup" | "restore";
  onClose(): void;
  onRestored(): void;
}

const PAGE_SIZE = 5000;
const TABLE_ROW_CAP = 200000;
// The start of an SQL file shown before it runs, as TablePlus previews it.
const RESTORE_PREVIEW_CHARS = 100000;

function errorOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function baseName(meta: EngineMeta): string {
  if (meta.path === null) {
    return "database";
  }
  const parts = meta.path.split("/");
  return parts[parts.length - 1] || "database";
}

export function DumpModal({ conn, meta, dialect, initialTab, onClose, onRestored }: DumpModalProps) {
  const [tab, setTab] = useState<"backup" | "restore">(initialTab);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(meta.tables));
  const [includeDdl, setIncludeDdl] = useState(true);
  const [includeData, setIncludeData] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Where a failed restore stopped, shown above the database's own error (whose
  // explanation would otherwise hide it); only while that error is the one shown.
  const [failedAt, setFailedAt] = useState<{ error: string; text: string } | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [restoreFile, setRestoreFile] = useState("");
  const [restoreBytes, setRestoreBytes] = useState<ArrayBuffer | null>(null);
  const [restoreEncoding, setRestoreEncoding] = useState<string>(() => getSettings().csvEncoding);
  const [restoreProgress, setRestoreProgress] = useState<{ done: number; total: number } | null>(null);
  // The running restore's job: Stop here and in the jobs queue both cancel it.
  const restoreJobRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const restoreText = useMemo(
    () => (restoreBytes === null ? "" : decodeText(restoreBytes, restoreEncoding)),
    [restoreBytes, restoreEncoding],
  );
  const restoreRanges = useMemo(() => splitSqlRanges(restoreText, dialect), [restoreText, dialect]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape" && !busy) {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  function toggleTable(name: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }

  async function runBackup(): Promise<void> {
    const tables = meta.tables.filter((name) => selected.has(name));
    if (tables.length === 0 || busy) {
      return;
    }
    // An import's rows aren't committed yet: a backup now would hold them.
    if (store.inOwnTx(conn)) {
      setError(t("가져오기가 진행 중입니다. 끝난 뒤 다시 실행하세요."));
      return;
    }
    const job = startJob(t("백업"), t("{count}개 테이블", { count: tables.length }), tables.length);
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      // The file reads the same whatever the UI language, so backups compare.
      const parts: string[] = [
        "-- TablePeek SQL dump",
        `-- Engine: ${meta.kind}`,
        `-- Created: ${new Date().toISOString()}`,
        "",
      ];
      // Structures first: tables go parents first, so creates and inserts find
      // what they reference; each table's indexes follow its rows, and foreign
      // keys are added after all the rows (the servers' CREATE TABLE text has
      // neither; SQLite's carries both).
      const details = new Map<string, TableDetail>();
      const failures = new Map<string, unknown>();
      for (const table of tables) {
        try {
          details.set(table, await store.fetchTableDetail(conn, table));
        } catch (err) {
          failures.set(table, err);
        }
      }
      const keysAfter = includeDdl && !dialect.keysInCreate;
      if (dialect.dumpBefore !== undefined) {
        parts.push(dialect.dumpBefore, "");
      }
      let tableIndex = 0;
      for (const table of dependencyOrder(tables, (name) => details.get(name)?.foreign_keys.map((fk) => fk.ref_table) ?? [])) {
        tableIndex += 1;
        job.update(tableIndex - 1, table);
        const detail = details.get(table);
        if (detail === undefined) {
          parts.push(
            // A multi-line reason would leave the comment and run as SQL on restore.
            `-- ${table}: skipped (${errorOf(failures.get(table), "could not read the structure").replace(/\s+/g, " ")})`,
          );
          parts.push("");
          job.update(tableIndex, t("{table} 건너뜀", { table }));
          continue;
        }
        parts.push(`-- ${table}`);
        if (includeDdl) {
          if (detail.ddl !== null) {
            parts.push(`${detail.ddl.trim().replace(/;?$/, ";")}`);
          } else {
            const drafts = draftsFromDetail(detail);
            const created = createTableSql(
              dialect,
              table,
              dialect.keysInCreate ? drafts : { ...drafts, indexes: [], foreignKeys: [] },
            );
            for (const statement of created.statements) {
              parts.push(`${statement};`);
            }
          }
        }
        if (includeData) {
          const pkIndex = detail.indexes.find((index) => index.primary);
          const pk = pkIndex?.columns ?? detail.columns.filter((c) => c.pk).map((c) => c.name);
          const order = pk.length > 0 ? pk.map((name) => quoteIdent(dialect, name)).join(", ") : null;
          const binary = (columns: string[]) => declaredAs("binary", columns, detail, dialect);
          if (order === null) {
            // No key to page by, and a table's order can change between two
            // reads: one read, so no row is skipped or copied twice.
            const detached = await store.runDetached(conn, `SELECT * FROM ${quoteIdent(dialect, table)}`, TABLE_ROW_CAP);
            try {
              const rows = await collectRows(detached.source);
              if (rows.length > 0) {
                parts.push(toSqlInserts(table, detached.meta.columns, rows, dialect, binary(detached.meta.columns)));
              }
              job.update(tableIndex - 1, `${table} · ${t("{count}행", { count: rows.length.toLocaleString() })}`);
              if (detached.meta.truncated) {
                parts.push(`-- ${table}: cut off at ${TABLE_ROW_CAP} rows (limit)`);
              }
            } finally {
              detached.source.dispose();
            }
          } else {
            let offset = 0;
            let copied = 0;
            for (;;) {
              if (copied >= TABLE_ROW_CAP) {
                parts.push(
                  `-- ${table}: cut off at ${TABLE_ROW_CAP} rows (limit)`,
                );
                break;
              }
              const sql = `SELECT * FROM ${quoteIdent(dialect, table)} ${rowWindowSql(dialect, order, PAGE_SIZE, offset)}`;
              const detached = await store.runDetached(conn, sql, PAGE_SIZE);
              try {
                const rows = await collectRows(detached.source);
                if (rows.length === 0) {
                  break;
                }
                parts.push(toSqlInserts(table, detached.meta.columns, rows, dialect, binary(detached.meta.columns)));
                copied += rows.length;
                offset += rows.length;
                job.update(tableIndex - 1, `${table} · ${t("{count}행", { count: copied.toLocaleString() })}`);
                if (rows.length < PAGE_SIZE) {
                  break;
                }
              } finally {
                detached.source.dispose();
              }
            }
          }
        }
        if (includeDdl) {
          for (const statement of dumpIndexSql(dialect, table, detail)) {
            parts.push(`${statement};`);
          }
        }
        parts.push("");
        job.update(tableIndex, table);
      }
      const keys = keysAfter
        ? tables.flatMap((table) => details.get(table)?.foreign_keys.map((fk) => `${foreignKeySql(dialect, table, fk)};`) ?? [])
        : [];
      if (keys.length > 0) {
        parts.push("-- Foreign keys", ...keys, "");
      }
      if (dialect.dumpAfter !== undefined) {
        parts.push(dialect.dumpAfter, "");
      }
      const text = parts.join("\n");
      downloadBlob(suggestFilename(`${baseName(meta)}_backup`, "sql"), text, EXPORT_MIME.sql);
      job.finish();
      setInfo(t("백업 파일을 만들었습니다"));
    } catch (err) {
      const message = errorOf(err, t("백업에 실패했습니다"));
      job.fail(message);
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function pickRestoreFile(file: File): Promise<void> {
    setRestoreFile(file.name);
    setError(null);
    setInfo(null);
    try {
      setRestoreBytes(await file.arrayBuffer());
    } catch (err) {
      setError(errorOf(err, t("파일을 읽지 못했습니다")));
    }
  }

  // The file's statements run one by one, as written: a dump brings its own
  // BEGIN and COMMIT (or none), so they aren't wrapped in a transaction, and
  // what ran before a failure or a stop stays. A transaction the user has
  // open is refused: the dump's COMMIT would end it.
  async function runRestore(): Promise<void> {
    const statements = restoreRanges;
    if (statements.length === 0 || busy) {
      return;
    }
    // The connection is the restore's until its last statement: the page's
    // writes and TX controls wait (a COMMIT in the dump would end their
    // transaction, or theirs the dump's), and its reads can't cancel the
    // dump's statements. Refused while the user's transaction or an import
    // holds it.
    setBusy(true);
    try {
      await store.claimConn(conn);
    } catch (err) {
      setBusy(false);
      setError(errorOf(err, t("복원에 실패했습니다")));
      return;
    }
    const job = startJob(t("복원"), restoreFile, statements.length, {
      cancellable: true,
      // A statement still running (a big INSERT, one waiting on a lock) stops too.
      onCancel: () => store.cancelJobStatement(conn),
    });
    restoreJobRef.current = job.id;
    setError(null);
    setInfo(null);
    setRestoreProgress({ done: 0, total: statements.length });
    // Shown in the window while it is open, in the status line once it isn't.
    const report = (message: string, failed: boolean): void => {
      if (mountedRef.current) {
        (failed ? setError : setInfo)(message);
      } else {
        (failed ? notifyError : store.setInfo)(message);
      }
    };
    let executed = 0;
    // What the dump may change for its run (foreign key checks, search_path),
    // put back below however far it gets.
    const snapshot = dialect.sessionSnapshot;
    let settings: unknown[] | undefined;
    if (snapshot !== undefined) {
      try {
        settings = (await store.exec(conn, snapshot, { job: true })).rows[0] as unknown[] | undefined;
      } catch {
        settings = undefined;
      }
    }
    try {
      for (const statement of statements) {
        if (job.signal.aborted) {
          break;
        }
        await store.exec(conn, statement.text, { job: true });
        executed += 1;
        job.update(executed);
        if (mountedRef.current) {
          setRestoreProgress({ done: executed, total: statements.length });
        }
      }
      // Stopped while the last statement ran: all of them did, but not as asked.
      if (executed < statements.length || job.signal.aborted) {
        const message = t("{count}개 문장을 실행한 뒤 중지했습니다. 실행한 문장은 되돌리지 않습니다.", {
          count: executed.toLocaleString(),
        });
        job.fail(message);
        report(message, true);
      } else {
        job.finish();
        report(t("{count}개 문장을 실행했습니다", { count: statements.length.toLocaleString() }), false);
      }
    } catch (err) {
      const failure = errorOf(err, t("복원에 실패했습니다"));
      // Stop interrupted the statement in flight: it failed because it was stopped.
      if (job.signal.aborted) {
        const message = t("{count}개 문장을 실행한 뒤 중지했습니다. 실행한 문장은 되돌리지 않습니다.", {
          count: executed.toLocaleString(),
        });
        job.fail(message);
        report(message, true);
        return;
      }
      const line = restoreText.slice(0, statements[executed].codeFrom).split("\n").length;
      job.fail(failure);
      const where = { index: (executed + 1).toLocaleString(), line: line.toLocaleString() };
      if (mountedRef.current) {
        setError(failure);
        setFailedAt({ error: failure, text: t("문장 {index}, {line}번째 줄에서 중단했습니다", where) });
      } else {
        notifyError(t("{error} (문장 {index}, {line}번째 줄에서 중단)", { error: failure, ...where }));
      }
    } finally {
      const putBack = settings === undefined ? null : (dialect.restoreSession?.(settings) ?? null);
      if (putBack !== null) {
        try {
          await store.exec(conn, putBack, { job: true });
        } catch (err) {
          report(t("복원 뒤 세션 설정(외래 키 검사 등)을 되돌리지 못했습니다: {error}", { error: errorOf(err, "") }), true);
        }
      }
      await store.releaseConn(conn);
      restoreJobRef.current = null;
      if (mountedRef.current) {
        setBusy(false);
        setRestoreProgress(null);
      }
      if (executed > 0) {
        onRestored();
      }
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => (busy ? undefined : onClose())}>
      <div className="modal dump-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{t("SQL 덤프")}</span>
          <span className="modal-path">{`${meta.kind} · ${baseName(meta)}`}</span>
          <span className="spacer" />
          <div className="view-tabs">
            <button
              type="button"
              className={tab === "backup" ? "active" : ""}
              disabled={busy}
              onClick={() => setTab("backup")}
            >
              {t("백업")}
            </button>
            <button
              type="button"
              className={tab === "restore" ? "active" : ""}
              disabled={busy}
              onClick={() => setTab("restore")}
            >
              {t("복원")}
            </button>
          </div>
        </div>
        <div className="modal-body dump-body">
          {error && failedAt?.error === error ? <div className="import-failed-at">{failedAt.text}</div> : null}
          {error ? <ErrorNotice error={error} context="export" /> : null}
          {info ? <div className="helper">{info}</div> : null}
          {tab === "backup" ? (
            <>
              <section className="export-section">
                <div className="section-title">
                  {t("테이블")}
                  <span className="panel-count">{`${selected.size} / ${meta.tables.length}`}</span>
                  <span className="spacer" />
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setSelected(new Set(meta.tables))}
                  >
                    {t("모두 선택")}
                  </button>
                  <button type="button" className="link-button" onClick={() => setSelected(new Set())}>
                    {t("모두 해제")}
                  </button>
                </div>
                <div className="dump-tables">
                  {meta.tables.map((name) => (
                    <label className="check-row inline" key={name}>
                      <input
                        type="checkbox"
                        checked={selected.has(name)}
                        disabled={busy}
                        onChange={() => toggleTable(name)}
                      />
                      <span className="mono">{name}</span>
                    </label>
                  ))}
                </div>
              </section>
              <section className="export-section">
                <div className="section-title">{t("포함")}</div>
                <div className="create-inline">
                  <label className="check-row inline">
                    <input
                      type="checkbox"
                      checked={includeDdl}
                      disabled={busy}
                      onChange={(event) => setIncludeDdl(event.target.checked)}
                    />
                    <span>DDL (CREATE)</span>
                  </label>
                  <label className="check-row inline">
                    <input
                      type="checkbox"
                      checked={includeData}
                      disabled={busy}
                      onChange={(event) => setIncludeData(event.target.checked)}
                    />
                    <span>{t("데이터 (INSERT)")}</span>
                  </label>
                </div>
                <p className="helper">
                  {t("테이블당 최대 {count}행까지 포함합니다", { count: TABLE_ROW_CAP.toLocaleString() })}
                </p>
              </section>
            </>
          ) : (
            <section className="export-section">
              <div className="section-title">{t("SQL 파일")}</div>
              <div className="create-inline">
                <label className="file-button">
                  <FolderIcon size={12} />
                  {t("파일 선택")}
                  <input
                    type="file"
                    accept=".sql,.txt"
                    disabled={busy}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) {
                        void pickRestoreFile(file);
                      }
                    }}
                  />
                </label>
                {restoreFile ? <span className="dim">{restoreFile}</span> : null}
                <label className="field">
                  <span>{t("인코딩")}</span>
                  <Select
                    value={restoreEncoding}
                    disabled={busy}
                    onChange={(event) => setRestoreEncoding(event.target.value)}
                  >
                    {IMPORT_ENCODINGS.map((entry) => (
                      <option value={entry} key={entry}>
                        {ENCODING_LABELS[entry]}
                      </option>
                    ))}
                  </Select>
                </label>
                {restoreBytes !== null ? (
                  <span className="panel-count">
                    {t("{count}개 문장", { count: restoreRanges.length.toLocaleString() })}
                  </span>
                ) : null}
              </div>
              {restoreBytes !== null ? (
                <pre className="dump-sql-preview">
                  {restoreText.length > RESTORE_PREVIEW_CHARS
                    ? `${restoreText.slice(0, RESTORE_PREVIEW_CHARS)}\n…`
                    : restoreText}
                </pre>
              ) : null}
              <p className="helper">
                {restoreProgress !== null
                  ? t("{done} / {total}개 문장 실행 중", {
                      done: restoreProgress.done.toLocaleString(),
                      total: restoreProgress.total.toLocaleString(),
                    })
                  : t("문장 단위로 나누어 현재 데이터베이스에서 순서대로 실행합니다. 실패하면 그 문장에서 멈추고, 앞서 실행한 문장은 남습니다.")}
              </p>
            </section>
          )}
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" disabled={busy} onClick={onClose}>
            {t("닫기")}
          </button>
          {tab === "backup" ? (
            <button
              type="button"
              className="primary"
              disabled={busy || selected.size === 0 || (!includeDdl && !includeData)}
              onClick={() => void runBackup()}
            >
              {t("백업 다운로드")}
            </button>
          ) : restoreProgress !== null ? (
            <>
              <button type="button" onClick={onClose}>
                {t("백그라운드에서 계속")}
              </button>
              <button type="button" onClick={() => restoreJobRef.current !== null && cancelJob(restoreJobRef.current)}>
                <StopIcon size={10} />
                {t("중지")}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={busy || restoreRanges.length === 0}
              onClick={() => void runRestore()}
            >
              {t("복원 실행")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
