import { useMemo, useState } from "react";
import { createTableSql, emptyDrafts, type StructureDraft } from "../ddl";
import type { SqlDialect } from "../engines/sqlDialect";
import { t } from "../i18n";
import { store, type EngineMeta } from "../store";
import { ColumnsEditor, DdlPreview, IndexesEditor } from "./DraftEditors";
import { ErrorNotice, FieldError } from "./ErrorNotice";

interface CreateTableModalProps {
  conn: string;
  dialect: SqlDialect;
  meta: EngineMeta;
  onClose(): void;
  onCreated(table: string): void;
}

function errorOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function CreateTableModal({ conn, dialect, meta, onClose, onCreated }: CreateTableModalProps) {
  const [name, setName] = useState("");
  const [draft, setDraft] = useState<StructureDraft>(() => emptyDrafts());
  const [preview, setPreview] = useState(false);
  const [engine, setEngine] = useState("InnoDB");
  const [charset, setCharset] = useState("utf8mb4");
  const [collation, setCollation] = useState("utf8mb4_unicode_ci");
  const [rowFormat, setRowFormat] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const result = useMemo(() => {
    if (name.trim() === "") {
      return { statements: [], errors: [t("테이블 이름을 입력하세요")] };
    }
    return createTableSql(dialect, name.trim(), draft, {
      engine,
      charset,
      collation,
      rowFormat,
      comment,
    });
  }, [dialect, name, draft, engine, charset, collation, rowFormat, comment]);

  async function run(): Promise<void> {
    if (result.errors.length > 0 || result.statements.length === 0) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      for (const statement of result.statements) {
        await store.exec(conn, statement, { history: true });
      }
      store.setInfo(t("테이블을 생성했습니다: {name}", { name: name.trim() }));
      onCreated(name.trim());
    } catch (err) {
      setError(errorOf(err, t("테이블을 생성하지 못했습니다")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => (busy ? undefined : onClose())}>
      <div className="modal create-table-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{t("테이블 생성")}</span>
          <span className="modal-path">{meta.kind}</span>
          <span className="spacer" />
          <span className="dim">{t("⌘S 미리보기")}</span>
        </div>
        <div className="modal-body create-table-body">
          <label className="field">
            <span>{t("테이블 이름")}</span>
            <input
              value={name}
              spellCheck={false}
              placeholder="new_table"
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {dialect.tableOptions !== undefined ? (
            <>
              <div className="create-inline">
                <label className="field">
                  <span>{t("엔진")}</span>
                  <input
                    value={engine}
                    spellCheck={false}
                    onChange={(e) => setEngine(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>{t("문자셋")}</span>
                  <input
                    value={charset}
                    spellCheck={false}
                    onChange={(e) => setCharset(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>{t("콜레이션")}</span>
                  <input
                    value={collation}
                    spellCheck={false}
                    onChange={(e) => setCollation(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>ROW_FORMAT</span>
                  <input
                    value={rowFormat}
                    spellCheck={false}
                    placeholder={t("기본값")}
                    onChange={(e) => setRowFormat(e.target.value)}
                  />
                </label>
              </div>
              <label className="field">
                <span>{t("테이블 설명")}</span>
                <input value={comment} onChange={(e) => setComment(e.target.value)} />
              </label>
            </>
          ) : null}
          <section className="export-section">
            <div className="section-title">{t("컬럼")}</div>
            <ColumnsEditor
              columns={draft.columns}
              onChange={(columns) => setDraft({ ...draft, columns })}
            />
          </section>
          <section className="export-section">
            <div className="section-title">{t("인덱스")}</div>
            <IndexesEditor
              indexes={draft.indexes}
              onChange={(indexes) => setDraft({ ...draft, indexes })}
            />
          </section>
          {preview ? <DdlPreview result={result} /> : null}
          {error ? <ErrorNotice error={error} context="structure" /> : null}
        </div>
        <div className="modal-foot">
          <FieldError id="create-table-problem" error={result.errors[0]} />
          <span className="spacer" />
          <button type="button" disabled={busy} onClick={() => setPreview((value) => !value)}>
            {preview ? t("미리보기 숨기기") : t("미리보기")}
          </button>
          <button type="button" disabled={busy} onClick={onClose}>
            {t("취소")}
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || result.errors.length > 0 || name.trim() === ""}
            aria-describedby={result.errors.length > 0 ? "create-table-problem" : undefined}
            onClick={() => void run()}
          >
            {t("생성")}
          </button>
        </div>
      </div>
    </div>
  );
}
