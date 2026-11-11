//! ClickHouse's HTTP interface. Every statement is a POST whose body is the
//! SQL; results come back as JSONCompactEachRowWithNamesAndTypes (names,
//! types, then one JSON array per row) unless the statement names a FORMAT
//! of its own. The editor's statements run in one HTTP session, so USE and
//! SET last from one to the next; catalog reads go without it, naming the
//! database they read.

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use reqwest::header::HeaderMap;
use serde_json::Value;
use tablepeek_types::{ErrorFields, ErrorPosition};

use crate::driver::FileStream;
use crate::registry::NetRoute;
use crate::sql_log::{Dialect, SqlLog};
use crate::{caused_by_tls, char_offset, EngineError};

use super::ClickHouseConfig;

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// The format results are asked in when a statement names none.
const RESULT_FORMAT: &str = "JSONCompactEachRowWithNamesAndTypes";

/// QUERY_WAS_CANCELLED: what a KILL QUERY leaves the statement it stopped.
const CANCELLED: i64 = 394;

#[derive(Clone)]
pub(crate) struct Client {
    http: reqwest::Client,
    /// `http(s)://host:port/`, the host as the settings name it even through
    /// a tunnel (the tunnel is where the name resolves to), so TLS checks
    /// the certificate against the real name.
    base: String,
    user: String,
    password: String,
    /// The HTTP session the editor's statements share.
    session_id: String,
    log: SqlLog,
}

/// Where a statement runs: in the editor's session (its database is the
/// session's, as USE left it), or on its own in the database named.
#[derive(Clone, Copy)]
pub(crate) enum Scope<'a> {
    Session,
    Database(&'a str),
}

/// How one statement is sent.
pub(crate) struct Request<'a> {
    pub scope: Scope<'a>,
    /// Lets a cancel find the statement (KILL QUERY WHERE query_id = …).
    pub query_id: Option<&'a str>,
    /// Rows kept; the rest is dropped unread, which also ends the query.
    pub max_rows: usize,
    /// max_execution_time in seconds; 0 for the server's own limit.
    pub timeout_secs: u64,
    /// Settings for this statement alone (mutations_sync, …).
    pub settings: &'a [(&'a str, &'a str)],
}

impl<'a> Request<'a> {
    /// A catalog read in `database`, all of its rows.
    pub(crate) fn read(database: &'a str) -> Self {
        Self {
            scope: Scope::Database(database),
            query_id: None,
            max_rows: usize::MAX,
            timeout_secs: 0,
            settings: &[],
        }
    }

    /// One of the page's statements, in the editor's session.
    pub(crate) fn session(max_rows: usize) -> Self {
        Self {
            scope: Scope::Session,
            query_id: None,
            max_rows,
            timeout_secs: 0,
            settings: &[],
        }
    }
}

/// A statement's result as it came back.
pub(crate) struct Reply {
    pub columns: Vec<String>,
    /// ClickHouse's type of each column ("Nullable(UInt32)"); empty for a
    /// result in a format the statement named itself.
    pub types: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub truncated: bool,
    /// Rows the statement wrote (an INSERT's), as the server's summary says.
    pub written_rows: Option<u64>,
}

