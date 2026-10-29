use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, Write};

use reqwest::blocking::{Client, Response};
use serde_json::{json, Map, Value};
use tablepeek_engine::driver::pipeline_writes;
use tablepeek_engine::{is_read_only, registry};

const PROTOCOL_VERSIONS: [&str; 3] = ["2024-11-05", "2025-03-26", "2025-06-18"];

pub struct McpConfig {
    pub url: String,
    pub token: String,
    pub conn: Option<String>,
}

struct Mcp {
    client: Client,
    base: String,
    token: String,
    conn: Option<String>,
}

pub fn run(config: McpConfig) -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()?;
    let mcp = Mcp {
        client,
        base: config.url.trim_end_matches('/').to_string(),
        token: config.token,
        conn: config.conn,
    };
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                write_message(
                    &mut stdout,
                    &json!({
                        "jsonrpc": "2.0",
                        "id": Value::Null,
                        "error": { "code": -32700, "message": format!("JSON 파싱 실패: {error}") }
                    }),
                )?;
                continue;
            }
        };
        let Some(response) = mcp.handle(request) else {
            continue;
        };
        write_message(&mut stdout, &response)?;
    }
    Ok(())
}

fn write_message(stdout: &mut io::Stdout, message: &Value) -> io::Result<()> {
    writeln!(stdout, "{message}")?;
    stdout.flush()
}

