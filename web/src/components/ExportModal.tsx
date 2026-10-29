import { useEffect, useMemo, useRef, useState } from "react";
import { buildOrderBy, buildWhere, rowWindowSql } from "../dataQuery";
import {
  createTableSql,
  dependencyOrder,
  draftsFromDetail,
  dumpIndexSql,
  dropForeignKeySql,
  dropIfExistsSql,
  foreignKeySql,
} from "../ddl";
import {
  csvHead,
  csvLines,
  downloadBlob,
  escapeSqlIdentifier,
  EXPORT_MAX_ROWS,
  EXPORT_MIME,
  exportBaseName,
  gzipBlob,
  jsonEnd,
  jsonItems,
  quoteIdentifier,
  readRows,
  safeFileName,
  TextBlobBuilder,
  toSqlInserts,
  type CsvOptions,
  type ExportFormat,
} from "../export";
import type { SqlDialect } from "../engines/sqlDialect";
import { declaredAs } from "../grid/columns";
import type { WindowedRowSource } from "../grid/windowSource";
import { t } from "../i18n";
import { cancelJob, startJob, subscribeJobs, type Job, type JobHandle } from "../jobs";
import { getSettings } from "../settings";
import { classifyStatement } from "../sqlTools";
import { store, type EngineMeta, type GridResult, type TableDetail, type TableDetailForeignKey } from "../store";
import { countFor, type DataTab } from "../tabs";
import { XlsxWriter } from "../xlsx";
import { ZipWriter } from "../zip";
import { ErrorNotice, notifyError } from "./ErrorNotice";
import { SearchIcon } from "./icons";
import { Select } from "./Select";

export interface ExportResultEntry {
  label: string;
  result: GridResult;
}

export type ExportTarget =
  | {
      mode: "results";
      conn: string;
      title: string;
      result: GridResult;
      dataTab: DataTab | null;
      // A multi-statement run's results that have rows to write.
      results: ExportResultEntry[] | null;
    }
  | {
      mode: "tables";
      conn: string;
      // Checked when the window opens.
      picked: string[];
      // "Export with Column Selection": one table, and a checklist of its fields.
      columnPick: boolean;
    };

interface ExportModalProps {
  target: ExportTarget;
  meta: EngineMeta;
  dialect: SqlDialect;
  onClose(): void;
  // Reads the schema again (the error's "스키마 새로고침"); the list follows `meta`.
  onRefreshSchema(): void;
}

type ItemKind = "table" | "view";

interface Item {
  name: string;
  kind: ItemKind;
}

// What the SQL format writes for an item, as TablePlus's Structure, Drop and Data.
interface ItemFlags {
  structure: boolean;
  drop: boolean;
  data: boolean;
}

type FlagKey = keyof ItemFlags;

const FLAG_COLUMNS: { key: FlagKey; label: string }[] = [
  { key: "structure", label: "구조" },
  { key: "drop", label: "DROP" },
  { key: "data", label: "데이터" },
];

const FORMATS: { value: ExportFormat; label: string }[] = [
  { value: "csv", label: "CSV" },
  { value: "json", label: "JSON" },
  { value: "sql", label: "SQL" },
  { value: "xlsx", label: "Excel" },
];

// Rows per page when a table is read in key order.
const PAGE_SIZE = 5000;
// Rows per step when reading a result the server already holds.
const CHUNK = 1000;

function errorOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function defaultFlags(kind: ItemKind): ItemFlags {
  // Rows inserted into a view rarely land anywhere, so a view's data starts off.
  return { structure: true, drop: false, data: kind === "table" };
}

function databaseName(meta: EngineMeta): string {
  if (meta.path === null) {
    return "database";
  }
  const parts = meta.path.split("/");
  return parts[parts.length - 1] || "database";
}

// A name inside an SQL comment: a line break would end the comment early.
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ");
}

function keyColumns(detail: TableDetail): string[] {
  const primary = detail.indexes.find((index) => index.primary);
  if (primary && primary.columns.length > 0) {
    return primary.columns;
  }
  return detail.columns.filter((column) => column.pk).map((column) => column.name);
}

// A result is run again only if running it can't change anything.
function rerunnable(sql: string, dialect: SqlDialect): boolean {
  return classifyStatement(sql, dialect) === null;
}

// ── Reading rows ─────────────────────────────────────────────────────────

interface Feed {
  columns: string[];
  // How many rows will come, when that is known before reading.
  size: number | null;
  // A single pass stopped at EXPORT_MAX_ROWS.
  truncated: boolean;
  // The next rows, or null once there are none.
  next(): Promise<unknown[][] | null>;
  close(): void;
}

function sourceFeed(source: WindowedRowSource, pick: number[] | null, close: () => void = () => {}): Feed {
  let at = 0;
  return {
    columns: pick === null ? source.columns : pick.map((index) => source.columns[index]),
    size: source.baseRowCount,
    truncated: false,
    async next() {
      if (at >= source.baseRowCount) {
        return null;
      }
      const rows = await readRows(source, at, at + CHUNK, pick ?? undefined);
      at += CHUNK;
      return rows;
    },
    close,
  };
}

// One statement, read through in windows: what can't be paged in a stable
// order (a view, a table with no key, any query) still reads consistently.
async function singlePassFeed(conn: string, sql: string, pick: number[] | null, signal: AbortSignal): Promise<Feed> {
  const detached = await store.runDetached(conn, sql, EXPORT_MAX_ROWS);
  if (signal.aborted) {
    detached.source.dispose();
    signal.throwIfAborted();
  }
  return {
    ...sourceFeed(detached.source, pick, () => detached.source.dispose()),
    truncated: detached.meta.truncated,
  };
}

