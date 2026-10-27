import { forwardRef, useImperativeHandle, useRef } from "react";
import type {
  CellChoices,
  GridEditHandlers,
  GridSelection,
  SelectedRows,
  SortIndicator,
} from "../grid/CanvasGrid";
import type { GridColumnSpec } from "../grid/columns";
import { store, type GridResult } from "../store";
import { TableGrid, type TableGridHandle } from "./TableGrid";

export interface GridHostHandle {
  beginEdit(row: number, col: number): void;
  focus(): void;
  // "columns": the rows will be sorted, paged or filtered (widths and the
  // sideways scroll stay); "all", the default: the same rows read again;
  // null: the run asked for brought nothing, so the request is taken back.
  keepViewOnNextResult(scope?: "all" | "columns" | null): void;
  selectCell(row: number, col: number): void;
  selectRows(from: number, to: number): void;
  selection(): GridSelection | null;
  copySelection(): void;
  cellRect(row: number, col: number): { left: number; top: number; right: number; bottom: number } | null;
}

interface GridHostProps {
  result: GridResult | null;
  // No result yet because one is loading (see TableGrid).
  awaitingRows?: boolean;
  // What the table's structure says about each result column.
  specs?: (GridColumnSpec | null)[] | null;
  sortColumns?: SortIndicator[];
  onHeaderClick?(columnIndex: number, event: { shiftKey: boolean }): void;
  onSelectionChange?(row: number | null, rows: SelectedRows | null): void;
  onCellContextMenu?(row: number, col: number, x: number, y: number, selection: GridSelection): void;
  onDeleteRows?(rows: number[]): void;
  onPasteRows?(rows: string[][]): void;
  onQuickLook?(row: number): void;
  onCellQuickLook?(row: number, col: number): void;
  onLink?(row: number, col: number): void;
  themeKey?: string;
}

// "a,b" with b picked → "a"; with c picked → "a,b,c".
function toggleMember(text: string, option: string): string {
  const members = text
    .split(",")
    .map((member) => member.trim())
    .filter((member) => member !== "");
  const next = members.includes(option) ? members.filter((member) => member !== option) : [...members, option];
  return next.join(",");
}

// The Data tab's table: a query result on the shared TableGrid. Edits stage
// through the store; enum and boolean columns offer their values in a list.
export const GridHost = forwardRef<GridHostHandle, GridHostProps>(function GridHost(props, ref) {
  const { result, specs } = props;
  const tableRef = useRef<TableGridHandle | null>(null);

  let editing: GridEditHandlers | null = null;
  const meta = result?.meta ?? null;
  if (result !== null && meta !== null && meta.sourceTable !== null) {
    const source = result.source;
    const pk = meta.pk;
    const keyed = pk !== null && pk.length > 0 && pk.every((name) => meta.columns.includes(name));
    editing = {
      // Rows staged for insert are editable even when the table has no primary
      // key; nothing is editable while a run or an apply could replace this result.
      canEdit: (row) => {
        const current = store.getState();
        const busy = store.isApplying() || (current.status === "running" && current.connId === result.conn);
        return !busy && !source.isDeleted(row) && (keyed || source.isInserted(row));
      },
      onCommit: (row, col, value) => {
        // A list's NULL entry stands for the NULL value, not the text.
        const spec = specs?.[col] ?? null;
        const listed = spec !== null && (spec.kind === "enum" || spec.kind === "boolean");
        // A set with its last member taken off is the empty set, not NULL.
        const emptied = spec?.kind === "set" && value === null;
        void store.editCell(row, col, emptied ? "" : listed && value === "NULL" ? null : value);
      },
      choices: (_row, col): CellChoices | null => {
        const spec = specs?.[col] ?? null;
        if (spec === null || spec.options === undefined) {
          return null;
        }
        if (spec.kind === "set") {
          // A set holds several members: a pick adds or removes one.
          return { options: spec.options, query: () => "", pick: toggleMember };
        }
        if (spec.kind !== "enum" && spec.kind !== "boolean") {
          return null;
        }
        return { options: spec.nullable ? [...spec.options, "NULL"] : spec.options, strict: true };
      },
    };
  }

  useImperativeHandle(
    ref,
    () => ({
      beginEdit: (row, col) => tableRef.current?.beginEdit(row, col),
      focus: () => tableRef.current?.focus(),
      keepViewOnNextResult: (scope) => tableRef.current?.keepViewOnNextSource(scope),
      selectCell: (row, col) => tableRef.current?.selectCell(row, col),
      selectRows: (from, to) => tableRef.current?.selectRows(from, to),
      selection: () => tableRef.current?.selection() ?? null,
      copySelection: () => tableRef.current?.copySelection(),
      cellRect: (row, col) => tableRef.current?.cellRect(row, col) ?? null,
    }),
    [],
  );

  return (
    <TableGrid
      ref={tableRef}
      source={result?.source ?? null}
      awaitingRows={props.awaitingRows}
      specs={specs ?? null}
      editing={editing}
      sortColumns={props.sortColumns}
      onHeaderClick={props.onHeaderClick}
      onSelectionChange={props.onSelectionChange}
      onCellContextMenu={props.onCellContextMenu}
      onDeleteRows={props.onDeleteRows}
      onPasteRows={props.onPasteRows}
      onQuickLook={props.onQuickLook}
      onCellQuickLook={props.onCellQuickLook}
      onLink={props.onLink}
      themeKey={props.themeKey}
    />
  );
});
