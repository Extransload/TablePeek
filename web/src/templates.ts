import { quoteIdent } from "./ddl";

export type ObjectKind = "view" | "function" | "procedure" | "trigger" | "sequence";

export function createTemplate(kind: string, obj: ObjectKind): string {
  if (kind === "sqlite") {
    if (obj === "view") {
      return "CREATE VIEW v_name AS\nSELECT 1 AS one;";
    }
    if (obj === "trigger") {
      return "CREATE TRIGGER trg_name\nAFTER INSERT ON table_name\nBEGIN\n  SELECT 1;\nEND;";
    }
    return "";
  }
  if (kind === "mysql") {
    if (obj === "view") {
      return "CREATE OR REPLACE VIEW v_name AS\nSELECT 1 AS one;";
    }
    if (obj === "function") {
      return "CREATE FUNCTION fn_name(x INT) RETURNS INT\nDETERMINISTIC\nRETURN x + 1;";
    }
    if (obj === "procedure") {
      return "CREATE PROCEDURE sp_name(IN x INT)\nSELECT x;";
    }
    if (obj === "trigger") {
      return "CREATE TRIGGER trg_name\nAFTER INSERT ON table_name FOR EACH ROW\nSET @flag = 1;";
    }
    return "";
  }
  if (kind === "mssql") {
    if (obj === "view") {
      return "CREATE VIEW dbo.v_name AS\nSELECT 1 AS one;";
    }
    if (obj === "function") {
      return [
        "CREATE FUNCTION dbo.fn_name (@x INT)",
        "RETURNS INT",
        "AS",
        "BEGIN",
        "  RETURN @x + 1;",
        "END;",
      ].join("\n");
    }
    if (obj === "procedure") {
      return [
        "CREATE PROCEDURE dbo.sp_name",
        "  @x INT",
        "AS",
        "BEGIN",
        "  SELECT @x AS x;",
        "END;",
      ].join("\n");
    }
    if (obj === "trigger") {
      return [
        "CREATE TRIGGER dbo.trg_name",
        "ON dbo.table_name",
        "AFTER INSERT",
        "AS",
        "BEGIN",
        "  SET NOCOUNT ON;",
        "END;",
      ].join("\n");
    }
    if (obj === "sequence") {
      return "CREATE SEQUENCE dbo.seq_name\n  AS BIGINT\n  START WITH 1\n  INCREMENT BY 1;";
    }
    return "";
  }
  if (obj === "view") {
    return "CREATE OR REPLACE VIEW v_name AS\nSELECT 1 AS one;";
  }
  if (obj === "function") {
    return [
      "CREATE OR REPLACE FUNCTION fn_name(x integer) RETURNS integer AS $$",
      "BEGIN",
      "  RETURN x + 1;",
      "END;",
      "$$ LANGUAGE plpgsql;",
    ].join("\n");
  }
  if (obj === "procedure") {
    return [
      "CREATE OR REPLACE PROCEDURE sp_name(x integer) AS $$",
      "BEGIN",
      "  RAISE NOTICE '%', x;",
      "END;",
      "$$ LANGUAGE plpgsql;",
    ].join("\n");
  }
  if (obj === "trigger") {
    return [
      "CREATE OR REPLACE FUNCTION trg_fn() RETURNS trigger AS $$",
      "BEGIN",
      "  RETURN NEW;",
      "END;",
      "$$ LANGUAGE plpgsql;",
      "",
      "CREATE TRIGGER trg_name",
      "AFTER INSERT ON table_name",
      "FOR EACH ROW EXECUTE FUNCTION trg_fn();",
    ].join("\n");
  }
  if (obj === "sequence") {
    return "CREATE SEQUENCE seq_name\n  START WITH 1\n  INCREMENT BY 1;";
  }
  return "";
}

export function dropTemplate(kind: string, obj: ObjectKind, name: string): string {
  const keyword: Record<ObjectKind, string> = {
    view: "VIEW",
    function: "FUNCTION",
    procedure: "PROCEDURE",
    trigger: "TRIGGER",
    sequence: "SEQUENCE",
  };
  if (kind === "mysql" && obj === "trigger") {
    return `DROP TRIGGER ${quoteIdent(kind, name)};`;
  }
  if (kind === "mssql" && obj === "trigger") {
    return `DROP TRIGGER ${quoteIdent(kind, name)};`;
  }
  return `DROP ${keyword[obj]} ${quoteIdent(kind, name)};`;
}
