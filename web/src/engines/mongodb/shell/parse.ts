// The mongosh tab and the query bar: a parser for the subset of mongosh the
// app understands (MONGODB.md §3.8). Nothing is evaluated as JavaScript;
// text becomes a typed request, and anything else (variables, functions,
// loops, operators) is rejected with its position.

import { t } from "../../../i18n";
import {
  Binary,
  BsonDate,
  BsonRegex,
  Code,
  Decimal128,
  Double,
  Int32,
  Int64,
  MAX_KEY,
  MIN_KEY,
  ObjectId,
  Timestamp,
  UNDEFINED,
  fromEJSON,
  isDocument,
  isNumber,
  setField,
  toEJSON,
  type BsonDocument,
  type BsonValue,
  type EJSON,
} from "../bson";

// ---- Results ----

export interface ShellError {
  message: string;
  from: number;
  to: number;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: ShellError };

export type ExplainVerbosity = "queryPlanner" | "executionStats" | "allPlansExecution";

export interface FindRequest {
  kind: "find";
  coll: string;
  filter: BsonDocument;
  projection: BsonDocument | null;
  sort: BsonDocument | null;
  skip: number | null;
  limit: number | null;
}

export interface AggregateRequest {
  kind: "aggregate";
  coll: string;
  pipeline: BsonDocument[];
}

// Requests that run against a database: the one named by
// `db.getSiblingDB("…")`, else the tab's current one.
export type DbRequest =
  | { kind: "show"; what: "dbs" | "collections" }
  | FindRequest
  | AggregateRequest
  | { kind: "findOne"; coll: string; filter: BsonDocument; projection: BsonDocument | null }
  | { kind: "countDocuments"; coll: string; filter: BsonDocument }
  | { kind: "estimatedDocumentCount"; coll: string }
  | { kind: "distinct"; coll: string; key: string; filter: BsonDocument }
  | { kind: "insertOne"; coll: string; doc: BsonDocument }
  | { kind: "insertMany"; coll: string; docs: BsonDocument[] }
  | { kind: "updateOne" | "updateMany"; coll: string; filter: BsonDocument; update: BsonDocument | BsonDocument[]; upsert: boolean }
  | { kind: "replaceOne"; coll: string; filter: BsonDocument; replacement: BsonDocument; upsert: boolean }
  | { kind: "deleteOne" | "deleteMany"; coll: string; filter: BsonDocument }
  | { kind: "createIndex"; coll: string; keys: BsonDocument; options: BsonDocument }
  | { kind: "dropIndex"; coll: string; index: string | BsonDocument }
  | { kind: "getIndexes"; coll: string }
  | { kind: "drop"; coll: string }
  | { kind: "stats"; coll: string | null }
  | { kind: "explain"; verbosity: ExplainVerbosity; target: FindRequest | AggregateRequest };

// `db` on `use` is the database to switch to; on every other request it is
// the `getSiblingDB` database, or null for the tab's current one.
export type ShellRequest = { kind: "use"; db: string } | (DbRequest & { db: string | null });

export interface ShellStatement {
  from: number;
  to: number;
  result: ParseResult<ShellRequest>;
}

class ShellSyntaxError extends Error {
  constructor(
    message: string,
    readonly from: number,
    readonly to: number,
  ) {
    super(message);
  }
}

// ---- Tokens ----

export type TokenType = "str" | "num" | "regex" | "ident" | "punc" | "comment" | "bad";

export interface Token {
  type: TokenType;
  // Source text, except for strings, where it is the decoded value.
  text: string;
  from: number;
  to: number;
  // Strings and regexes: whether the closing quote or slash was found.
  closed: boolean;
}

const ID_START = /[A-Za-z_$\u00c0-\uffff]/;
const ID_PART = /[\w$\u00c0-\uffff]/;
const PUNCTUATION = "{}[](),:.;-+=!<>*%&|?~^";
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" };

// Tokens of `src`, positions shifted by `offset`. `tolerant` keeps going past
// unclosed strings and stray characters (for completion and highlighting).
export function tokenize(src: string, tolerant = false, offset = 0): Token[] {
  const out: Token[] = [];
  const n = src.length;
  let i = 0;
  const push = (type: TokenType, text: string, start: number, closed = true) => {
    out.push({ type, text, from: start + offset, to: i + offset, closed });
  };
  while (i < n) {
    const ch = src[i];
    const start = i;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") {
        i++;
      }
      push("comment", src.slice(start, i), start);
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      i = close < 0 ? n : close + 2;
      push("comment", src.slice(start, i), start, close >= 0);
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i++;
      let text = "";
      let closed = false;
      while (i < n) {
        const c = src[i];
        if (c === "\\") {
          const e = src[i + 1] ?? "";
          if (e === "u") {
            const braced = src[i + 2] === "{";
            const hex = braced ? src.slice(i + 3, src.indexOf("}", i + 3)) : src.slice(i + 2, i + 6);
            text += String.fromCodePoint(parseInt(hex, 16) || 0);
            i += braced ? hex.length + 4 : 6;
            continue;
          }
          if (e === "x") {
            text += String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16) || 0);
            i += 4;
            continue;
          }
          text += ESCAPES[e] ?? e;
          i += 2;
          continue;
        }
        if (c === ch) {
          closed = true;
          i++;
          break;
        }
        if (c === "\n" && ch !== "`") {
          break;
        }
        text += c;
        i++;
      }
      if (!closed && !tolerant) {
        throw new ShellSyntaxError(t("닫히지 않은 문자열입니다"), start + offset, i + offset);
      }
      if (ch === "`" && text.includes("${") && !tolerant) {
        throw new ShellSyntaxError(t("템플릿 문자열 안의 ${…}는 쓸 수 없습니다"), start + offset, i + offset);
      }
      push("str", text, start, closed);
      continue;
    }
    if (/\d/.test(ch) || (ch === "." && /\d/.test(src[i + 1] ?? ""))) {
      const m = /^(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(src.slice(i));
      i += m ? m[0].length : 1;
      push("num", src.slice(start, i), start);
      continue;
    }
    if (ch === "/") {
      // There is no division in this grammar: a lone slash opens a regex.
      i++;
      let inClass = false;
      let closed = false;
      while (i < n && src[i] !== "\n") {
        const c = src[i];
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "[") {
          inClass = true;
        } else if (c === "]") {
          inClass = false;
        } else if (c === "/" && !inClass) {
          closed = true;
          i++;
          break;
        }
        i++;
      }
      if (!closed && !tolerant) {
        throw new ShellSyntaxError(t("닫히지 않은 정규식입니다"), start + offset, i + offset);
      }
      while (closed && i < n && /[a-z]/.test(src[i])) {
        i++;
      }
      push("regex", src.slice(start, i), start, closed);
      continue;
    }
    if (ID_START.test(ch)) {
      while (i < n && ID_PART.test(src[i])) {
        i++;
      }
      push("ident", src.slice(start, i), start);
      continue;
    }
    i++;
    if (PUNCTUATION.includes(ch)) {
      push("punc", ch, start);
      continue;
    }
    if (!tolerant) {
      throw new ShellSyntaxError(t("알 수 없는 문자입니다: {char}", { char: ch }), start + offset, i + offset);
    }
    push("bad", ch, start);
  }
  return out;
}

