import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  gridHeaderH,
  gridRowH,
  type CanvasGrid,
  type CellChoices,
  type GridEditHandlers,
  type GridSelection,
  type SelectedRows,
} from "../grid/CanvasGrid";
import { cellMenuItems, deleteRowsLabel } from "../grid/cellMenu";
import { formatCopy, type CopyFormat } from "../copyFormats";
import type { CellState, RowSource, RowState } from "../grid/rowSource";
import { t } from "../i18n";
import { CellInspector, type CellAnchor } from "./CellInspector";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { notifyError } from "./ErrorNotice";
import { TableGrid, type TableGridHandle } from "./TableGrid";

export type { CellChoices };

export interface GridColumn {
  header: string;
  // The cell's text; null shows NULL, as in the data grid.
  value(row: number): string | null;
  commit?(row: number, value: string): void;
  // The list under the editor, as TablePlus offers types and values.
  choices?(row: number): CellChoices | null;
  ink?(row: number): string | null;
  readOnly?(row: number): boolean;
  changed?(row: number): boolean;
  title?(row: number): string | undefined;
  // Whether clearing the cell (its menu's "set NULL") means something here.
  nullable?: boolean;
}

export interface GridFocus {
  row: number;
  col: number;
  // Bumped on every request so the same cell can be asked for twice.
  seq: number;
}

interface StructureGridProps {
  rowCount: number;
  columns: GridColumn[];
  rowState?(row: number): "inserted" | "deleted" | null;
  // Rows that can't be edited, such as one marked for deletion.
  rowReadOnly?(row: number): boolean;
  canDeleteRow?(row: number): boolean;
  onDeleteRows?(rows: number[]): void;
  // Opens the editor on a cell, e.g. the name of a row just added; the owner
  // clears it once handled, so a grid shown again doesn't reopen it.
  focus?: GridFocus | null;
  onFocusHandled?(): void;
  // Columns are sized to their contents again when this changes.
  fitKey?: unknown;
  // Fill the space it's given and scroll itself, as the Data tab's grid does,
  // instead of growing to its rows.
  fill?: boolean;
  // The picked rows (null for none), with the rows they're read from, for the
  // right panel.
  onSelect?(source: RowSource, rows: SelectedRows | null): void;
}

const MIN_COLUMN_W = 96;
// The canvas is as tall as the grid; very tall ones go blank (and cost a lot
// of memory), so past this height in device pixels the grid scrolls itself.
const MAX_CANVAS_PX = 8192;

function maxRowsShown(): number {
  const dpr = window.devicePixelRatio || 1;
  return Math.max(10, Math.floor((MAX_CANVAS_PX / dpr - gridHeaderH() - 1) / gridRowH()));
}

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}

// Rows read straight from the panel's draft; an update repaints the grid.
class DraftSource implements RowSource {
  columns: string[] = [];
  rowCount = 0;
  props: StructureGridProps | null = null;
  private readonly listeners = new Set<() => void>();

  update(props: StructureGridProps): void {
    this.props = props;
    this.columns = props.columns.map((column) => column.header);
    this.rowCount = props.rowCount;
    for (const listener of this.listeners) {
      listener();
    }
  }

  cell(row: number, col: number): unknown {
    return this.props?.columns[col]?.value(row) ?? null;
  }

  rowState(row: number): RowState {
    const props = this.props;
    if (props === null) {
      return null;
    }
    const state = props.rowState?.(row) ?? null;
    if (state !== null) {
      return state;
    }
    return props.columns.some((column) => column.changed?.(row) ?? false) ? "edited" : null;
  }

  cellState(row: number, col: number): CellState {
    return (this.props?.columns[col]?.changed?.(row) ?? false) ? "edited" : null;
  }

  cellInk(row: number, col: number): string | null {
    return this.props?.columns[col]?.ink?.(row) ?? null;
  }

  cellTitle(row: number, col: number): string | undefined {
    return this.props?.columns[col]?.title?.(row);
  }

  onUpdate(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    notifyError(t("클립보드에 복사하지 못했습니다"));
  }
}

