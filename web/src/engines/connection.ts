import type { ConnConfig } from "../store";
import { engineForUrl } from "./index";
import type { ConnectionField, Engine, FieldCondition, FieldOption, FieldValue } from "./types";

// The connection form's values, as typed: numbers stay text while editing.
export type FormValues = Record<string, string | boolean>;

export function optionsOf(field: ConnectionField): FieldOption[] {
  return (field.options ?? []).map((option) =>
    typeof option === "string" ? { value: option, label: option } : option,
  );
}

function holds(condition: FieldCondition, values: FormValues): boolean {
  return Object.entries(condition).every(([key, want]) => {
    const have = values[key];
    const wanted = Array.isArray(want) ? want : [want];
    return wanted.some((value) => String(value) === String(have));
  });
}

// Whether a field shows, given the form's other values.
export function fieldVisible(field: ConnectionField, values: FormValues): boolean {
  if (field.visible_when === undefined) {
    return true;
  }
  const conditions = Array.isArray(field.visible_when) ? field.visible_when : [field.visible_when];
  return conditions.some((condition) => holds(condition, values));
}

// The field as the form's other values make it: its first variant whose
// condition holds overrides its label, placeholder and the like.
export function fieldFor(field: ConnectionField, values: FormValues): ConnectionField {
  const variant = field.variants?.find((candidate) => holds(candidate.when, values));
  return variant === undefined ? field : { ...field, ...variant };
}

// A select's value with the other fields its choice sets (see FieldOption.sets).
export function choiceValues(field: ConnectionField, value: string): FormValues {
  return { ...optionsOf(field).find((option) => option.value === value)?.sets, [field.key]: value };
}

function formValue(field: ConnectionField, value: FieldValue | null | undefined): string | boolean {
  if (field.type === "toggle") {
    return typeof value === "boolean" ? value : value === "true";
  }
  return value === undefined || value === null ? "" : String(value);
}

// A new connection's form: each field at its default.
export function defaultValues(engine: Engine): FormValues {
  const values: FormValues = {};
  for (const field of engine.connection.fields) {
    values[field.key] = formValue(field, field.default ?? (field.type === "port" ? engine.default_port : undefined));
  }
  return values;
}

// A saved profile's settings as form values; fields it lacks take their defaults.
export function valuesFromConfig(engine: Engine, config: ConnConfig): FormValues {
  const values = defaultValues(engine);
  for (const field of engine.connection.fields) {
    if (field.type !== "secret" && config[field.key] !== undefined && config[field.key] !== null) {
      values[field.key] = formValue(field, config[field.key]);
    }
  }
  return values;
}

// The settings sent to the server: only the fields that show, text trimmed,
// numbers as numbers. Secrets and optional files go only when filled in.
export function configFromValues(engine: Engine, values: FormValues): ConnConfig {
  const config: ConnConfig = {};
  for (const field of engine.connection.fields) {
    if (!fieldVisible(field, values)) {
      continue;
    }
    const value = values[field.key];
    if (field.type === "toggle") {
      config[field.key] = value === true;
      continue;
    }
    const text = typeof value === "string" ? value : "";
    if (field.type === "secret") {
      if (text !== "") {
        config[field.key] = text;
      }
    } else if (field.type === "port" || field.type === "number") {
      if (text.trim() !== "") {
        config[field.key] = Number(text.trim());
      }
    } else if (field.type === "file") {
      if (text.trim() !== "") {
        config[field.key] = text.trim();
      }
    } else if (field.type === "select") {
      config[field.key] = text;
    } else {
      config[field.key] = text.trim();
    }
  }
  return config;
}

// A saved profile's settings sent back as they are, minus fields that no longer show.
export function cleanConfig(engine: Engine, config: ConnConfig): ConnConfig {
  return configFromValues(engine, valuesFromConfig(engine, config));
}

// A connection template ("{host} : {database}") filled with a profile's values.
// A placeholder whose value is empty drops the separator text just before it,
// and so does the first value shown.
export function fillTemplate(template: string, config: ConnConfig): string {
  let out = "";
  for (const [, separator, key] of template.matchAll(/([^{}]*)\{(\w+)\}/g)) {
    const found = config[key];
    const text = found === undefined || found === null ? "" : String(found);
    if (text !== "") {
      out += out === "" ? text : `${separator}${text}`;
    }
  }
  return out;
}

