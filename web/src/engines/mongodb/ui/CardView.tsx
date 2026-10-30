// ☰ list view: one card per document, laid out like the app's row-detail
// field boxes (name · value box · type). Nested documents and arrays fold
// in place. Everything is edited inline on a per-card draft: the whole value
// box is the edit target, the type label opens the type menu, a key is
// renamed by double-clicking it; the draft is saved as one guarded
// updateOne (see useDocEdits). `DocFields` is the card body alone, which
// the app's detail panel reuses. A click on a card's head or the arrow keys
// pick the card the detail panel shows.

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { writeClipboard } from "../../../clipboard";
import { ContextMenu, type ContextMenuItem } from "../../../components/ContextMenu";
import { FieldError, fieldErrorProps } from "../../../components/ErrorNotice";
import { CheckIcon, ChevronIcon, CloseIcon, CopyIcon, PlusIcon, TrashIcon } from "../../../components/icons";
import { phrase, say, t, type Phrase } from "../../../i18n";
import { deepEqual, isDocument, stringifyJson, toEJSON, typeName, type BsonDocument, type BsonTypeName, type BsonValue } from "../bson";
import { VIEW_LIMITS, ejsonText, preview, toShell, truncation } from "../format";
import { valueAt, type DocEdit } from "../guard";
import { BracesIcon, CloneIcon } from "./icons";
import { arrowStep, selectsItem } from "./selection";
import { ShellText } from "./ShellText";
import { EDIT_TYPES, coerceInput, convertType, editText, valueText } from "./valueEdit";
import { WriteErrorNotice, validationProblems } from "./writeErrors";

// ---- Draft helpers ----

function cloneBson<T extends BsonValue>(v: T): T {
  if (Array.isArray(v)) {
    return v.map((x) => cloneBson(x)) as T;
  }
  if (isDocument(v)) {
    const doc: BsonDocument = v;
    return new Map(Array.from(doc, ([key, value]) => [key, cloneBson(value)])) as T;
  }
  return v;
}

function join(base: string, key: string): string {
  return base === "" ? key : `${base}.${key}`;
}

// The edits that turn `o` into `d`: changed leaves and elements as `set`,
// new fields as `add`, removed ones as `unset`; an array whose length
// changed is set whole (its later elements moved).
export function diffEdits(o: BsonDocument, d: BsonDocument, base = ""): DocEdit[] {
  const out: DocEdit[] = [];
  const walk = (ov: BsonValue, dv: BsonValue, path: string) => {
    if (isDocument(ov) && isDocument(dv)) {
      for (const [key, value] of dv) {
        const old = ov.get(key);
        if (old !== undefined) {
          walk(old, value, join(path, key));
        } else {
          out.push({ op: "add", path: join(path, key), value });
        }
      }
      for (const key of ov.keys()) {
        if (!dv.has(key)) {
          out.push({ op: "unset", path: join(path, key) });
        }
      }
    } else if (Array.isArray(ov) && Array.isArray(dv) && ov.length === dv.length && path !== "") {
      dv.forEach((x, i) => walk(ov[i], x, join(path, String(i))));
    } else if (!deepEqual(ov, dv)) {
      out.push({ op: "set", path, value: dv });
    }
  };
  walk(o, d, base);
  return out;
}

type Mark = "changed" | "added";

// Paths that look different in the draft, for the yellow and green marks,
// and how many fields or elements went.
function visualDiff(o: BsonDocument, d: BsonDocument): { marks: Map<string, Mark>; removed: number; count: number } {
  const marks = new Map<string, Mark>();
  let removed = 0;
  const walk = (ov: BsonValue | undefined, dv: BsonValue, path: string) => {
    if (isDocument(ov) && isDocument(dv)) {
      for (const [key, value] of dv) {
        const p = join(path, key);
        if (ov.has(key)) {
          walk(ov.get(key), value, p);
        } else {
          marks.set(p, "added");
        }
      }
      removed += [...ov.keys()].filter((key) => !dv.has(key)).length;
    } else if (Array.isArray(ov) && Array.isArray(dv)) {
      dv.forEach((x, i) => {
        if (i < ov.length) {
          walk(ov[i], x, join(path, String(i)));
        } else {
          marks.set(join(path, String(i)), "added");
        }
      });
      removed += Math.max(0, ov.length - dv.length);
    } else if (!deepEqual(ov, dv)) {
      marks.set(path, "changed");
    }
  };
  walk(o, d, "");
  return { marks, removed, count: marks.size + removed };
}