impl Client {
    pub(crate) fn new(
        config: &ClickHouseConfig,
        net: &NetRoute,
        session_id: String,
        log: SqlLog,
    ) -> Result<Self, EngineError> {
        let scheme = if config.tls { "https" } else { "http" };
        let host = config.host.trim();
        let mut builder = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .tcp_keepalive(Duration::from_secs(30))
            // Tunnels are the only detour a connection takes.
            .no_proxy();
        let mut url_host = host.to_string();
        let mut url_port = config.port;
        if let NetRoute::Via {
            host: via_host,
            port: via_port,
        } = net
        {
            match via_host.parse::<IpAddr>() {
                // The settings' name resolves to the tunnel's end: the URL
                // (and TLS's name check) keeps the real host. reqwest takes
                // the port from the URL, so that is the tunnel's.
                Ok(ip) if !host.is_empty() && host.parse::<IpAddr>().is_err() => {
                    builder = builder.resolve(host, SocketAddr::new(ip, *via_port));
                    // The Host header still names the server as set, for
                    // whatever routes by it in front of ClickHouse.
                    if let Ok(value) =
                        reqwest::header::HeaderValue::from_str(&format!("{host}:{}", config.port))
                    {
                        let mut headers = HeaderMap::new();
                        headers.insert(reqwest::header::HOST, value);
                        builder = builder.default_headers(headers);
                    }
                    url_port = *via_port;
                }
                _ => {
                    url_host.clone_from(via_host);
                    url_port = *via_port;
                }
            }
        }
        if config.tls {
            if let Some(path) = config
                .tls_ca_file
                .as_deref()
                .filter(|path| !path.is_empty())
            {
                let pem = std::fs::read(path).map_err(|err| {
                    EngineError::BadRequest(format!("CA 인증서를 읽을 수 없습니다: {path} ({err})"))
                })?;
                let certificates = reqwest::Certificate::from_pem_bundle(&pem).map_err(|err| {
                    EngineError::BadRequest(format!(
                        "CA 인증서가 올바르지 않습니다: {path} ({err})"
                    ))
                })?;
                for certificate in certificates {
                    builder = builder.add_root_certificate(certificate);
                }
            }
            if config.tls_skip_verify {
                builder = builder.danger_accept_invalid_certs(true);
            }
        }
        let http = builder.build().map_err(|err| {
            EngineError::Internal(format!("HTTP 클라이언트를 만들 수 없습니다: {err}"))
        })?;
        let url_host = if url_host.contains(':') && !url_host.starts_with('[') {
            format!("[{url_host}]")
        } else {
            url_host
        };
        Ok(Self {
            http,
            base: format!("{scheme}://{url_host}:{url_port}/"),
            user: config.user.clone(),
            password: config.password.clone().unwrap_or_default(),
            session_id,
            log,
        })
    }

    /// Runs one statement and reads up to `max_rows` of its rows.
    pub(crate) async fn run(&self, sql: &str, request: Request<'_>) -> Result<Reply, EngineError> {
        let max_rows = request.max_rows;
        let mut stream = self.rows(sql, request).await?;
        let rows = stream.next_rows(max_rows).await?;
        // One row past them tells whether there were more; the rest is
        // dropped unread, which ends the query.
        let truncated = !stream.ended && !stream.next_rows(1).await?.is_empty();
        Ok(Reply {
            columns: stream.lines.columns,
            types: stream.lines.types,
            rows,
            truncated,
            written_rows: stream.written_rows,
        })
    }

    /// Runs one statement and hands its rows over as they arrive
    /// (`RowStream::next_rows`). Dropping the stream ends the query.
    pub(crate) async fn rows(
        &self,
        sql: &str,
        request: Request<'_>,
    ) -> Result<RowStream, EngineError> {
        let response = self.send(sql, request).await?;
        let headers = response.headers();
        let format = headers
            .get("x-clickhouse-format")
            .and_then(|value| value.to_str().ok())
            .unwrap_or(RESULT_FORMAT)
            .to_string();
        let written_rows = summary_count(headers, "written_rows");
        Ok(RowStream {
            response,
            lines: BodyLines::new(&format),
            sql: sql.to_string(),
            ended: false,
            written_rows,
        })
    }

    /// Runs a statement whose result is a file in the format it names: its
    /// bytes as they arrive. An error after the first bytes comes as an
    /// item of the stream.
    pub(crate) async fn stream(
        &self,
        sql: &str,
        request: Request<'_>,
    ) -> Result<FileStream, EngineError> {
        let response = self.send(sql, request).await?;
        let sql = sql.to_string();
        let chunks = futures_util::stream::unfold(Some(response), move |state| {
            let sql = sql.clone();
            async move {
                let mut response = state?;
                match response.chunk().await {
                    Ok(Some(chunk)) => {
                        // The server's error after rows: "\n__exception__\n…Code: …".
                        if let Some(at) = find(&chunk, b"__exception__") {
                            let text = String::from_utf8_lossy(&chunk[at..]).to_string();
                            return Some((Err(server_error(&text, None, &sql)), None));
                        }
                        Some((Ok(chunk.to_vec()), Some(response)))
                    }
                    Ok(None) => None,
                    Err(err) => Some((Err(transport_error(err)), None)),
                }
            }
        });
        Ok(Box::pin(chunks))
    }