// The values a template shows, one per placeholder.
export function templateValues(template: string, config: ConnConfig): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map(([, key]) => {
    const found = config[key];
    return found === undefined || found === null ? "" : String(found);
  });
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export interface ParsedUrl {
  engine: Engine;
  values: FormValues;
}

// What a newly entered connection URL takes back from the one before it. A
// URL speaks for every field it fills, so a field the previous URL filled
// that the new one doesn't mention returns to its default (TLS, certificate
// files, the mechanism, replica set, read preference and the like), and so
// do the values a select's earlier choice set (X.509's TLS) once the new URL
// picks another option. A field typed by hand stays unless the new URL says
// something else for it. `filled` is the keys the previous URL filled and no
// hand has touched since; `values` the form as it is.
export function staleUrlValues(
  engine: Engine,
  values: FormValues,
  filled: ReadonlySet<string>,
  parsed: FormValues,
): FormValues {
  const stale = new Set(filled);
  for (const field of engine.connection.fields) {
    const next = parsed[field.key];
    if (field.type === "select" && next !== undefined && next !== values[field.key]) {
      const was = optionsOf(field).find((option) => option.value === values[field.key]);
      for (const key of Object.keys(was?.sets ?? {})) {
        stale.add(key);
      }
    }
  }
  const defaults = defaultValues(engine);
  const reset: FormValues = {};
  for (const key of stale) {
    if (parsed[key] === undefined && key in defaults) {
      reset[key] = defaults[key];
    }
  }
  return reset;
}