impl Mcp {
    fn handle(&self, request: Value) -> Option<Value> {
        let id = request.get("id").cloned();
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let params = request.get("params").cloned().unwrap_or(Value::Null);
        let id = id?;
        let result = match method {
            "initialize" => Ok(self.initialize(&params)),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": self.tools() })),
            "tools/call" => self.call_tool(&params),
            other => Err((-32601, format!("지원하지 않는 메서드: {other}"))),
        };
        Some(match result {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, message)) => {
                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
            }
        })
    }

    fn initialize(&self, params: &Value) -> Value {
        let requested = params
            .get("protocolVersion")
            .and_then(Value::as_str)
            .unwrap_or("2025-06-18");
        let version = if PROTOCOL_VERSIONS.contains(&requested) {
            requested
        } else {
            "2025-06-18"
        };
        json!({
            "protocolVersion": version,
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": "tablepeek-mcp", "version": env!("CARGO_PKG_VERSION") },
            "instructions": "TablePeek의 활성 연결을 조회하고 읽기 전용 SQL이나 MongoDB 조회(find·aggregate·스키마 표본·인덱스)를 실행합니다. 쓰기는 TablePeek UI에서 수행하세요."
        })
    }

    /// The tools for the connection a call goes to without its own `conn`
    /// (--conn, else the server's default): MongoDB's for a document store,
    /// SQL's otherwise; both when that connection can't be told.
    fn tools(&self) -> Value {
        let conns = self
            .get_with_query("/api/conns", &[], None)
            .ok()
            .and_then(|listed| listed.get("conns")?.as_array().cloned())
            .unwrap_or_default();
        let target = conns.iter().find(|conn| match self.conn.as_deref() {
            Some(id) => conn["id"] == id,
            None => conn["is_default"] == true,
        });
        let paradigm = target
            .and_then(|conn| conn["kind"].as_str())
            .and_then(registry::factory)
            .map(|factory| factory.descriptor().paradigm.as_str());
        let mut tools = vec![list_connections_tool()];
        match paradigm {
            Some("document") => tools.extend(mongo_tools()),
            Some(_) => tools.extend(sql_tools()),
            None => {
                tools.extend(sql_tools());
                tools.extend(mongo_tools());
            }
        }
        Value::Array(tools)
    }

    fn call_tool(&self, params: &Value) -> Result<Value, (i64, String)> {
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .ok_or((-32602, "도구 이름이 필요합니다".to_string()))?;
        let args = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        // A tool's own conn wins over --conn; without either the server's
        // default connection (from --db or --demo) is used, if it has one.
        let conn = args
            .get("conn")
            .and_then(Value::as_str)
            .or(self.conn.as_deref());
        let result = match name {
            "tablepeek_list_connections" => self.get_with_query("/api/conns", &[], None),
            "tablepeek_list_tables" => {
                let system = args
                    .get("include_system")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                self.get_with_query(
                    "/api/schema",
                    &[("system", if system { "1" } else { "0" })],
                    conn,
                )
            }
            "tablepeek_describe_table" => {
                let table = required_string(&args, "table")?;
                self.get_with_query("/api/table", &[("name", table)], conn)
            }
            "tablepeek_query" => {
                let sql = required_string(&args, "sql")?;
                if !is_read_only(sql) {
                    return Ok(tool_error(
                        "읽기 전용 SELECT/WITH/SHOW/DESCRIBE/EXPLAIN만 실행할 수 있습니다.",
                    ));
                }
                let max_rows = args
                    .get("max_rows")
                    .and_then(Value::as_u64)
                    .unwrap_or(200)
                    .clamp(1, 1000);
                self.post_json(
                    "/api/query",
                    &json!({ "sql": sql, "max_rows": max_rows }),
                    conn,
                )
            }
            "mongo_list_collections" => match optional_string(&args, "db") {
                Some(db) => self.get_with_query("/api/doc/collections", &[("db", db)], conn),
                None => self.mongo_databases(&args, conn),
            },
            "mongo_find" => {
                let mut body = namespace(&args)?;
                for key in ["filter", "projection", "sort"] {
                    if let Some(value) = json_arg(&args, key)? {
                        body.insert(key.into(), value);
                    }
                }
                if let Some(skip) = args.get("skip").and_then(Value::as_u64) {
                    body.insert("skip".into(), json!(skip));
                }
                body.insert("limit".into(), json!(limit_arg(&args, 20)));
                body.insert("maxTimeMS".into(), json!(MONGO_MAX_TIME_MS));
                self.post_json("/api/doc/find", &Value::Object(body), conn)
            }
            "mongo_aggregate" => {
                let mut body = namespace(&args)?;
                let Some(Value::Array(mut pipeline)) = json_arg(&args, "pipeline")? else {
                    return Err((-32602, "pipeline 인자(단계 배열)가 필요합니다".into()));
                };
                if pipeline_writes(&pipeline) {
                    return Ok(tool_error(
                        "$out·$merge가 있는 파이프라인은 실행할 수 없습니다 (읽기 전용).",
                    ));
                }
                pipeline.push(json!({ "$limit": limit_arg(&args, 50) }));
                body.insert("pipeline".into(), Value::Array(pipeline));
                body.insert("maxTimeMS".into(), json!(MONGO_MAX_TIME_MS));
                self.post_json("/api/doc/aggregate", &Value::Object(body), conn)
            }
            "mongo_schema" => {
                let mut body = namespace(&args)?;
                let filter = json_arg(&args, "filter")?.unwrap_or_else(|| json!({}));
                let size = args
                    .get("sample")
                    .and_then(Value::as_u64)
                    .unwrap_or(SCHEMA_SAMPLE_MAX)
                    .clamp(1, SCHEMA_SAMPLE_MAX);
                body.insert(
                    "pipeline".into(),
                    json!([{ "$match": filter }, { "$sample": { "size": size } }]),
                );
                body.insert("maxTimeMS".into(), json!(MONGO_MAX_TIME_MS));
                self.post_json("/api/doc/aggregate", &Value::Object(body), conn)
                    .map(|batch| {
                        schema_summary(batch["docs"].as_array().map_or(&[], Vec::as_slice))
                    })
            }
            "mongo_indexes" => {
                let db = required_string(&args, "db")?;
                let coll = required_string(&args, "coll")?;
                self.get_with_query("/api/doc/indexes", &[("db", db), ("coll", coll)], conn)
            }
            other => return Err((-32602, format!("알 수 없는 도구: {other}"))),
        };
        Ok(match result {
            Ok(value) => tool_text(serde_json::to_string_pretty(&value).unwrap_or_default()),
            Err(message) => tool_error(&message),
        })
    }

    fn get_with_query(
        &self,
        path: &str,
        query: &[(&str, &str)],
        conn: Option<&str>,
    ) -> Result<Value, String> {
        let mut request = self
            .client
            .get(format!("{}{}", self.base, path))
            .header("x-tablepeek-token", &self.token)
            .query(query);
        if let Some(conn) = conn {
            request = request.query(&[("conn", conn)]);
        }
        parse_response(request.send())
    }

    fn post_json(&self, path: &str, body: &Value, conn: Option<&str>) -> Result<Value, String> {
        let mut request = self
            .client
            .post(format!("{}{}", self.base, path))
            .header("x-tablepeek-token", &self.token)
            .json(body);
        if let Some(conn) = conn {
            request = request.query(&[("conn", conn)]);
        }
        parse_response(request.send())
    }

    /// Every database (MongoDB's own only with `include_system`) and its
    /// collections.
    fn mongo_databases(&self, args: &Value, conn: Option<&str>) -> Result<Value, String> {
        let system = args
            .get("include_system")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let databases = self.get_with_query("/api/doc/databases", &[], conn)?;
        let mut listed = Vec::new();
        for database in databases.as_array().into_iter().flatten() {
            let Some(name) = database["name"].as_str() else {
                continue;
            };
            if !system && ["admin", "config", "local"].contains(&name) {
                continue;
            }
            let collections = self.get_with_query("/api/doc/collections", &[("db", name)], conn)?;
            let collections: Vec<Value> = collections
                .as_array()
                .into_iter()
                .flatten()
                .map(|c| json!({ "name": c["name"], "type": c["type"], "count": c["count"] }))
                .collect();
            listed.push(json!({ "db": name, "collections": collections }));
        }
        Ok(Value::Array(listed))
    }
}

