// 코드로 (MONGODB.md §8.1): a find or an aggregation of the collection tab
// as code for a driver — PyMongo, the Node.js driver, the Java sync driver,
// the .NET driver, the Go driver (v2), the Rust driver, the PHP library,
// the Ruby driver — or for mongosh. Every BSON value is written with the
// language's own type for it (ObjectId, Decimal128, Int64, dates, regular
// expressions, binary and UUID, …), so the code sends exactly what the tab
// sent. With a connection string the code is a whole program that connects,
// runs the query and prints each document; without one it is the query
// alone and expects a connected `client`.
//
// Pure: no React, no requests. The connection string never holds the
// password; `connectionUri` writes `<password>` where it goes.

import { isDocument, doubleText, base64ToHex, type BsonDocument, type BsonValue } from "./bson";
import { shellCollection, toShell } from "./format";

export type CodeLanguage = "mongosh" | "python" | "node" | "java" | "csharp" | "go" | "rust" | "php" | "ruby";

export const CODE_LANGUAGES: { id: CodeLanguage; label: string }[] = [
  { id: "mongosh", label: "mongosh" },
  { id: "python", label: "Python (PyMongo)" },
  { id: "node", label: "Node.js" },
  { id: "java", label: "Java (sync)" },
  { id: "csharp", label: "C# (.NET)" },
  { id: "go", label: "Go" },
  { id: "rust", label: "Rust" },
  { id: "php", label: "PHP" },
  { id: "ruby", label: "Ruby" },
];

// What the code runs. `skip` and `limit` 0 mean none.
export type CodeSource =
  | { kind: "find"; filter: BsonDocument; projection: BsonDocument | null; sort: BsonDocument | null; skip: number; limit: number }
  | { kind: "aggregate"; pipeline: BsonDocument[] };

// The query bar's 옵션 that change how the server runs the query.
export interface CodeOptions {
  collation?: BsonDocument | null;
  hint?: string | BsonDocument | null;
  maxTimeMS?: number | null;
}

export interface CodeRequest {
  db: string;
  coll: string;
  source: CodeSource;
  options?: CodeOptions;
  // A connection string (without the password): the code connects and
  // prints the documents. Null: only the query, for a connected `client`.
  uri: string | null;
}

export function generateCode(language: CodeLanguage, request: CodeRequest): string {
  const q = normalize(request);
  switch (language) {
    case "mongosh":
      return mongosh(q);
    case "python":
      return python(q);
    case "node":
      return node(q);
    case "java":
      return java(q);
    case "csharp":
      return csharp(q);
    case "go":
      return golang(q);
    case "rust":
      return rust(q);
    case "php":
      return php(q);
    case "ruby":
      return ruby(q);
  }
}

// ---- The connection string ----

type ConfigValue = string | number | boolean | null | undefined;

// A connection string for a saved profile's settings (the engine's form
// fields: host, port, auth, user, auth_source, …), without the password:
// where one belongs it says `<password>`. `placeholder` tells whether it does.
export function connectionUri(config: Record<string, ConfigValue | unknown>): { uri: string; placeholder: boolean } {
  const text = (key: string): string => {
    const v = config[key];
    return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  };
  const on = (key: string): boolean => config[key] === true || config[key] === "true";
  let scheme = "mongodb";
  let hosts = `${text("host") || "localhost"}:${text("port") || "27017"}`;
  let userInUri = "";
  let path = "";
  const params = new URLSearchParams();
  const given = text("uri");
  const match = given === "" ? null : /^([a-z][a-z0-9+.-]*):\/\/(?:([^:@/]*)(?::[^@/]*)?@)?([^/?]+)(?:\/([^?]*))?(?:\?(.*))?$/i.exec(given);
  if (match !== null) {
    scheme = match[1];
    userInUri = match[2] ?? "";
    hosts = match[3];
    path = match[4] ?? "";
    for (const [k, v] of new URLSearchParams(match[5] ?? "")) {
      params.set(k, v);
    }
  }
  const user = text("user") !== "" ? encodeURIComponent(text("user")) : userInUri;
  const auth = text("auth") || (user !== "" ? "password" : "none");
  const set = (key: string, value: string) => {
    if (value !== "" && !params.has(key)) {
      params.set(key, value);
    }
  };
  let credentials = "";
  let placeholder = false;
  switch (auth) {
    case "password":
      credentials = user !== "" ? `${user}:<password>@` : "";
      placeholder = user !== "";
      set("authSource", text("auth_source"));
      set("authMechanism", text("auth_mechanism"));
      break;
    case "ldap":
      credentials = `${user}:<password>@`;
      placeholder = true;
      set("authMechanism", "PLAIN");
      set("authSource", "$external");
      break;
    case "aws":
      // An access key and its secret, or the environment's credentials.
      credentials = user !== "" ? `${user}:<password>@` : "";
      placeholder = user !== "";
      set("authMechanism", "MONGODB-AWS");
      break;
    case "kerberos": {
      credentials = user !== "" ? `${user}@` : "";
      set("authMechanism", "GSSAPI");
      set("authSource", "$external");
      const props = [`SERVICE_NAME:${text("kerberos_service_name") || "mongodb"}`];
      if (text("kerberos_service_realm") !== "") props.push(`SERVICE_REALM:${text("kerberos_service_realm")}`);
      if (text("kerberos_service_host") !== "") props.push(`SERVICE_HOST:${text("kerberos_service_host")}`);
      if (text("kerberos_canonicalize") !== "" && text("kerberos_canonicalize") !== "none") props.push(`CANONICALIZE_HOST_NAME:${text("kerberos_canonicalize")}`);
      set("authMechanismProperties", props.join(","));
      break;
    }
    case "x509":
      set("authMechanism", "MONGODB-X509");
      break;
    case "oidc": {
      credentials = user !== "" ? `${user}@` : "";
      set("authMechanism", "MONGODB-OIDC");
      const flow = text("oidc_flow");
      if (flow === "azure" || flow === "gcp" || flow === "k8s") {
        const props = [`ENVIRONMENT:${flow}`];
        if (text("oidc_token_resource") !== "") props.push(`TOKEN_RESOURCE:${text("oidc_token_resource")}`);
        set("authMechanismProperties", props.join(","));
      }
      break;
    }
  }
  set("replicaSet", text("replica_set"));
  if (on("direct_connection")) set("directConnection", "true");
  set("readPreference", text("read_preference"));
  if (on("tls") || auth === "x509") set("tls", "true");
  set("tlsCAFile", text("tls_ca_file"));
  set("tlsCertificateKeyFile", text("tls_cert_key_file"));
  // Percent-encoding ":", ",", "/" and "$" (mechanism properties, file
  // paths, $external) is optional for drivers; plain is easier to read.
  const query = [...params].map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%(3A|2C|2F|24)/gi, (m) => decodeURIComponent(m))}`).join("&");
  return { uri: `${scheme}://${credentials}${hosts}/${path}${query !== "" ? `?${query}` : ""}`, placeholder };
}

// ---- Layout ----

// Code as a tree a printer lays out: on one line when it fits the width,
// otherwise one item per line, indented.
type Node =
  | { k: "leaf"; text: string }
  | { k: "list"; open: string; close: string; items: Item[]; pad: boolean; trailing: boolean }
  // A method chain (Java's `.append(…)`, builders): the head, then each
  // part on its own line when it does not fit.
  | { k: "chain"; parts: Item[] };

interface Item {
  pre: string;
  node: Node;
  post: string;
}

interface Style {
  width: number;
  indent: string;
  // Indent levels of a chain's continuation lines.
  chain: number;
  // Lists end with a comma after their last item when laid out on lines.
  trailing: boolean;
}

const leaf = (text: string): Node => ({ k: "leaf", text });
const item = (node: Node, pre = "", post = ""): Item => ({ pre, node, post });

function list(open: string, close: string, items: Item[], pad = false, trailing?: boolean): Node {
  return { k: "list", open, close, items, pad, trailing: trailing ?? true };
}

// `name(arg, arg)`.
function call(name: string, args: Node[]): Node {
  return list(`${name}(`, ")", args.map((a) => item(a)), false, false);
}

function chain(parts: Item[]): Node {
  return parts.length === 1 && parts[0].pre === "" && parts[0].post === "" ? parts[0].node : { k: "chain", parts };
}

function flat(n: Node): string {
  if (n.k === "leaf") {
    return n.text;
  }
  if (n.k === "chain") {
    return n.parts.map((p) => p.pre + flat(p.node) + p.post).join("");
  }
  if (n.items.length === 0) {
    return n.open + n.close;
  }
  const inner = n.items.map((p) => p.pre + flat(p.node) + p.post).join(", ");
  return n.pad ? `${n.open} ${inner} ${n.close}` : n.open + inner + n.close;
}

function columns(text: string): number {
  return text.replace(/\t/g, "    ").length;
}

function render(n: Node, depth: number, col: number, s: Style): string {
  if (n.k === "leaf") {
    return n.text;
  }
  const one = flat(n);
  if (col + one.length <= s.width) {
    return one;
  }
  if (n.k === "chain") {
    const [head, ...rest] = n.parts;
    let out = head.pre + render(head.node, depth, col + columns(head.pre), s) + head.post;
    const pad = s.indent.repeat(depth + s.chain);
    for (const p of rest) {
      out += `\n${pad}${p.pre}${render(p.node, depth + s.chain, columns(pad + p.pre), s)}${p.post}`;
    }
    return out;
  }
  if (n.items.length === 0) {
    return n.open + n.close;
  }
  const pad = s.indent.repeat(depth + 1);
  const lines = n.items.map((p) => pad + p.pre + render(p.node, depth + 1, columns(pad + p.pre), s) + p.post);
  return `${n.open}\n${lines.join(",\n")}${n.trailing && s.trailing ? "," : ""}\n${s.indent.repeat(depth)}${n.close}`;
}