async function fetchPage(
  conn: string,
  dialect: SqlDialect,
  base: string,
  order: string,
  offset: number,
): Promise<{ columns: string[]; rows: unknown[][] }> {
  const sql = `${base} ${rowWindowSql(dialect, order, PAGE_SIZE, offset)}`;
  const detached = await store.runDetached(conn, sql, PAGE_SIZE);
  try {
    return { columns: detached.meta.columns, rows: await readRows(detached.source, 0, PAGE_SIZE) };
  } finally {
    detached.source.dispose();
  }
}

// A page at a time in key order, so no row is read twice or missed and the
// table's size has no limit.
async function pagedFeed(conn: string, dialect: SqlDialect, base: string, order: string, signal: AbortSignal): Promise<Feed> {
  const first = await fetchPage(conn, dialect, base, order, 0);
  let pending: unknown[][] | null = first.rows;
  let offset = first.rows.length;
  return {
    columns: first.columns,
    size: null,
    truncated: false,
    async next() {
      const rows = pending;
      if (rows === null) {
        return null;
      }
      if (rows.length < PAGE_SIZE) {
        pending = null;
        return rows.length > 0 ? rows : null;
      }
      signal.throwIfAborted();
      const page = await fetchPage(conn, dialect, base, order, offset);
      offset += page.rows.length;
      pending = page.rows;
      return rows;
    },
    close() {},
  };
}

function tableFeed(
  conn: string,
  dialect: SqlDialect,
  item: Item,
  detail: TableDetail | null,
  columns: string[] | null,
  signal: AbortSignal,
): Promise<Feed> {
  const list = columns === null ? "*" : columns.map((name) => escapeSqlIdentifier(name, dialect)).join(", ");
  const base = `SELECT ${list} FROM ${quoteIdentifier(item.name, dialect)}`;
  const pk = detail === null ? [] : keyColumns(detail);
  // A table without a declared key may still have an order of its own (SQLite's rowid).
  const order =
    pk.length > 0
      ? pk.map((name) => escapeSqlIdentifier(name, dialect)).join(", ")
      : detail !== null
        ? dialect.implicitRowOrder
        : null;
  return order !== null ? pagedFeed(conn, dialect, base, order, signal) : singlePassFeed(conn, base, null, signal);
}

// Every row of a data tab under its filter and sort; the key breaks ties so
// pages don't overlap.
function dataTabFeed(
  conn: string,
  dialect: SqlDialect,
  tab: DataTab,
  result: GridResult,
  names: string[],
  signal: AbortSignal,
): Promise<Feed> {
  const where = buildWhere(tab.filter ?? null, dialect);
  const base = `SELECT ${names.map((name) => escapeSqlIdentifier(name, dialect)).join(", ")} FROM ${quoteIdentifier(tab.table, dialect)}${
    where === null ? "" : ` WHERE ${where}`
  }`;
  const sorts = tab.sorts ?? [];
  const pk = tab.pkColumns ?? tab.meta?.pk ?? result.meta.pk ?? [];
  const sorted = new Set(sorts.map((sort) => sort.column));
  const order = [
    buildOrderBy(sorts, dialect),
    ...pk.filter((name) => !sorted.has(name)).map((name) => escapeSqlIdentifier(name, dialect)),
  ]
    .filter((part): part is string => part !== null && part !== "")
    .join(", ");
  if (pk.length > 0) {
    return pagedFeed(conn, dialect, base, order, signal);
  }
  return singlePassFeed(conn, order === "" ? base : `${base} ORDER BY ${order}`, null, signal);
}

// ── Writing files ────────────────────────────────────────────────────────

interface FileWriter {
  write(rows: unknown[][]): void;
  end(): Promise<Blob>;
}

function fileWriter(
  format: Exclude<ExportFormat, "sql">,
  title: string,
  columns: string[],
  numeric: boolean[],
  csv: CsvOptions,
): FileWriter {
  if (format === "xlsx") {
    const book = new XlsxWriter(title);
    book.setColumns(columns);
    return { write: (rows) => book.addRows(rows, numeric), end: () => book.finish() };
  }
  const out = new TextBlobBuilder();
  if (format === "csv") {
    const options: CsvOptions = { ...csv, numeric };
    out.push(csvHead(columns, options));
    return {
      write: (rows) => out.push(csvLines(rows, columns.length, options)),
      end: async () => out.blob(EXPORT_MIME.csv),
    };
  }
  let empty = true;
  out.push("[");
  return {
    write(rows) {
      if (rows.length > 0) {
        out.push(jsonItems(columns, rows, empty));
        empty = false;
      }
    },
    async end() {
      out.push(jsonEnd(empty));
      return out.blob(EXPORT_MIME.json);
    },
  };
}

// One item of an export: a table, a view or a result.
interface Section {
  // Its file's name inside a zip, without the extension.
  name: string;
  // What INSERTs go into, and the SQL file's heading for it.
  table: string;
  expected: number;
  numeric(columns: string[]): boolean[];
  binary(columns: string[]): boolean[];
  drop: string | null;
  // References dropped before any table is, where dropped tables form a cycle.
  unlink: string[];
  structure: (() => Promise<string[]>) | null;
  data: boolean;
  // CREATE INDEX, written after the section's rows.
  indexes: string[];
  // ALTER TABLE … ADD CONSTRAINT, written once every table holds its rows.
  foreignKeys: string[];
  open(signal: AbortSignal): Promise<Feed>;
}

interface ExportPlan {
  format: ExportFormat;
  // The engine's name, for the file's header, and its SQL.
  kind: string;
  dialect: SqlDialect;
  csv: CsvOptions;
  gzip: boolean;
  base: string;
  // Tables' SQL: MySQL's foreign key checks go off while it runs.
  dump: boolean;
  sections(signal: AbortSignal): Promise<Section[]>;
}

interface Outcome {
  name: string;
  blob: Blob;
  // Items cut off at EXPORT_MAX_ROWS.
  cut: string[];
}

