// {} JSON view: one coloured block per document in mongosh notation (or
// canonical Extended JSON), every { and [ foldable. Hovering a block shows
// edit · clone · copy · delete; editing turns the block into a code editor
// in place (⌘↩ saves as a guarded replaceOne, Esc cancels). As on the SQL
// grid, a line's right-click opens the menu of the value it starts (the
// block's, the document's) and a middle-click opens it in Quick Look, as ⌘↩
// on the list does for the picked block.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { writeClipboard } from "../../../clipboard";
import { ContextMenu, type ContextMenuItem } from "../../../components/ContextMenu";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { CheckIcon, ChevronIcon, CopyIcon, PencilIcon, TrashIcon } from "../../../components/icons";
import type { ErrorContext } from "../../../errorHelp";
import { errorPhrase, phrase, say, t, type Phrase } from "../../../i18n";
import { JsonSyntaxError, fromEJSON, isDocument, jsonKeys, parseJson, stringifyJson, toEJSON, type BsonDocument, type BsonValue, type EJSON } from "../bson";
import { VIEW_LIMITS, ejsonText, shellKey, toShell, toShellPretty, truncation } from "../format";
import { valueAt } from "../guard";
import { parseValue } from "../shell/parse";
import { docKey } from "./CardView";
import { anchorOf, copyDocsItem, copyPathItem, copyValueItems, docEditItems, docMenuItems, filterItems, hideItem, queryPath, querySort, sortItems, useDocActions, useOnItemsChange, ValueQuickLook, type QuickLookTarget } from "./docMenus";
import { CloneIcon } from "./icons";
import { MongoEditor, type MongoEditorHandle } from "./MongoEditor";
import { arrowStep, selectsItem } from "./selection";
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

// `message` is translated where it shows, so it follows a language switch.
type Parsed = { ok: true; value: BsonDocument } | { ok: false; message: Phrase; from: number; to: number };

// The editor's text as a document: mongosh notation, or with EJSON on,
// Extended JSON.
// `json`: plain JSON, whose whole numbers past 2^53 read back exactly.
export function parseDocText(text: string, canonical: boolean, json = false): Parsed {
  if (canonical || json) {
    try {
      const value = fromEJSON(parseJson(text, { bigints: json }));
      return isDocument(value) ? { ok: true, value } : { ok: false, message: phrase("문서 { … }를 써야 합니다"), from: 0, to: text.length };
    } catch (error) {
      const pos = error instanceof JsonSyntaxError ? error.offset : 0;
      return { ok: false, message: errorPhrase(error), from: pos, to: pos + 1 };
    }
  }
  const r = parseValue(text);
  if (!r.ok) {
    return { ok: false, message: r.error.message, from: r.error.from, to: r.error.to };
  }
  return isDocument(r.value) ? { ok: true, value: r.value } : { ok: false, message: phrase("문서 { … }를 써야 합니다"), from: 0, to: text.length };
}

// The block's text: mongosh notation, canonical Extended JSON, or for plain
// JSON documents (the search engines) plain JSON.
export function docText(doc: BsonValue, canonical: boolean, json = false): string {
  return json ? ejsonText(doc, { relaxed: true, exactNumbers: true }) : canonical ? stringifyJson(toEJSON(doc), 2) : toShellPretty(doc);
}

interface Line {
  depth: number;
  text: string;
  fold: string | null;
  folded: boolean;
  summary: string | null;
  more: string | null;
  // The dotted path of the value the line starts ("" for the document),
  // null on closing brackets and "more" lines: what its menu acts on.
  path: string | null;
}

// An EJSON wrapper ({ "$oid": … }, { "$date": { "$numberLong": … } })
// stays on one line.
function isWrapper(v: EJSON): boolean {
  return v !== null && typeof v === "object" && !Array.isArray(v) && jsonKeys(v)[0]?.startsWith("$") === true;
}

interface JsonBlockProps {
  doc: BsonDocument;
  position: number;
  canonical: boolean;
  json: boolean;
  allFolded: boolean;
  readOnly: boolean;
  completion?: () => CompletionContext;
  onSave?(doc: BsonDocument, value: BsonDocument): Promise<Error | null>;
  onClone?(doc: BsonDocument): void;
  onDelete?(doc: BsonDocument): void;
  notify(message: string): void;
  selected: boolean;
  // Picks the block for the app's detail panel; omitted where nothing is picked.
  onPick?(): void;
  // Called when a pointer press or focus lands anywhere inside the block
  // (its editor included), so working on it also picks it.
  onActivate?(): void;
}

