import type { FilterState } from "./dataQuery";

export interface ColumnValue {
  column: string;
  value: string | null;
}

export function cellToString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

export function buildPkPairs(
  columns: string[],
  pk: string[],
  values: unknown[],
): ColumnValue[] | null {
  if (pk.length === 0) {
    return null;
  }
  const pairs: ColumnValue[] = [];
  for (const name of pk) {
    const index = columns.indexOf(name);
    if (index < 0) {
      return null;
    }
    const value = values[index];
    if (value === undefined) {
      return null;
    }
    pairs.push({ column: name, value: cellToString(value) });
  }
  return pairs;
}

export function buildInsertValues(columns: string[], values: unknown[]): ColumnValue[] {
  return columns.map((column, index) => ({
    column,
    value: cellToString(values[index]),
  }));
}

export function fkFilterFor(column: string, value: unknown, id = "fk"): FilterState | null {
  const text = cellToString(value);
  if (text === null) {
    return null;
  }
  return {
    rows: [{ id, column, op: "=", value: text, enabled: true }],
    logic: "AND",
  };
}
