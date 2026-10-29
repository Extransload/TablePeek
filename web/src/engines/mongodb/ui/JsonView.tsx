// {} JSON view: one coloured block per document in mongosh notation (or
// canonical Extended JSON), every { and [ foldable. Hovering a block shows
// edit · clone · copy · delete; editing turns the block into a code editor
// in place (⌘↩ saves as a guarded replaceOne, Esc cancels).

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { writeClipboard } from "../../../clipboard";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { CheckIcon, ChevronIcon, CopyIcon, PencilIcon, TrashIcon } from "../../../components/icons";
import type { ErrorContext } from "../../../errorHelp";
import { t } from "../../../i18n";
import { fromEJSON, isDocument, toEJSON, type BsonDocument, type BsonValue, type EJSON } from "../bson";
import { VIEW_LIMITS, shellKey, toShell, toShellPretty, truncation } from "../format";
import { parseValue } from "../shell/parse";
import { docKey } from "./CardView";
import { CloneIcon } from "./icons";
import { MongoEditor, type MongoEditorHandle } from "./MongoEditor";
import { ShellText } from "./ShellText";
import { WriteErrorNotice } from "./writeErrors";
import type { CompletionContext } from "../complete";

// A parse error in an editor's text, shown the same way everywhere (the
// editor underlines the range): the notice with its line and column, and
// under it the line with a caret at the column.
export function SyntaxErrorNotice({ src, message, at, context, variant = "compact", onClose }: { src: string; message: string; at: number; context: ErrorContext; variant?: "block" | "compact"; onClose?(): void }) {
  const before = src.slice(0, at);
  const line = before.split("\n").length;
  const lineText = src.split("\n")[line - 1] ?? "";
  const col = at - before.lastIndexOf("\n") - 1;
  const where = t("{line}행 {col}열", { line, col: col + 1 });
  return (
    <div className="mg-syntax-error">
      <ErrorNotice error={{ code: "parse_error", message, position: { line, column: col + 1 } }} context={context} engine="mongodb" variant={variant} onClose={onClose} />
      <pre className="mg-error-at" aria-label={where}>
        <span className="mg-error-where">{where}</span>
        {`\n${lineText}\n${" ".repeat(Math.max(0, col))}^`}
      </pre>
    </div>
  );
}

type Parsed = { ok: true; value: BsonDocument } | { ok: false; message: string; from: number; to: number };

// The editor's text as a document: mongosh notation, or with EJSON on,
// Extended JSON.
export function parseDocText(text: string, canonical: boolean): Parsed {
  if (canonical) {
    try {
      const value = fromEJSON(JSON.parse(text));
      return isDocument(value) ? { ok: true, value } : { ok: false, message: t("문서 { … }를 써야 합니다"), from: 0, to: text.length };
    } catch (error) {
      const at = /position (\d+)/.exec((error as Error).message);
      const pos = at ? Number(at[1]) : 0;
      return { ok: false, message: (error as Error).message, from: pos, to: pos + 1 };
    }
  }
  const r = parseValue(text);
  if (!r.ok) {
    return { ok: false, message: r.error.message, from: r.error.from, to: r.error.to };
  }
  return isDocument(r.value) ? { ok: true, value: r.value } : { ok: false, message: t("문서 { … }를 써야 합니다"), from: 0, to: text.length };
}

export function docText(doc: BsonValue, canonical: boolean): string {
  return canonical ? JSON.stringify(toEJSON(doc), null, 2) : toShellPretty(doc);
}

interface Line {
  depth: number;
  text: string;
  fold: string | null;
  folded: boolean;
  summary: string | null;
  more: string | null;
}

// An EJSON wrapper ({ "$oid": … }, { "$date": { "$numberLong": … } })
// stays on one line.
function isWrapper(v: EJSON): boolean {
  return v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0 && Object.keys(v)[0].startsWith("$");
}

interface JsonBlockProps {
  doc: BsonDocument;
  position: number;
  canonical: boolean;
  allFolded: boolean;
  readOnly: boolean;
  completion?: () => CompletionContext;
  onSave?(doc: BsonDocument, value: BsonDocument): Promise<Error | null>;
  onClone?(doc: BsonDocument): void;
  onDelete?(doc: BsonDocument): void;
  notify(message: string): void;
}

