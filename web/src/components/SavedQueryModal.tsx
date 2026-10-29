import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { confirmDialog } from "./ConfirmDialog";
import { ErrorNotice } from "./ErrorNotice";
import { store, type Favorite } from "../store";
import type { CompletionColumn } from "../sqlComplete";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor";
import { Spinner } from "./Spinner";

interface SavedQueryModalProps {
  // null writes a new query (into `folder`).
  query: Favorite | null;
  folder?: string | null;
  onClose(): void;
}

const EDITOR_TAB = "saved-query-editor";
const NO_SCHEMA: Record<string, CompletionColumn[]> = {};

// TablePlus's saved query window: name, keyword for autocompletion, and the SQL.
export function SavedQueryModal({ query, folder = null, onClose }: SavedQueryModalProps) {
  const [name, setName] = useState(query?.name ?? t("제목 없음"));
  const [keyword, setKeyword] = useState(query?.keyword ?? "");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const editorRef = useRef<SqlEditorHandle | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  async function save(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === "" || busy) {
      return;
    }
    const sql = editorRef.current?.getDoc() ?? query?.sql ?? "";
    const word = keyword.trim();
    setBusy(true);
    setFailure(null);
    try {
      if (query === null) {
        await store.createFavorite(trimmed, sql, word === "" ? undefined : word, folder);
      } else {
        await store.updateFavorite(query.id, { name: trimmed, sql, keyword: word === "" ? null : word });
      }
      onClose();
    } catch (err) {
      setFailure(err instanceof Error && err.message ? err.message : t("쿼리를 저장하지 못했습니다"));
    } finally {
      setBusy(false);
    }
  }

  // Asks before throwing away what was typed.
  async function close(): Promise<void> {
    if (busy) {
      return;
    }
    const sql = editorRef.current?.getDoc() ?? query?.sql ?? "";
    const dirty =
      name !== (query?.name ?? t("제목 없음")) || keyword !== (query?.keyword ?? "") || sql !== (query?.sql ?? "");
    if (
      dirty &&
      !(await confirmDialog({
        title: t("변경사항 버리기"),
        message: t("저장하지 않은 변경 사항을 버릴까요?"),
        confirmLabel: t("버리기"),
        danger: true,
      }))
    ) {
      return;
    }
    onClose();
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        // The editor's completion list and search panel close on Escape first.
        const target = event.target instanceof Element ? event.target : null;
        const editorPopup = document.querySelector(
          ".saved-query-modal .cm-tooltip-autocomplete, .saved-query-modal .cm-panel",
        );
        if (target?.closest(".cm-editor") != null && editorPopup !== null) {
          return;
        }
        void close();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        // The app's own ⌘S (apply grid changes) must not run under the dialog.
        event.preventDefault();
        event.stopImmediatePropagation();
        void save();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  return (
    <div className="modal-backdrop" onClick={close}>
      <form
        className="modal saved-query-modal"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="saved-query-fields">
          <label>
            <span>{t("이름")}</span>
            <input
              ref={nameRef}
              value={name}
              spellCheck={false}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            <span>{t("키워드")}</span>
            <input
              value={keyword}
              placeholder={t("자동 완성에 쓸 키워드")}
              spellCheck={false}
              disabled={busy}
              onChange={(event) => setKeyword(event.target.value)}
            />
          </label>
          <p className="saved-query-hint">
            {t("SQL 에디터에서 이 키워드를 입력하면 자동 완성 목록에 이 쿼리가 나옵니다")}
          </p>
        </div>
        <div className="saved-query-editor">
          <SqlEditor
            ref={editorRef}
            tabId={EDITOR_TAB}
            tabIds={[EDITOR_TAB]}
            initialSql={query?.sql ?? ""}
            onRun={() => undefined}
            onSqlChange={() => undefined}
            schema={NO_SCHEMA}
            favorites={[]}
            runKey={null}
          />
        </div>
        {failure !== null ? (
          <div className="saved-query-error-slot">
            <ErrorNotice error={failure} variant="compact" />
          </div>
        ) : null}
        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" onClick={close} disabled={busy}>
            {t("취소")}
          </button>
          <button type="submit" className="primary" disabled={name.trim() === "" || busy}>
            {busy ? <Spinner size={10} /> : null}
            {t("저장")}
          </button>
        </div>
      </form>
    </div>
  );
}
