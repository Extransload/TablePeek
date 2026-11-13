import { describe, expect, it } from "vitest";
import {
  type ColumnDraft,
  type StructureDraft,
  createTableSql,
  dependencyOrder,
  diffStructure,
  dropIndexSql,
  quoteIdent,
  quoteName,
  renameTableSql,
  validateDraft,
} from "./ddl";
import { sql as mssql } from "./engines/mssql/sql";
import { sql as mysql } from "./engines/mysql/sql";
import { sql as oracle } from "./engines/oracle/sql";
import { sql as postgres } from "./engines/postgres/sql";

function column(name: string, type: string, extra: Partial<ColumnDraft> = {}): ColumnDraft {
  return { key: name, orig: name, name, type, notNull: false, pk: false, def: "", ...extra };
}

const users: StructureDraft = {
  columns: [
    column("id", "integer", { pk: true, notNull: true }),
    column("email", "text", { notNull: true }),
    column("team_id", "integer"),
    column("note", "text", { def: "''" }),
  ],
  indexes: [{ key: "i1", orig: "users_email", name: "users_email", unique: true, columns: "email" }],
  foreignKeys: [{ key: "f1", orig: "users_team", name: "users_team", columns: "team_id", refTable: "teams", refColumns: "id" }],
};

describe("quoting", () => {
  it("quotes each part of a qualified name, escaping the quote character", () => {
    expect(quoteIdent(postgres, 'app.we"ird')).toBe('"app"."we""ird"');
    expect(quoteIdent(mysql, "a`b")).toBe("`a``b`");
    expect(quoteIdent(mssql, "dbo.x]y")).toBe("[dbo].[x]]y]");
  });

  it("keeps a dot in a column name as part of the name", () => {
    expect(quoteName(postgres, "a.b")).toBe('"a.b"');
  });
});

describe("createTableSql", () => {
  it("writes columns, the key, foreign keys, then the indexes", () => {
    const { statements, errors } = createTableSql(postgres, "app.users", users);
    expect(errors).toEqual([]);
    expect(statements).toEqual([
      [
        'CREATE TABLE "app"."users" (',
        '  "id" integer NOT NULL,',
        '  "email" text NOT NULL,',
        '  "team_id" integer,',
        "  \"note\" text DEFAULT '',",
        '  PRIMARY KEY ("id"),',
        '  CONSTRAINT "users_team" FOREIGN KEY ("team_id") REFERENCES "teams" ("id")',
        ")",
      ].join("\n"),
      'CREATE UNIQUE INDEX "users_email" ON "app"."users" ("email")',
    ]);
  });

  it("refuses a draft with blank or repeated names", () => {
    const bad: StructureDraft = {
      columns: [column("a", "int"), column("a", "int"), column("", "int"), column("b", " ")],
      indexes: [{ key: "i", orig: null, name: "", unique: false, columns: " , " }],
      foreignKeys: [{ key: "f", orig: null, name: "fk", columns: "a", refTable: " ", refColumns: "" }],
    };
    expect(validateDraft(bad)).toHaveLength(6);
    expect(createTableSql(postgres, "t", bad).statements).toEqual([]);
  });
});

describe("diffStructure", () => {
  it("drops what goes first, then renames, changes and adds, then rebuilds indexes and keys", () => {
    const next: StructureDraft = {
      ...users,
      columns: [
        users.columns[0],
        { ...users.columns[1], name: "mail" },
        users.columns[2],
        column("age", "integer", { orig: null, key: "new1" }),
      ],
      indexes: [{ ...users.indexes[0], columns: "mail" }],
    };
    const { statements, errors } = diffStructure(postgres, "users", users, next);
    expect(errors).toEqual([]);
    expect(statements).toEqual([
      'DROP INDEX "users_email"',
      'ALTER TABLE "users" RENAME COLUMN "email" TO "mail"',
      'ALTER TABLE "users" ADD COLUMN "age" integer',
      'ALTER TABLE "users" DROP COLUMN "note"',
      'CREATE UNIQUE INDEX "users_email" ON "users" ("mail")',
    ]);
  });

  it("drops a removed foreign key before anything else", () => {
    const next = { ...users, foreignKeys: [] };
    expect(diffStructure(postgres, "users", users, next).statements).toEqual([
      'ALTER TABLE "users" DROP CONSTRAINT "users_team"',
    ]);
  });

  it("has nothing to do when nothing changed", () => {
    expect(diffStructure(postgres, "users", users, users)).toEqual({ statements: [], errors: [] });
  });
});

describe("statements by dialect", () => {
  it("drops an index in its table's schema, or on its table", () => {
    expect(dropIndexSql(postgres, "app.users", "users_email")).toBe('DROP INDEX "app"."users_email"');
    expect(dropIndexSql(mssql, "dbo.users", "users_email")).toBe("DROP INDEX [users_email] ON [dbo].[users]");
  });

  it("renames a table within its schema", () => {
    expect(renameTableSql(postgres, "app.users", "app.people")).toBe('ALTER TABLE "app"."users" RENAME TO "people"');
    expect(renameTableSql(oracle, "users", "people")).toBe('ALTER TABLE "users" RENAME TO "people"');
  });

  it("keeps quotes and brackets in SQL Server names inside sp_rename", () => {
    expect(renameTableSql(mssql, "dbo.o'neil", "o'brien")).toBe("EXEC sp_rename N'[dbo].[o''neil]', N'o''brien'");
    expect(mssql.renameColumn?.("dbo.t", "it's", "x]y")).toBe(
      "EXEC sp_rename N'[dbo].[t].[it''s]', N'x]y', 'COLUMN'",
    );
  });
});

describe("dependencyOrder", () => {
  it("puts each table after the tables it references", () => {
    const refs: Record<string, string[]> = {
      orders: ["users", "products"],
      users: ["teams"],
      products: [],
      teams: [],
      audit: ["outside"],
    };
    expect(dependencyOrder(["orders", "users", "products", "teams", "audit"], (name) => refs[name])).toEqual([
      "teams",
      "users",
      "products",
      "orders",
      "audit",
    ]);
  });

  it("breaks a cycle and keeps self-references from looping", () => {
    const refs: Record<string, string[]> = { a: ["b"], b: ["a"], c: ["c"] };
    expect(dependencyOrder(["a", "b", "c"], (name) => refs[name])).toEqual(["b", "a", "c"]);
  });
});
