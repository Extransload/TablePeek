use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 하나의 쿼리 실행 결과 (JSON 경로용, 디버그/테스트 엔드포인트)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub row_count: usize,
    pub elapsed_ms: f64,
    pub truncated: bool,
}

/// API 오류 응답: `code`와 사람에게 보일 첫 줄 `message`, 그리고 데이터베이스가
/// 알려 준 만큼의 구조화된 정보 (docs/ERRORS.md §2).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiError {
    pub code: String,
    pub message: String,
    /// Boxed: most errors have none, and an error reply stays small.
    #[serde(flatten)]
    pub fields: Box<ErrorFields>,
}

impl ApiError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            fields: Box::default(),
        }
    }
}

/// What a database said about an error beyond its first line. Every part is
/// optional and left out of the JSON when unknown.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ErrorFields {
    /// The SQL engines' SQLSTATE (PostgreSQL, CockroachDB, MySQL).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sqlstate: Option<String>,
    /// Where in the statement sent the error points.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<ErrorPosition>,
    /// The engine's own number: MongoDB's code, MySQL's errno, SQL Server's
    /// error number, SQLite's extended result code.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_code: Option<i64>,
    /// MongoDB's codeName ("DuplicateKey").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code_name: Option<String>,
    /// Structured extras: PostgreSQL's detail, hint and the constraint,
    /// table and column it names; MongoDB's errInfo and writeErrors
    /// (canonical Extended JSON); for a MongoDB connection, the topology.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    /// The driver's whole text, credentials masked, when it says more than
    /// `message`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
}

/// `offset` counts characters of the statement from 1 (PostgreSQL's and
/// SQLite's); `line` and `column` count from 1 (MySQL and SQL Server give a
/// line only).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorPosition {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
}

/// 엔진 접속 상태
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineMeta {
    pub kind: String,
    pub path: Option<String>,
    pub demo: bool,
    pub tables: Vec<String>,
    /// What this connection can do, as the engine reports it once connected.
    /// Drivers leave it empty; the engine fills it in from its driver.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Capabilities>,
}

/// What an engine can do; the page turns features on from these values
/// rather than from the engine's name. Names are only ever added: a change
/// of meaning gets a new name. Keys an engine leaves out read as "can't".
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Capabilities {
    /// Query language: "sql", "mongo", …
    pub language: String,
    /// Object kinds the sidebar lists: "table", "view", "collection", …
    pub objects: Vec<String>,
    /// Where column information comes from: "declared" or "sampled".
    pub schema: String,
    /// Cells, rows and documents can be edited, added and deleted by key.
    pub edit_by_key: bool,
    /// "always", "replica_set" or "none".
    pub transactions: String,
    pub foreign_keys: bool,
    pub ddl: bool,
    /// "switch", "list" or "none".
    pub databases: String,
    pub users: bool,
    /// The plan format: "pg-json", "mysql-json", "sqlite", "mongo"; null for none.
    pub explain: Option<String>,
    pub exact_count: bool,
    /// Backup and restore format: "sql", "ejson"; null for none.
    pub dump: Option<String>,
    pub import_formats: Vec<String>,
    pub export_formats: Vec<String>,
    pub sessions: SessionCapabilities,
    pub validation: bool,
    pub aggregation: bool,
    pub indexes: IndexCapabilities,
    /// A table's rows page by the database's own paging token (Cassandra's
    /// paging state) rather than by OFFSET: the page goes forward from the
    /// token the last page gave, back or far ahead from tokens it noted, and
    /// past rows it never saw by having the server walk them (`/api/sql/skip`).
    pub cursor_paging: bool,
    /// An exact COUNT runs as steps the server splits (Cassandra's token
    /// ranges, several at once) through `/api/sql/count`, so the page shows
    /// how far it got and can stop it.
    pub count_steps: bool,
    /// Cancelling a running statement ends the session (SQL Server's KILL;
    /// an Oracle session that can neither break the call out of band nor
    /// run ALTER SYSTEM CANCEL SQL), so a transaction open on it rolls back:
    /// the client asks before cancelling inside one.
    pub cancel_ends_session: bool,
    /// A binary cell (Oracle's BLOB and RAW) is read whole and replaced from
    /// bytes of any size through `/api/sql/cell`, streamed both ways, past
    /// what the grid shows of it.
    pub binary_cells: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SessionCapabilities {
    pub kill: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct IndexCapabilities {
    pub create: bool,
    pub drop: bool,
}

/// 파일 탐색기 항목
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: Option<u64>,
}

/// 디렉터리 목록 응답
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<FsEntry>,
}