function parentAt(doc: BsonDocument, path: string): { parent: BsonDocument | BsonValue[]; key: string; base: string } {
  const parts = path.split(".");
  const key = parts.pop() ?? "";
  const base = parts.join(".");
  const parent = base === "" ? doc : valueAt(doc, base);
  if (!isDocument(parent) && !Array.isArray(parent)) {
    throw new Error(`no container at ${base}`);
  }
  return { parent, key, base };
}

function setAt(doc: BsonDocument, path: string, value: BsonValue): void {
  const { parent, key } = parentAt(doc, path);
  if (Array.isArray(parent)) {
    parent[Number(key)] = value;
  } else {
    parent.set(key, value);
  }
}

// Rewrites `obj` in place with its keys in a new order or names.
function rebuild(obj: BsonDocument, entries: [string, BsonValue][]): void {
  obj.clear();
  for (const [key, value] of entries) {
    obj.set(key, value);
  }
}

function uniqueKey(obj: BsonDocument): string {
  let n = 1;
  while (obj.has(`field${n}`)) {
    n++;
  }
  return `field${n}`;
}

function isContainer(v: BsonValue): v is BsonDocument | BsonValue[] {
  return Array.isArray(v) || isDocument(v);
}

// ---- Inline input ----

function InlineInput({ initial, className, error, errorId, onCommit, onCancel }: { initial: string; className: string; error: string | null; errorId: string; onCommit(text: string): void; onCancel(): void }) {
  const ref = useRef<HTMLInputElement | null>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  useEffect(() => {
    // A rejected value keeps the box open for another try.
    if (error !== null) {
      done.current = false;
      ref.current?.focus();
    }
  }, [error]);
  const commit = () => {
    if (!done.current) {
      done.current = true;
      onCommit(ref.current?.value ?? "");
    }
  };
  return (
    <input
      ref={ref}
      type="text"
      className={`mg-f-input ${className}${error !== null ? " invalid" : ""}`}
      defaultValue={initial}
      spellCheck={false}
      {...fieldErrorProps(errorId, error)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          done.current = true;
          onCancel();
        }
      }}
      onBlur={commit}
    />
  );
}

// ---- Field rows ----

export interface DocFieldsProps {
  // The document as loaded; edits are guarded against it.
  doc: BsonDocument;
  readOnly?: boolean;
  // Field search: rows whose path (or a path below) contains the text.
  filter?: string;
  // All nested values open (the toolbar's 모두 펼치기).
  allOpen?: boolean;
  // Saves the draft; resolves null when saved, else the failure to show.
  onSave?(edits: DocEdit[]): Promise<Error | null>;
  onDirtyChange?(dirty: boolean): void;
  // Above the rows (the card head).
  head?: ReactNode;
  className?: string;
  // The type shown beside a value instead of its BSON type name (a search
  // index's mapping type: keyword, long, date…); null keeps the BSON name.
  // `path` is dotted, with array positions.
  typeLabel?(path: string, value: BsonValue): string | null;
}

interface Editing {
  path: string;
  mode: "value" | "key";
  // Translated where it shows, so it follows a language switch.
  error: Phrase | null;
  // A brand-new field: after naming it, edit its value.
  fresh: boolean;
}