// ---- Values ----

const OPERATOR_CHARS = "=+-*/%!<>&|?~^";

interface Arg {
  value: BsonValue;
  from: number;
  to: number;
}

class Parser {
  private readonly toks: Token[];
  private i = 0;

  constructor(
    private readonly src: string,
    private readonly offset: number,
    // Query-bar text: errors speak of the filter, not of mongosh.
    private readonly filter = false,
  ) {
    this.toks = tokenize(src, false, offset).filter((tok) => tok.type !== "comment");
  }

  peek(ahead = 0): Token | undefined {
    return this.toks[this.i + ahead];
  }

  next(): Token | undefined {
    return this.toks[this.i++];
  }

  // The next token where the caller has already seen that one is there.
  take(): Token {
    return this.next() ?? this.fail(t("입력이 끝났습니다"));
  }

  atEnd(): boolean {
    return this.i >= this.toks.length;
  }

  end(): number {
    return this.offset + this.src.length;
  }

  // The end of the last consumed token.
  lastEnd(): number {
    return this.toks[this.i - 1]?.to ?? this.offset;
  }

  isPunc(text: string, ahead = 0): boolean {
    const tok = this.peek(ahead);
    return tok !== undefined && tok.type === "punc" && tok.text === text;
  }

  fail(message: string, tok = this.peek()): never {
    throw new ShellSyntaxError(message, tok ? tok.from : this.end(), tok ? tok.to : this.end());
  }

  // JavaScript the app does not run: quote the source from the token on.
  unsupported(tok: Token, to = tok.to): never {
    const line = this.src.slice(tok.from - this.offset).split("\n")[0].trim();
    const text = line.length > 40 ? `${line.slice(0, 39)}…` : line;
    let message = this.filter ? t("필터를 읽을 수 없습니다: {text}", { text }) : t("지원하지 않는 mongosh 문법입니다: {text}", { text });
    if (!this.filter && ["var", "let", "const", "for", "while", "function", "if"].includes(tok.text)) {
      message += ` — ${t("변수·반복문·함수는 실행하지 않습니다. db.컬렉션.find({ … })처럼 쿼리를 한 문장씩 쓰세요")}`;
    } else if (!this.filter && (tok.text === "print" || tok.text === "printjson")) {
      message += ` — ${t("{name}() 없이 쿼리만 쓰면 결과 창에 보입니다", { name: tok.text })}`;
    }
    throw new ShellSyntaxError(message, tok.from, to);
  }

  // A token where something else was expected: an operator or a name reads
  // as JavaScript, anything else as a plain syntax error.
  unexpected(message: string): never {
    const tok = this.peek();
    if (tok && ((tok.type === "punc" && OPERATOR_CHARS.includes(tok.text)) || tok.type === "ident")) {
      this.unsupported(tok);
    }
    this.fail(tok ? `${message} (${tok.type === "str" ? JSON.stringify(tok.text) : tok.text})` : message);
  }

  expect(text: string): Token {
    if (!this.isPunc(text)) {
      this.unexpected(this.atEnd() ? t("'{want}'가 와야 하는데 입력이 끝났습니다", { want: text }) : t("'{want}'가 와야 합니다", { want: text }));
    }
    return this.take();
  }

  value(): BsonValue {
    const tok = this.peek();
    if (!tok) {
      this.fail(t("값이 와야 하는데 입력이 끝났습니다"));
    }
    if (tok.type === "punc") {
      if (tok.text === "{") {
        return this.object();
      }
      if (tok.text === "[") {
        return this.array();
      }
      if (tok.text === "-" || tok.text === "+") {
        return this.signed(tok);
      }
      this.unexpected(t("값이 와야 합니다"));
    }
    this.next();
    switch (tok.type) {
      case "str":
        return tok.text;
      case "num":
        return numberLiteral(tok.text);
      case "regex":
        return this.regex(tok);
      case "ident":
        return this.identValue(tok);
      default:
        return this.fail(t("값이 와야 합니다"), tok);
    }
  }

