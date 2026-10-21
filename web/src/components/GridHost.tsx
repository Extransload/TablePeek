import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { CanvasGrid, type SelectedRows, type SortIndicator } from "../grid/CanvasGrid";
import { store, type GridResult } from "../store";

export interface GridHostHandle {
  beginEdit(row: number, col: number): void;
  focus(): void;
  keepViewOnNextResult(): void;
  selectCell(row: number, col: number): void;
  cellRect(row: number, col: number): { left: number; top: number; right: number; bottom: number } | null;
}

interface GridHostProps {
  result: GridResult | null;
  sortColumns?: SortIndicator[];
  onHeaderClick?(columnIndex: number, event: { shiftKey: boolean }): void;
  onSelectionChange?(row: number | null, rows: SelectedRows | null): void;
  onCellContextMenu?(row: number, col: number, x: number, y: number): void;
  onDeleteRows?(rows: number[]): void;
  onQuickLook?(row: number): void;
  onCellQuickLook?(row: number, col: number): void;
  themeKey?: string;
}

export const GridHost = forwardRef<GridHostHandle, GridHostProps>(function GridHost(
  {
    result,
    sortColumns,
    onHeaderClick,
    onSelectionChange,
    onCellContextMenu,
    onDeleteRows,
    onQuickLook,
    onCellQuickLook,
    themeKey,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<CanvasGrid | null>(null);
  const headerClickRef = useRef(onHeaderClick);
  const selectionRef = useRef(onSelectionChange);
  const contextMenuRef = useRef(onCellContextMenu);
  const deleteRowsRef = useRef(onDeleteRows);
  const quickLookRef = useRef(onQuickLook);
  const cellQuickLookRef = useRef(onCellQuickLook);

  headerClickRef.current = onHeaderClick;
  selectionRef.current = onSelectionChange;
  contextMenuRef.current = onCellContextMenu;
  deleteRowsRef.current = onDeleteRows;
  quickLookRef.current = onQuickLook;
  cellQuickLookRef.current = onCellQuickLook;

  const hasHeaderClick = onHeaderClick !== undefined;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const grid = new CanvasGrid(host);
    gridRef.current = grid;
    grid.setSelectionListener((row, rows) => {
      selectionRef.current?.(row, rows);
    });
    grid.setCellContextMenuHandler((row, col, x, y) => {
      contextMenuRef.current?.(row, col, x, y);
    });
    grid.setQuickLookHandler((row) => {
      quickLookRef.current?.(row);
    });
    grid.setCellQuickLookHandler((row, col) => {
      cellQuickLookRef.current?.(row, col);
    });
    const onTheme = (): void => {
      grid.refreshTheme();
    };
    window.addEventListener("tablepeek:theme", onTheme);
    return () => {
      window.removeEventListener("tablepeek:theme", onTheme);
      gridRef.current = null;
      grid.destroy();
    };
  }, []);

  useEffect(() => {
    gridRef.current?.setHeaderClickHandler(
      hasHeaderClick
        ? (columnIndex, event) => {
            headerClickRef.current?.(columnIndex, event);
          }
        : null,
    );
  }, [hasHeaderClick]);

  useEffect(() => {
    gridRef.current?.refreshTheme();
  }, [themeKey]);

  const sortsKey = JSON.stringify(sortColumns ?? null);

  useEffect(() => {
    gridRef.current?.setSortColumns(sortColumns ?? null);
  }, [sortsKey]);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) {
      return;
    }
    grid.setSource(result ? result.source : null);
    const meta = result ? result.meta : null;
    const columns = meta ? meta.columns : [];
    const pk = meta ? meta.pk : null;
    const keyed = pk !== null && pk.length > 0 && pk.every((name) => columns.includes(name));
    if (result !== null && meta !== null && meta.sourceTable !== null) {
      const source = result.source;
      // Rows staged for insert are editable even when the table has no primary key;
      // nothing is editable while a run or an apply could replace this result.
      grid.setEditable({
        canEdit: (row) => {
          const current = store.getState();
          const busy =
            store.isApplying() || (current.status === "running" && current.connId === result.conn);
          return !busy && !source.isDeleted(row) && (keyed || source.isInserted(row));
        },
        onCommit: (row, col, value) => {
          void store.editCell(row, col, value);
        },
      });
      grid.setDeleteRowsHandler((rows) => {
        deleteRowsRef.current?.(rows);
      });
    } else {
      grid.setEditable(null);
      grid.setDeleteRowsHandler(null);
    }
    return () => {
      grid.setEditable(null);
      grid.setDeleteRowsHandler(null);
    };
  }, [result]);

  useImperativeHandle(
    ref,
    () => ({
      beginEdit(row: number, col: number): void {
        gridRef.current?.beginEdit(row, col);
      },
      focus(): void {
        gridRef.current?.focus();
      },
      keepViewOnNextResult(): void {
        gridRef.current?.keepViewOnNextSource();
      },
      selectCell(row: number, col: number): void {
        gridRef.current?.selectCell(row, col);
      },
      cellRect(row: number, col: number) {
        return gridRef.current?.cellRect(row, col) ?? null;
      },
    }),
    [],
  );

  return <div className="grid-host" ref={hostRef} />;
});