export function DocFields({ doc, readOnly = false, filter = "", allOpen = false, onSave, onDirtyChange, head, className, typeLabel }: DocFieldsProps) {
  // The draft keeps the document it started from, so a page reload under
  // an unsaved draft does not change what the save is guarded against.
  const [draft, setDraft] = useState<{ base: BsonDocument; value: BsonDocument } | null>(null);
  const [toggled, setToggled] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<Error | null>(null);
  // A validation failure's fields, marked in place.
  const problems = useMemo(() => validationProblems(error), [error]);
  const idBase = useId();
  const [saving, setSaving] = useState(false);
  const [full, setFull] = useState(false);
  const [typeMenu, setTypeMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  useEffect(() => setToggled(new Set()), [allOpen]);

  const cur = draft?.value ?? doc;
  const diff = useMemo(() => (draft ? visualDiff(draft.base, draft.value) : null), [draft]);
  const dirty = draft !== null;
  const ro = readOnly || onSave === undefined;
  const cut = useMemo(() => (full ? null : truncation(cur)), [cur, full]);
  const cutArrays = useMemo(() => new Set(cut?.arrays.map((a) => a.path)), [cut]);

  const dirtyRef = useRef(onDirtyChange);
  dirtyRef.current = onDirtyChange;
  useEffect(() => dirtyRef.current?.(dirty), [dirty]);
  useEffect(() => () => dirtyRef.current?.(false), []);

  const isOpen = (path: string) => toggled.has(path) !== allOpen;
  const toggle = (path: string) =>
    setToggled((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) {
        next.add(path);
      }
      return next;
    });

  // Applies `change` to a copy of the draft (made from the document when
  // there is none); a draft equal to its base is dropped.
  const mutate = (change: (d: BsonDocument) => void) => {
    const start = draft ?? { base: doc, value: doc };
    const value = cloneBson(start.value);
    change(value);
    setDraft(deepEqual(value, start.base) ? null : { base: start.base, value });
    setError(null);
  };

  const matches = (path: string, v: BsonValue): boolean => {
    const q = filter.trim().toLowerCase();
    if (q === "" || path.toLowerCase().includes(q)) {
      return true;
    }
    if (isDocument(v)) {
      return [...v].some(([k, x]) => matches(join(path, k), x));
    }
    return Array.isArray(v) && v.some((x, i) => matches(join(path, String(i)), x));
  };

  const commitValue = (path: string, text: string) => {
    const old = valueAt(cur, path);
    const type: BsonTypeName = old === undefined ? "String" : typeName(old);
    const r = coerceInput(text, type);
    if ("error" in r) {
      setEditing((e) => (e === null ? e : { ...e, error: r.error }));
      return;
    }
    setEditing(null);
    if (old === undefined || !deepEqual(old, r.value)) {
      mutate((d) => setAt(d, path, r.value));
    }
  };

  const commitKey = (path: string, text: string, fresh: boolean) => {
    const name = text.trim();
    const { parent, key, base: parentPath } = parentAt(cur, path);
    if (Array.isArray(parent)) {
      setEditing(null);
      return;
    }
    if (name !== "" && name !== key) {
      if (parent.has(name)) {
        setEditing((e) => (e === null ? e : { ...e, error: phrase("이미 있는 필드 이름입니다: {name}", { name }) }));
        return;
      }
      if (name.startsWith("$") || name.includes(".")) {
        setEditing((e) => (e === null ? e : { ...e, error: phrase("필드 이름에는 $로 시작하거나 .을 넣을 수 없습니다") }));
        return;
      }
      mutate((d) => {
        const { parent: p } = parentAt(d, path);
        if (!Array.isArray(p)) {
          rebuild(p, Array.from(p, ([k, x]): [string, BsonValue] => [k === key ? name : k, x]));
        }
      });
    }
    const renamed = name !== "" && name !== key ? join(parentPath, name) : path;
    setEditing(fresh ? { path: renamed, mode: "value", error: null, fresh: false } : null);
  };

  const remove = (path: string) =>
    mutate((d) => {
      const { parent, key } = parentAt(d, path);
      if (Array.isArray(parent)) {
        parent.splice(Number(key), 1);
      } else {
        parent.delete(key);
      }
    });

  // New field or element: at the end of the document, inside a container,
  // or after a row. A field is named first; an element goes straight to
  // its value.
  const add = (how: "top" | "child" | "after", path: string) => {
    let target = "";
    let mode: "key" | "value" = "key";
    mutate((d) => {
      if (how === "top") {
        target = uniqueKey(d);
        d.set(target, "");
        return;
      }
      if (how === "child") {
        const c = valueAt(d, path);
        if (Array.isArray(c)) {
          c.push("");
          target = join(path, String(c.length - 1));
          mode = "value";
        } else if (isDocument(c)) {
          target = join(path, uniqueKey(c));
          c.set(target.slice(target.lastIndexOf(".") + 1), "");
        }
        return;
      }
      const { parent, key, base: parentPath } = parentAt(d, path);
      if (Array.isArray(parent)) {
        parent.splice(Number(key) + 1, 0, "");
        target = join(parentPath, String(Number(key) + 1));
        mode = "value";
      } else {
        const name = uniqueKey(parent);
        const entries = [...parent].flatMap((entry): [string, BsonValue][] => (entry[0] === key ? [entry, [name, ""]] : [entry]));
        rebuild(parent, entries);
        target = join(parentPath, name);
      }
    });
    if (how === "child" && !isOpen(path)) {
      toggle(path);
    }
    setEditing({ path: target, mode, error: null, fresh: mode === "key" });
  };

  const changeType = (path: string, type: BsonTypeName) => {
    const old = valueAt(cur, path);
    if (old === undefined || typeName(old) === type) {
      return;
    }
    mutate((d) => setAt(d, path, convertType(old, type)));
    if ((type === "Object" || type === "Array") && !isOpen(path)) {
      toggle(path);
    }
  };

  const save = async () => {
    if (draft === null || onSave === undefined) {
      return;
    }
    const edits = diffEdits(draft.base, draft.value);
    if (edits.length === 0) {
      setDraft(null);
      return;
    }
    setSaving(true);
    setError(null);
    const failure = await onSave(edits);
    setSaving(false);
    if (failure === null) {
      setDraft(null);
    } else {
      setError(failure);
    }
  };

  const rows = (obj: BsonDocument | BsonValue[], parentPath: string, depth: number): ReactNode[] => {
    const inArray = Array.isArray(obj);
    let keys = inArray ? obj.map((_, i) => String(i)) : [...obj.keys()];
    let more: ReactNode = null;
    if (cut !== null && depth === 0 && !inArray && cut.shownFields < keys.length) {
      more = (
        <div key="#more" className="mg-n mg-more">
          {t("… 필드 {count}개 더", { count: keys.length - cut.shownFields })}
          <button type="button" className="icon-text-button" onClick={() => setFull(true)}>
            {t("전체 보기")}
          </button>
        </div>
      );
      keys = keys.slice(0, cut.shownFields);
    } else if (inArray && cutArrays.has(parentPath) && keys.length > VIEW_LIMITS.arrayItems) {
      more = (
        <div key="#more" className="mg-n mg-more" style={{ paddingLeft: depth * 16 + 4 }}>
          {t("… {count}개 더", { count: keys.length - VIEW_LIMITS.arrayItems })}
          <button type="button" className="icon-text-button" onClick={() => setFull(true)}>
            {t("전체 보기")}
          </button>
        </div>
      );
      keys = keys.slice(0, VIEW_LIMITS.arrayItems);
    }
    const out: ReactNode[] = [];
    for (const key of keys) {
      const v = (inArray ? obj[Number(key)] : obj.get(key)) as BsonValue;
      const path = join(parentPath, key);
      if (depth === 0 && !matches(path, v)) {
        continue;
      }
      const mark = diff?.marks.get(path) ?? null;
      const container = isContainer(v);
      const editable = !ro && path !== "_id";
      const open = container && isOpen(path);
      const editingThis = editing !== null && editing.path === path;
      const type = typeName(v);
      const shownType = typeLabel?.(path, v) ?? type;
      const errorId = `${idBase}-err-${encodeURIComponent(path)}`;
      const keyEl =
        editingThis && editing.mode === "key" ? (
          <InlineInput key="k" initial={key} className="key" error={editing.error === null ? null : say(editing.error)} errorId={errorId} onCommit={(text) => commitKey(path, text, editing.fresh)} onCancel={() => setEditing(null)} />
        ) : inArray ? (
          <span className="mg-f-key idx">{key}</span>
        ) : (
          <span
            className="mg-f-key"
            data-rename={editable ? "" : undefined}
            title={editable ? t("{key} — 두 번 눌러 이름 바꾸기", { key }) : key}
            onDoubleClick={
              editable
                ? (event) => {
                    event.stopPropagation();
                    setEditing({ path, mode: "key", error: null, fresh: false });
                  }
                : undefined
            }
          >
            {key}
          </span>
        );
      let valEl: ReactNode;
      if (container) {
        const p = preview(v, 48);
        valEl = (
          <span className="mg-f-sum">
            <span className={`cell-pop-chevron${open ? " open" : ""}`}>
              <ChevronIcon size={9} />
            </span>
            <span className={`mg-f-count ${Array.isArray(v) ? "arr" : "obj"}`}>{p.badge}</span>
            {open ? null : <span className="mg-f-prev">{p.text}</span>}
          </span>
        );
      } else if (editingThis && editing.mode === "value") {
        valEl = <InlineInput initial={editText(v)} className={`t-${type}`} error={editing.error === null ? null : say(editing.error)} errorId={errorId} onCommit={(text) => commitValue(path, text)} onCancel={() => setEditing(null)} />;
      } else {
        valEl = <span className={`mg-f-val t-${type}`}>{valueText(v)}</span>;
      }
      const typeEl = (
        <button
          type="button"
          className="mg-f-type"
          disabled={!editable}
          title={editable ? `${t("타입 바꾸기")} (${type})` : type}
          onClick={(event) => {
            event.stopPropagation();
            const r = event.currentTarget.getBoundingClientRect();
            setTypeMenu({ x: r.left, y: r.bottom + 2, path });
          }}
        >
          {shownType}
        </button>
      );
      const acts = ro ? null : (
        <span className="mg-f-acts">
          {container ? (
            <button type="button" title={Array.isArray(v) ? t("원소 추가") : t("하위 필드 추가")} onClick={(event) => (event.stopPropagation(), add("child", path))}>
              <PlusIcon size={8} />
            </button>
          ) : (
            <button type="button" title={t("아래에 추가")} onClick={(event) => (event.stopPropagation(), add("after", path))}>
              <PlusIcon size={8} />
            </button>
          )}
          {path === "_id" ? null : (
            <button type="button" title={t("지우기")} onClick={(event) => (event.stopPropagation(), remove(path))}>
              <CloseIcon size={8} />
            </button>
          )}
        </span>
      );
      // A value the input refused, else what the last save's validation
      // said about this field.
      const problem = editingThis && editing.error !== null ? say(editing.error) : (problems.get(path) ?? null);
      const fieldError = problem !== null ? <FieldError id={errorId} error={problem} /> : null;
      // The whole box (or nested row) answers a click: a value is edited, an
      // object or array opens and closes.
      const onActivate = container ? () => toggle(path) : editable && !editingThis ? () => setEditing({ path, mode: "value", error: null, fresh: false }) : undefined;
      if (depth === 0) {
        out.push(
          <div key={path} className={`mg-f top${mark ? ` ${mark}` : ""}${problems.has(path) ? " invalid" : ""}`} data-path={path}>
            {keyEl}
            <div className={`mg-f-box${container ? " tree" : editable ? " editable" : ""}`} onClick={container ? undefined : onActivate}>
              <div className="mg-f-line" onClick={container ? onActivate : undefined}>
                {valEl}
              </div>
              {fieldError}
              {open ? (
                <div className="mg-kids">
                  {rows(v, path, 1)}
                  {(Array.isArray(v) ? v.length : v.size) === 0 ? <div className="mg-n empty">{Array.isArray(v) ? t("빈 배열") : t("빈 문서")}</div> : null}
                </div>
              ) : null}
            </div>
            {typeEl}
            {acts}
          </div>,
        );
      } else {
        out.push(
          <div key={path} className={`mg-n${mark ? ` ${mark}` : ""}${!container && editable ? " editable" : ""}${container ? " tree" : ""}${problems.has(path) ? " invalid" : ""}`} data-path={path} style={{ paddingLeft: (depth - 1) * 16 + 4 }} onClick={onActivate}>
            {keyEl}
            <span className="mg-n-colon">:</span>
            {valEl}
            <span className="spacer" />
            {typeEl}
            {acts}
          </div>,
        );
        if (fieldError !== null) {
          out.push(
            <div key={`${path}#err`} style={{ paddingLeft: (depth - 1) * 16 + 4 }}>
              {fieldError}
            </div>,
          );
        }
        if (open) {
          out.push(...rows(v, path, depth + 1));
          if ((Array.isArray(v) ? v.length : v.size) === 0) {
            out.push(
              <div key={`${path}#empty`} className="mg-n empty" style={{ paddingLeft: depth * 16 + 4 }}>
                {Array.isArray(v) ? t("빈 배열") : t("빈 문서")}
              </div>,
            );
          }
        }
      }
    }
    if (more !== null) {
      out.push(more);
    }
    return out;
  };

  const keyWidth = Math.min(18, Math.max(4, ...Array.from(cur.keys(), (k) => [...k].length)));
  const menuValue = typeMenu === null ? undefined : valueAt(cur, typeMenu.path);
  const menuItems: ContextMenuItem[] =
    typeMenu === null || menuValue === undefined
      ? []
      : EDIT_TYPES.map((type) => ({ label: type, checked: typeName(menuValue) === type, onSelect: () => changeType(typeMenu.path, type) }));

  return (
    <div className={`mg-card${dirty ? " dirty" : ""}${ro ? " ro" : ""}${className ? ` ${className}` : ""}`}>
      {head}
      <div className="mg-card-body" style={{ ["--kw" as string]: `${keyWidth + 1}ch` }}>
        {rows(cur, "", 0)}
        {ro ? null : (
          <button type="button" className="mg-add-field" onClick={() => add("top", "")}>
            <PlusIcon size={9} />
            {t("필드 추가")}
          </button>
        )}
      </div>
      {draft !== null && diff !== null ? (
        <div className="mg-card-foot">
          <span className="pending-dot" aria-hidden="true" />
          <span className="mg-card-count">
            {t("변경 {count}건", { count: diff.count })}
            {diff.removed > 0 ? ` (${t("삭제 {count}", { count: diff.removed })})` : ""}
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="pending-discard"
            disabled={saving}
            onClick={() => {
              setDraft(null);
              setEditing(null);
              setError(null);
            }}
          >
            {t("취소")}
          </button>
          <button type="button" className="primary pending-apply" disabled={saving || editing !== null} onClick={() => void save()}>
            <CheckIcon size={10} />
            {t("저장")}
          </button>
        </div>
      ) : null}
      {draft !== null && error !== null ? (
        <div className="mg-card-failure">
          <WriteErrorNotice error={error} onClose={() => setError(null)} />
        </div>
      ) : null}
      {typeMenu !== null && menuItems.length > 0 ? <ContextMenu x={typeMenu.x} y={typeMenu.y} items={menuItems} onClose={() => setTypeMenu(null)} /> : null}
    </div>
  );
}