  signed(sign: Token): BsonValue {
    this.next();
    const tok = this.peek();
    const negative = sign.text === "-";
    // A literal keeps its own sign so -2147483648 is still an Int32.
    if (tok?.type === "num" && tok.from === sign.to) {
      this.next();
      return numberLiteral(negative ? `-${tok.text}` : tok.text);
    }
    const v = this.value();
    if (!isNumber(v)) {
      this.unsupported(sign, this.lastEnd());
    }
    if (!negative) {
      return v;
    }
    switch (v.type) {
      case "Int32":
        return v.value === -2147483648 ? new Int64(2147483648n) : new Int32(-v.value);
      case "Int64":
        return new Int64(-v.value);
      case "Double":
        return new Double(-v.value);
      case "Decimal128":
        return new Decimal128(v.value.startsWith("-") ? v.value.slice(1) : `-${v.value.replace(/^\+/, "")}`);
    }
  }

  regex(tok: Token): BsonRegex {
    const close = tok.text.lastIndexOf("/");
    const flags = tok.text.slice(close + 1);
    // `\/` exists only because of the literal's delimiters; the pattern
    // means a plain slash.
    const pattern = tok.text.slice(1, close).replace(/\\(.)/gs, (escape: string, c: string) => (c === "/" ? "/" : escape));
    try {
      return new BsonRegex(pattern, flags);
    } catch (e) {
      return this.fail(e instanceof Error ? e.message : String(e), tok);
    }
  }

  identValue(tok: Token): BsonValue {
    switch (tok.text) {
      case "true":
        return true;
      case "false":
        return false;
      case "null":
        return null;
      case "undefined":
        return UNDEFINED;
      case "Infinity":
        return new Double(Infinity);
      case "NaN":
        return new Double(NaN);
      case "new": {
        const ctor = this.next();
        if (!ctor || ctor.type !== "ident" || !this.isPunc("(")) {
          this.unsupported(tok);
        }
        return this.construct(ctor, ctor.text, true);
      }
    }
    // Binary.createFromBase64(…) and similar static constructors.
    if (this.isPunc(".") && this.peek(1)?.type === "ident" && this.isPunc("(", 2)) {
      this.next();
      const member = this.take();
      return this.construct(tok, `${tok.text}.${member.text}`, false);
    }
    if (this.isPunc("(")) {
      return this.construct(tok, tok.text, false);
    }
    return this.unsupported(tok);
  }

  args(): Arg[] {
    this.expect("(");
    const out: Arg[] = [];
    while (!this.isPunc(")")) {
      const from = this.peek()?.from ?? this.end();
      const value = this.value();
      out.push({ value, from, to: this.lastEnd() });
      if (!this.isPunc(")")) {
        this.expect(",");
      }
    }
    this.expect(")");
    return out;
  }

  construct(tok: Token, name: string, isNew: boolean): BsonValue {
    const args = this.args();
    const span = { from: tok.from, to: this.lastEnd() };
    const fail = (message: string): never => {
      throw new ShellSyntaxError(message, span.from, span.to);
    };
    const values = args.map((a) => a.value);
    if (values.length > CONSTRUCTOR_ARITY[name]) {
      fail(t("{name}()의 인수가 너무 많습니다", { name }));
    }
    const text = (v: BsonValue | undefined): string => {
      if (typeof v === "string") {
        return v;
      }
      if (isNumber(v)) {
        return String(v.value);
      }
      return fail(t("{name}()에는 문자열이나 숫자가 와야 합니다", { name }));
    };
    const int = (v: BsonValue | undefined, fallback: number): number => {
      if (v === undefined) {
        return fallback;
      }
      const n = Number(text(v));
      return Number.isInteger(n) ? n : fail(t("{name}()에는 정수가 와야 합니다", { name }));
    };
    const [a, b] = values;
    try {
      switch (name) {
        case "ObjectId":
          return a === undefined ? ObjectId.generate() : new ObjectId(text(a));
        case "ISODate":
          return a === undefined ? BsonDate.fromDate(new Date()) : isoDate(text(a));
        case "Date":
          if (!isNew) {
            // Without `new`, JavaScript's Date() is the current time as text.
            return new Date().toString();
          }
          if (a === undefined) {
            return BsonDate.fromDate(new Date());
          }
          if (isNumber(a)) {
            return new BsonDate(a.type === "Int64" ? a.value : Math.trunc(Number(text(a))));
          }
          return jsDate(text(a));
        case "NumberDecimal":
        case "Decimal128":
          return new Decimal128(a === undefined ? "0" : text(a));
        case "NumberInt":
        case "Int32":
          return new Int32(a === undefined ? 0 : Math.trunc(Number(text(a))));
        case "NumberLong":
        case "Long":
          return new Int64(a === undefined ? 0n : isNumber(a) && a.type === "Double" ? BigInt(Math.trunc(a.value)) : text(a));
        case "Double":
          return new Double(a === undefined ? 0 : Number(text(a)));
        case "UUID":
          return Binary.fromUuid(a === undefined ? crypto.randomUUID() : text(a));
        case "BinData":
          return new Binary(typeof b === "string" ? b : fail(t("BinData(하위 타입, base64)로 쓰세요")), int(a, 0));
        case "Binary.createFromBase64":
          return new Binary(typeof a === "string" ? a : fail(t("base64 문자열이 와야 합니다")), int(b, 0));
        case "Binary.createFromHexString":
          return Binary.fromHex(typeof a === "string" ? a : fail(t("16진수 문자열이 와야 합니다")), int(b, 0));
        case "Timestamp":
          if (isDocument(a)) {
            return new Timestamp(int(a.t, 0), int(a.i, 0));
          }
          return new Timestamp(int(a, 0), int(b, 0));
        case "MinKey":
          return MIN_KEY;
        case "MaxKey":
          return MAX_KEY;
        case "Code":
          if (b !== undefined && !isDocument(b)) {
            fail(t("Code()의 두 번째 인수는 문서여야 합니다"));
          }
          return new Code(text(a ?? ""), isDocument(b) ? b : null);
        case "RegExp":
          return new BsonRegex(text(a ?? ""), b === undefined ? "" : text(b));
      }
    } catch (e) {
      if (e instanceof ShellSyntaxError) {
        throw e;
      }
      fail(e instanceof Error ? e.message : String(e));
    }
    return this.unsupported(tok, span.to);
  }

