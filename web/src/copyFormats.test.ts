import { describe, expect, it } from "vitest";
import { formatCopy, parseClipboardTable, toHtmlTable, toMarkdownTable, toPlainText } from "./copyFormats";
import { sql as mssql } from "./engines/mssql/sql";
import { sql as mysql } from "./engines/mysql/sql";
import { sql as postgres } from "./engines/postgres/sql";
import { SqlExpression } from "./export";

describe("toPlainText", () => {
  it("copies one cell exactly as it is", () => {
    expect(toPlainText([['say "hi"\nthere']])).toBe('say "hi"\nthere');
    expect(toPlainText([[null]])).toBe("");
  });

  it("writes rows tab-separated, quoting fields that would break the layout", () => {
    expect(
      toPlainText([
        ["a", null, 1, { k: [1] }],
        ["x\ty", "two\nlines", '"quoted', 'mid"dle'],
      ]),
    ).toBe('a\t\t1\t{"k":[1]}\n"x\ty"\t"two\nlines"\t"""quoted"\tmid"dle');
  });

  it("pastes back into the same cells", () => {
    const rows = [
      ["a", "x\ty", "two\r\nlines"],
      ['"q"', "", 'mid"dle'],
    ];
    expect(parseClipboardTable(toPlainText(rows))).toEqual(rows);
  });
});

describe("parseClipboardTable", () => {
  it("reads one line without tabs as one value", () => {
    expect(parseClipboardTable("a, b, c\n")).toEqual([["a, b, c"]]);
  });

  it("reads tab-separated rows, as spreadsheets copy them", () => {
    expect(parseClipboardTable("a\tb\r\n1\t2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("reads comma-separated lines when every line has the same number of fields", () => {
    expect(parseClipboardTable('a,b\n"1,5",2')).toEqual([
      ["a", "b"],
      ["1,5", "2"],
    ]);
  });

  it("reads lines with uneven commas as one value per line", () => {
    expect(parseClipboardTable("a,b\nc")).toEqual([["a,b"], ["c"]]);
  });

  it("keeps a quote that doesn't close a field as text", () => {
    expect(parseClipboardTable('5" screen\t1\n"open\t2')).toEqual([
      ['5" screen', "1"],
      ['"open', "2"],
    ]);
  });
});

describe("toHtmlTable", () => {
  it("escapes markup and writes NULL", () => {
    expect(toHtmlTable(["a<b"], [["<i>&\"</i>"], [null]])).toBe(
      [
        "<table>",
        "  <thead>",
        "    <tr><th>a&lt;b</th></tr>",
        "  </thead>",
        "  <tbody>",
        "    <tr><td>&lt;i&gt;&amp;&quot;&lt;/i&gt;</td></tr>",
        "    <tr><td>NULL</td></tr>",
        "  </tbody>",
        "</table>",
      ].join("\n"),
    );
  });
});

describe("toMarkdownTable", () => {
  it("escapes pipes and backslashes and turns line breaks into <br>", () => {
    expect(toMarkdownTable(["a|b", "c"], [["x\\|y", "1\r\n2"], [null, ""]])).toBe(
      ["| a\\|b | c |", "| --- | --- |", "| x\\\\\\|y | 1<br>2 |", "| NULL |  |"].join("\n"),
    );
  });
});

describe("formatCopy", () => {
  const table = { columns: ["id", "name"], rows: [[1, "O'Brien, Pat"], [2, null]] };

  it("writes CSV with and without the header, CRLF between records", () => {
    expect(formatCopy("csv", table, null)).toBe('1,"O\'Brien, Pat"\r\n2,');
    expect(formatCopy("csvHeader", table, null)).toBe('id,name\r\n1,"O\'Brien, Pat"\r\n2,');
  });

  it("writes JSON objects keyed by column", () => {
    expect(JSON.parse(formatCopy("json", table, null))).toEqual([
      { id: 1, name: "O'Brien, Pat" },
      { id: 2, name: null },
    ]);
  });

  it("writes INSERTs in the target's dialect, or nothing without a target", () => {
    expect(formatCopy("insert", table, null)).toBe("");
    expect(formatCopy("insert", table, { table: "public.people", dialect: postgres })).toBe(
      'INSERT INTO "public"."people" ("id", "name") VALUES\n  (1, \'O\'\'Brien, Pat\'),\n  (2, NULL);',
    );
    expect(formatCopy("insert", table, { table: "people", dialect: mysql })).toBe(
      "INSERT INTO `people` (`id`, `name`) VALUES\n  (1, 'O''Brien, Pat'),\n  (2, NULL);",
    );
  });

  it("writes byte columns as binary literals", () => {
    const bytes = { columns: ["data"], rows: [["\\x00ff"], ["0xABCD"]] };
    expect(formatCopy("insert", bytes, { table: "b", dialect: postgres, binary: [true] })).toBe(
      "INSERT INTO \"b\" (\"data\") VALUES\n  ('\\x00ff'),\n  ('\\xabcd');",
    );
    expect(formatCopy("insert", bytes, { table: "b", dialect: mssql, binary: [true] })).toBe(
      "INSERT INTO [b] ([data]) VALUES\n  (0x00FF),\n  (0xABCD);",
    );
  });

  it("leaves out columns at DEFAULT, grouping rows that leave out the same ones", () => {
    const staged = {
      columns: ["id", "name"],
      rows: [
        [new SqlExpression("default"), "a"],
        [new SqlExpression("default"), "b"],
        [3, "c"],
      ],
    };
    expect(formatCopy("insert", staged, { table: "t", dialect: postgres })).toBe(
      ['INSERT INTO "t" ("name") VALUES', "  ('a'),", "  ('b');", 'INSERT INTO "t" ("id", "name") VALUES', "  (3, 'c');"].join(
        "\n",
      ),
    );
  });
});