    /// Sends one statement; a reply other than 200 is the server's error.
    async fn send(
        &self,
        sql: &str,
        request: Request<'_>,
    ) -> Result<reqwest::Response, EngineError> {
        self.log.record(sql, Dialect::ClickHouse);
        let mut params: Vec<(&str, String)> = vec![
            ("default_format", RESULT_FORMAT.into()),
            // Exact text for the numbers JSON can't carry (Int64 past 2^53,
            // Decimal, NaN); the driver turns the ones that fit back.
            ("output_format_json_quote_64bit_integers", "1".into()),
            ("output_format_json_quote_decimals", "1".into()),
            ("output_format_json_quote_denormals", "1".into()),
            // Decimal(10, 2) shows 10.50, as declared.
            ("output_format_decimal_trailing_zeros", "1".into()),
            // Tuples as arrays, in their elements' order, as edits write them back.
            ("output_format_json_named_tuples_as_objects", "0".into()),
            // Rows read and dropped unread end the query on the server.
            ("cancel_http_readonly_queries_on_client_close", "1".into()),
            // An error after the first rows comes as plain text after them.
            ("http_write_exception_in_output_format", "0".into()),
        ];
        match request.scope {
            Scope::Session => {
                params.push(("session_id", self.session_id.clone()));
                params.push(("session_timeout", "3600".into()));
            }
            Scope::Database(database) => params.push(("database", database.to_string())),
        }
        if let Some(query_id) = request.query_id {
            params.push(("query_id", query_id.to_string()));
        }
        if request.timeout_secs > 0 {
            params.push(("max_execution_time", request.timeout_secs.to_string()));
        }
        for (name, value) in request.settings {
            params.push((name, (*value).to_string()));
        }
        let response = self
            .http
            .post(&self.base)
            .query(&params)
            .header("X-ClickHouse-User", &self.user)
            .header("X-ClickHouse-Key", &self.password)
            .body(sql.to_string())
            .send()
            .await
            .map_err(transport_error)?;
        let status = response.status();
        if !status.is_success() {
            let code = header_code(response.headers());
            let text = response.text().await.map_err(transport_error)?;
            return Err(server_error(&text, code, sql));
        }
        Ok(response)
    }

    /// Runs a statement whose result doesn't matter.
    pub(crate) async fn execute(&self, sql: &str, request: Request<'_>) -> Result<(), EngineError> {
        self.run(sql, request).await.map(|_| ())
    }

    /// The first column of the first row, as text.
    pub(crate) async fn scalar(
        &self,
        sql: &str,
        request: Request<'_>,
    ) -> Result<Option<String>, EngineError> {
        let reply = self.run(sql, request).await?;
        Ok(reply
            .rows
            .into_iter()
            .next()
            .and_then(|row| row.into_iter().next())
            .and_then(|value| text_of(&value)))
    }
}

/// A cell as text: strings as they are, other values as JSON writes them;
/// None for NULL.
pub(crate) fn text_of(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        other => Some(other.to_string()),
    }
}

/// A statement's rows as they arrive (`Client::rows`): the response, read a
/// chunk at a time as rows are asked for.
pub(crate) struct RowStream {
    response: reqwest::Response,
    lines: BodyLines,
    sql: String,
    /// The whole body has been read.
    ended: bool,
    /// Rows the statement wrote (an INSERT's), as the server's summary says.
    written_rows: Option<u64>,
}

impl RowStream {
    /// Up to `limit` more rows, reading as many more bytes as they take;
    /// fewer only once the body has ended. The names and types are known
    /// once a row has come or the body has ended.
    pub(crate) async fn next_rows(&mut self, limit: usize) -> Result<Vec<Vec<Value>>, EngineError> {
        let mut rows = Vec::new();
        while rows.len() < limit {
            if let Some(row) = self.lines.next_row() {
                rows.push(row);
                continue;
            }
            if self.ended {
                break;
            }
            match self.response.chunk().await {
                Ok(Some(chunk)) => self.lines.push(&chunk),
                Ok(None) => {
                    self.ended = true;
                    rows.extend(self.lines.finish(&self.sql)?);
                }
                Err(err) => return Err(self.lines.broken(err, &self.sql)),
            }
        }
        Ok(rows)
    }