// ---- Cards ----

// A stable key for a document across reloads: its _id, else its position.
export function docKey(doc: BsonValue, position: number): string {
  const id = isDocument(doc) ? doc.get("_id") : undefined;
  return id !== undefined ? toShell(id) : `#${position}`;
}

export interface CardViewProps {
  docs: BsonDocument[];
  // Position of the first document in the whole result (for `#n`).
  offset: number;
  readOnly: boolean;
  allOpen: boolean;
  // Saves the edits of one card; omitted for read-only results.
  onSave?(original: BsonDocument, edits: DocEdit[]): Promise<Error | null>;
  onEditJson?(doc: BsonDocument): void;
  onClone?(doc: BsonDocument): void;
  onDelete?(doc: BsonDocument): void;
  notify(message: string): void;
  // How many cards hold unsaved changes.
  onDirtyCount?(count: number): void;
  emptyText?: string;
  // Plain JSON documents (the search engines): copy as JSON, edit as JSON.
  json?: boolean;
  // More in a card's head after the `_id` (a search hit's score and index).
  headExtra?(doc: BsonDocument): ReactNode;
  // See DocFieldsProps.typeLabel.
  typeLabel?(path: string, value: BsonValue): string | null;
  // The card shown in the app's detail panel (its docKey), picked by a click
  // on a card's head or the arrow keys; omitted where nothing is picked.
  selected?: string | null;
  onSelect?(key: string): void;
}

