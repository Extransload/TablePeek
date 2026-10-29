import { quoteIdent } from "./ddl";
import type { SqlDialect } from "./engines/sqlDialect";

export type ObjectKind = "view" | "function" | "procedure" | "trigger" | "sequence";

// The dialect's CREATE template for a kind of object; empty where the
// engine has none.
export function createTemplate(dialect: SqlDialect, obj: ObjectKind): string {
  return dialect.templates[obj] ?? "";
}

const DROP_KEYWORD: Record<ObjectKind, string> = {
  view: "VIEW",
  function: "FUNCTION",
  procedure: "PROCEDURE",
  trigger: "TRIGGER",
  sequence: "SEQUENCE",
};

export function dropTemplate(dialect: SqlDialect, obj: ObjectKind, name: string): string {
  return `DROP ${DROP_KEYWORD[obj]} ${quoteIdent(dialect, name)};`;
}