  key(): string {
    const tok = this.next();
    if (!tok) {
      this.fail(t("키가 와야 하는데 입력이 끝났습니다"));
    }
    if (tok.type === "str" || tok.type === "num") {
      return tok.text;
    }
    if (tok.type === "ident") {
      // Unquoted dotted paths are allowed: { address.city: "Seoul" }.
      let key = tok.text;
      while (this.isPunc(".") && (this.peek(1)?.type === "ident" || this.peek(1)?.type === "num")) {
        this.next();
        key += `.${this.take().text}`;
      }
      return key;
    }
    if (tok.type === "punc" && tok.text === "[") {
      this.unsupported(tok);
    }
    return this.fail(t("키가 와야 합니다"), tok);
  }

  object(): BsonValue {
    const open = this.expect("{");
    const doc = this.entries("}");
    this.expect("}");
    // Extended JSON wrappers typed by hand ({ $oid: "…" }, { $date: "…" }).
    const keys = Object.keys(doc);
    if (keys.length > 0 && keys.length <= 2 && keys[0].startsWith("$")) {
      let typed: BsonValue;
      try {
        typed = fromEJSON(plainEJSON(doc));
      } catch (e) {
        throw new ShellSyntaxError(e instanceof Error ? e.message : String(e), open.from, this.lastEnd());
      }
      if (!isDocument(typed)) {
        return typed;
      }
    }
    return doc;
  }

  // `key: value` entries up to `close`, or to the end of the input for a
  // query-bar filter written without braces.
  entries(close: "}" | null): BsonDocument {
    const doc: BsonDocument = {};
    const done = () => (close === null ? this.atEnd() : this.isPunc(close));
    while (!done()) {
      if (this.isPunc(".") && this.isPunc(".", 1)) {
        this.unsupported(this.take());
      }
      const key = this.key();
      this.expect(":");
      setField(doc, key, this.value());
      if (!done()) {
        if (!this.isPunc(",")) {
          this.unexpected(
            close === null ? t("'{want}'가 와야 합니다", { want: "," }) : this.atEnd() ? t("'}'가 와야 하는데 입력이 끝났습니다") : t("',' 또는 '}'가 와야 합니다"),
          );
        }
        this.next();
      }
    }
    return doc;
  }

  array(): BsonValue[] {
    this.expect("[");
    const out: BsonValue[] = [];
    while (!this.isPunc("]")) {
      out.push(this.value());
      if (!this.isPunc("]")) {
        if (!this.isPunc(",")) {
          this.unexpected(this.atEnd() ? t("']'가 와야 하는데 입력이 끝났습니다") : t("',' 또는 ']'가 와야 합니다"));
        }
        this.next();
      }
    }
    this.expect("]");
    return out;
  }

  skipSemicolons(): void {
    while (this.isPunc(";")) {
      this.next();
    }
  }

  finish(): void {
    this.skipSemicolons();
    if (!this.atEnd()) {
      const tok = this.take();
      if (tok.type === "punc" && OPERATOR_CHARS.includes(tok.text)) {
        this.unsupported(tok);
      }
      this.fail(this.filter ? t("필터 뒤에 남은 내용이 있습니다: {text}", { text: tok.text }) : t("문장 뒤에 남은 내용이 있습니다: {text}", { text: tok.text }), tok);
    }
  }
}

const CONSTRUCTOR_ARITY: Record<string, number> = {
  ObjectId: 1,
  ISODate: 1,
  Date: 1,
  NumberDecimal: 1,
  Decimal128: 1,
  NumberInt: 1,
  Int32: 1,
  NumberLong: 1,
  Long: 1,
  Double: 1,
  UUID: 1,
  BinData: 2,
  "Binary.createFromBase64": 2,
  "Binary.createFromHexString": 2,
  Timestamp: 2,
  MinKey: 0,
  MaxKey: 0,
  Code: 2,
  RegExp: 2,
};

// A number literal the way mongosh stores it: integers that fit become
// Int32, everything else a Double.
function numberLiteral(text: string): Int32 | Double {
  const n = /^[+-]?0[xX]/.test(text) ? (text.startsWith("-") ? -1 : 1) * parseInt(text.replace(/^[+-]?0[xX]/, ""), 16) : Number(text);
  const integral = !/[.eE]/.test(text) || /^[+-]?0[xX]/.test(text);
  if (integral && Number.isInteger(n) && n >= -2147483648 && n <= 2147483647 && !Object.is(n, -0)) {
    return new Int32(n);
  }
  return new Double(n);
}

// ISODate() reads a date-time without a zone as UTC, as mongosh does.
function isoDate(text: string): BsonDate {
  let iso = text.trim().replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(iso)) {
    iso += "Z";
  }
  return jsDate(iso);
}

function jsDate(text: string): BsonDate {
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) {
    throw new Error(t("날짜로 읽을 수 없습니다: {text}", { text }));
  }
  return new BsonDate(ms);
}

