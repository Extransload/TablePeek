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
}

/// 테이블 스키마 (스키마 브라우저)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableSchema {
    pub name: String,
    pub columns: Vec<ColumnSchema>,
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
}
