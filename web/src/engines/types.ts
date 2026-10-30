import type { ErrorRule } from "../errorHelp";
import type { SqlDialect } from "./sqlDialect";

// What an engine can do. The engine's definition carries the defaults; once
// connected, the server's `meta.capabilities` gives the actual values (some
// depend on the server's version or the account's rights). Names are only
// ever added; a changed meaning gets a new name.
export interface Capabilities {
  // The query language: editor, statement splitting, safe mode, completion.
  language: string;
  // The kinds of objects the sidebar lists ("table", "view", "collection", …).
  objects: string[];
  // Where column information comes from: the catalog, or sampled documents.
  schema: "declared" | "sampled";
  // Cells (or fields) can be edited, and rows added and deleted, by key.
  edit_by_key: boolean;
  transactions: "always" | "replica_set" | "none";
  // ER diagram, JOIN suggestions and jumping along a foreign key.
  foreign_keys: boolean;
  // Structure editing, creating tables, the DDL tab.
  ddl: boolean;
  // "switch": the server has several databases and the connection can move
  // between them (and create and drop them); "list": it only lists them.
  databases: "switch" | "list" | "none";
  users: boolean;
  // How a query plan is read, or null when the engine has none to show.
  explain: "pg-json" | "mysql-json" | "sqlite" | "mongo" | "es-profile" | "oracle" | "cql-trace" | "clickhouse" | null;
  // Row counts are exact rather than estimated.
  exact_count: boolean;
  dump: "sql" | "ejson" | "es-bulk" | null;
  import_formats: string[];
  export_formats: string[];
  sessions: { kill: boolean };
  validation: boolean;
  aggregation: boolean;
  indexes: { create: boolean; drop: boolean };
  // A table's rows page by the server's paging token (CQL), not OFFSET;
  // absent from older servers and engines that page by OFFSET. A far page
  // is reached by the server walking the rows before it (/api/sql/skip).
  cursor_paging?: boolean;
  // An exact COUNT runs in steps the server splits (/api/sql/count), with
  // progress and a stop between them.
  count_steps?: boolean;
  // Stopping a running statement ends the session (SQL Server; an Oracle
  // session that can neither break the call nor cancel it from another
  // session), so an open transaction rolls back: Stop asks first inside one.
  cancel_ends_session?: boolean;
  // A binary cell (Oracle BLOB, RAW) is read whole and replaced from bytes
  // of any size through /api/sql/cell, past what the grid shows of it.
  binary_cells?: boolean;
}

export type FieldType =
  | "text"
  | "host"
  | "port"
  | "secret"
  | "file"
  | "path"
  | "select"
  | "toggle"
  | "uri"
  | "number"
  | "textarea";

export interface FieldOption {
  value: string;
  // An i18n key.
  label: string;
  // Other fields this choice sets as it is picked (X.509 turns TLS on).
  sets?: Record<string, string | boolean>;
}

export type FieldValue = string | number | boolean;

// Field values a field's visibility depends on, by field key.
export type FieldCondition = Record<string, FieldValue | FieldValue[]>;

// One field of an engine's connection form. Labels, descriptions and
// placeholders are i18n keys (the Korean text).
export interface ConnectionField {
  key: string;
  type: FieldType;
  label?: string;
  // Needed to save the profile.
  required?: boolean;
  // Needed to connect, though a profile can be saved without it.
  required_to_connect?: boolean;
  // Needed unless the named field (say, a connection string) is filled in.
  required_unless?: string;
  default?: FieldValue;
  // A select's choices, as objects or as bare values that are their own label.
  options?: (string | FieldOption)[];
  // Shown only while each named field has the given value (or one of the
  // listed values); a list of such conditions shows it when any one holds.
  visible_when?: FieldCondition | FieldCondition[];
  // Tucked away under "advanced".
  advanced?: boolean;
  // A pasted connection string that fills the other fields.
  fills_others?: boolean;
  schemes?: string[];
  // Consecutive fields with the same group share one row under this label.
  group?: string;
  // A toggle's text beside its switch.
  description?: string;
  placeholder?: string;
  // What changes while a condition holds (the user field reads "액세스 키
  // ID" for AWS); the first variant whose condition holds applies.
  variants?: FieldVariant[];
}

export interface FieldVariant {
  when: FieldCondition;
  label?: string;
  placeholder?: string;
  description?: string;
  required_to_connect?: boolean;
}

export interface ConnectionSpec {
  fields: ConnectionField[];
  // The tunnels the form offers; empty for none.
  tunnels: ("ssh" | "http")[];
  // The Home list's address line: field keys in braces, e.g. "{host} : {database}".
  summary: string;
  // The fuller address shown on hover, e.g. "{user}@{host}:{port}/{database}".
  detail: string;
}

// An engine as the server describes it (GET /api/engines). The server's JSON
// files are the source; the web bundles the same files for its first render.
export interface EngineDescriptor {
  // The name used in storage, the API and the keychain; it never changes.
  id: string;
  // URL schemes and former names that mean this engine.
  aliases: string[];
  label: string;
  paradigm: string;
  // Engines sharing a dialect (cockroach is "postgres", mariadb "mysql").
  family: string;
  transport: "server" | "file" | "memory";
  default_port?: number;
  url_schemes: string[];
  // The prefix of the engine's own error codes from the server ("mongo" → "mongo_11000").
  error_code_prefix?: string;
  capabilities: Capabilities;
  connection: ConnectionSpec;
}

export interface EngineIcon {
  color: string;
  viewBox: string;
  paths: string[];
}

// Extra advice an explained error gives for this engine, by situation.
export type ErrorHint =
  | "login_failed"
  | "unknown_database"
  | "syntax"
  | "unknown_table"
  | "unknown_column"
  | "connection_refused";

export interface EngineErrorHelp {
  // Recognizes this engine's own error text.
  detect: RegExp;
  // i18n keys, added to the shared explanation of the situation.
  hints: Partial<Record<ErrorHint, string[]>>;
  // Explanations of the engine's own errors, tried before the shared ones.
  rules?: ErrorRule[];
}

// The workbench a paradigm opens in ("search": Elasticsearch / OpenSearch).
export type Workbench = "sql" | "document" | "search";

// What only the web knows about an engine.
export interface EngineWebParts {
  icon: EngineIcon;
  workbench: Workbench;
  // The second line of the engine's card in the connection dialog (an i18n key).
  subtitle: string;
  // The file types offered when picking a file-based engine's database.
  fileExtensions?: string[];
  sql?: SqlDialect;
  errorHelp?: EngineErrorHelp;
}

export type Engine = EngineDescriptor & EngineWebParts;