// Parsed values as the plain JSON fromEJSON expects inside a wrapper:
// shell numbers become JSON numbers again.
function plainEJSON(v: BsonValue): EJSON {
  if (v instanceof Int32 || v instanceof Double) {
    return v.value;
  }
  if (isDocument(v)) {
    const out: { [key: string]: EJSON } = {};
    for (const key of Object.keys(v)) {
      out[key] = plainEJSON(v[key]);
    }
    return out;
  }
  return Array.isArray(v) ? v.map(plainEJSON) : toEJSON(v);
}

function capture<T>(run: () => T): ParseResult<T> {
  try {
    return { ok: true, value: run() };
  } catch (e) {
    if (e instanceof ShellSyntaxError) {
      return { ok: false, error: { message: e.message, from: e.from, to: e.to } };
    }
    throw e;
  }
}

// One value in relaxed Extended JSON / shell notation.
export function parseValue(text: string, offset = 0): ParseResult<BsonValue> {
  return capture(() => {
    const p = new Parser(text, offset);
    const v = p.value();
    p.finish();
    return v;
  });
}

// A document for the query bar's filter, projection or sort box. Empty
// text is the empty document; text not starting with `{` is read as the
// document's entries (`status: "paid"` ≡ `{ status: "paid" }`).
export function parseFilter(text: string, offset = 0): ParseResult<BsonDocument> {
  return capture(() => {
    const p = new Parser(text, offset, true);
    if (p.atEnd()) {
      return {};
    }
    if (!p.isPunc("{")) {
      const doc = p.entries(null);
      p.finish();
      return doc;
    }
    const from = p.peek()?.from ?? offset;
    const v = p.value();
    p.finish();
    if (!isDocument(v)) {
      throw new ShellSyntaxError(t("{ … } 형태의 문서가 와야 합니다"), from, p.lastEnd());
    }
    return v;
  });
}

// ---- Statements ----

const VERBOSITIES: ExplainVerbosity[] = ["queryPlanner", "executionStats", "allPlansExecution"];

interface Call {
  name: string;
  args: Arg[];
  from: number;
  to: number;
}

// One mongosh statement as a request.
export function parseStatement(text: string, offset = 0): ParseResult<ShellRequest> {
  return capture(() => statement(new Parser(text, offset), text, offset));
}

