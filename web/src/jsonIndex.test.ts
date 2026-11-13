import { describe, expect, it } from "vitest";
import {
  buildIndex,
  childIds,
  jsonSpans,
  lineSpans,
  openTo,
  pathOf,
  prettyLines,
  searchIndex,
  visibleIds,
} from "./jsonIndex";

const doc = { name: "a", items: [{ id: 1, "odd key": null }, 2], empty: {}, nested: { deep: [true] } };

describe("buildIndex", () => {
  const index = buildIndex(doc);

  it("lists nodes in document order with their subtree ends", () => {
    expect(index.keys).toEqual(["ROOT", "name", "items", "0", "id", "odd key", "1", "empty", "nested", "deep", "0"]);
    // items (id 2) spans itself, its object (3..5) and 2 (6).
    expect(index.ends[2]).toBe(7);
    expect(index.maxDepth).toBe(3);
    expect(Array.from(childIds(index, 0))).toEqual([1, 2, 7, 8]);
    expect(Array.from(childIds(index, 1))).toEqual([]);
  });

  it("writes JSONPath-style paths, bracketing keys that aren't identifiers", () => {
    expect(pathOf(index, 0)).toBe("$");
    expect(pathOf(index, 4)).toBe("$.items[0].id");
    expect(pathOf(index, 5)).toBe('$.items[0]["odd key"]');
    expect(pathOf(index, 10)).toBe("$.nested.deep[0]");
  });

  it("shows only nodes whose ancestors are open", () => {
    const open = new Uint8Array(index.count);
    open[0] = 1;
    expect(Array.from(visibleIds(index, open))).toEqual([0, 1, 2, 7, 8]);
    openTo(index, open, 10);
    expect(Array.from(visibleIds(index, open))).toEqual([0, 1, 2, 7, 8, 9, 10]);
  });

  it("searches keys and primitive values, not array indexes", () => {
    expect(Array.from(searchIndex(index, "ID"))).toEqual([4]);
    expect(Array.from(searchIndex(index, "null"))).toEqual([5]);
    expect(Array.from(searchIndex(index, "0"))).toEqual([]);
  });
});

describe("prettyLines and lineSpans", () => {
  it("indent like JSON.stringify with two spaces, and place each node on its lines", () => {
    const text = JSON.stringify(doc);
    const lines = prettyLines(text);
    expect(lines).toEqual(JSON.stringify(doc, null, 2).split("\n"));
    const index = buildIndex(doc);
    const spans = lineSpans(index);
    expect(spans.total).toBe(lines.length);
    // "items": [ … ] opens on its key's line and closes on its bracket.
    expect(lines[spans.starts[2]].trim()).toBe('"items": [');
    expect(lines[spans.closes[2]].trim()).toBe("],");
    expect(lines[spans.starts[7]].trim()).toBe('"empty": {},');
  });

  it("keeps numbers past 2^53 and escapes as stored", () => {
    expect(prettyLines('{"id":12345678901234567890,"s":"a\\\\\\"b"}')).toEqual([
      "{",
      '  "id": 12345678901234567890,',
      '  "s": "a\\\\\\"b"',
      "}",
    ]);
  });
});

describe("jsonSpans", () => {
  it("colours keys, values and punctuation", () => {
    const text = '{"k": "v", "n": -1.5, "b": 9007199254740993, "t": true, "z": null}';
    const inks = jsonSpans(text).map((span) => [text.slice(span.from, span.to), span.ink]);
    expect(inks).toEqual([
      ["{", "punct"],
      ['"k"', "key"],
      [": ", "punct"],
      ['"v"', "string"],
      [", ", "punct"],
      ['"n"', "key"],
      [": ", "punct"],
      ["-1.5", "float"],
      [", ", "punct"],
      ['"b"', "key"],
      [": ", "punct"],
      ["9007199254740993", "bigint"],
      [", ", "punct"],
      ['"t"', "key"],
      [": ", "punct"],
      ["true", "boolean"],
      [", ", "punct"],
      ['"z"', "key"],
      [": ", "punct"],
      ["null", "null"],
      ["}", "punct"],
    ]);
  });
});