// `prefix` + the node + `suffix` as a statement at `depth`.
function statement(prefix: string, n: Node, suffix: string, depth: number, s: Style): string {
  const pad = s.indent.repeat(depth);
  return `${pad}${prefix}${render(n, depth, columns(pad + prefix), s)}${suffix}`;
}

// ---- Shared pieces ----

interface Query {
  db: string;
  coll: string;
  source: CodeSource;
  collation: BsonDocument | null;
  hint: string | BsonDocument | null;
  maxTimeMS: number | null;
  uri: string | null;
}

function normalize(r: CodeRequest): Query {
  const o = r.options ?? {};
  const hint = o.hint ?? null;
  return {
    db: r.db,
    coll: r.coll,
    source: r.source,
    collation: o.collation != null && o.collation.size > 0 ? o.collation : null,
    hint: typeof hint === "string" ? (hint.trim() === "" ? null : hint) : hint !== null && hint.size > 0 ? hint : null,
    maxTimeMS: o.maxTimeMS != null && o.maxTimeMS > 0 ? Math.floor(o.maxTimeMS) : null,
    uri: r.uri,
  };
}

// What a piece of code needs imported, collected while values are written.
class Uses {
  private readonly set = new Set<string>();
  add(name: string): void {
    this.set.add(name);
  }
  has(name: string): boolean {
    return this.set.has(name);
  }
  sorted(names: readonly string[]): string[] {
    return names.filter((n) => this.set.has(n));
  }
}

// The collation's fields with the types the typed drivers' builders take.
interface CollationFields {
  locale: string | null;
  strength: number | null;
  caseLevel: boolean | null;
  caseFirst: string | null;
  numericOrdering: boolean | null;
  alternate: string | null;
  maxVariable: string | null;
  normalization: boolean | null;
  backwards: boolean | null;
}

function numberOf(v: BsonValue | undefined): number | null {
  if (v === undefined || v === null || typeof v !== "object" || Array.isArray(v) || isDocument(v)) {
    return null;
  }
  switch (v.type) {
    case "Int32":
    case "Double":
      return v.value;
    case "Int64":
      return Number(v.value);
    case "Decimal128":
      return Number(v.value);
    default:
      return null;
  }
}

function collationFields(doc: BsonDocument): CollationFields {
  const str = (k: string) => {
    const v = doc.get(k);
    return typeof v === "string" ? v : null;
  };
  const bool = (k: string) => {
    const v = doc.get(k);
    return typeof v === "boolean" ? v : null;
  };
  return {
    locale: str("locale"),
    strength: numberOf(doc.get("strength")),
    caseLevel: bool("caseLevel"),
    caseFirst: str("caseFirst"),
    numericOrdering: bool("numericOrdering"),
    alternate: str("alternate"),
    maxVariable: str("maxVariable"),
    normalization: bool("normalization"),
    backwards: bool("backwards"),
  };
}

const STRENGTH_NAMES = ["", "Primary", "Secondary", "Tertiary", "Quaternary", "Identical"];

function pascal(text: string): string {
  return text.replace(/(^|[^A-Za-z0-9])([a-z])/g, (_, __, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, "");
}

// UTC parts of a date when a year 1–9999 calendar holds it, else null.
interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
  iso: string;
}

function dateParts(ms: bigint): DateParts | null {
  if (ms < -62135596800000n || ms > 253402300799999n) {
    return null;
  }
  const d = new Date(Number(ms));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    ms: d.getUTCMilliseconds(),
    iso: d.toISOString(),
  };
}

// The Unicode code points of `s` (lone surrogates as themselves).
function codePoints(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    out.push(ch.codePointAt(0) ?? 0);
  }
  return out;
}

function isControl(cp: number): boolean {
  return cp < 0x20 || cp === 0x7f || cp === 0x2028 || cp === 0x2029;
}

// A double-quoted literal with C-style escapes; `unicode` writes the other
// control characters.
function quoted(s: string, unicode: (cp: number) => string, extra: Record<string, string> = {}): string {
  let out = '"';
  for (const cp of codePoints(s)) {
    const ch = String.fromCodePoint(cp);
    if (extra[ch] !== undefined) {
      out += extra[ch];
    } else if (ch === '"' || ch === "\\") {
      out += `\\${ch}`;
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (ch === "\t") {
      out += "\\t";
    } else if (isControl(cp)) {
      out += unicode(cp);
    } else {
      out += ch;
    }
  }
  return `${out}"`;
}

// A single-quoted literal where only `\` and `'` need escaping (PHP, Ruby),
// or null when the text holds a control character.
function singleQuoted(s: string): string | null {
  return codePoints(s).some(isControl) ? null : `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0");

function binaryHex(base64: string): string {
  return base64ToHex(base64) ?? "";
}

// ---- mongosh ----

// mongosh reads numbers as JavaScript does, so a double that is a whole
// number needs Double(…) to stay a double, and a regex literal sends its
// source as written (a "/" escaped), so such patterns use BSONRegExp.
function shValue(v: BsonValue): Node {
  if (v === null) return leaf("null");
  if (typeof v === "string") return leaf(JSON.stringify(v));
  if (typeof v === "boolean") return leaf(String(v));
  if (Array.isArray(v)) return list("[", "]", v.map((x) => item(shValue(x))), false, false);
  if (isDocument(v)) return v.size === 0 ? leaf("{}") : list("{", "}", [...v].map(([k, x]) => item(shValue(x), `${JS_KEY.test(k) ? k : JSON.stringify(k)}: `)), true, false);
  switch (v.type) {
    case "ObjectId":
      return leaf(`ObjectId('${v.hex}')`);
    case "Int32":
      return leaf(String(v.value));
    case "Int64":
      return leaf(`Long('${v.value}')`);
    case "Double": {
      const n = v.value;
      if (Number.isNaN(n)) return leaf("NaN");
      if (!Number.isFinite(n)) return leaf(n > 0 ? "Infinity" : "-Infinity");
      return leaf(Number.isInteger(n) ? `Double(${Object.is(n, -0) ? "-0" : String(n)})` : String(n));
    }
    case "Decimal128":
      return leaf(`NumberDecimal('${v.value}')`);
    case "Date": {
      const iso = v.iso();
      return leaf(iso !== null ? `ISODate('${iso}')` : `new Date(${v.ms})`);
    }
    case "Binary": {
      const uuid = v.uuid();
      return leaf(uuid !== null ? `UUID('${uuid}')` : `Binary.createFromBase64('${v.base64}', ${v.subType})`);
    }
    case "Regex":
      if (/^[ims]*$/.test(v.options) && v.pattern !== "" && !/[/\n\r\u2028\u2029]/.test(v.pattern) && validJsRegex(v.pattern, v.options)) {
        return leaf(`/${v.pattern}/${v.options}`);
      }
      return leaf(`BSONRegExp(${JSON.stringify(v.pattern)}, "${v.options}")`);
    case "Timestamp":
      return leaf(`Timestamp({ t: ${v.t}, i: ${v.i} })`);
    case "Code":
      return v.scope === null ? leaf(`Code(${JSON.stringify(v.code)})`) : call("Code", [leaf(JSON.stringify(v.code)), shValue(v.scope)]);
    case "MinKey":
      return leaf("MinKey()");
    case "MaxKey":
      return leaf("MaxKey()");
    case "Undefined":
      return leaf("undefined");
  }
}

const SH: Style = { width: 80, indent: "  ", chain: 1, trailing: false };

function mongosh(q: Query): string {
  const coll = shellCollection(q.coll);
  const head: string[] = [];
  if (q.uri !== null) {
    head.push(`// mongosh ${JSON.stringify(q.uri)}`);
  }
  head.push(`use ${q.db}`);
  let statementText: string;
  if (q.source.kind === "find") {
    const f = q.source;
    const args = [item(shValue(f.filter))];
    if (f.projection !== null) args.push(item(shValue(f.projection)));
    const more: string[] = [];
    if (f.sort !== null) more.push(`.sort(${flat(shValue(f.sort))})`);
    if (f.skip > 0) more.push(`.skip(${f.skip})`);
    if (f.limit > 0) more.push(`.limit(${f.limit})`);
    if (q.collation !== null) more.push(`.collation(${flat(shValue(q.collation))})`);
    if (q.hint !== null) more.push(`.hint(${typeof q.hint === "string" ? JSON.stringify(q.hint) : flat(shValue(q.hint))})`);
    if (q.maxTimeMS !== null) more.push(`.maxTimeMS(${q.maxTimeMS})`);
    // On the call's last line: mongosh's prompt reads a line that starts
    // with "." as a REPL command, so the chain cannot continue below.
    statementText = statement("", list(`${coll}.find(`, ")", args, false, false), more.join(""), 0, SH);
  } else {
    const args = [item(shValue(q.source.pipeline))];
    const opts: Item[] = [];
    if (q.collation !== null) opts.push(item(shValue(q.collation), "collation: "));
    if (q.hint !== null) opts.push(item(typeof q.hint === "string" ? leaf(JSON.stringify(q.hint)) : shValue(q.hint), "hint: "));
    if (q.maxTimeMS !== null) opts.push(item(leaf(String(q.maxTimeMS)), "maxTimeMS: "));
    if (opts.length > 0) args.push(item(list("{", "}", opts, true, false)));
    statementText = statement("", list(`${coll}.aggregate(`, ")", args, false, false), "", 0, SH);
  }
  return joinBlocks([head, [statementText]]);
}

