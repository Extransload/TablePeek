import { useEffect, useRef, useState } from "react";
import { escapeSqlIdentifier, quoteIdentifier } from "../dataQuery";
import { capabilitiesOf } from "../engines";
import { createTableSql, dependencyOrder, draftsFromDetail, dumpIndexSql, foreignKeySql, quoteIdent } from "../ddl";
import { suggestFilename } from "../export";
import { declaredAs } from "../grid/columns";
import { t } from "../i18n";
import { formatBytes } from "../format";
import { decoderFor, ENCODING_LABELS, IMPORT_ENCODINGS } from "../importParse";
import { cancelJob, startJob } from "../jobs";
import type { SqlDialect } from "../engines/sqlDialect";
import { getSettings } from "../settings";
import { store, type DumpProgress, type DumpTablePlan, type EngineMeta, type TableDetail } from "../store";
import { ErrorNotice, notifyError } from "./ErrorNotice";
import { FolderIcon, StopIcon } from "./icons";
import { Select } from "./Select";
import { SqlPreview } from "./SqlEditor";

interface DumpModalProps {
  conn: string;
  meta: EngineMeta;
  dialect: SqlDialect;
  initialTab: "backup" | "restore";
  onClose(): void;
  onRestored(): void;
}

// How often a running backup or restore is asked how far it has got.
const BACKUP_POLL_MS = 300;
const RESTORE_POLL_MS = 250;
// The start of an SQL file shown before it runs, as TablePlus previews it.
const RESTORE_PREVIEW_BYTES = 100000;

function errorOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