function uniqueName(used: Set<string>, name: string, ext: string): string {
  let candidate = `${name}.${ext}`;
  for (let n = 2; used.has(candidate.toLowerCase()); n += 1) {
    candidate = `${name} (${n}).${ext}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

async function runExport(plan: ExportPlan, job: JobHandle): Promise<Outcome> {
  const signal = job.signal;
  const sections = await plan.sections(signal);
  const expected = sections.map((section) => Math.max(0, section.expected));
  const done = sections.map(() => 0);
  const cut: string[] = [];
  function report(detail: string): void {
    const rows = done.reduce((sum, value) => sum + value, 0);
    const total = expected.reduce((sum, value, index) => sum + Math.max(value, done[index]), 0);
    job.update(rows, detail, total);
  }
  async function pump(index: number, feed: Feed, write: (rows: unknown[][]) => void): Promise<void> {
    if (feed.size !== null) {
      expected[index] = feed.size;
    }
    for (;;) {
      signal.throwIfAborted();
      const rows = await feed.next();
      if (rows === null) {
        break;
      }
      write(rows);
      done[index] += rows.length;
      report(t("{item} · {count}행", { item: sections[index].name, count: done[index].toLocaleString() }));
    }
    if (feed.truncated) {
      cut.push(sections[index].name);
    }
  }

  if (plan.format === "sql") {
    // The file reads the same whatever the UI language, so exports compare.
    const out = new TextBlobBuilder();
    out.push(`-- TablePeek SQL export\n-- Engine: ${plan.kind}\n-- Created: ${new Date().toISOString()}\n\n`);
    if (plan.dump && plan.dialect.dumpBefore !== undefined) {
      out.push(`${plan.dialect.dumpBefore}\n\n`);
    }
    // Sections come parents first, so children (and views) are dropped before
    // the tables they depend on.
    for (const statement of sections.flatMap((section) => section.unlink)) {
      out.push(`${statement};\n`);
    }
    const drops = sections.filter((section) => section.drop !== null).reverse();
    for (const section of drops) {
      out.push(`${section.drop};\n`);
    }
    if (drops.length > 0) {
      out.push("\n");
    }
    for (const [index, section] of sections.entries()) {
      signal.throwIfAborted();
      report(section.name);
      out.push(`-- ${oneLine(section.table)}\n`);
      if (section.structure !== null) {
        for (const statement of await section.structure()) {
          out.push(`${statement}\n`);
        }
      }
      if (section.data) {
        const feed = await section.open(signal);
        try {
          const binary = section.binary(feed.columns);
          await pump(index, feed, (rows) => {
            if (rows.length > 0) {
              out.push(`${toSqlInserts(section.table, feed.columns, rows, plan.dialect, binary)}\n`);
            }
          });
          if (feed.truncated) {
            out.push(`-- ${oneLine(section.table)}: cut off at ${EXPORT_MAX_ROWS} rows (one query's limit)\n`);
          }
        } finally {
          feed.close();
        }
      }
      for (const statement of section.indexes) {
        out.push(`${statement};\n`);
      }
      out.push("\n");
    }
    const keys = sections.flatMap((section) => section.foreignKeys);
    if (keys.length > 0) {
      out.push(`-- Foreign keys\n${keys.map((statement) => `${statement};\n`).join("")}\n`);
    }
    if (plan.dump && plan.dialect.dumpAfter !== undefined) {
      out.push(`${plan.dialect.dumpAfter}\n`);
    }
    const blob = out.blob(EXPORT_MIME.sql);
    signal.throwIfAborted();
    return plan.gzip
      ? { name: `${plan.base}.sql.gz`, blob: await gzipBlob(blob), cut }
      : { name: `${plan.base}.sql`, blob, cut };
  }

  const format = plan.format;
  // A browser can't write a folder: several files go into one zip instead.
  const zip = sections.length > 1 ? new ZipWriter() : null;
  const used = new Set<string>();
  let single: Blob = new Blob([]);
  for (const [index, section] of sections.entries()) {
    signal.throwIfAborted();
    report(section.name);
    const feed = await section.open(signal);
    let blob: Blob;
    try {
      const writer = fileWriter(format, section.name, feed.columns, section.numeric(feed.columns), plan.csv);
      await pump(index, feed, (rows) => writer.write(rows));
      blob = await writer.end();
    } finally {
      feed.close();
    }
    if (zip === null) {
      single = blob;
    } else {
      await zip.add(uniqueName(used, safeFileName(section.name), format), blob, { store: format === "xlsx" });
    }
  }
  signal.throwIfAborted();
  return zip === null
    ? { name: `${plan.base}.${format}`, blob: single, cut }
    : { name: `${plan.base}.zip`, blob: zip.finish(), cut };
}

async function structureSql(conn: string, dialect: SqlDialect, item: Item, detail: TableDetail | null): Promise<string[]> {
  const unavailable = (reason: string): string[] => [`-- ${oneLine(item.name)}: structure skipped (${oneLine(reason)})`];
  if (item.kind === "view") {
    try {
      const definition = await store.fetchDefinition(conn, "view", item.name);
      const ddl = definition.ddl?.trim() ?? "";
      if (ddl === "") {
        return unavailable("no definition");
      }
      // PostgreSQL gives the SELECT alone.
      const create = /^create\b/i.test(ddl) ? ddl : `CREATE VIEW ${quoteIdentifier(item.name, dialect)} AS\n${ddl}`;
      return [create.replace(/;?\s*$/, ";")];
    } catch (err) {
      return unavailable(errorOf(err, "could not read the definition"));
    }
  }
  if (detail === null) {
    return unavailable("could not read the structure");
  }
  if (detail.ddl !== null) {
    return [detail.ddl.trim().replace(/;?$/, ";")];
  }
  // Indexes follow the data and foreign keys all of it (see tableSections)
  // unless CREATE TABLE carries them (SQLite).
  const drafts = draftsFromDetail(detail);
  const created = createTableSql(
    dialect,
    item.name,
    dialect.keysInCreate ? drafts : { ...drafts, indexes: [], foreignKeys: [] },
  );
  return created.statements.length > 0
    ? created.statements.map((statement) => `${statement};`)
    : unavailable(created.errors.join("; "));
}

