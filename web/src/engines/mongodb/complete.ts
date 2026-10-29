// Completion candidates for the query bar (filter, projection, sort), the
// mongosh tab and, later, the aggregation editor: field paths sampled from
// documents, query/update operators, aggregation stages and expressions.
// Plain data; the CodeMirror layer turns items into its own completions.

import { t } from "../../i18n";
import { isDocument, typeName, type BsonDocument, type BsonTypeName, type BsonValue } from "./bson";
import { toShell } from "./format";
import { tokenize, type Token } from "./shell/parse";

// ---- Operator reference ----

// name → [short description, example]
type OpDocs = Record<string, [string, string]>;

export const QUERY_OPERATORS: OpDocs = {
  $eq: ["같음", '{ status: { $eq: "paid" } }'],
  $ne: ["같지 않음 (필드가 없는 문서도 포함)", '{ status: { $ne: "cancelled" } }'],
  $gt: ["보다 큼", '{ total: { $gt: NumberDecimal("500") } }'],
  $gte: ["크거나 같음", '{ orderedAt: { $gte: ISODate("2025-03-01") } }'],
  $lt: ["보다 작음", "{ stock: { $lt: 10 } }"],
  $lte: ["작거나 같음", "{ rating: { $lte: 2 } }"],
  $in: ["배열 안의 값 중 하나와 같음", '{ status: { $in: ["paid", "shipped"] } }'],
  $nin: ["배열 안의 어느 값과도 같지 않음", '{ tier: { $nin: ["free"] } }'],
  $exists: ["필드가 있는지 (true) 없는지 (false)", "{ coupon: { $exists: true } }"],
  $regex: ["정규식과 맞는 문자열", '{ email: { $regex: "^user1", $options: "i" } }'],
  $options: ["$regex 옵션 (i, m, s, x)", '{ name: { $regex: "램프", $options: "i" } }'],
  $not: ["조건을 뒤집음", "{ rating: { $not: { $gte: 3 } } }"],
  $size: ["배열 길이가 정확히 n", "{ items: { $size: 3 } }"],
  $elemMatch: ["배열 원소 하나가 모든 조건을 만족", "{ items: { $elemMatch: { quantity: { $gte: 3 } } } }"],
  $all: ["배열이 모든 값을 포함", '{ categories: { $all: ["gift", "lifestyle"] } }'],
  $type: ["BSON 타입이 같음", '{ body: { $type: "null" } }'],
  $mod: ["나눈 나머지가 같음", "{ orderNo: { $mod: [2, 0] } }"],
};

export const LOGICAL_OPERATORS: OpDocs = {
  $and: ["모든 조건을 만족", '{ $and: [ { status: "paid" }, { coupon: { $exists: true } } ] }'],
  $or: ["조건 중 하나라도 만족", '{ $or: [ { tier: "pro" }, { tier: "enterprise" } ] }'],
  $nor: ["어느 조건도 만족하지 않음", "{ $nor: [ { active: false } ] }"],
  $expr: ["집계 식으로 비교", '{ $expr: { $gt: [ { $size: "$items" }, 3 ] } }'],
};

export const STAGES: OpDocs = {
  $match: ["필터로 문서를 거름", '{ $match: { status: "paid" } }'],
  $project: ["필드를 고르거나 계산", '{ $project: { orderNo: 1, n: { $size: "$items" } } }'],
  $addFields: ["계산한 필드를 더함", '{ $addFields: { itemCount: { $size: "$items" } } }'],
  $set: ["$addFields와 같음", '{ $set: { year: { $year: "$orderedAt" } } }'],
  $unset: ["필드를 뺌", '{ $unset: "items" }'],
  $group: ["_id로 묶고 누산", '{ $group: { _id: "$status", n: { $sum: 1 } } }'],
  $sort: ["정렬", "{ $sort: { total: -1 } }"],
  $skip: ["앞의 n개를 건너뜀", "{ $skip: 20 }"],
  $limit: ["n개까지만", "{ $limit: 10 }"],
  $unwind: ["배열을 원소별 문서로 펼침", '{ $unwind: "$items" }'],
  $lookup: ["다른 컬렉션과 조인 (localField = foreignField)", '{ $lookup: { from: "customers", localField: "customerId", foreignField: "_id", as: "customer" } }'],
  $count: ["문서 수를 한 필드로", '{ $count: "n" }'],
  $sortByCount: ["값별 개수를 많은 순으로", '{ $sortByCount: "$status" }'],
  $replaceRoot: ["하위 문서를 루트로", '{ $replaceRoot: { newRoot: "$shipping" } }'],
  $facet: ["여러 파이프라인을 한 번에", '{ $facet: { byStatus: [ { $sortByCount: "$status" } ] } }'],
  $sample: ["무작위로 n개", "{ $sample: { size: 100 } }"],
  $out: ["결과로 컬렉션을 통째로 바꿈 (마지막 단계)", '{ $out: "orders_summary" }'],
  $merge: ["결과를 컬렉션에 합침 (마지막 단계)", '{ $merge: { into: "orders_summary", whenMatched: "replace", whenNotMatched: "insert" } }'],
};

