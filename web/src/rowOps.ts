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

// A float as it was meant, without the binary rounding tail a sum or a
// product leaves (271.40999999999997 → 271.41): fifteen significant digits,
// as many as any double carries faithfully. Whole numbers and huge values
// are left as they are, since rounding them would change their digits.
export function tidyNumberText(value: number): string {
  if (Number.isInteger(value) || !Number.isFinite(value) || Math.abs(value) >= 1e15) {
    return String(value);
  }
  return String(Number(value.toPrecision(15)));
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

// The Quick Filter: the rows whose column holds this value, or is
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
