export interface ParsedImport {
  columns: string[];
  rows: unknown[][];
  // Where each row came from, for errors: its first line in the file (CSV,
  // JSON Lines) or its place in the array (JSON), from 1.
  at: number[];
  unit: "line" | "record";
}

// The TextDecoder encodings worth offering for a data file.
export const IMPORT_ENCODINGS = ["utf-8", "euc-kr", "utf-16le", "windows-1252", "macintosh", "shift_jis"] as const;

export const ENCODING_LABELS: Record<string, string> = {
  "utf-8": "UTF-8",
  "euc-kr": "EUC-KR",
  "utf-16le": "UTF-16LE",
  "windows-1252": "Windows-1252",
  macintosh: "Mac Roman",
  "shift_jis": "Shift_JIS",
};

// A byte order mark says what the file is, whatever encoding was picked.
export function decodeText(bytes: ArrayBuffer | Uint8Array, encoding: string): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let chosen = encoding;
  if (view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf) {
    chosen = "utf-8";
  } else if (view[0] === 0xff && view[1] === 0xfe) {
    chosen = "utf-16le";
  }
  let text: string;
  try {
    text = new TextDecoder(chosen).decode(view);
  } catch {
    text = new TextDecoder("utf-8").decode(view);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
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

export interface DelimitedOptions {
  delimiter: string;
  // Empty: no quoting, every character is data.
  quote: string;
}

export interface DelimitedRows {
  rows: string[][];
  // The line each row starts on, from 1.
  lines: number[];
}

// RFC 4180 with the delimiter and quote of the caller's choosing: a quote
// opens a quoted field only at the field's start, a doubled quote inside one
// is a quote, and line breaks inside one are data. Blank lines are no rows.
export function parseDelimited(text: string, options: DelimitedOptions): DelimitedRows {
  const delimiter = options.delimiter === "" ? "," : options.delimiter;
  const quote = options.quote.slice(0, 1);
  const rows: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStart = true;
  let rowQuoted = false;
  let line = 1;
  let rowLine = 1;
  const length = text.length;

  function endRow(): void {
    row.push(field);
    if (!(row.length === 1 && row[0] === "" && !rowQuoted)) {
      rows.push(row);
      lines.push(rowLine);
    }
    row = [];
    field = "";
    fieldStart = true;
    rowQuoted = false;
  }

  let index = 0;
  while (index < length) {
    const ch = text[index];
    if (quoted) {
      if (ch === quote) {
        if (text[index + 1] === quote) {
          field += quote;
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      if (ch === "\n" || (ch === "\r" && text[index + 1] !== "\n")) {
        line += 1;
      }
      field += ch;
      index += 1;
      continue;
    }
    if (fieldStart && quote !== "" && ch === quote) {
      quoted = true;
      rowQuoted = true;
      fieldStart = false;
      index += 1;
      continue;
    }
    if (text.startsWith(delimiter, index)) {
      row.push(field);
      field = "";
      fieldStart = true;
      index += delimiter.length;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      index += ch === "\r" && text[index + 1] === "\n" ? 2 : 1;
      endRow();
      line += 1;
      rowLine = line;
      continue;
    }
    field += ch;
    fieldStart = false;
    index += 1;
  }
  if (field !== "" || row.length > 0 || rowQuoted) {
    endRow();
  }
  return { rows, lines };
}

// Header names as columns: blanks get colN, repeats (in any case, since
// names match case-insensitively) get _2, _3.
function columnNames(header: string[], count: number): string[] {
  const used = new Set<string>();
  const names: string[] = [];
  for (let c = 0; c < count; c += 1) {
    const base = (header[c] ?? "").trim() || `col${c + 1}`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) {
      name = `${base}_${n}`;
    }
    used.add(name.toLowerCase());
    names.push(name);
  }
  return names;
}

function padRow(row: string[], count: number): unknown[] {
  const values = new Array<unknown>(count);
  for (let c = 0; c < count; c += 1) {
    // A short row's missing fields are NULL, not empty text.
    values[c] = row[c] ?? null;
  }
  return values;
}

export interface CsvOptions extends DelimitedOptions {
  header: boolean;
}

export function parseCsv(text: string, options: CsvOptions): ParsedImport {
  const { rows: grid, lines } = parseDelimited(text, options);
  const columnCount = grid.reduce((widest, row) => Math.max(widest, row.length), 0);
  if (options.header) {
    return {
      columns: columnNames(grid[0] ?? [], columnCount),
      rows: grid.slice(1).map((row) => padRow(row, columnCount)),
      at: lines.slice(1),
      unit: "line",
    };
  }
  return {
    columns: columnNames([], columnCount),
    rows: grid.map((row) => padRow(row, columnCount)),
    at: lines,
    unit: "line",
  };
}

// Nested objects and arrays go in as their JSON text.
function scalar(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (value !== null && typeof value === "object") {
    return JSON.stringify(value);
  }
  return value;
}

function fromRecords(items: unknown[], at: number[], unit: ParsedImport["unit"]): ParsedImport {
  if (items.length === 0) {
    return { columns: [], rows: [], at: [], unit };
  }
  if (items.every((item) => Array.isArray(item))) {
    const grid = items as unknown[][];
    const columnCount = grid.reduce((widest, row) => Math.max(widest, row.length), 0);
    return {
      columns: columnNames([], columnCount),
      rows: grid.map((row) => Array.from({ length: columnCount }, (_, c) => scalar(row[c]))),
      at,
      unit,
    };
  }
  const isRecord = (item: unknown): item is Record<string, unknown> =>
    item !== null && typeof item === "object" && !Array.isArray(item);
  if (!items.some(isRecord)) {
    // A list of plain values is one column of them.
    return { columns: ["value"], rows: items.map((item) => [scalar(item)]), at, unit };
  }
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (isRecord(item)) {
      for (const key of Object.keys(item)) {
        if (!seen.has(key)) {
          seen.add(key);
          columns.push(key);
        }
      }
    }
  }
  return {
    columns,
    rows: items.map((item) => {
      const record = isRecord(item) ? item : {};
      return columns.map((column) => scalar(record[column]));
    }),
    at,
    unit,
  };
}

// An array of objects (or of arrays), one object, or JSON Lines: a value per line.
export function parseJsonImport(text: string): ParsedImport {
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch (error) {
    const items: unknown[] = [];
    const at: number[] = [];
    const lines = text.split(/\r\n|\n|\r/);
    for (let index = 0; index < lines.length; index += 1) {
      const lineText = lines[index].trim();
      if (lineText === "") {
        continue;
      }
      try {
        items.push(JSON.parse(lineText) as unknown);
      } catch {
        // Not JSON Lines either: what JSON.parse said of the whole file reads best.
        if (items.length === 0) {
          throw error;
        }
        throw new Error(`${error instanceof Error ? error.message : String(error)} (line ${index + 1})`);
      }
      at.push(index + 1);
    }
    return fromRecords(items, at, "line");
  }
  if (Array.isArray(data)) {
    return fromRecords(
      data,
      data.map((_, index) => index + 1),
      "record",
    );
  }
  if (data !== null && typeof data === "object") {
    return fromRecords([data], [1], "record");
  }
  return { columns: [], rows: [], at: [], unit: "record" };
}