export const ACCUMULATORS: OpDocs = {
  $sum: ["합계 (1이면 개수)", '{ $sum: "$total" }'],
  $avg: ["평균", '{ $avg: "$rating" }'],
  $min: ["최솟값", '{ $min: "$orderedAt" }'],
  $max: ["최댓값", '{ $max: "$total" }'],
  $count: ["묶음의 문서 수", "{ $count: {} }"],
  $push: ["값을 배열로 모음", '{ $push: "$orderNo" }'],
  $addToSet: ["서로 다른 값을 배열로 모음", '{ $addToSet: "$shipping.city" }'],
  $first: ["묶음의 첫 값", '{ $first: "$orderedAt" }'],
  $last: ["묶음의 마지막 값", '{ $last: "$orderedAt" }'],
};

export const EXPRESSIONS: OpDocs = {
  $add: ["더하기", '{ $add: ["$a", "$b"] }'],
  $subtract: ["뺄셈", '{ $subtract: ["$a", "$b"] }'],
  $multiply: ["곱하기", '{ $multiply: ["$quantity", "$unitPrice"] }'],
  $divide: ["나누기", '{ $divide: ["$total", 2] }'],
  $round: ["반올림", '{ $round: ["$avg", 2] }'],
  $size: ["배열 길이", '{ $size: "$items" }'],
  $concat: ["문자열 잇기", '{ $concat: ["$shipping.city", ", ", "$shipping.country"] }'],
  $toUpper: ["대문자로", '{ $toUpper: "$status" }'],
  $toLower: ["소문자로", '{ $toLower: "$sku" }'],
  $year: ["연도", '{ $year: "$orderedAt" }'],
  $month: ["월", '{ $month: "$orderedAt" }'],
  $dayOfMonth: ["일", '{ $dayOfMonth: "$orderedAt" }'],
  $dateToString: ["날짜를 문자열로", '{ $dateToString: { format: "%Y-%m", date: "$orderedAt" } }'],
  $cond: ["조건 분기", '{ $cond: [ { $gte: ["$total", 500] }, "big", "small" ] }'],
  $ifNull: ["null이면 대신할 값", '{ $ifNull: ["$coupon", "없음"] }'],
  $eq: ["같은지", '{ $eq: ["$status", "paid"] }'],
  $ne: ["다른지", '{ $ne: ["$status", "paid"] }'],
  $gt: ["큰지", '{ $gt: ["$total", 100] }'],
  $gte: ["크거나 같은지", '{ $gte: ["$rating", 4] }'],
  $lt: ["작은지", '{ $lt: ["$stock", 10] }'],
  $lte: ["작거나 같은지", '{ $lte: ["$stock", 10] }'],
  $and: ["모두 참인지", "{ $and: [ … ] }"],
  $or: ["하나라도 참인지", "{ $or: [ … ] }"],
  $in: ["배열에 있는지", '{ $in: ["$status", ["paid", "shipped"]] }'],
  $arrayElemAt: ["배열의 n번째", '{ $arrayElemAt: ["$items", 0] }'],
  $first: ["배열의 첫 원소", '{ $first: "$items" }'],
  $sum: ["배열 합계", '{ $sum: "$items.quantity" }'],
  $avg: ["배열 평균", '{ $avg: "$items.unitPrice" }'],
  $toString: ["문자열로", '{ $toString: "$_id" }'],
  $toDecimal: ["Decimal128로", '{ $toDecimal: "$price" }'],
  $literal: ["값 그대로", '{ $literal: "$notAField" }'],
};

// Expressions whose argument is a list ({ $add: [ … ] }).
const LIST_EXPRESSIONS = ["$and", "$or", "$concat", "$add", "$multiply", "$subtract", "$divide", "$cond", "$ifNull", "$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$arrayElemAt", "$round"];

