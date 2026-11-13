import { describe, expect, it, vi } from "vitest";
import {
  JsonNumber,
  decodeText,
  detectDelimiter,
  parseCsv,
  parseDelimited,
  parseJsonExact,
  parseJsonImport,
} from "./importParse";

const CSV = { delimiter: ",", quote: '"' };

describe("detectDelimiter", () => {
  it("reads the first line only", () => {
    expect(detectDelimiter("a;b;c\n1,2,3,4,5")).toBe(";");
    expect(detectDelimiter("a\tb\tc\n1,2")).toBe("\t");
    expect(detectDelimiter("a,b;c,d")).toBe(",");
    expect(detectDelimiter("single")).toBe(",");
  });
});

describe("parseDelimited", () => {
  it("keeps delimiters, doubled quotes and line breaks inside quoted fields", () => {
    const text = 'id,note\n1,"a, b"\n2,"say ""hi"""\n3,"two\nlines"\n';
    expect(parseDelimited(text, CSV)).toEqual({
      rows: [
        ["id", "note"],
        ["1", "a, b"],
        ["2", 'say "hi"'],
        ["3", "two\nlines"],
      ],
      lines: [1, 2, 3, 4],
    });
  });

  it("counts lines across embedded line breaks for the rows after them", () => {
    const { lines } = parseDelimited('a,"x\ny\nz"\nb,c\r\nd,e', CSV);
    expect(lines).toEqual([1, 4, 5]);
  });

  it("treats CRLF, CR and LF alike as row ends", () => {
    expect(parseDelimited("a,b\r\nc,d\re,f\ng,h", CSV).rows).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
      ["g", "h"],
    ]);
  });

  it("reads a quote that doesn't open the field as data", () => {
    expect(parseDelimited('5" screen,x\n', CSV).rows).toEqual([['5" screen', "x"]]);
  });

  it("reads quotes as data when quoting is off", () => {
    expect(parseDelimited('"a",b\n', { delimiter: ",", quote: "" }).rows).toEqual([['"a"', "b"]]);
  });

  it("takes a multi-character delimiter", () => {
    expect(parseDelimited("a||b||c\n1||2||3", { delimiter: "||", quote: '"' }).rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("skips blank lines between multi-column rows", () => {
    const { rows, lines } = parseDelimited("a,b\n\n1,2\n\n", CSV);
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(lines).toEqual([1, 3]);
  });

  it("keeps a blank line between one-column rows as an empty value, but not trailing ones", () => {
    expect(parseDelimited("name\nx\n\ny\n\n\n", CSV).rows).toEqual([["name"], ["x"], [""], ["y"]]);
  });

  it("keeps a quoted empty field as a row", () => {
    expect(parseDelimited('a,b\n""\n', CSV).rows).toEqual([["a", "b"], [""]]);
  });

  it("returns nothing for blank text", () => {
    expect(parseDelimited("\n\n", CSV)).toEqual({ rows: [], lines: [] });
  });
});

describe("parseCsv", () => {
  it("pads short rows with NULL, not empty text", () => {
    const parsed = parseCsv("a,b,c\n1,2\n3,,4,5\n", { ...CSV, header: true });
    expect(parsed.columns).toEqual(["a", "b", "c", "col4"]);
    expect(parsed.rows).toEqual([
      ["1", "2", null, null],
      ["3", "", "4", "5"],
    ]);
    expect(parsed.at).toEqual([2, 3]);
    expect(parsed.unit).toBe("line");
  });

  it("names blank headers and makes repeated ones unique, ignoring case", () => {
    const parsed = parseCsv("id,,ID,name,Name\n1,2,3,4,5", { ...CSV, header: true });
    expect(parsed.columns).toEqual(["id", "col2", "ID_2", "name", "Name_2"]);
  });

  it("numbers columns when there is no header row", () => {
    const parsed = parseCsv("1;2\n3;4", { delimiter: ";", quote: '"', header: false });
    expect(parsed.columns).toEqual(["col1", "col2"]);
    expect(parsed.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(parsed.at).toEqual([1, 2]);
  });
});

describe("decodeText", () => {
  it("drops a UTF-8 byte order mark", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("id,이름")]);
    expect(decodeText(bytes, "utf-8")).toBe("id,이름");
  });

  it("lets a byte order mark override the chosen encoding", () => {
    const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, 0xed, 0x95, 0x9c]);
    expect(decodeText(utf8, "euc-kr")).toBe("한");
    // "hi" in UTF-16LE with its BOM.
    const utf16 = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
    expect(decodeText(utf16, "utf-8")).toBe("hi");
  });

  it("decodes EUC-KR when asked", () => {
    expect(decodeText(new Uint8Array([0xc7, 0xd1]), "euc-kr")).toBe("한");
  });

  it("falls back to UTF-8 for an encoding the runtime doesn't know", () => {
    expect(decodeText(new TextEncoder().encode("abc"), "no-such-encoding")).toBe("abc");
  });
});