    pub(crate) fn columns(&self) -> &[String] {
        &self.lines.columns
    }

    /// ClickHouse's type of each column; empty for a result in a format the
    /// statement named itself.
    pub(crate) fn types(&self) -> &[String] {
        &self.lines.types
    }
}

/// A body's lines, parsed as its bytes arrive: in the driver's own format
/// the names, the types and then one row per line; any other format's lines
/// as rows of one column named after it. Once a line isn't JSON, the rest
/// of the body is the server's error text.
struct BodyLines {
    ours: bool,
    /// Bytes not yet parsed start at `start`.
    pending: Vec<u8>,
    start: usize,
    lines_seen: usize,
    trailer: Option<Vec<u8>>,
    columns: Vec<String>,
    types: Vec<String>,
}

impl BodyLines {
    fn new(format: &str) -> Self {
        let ours = format == RESULT_FORMAT;
        Self {
            ours,
            pending: Vec::new(),
            start: 0,
            lines_seen: 0,
            trailer: None,
            columns: if ours {
                Vec::new()
            } else {
                vec![format.to_string()]
            },
            types: Vec::new(),
        }
    }

    /// The next bytes of the body.
    fn push(&mut self, chunk: &[u8]) {
        if let Some(trailer) = self.trailer.as_mut() {
            trailer.extend_from_slice(chunk);
            return;
        }
        self.pending.drain(..self.start);
        self.start = 0;
        self.pending.extend_from_slice(chunk);
    }

    /// The next row whose line has fully arrived; None until more bytes
    /// come, or for good once the server's error text has started.
    fn next_row(&mut self) -> Option<Vec<Value>> {
        while self.trailer.is_none() {
            let end = self.pending[self.start..]
                .iter()
                .position(|byte| *byte == b'\n')?;
            let line_start = self.start;
            self.start += end + 1;
            let line = &self.pending[line_start..line_start + end];
            if !self.ours {
                let text = String::from_utf8_lossy(line)
                    .trim_end_matches('\r')
                    .to_string();
                return Some(vec![Value::String(text)]);
            }
            let Ok(values) = serde_json::from_slice::<Vec<Value>>(line) else {
                self.trailer = Some(self.pending.split_off(line_start));
                self.pending.clear();
                self.start = 0;
                return None;
            };
            self.lines_seen += 1;
            let texts = || {
                values
                    .iter()
                    .map(|value| text_of(value).unwrap_or_default())
                    .collect()
            };
            match self.lines_seen {
                1 => self.columns = texts(),
                2 => self.types = texts(),
                _ => return Some(values),
            }
        }
        None
    }

    /// The body has ended, every whole line taken: what is left is another
    /// format's last line without its newline (a row), or the error the
    /// server wrote after the rows.
    fn finish(&mut self, sql: &str) -> Result<Option<Vec<Value>>, EngineError> {
        let rest = self.pending.split_off(self.start);
        self.pending.clear();
        self.start = 0;
        let trailer = match self.trailer.take() {
            Some(trailer) => trailer,
            None if self.ours => rest,
            None if rest.is_empty() => return Ok(None),
            None => {
                let text = String::from_utf8_lossy(&rest).to_string();
                return Ok(Some(vec![Value::String(text)]));
            }
        };
        let text = String::from_utf8_lossy(&trailer);
        if !text.trim().is_empty() {
            return Err(server_error(&text, None, sql));
        }
        Ok(None)
    }

    /// The body broken off midway. The server breaks the stream off after
    /// the error it wrote (__exception__ …): that error is the one to
    /// report.
    fn broken(&self, err: reqwest::Error, sql: &str) -> EngineError {
        let unread = self
            .trailer
            .as_deref()
            .unwrap_or(&self.pending[self.start..]);
        let text = String::from_utf8_lossy(unread);
        if let Some(at) = text.find("__exception__") {
            return server_error(&text[at..], None, sql);
        }
        transport_error(err)
    }
}