// Database names `use` and `getSiblingDB` accept.
const DB_NAME = /^[^\s/\\."$*<>:|?;]+$/;

function statement(p: Parser, text: string, offset: number): ShellRequest {
  p.skipSemicolons();
  const first = p.next();
  if (!first) {
    throw new ShellSyntaxError(t("실행할 문장이 없습니다"), offset, offset + text.length);
  }
  if (first.type === "ident" && first.text === "use") {
    const name = text
      .slice(first.to - offset)
      .replace(/;\s*$/, "")
      .trim();
    if (!DB_NAME.test(name)) {
      throw new ShellSyntaxError(t("use 다음에는 데이터베이스 이름이 와야 합니다"), first.from, offset + text.length);
    }
    return { kind: "use", db: name };
  }
  if (first.type === "ident" && first.text === "show") {
    const what = p.next();
    if (!what || what.type !== "ident") {
      p.fail(t("show 다음에는 dbs 또는 collections가 와야 합니다"), what);
    }
    p.finish();
    if (what.text === "dbs" || what.text === "databases") {
      return { kind: "show", what: "dbs", db: null };
    }
    if (what.text === "collections" || what.text === "tables") {
      return { kind: "show", what: "collections", db: null };
    }
    return p.unsupported(first, what.to);
  }
  if (first.type !== "ident" || first.text !== "db" || !(p.isPunc(".") || p.isPunc("["))) {
    return p.unsupported(first);
  }
  // db.getSiblingDB("shop").orders.find(…), as History records operations.
  let db: string | null = null;
  if (p.isPunc(".") && p.peek(1)?.text === "getSiblingDB" && p.isPunc("(", 2)) {
    p.next();
    const method = p.take();
    const args = p.args();
    const name = args.length === 1 ? args[0].value : null;
    if (typeof name !== "string" || !DB_NAME.test(name)) {
      throw new ShellSyntaxError(t("getSiblingDB()에는 데이터베이스 이름 문자열 하나가 와야 합니다"), method.from, p.lastEnd());
    }
    db = name;
  }
  return { ...dbStatement(p), db };
}

// What follows `db` (or `db.getSiblingDB(…)`): a database method, or a
// collection and its method calls.
function dbStatement(p: Parser): DbRequest {
  const coll = collectionName(p);
  if (coll === null) {
    const method = p.take();
    const args = p.args();
    p.finish();
    if (method.text === "runCommand") {
      // Only the command History records for dropping a collection.
      const command = args.length === 1 ? args[0].value : null;
      if (isDocument(command) && Object.keys(command).length === 1 && typeof command.drop === "string") {
        return { kind: "drop", coll: command.drop };
      }
      return p.unsupported(method, p.lastEnd());
    }
    if (args.length > 0) {
      throw new ShellSyntaxError(t("{name}()에는 인수가 없습니다", { name: method.text }), args[0].from, args[args.length - 1].to);
    }
    if (method.text === "stats") {
      return { kind: "stats", coll: null };
    }
    return { kind: "show", what: "collections" };
  }
  const calls: Call[] = [];
  while (p.isPunc(".")) {
    p.next();
    const name = p.next();
    if (!name || name.type !== "ident") {
      p.fail(t("메서드 이름이 와야 합니다"), name);
    }
    if (!p.isPunc("(")) {
      p.unsupported(name);
    }
    const args = p.args();
    calls.push({ name: name.text, args, from: name.from, to: p.lastEnd() });
  }
  p.finish();
  if (calls.length === 0) {
    throw new ShellSyntaxError(t("db.{coll} 다음에 메서드를 부르세요 (예: .find())", { coll: coll.name }), coll.from, coll.to);
  }
  return collectionRequest(coll.name, calls);
}

// The collection after `db`: `db.orders`, `db["order items"]`,
// `db.getCollection("x")`, dotted names such as `db.system.profile`. Null
// when the statement is a database method instead (`stats`,
// `getCollectionNames`, `getCollectionInfos`, `runCommand`; the parser then
// sits on the method name).
function collectionName(p: Parser): { name: string; from: number; to: number } | null {
  if (p.isPunc("[")) {
    p.next();
    const tok = p.next();
    if (!tok || tok.type !== "str") {
      p.fail(t("db[…] 안에는 컬렉션 이름 문자열이 와야 합니다"), tok);
    }
    p.expect("]");
    return { name: tok.text, from: tok.from, to: tok.to };
  }
  p.expect(".");
  const tok = p.peek();
  if (!tok || tok.type !== "ident") {
    p.fail(t("db. 다음에는 컬렉션 이름이 와야 합니다"), tok);
  }
  if (p.isPunc("(", 1)) {
    if (tok.text === "getCollection") {
      p.next();
      const args = p.args();
      if (args.length !== 1 || typeof args[0].value !== "string") {
        throw new ShellSyntaxError(t("getCollection()에는 이름 문자열 하나가 와야 합니다"), tok.from, p.lastEnd());
      }
      return { name: args[0].value, from: args[0].from, to: args[0].to };
    }
    if (["stats", "getCollectionNames", "getCollectionInfos", "runCommand"].includes(tok.text)) {
      return null;
    }
    p.unsupported(tok);
  }
  p.next();
  let name = tok.text;
  let to = tok.to;
  while (p.isPunc(".") && p.peek(1)?.type === "ident" && !p.isPunc("(", 2)) {
    p.next();
    const part = p.take();
    name += `.${part.text}`;
    to = part.to;
  }
  return { name, from: tok.from, to };
}

function collectionRequest(coll: string, calls: Call[]): DbRequest {
  let verbosity: ExplainVerbosity | null = null;
  let rest = calls;
  // db.c.explain("executionStats").find(…)
  if (calls[0].name === "explain") {
    verbosity = explainVerbosity(calls[0]);
    rest = calls.slice(1);
    if (rest.length === 0) {
      throw new ShellSyntaxError(t("explain() 다음에 find나 aggregate를 부르세요"), calls[0].from, calls[0].to);
    }
  }
  const [call, ...chain] = rest;
  const target = (request: FindRequest | AggregateRequest): DbRequest =>
    verbosity === null ? request : { kind: "explain", verbosity, target: request };
  if (verbosity !== null && call.name !== "find" && call.name !== "aggregate") {
    throw new ShellSyntaxError(t("explain()은 find와 aggregate에만 쓸 수 있습니다"), call.from, call.to);
  }
  switch (call.name) {
    case "find": {
      arity(call, 0, 2);
      const request: FindRequest = {
        kind: "find",
        coll,
        filter: optionalDocArg(call, 0) ?? {},
        projection: optionalDocArg(call, 1),
        sort: null,
        skip: null,
        limit: null,
      };
      for (const link of chain) {
        if (verbosity !== null) {
          throw new ShellSyntaxError(t("explain() 뒤에는 다른 메서드를 이을 수 없습니다"), link.from, link.to);
        }
        switch (link.name) {
          case "sort":
            arity(link, 1, 1);
            request.sort = docArg(link, 0);
            break;
          case "skip":
          case "limit":
            arity(link, 1, 1);
            request[link.name] = countArg(link);
            break;
          case "projection":
          case "project":
            arity(link, 1, 1);
            request.projection = docArg(link, 0);
            break;
          case "explain":
            verbosity = explainVerbosity(link);
            break;
          case "toArray":
          case "pretty":
            arity(link, 0, 0);
            break;
          default:
            throw unsupportedCall(link);
        }
      }
      return target(request);
    }
    case "aggregate": {
      arity(call, 1, 1);
      const pipeline = call.args[0].value;
      if (!Array.isArray(pipeline) || !pipeline.every(isDocument)) {
        throw new ShellSyntaxError(t("aggregate()에는 단계 문서의 배열 [ { … } ]이 와야 합니다"), call.args[0].from, call.args[0].to);
      }
      for (const link of chain) {
        if (link.name === "explain" && verbosity === null) {
          verbosity = explainVerbosity(link);
        } else if (link.name === "toArray") {
          arity(link, 0, 0);
        } else {
          throw unsupportedCall(link, "aggregate");
        }
      }
      return target({ kind: "aggregate", coll, pipeline });
    }
  }
  if (chain.length > 0) {
    throw unsupportedCall(chain[0]);
  }
  switch (call.name) {
    case "findOne":
      arity(call, 0, 2);
      return { kind: "findOne", coll, filter: optionalDocArg(call, 0) ?? {}, projection: optionalDocArg(call, 1) };
    case "countDocuments": {
      arity(call, 0, 2);
      // { maxTimeMS } is allowed (History records it) but the app applies
      // its own time limit.
      const options = optionalDocArg(call, 1) ?? {};
      for (const key of Object.keys(options)) {
        if (key !== "maxTimeMS" || !isNumber(options.maxTimeMS)) {
          throw new ShellSyntaxError(t("지원하지 않는 옵션입니다: {name}", { name: key }), call.args[1].from, call.args[1].to);
        }
      }
      return { kind: "countDocuments", coll, filter: optionalDocArg(call, 0) ?? {} };
    }
    case "estimatedDocumentCount":
      arity(call, 0, 0);
      return { kind: "estimatedDocumentCount", coll };
    case "distinct": {
      arity(call, 1, 2);
      const key = call.args[0].value;
      if (typeof key !== "string") {
        throw new ShellSyntaxError(t("distinct()의 첫 인수는 필드 이름 문자열입니다"), call.args[0].from, call.args[0].to);
      }
      return { kind: "distinct", coll, key, filter: optionalDocArg(call, 1) ?? {} };
    }
    case "insertOne":
      arity(call, 1, 1);
      return { kind: "insertOne", coll, doc: docArg(call, 0) };
    case "insertMany": {
      arity(call, 1, 1);
      const docs = call.args[0].value;
      if (!Array.isArray(docs) || !docs.every(isDocument)) {
        throw new ShellSyntaxError(t("insertMany()에는 문서의 배열 [ { … } ]이 와야 합니다"), call.args[0].from, call.args[0].to);
      }
      return { kind: "insertMany", coll, docs };
    }
    case "updateOne":
    case "updateMany": {
      arity(call, 2, 3);
      // Update operators ({ $set: … }) or an update pipeline ([ { $set: … } ]).
      const raw = call.args[1].value;
      let update: BsonDocument | BsonDocument[];
      if (isDocument(raw) && Object.keys(raw).length > 0 && Object.keys(raw).every((k) => k.startsWith("$"))) {
        update = raw;
      } else if (Array.isArray(raw) && raw.every(isDocument)) {
        update = raw;
      } else {
        throw new ShellSyntaxError(t("수정 문서에는 $set 같은 연산자만 쓸 수 있습니다 (문서를 통째로 바꾸려면 replaceOne)"), call.args[1].from, call.args[1].to);
      }
      return {
        kind: call.name,
        coll,
        filter: docArg(call, 0),
        update,
        upsert: upsertOption(call, 2),
      };
    }
    case "replaceOne": {
      arity(call, 2, 3);
      const replacement = docArg(call, 1);
      if (Object.keys(replacement).some((k) => k.startsWith("$"))) {
        throw new ShellSyntaxError(t("바꿀 문서에는 $ 연산자를 쓸 수 없습니다"), call.args[1].from, call.args[1].to);
      }
      return { kind: "replaceOne", coll, filter: docArg(call, 0), replacement, upsert: upsertOption(call, 2) };
    }
    case "deleteOne":
    case "deleteMany":
      arity(call, 1, 1);
      return { kind: call.name, coll, filter: docArg(call, 0) };
    case "createIndex":
      arity(call, 1, 2);
      return { kind: "createIndex", coll, keys: docArg(call, 0), options: optionalDocArg(call, 1) ?? {} };
    case "dropIndex": {
      arity(call, 1, 1);
      const index = call.args[0].value;
      if (typeof index !== "string" && !isDocument(index)) {
        throw new ShellSyntaxError(t("dropIndex()에는 인덱스 이름이나 키 문서가 와야 합니다"), call.args[0].from, call.args[0].to);
      }
      return { kind: "dropIndex", coll, index };
    }
    case "getIndexes":
      arity(call, 0, 0);
      return { kind: "getIndexes", coll };
    case "drop":
      arity(call, 0, 0);
      return { kind: "drop", coll };
    case "stats":
      arity(call, 0, 0);
      return { kind: "stats", coll };
  }
  throw unsupportedCall(call);
}

// The supported form to use instead of a mongosh method the app does not
// run, if there is one.
const INSTEAD: Record<string, string> = {
  insert: "insertOne() · insertMany()",
  save: "insertOne() · replaceOne()",
  update: "updateOne() · updateMany()",
  remove: "deleteOne() · deleteMany()",
  count: "countDocuments()",
  itcount: "countDocuments()",
  size: "countDocuments()",
  findOneAndUpdate: "updateOne()",
  findOneAndReplace: "replaceOne()",
  findOneAndDelete: "deleteOne()",
  bulkWrite: "insertMany() · updateMany() · deleteMany()",
  createIndexes: "createIndex()",
  dropIndexes: "dropIndex()",
  getIndexKeys: "getIndexes()",
  getIndexSpecs: "getIndexes()",
  dataSize: "stats()",
  totalSize: "stats()",
  storageSize: "stats()",
};

// Cursor methods after aggregate() that have a stage of their own.
const STAGE_INSTEAD: Record<string, string> = { sort: "$sort", limit: "$limit", skip: "$skip", project: "$project", projection: "$project", count: "$count" };

function unsupportedCall(call: Call, after?: "aggregate"): ShellSyntaxError {
  const text = `.${call.name}()`;
  const stage = after === "aggregate" ? STAGE_INSTEAD[call.name] : undefined;
  const instead = stage !== undefined ? t("{stage} 단계를 파이프라인에 넣으세요", { stage }) : Object.hasOwn(INSTEAD, call.name) ? t("{form}를 쓰세요", { form: INSTEAD[call.name] }) : null;
  const message = t("지원하지 않는 mongosh 문법입니다: {text}", { text });
  return new ShellSyntaxError(instead === null ? message : `${message} — ${instead}`, call.from, call.to);
}

function arity(call: Call, min: number, max: number): void {
  if (call.args.length < min) {
    throw new ShellSyntaxError(t("{name}()에 인수가 모자랍니다", { name: call.name }), call.from, call.to);
  }
  if (call.args.length > max) {
    const extra = call.args[max];
    throw new ShellSyntaxError(t("{name}()의 인수가 너무 많습니다", { name: call.name }), extra.from, call.args[call.args.length - 1].to);
  }
}

function docArg(call: Call, index: number): BsonDocument {
  const arg = call.args[index];
  if (arg === undefined || !isDocument(arg.value)) {
    throw new ShellSyntaxError(t("{ … } 형태의 문서가 와야 합니다"), arg?.from ?? call.from, arg?.to ?? call.to);
  }
  return arg.value;
}

// The document argument at `index`, or null when it was not given.
function optionalDocArg(call: Call, index: number): BsonDocument | null {
  return call.args[index] === undefined ? null : docArg(call, index);
}

function countArg(call: Call): number {
  const arg = call.args[0];
  const n = isNumber(arg.value) ? Number(arg.value.value) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new ShellSyntaxError(t("{name}()에는 0 이상의 정수가 와야 합니다", { name: call.name }), arg.from, arg.to);
  }
  return n;
}

