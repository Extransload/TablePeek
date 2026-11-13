// The rows of a hash, list, set, sorted set or stream, RedisInsight-style:
// each row edits in place (its pencil, a double-click or ↩ on the selected
// row; ↩ saves, ⇧↩ breaks a line, Esc cancels), deletes from its trash button after a
// small confirm, and new rows (several at once) are typed into rows of
// boxes above the list. Byte values that aren't UTF-8 edit as hex. ↑ ↓
// move the selection. Values are coloured by kind as the data grid colours
// them (numbers, booleans, null-ish words, JSON token by token); a long one
// is cut with a control to show it all, and opens (its ⤢, the row's
// button, Space) in the string view's panel over the table, where a long
// value is also edited.

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ErrorNotice, notifyError } from "../../../components/ErrorNotice";
import { CheckIcon, CloseIcon, CopyIcon, ExpandIcon, PencilIcon, PlusIcon, TrashIcon } from "../../../components/icons";
import { t } from "../../../i18n";
import { jsonSpans } from "../../../jsonIndex";
import { binFromHex, binText, hexOf, isText, type Bin } from "../bin";
import { cellInk, minifyJson } from "../valueFormat";
import { ConfirmPopover, type RedisHost } from "./common";
import { ValuePanel } from "./ValuePanel";

// A column; `edit` makes it a box when the row edits.
export interface Col<R> {
  id: string;
  label: string;
  className?: string;
  cell(row: R, open?: () => void): ReactNode;
  // The column's bytes, for the value viewer.
  open?(row: R): Bin;
  edit?: {
    // The column's value of a row (null: a new row).
    value(row: R | null): Bin;
    multiline?: boolean;
    placeholder?: string;
    // Plain text checked by `valid` (a score), never bytes.
    plain?: boolean;
    valid?(text: string): boolean;
  };
}

interface Draft {
  text: string;
  hex: boolean;
}

function draftOf(bin: Bin): Draft {
  return isText(bin) ? { text: bin, hex: false } : { text: hexOf(bin), hex: true };
}

// The values typed, by column; null while a box holds something it can't send.
function valuesOf<R>(cols: Col<R>[], drafts: Record<string, Draft>): Record<string, Bin> | null {
  const out: Record<string, Bin> = {};
  for (const col of cols) {
    if (col.edit === undefined) {
      continue;
    }
    const draft = drafts[col.id];
    if (col.edit.plain === true) {
      if (col.edit.valid !== undefined && !col.edit.valid(draft.text)) {
        return null;
      }
      out[col.id] = draft.text.trim();
      continue;
    }
    const bin = draft.hex ? binFromHex(draft.text) : draft.text;
    if (bin === null) {
      return null;
    }
    out[col.id] = bin;
  }
  return out;
}

function Box({ draft, multiline, placeholder, autoFocus, bad, onChange, onKey }: { draft: Draft; multiline?: boolean; placeholder?: string; autoFocus?: boolean; bad: boolean; onChange(text: string): void; onKey(event: ReactKeyboardEvent): void }) {
  const props = {
    className: `kv-box mono${bad ? " invalid" : ""}`,
    spellCheck: false,
    autoFocus,
    placeholder: draft.hex ? t("16진수 (예: 0a ff)") : placeholder,
    value: draft.text,
    onKeyDown: onKey,
  };
  return (
    <span className="kv-box-wrap">
      {draft.hex ? <span className="kv-bin-mark">hex</span> : null}
      {multiline ? (
        <textarea {...props} rows={Math.min(8, Math.max(1, draft.text.split("\n").length))} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <input type="text" {...props} onChange={(event) => onChange(event.target.value)} />
      )}
    </span>
  );
}