/// A value the database writes itself, as TablePlus's Set Value offers it.
/// The client names one; each backend writes its own keyword or function,
/// so no SQL text ever comes from the client.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ValueExpr {
    /// The column's default.
    Default,
    /// The current date and time, as the database tells it.
    Now,
}

/// 편집 대상 (UPDATE ... WHERE pk)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditTarget {
    pub table: String,
    pub pk: Vec<PkValue>,
    pub column: String,
    pub value: Option<String>,
    /// Written in place of `value` when set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expr: Option<ValueExpr>,
}

/// One cell of a saved row, by its table's key: a binary cell read or
/// replaced whole (`/api/sql/cell`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CellRef {
    pub table: String,
    pub pk: Vec<PkValue>,
    pub column: String,
}

/// One column of a new row: a value bound as text, or an expression.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InsertValue {
    pub column: String,
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expr: Option<ValueExpr>,
}

/// 기본 키 컬럼과 값 (NULL 비교 포함)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PkValue {
    pub column: String,
    pub value: Value,
}

/// 테이블 컬럼 정보 (스키마 브라우저)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnSchema {
    pub name: String,
    pub decl_type: Option<String>,
    pub not_null: bool,
    pub pk: bool,
    #[serde(default)]
    pub default: Option<String>,
    /// The values an enum column takes, in order (PostgreSQL enum types,
    /// MySQL ENUM and SET); filled by table detail only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<String>>,
}

/// 테이블 스키마 (스키마 브라우저)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableSchema {
    pub name: String,
    pub columns: Vec<ColumnSchema>,
}

/// 테이블 간 외래 키 관계 (/api/relations). Table names are spelled the way
/// the schema list spells them; multi-column keys keep their column order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Relation {
    pub table: String,
    pub columns: Vec<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
}

/// 인덱스 정보 (/api/table)
///
/// `columns` lists the plain columns of the index, as before. The optional
/// fields say what those can't (a dump needs them to recreate partial,
/// expression and prefix indexes); each is left out where the engine has no
/// such thing to report.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct IndexInfo {
    pub name: String,
    pub unique: bool,
    pub primary: bool,
    pub columns: Vec<String>,
    /// The engine's own complete statement for the index, ready to run:
    /// PostgreSQL/CockroachDB `pg_get_indexdef`, SQLite `sqlite_master.sql`.
    /// None for MySQL and SQL Server, and for indexes the engine made itself
    /// (SQLite's `sqlite_autoindex_*`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definition: Option<String>,
    /// A partial index's predicate, without the `WHERE` (PostgreSQL,
    /// CockroachDB, SQLite, SQL Server's filtered index `filter_definition`).
    #[serde(default, rename = "where", skip_serializing_if = "Option::is_none")]
    pub predicate: Option<String>,
    /// The key parts in key order, where the engine reports them one by one
    /// (PostgreSQL, CockroachDB, MySQL, SQL Server): each a column (with
    /// MySQL's prefix length) or an expression, and its sort direction.
    /// Included (non-key) columns are not parts. None for SQLite.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parts: Option<Vec<IndexPart>>,
    /// Non-key columns carried in the index (SQL Server `INCLUDE`,
    /// PostgreSQL `INCLUDE`, CockroachDB `STORING`); None when there are none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub included: Option<Vec<String>>,
}

/// One key part of an index: exactly one of `column` and `expression`, and
/// whether the key sorts descending (left out when ascending).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct IndexPart {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<String>,
    /// The expression as the engine prints it (PostgreSQL
    /// `pg_get_indexdef(index, n, true)`, MySQL 8 `EXPRESSION`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expression: Option<String>,
    /// MySQL: how many leading characters (bytes for binary types) of the
    /// column are indexed (`SUB_PART`); None for the whole column.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix_length: Option<u32>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub descending: bool,
}

/// 외래 키 정보 (/api/table)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForeignKeyInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
}