// The options as the app's mongosh text writes them on a cursor:
// `.collation({…})`, `.hint(…)`, `.maxTimeMS(n)` (the explain and export
// dialogs' command lines).
export function shellCursorOptions(o: CodeOptions | undefined): string[] {
  const out: string[] = [];
  if (o?.collation) out.push(`.collation(${toShell(o.collation)})`);
  if (o?.hint) out.push(`.hint(${typeof o.hint === "string" ? JSON.stringify(o.hint) : toShell(o.hint)})`);
  if (o?.maxTimeMS != null) out.push(`.maxTimeMS(${o.maxTimeMS})`);
  return out;
}

// ---- Python (PyMongo) ----

const PY: Style = { width: 88, indent: "    ", chain: 1, trailing: true };

function pyValue(v: BsonValue, u: Uses): Node {
  if (v === null) return leaf("None");
  if (typeof v === "string") return leaf(JSON.stringify(v));
  if (typeof v === "boolean") return leaf(v ? "True" : "False");
  if (Array.isArray(v)) return list("[", "]", v.map((x) => item(pyValue(x, u))));
  if (isDocument(v)) return list("{", "}", [...v].map(([k, x]) => item(pyValue(x, u), `${JSON.stringify(k)}: `)));
  switch (v.type) {
    case "ObjectId":
      u.add("ObjectId");
      return leaf(`ObjectId("${v.hex}")`);
    case "Int32":
      return leaf(String(v.value));
    case "Int64":
      u.add("Int64");
      return leaf(`Int64(${v.value})`);
    case "Double":
      return leaf(Number.isNaN(v.value) ? 'float("nan")' : !Number.isFinite(v.value) ? (v.value > 0 ? 'float("inf")' : 'float("-inf")') : doubleText(v.value));
    case "Decimal128":
      u.add("Decimal128");
      return leaf(`Decimal128("${v.value}")`);
    case "Date": {
      const p = dateParts(v.ms);
      if (p === null) {
        u.add("DatetimeMS");
        return leaf(`DatetimeMS(${v.ms})`);
      }
      u.add("datetime");
      const micro = p.ms > 0 ? `, ${p.ms * 1000}` : "";
      return leaf(`datetime(${p.year}, ${p.month}, ${p.day}, ${p.hour}, ${p.minute}, ${p.second}${micro}, tzinfo=timezone.utc)`);
    }
    case "Binary": {
      u.add("Binary");
      const uuid = v.uuid();
      if (uuid !== null) {
        u.add("uuid");
        return leaf(`Binary.from_uuid(uuid.UUID("${uuid}"))`);
      }
      return leaf(`Binary(bytes.fromhex("${binaryHex(v.base64)}")${v.subType !== 0 ? `, ${v.subType}` : ""})`);
    }
    case "Regex":
      u.add("Regex");
      return leaf(`Regex(${JSON.stringify(v.pattern)}${v.options !== "" ? `, "${v.options}"` : ""})`);
    case "Timestamp":
      u.add("Timestamp");
      return leaf(`Timestamp(${v.t}, ${v.i})`);
    case "Code":
      u.add("Code");
      return v.scope === null ? leaf(`Code(${JSON.stringify(v.code)})`) : call("Code", [leaf(JSON.stringify(v.code)), pyValue(v.scope, u)]);
    case "MinKey":
      u.add("MinKey");
      return leaf("MinKey()");
    case "MaxKey":
      u.add("MaxKey");
      return leaf("MaxKey()");
    case "Undefined":
      return leaf("None");
  }
}

// PyMongo takes sort and hint keys as (key, direction) pairs.
function pyPairs(doc: BsonDocument, u: Uses): Node {
  return list("[", "]", [...doc].map(([k, x]) => item(list("(", ")", [item(leaf(JSON.stringify(k))), item(pyValue(x, u))], false, false))));
}

function python(q: Query): string {
  const u = new Uses();
  const body: string[] = [];
  const args: Item[] = [];
  let call0: string;
  if (q.source.kind === "find") {
    const f = q.source;
    body.push(statement("query = ", pyValue(f.filter, u), "", 0, PY));
    args.push(item(leaf("query")));
    if (f.projection !== null) {
      body.push(statement("projection = ", pyValue(f.projection, u), "", 0, PY));
      args.push(item(leaf("projection")));
    }
    if (f.sort !== null) args.push(item(pyPairs(f.sort, u), "sort="));
    if (f.skip > 0) args.push(item(leaf(String(f.skip)), "skip="));
    if (f.limit > 0) args.push(item(leaf(String(f.limit)), "limit="));
    call0 = "collection.find(";
  } else {
    body.push(statement("pipeline = ", pyValue(q.source.pipeline, u), "", 0, PY));
    args.push(item(leaf("pipeline")));
    call0 = "collection.aggregate(";
  }
  if (q.collation !== null) args.push(item(pyValue(q.collation, u), "collation="));
  if (q.hint !== null) args.push(item(typeof q.hint === "string" ? leaf(JSON.stringify(q.hint)) : pyPairs(q.hint, u), "hint="));
  if (q.maxTimeMS !== null) args.push(item(leaf(String(q.maxTimeMS)), q.source.kind === "find" ? "max_time_ms=" : "maxTimeMS="));
  body.push(statement("cursor = ", list(call0, ")", args), "", 0, PY));
  body.push("for doc in cursor:", "    print(doc)");

  const imports: string[] = [];
  if (u.has("datetime")) imports.push("from datetime import datetime, timezone");
  if (u.has("uuid")) imports.push("import uuid");
  if (imports.length > 0) imports.push("");
  const bsonNames = u.sorted(["Binary", "Code", "DatetimeMS", "Decimal128", "Int64", "MaxKey", "MinKey", "ObjectId", "Regex", "Timestamp"]);
  if (bsonNames.length > 0) imports.push(`from bson import ${bsonNames.join(", ")}`);
  if (q.uri !== null) imports.push("from pymongo import MongoClient");
  const head: string[] = [];
  if (q.uri !== null) head.push(`client = MongoClient(${JSON.stringify(q.uri)})`);
  head.push(`collection = client[${JSON.stringify(q.db)}][${JSON.stringify(q.coll)}]`);
  return joinBlocks([imports, head, body]);
}

// Blocks of lines with a blank line between non-empty ones.
function joinBlocks(blocks: string[][]): string {
  return `${blocks
    .filter((b) => b.length > 0)
    .map((b) => b.join("\n"))
    .join("\n\n")}\n`;
}

// ---- Node.js ----

const JS: Style = { width: 80, indent: "  ", chain: 1, trailing: true };
const JS_KEY = /^[A-Za-z_$][\w$]*$/;

function jsValue(v: BsonValue, u: Uses): Node {
  if (v === null) return leaf("null");
  if (typeof v === "string") return leaf(JSON.stringify(v));
  if (typeof v === "boolean") return leaf(String(v));
  if (Array.isArray(v)) return list("[", "]", v.map((x) => item(jsValue(x, u))));
  if (isDocument(v)) return v.size === 0 ? leaf("{}") : list("{", "}", [...v].map(([k, x]) => item(jsValue(x, u), `${JS_KEY.test(k) ? k : JSON.stringify(k)}: `)), true);
  switch (v.type) {
    case "ObjectId":
      u.add("ObjectId");
      return leaf(`new ObjectId("${v.hex}")`);
    case "Int32":
      return leaf(String(v.value));
    case "Int64":
      u.add("Long");
      return leaf(`Long.fromString("${v.value}")`);
    case "Double": {
      const n = v.value;
      if (Number.isNaN(n)) return leaf("NaN");
      if (!Number.isFinite(n)) return leaf(n > 0 ? "Infinity" : "-Infinity");
      // An integral number would go as an int32; Double keeps it a double.
      if (Number.isInteger(n)) {
        u.add("Double");
        return leaf(`new Double(${Object.is(n, -0) ? "-0" : String(n)})`);
      }
      return leaf(String(n));
    }
    case "Decimal128":
      u.add("Decimal128");
      return leaf(`Decimal128.fromString("${v.value}")`);
    case "Date": {
      const iso = v.iso();
      return leaf(iso !== null ? `new Date("${iso}")` : `new Date(${v.ms})`);
    }
    case "Binary": {
      const uuid = v.uuid();
      if (uuid !== null) {
        u.add("UUID");
        return leaf(`new UUID("${uuid}")`);
      }
      u.add("Binary");
      return leaf(`Binary.createFromBase64("${v.base64}", ${v.subType})`);
    }
    case "Regex": {
      // A literal sends its source as written, so a "/" (which a literal must
      // escape) would change the pattern; such patterns use BSONRegExp.
      if (/^[ims]*$/.test(v.options) && v.pattern !== "" && !/[/\n\r\u2028\u2029]/.test(v.pattern) && validJsRegex(v.pattern, v.options)) {
        return leaf(`/${v.pattern}/${v.options}`);
      }
      u.add("BSONRegExp");
      return leaf(`new BSONRegExp(${JSON.stringify(v.pattern)}, "${v.options}")`);
    }
    case "Timestamp":
      u.add("Timestamp");
      return leaf(`new Timestamp({ t: ${v.t}, i: ${v.i} })`);
    case "Code":
      u.add("Code");
      return v.scope === null ? leaf(`new Code(${JSON.stringify(v.code)})`) : call("new Code", [leaf(JSON.stringify(v.code)), jsValue(v.scope, u)]);
    case "MinKey":
      u.add("MinKey");
      return leaf("new MinKey()");
    case "MaxKey":
      u.add("MaxKey");
      return leaf("new MaxKey()");
    case "Undefined":
      return leaf("null");
  }
}