export function RowsTable<R>({
  rows,
  rowId,
  cols,
  readOnly,
  adding,
  addLabel,
  onSave,
  onAdd,
  onAddClose,
  onDelete,
  onCopy,
  empty,
  canEdit = true,
  host,
  path,
}: {
  rows: R[];
  rowId(row: R): string;
  cols: Col<R>[];
  readOnly: boolean;
  // New rows being typed (the bar's + opens them).
  adding: boolean;
  addLabel: string;
  // false: not saved (the question was declined).
  onSave(row: R, values: Record<string, Bin>): Promise<boolean | void>;
  onAdd(values: Record<string, Bin>[]): Promise<void>;
  onAddClose(): void;
  onDelete(row: R): Promise<void>;
  onCopy(row: R): void;
  empty: string;
  canEdit?: boolean;
  // The connection (copy, notices) and the key's path, for the value viewer.
  host: RedisHost;
  path: string;
}) {
  const editCols = cols.filter((col) => col.edit !== undefined);
  const [editing, setEditing] = useState<{ id: string; drafts: Record<string, Draft> } | null>(null);
  const [news, setNews] = useState<Record<string, Draft>[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ row: R; anchor: HTMLElement } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const blank = (): Record<string, Draft> => Object.fromEntries(editCols.map((col) => [col.id, draftOf(col.edit?.value(null) ?? "")]));
  useEffect(() => {
    setNews(adding ? [blank()] : []);
    setFailure(null);
    // A fresh set of boxes each time adding opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adding]);

  // The value viewer: which row's which column, and whether it opened to edit.
  const [viewing, setViewing] = useState<{ id: string; col: string; edit: boolean } | null>(null);
  const openCols = cols.filter((col) => col.open !== undefined);
  const mainCol = openCols[openCols.length - 1];
  const open = (row: R, col: Col<R> | undefined = mainCol, edit = false) => {
    if (col !== undefined) {
      setSelected(rowId(row));
      setViewing({ id: rowId(row), col: col.id, edit });
    }
  };

  const startEdit = (row: R) => {
    if (readOnly || !canEdit || editCols.length === 0) {
      return;
    }
    // A long value is edited in the viewer, not a box in the row.
    const long = editCols.find((col) => col.open !== undefined && isLong(col.open(row)));
    if (long !== undefined) {
      open(row, long, true);
      return;
    }
    setFailure(null);
    setEditing({ id: rowId(row), drafts: Object.fromEntries(editCols.map((col) => [col.id, draftOf(col.edit?.value(row) ?? "")])) });
  };

  const saveEdit = async (row: R) => {
    if (editing === null || busy) {
      return;
    }
    const values = valuesOf(cols, editing.drafts);
    if (values === null) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await onSave(row, values);
      setEditing(null);
      wrapRef.current?.focus();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };

  const saveNew = async () => {
    const values = news.map((drafts) => valuesOf(cols, drafts));
    if (busy || values.some((value) => value === null) || values.length === 0) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await onAdd(values as Record<string, Bin>[]);
      onAddClose();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };

  const boxKeys = (save: () => void, cancel: () => void) => (event: ReactKeyboardEvent) => {
    // ↩ saves; ⇧↩ breaks the line in a multi-line box.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  };

  const at = rows.findIndex((row) => rowId(row) === selected);

  return (
    <div
      ref={wrapRef}
      className="kv-rows"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const next = rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))];
          if (next !== undefined) {
            setSelected(rowId(next));
            wrapRef.current?.querySelector(`[data-row="${CSS.escape(rowId(next))}"]`)?.scrollIntoView({ block: "nearest" });
          }
        } else if (event.key === "Enter" && at >= 0) {
          event.preventDefault();
          startEdit(rows[at]);
        } else if (event.key === " " && at >= 0) {
          // Space opens the value, as Quick Look does.
          event.preventDefault();
          open(rows[at]);
        } else if ((event.key === "Delete" || event.key === "Backspace") && at >= 0 && !readOnly) {
          event.preventDefault();
          const anchor = wrapRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(rowId(rows[at]))}"] .kv-row-del`);
          if (anchor) {
            setConfirm({ row: rows[at], anchor });
          }
        } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c" && at >= 0 && window.getSelection()?.toString() === "") {
          event.preventDefault();
          onCopy(rows[at]);
        }
      }}
    >
      <table className="kv-grid">
        <thead>
          <tr>
            {cols.map((col) => (
              <th key={col.id} className={col.className}>
                {col.label}
              </th>
            ))}
            <th className="kv-grid-actions" aria-label={t("작업")} />
          </tr>
        </thead>
        <tbody>
          {news.map((drafts, i) => {
            const bad = valuesOf(cols, drafts) === null;
            return (
              <tr key={`new:${i}`} className="kv-new-row">
                {cols.map((col) => (
                  <td key={col.id} className={col.className}>
                    {col.edit !== undefined ? (
                      <Box
                        draft={drafts[col.id]}
                        multiline={col.edit.multiline}
                        placeholder={col.edit.placeholder ?? col.label}
                        autoFocus={i === news.length - 1 && col === editCols[0]}
                        bad={bad && drafts[col.id].text !== "" && valuesOf([col], { [col.id]: drafts[col.id] }) === null}
                        onChange={(text) => setNews((prev) => prev.map((d, j) => (j === i ? { ...d, [col.id]: { ...d[col.id], text } } : d)))}
                        onKey={boxKeys(() => void saveNew(), onAddClose)}
                      />
                    ) : (
                      <span className="panel-dim">{t("새로")}</span>
                    )}
                  </td>
                ))}
                <td className="kv-grid-actions">
                  <button type="button" className="kv-icon" title={t("이 줄 빼기")} disabled={news.length === 1} onClick={() => setNews((prev) => prev.filter((_, j) => j !== i))}>
                    <CloseIcon size={10} />
                  </button>
                </td>
              </tr>
            );
          })}
          {news.length > 0 ? (
            <tr className="kv-new-bar">
              <td colSpan={cols.length + 1}>
                <button type="button" className="kv-link" onClick={() => setNews((prev) => [...prev, blank()])}>
                  <PlusIcon size={10} /> {t("줄 더하기")}
                </button>
                <span className="spacer" />
                <button type="button" onClick={onAddClose} disabled={busy}>
                  {t("취소")}
                </button>
                <button type="button" className="primary" disabled={busy || news.some((drafts) => valuesOf(cols, drafts) === null)} onClick={() => void saveNew()}>
                  {addLabel}
                </button>
              </td>
            </tr>
          ) : null}
          {rows.map((row) => {
            const id = rowId(row);
            const isEditing = editing?.id === id;
            return (
              <tr
                key={id}
                data-row={id}
                className={`${id === selected ? "selected" : ""}${isEditing ? " editing" : ""}`}
                onMouseDown={() => setSelected(id)}
                onDoubleClick={() => startEdit(row)}
              >
                {cols.map((col) => (
                  <td key={col.id} className={col.className}>
                    {isEditing && col.edit !== undefined && editing !== null ? (
                      <Box
                        draft={editing.drafts[col.id]}
                        multiline={col.edit.multiline}
                        placeholder={col.edit.placeholder}
                        autoFocus={col === editCols[editCols.length - 1]}
                        bad={valuesOf([col], { [col.id]: editing.drafts[col.id] }) === null}
                        onChange={(text) => setEditing((prev) => (prev === null ? prev : { ...prev, drafts: { ...prev.drafts, [col.id]: { ...prev.drafts[col.id], text } } }))}
                        onKey={boxKeys(() => void saveEdit(row), () => setEditing(null))}
                      />
                    ) : (
                      col.cell(row, col.open !== undefined ? () => open(row, col) : undefined)
                    )}
                  </td>
                ))}
                <td className="kv-grid-actions">
                  {isEditing ? (
                    <>
                      <button type="button" className="kv-icon ok" title={t("저장 (↩)")} disabled={busy || (editing !== null && valuesOf(cols, editing.drafts) === null)} onClick={() => void saveEdit(row)}>
                        <CheckIcon size={11} />
                      </button>
                      <button type="button" className="kv-icon" title={t("취소 (Esc)")} onClick={() => setEditing(null)}>
                        <CloseIcon size={10} />
                      </button>
                    </>
                  ) : (
                    <span className="kv-row-tools">
                      {mainCol !== undefined ? (
                        <button type="button" className="kv-icon" title={t("값 보기 (Space)")} onClick={() => open(row)}>
                          <ExpandIcon size={10} />
                        </button>
                      ) : null}
                      <button type="button" className="kv-icon" title={t("값 복사")} onClick={() => onCopy(row)}>
                        <CopyIcon size={10} />
                      </button>
                      {!readOnly && canEdit && editCols.length > 0 ? (
                        <button type="button" className="kv-icon" title={t("편집 [버튼]")} onClick={() => startEdit(row)}>
                          <PencilIcon size={10} />
                        </button>
                      ) : null}
                      {!readOnly ? (
                        <button type="button" className="kv-icon kv-row-del" title={t("삭제")} onClick={(event) => setConfirm({ row, anchor: event.currentTarget })}>
                          <TrashIcon size={10} />
                        </button>
                      ) : null}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && news.length === 0 ? <div className="kv-empty panel-dim">{empty}</div> : null}
      {failure !== null ? (
        <div className="kv-rows-error">
          <ErrorNotice error={failure} context="data" engine="redis" variant="compact" onClose={() => setFailure(null)} />
        </div>
      ) : null}
      {confirm !== null ? (
        <ConfirmPopover
          anchor={confirm.anchor}
          message={t("이 줄을 지울까요?")}
          okLabel={t("삭제")}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            const row = confirm.row;
            void onDelete(row).catch((error: unknown) => setFailure(error));
          }}
        />
      ) : null}
      {viewing !== null ? <Viewer rows={rows} rowId={rowId} cols={cols} viewing={viewing} host={host} path={path} editable={!readOnly && canEdit} onSave={onSave} onClose={() => {
        setViewing(null);
        wrapRef.current?.focus();
      }} /> : null}
    </div>
  );
}

// Past this a value is cut in its cell (and edited in the viewer).
const LONG_CHARS = 160;
const LONG_LINES = 3;
// What a cell draws of a value, at most; the viewer shows all of it.
const CELL_CHARS = 600;
const CELL_OPEN_CHARS = 20_000;

function isLong(bin: Bin): boolean {
  if (!isText(bin)) {
    return hexOf(bin, LONG_CHARS).length >= LONG_CHARS;
  }
  return bin.length > LONG_CHARS || bin.split("\n", LONG_LINES + 1).length > LONG_LINES;
}

// Text as a cell shows it: line breaks and tabs kept, other control
// characters as \xNN.
function cellText(bin: Bin): string {
  return isText(bin) ? bin.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`) : binText(bin);
}

function inked(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const span of jsonSpans(text)) {
    if (span.from > at) {
      out.push(text.slice(at, span.from));
    }
    out.push(
      <span key={span.from} className={`jv-${span.ink}`}>
        {text.slice(span.from, span.to)}
      </span>,
    );
    at = span.to;
  }
  if (at < text.length) {
    out.push(text.slice(at));
  }
  return out;
}

// A byte value in a cell, coloured by its kind as the data grid colours it:
// numbers, booleans, null-ish words, JSON compact and token by token, other
// bytes as `\xff` escapes with a mark. A long one is cut, with a control to
// show it all here and one (⤢) to open it in the viewer.
export function BinCell({ bin, onOpen }: { bin: Bin; onOpen?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const ink = isText(bin) ? cellInk(bin) : "binary";
  const json = ink === "json" || ink === "list";
  const text = json && isText(bin) ? minifyJson(bin) : cellText(bin);
  // Cut by the cell's three lines: a control shows the rest here.
  const clipped = text.length > LONG_CHARS || text.split("\n", LONG_LINES + 1).length > LONG_LINES;
  const limit = expanded ? CELL_OPEN_CHARS : CELL_CHARS;
  const cut = text.length > limit ? `${text.slice(0, limit)}…` : text;
  return (
    <span className={`kv-cell-wrap${expanded ? " expanded" : ""}`}>
      <span className={`kv-cell jv-${ink === "empty" ? "null" : ink}${ink === "empty" ? " empty" : ""}`} title={text.length > 80 && !expanded ? text.slice(0, 2000) : undefined}>
        {!isText(bin) ? <span className="kv-bin-mark">bin</span> : null}
        {ink === "empty" ? t("(빈 값)") : json ? inked(cut) : cut}
      </span>
      {clipped || onOpen !== undefined ? (
        <span className="kv-cell-tools">
          {clipped ? (
            <button type="button" className="kv-link kv-cell-more" onMouseDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onClick={() => setExpanded(!expanded)}>
              {expanded ? t("접기") : t("더 보기")}
            </button>
          ) : null}
          {onOpen !== undefined ? (
            <button type="button" className="kv-icon small kv-cell-open" title={t("값 보기 (Space)")} aria-label={t("값 보기")} onDoubleClick={(event) => event.stopPropagation()} onClick={onOpen}>
              <ExpandIcon size={9} />
            </button>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

// The value viewer over the table, Quick Look-style: the string view's
// panel (formatters, JSON explorer, editor) for one row's value.
function Viewer<R>({
  rows,
  rowId,
  cols,
  viewing,
  host,
  path,
  editable,
  onSave,
  onClose,
}: {
  rows: R[];
  rowId(row: R): string;
  cols: Col<R>[];
  viewing: { id: string; col: string; edit: boolean };
  host: RedisHost;
  path: string;
  editable: boolean;
  onSave(row: R, values: Record<string, Bin>): Promise<boolean | void>;
  onClose(): void;
}) {
  const row = rows.find((candidate) => rowId(candidate) === viewing.id);
  const col = cols.find((candidate) => candidate.id === viewing.col);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (row === undefined || col === undefined) {
      onClose();
    }
  });
  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true });
  }, []);
  if (row === undefined || col?.open === undefined) {
    return null;
  }
  const value = col.open(row);
  // The row's name, from the column left of the value: a hash's field, a
  // list's index, a stream entry's id.
  const first = cols[0] !== col ? cols[0] : undefined;
  const name = first === undefined ? null : first.open !== undefined ? binText(first.open(row)) : viewing.id;
  const label = t("{key}의 {column}", { key: path, column: col.label });
  return (
    <div
      className="cell-pop-backdrop big"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="cell-pop kv-peek"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={(event) => {
          // Esc closes, once the editor or the search box has had it.
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
          // Keys stay in the viewer, never reach the table behind it.
          event.stopPropagation();
        }}
      >
        <div className="kv-peek-head">
          <span className="kv-peek-title">
            {path}
            <span className="kv-peek-sep">›</span>
            <strong>{name ?? col.label}</strong>
            {name !== null ? <span className="kv-peek-col">{col.label}</span> : null}
          </span>
          <span className="spacer" />
          <button type="button" className="kv-icon" title={t("닫기 (Esc)")} aria-label={t("닫기")} onClick={onClose}>
            <CloseIcon size={11} />
          </button>
        </div>
        <ValuePanel
          host={host}
          value={value}
          label={label}
          identity={`${viewing.id}:${viewing.col}`}
          editable={editable && col.edit !== undefined && col.edit.plain !== true}
          startEditing={viewing.edit}
          onCancelEdit={viewing.edit ? onClose : undefined}
          onSave={async (next) => {
            const values = Object.fromEntries(cols.flatMap((candidate) => (candidate.edit === undefined ? [] : [[candidate.id, candidate.id === col.id ? next : candidate.edit.value(row)]])));
            try {
              const saved = (await onSave(row, values)) !== false;
              if (saved && viewing.edit) {
                onClose();
              }
              return saved;
            } catch (error) {
              notifyError(error, { context: "data" });
              return false;
            }
          }}
        />
      </div>
    </div>
  );
}