function JsonBlock({ doc, position, canonical, allFolded, readOnly, completion, onSave, onClone, onDelete, notify }: JsonBlockProps) {
  const [toggled, setToggled] = useState<Set<string>>(() => new Set());
  // The text being edited, and what stopped the last save: the text did not
  // parse, or the server refused the write.
  const [editing, setEditing] = useState<{ text: string; parse: { message: string; from: number; to: number } | null; failure: Error | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [full, setFull] = useState(false);
  const editorRef = useRef<MongoEditorHandle | null>(null);
  const blockRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => setToggled(new Set()), [allFolded]);

  const ro = readOnly || doc._id === undefined || onSave === undefined;

  const lines = useMemo(() => {
    const out: Line[] = [];
    const cut = full ? null : truncation(doc);
    const cutArrays = new Set(cut?.arrays.map((a) => a.path));
    const isFolded = (path: string, depth: number) => toggled.has(path) !== (allFolded && depth >= 1);
    const scalar = (v: BsonValue, e: EJSON) => (canonical ? (isWrapper(e) ? JSON.stringify(e).replace(/":/g, '": ') : JSON.stringify(e)) : toShell(v));
    const walk = (v: BsonValue, e: EJSON, path: string, depth: number, prefix: string, comma: boolean) => {
      const tail = comma ? "," : "";
      const container = (Array.isArray(v) || isDocument(v)) && !(canonical && isWrapper(e));
      if (!container) {
        out.push({ depth, text: `${prefix}${scalar(v, e)}${tail}`, fold: null, folded: false, summary: null, more: null });
        return;
      }
      const arr = Array.isArray(v);
      let keys = arr ? v.map((_, i) => String(i)) : Object.keys(v);
      const [open, close] = arr ? ["[", "]"] : ["{", "}"];
      if (keys.length === 0) {
        out.push({ depth, text: `${prefix}${open}${close}${tail}`, fold: null, folded: false, summary: null, more: null });
        return;
      }
      if (isFolded(path, depth)) {
        out.push({ depth, text: `${prefix}${open} … ${close}${tail}`, fold: path, folded: true, summary: arr ? t("{count}개", { count: keys.length }) : t("필드 {count}개", { count: keys.length }), more: null });
        return;
      }
      out.push({ depth, text: `${prefix}${open}`, fold: path, folded: false, summary: null, more: null });
      let more: string | null = null;
      if (cut !== null && depth === 0 && !arr && cut.shownFields < keys.length) {
        more = t("… 필드 {count}개 더", { count: keys.length - cut.shownFields });
        keys = keys.slice(0, cut.shownFields);
      } else if (arr && cutArrays.has(path) && keys.length > VIEW_LIMITS.arrayItems) {
        more = t("… {count}개 더", { count: keys.length - VIEW_LIMITS.arrayItems });
        keys = keys.slice(0, VIEW_LIMITS.arrayItems);
      }
      keys.forEach((k, i) => {
        const child = Array.isArray(v) ? v[Number(k)] : isDocument(v) ? v[k] : null;
        const childE = Array.isArray(e) ? e[Number(k)] : e !== null && typeof e === "object" ? e[k] : null;
        const childPath = path === "" ? k : `${path}.${k}`;
        walk(child, childE, childPath, depth + 1, arr ? "" : `${canonical ? JSON.stringify(k) : shellKey(k)}: `, i < keys.length - 1 || more !== null);
      });
      if (more !== null) {
        out.push({ depth: depth + 1, text: "", fold: null, folded: false, summary: null, more });
      }
      out.push({ depth, text: `${close}${tail}`, fold: null, folded: false, summary: null, more: null });
    };
    walk(doc, toEJSON(doc), "", 0, "", false);
    return out;
  }, [doc, canonical, toggled, allFolded, full]);

  const toggle = (path: string) =>
    setToggled((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) {
        next.add(path);
      }
      return next;
    });

  const startEdit = () => {
    if (!ro) {
      setEditing({ text: docText(doc, canonical), parse: null, failure: null });
    }
  };

  const cancel = () => {
    setEditing(null);
    window.setTimeout(() => blockRef.current?.focus(), 0);
  };

  const save = async () => {
    if (editing === null || onSave === undefined) {
      return;
    }
    const text = editorRef.current?.text() ?? editing.text;
    const parsed = parseDocText(text, canonical);
    if (!parsed.ok) {
      setEditing({ text, parse: parsed, failure: null });
      return;
    }
    setSaving(true);
    const failure = await onSave(doc, parsed.value);
    setSaving(false);
    if (failure === null) {
      setEditing(null);
    } else {
      setEditing({ text, parse: null, failure });
    }
  };

  const copy = () => {
    void writeClipboard(docText(doc, canonical), notify);
    notify(t("복사했습니다"));
  };

  let body: ReactNode;
  if (editing !== null) {
    const height = Math.min(560, Math.max(120, editing.text.split("\n").length * 18 + 14));
    body = (
      <div className="mg-jedit">
        <div className="mg-jedit-host" style={{ height }}>
          <MongoEditor
            ref={editorRef}
            value={editing.text}
            role="doc"
            completion={completion}
            autoFocus
            error={editing.parse}
            onRun={() => void save()}
            onEscape={cancel}
            ariaLabel={t("문서 편집")}
          />
        </div>
        {editing.parse !== null ? <SyntaxErrorNotice src={editing.text} message={editing.parse.message} at={editing.parse.from} context="document" /> : null}
        {editing.failure !== null ? <WriteErrorNotice error={editing.failure} /> : null}
        <div className="mg-jedit-bar">
          <span className="panel-dim">
            {canonical ? "Extended JSON" : t("mongosh 표기")} · {t("_id는 바꿀 수 없습니다")} · {t("Esc 취소")}
          </span>
          <span className="spacer" />
          <button type="button" onClick={cancel} disabled={saving}>
            {t("취소")}
          </button>
          <button type="button" className="primary" onClick={() => void save()} disabled={saving}>
            <CheckIcon size={10} />
            {t("저장")} <span className="split-hint">⌘↩</span>
          </button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="mg-jcode">
        {lines.map((line, i) => (
          <div key={i} className="mg-jl" style={{ paddingLeft: `${line.depth * 2 + 2}ch` }}>
            {line.fold !== null ? (
              <span className={`mg-jl-fold${line.folded ? "" : " open"}`} onClick={() => toggle(line.fold ?? "")}>
                <ChevronIcon size={8} />
              </span>
            ) : null}
            {line.more !== null ? (
              <span className="mg-jl-sum">
                {line.more}{" "}
                <button type="button" className="icon-text-button" onClick={() => setFull(true)}>
                  {t("전체 보기")}
                </button>
              </span>
            ) : (
              <ShellText text={line.text} />
            )}
            {line.summary !== null ? <span className="mg-jl-sum">{line.summary}</span> : null}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      ref={blockRef}
      className={`mg-jdoc${editing !== null ? " editing" : ""}`}
      tabIndex={-1}
      onDoubleClick={(event) => {
        if (editing === null && !(event.target as HTMLElement).closest(".mg-jl-fold, button")) {
          startEdit();
        }
      }}
    >
      <div className="mg-jdoc-no">#{(position + 1).toLocaleString()}</div>
      <span className="mg-jdoc-acts">
        {ro ? null : (
          <button type="button" className="icon-text-button" title={t("이 자리에서 편집 (두 번 눌러도 됩니다)")} onClick={startEdit}>
            <PencilIcon size={10} />
            {t("편집")}
          </button>
        )}
        {!ro && onClone ? (
          <button type="button" className="icon-text-button" onClick={() => onClone(doc)}>
            <CloneIcon size={10} />
            {t("복제")}
          </button>
        ) : null}
        <button type="button" className="icon-text-button" title={canonical ? t("Extended JSON으로 복사") : t("mongosh 표기로 복사")} onClick={copy}>
          <CopyIcon size={10} />
          {t("복사")}
        </button>
        {!ro && onDelete ? (
          <button type="button" className="icon-text-button mg-danger-text" onClick={() => onDelete(doc)}>
            <TrashIcon size={10} />
            {t("삭제")}
          </button>
        ) : null}
      </span>
      {body}
    </div>
  );
}

export interface JsonViewProps {
  docs: BsonDocument[];
  offset: number;
  // Canonical Extended JSON instead of mongosh notation.
  canonical: boolean;
  // Nested values folded (the toolbar's 모두 접기).
  allFolded: boolean;
  readOnly: boolean;
  completion?: () => CompletionContext;
  onSave?(doc: BsonDocument, value: BsonDocument): Promise<Error | null>;
  onClone?(doc: BsonDocument): void;
  onDelete?(doc: BsonDocument): void;
  notify(message: string): void;
  emptyText?: string;
}

export function JsonView({ docs, offset, emptyText, ...rest }: JsonViewProps) {
  if (docs.length === 0) {
    return (
      <div className="mg-jdocs">
        <div className="panel-empty">{emptyText ?? t("조건에 맞는 문서가 없습니다")}</div>
      </div>
    );
  }
  return (
    <div className="mg-jdocs" tabIndex={-1}>
      {docs.map((doc, i) => (
        <JsonBlock key={docKey(doc, offset + i)} doc={doc} position={offset + i} {...rest} />
      ))}
    </div>
  );
}