function validJsRegex(pattern: string, options: string): boolean {
  try {
    new RegExp(pattern, options);
    return true;
  } catch {
    return false;
  }
}

function node(q: Query): string {
  const u = new Uses();
  const body: string[] = [];
  const opts: Item[] = [];
  let run: string;
  if (q.source.kind === "find") {
    const f = q.source;
    body.push(statement("const query = ", jsValue(f.filter, u), ";", 0, JS));
    if (f.projection !== null) {
      body.push(statement("const projection = ", jsValue(f.projection, u), ";", 0, JS));
      opts.push(item(leaf("projection")));
    }
    if (f.sort !== null) opts.push(item(jsValue(f.sort, u), "sort: "));
    if (f.skip > 0) opts.push(item(leaf(String(f.skip)), "skip: "));
    if (f.limit > 0) opts.push(item(leaf(String(f.limit)), "limit: "));
    run = "collection.find(query";
  } else {
    body.push(statement("const pipeline = ", jsValue(q.source.pipeline, u), ";", 0, JS));
    run = "collection.aggregate(pipeline";
  }
  if (q.collation !== null) opts.push(item(jsValue(q.collation, u), "collation: "));
  if (q.hint !== null) opts.push(item(typeof q.hint === "string" ? leaf(JSON.stringify(q.hint)) : jsValue(q.hint, u), "hint: "));
  if (q.maxTimeMS !== null) opts.push(item(leaf(String(q.maxTimeMS)), "maxTimeMS: "));
  body.push(opts.length > 0 ? statement(`const cursor = ${run}, `, list("{", "}", opts, true), ");", 0, JS) : `const cursor = ${run});`);
  body.push("for await (const doc of cursor) {", "  console.log(doc);", "}");

  const names = u.sorted(["BSONRegExp", "Binary", "Code", "Decimal128", "Double", "Long", "MaxKey", "MinKey", "ObjectId", "Timestamp", "UUID"]);
  if (q.uri !== null) names.unshift("MongoClient");
  const imports = names.length > 0 ? [`import { ${names.join(", ")} } from "mongodb";`] : [];
  const collection = `const collection = client.db(${JSON.stringify(q.db)}).collection(${JSON.stringify(q.coll)});`;
  if (q.uri === null) {
    return joinBlocks([imports, [collection], body]);
  }
  const inner = [collection, "", ...body].map((l) => (l === "" ? "" : `  ${l.replace(/\n/g, "\n  ")}`));
  return joinBlocks([imports, [`const client = new MongoClient(${JSON.stringify(q.uri)});`, "try {", ...inner, "} finally {", "  await client.close();", "}"]]);
}

// ---- Java (sync driver) ----

const JAVA: Style = { width: 100, indent: "    ", chain: 2, trailing: false };

function javaValue(v: BsonValue, u: Uses): Node {
  if (v === null) return leaf("null");
  if (typeof v === "string") return leaf(JSON.stringify(v));
  if (typeof v === "boolean") return leaf(String(v));
  if (Array.isArray(v)) {
    u.add("java.util.Arrays");
    return list("Arrays.asList(", ")", v.map((x) => item(javaValue(x, u))), false, false);
  }
  if (isDocument(v)) {
    u.add("org.bson.Document");
    const entries = [...v];
    if (entries.length === 0) return leaf("new Document()");
    return chain(entries.map(([k, x], i) => item(javaValue(x, u), `${i === 0 ? "new Document(" : ".append("}${JSON.stringify(k)}, `, ")")));
  }
  switch (v.type) {
    case "ObjectId":
      u.add("org.bson.types.ObjectId");
      return leaf(`new ObjectId("${v.hex}")`);
    case "Int32":
      return leaf(String(v.value));
    case "Int64":
      return leaf(`${v.value}L`);
    case "Double":
      return leaf(Number.isNaN(v.value) ? "Double.NaN" : !Number.isFinite(v.value) ? (v.value > 0 ? "Double.POSITIVE_INFINITY" : "Double.NEGATIVE_INFINITY") : doubleText(v.value));
    case "Decimal128":
      u.add("org.bson.types.Decimal128");
      return leaf(`Decimal128.parse("${v.value}")`);
    case "Date": {
      u.add("java.util.Date");
      const p = dateParts(v.ms);
      if (p === null) return leaf(`new Date(${v.ms}L)`);
      u.add("java.time.Instant");
      return leaf(`Date.from(Instant.parse("${p.iso}"))`);
    }
    case "Binary": {
      const uuid = v.uuid();
      if (uuid !== null) {
        u.add("org.bson.BsonBinary");
        u.add("java.util.UUID");
        return leaf(`new BsonBinary(UUID.fromString("${uuid}"))`);
      }
      u.add("org.bson.types.Binary");
      u.add("java.util.Base64");
      const data = `Base64.getDecoder().decode("${v.base64}")`;
      return leaf(v.subType === 0 ? `new Binary(${data})` : `new Binary((byte) 0x${hex2(v.subType)}, ${data})`);
    }
    case "Regex":
      u.add("org.bson.BsonRegularExpression");
      return leaf(`new BsonRegularExpression(${JSON.stringify(v.pattern)}${v.options !== "" ? `, "${v.options}"` : ""})`);
    case "Timestamp":
      u.add("org.bson.BsonTimestamp");
      return leaf(v.t <= 0x7fffffff && v.i <= 0x7fffffff ? `new BsonTimestamp(${v.t}, ${v.i})` : `new BsonTimestamp(${BigInt.asIntN(64, (BigInt(v.t) << 32n) | BigInt(v.i))}L)`);
    case "Code":
      if (v.scope === null) {
        u.add("org.bson.types.Code");
        return leaf(`new Code(${JSON.stringify(v.code)})`);
      }
      u.add("org.bson.types.CodeWithScope");
      return call("new CodeWithScope", [leaf(JSON.stringify(v.code)), javaValue(v.scope, u)]);
    case "MinKey":
      u.add("org.bson.types.MinKey");
      return leaf("new MinKey()");
    case "MaxKey":
      u.add("org.bson.types.MaxKey");
      return leaf("new MaxKey()");
    case "Undefined":
      u.add("org.bson.BsonUndefined");
      return leaf("new BsonUndefined()");
  }
}

function javaCollation(c: CollationFields, u: Uses): Node {
  u.add("com.mongodb.client.model.Collation");
  const parts: Item[] = [item(leaf("Collation.builder()"))];
  const add = (text: string) => parts.push(item(leaf(text)));
  if (c.locale !== null) add(`.locale(${JSON.stringify(c.locale)})`);
  if (c.caseLevel !== null) add(`.caseLevel(${c.caseLevel})`);
  if (c.caseFirst !== null) {
    u.add("com.mongodb.client.model.CollationCaseFirst");
    add(`.collationCaseFirst(CollationCaseFirst.${c.caseFirst.toUpperCase()})`);
  }
  if (c.strength !== null && STRENGTH_NAMES[c.strength]) {
    u.add("com.mongodb.client.model.CollationStrength");
    add(`.collationStrength(CollationStrength.${STRENGTH_NAMES[c.strength].toUpperCase()})`);
  }
  if (c.numericOrdering !== null) add(`.numericOrdering(${c.numericOrdering})`);
  if (c.alternate !== null) {
    u.add("com.mongodb.client.model.CollationAlternate");
    add(`.collationAlternate(CollationAlternate.${c.alternate === "shifted" ? "SHIFTED" : "NON_IGNORABLE"})`);
  }
  if (c.maxVariable !== null) {
    u.add("com.mongodb.client.model.CollationMaxVariable");
    add(`.collationMaxVariable(CollationMaxVariable.${c.maxVariable === "space" ? "SPACE" : "PUNCT"})`);
  }
  if (c.normalization !== null) add(`.normalization(${c.normalization})`);
  if (c.backwards !== null) add(`.backwards(${c.backwards})`);
  add(".build()");
  return chain(parts);
}

function java(q: Query): string {
  const u = new Uses();
  u.add("org.bson.Document");
  u.add("com.mongodb.client.MongoCollection");
  const body: string[] = [];
  const depth = q.uri !== null ? 3 : 0;
  const parts: Item[] = [];
  let iterable: string;
  if (q.source.kind === "find") {
    const f = q.source;
    u.add("org.bson.conversions.Bson");
    u.add("com.mongodb.client.FindIterable");
    body.push(statement("Bson query = ", javaValue(f.filter, u), ";", depth, JAVA));
    parts.push(item(leaf("collection.find(query)")));
    if (f.projection !== null) parts.push(item(javaValue(f.projection, u), ".projection(", ")"));
    if (f.sort !== null) parts.push(item(javaValue(f.sort, u), ".sort(", ")"));
    if (f.skip > 0) parts.push(item(leaf(`.skip(${f.skip})`)));
    if (f.limit > 0) parts.push(item(leaf(`.limit(${f.limit})`)));
    iterable = "FindIterable<Document> result = ";
  } else {
    u.add("org.bson.conversions.Bson");
    u.add("java.util.List");
    u.add("com.mongodb.client.AggregateIterable");
    body.push(statement("List<Bson> pipeline = ", javaValue(q.source.pipeline, u), ";", depth, JAVA));
    parts.push(item(leaf("collection.aggregate(pipeline)")));
    iterable = "AggregateIterable<Document> result = ";
  }
  if (q.collation !== null) parts.push(item(javaCollation(collationFields(q.collation), u), ".collation(", ")"));
  if (q.hint !== null) parts.push(typeof q.hint === "string" ? item(leaf(`.hintString(${JSON.stringify(q.hint)})`)) : item(javaValue(q.hint, u), ".hint(", ")"));
  if (q.maxTimeMS !== null) {
    u.add("java.util.concurrent.TimeUnit");
    parts.push(item(leaf(`.maxTime(${q.maxTimeMS}, TimeUnit.MILLISECONDS)`)));
  }
  body.push(statement(iterable, chain(parts), ";", depth, JAVA));
  const pad = JAVA.indent.repeat(depth);
  body.push(`${pad}for (Document doc : result) {`, `${pad}    System.out.println(doc.toJson());`, `${pad}}`);
  const collection = `${pad}MongoCollection<Document> collection = client.getDatabase(${JSON.stringify(q.db)}).getCollection(${JSON.stringify(q.coll)});`;
  if (q.uri !== null) {
    u.add("com.mongodb.client.MongoClient");
    u.add("com.mongodb.client.MongoClients");
  }
  const imports = u.sorted(JAVA_IMPORTS).map((name) => `import ${name};`);
  if (q.uri === null) {
    return joinBlocks([imports, [collection], body]);
  }
  return joinBlocks([
    imports,
    [
      "public class Query {",
      "    public static void main(String[] args) {",
      `        try (MongoClient client = MongoClients.create(${JSON.stringify(q.uri)})) {`,
      collection,
      ...body,
      "        }",
      "    }",
      "}",
    ],
  ]);
}