fn header_code(headers: &HeaderMap) -> Option<i64> {
    headers
        .get("x-clickhouse-exception-code")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse().ok())
}

/// A count from the X-ClickHouse-Summary header (`{"written_rows":"3",…}`).
fn summary_count(headers: &HeaderMap, key: &str) -> Option<u64> {
    let summary: Value =
        serde_json::from_str(headers.get("x-clickhouse-summary")?.to_str().ok()?).ok()?;
    match &summary[key] {
        Value::String(text) => text.parse().ok(),
        Value::Number(number) => number.as_u64(),
        _ => None,
    }
}

/// The server's error text, "Code: 62. DB::Exception: Syntax error: failed
/// at position 8 (FROM) (line 1, col 8): …. (SYNTAX_ERROR) (version 25.8…)",
/// as the error's parts.
pub(crate) fn server_error(text: &str, code: Option<i64>, sql: &str) -> EngineError {
    let raw = text.trim().to_string();
    let parsed_code = raw
        .find("Code: ")
        .map(|at| &raw[at + 6..])
        .and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|digits| digits.parse::<i64>().ok());
    let code = code.or(parsed_code);
    let mut message = match raw.find("DB::Exception: ") {
        Some(at) => raw[at + 15..].to_string(),
        None => raw.clone(),
    };
    if let Some(at) = message.rfind(" (version ") {
        message.truncate(at);
    }
    // The error's name, last in parentheses: "(SYNTAX_ERROR)".
    let mut code_name = None;
    if let Some(open) = message.rfind(" (") {
        let name = message[open + 2..].trim_end_matches(')');
        if !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_uppercase() || c == '_' || c.is_ascii_digit())
        {
            code_name = Some(name.to_string());
            message.truncate(open);
        }
    }
    let message = message.trim_end_matches('.').trim().to_string();
    let mut fields = ErrorFields {
        server_code: code,
        code_name,
        position: error_position(&message, sql),
        ..ErrorFields::default()
    };
    fields.raw = (raw != message).then_some(raw);
    EngineError::Driver {
        engine: "clickhouse",
        code: code.map(|code| code.to_string()),
        message: if message.is_empty() {
            "알 수 없는 ClickHouse 오류".into()
        } else {
            message
        },
        interrupted: code == Some(CANCELLED),
        fields: Box::new(fields),
    }
}

/// "failed at position 8" counts bytes of the statement from 1; "(line 1,
/// col 8)" comes with it on newer servers.
fn error_position(message: &str, sql: &str) -> Option<ErrorPosition> {
    let after = message.find("at position ").map(|at| &message[at + 12..])?;
    let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
    let byte: usize = digits.parse().ok()?;
    let offset = char_offset(sql, byte.checked_sub(1)?)?;
    Some(ErrorPosition {
        offset: Some(offset),
        ..ErrorPosition::default()
    })
}