export function CardView({ docs, offset, readOnly, allOpen, onSave, onEditJson, onClone, onDelete, notify, onDirtyCount, emptyText, json = false, headExtra, typeLabel, selected = null, onSelect }: CardViewProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const dirtyKeys = useRef(new Set<string>());
  const countRef = useRef(onDirtyCount);
  countRef.current = onDirtyCount;

  if (docs.length === 0) {
    return (
      <div className="mg-cards">
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
      className="mg-cards"
      tabIndex={-1}
      onKeyDown={(event) => {
        const next = onSelect === undefined ? null : arrowStep(event, keys.length, selected === null ? -1 : keys.indexOf(selected));
        if (next !== null) {
          event.preventDefault();
          pick(next);
        }
      }}
    >
      {docs.map((doc, i) => {
        const key = keys[i];
        const id = doc.get("_id");
        const editable = !readOnly && id !== undefined && onSave !== undefined;
        const head = (
          <div
            className="mg-card-head"
            onClick={(event) => {
              if (onSelect !== undefined && selectsItem(event.target)) {
                pick(i);
                listRef.current?.focus({ preventScroll: true });
              }
            }}
          >
            <span className="mg-doc-no">#{(offset + i + 1).toLocaleString()}</span>
            {id !== undefined ? <ShellText className="mg-doc-id" text={toShell(id)} /> : null}
            {headExtra?.(doc)}
            <span className="spacer" />
            <span className="mg-card-actions">
              {editable && onEditJson ? (
                <button type="button" className="icon-text-button" title={json ? t("JSON으로 편집") : t("셸 형식 JSON으로 편집 (replaceOne)")} onClick={() => onEditJson(doc)}>
                  <BracesIcon size={10} />
                  JSON
                </button>
              ) : null}
              {editable && onClone ? (
                <button type="button" className="icon-text-button" title={t("이 문서를 복제해 새로 추가")} onClick={() => onClone(doc)}>
                  <CloneIcon size={10} />
                  {t("복제")}
                </button>
              ) : null}
              <button
                type="button"
                className="icon-text-button"
                title={json ? t("JSON으로 복사") : t("Extended JSON으로 복사")}
                onClick={() => {
                  void writeClipboard(json ? ejsonText(doc, { relaxed: true, exactNumbers: true }) : stringifyJson(toEJSON(doc), 2), notify);
                  notify(json ? t("JSON으로 복사했습니다") : t("Extended JSON으로 복사했습니다"));
                }}
              >
                <CopyIcon size={10} />
                {t("복사")}
              </button>
              {editable && onDelete ? (
                <button type="button" className="icon-text-button mg-danger-text" title={t("문서 삭제")} onClick={() => onDelete(doc)}>
                  <TrashIcon size={10} />
                  {t("삭제")}
                </button>
              ) : null}
            </span>
          </div>
        );
        return (
          <DocFields
            key={key}
            doc={doc}
            readOnly={!editable}
            allOpen={allOpen}
            head={head}
            className={key === selected ? "selected" : undefined}
            typeLabel={typeLabel}
            onSave={editable && onSave ? (edits) => onSave(doc, edits) : undefined}
            onDirtyChange={(dirty) => {
              const had = dirtyKeys.current.has(key);
              if (dirty === had) {
                return;
              }
              if (dirty) {
                dirtyKeys.current.add(key);
              } else {
                dirtyKeys.current.delete(key);
              }
              countRef.current?.(dirtyKeys.current.size);
            }}
          />
        );
      })}
    </div>
  );
}