const JAVA_IMPORTS = [
  "com.mongodb.client.AggregateIterable",
  "com.mongodb.client.FindIterable",
  "com.mongodb.client.MongoClient",
  "com.mongodb.client.MongoClients",
  "com.mongodb.client.MongoCollection",
  "com.mongodb.client.model.Collation",
  "com.mongodb.client.model.CollationAlternate",
  "com.mongodb.client.model.CollationCaseFirst",
  "com.mongodb.client.model.CollationMaxVariable",
  "com.mongodb.client.model.CollationStrength",
  "java.time.Instant",
  "java.util.Arrays",
  "java.util.Base64",
  "java.util.Date",
  "java.util.List",
  "java.util.UUID",
  "java.util.concurrent.TimeUnit",
  "org.bson.BsonBinary",
  "org.bson.BsonRegularExpression",
  "org.bson.BsonTimestamp",
  "org.bson.BsonUndefined",
  "org.bson.Document",
  "org.bson.conversions.Bson",
  "org.bson.types.Binary",
  "org.bson.types.Code",
  "org.bson.types.CodeWithScope",
  "org.bson.types.Decimal128",
  "org.bson.types.MaxKey",
  "org.bson.types.MinKey",
  "org.bson.types.ObjectId",
];

// ---- C# (.NET driver) ----

const CS: Style = { width: 100, indent: "    ", chain: 1, trailing: false };

function csValue(v: BsonValue): Node {
  if (v === null) return leaf("BsonNull.Value");
  if (typeof v === "string") return leaf(JSON.stringify(v));
  if (typeof v === "boolean") return leaf(String(v));
  if (Array.isArray(v)) return v.length === 0 ? leaf("new BsonArray()") : list("new BsonArray {", "}", v.map((x) => item(csValue(x))), true, false);
  if (isDocument(v)) {
    const entries = [...v];
    if (entries.length === 0) return leaf("new BsonDocument()");
    if (entries.length === 1) return call("new BsonDocument", [leaf(JSON.stringify(entries[0][0])), csValue(entries[0][1])]);
    return list("new BsonDocument {", "}", entries.map(([k, x]) => item(csValue(x), `{ ${JSON.stringify(k)}, `, " }")), true, false);
  }
  switch (v.type) {
    case "ObjectId":
      return leaf(`new ObjectId("${v.hex}")`);
    case "Int32":
      return leaf(String(v.value));
    case "Int64":
      return leaf(`${v.value}L`);
    case "Double":
      return leaf(Number.isNaN(v.value) ? "double.NaN" : !Number.isFinite(v.value) ? (v.value > 0 ? "double.PositiveInfinity" : "double.NegativeInfinity") : doubleText(v.value));
    case "Decimal128":
      return leaf(`Decimal128.Parse("${v.value}")`);
    case "Date": {
      const p = dateParts(v.ms);
      return leaf(p === null ? `new BsonDateTime(${v.ms})` : `new DateTime(${p.year}, ${p.month}, ${p.day}, ${p.hour}, ${p.minute}, ${p.second}, ${p.ms}, DateTimeKind.Utc)`);
    }
    case "Binary": {
      const uuid = v.uuid();
      if (uuid !== null) return leaf(`new BsonBinaryData(Guid.Parse("${uuid}"), GuidRepresentation.Standard)`);
      const sub = v.subType === 0 ? "BsonBinarySubType.Binary" : v.subType === 5 ? "BsonBinarySubType.MD5" : `(BsonBinarySubType)0x${hex2(v.subType)}`;
      return leaf(`new BsonBinaryData(Convert.FromBase64String("${v.base64}"), ${sub})`);
    }
    case "Regex":
      return leaf(`new BsonRegularExpression(${JSON.stringify(v.pattern)}${v.options !== "" ? `, "${v.options}"` : ""})`);
    case "Timestamp":
      return leaf(v.t <= 0x7fffffff && v.i <= 0x7fffffff ? `new BsonTimestamp(${v.t}, ${v.i})` : `new BsonTimestamp(${BigInt.asIntN(64, (BigInt(v.t) << 32n) | BigInt(v.i))}L)`);
    case "Code":
      return v.scope === null ? leaf(`new BsonJavaScript(${JSON.stringify(v.code)})`) : call("new BsonJavaScriptWithScope", [leaf(JSON.stringify(v.code)), csValue(v.scope)]);
    case "MinKey":
      return leaf("BsonMinKey.Value");
    case "MaxKey":
      return leaf("BsonMaxKey.Value");
    case "Undefined":
      return leaf("BsonUndefined.Value");
  }
}

function csCollation(c: CollationFields): Node {
  const args: Item[] = [item(leaf(JSON.stringify(c.locale ?? "simple")))];
  const named = (name: string, value: string) => args.push(item(leaf(value), `${name}: `));
  if (c.caseLevel !== null) named("caseLevel", String(c.caseLevel));
  if (c.caseFirst !== null) named("caseFirst", `CollationCaseFirst.${pascal(c.caseFirst)}`);
  if (c.strength !== null && STRENGTH_NAMES[c.strength]) named("strength", `CollationStrength.${STRENGTH_NAMES[c.strength]}`);
  if (c.numericOrdering !== null) named("numericOrdering", String(c.numericOrdering));
  if (c.alternate !== null) named("alternate", c.alternate === "shifted" ? "CollationAlternate.Shifted" : "CollationAlternate.NonIgnorable");
  if (c.maxVariable !== null) named("maxVariable", c.maxVariable === "space" ? "CollationMaxVariable.Space" : "CollationMaxVariable.Punctuation");
  if (c.normalization !== null) named("normalization", String(c.normalization));
  if (c.backwards !== null) named("backwards", String(c.backwards));
  return list("new Collation(", ")", args, false, false);
}

function csharp(q: Query): string {
  const body: string[] = [];
  const opts: Item[] = [];
  if (q.collation !== null) opts.push(item(csCollation(collationFields(q.collation)), "Collation = "));
  if (q.hint !== null) opts.push(item(typeof q.hint === "string" ? leaf(JSON.stringify(q.hint)) : csValue(q.hint), "Hint = "));
  if (q.maxTimeMS !== null) opts.push(item(leaf(`TimeSpan.FromMilliseconds(${q.maxTimeMS})`), "MaxTime = "));
  if (q.source.kind === "find") {
    const f = q.source;
    body.push(statement("var query = ", csValue(f.filter), ";", 0, CS));
    if (opts.length > 0) body.push(statement("var options = ", list("new FindOptions {", "}", opts, true, false), ";", 0, CS));
    const parts: Item[] = [item(leaf(`collection.Find(query${opts.length > 0 ? ", options" : ""})`))];
    if (f.projection !== null) parts.push(item(csValue(f.projection), ".Project(", ")"));
    if (f.sort !== null) parts.push(item(csValue(f.sort), ".Sort(", ")"));
    if (f.skip > 0) parts.push(item(leaf(`.Skip(${f.skip})`)));
    if (f.limit > 0) parts.push(item(leaf(`.Limit(${f.limit})`)));
    parts.push(item(leaf(".ToList()")));
    body.push(statement("var result = ", chain(parts), ";", 0, CS));
  } else {
    const stages = q.source.pipeline.map((s) => item(csValue(s)));
    body.push(statement("var pipeline = ", stages.length === 0 ? leaf("new BsonDocument[0]") : list("new BsonDocument[] {", "}", stages, true, false), ";", 0, CS));
    if (opts.length > 0) body.push(statement("var options = ", list("new AggregateOptions {", "}", opts, true, false), ";", 0, CS));
    body.push(`var result = collection.Aggregate<BsonDocument>(pipeline${opts.length > 0 ? ", options" : ""}).ToList();`);
  }
  body.push("foreach (var doc in result)", "{", "    Console.WriteLine(doc);", "}");
  const head: string[] = [];
  if (q.uri !== null) head.push(`var client = new MongoClient(${JSON.stringify(q.uri)});`);
  head.push(`var collection = client.GetDatabase(${JSON.stringify(q.db)}).GetCollection<BsonDocument>(${JSON.stringify(q.coll)});`);
  return joinBlocks([["using System;", "using MongoDB.Bson;", "using MongoDB.Driver;"], head, body]);
}

// ---- Go (driver v2) ----