/// 테이블에 걸린 트리거
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggerInfo {
    pub name: String,
    /// BEFORE / AFTER / INSTEAD OF, when the driver says
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timing: Option<String>,
    /// INSERT / UPDATE / DELETE (several joined with " OR ")
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
    /// The full CREATE TRIGGER statement where the driver can give it
    pub definition: Option<String>,
}

/// 테이블 구조 + 통계 (/api/table)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableDetail {
    pub name: String,
    pub row_count_estimate: Option<i64>,
    /// 전체 크기 (데이터 + 인덱스)
    pub size_bytes: Option<i64>,
    /// 데이터 크기 (힙/클러스터드 + TOAST/LOB, 인덱스 제외)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_bytes: Option<i64>,
    /// 인덱스 크기
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index_bytes: Option<i64>,
    /// 테이블 주석 (비어 있으면 None)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    pub columns: Vec<ColumnSchema>,
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKeyInfo>,
    #[serde(default)]
    pub triggers: Vec<TriggerInfo>,
    pub ddl: Option<String>,
    #[serde(default)]
    pub schema: Option<String>,
    /// How the table is stored, line by line, where the engine says more
    /// than its columns and indexes do (ClickHouse's engine, ORDER BY,
    /// PARTITION BY, TTL). Left out when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub properties: Vec<TableProperty>,
}

/// One line of a table's properties: what it is and its value as the
/// engine writes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableProperty {
    pub name: String,
    pub value: String,
}

/// 서버 세션 정보 (/api/server)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerSession {
    pub id: String,
    pub user: Option<String>,
    pub database: Option<String>,
    pub state: Option<String>,
    pub query: Option<String>,
    pub elapsed_ms: Option<i64>,
    pub is_current: bool,
}

/// 서버/데이터베이스 정보 (/api/server)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerInfo {
    pub driver: String,
    pub version: Option<String>,
    pub database: Option<String>,
    pub encoding: Option<String>,
    pub uptime: Option<String>,
    pub size_bytes: Option<i64>,
    pub sessions: Option<Vec<ServerSession>>,
    pub can_kill: bool,
    /// How the server is deployed ("standalone", "replica_set", "sharded"),
    /// where the engine has such a notion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topology: Option<String>,
    /// The server answering, as host:port, where it isn't the address the
    /// connection names (a replica set member).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
}

/// 뷰/함수/프로시저/트리거/시퀀스 목록 (/api/objects)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DbObjects {
    pub views: Vec<String>,
    pub functions: Vec<String>,
    pub triggers: Vec<String>,
    pub sequences: Vec<String>,
    #[serde(default)]
    pub procedures: Vec<String>,
    /// Views whose rows are stored (ClickHouse, Oracle, Cassandra); opened
    /// like a view. Left out where the engine has none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub materialized_views: Vec<String>,
    /// ClickHouse dictionaries, read with SELECT like a table.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dictionaries: Vec<String>,
    /// User-defined types (Cassandra's UDTs, Oracle object types), shown
    /// with their definition.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub types: Vec<String>,
    /// User-defined aggregates (Cassandra), shown with their definition.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aggregates: Vec<String>,
    /// Synonyms (Oracle): other names for objects, shown with their target.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub synonyms: Vec<String>,
    /// PL/SQL packages (Oracle): their spec and body, shown as definitions.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub packages: Vec<String>,
}

/// 객체 정의 (/api/definition)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectDefinition {
    pub name: String,
    pub kind: String,
    pub ddl: Option<String>,
}

/// PostgreSQL 접속 설정 (비밀번호는 응답에 절대 포함하지 않는다)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostgresConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default, skip_serializing)]
    pub password: Option<String>,
    pub database: String,
    #[serde(default)]
    pub ssl_mode: SslMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssl_root_cert: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssl_client_cert: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssl_client_key: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SslMode {
    #[default]
    Disable,
    Prefer,
    Require,
}

/// MySQL/MariaDB 접속 설정 (비밀번호는 응답에 절대 포함하지 않는다)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MySqlConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default, skip_serializing)]
    pub password: Option<String>,
    pub database: String,
    #[serde(default)]
    pub ssl_mode: SslMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssl_root_cert: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssl_client_cert: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssl_client_key: Option<String>,
}

/// Microsoft SQL Server 접속 설정 (비밀번호는 응답에 절대 포함하지 않는다)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MssqlConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default, skip_serializing)]
    pub password: Option<String>,
    pub database: String,
    #[serde(default)]
    pub encrypt: bool,
}

