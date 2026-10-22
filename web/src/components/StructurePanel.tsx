import { useEffect, useMemo, useRef, useState } from "react";
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
import { formatBytes, formatRowEstimate } from "../format";
import { peekSchema } from "../schemaCache";
import { store, type TableDetail, type TableSchema } from "../store";
import { DdlPreview } from "./DraftEditors";
import { t } from "../i18n";
import { ErrorNotice } from "./ErrorNotice";
import { ColumnsIcon, CopyIcon, KeyIcon, RefreshIcon, TableIcon } from "./icons";
import { Spinner } from "./Spinner";
import { StructureGrid, type GridColumn, type GridFocus } from "./StructureGrid";

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

// "ref_table(ref_column)"; a bare "ref_table" takes that table's primary key.
const FK_TEXT = /^([^()]+?)\s*(?:\(\s*([^()]*?)\s*\))?$/;

// Types offered in data_type's list, in each engine's usual spelling.
const TYPE_CHOICES: Record<string, string[]> = {
  sqlite: ["INTEGER", "TEXT", "REAL", "NUMERIC", "BLOB", "BOOLEAN", "VARCHAR(255)", "DATE", "DATETIME", "JSON"],
  mysql: [
    "int", "bigint", "smallint", "tinyint(1)", "decimal(10,2)", "float", "double",
    "varchar(255)", "char(32)", "text", "longtext", "json", "date", "datetime",
    "datetime(6)", "timestamp", "time", "blob",
  ],
  postgres: [
    "integer", "bigint", "smallint", "serial", "bigserial", "numeric(10,2)", "real",
    "double precision", "boolean", "text", "varchar(255)", "char(32)", "uuid", "date",
    "time", "timestamp", "timestamptz", "json", "jsonb", "bytea",
  ],
  mssql: [
    "int", "bigint", "smallint", "bit", "decimal(18,2)", "float", "nvarchar(255)",
    "varchar(255)", "nvarchar(max)", "char(32)", "date", "datetime2", "datetimeoffset",
    "uniqueidentifier", "varbinary(max)",
  ],
};

// Defaults offered in column_default's list; NULL means no default.
const DEFAULT_CHOICES: Record<string, string[]> = {
  sqlite: ["CURRENT_TIMESTAMP", "CURRENT_DATE"],
  mysql: ["CURRENT_TIMESTAMP", "CURRENT_TIMESTAMP(6)", "(UUID())"],
  postgres: ["now()", "CURRENT_TIMESTAMP", "gen_random_uuid()", "true", "false"],
  mssql: ["GETDATE()", "SYSDATETIME()", "NEWID()"],
};

const NO_TABLES: TableSchema[] = [];

// Unsaved edits per table, so switching to Data and back keeps them.
interface UnsavedEdits {
  detail: TableDetail;
  draft: StructureDraft;
  deleted: Set<string>;
}
const unsavedEdits = new Map<string, UnsavedEdits>();

function dialect(kind: string): string {
  return kind === "cockroachdb" ? "postgres" : kind;
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter((item) => item !== ""))];
}

function nullText() {
  return <span className="structure-null">NULL</span>;
}