const GO: Style = { width: 100, indent: "\t", chain: 1, trailing: true };
const MONTHS = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function goValue(v: BsonValue, u: Uses): Node {
  if (v === null) return leaf("nil");
  if (typeof v === "string") return leaf(JSON.stringify(v));
  if (typeof v === "boolean") return leaf(String(v));
  if (Array.isArray(v)) return list("bson.A{", "}", v.map((x) => item(goValue(x, u))));
  if (isDocument(v)) return goDoc(v, u);
  switch (v.type) {
    case "ObjectId":
      u.add("objectID");
      return leaf(`objectID("${v.hex}")`);
    case "Int32":
      return leaf(String(v.value));
    case "Int64":
      return leaf(`int64(${v.value})`);
    case "Double": {
      const n = v.value;
      if (Number.isNaN(n) || !Number.isFinite(n) || Object.is(n, -0)) {
        u.add("math");
        return leaf(Number.isNaN(n) ? "math.NaN()" : Object.is(n, -0) ? "math.Copysign(0, -1)" : `math.Inf(${n > 0 ? 1 : -1})`);
      }
      return leaf(doubleText(n));
    }
    case "Decimal128":
      u.add("decimal128");
      return leaf(`decimal128("${v.value}")`);
    case "Date": {
      const p = dateParts(v.ms);
      if (p === null) return leaf(`bson.DateTime(${v.ms})`);
      u.add("time");
      return leaf(`time.Date(${p.year}, time.${MONTHS[p.month]}, ${p.day}, ${p.hour}, ${p.minute}, ${p.second}, ${p.ms * 1_000_000}, time.UTC)`);
    }
    case "Binary":
      u.add("hexBytes");
      return leaf(`bson.Binary{Subtype: 0x${hex2(v.subType)}, Data: hexBytes("${binaryHex(v.base64)}")}`);
    case "Regex":
      return leaf(`bson.Regex{Pattern: ${JSON.stringify(v.pattern)}, Options: "${v.options}"}`);
    case "Timestamp":
      return leaf(`bson.Timestamp{T: ${v.t}, I: ${v.i}}`);
    case "Code":
      return v.scope === null ? leaf(`bson.JavaScript(${JSON.stringify(v.code)})`) : list("bson.CodeWithScope{", "}", [item(leaf(JSON.stringify(v.code)), "Code: "), item(goDoc(v.scope, u), "Scope: ")]);
    case "MinKey":
      return leaf("bson.MinKey{}");
    case "MaxKey":
      return leaf("bson.MaxKey{}");
    case "Undefined":
      return leaf("bson.Undefined{}");
  }
}

function goDoc(doc: BsonDocument, u: Uses): Node {
  return list("bson.D{", "}", [...doc].map(([k, x]) => item(goValue(x, u), `{Key: ${JSON.stringify(k)}, Value: `, "}")));
}

function goCollation(c: CollationFields): Node {
  const fields: Item[] = [];
  const add = (name: string, value: string) => fields.push(item(leaf(value), `${name}: `));
  if (c.locale !== null) add("Locale", JSON.stringify(c.locale));
  if (c.caseLevel !== null) add("CaseLevel", String(c.caseLevel));
  if (c.caseFirst !== null) add("CaseFirst", JSON.stringify(c.caseFirst));
  if (c.strength !== null) add("Strength", String(c.strength));
  if (c.numericOrdering !== null) add("NumericOrdering", String(c.numericOrdering));
  if (c.alternate !== null) add("Alternate", JSON.stringify(c.alternate));
  if (c.maxVariable !== null) add("MaxVariable", JSON.stringify(c.maxVariable));
  if (c.normalization !== null) add("Normalization", String(c.normalization));
  if (c.backwards !== null) add("Backwards", String(c.backwards));
  return list("&options.Collation{", "}", fields);
}

// A Go method chain: each call ends its line with the dot, as Go needs.
function goChain(head: string, calls: { name: string; arg: Node }[]): Node {
  if (calls.length === 0) return leaf(head);
  return chain([item(leaf(`${head}.`)), ...calls.map((c, i) => item(c.arg, `${c.name}(`, i < calls.length - 1 ? ")." : ")"))]);
}

function golang(q: Query): string {
  const u = new Uses();
  const depth = q.uri !== null ? 1 : 0;
  const pad = GO.indent.repeat(depth);
  const body: string[] = [];
  const calls: { name: string; arg: Node }[] = [];
  let builder: string;
  let run: string;
  if (q.source.kind === "find") {
    const f = q.source;
    body.push(statement("filter := ", goDoc(f.filter, u), "", depth, GO));
    if (f.projection !== null) calls.push({ name: "SetProjection", arg: goDoc(f.projection, u) });
    if (f.sort !== null) calls.push({ name: "SetSort", arg: goDoc(f.sort, u) });
    if (f.skip > 0) calls.push({ name: "SetSkip", arg: leaf(String(f.skip)) });
    if (f.limit > 0) calls.push({ name: "SetLimit", arg: leaf(String(f.limit)) });
    builder = "options.Find()";
    run = "coll.Find(ctx, filter";
  } else {
    u.add("mongo");
    body.push(statement("pipeline := ", list("mongo.Pipeline{", "}", q.source.pipeline.map((s) => item(goDoc(s, u)))), "", depth, GO));
    builder = "options.Aggregate()";
    run = "coll.Aggregate(ctx, pipeline";
  }
  if (q.collation !== null) calls.push({ name: "SetCollation", arg: goCollation(collationFields(q.collation)) });
  if (q.hint !== null) calls.push({ name: "SetHint", arg: typeof q.hint === "string" ? leaf(JSON.stringify(q.hint)) : goDoc(q.hint, u) });
  if (calls.length > 0) {
    u.add("options");
    body.push(statement("opts := ", goChain(builder, calls), "", depth, GO));
    run += ", opts";
  }
  const ctxLines: string[] = [];
  if (q.maxTimeMS !== null) {
    // Driver v2 sends maxTimeMS from the context's deadline.
    u.add("time");
    ctxLines.push(
      `${pad}// maxTimeMS ${q.maxTimeMS}: the driver sends the time left before the context's deadline.`,
      `${pad}ctx, cancel := context.WithTimeout(context.Background(), ${q.maxTimeMS}*time.Millisecond)`,
      `${pad}defer cancel()`,
    );
  } else {
    ctxLines.push(`${pad}ctx := context.Background()`);
  }
  const loop = [
    `cursor, err := ${run})`,
    "if err != nil {",
    "\tpanic(err)",
    "}",
    "defer cursor.Close(ctx)",
    "for cursor.Next(ctx) {",
    "\tvar doc bson.D",
    "\tif err := cursor.Decode(&doc); err != nil {",
    "\t\tpanic(err)",
    "\t}",
    "\tout, err := bson.MarshalExtJSON(doc, false, false)",
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
    "\tfmt.Println(string(out))",
    "}",
    "if err := cursor.Err(); err != nil {",
    "\tpanic(err)",
    "}",
  ].map((l) => pad + l);
  const coll = `${pad}coll := client.Database(${JSON.stringify(q.db)}).Collection(${JSON.stringify(q.coll)})`;
  if (q.uri !== null) {
    u.add("mongo");
    u.add("options");
  }
  const std = ["context", "encoding/hex", "fmt", "math", "time"].filter((n) => n === "context" || n === "fmt" || (n === "encoding/hex" ? u.has("hexBytes") : u.has(n)));
  const ext = ["go.mongodb.org/mongo-driver/v2/bson", ...(u.has("mongo") ? ["go.mongodb.org/mongo-driver/v2/mongo"] : []), ...(u.has("options") ? ["go.mongodb.org/mongo-driver/v2/mongo/options"] : [])];
  const imports = ["import (", ...std.map((n) => `\t"${n}"`), "", ...ext.map((n) => `\t"${n}"`), ")"];
  const helpers: string[] = [];
  if (u.has("objectID")) {
    helpers.push(
      ["// objectID reads an ObjectID written in hex.", "func objectID(s string) bson.ObjectID {", "\tid, err := bson.ObjectIDFromHex(s)", "\tif err != nil {", "\t\tpanic(err)", "\t}", "\treturn id", "}"].join("\n"),
    );
  }
  if (u.has("decimal128")) {
    helpers.push(
      ["// decimal128 reads a Decimal128 written as text.", "func decimal128(s string) bson.Decimal128 {", "\td, err := bson.ParseDecimal128(s)", "\tif err != nil {", "\t\tpanic(err)", "\t}", "\treturn d", "}"].join("\n"),
    );
  }
  if (u.has("hexBytes")) {
    helpers.push(["// hexBytes reads bytes written in hex.", "func hexBytes(s string) []byte {", "\tb, err := hex.DecodeString(s)", "\tif err != nil {", "\t\tpanic(err)", "\t}", "\treturn b", "}"].join("\n"));
  }
  if (q.uri === null) {
    return joinBlocks([imports, [coll, ...ctxLines], body, loop, ...helpers.map((h) => [h])]);
  }
  const main = [
    "func main() {",
    `\tclient, err := mongo.Connect(options.Client().ApplyURI(${JSON.stringify(q.uri)}))`,
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
    "\tdefer func() {",
    "\t\tif err := client.Disconnect(context.Background()); err != nil {",
    "\t\t\tpanic(err)",
    "\t\t}",
    "\t}()",
    "",
    coll,
    ...ctxLines,
    ...body,
    ...loop,
    "}",
  ];
  return joinBlocks([["package main"], imports, main, ...helpers.map((h) => [h])]);
}

// ---- Rust ----

const RS: Style = { width: 100, indent: "    ", chain: 1, trailing: true };

function rustStr(s: string): string {
  return quoted(s, (cp) => `\\u{${cp.toString(16)}}`, { "\0": "\\0" });
}