async function detailOrNull(conn: string, table: string): Promise<TableDetail | null> {
  try {
    return await store.fetchTableDetail(conn, table);
  } catch {
    // The rows still export; only the key, types and structure are unknown.
    return null;
  }
}

// The tables' sections; each one's structure (key, types, DDL) is read once
// the job runs. For SQL, tables come parents first and views after them, and
// a created table's indexes follow its rows and its foreign keys all the
// rows: the servers' CREATE TABLE text carries neither, and this way
// self-references and cycles load too.
function tableSections(
  conn: string,
  dialect: SqlDialect,
  format: ExportFormat,
  items: Item[],
  flags: ItemFlags[],
  columns: string[] | null,
): ExportPlan["sections"] {
  const sql = format === "sql";
  return async (signal) => {
    const sections: Section[] = [];
    const foreign = new Map<string, TableDetailForeignKey[]>();
    for (const [index, item] of items.entries()) {
      signal.throwIfAborted();
      const flag = flags[index];
      const detail = item.kind === "table" ? await detailOrNull(conn, item.name) : null;
      const keys = detail?.foreign_keys ?? [];
      foreign.set(item.name, keys);
      sections.push({
        name: item.name,
        table: item.name,
        expected: detail?.row_count_estimate ?? 0,
        numeric: (names) => declaredAs("number", names, detail, dialect),
        binary: (names) => declaredAs("binary", names, detail, dialect),
        drop: sql && flag.drop ? dropIfExistsSql(dialect, item.name, item.kind) : null,
        unlink: [],
        structure: sql && flag.structure ? () => structureSql(conn, dialect, item, detail) : null,
        data: !sql || flag.data,
        indexes: sql && flag.structure && detail !== null ? dumpIndexSql(dialect, item.name, detail) : [],
        foreignKeys:
          sql && flag.structure && !dialect.keysInCreate ? keys.map((fk) => foreignKeySql(dialect, item.name, fk)) : [],
        open: (sig) => tableFeed(conn, dialect, item, detail, columns, sig),
      });
    }
    if (!sql) {
      return sections;
    }
    const byName = new Map(sections.map((section) => [section.name, section]));
    const parents = (name: string): string[] => (foreign.get(name) ?? []).map((fk) => fk.ref_table);
    const dropped = new Set(sections.filter((section) => section.drop !== null).map((section) => section.name));
    // Whether `to` is reachable from `from` through references among dropped tables.
    const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
      if (from === to) {
        return true;
      }
      seen.add(from);
      return parents(from).some((next) => dropped.has(next) && !seen.has(next) && reaches(next, to, seen));
    };
    for (const section of sections) {
      if (section.drop === null) {
        continue;
      }
      section.unlink = (foreign.get(section.name) ?? []).flatMap((fk) => {
        const closes = fk.ref_table !== section.name && dropped.has(fk.ref_table) && reaches(fk.ref_table, section.name);
        const statement = closes ? dropForeignKeySql(dialect, section.name, fk) : null;
        return statement === null ? [] : [statement];
      });
    }
    const tables = items.filter((item) => item.kind === "table").map((item) => item.name);
    const views = items.filter((item) => item.kind === "view").map((item) => item.name);
    return [...dependencyOrder(tables, parents), ...views].map((name) => byName.get(name) as Section);
  };
}

interface ResultPick {
  label: string;
  result: GridResult;
  // The fields written, by index; null for all of them.
  pick: number[] | null;
  table: string;
}

function resultSections(
  conn: string,
  dialect: SqlDialect,
  entries: ResultPick[],
  tab: DataTab | null,
  wantAll: boolean,
): ExportPlan["sections"] {
  return async (signal) => {
    const sections: Section[] = [];
    for (const entry of entries) {
      signal.throwIfAborted();
      const source = entry.result.meta.sourceTable;
      const detail = source === null ? null : await detailOrNull(conn, source);
      const names =
        entry.pick === null ? entry.result.meta.columns : entry.pick.map((index) => entry.result.meta.columns[index]);
      let open: (sig: AbortSignal) => Promise<Feed>;
      let expected = entry.result.source.baseRowCount;
      if (wantAll && tab !== null) {
        open = (sig) => dataTabFeed(conn, dialect, tab, entry.result, names, sig);
        expected = countFor(tab, dialect) ?? expected;
      } else if (wantAll && entry.result.meta.truncated && rerunnable(entry.result.sql, dialect)) {
        open = (sig) => singlePassFeed(conn, entry.result.sql, entry.pick, sig);
      } else {
        // Every row already came back, or the statement changes data and isn't run again.
        open = async () => sourceFeed(entry.result.source, entry.pick);
      }
      sections.push({
        name: entry.label,
        table: entry.table,
        expected,
        numeric: (columns) => declaredAs("number", columns, detail, dialect),
        binary: (columns) => declaredAs("binary", columns, detail, dialect),
        drop: null,
        unlink: [],
        structure: null,
        data: true,
        indexes: [],
        foreignKeys: [],
        open,
      });
    }
    return sections;
  };
}

// ── The window ───────────────────────────────────────────────────────────

