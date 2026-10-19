export interface ParsedImport {
  columns: string[];
  rows: unknown[][];
}

export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const semicolons = (firstLine.match(/;/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  if (tabs > 0 && tabs >= commas && tabs >= semicolons) {
    return "\t";
  }
  if (semicolons > 0 && semicolons > commas) {
    return ";";
  }
  return ",";
}

export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let index = 0;
  const length = text.length;
  while (index < length) {
    const ch = text[index];
    if (inQuotes) {
      if (ch === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += ch;
      index += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      index += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      index += 1;
      continue;
    }
    field += ch;
    index += 1;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => !(entry.length === 1 && entry[0] === ""));
}

export function parseCsv(text: string, delimiter: string, header: boolean): ParsedImport {
  const grid = parseDelimited(text, delimiter);
  if (delimiter === "," && grid.length > 1) {
    const widths = grid.map((row) => row.length);
    const maxWidth = Math.max(...widths);
    const minWidth = Math.min(...widths);
    if (maxWidth === 1 && grid[0][0].includes("\t")) {
      return parseCsv(text, "\t", header);
    }
    if (minWidth === 0 && maxWidth > 0) {
      grid.splice(0, 1);
    }
  }
  const first = grid[0] ?? [];
  const columnCount = Math.max(...grid.map((row) => row.length), 0);
  if (header) {
    const columns = new Array<string>(columnCount);
    for (let c = 0; c < columnCount; c += 1) {
      columns[c] = (first[c] ?? `col${c + 1}`).trim() || `col${c + 1}`;
    }
    const rows = grid.slice(1).map((row) => {
      const values = new Array<unknown>(columnCount);
      for (let c = 0; c < columnCount; c += 1) {
        values[c] = row[c] ?? null;
      }
      return values;
    });
    return { columns, rows };
  }
  const columns = Array.from({ length: columnCount }, (_, c) => `col${c + 1}`);
  const rows = grid.map((row) => {
    const values = new Array<unknown>(columnCount);
    for (let c = 0; c < columnCount; c += 1) {
      values[c] = row[c] ?? null;
    }
    return values;
  });
  return { columns, rows };
}

export function parseJsonImport(text: string): ParsedImport {
  const data = JSON.parse(text) as unknown;
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return { columns: [], rows: [] };
    }
    if (Array.isArray(data[0])) {
      const grid = data as unknown[][];
      const columnCount = Math.max(...grid.map((row) => row.length), 0);
      const columns = Array.from({ length: columnCount }, (_, c) => `col${c + 1}`);
      return {
        columns,
        rows: grid.map((row) => {
          const values = new Array<unknown>(columnCount);
          for (let c = 0; c < columnCount; c += 1) {
            values[c] = row[c] ?? null;
          }
          return values;
        }),
      };
    }
    const columns: string[] = [];
    for (const item of data) {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        for (const key of Object.keys(item as Record<string, unknown>)) {
          if (!columns.includes(key)) {
            columns.push(key);
          }
        }
      }
    }
    const rows = (data as unknown[]).map((item) => {
      const record = (item ?? {}) as Record<string, unknown>;
      return columns.map((column) => {
        const value = record[column];
        if (value === undefined) {
          return null;
        }
        if (value !== null && typeof value === "object") {
          return JSON.stringify(value);
        }
        return value;
      });
    });
    return { columns, rows };
  }
  if (data !== null && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const columns = Object.keys(record);
    return {
      columns,
      rows: [
        columns.map((column) => {
          const value = record[column];
          if (value !== null && typeof value === "object") {
            return JSON.stringify(value);
          }
          return value ?? null;
        }),
      ],
    };
  }
  return { columns: [], rows: [] };
}