/// How long a MongoDB read from a tool may run.
const MONGO_MAX_TIME_MS: u64 = 30_000;
/// The most documents `mongo_find` and `mongo_aggregate` return.
const MONGO_LIMIT_MAX: u64 = 100;
/// The largest sample `mongo_schema` reads.
const SCHEMA_SAMPLE_MAX: u64 = 200;

fn optional_string<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// `{ db, coll }` of a call, both required.
fn namespace(args: &Value) -> Result<Map<String, Value>, (i64, String)> {
    let mut body = Map::new();
    body.insert("db".into(), json!(required_string(args, "db")?));
    body.insert("coll".into(), json!(required_string(args, "coll")?));
    Ok(body)
}

/// A filter, sort or pipeline argument: JSON (Extended JSON for BSON types),
/// given as a value or as text holding one.
fn json_arg(args: &Value, key: &str) -> Result<Option<Value>, (i64, String)> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if text.trim().is_empty() => Ok(None),
        Some(Value::String(text)) => serde_json::from_str(text)
            .map(Some)
            .map_err(|error| (-32602, format!("{key} 인자가 JSON이 아닙니다: {error}"))),
        Some(value) => Ok(Some(value.clone())),
    }
}

fn limit_arg(args: &Value, default: u64) -> u64 {
    args.get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(default)
        .clamp(1, MONGO_LIMIT_MAX)
}

/// The BSON type a canonical Extended JSON value stands for.
fn bson_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(map) => match map.keys().next().map(String::as_str) {
            Some("$oid") => "objectId",
            Some("$date") => "date",
            Some("$numberDecimal") => "decimal",
            Some("$numberInt") => "int",
            Some("$numberLong") => "long",
            Some("$numberDouble") => "double",
            Some("$binary") => "binData",
            Some("$regularExpression") => "regex",
            Some("$timestamp") => "timestamp",
            Some("$minKey") => "minKey",
            Some("$maxKey") => "maxKey",
            Some("$code") => "javascript",
            Some("$symbol") => "symbol",
            Some("$dbPointer") => "dbPointer",
            Some("$undefined") => "undefined",
            _ => "object",
        },
    }
}

/// One field path's tally over the sample.
struct FieldTally {
    path: String,
    /// Documents that have it at least once.
    docs: usize,
    types: HashMap<&'static str, usize>,
}

