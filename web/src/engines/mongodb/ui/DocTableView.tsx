// The ⊞ view of a collection tab (MONGODB.md §3.5): the page as a table on
// the app's canvas grid, object and array fields opened as child tables
// (`orders › items`), typed cell edits saved as dotted-path $set with the
// conflict guard, and the selected row in the app's detail panel. As on the
// SQL grid, a cell's and a header's right-click (or ⌥-click) open their
// menus, a middle-click or ⌘↩ shows the cell in Quick Look and Space opens
// the detail panel.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { writeClipboard } from "../../../clipboard";
import { columnWidthsKey } from "../../../columnWidths";
import { ContextMenu, type ContextMenuItem } from "../../../components/ContextMenu";
import { notifyError } from "../../../components/ErrorNotice";
import { PanelIcon } from "../../../components/icons";
import { TableGrid, type TableGridHandle } from "../../../components/TableGrid";
import type { GridEditHandlers, GridSelection, SelectedRows, SortIndicator } from "../../../grid/CanvasGrid";
import type { GridColumnSpec } from "../../../grid/columns";
import type { RowSource } from "../../../grid/rowSource";
import { phrase, phraseError, t } from "../../../i18n";
import { palette, type ValueKind } from "../../../palette";
import { getSettings } from "../../../settings";
import { Int32, deepEqual, isDocument, isNumber, typeName, type BsonDocument, type BsonTypeName, type BsonValue } from "../bson";
import { preview, toShell } from "../format";
import type { DocEdit } from "../guard";
import { buildTable, cellPath, cellValue, sortRows, type DocTable, type TableColumn, type TableRow } from "../table";
import { DocDetailPanel, TableDetail, useDetailSlot } from "./DocDetailPanel";
import { confirmTypeChange, copyDocsItem, copyPathItem, copyValueItems, docEditItems, filterItems, hideItem, plainText, sortItems, trimSeparators, useDocActions, useOnItemsChange, ValueQuickLook, type QuickLookTarget, type SortControl } from "./docMenus";
import { GridIcon } from "./icons";
import type { DocTableViewProps, SaveEdits } from "./types";
import { EDIT_TYPES, coerceInput, defaultOfType, editText } from "./valueEdit";
import { WriteErrorNotice } from "./writeErrors";
import "./panels.css";

// What a missing field shows, dimmed (a null shows NULL).
const MISSING = "—";

// The grid's type colours for BSON types.
const INK_KIND: Partial<Record<BsonTypeName, ValueKind>> = {
  String: "string",
  Int32: "integer",
  Int64: "bigint",
  Double: "float",
  Decimal128: "float",
  Boolean: "boolean",
  Date: "date",
  ObjectId: "uuid",
  Binary: "binary",
  Timestamp: "time",
  Regex: "enum",
  Code: "string",
};

// The table's cells for the canvas grid: scalars as their edit text,
// documents and arrays as a tag and a one-line preview.
class DocRowSource implements RowSource {
  readonly columns: string[];
  readonly rowCount: number;

  constructor(private readonly table: DocTable) {
    // The column of non-document array elements is labelled "값" by the table.
    this.columns = table.columns.map((c) => (c.kind === "value" ? t(c.label) : c.label));
    this.rowCount = table.rows.length;
  }

  value(row: number, col: number): BsonValue | undefined {
    const r = this.table.rows[row];
    const column = this.table.columns[col];
    return r && column ? cellValue(r, column) : undefined;
  }

  cell(row: number, col: number): unknown {
    const v = this.value(row, col);
    if (v === undefined) {
      return MISSING;
    }
    if (isDocument(v)) {
      return preview(v, 60).text;
    }
    if (Array.isArray(v)) {
      // Elements spelled out (documents with their leading fields), as far
      // as the cell shows.
      return v
        .slice(0, 4)
        .map((x) => (Array.isArray(x) || isDocument(x) ? preview(x, 40).text : toShell(x)))
        .join(", ");
    }
    return v === null ? null : editText(v);
  }

