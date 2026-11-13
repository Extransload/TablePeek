import { describe, expect, it } from "vitest";
import { sql as postgres } from "./engines/postgres/sql";
import { type CompletionColumn, type SqlCompletionConfig, completeSql, valueSlotAt } from "./sqlComplete";

function col(name: string, pk = false): CompletionColumn {
  return { name, type: "text", notNull: pk, pk };
}

const config: SqlCompletionConfig = {
  schema: {
    users: [col("id", true), col("email"), col("team_id")],
    teams: [col("id", true), col("title")],
    "audit.Log Entries": [col("id", true)],
  },
  relations: [{ table: "users", columns: ["team_id"], refTable: "teams", refColumns: ["id"] }],
  words: [
    { label: "SELECT", type: "keyword" },
    { label: "FROM", type: "keyword" },
  ],
  dialect: postgres,
  identifierQuotes: '"',
};

// The completions at the | in the text.
function at(text: string, extra: Partial<SqlCompletionConfig> = {}) {
  const pos = text.indexOf("|");
  return completeSql(text.replace("|", ""), pos, { ...config, ...extra });
}

function labels(text: string, kind?: string): string[] {
  return (at(text)?.options ?? []).filter((option) => kind === undefined || option.kind === kind).map((option) => option.label);
}

describe("completeSql", () => {
  it("offers tables after FROM", () => {
    expect(labels("SELECT * FROM us|", "table")).toEqual(["users"]);
  });

  it("offers the columns of the table an alias names", () => {
    expect(labels("SELECT u.| FROM users u", "column").sort()).toEqual(["email", "id", "team_id"]);
    expect(labels("SELECT t.ti| FROM users u JOIN teams t ON true", "column")).toEqual(["title"]);
  });

  it("replaces only the word typed so far", () => {
    const result = at("SELECT u.em| FROM users u");
    expect(result).not.toBeNull();
    expect(result!.typed).toBe("em");
    expect(result!.bare).toBe(false);
    expect("SELECT u.em FROM users u".slice(result!.from, result!.to)).toBe("em");
  });

  it("quotes an inserted name that needs it", () => {
    const option = at("SELECT * FROM audit.Lo|")?.options.find((item) => item.kind === "table");
    expect(option?.label).toBe("Log Entries");
    expect(option?.apply).toBe('"Log Entries"');
  });

  it("suggests a join on the foreign key", () => {
    const join = at("SELECT * FROM users u JOIN |", { explicit: true })?.options.find(
      (item) => item.kind === "join" && item.table === "teams",
    );
    expect(join).toMatchObject({ apply: "teams t ON u.team_id = t.id", guessed: false });
  });

  it("offers nothing inside a string or a comment", () => {
    expect(at("SELECT 'FROM us|' FROM users")).toBeNull();
    expect(at("SELECT 1 -- FROM us|")).toBeNull();
  });
});

describe("valueSlotAt", () => {
  it("finds the column a string is compared with", () => {
    const text = "SELECT * FROM users u WHERE u.email = 'ad";
    expect(valueSlotAt(text, text.length, config)).toMatchObject({
      table: "users",
      column: "email",
      typed: "ad",
      quote: "'",
      closed: false,
    });
  });

  it("reads each string of an IN list", () => {
    const text = "SELECT * FROM users WHERE email IN ('a', 'b|')";
    const slot = valueSlotAt(text.replace("|", ""), text.indexOf("|"), config);
    expect(slot).toMatchObject({ table: "users", column: "email", typed: "b", closed: true });
  });
});
