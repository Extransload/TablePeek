export type RowState = "inserted" | "deleted" | "edited" | null;
export type CellState = "edited" | "default" | null;

export interface RowSource {
  readonly columns: string[];
  readonly rowCount: number;
  cell(row: number, col: number): unknown;
  onUpdate?(listener: () => void): () => void;
  rowState?(row: number): RowState;
  cellState?(row: number, col: number): CellState;
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