function explainVerbosity(call: Call): ExplainVerbosity {
  arity(call, 0, 1);
  const arg = call.args[0];
  if (arg === undefined) {
    return "queryPlanner";
  }
  if (typeof arg.value === "boolean") {
    return arg.value ? "allPlansExecution" : "queryPlanner";
  }
  const found = VERBOSITIES.find((v) => v === arg.value);
  if (found === undefined) {
    throw new ShellSyntaxError(t("explain()에는 {list} 중 하나가 와야 합니다", { list: VERBOSITIES.join(", ") }), arg.from, arg.to);
  }
  return found;
}

function upsertOption(call: Call, index: number): boolean {
  const options = optionalDocArg(call, index);
  if (options === null) {
    return false;
  }
  for (const key of Object.keys(options)) {
    if (key !== "upsert" || typeof options.upsert !== "boolean") {
      const arg = call.args[index];
      throw new ShellSyntaxError(t("지원하지 않는 옵션입니다: {name}", { name: key }), arg.from, arg.to);
    }
  }
  return options.upsert === true;
}

// ---- Scripts ----

// Punctuation that leaves a statement unfinished at the end of a line.
const OPEN_ENDINGS = ".,:=+-*/%<>&|^?!~";
// Punctuation that continues the previous line's statement when a line
// starts with it (`.sort(…)`, an operator, a closing bracket).
const CONTINUATIONS = ".,:=+-*/%<>&|^?)]}";

