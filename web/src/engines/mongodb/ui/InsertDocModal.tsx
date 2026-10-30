// A document in a code editor inside a modal: 문서 추가 (insertOne, from a
// template of the collection's common fields), 문서 복제, and a card's JSON
// edit (replaceOne). The text is mongosh notation; ⌘↩ submits, Esc closes,
// a parse error is underlined and shown with its line and column.

import { useEffect, useRef, useState } from "react";
import { Spinner } from "../../../components/Spinner";
import { say, t, type Phrase } from "../../../i18n";
import type { BsonDocument, BsonTypeName, BsonValue } from "../bson";
import type { CompletionContext, FieldStat } from "../complete";
import { SyntaxErrorNotice, parseDocText } from "./JsonView";
import { MongoEditor, type MongoEditorHandle } from "./MongoEditor";
import { defaultOfType } from "./valueEdit";
import { OpenValidationContext, WriteErrorNotice } from "./writeErrors";

interface InsertDocModalProps {
  title: string;
  // The namespace (and _id) the document belongs to, under the title.
  path: string;
  initial: string;
  okLabel: string;
  hint: string;
  completion?: () => CompletionContext;
  // Resolves null when done (the modal closes), else the failure to show.
  onSubmit(value: BsonDocument): Promise<Error | null>;
  onClose(): void;
  // A validation failure's "검증 탭 열기": the modal hands over its text (to
  // come back with) and closes, so the tab is not left under it.
  onOpenValidation?(text: string): void;
}

export function InsertDocModal({
  title,
  path,
  initial,
  okLabel,
  hint,
  completion,
  onSubmit,
  onClose,
  onOpenValidation,
}: InsertDocModalProps) {
  const editorRef = useRef<MongoEditorHandle | null>(null);
  // What stopped the last submit: the text did not parse (with the text it
  // was in), or the server refused the write.
  const [error, setError] = useState<{ parse: { message: Phrase; from: number; to: number; src: string } } | { failure: Error } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const submit = async () => {
    if (busyRef.current) {
      return;
    }
    const text = editorRef.current?.text() ?? initial;
    const parsed = parseDocText(text, false);
    if (!parsed.ok) {
      setError({ parse: { message: parsed.message, from: parsed.from, to: parsed.to, src: text } });
      return;
    }
    busyRef.current = true;
    setBusy(true);
    const failure = await onSubmit(parsed.value);
    busyRef.current = false;
    setBusy(false);
    setError(failure === null ? null : { failure });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !busyRef.current) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={() => !busyRef.current && onClose()}>
      <div className="modal mg-doc-modal" role="dialog" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <div className="modal-head mg-doc-modal-head">
          <span className="modal-title">{title}</span>
          <span className="mg-doc-modal-path mono">{path}</span>
        </div>
        <div className="modal-body mg-doc-body">
          <MongoEditor ref={editorRef} value={initial} role="doc" completion={completion} autoFocus error={error !== null && "parse" in error ? error.parse : null} onRun={() => void submit()} ariaLabel={title} />
        </div>
        {error !== null ? (
          <div className="mg-modal-error">
            {"parse" in error ? (
              <SyntaxErrorNotice src={error.parse.src} message={say(error.parse.message)} at={error.parse.from} context="document" />
            ) : (
              <OpenValidationContext.Provider
                value={onOpenValidation === undefined ? null : () => onOpenValidation(editorRef.current?.text() ?? initial)}
              >
                <WriteErrorNotice error={error.failure} variant="block" />
              </OpenValidationContext.Provider>
            )}
          </div>
        ) : null}
        <div className="modal-foot">
          <span className="panel-dim">{hint}</span>
          <span className="spacer" />
          <button type="button" onClick={onClose} disabled={busy}>
            {t("취소")}
          </button>
          <button type="button" className="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? <Spinner size={10} /> : null}
            {okLabel} <span className="split-hint">⌘↩</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// A new document from the sampled fields present in at least half the
// documents, each with an empty value of its most common type (nested
// documents filled the same way). `_id` is left to the server.
export function templateDoc(fields: FieldStat[]): BsonDocument {
  const byPath = new Map(fields.map((f) => [f.path, f]));
  const fill = (path: string): BsonValue => {
    const field = byPath.get(path);
    const type: BsonTypeName = field?.types.find((x) => x.type !== "Null")?.type ?? "Null";
    if (type !== "Object") {
      return defaultOfType(type);
    }
    const out: BsonDocument = new Map();
    for (const child of fields) {
      if (child.depth === (field?.depth ?? 0) + 1 && child.path.startsWith(`${path}.`) && child.presence >= 0.5) {
        out.set(child.path.slice(path.length + 1), fill(child.path));
      }
    }
    return out;
  };
  const doc: BsonDocument = new Map();
  for (const field of fields) {
    if (field.depth === 0 && field.path !== "_id" && field.presence >= 0.5) {
      doc.set(field.path, fill(field.path));
    }
  }
  return doc;
}