export const UPDATE_OPERATORS: OpDocs = {
  $set: ["필드 값을 바꾸거나 새로 만듦", '{ $set: { status: "paid" } }'],
  $unset: ["필드를 지움", '{ $unset: { coupon: "" } }'],
  $inc: ["숫자를 더함 (타입 유지)", "{ $inc: { stock: -1 } }"],
  $mul: ["숫자를 곱함", '{ $mul: { price: NumberDecimal("1.1") } }'],
  $push: ["배열에 추가", '{ $push: { tags: "vip" } }'],
  $addToSet: ["배열에 없으면 추가", '{ $addToSet: { tags: "vip" } }'],
  $pull: ["배열에서 맞는 원소를 뺌", '{ $pull: { tags: "vip" } }'],
  $rename: ["필드 이름 바꾸기", '{ $rename: { phone: "tel" } }'],
  $min: ["더 작을 때만 바꿈", "{ $min: { stock: 0 } }"],
  $max: ["더 클 때만 바꿈", "{ $max: { stock: 0 } }"],
  $currentDate: ["지금 시각으로", "{ $currentDate: { updatedAt: true } }"],
};

// method → [arguments, description, example]
export const COLLECTION_METHODS: Record<string, [string, string, string]> = {
  find: ["(filter, projection)", "조건에 맞는 문서를 찾습니다. .sort() .skip() .limit()을 이어 붙일 수 있습니다", 'db.orders.find({ status: "paid" }).sort({ orderedAt: -1 }).limit(20)'],
  findOne: ["(filter, projection)", "조건에 맞는 첫 문서 하나", 'db.customers.findOne({ email: "user1@example.com" })'],
  countDocuments: ["(filter)", "조건에 맞는 문서 수", 'db.orders.countDocuments({ status: "refunded" })'],
  estimatedDocumentCount: ["()", "컬렉션 전체 문서 수 (메타데이터)", "db.events.estimatedDocumentCount()"],
  distinct: ["(field, filter)", "필드의 서로 다른 값", 'db.orders.distinct("shipping.country")'],
  aggregate: ["(pipeline)", "집계 파이프라인을 실행합니다", 'db.orders.aggregate([\n  { $match: { status: "paid" } },\n  { $group: { _id: "$shipping.country", revenue: { $sum: "$total" } } },\n  { $sort: { revenue: -1 } }\n])'],
  insertOne: ["(doc)", "문서 하나를 추가합니다. _id가 없으면 ObjectId를 만듭니다", 'db.events.insertOne({ type: "login", at: new Date() })'],
  insertMany: ["([docs])", "문서 여러 개를 추가합니다", 'db.events.insertMany([{ type: "login" }, { type: "logout" }])'],
  updateOne: ["(filter, update, options)", "맞는 첫 문서를 수정합니다", 'db.orders.updateOne({ orderNo: 100001 }, { $set: { status: "paid" } })'],
  updateMany: ["(filter, update, options)", "맞는 모든 문서를 수정합니다", "db.products.updateMany({ stock: { $lt: 10 } }, { $inc: { stock: 100 } })"],
  replaceOne: ["(filter, doc)", "맞는 첫 문서를 통째로 바꿉니다 (_id 유지)", 'db.events.replaceOne({ _id: … }, { type: "login" })'],
  deleteOne: ["(filter)", "맞는 첫 문서를 지웁니다", "db.reviews.deleteOne({ rating: 1 })"],
  deleteMany: ["(filter)", "맞는 모든 문서를 지웁니다", 'db.events.deleteMany({ type: "logout" })'],
  createIndex: ["(keys, options)", "인덱스를 만듭니다", "db.events.createIndex({ type: 1, at: -1 })"],
  dropIndex: ["(name)", "인덱스를 지웁니다", 'db.events.dropIndex("type_1_at_-1")'],
  getIndexes: ["()", "인덱스 목록", "db.orders.getIndexes()"],
  drop: ["()", "컬렉션을 통째로 지웁니다 (안전 모드에서 확인)", "db.events.drop()"],
  stats: ["()", "컬렉션 통계", "db.orders.stats()"],
  explain: ['("executionStats")', "다음 find나 aggregate의 실행 계획", 'db.orders.explain("executionStats").find({ status: "paid" })'],
};

// cursor method → [arguments, description]
const CURSOR_METHODS: Record<string, [string, string]> = {
  sort: ["(spec)", "정렬: { 필드: 1 | -1 }"],
  skip: ["(n)", "앞의 n개를 건너뜀"],
  limit: ["(n)", "n개까지만"],
  projection: ["(spec)", "프로젝션"],
  explain: ['("executionStats")', "실행 계획"],
};

// ---- Sampled fields ----

export interface FieldStat {
  // Dotted path; elements of arrays of documents share their array's path
  // (`items.quantity`), as $match addresses them.
  path: string;
  depth: number;
  // Share of documents having the path (0–1).
  presence: number;
  types: { type: BsonTypeName; count: number }[];
  // Order of first appearance, for ties.
  order: number;
  // Frequent scalar values (seen at least twice), most frequent first.
  values: BsonValue[];
}

const VALUE_LIMIT = 12;