// Text written as lines: each one ends with "\n".
function lines(items: string[]): string {
  return items.map((item) => `${item}\n`).join("");
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
  // The file goes to the server as it is, straight from disk (a dump runs to
  // gigabytes); only its start is read here, for the preview.
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restorePreview, setRestorePreview] = useState("");
  const [restoreEncoding, setRestoreEncoding] = useState<string>(() => getSettings().csvEncoding);
  const [restoreProgress, setRestoreProgress] = useState<{ statements: number; bytes: number } | null>(null);
  // Run the file in one transaction: one commit at the end instead of one
  // per statement, and a failure or a stop rolls it all back.
  const [restoreInOne, setRestoreInOne] = useState(false);
  const transactional = capabilitiesOf(meta)?.transactions !== "none";
  // How far the running backup has got, as a line of text; null when none runs.
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  // The running restore's and backup's jobs: Stop here and in the jobs queue both cancel them.
  const restoreJobRef = useRef<string | null>(null);
  const backupJobRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    if (restoreFile === null) {
      setRestorePreview("");
      return;
    }
    let live = true;
    void (async () => {
      try {
        const head = new Uint8Array(await restoreFile.slice(0, RESTORE_PREVIEW_BYTES).arrayBuffer());
        // Streamed, so a character cut at the end is left out, not garbled.
        const text = decoderFor(head, restoreEncoding).decode(head, { stream: restoreFile.size > head.length });
        if (live) {
          setRestorePreview(restoreFile.size > head.length ? `${text}\n…` : text);
        }
      } catch (err) {
        if (live) {
          setRestorePreview("");
          setError(`${t("파일을 읽지 못했습니다")}: ${errorOf(err, "")}`);
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [restoreFile, restoreEncoding]);

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

  // Shown in the window while it is open, in the status line once it isn't.
  function report(message: string, failed: boolean): void {
    if (mountedRef.current) {
      (failed ? setError : setInfo)(message);
    } else {
      (failed ? notifyError : store.setInfo)(message);
    }
  }

  // The page lays the file out (comments, structures, indexes, keys) and
  // the server writes it, each table's rows read straight from the database
  // as INSERT statements, into a download the browser saves as it comes:
  // no row limit, and the page never holds the file.
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
    // Set once the server has the plan; a stop before then ends it here.
    let dumpId: string | null = null;
    const job = startJob(t("백업"), t("{count}개 테이블", { count: tables.length }), tables.length, {
      cancellable: true,
      onCancel: () => {
        if (dumpId !== null) {
          void store.stopDump(conn, dumpId).catch(() => undefined);
        }
      },
    });
    backupJobRef.current = job.id;
    setBusy(true);
    setError(null);
    setInfo(null);
    setBackupStatus(t("테이블 구조를 읽는 중…"));
    const stopped = t("백업을 중지했습니다");
    try {
      // Structures first: tables go parents first, so creates and inserts find
      // what they reference; each table's indexes follow its rows, and foreign
      // keys are added after all the rows (the servers' CREATE TABLE text has
      // neither; SQLite's carries both).
      const details = new Map<string, TableDetail>();
      const failures = new Map<string, unknown>();
      for (const table of tables) {
        if (job.signal.aborted) {
          break;
        }
        try {
          details.set(table, await store.fetchTableDetail(conn, table));
        } catch (err) {
          failures.set(table, err);
        }
      }
      if (job.signal.aborted) {
        report(stopped, false);
        return;
      }
      const keysAfter = includeDdl && !dialect.keysInCreate;
      // The engine pages by the server's token: its rows come in its own
      // order, not the key's.
      const cursor = capabilitiesOf(meta)?.cursor_paging === true;
      const skipped = new Set<string>();
      const plan: DumpTablePlan[] = [];
      for (const table of dependencyOrder(tables, (name) => details.get(name)?.foreign_keys.map((fk) => fk.ref_table) ?? [])) {
        const detail = details.get(table);
        // Named as toSqlInserts names a table, for the INSERTs the server writes.
        const target = quoteIdentifier(table, dialect);
        if (detail === undefined) {
          skipped.add(table);
          plan.push({
            name: table,
            before: lines([
              // A multi-line reason would leave the comment and run as SQL on restore.
              `-- ${table}: skipped (${errorOf(failures.get(table), "could not read the structure").replace(/\s+/g, " ")})`,
              "",
            ]),
            select: null,
            target,
            columns: [],
            single_row: dialect.singleRowValues === true,
            after: "",
          });
          continue;
        }
        const before = [`-- ${table}`];
        if (includeDdl) {
          if (detail.ddl !== null) {
            before.push(`${detail.ddl.trim().replace(/;?$/, ";")}`);
          } else {
            const drafts = draftsFromDetail(detail);
            const created = createTableSql(
              dialect,
              table,
              dialect.keysInCreate ? drafts : { ...drafts, indexes: [], foreignKeys: [] },
            );
            for (const statement of created.statements) {
              before.push(`${statement};`);
            }
          }
        }
        let select: string | null = null;
        if (includeData) {
          const pkIndex = detail.indexes.find((index) => index.primary);
          const pk = pkIndex?.columns ?? detail.columns.filter((c) => c.pk).map((c) => c.name);
          const order =
            pk.length > 0 && dialect.keyOrder !== false && !cursor
              ? pk.map((name) => quoteIdent(dialect, name)).join(", ")
              : null;
          select = `SELECT * FROM ${quoteIdent(dialect, table)}${order !== null ? ` ORDER BY ${order}` : ""}`;
        }
        const names = detail.columns.map((column) => column.name);
        const binary = declaredAs("binary", names, detail, dialect);
        const after = includeDdl ? dumpIndexSql(dialect, table, detail).map((statement) => `${statement};`) : [];
        plan.push({
          name: table,
          before: lines(before),
          select,
          target,
          columns: detail.columns.map((column, c) => ({
            name: column.name,
            quoted: escapeSqlIdentifier(column.name, dialect),
            binary: binary[c] === true,
            declared: column.decl_type ?? null,
          })),
          single_row: dialect.singleRowValues === true,
          after: lines([...after, ""]),
        });
      }
      // The file reads the same whatever the UI language, so backups compare.
      const head = lines([
        "-- TablePeek SQL dump",
        `-- Engine: ${meta.kind}`,
        `-- Created: ${new Date().toISOString()}`,
        "",
        ...(dialect.dumpBefore !== undefined ? [dialect.dumpBefore, ""] : []),
      ]);
      const keys = keysAfter
        ? tables.flatMap((table) => details.get(table)?.foreign_keys.map((fk) => `${foreignKeySql(dialect, table, fk)};`) ?? [])
        : [];
      let tail = lines([
        ...(keys.length > 0 ? ["-- Foreign keys", ...keys, ""] : []),
        ...(dialect.dumpAfter !== undefined ? [dialect.dumpAfter, ""] : []),
      ]);
      // The file's last line is a blank one, and no "\n" follows it.
      const last = plan[plan.length - 1];
      if (tail !== "") {
        tail = tail.slice(0, -1);
      } else if (last.after !== "") {
        last.after = last.after.slice(0, -1);
      } else {
        last.before = last.before.slice(0, -1);
      }
      const id = await store.startDump(conn, {
        filename: suggestFilename(`${baseName(meta)}_backup`, "sql"),
        head,
        tables: plan,
        tail,
      });
      dumpId = id;
      // Stopped while the server took the plan: its onCancel had no id to stop.
      if (job.signal.aborted) {
        void store.stopDump(conn, id).catch(() => undefined);
        report(stopped, false);
        return;
      }
      // The browser downloads the file itself, as the server writes it.
      const link = document.createElement("a");
      link.href = store.dumpDownloadUrl(conn, id);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      for (;;) {
        await new Promise((resolve) => window.setTimeout(resolve, BACKUP_POLL_MS));
        if (job.signal.aborted) {
          report(stopped, false);
          return;
        }
        const progress: DumpProgress = await store.dumpProgress(conn, id);
        if (progress.state === "done") {
          job.finish();
          report(t("백업 파일을 만들었습니다"), false);
          return;
        }
        if (progress.state === "failed") {
          const message = errorOf(progress.error, t("백업에 실패했습니다"));
          job.fail(message);
          report(message, true);
          return;
        }
        if (progress.state === "stopped") {
          job.fail(stopped);
          report(stopped, false);
          return;
        }
        const table = progress.table;
        const where =
          table === null
            ? null
            : skipped.has(table)
              ? t("{table} 건너뜀", { table })
              : progress.rows > 0
                ? `${table} · ${t("{count}행", { count: progress.rows.toLocaleString() })}`
                : table;
        if (progress.state === "waiting") {
          job.update(0, t("내려받기를 기다리는 중…"));
        } else if (where !== null) {
          job.update(progress.tables_done, where);
        } else {
          job.update(progress.tables_done);
        }
        if (mountedRef.current) {
          setBackupStatus(
            progress.state === "waiting"
              ? t("내려받기를 기다리는 중…")
              : `${t("테이블 {done} / {total} · {bytes}", {
                  done: progress.tables_done.toLocaleString(),
                  total: progress.tables.toLocaleString(),
                  bytes: formatBytes(progress.bytes) ?? "",
                })}${where !== null ? ` · ${where}` : ""}`,
          );
        }
      }
    } catch (err) {
      if (job.signal.aborted) {
        report(stopped, false);
        return;
      }
      const message = errorOf(err, t("백업에 실패했습니다"));
      job.fail(message);
      report(message, true);
    } finally {
      backupJobRef.current = null;
      if (mountedRef.current) {
        setBusy(false);
        setBackupStatus(null);
      }
    }
  }

  function pickRestoreFile(file: File): void {
    setRestoreFile(file);
    setError(null);
    setFailedAt(null);
    setInfo(null);
  }

  // The server splits the file into statements and runs them one by one, as
  // written: a dump brings its own BEGIN and COMMIT (or none), so they aren't
  // wrapped in a transaction, and what ran before a failure or a stop stays.
  // A transaction the user has open is refused: the dump's COMMIT would end it.
  async function runRestore(): Promise<void> {
    const file = restoreFile;
    if (file === null || busy) {
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
    // Names the run on the server, for its progress and Stop.
    const id = crypto.randomUUID();
    const job = startJob(t("복원"), file.name, file.size, {
      cancellable: true,
      // The server stops after the statement running, or cancels it (a big
      // INSERT, one waiting on a lock); the upload's reply then says so.
      onCancel: () => void store.stopRestore(conn, id).catch(() => undefined),
      unit: "bytes",
    });
    restoreJobRef.current = job.id;
    setError(null);
    setFailedAt(null);
    setInfo(null);
    setRestoreProgress({ statements: 0, bytes: 0 });
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
    // Until the reply: a progress read that comes back after it is dropped.
    let running = true;
    const poll = window.setInterval(() => {
      void store.restoreProgress(conn, id).then(
        (progress) => {
          if (!running) {
            return;
          }
          executed = progress.statements;
          job.update(progress.bytes);
          if (mountedRef.current) {
            setRestoreProgress(progress);
          }
        },
        // Not started on the server yet, or just finished.
        () => undefined,
      );
    }, RESTORE_POLL_MS);
    try {
      const inOne = restoreInOne && transactional;
      const outcome = await store.restoreSql(conn, id, file, restoreEncoding, dialect.lexing, inOne);
      executed = outcome.statements;
      const failure = outcome.failure;
      // Added to a failure's message when the transaction was taken back.
      const undone = outcome.rolledBack ? ` · ${t("트랜잭션을 되돌렸습니다")}` : "";
      // A stop asked for while the last statement ran still counts: they all
      // ran, but not as asked.
      if (outcome.stopped || job.signal.aborted) {
        const message = outcome.rolledBack
          ? t("{count}개 문장을 실행하다 중지하고 트랜잭션을 되돌렸습니다", { count: executed.toLocaleString() })
          : t("{count}개 문장을 실행한 뒤 중지했습니다. 실행한 문장은 되돌리지 않습니다.", {
              count: executed.toLocaleString(),
            });
        job.fail(message);
        report(message, true);
      } else if (failure === null) {
        job.finish();
        report(t("{count}개 문장을 실행했습니다", { count: executed.toLocaleString() }), false);
      } else if (failure.stage === "read") {
        const message = `${t("파일을 읽지 못했습니다")}: ${errorOf(failure.error, "")}${undone}`;
        job.fail(message);
        report(message, true);
      } else if (failure.stage === "commit" || failure.statement === null) {
        const message = `${t("커밋하지 못했습니다")}: ${errorOf(failure.error, "")}`;
        job.fail(message);
        report(message, true);
      } else {
        const message = errorOf(failure.error, t("복원에 실패했습니다"));
        job.fail(message);
        const index = failure.statement.toLocaleString();
        const line = failure.line;
        if (mountedRef.current) {
          setError(message);
          setFailedAt({
            error: message,
            text: `${
              line !== null
                ? t("문장 {index}, {line}번째 줄에서 중단했습니다", { index, line: line.toLocaleString() })
                : t("문장 {index}에서 중단했습니다", { index })
            }${undone}`,
          });
        } else {
          notifyError(
            `${
              line !== null
                ? t("{error} (문장 {index}, {line}번째 줄에서 중단)", { error: message, index, line: line.toLocaleString() })
                : t("{error} (문장 {index}에서 중단)", { error: message, index })
            }${undone}`,
          );
        }
      }
    } catch (err) {
      // The upload failed: Stop was asked for, or the server is out of reach.
      const message = job.signal.aborted
        ? t("{count}개 문장을 실행한 뒤 중지했습니다. 실행한 문장은 되돌리지 않습니다.", {
            count: executed.toLocaleString(),
          })
        : errorOf(err, t("복원에 실패했습니다"));
      job.fail(message);
      report(message, true);
    } finally {
      running = false;
      window.clearInterval(poll);
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
                {backupStatus !== null ? <p className="helper">{backupStatus}</p> : null}
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
                        pickRestoreFile(file);
                      }
                    }}
                  />
                </label>
                {restoreFile !== null ? <span className="dim">{restoreFile.name}</span> : null}
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
                {restoreFile !== null ? <span className="panel-count">{formatBytes(restoreFile.size)}</span> : null}
              </div>
              {restorePreview !== "" ? (
                <div className="dump-sql-preview">
                  <SqlPreview doc={restorePreview} dialect={dialect} />
                </div>
              ) : null}
              {transactional ? (
                <label className="check-row inline">
                  <input
                    type="checkbox"
                    checked={restoreInOne}
                    disabled={busy}
                    onChange={(event) => setRestoreInOne(event.target.checked)}
                  />
                  <span>{t("한 트랜잭션으로 실행")}</span>
                </label>
              ) : null}
              <p className="helper">
                {restoreProgress !== null && restoreFile !== null
                  ? t("{count}개 문장 실행 · {done} / {total} 읽음", {
                      count: restoreProgress.statements.toLocaleString(),
                      done: formatBytes(restoreProgress.bytes) ?? "",
                      total: formatBytes(restoreFile.size) ?? "",
                    })
                  : restoreInOne && transactional
                    ? t("문장마다 커밋하지 않고 끝에 한 번 커밋해 빠릅니다. 실패하거나 중지하면 모두 되돌립니다(MySQL·MariaDB·Oracle은 CREATE 같은 DDL이 그 앞까지를 커밋합니다). 파일에 BEGIN·COMMIT이 있으면 실행하지 않습니다.")
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
            backupStatus !== null ? (
              <>
                <button type="button" onClick={onClose}>
                  {t("백그라운드에서 계속")}
                </button>
                <button type="button" onClick={() => backupJobRef.current !== null && cancelJob(backupJobRef.current)}>
                  <StopIcon size={10} />
                  {t("중지")}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={busy || selected.size === 0 || (!includeDdl && !includeData)}
                onClick={() => void runBackup()}
              >
                {t("백업 다운로드")}
              </button>
            )
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
              disabled={busy || restoreFile === null}
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
