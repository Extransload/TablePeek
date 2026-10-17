export interface RowSource {
  readonly columns: string[];
  readonly rowCount: number;
  cell(row: number, col: number): unknown;
  onUpdate?(listener: () => void): () => void;
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