// `inMacro`: inside `doc!`, where documents are bare `{ … }`, arrays `[…]`
// and null is `null`.
function rsValue(v: BsonValue, u: Uses, inMacro: boolean): Node {
  if (v === null) {
    if (!inMacro) u.add("Bson");
    return leaf(inMacro ? "null" : "Bson::Null");
  }
  if (typeof v === "string") return leaf(rustStr(v));
  if (typeof v === "boolean") return leaf(String(v));
  if (Array.isArray(v)) {
    const items = v.map((x) => item(rsValue(x, u, true)));
    if (inMacro) return list("[", "]", items);
    u.add("bson!");
    return list("bson!([", "])", items);
  }
  if (isDocument(v)) {
    if (!inMacro) u.add("doc!");
    const entries = [...v].map(([k, x]) => item(rsValue(x, u, true), `${rustStr(k)}: `));
    return entries.length === 0 ? leaf(inMacro ? "{}" : "doc! {}") : list(inMacro ? "{" : "doc! {", "}", entries, true);
  }
  switch (v.type) {
    case "ObjectId":
      u.add("ObjectId");
      return leaf(`ObjectId::parse_str("${v.hex}")?`);
    case "Int32":
      return leaf(String(v.value));
    case "Int64":
      return leaf(`${v.value}_i64`);
    case "Double": {
      const n = v.value;
      if (Number.isNaN(n)) return leaf("f64::NAN");
      if (!Number.isFinite(n)) return leaf(n > 0 ? "f64::INFINITY" : "f64::NEG_INFINITY");
      const text = doubleText(n);
      // A literal such as `1e21` is already a float; `1e-7_f64` reads oddly.
      return leaf(/[.]/.test(text) || /e/i.test(text) ? text.replace(/e\+/i, "e") : `${text}.0`);
    }
    case "Decimal128":
      u.add("Decimal128");
      return leaf(`"${v.value}".parse::<Decimal128>()?`);
    case "Date": {
      u.add("DateTime");
      const p = dateParts(v.ms);
      return leaf(p === null ? `DateTime::from_millis(${v.ms})` : `DateTime::parse_rfc3339_str("${p.iso}")?`);
    }
    case "Binary": {
      const uuid = v.uuid();
      if (uuid !== null) {
        u.add("Uuid");
        return leaf(`Uuid::parse_str("${uuid}")?`);
      }
      u.add("Binary");
      u.add("BinarySubtype");
      const sub = v.subType === 0 ? "BinarySubtype::Generic" : v.subType === 5 ? "BinarySubtype::Md5" : `BinarySubtype::from(0x${hex2(v.subType)})`;
      return leaf(`Binary::from_base64("${v.base64}", ${sub})?`);
    }
    case "Regex":
      u.add("Regex");
      return leaf(`Regex { pattern: ${rustStr(v.pattern)}.to_string(), options: "${v.options}".to_string() }`);
    case "Timestamp":
      u.add("Timestamp");
      return leaf(`Timestamp { time: ${v.t}, increment: ${v.i} }`);
    case "Code":
      u.add("Bson");
      if (v.scope === null) return leaf(`Bson::JavaScriptCode(${rustStr(v.code)}.to_string())`);
      u.add("JavaScriptCodeWithScope");
      return list("Bson::JavaScriptCodeWithScope(JavaScriptCodeWithScope {", "})", [item(leaf(`${rustStr(v.code)}.to_string()`), "code: "), item(rsValue(v.scope, u, false), "scope: ")], true);
    case "MinKey":
      u.add("Bson");
      return leaf("Bson::MinKey");
    case "MaxKey":
      u.add("Bson");
      return leaf("Bson::MaxKey");
    case "Undefined":
      u.add("Bson");
      return leaf("Bson::Undefined");
  }
}

function rsCollation(c: CollationFields, u: Uses): Node {
  u.add("Collation");
  const parts: Item[] = [item(leaf("Collation::builder()"))];
  const add = (text: string) => parts.push(item(leaf(text)));
  add(`.locale(${rustStr(c.locale ?? "simple")})`);
  if (c.caseLevel !== null) add(`.case_level(${c.caseLevel})`);
  if (c.caseFirst !== null) {
    u.add("CollationCaseFirst");
    add(`.case_first(CollationCaseFirst::${pascal(c.caseFirst)})`);
  }
  if (c.strength !== null && STRENGTH_NAMES[c.strength]) {
    u.add("CollationStrength");
    add(`.strength(CollationStrength::${STRENGTH_NAMES[c.strength]})`);
  }
  if (c.numericOrdering !== null) add(`.numeric_ordering(${c.numericOrdering})`);
  if (c.alternate !== null) {
    u.add("CollationAlternate");
    add(`.alternate(CollationAlternate::${c.alternate === "shifted" ? "Shifted" : "NonIgnorable"})`);
  }
  if (c.maxVariable !== null) {
    u.add("CollationMaxVariable");
    add(`.max_variable(CollationMaxVariable::${c.maxVariable === "space" ? "Space" : "Punctuation"})`);
  }
  if (c.normalization !== null) add(`.normalization(${c.normalization})`);
  if (c.backwards !== null) add(`.backwards(${c.backwards})`);
  add(".build()");
  return chain(parts);
}

function rust(q: Query): string {
  const u = new Uses();
  u.add("Document");
  const depth = q.uri !== null ? 1 : 0;
  const pad = RS.indent.repeat(depth);
  const body: string[] = [];
  const parts: Item[] = [item(leaf("collection"))];
  if (q.source.kind === "find") {
    const f = q.source;
    body.push(statement("let filter = ", rsValue(f.filter, u, false), ";", depth, RS));
    parts.push(item(leaf(".find(filter)")));
    if (f.projection !== null) parts.push(item(rsValue(f.projection, u, false), ".projection(", ")"));
    if (f.sort !== null) parts.push(item(rsValue(f.sort, u, false), ".sort(", ")"));
    if (f.skip > 0) parts.push(item(leaf(`.skip(${f.skip})`)));
    if (f.limit > 0) parts.push(item(leaf(`.limit(${f.limit})`)));
  } else {
    u.add("doc!");
    body.push(statement("let pipeline = ", list("vec![", "]", q.source.pipeline.map((s) => item(rsValue(s, u, false)))), ";", depth, RS));
    parts.push(item(leaf(".aggregate(pipeline)")));
  }
  if (q.collation !== null) parts.push(item(rsCollation(collationFields(q.collation), u), ".collation(", ")"));
  if (q.hint !== null) {
    u.add("Hint");
    parts.push(typeof q.hint === "string" ? item(leaf(`.hint(Hint::Name(${rustStr(q.hint)}.to_string()))`)) : item(rsValue(q.hint, u, false), ".hint(Hint::Keys(", "))"));
  }
  if (q.maxTimeMS !== null) {
    u.add("Duration");
    parts.push(item(leaf(`.max_time(Duration::from_millis(${q.maxTimeMS}))`)));
  }
  parts.push(item(leaf(".await?")));
  body.push(statement("let mut cursor = ", chain(parts), ";", depth, RS));
  body.push(`${pad}while let Some(doc) = cursor.try_next().await? {`, `${pad}    println!("{doc}");`, `${pad}}`);
  const coll = `${pad}let collection = client.database(${rustStr(q.db)}).collection::<Document>(${rustStr(q.coll)});`;

  const bsonNames = u.sorted(["bson!", "doc!", "Binary", "Bson", "DateTime", "Decimal128", "Document", "JavaScriptCodeWithScope", "Regex", "Timestamp", "Uuid"]).map((n) => n.replace("!", ""));
  if (u.has("ObjectId")) bsonNames.push("oid::ObjectId");
  if (u.has("BinarySubtype")) bsonNames.push("spec::BinarySubtype");
  const optionNames = u.sorted(["Collation", "CollationAlternate", "CollationCaseFirst", "CollationMaxVariable", "CollationStrength", "Hint"]);
  const imports = ["use futures::TryStreamExt;", `use mongodb::bson::{${bsonNames.join(", ")}};`];
  if (optionNames.length > 0) imports.push(optionNames.length === 1 ? `use mongodb::options::${optionNames[0]};` : `use mongodb::options::{${optionNames.join(", ")}};`);
  if (q.uri !== null) imports.push("use mongodb::Client;");
  if (u.has("Duration")) imports.push("use std::time::Duration;");
  // `doc!` expands field by field; a large literal outgrows the default
  // macro recursion limit of 128.
  const large = body.join("\n").split('": ').length > 40;
  if (q.uri === null) {
    return joinBlocks([large ? ['// A literal this large needs #![recursion_limit = "256"] at the crate root.'] : [], imports, [coll], body]);
  }
  return joinBlocks([
    large ? ['#![recursion_limit = "256"]'] : [],
    imports,
    [
      "#[tokio::main]",
      "async fn main() -> Result<(), Box<dyn std::error::Error>> {",
      `    let client = Client::with_uri_str(${rustStr(q.uri)}).await?;`,
      coll,
      "",
      ...body,
      "    Ok(())",
      "}",
    ],
  ]);
}

// ---- PHP (mongodb/mongodb) ----

const PHP: Style = { width: 100, indent: "    ", chain: 1, trailing: true };

function phpStr(s: string): string {
  return singleQuoted(s) ?? quoted(s, (cp) => `\\u{${cp.toString(16)}}`, { $: "\\$" });
}

