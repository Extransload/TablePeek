import { pkList, quoteIdent, type StructureDraft } from "../../ddl";
import { parsePostgresPlan } from "../../explainPlan";
import { t } from "../../i18n";
import { postgresUsers, sql as postgres } from "../postgres/sql";
import type { SqlDialect } from "../sqlDialect";

// CockroachDB swaps a primary key in one statement and keeps one always;
// its columns must be NOT NULL first (others make them so themselves).
function changePrimaryKey(table: string, _orig: StructureDraft, next: StructureDraft, errors: string[]): string[] {
  const nextPk = pkList(next.columns);
  if (nextPk.length === 0) {
    errors.push(t("CockroachDB 테이블에서는 기본 키를 없앨 수 없습니다"));
    return [];
  }
  const statements: string[] = [];
  for (const column of next.columns) {
    if (column.pk && !column.notNull) {
      statements.push(
        `ALTER TABLE ${quoteIdent(sql, table)} ALTER COLUMN ${quoteIdent(sql, column.name.trim())} SET NOT NULL`,
      );
    }
  }
  statements.push(
    `ALTER TABLE ${quoteIdent(sql, table)} ALTER PRIMARY KEY USING COLUMNS (${nextPk
      .map((name) => quoteIdent(sql, name))
      .join(", ")})`,
  );
  return statements;
}

// CockroachDB speaks PostgreSQL's SQL; it differs in how a primary key
// changes, which session settings a restore keeps, and its roles.
export const sql: SqlDialect = {
  ...postgres,
  changePrimaryKey,
  sessionSnapshot: "SELECT current_setting('search_path')",
  // As SHOW gives it: a list of names, quoted where they need it.
  restoreSession: (row) =>
    typeof row[0] === "string" && row[0].trim() !== "" ? `SET search_path = ${row[0]}` : null,
  // CockroachDB has no EXPLAIN (FORMAT JSON); its plain EXPLAIN stays.
  explain: { prefix: "EXPLAIN ", parse: (_columns, rows) => parsePostgresPlan(rows) },
  // CockroachDB has no SUPERUSER role option.
  users: { ...postgresUsers, superUserOption: false },
};
