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
// is a quote, and line breaks inside one are data. Blank lines are no rows,
// unless every row has one field: there an empty line between rows is an
// empty value (a one-column export writes NULL so), while the blank lines
// at the very end of the file are only its end.
export function parseDelimited(text: string, options: DelimitedOptions): DelimitedRows {
  const delimiter = options.delimiter === "" ? "," : options.delimiter;
  const quote = options.quote.slice(0, 1);
  const rows: string[][] = [];
  const lines: number[] = [];
  const blank: boolean[] = [];
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
    rows.push(row);
    lines.push(rowLine);
    blank.push(row.length === 1 && row[0] === "" && !rowQuoted);
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
  if (blank.every(Boolean)) {
    return { rows: [], lines: [] };
  }
  if (rows.every((entry) => entry.length <= 1)) {
    let end = rows.length;
    while (end > 0 && blank[end - 1]) {
      end -= 1;
    }
    return { rows: rows.slice(0, end), lines: lines.slice(0, end) };
  }
  const kept = rows.map((_, index) => index).filter((index) => !blank[index]);
  return { rows: kept.map((index) => rows[index]), lines: kept.map((index) => lines[index]) };
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

// A JSON number a double can't hold exactly: an integer past 2^53, or a
// decimal with more significant digits than a double keeps. It stays as the
// file wrote it, so ids and amounts go in unchanged, and reads as that text.
export class JsonNumber {
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  toString(): string {
    return this.text;
  }

  // Exact inside nested JSON where the engine can write raw JSON; a double elsewhere.
  toJSON(): unknown {
    const raw = (JSON as unknown as { rawJSON?: (text: string) => unknown }).rawJSON;
    return raw === undefined ? Number(this.text) : raw(this.text);
  }

  // The same digits without an exponent (1.25e3 is 1250): MySQL and SQL
  // Server read an exponent as a float, but plain digits as an exact
  // decimal. Kept as written when that would take over 1,000 digits.
  get plain(): string {
    const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(this.text);
    if (match === null) {
      return this.text;
    }
    const [, sign, whole, fraction = "", exponent] = match;
    const digits = whole + fraction;
    // Where the point falls among the digits once the exponent moves it.
    const point = whole.length + Number(exponent);
    if (Math.abs(point) > 1000 || digits.length > 1000) {
      return this.text;
    }
    const head = point <= 0 ? "0" : digits.slice(0, point).padEnd(point, "0");
    const tail = point <= 0 ? "0".repeat(-point) + digits : digits.slice(point);
    const integer = head.replace(/^0+(?=\d)/, "");
    const decimals = tail.replace(/0+$/, "");
    return `${sign}${integer}${decimals === "" ? "" : `.${decimals}`}`;
  }
}

// An object read from the file: not an array, and not a number kept as its text.
function isRecord(item: unknown): item is Record<string, unknown> {
  return item !== null && typeof item === "object" && !Array.isArray(item) && !(item instanceof JsonNumber);
}

// Whether Number(source) would change a number literal's value.
function inexact(source: string): boolean {
  const value = Number(source);
  if (/^-?\d+$/.test(source)) {
    return !Number.isSafeInteger(value);
  }
  // Past a double's range (1e400) or below it (1e-400).
  const digits = source.replace(/^-/, "").split(/[eE]/)[0].replace(".", "").replace(/^0+/, "").replace(/0+$/, "");
  return digits.length > 15 || !Number.isFinite(value) || (value === 0 && digits !== "");
}

// Sixteen digits in a row (a point between them aside) or a three-digit
// exponent: without either every number literal is exact as a double, and
// JSON.parse alone will do.
const LONG_NUMBER = /(?:\d\.?){16}|\d[eE][+-]?\d{3}/;

// JSON.parse hands a reviver each literal's source text (Chrome 114+, Node 21+).
const SOURCE_TEXT = (() => {
  let source: unknown;
  try {
    JSON.parse("1", (_key: string, value: unknown, context?: { source?: string }) => {
      source = context?.source;
      return value;
    });
  } catch {
    return false;
  }
  return source === "1";
})();

const NUMBER_TOKEN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const WORDS: [string, unknown][] = [
  ["true", true],
  ["false", false],
  ["null", null],
];

// JSON read by hand, for engines whose JSON.parse gives no source text:
// number literals arrive as written, strings still go through JSON.parse.
class ExactJsonReader {
  private readonly text: string;
  private at = 0;

  constructor(text: string) {
    this.text = text;
  }

  document(): unknown {
    const value = this.value();
    this.space();
    if (this.at < this.text.length) {
      this.fail();
    }
    return value;
  }

  private fail(): never {
    const found = this.text[this.at];
    throw new SyntaxError(
      found === undefined
        ? "Unexpected end of JSON input"
        : `Unexpected token '${found}' in JSON at position ${this.at}`,
    );
  }

  private space(): void {
    while (this.at < this.text.length && " \t\n\r".includes(this.text[this.at])) {
      this.at += 1;
    }
  }

  private expect(ch: string): void {
    this.space();
    if (this.text[this.at] !== ch) {
      this.fail();
    }
    this.at += 1;
  }

  private value(): unknown {
    this.space();
    const ch = this.text[this.at];
    if (ch === "{") {
      return this.object();
    }
    if (ch === "[") {
      return this.array();
    }
    if (ch === '"') {
      return this.string();
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      NUMBER_TOKEN.lastIndex = this.at;
      const match = NUMBER_TOKEN.exec(this.text);
      if (match === null) {
        this.fail();
      }
      this.at += match[0].length;
      return inexact(match[0]) ? new JsonNumber(match[0]) : Number(match[0]);
    }
    for (const [word, value] of WORDS) {
      if (this.text.startsWith(word, this.at)) {
        this.at += word.length;
        return value;
      }
    }
    return this.fail();
  }

  private string(): string {
    const start = this.at;
    this.at += 1;
    while (this.at < this.text.length) {
      const ch = this.text[this.at];
      if (ch === '"') {
        this.at += 1;
        return JSON.parse(this.text.slice(start, this.at)) as string;
      }
      this.at += ch === "\\" ? 2 : 1;
    }
    return this.fail();
  }

  private object(): Record<string, unknown> {
    const item: Record<string, unknown> = {};
    this.at += 1;
    this.space();
    if (this.text[this.at] === "}") {
      this.at += 1;
      return item;
    }
    for (;;) {
      this.space();
      if (this.text[this.at] !== '"') {
        this.fail();
      }
      const key = this.string();
      this.expect(":");
      // As JSON.parse does: "__proto__" is a key like any other.
      Object.defineProperty(item, key, { value: this.value(), enumerable: true, writable: true, configurable: true });
      this.space();
      if (this.text[this.at] === "}") {
        this.at += 1;
        return item;
      }
      this.expect(",");
    }
  }

  private array(): unknown[] {
    const items: unknown[] = [];
    this.at += 1;
    this.space();
    if (this.text[this.at] === "]") {
      this.at += 1;
      return items;
    }
    for (;;) {
      items.push(this.value());
      this.space();
      if (this.text[this.at] === "]") {
        this.at += 1;
        return items;
      }
      this.expect(",");
    }
  }
}

// JSON.parse, except that numbers a double would change come back as JsonNumber.
export function parseJsonExact(text: string): unknown {
  if (!LONG_NUMBER.test(text)) {
    return JSON.parse(text) as unknown;
  }
  if (SOURCE_TEXT) {
    return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) =>
      typeof value === "number" && context?.source !== undefined && inexact(context.source)
        ? new JsonNumber(context.source)
        : value,
    ) as unknown;
  }
  return new ExactJsonReader(text).document();
}

// Nested objects and arrays go in as their JSON text.
function scalar(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (value instanceof JsonNumber) {
    return value;
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
    data = parseJsonExact(text);
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
        items.push(parseJsonExact(lineText));
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
  if (isRecord(data)) {
    return fromRecords([data], [1], "record");
  }
  return { columns: [], rows: [], at: [], unit: "record" };
}
