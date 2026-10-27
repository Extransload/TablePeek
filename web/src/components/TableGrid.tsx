import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  CanvasGrid,
  type GridEditHandlers,
  type GridSelection,
  type SelectedRows,
  type SortIndicator,
} from "../grid/CanvasGrid";
import { isDateKind, type GridColumnSpec } from "../grid/columns";
import type { RowSource } from "../grid/rowSource";
import { DatePicker } from "./DatePicker";

export interface TableGridHandle {
  beginEdit(row: number, col: number): void;
  focus(): void;
  keepViewOnNextSource(scope?: "all" | "columns" | null): void;
  selectCell(row: number, col: number): void;
  selectRows(from: number, to: number): void;
  selection(): GridSelection | null;
  // ⌘C's copy of the selection.
  copySelection(): void;
  cellRect(row: number, col: number): { left: number; top: number; right: number; bottom: number } | null;
  // The grid itself, for what only one view needs (sizing to its rows, …).
  grid(): CanvasGrid | null;
}

export interface TableGridProps {
  source: RowSource | null;
  // No source yet because rows are on their way: the last ones drawn stay a
  // moment, so switching tables doesn't flash an empty grid.
  awaitingRows?: boolean;
  specs?: (GridColumnSpec | null)[] | null;
  // null or absent: read-only.
  editing?: GridEditHandlers | null;
  sortColumns?: SortIndicator[];
  onHeaderClick?(columnIndex: number, event: { shiftKey: boolean }): void;
  onSelectionChange?(row: number | null, rows: SelectedRows | null): void;
  // `selection`: what the menu acts on, the clicked cell inside it.
  onCellContextMenu?(row: number, col: number, x: number, y: number, selection: GridSelection): void;
  onDeleteRows?(rows: number[]): void;
  // Rows pasted over whole selected rows, a field per column; absent, they
  // paste over the cells as any other paste does.
  onPasteRows?(rows: string[][]): void;
  onQuickLook?(row: number): void;
  onCellQuickLook?(row: number, col: number): void;
  // The → of a foreign key cell.
  onLink?(row: number, col: number): void;
  // Called once with the new grid, for wiring a view adds of its own.
  onReady?(grid: CanvasGrid): () => void;
  themeKey?: string;
  className?: string;
  style?: CSSProperties;
}

interface PickerState {
  row: number;
  col: number;
  spec: GridColumnSpec;
  value: unknown;
  anchor: { left: number; top: number; right: number; bottom: number };
}