function phpValue(v: BsonValue, u: Uses): Node {
  if (v === null) return leaf("null");
  if (typeof v === "string") return leaf(phpStr(v));
  if (typeof v === "boolean") return leaf(String(v));
  if (Array.isArray(v)) return list("[", "]", v.map((x) => item(phpValue(x, u))));
  if (isDocument(v)) {
    const entries = [...v];
    if (entries.length === 0) return leaf("(object) []");
    // Keys 0, 1, 2, … would make PHP send a BSON array.
    const listLike = entries.every(([k], i) => k === String(i));
    return list(listLike ? "(object) [" : "[", "]", entries.map(([k, x]) => item(phpValue(x, u), `${phpStr(k)} => `)));
  }
  switch (v.type) {
    case "ObjectId":
      u.add("ObjectId");
      return leaf(`new ObjectId('${v.hex}')`);
    case "Int32":
      return leaf(String(v.value));
    case "Int64":
      u.add("Int64");
      return leaf(`new Int64('${v.value}')`);
    case "Double":
      return leaf(Number.isNaN(v.value) ? "NAN" : !Number.isFinite(v.value) ? (v.value > 0 ? "INF" : "-INF") : doubleText(v.value));
    case "Decimal128":
      u.add("Decimal128");
      return leaf(`new Decimal128('${v.value}')`);
    case "Date": {
      u.add("UTCDateTime");
      const p = dateParts(v.ms);
      return leaf(p === null ? `new UTCDateTime(${v.ms})` : `new UTCDateTime(new DateTimeImmutable('${p.iso}'))`);
    }
    case "Binary": {
      u.add("Binary");
      const uuid = v.uuid();
      if (uuid !== null) return leaf(`new Binary(hex2bin('${uuid.replace(/-/g, "")}'), Binary::TYPE_UUID)`);
      return leaf(`new Binary(base64_decode('${v.base64}'), ${v.subType === 0 ? "Binary::TYPE_GENERIC" : `0x${hex2(v.subType)}`})`);
    }
    case "Regex":
      u.add("Regex");
      return leaf(`new Regex(${phpStr(v.pattern)}${v.options !== "" ? `, '${v.options}'` : ""})`);
    case "Timestamp":
      u.add("Timestamp");
      // The increment comes first.
      return leaf(`new Timestamp(${v.i}, ${v.t})`);
    case "Code":
      u.add("Javascript");
      return v.scope === null ? leaf(`new Javascript(${phpStr(v.code)})`) : call("new Javascript", [leaf(phpStr(v.code)), phpValue(v.scope, u)]);
    case "MinKey":
      u.add("MinKey");
      return leaf("new MinKey()");
    case "MaxKey":
      u.add("MaxKey");
      return leaf("new MaxKey()");
    case "Undefined":
      return leaf("null");
  }
}

function php(q: Query): string {
  const u = new Uses();
  const body: string[] = [];
  const opts: Item[] = [];
  let run: string;
  if (q.source.kind === "find") {
    const f = q.source;
    body.push(statement("$filter = ", phpValue(f.filter, u), ";", 0, PHP));
    if (f.projection !== null) opts.push(item(phpValue(f.projection, u), "'projection' => "));
    if (f.sort !== null) opts.push(item(phpValue(f.sort, u), "'sort' => "));
    if (f.skip > 0) opts.push(item(leaf(String(f.skip)), "'skip' => "));
    if (f.limit > 0) opts.push(item(leaf(String(f.limit)), "'limit' => "));
    run = "$collection->find($filter";
  } else {
    body.push(statement("$pipeline = ", phpValue(q.source.pipeline, u), ";", 0, PHP));
    run = "$collection->aggregate($pipeline";
  }
  if (q.collation !== null) opts.push(item(phpValue(q.collation, u), "'collation' => "));
  if (q.hint !== null) opts.push(item(typeof q.hint === "string" ? leaf(phpStr(q.hint)) : phpValue(q.hint, u), "'hint' => "));
  if (q.maxTimeMS !== null) opts.push(item(leaf(String(q.maxTimeMS)), "'maxTimeMS' => "));
  if (opts.length > 0) {
    body.push(statement("$options = ", list("[", "]", opts), ";", 0, PHP));
    run += ", $options";
  }
  // Extended JSON keeps NaN, binary data and the BSON types json_encode cannot write.
  body.push(`$cursor = ${run});`, "foreach ($cursor as $document) {", "    echo \\MongoDB\\BSON\\Document::fromPHP($document)->toRelaxedExtendedJSON(), PHP_EOL;", "}");
  const uses = u.sorted(["Binary", "Decimal128", "Int64", "Javascript", "MaxKey", "MinKey", "ObjectId", "Regex", "Timestamp", "UTCDateTime"]).map((n) => `use MongoDB\\BSON\\${n};`);
  if (q.uri !== null) uses.push("use MongoDB\\Client;");
  const head: string[] = [];
  if (q.uri !== null) head.push(`$client = new Client(${phpStr(q.uri)});`);
  head.push(`$collection = $client->selectCollection(${phpStr(q.db)}, ${phpStr(q.coll)});`);
  return joinBlocks([["<?php"], q.uri !== null ? ["require __DIR__ . '/vendor/autoload.php';"] : [], uses, head, body]);
}

// ---- Ruby ----

const RB: Style = { width: 80, indent: "  ", chain: 1, trailing: false };

function rbStr(s: string): string {
  return singleQuoted(s) ?? quoted(s, (cp) => (cp === 0x1b ? "\\e" : `\\u{${cp.toString(16)}}`), { "#": "\\#" });
}

const RUBY_SUBTYPES: Record<number, string> = { 0: "generic", 1: "function", 2: "old", 3: "uuid_old", 4: "uuid", 5: "md5", 6: "ciphertext", 7: "column", 8: "sensitive", 9: "vector" };

function rbValue(v: BsonValue): Node {
  if (v === null) return leaf("nil");
  if (typeof v === "string") return leaf(rbStr(v));
  if (typeof v === "boolean") return leaf(String(v));
  if (Array.isArray(v)) return list("[", "]", v.map((x) => item(rbValue(x))));
  if (isDocument(v)) return v.size === 0 ? leaf("{}") : list("{", "}", [...v].map(([k, x]) => item(rbValue(x), `${rbStr(k)} => `)), true);
  switch (v.type) {
    case "ObjectId":
      return leaf(`BSON::ObjectId.from_string('${v.hex}')`);
    case "Int32":
      return leaf(String(v.value));
    case "Int64":
      return leaf(`BSON::Int64.new(${v.value})`);
    case "Double":
      return leaf(Number.isNaN(v.value) ? "Float::NAN" : !Number.isFinite(v.value) ? (v.value > 0 ? "Float::INFINITY" : "-Float::INFINITY") : doubleText(v.value));
    case "Decimal128":
      return leaf(`BSON::Decimal128.new('${v.value}')`);
    case "Date": {
      const p = dateParts(v.ms);
      return leaf(p === null ? `Time.at(0, ${v.ms}, :millisecond).utc` : `Time.utc(${p.year}, ${p.month}, ${p.day}, ${p.hour}, ${p.minute}, ${p.second}${p.ms > 0 ? `, ${p.ms * 1000}` : ""})`);
    }
    case "Binary": {
      const uuid = v.uuid();
      if (uuid !== null) return leaf(`BSON::Binary.from_uuid('${uuid}')`);
      return leaf(`BSON::Binary.new(['${binaryHex(v.base64)}'].pack('H*'), :${RUBY_SUBTYPES[v.subType] ?? "user"})`);
    }
    case "Regex":
      return leaf(`BSON::Regexp::Raw.new(${rbStr(v.pattern)}${v.options !== "" ? `, '${v.options}'` : ""})`);
    case "Timestamp":
      return leaf(`BSON::Timestamp.new(${v.t}, ${v.i})`);
    case "Code":
      return v.scope === null ? leaf(`BSON::Code.new(${rbStr(v.code)})`) : call("BSON::CodeWithScope.new", [leaf(rbStr(v.code)), rbValue(v.scope)]);
    case "MinKey":
      return leaf("BSON::MinKey.new");
    case "MaxKey":
      return leaf("BSON::MaxKey.new");
    case "Undefined":
      return leaf("nil");
  }
}

function ruby(q: Query): string {
  const body: string[] = [];
  const args: Item[] = [];
  let run: string;
  if (q.source.kind === "find") {
    const f = q.source;
    body.push(statement("filter = ", rbValue(f.filter), "", 0, RB));
    args.push(item(leaf("filter")));
    if (f.projection !== null) args.push(item(rbValue(f.projection), "projection: "));
    if (f.sort !== null) args.push(item(rbValue(f.sort), "sort: "));
    if (f.skip > 0) args.push(item(leaf(String(f.skip)), "skip: "));
    if (f.limit > 0) args.push(item(leaf(String(f.limit)), "limit: "));
    run = "collection.find(";
  } else {
    body.push(statement("pipeline = ", rbValue(q.source.pipeline), "", 0, RB));
    args.push(item(leaf("pipeline")));
    run = "collection.aggregate(";
  }
  if (q.collation !== null) args.push(item(rbValue(q.collation), "collation: "));
  if (q.hint !== null) args.push(item(typeof q.hint === "string" ? leaf(rbStr(q.hint)) : rbValue(q.hint), "hint: "));
  if (q.maxTimeMS !== null) args.push(item(leaf(String(q.maxTimeMS)), "max_time_ms: "));
  body.push(statement("cursor = ", list(run, ")", args, false, false), "", 0, RB));
  body.push("cursor.each do |doc|", "  puts doc.to_extended_json(mode: :relaxed)", "end");
  const head: string[] = [];
  if (q.uri !== null) head.push(`client = Mongo::Client.new(${rbStr(q.uri)})`);
  head.push(`collection = client.use(${rbStr(q.db)})[${rbStr(q.coll)}]`);
  return joinBlocks([["require 'mongo'"], head, body, q.uri !== null ? ["client.close"] : []]);
}
