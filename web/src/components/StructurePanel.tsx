import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { addActivity } from "../activity";
import { writeClipboard } from "../clipboard";
import {
  diffStructure,
  draftKey,
  draftsFromDetail,
  splitList,
  type ColumnDraft,
  type FkDraft,
  type IndexDraft,
  type StructureDraft,
} from "../ddl";
import type { SqlDialect } from "../engines/sqlDialect";
import { palette } from "../palette";
import { getSettings } from "../settings";
import { peekSchema } from "../schemaCache";
import type { SelectedRows } from "../grid/CanvasGrid";
import type { RowSource } from "../grid/rowSource";
import { store, type TableDetail, type TableSchema } from "../store";
import { DdlPreview } from "./DraftEditors";
import { t } from "../i18n";
import { ErrorNotice, notifyError } from "./ErrorNotice";
import { CopyIcon, PlusIcon, RefreshIcon, SearchIcon } from "./icons";
import { LoadingState, Spinner } from "./Spinner";
import { StructureGrid, type CellChoices, type GridColumn, type GridFocus } from "./StructureGrid";

interface StructurePanelProps {
  conn: string;
  dialect: SqlDialect;
  table: string;
  data: TableDetail | undefined;
  // The Data | Structure | Index switch, which leads the footer as in TablePlus.
  viewTabs?: ReactNode;
  // Renames the table (the Name field); resolves true once it's done.
  onRename?(name: string): Promise<boolean>;
  // The picked rows of the grid shown, for the right panel; null for none.
  onSelectRows?(pick: { source: RowSource; rows: SelectedRows } | null): void;
  onData(data: TableDetail): void;
  onChanged(): void;
  // Unsaved edits appeared: a temporary tab showing them is kept.
  onPending?(): void;
  // Which of the table's grids fills the panel: its columns (Structure) or its
  // indexes (Index), as TablePlus shows them one at a time.
  section?: "columns" | "indexes";
}

function errorOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

// "ref_table(ref_column)"; a bare "ref_table" takes that table's primary key.
const FK_TEXT = /^([^()]+?)\s*(?:\(\s*([^()]*?)\s*\))?$/;

const NO_TABLES: TableSchema[] = [];

// Unsaved edits per table, so switching to Data and back keeps them.
interface UnsavedEdits {
  detail: TableDetail;
  draft: StructureDraft;
  deleted: Set<string>;
}
const unsavedEdits = new Map<string, UnsavedEdits>();

function unique(items: string[]): string[] {
  return [...new Set(items.filter((item) => item !== ""))];
}

// Off flags (NO, FALSE) recede, as in TablePlus.
// YES/NO and TRUE/FALSE flags are booleans: in the boolean ink, as the Data
// tab shows true and false.
function flagInk(): string | null {
  return getSettings().typeColors ? palette.typeInks.boolean : null;
}

// Foreign keys that include a column, matched by its saved or current name.
function fksOf(foreignKeys: FkDraft[], column: ColumnDraft): FkDraft[] {
  const names = new Set([column.orig ?? column.name, column.name]);
  return foreignKeys.filter((fk) => splitList(fk.columns).some((name) => names.has(name)));
}

function fkTextOf(foreignKeys: FkDraft[], column: ColumnDraft): string {
  return fksOf(foreignKeys, column)
    .map((fk) => {
      const at = splitList(fk.columns).findIndex(
        (name) => name === column.name || name === column.orig,
      );
      const target = splitList(fk.refColumns)[at] ?? "";
      return target === "" ? fk.refTable : `${fk.refTable}(${target})`;
    })
    .join(", ");
}

// Drops columns from the index and key definitions that would still name them.
// `owns` says which definitions to touch: the database renames or drops its
// own indexes with a column, but a SQLite rebuild and unsaved ones need it here.
function withoutColumns(
  draft: StructureDraft,
  gone: Set<string>,
  owns: (orig: string | null) => boolean,
): StructureDraft {
  if (gone.size === 0) {
    return draft;
  }
  return {
    ...draft,
    indexes: draft.indexes.flatMap((index) => {
      if (!owns(index.orig)) {
        return [index];
      }
      const all = splitList(index.columns);
      const kept = all.filter((name) => !gone.has(name));
      if (kept.length === all.length) {
        return [index];
      }
      return kept.length === 0 ? [] : [{ ...index, columns: kept.join(", ") }];
    }),
    foreignKeys: draft.foreignKeys.filter(
      (fk) => !owns(fk.orig) || !splitList(fk.columns).some((name) => gone.has(name)),
    ),
  };
}