  cellInk(row: number, col: number): string | null {
    const v = this.value(row, col);
    if (v === undefined) {
      return palette.faint;
    }
    const column = this.table.columns[col];
    if (column.kind === "index" || Array.isArray(v) || isDocument(v)) {
      return palette.muted;
    }
    // _id columns take the grid's key colour from their spec.
    if (v === null || column.kind === "parentId" || (column.field === "_id" && this.table.path.length === 0) || !getSettings().typeColors) {
      return null;
    }
    const kind = INK_KIND[typeName(v)];
    return kind === undefined ? null : palette.typeInks[kind];
  }

  cellBadge(row: number, col: number): { text: string; ink: string } | null {
    const v = this.value(row, col);
    if (Array.isArray(v)) {
      return { text: `[${v.length}]`, ink: palette.typeInks.list };
    }
    return isDocument(v) ? { text: "{…}", ink: palette.typeInks.json } : null;
  }

  cellAlign(row: number, col: number): "left" | "right" | null {
    return isNumber(this.value(row, col)) ? "right" : null;
  }

  headerMark(col: number): string | null {
    return this.table.columns[col]?.drill ? "›" : null;
  }

  cellTitle(row: number, col: number): string | undefined {
    const r = this.table.rows[row];
    const column = this.table.columns[col];
    if (!r || !column) {
      return undefined;
    }
    const v = cellValue(r, column);
    const path = cellPath(r, column) ?? column.label;
    return v === undefined ? t("{path} — 필드 없음", { path }) : `${path} — ${typeName(v)}`;
  }
}

// The type a typed edit keeps: the cell's own, or for a missing or null
// cell the column's most common other type.
function editType(v: BsonValue | undefined, column: TableColumn): BsonTypeName {
  if (v !== undefined && v !== null) {
    return typeName(v);
  }
  return column.types.find((type) => type !== "Null") ?? "String";
}

interface CellError {
  // The value the input refused (text), or the failed save.
  error: unknown;
  left: number;
  top: number;
}