/// SSH 터널 설정 (비밀번호/키는 응답에 포함하지 않는다)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default, skip_serializing)]
    pub password: Option<String>,
    #[serde(default, skip_serializing)]
    pub private_key_path: Option<String>,
}

/// HTTP CONNECT 프록시 터널 설정 (비밀번호는 응답에 포함하지 않는다)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpTunnelConfig {
    pub host: String,
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing)]
    pub password: Option<String>,
}

/// SQLite 파일 접속 설정 (저장된 연결 프로필에서 파일 경로를 기억한다)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqliteConfig {
    pub path: String,
}

/// An engine's connection settings as the client sends them: the keys its
/// descriptor's form fields name (host, port, path, …). The engine parses
/// them into its own typed settings.
pub type ConnConfig = serde_json::Map<String, Value>;

/// 원격 접속 요청 (/api/connect)
///
/// Written as `{ driver, config, ssh?, http_tunnel? }`. The older shape, the
/// settings under a key named after the driver (`{ driver: "postgres",
/// postgres: {…} }`), is still read: saved profiles and exported files from
/// earlier versions use it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(from = "ConnectRequestWire")]
pub struct ConnectRequest {
    pub driver: String,
    pub config: ConnConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<SshConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_tunnel: Option<HttpTunnelConfig>,
}

#[derive(Deserialize)]
struct ConnectRequestWire {
    driver: String,
    #[serde(default)]
    config: Option<ConnConfig>,
    #[serde(default)]
    ssh: Option<SshConfig>,
    #[serde(default)]
    http_tunnel: Option<HttpTunnelConfig>,
    #[serde(flatten)]
    rest: ConnConfig,
}

impl From<ConnectRequestWire> for ConnectRequest {
    fn from(wire: ConnectRequestWire) -> Self {
        let config = wire
            .config
            .unwrap_or_else(|| legacy_config(&wire.driver, wire.rest));
        Self {
            driver: wire.driver,
            config,
            ssh: wire.ssh,
            http_tunnel: wire.http_tunnel,
        }
    }
}

/// The settings of the older shape: the object under the driver's own key
/// among `rest`, the keys besides `driver`, `ssh` and `http_tunnel`. Empty
/// when there is none, which the engine then reports as missing settings.
pub fn legacy_config(driver: &str, mut rest: ConnConfig) -> ConnConfig {
    match rest.remove(driver) {
        Some(Value::Object(config)) => config,
        _ => ConnConfig::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn connect_request_reads_both_shapes() {
        let new: ConnectRequest = serde_json::from_value(json!({
            "driver": "postgres",
            "config": { "host": "h", "port": 5432 },
            "ssh": { "host": "b", "port": 22, "user": "u" }
        }))
        .unwrap();
        assert_eq!(new.config["host"], json!("h"));
        assert_eq!(new.ssh.unwrap().host, "b");

        let legacy: ConnectRequest = serde_json::from_value(json!({
            "driver": "mysql",
            "postgres": { "host": "other" },
            "mysql": { "host": "h", "port": 3306, "password": "pw" },
            "http_tunnel": { "host": "p", "port": 8080 }
        }))
        .unwrap();
        assert_eq!(legacy.config["host"], json!("h"));
        assert_eq!(legacy.config["password"], json!("pw"));
        assert_eq!(legacy.http_tunnel.unwrap().host, "p");

        let missing: ConnectRequest =
            serde_json::from_value(json!({ "driver": "sqlite" })).unwrap();
        assert!(missing.config.is_empty());

        // Written in the new shape.
        let written = serde_json::to_value(&missing).unwrap();
        assert_eq!(written, json!({ "driver": "sqlite", "config": {} }));
    }

    #[test]
    fn capabilities_left_out_read_as_cannot() {
        let caps: Capabilities = serde_json::from_value(json!({ "language": "sql" })).unwrap();
        assert_eq!(caps.language, "sql");
        assert!(!caps.ddl);
        assert_eq!(caps.explain, None);
        let written = serde_json::to_value(&caps).unwrap();
        assert_eq!(written["explain"], Value::Null);
        assert_eq!(
            written["indexes"],
            json!({ "create": false, "drop": false })
        );
    }
}