/// Field paths of a sample (nested ones dotted, array elements as `[]`),
/// with the share of documents that have each and the types seen there.
fn schema_summary(docs: &[Value]) -> Value {
    let mut fields: Vec<FieldTally> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for doc in docs {
        let mut seen = HashSet::new();
        if let Value::Object(map) = doc {
            tally_fields(map, "", &mut fields, &mut index, &mut seen);
        }
    }
    let sampled = docs.len().max(1) as f64;
    let fields: Vec<Value> = fields
        .into_iter()
        .map(|field| {
            let mut types: Vec<(&str, usize)> = field.types.into_iter().collect();
            types.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
            json!({
                "path": field.path,
                "presence": (field.docs as f64 / sampled * 1000.0).round() / 1000.0,
                "types": types.into_iter().map(|(name, count)| json!({ "type": name, "count": count })).collect::<Vec<_>>(),
            })
        })
        .collect();
    json!({ "sampled": docs.len(), "fields": fields })
}

fn tally_fields(
    map: &Map<String, Value>,
    prefix: &str,
    fields: &mut Vec<FieldTally>,
    index: &mut HashMap<String, usize>,
    seen: &mut HashSet<String>,
) {
    for (key, value) in map {
        tally_value(&format!("{prefix}{key}"), value, fields, index, seen);
    }
}

fn tally_value(
    path: &str,
    value: &Value,
    fields: &mut Vec<FieldTally>,
    index: &mut HashMap<String, usize>,
    seen: &mut HashSet<String>,
) {
    let at = *index.entry(path.to_string()).or_insert_with(|| {
        fields.push(FieldTally {
            path: path.to_string(),
            docs: 0,
            types: HashMap::new(),
        });
        fields.len() - 1
    });
    let kind = bson_type(value);
    *fields[at].types.entry(kind).or_default() += 1;
    if seen.insert(path.to_string()) {
        fields[at].docs += 1;
    }
    match value {
        Value::Object(map) if kind == "object" => {
            tally_fields(map, &format!("{path}."), fields, index, seen);
        }
        Value::Array(items) => {
            let element = format!("{path}[]");
            for item in items {
                tally_value(&element, item, fields, index, seen);
            }
        }
        _ => {}
    }
}

fn parse_response(response: reqwest::Result<Response>) -> Result<Value, String> {
    let response = response.map_err(|error| format!("TablePeek 서버 요청 실패: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|error| format!("응답을 읽지 못했습니다: {error}"))?;
    let value: Value = serde_json::from_str(&text)
        .unwrap_or_else(|_| json!({ "message": text.chars().take(400).collect::<String>() }));
    if status.is_success() {
        Ok(value)
    } else {
        let message = value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("알 수 없는 오류");
        // The database's code and where it points, as an agent fixing the
        // statement needs them.
        let mut tags: Vec<String> = Vec::new();
        if let Some(sqlstate) = value.get("sqlstate").and_then(Value::as_str) {
            tags.push(format!("SQLSTATE {sqlstate}"));
        }
        if let Some(code) = value.get("server_code").and_then(Value::as_i64) {
            tags.push(format!("code {code}"));
        }
        if let Some(name) = value.get("code_name").and_then(Value::as_str) {
            tags.push(name.to_string());
        }
        let position = &value["position"];
        for key in ["offset", "line", "column"] {
            if let Some(at) = position.get(key).and_then(Value::as_u64) {
                tags.push(format!("{key} {at}"));
            }
        }
        let detail = value["details"]
            .get("detail")
            .or_else(|| value["details"].get("errInfo"))
            .map(|detail| match detail {
                Value::String(text) => format!(" — {text}"),
                other => format!(" — {other}"),
            })
            .unwrap_or_default();
        if tags.is_empty() {
            Err(format!("HTTP {status}: {message}{detail}"))
        } else {
            Err(format!(
                "HTTP {status}: {message}{detail} [{}]",
                tags.join(", ")
            ))
        }
    }
}

fn required_string<'a>(args: &'a Value, key: &str) -> Result<&'a str, (i64, String)> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or((-32602, format!("{key} 인자가 필요합니다")))
}

fn tool_text(text: String) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": false })
}

fn tool_error(message: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": message }], "isError": true })
}

const CONN_DESCRIPTION: &str =
    "연결 ID (tablepeek_list_connections로 확인). 생략하면 --conn, 그다음 서버의 기본 연결";

fn list_connections_tool() -> Value {
    json!({
        "name": "tablepeek_list_connections",
        "description": "TablePeek에 열려 있는 활성 연결 목록을 반환합니다 (kind: 엔진).",
        "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
    })
}