// The one table every view shows: the Data tab's results and the Structure
// tab's columns and indexes alike. Selection, copy, editing, the cell buttons
// (⌃⌄ lists and date pickers, → foreign keys), ellipsis and the menus behave
// the same wherever it appears; a view only supplies rows, column specs and
// what an edit does.
export const TableGrid = forwardRef<TableGridHandle, TableGridProps>(function TableGrid(props, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<CanvasGrid | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [picker, setPicker] = useState<PickerState | null>(null);

  // A layout effect, so a view's own layout effects find the grid in place.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }
    const grid = new CanvasGrid(host);
    gridRef.current = grid;
    grid.setSelectionListener((row, rows) => propsRef.current.onSelectionChange?.(row, rows));
    grid.setCellContextMenuHandler((row, col, x, y, selection) =>
      propsRef.current.onCellContextMenu?.(row, col, x, y, selection),
    );
    grid.setQuickLookHandler((row) => propsRef.current.onQuickLook?.(row));
    grid.setCellQuickLookHandler((row, col) => propsRef.current.onCellQuickLook?.(row, col));
    grid.setAccessoryHandler((kind, row, col) => {
      if (kind === "link") {
        propsRef.current.onLink?.(row, col);
        return;
      }
      const spec = propsRef.current.specs?.[col] ?? null;
      const anchor = grid.cellRect(row, col);
      if (spec === null || !isDateKind(spec.kind) || anchor === null) {
        return;
      }
      setPicker({ row, col, spec, value: grid.sourceCell(row, col), anchor });
    });
    const onTheme = (): void => grid.refreshTheme();
    window.addEventListener("tablepeek:theme", onTheme);
    const undo = propsRef.current.onReady?.(grid);
    return () => {
      undo?.();
      window.removeEventListener("tablepeek:theme", onTheme);
      gridRef.current = null;
      grid.destroy();
    };
  }, []);

  useLayoutEffect(() => {
    gridRef.current?.setColumnSpecs(props.specs ?? null);
  }, [props.specs]);

  const editable = props.editing !== null && props.editing !== undefined;
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (grid === null) {
      return;
    }
    // The latest handlers are read at call time, so a new render's closures
    // apply without rebuilding the grid's editing state.
    grid.setEditable(
      editable
        ? {
            canEdit: (row, col) => propsRef.current.editing?.canEdit?.(row, col) ?? true,
            onCommit: (row, col, value) => propsRef.current.editing?.onCommit(row, col, value),
            onCancel: () => propsRef.current.editing?.onCancel?.(),
            choices: (row, col) => propsRef.current.editing?.choices?.(row, col) ?? null,
          }
        : null,
    );
    grid.setDeleteRowsHandler(
      editable ? (rows) => propsRef.current.onDeleteRows?.(rows) : null,
    );
    grid.setPasteRowsHandler(
      editable && propsRef.current.onPasteRows !== undefined
        ? (rows) => propsRef.current.onPasteRows?.(rows)
        : null,
    );
  }, [editable, props.source]);

  // After the specs and the editing handlers, so the first fit of a new
  // source's columns leaves room for the cell buttons they bring.
  useLayoutEffect(() => {
    gridRef.current?.setSource(props.source, props.awaitingRows === true);
    // A picker opened on the old rows must not write into the new ones.
    setPicker(null);
  }, [props.source]);

  // Rows awaited that won't come (the load failed or was stopped): the held
  // frame of the previous ones goes.
  useLayoutEffect(() => {
    if (props.awaitingRows !== true) {
      gridRef.current?.endHold();
    }
  }, [props.awaitingRows]);

  // The picker doesn't follow its cell: scrolling the grid closes it.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (picker === null || host === null) {
      return;
    }
    const close = (): void => setPicker(null);
    host.addEventListener("scroll", close, true);
    return () => host.removeEventListener("scroll", close, true);
  }, [picker]);

  const hasHeaderClick = props.onHeaderClick !== undefined;
  useLayoutEffect(() => {
    gridRef.current?.setHeaderClickHandler(
      hasHeaderClick ? (columnIndex, event) => propsRef.current.onHeaderClick?.(columnIndex, event) : null,
    );
  }, [hasHeaderClick]);

  const sortsKey = JSON.stringify(props.sortColumns ?? null);
  useLayoutEffect(() => {
    gridRef.current?.setSortColumns(props.sortColumns ?? null);
  }, [sortsKey]);

  useLayoutEffect(() => {
    gridRef.current?.refreshTheme();
  }, [props.themeKey]);

  useImperativeHandle(
    ref,
    () => ({
      beginEdit: (row, col) => gridRef.current?.beginEdit(row, col),
      focus: () => gridRef.current?.focus(),
      keepViewOnNextSource: (scope) => gridRef.current?.keepViewOnNextSource(scope),
      selectCell: (row, col) => gridRef.current?.selectCell(row, col),
      selectRows: (from, to) => gridRef.current?.selectRows(from, to),
      selection: () => gridRef.current?.selection() ?? null,
      copySelection: () => gridRef.current?.copySelection(),
      cellRect: (row, col) => gridRef.current?.cellRect(row, col) ?? null,
      grid: () => gridRef.current,
    }),
    [],
  );

  function closePicker(): void {
    setPicker(null);
    gridRef.current?.focus();
  }

  return (
    <>
      {/* "table-grid" marks every table, whichever view it belongs to. */}
      <div className={`${props.className ?? "grid-host"} table-grid`} style={props.style} ref={hostRef} />
      {picker !== null ? (
        <DatePicker
          kind={picker.spec.kind}
          value={picker.value}
          nullable={picker.spec.nullable ?? true}
          anchor={picker.anchor}
          onPick={(value) => {
            propsRef.current.editing?.onCommit(picker.row, picker.col, value);
            closePicker();
          }}
          onClose={closePicker}
        />
      ) : null}
    </>
  );
});