function flag(on: boolean, yes = "YES", no = "NO") {
  return <span className={on ? "structure-flag on" : "structure-flag"}>{on ? yes : no}</span>;
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
  const sqlite = kind === "sqlite";
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

  const owns = (orig: string | null): boolean => sqlite || orig === null;

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
    return withoutColumns(kept, gone, (orig) => sqlite || orig === null);
  }, [draft, deleted, sqlite]);

  const diff = useMemo(
    () =>
      effective !== null && origDraft !== null && (draft !== origDraft || deleted.size > 0)
        ? diffStructure(kind, table, origDraft, effective)
        : null,
    [effective, draft, deleted, origDraft, kind, table],
  );
  const pending = diff !== null && (diff.statements.length > 0 || diff.errors.length > 0);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

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
    const result = diffStructure(kind, table, origDraft, effective);
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
        await store.exec(conn, statement);
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
    if (!sqlite || off < 0) {
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

  const countText = detail ? formatRowEstimate(detail.row_count_estimate, exactRows) : null;
  const sizeText = detail ? formatBytes(detail.size_bytes) : null;

  function copyDdl(ddl: string): void {
    void writeClipboard(ddl, (message) => store.setError(message));
  }

  function patchColumn(row: number, part: Partial<ColumnDraft>): void {
    if (draft === null) {
      return;
    }
    const column = draft.columns[row];
    if (Object.entries(part).every(([key, value]) => column[key as keyof ColumnDraft] === value)) {
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
    if (Object.entries(part).every(([key, value]) => index[key as keyof IndexDraft] === value)) {
      return;
    }
    setDraft({
      ...draft,
      indexes: draft.indexes.map((entry, i) => (i === position ? { ...entry, ...part } : entry)),
    });
  }

  function toggleDeleted(key: string): void {
    setDeleted((current) => {
      const next = new Set(current);
      if (!next.delete(key)) {
        next.add(key);
      }
      return next;
    });
  }

  function deleteColumn(row: number): void {
    if (draft === null) {
      return;
    }
    const column = draft.columns[row];
    if (column.orig !== null) {
      toggleDeleted(column.key);
      return;
    }
    // A column added here goes at once, with anything added here that names it.
    const rest = { ...draft, columns: draft.columns.filter((_, i) => i !== row) };
    setDraft(
      column.name === ""
        ? rest
        : withoutColumns(rest, new Set([column.name]), (orig) => orig === null),
    );
  }

  function deleteIndex(position: number): void {
    if (draft === null) {
      return;
    }
    const index = draft.indexes[position];
    if (index.orig !== null) {
      toggleDeleted(index.key);
      return;
    }
    setDraft({ ...draft, indexes: draft.indexes.filter((_, i) => i !== position) });
  }

  // Foreign keys that include a column, matched by its saved or current name.
  function columnFks(column: ColumnDraft): FkDraft[] {
    const names = new Set([column.orig ?? column.name, column.name]);
    return (draft?.foreignKeys ?? []).filter((fk) =>
      splitList(fk.columns).some((name) => names.has(name)),
    );
  }

  function fkText(column: ColumnDraft): string {
    return columnFks(column)
      .map((fk) => {
        const at = splitList(fk.columns).findIndex(
          (name) => name === column.name || name === column.orig,
        );
        const target = splitList(fk.refColumns)[at] ?? "";
        return target === "" ? fk.refTable : `${fk.refTable}(${target})`;
      })
      .join(", ");
  }

  // The cell edits one single-column key; composite or several go through SQL.
  function fkLocked(column: ColumnDraft): boolean {
    const fks = columnFks(column);
    return fks.length > 1 || fks.some((fk) => splitList(fk.columns).length > 1);
  }

  const schemaTables = peekSchema(conn, false) ?? peekSchema(conn, true) ?? NO_TABLES;

  function setColumnFk(row: number, text: string): void {
    if (draft === null) {
      return;
    }
    const column = draft.columns[row];
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
        store.setError(t("컬럼 이름을 먼저 입력하세요"));
        return;
      }
      const match = FK_TEXT.exec(value);
      if (match === null || (match[2] ?? "").includes(",")) {
        store.setError(t("외래 키는 table(column) 형식으로 입력하세요"));
        return;
      }
      const refTable = match[1].trim();
      let refColumns = (match[2] ?? "").trim();
      if (refColumns === "") {
        const pk = schemaTables
          .find((schema) => schema.name === refTable)
          ?.columns.filter((entry) => entry.pk);
        if (pk === undefined || pk.length !== 1) {
          store.setError(t("참조할 컬럼을 table(column)으로 적어 주세요"));
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
    setColumnFocus({ row: draft.columns.length, col: 0, seq: Date.now() });
  }

  function addIndex(): void {
    if (draft === null) {
      return;
    }
    const index: IndexDraft = { key: draftKey(), orig: null, name: "", unique: false, columns: "" };
    setDraft({ ...draft, indexes: [...draft.indexes, index] });
    setIndexFocus({ row: pkRows + draft.indexes.length, col: 0, seq: Date.now() });
  }

  const engine = dialect(kind);
  const typeChoices = unique([...(TYPE_CHOICES[engine] ?? []), ...columns.map((column) => column.type)]);
  const defaultChoices = ["NULL", "''", "0", "1", ...(DEFAULT_CHOICES[engine] ?? [])];
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

  const columnGrid: GridColumn[] = [
    {
      header: "column_name",
      render: (row) => (
        <span className="structure-column-name">
          {columns[row].pk ? <KeyIcon size={10} className="structure-pk-icon" /> : null}
          {columns[row].name || <span className="structure-null">{t("컬럼 이름")}</span>}
        </span>
      ),
      value: (row) => columns[row].name,
      commit: (row, value) => patchColumn(row, { name: value.trim() }),
      changed: (row) => columnChanged(row, "name"),
    },
    {
      header: "data_type",
      className: "structure-type",
      render: (row) => columns[row].type,
      value: (row) => columns[row].type,
      options: () => typeChoices,
      commit: (row, value) => patchColumn(row, { type: value.trim() }),
      changed: (row) => columnChanged(row, "type"),
    },
    {
      header: "is_nullable",
      render: (row) => flag(!columns[row].notNull),
      value: (row) => (columns[row].notNull ? "NO" : "YES"),
      options: () => ["YES", "NO"],
      strict: true,
      commit: (row, value) => patchColumn(row, { notNull: value === "NO" }),
      changed: (row) => columnChanged(row, "notNull"),
    },
    {
      header: "is_primary",
      render: (row) => flag(columns[row].pk),
      value: (row) => (columns[row].pk ? "YES" : "NO"),
      options: () => ["YES", "NO"],
      strict: true,
      commit: (row, value) => patchColumn(row, { pk: value === "YES" }),
      changed: (row) => columnChanged(row, "pk"),
    },
    {
      header: "column_default",
      className: "structure-default",
      render: (row) => (columns[row].def === "" ? nullText() : columns[row].def),
      value: (row) => columns[row].def,
      options: () => defaultChoices,
      commit: (row, value) => patchColumn(row, { def: value.trim().toUpperCase() === "NULL" ? "" : value }),
      changed: (row) => columnChanged(row, "def"),
      title: (row) => columns[row].def || undefined,
    },
    {
      header: "foreign_key",
      className: "structure-fk-target",
      render: (row) => fkText(columns[row]),
      value: (row) => fkText(columns[row]),
      options: () => fkChoices,
      commit: (row, value) => setColumnFk(row, value.trim().toUpperCase() === "NULL" ? "" : value),
      readOnly: (row) => fkLocked(columns[row]),
      title: (row) => (fkLocked(columns[row]) ? t("복합 외래 키는 SQL로 변경하세요") : undefined),
    },
  ];

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

  const indexGrid: GridColumn[] = [
    {
      header: "index_name",
      render: (row) => {
        const index = indexAt(row);
        return (
          <span className="structure-column-name">
            {index === undefined ? <KeyIcon size={10} className="structure-pk-icon" /> : null}
            {index === undefined
              ? primaryName
              : index.name || <span className="structure-null">{t("인덱스 이름")}</span>}
          </span>
        );
      },
      value: (row) => indexAt(row)?.name ?? "",
      commit: (row, value) => patchIndex(row - pkRows, { name: value.trim() }),
      readOnly: (row) => row < pkRows,
      changed: (row) => indexChanged(row, "name"),
    },
    {
      header: "is_unique",
      render: (row) => flag(indexAt(row)?.unique ?? true, "TRUE", "FALSE"),
      value: (row) => ((indexAt(row)?.unique ?? true) ? "TRUE" : "FALSE"),
      options: () => ["TRUE", "FALSE"],
      strict: true,
      commit: (row, value) => patchIndex(row - pkRows, { unique: value === "TRUE" }),
      readOnly: (row) => row < pkRows,
      changed: (row) => indexChanged(row, "unique"),
    },
    {
      header: "column_name",
      render: (row) => indexAt(row)?.columns ?? primaryColumns.join(", "),
      value: (row) => indexAt(row)?.columns ?? "",
      options: () => [...columnNames].filter((name) => name !== ""),
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
      commit: (row, value) => patchIndex(row - pkRows, { columns: splitList(value).join(", ") }),
      readOnly: (row) => row < pkRows,
      changed: (row) => indexChanged(row, "columns"),
      title: (row) => (row < pkRows ? t("기본 키는 컬럼의 is_primary로 바꿉니다") : undefined),
    },
  ];

  function rowState(orig: string | null, key: string): string {
    return deleted.has(key) ? "deleted" : orig === null ? "new" : "";
  }

  return (
    <div className="panel structure-panel">
      <div className="panel-head structure-head">
        <span className="panel-title">
          <TableIcon size={12} />
          {table}
        </span>
        <span className="structure-kind">{kind}</span>
        {detail?.schema ? <span className="panel-stat mono">{detail.schema}</span> : null}
        {countText ? <span className="panel-stat">{countText}</span> : null}
        {sizeText ? <span className="panel-stat">{sizeText}</span> : null}
        <span className="spacer" />
        {busy ? <span className="panel-dim">{t("실행 중…")}</span> : null}
        {loading ? (
          <span className="panel-dim">
            <Spinner size={10} /> {t("불러오는 중…")}
          </span>
        ) : null}
        {pending ? (
          <>
            <button
              type="button"
              className={preview ? "icon-text-button active" : "icon-text-button"}
              onClick={() => setPreview((value) => !value)}
              title={t("미리보기")}
            >
              {t("미리보기")}
            </button>
            <button type="button" disabled={busy} onClick={discard}>
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
      <div className="panel-body structure-body">
        {error ? <ErrorNotice message={error} /> : null}
        {saveError ? <ErrorNotice message={saveError} onClose={() => setSaveError(null)} /> : null}
        {detail === null || draft === null ? (
          error ? null : (
            <div className="panel-empty">
              <Spinner size={14} />
              {t("불러오는 중…")}
            </div>
          )
        ) : (
          <>
            <section className="structure-section">
              <div className="structure-section-head">
                <span className="structure-section-title">
                  <ColumnsIcon size={11} />
                  {t("컬럼")}
                </span>
                <span className="structure-count">{columns.length}</span>
                <span className="structure-hint">{t("더블클릭해 편집 · ⌫ 행 삭제/되살리기")}</span>
                <span className="spacer" />
                <button type="button" className="icon-text-button" onClick={addColumn}>
                  {t("+ 컬럼 추가")}
                </button>
              </div>
              <div className="structure-table-wrap">
                <StructureGrid
                  rowKeys={columns.map((column) => column.key)}
                  columns={columnGrid}
                  numbered
                  rowClassName={(row) => rowState(columns[row].orig, columns[row].key)}
                  rowReadOnly={(row) => deleted.has(columns[row].key)}
                  onDeleteRow={deleteColumn}
                  focus={columnFocus}
                />
              </div>
            </section>

            <section className="structure-section">
              <div className="structure-section-head">
                <span className="structure-section-title">
                  <KeyIcon size={11} />
                  {t("인덱스")}
                </span>
                <span className="structure-count">{pkRows + indexes.length}</span>
                <span className="spacer" />
                <button type="button" className="icon-text-button" onClick={addIndex}>
                  {t("+ 인덱스 추가")}
                </button>
              </div>
              {pkRows + indexes.length === 0 ? (
                <div className="structure-empty">{t("인덱스가 없습니다")}</div>
              ) : (
                <div className="structure-table-wrap">
                  <StructureGrid
                    rowKeys={[
                      ...(pkRows > 0 ? ["primary"] : []),
                      ...indexes.map((index) => index.key),
                    ]}
                    columns={indexGrid}
                    rowClassName={(row) => {
                      const index = indexAt(row);
                      return index === undefined ? "" : rowState(index.orig, index.key);
                    }}
                    rowReadOnly={(row) => {
                      const index = indexAt(row);
                      return index !== undefined && deleted.has(index.key);
                    }}
                    canDeleteRow={(row) => row >= pkRows}
                    onDeleteRow={(row) => deleteIndex(row - pkRows)}
                    focus={indexFocus}
                  />
                </div>
              )}
            </section>

            {preview && diff !== null ? (
              <section className="structure-section">
                <div className="structure-section-head">
                  <span className="structure-section-title">{t("DDL 미리보기")}</span>
                </div>
                <DdlPreview result={diff} />
              </section>
            ) : null}

            <details className="structure-ddl">
              <summary>
                <span>{t("DDL")}</span>
                <span className="structure-count">
                  {detail.ddl === null ? t("DDL 미지원") : "CREATE"}
                </span>
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