/// A request that never got an answer: the server unreachable, TLS refused,
/// the connection dropped.
fn transport_error(err: reqwest::Error) -> EngineError {
    let tls = caused_by_tls(&err);
    let mut parts: Vec<String> = Vec::new();
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(&err);
    while let Some(cause) = current {
        let text = cause.to_string();
        if !text.is_empty() && !parts.iter().any(|part| part.contains(&text)) {
            parts.push(text);
        }
        current = cause.source();
    }
    // reqwest names the URL, which says nothing secret (credentials go in headers).
    let message = parts.join(": ");
    let error = EngineError::Driver {
        engine: "clickhouse",
        code: None,
        message: message.clone(),
        interrupted: false,
        fields: Box::new(ErrorFields::default()),
    };
    if tls {
        error.prefixed("TLS 연결 실패: ")
    } else {
        error
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn parts(error: EngineError) -> (Option<String>, String, ErrorFields) {
        match error {
            EngineError::Driver {
                code,
                message,
                fields,
                ..
            } => (code, message, *fields),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn server_errors_keep_code_name_and_position() {
        let sql = "SELECT FROM t";
        let (code, message, fields) = parts(server_error(
            "Code: 62. DB::Exception: Syntax error: failed at position 8 (FROM) (line 1, col 8): FROM t. Expected one of: list of elements. (SYNTAX_ERROR) (version 25.8.1.1 (official build))\n",
            None,
            sql,
        ));
        assert_eq!(code.as_deref(), Some("62"));
        assert_eq!(fields.server_code, Some(62));
        assert_eq!(fields.code_name.as_deref(), Some("SYNTAX_ERROR"));
        assert_eq!(
            fields.position.and_then(|position| position.offset),
            Some(8)
        );
        assert!(message.starts_with("Syntax error: failed at position 8"));
        assert!(!message.contains("version"));
        assert!(fields.raw.is_some());
    }

    #[test]
    fn header_code_wins_and_cancel_is_interrupted() {
        let error = server_error(
            "Code: 394. DB::Exception: Query was cancelled. (QUERY_WAS_CANCELLED)",
            Some(394),
            "SELECT 1",
        );
        assert!(error.is_interrupted());
        let (_, message, fields) = parts(error);
        assert_eq!(message, "Query was cancelled");
        assert_eq!(fields.code_name.as_deref(), Some("QUERY_WAS_CANCELLED"));
    }

    #[test]
    fn positions_count_characters() {
        let sql = "SELECT '가' FROM";
        // FROM starts at byte 14 (from 1), the 12th character.
        let position = error_position("failed at position 14 (FROM)", sql);
        assert_eq!(position.and_then(|position| position.offset), Some(12));
    }

    /// `body` fed in pieces of `size` bytes: the rows, then the end's.
    fn parse(
        format: &str,
        body: &[u8],
        size: usize,
    ) -> (BodyLines, Vec<Vec<Value>>, Result<(), EngineError>) {
        let mut lines = BodyLines::new(format);
        let mut rows = Vec::new();
        for chunk in body.chunks(size) {
            lines.push(chunk);
            while let Some(row) = lines.next_row() {
                rows.push(row);
            }
        }
        let end = lines.finish("SELECT 1").map(|last| rows.extend(last));
        (lines, rows, end)
    }

    #[test]
    fn rows_come_whole_across_any_chunk_boundary() {
        let body =
            "[\"id\",\"name\"]\n[\"UInt64\",\"String\"]\n[\"1\",\"a\\nb\"]\n[\"2\",\"가나\"]\n";
        for size in 1..=body.len() {
            let (lines, rows, end) = parse(RESULT_FORMAT, body.as_bytes(), size);
            assert!(end.is_ok(), "size {size}");
            assert_eq!(lines.columns, ["id", "name"]);
            assert_eq!(lines.types, ["UInt64", "String"]);
            assert_eq!(
                rows,
                vec![
                    vec![json!("1"), json!("a\nb")],
                    vec![json!("2"), json!("가나")]
                ]
            );
        }
    }

    #[test]
    fn names_arrive_without_rows() {
        let (lines, rows, end) = parse(RESULT_FORMAT, b"[\"n\"]\n[\"Int32\"]\n", 3);
        assert!(end.is_ok());
        assert_eq!(lines.columns, ["n"]);
        assert!(rows.is_empty());
    }

    #[test]
    fn error_after_rows_is_reported_whatever_the_chunks() {
        let body = "[\"n\"]\n[\"Int32\"]\n[1]\nCode: 395. DB::Exception: Value passed to 'throwIf' function is non-zero. (FUNCTION_THROW_IF_VALUE_IS_NON_ZERO)\n";
        for size in [1, 7, body.len()] {
            let (_, rows, end) = parse(RESULT_FORMAT, body.as_bytes(), size);
            assert_eq!(rows, vec![vec![json!(1)]]);
            let error = end.unwrap_err();
            assert!(matches!(error, EngineError::Driver { .. }), "{error:?}");
        }
    }

    #[test]
    fn other_formats_are_lines_and_the_last_needs_no_newline() {
        let (lines, rows, end) = parse("CSV", b"1,\"a\"\r\n2,\"b\"", 2);
        assert!(end.is_ok());
        assert_eq!(lines.columns, ["CSV"]);
        assert_eq!(rows, vec![vec![json!("1,\"a\"")], vec![json!("2,\"b\"")]]);
    }
}