// Field paths and their types, presence and frequent values in `docs`.
export function sampleFields(docs: BsonDocument[]): FieldStat[] {
  interface Acc {
    path: string;
    depth: number;
    docs: number;
    lastDoc: number;
    order: number;
    types: Map<BsonTypeName, number>;
    values: Map<string, { value: BsonValue; count: number }>;
  }
  const fields = new Map<string, Acc>();
  const visit = (v: BsonValue, path: string, depth: number, docIndex: number) => {
    let acc = fields.get(path);
    if (!acc) {
      acc = { path, depth, docs: 0, lastDoc: -1, order: fields.size, types: new Map(), values: new Map() };
      fields.set(path, acc);
    }
    if (acc.lastDoc !== docIndex) {
      acc.docs++;
      acc.lastDoc = docIndex;
    }
    const type = typeName(v);
    acc.types.set(type, (acc.types.get(type) ?? 0) + 1);
    if (isDocument(v)) {
      for (const [key, value] of v) {
        visit(value, `${path}.${key}`, depth + 1, docIndex);
      }
    } else if (Array.isArray(v)) {
      for (const element of v) {
        if (isDocument(element)) {
          for (const [key, value] of element) {
            visit(value, `${path}.${key}`, depth + 1, docIndex);
          }
        }
      }
    } else if (type === "String" || type === "Boolean" || type === "Int32" || type === "Int64" || type === "Double" || type === "Decimal128") {
      const text = toShell(v);
      const seen = acc.values.get(text);
      if (seen) {
        seen.count++;
      } else if (acc.values.size < 200) {
        acc.values.set(text, { value: v, count: 1 });
      }
    }
  };
  docs.forEach((doc, i) => {
    for (const [key, value] of doc) {
      visit(value, key, 0, i);
    }
  });
  return [...fields.values()].map((acc): FieldStat => ({
    path: acc.path,
    depth: acc.depth,
    presence: docs.length === 0 ? 0 : acc.docs / docs.length,
    types: Array.from(acc.types, ([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
    order: acc.order,
    values: [...acc.values.values()]
      .filter((x) => x.count >= 2)
      .sort((a, b) => b.count - a.count)
      .slice(0, VALUE_LIMIT)
      .map((x) => x.value),
  }));
}

// `String · Int32 20%`: types with their share when mixed.
function typeSummary(field: FieldStat): string {
  const total = field.types.reduce((n, x) => n + x.count, 0) || 1;
  return field.types.map((x) => (x.count === total ? x.type : `${x.type} ${Math.round((x.count / total) * 100)}%`)).join(" · ");
}

// ---- Items ----

export type CompletionKind = "field" | "operator" | "stage" | "accumulator" | "expression" | "update" | "value" | "keyword" | "collection" | "method";

export interface CompletionItem {
  label: string;
  kind: CompletionKind;
  // Short text beside the label (types, arguments, operator meaning).
  detail: string;
  // Longer description and example for the side panel.
  info: { doc: string; example: string | null } | null;
  // Text replacing the typed prefix.
  apply: string;
  // A key: insert ": " after it unless one follows already.
  key: boolean;
  // Move the caret this many characters back after inserting (into "()").
  caretBack: number;
  // Completing inside a string: also consume up to and including its
  // closing quote, and add the quote.
  closeQuote: boolean;
}

export interface CompletionResult {
  // Start of the text the item replaces (the prefix), up to the caret.
  from: number;
  prefix: string;
  inString: boolean;
  items: CompletionItem[];
}

// Where the text is typed: the query bar boxes, a pipeline, an update
// document, a document being edited, or the mongosh tab.
export type CompletionRole = "filter" | "projection" | "sort" | "pipeline" | "update" | "doc" | "shell";

export interface CompletionContext {
  // Sampled fields of the current collection.
  fields: FieldStat[];
  // Collection names, for `db.` and $lookup.from.
  collections?: string[];
  // Fields of another collection (mongosh tab, $lookup.foreignField); `db`
  // is the `getSiblingDB` database, null for the current one.
  fieldsOf?: (collection: string, db: string | null) => FieldStat[] | null;
}

function item(label: string, kind: CompletionKind, detail: string, more: Partial<CompletionItem> = {}): CompletionItem {
  return { label, kind, detail, info: null, apply: label, key: false, caretBack: 0, closeQuote: false, ...more };
}

function opItems(docs: OpDocs, kind: CompletionKind): CompletionItem[] {
  return Object.keys(docs).map((name) => item(name, kind, t(docs[name][0]), { info: { doc: t(docs[name][0]), example: docs[name][1] } }));
}

const PLAIN_KEY = /^[A-Za-z_$][\w$]*$/;

function fieldItems(
  fields: FieldStat[],
  options: { prefix?: string; quoteAlways?: boolean; dollar?: boolean; inString?: boolean; key?: boolean } = {},
): CompletionItem[] {
  const prefix = options.prefix ?? "";
  const ranked: { rank: number; item: CompletionItem }[] = [];
  for (const field of fields) {
    if (prefix && !field.path.startsWith(prefix)) {
      continue;
    }
    const name = field.path.slice(prefix.length);
    const label = options.dollar ? `$${name}` : name;
    let apply = label;
    if (!options.inString) {
      apply = options.dollar || options.quoteAlways || !PLAIN_KEY.test(label) ? JSON.stringify(label) : label;
    }
    ranked.push({
      rank: field.depth * 1000 + (1 - field.presence) * 100 + field.order / 1000,
      item: item(label, "field", typeSummary(field), {
        info: { doc: `${Math.round(field.presence * 100)}%`, example: field.values.length ? field.values.map(toShell).join(", ") : null },
        apply,
        key: options.key ?? false,
        closeQuote: options.inString ?? false,
      }),
    });
  }
  return ranked.sort((a, b) => a.rank - b.rank).map((r) => r.item);
}

function valueItems(fields: FieldStat[], path: string, inString: boolean): CompletionItem[] {
  const field = fields.find((f) => f.path === path);
  if (!field) {
    return [];
  }
  const dominant = field.types[0]?.type;
  if (dominant === "Boolean") {
    return inString ? [] : ["true", "false"].map((v) => item(v, "value", "Boolean"));
  }
  if (dominant === "Date") {
    const day = new Date().toISOString().slice(0, 10);
    return inString ? [] : [item(`ISODate("${day}")`, "value", "Date", { apply: `ISODate("${day}T00:00:00Z")` })];
  }
  return field.values
    .filter((v) => !inString || typeof v === "string")
    .map((v) => item(toShell(v), "value", typeName(v), { apply: inString && typeof v === "string" ? v : toShell(v), closeQuote: inString }));
}

// ---- Context scan ----

type Frame =
  | { t: "top"; role: string }
  | { t: "call"; name: string; argIndex: number }
  | { t: "arr"; role: string; field: string | null; prefix: string }
  | { t: "obj"; role: string; field: string | null; prefix: string; expect: "key" | "value"; key: string | null; entries: Record<string, string> };

// The role of each argument of a call, for what goes inside it.
const CALL_ARG_ROLES: Record<string, string[]> = {
  find: ["filter", "projection"],
  findOne: ["filter", "projection"],
  countDocuments: ["filter"],
  deleteOne: ["filter"],
  deleteMany: ["filter"],
  distinct: ["fieldName", "filter"],
  updateOne: ["filter", "update", "options"],
  updateMany: ["filter", "update", "options"],
  replaceOne: ["filter", "doc"],
  aggregate: ["pipeline"],
  insertOne: ["doc"],
  insertMany: ["docList"],
  sort: ["sort"],
  projection: ["projection"],
  createIndex: ["sort"],
};

const ARRAY_CHILD: Record<string, string> = { pipeline: "stage", filterList: "filter", docList: "doc", valueList: "value", expr: "expr", exprList: "expr" };

const STAGE_ROLE: Record<string, string> = {
  $match: "filter",
  $project: "projectExpr",
  $addFields: "projectExpr",
  $set: "projectExpr",
  $group: "group",
  $sort: "sort",
  $lookup: "lookup",
  $unwind: "unwind",
  $replaceRoot: "expr",
  $facet: "facet",
};

function childRole(top: Frame): { role: string; field: string | null; prefix: string } {
  if (top.t === "top") {
    return { role: top.role === "pipeline" ? "pipeline" : top.role, field: null, prefix: "" };
  }
  if (top.t === "call") {
    return { role: CALL_ARG_ROLES[top.name]?.[top.argIndex] ?? "value", field: null, prefix: "" };
  }
  if (top.t === "arr") {
    return { role: ARRAY_CHILD[top.role] ?? "value", field: top.field, prefix: top.prefix };
  }
  const key = top.key ?? "";
  const prefix = top.prefix;
  switch (top.role) {
    case "filter":
      if (key === "$and" || key === "$or" || key === "$nor") {
        return { role: "filterList", field: null, prefix };
      }
      if (key === "$expr") {
        return { role: "expr", field: null, prefix: "" };
      }
      return { role: "fieldops", field: prefix + key, prefix };
    case "fieldops":
      if (key === "$in" || key === "$nin" || key === "$all") {
        return { role: "valueList", field: top.field, prefix: "" };
      }
      if (key === "$elemMatch") {
        return { role: "filter", field: top.field, prefix: `${top.field}.` };
      }
      return { role: key === "$not" ? "fieldops" : "value", field: top.field, prefix: "" };
    case "stage":
      return { role: STAGE_ROLE[key] ?? "value", field: null, prefix: "" };
    case "facet":
      return { role: "pipeline", field: null, prefix: "" };
    case "group":
      return { role: key === "_id" ? "expr" : "accumulator", field: null, prefix: "" };
    case "accumulator":
    case "expr":
    case "projectExpr":
      return { role: LIST_EXPRESSIONS.includes(key) ? "exprList" : "expr", field: null, prefix: "" };
    case "update":
      return { role: "updateFields", field: null, prefix: "" };
    case "updateFields":
      return { role: "value", field: key, prefix: "" };
    case "doc":
      return { role: "doc", field: null, prefix: `${prefix}${key}.` };
  }
  return { role: "value", field: null, prefix: "" };
}

// Walks the tokens before the caret keeping a stack of open { [ ( with
// what each one holds. `braceless`: query-bar text written without the
// outer `{ }`, which reads as already inside the document.
function scanContext(toks: Token[], rootRole: CompletionRole, braceless: boolean): { stack: Frame[]; chain: string[] } {
  const stack: Frame[] = [{ t: "top", role: rootRole }];
  if (braceless) {
    stack.push({ t: "obj", role: rootRole, field: null, prefix: "", expect: "key", key: null, entries: {} });
  }
  const chain: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    const top = stack[stack.length - 1];
    if (tok.type === "comment") {
      continue;
    }
    if (tok.type === "punc") {
      switch (tok.text) {
        case "{": {
          const r = childRole(top);
          stack.push({ t: "obj", role: r.role, field: r.field, prefix: r.prefix, expect: "key", key: null, entries: {} });
          break;
        }
        case "[": {
          const r = childRole(top);
          stack.push({ t: "arr", role: r.role, field: r.field, prefix: r.prefix });
          break;
        }
        case "(": {
          const prev = toks[i - 1];
          const name = prev?.type === "ident" ? prev.text : "";
          if (stack.length === 1 && rootRole === "shell") {
            chain.push(name);
          }
          stack.push({ t: "call", name, argIndex: 0 });
          break;
        }
        case "}":
        case "]":
        case ")":
          if (stack.length > 1) {
            stack.pop();
          }
          break;
        case ":":
          if (top.t === "obj") {
            top.expect = "value";
          }
          break;
        case ",":
          if (top.t === "obj") {
            top.expect = "key";
            top.key = null;
          } else if (top.t === "call") {
            top.argIndex++;
          }
          break;
      }
      continue;
    }
    if (top.t === "obj" && top.expect === "key" && (tok.type === "ident" || tok.type === "str" || tok.type === "num")) {
      let key = tok.text;
      while (toks[i + 1]?.text === "." && toks[i + 2]?.type === "ident") {
        key += `.${toks[i + 2].text}`;
        i += 2;
      }
      top.key = key;
      continue;
    }
    if (top.t === "obj" && top.expect === "value" && top.key && (tok.type === "str" || tok.type === "ident" || tok.type === "num")) {
      top.entries[top.key] = tok.text;
    }
  }
  return { stack, chain };
}

function asKeys(items: CompletionItem[], inString: boolean): CompletionItem[] {
  return items.map((it) => ({ ...it, key: true, apply: inString ? it.label : PLAIN_KEY.test(it.label) ? it.label : JSON.stringify(it.label), closeQuote: inString }));
}

export interface ShellTarget {
  // `db.getSiblingDB("…")`'s database, or null for the current one.
  db: string | null;
  // `db.coll`, `db["coll"]` or `db.getCollection("coll")`, once something
  // follows it; else null.
  coll: string | null;
  // Token index right after `db` / `db.getSiblingDB(…)`, and right after
  // the collection (-1 without one).
  dbEnd: number;
  collEnd: number;
}

// The database and collection a mongosh statement starts with, from its
// tokens (comments removed); null when it does not start with `db`.
export function shellTarget(toks: Token[]): ShellTarget | null {
  const punc = (i: number, text: string) => toks[i]?.type === "punc" && toks[i].text === text;
  // `.name("string")` at i: the string, else null.
  const stringCall = (i: number, name: string) =>
    punc(i, ".") && toks[i + 1]?.text === name && punc(i + 2, "(") && toks[i + 3]?.type === "str" && punc(i + 4, ")") ? toks[i + 3].text : null;
  if (toks[0]?.type !== "ident" || toks[0].text !== "db") {
    return null;
  }
  let i = 1;
  const db = stringCall(i, "getSiblingDB");
  if (db !== null) {
    i += 5;
  }
  const target: ShellTarget = { db, coll: null, dbEnd: i, collEnd: -1 };
  const named = stringCall(i, "getCollection");
  if (named !== null) {
    return { ...target, coll: named, collEnd: i + 5 };
  }
  if (punc(i, "[") && toks[i + 1]?.type === "str" && punc(i + 2, "]")) {
    return { ...target, coll: toks[i + 1].text, collEnd: i + 3 };
  }
  if (punc(i, ".") && toks[i + 1]?.type === "ident" && i + 2 < toks.length && !punc(i + 2, "(")) {
    return { ...target, coll: toks[i + 1].text, collEnd: i + 2 };
  }
  return target;
}

// Candidates for the caret in `text`, or null where nothing is offered
// (inside a comment, after a closed string, in a value with no hints).
// Items are unfiltered: the caller matches them against `prefix`.
export function completionsAt(text: string, caret: number, role: CompletionRole, ctx: CompletionContext): CompletionResult | null {
  const toks = tokenize(text.slice(0, caret), true);
  let prefix = "";
  let from = caret;
  let inString = false;
  const last = toks[toks.length - 1];
  if (last && last.type === "comment" && (last.to >= caret || !last.closed)) {
    return null;
  }
  if (last && last.to === caret) {
    if (last.type === "str") {
      if (last.closed) {
        return null;
      }
      inString = true;
      prefix = last.text;
      from = last.from + 1;
      toks.pop();
    } else if (last.type === "ident" || last.type === "num") {
      prefix = last.text;
      from = last.from;
      toks.pop();
    }
  }
  // The query-bar boxes accept `status: "paid"` for `{ status: "paid" }`.
  const first = tokenize(text, true).find((tok) => tok.type !== "comment");
  const braceless = (role === "filter" || role === "projection" || role === "sort") && !(first?.type === "punc" && first.text === "{");
  let { stack, chain } = scanContext(toks, role, braceless);
  // A dotted path being typed as a key (`items.qu`) completes as one name.
  if (!inString) {
    let i = toks.length;
    let p = prefix;
    let f = from;
    while (i >= 2 && toks[i - 1].text === "." && toks[i - 1].to === f && toks[i - 2].type === "ident" && toks[i - 2].to === toks[i - 1].from) {
      p = `${toks[i - 2].text}.${p}`;
      f = toks[i - 2].from;
      i -= 2;
    }
    if (i < toks.length) {
      const merged = scanContext(toks.slice(0, i), role, braceless);
      const mergedTop = merged.stack[merged.stack.length - 1];
      if (mergedTop.t === "obj") {
        toks.length = i;
        ({ stack, chain } = merged);
        prefix = p;
        from = f;
      }
    }
  }
  const code = toks.filter((tok) => tok.type !== "comment");
  const target = role === "shell" ? shellTarget(code) : null;
  const fields = target?.coll && ctx.fieldsOf ? (ctx.fieldsOf(target.coll, target.db) ?? ctx.fields) : ctx.fields;
  const top = stack[stack.length - 1];
  const prev = code[code.length - 1];
  const prev2 = code[code.length - 2];
  const result = (items: CompletionItem[]): CompletionResult => ({ from, prefix, inString, items });

  if (top.t === "top") {
    if (role !== "shell" || inString) {
      return null;
    }
    if (target !== null && code.length === target.dbEnd + 1 && prev?.text === ".") {
      // Collection names are known only for the current database.
      const methods = target.db === null ? ["getSiblingDB", "getCollection", "getCollectionNames", "stats"] : ["getCollection", "getCollectionNames", "stats"];
      return result([
        ...(target.db === null ? (ctx.collections ?? []) : []).map((name) => item(name, "collection", "")),
        ...methods.map((m) => item(m, "method", "()", { apply: `${m}()`, caretBack: m.startsWith("get") && m !== "getCollectionNames" ? 1 : 0 })),
      ]);
    }
    if (target?.coll && code.length === target.collEnd + 1 && prev?.text === ".") {
      // Examples show the statement's own head: db.getSiblingDB("x").orders.
      const head = code
        .slice(0, target.collEnd)
        .map((tok) => (tok.type === "str" ? JSON.stringify(tok.text) : tok.text))
        .join("");
      return result(
        Object.keys(COLLECTION_METHODS).map((m) =>
          item(m, "method", COLLECTION_METHODS[m][0], {
            apply: `${m}()`,
            caretBack: 1,
            info: { doc: t(COLLECTION_METHODS[m][1]), example: COLLECTION_METHODS[m][2].replace(/db\.\w+\./, `${head}.`) },
          }),
        ),
      );
    }
    if (prev?.text === "." && prev2?.text === ")" && chain[chain.length - 1] !== "explain" && (chain.includes("find") || chain.includes("aggregate"))) {
      const names = chain.includes("find") ? Object.keys(CURSOR_METHODS) : ["explain"];
      return result(names.map((m) => item(m, "method", CURSOR_METHODS[m][0], { apply: `${m}()`, caretBack: 1, info: { doc: t(CURSOR_METHODS[m][1]), example: null } })));
    }
    if (code.length === 0 || prev?.text === ";") {
      return result([
        item("db", "keyword", t("데이터베이스"), { apply: "db." }),
        item("show collections", "keyword", t("컬렉션 목록")),
        item("show dbs", "keyword", t("데이터베이스 목록")),
        item("use", "keyword", t("데이터베이스 바꾸기"), { apply: "use " }),
      ]);
    }
    return null;
  }

  if (top.t === "obj" && top.expect === "key") {
    const keyRole = top.role;
    if (inString && !["filter", "doc", "sort", "projection", "projectExpr", "updateFields"].includes(keyRole)) {
      return null;
    }
    switch (keyRole) {
      case "filter":
        return result([...fieldItems(fields, { prefix: top.prefix, inString, key: true }), ...(inString ? [] : asKeys(opItems(LOGICAL_OPERATORS, "operator"), false))]);
      case "fieldops":
        return result(asKeys(opItems(QUERY_OPERATORS, "operator"), inString));
      case "stage":
        return result(asKeys(opItems(STAGES, "stage"), inString));
      case "group":
        return result(asKeys([item("_id", "field", t("묶을 기준"))], inString));
      case "accumulator":
        return result(asKeys(opItems(ACCUMULATORS, "accumulator"), inString));
      case "expr":
      case "exprList":
        return result(asKeys(opItems(EXPRESSIONS, "expression"), inString));
      case "projectExpr":
      case "sort":
      case "projection":
      case "updateFields":
      case "doc":
        return result(fieldItems(fields, { prefix: keyRole === "doc" ? top.prefix : "", inString, key: true }));
      case "update":
        return result(asKeys(opItems(UPDATE_OPERATORS, "update"), inString));
      case "lookup":
        return result(
          asKeys(
            [
              ["from", "합칠 컬렉션"],
              ["localField", "이 컬렉션의 필드"],
              ["foreignField", "from 컬렉션의 필드"],
              ["as", "결과 배열 필드 이름"],
            ].map(([k, d]) => item(k, "keyword", t(d))),
            inString,
          ),
        );
      case "unwind":
        return result(asKeys(["path", "preserveNullAndEmptyArrays", "includeArrayIndex"].map((k) => item(k, "keyword", "")), inString));
    }
    return null;
  }

  if (top.t === "call") {
    const argRole = CALL_ARG_ROLES[top.name]?.[top.argIndex];
    return argRole === "fieldName" && inString ? result(fieldItems(fields, { inString: true })) : null;
  }

  const valueRole = top.role;
  const key = top.t === "obj" ? top.key : null;
  if (["projectExpr", "group", "accumulator", "expr", "exprList", "unwind"].includes(valueRole) && (inString ? prefix === "" || prefix.startsWith("$") : prefix === "")) {
    const items = fieldItems(fields, { dollar: true, inString });
    if (valueRole === "accumulator" && !inString) {
      items.unshift(item("1", "value", t("개수 세기")));
    }
    return result(items);
  }
  if (valueRole === "lookup" && top.t === "obj" && key !== null) {
    if (key === "from") {
      return result((ctx.collections ?? []).map((name) => item(name, "collection", "", { apply: inString ? name : JSON.stringify(name), closeQuote: inString })));
    }
    if (key === "localField") {
      return result(fieldItems(fields, { quoteAlways: true, inString }));
    }
    if (key === "foreignField") {
      const other = top.entries.from ? ctx.fieldsOf?.(top.entries.from, target?.db ?? null) : null;
      return result(fieldItems(other ?? fields, { quoteAlways: true, inString }));
    }
    return null;
  }
  if (valueRole === "sort" && !inString) {
    return result([item("1", "value", t("오름차순")), item("-1", "value", t("내림차순"))]);
  }
  if (valueRole === "projection" && !inString) {
    return result([item("1", "value", t("포함")), item("0", "value", t("제외"))]);
  }
  if (["filter", "fieldops", "valueList", "value", "updateFields"].includes(valueRole)) {
    if (valueRole === "filter" && key?.startsWith("$")) {
      return null;
    }
    const path = valueRole === "filter" && top.t === "obj" ? top.prefix + (key ?? "") : (top.field ?? key ?? "");
    const items = valueItems(fields, path, inString);
    if (valueRole === "filter" && !inString && prefix === "") {
      items.push(...opItems(QUERY_OPERATORS, "operator").map((it) => ({ ...it, label: `{ ${it.label} }`, apply: `{ ${it.label}:  }`, caretBack: 2 })));
    }
    return result(items);
  }
  return null;
}