// A grid column read through the search: display row → position in the draft
// (-1 for a row the search no longer shows, which reads empty and takes no edit).
function throughRows(column: GridColumn, at: (row: number) => number): GridColumn {
  return {
    ...column,
    value: (row) => (at(row) < 0 ? null : column.value(at(row))),
    commit:
      column.commit &&
      ((row, value) => {
        if (at(row) >= 0) {
          column.commit?.(at(row), value);
        }
      }),
    choices: column.choices && ((row) => (at(row) < 0 ? null : (column.choices?.(at(row)) ?? null))),
    ink: column.ink && ((row) => (at(row) < 0 ? null : (column.ink?.(at(row)) ?? null))),
    readOnly: (row) => at(row) < 0 || (column.readOnly?.(at(row)) ?? false),
    changed: column.changed && ((row) => at(row) >= 0 && (column.changed?.(at(row)) ?? false)),
    title: column.title && ((row) => (at(row) < 0 ? undefined : column.title?.(at(row)))),
  };
}

// The primary key's row of the Index grid, which has no draft key of its own.
const PK_ROW_KEY = "\u0000primary";

export function StructurePanel({
  conn,
  dialect,
  table,
  data,
  viewTabs,
  onRename,
  onSelectRows,
  onData,
  onChanged,
  onPending,
  section = "columns",
}: StructurePanelProps) {
  // The CREATE statement and the triggers, shown under the grid while asked for.
  const [showDdl, setShowDdl] = useState(false);
  const [showTriggers, setShowTriggers] = useState(false);
  // What the top bar's search keeps: columns by name, indexes by name or column.
  const [columnQuery, setColumnQuery] = useState("");
  const [indexQuery, setIndexQuery] = useState("");
  const [nameDraft, setNameDraft] = useState(table);
  const [renaming, setRenaming] = useState(false);
  useEffect(() => setNameDraft(table), [table]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [columnFocus, setColumnFocus] = useState<GridFocus | null>(null);
  const [indexFocus, setIndexFocus] = useState<GridFocus | null>(null);
  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  // Reads the table on open (unless the tab already has it) and on refresh.
  // Not on every new `data`: that read is what produces it, so it would loop.
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
          setError(errorOf(err, t("테이블 정보를 불러오지 못했습니다")));
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
  }, [conn, table, nonce]);

  const detail = data ?? null;
  // An engine that rebuilds the table on save (SQLite) drops every column
  // and index the draft leaves out, not just new ones.
  const rebuilds = dialect.rebuildsTable;
  const editsKey = `${conn}:${table}`;
  const origDraft = useMemo(() => (detail === null ? null : draftsFromDetail(detail)), [detail]);
  // The tables are always editable, as in TablePlus; edits stay here until saved.
  const [draft, setDraft] = useState<StructureDraft | null>(() => {
    const kept = unsavedEdits.get(editsKey);
    return kept !== undefined && kept.detail === data ? kept.draft : origDraft;
  });
  // Saved rows marked with ⌫; they stay listed, struck out, until saved.
  const [deleted, setDeleted] = useState<Set<string>>(() => {
    const kept = unsavedEdits.get(editsKey);
    return kept !== undefined && kept.detail === data ? kept.deleted : new Set();
  });

  // The read the draft started from. A new read replaces untouched tables, and
  // edited ones only when asked (after a save, a refresh, or a partial save).
  const baseRef = useRef(origDraft);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const deletedRef = useRef(deleted);
  deletedRef.current = deleted;
  const resetRef = useRef(false);
  const errorAfterResetRef = useRef<string | null>(null);

  useEffect(() => {
    const untouched = draftRef.current === baseRef.current && deletedRef.current.size === 0;
    baseRef.current = origDraft;
    if (untouched || resetRef.current) {
      resetRef.current = false;
      setDraft(origDraft);
      setDeleted(new Set());
      setPreview(false);
      setSaveError(errorAfterResetRef.current);
      errorAfterResetRef.current = null;
    }
  }, [origDraft]);

  useEffect(() => {
    if (detail !== null && draft !== null && (draft !== origDraft || deleted.size > 0)) {
      unsavedEdits.set(editsKey, { detail, draft, deleted });
    } else {
      unsavedEdits.delete(editsKey);
    }
  }, [editsKey, detail, draft, origDraft, deleted]);

  const owns = (orig: string | null): boolean => rebuilds || orig === null;

  // What a save would write: the draft without the rows marked for deletion.
  const effective = useMemo(() => {
    if (draft === null || deleted.size === 0) {
      return draft;
    }
    const gone = new Set(
      draft.columns.filter((column) => deleted.has(column.key)).map((column) => column.name),
    );
    const kept = {
      ...draft,
      columns: draft.columns.filter((column) => !deleted.has(column.key)),
      indexes: draft.indexes.filter((index) => !deleted.has(index.key)),
    };
    return withoutColumns(kept, gone, (orig) => rebuilds || orig === null);
  }, [draft, deleted, rebuilds]);

  const diff = useMemo(
    () =>
      effective !== null && origDraft !== null && (draft !== origDraft || deleted.size > 0)
        ? diffStructure(dialect, table, origDraft, effective)
        : null,
    [effective, draft, deleted, origDraft, dialect, table],
  );
  const pending = diff !== null && (diff.statements.length > 0 || diff.errors.length > 0);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const onPendingRef = useRef(onPending);
  onPendingRef.current = onPending;
  useEffect(() => {
    if (pending) {
      onPendingRef.current?.();
    }
  }, [pending]);

  const origColumns = useMemo(
    () => new Map((origDraft?.columns ?? []).map((column) => [column.name, column])),
    [origDraft],
  );
  const origIndexes = useMemo(
    () => new Map((origDraft?.indexes ?? []).map((index) => [index.name, index])),
    [origDraft],
  );

  const saveRef = useRef<() => Promise<void>>(async () => {});

  async function save(): Promise<void> {
    if (origDraft === null || effective === null || busy) {
      return;
    }
    const result = diffStructure(dialect, table, origDraft, effective);
    if (result.errors.length > 0) {
      setSaveError(result.errors.join("\n"));
      setPreview(true);
      return;
    }
    if (result.statements.length === 0) {
      discard();
      return;
    }
    setBusy(true);
    setSaveError(null);
    let done = 0;
    try {
      for (const statement of result.statements) {
        await store.exec(conn, statement, { history: true });
        done += 1;
      }
      store.setInfo(t("구조를 변경했습니다 ({count}문장)", { count: result.statements.length }));
      addActivity(
        "ddl",
        t("구조 변경: {table}", { table }),
        t("{count}문장", { count: result.statements.length }),
      );
      setPreview(false);
      resetRef.current = true;
      setNonce((value) => value + 1);
      onChanged();
    } catch (err) {
      const message = errorOf(err, t("구조 변경에 실패했습니다"));
      setSaveError(message);
      const intact = await undoRebuild(result.statements, done);
      if (!intact) {
        // Some statements ran: show the table as it is now, keeping the error,
        // since the edits were made against what it used to be.
        errorAfterResetRef.current = message;
        resetRef.current = true;
        setNonce((value) => value + 1);
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  }
  saveRef.current = save;

  // After a failed save, puts a SQLite rebuild back the way it started: the
  // half-made copy goes and foreign keys come back on. True when the table was
  // left unchanged.
  async function undoRebuild(statements: string[], done: number): Promise<boolean> {
    const off = statements.indexOf("PRAGMA foreign_keys = OFF");
    if (!rebuilds || off < 0) {
      return done === 0;
    }
    const copy = /^DROP TABLE IF EXISTS ("(?:[^"]|"")*_tablepeek_tmp")$/.exec(
      statements[off + 1] ?? "",
    )?.[1];
    const dropAt = statements.findIndex(
      (statement) => statement.startsWith("DROP TABLE ") && !statement.startsWith("DROP TABLE IF EXISTS"),
    );
    let intact = false;
    if (copy !== undefined && done <= dropAt) {
      // If the DROP ran but its reply was lost, the copy holds the only data.
      const original = await store.fetchTableDetail(conn, table).then(
        () => true,
        () => false,
      );
      if (original) {
        await store.exec(conn, `DROP TABLE IF EXISTS ${copy}`).catch(() => undefined);
        intact = true;
      }
    }
    if (done > off) {
      await store.exec(conn, "PRAGMA foreign_keys = ON").catch(() => undefined);
    }
    return intact;
  }

  function discard(): void {
    setDraft(origDraft);
    setDeleted(new Set());
    setPreview(false);
    setSaveError(null);
  }

  // ⌘S saves; an open cell editor is committed first, as in the data grid.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") {
        return;
      }
      const active = document.activeElement;
      const editingCell = active instanceof HTMLInputElement && active.closest(".structure-grid") !== null;
      if (!editingCell && !pendingRef.current) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (editingCell) {
        active.blur();
        window.setTimeout(() => void saveRef.current(), 0);
      } else {
        void saveRef.current();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  function copyDdl(ddl: string): void {
    void writeClipboard(ddl, (message) => notifyError(message));
  }

  function patchColumn(row: number, part: Partial<ColumnDraft>): void {
    if (draft === null) {
      return;
    }
    const column = draft.columns[row];
    if (
      column === undefined ||
      Object.entries(part).every(([key, value]) => column[key as keyof ColumnDraft] === value)
    ) {
      return;
    }
    let { indexes, foreignKeys } = draft;
    const before = column.name;
    const after = part.name;
    // A rename carries into the definitions this draft writes itself.
    if (after !== undefined && before !== "" && after !== before) {
      const rename = (list: string): string =>
        splitList(list)
          .map((name) => (name === before ? after : name))
          .join(", ");
      const names = (list: string): boolean => splitList(list).includes(before);
      indexes = indexes.map((index) =>
        owns(index.orig) && names(index.columns) ? { ...index, columns: rename(index.columns) } : index,
      );
      foreignKeys = foreignKeys.map((fk) =>
        owns(fk.orig) && names(fk.columns) ? { ...fk, columns: rename(fk.columns) } : fk,
      );
    }
    setDraft({
      columns: draft.columns.map((entry, i) => (i === row ? { ...entry, ...part } : entry)),
      indexes,
      foreignKeys,
    });
  }

  function patchIndex(position: number, part: Partial<IndexDraft>): void {
    if (draft === null) {
      return;
    }
    const index = draft.indexes[position];
    if (
      index === undefined ||
      Object.entries(part).every(([key, value]) => index[key as keyof IndexDraft] === value)
    ) {
      return;
    }
    setDraft({
      ...draft,
      indexes: draft.indexes.map((entry, i) => (i === position ? { ...entry, ...part } : entry)),
    });
  }

  // Saved rows are marked, struck out until saved.
  function markDeleted(keys: string[], on: boolean): void {
    if (keys.length === 0) {
      return;
    }
    setDeleted((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (on) {
          next.add(key);
        } else {
          next.delete(key);
        }
      }
      return next;
    });
  }

  // ⌫ on rows that are all marked already brings them back; any other pick is
  // deleted: saved rows get marked and rows added here go at once.
  function onlyMarked(saved: { key: string }[], added: unknown[]): boolean {
    return added.length === 0 && saved.length > 0 && saved.every((row) => deleted.has(row.key));
  }

  function deleteColumns(rows: number[]): void {
    if (draft === null) {
      return;
    }
    const picked = rows.flatMap((row) => draft.columns[row] ?? []);
    const saved = picked.filter((column) => column.orig !== null);
    const added = picked.filter((column) => column.orig === null);
    if (onlyMarked(saved, added)) {
      markDeleted(saved.map((column) => column.key), false);
      return;
    }
    markDeleted(saved.map((column) => column.key), true);
    if (added.length > 0) {
      // Columns added here go at once, with anything added here that names them.
      const keys = new Set(added.map((column) => column.key));
      const names = new Set(added.map((column) => column.name).filter((name) => name !== ""));
      const rest = { ...draft, columns: draft.columns.filter((column) => !keys.has(column.key)) };
      setDraft(withoutColumns(rest, names, (orig) => orig === null));
    }
  }

  function deleteIndexes(positions: number[]): void {
    if (draft === null) {
      return;
    }
    const picked = positions.flatMap((position) => draft.indexes[position] ?? []);
    const saved = picked.filter((index) => index.orig !== null);
    const added = picked.filter((index) => index.orig === null);
    if (onlyMarked(saved, added)) {
      markDeleted(saved.map((index) => index.key), false);
      return;
    }
    markDeleted(saved.map((index) => index.key), true);
    if (added.length > 0) {
      const keys = new Set(added.map((index) => index.key));
      setDraft({ ...draft, indexes: draft.indexes.filter((index) => !keys.has(index.key)) });
    }
  }

  function columnFks(column: ColumnDraft): FkDraft[] {
    return fksOf(draft?.foreignKeys ?? [], column);
  }

  function fkText(column: ColumnDraft): string {
    return fkTextOf(draft?.foreignKeys ?? [], column);
  }

  // The cell edits one single-column key; composite or several go through SQL.
  function fkLocked(column: ColumnDraft): boolean {
    const fks = columnFks(column);
    return fks.length > 1 || fks.some((fk) => splitList(fk.columns).length > 1);
  }

  const schemaTables = peekSchema(conn, false) ?? peekSchema(conn, true) ?? NO_TABLES;

  function setColumnFk(row: number, text: string): void {
    const column = draft?.columns[row];
    if (draft === null || column === undefined) {
      return;
    }
    const value = text.trim();
    const current = columnFks(column)[0];
    let foreignKeys = draft.foreignKeys;
    if (value === "") {
      if (current === undefined) {
        return;
      }
      foreignKeys = foreignKeys.filter((fk) => fk !== current);
    } else {
      if (column.name === "") {
        notifyError(t("컬럼 이름을 먼저 입력하세요"));
        return;
      }
      const match = FK_TEXT.exec(value);
      if (match === null || (match[2] ?? "").includes(",")) {
        notifyError(t("외래 키는 table(column) 형식으로 입력하세요"));
        return;
      }
      const refTable = match[1].trim();
      let refColumns = (match[2] ?? "").trim();
      if (refColumns === "") {
        const pk = schemaTables
          .find((schema) => schema.name === refTable)
          ?.columns.filter((entry) => entry.pk);
        if (pk === undefined || pk.length !== 1) {
          notifyError(t("참조할 컬럼을 table(column)으로 적어 주세요"));
          return;
        }
        refColumns = pk[0].name;
      }
      if (
        current !== undefined &&
        current.refTable === refTable &&
        current.refColumns === refColumns &&
        current.columns === column.name
      ) {
        return;
      }
      const next = { columns: column.name, refTable, refColumns };
      foreignKeys =
        current === undefined
          ? [...foreignKeys, { key: draftKey(), orig: null, name: "", ...next }]
          : foreignKeys.map((fk) => (fk === current ? { ...fk, ...next } : fk));
    }
    setDraft({ ...draft, foreignKeys });
  }

  const columns = draft?.columns ?? [];
  const indexes = draft?.indexes ?? [];
  const primaryColumns = columns
    .filter((column) => column.pk && !deleted.has(column.key))
    .map((column) => column.name);
  const primaryName = detail?.indexes.find((index) => index.primary)?.name ?? "PRIMARY";
  // The primary key shows as the first index row; it changes through is_primary.
  const pkRows = primaryColumns.length > 0 ? 1 : 0;

  function addColumn(): void {
    if (draft === null) {
      return;
    }
    const column: ColumnDraft = {
      key: draftKey(),
      orig: null,
      name: "",
      type: "TEXT",
      notNull: false,
      pk: false,
      def: "",
    };
    setDraft({ ...draft, columns: [...draft.columns, column] });
    // A search would hide the new row (it has no name yet).
    setColumnQuery("");
    setColumnFocus({ row: draft.columns.length, col: 0, seq: Date.now() });
  }

  function addIndex(): void {
    if (draft === null) {
      return;
    }
    const index: IndexDraft = { key: draftKey(), orig: null, name: "", unique: false, columns: "" };
    setDraft({ ...draft, indexes: [...draft.indexes, index] });
    setIndexQuery("");
    setIndexFocus({ row: pkRows + draft.indexes.length, col: 0, seq: Date.now() });
  }

  const typeChoices = unique([...dialect.columnTypes, ...columns.map((column) => column.type)]);
  const defaultChoices = ["NULL", "''", "0", "1", ...dialect.columnDefaults];
  // Tables' primary keys, from the schema the sidebar already loaded.
  const fkChoices = useMemo(
    () => [
      "NULL",
      ...schemaTables.flatMap((schema) =>
        schema.columns.filter((column) => column.pk).map((column) => `${schema.name}(${column.name})`),
      ),
    ],
    [schemaTables],
  );

  function columnChanged(row: number, field: keyof ColumnDraft): boolean {
    const column = columns[row];
    const before =
      column === undefined || column.orig === null ? undefined : origColumns.get(column.orig);
    return before !== undefined && before[field] !== column[field];
  }

  const yesNo: CellChoices = { options: ["YES", "NO"], strict: true };
  const trueFalse: CellChoices = { options: ["TRUE", "FALSE"], strict: true };

  const columnGrid: GridColumn[] = [
    {
      header: "column_name",
      value: (row) => columns[row].name,
      // Key columns in the key colour, as the Data tab shows their values.
      ink: (row) => (columns[row].pk && getSettings().typeColors ? palette.error : null),
      commit: (row, value) => patchColumn(row, { name: value.trim() }),
      changed: (row) => columnChanged(row, "name"),
    },
    {
      header: "data_type",
      value: (row) => columns[row].type,
      choices: () => ({ options: typeChoices }),
      commit: (row, value) => patchColumn(row, { type: value.trim() }),
      changed: (row) => columnChanged(row, "type"),
    },
    {
      header: "is_nullable",
      value: (row) => (columns[row].notNull ? "NO" : "YES"),
      ink: flagInk,
      choices: () => yesNo,
      commit: (row, value) => patchColumn(row, { notNull: value === "NO" }),
      changed: (row) => columnChanged(row, "notNull"),
    },
    {
      header: "is_primary",
      value: (row) => (columns[row].pk ? "YES" : "NO"),
      ink: flagInk,
      choices: () => yesNo,
      commit: (row, value) => patchColumn(row, { pk: value === "YES" }),
      changed: (row) => columnChanged(row, "pk"),
    },
    {
      header: "column_default",
      // No default shows NULL, as TablePlus does.
      value: (row) => (columns[row].def === "" ? null : columns[row].def),
      choices: () => ({ options: defaultChoices }),
      commit: (row, value) => patchColumn(row, { def: value.trim().toUpperCase() === "NULL" ? "" : value }),
      nullable: true,
      changed: (row) => columnChanged(row, "def"),
      title: (row) => columns[row].def || undefined,
    },
    {
      header: "foreign_key",
      value: (row) => fkText(columns[row]),
      ink: () => palette.accent,
      choices: () => ({ options: fkChoices }),
      commit: (row, value) => setColumnFk(row, value.trim().toUpperCase() === "NULL" ? "" : value),
      nullable: true,
      readOnly: (row) => fkLocked(columns[row]),
      changed: (row) => fkChanged(columns[row]),
      title: (row) => (fkLocked(columns[row]) ? t("복합 외래 키는 SQL로 변경하세요") : undefined),
    },
  ];

  function fkChanged(column: ColumnDraft): boolean {
    const before = column.orig === null ? undefined : origColumns.get(column.orig);
    return (
      before !== undefined &&
      origDraft !== null &&
      fkTextOf(origDraft.foreignKeys, before) !== fkText(column)
    );
  }

  function indexAt(row: number): IndexDraft | undefined {
    return row < pkRows ? undefined : indexes[row - pkRows];
  }

  function indexChanged(row: number, field: keyof IndexDraft): boolean {
    const index = indexAt(row);
    const before =
      index === undefined || index.orig === null ? undefined : origIndexes.get(index.orig);
    return before !== undefined && index !== undefined && before[field] !== index[field];
  }

  const columnNames = new Set(columns.map((column) => column.name));

  const indexColumnChoices: CellChoices = {
    options: [...columnNames].filter((name) => name !== ""),
    query: (value) => value.split(",").pop() ?? "",
    // A picked column completes a partly typed name, or is added after a full one.
    pick: (value, option) => {
      const parts = splitList(value);
      if (parts.includes(option)) {
        return parts.join(", ");
      }
      const last = value.slice(value.lastIndexOf(",") + 1).trim();
      if (last !== "" && !columnNames.has(last)) {
        parts.pop();
      }
      return [...parts, option].join(", ");
    },
  };

  const primaryTitle = (row: number): string | undefined =>
    row < pkRows ? t("기본 키는 컬럼의 is_primary로 바꿉니다") : undefined;

  const indexGrid: GridColumn[] = [
    {
      header: "index_name",
      value: (row) => indexAt(row)?.name ?? primaryName,
      commit: (row, value) => patchIndex(row - pkRows, { name: value.trim() }),
      readOnly: (row) => row < pkRows,
      changed: (row) => indexChanged(row, "name"),
      title: primaryTitle,
    },
    {
      header: "is_unique",
      value: (row) => ((indexAt(row)?.unique ?? true) ? "TRUE" : "FALSE"),
      ink: flagInk,
      choices: () => trueFalse,
      commit: (row, value) => patchIndex(row - pkRows, { unique: value === "TRUE" }),
      readOnly: (row) => row < pkRows,
      changed: (row) => indexChanged(row, "unique"),
      title: primaryTitle,
    },
    {
      header: "column_name",
      value: (row) => indexAt(row)?.columns ?? primaryColumns.join(", "),
      choices: () => indexColumnChoices,
      commit: (row, value) => patchIndex(row - pkRows, { columns: splitList(value).join(", ") }),
      readOnly: (row) => row < pkRows,
      changed: (row) => indexChanged(row, "columns"),
      title: primaryTitle,
    },
  ];

  function rowState(orig: string | null, key: string): "inserted" | "deleted" | null {
    return deleted.has(key) ? "deleted" : orig === null ? "inserted" : null;
  }

  // The rows the top bar's search keeps: columns by name, indexes (the primary
  // key first) by name or column. Matched by row key when the search or the
  // set of rows changes, not on every edit, so a row renamed out of the search
  // keeps its place (an editor may still be open on it).
  const columnNeedle = columnQuery.trim().toLowerCase();
  const columnMatches = useMemo(
    () =>
      columnNeedle === ""
        ? null
        : new Set(
            columns.filter((column) => column.name.toLowerCase().includes(columnNeedle)).map((column) => column.key),
          ),
    [columnNeedle, columns.length, origDraft],
  );
  const shownColumns = columns.flatMap((column, at) =>
    columnMatches === null || columnMatches.has(column.key) ? [at] : [],
  );
  const indexNeedle = indexQuery.trim().toLowerCase();
  const indexRows = Array.from({ length: pkRows + indexes.length }, (_, at) => at);
  const indexMatches = useMemo(
    () =>
      indexNeedle === ""
        ? null
        : new Set(
            indexRows
              .filter((at) => {
                const index = indexAt(at);
                const text = `${index?.name ?? primaryName} ${index?.columns ?? primaryColumns.join(", ")}`;
                return text.toLowerCase().includes(indexNeedle);
              })
              .map((at) => indexAt(at)?.key ?? PK_ROW_KEY),
          ),
    [indexNeedle, indexes.length, pkRows, origDraft],
  );
  const shownIndexes = indexRows.filter(
    (at) => indexMatches === null || indexMatches.has(indexAt(at)?.key ?? PK_ROW_KEY),
  );
  const columnAt = (row: number): number => shownColumns[row] ?? -1;
  const indexRowAt = (row: number): number => shownIndexes[row] ?? -1;

  function selectRows(source: RowSource, rows: SelectedRows | null): void {
    onSelectRows?.(rows === null ? null : { source, rows });
  }

  // Enter renames the table; Escape (or leaving the field) puts the name back.
  async function commitName(): Promise<void> {
    const next = nameDraft.trim();
    if (onRename === undefined || next === "" || next === table) {
      setNameDraft(table);
      return;
    }
    setRenaming(true);
    try {
      if (!(await onRename(next))) {
        setNameDraft(table);
      }
    } finally {
      setRenaming(false);
    }
  }

  // Absent (an older server): unknown, not none.
  const triggers = detail?.triggers ?? null;

  const pendingEdits = pending || deleted.size > 0;

  return (
    <div className="panel structure-panel">
      {/* TablePlus's bar over the grid: the table's name, its primary key and
          a search of the rows below. */}
      <div className="structure-bar">
        <label className="structure-field">
          <span className="structure-field-label">{t("이름")}</span>
          <input
            className="structure-name"
            value={nameDraft}
            spellCheck={false}
            disabled={onRename === undefined || renaming || pendingEdits}
            title={pendingEdits ? t("구조 변경을 먼저 저장하거나 취소하세요") : t("Return으로 테이블 이름 변경")}
            onChange={(event) => setNameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void commitName();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setNameDraft(table);
                event.currentTarget.blur();
              }
            }}
            onBlur={() => {
              if (!renaming) {
                setNameDraft(table);
              }
            }}
          />
        </label>
        {section === "columns" ? (
          <div className="structure-field structure-primary">
            <span className="structure-field-label">{t("기본 키")}</span>
            <span className="structure-chips" title={t("기본 키는 컬럼의 is_primary로 바꿉니다")}>
              {columns
                .filter((column) => column.pk && column.name !== "" && !deleted.has(column.key))
                .map((column) => (
                  <span className="structure-chip" key={column.key}>
                    {column.name}
                  </span>
                ))}
            </span>
          </div>
        ) : (
          <span className="spacer" />
        )}
        <label className="structure-search">
          <SearchIcon size={11} />
          <input
            value={section === "columns" ? columnQuery : indexQuery}
            placeholder={section === "columns" ? t("컬럼 검색…") : t("인덱스 검색…")}
            spellCheck={false}
            onChange={(event) =>
              section === "columns" ? setColumnQuery(event.target.value) : setIndexQuery(event.target.value)
            }
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                if (section === "columns") {
                  setColumnQuery("");
                } else {
                  setIndexQuery("");
                }
              }
            }}
          />
        </label>
      </div>
      <div className="panel-body structure-body">
        {error ? <ErrorNotice error={error} context="structure" /> : null}
        {saveError ? <ErrorNotice error={saveError} context="structure" onClose={() => setSaveError(null)} /> : null}
        {detail === null || draft === null ? (
          error ? null : <LoadingState />
        ) : (
          <>
            {section === "columns" ? (
              <section className="structure-section fill">
                {columns.length > 0 && shownColumns.length === 0 ? (
                  <div className="panel-empty">{t("검색 결과가 없습니다")}</div>
                ) : (
                  <StructureGrid
                    key="columns"
                    fill
                    rowCount={shownColumns.length}
                    columns={columnGrid.map((column) => throughRows(column, columnAt))}
                    rowState={(row) => {
                      const column = columns[columnAt(row)];
                      return column === undefined ? null : rowState(column.orig, column.key);
                    }}
                    rowReadOnly={(row) => {
                      const column = columns[columnAt(row)];
                      return column === undefined || deleted.has(column.key);
                    }}
                    onDeleteRows={(rows) => deleteColumns(rows.map(columnAt))}
                    focus={columnFocus}
                    onFocusHandled={() => setColumnFocus(null)}
                    fitKey={origDraft}
                    onSelect={selectRows}
                  />
                )}
              </section>
            ) : (
              <section className="structure-section fill">
                {pkRows + indexes.length === 0 ? (
                  <div className="panel-empty">{t("인덱스가 없습니다")}</div>
                ) : shownIndexes.length === 0 ? (
                  <div className="panel-empty">{t("검색 결과가 없습니다")}</div>
                ) : (
                  <StructureGrid
                    key="indexes"
                    fill
                    rowCount={shownIndexes.length}
                    columns={indexGrid.map((column) => throughRows(column, indexRowAt))}
                    rowState={(row) => {
                      const index = indexAt(indexRowAt(row));
                      return index === undefined ? null : rowState(index.orig, index.key);
                    }}
                    rowReadOnly={(row) => {
                      const index = indexAt(indexRowAt(row));
                      return index !== undefined && deleted.has(index.key);
                    }}
                    canDeleteRow={(row) => indexRowAt(row) >= pkRows}
                    onDeleteRows={(rows) => deleteIndexes(rows.map((row) => indexRowAt(row) - pkRows))}
                    focus={indexFocus}
                    onFocusHandled={() => setIndexFocus(null)}
                    fitKey={origDraft}
                    onSelect={selectRows}
                  />
                )}
              </section>
            )}

            {preview && diff !== null ? (
              <section className="structure-pane">
                <div className="structure-section-head">
                  <span className="structure-section-title">{t("DDL 미리보기")}</span>
                </div>
                <DdlPreview result={diff} />
              </section>
            ) : null}

            {showTriggers && section === "columns" ? (
              <section className="structure-pane">
                <div className="structure-section-head">
                  <span className="structure-section-title">{t("트리거")}</span>
                  {triggers !== null ? <span className="structure-count">{triggers.length}</span> : null}
                </div>
                {triggers === null ? (
                  <div className="structure-empty">{t("트리거 정보를 가져올 수 없습니다")}</div>
                ) : triggers.length === 0 ? (
                  <div className="structure-empty">{t("트리거가 없습니다")}</div>
                ) : (
                  triggers.map((trigger) => (
                    <div className="structure-trigger" key={trigger.name}>
                      <div className="structure-trigger-head">
                        <span className="structure-trigger-name">{trigger.name}</span>
                        {trigger.timing || trigger.event ? (
                          <span className="panel-dim">
                            {[trigger.timing, trigger.event].filter(Boolean).join(" ")}
                          </span>
                        ) : null}
                        <span className="spacer" />
                        {trigger.definition ? (
                          <button
                            type="button"
                            className="icon-text-button"
                            onClick={() => copyDdl(trigger.definition ?? "")}
                            title={t("복사")}
                          >
                            <CopyIcon size={11} />
                            {t("복사")}
                          </button>
                        ) : null}
                      </div>
                      {trigger.definition ? <pre className="panel-pre">{trigger.definition}</pre> : null}
                    </div>
                  ))
                )}
              </section>
            ) : null}

            {showDdl && section === "columns" ? (
              <section className="structure-pane">
                <div className="structure-section-head">
                  <span className="structure-section-title">{t("CREATE 문")}</span>
                  <span className="spacer" />
                  {detail.ddl !== null ? (
                    <button
                      type="button"
                      className="icon-text-button"
                      onClick={() => copyDdl(detail.ddl ?? "")}
                      title={t("복사")}
                    >
                      <CopyIcon size={11} />
                      {t("복사")}
                    </button>
                  ) : null}
                </div>
                {detail.ddl === null ? (
                  <div className="structure-empty">{t("DDL 미지원")}</div>
                ) : (
                  <pre className="panel-pre">{detail.ddl}</pre>
                )}
              </section>
            ) : null}
          </>
        )}
      </div>
      {/* The footer, as in TablePlus: the views, then what this one adds. */}
      <div className="data-toolbar structure-footer">
        {viewTabs}
        {section === "columns" ? (
          <>
            <button type="button" className="footer-button" disabled={draft === null} onClick={addColumn}>
              <PlusIcon size={11} />
              <span className="footer-label">{t("새 컬럼")}</span>
            </button>
            <button
              type="button"
              className={showTriggers ? "footer-button active" : "footer-button"}
              disabled={detail === null}
              onClick={() => setShowTriggers((value) => !value)}
            >
              {t("트리거")}
            </button>
            <button
              type="button"
              className={showDdl ? "footer-button active" : "footer-button"}
              disabled={detail === null}
              onClick={() => setShowDdl((value) => !value)}
              title={t("CREATE 문 보기")}
            >
              DDL
            </button>
          </>
        ) : (
          <button type="button" className="footer-button" disabled={draft === null} onClick={addIndex}>
            <PlusIcon size={11} />
            <span className="footer-label">{t("새 인덱스")}</span>
          </button>
        )}
        <span className="spacer" />
        {busy ? <span className="panel-dim">{t("실행 중…")}</span> : null}
        {/* A refresh of what's shown; a first load shows in the body. */}
        {loading && detail !== null ? (
          <span className="panel-dim delayed-in">
            <Spinner size={10} /> {t("불러오는 중…")}
          </span>
        ) : null}
        {pending ? (
          <>
            <button
              type="button"
              className={preview ? "footer-button active" : "footer-button"}
              onClick={() => setPreview((value) => !value)}
              title={t("미리보기")}
            >
              {t("미리보기")}
            </button>
            <button type="button" className="footer-button" disabled={busy} onClick={discard}>
              {t("취소")}
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || loading || (diff !== null && diff.errors.length > 0)}
              onClick={() => void save()}
              title={t("저장 (⌘S)")}
            >
              {t("저장 (⌘S)")}
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="icon-button"
          disabled={loading || busy}
          onClick={() => {
            resetRef.current = true;
            setNonce((value) => value + 1);
          }}
          title={t("구조 새로고침")}
        >
          <RefreshIcon size={12} />
        </button>
      </div>
    </div>
  );
}
