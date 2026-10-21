import { useEffect, useMemo, useRef, useState } from "react";
import { addActivity } from "../activity";
import { writeClipboard } from "../clipboard";
import { diffStructure, draftsFromDetail, type StructureDraft } from "../ddl";
import { formatBytes, formatRowEstimate } from "../format";
import { store, type TableDetail } from "../store";
import { ColumnsEditor, DdlPreview, FksEditor, IndexesEditor } from "./DraftEditors";
import { t } from "../i18n";
import { ErrorNotice } from "./ErrorNotice";
import {
  ColumnsIcon,
  CopyIcon,
  KeyIcon,
  LinkIcon,
  PencilIcon,
  RefreshIcon,
  TableIcon,
} from "./icons";
import { Spinner } from "./Spinner";

interface StructurePanelProps {
  conn: string;
  kind: string;
  table: string;
  data: TableDetail | undefined;
  exactRows: boolean;
  onData(data: TableDetail): void;
  onChanged(): void;
}

function errorOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function StructurePanel({
  conn,
  kind,
  table,
  data,
  exactRows,
  onData,
  onChanged,
}: StructurePanelProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<StructureDraft | null>(null);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  useEffect(() => {
    if (nonce === 0 && data !== undefined) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const detail = await store.fetchTableDetail(conn, table);
        if (!cancelled) {
          onDataRef.current(detail);
        }
      } catch (err) {
        if (!cancelled) {
          setError(errorOf(err, "테이블 정보를 불러오지 못했습니다"));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conn, table, data, nonce]);

  const detail = data ?? null;
  const origDraft = useMemo(() => (detail === null ? null : draftsFromDetail(detail)), [detail]);
  const diff = useMemo(
    () =>
      editing && draft !== null && origDraft !== null
        ? diffStructure(kind, table, origDraft, draft)
        : null,
    [editing, draft, origDraft, kind, table],
  );

  const saveRef = useRef<() => Promise<void>>(async () => {});

  async function save(): Promise<void> {
    if (origDraft === null || draft === null) {
      return;
    }
    const result = diffStructure(kind, table, origDraft, draft);
    if (result.errors.length > 0) {
      setSaveError(result.errors.join("\n"));
      setPreview(true);
      return;
    }
    if (result.statements.length === 0) {
      setEditing(false);
      setDraft(null);
      store.setInfo("변경 사항이 없습니다");
      return;
    }
    setBusy(true);
    setSaveError(null);
    try {
      for (const statement of result.statements) {
        await store.exec(conn, statement);
      }
      store.setInfo(`구조를 변경했습니다 (${result.statements.length}문장)`);
      addActivity("ddl", `구조 변경: ${table}`, `${result.statements.length}문장`);
      setEditing(false);
      setDraft(null);
      setPreview(false);
      setNonce((value) => value + 1);
      onChanged();
    } catch (err) {
      setSaveError(errorOf(err, "구조 변경에 실패했습니다"));
    } finally {
      setBusy(false);
    }
  }
  saveRef.current = save;

  useEffect(() => {
    if (!editing) {
      return;
    }
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        event.stopPropagation();
        void saveRef.current();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [editing]);

  function startEdit(): void {
    if (detail === null) {
      return;
    }
    setDraft(draftsFromDetail(detail));
    setSaveError(null);
    setPreview(false);
    setEditing(true);
  }

  function cancelEdit(): void {
    setEditing(false);
    setDraft(null);
    setPreview(false);
    setSaveError(null);
  }

  const countText = detail ? formatRowEstimate(detail.row_count_estimate, exactRows) : null;
  const sizeText = detail ? formatBytes(detail.size_bytes) : null;

  function copyDdl(ddl: string): void {
    void writeClipboard(ddl, (message) => store.setError(message));
  }

  return (
    <div className="panel structure-panel">
      <div className="panel-head structure-head">
        <span className="panel-title">
          <TableIcon size={12} />
          {table}
        </span>
        <span className="structure-kind">{kind}</span>
        {countText ? <span className="panel-stat">{countText}</span> : null}
        {sizeText ? <span className="panel-stat">{sizeText}</span> : null}
        <span className="spacer" />
        {editing ? (
          <>
            {busy ? <span className="panel-dim">{t("실행 중…")}</span> : null}
            <button
              type="button"
              className={preview ? "icon-text-button active" : "icon-text-button"}
              onClick={() => setPreview((value) => !value)}
              title={t("미리보기")}
            >
              {t("미리보기")}
            </button>
            <button type="button" disabled={busy} onClick={cancelEdit}>
              {t("취소")}
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || (diff !== null && diff.errors.length > 0)}
              onClick={() => void save()}
              title={t("저장 (⌘S)")}
            >
              {t("저장 (⌘S)")}
            </button>
          </>
        ) : (
          <>
            {loading ? (
              <span className="panel-dim">
                <Spinner size={10} /> {t("불러오는 중…")}
              </span>
            ) : null}
            <button
              type="button"
              className="icon-text-button"
              disabled={loading || detail === null}
              onClick={startEdit}
              title={t("구조 편집")}
            >
              <PencilIcon size={11} />
              {t("편집")}
            </button>
            <button
              type="button"
              className="icon-button"
              disabled={loading}
              onClick={() => setNonce((value) => value + 1)}
              title={t("구조 새로고침")}
            >
              <RefreshIcon size={12} />
            </button>
          </>
        )}
      </div>
      <div className="panel-body structure-body">
        {error ? <ErrorNotice message={error} /> : null}
        {saveError ? <ErrorNotice message={saveError} /> : null}
        {detail === null ? (
          error ? null : (
            <div className="panel-empty">
              <Spinner size={14} />
              {t("불러오는 중…")}
            </div>
          )
        ) : editing && draft !== null ? (
          <div className="structure-editor">
            <div className="structure-section">
              <div className="structure-section-head">
                <span className="structure-section-title">
                  <ColumnsIcon size={11} />
                  {t("컬럼")}
                </span>
                <span className="structure-count">{draft.columns.length}</span>
              </div>
              <ColumnsEditor
                columns={draft.columns}
                onChange={(columns) => setDraft({ ...draft, columns })}
              />
            </div>
            <div className="structure-section">
              <div className="structure-section-head">
                <span className="structure-section-title">
                  <KeyIcon size={11} />
                  {t("인덱스")}
                </span>
                <span className="structure-count">{draft.indexes.length}</span>
              </div>
              <IndexesEditor
                indexes={draft.indexes}
                onChange={(indexes) => setDraft({ ...draft, indexes })}
              />
            </div>
            <div className="structure-section">
              <div className="structure-section-head">
                <span className="structure-section-title">
                  <LinkIcon size={11} />
                  {t("외래 키")}
                </span>
                <span className="structure-count">{draft.foreignKeys.length}</span>
              </div>
              <FksEditor
                fks={draft.foreignKeys}
                onChange={(foreignKeys) => setDraft({ ...draft, foreignKeys })}
              />
            </div>
            {preview && diff !== null ? (
              <div className="structure-section">
                <div className="structure-section-head">
                  <span className="structure-section-title">{t("DDL 미리보기")}</span>
                </div>
                <DdlPreview result={diff} />
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <div className="structure-summary">
              <div className="structure-stat">
                <span className="structure-stat-label">{t("컬럼")}</span>
                <strong>{detail.columns.length}</strong>
              </div>
              <div className="structure-stat">
                <span className="structure-stat-label">{t("인덱스")}</span>
                <strong>{detail.indexes.length}</strong>
              </div>
              <div className="structure-stat">
                <span className="structure-stat-label">{t("외래 키")}</span>
                <strong>{detail.foreign_keys.length}</strong>
              </div>
              <div className="structure-stat">
                <span className="structure-stat-label">{t("행 수")}</span>
                <strong>{countText ?? "—"}</strong>
              </div>
              <div className="structure-stat">
                <span className="structure-stat-label">{t("크기")}</span>
                <strong>{sizeText ?? "—"}</strong>
              </div>
              {detail.schema ? (
                <div className="structure-stat">
                  <span className="structure-stat-label">{t("스키마 정보")}</span>
                  <strong className="mono">{detail.schema}</strong>
                </div>
              ) : null}
            </div>

            <section className="structure-section">
              <div className="structure-section-head">
                <span className="structure-section-title">
                  <ColumnsIcon size={11} />
                  {t("컬럼")}
                </span>
                <span className="structure-count">{detail.columns.length}</span>
              </div>
              {detail.columns.length === 0 ? (
                <div className="structure-empty">{t("컬럼 정보가 없습니다")}</div>
              ) : (
                <div className="structure-table-wrap">
                  <table className="structure-table">
                    <thead>
                      <tr>
                        <th>{t("이름")}</th>
                        <th>{t("타입")}</th>
                        <th>NULL</th>
                        <th>{t("키")}</th>
                        <th>{t("기본값")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.columns.map((column) => (
                        <tr key={column.name}>
                          <td>
                            <span className="structure-column-name">
                              {column.pk ? <KeyIcon size={10} className="structure-pk-icon" /> : null}
                              {column.name}
                            </span>
                          </td>
                          <td>
                            <span className="structure-type">{column.decl_type ?? "—"}</span>
                          </td>
                          <td>
                            <span className={column.not_null ? "structure-null nn" : "structure-null"}>
                              {column.not_null ? "NOT NULL" : "NULL"}
                            </span>
                          </td>
                          <td>
                            {column.pk ? <span className="structure-key-badge">PK</span> : <span className="structure-dash">—</span>}
                          </td>
                          <td>
                            <span className="structure-default" title={column.default ?? ""}>
                              {column.default ?? "—"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <div className="structure-relations">
              <section className="structure-section">
                <div className="structure-section-head">
                  <span className="structure-section-title">
                    <KeyIcon size={11} />
                    {t("인덱스")}
                  </span>
                  <span className="structure-count">{detail.indexes.length}</span>
                </div>
                {detail.indexes.length === 0 ? (
                  <div className="structure-empty">{t("인덱스가 없습니다")}</div>
                ) : (
                  <div className="structure-card-list">
                    {detail.indexes.map((index) => (
                      <div className="structure-card" key={index.name}>
                        <div className="structure-card-head">
                          <KeyIcon size={10} />
                          <span className="structure-card-name">{index.name}</span>
                          {index.primary ? <span className="structure-key-badge">PK</span> : null}
                          {index.unique && !index.primary ? (
                            <span className="structure-key-badge unique">UNIQUE</span>
                          ) : null}
                        </div>
                        <div className="structure-chips">
                          {index.columns.map((column) => (
                            <span className="structure-chip" key={column}>
                              {column}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="structure-section">
                <div className="structure-section-head">
                  <span className="structure-section-title">
                    <LinkIcon size={11} />
                    {t("외래 키")}
                  </span>
                  <span className="structure-count">{detail.foreign_keys.length}</span>
                </div>
                {detail.foreign_keys.length === 0 ? (
                  <div className="structure-empty">{t("외래 키가 없습니다")}</div>
                ) : (
                  <div className="structure-card-list">
                    {detail.foreign_keys.map((fk) => (
                      <div className="structure-card" key={fk.name}>
                        <div className="structure-card-head">
                          <LinkIcon size={10} />
                          <span className="structure-card-name">{fk.name}</span>
                        </div>
                        <div className="structure-fk-flow">
                          <span className="structure-chips">
                            {fk.columns.map((column) => (
                              <span className="structure-chip" key={column}>
                                {column}
                              </span>
                            ))}
                          </span>
                          <span className="structure-arrow">→</span>
                          <span className="structure-fk-target">
                            {fk.ref_table}
                            {fk.ref_columns.length > 0 ? `.${fk.ref_columns.join(", ")}` : ""}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>

            <details className="structure-ddl">
              <summary>
                <span>{t("DDL")}</span>
                <span className="structure-count">{detail.ddl === null ? t("DDL 미지원") : "CREATE"}</span>
              </summary>
              {detail.ddl === null ? (
                <div className="structure-empty">{t("DDL 미지원")}</div>
              ) : (
                <div className="panel-code">
                  <div className="panel-code-head">
                    <span className="dim">{t("CREATE 문")}</span>
                    <span className="spacer" />
                    <button
                      type="button"
                      className="icon-text-button"
                      onClick={() => copyDdl(detail.ddl ?? "")}
                      title={t("복사")}
                    >
                      <CopyIcon size={11} />
                      {t("복사")}
                    </button>
                  </div>
                  <pre className="panel-pre">{detail.ddl}</pre>
                </div>
              )}
            </details>
          </>
        )}
      </div>
    </div>
  );
}
