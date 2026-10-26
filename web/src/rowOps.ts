import type { FilterState } from "./dataQuery";

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

// TablePlus's Quick Filter: the rows whose column holds this value, or is
// NULL. `isText`: the column holds text, so the value is always quoted.
export function quickFilterFor(column: string, value: unknown, isText: boolean): FilterState {
  const text = cellToString(value);
  return {
    rows: [
      {
        id: "quick",
        column,
        op: text === null ? "IS NULL" : "=",
        value: text ?? "",
        enabled: true,
        ...(isText ? { text: true } : {}),
      },
    ],
    logic: "AND",
  };
}
