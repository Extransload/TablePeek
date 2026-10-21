import { useEffect, useState } from "react";
import { createTableSql, draftsFromDetail, quoteIdent } from "../ddl";
import { collectRows, downloadBlob, EXPORT_MIME, suggestFilename, toSqlInserts } from "../export";
import { t } from "../i18n";
import { startJob } from "../jobs";
import { splitSqlStatements } from "../sqlSplit";
import { store, type EngineMeta, type TableDetail } from "../store";
import { ErrorNotice } from "./ErrorNotice";
import { FolderIcon } from "./icons";

interface DumpModalProps {
  conn: string;
  meta: EngineMeta;
  initialTab: "backup" | "restore";
  onClose(): void;
  onRestored(): void;
}

const PAGE_SIZE = 5000;
const TABLE_ROW_CAP = 200000;

function errorOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function baseName(meta: EngineMeta): string {
  if (meta.path === null) {
    return meta.kind === "sqlite" ? "database" : "database";
  }
  const parts = meta.path.split("/");
  return parts[parts.length - 1] || "database";
}

export function DumpModal({ conn, meta, initialTab, onClose, onRestored }: DumpModalProps) {
  const [tab, setTab] = useState<"backup" | "restore">(initialTab);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(meta.tables));
  const [includeDdl, setIncludeDdl] = useState(true);
  const [includeData, setIncludeData] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [restoreFile, setRestoreFile] = useState("");
  const [restoreText, setRestoreText] = useState("");

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
      let tableIndex = 0;
      for (const table of tables) {
        tableIndex += 1;
        job.update(tableIndex - 1, table);
        let detail: TableDetail;
        try {
          detail = await store.fetchTableDetail(conn, table);
        } catch (err) {
          parts.push(
            // A multi-line reason would leave the comment and run as SQL on restore.
            `-- ${table}: skipped (${errorOf(err, "could not read the structure").replace(/\s+/g, " ")})`,
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
            const created = createTableSql(
              meta.kind,
              table,
              draftsFromDetail(detail),
            );
            for (const statement of created.statements) {
              parts.push(`${statement};`);
            }
          }
        }
        if (includeData) {
          const pkIndex = detail.indexes.find((index) => index.primary);
          const pk = pkIndex?.columns ?? detail.columns.filter((c) => c.pk).map((c) => c.name);
          const order = pk.length > 0 ? ` ORDER BY ${pk.map((name) => quoteIdent(meta.kind, name)).join(", ")}` : "";
          let offset = 0;
          let copied = 0;
          for (;;) {
            if (copied >= TABLE_ROW_CAP) {
              parts.push(
                `-- ${table}: cut off at ${TABLE_ROW_CAP} rows (limit)`,
              );
              break;
            }
            const sql = `SELECT * FROM ${quoteIdent(meta.kind, table)}${order} LIMIT ${PAGE_SIZE} OFFSET ${offset}`;
            const detached = await store.runDetached(conn, sql, PAGE_SIZE);
            try {
              const rows = await collectRows(detached.source);
              if (rows.length === 0) {
                break;
              }
              parts.push(toSqlInserts(table, detached.meta.columns, rows, meta.kind));
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
        parts.push("");
        job.update(tableIndex, table);
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
      const text = await file.text();
      setRestoreText(text);
      const count = splitSqlStatements(text).length;
      setInfo(t("{count}개 문장", { count: count.toLocaleString() }));
    } catch (err) {
      setError(errorOf(err, t("파일을 읽지 못했습니다")));
    }
  }

  async function runRestore(): Promise<void> {
    if (restoreText === "" || busy) {
      return;
    }
    const statements = splitSqlStatements(restoreText);
    if (statements.length === 0) {
      return;
    }
    const job = startJob(t("복원"), restoreFile, statements.length);
    setBusy(true);
    setError(null);
    let executed = 0;
    try {
      for (const statement of statements) {
        await store.exec(conn, statement);
        executed += 1;
        job.update(executed);
      }
      job.finish();
      setInfo(t("{count}개 문장을 실행했습니다", { count: statements.length.toLocaleString() }));
      onRestored();
    } catch (err) {
      const failure = errorOf(err, t("복원에 실패했습니다"));
      const message = t("{error} (문장 {index}에서 중단)", { error: failure, index: executed + 1 });
      job.fail(failure);
      setError(message);
    } finally {
      setBusy(false);
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
          {error ? <ErrorNotice message={error} /> : null}
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
                      if (file) {
                        void pickRestoreFile(file);
                      }
                    }}
                  />
                </label>
                {restoreFile ? <span className="dim">{restoreFile}</span> : null}
              </div>
              <p className="helper">{t("문장 단위로 나누어 순서대로 실행합니다. 실패 시 중단됩니다.")}</p>
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
          ) : (
            <button
              type="button"
              className="primary"
              disabled={busy || restoreText === ""}
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
