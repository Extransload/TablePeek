import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createTableSql, draftKey, type ColumnDraft } from "../ddl";
import { gridHeaderH, type CanvasGrid } from "../grid/CanvasGrid";
import type { RowSource } from "../grid/rowSource";
import { t } from "../i18n";
import { matchColumns, type MatchStrategy } from "../importMatch";
import {
  decodeText,
  detectDelimiter,
  ENCODING_LABELS,
  IMPORT_ENCODINGS,
  parseCsv,
  parseJsonImport,
  type ParsedImport,
} from "../importParse";
import {
  ImportFailure,
  importLiteral,
  insertModes,
  modeNeedsKey,
  runImport,
  type ImportPlan,
  type InsertMode,
} from "../importSql";
import { asBoolean, profileColumn, textProfile, typeChoices, typeName, wantsBoolean } from "../importTypes";
import { cancelJob, startJob } from "../jobs";
import { palette } from "../palette";
import { getSettings } from "../settings";
import { store, type TableDetail } from "../store";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { ErrorNotice } from "./ErrorNotice";
import { FolderIcon, StopIcon } from "./icons";
import { PromptModal } from "./PromptModal";
import { TableGrid, type TableGridHandle } from "./TableGrid";

export type ImportFormat = "csv" | "json";

interface ImportModalProps {
  conn: string;
  kind: string;
  format: ImportFormat;
  // The database's tables, to pick the destination from.
  tables: string[];
  // The destination picked beforehand (a table's own menu), else none.
  table: string | null;
  onImported(table: string, created: boolean): void;
  onClose(): void;
}

// A new table's column, made from a source column.
interface NewColumn {
  name: string;
  type: string;
  include: boolean;
}

// The user's own picks from the header menus; they hold until what they were
// made on (the file, its options, the destination, the strategy) changes.
interface Overrides {
  basis: string;
  targets: Record<number, string | null>;
  columns: Record<number, Partial<NewColumn>>;
}

interface Running {
  done: number;
  total: number;
  locating: boolean;
}

const CHUNK_ROWS = 200;
const PREVIEW_ROWS = 100;
const MIN_COLUMN_W = 96;
const DELIMITERS: { value: string; label: string }[] = [
  { value: ",", label: ", (쉼표)" },
  { value: ";", label: "; (세미콜론)" },
  { value: "\t", label: "탭" },
];
const QUOTES = ['"', "'"];

function errorOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

// "sales 2024.csv" → "sales_2024": a dot would read as a schema.
function tableNameOf(fileName: string): string {
  return fileName.replace(/\.[^.]*$/, "").replace(/[.\s]+/g, "_") || "imported";
}

function* columnValues(rows: unknown[][], col: number): Generator<unknown> {
  for (const row of rows) {
    yield row[col];
  }
}

function primaryKeyOf(detail: TableDetail): string[] {
  return detail.indexes.find((index) => index.primary)?.columns ?? detail.columns.filter((c) => c.pk).map((c) => c.name);
}

