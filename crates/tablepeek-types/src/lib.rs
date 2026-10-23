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

/// API 오류 응답
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiError {
    pub code: String,
    pub message: String,
}

/// 엔진 접속 상태
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineMeta {
    pub kind: String,
    pub path: Option<String>,
    pub demo: bool,
    pub tables: Vec<String>,
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

/// 편집 대상 (UPDATE ... WHERE pk)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditTarget {
    pub table: String,
    pub pk: Vec<PkValue>,
    pub column: String,
    pub value: Option<String>,
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

/// 인덱스 정보 (/api/table)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexInfo {
    pub name: String,
    pub unique: bool,
    pub primary: bool,
    pub columns: Vec<String>,
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
}

/// 뷰/함수/프로시저/트리거/시퀀스 목록 (/api/objects)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbObjects {
    pub views: Vec<String>,
    pub functions: Vec<String>,
    pub triggers: Vec<String>,
    pub sequences: Vec<String>,
    #[serde(default)]
    pub procedures: Vec<String>,
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

/// 원격 접속 요청 (/api/connect)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectRequest {
    pub driver: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub postgres: Option<PostgresConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cockroach: Option<PostgresConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mysql: Option<MySqlConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mssql: Option<MssqlConfig>,
    #[serde(default, skip_serializing)]
    pub ssh: Option<SshConfig>,
    #[serde(default, skip_serializing)]
    pub http_tunnel: Option<HttpTunnelConfig>,
}
