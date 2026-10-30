import { quoteIdent } from "./ddl";
import type { SqlDialect } from "./engines/sqlDialect";
import type { DefinitionKind } from "./sqlTools";

export type ObjectKind = DefinitionKind;

// The dialect's CREATE template for a kind of object; empty where the
// engine has none.
export function createTemplate(dialect: SqlDialect, obj: ObjectKind): string {
  return dialect.templates[obj] ?? "";
}

const DROP_KEYWORD: Record<ObjectKind, string> = {
  view: "VIEW",
  materialized_view: "MATERIALIZED VIEW",
  dictionary: "DICTIONARY",
  function: "FUNCTION",
  procedure: "PROCEDURE",
  trigger: "TRIGGER",
  sequence: "SEQUENCE",
  type: "TYPE",
  aggregate: "AGGREGATE",
  synonym: "SYNONYM",
  package: "PACKAGE",
};

export function dropTemplate(dialect: SqlDialect, obj: ObjectKind, name: string): string {
  const keyword = dialect.dropKeywords?.[obj] ?? DROP_KEYWORD[obj];
  return `DROP ${keyword} ${quoteIdent(dialect, name)};`;
}