// The first rows as the file gives them, under headers that say where each
// column goes; columns left out are drawn faint.
class PreviewSource implements RowSource {
  columns: string[] = [];
  readonly rowCount: number;
  private readonly rows: unknown[][];
  private skipped: boolean[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(rows: unknown[][]) {
    this.rows = rows;
    this.rowCount = rows.length;
  }

  label(columns: string[], skipped: boolean[]): void {
    this.columns = columns;
    this.skipped = skipped;
  }

  changed(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  cell(row: number, col: number): unknown {
    const value = this.rows[row]?.[col];
    return value === undefined ? null : value;
  }

  cellInk(_row: number, col: number): string | null {
    return this.skipped[col] ? palette.faint : null;
  }

  onUpdate(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

// CSV and JSON into a table, as TablePlus's import: the options, the
// destination (an existing table or a new one named after the file), how
// columns match, then the first rows with each header naming where its column
// goes; clicking a header changes that. Rows go in by chunks in one
// transaction, so a failure or a stop leaves the table as it was.
export function ImportModal({ conn, kind, format, tables, table, onImported, onClose }: ImportModalProps) {
  const settings = getSettings();
  const [fileName, setFileName] = useState("");
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [encoding, setEncoding] = useState<string>(settings.csvEncoding);
  const [delimiter, setDelimiter] = useState(settings.csvDelimiter || ",");
  // A saved delimiter the list doesn't have (a pipe, say) shows as typed in.
  const [customDelimiter, setCustomDelimiter] = useState(
    () => !DELIMITERS.some((entry) => entry.value === (settings.csvDelimiter || ",")),
  );
  const [quote, setQuote] = useState('"');
  const [customQuote, setCustomQuote] = useState(false);
  const [header, setHeader] = useState(settings.csvHeader);
  const [emptyAsNull, setEmptyAsNull] = useState(true);
  const [createNew, setCreateNew] = useState(table === null && tables.length === 0);
  const [target, setTarget] = useState(table ?? "");
  const [newName, setNewName] = useState("");
  const [allText, setAllText] = useState(false);
  const [strategy, setStrategy] = useState<MatchStrategy>("nameOrder");
  const [mode, setMode] = useState<InsertMode>("insert");
  const [detail, setDetail] = useState<{ table: string; detail: TableDetail } | null>(null);
  const [overrides, setOverrides] = useState<Overrides>({ basis: "", targets: {}, columns: {} });
  const [menu, setMenu] = useState<{ x: number; y: number; col: number } | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [running, setRunning] = useState<Running | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Where a failed import stopped, shown above the database's own error (whose
  // explanation would otherwise hide it); only while that error is the one shown.
  const [failedAt, setFailedAt] = useState<{ error: string; text: string } | null>(null);
  // The running import's job: Stop here and in the jobs queue both cancel it.
  const jobRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pointerRef = useRef({ x: 0, y: 0 });
  const tableRef = useRef<TableGridHandle | null>(null);
  const busy = running !== null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape" && !busy && renaming === null && menu === null) {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, renaming, menu, onClose]);

  // The destination's columns and key.
  useEffect(() => {
    if (createNew || target === "") {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await store.fetchTableDetail(conn, target);
        if (!cancelled) {
          setDetail({ table: target, detail: loaded });
        }
      } catch (err) {
        if (!cancelled) {
          setError(errorOf(err, t("테이블 구조를 불러오지 못했습니다")));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conn, target, createNew]);

  const read = useMemo((): { parsed: ParsedImport | null; error: string | null } => {
    if (bytes === null) {
      return { parsed: null, error: null };
    }
    try {
      const text = decodeText(bytes, encoding);
      const parsed = format === "json" ? parseJsonImport(text) : parseCsv(text, { delimiter, quote, header });
      return { parsed, error: null };
    } catch (err) {
      return { parsed: null, error: errorOf(err, t("파일을 해석하지 못했습니다")) };
    }
  }, [bytes, encoding, format, delimiter, quote, header]);
  const parsed = read.parsed;
  const sources = parsed?.columns ?? [];

  const tableDetail = !createNew && detail !== null && detail.table === target ? detail.detail : null;
  const targetColumns = useMemo(() => tableDetail?.columns.map((column) => column.name) ?? [], [tableDetail]);
  const pk = useMemo(() => (tableDetail === null ? [] : primaryKeyOf(tableDetail)), [tableDetail]);

  const profiles = useMemo(
    () => (parsed === null ? [] : parsed.columns.map((_, col) => profileColumn(columnValues(parsed.rows, col)))),
    [parsed],
  );

  const basis = JSON.stringify([fileName, sources, createNew, target, strategy, targetColumns, allText]);
  const picks = overrides.basis === basis ? overrides : { basis, targets: {}, columns: {} };

  const autoTargets = useMemo(
    () => matchColumns(sources, targetColumns, strategy),
    // sources and targetColumns are new arrays on every parse; basis says when they differ.
    [basis],
  );
  const mapping: (string | null)[] = sources.map((_, col) =>
    Object.hasOwn(picks.targets, col) ? picks.targets[col] : autoTargets[col],
  );
  const newColumns: NewColumn[] = sources.map((source, col) => {
    const profile = profiles[col] ?? textProfile();
    const guessed = typeName(allText ? textProfile(profile.maxLength) : profile, kind);
    return { name: source, type: guessed, include: true, ...picks.columns[col] };
  });

  // What goes in: each imported source column and the column it fills.
  const included = sources.flatMap((_, col) => {
    if (createNew) {
      const column = newColumns[col];
      return column.include ? [{ source: col, name: column.name, boolean: wantsBoolean(column.type) }] : [];
    }
    const name = mapping[col];
    if (name === null) {
      return [];
    }
    const declared = tableDetail?.columns.find((column) => column.name === name)?.decl_type ?? null;
    return [{ source: col, name, boolean: wantsBoolean(declared) }];
  });

  const modes = createNew ? (["insert"] as InsertMode[]) : insertModes(kind);
  const keyMissing = modeNeedsKey(mode, kind) && pk.length === 0;
  const effectiveMode: InsertMode = modes.includes(mode) && !keyMissing ? mode : "insert";

  const preview = useMemo(() => new PreviewSource(parsed?.rows.slice(0, PREVIEW_ROWS) ?? []), [parsed]);
  const labels = sources.map((source, col) => {
    if (createNew) {
      const column = newColumns[col];
      if (!column.include) {
        return `${source} → ${t("가져오지 않음")}`;
      }
      const named = column.name === source ? source : `${source} → ${column.name}`;
      return `${named} · ${column.type}`;
    }
    return `${source} → ${mapping[col] ?? t("가져오지 않음")}`;
  });
  const skipped = sources.map((_, col) => (createNew ? !newColumns[col].include : mapping[col] === null));
  // Set while rendering, so the grid takes its first source already labelled.
  preview.label(labels, skipped);
  const labelKey = JSON.stringify([labels, skipped]);
  useLayoutEffect(() => {
    preview.changed();
  }, [preview, labelKey]);
  // Columns fit their headers again when the matching (not one pick) changes.
  useLayoutEffect(() => {
    tableRef.current?.grid()?.fitColumns(MIN_COLUMN_W);
  }, [preview, basis]);

  function pick(file: File): void {
    setError(null);
    setFileName(file.name);
    setNewName(tableNameOf(file.name));
    void file.arrayBuffer().then(
      (buffer) => {
        if (format === "csv") {
          const head = decodeText(buffer.slice(0, 64 * 1024), encoding);
          const detected = /\.tsv$/i.test(file.name) ? "\t" : detectDelimiter(head);
          setDelimiter(detected);
          setCustomDelimiter(false);
        }
        setBytes(buffer);
      },
      (err: unknown) => setError(errorOf(err, t("파일을 읽지 못했습니다"))),
    );
  }

  function setTargetFor(col: number, name: string | null): void {
    const targets = { ...picks.targets, [col]: name };
    if (name !== null) {
      // A column is filled from one source: the one that had it lets go.
      mapping.forEach((current, other) => {
        if (other !== col && current === name) {
          targets[other] = null;
        }
      });
    }
    setOverrides({ ...picks, targets });
  }

  function setColumn(col: number, change: Partial<NewColumn>): void {
    setOverrides({ ...picks, columns: { ...picks.columns, [col]: { ...picks.columns[col], ...change } } });
  }

  function menuItems(col: number): ContextMenuItem[] {
    if (createNew) {
      const column = newColumns[col];
      return [
        { label: t("이름 변경…"), onSelect: () => setRenaming(col) },
        {
          label: t("데이터 타입"),
          submenu: typeChoices(kind, column.type).map((type) => ({
            label: type,
            checked: type === column.type,
            onSelect: () => setColumn(col, { type }),
          })),
        },
        {
          label: t("가져오지 않음"),
          separatorBefore: true,
          checked: !column.include,
          onSelect: () => setColumn(col, { include: !column.include }),
        },
      ];
    }
    const items: ContextMenuItem[] = targetColumns.map((name) => {
      const holder = mapping.findIndex((current, other) => other !== col && current === name);
      return {
        label: holder >= 0 ? `${name}  ← ${sources[holder]}` : name,
        checked: mapping[col] === name,
        onSelect: () => setTargetFor(col, name),
      };
    });
    items.push({
      label: t("가져오지 않음"),
      separatorBefore: items.length > 0,
      checked: mapping[col] === null,
      onSelect: () => setTargetFor(col, null),
    });
    return items;
  }

  function onReady(grid: CanvasGrid): () => void {
    // The header click carries no position; the menu opens where it was.
    const host = grid.hostElement();
    const remember = (event: PointerEvent): void => {
      pointerRef.current = { x: event.clientX, y: event.clientY };
    };
    host.addEventListener("pointerup", remember, true);
    return () => host.removeEventListener("pointerup", remember, true);
  }

  function openHeaderMenu(col: number): void {
    if (busy) {
      return;
    }
    const host = tableRef.current?.grid()?.hostElement();
    const top = host ? host.getBoundingClientRect().top + gridHeaderH() : pointerRef.current.y;
    setMenu({ x: pointerRef.current.x, y: top, col });
  }

  const destination = createNew ? newName.trim() : target;
  const ready = parsed !== null && parsed.rows.length > 0 && included.length > 0 && destination !== "" && (createNew || tableDetail !== null);

  async function run(): Promise<void> {
    if (!ready || parsed === null || busy) {
      return;
    }
    setError(null);
    let create: string[] = [];
    if (createNew) {
      const drafts: ColumnDraft[] = included.map((column) => ({
        key: draftKey(),
        orig: null,
        name: column.name,
        type: newColumns[column.source].type,
        notNull: false,
        pk: false,
        def: "",
      }));
      const made = createTableSql(kind, destination, { columns: drafts, indexes: [], foreignKeys: [] });
      if (made.errors.length > 0) {
        setError(made.errors.join("\n"));
        return;
      }
      create = made.statements;
    }
    const rows = parsed.rows;
    const plan: ImportPlan = {
      spec: { dialect: kind, table: destination, columns: included.map((column) => column.name), pk, mode: effectiveMode },
      create,
      rowCount: rows.length,
      chunkRows: CHUNK_ROWS,
      literals: (row) =>
        included.map((column) => {
          let value = rows[row][column.source];
          if (value === "" && emptyAsNull) {
            value = null;
          }
          return importLiteral(column.boolean ? asBoolean(value) : value, kind);
        }),
    };
    const job = startJob(t("가져오기: {table}", { table: destination }), fileName, rows.length, {
      cancellable: true,
    });
    jobRef.current = job.id;
    setRunning({ done: 0, total: rows.length, locating: false });
    const where = (row: number): string => {
      const at = parsed.at[row] ?? row + 1;
      return parsed.unit === "line" ? t("{line}번째 줄", { line: at.toLocaleString() }) : t("레코드 {index}", { index: at.toLocaleString() });
    };
    try {
      await runImport(
        plan,
        {
          exec: async (sql) => {
            await store.exec(conn, sql);
          },
          begin: () => store.ownTx(conn, "begin"),
          commit: () => store.ownTx(conn, "commit"),
          rollback: () => store.ownTx(conn, "rollback"),
        },
        job.signal,
        (done, locating = false) => {
          job.update(done, locating ? t("오류가 난 행을 찾는 중…") : undefined);
          if (mountedRef.current) {
            setRunning({ done, total: rows.length, locating });
          }
        },
      );
      job.finish();
      store.setInfo(t("가져오기 완료: {table}에 {count}행", { table: destination, count: rows.length.toLocaleString() }));
      onImported(destination, createNew);
      if (mountedRef.current) {
        onClose();
      }
    } catch (err) {
      let message: string;
      let at: string | null = null;
      if (err instanceof ImportFailure) {
        message = err.stopped
          ? t("가져오기를 중지했습니다. 테이블은 바뀌지 않았습니다.")
          : err.row !== null
            ? t("{where}에서 실패해 모두 되돌렸습니다: {error}", { where: where(err.row), error: err.message })
            : t("가져오기에 실패해 모두 되돌렸습니다: {error}", { error: err.message });
        if (!err.stopped) {
          at =
            err.row !== null
              ? t("{where}에서 실패해 모두 되돌렸습니다", { where: where(err.row) })
              : t("가져오기에 실패해 모두 되돌렸습니다");
        }
      } else {
        message = errorOf(err, t("가져오기에 실패했습니다"));
      }
      job.fail(message);
      if (mountedRef.current) {
        if (at !== null && err instanceof ImportFailure) {
          setError(err.message);
          setFailedAt({ error: err.message, text: at });
        } else {
          setError(message);
        }
      } else {
        store.setError(message);
      }
    } finally {
      jobRef.current = null;
      if (mountedRef.current) {
        setRunning(null);
      }
    }
  }

  const title = format === "json" ? t("JSON 가져오기") : t("CSV 가져오기");
  const rowCount = parsed?.rows.length ?? 0;
  const strategyLabels: Record<MatchStrategy, string> = {
    nameOrder: t("이름과 순서로"),
    name: t("이름으로"),
    order: t("순서로"),
  };
  const modeLabels: Record<InsertMode, string> = {
    insert: t("오류 시 중단 (STOP ON ERROR)"),
    upsert: t("중복 시 업데이트 (UPDATE ON DUPLICATE)"),
    replace: t("교체 (REPLACE)"),
  };

  return (
    <>
      <div className="modal-backdrop" onClick={() => (busy ? undefined : onClose())}>
        <div
          className="modal import-modal"
          onClick={(event) => event.stopPropagation()}
          onDragOver={(event) => {
            if (!busy) {
              event.preventDefault();
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            const file = event.dataTransfer.files[0];
            if (file && !busy) {
              pick(file);
            }
          }}
        >
          <div className="modal-head">
            <span className="modal-title">{title}</span>
            <span className="modal-path">{fileName ? `${fileName} · ${kind}` : kind}</span>
          </div>
          <div className="modal-body import-body">
            {error && failedAt?.error === error ? <div className="import-failed-at">{failedAt.text}</div> : null}
            {error ? <ErrorNotice message={error} /> : null}
            {read.error ? <ErrorNotice message={read.error} /> : null}
            <section className="export-section">
              <div className="import-options">
                <label className="file-button">
                  <FolderIcon size={12} />
                  {t("파일 선택")}
                  <input
                    type="file"
                    accept={format === "json" ? ".json,.jsonl,.ndjson,.txt" : ".csv,.tsv,.txt"}
                    disabled={busy}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) {
                        pick(file);
                      }
                    }}
                  />
                </label>
                <span className="import-file mono" title={fileName}>
                  {fileName || t("선택한 파일 없음")}
                </span>
                {parsed !== null ? (
                  <span className="panel-count">{t("{count}행", { count: rowCount.toLocaleString() })}</span>
                ) : null}
              </div>
              <div className="import-options">
                {format === "csv" ? (
                  <>
                    <label className="field">
                      <span>{t("구분자")}</span>
                      <span className="import-pair">
                        <select
                          value={customDelimiter ? "custom" : delimiter}
                          disabled={busy}
                          onChange={(event) => {
                            const value = event.target.value;
                            setCustomDelimiter(value === "custom");
                            if (value !== "custom") {
                              setDelimiter(value);
                            }
                          }}
                        >
                          {DELIMITERS.map((entry) => (
                            <option value={entry.value} key={entry.value}>
                              {t(entry.label)}
                            </option>
                          ))}
                          <option value="custom">{t("직접 입력")}</option>
                        </select>
                        {customDelimiter ? (
                          <input
                            className="import-char mono"
                            value={delimiter}
                            maxLength={4}
                            disabled={busy}
                            aria-label={t("구분자")}
                            onChange={(event) => setDelimiter(event.target.value)}
                          />
                        ) : null}
                      </span>
                    </label>
                    <label className="field">
                      <span>{t("따옴표")}</span>
                      <span className="import-pair">
                        <select
                          value={customQuote ? "custom" : quote}
                          disabled={busy}
                          onChange={(event) => {
                            const value = event.target.value;
                            setCustomQuote(value === "custom");
                            if (value !== "custom") {
                              setQuote(value);
                            }
                          }}
                        >
                          {QUOTES.map((entry) => (
                            <option value={entry} key={entry}>
                              {entry}
                            </option>
                          ))}
                          <option value="custom">{t("직접 입력")}</option>
                        </select>
                        {customQuote ? (
                          <input
                            className="import-char mono"
                            value={quote}
                            maxLength={1}
                            disabled={busy}
                            placeholder={t("없음")}
                            aria-label={t("따옴표")}
                            onChange={(event) => setQuote(event.target.value)}
                          />
                        ) : null}
                      </span>
                    </label>
                  </>
                ) : null}
                <label className="field">
                  <span>{t("인코딩")}</span>
                  <select value={encoding} disabled={busy} onChange={(event) => setEncoding(event.target.value)}>
                    {IMPORT_ENCODINGS.map((entry) => (
                      <option value={entry} key={entry}>
                        {ENCODING_LABELS[entry]}
                      </option>
                    ))}
                  </select>
                </label>
                {format === "csv" ? (
                  <label className="check-row inline">
                    <input
                      type="checkbox"
                      checked={header}
                      disabled={busy}
                      onChange={(event) => setHeader(event.target.checked)}
                    />
                    <span>{t("첫 줄이 헤더")}</span>
                  </label>
                ) : null}
                <label className="check-row inline">
                  <input
                    type="checkbox"
                    checked={emptyAsNull}
                    disabled={busy}
                    onChange={(event) => setEmptyAsNull(event.target.checked)}
                  />
                  <span>{t("빈 문자열 → NULL")}</span>
                </label>
              </div>
            </section>
            <section className="export-section">
              <div className="section-title">{t("대상")}</div>
              <div className="import-options">
                {createNew ? (
                  <label className="field">
                    <span>{t("새 테이블 이름")}</span>
                    <input
                      className="mono"
                      value={newName}
                      disabled={busy}
                      spellCheck={false}
                      onChange={(event) => setNewName(event.target.value)}
                    />
                  </label>
                ) : (
                  <label className="field">
                    <span>{t("테이블")}</span>
                    <select
                      value={target}
                      disabled={busy}
                      onChange={(event) => {
                        setError(null);
                        setTarget(event.target.value);
                      }}
                    >
                      <option value="" disabled>
                        {t("테이블 선택")}
                      </option>
                      {tables.map((name) => (
                        <option value={name} key={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="check-row inline">
                  <input
                    type="checkbox"
                    checked={createNew}
                    disabled={busy}
                    onChange={(event) => setCreateNew(event.target.checked)}
                  />
                  <span>{t("새 테이블 만들기")}</span>
                </label>
                {createNew ? (
                  <label className="check-row inline">
                    <input
                      type="checkbox"
                      checked={allText}
                      disabled={busy}
                      onChange={(event) => setAllText(event.target.checked)}
                    />
                    <span>{t("모든 컬럼을 텍스트로")}</span>
                  </label>
                ) : (
                  <label className="field">
                    <span>{t("컬럼 매칭")}</span>
                    <select
                      value={strategy}
                      disabled={busy}
                      onChange={(event) => setStrategy(event.target.value as MatchStrategy)}
                    >
                      {(["nameOrder", "name", "order"] as MatchStrategy[]).map((entry) => (
                        <option value={entry} key={entry}>
                          {strategyLabels[entry]}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {modes.length > 1 ? (
                  <label className="field">
                    <span>{t("삽입 방식")}</span>
                    <select
                      value={effectiveMode}
                      disabled={busy}
                      onChange={(event) => setMode(event.target.value as InsertMode)}
                    >
                      {modes.map((entry) => (
                        <option value={entry} key={entry} disabled={modeNeedsKey(entry, kind) && pk.length === 0}>
                          {modeNeedsKey(entry, kind) && pk.length === 0
                            ? `${modeLabels[entry]} — ${t("기본 키 없음")}`
                            : modeLabels[entry]}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
              <p className="helper">
                {createNew && kind === "mysql"
                  ? t("MySQL은 CREATE TABLE을 트랜잭션 밖에서 실행합니다. 가져오기가 실패하거나 중지되면 만든 테이블을 지웁니다.")
                  : t("모든 행을 한 트랜잭션으로 넣습니다. 실패하거나 중지하면 테이블은 그대로입니다.")}
              </p>
            </section>
            <section className="export-section">
              <div className="section-title">
                {t("미리보기")}
                {parsed !== null ? (
                  <span className="panel-count">{`${included.length} / ${sources.length}`}</span>
                ) : null}
                <span className="spacer" />
                {parsed !== null ? <span className="dim">{t("헤더를 눌러 대상 컬럼을 고릅니다")}</span> : null}
              </div>
              {parsed !== null ? (
                <div className="import-grid">
                  <TableGrid
                    ref={tableRef}
                    source={preview}
                    onHeaderClick={(col) => openHeaderMenu(col)}
                    onReady={onReady}
                  />
                </div>
              ) : (
                <div className="import-drop">
                  {format === "json"
                    ? t("JSON 파일을 선택하거나 이 창에 끌어다 놓으세요")
                    : t("CSV 파일을 선택하거나 이 창에 끌어다 놓으세요")}
                </div>
              )}
            </section>
          </div>
          <div className="modal-foot">
            {running !== null ? (
              <span className="dim">
                {running.locating
                  ? t("오류가 난 행을 찾는 중…")
                  : t("{done} / {total}행", {
                      done: running.done.toLocaleString(),
                      total: running.total.toLocaleString(),
                    })}
              </span>
            ) : null}
            <span className="spacer" />
            {running !== null ? (
              <>
                <button type="button" onClick={onClose}>
                  {t("백그라운드에서 계속")}
                </button>
                <button type="button" onClick={() => jobRef.current !== null && cancelJob(jobRef.current)}>
                  <StopIcon size={10} />
                  {t("중지")}
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={onClose}>
                  {t("닫기")}
                </button>
                <button type="button" className="primary" disabled={!ready} onClick={() => void run()}>
                  {t("가져오기")}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
      {menu !== null ? (
        <div className="import-header-menu">
          <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.col)} onClose={() => setMenu(null)} />
        </div>
      ) : null}
      {renaming !== null ? (
        <PromptModal
          title={t("컬럼 이름 변경")}
          label={t("새 테이블의 컬럼 이름")}
          initial={newColumns[renaming]?.name ?? ""}
          confirmLabel={t("변경")}
          onSubmit={(value) => {
            setColumn(renaming, { name: value.trim() });
            setRenaming(null);
          }}
          onClose={() => setRenaming(null)}
        />
      ) : null}
    </>
  );
}