describe("JsonNumber.plain", () => {
  it("writes exponents out as plain digits", () => {
    expect(new JsonNumber("1.25e3").plain).toBe("1250");
    expect(new JsonNumber("-1.5E-3").plain).toBe("-0.0015");
    expect(new JsonNumber("12345678901234567890e2").plain).toBe("1234567890123456789000");
    expect(new JsonNumber("1.000e1").plain).toBe("10");
  });

  it("leaves numbers without an exponent as written", () => {
    expect(new JsonNumber("12345678901234567890").plain).toBe("12345678901234567890");
    expect(new JsonNumber("0.10000000000000000001").plain).toBe("0.10000000000000000001");
  });
});

describe("parseJsonExact", () => {
  it("keeps integers past 2^53 and long decimals as their text", () => {
    const parsed = parseJsonExact('{"id": 9007199254740993, "small": 42, "amount": 0.12345678901234567}') as Record<
      string,
      unknown
    >;
    expect(parsed.id).toBeInstanceOf(JsonNumber);
    expect(String(parsed.id)).toBe("9007199254740993");
    expect(parsed.small).toBe(42);
    expect(String(parsed.amount)).toBe("0.12345678901234567");
  });

  it("keeps a number a double can hold as a number", () => {
    expect(parseJsonExact("[9007199254740991, 1.5e300]")).toEqual([9007199254740991, 1.5e300]);
  });

  it("does not read digits inside strings as numbers", () => {
    expect(parseJsonExact('{"s": "12345678901234567890"}')).toEqual({ s: "12345678901234567890" });
  });
});

describe("parseJsonImport", () => {
  it("takes the union of keys across an array of objects, in first-seen order", () => {
    const parsed = parseJsonImport('[{"a": 1, "b": {"x": [1]}}, {"c": true, "a": null}]');
    expect(parsed.columns).toEqual(["a", "b", "c"]);
    expect(parsed.rows).toEqual([
      [1, '{"x":[1]}', null],
      [null, null, true],
    ]);
    expect(parsed.at).toEqual([1, 2]);
    expect(parsed.unit).toBe("record");
  });

  it("reads one object as one row", () => {
    expect(parseJsonImport('{"a": "x"}').rows).toEqual([["x"]]);
  });

  it("reads an array of arrays as positional columns", () => {
    const parsed = parseJsonImport("[[1, 2], [3]]");
    expect(parsed.columns).toEqual(["col1", "col2"]);
    expect(parsed.rows).toEqual([
      [1, 2],
      [3, null],
    ]);
  });

  it("reads an array of plain values as one column", () => {
    expect(parseJsonImport('[1, "two", null]')).toMatchObject({ columns: ["value"], rows: [[1], ["two"], [null]] });
  });

  it("reads JSON Lines with each row's line number, skipping blank lines", () => {
    const parsed = parseJsonImport('{"a": 1}\n\n{"a": 2, "b": 3}\r\n');
    expect(parsed.columns).toEqual(["a", "b"]);
    expect(parsed.rows).toEqual([
      [1, null],
      [2, 3],
    ]);
    expect(parsed.at).toEqual([1, 3]);
    expect(parsed.unit).toBe("line");
  });

  it("names the bad line of a JSON Lines file", () => {
    expect(() => parseJsonImport('{"a": 1}\n{"a": 2}\n{oops}\n')).toThrow(/\(line 3\)/);
  });

  it("reports the parse error itself when the first line is not JSON either", () => {
    expect(() => parseJsonImport("not json")).toThrow(SyntaxError);
  });

  it("keeps big integers exact in imported rows", () => {
    const [[id]] = parseJsonImport('[{"id": 123456789012345678901}]').rows;
    expect(id).toBeInstanceOf(JsonNumber);
    expect(String(id)).toBe("123456789012345678901");
  });
});

// Engines whose JSON.parse hands a reviver no source text (Safari, older
// Firefox) take the hand-written reader instead.
describe("parseJsonExact without reviver source text", () => {
  async function loadWithoutSourceText(): Promise<typeof import("./importParse")> {
    const parse = JSON.parse;
    JSON.parse = ((text: string, reviver?: (key: string, value: unknown) => unknown) =>
      reviver === undefined ? parse(text) : parse(text, (key, value) => reviver(key, value))) as typeof JSON.parse;
    try {
      vi.resetModules();
      return await import("./importParse");
    } finally {
      JSON.parse = parse;
    }
  }

  it("keeps big numbers exact and reads the rest as JSON.parse does", async () => {
    const mod = await loadWithoutSourceText();
    const parsed = mod.parseJsonExact(
      '{"id": 12345678901234567890, "n": -1.5e2, "s": "a\\"b 12345678901234567890", "l": [true, false, null], "__proto__": 1}',
    ) as Record<string, unknown>;
    expect(parsed.id).toBeInstanceOf(mod.JsonNumber);
    expect(String(parsed.id)).toBe("12345678901234567890");
    expect(parsed.n).toBe(-150);
    expect(parsed.s).toBe('a"b 12345678901234567890');
    expect(parsed.l).toEqual([true, false, null]);
    expect(Object.keys(parsed)).toContain("__proto__");
  });

  it("rejects malformed JSON", async () => {
    const mod = await loadWithoutSourceText();
    expect(() => mod.parseJsonExact("[12345678901234567890,]")).toThrow(SyntaxError);
    expect(() => mod.parseJsonExact("[12345678901234567890] x")).toThrow(SyntaxError);
  });
});