// The Structure tab's columns and indexes on the shared TableGrid, sized to its
// rows (the panel scrolls). Selection, copy, editing, lists, the cell menu and
// Quick Look are the Data tab's own.
export function StructureGrid(props: StructureGridProps) {
  const tableRef = useRef<TableGridHandle | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  // Filled during the first render, so the grid starts with its columns.
  const sourceRef = useRef<DraftSource | null>(null);
  if (sourceRef.current === null) {
    sourceRef.current = new DraftSource();
    sourceRef.current.update(props);
  }
  const source = sourceRef.current;
  // Room under the last row for the sideways scrollbar, only while there is one.
  const [scrollbar, setScrollbar] = useState(0);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    row: number;
    col: number;
    selection: GridSelection;
  } | null>(null);
  const [quickLook, setQuickLook] = useState<{ row: number; col: number; anchor: CellAnchor | null } | null>(
    null,
  );

  // Every render carries the draft's latest rows into the grid.
  useLayoutEffect(() => {
    source.update(props);
  });

  useLayoutEffect(() => {
    tableRef.current?.grid()?.fitColumns(MIN_COLUMN_W);
  }, [props.fitKey]);

  // A grid that goes (another view, another tab) leaves nothing picked.
  useEffect(() => () => propsRef.current.onSelect?.(source, null), []);

  useEffect(() => {
    const focus = props.focus;
    if (focus) {
      tableRef.current?.beginEdit(focus.row, focus.col);
      props.onFocusHandled?.();
    }
    // Only a new request opens the editor, not a re-render.
  }, [props.focus?.seq]);

  function editableCell(row: number, col: number): boolean {
    const current = propsRef.current;
    const column = current.columns[col];
    return (
      column?.commit !== undefined &&
      !(column.readOnly?.(row) ?? false) &&
      !(current.rowReadOnly?.(row) ?? false)
    );
  }

  const editing: GridEditHandlers = {
    canEdit: editableCell,
    onCommit: (row, col, value) => propsRef.current.columns[col]?.commit?.(row, value ?? ""),
    choices: (row, col) => propsRef.current.columns[col]?.choices?.(row) ?? null,
  };

  function onReady(grid: CanvasGrid): () => void {
    grid.setLayoutListener(() => setScrollbar(grid.horizontalScrollbar()));
    // The page scrolls this grid, not the grid itself: keep the cursor's row
    // in view there as the arrow keys move it.
    grid.setKeyMoveListener((row) => {
      const panel = scrollParent(grid.hostElement());
      if (panel === null) {
        return;
      }
      const { top, bottom } = grid.rowBounds(row);
      const view = panel.getBoundingClientRect();
      if (top < view.top) {
        panel.scrollTop -= view.top - top;
      } else if (bottom > view.bottom) {
        panel.scrollTop += bottom - view.bottom;
      }
    });
    return () => {
      grid.setLayoutListener(null);
      grid.setKeyMoveListener(null);
    };
  }

  function menuItems(row: number, col: number, selection: GridSelection): ContextMenuItem[] {
    const current = propsRef.current;
    const column = current.columns[col];
    const editable = editableCell(row, col);
    const rowsOf = (cols: number[]): unknown[][] => {
      const rows: unknown[][] = [];
      for (let r = selection.r0; r <= selection.r1; r += 1) {
        rows.push(cols.map((c) => source.cell(r, c)));
      }
      return rows;
    };
    const copyAs = (cols: number[]) => (format: CopyFormat) =>
      void copyText(formatCopy(format, { columns: cols.map((c) => source.columns[c]), rows: rowsOf(cols) }, null));
    const allColumns = current.columns.map((_, index) => index);
    const selectedColumns = allColumns.slice(selection.c0, selection.c1 + 1);
    // Set Value covers the selected cells that can be changed, when every
    // selected column can be cleared.
    const targets: [number, number][] = [];
    for (let r = selection.r0; r <= selection.r1; r += 1) {
      for (const c of selectedColumns) {
        if (editableCell(r, c)) {
          targets.push([r, c]);
        }
      }
    }
    const items = cellMenuItems({
      column: column?.header ?? "",
      copySelection: () => tableRef.current?.copySelection(),
      copyText,
      copyRowsAs: copyAs(allColumns),
      copyCellsAs: copyAs(selectedColumns),
      quickLook: () => setQuickLook({ row, col, anchor: tableRef.current?.cellRect(row, col) ?? null }),
      edit: editable ? () => tableRef.current?.beginEdit(row, col) : undefined,
      setValue:
        targets.length > 0
          ? () => targets.forEach(([r, c]) => propsRef.current.columns[c]?.commit?.(r, ""))
          : undefined,
      nullable: selectedColumns.every((c) => current.columns[c]?.nullable === true),
      isNull: targets.every(([r, c]) => source.cell(r, c) === null),
    });
    // Whole columns take every row; Delete leaves them alone, as the key does.
    const rows: number[] = [];
    if (selection.mode !== "col") {
      for (let r = selection.r0; r <= selection.r1; r += 1) {
        if (current.canDeleteRow?.(r) ?? true) {
          rows.push(r);
        }
      }
    }
    if (current.onDeleteRows !== undefined && rows.length > 0) {
      const states = rows.map((r) => current.rowState?.(r) ?? null);
      const action = states.every((state) => state === "inserted")
        ? "cancel"
        : states.every((state) => state === "deleted")
          ? "undo"
          : "delete";
      items.push({
        label: deleteRowsLabel(rows.length, action),
        separatorBefore: true,
        onSelect: () => current.onDeleteRows?.(rows),
      });
    }
    return items;
  }

  const rows = Math.min(props.rowCount, maxRowsShown());
  const height = gridHeaderH() + rows * gridRowH() + 1 + scrollbar;
  return (
    <>
      <TableGrid
        ref={tableRef}
        className={props.fill ? "structure-grid fill" : "structure-grid"}
        style={props.fill ? undefined : { height }}
        source={source}
        editing={editing}
        onDeleteRows={(rows) => {
          const current = propsRef.current;
          const allowed = rows.filter((row) => current.canDeleteRow?.(row) ?? true);
          if (allowed.length > 0) {
            current.onDeleteRows?.(allowed);
          }
        }}
        onSelectionChange={(row, rows) => propsRef.current.onSelect?.(source, row === null ? null : rows)}
        onCellContextMenu={(row, col, x, y, selection) => setMenu({ x, y, row, col, selection })}
        onCellQuickLook={(row, col) =>
          setQuickLook({ row, col, anchor: tableRef.current?.cellRect(row, col) ?? null })
        }
        onReady={onReady}
      />
      {menu !== null ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.row, menu.col, menu.selection)}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {quickLook !== null ? (
        <CellInspector
          source={source}
          columns={source.columns}
          row={quickLook.row}
          col={quickLook.col}
          anchor={quickLook.anchor}
          table={null}
          onClose={() => {
            setQuickLook(null);
            tableRef.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}