// Statement ranges as mongosh reads them. A top-level `;` or blank line
// ends a statement; so does a line break once the statement is complete
// (brackets and strings closed, the line not ending in an operator) unless
// the next line continues it. Comment lines are skipped when looking for
// that next line, and comments between statements belong to none.
export function splitStatements(text: string): { from: number; to: number }[] {
  const toks = tokenize(text, true);
  const out: { from: number; to: number }[] = [];
  let depth = 0;
  let first: Token | null = null;
  let last: Token | null = null;
  let prevEnd = 0;
  // Since the last significant token: a blank line, a line break.
  let blank = false;
  let lineBreak = false;
  const close = () => {
    if (first !== null && last !== null) {
      out.push({ from: first.from, to: last.to });
    }
    first = null;
    last = null;
    depth = 0;
  };
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    const gap = text.slice(prevEnd, tok.from);
    prevEnd = tok.to;
    blank ||= /\n[ \t\r]*\n/.test(gap);
    lineBreak ||= gap.includes("\n");
    if (tok.type === "comment") {
      lineBreak ||= tok.text.includes("\n");
      continue;
    }
    if (last !== null && depth === 0 && (blank || (lineBreak && statementComplete(last) && !continuesLine(tok, toks[i + 1])))) {
      close();
    }
    blank = false;
    lineBreak = false;
    if (first === null) {
      if (tok.type === "punc" && tok.text === ";") {
        continue;
      }
      first = tok;
    }
    last = tok;
    if (tok.type === "punc") {
      if ("{[(".includes(tok.text)) {
        depth++;
      } else if ("}])".includes(tok.text)) {
        depth = Math.max(0, depth - 1);
      } else if (tok.text === ";" && depth === 0) {
        close();
      }
    }
  }
  close();
  return out;
}

// Whether a statement may end after `last` (outside brackets).
function statementComplete(last: Token): boolean {
  if ((last.type === "str" || last.type === "regex") && !last.closed) {
    return false;
  }
  if (last.type === "punc") {
    return !OPEN_ENDINGS.includes(last.text);
  }
  return !(last.type === "ident" && last.text === "new");
}

// Whether a line starting with `tok` continues the statement before it.
function continuesLine(tok: Token, next: Token | undefined): boolean {
  if (tok.type === "regex") {
    // A slash after a complete statement is division, not a new regex.
    return true;
  }
  if (tok.type !== "punc") {
    return false;
  }
  if (tok.text === "!") {
    return next?.type === "punc" && next.text === "=" && next.from === tok.to;
  }
  return CONTINUATIONS.includes(tok.text);
}

// Every statement in the editor, parsed.
export function parseScript(text: string): ShellStatement[] {
  return splitStatements(text).map((range) => ({ ...range, result: parseStatement(text.slice(range.from, range.to), range.from) }));
}

// The statement range under (or just before) the cursor.
export function statementAt(text: string, cursor: number): { from: number; to: number } | null {
  let best: { from: number; to: number } | null = null;
  for (const range of splitStatements(text)) {
    if (cursor >= range.from && cursor <= range.to) {
      return range;
    }
    if (range.from <= cursor || best === null) {
      best = range;
    }
  }
  return best;
}