fn sql_tools() -> Vec<Value> {
    vec![
        json!({
            "name": "tablepeek_list_tables",
            "description": "선택한 연결의 테이블과 컬럼 목록을 반환합니다.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "include_system": { "type": "boolean", "description": "시스템 테이블 포함" },
                    "conn": { "type": "string", "description": CONN_DESCRIPTION }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "tablepeek_describe_table",
            "description": "테이블의 컬럼, 인덱스, 외래 키, DDL을 반환합니다.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "table": { "type": "string" },
                    "conn": { "type": "string", "description": CONN_DESCRIPTION }
                },
                "required": ["table"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "tablepeek_query",
            "description": "읽기 전용 SQL을 실행합니다. 쓰기 문은 거부됩니다.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sql": { "type": "string" },
                    "conn": { "type": "string", "description": CONN_DESCRIPTION },
                    "max_rows": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 200 }
                },
                "required": ["sql"],
                "additionalProperties": false
            }
        }),
    ]
}

const EJSON_DESCRIPTION: &str =
    "JSON 객체. BSON 타입은 Extended JSON으로 ({\"$oid\": \"…\"}, {\"$date\": \"2025-01-01T00:00:00Z\"})";

fn mongo_tools() -> Vec<Value> {
    let common = || {
        json!({
            "db": { "type": "string", "description": "데이터베이스" },
            "coll": { "type": "string", "description": "컬렉션" },
            "conn": { "type": "string", "description": CONN_DESCRIPTION }
        })
    };
    let with = |extra: Value| {
        let mut properties = common();
        if let (Some(properties), Value::Object(extra)) = (properties.as_object_mut(), extra) {
            properties.extend(extra);
        }
        properties
    };
    vec![
        json!({
            "name": "mongo_list_collections",
            "description": "MongoDB 연결의 데이터베이스와 컬렉션(종류·대략의 문서 수) 목록을 반환합니다. db를 주면 그 데이터베이스만.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "db": { "type": "string", "description": "데이터베이스 (생략하면 전부)" },
                    "include_system": { "type": "boolean", "description": "admin·config·local 포함" },
                    "conn": { "type": "string", "description": CONN_DESCRIPTION }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "mongo_find",
            "description": "컬렉션에서 문서를 찾습니다 (읽기 전용, 최대 100건). 결과는 canonical Extended JSON.",
            "inputSchema": {
                "type": "object",
                "properties": with(json!({
                    "filter": { "type": "object", "description": EJSON_DESCRIPTION },
                    "projection": { "type": "object" },
                    "sort": { "type": "object" },
                    "skip": { "type": "integer", "minimum": 0 },
                    "limit": { "type": "integer", "minimum": 1, "maximum": MONGO_LIMIT_MAX, "default": 20 }
                })),
                "required": ["db", "coll"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "mongo_aggregate",
            "description": "집계 파이프라인을 실행합니다 (읽기 전용: $out·$merge는 거부, 최대 100건).",
            "inputSchema": {
                "type": "object",
                "properties": with(json!({
                    "pipeline": { "type": "array", "items": { "type": "object" }, "description": "단계 배열. 값은 Extended JSON" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": MONGO_LIMIT_MAX, "default": 50 }
                })),
                "required": ["db", "coll", "pipeline"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "mongo_schema",
            "description": "컬렉션 표본($sample, 최대 200건)으로 필드 경로(중첩은 점, 배열 원소는 []), 있는 비율, 타입 분포를 요약합니다.",
            "inputSchema": {
                "type": "object",
                "properties": with(json!({
                    "filter": { "type": "object", "description": EJSON_DESCRIPTION },
                    "sample": { "type": "integer", "minimum": 1, "maximum": SCHEMA_SAMPLE_MAX, "default": SCHEMA_SAMPLE_MAX }
                })),
                "required": ["db", "coll"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "mongo_indexes",
            "description": "컬렉션의 인덱스(키·옵션·크기·사용 횟수)를 반환합니다.",
            "inputSchema": {
                "type": "object",
                "properties": common(),
                "required": ["db", "coll"],
                "additionalProperties": false
            }
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_guard_accepts_queries() {
        assert!(is_read_only("SELECT * FROM demo"));
        assert!(is_read_only("  with x as (select 1) select * from x"));
        assert!(is_read_only("SHOW TABLES"));
        assert!(is_read_only("EXPLAIN SELECT 1"));
        assert!(is_read_only("DESCRIBE demo"));
    }

    #[test]
    fn read_only_guard_rejects_writes_and_multi_statements() {
        assert!(!is_read_only("DELETE FROM demo"));
        assert!(!is_read_only("SELECT 1; DELETE FROM demo"));
        assert!(!is_read_only("WITH x AS (SELECT 1) DELETE FROM demo"));
        assert!(!is_read_only("SELECT * INTO backup FROM demo"));
        assert!(!is_read_only("INSERT INTO demo VALUES (1)"));
        assert!(!is_read_only("PRAGMA journal_mode=DELETE"));
    }

    fn offline() -> Mcp {
        Mcp {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(2))
                .build()
                .unwrap(),
            // Nothing listens on port 1.
            base: "http://127.0.0.1:1".into(),
            token: "t".into(),
            conn: None,
        }
    }

    fn tool_names(tools: &Value) -> Vec<&str> {
        tools
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect()
    }

    #[test]
    fn tools_cover_both_kinds_when_the_connection_is_unknown() {
        let names = tool_names(&offline().tools()).join(" ");
        for name in [
            "tablepeek_list_connections",
            "tablepeek_query",
            "mongo_find",
            "mongo_schema",
        ] {
            assert!(names.contains(name), "{names}");
        }
        let mongo: Vec<Value> = mongo_tools();
        let mongo = tool_names(&Value::Array(mongo)).join(" ");
        assert!(!mongo.contains("tablepeek_query") && !mongo.contains("insert"));
    }

    #[test]
    fn mongo_aggregate_refuses_writing_stages() {
        for pipeline in [
            json!([{ "$out": "copy" }]),
            json!("[{\"$merge\": {\"into\": \"copy\"}}]"),
        ] {
            let result = offline()
                .call_tool(&json!({ "name": "mongo_aggregate", "arguments": {
                    "db": "shop", "coll": "orders", "pipeline": pipeline } }))
                .unwrap();
            assert_eq!(result["isError"], json!(true), "{result}");
            assert!(result["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("$out"));
        }
        let err = offline()
            .call_tool(&json!({ "name": "mongo_find", "arguments": { "db": "shop" } }))
            .unwrap_err();
        assert_eq!(err.0, -32602);
    }

    #[test]
    fn schema_summary_tallies_paths_presence_and_types() {
        let docs = vec![
            json!({ "_id": { "$oid": "64b7f0c2a1b2c3d4e5f60718" }, "total": { "$numberDecimal": "1.5" },
                    "tags": ["a", "b"], "ship": { "city": "Seoul" } }),
            json!({ "_id": { "$oid": "64b7f0c2a1b2c3d4e5f60719" }, "total": { "$numberInt": "3" },
                    "tags": [], "items": [{ "qty": { "$numberInt": "1" } }, { "qty": null }] }),
        ];
        let summary = schema_summary(&docs);
        assert_eq!(summary["sampled"], json!(2));
        let field = |path: &str| {
            summary["fields"]
                .as_array()
                .unwrap()
                .iter()
                .find(|field| field["path"] == path)
                .unwrap_or_else(|| panic!("{path}: {summary}"))
                .clone()
        };
        assert_eq!(
            field("_id")["types"],
            json!([{ "type": "objectId", "count": 2 }])
        );
        assert_eq!(
            field("total")["types"],
            json!([{ "type": "decimal", "count": 1 }, { "type": "int", "count": 1 }])
        );
        assert_eq!(field("tags")["presence"], json!(1.0));
        assert_eq!(
            field("tags[]")["types"],
            json!([{ "type": "string", "count": 2 }])
        );
        assert_eq!(field("tags[]")["presence"], json!(0.5));
        assert_eq!(field("ship.city")["presence"], json!(0.5));
        // Counted once per document however many elements have it.
        assert_eq!(field("items[].qty")["presence"], json!(0.5));
        assert_eq!(
            field("items[].qty")["types"],
            json!([{ "type": "int", "count": 1 }, { "type": "null", "count": 1 }])
        );
    }
}