// "postgres://user:pass@host:5432/db?sslmode=require", optionally "jdbc:"-prefixed:
// the engine its scheme names and the form values it fills, for the fields that
// engine has. The certificate files come from libpq's sslrootcert, sslcert and
// sslkey (MySQL's ssl-ca, ssl-cert, ssl-key).
export function parseConnectionUrl(text: string): ParsedUrl | null {
  const trimmed = text.trim().replace(/^jdbc:/i, "");
  const engine = engineForUrl(trimmed);
  if (engine === undefined) {
    return null;
  }
  if (engine.connection.fields.some((field) => field.type === "uri" && field.fills_others === true)) {
    return parseConnectionString(engine, trimmed);
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const has = new Set(engine.connection.fields.map((field) => field.key));
  const values: FormValues = {};
  const set = (key: string, value: string | null): void => {
    if (has.has(key) && value) {
      values[key] = value;
    }
  };
  set("port", url.port || (engine.default_port !== undefined ? String(engine.default_port) : ""));
  if (url.hostname !== "") {
    set("host", safeDecode(url.hostname.replace(/^\[|\]$/g, "")));
  }
  set("user", url.username !== "" ? safeDecode(url.username) : url.searchParams.get("user"));
  set("password", url.password !== "" ? safeDecode(url.password) : url.searchParams.get("password"));
  set("database", safeDecode(url.pathname.replace(/^\/+/, "")));
  const ssl = (url.searchParams.get("sslmode") ?? url.searchParams.get("ssl-mode") ?? "").toLowerCase();
  if (ssl !== "") {
    set(
      "ssl_mode",
      ssl === "disable" || ssl === "disabled"
        ? "disable"
        : ssl === "prefer" || ssl === "preferred" || ssl === "allow"
          ? "prefer"
          : "require",
    );
  }
  set("ssl_root_cert", url.searchParams.get("sslrootcert") ?? url.searchParams.get("ssl-ca"));
  set("ssl_client_cert", url.searchParams.get("sslcert") ?? url.searchParams.get("ssl-cert"));
  set("ssl_client_key", url.searchParams.get("sslkey") ?? url.searchParams.get("ssl-key"));
  return { engine, values };
}

const TRUE_TEXT = /^(true|1|yes)$/i;

// A MongoDB-style connection string, "mongodb://user:pw@host:27017/db?authSource=admin":
// the form's fields from it. One plain host fills host and port and leaves
// the connection-string field empty; a seed list or an SRV name can only be
// said by the string, which then stays (without its password, which goes to
// the password field and so never into the saved profile).
function parseConnectionString(engine: Engine, text: string): ParsedUrl | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^/?]+)(?:\/([^?]*))?(?:\?(.*))?$/i.exec(text);
  if (match === null) {
    return null;
  }
  const [, scheme, user, password, hostList, database, query] = match;
  const has = new Map(engine.connection.fields.map((field) => [field.key, field]));
  const values: FormValues = {};
  const set = (key: string, value: string | boolean | undefined): void => {
    const field = has.get(key);
    if (field === undefined || value === undefined || value === "") {
      return;
    }
    values[key] = field.type === "toggle" ? value === true || (typeof value === "string" && TRUE_TEXT.test(value)) : String(value);
  };
  if (user !== undefined) {
    set("user", safeDecode(user));
  }
  if (password !== undefined) {
    set("password", safeDecode(password));
  }
  set("database", safeDecode(database ?? ""));
  const params = new URLSearchParams(query ?? "");
  const named: Record<string, string> = {
    authsource: "auth_source",
    authmechanism: "auth_mechanism",
    directconnection: "direct_connection",
    replicaset: "replica_set",
    readpreference: "read_preference",
    tls: "tls",
    ssl: "tls",
    tlscafile: "tls_ca_file",
    tlscertificatekeyfile: "tls_cert_key_file",
  };
  for (const [name, value] of params) {
    const key = named[name.toLowerCase()];
    if (key !== undefined) {
      set(key, value);
    }
  }
  // authMechanismProperties=SERVICE_NAME:mongo,TOKEN_RESOURCE:api://x: the
  // fields they stand for (a value may hold colons; the name never does).
  // CANONICALIZE_HOST_NAME may also be true or false.
  const canonicalize: Record<string, string> = { true: "forwardAndReverse", false: "none" };
  const properties: Record<string, string> = {
    service_name: "kerberos_service_name",
    service_realm: "kerberos_service_realm",
    service_host: "kerberos_service_host",
    canonicalize_host_name: "kerberos_canonicalize",
    environment: "oidc_flow",
    token_resource: "oidc_token_resource",
    aws_session_token: "aws_session_token",
  };
  for (const pair of (params.get("authMechanismProperties") ?? "").split(",")) {
    const colon = pair.indexOf(":");
    const key = colon > 0 ? properties[pair.slice(0, colon).toLowerCase()] : undefined;
    if (key !== undefined) {
      const value = pair.slice(colon + 1);
      set(key, key === "kerberos_canonicalize" ? (canonicalize[value] ?? value) : value);
    }
  }
  // The authentication the string says: a mechanism with a choice of its
  // own (X.509, AWS, PLAIN for LDAP, GSSAPI for Kerberos, OIDC; never a
  // password's mechanism), a password by a user, else none. What the
  // choice sets (X.509's TLS) yields to what the string says.
  const auth = has.get("auth");
  if (auth !== undefined) {
    const own: Record<string, string> = {
      "MONGODB-X509": "x509",
      "MONGODB-AWS": "aws",
      PLAIN: "ldap",
      GSSAPI: "kerberos",
      "MONGODB-OIDC": "oidc",
    };
    const mechanism = own[String(values.auth_mechanism ?? "").toUpperCase()];
    if (mechanism !== undefined) {
      delete values.auth_mechanism;
    }
    const choice = mechanism ?? (values.user !== undefined ? "password" : "none");
    for (const [key, value] of Object.entries(choiceValues(auth, choice))) {
      if (key === auth.key || values[key] === undefined) {
        values[key] = value;
      }
    }
    if (choice === "oidc" && values.oidc_flow === undefined) {
      values.oidc_flow = "human";
    }
  }
  const single = !scheme.toLowerCase().endsWith("+srv") && !hostList.includes(",");
  const hostPort = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostList);
  if (single && hostPort !== null) {
    set("host", safeDecode(hostPort[1].replace(/^\[|\]$/g, "")));
    set("port", hostPort[2] ?? (engine.default_port !== undefined ? String(engine.default_port) : ""));
    values.uri = "";
  } else {
    const rest = query !== undefined ? `?${query}` : "";
    values.uri = `${scheme}://${user !== undefined ? `${user}@` : ""}${hostList}/${database ?? ""}${rest}`;
    values.host = "";
  }
  return { engine, values };
}
