use std::io::{self, BufRead, Write};

use reqwest::blocking::{Client, Response};
use serde_json::{json, Value};

const PROTOCOL_VERSIONS: [&str; 3] = ["2024-11-05", "2025-03-26", "2025-06-18"];
const READ_ONLY_PREFIXES: [&str; 6] = ["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN"];
const FORBIDDEN_WORDS: [&str; 7] = [
    "INSERT", "UPDATE", "DELETE", "MERGE", "INTO", "DROP", "ALTER",
];

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
            "tools/list" => Ok(json!({ "tools": tools() })),
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
            "instructions": "TablePeek의 활성 연결을 조회하고 읽기 전용 SQL을 실행합니다. 쓰기는 TablePeek UI에서 수행하세요."
        })
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
        let result = match name {
            "tablepeek_list_connections" => self.get("/api/conns"),
            "tablepeek_list_tables" => {
                let system = args
                    .get("include_system")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                self.get_with_query("/api/schema", &[("system", if system { "1" } else { "0" })])
            }
            "tablepeek_describe_table" => {
                let table = required_string(&args, "table")?;
                self.get_with_query("/api/table", &[("name", table)])
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
                let conn = args
                    .get("conn")
                    .and_then(Value::as_str)
                    .or(self.conn.as_deref());
                self.post_query(sql, max_rows as usize, conn)
            }
            other => return Err((-32602, format!("알 수 없는 도구: {other}"))),
        };
        Ok(match result {
            Ok(value) => tool_text(serde_json::to_string_pretty(&value).unwrap_or_default()),
            Err(message) => tool_error(&message),
        })
    }

    fn get(&self, path: &str) -> Result<Value, String> {
        self.get_with_query(path, &[])
    }

    fn get_with_query(&self, path: &str, query: &[(&str, &str)]) -> Result<Value, String> {
        let mut request = self
            .client
            .get(format!("{}{}", self.base, path))
            .header("x-tablepeek-token", &self.token)
            .query(query);
        if let Some(conn) = self.conn.as_deref() {
            request = request.query(&[("conn", conn)]);
        }
        parse_response(request.send())
    }

    fn post_query(&self, sql: &str, max_rows: usize, conn: Option<&str>) -> Result<Value, String> {
        let mut request = self
            .client
            .post(format!("{}/api/query", self.base))
            .header("x-tablepeek-token", &self.token)
            .json(&json!({ "sql": sql, "max_rows": max_rows }));
        if let Some(conn) = conn {
            request = request.query(&[("conn", conn)]);
        }
        parse_response(request.send())
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
        Err(format!("HTTP {status}: {message}"))
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

fn is_read_only(sql: &str) -> bool {
    let trimmed = sql.trim();
    if trimmed.contains(';') {
        return false;
    }
    let upper = trimmed.to_ascii_uppercase();
    let first = upper.split_whitespace().next().unwrap_or("");
    if !READ_ONLY_PREFIXES.contains(&first) {
        return false;
    }
    !FORBIDDEN_WORDS
        .iter()
        .any(|word| contains_word(&upper, word))
}

fn contains_word(text: &str, word: &str) -> bool {
    text.match_indices(word).any(|(index, _)| {
        let before = text[..index].chars().next_back();
        let after = text[index + word.len()..].chars().next();
        !before.is_some_and(|value| value.is_alphanumeric() || value == '_')
            && !after.is_some_and(|value| value.is_alphanumeric() || value == '_')
    })
}

fn tools() -> Value {
    json!([
        {
            "name": "tablepeek_list_connections",
            "description": "TablePeek에 열려 있는 활성 연결 목록을 반환합니다.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "tablepeek_list_tables",
            "description": "선택한 연결의 테이블과 컬럼 목록을 반환합니다.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "include_system": { "type": "boolean", "description": "시스템 테이블 포함" }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "tablepeek_describe_table",
            "description": "테이블의 컬럼, 인덱스, 외래 키, DDL을 반환합니다.",
            "inputSchema": {
                "type": "object",
                "properties": { "table": { "type": "string" } },
                "required": ["table"],
                "additionalProperties": false
            }
        },
        {
            "name": "tablepeek_query",
            "description": "읽기 전용 SQL을 실행합니다. 쓰기 문은 거부됩니다.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sql": { "type": "string" },
                    "conn": { "type": "string" },
                    "max_rows": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 200 }
                },
                "required": ["sql"],
                "additionalProperties": false
            }
        }
    ])
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
}
