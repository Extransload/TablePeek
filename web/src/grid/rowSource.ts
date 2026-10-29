export type RowState = "inserted" | "deleted" | "edited" | null;
export type CellState = "edited" | "default" | null;

export interface RowSource {
  readonly columns: string[];
  readonly rowCount: number;
  cell(row: number, col: number): unknown;
  onUpdate?(listener: () => void): () => void;
  rowState?(row: number): RowState;
  cellState?(row: number, col: number): CellState;
  // The label of a value the database will write itself (DEFAULT, NOW()),
  // shown faint in the cell until the change is applied.
  cellExpr?(row: number, col: number): string | null;
  // A text colour in place of the value's type colour.
  cellInk?(row: number, col: number): string | null;
  // Shown as the tooltip while the pointer is over the cell.
  cellTitle?(row: number, col: number): string | undefined;
  // A short tag drawn as a pill before the value, in its own ink (a
  // document's `{…}`, an array's `[3]`).
  cellBadge?(row: number, col: number): { text: string; ink: string } | null;
  // Overrides where the text sits; numbers sit right by default.
  cellAlign?(row: number, col: number): "left" | "right" | null;
  // A faint mark after a column's name in the header (`›` on a column that
  // opens a child table).
  headerMark?(col: number): string | null;
}

export class JsonRowSource implements RowSource {
  readonly columns: string[];
  readonly rowCount: number;
  private readonly rows: unknown[][];

  constructor(columns: string[], rows: unknown[][]) {
    this.columns = columns;
    this.rows = rows;
    this.rowCount = rows.length;
  }

  cell(row: number, col: number): unknown {
    const r = this.rows[row];
    if (!r) {
      return null;
    }
    const v = r[col];
    return v === undefined ? null : v;
  }
}