function JsonBlock({ doc, position, canonical, json, allFolded, readOnly, completion, onSave, onClone, onDelete, notify, selected, onPick, onActivate }: JsonBlockProps) {
  const [toggled, setToggled] = useState<Set<string>>(() => new Set());
  // The text being edited, and what stopped the last save: the text did not
  // parse, or the server refused the write.
  const [editing, setEditing] = useState<{ text: string; parse: { message: Phrase; from: number; to: number } | null; failure: Error | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [full, setFull] = useState(false);
  const editorRef = useRef<MongoEditorHandle | null>(null);
  const blockRef = useRef<HTMLDivElement | null>(null);
  const actions = useDocActions();
  // A line's or the block's right-click menu, and a value in Quick Look.
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [look, setLook] = useState<QuickLookTarget | null>(null);

  useEffect(() => setToggled(new Set()), [allFolded]);
  // A menu or Quick Look belongs to the document it was opened on; a reload
  // can move or drop its line, so it closes.
  useEffect(() => {
    setMenu(null);
    setLook(null);
  }, [doc]);

  const ro = readOnly || !doc.has("_id") || onSave === undefined;

  const lines = useMemo(() => {
    const out: Line[] = [];
    const cut = full ? null : truncation(doc);
    const cutArrays = new Set(cut?.arrays.map((a) => a.path));
    const isFolded = (path: string, depth: number) => toggled.has(path) !== (allFolded && depth >= 1);
    const scalar = (v: BsonValue, e: EJSON) => (json ? ejsonText(v, { relaxed: true, exactNumbers: true, indent: 0 }) : canonical ? (isWrapper(e) ? stringifyJson(e).replace(/":/g, '": ') : JSON.stringify(e)) : toShell(v));
    const walk = (v: BsonValue, e: EJSON, path: string, depth: number, prefix: string, comma: boolean) => {
      const tail = comma ? "," : "";
      const container = (Array.isArray(v) || isDocument(v)) && !(canonical && isWrapper(e));
      if (!container) {
        out.push({ depth, text: `${prefix}${scalar(v, e)}${tail}`, fold: null, folded: false, summary: null, more: null, path });
        return;
      }
      const arr = Array.isArray(v);
      let keys = Array.isArray(v) ? v.map((_, i) => String(i)) : isDocument(v) ? [...v.keys()] : [];
      const [open, close] = arr ? ["[", "]"] : ["{", "}"];
      if (keys.length === 0) {
        out.push({ depth, text: `${prefix}${open}${close}${tail}`, fold: null, folded: false, summary: null, more: null, path });
        return;
      }
      if (isFolded(path, depth)) {
        out.push({ depth, text: `${prefix}${open} … ${close}${tail}`, fold: path, folded: true, summary: arr ? t("{count}개", { count: keys.length }) : t("필드 {count}개", { count: keys.length }), more: null, path });
        return;
      }
      out.push({ depth, text: `${prefix}${open}`, fold: path, folded: false, summary: null, more: null, path });
      let more: string | null = null;
      if (cut !== null && depth === 0 && !arr && cut.shownFields < keys.length) {
        more = t("… 필드 {count}개 더", { count: keys.length - cut.shownFields });
        keys = keys.slice(0, cut.shownFields);
      } else if (arr && cutArrays.has(path) && keys.length > VIEW_LIMITS.arrayItems) {
        more = t("… {count}개 더", { count: keys.length - VIEW_LIMITS.arrayItems });
        keys = keys.slice(0, VIEW_LIMITS.arrayItems);
      }
      keys.forEach((k, i) => {
        const child = (Array.isArray(v) ? v[Number(k)] : isDocument(v) ? v.get(k) : null) ?? null;
        const childE = Array.isArray(e) ? e[Number(k)] : e !== null && typeof e === "object" ? e[k] : null;
        const childPath = path === "" ? k : `${path}.${k}`;
        walk(child, childE, childPath, depth + 1, arr ? "" : `${canonical || json ? JSON.stringify(k) : shellKey(k)}: `, i < keys.length - 1 || more !== null);
      });
      if (more !== null) {
        out.push({ depth: depth + 1, text: "", fold: null, folded: false, summary: null, more, path: null });
      }
      out.push({ depth, text: `${close}${tail}`, fold: null, folded: false, summary: null, more: null, path: null });
    };
    walk(doc, toEJSON(doc), "", 0, "", false);
    return out;
  }, [doc, canonical, json, toggled, allFolded, full]);

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
      setEditing({ text: docText(doc, canonical, json), parse: null, failure: null });
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
    const parsed = parseDocText(text, canonical, json);
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
    void writeClipboard(docText(doc, canonical, json), notify);
    notify(t("복사했습니다"));
  };

  // The document, or the value a line starts, in Quick Look beside `anchor`.
  const lookAt = (path: string, anchor: Element) => {
    const v = path === "" ? doc : valueAt(doc, path);
    if (v === undefined) {
      return;
    }
    setMenu(null);
    setLook({ name: path === "" ? `#${(position + 1).toLocaleString()}` : path, value: v, position, anchor: anchorOf(anchor) });
  };

  // A line's menu (its value: copy, look, fold, the query) above the
  // document's; the block's own space and its first line give the
  // document's alone.
  const openMenu = (x: number, y: number, line: Line | null, anchor: Element) => {
    const edits = {
      onEdit: ro ? undefined : startEdit,
      onClone: !ro && onClone ? () => onClone(doc) : undefined,
      onDelete: !ro && onDelete ? () => onDelete(doc) : undefined,
    };
    const path = line?.path ?? "";
    const v = path === "" ? undefined : valueAt(doc, path);
    let items: ContextMenuItem[];
    if (line === null || v === undefined) {
      items = docMenuItems(actions, { doc, json, quickLook: () => lookAt("", anchor), ...edits });
    } else {
      const field = queryPath(doc, path);
      items = [...copyValueItems(v, json), copyPathItem(path), { label: "Quick Look", separatorBefore: true, onSelect: () => lookAt(path, anchor) }];
      if (line.fold !== null) {
        const fold = line.fold;
        items.push({ label: line.folded ? t("펼치기") : t("접기"), onSelect: () => toggle(fold) });
      }
      items.push(...filterItems(actions, field, v), ...sortItems(querySort(actions, field)), ...hideItem(actions, field));
      items.push({ ...copyDocsItem([doc], json), separatorBefore: true }, ...docEditItems(edits));
    }
    setLook(null);
    setMenu({ x, y, items });
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
        {editing.parse !== null ? <SyntaxErrorNotice src={editing.text} message={say(editing.parse.message)} at={editing.parse.from} context="document" /> : null}
        {editing.failure !== null ? <WriteErrorNotice error={editing.failure} /> : null}
        <div className="mg-jedit-bar">
          <span className="panel-dim">
            {json ? "JSON" : canonical ? "Extended JSON" : t("mongosh 표기")} · {t("_id는 바꿀 수 없습니다")} · {t("Esc 취소")}
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
          <div
            key={i}
            className="mg-jl"
            style={{ paddingLeft: `${line.depth * 2 + 2}ch` }}
            onContextMenu={
              line.path === null
                ? undefined
                : (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openMenu(event.clientX, event.clientY, line, event.currentTarget);
                  }
            }
            onAuxClick={
              line.path === null
                ? undefined
                : (event) => {
                    if (event.button === 1) {
                      event.preventDefault();
                      event.stopPropagation();
                      lookAt(line.path ?? "", event.currentTarget);
                    }
                  }
            }
          >
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
      className={`mg-jdoc${editing !== null ? " editing" : ""}${selected ? " selected" : ""}`}
      tabIndex={-1}
      onPointerDownCapture={selected ? undefined : onActivate}
      onFocusCapture={selected ? undefined : onActivate}
      onClick={(event) => {
        if (editing === null && onPick !== undefined && selectsItem(event.target)) {
          onPick();
        }
      }}
      onDoubleClick={(event) => {
        if (editing === null && !(event.target as HTMLElement).closest(".mg-jl-fold, button, .cell-pop-backdrop")) {
          startEdit();
        }
      }}
      onContextMenu={(event) => {
        // While editing, the editor keeps the browser's own menu; the block's
        // own menu and Quick Look keep theirs.
        if (editing === null && !(event.target as HTMLElement).closest(".context-layer, .cell-pop-backdrop")) {
          event.preventDefault();
          openMenu(event.clientX, event.clientY, null, event.currentTarget);
        }
      }}
      onAuxClick={(event) => {
        if (editing === null && event.button === 1 && !(event.target as HTMLElement).closest(".context-layer, .cell-pop-backdrop")) {
          event.preventDefault();
          lookAt("", event.currentTarget);
        }
      }}
    >
      <div className="mg-jdoc-no">#{(position + 1).toLocaleString()}</div>
      <span className="mg-jdoc-acts">
        {ro ? null : (
          <button type="button" className="icon-text-button" title={t("이 자리에서 편집 (두 번 눌러도 됩니다)")} onClick={startEdit}>
            <PencilIcon size={10} />
            {t("편집 [버튼]")}
          </button>
        )}
        {!ro && onClone ? (
          <button type="button" className="icon-text-button" onClick={() => onClone(doc)}>
            <CloneIcon size={10} />
            {t("복제")}
          </button>
        ) : null}
        <button type="button" className="icon-text-button" title={json ? t("JSON으로 복사") : canonical ? t("Extended JSON으로 복사") : t("mongosh 표기로 복사")} onClick={copy}>
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
      {menu !== null ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} /> : null}
      {look !== null ? <ValueQuickLook target={look} where={null} onClose={() => setLook(null)} /> : null}
    </div>
  );
}

export interface JsonViewProps {
  docs: BsonDocument[];
  offset: number;
  // Canonical Extended JSON instead of mongosh notation.
  canonical: boolean;
  // Plain JSON documents (the search engines) instead of either.
  json?: boolean;
  // Nested values folded (the toolbar's 모두 접기).
  allFolded: boolean;
  readOnly: boolean;
  completion?: () => CompletionContext;
  onSave?(doc: BsonDocument, value: BsonDocument): Promise<Error | null>;
  onClone?(doc: BsonDocument): void;
  onDelete?(doc: BsonDocument): void;
  notify(message: string): void;
  emptyText?: string;
  // The block shown in the app's detail panel (its docKey), picked by a click
  // on a block or the arrow keys; omitted where nothing is picked.
  selected?: string | null;
  onSelect?(key: string): void;
}

export function JsonView({ docs, offset, emptyText, json = false, selected = null, onSelect, ...rest }: JsonViewProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  // The picked block's document in Quick Look (⌘↩).
  const [look, setLook] = useState<QuickLookTarget | null>(null);
  useOnItemsChange(docs, () => setLook(null));
  if (docs.length === 0) {
    return (
      <div className="mg-jdocs">
        <div className="panel-empty">{emptyText ?? t("조건에 맞는 문서가 없습니다")}</div>
      </div>
    );
  }
  const keys = docs.map((doc, i) => docKey(doc, offset + i));
  const pick = (index: number) => {
    const key = keys[index];
    if (key !== undefined && onSelect !== undefined) {
      onSelect(key);
      listRef.current?.children[index]?.scrollIntoView({ block: "nearest" });
    }
  };
  return (
    <div
      ref={listRef}
      className="mg-jdocs"
      tabIndex={-1}
      onKeyDown={(event) => {
        const at = selected === null ? -1 : keys.indexOf(selected);
        // ⌘↩ on the list (not in a block's editor) shows the picked document in Quick Look, as on a grid cell.
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && at >= 0 && (event.target === event.currentTarget || (event.target as HTMLElement).matches(".mg-jdoc"))) {
          event.preventDefault();
          setLook({ name: `#${(offset + at + 1).toLocaleString()}`, value: docs[at], position: offset + at, anchor: anchorOf(listRef.current?.children[at] ?? null) });
          return;
        }
        const next = onSelect === undefined ? null : arrowStep(event, keys.length, at);
        if (next !== null) {
          event.preventDefault();
          pick(next);
        }
      }}
    >
      {docs.map((doc, i) => (
        <JsonBlock
          key={keys[i]}
          doc={doc}
          position={offset + i}
          json={json}
          selected={keys[i] === selected}
          onActivate={onSelect === undefined ? undefined : () => onSelect(keys[i])}
          onPick={
            onSelect === undefined
              ? undefined
              : () => {
                  pick(i);
                  listRef.current?.focus({ preventScroll: true });
                }
          }
          {...rest}
        />
      ))}
      {/* After the blocks, so a block's index is still its child's. */}
      {look !== null ? (
        <ValueQuickLook
          target={look}
          where={null}
          onClose={() => {
            setLook(null);
            listRef.current?.focus({ preventScroll: true });
          }}
        />
      ) : null}
    </div>
  );
}