export function ExportModal({ target, meta, dialect, onClose, onRefreshSchema }: ExportModalProps) {
  const kind = meta.kind;
  const [opened] = useState(() => new Date());
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [csv, setCsv] = useState<CsvOptions>(() => {
    const settings = getSettings();
    return {
      header: settings.csvHeader,
      bom: false,
      delimiter: settings.csvDelimiter,
      quote: '"',
      lineBreak: "\r\n",
      decimal: ".",
      nullAsEmpty: true,
      lineBreakAsSpace: false,
    };
  });
  const [gzip, setGzip] = useState(false);
  // null: the suggested name, which follows what is picked.
  const [fileName, setFileName] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  // Tables; until the views are listed a picked name's kind isn't known.
  const [views, setViews] = useState<string[]>([]);
  const [listed, setListed] = useState(() => target.mode !== "tables" || target.columnPick);
  const [checked, setChecked] = useState<Set<string>>(() =>
    new Set(target.mode === "tables" ? target.picked : []),
  );
  const [flags, setFlags] = useState<Record<string, ItemFlags>>({});
  const [query, setQuery] = useState("");
  // Results
  const [scope, setScope] = useState<"loaded" | "all">("loaded");
  const [which, setWhich] = useState<"current" | "every">("current");
  const [insertTable, setInsertTable] = useState(() =>
    target.mode === "results" ? (target.dataTab?.table ?? target.result.meta.sourceTable ?? "exported") : "",
  );
  // The fields checklist: a result's columns, or the one table's.
  const [fields, setFields] = useState<string[] | null>(() =>
    target.mode === "results" ? target.result.meta.columns : null,
  );
  const [fieldOff, setFieldOff] = useState<Set<number>>(() => new Set());

  const running = jobId !== null;
  const columnPick = target.mode === "tables" && target.columnPick;
  const pickedTable = target.mode === "tables" ? (target.picked[0] ?? null) : null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape" && !running) {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [running, onClose]);

  useEffect(() => {
    if (jobId === null) {
      setJob(null);
      return;
    }
    return subscribeJobs((list) => setJob(list.find((entry) => entry.id === jobId) ?? null));
  }, [jobId]);

  useEffect(() => {
    if (target.mode !== "tables" || columnPick) {
      return;
    }
    let live = true;
    store
      .fetchObjects(target.conn)
      .then((objects) => {
        if (live) {
          setViews(objects.views);
          setListed(true);
        }
      })
      .catch(() => {
        // Tables still export; the list just has no views.
        if (live) {
          setListed(true);
        }
      });
    return () => {
      live = false;
    };
  }, [target.conn, target.mode, columnPick]);

  useEffect(() => {
    if (!columnPick || pickedTable === null) {
      return;
    }
    let live = true;
    store
      .fetchTableDetail(target.conn, pickedTable)
      .then((detail) => {
        if (live) {
          setFields(detail.columns.map((column) => column.name));
        }
      })
      .catch((err) => {
        if (live) {
          setError(errorOf(err, t("테이블 구조를 불러오지 못했습니다")));
          setFields([]);
        }
      });
    return () => {
      live = false;
    };
  }, [columnPick, pickedTable, target.conn]);

  const items: Item[] = useMemo(() => {
    if (target.mode !== "tables") {
      return [];
    }
    const tableSet = new Set(meta.tables);
    const all: Item[] = [
      ...meta.tables.map((name): Item => ({ name, kind: "table" })),
      ...views.filter((name) => !tableSet.has(name)).map((name): Item => ({ name, kind: "view" })),
    ];
    // A picked table neither list has (a system table, say) still shows.
    for (const name of target.picked) {
      if (!all.some((item) => item.name === name)) {
        all.push({ name, kind: "table" });
      }
    }
    return columnPick ? all.filter((item) => item.name === pickedTable) : all;
  }, [target, meta.tables, views, columnPick, pickedTable]);

  const chosen = items.filter((item) => checked.has(item.name));
  const results = target.mode === "results" ? (target.results ?? []) : [];
  const every = target.mode === "results" && which === "every" && results.length > 1;
  const showFields = columnPick || (target.mode === "results" && !every);
  const pick = fields === null ? null : fields.map((_, index) => index).filter((index) => !fieldOff.has(index));

  function flagsOf(item: Item): ItemFlags {
    return flags[item.name] ?? defaultFlags(item.kind);
  }

  const many = target.mode === "tables" ? chosen.length > 1 : every;
  const extension = format === "sql" ? (gzip ? ".sql.gz" : ".sql") : many ? ".zip" : `.${format}`;
  const suggested =
    target.mode === "tables"
      ? exportBaseName(chosen.length === 1 ? chosen[0].name : databaseName(meta), opened)
      : exportBaseName(target.title, opened);
  const base = fileName ?? suggested;

  const dataTab = target.mode === "results" ? target.dataTab : null;
  const current = target.mode === "results" ? target.result : null;
  const currentRerun = current !== null && rerunnable(current.sql, dialect);
  // A statement that changes data isn't run again, so rows past those loaded are out of reach.
  const allDisabled = current !== null && dataTab === null && current.meta.truncated && !currentRerun;

  let problem: string | null = null;
  if (target.mode === "tables") {
    if (!listed) {
      problem = t("목록을 불러오는 중…");
    } else if (chosen.length === 0) {
      problem = t("내보낼 항목을 고르세요");
    } else if (format === "sql" && chosen.every((item) => !Object.values(flagsOf(item)).some(Boolean))) {
      problem = t("구조·DROP·데이터 중 하나 이상을 고르세요");
    }
  }
  if (showFields && (pick === null || pick.length === 0)) {
    problem = fields === null ? t("필드를 불러오는 중…") : t("필드를 하나 이상 고르세요");
  }
  if (base.trim() === "") {
    problem = t("파일 이름을 입력하세요");
  } else if (safeFileName(base) !== base.trim()) {
    problem = t("파일 이름에 쓸 수 없는 문자가 있습니다");
  }

  function toggleChecked(names: string[], on: boolean): void {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const name of names) {
        if (on) {
          next.add(name);
        } else {
          next.delete(name);
        }
      }
      return next;
    });
  }

  function setFlag(targets: Item[], key: FlagKey, on: boolean): void {
    setFlags((prev) => {
      const next = { ...prev };
      for (const item of targets) {
        next[item.name] = { ...(prev[item.name] ?? defaultFlags(item.kind)), [key]: on };
      }
      return next;
    });
  }

  // The results to write, each with its fields and INSERT target.
  function resultPicks(): ResultPick[] {
    if (target.mode !== "results") {
      return [];
    }
    if (every) {
      return results.map((entry) => ({
        label: entry.label,
        result: entry.result,
        pick: null,
        // The label is the UI's ("결과 1"); a table name comes from the result.
        table: entry.result.meta.sourceTable ?? "exported",
      }));
    }
    return [{ label: target.title, result: target.result, pick, table: insertTable.trim() || "exported" }];
  }

  function start(): void {
    if (running || problem !== null) {
      return;
    }
    const conn = target.conn;
    const name = base.trim();
    const plan: ExportPlan = {
      format,
      kind,
      dialect,
      csv,
      gzip: format === "sql" && gzip,
      base: name,
      dump: target.mode === "tables",
      sections:
        target.mode === "tables"
          ? tableSections(
              conn,
              dialect,
              format,
              chosen,
              chosen.map(flagsOf),
              columnPick && fields !== null && pick !== null ? pick.map((index) => fields[index]) : null,
            )
          : resultSections(conn, dialect, resultPicks(), every ? null : dataTab, scope === "all"),
    };
    const handle = startJob(t("내보내기"), `${name}${extension}`, 0, {
      cancellable: true,
      // A long read in flight stops too, rather than holding the connection.
      onCancel: () => store.cancelJobStatement(conn),
    });
    setJobId(handle.id);
    setError(null);
    void (async () => {
      try {
        const outcome = await runExport(plan, handle);
        handle.signal.throwIfAborted();
        downloadBlob(outcome.name, outcome.blob);
        handle.finish();
        const note =
          outcome.cut.length > 0
            ? t("{items}: 쿼리 한 번에 읽을 수 있는 {count}행까지만 내보냈습니다", {
                items: outcome.cut.join(", "),
                count: EXPORT_MAX_ROWS.toLocaleString(),
              })
            : null;
        if (mountedRef.current) {
          if (note !== null) {
            store.setInfo(note);
          }
          onClose();
        } else {
          store.setInfo(note ?? t("내보내기를 마쳤습니다: {file}", { file: outcome.name }));
        }
      } catch (err) {
        if (handle.signal.aborted) {
          return;
        }
        const message = errorOf(err, t("내보내기에 실패했습니다"));
        handle.fail(message);
        if (mountedRef.current) {
          setError(message);
          setJobId(null);
        } else {
          notifyError(message);
        }
      }
    })();
  }

  function stop(): void {
    if (jobId !== null) {
      cancelJob(jobId);
      setJobId(null);
    }
  }

  function renderItems() {
    const lower = query.trim().toLowerCase();
    const shown = lower === "" ? items : items.filter((item) => item.name.toLowerCase().includes(lower));
    const sql = format === "sql";
    const groups: { kind: ItemKind; label: string; items: Item[] }[] = [
      { kind: "table", label: t("테이블"), items: shown.filter((item) => item.kind === "table") },
      { kind: "view", label: t("뷰"), items: shown.filter((item) => item.kind === "view") },
    ];
    return (
      <div className={`export-items${sql ? " sql" : ""}`}>
        {groups
          .filter((group) => group.items.length > 0)
          .map((group) => {
            const names = group.items.map((item) => item.name);
            const on = names.filter((name) => checked.has(name)).length;
            return (
              <div className="export-group" key={group.kind}>
                <div className="export-item head">
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={on === names.length}
                      ref={(input) => {
                        if (input !== null) {
                          input.indeterminate = on > 0 && on < names.length;
                        }
                      }}
                      disabled={running || columnPick}
                      onChange={(event) => toggleChecked(names, event.target.checked)}
                    />
                    <span>{group.label}</span>
                    <span className="panel-count">{`${on} / ${names.length}`}</span>
                  </label>
                  {sql
                    ? FLAG_COLUMNS.map((column) => {
                        const all = group.items.every((item) => flagsOf(item)[column.key]);
                        return (
                          <label className="export-flag" key={column.key} title={t(column.label)}>
                            <span>{t(column.label)}</span>
                            <input
                              type="checkbox"
                              checked={all}
                              disabled={running}
                              onChange={(event) => setFlag(group.items, column.key, event.target.checked)}
                            />
                          </label>
                        );
                      })
                    : null}
                </div>
                {group.items.map((item) => {
                  const itemFlags = flagsOf(item);
                  return (
                    <div className="export-item" key={item.name}>
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={checked.has(item.name)}
                          disabled={running || columnPick}
                          onChange={(event) => toggleChecked([item.name], event.target.checked)}
                        />
                        <span className="mono export-item-name" title={item.name}>
                          {item.name}
                        </span>
                      </label>
                      {sql
                        ? FLAG_COLUMNS.map((column) => (
                            <label className="export-flag" key={column.key}>
                              <input
                                type="checkbox"
                                aria-label={`${item.name} ${t(column.label)}`}
                                checked={itemFlags[column.key]}
                                disabled={running}
                                onChange={(event) => setFlag([item], column.key, event.target.checked)}
                              />
                            </label>
                          ))
                        : null}
                    </div>
                  );
                })}
              </div>
            );
          })}
        {items.length === 0 ? <div className="panel-empty-inline">{t("테이블이 없습니다")}</div> : null}
      </div>
    );
  }

  function renderFields() {
    if (fields === null) {
      return <div className="panel-empty-inline">{t("필드를 불러오는 중…")}</div>;
    }
    return (
      <section className="export-section">
        <div className="section-title">
          {t("필드")}
          <span className="panel-count">{`${fields.length - fieldOff.size} / ${fields.length}`}</span>
          <span className="spacer" />
          <button type="button" className="link-button" disabled={running} onClick={() => setFieldOff(new Set())}>
            {t("모두 선택")}
          </button>
          <button
            type="button"
            className="link-button"
            disabled={running}
            onClick={() => setFieldOff(new Set(fields.map((_, index) => index)))}
          >
            {t("모두 해제")}
          </button>
        </div>
        <div className="export-fields">
          {fields.map((name, index) => (
            <label className="check-row" key={`${index}:${name}`}>
              <input
                type="checkbox"
                checked={!fieldOff.has(index)}
                disabled={running}
                onChange={(event) =>
                  setFieldOff((prev) => {
                    const next = new Set(prev);
                    if (event.target.checked) {
                      next.delete(index);
                    } else {
                      next.add(index);
                    }
                    return next;
                  })
                }
              />
              <span className="mono export-item-name" title={name}>
                {name}
              </span>
            </label>
          ))}
        </div>
      </section>
    );
  }

  function renderResultScope() {
    if (current === null) {
      return null;
    }
    const loadedLabel = dataTab
      ? t("현재 페이지 ({count}행)", { count: current.meta.rowCount.toLocaleString() })
      : t("로드된 행 ({count}행)", { count: current.meta.rowCount.toLocaleString() });
    const hasKey = (dataTab?.pkColumns ?? dataTab?.meta?.pk ?? current.meta.pk ?? []).length > 0;
    let allHelp: string;
    if (every) {
      allHelp = t("결과마다 SQL을 다시 실행해 최대 {count}행까지 씁니다. 데이터를 바꾸는 문장은 다시 실행하지 않고 로드된 행을 씁니다.", {
        count: EXPORT_MAX_ROWS.toLocaleString(),
      });
    } else if (dataTab !== null) {
      allHelp = hasKey
        ? t("필터·정렬을 적용해 키 순서로 나눠 읽으므로 행 수 제한이 없습니다")
        : t("키가 없어 한 번에 최대 {count}행까지 읽습니다", { count: EXPORT_MAX_ROWS.toLocaleString() });
    } else if (!current.meta.truncated) {
      allHelp = t("결과의 모든 행이 이미 로드되어 있습니다");
    } else if (currentRerun) {
      allHelp = t("SQL을 다시 실행해 최대 {count}행까지 씁니다", { count: EXPORT_MAX_ROWS.toLocaleString() });
    } else {
      allHelp = t("데이터를 바꾸는 문장은 다시 실행하지 않습니다");
    }
    return (
      <>
        {results.length > 1 ? (
          <section className="export-section">
            <div className="section-title">{t("결과")}</div>
            <label className="check-row">
              <input
                type="radio"
                name="export-which"
                checked={which === "current"}
                disabled={running}
                onChange={() => setWhich("current")}
              />
              <span>{t("현재 결과")}</span>
            </label>
            <label className="check-row">
              <input
                type="radio"
                name="export-which"
                checked={which === "every"}
                disabled={running}
                onChange={() => setWhich("every")}
              />
              <span>{t("모든 탭 결과 ({count}개)", { count: results.length })}</span>
            </label>
          </section>
        ) : null}
        <section className="export-section">
          <div className="section-title">{t("범위")}</div>
          <label className="check-row">
            <input
              type="radio"
              name="export-scope"
              checked={scope === "loaded"}
              disabled={running}
              onChange={() => setScope("loaded")}
            />
            <span>{every ? t("로드된 행") : loadedLabel}</span>
          </label>
          <label className="check-row">
            <input
              type="radio"
              name="export-scope"
              checked={scope === "all"}
              disabled={running || (!every && allDisabled)}
              onChange={() => setScope("all")}
            />
            <span>{dataTab && !every ? t("모든 행 (필터·정렬 적용)") : t("모든 행 (SQL 다시 실행)")}</span>
          </label>
          <p className="helper">{allHelp}</p>
        </section>
      </>
    );
  }

  function renderOptions() {
    if (format === "csv") {
      const set = (patch: Partial<CsvOptions>) => setCsv((prev) => ({ ...prev, ...patch }));
      return (
        <div className="export-options-grid">
          <label className="field">
            <span>{t("구분자")}</span>
            <Select value={csv.delimiter} disabled={running} onChange={(event) => set({ delimiter: event.target.value })}>
              <option value=",">{t("쉼표 (,)")}</option>
              <option value=";">{t("세미콜론 (;)")}</option>
              <option value={"\t"}>{t("탭")}</option>
              <option value="|">{t("파이프 (|)")}</option>
            </Select>
          </label>
          <label className="field">
            <span>{t("따옴표")}</span>
            <Select value={csv.quote} disabled={running} onChange={(event) => set({ quote: event.target.value })}>
              <option value={'"'}>{t('큰따옴표 (")')}</option>
              <option value="'">{t("작은따옴표 (')")}</option>
              <option value="">{t("없음")}</option>
            </Select>
          </label>
          <label className="field">
            <span>{t("줄바꿈")}</span>
            <Select value={csv.lineBreak} disabled={running} onChange={(event) => set({ lineBreak: event.target.value })}>
              <option value={"\r\n"}>CRLF (\r\n)</option>
              <option value={"\n"}>LF (\n)</option>
              <option value={"\r"}>CR (\r)</option>
            </Select>
          </label>
          <label className="field">
            <span>{t("소수점")}</span>
            <Select value={csv.decimal} disabled={running} onChange={(event) => set({ decimal: event.target.value })}>
              <option value=".">{t("마침표 (.)")}</option>
              <option value=",">{t("쉼표 (,)")}</option>
            </Select>
          </label>
          <div className="export-checks">
            <label className="check-row">
              <input
                type="checkbox"
                checked={csv.header}
                disabled={running}
                onChange={(event) => set({ header: event.target.checked })}
              />
              <span>{t("첫 줄에 필드 이름 쓰기")}</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={csv.nullAsEmpty !== false}
                disabled={running}
                onChange={(event) => set({ nullAsEmpty: event.target.checked })}
              />
              <span>{t("NULL을 빈 값으로")}</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={csv.lineBreakAsSpace === true}
                disabled={running}
                onChange={(event) => set({ lineBreakAsSpace: event.target.checked })}
              />
              <span>{t("값 안의 줄바꿈을 공백으로")}</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={csv.bom}
                disabled={running}
                onChange={(event) => set({ bom: event.target.checked })}
              />
              <span>{t("UTF-8 BOM (Excel에서 한글이 깨지지 않게)")}</span>
            </label>
          </div>
        </div>
      );
    }
    if (format === "json") {
      return <p className="helper">{t("행마다 필드 이름을 키로 하는 객체의 배열로 씁니다")}</p>;
    }
    if (format === "xlsx") {
      return (
        <p className="helper">
          {t("항목마다 .xlsx 파일 하나를 씁니다. 시트 하나에 1,048,576행이 넘으면 다음 시트로 이어집니다.")}
        </p>
      );
    }
    return (
      <div className="export-checks">
        {target.mode === "results" && !every ? (
          <label className="field">
            <span>{t("INSERT 대상 테이블")}</span>
            <input
              value={insertTable}
              disabled={running}
              spellCheck={false}
              onChange={(event) => setInsertTable(event.target.value)}
            />
          </label>
        ) : null}
        {target.mode === "tables" ? (
          <p className="helper">{t("항목마다 구조(CREATE), DROP, 데이터(INSERT)를 고릅니다. 모든 항목이 SQL 파일 하나에 들어갑니다.")}</p>
        ) : (
          <p className="helper">{t("행을 INSERT 문으로 씁니다. 모든 결과가 SQL 파일 하나에 들어갑니다.")}</p>
        )}
        <label className="check-row">
          <input
            type="checkbox"
            checked={gzip}
            disabled={running}
            onChange={(event) => setGzip(event.target.checked)}
          />
          <span>{t("Gzip으로 압축 (.sql.gz)")}</span>
        </label>
      </div>
    );
  }

  const progress = job !== null && job.status === "running" ? job : null;
  const percent =
    progress !== null && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : null;

  return (
    <div className="modal-backdrop" onClick={() => (running ? undefined : onClose())}>
      <div className="modal export-window" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{target.mode === "tables" ? t("테이블 내보내기") : t("결과 내보내기")}</span>
          <span className="modal-path">
            {target.mode === "tables" ? `${kind} · ${databaseName(meta)}` : target.title}
          </span>
        </div>
        <div className="export-format-tabs" role="tablist">
          <div className="segmented">
            {FORMATS.map((entry) => (
              <button
                type="button"
                role="tab"
                key={entry.value}
                aria-selected={format === entry.value}
                className={format === entry.value ? "active" : ""}
                disabled={running}
                onClick={() => setFormat(entry.value)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>
        <div className="export-panes">
          <div className="export-pane export-pick">
            {target.mode === "tables" ? (
              <>
                {columnPick ? (
                  <div className="section-title">
                    <span className="mono">{pickedTable}</span>
                  </div>
                ) : (
                  <div className="export-search">
                    <SearchIcon size={11} />
                    <input
                      value={query}
                      placeholder={t("테이블·뷰 검색")}
                      spellCheck={false}
                      disabled={running}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </div>
                )}
                {columnPick ? renderFields() : renderItems()}
              </>
            ) : (
              <>
                {renderResultScope()}
                {showFields ? renderFields() : null}
              </>
            )}
          </div>
          <div className="export-pane export-settings">
            <div className="section-title">{t("{format} 옵션", { format: FORMATS.find((entry) => entry.value === format)?.label ?? "" })}</div>
            {renderOptions()}
          </div>
        </div>
        <div className="export-file">
          <label className="field">
            <span>{t("파일 이름")}</span>
            <div className="export-file-name">
              <input
                value={base}
                disabled={running}
                spellCheck={false}
                onChange={(event) => setFileName(event.target.value)}
              />
              <span className="export-file-ext mono">{extension}</span>
            </div>
          </label>
          {many && format !== "sql" ? (
            <p className="helper">{t("브라우저는 폴더에 쓸 수 없어, 항목마다 파일 하나씩 담은 ZIP 하나로 내려받습니다")}</p>
          ) : null}
          {progress !== null ? (
            <div className="export-progress">
              <div className="job-bar">
                <div className="job-bar-fill" style={{ width: `${percent ?? 5}%` }} />
              </div>
              <span className="helper">
                {progress.detail}
                {progress.total > 0
                  ? ` — ${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}`
                  : ""}
              </span>
            </div>
          ) : null}
          {error ? (
            <ErrorNotice
              error={error}
              context="export"
              onFix={{
                "refresh-schema": () => {
                  // The failure was about the old list; the new one replaces it.
                  setError(null);
                  onRefreshSchema();
                },
              }}
            />
          ) : null}
          {problem !== null && !running ? <p className="helper">{problem}</p> : null}
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          {running ? (
            <>
              <button type="button" onClick={stop}>
                {t("중지")}
              </button>
              <button type="button" className="primary" onClick={onClose}>
                {t("백그라운드에서 계속")}
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={onClose}>
                {t("닫기")}
              </button>
              <button type="button" className="primary" disabled={problem !== null} onClick={start}>
                {t("내보내기")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