export function DocTableView({
  ns,
  docs,
  connKey,
  readOnly,
  sort,
  onSort,
  save,
  path,
  onPathChange,
  facts,
  typeLabel,
  onEditJson,
  onClone,
  onDelete,
}: DocTableViewProps) {
  const gridRef = useRef<TableGridHandle | null>(null);
  const slot = useDetailSlot();
  const actions = useDocActions();
  const pathKey = path.join("\u0000");
  // Drilled levels sort their rows here; the top level sorts on the server.
  const [localSort, setLocalSort] = useState<{ pathKey: string; column: string; dir: 1 | -1 } | null>(null);
  const [selection, setSelection] = useState<SelectedRows | null>(null);
  const [cellError, setCellError] = useState<CellError | null>(null);
  const cellErrorRef = useRef<HTMLDivElement | null>(null);
  // The cell to select again once the page comes back after a save.
  const restoreRef = useRef<GridSelection | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [look, setLook] = useState<QuickLookTarget | null>(null);

  const built = useMemo(() => buildTable(docs, path), [docs, pathKey]);
  const activeSort = localSort !== null && localSort.pathKey === pathKey && path.length > 0 ? localSort : null;
  const table = useMemo(() => {
    const column = activeSort === null ? undefined : built.columns.find((c) => c.id === activeSort.column);
    return activeSort === null || column === undefined ? built : sortRows(built, column, activeSort.dir);
  }, [built, activeSort?.column, activeSort?.dir]);
  const source = useMemo(() => new DocRowSource(table), [table]);
  // A menu or Quick Look belongs to the rows it was opened on: a reload (a
  // save, F5, another page), another level or another order can move or
  // drop its cell, so it closes, and its items no longer act.
  const generation = useRef(0);
  useOnItemsChange([pathKey, activeSort?.column, activeSort?.dir, ...docs], () => {
    generation.current += 1;
    setMenu(null);
    setLook(null);
  });

  // A menu whose items act only while its rows are still the ones shown;
  // otherwise they say so instead of acting on whatever moved into place.
  function openMenu(x: number, y: number, items: ContextMenuItem[]): void {
    const opened = generation.current;
    const guard = (list: ContextMenuItem[]): ContextMenuItem[] =>
      list.map((item) => ({
        ...item,
        submenu: item.submenu && guard(item.submenu),
        onSelect:
          item.onSelect &&
          (() => {
            if (generation.current !== opened) {
              notifyError(phraseError(phrase("문서가 다시 읽혀 이 칸이 옮겨졌거나 사라졌습니다. 메뉴를 다시 여세요.")), { context: "document" });
              return;
            }
            item.onSelect?.();
          }),
      }));
    setLook(null);
    setMenu({ x, y, items: guard(items) });
  }

  const specs = useMemo(
    () =>
      table.columns.map((c): GridColumnSpec | null =>
        c.kind === "parentId" || (c.field === "_id" && path.length === 0) ? { kind: "text", pk: true } : null,
      ),
    [table],
  );

  const sortIndicators = useMemo((): SortIndicator[] => {
    if (path.length > 0) {
      const index = activeSort === null ? -1 : table.columns.findIndex((c) => c.id === activeSort.column);
      return index < 0 || activeSort === null ? [] : [{ columnIndex: index, dir: activeSort.dir === 1 ? "asc" : "desc" }];
    }
    return [...(sort ?? [])].flatMap(([field, v]): SortIndicator[] => {
      const index = table.columns.findIndex((c) => c.kind === "field" && c.field === field);
      const dir = isNumber(v) ? Number(v.value) : 1;
      return index < 0 ? [] : [{ columnIndex: index, dir: dir < 0 ? "desc" : "asc" }];
    });
  }, [table, sort, path.length, activeSort]);

  useLayoutEffect(() => {
    const keep = restoreRef.current;
    restoreRef.current = null;
    if (keep === null || keep.r1 >= source.rowCount || keep.c0 >= source.columns.length) {
      return;
    }
    if (keep.mode === "row") {
      gridRef.current?.selectRows(keep.r0, keep.r1);
    } else {
      gridRef.current?.selectCell(keep.r0, keep.c0);
    }
  }, [source]);

  // A rejected edit's notice goes with the next click outside it.
  useEffect(() => {
    if (cellError === null) {
      return;
    }
    const dismiss = (event: PointerEvent): void => {
      if (!(event.target instanceof Node && cellErrorRef.current?.contains(event.target))) {
        setCellError(null);
      }
    };
    window.addEventListener("pointerdown", dismiss, true);
    return () => window.removeEventListener("pointerdown", dismiss, true);
  }, [cellError]);

  function drillTo(next: string[]): void {
    setCellError(null);
    setSelection(null);
    onPathChange(next);
  }

  function onHeaderClick(index: number, event: { shiftKey: boolean }): void {
    const column = table.columns[index];
    if (!column) {
      return;
    }
    if (column.drill && column.field !== null) {
      drillTo([...path, column.field]);
      return;
    }
    if (path.length > 0) {
      // None → ascending → descending → none, as the top level does.
      const cur = activeSort?.column === column.id ? activeSort.dir : 0;
      setLocalSort(cur === -1 ? null : { pathKey, column: column.id, dir: cur === 1 ? -1 : 1 });
      return;
    }
    if (column.field === null) {
      return;
    }
    const field = column.field;
    const current = sort ?? new Map<string, BsonValue>();
    const old = current.get(field);
    const was = isNumber(old) ? Number(old.value) : 0;
    const dir = was === 0 ? 1 : was > 0 ? -1 : 0;
    // Shift adds to the sort; a plain click sorts by this field alone.
    const next: BsonDocument = new Map();
    if (event.shiftKey) {
      for (const [key, v] of current) {
        if (key !== field) {
          next.set(key, v);
        }
      }
    }
    if (dir !== 0) {
      next.set(field, new Int32(dir));
    }
    onSort(next.size === 0 ? null : next);
  }

  function onCellClick(row: number, col: number): void {
    const column = table.columns[col];
    const v = source.value(row, col);
    if (column?.kind === "field" && column.field !== null && (Array.isArray(v) || isDocument(v))) {
      drillTo([...path, column.field]);
    }
  }

  function showError(row: number, col: number, error: unknown): void {
    const rect = gridRef.current?.cellRect(row, col);
    if (rect) {
      setCellError({ error, left: rect.left, top: rect.bottom + 2 });
    } else {
      notifyError(error, { context: "document" });
    }
  }

  async function commitCell(row: number, col: number, text: string | null): Promise<void> {
    const r = table.rows[row];
    const column = table.columns[col];
    const target = r && column ? cellPath(r, column) : null;
    if (!r || !column || target === null) {
      return;
    }
    const v = cellValue(r, column);
    if (v === undefined && (text === null || text === "")) {
      return;
    }
    let value: BsonValue = null;
    if (text !== null) {
      const coerced = coerceInput(text, editType(v, column));
      if ("error" in coerced) {
        showError(row, col, phraseError(coerced.error));
        return;
      }
      value = coerced.value;
    }
    if (v !== undefined && deepEqual(v, value)) {
      return;
    }
    await applyEdit(row, col, v === undefined ? { op: "add", path: target, value } : { op: "set", path: target, value });
  }

  // One edit of a row's document; a refusal shows at the cell.
  async function applyEdit(row: number, col: number, edit: DocEdit): Promise<void> {
    const r = table.rows[row];
    if (!r) {
      return;
    }
    const failure = await keptSave(table.docs[r.doc], [edit]);
    if (failure !== null) {
      showError(row, col, failure);
    }
  }

  // A save reloads the page: the view and the selection stay where they are.
  const keptSave: SaveEdits = async (original, edits) => {
    const grid = gridRef.current;
    grid?.keepViewOnNextSource("all");
    restoreRef.current = grid?.selection() ?? null;
    const message = await save(original, edits);
    if (message !== null) {
      restoreRef.current = null;
    }
    return message;
  };

  // A cell's dotted path in its document with array positions (what Quick
  // Look names and an edit writes), or null for the position column.
  function fieldPathOf(row: TableRow, column: TableColumn): string | null {
    switch (column.kind) {
      case "field":
        return column.field === null ? null : row.base === "" ? column.field : `${row.base}.${column.field}`;
      case "value":
        return row.base;
      case "parentId":
        return "_id";
      case "index":
        return null;
    }
  }

  // A column's path for queries (`items.sku` in `orders › items`), or null
  // for the position column.
  function columnPath(column: TableColumn): string | null {
    switch (column.kind) {
      case "field":
        return column.field === null ? null : [...path, column.field].join(".");
      case "value":
        return path.join(".");
      case "parentId":
        return "_id";
      case "index":
        return null;
    }
  }

  // The sort a column's menu shows: the query's at the top level (by this
  // field alone, as a plain header click), the drilled table's own below.
  function columnSort(column: TableColumn): SortControl | null {
    if (path.length > 0) {
      return {
        dir: activeSort?.column === column.id ? activeSort.dir : null,
        set: (dir) => setLocalSort(dir === null ? null : { pathKey, column: column.id, dir }),
      };
    }
    const field = column.field;
    if (column.kind !== "field" || field === null) {
      return null;
    }
    const current = sort?.get(field);
    return {
      dir: isNumber(current) ? (Number(current.value) < 0 ? -1 : 1) : null,
      set: (dir) => {
        if (dir !== null) {
          onSort(new Map<string, BsonValue>([[field, new Int32(dir)]]));
          return;
        }
        const rest: BsonDocument = new Map([...(sort ?? [])].filter(([key]) => key !== field));
        onSort(rest.size === 0 ? null : rest);
      },
    };
  }

  function quickLook(row: number, col: number): void {
    const r = table.rows[row];
    const column = table.columns[col];
    const v = source.value(row, col);
    if (!r || !column || v === undefined) {
      return;
    }
    setMenu(null);
    setLook({ name: fieldPathOf(r, column) ?? source.columns[col], value: v, position: row, anchor: gridRef.current?.cellRect(row, col) ?? null });
  }

  // The cell menu, in the SQL grid's order: copy, look, edit, then the
  // query and the document. Copy and 문서 복사 take the whole selection;
  // the rest acts on the cell clicked.
  function openCellMenu(row: number, col: number, x: number, y: number, selection: GridSelection): void {
    const r = table.rows[row];
    const column = table.columns[col];
    if (!r || !column) {
      return;
    }
    const v = source.value(row, col);
    const root = table.docs[r.doc];
    const target = cellPath(r, column);
    const at = fieldPathOf(r, column);
    const container = Array.isArray(v) || isDocument(v);
    const picked = selection.mode === "col" ? [r.doc] : [...new Set(table.rows.slice(selection.r0, selection.r1 + 1).map((entry) => entry.doc))];
    const items: ContextMenuItem[] = [{ label: t("복사"), onSelect: () => gridRef.current?.copySelection() }];
    if (v !== undefined) {
      items.push(...copyValueItems(v, actions.json));
    }
    if (at !== null) {
      items.push(copyPathItem(at));
    }
    items.push(copyDocsItem(picked.map((i) => table.docs[i]), actions.json));
    items.push({ label: "Quick Look", separatorBefore: true, disabled: v === undefined, onSelect: () => quickLook(row, col) });
    items.push({ label: t("행 상세 보기"), onSelect: () => slot.setOpen(true) });
    const field = column.field;
    if (container && column.kind === "field" && field !== null) {
      items.push({ label: t("하위 표로 열기"), onSelect: () => drillTo([...path, field]) });
    }
    if (!readOnly && target !== null) {
      const set = (value: BsonValue) => void applyEdit(row, col, v === undefined ? { op: "add", path: target, value } : { op: "set", path: target, value });
      const type = editType(v, column);
      const values: ContextMenuItem[] = [];
      if (type === "String") {
        values.push({ label: "EMPTY", disabled: v === "", onSelect: () => set("") });
      }
      values.push({ label: "null", disabled: v === null, onSelect: () => set(null) });
      if (type === "Date") {
        values.push({ label: "new Date()", onSelect: () => set(defaultOfType("Date")) });
      }
      items.push({ label: t("이 셀 편집"), separatorBefore: true, disabled: container, onSelect: () => gridRef.current?.beginEdit(row, col) });
      if (v !== undefined) {
        const current = typeName(v);
        items.push({
          label: t("타입 바꾸기"),
          submenu: EDIT_TYPES.map((name) => ({
            label: name,
            checked: current === name,
            // A conversion that loses part of the value asks first.
            onSelect: () => {
              if (current !== name) {
                void confirmTypeChange(at ?? target, v, name).then((next) => next !== undefined && set(next));
              }
            },
          })),
        });
      }
      items.push({ label: t("값 설정"), submenu: values });
      if (v !== undefined && column.kind === "field") {
        items.push({ label: t("필드 지우기 ($unset)"), danger: true, onSelect: () => void applyEdit(row, col, { op: "unset", path: target }) });
      }
    }
    const queryField = columnPath(column);
    if (queryField !== null) {
      items.push(...filterItems(actions, queryField, v));
    }
    items.push(...sortItems(columnSort(column)));
    if (!readOnly && root.has("_id")) {
      items.push(
        ...docEditItems({
          onEdit: onEditJson && (() => onEditJson(root)),
          onClone: onClone && (() => onClone(root)),
          onDelete: onDelete && (() => onDelete(root)),
        }),
      );
    }
    openMenu(x, y, items);
  }

  // A header's menu: sort, open, copy the path or every value, filter by
  // presence, hide.
  function openHeaderMenu(col: number, x: number, y: number): void {
    const column = table.columns[col];
    if (!column) {
      return;
    }
    const queryField = columnPath(column);
    const items: ContextMenuItem[] = [...sortItems(columnSort(column))];
    const field = column.field;
    if (column.drill && field !== null) {
      items.push({ label: t("하위 표로 열기"), separatorBefore: true, onSelect: () => drillTo([...path, field]) });
    }
    if (queryField !== null) {
      items.push({ ...copyPathItem(queryField), separatorBefore: true });
    }
    items.push({
      label: t("열 값 전체 복사"),
      separatorBefore: queryField === null,
      onSelect: () => {
        const lines = table.rows.map((entry) => {
          const v = cellValue(entry, column);
          return v === undefined ? "" : Array.isArray(v) || isDocument(v) ? toShell(v) : plainText(v);
        });
        void writeClipboard(lines.join("\n"));
      },
    });
    if (queryField !== null && column.kind !== "parentId") {
      items.push(...filterItems(actions, queryField, undefined));
    }
    if (queryField !== null && column.kind === "field") {
      items.push(...hideItem(actions, queryField));
    }
    openMenu(x, y, trimSeparators(items));
  }

  const editing: GridEditHandlers | null = readOnly
    ? null
    : {
        canEdit: (row, col) => {
          const r = table.rows[row];
          const column = table.columns[col];
          const v = source.value(row, col);
          return r !== undefined && column !== undefined && cellPath(r, column) !== null && !Array.isArray(v) && !isDocument(v);
        },
        editText: (row, col) => editText(source.value(row, col)),
        choices: (row, col) => {
          const column = table.columns[col];
          return column && editType(source.value(row, col), column) === "Boolean" ? { options: ["true", "false"] } : null;
        },
        onCommit: (row, col, text) => {
          void commitCell(row, col, text);
        },
      };

  const widthsKey = columnWidthsKey(connKey, [`${ns.db}.${ns.coll}`, ...path].join(" › "));
  const empty = table.rows.length === 0;

  return (
    <div className="mg-tablewrap">
      <div className="mg-tablemain">
        <div className="mg-crumbs">
          <span className="mg-crumb-icon" aria-hidden="true">
            <GridIcon size={10} />
          </span>
          <nav className="mg-crumb-list" aria-label={t("표 경로")}>
            {[ns.coll, ...path].map((label, depth) => (
              <span key={depth} className="mg-crumb-step">
                {depth > 0 ? <span className="mg-crumb-sep">›</span> : null}
                <button
                  type="button"
                  className={`mg-crumb${depth === path.length ? " current" : ""}`}
                  disabled={depth === path.length}
                  aria-current={depth === path.length ? "location" : undefined}
                  onClick={() => drillTo(path.slice(0, depth))}
                >
                  {label}
                </button>
              </span>
            ))}
          </nav>
          <span className="spacer" />
          <span className="panel-dim mg-crumb-hint">
            {path.length > 0
              ? t("문서 {docs}개에서 {rows}행", { docs: docs.length.toLocaleString(), rows: table.rows.length.toLocaleString() })
              : t("{…}·[n] 셀이나 › 머리글을 누르면 그 필드를 표로 엽니다")}
          </span>
          <button
            type="button"
            className={`icon-button mg-panel-toggle${slot.open ? " active" : ""}`}
            title={t("행 상세 패널 (⌘I)")}
            aria-label={t("행 상세 패널")}
            aria-pressed={slot.open}
            onClick={() => slot.setOpen(!slot.open)}
          >
            <PanelIcon size={12} />
          </button>
        </div>
        <div className="mg-gridbox">
          <TableGrid
            ref={gridRef}
            source={source}
            widthsKey={widthsKey}
            specs={specs}
            editing={editing}
            sortColumns={sortIndicators}
            onHeaderClick={onHeaderClick}
            onCellClick={onCellClick}
            onSelectionChange={(_row, rows) => {
              setSelection(rows);
              setCellError(null);
            }}
            onCellContextMenu={openCellMenu}
            onHeaderContextMenu={openHeaderMenu}
            onCellQuickLook={quickLook}
            onQuickLook={() => slot.setOpen(true)}
          />
          {empty ? (
            <div className="panel-empty mg-grid-empty">
              {path.length > 0 ? t("이 페이지에는 {path} 값이 있는 문서가 없습니다", { path: path.join(".") }) : t("조건에 맞는 문서가 없습니다")}
            </div>
          ) : null}
        </div>
      </div>
      <DocDetailPanel>{(query) => <TableDetail ns={ns} table={table} rows={selection} readOnly={readOnly} save={keptSave} facts={facts} typeLabel={typeLabel} query={query} />}</DocDetailPanel>
      {cellError !== null ? (
        <div ref={cellErrorRef} className="mg-edit-error" style={{ left: cellError.left, top: cellError.top }}>
          <WriteErrorNotice error={cellError.error} onClose={() => setCellError(null)} />
        </div>
      ) : null}
      {menu !== null ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} /> : null}
      {look !== null ? (
        <ValueQuickLook
          target={look}
          where={ns.coll}
          onClose={() => {
            setLook(null);
            gridRef.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
