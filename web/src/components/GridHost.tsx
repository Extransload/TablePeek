import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { CanvasGrid, type SortIndicator } from "../grid/CanvasGrid";
import { store, type GridResult } from "../store";

export interface GridHostHandle {
  beginEdit(row: number, col: number): void;
  focus(): void;
}

interface GridHostProps {
  result: GridResult | null;
  sortColumns?: SortIndicator[];
  onHeaderClick?(columnIndex: number, event: { shiftKey: boolean }): void;
  onSelectionChange?(row: number | null): void;
  onCellContextMenu?(row: number, col: number, x: number, y: number): void;
  onCellEdited?(row: number, col: number): void;
}

export const GridHost = forwardRef<GridHostHandle, GridHostProps>(function GridHost(
  {
    result,
    sortColumns,
    onHeaderClick,
    onSelectionChange,
    onCellContextMenu,
    onCellEdited,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<CanvasGrid | null>(null);
  const headerClickRef = useRef(onHeaderClick);
  const selectionRef = useRef(onSelectionChange);
  const contextMenuRef = useRef(onCellContextMenu);
  const editedRef = useRef(onCellEdited);

  headerClickRef.current = onHeaderClick;
  selectionRef.current = onSelectionChange;
  contextMenuRef.current = onCellContextMenu;
  editedRef.current = onCellEdited;

  const hasHeaderClick = onHeaderClick !== undefined;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const grid = new CanvasGrid(host);
    gridRef.current = grid;
    grid.setSelectionListener((row) => {
      selectionRef.current?.(row);
    });
    grid.setCellContextMenuHandler((row, col, x, y) => {
      contextMenuRef.current?.(row, col, x, y);
    });
    return () => {
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
    const canEdit =
      meta !== null &&
      meta.sourceTable !== null &&
      pk !== null &&
      pk.length > 0 &&
      pk.every((name) => columns.includes(name));
    if (canEdit) {
      grid.setEditable({
        onCommit: (row, col, value) => {
          void store.editCell(row, col, value).then((outcome) => {
            if (outcome !== null) {
              editedRef.current?.(outcome.row, outcome.col);
            }
          });
        },
      });
    } else {
      grid.setEditable(null);
    }
    return () => {
      grid.setEditable(null);
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
    }),
    [],
  );

  return <div className="grid-host" ref={hostRef} />;
});
