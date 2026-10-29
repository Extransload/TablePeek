use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Once, RwLock};
use std::time::{Duration, Instant};

use arrow::array::{
    Array, ArrayRef, Float64Array, Float64Builder, Int64Array, Int64Builder, StringArray,
    StringBuilder,
};
use arrow::datatypes::{DataType, Field, Schema, SchemaRef};
use arrow::ipc::writer::StreamWriter;
use arrow::record_batch::RecordBatch;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use tablepeek_types::{
    Capabilities, ColumnSchema, ConnConfig, DbObjects, EditTarget, EngineMeta, ErrorFields,
    ErrorPosition, ForeignKeyInfo, IndexInfo, InsertValue, ObjectDefinition, PkValue, QueryResult,
    Relation, ServerInfo, TableDetail, TableSchema, TriggerInfo, ValueExpr,
};

pub mod driver;
pub mod engines;
mod mssql;
mod mysql;
mod postgres;
pub mod registry;
mod source_cache;
pub mod sql_log;
mod sql_parse;
pub use sql_parse::is_read_only;

use driver::{CancelRequest, DocumentDriver, Driver, SqlDriver, TxOp};
use engines::sqlite::SqliteDriver;
use registry::{DriverFactory, NetRoute};
use sql_log::{inline_params, Change, Dialect, LogParam, SqlLog};

pub const BATCH_CHUNK: usize = 65_536;

static CRYPTO_PROVIDER: Once = Once::new();

pub(crate) fn ensure_crypto_provider() {
    CRYPTO_PROVIDER.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Errors carry the engine they came from; a database's own errors all
/// share one form, `Driver`, whatever the engine.
#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    /// An error the database (or its client library) reported. `engine` is
    /// the driver's id ("postgres" for CockroachDB too, which shares its
    /// driver); `code` the database's own code where it gives one (SQLSTATE,
    /// SQLite's result code, MySQL's and SQL Server's error numbers);
    /// `message` the human first line, without codes or labels; `fields`
    /// the rest the driver said (codes, position, details, its whole text).
    /// `interrupted`: the statement stopped because it was cancelled.
    #[error("{} 오류: {message}", registry::label(engine))]
    Driver {
        engine: &'static str,
        code: Option<String>,
        message: String,
        interrupted: bool,
        fields: Box<ErrorFields>,
    },
    #[error("Arrow 오류: {0}")]
    Arrow(#[from] arrow::error::ArrowError),
    #[error("파일을 찾을 수 없습니다: {0}")]
    NotFound(String),
    #[error("SQLite 데이터베이스 파일이 아닙니다: {0}")]
    NotAFile(String),
    #[error("편집할 수 없습니다: {0}")]
    NotEditable(String),
    #[error("{0}")]
    BadRequest(String),
    /// The engine can't do this at all (a SQL operation on a document store).
    #[error("{0}")]
    Unsupported(String),
    /// No registered engine has this id.
    #[error("지원하지 않는 엔진: {0}")]
    UnknownEngine(String),
    #[error("테이블을 찾을 수 없습니다")]
    TableNotFound,
    #[error("세션을 찾을 수 없습니다")]
    SessionNotFound,
    /// COMMIT did not commit: the transaction was rolled back instead.
    #[error("{0}")]
    TxRolledBack(String),
    /// The transaction is over, but whether its COMMIT went through is not
    /// known (the connection was lost on the way).
    #[error("{0}")]
    TxOutcomeUnknown(String),
    #[error("내부 오류: {0}")]
    Internal(String),
}

pub(crate) fn postgres_message(err: &tokio_postgres::Error) -> String {
    if let Some(db) = err.as_db_error() {
        let mut message = db.message().to_owned();
        if let Some(detail) = db.detail() {
            if !detail.is_empty() {
                message.push_str(&format!(" ({detail})"));
            }
        }
        if let Some(hint) = db.hint() {
            if !hint.is_empty() {
                message.push_str(&format!(" — {hint}"));
            }
        }
        // The code identifies the error even when the server's messages are
        // localized; the UI keys its explanations off it.
        message.push_str(&format!(" [SQLSTATE {}]", db.code().code()));
        return message;
    }
    let mut parts: Vec<String> = Vec::new();
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(err);
    while let Some(cause) = current {
        let text = cause.to_string();
        if !text.is_empty() && text != "db error" && !parts.contains(&text) {
            parts.push(text);
        }
        current = cause.source();
    }
    if parts.is_empty() {
        "알 수 없는 PostgreSQL 오류".into()
    } else {
        parts.join(": ")
    }
}

impl From<tokio_postgres::Error> for EngineError {
    fn from(source: tokio_postgres::Error) -> Self {
        let raw = postgres_message(&source);
        let mut fields = ErrorFields::default();
        let message = match source.as_db_error() {
            Some(db) => {
                fields.sqlstate = Some(db.code().code().to_string());
                // Only a position in the statement sent; an internal one
                // points into a query the server made up.
                if let Some(tokio_postgres::error::ErrorPosition::Original(offset)) = db.position()
                {
                    fields.position = Some(ErrorPosition {
                        offset: Some(*offset),
                        ..ErrorPosition::default()
                    });
                }
                let parts = [
                    ("detail", db.detail()),
                    ("hint", db.hint()),
                    ("schema", db.schema()),
                    ("table", db.table()),
                    ("column", db.column()),
                    ("constraint", db.constraint()),
                    ("datatype", db.datatype()),
                ];
                let details: serde_json::Map<String, Value> = parts
                    .into_iter()
                    .filter_map(|(key, value)| {
                        let value = value.filter(|value| !value.is_empty())?;
                        Some((key.to_string(), Value::String(value.to_string())))
                    })
                    .collect();
                if !details.is_empty() {
                    fields.details = Some(Value::Object(details));
                }
                fields.raw = Some(raw);
                db.message().to_owned()
            }
            None => raw,
        };
        EngineError::Driver {
            engine: "postgres",
            code: source.code().map(|state| state.code().to_string()),
            message,
            interrupted: source.code() == Some(&tokio_postgres::error::SqlState::QUERY_CANCELED),
            fields: Box::new(fields),
        }
    }
}

impl From<rusqlite::Error> for EngineError {
    fn from(source: rusqlite::Error) -> Self {
        let mut fields = ErrorFields::default();
        let (code, interrupted, message) = match &source {
            rusqlite::Error::SqliteFailure(failure, text) => (
                Some(failure.extended_code),
                failure.code == rusqlite::ErrorCode::OperationInterrupted,
                text.clone(),
            ),
            // sqlite3_error_offset: the byte where the bad token starts.
            rusqlite::Error::SqlInputError {
                error,
                msg,
                sql,
                offset,
            } => {
                fields.position = usize::try_from(*offset)
                    .ok()
                    .and_then(|offset| char_offset(sql, offset))
                    .map(|offset| ErrorPosition {
                        offset: Some(offset),
                        ..ErrorPosition::default()
                    });
                (Some(error.extended_code), false, Some(msg.clone()))
            }
            _ => (None, false, None),
        };
        let raw = source.to_string();
        let message = message.unwrap_or_else(|| raw.clone());
        fields.server_code = code.map(i64::from);
        fields.raw = (raw != message).then_some(raw);
        EngineError::Driver {
            engine: "sqlite",
            code: code.map(|code| code.to_string()),
            message,
            interrupted,
            fields: Box::new(fields),
        }
    }
}

/// The character, counted from 1, that starts at byte `offset` of `text`.
pub(crate) fn char_offset(text: &str, offset: usize) -> Option<u32> {
    let before = text.get(..offset)?;
    u32::try_from(before.chars().count() + 1).ok()
}

/// Whether TLS is what failed: a rustls error somewhere down the chain,
/// directly or inside the I/O error that carries it.
pub(crate) fn caused_by_tls(err: &(dyn std::error::Error + 'static)) -> bool {
    let mut current = Some(err);
    while let Some(cause) = current {
        if cause.is::<rustls::Error>() {
            return true;
        }
        if let Some(inner) = cause
            .downcast_ref::<std::io::Error>()
            .and_then(std::io::Error::get_ref)
        {
            if caused_by_tls(inner) {
                return true;
            }
        }
        current = cause.source();
    }
    false
}

impl EngineError {
    /// A MySQL error; whether it means the statement was stopped (KILL
    /// QUERY, a closed connection) is read from its text.
    pub(crate) fn mysql(message: String, fields: ErrorFields) -> Self {
        let lower = format!("{message} {}", fields.raw.as_deref().unwrap_or("")).to_lowercase();
        let interrupted = lower.contains("interrupted")
            || lower.contains("killed")
            || lower.contains("connection closed")
            || lower.contains("connection reset");
        EngineError::Driver {
            engine: "mysql",
            code: fields.server_code.map(|code| code.to_string()),
            message,
            interrupted,
            fields: Box::new(fields),
        }
    }

    /// A SQL Server error; whether it means the statement was stopped (a
    /// KILL, a closed connection) is read from its text.
    pub(crate) fn mssql(message: String, fields: ErrorFields) -> Self {
        let lower = format!("{message} {}", fields.raw.as_deref().unwrap_or("")).to_lowercase();
        let interrupted = lower.contains("kill")
            || lower.contains("interrupted")
            || lower.contains("connection closed")
            || lower.contains("connection reset")
            || lower.contains("forcibly");
        EngineError::Driver {
            engine: "mssql",
            code: fields.server_code.map(|code| code.to_string()),
            message,
            interrupted,
            fields: Box::new(fields),
        }
    }

    /// The same error with `prefix` before its first line ("TLS 연결 실패: ").
    pub(crate) fn prefixed(mut self, prefix: &str) -> Self {
        if let EngineError::Driver { message, .. } = &mut self {
            *message = format!("{prefix}{message}");
        }
        self
    }

    pub fn is_interrupted(&self) -> bool {
        matches!(
            self,
            EngineError::Driver {
                interrupted: true,
                ..
            }
        )
    }
}

/// 컬럼형 쿼리 결과: Arrow 배치 + 편집용 메타데이터.
#[derive(Clone)]
pub struct QueryData {
    pub kind: &'static str,
    pub columns: Vec<String>,
    pub schema: SchemaRef,
    pub batches: Vec<RecordBatch>,
    pub row_count: usize,
    pub elapsed_ms: f64,
    pub truncated: bool,
    pub source_table: Option<String>,
    pub pk: Option<Vec<String>>,
    /// What the driver says a column holds where its values can't: "boolean"
    /// for MySQL's TINYINT(1), whose values are 1 and 0. Empty when nothing
    /// is known.
    pub column_kinds: Vec<Option<&'static str>>,
    /// Rows a statement without a result set (INSERT, UPDATE, DELETE, DDL)
    /// changed, as the database reports it. None for one that returns rows,
    /// or where the driver doesn't say (SQL Server's query stream).
    pub rows_affected: Option<u64>,
}

impl QueryData {
    pub fn empty() -> Self {
        Self {
            kind: "sqlite",
            columns: Vec::new(),
            schema: Arc::new(Schema::empty()),
            batches: Vec::new(),
            row_count: 0,
            elapsed_ms: 0.0,
            truncated: false,
            source_table: None,
            pk: None,
            column_kinds: Vec::new(),
            rows_affected: None,
        }
    }

    pub fn slice_rows(
        &self,
        offset: usize,
        limit: usize,
    ) -> Result<(RecordBatch, usize), EngineError> {
        if self.row_count == 0 || offset >= self.row_count {
            return Ok((RecordBatch::new_empty(self.schema.clone()), 0));
        }
        let end = (offset + limit).min(self.row_count);
        let mut picked: Vec<RecordBatch> = Vec::new();
        let mut seen = 0usize;
        for batch in &self.batches {
            let batch_start = seen;
            let batch_end = seen + batch.num_rows();
            let from = offset.max(batch_start);
            let to = end.min(batch_end);
            if from < to {
                picked.push(batch.slice(from - batch_start, to - from));
            }
            seen = batch_end;
            if seen >= end {
                break;
            }
        }
        let combined = match picked.len() {
            0 => RecordBatch::new_empty(self.schema.clone()),
            1 => picked.pop().unwrap(),
            _ => arrow::compute::concat_batches(&self.schema, &picked)?,
        };
        Ok((combined, end - offset))
    }

    pub fn encode_ipc(&self, batch: &RecordBatch) -> Result<Vec<u8>, EngineError> {
        let mut writer = StreamWriter::try_new(Vec::new(), &self.schema)?;
        writer.write(batch)?;
        writer.finish()?;
        Ok(writer.into_inner()?)
    }

    pub fn rows_json(&self) -> Vec<Vec<Value>> {
        let mut out = Vec::with_capacity(self.row_count);
        for batch in &self.batches {
            for r in 0..batch.num_rows() {
                let mut row = Vec::with_capacity(batch.num_columns());
                for col in batch.columns() {
                    row.push(array_value(col, r));
                }
                out.push(row);
            }
        }
        out
    }

    pub fn cell_string(&self, row: usize, col: usize) -> Option<String> {
        let mut seen = 0usize;
        for batch in &self.batches {
            let next = seen + batch.num_rows();
            if row < next {
                if col >= batch.num_columns() {
                    return None;
                }
                let arr = batch.column(col);
                let local = row - seen;
                if arr.is_null(local) {
                    return None;
                }
                if let Some(a) = arr.as_any().downcast_ref::<Int64Array>() {
                    return Some(a.value(local).to_string());
                }
                if let Some(a) = arr.as_any().downcast_ref::<Float64Array>() {
                    return Some(a.value(local).to_string());
                }
                if let Some(a) = arr.as_any().downcast_ref::<StringArray>() {
                    return Some(a.value(local).to_string());
                }
                return None;
            }
            seen = next;
        }
        None
    }

    pub fn patch_cell(
        &mut self,
        row: usize,
        col: usize,
        value: Option<&str>,
    ) -> Result<(), EngineError> {
        if col >= self.columns.len() {
            return Err(EngineError::Internal("열 범위를 벗어났습니다".into()));
        }
        let mut seen = 0usize;
        let mut target: Option<(usize, usize)> = None;
        for (index, batch) in self.batches.iter().enumerate() {
            let next = seen + batch.num_rows();
            if row < next {
                target = Some((index, row - seen));
                break;
            }
            seen = next;
        }
        let Some((batch_index, local)) = target else {
            return Err(EngineError::Internal("행 범위를 벗어났습니다".into()));
        };

        let current = self.schema.field(col).data_type().clone();
        let fits = match (&current, value) {
            (_, None) => true,
            (DataType::Utf8, Some(_)) => true,
            (DataType::Int64, Some(text)) => text.parse::<i64>().is_ok(),
            (DataType::Float64, Some(text)) => text.parse::<f64>().is_ok(),
            _ => false,
        };

        if fits {
            let batch = &self.batches[batch_index];
            let replaced = replace_array_value(batch.column(col), local, value, &current)?;
            let columns: Vec<ArrayRef> = batch
                .columns()
                .iter()
                .enumerate()
                .map(|(c, arr)| {
                    if c == col {
                        replaced.clone()
                    } else {
                        arr.clone()
                    }
                })
                .collect();
            self.batches[batch_index] = RecordBatch::try_new(self.schema.clone(), columns)?;
        } else {
            let mut fields: Vec<Field> =
                self.schema.fields().iter().map(|f| (**f).clone()).collect();
            fields[col] = Field::new(fields[col].name(), DataType::Utf8, true);
            let new_schema: SchemaRef = Arc::new(Schema::new(fields));
            for (index, batch) in self.batches.iter_mut().enumerate() {
                let replacement = if index == batch_index {
                    Some((local, value))
                } else {
                    None
                };
                let column = to_string_column(batch.column(col), replacement)?;
                let columns: Vec<ArrayRef> = batch
                    .columns()
                    .iter()
                    .enumerate()
                    .map(|(c, arr)| {
                        if c == col {
                            column.clone()
                        } else {
                            arr.clone()
                        }
                    })
                    .collect();
                *batch = RecordBatch::try_new(new_schema.clone(), columns)?;
            }
            self.schema = new_schema;
        }
        Ok(())
    }
}

fn replace_array_value(
    arr: &ArrayRef,
    index: usize,
    value: Option<&str>,
    dtype: &DataType,
) -> Result<ArrayRef, EngineError> {
    let len = arr.len();
    match dtype {
        DataType::Utf8 => {
            let existing = arr
                .as_any()
                .downcast_ref::<StringArray>()
                .ok_or_else(|| EngineError::Internal("문자열 배열을 해석할 수 없습니다".into()))?;
            let mut builder = StringBuilder::new();
            for i in 0..len {
                if i == index {
                    match value {
                        Some(text) => builder.append_value(text),
                        None => builder.append_null(),
                    }
                } else if existing.is_null(i) {
                    builder.append_null();
                } else {
                    builder.append_value(existing.value(i));
                }
            }
            Ok(Arc::new(builder.finish()))
        }
        DataType::Int64 => {
            let existing = arr
                .as_any()
                .downcast_ref::<Int64Array>()
                .ok_or_else(|| EngineError::Internal("정수 배열을 해석할 수 없습니다".into()))?;
            let parsed = value.map(|text| text.parse::<i64>());
            let mut builder = Int64Builder::new();
            for i in 0..len {
                if i == index {
                    match parsed {
                        Some(Ok(number)) => builder.append_value(number),
                        _ => builder.append_null(),
                    }
                } else if existing.is_null(i) {
                    builder.append_null();
                } else {
                    builder.append_value(existing.value(i));
                }
            }
            Ok(Arc::new(builder.finish()))
        }
        DataType::Float64 => {
            let existing = arr
                .as_any()
                .downcast_ref::<Float64Array>()
                .ok_or_else(|| EngineError::Internal("실수 배열을 해석할 수 없습니다".into()))?;
            let parsed = value.map(|text| text.parse::<f64>());
            let mut builder = Float64Builder::new();
            for i in 0..len {
                if i == index {
                    match parsed {
                        Some(Ok(number)) => builder.append_value(number),
                        _ => builder.append_null(),
                    }
                } else if existing.is_null(i) {
                    builder.append_null();
                } else {
                    builder.append_value(existing.value(i));
                }
            }
            Ok(Arc::new(builder.finish()))
        }
        DataType::Null => Ok(Arc::new(arrow::array::NullArray::new(len))),
        other => Err(EngineError::Internal(format!(
            "지원하지 않는 컬럼 타입입니다: {other}"
        ))),
    }
}

fn to_string_column(
    arr: &ArrayRef,
    replace: Option<(usize, Option<&str>)>,
) -> Result<ArrayRef, EngineError> {
    let len = arr.len();
    let mut builder = StringBuilder::new();
    for i in 0..len {
        if let Some((index, value)) = replace {
            if i == index {
                match value {
                    Some(text) => {
                        builder.append_value(text);
                        continue;
                    }
                    None => {
                        builder.append_null();
                        continue;
                    }
                }
            }
        }
        if arr.is_null(i) {
            builder.append_null();
            continue;
        }
        if let Some(a) = arr.as_any().downcast_ref::<Int64Array>() {
            builder.append_value(a.value(i).to_string());
        } else if let Some(a) = arr.as_any().downcast_ref::<Float64Array>() {
            builder.append_value(a.value(i).to_string());
        } else if let Some(a) = arr.as_any().downcast_ref::<StringArray>() {
            builder.append_value(a.value(i));
        } else {
            builder.append_null();
        }
    }
    Ok(Arc::new(builder.finish()))
}

fn array_value(arr: &ArrayRef, i: usize) -> Value {
    if arr.is_null(i) {
        return Value::Null;
    }
    if let Some(a) = arr.as_any().downcast_ref::<Int64Array>() {
        return Value::from(a.value(i));
    }
    if let Some(a) = arr.as_any().downcast_ref::<Float64Array>() {
        return Value::from(a.value(i));
    }
    if let Some(a) = arr.as_any().downcast_ref::<StringArray>() {
        return Value::from(a.value(i));
    }
    Value::Null
}

pub struct SqliteInner {
    conn: Arc<Mutex<Connection>>,
    interrupt: rusqlite::InterruptHandle,
    path: Option<PathBuf>,
    demo: bool,
    log: SqlLog,
}

impl SqliteInner {
    fn new(conn: Connection, path: Option<PathBuf>, demo: bool, log: SqlLog) -> Self {
        let interrupt = conn.get_interrupt_handle();
        Self {
            conn: Arc::new(Mutex::new(conn)),
            interrupt,
            path,
            demo,
            log,
        }
    }
}

/// A locked SQLite connection that logs every statement before running it.
/// It deliberately has no way to reach the bare connection.
struct SqliteConn<'a> {
    conn: std::sync::MutexGuard<'a, Connection>,
    log: &'a SqlLog,
}

impl SqliteConn<'_> {
    fn note(&self, sql: &str, params: &[&dyn rusqlite::ToSql]) {
        if params.is_empty() {
            self.log.record(sql, Dialect::Sqlite);
        } else {
            let shown = inline_params(sql, &sqlite_params(params), Dialect::Sqlite);
            self.log.record(&shown, Dialect::Sqlite);
        }
    }

    /// Prepares a statement that runs without parameters.
    fn prepare(&self, sql: &str) -> rusqlite::Result<rusqlite::Statement<'_>> {
        self.log.record(sql, Dialect::Sqlite);
        self.conn.prepare(sql)
    }

    /// Prepares a statement the caller runs with exactly `params`.
    fn prepare_bound(
        &self,
        sql: &str,
        params: &[&dyn rusqlite::ToSql],
    ) -> rusqlite::Result<rusqlite::Statement<'_>> {
        self.note(sql, params);
        self.conn.prepare(sql)
    }

    fn query_row<T, F>(
        &self,
        sql: &str,
        params: &[&dyn rusqlite::ToSql],
        f: F,
    ) -> rusqlite::Result<T>
    where
        F: FnOnce(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
    {
        self.note(sql, params);
        self.conn.query_row(sql, params, f)
    }

    fn execute_batch(&self, sql: &str) -> rusqlite::Result<()> {
        self.log.record(sql, Dialect::Sqlite);
        self.conn.execute_batch(sql)
    }

    /// Runs a data change made from the GUI; one that changed rows goes to
    /// History, at COMMIT when a transaction is open.
    fn change(&self, sql: &str, params: &[&dyn rusqlite::ToSql]) -> rusqlite::Result<usize> {
        let shown = inline_params(sql, &sqlite_params(params), Dialect::Sqlite);
        self.log.record(&shown, Dialect::Sqlite);
        let started = Instant::now();
        let changed = self.conn.execute(sql, params)?;
        if changed > 0 {
            let change = Change {
                sql: shown,
                ms: started.elapsed().as_millis() as u64,
                rows: changed as u64,
            };
            self.log.changed(change, !self.conn.is_autocommit());
        }
        Ok(changed)
    }

    fn is_autocommit(&self) -> bool {
        self.conn.is_autocommit()
    }
}

fn sqlite_params(params: &[&dyn rusqlite::ToSql]) -> Vec<LogParam> {
    use rusqlite::types::ToSqlOutput;
    params
        .iter()
        .map(|param| match param.to_sql() {
            Ok(ToSqlOutput::Borrowed(value)) => value_ref_param(value),
            Ok(ToSqlOutput::Owned(value)) => value_ref_param((&value).into()),
            _ => LogParam::Null,
        })
        .collect()
}

fn value_ref_param(value: ValueRef<'_>) -> LogParam {
    match value {
        ValueRef::Null => LogParam::Null,
        ValueRef::Integer(number) => LogParam::Int(number),
        ValueRef::Real(number) => LogParam::Float(number),
        ValueRef::Text(bytes) => LogParam::Text(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Blob(bytes) => LogParam::Blob(bytes.to_vec()),
    }
}

/// 엔진: 연결 하나를 맡은 드라이버를 들고, 데이터베이스 전환 때 드라이버를
/// 바꿔 끼운다. 쿼리는 컬럼형(Arrow) 결과로 반환되며, 긴 쿼리는 취소를 지원한다.
struct EpochBump<'a>(&'a AtomicU64);

impl Drop for EpochBump<'_> {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

// Cancel requests on their way: PostgreSQL's, MySQL's and SQL Server's go
// over a connection of their own and land a moment after they're sent.
#[derive(Default)]
struct CancelsInFlight {
    count: AtomicUsize,
    landed: tokio::sync::Notify,
    // PostgreSQL's request is done once written; the server signals the
    // statement a moment later. Until then a new statement could take it.
    quiet_until: Mutex<Option<Instant>>,
}

pub struct Engine {
    driver: RwLock<Arc<dyn Driver>>,
    // The driver a statement runs on now: a cancel goes there even if the
    // driver was swapped meanwhile.
    active: Mutex<Option<Arc<dyn Driver>>>,
    cancels: Arc<CancelsInFlight>,
    // Bumped by every statement and driver swap: anything derived from the
    // schema (table counts, …) is only known current while this hasn't moved.
    epoch: AtomicU64,
    // Every statement sent, across driver swaps (a database switch keeps it).
    log: SqlLog,
}

/// The document side of the connection open now, held for one operation.
/// Like a query, the operation moves the epoch before and after it runs:
/// collections may come and go.
pub struct DocumentSession<'a> {
    driver: Arc<dyn Driver>,
    _finished: EpochBump<'a>,
}

impl DocumentSession<'_> {
    pub fn ops(&self) -> &dyn DocumentDriver {
        self.driver
            .document()
            .expect("checked when the session was made")
    }
}

/// The SQL side of `driver`, or the error a SQL operation meets on an engine
/// of another paradigm.
fn sql_of(driver: &Arc<dyn Driver>) -> Result<&dyn SqlDriver, EngineError> {
    driver.sql().ok_or_else(|| {
        EngineError::Unsupported(format!(
            "{}에서는 SQL을 실행할 수 없습니다",
            registry::label(driver.id())
        ))
    })
}

impl Engine {
    pub fn open_demo(rows: usize) -> Result<Self, EngineError> {
        let log = SqlLog::new();
        let inner = build_demo_inner(rows, log.clone())?;
        Ok(Self::from_driver(SqliteDriver::open(inner), log))
    }

    pub fn open_file(path: &Path) -> Result<Self, EngineError> {
        let log = SqlLog::new();
        let inner = open_file_inner(path, log.clone())?;
        Ok(Self::from_driver(SqliteDriver::open(inner), log))
    }

    fn from_driver(driver: Arc<dyn Driver>, log: SqlLog) -> Self {
        Self {
            driver: RwLock::new(driver),
            active: Mutex::new(None),
            cancels: Arc::new(CancelsInFlight::default()),
            epoch: AtomicU64::new(0),
            log,
        }
    }

    /// Changes whenever a statement runs or the driver is replaced.
    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    /// The console log of every statement this engine sent.
    pub fn sql_log(&self) -> &SqlLog {
        &self.log
    }

    /// Hands a statement the GUI ran with History asked for to History once
    /// it is durable: now, or when the open transaction commits.
    pub async fn file_change(&self, change: Change) {
        let in_tx = self.in_tx().await.unwrap_or(false);
        self.log.changed(change, in_tx);
    }

    async fn replace_driver(&self, driver: Arc<dyn Driver>) -> Result<(), EngineError> {
        let old = {
            let mut guard = self
                .driver
                .write()
                .map_err(|_| EngineError::Internal("백엔드 잠금 실패".into()))?;
            std::mem::replace(&mut *guard, driver)
        };
        // The old connection's open transaction goes with it.
        self.log.settle(false);
        self.epoch.fetch_add(1, Ordering::SeqCst);
        old.close().await;
        Ok(())
    }

    fn driver(&self) -> Result<Arc<dyn Driver>, EngineError> {
        self.driver
            .read()
            .map(|guard| guard.clone())
            .map_err(|_| EngineError::Internal("백엔드 잠금 실패".into()))
    }

    /// The id of the engine connected now ("postgres", "sqlite", …).
    pub fn engine_id(&self) -> Result<&'static str, EngineError> {
        Ok(self.driver()?.id())
    }

    /// What the connection open now can do.
    pub fn capabilities(&self) -> Result<Capabilities, EngineError> {
        Ok(self.driver()?.capabilities())
    }

    /// The file behind a file engine; None for the in-memory demo and for
    /// server databases.
    pub fn file(&self) -> Option<PathBuf> {
        self.driver().ok().and_then(|driver| driver.file())
    }

    pub async fn swap_to_file(&self, path: &Path) -> Result<EngineMeta, EngineError> {
        let inner = open_file_inner(path, self.log.clone())?;
        self.swap(SqliteDriver::open(inner)).await
    }

    pub async fn swap_to_demo(&self, rows: usize) -> Result<EngineMeta, EngineError> {
        let log = self.log.clone();
        let inner = tokio::task::spawn_blocking(move || build_demo_inner(rows, log))
            .await
            .map_err(|e| EngineError::Internal(e.to_string()))??;
        self.swap(SqliteDriver::open(inner)).await
    }

    /// Connects with `factory`'s engine and, once that worked, works on the
    /// new connection instead of the current one.
    pub async fn swap_to(
        &self,
        factory: &dyn DriverFactory,
        config: &ConnConfig,
        net: &NetRoute,
    ) -> Result<EngineMeta, EngineError> {
        let driver = factory.connect(config, net, self.log.clone()).await?;
        self.swap(driver).await
    }

    async fn swap(&self, driver: Arc<dyn Driver>) -> Result<EngineMeta, EngineError> {
        let meta = with_capabilities(&driver, driver.meta(false).await?);
        self.replace_driver(driver).await?;
        Ok(meta)
    }

    pub async fn meta(&self, include_system: bool) -> Result<EngineMeta, EngineError> {
        let driver = self.driver()?;
        let meta = driver.meta(include_system).await?;
        Ok(with_capabilities(&driver, meta))
    }

    pub async fn schema(&self, include_system: bool) -> Result<Vec<TableSchema>, EngineError> {
        let driver = self.driver()?;
        sql_of(&driver)?.schema(include_system).await
    }

    /// Every foreign key between the tables the schema list shows, in one call.
    pub async fn relations(&self, include_system: bool) -> Result<Vec<Relation>, EngineError> {
        let driver = self.driver()?;
        sql_of(&driver)?.relations(include_system).await
    }

    pub async fn table_count(&self, name: &str) -> Result<i64, EngineError> {
        let driver = self.driver()?;
        sql_of(&driver)?.table_count(name).await
    }

    pub async fn databases(&self) -> Result<Vec<String>, EngineError> {
        let driver = self.driver()?;
        sql_of(&driver)?.databases().await
    }

    pub async fn query(&self, sql: &str, max_rows: usize) -> Result<QueryData, EngineError> {
        // Before and after: meta read while the statement runs is stale once
        // it finishes, even if the query future is dropped midway.
        self.epoch.fetch_add(1, Ordering::SeqCst);
        let _finished = EpochBump(&self.epoch);
        let driver = self.driver()?;
        let sql_driver = sql_of(&driver)?;
        if let Ok(mut active) = self.active.lock() {
            *active = Some(driver.clone());
        }
        let result = sql_driver.query(sql, max_rows).await;
        if let Ok(mut active) = self.active.lock() {
            *active = None;
        }
        result
    }

    /// The document operations of the connection open now, or the error an
    /// engine of another paradigm gives.
    pub fn document(&self) -> Result<DocumentSession<'_>, EngineError> {
        let driver = self.driver()?;
        if driver.document().is_none() {
            return Err(EngineError::Unsupported(format!(
                "{}에서는 문서 작업을 할 수 없습니다",
                registry::label(driver.id())
            )));
        }
        self.epoch.fetch_add(1, Ordering::SeqCst);
        Ok(DocumentSession {
            driver,
            _finished: EpochBump(&self.epoch),
        })
    }

    pub async fn execute(&self, sql: &str, max_rows: usize) -> Result<QueryResult, EngineError> {
        let data = self.query(sql, max_rows).await?;
        Ok(QueryResult {
            columns: data.columns.clone(),
            row_count: data.row_count,
            rows: data.rows_json(),
            elapsed_ms: data.elapsed_ms,
            truncated: data.truncated,
        })
    }

    pub fn cancel(&self) {
        // The driver running a statement now, else the current one.
        let target = self
            .active
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
            .or_else(|| self.driver.read().ok().map(|guard| guard.clone()));
        let Some(target) = target else {
            return;
        };
        let CancelRequest::Sent {
            request,
            lands_later,
        } = target.cancel()
        else {
            return;
        };
        let cancels = self.cancels.clone();
        cancels.count.fetch_add(1, Ordering::SeqCst);
        let sent = Instant::now();
        tokio::spawn(async move {
            let _ = request.await;
            if lands_later {
                // As long again as sending took (a round trip or more), so
                // the server has had the time to act on it.
                let until = Instant::now() + sent.elapsed().max(Duration::from_millis(50));
                if let Ok(mut quiet) = cancels.quiet_until.lock() {
                    if quiet.is_none_or(|at| at < until) {
                        *quiet = Some(until);
                    }
                }
            }
            cancels.count.fetch_sub(1, Ordering::SeqCst);
            cancels.landed.notify_waiters();
        });
    }

    /// Waits, at most `limit`, for cancel requests already sent to land: one
    /// meant for the statement before would otherwise stop the next one, if
    /// that started first (PostgreSQL and MySQL cancel whatever is running
    /// when the request arrives).
    pub async fn cancels_settled(&self, limit: Duration) {
        let settled = async {
            loop {
                // Made before the count is read, so a landing in between isn't missed.
                let landed = self.cancels.landed.notified();
                if self.cancels.count.load(Ordering::SeqCst) == 0 {
                    break;
                }
                landed.await;
            }
            let quiet = self
                .cancels
                .quiet_until
                .lock()
                .ok()
                .and_then(|quiet| *quiet);
            if let Some(until) = quiet {
                tokio::time::sleep_until(tokio::time::Instant::from_std(until)).await;
            }
        };
        let _ = tokio::time::timeout(limit, settled).await;
    }

    /// A statement that fails inside a transaction aborts all of it until a
    /// ROLLBACK (TO SAVEPOINT), as on PostgreSQL and CockroachDB.
    pub fn failure_aborts_transaction(&self) -> bool {
        self.driver().ok().is_some_and(|driver| {
            driver
                .sql()
                .is_some_and(|sql| sql.failure_aborts_transaction())
        })
    }

    pub async fn edit(&self, target: &EditTarget) -> Result<u64, EngineError> {
        let driver = self.driver()?;
        sql_of(&driver)?.edit(target).await
    }

    pub async fn insert_row(
        &self,
        table: &str,
        values: &[(String, Option<String>)],
    ) -> Result<u64, EngineError> {
        let values: Vec<InsertValue> = values
            .iter()
            .map(|(column, value)| InsertValue {
                column: column.clone(),
                value: value.clone(),
                expr: None,
            })
            .collect();
        self.insert_values(table, &values).await
    }

    /// A new row whose columns may also be expressions. A column set to
    /// DEFAULT is left out of the INSERT, which every database (SQLite too,
    /// which has no DEFAULT in VALUES) reads as its default.
    pub async fn insert_values(
        &self,
        table: &str,
        values: &[InsertValue],
    ) -> Result<u64, EngineError> {
        let values: Vec<InsertValue> = values
            .iter()
            .filter(|value| value.expr != Some(ValueExpr::Default))
            .cloned()
            .collect();
        let driver = self.driver()?;
        sql_of(&driver)?.insert_row(table, &values).await
    }

    pub async fn delete_row(&self, table: &str, pk: &[PkValue]) -> Result<u64, EngineError> {
        let driver = self.driver()?;
        sql_of(&driver)?.delete_row(table, pk).await
    }

    pub async fn table_detail(&self, name: &str) -> Result<TableDetail, EngineError> {
        let driver = self.driver()?;
        sql_of(&driver)?.table_detail(name).await
    }

    pub async fn server_info(&self) -> Result<ServerInfo, EngineError> {
        self.driver()?.server_info().await
    }

    pub async fn objects(&self, include_system: bool) -> Result<DbObjects, EngineError> {
        let driver = self.driver()?;
        sql_of(&driver)?.objects(include_system).await
    }

    pub async fn object_definition(
        &self,
        kind: &str,
        name: &str,
    ) -> Result<Option<ObjectDefinition>, EngineError> {
        let driver = self.driver()?;
        sql_of(&driver)?.object_definition(kind, name).await
    }

    pub async fn kill_session(&self, id: &str) -> Result<(), EngineError> {
        let numeric: u64 = id
            .trim()
            .parse()
            .map_err(|_| EngineError::BadRequest("세션 ID가 올바르지 않습니다".into()))?;
        let driver = self.driver()?;
        sql_of(&driver)?.kill_session(numeric).await
    }

    pub async fn begin_tx(&self) -> Result<(), EngineError> {
        self.tx(TxOp::Begin).await
    }

    pub async fn commit_tx(&self) -> Result<(), EngineError> {
        self.tx(TxOp::Commit).await
    }

    pub async fn rollback_tx(&self) -> Result<(), EngineError> {
        self.tx(TxOp::Rollback).await
    }

    /// Whether a transaction is open; never on an engine without SQL.
    pub async fn in_tx(&self) -> Result<bool, EngineError> {
        let driver = self.driver()?;
        match driver.sql() {
            Some(sql) => sql.in_tx().await,
            None => Ok(false),
        }
    }

    async fn tx(&self, op: TxOp) -> Result<(), EngineError> {
        let driver = self.driver()?;
        sql_of(&driver)?.tx(op).await
    }
}

/// `meta` with what `driver` can do filled in.
fn with_capabilities(driver: &Arc<dyn Driver>, mut meta: EngineMeta) -> EngineMeta {
    meta.capabilities = Some(driver.capabilities());
    meta
}

fn lock_conn(inner: &SqliteInner) -> Result<SqliteConn<'_>, EngineError> {
    let conn = inner
        .conn
        .lock()
        .map_err(|_| EngineError::Internal("커넥션 잠금 실패".into()))?;
    Ok(SqliteConn {
        conn,
        log: &inner.log,
    })
}

// The demo's own seeding is not logged: it builds the fixture (also the
// placeholder engine a server connection starts from), not a statement the
// user's work sent.
fn build_demo_inner(rows: usize, log: SqlLog) -> Result<Arc<SqliteInner>, EngineError> {
    let conn = Connection::open_in_memory()?;
    seed_demo(&conn, rows)?;
    Ok(Arc::new(SqliteInner::new(conn, None, true, log)))
}

fn open_file_inner(path: &Path, log: SqlLog) -> Result<Arc<SqliteInner>, EngineError> {
    if !path.is_file() {
        return Err(EngineError::NotFound(path.display().to_string()));
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    const CHECK_SQL: &str = "SELECT count(*) FROM sqlite_master";
    log.record(CHECK_SQL, Dialect::Sqlite);
    let valid = conn.query_row(CHECK_SQL, [], |_| Ok(())).is_ok();
    if !valid {
        return Err(EngineError::NotAFile(path.display().to_string()));
    }
    Ok(Arc::new(SqliteInner::new(
        conn,
        Some(path.to_path_buf()),
        false,
        log,
    )))
}

fn seed_demo(conn: &Connection, rows: usize) -> Result<(), EngineError> {
    let rows = rows.clamp(1, 2_000_000) as i64;
    conn.execute_batch(
        "CREATE TABLE demo(id INTEGER PRIMARY KEY, name TEXT, email TEXT, created_at TEXT, amount REAL)",
    )?;
    conn.execute(
        r#"WITH RECURSIVE seq(i) AS (
               SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ?1
           )
           INSERT INTO demo(id, name, email, created_at, amount)
           SELECT i,
                  'user_' || i,
                  'user' || i || '@example.com',
                  datetime('now', '-' || i || ' minutes'),
                  (i * i) % 100000 / 100.0
           FROM seq"#,
        [rows],
    )?;
    Ok(())
}

fn sqlite_table_names(
    conn: &SqliteConn<'_>,
    include_system: bool,
) -> Result<Vec<String>, EngineError> {
    let sql = if include_system {
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    } else {
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    };
    let mut stmt = conn.prepare(sql)?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(names)
}

fn meta_sync(inner: &SqliteInner, include_system: bool) -> Result<EngineMeta, EngineError> {
    let conn = lock_conn(inner)?;
    let tables = sqlite_table_names(&conn, include_system)?;
    Ok(EngineMeta {
        kind: "sqlite".into(),
        path: inner.path.as_ref().map(|p| p.display().to_string()),
        demo: inner.demo,
        tables,
        capabilities: None,
    })
}

fn schema_sync(inner: &SqliteInner, include_system: bool) -> Result<Vec<TableSchema>, EngineError> {
    let conn = lock_conn(inner)?;
    let names = sqlite_table_names(&conn, include_system)?;

    let mut tables = Vec::with_capacity(names.len());
    for name in names {
        let mut col_stmt = conn.prepare(&format!("PRAGMA table_info({})", quote_ident(&name)))?;
        let columns = col_stmt
            .query_map([], |row| {
                Ok(ColumnSchema {
                    name: row.get(1)?,
                    decl_type: row.get(2)?,
                    not_null: row.get::<_, i64>(3)? != 0,
                    pk: row.get::<_, i64>(5)? > 0,
                    default: row.get(4)?,
                    enum_values: None,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        tables.push(TableSchema { name, columns });
    }
    Ok(tables)
}

fn relations_sync(inner: &SqliteInner, include_system: bool) -> Result<Vec<Relation>, EngineError> {
    let conn = lock_conn(inner)?;
    let names = sqlite_table_names(&conn, include_system)?;

    const FK_SQL: &str = "SELECT id, \"table\", \"from\", \"to\" \
         FROM pragma_foreign_key_list(?1) ORDER BY id, seq";
    let mut relations = Vec::new();
    for table in names {
        let mut fk_stmt = conn.prepare_bound(FK_SQL, &[&table])?;
        let steps = fk_stmt
            .query_map([&table], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let first = relations.len();
        let mut current: Option<i64> = None;
        for (id, ref_table, column, ref_column) in steps {
            if current != Some(id) {
                current = Some(id);
                relations.push(Relation {
                    table: table.clone(),
                    columns: Vec::new(),
                    ref_table,
                    ref_columns: Vec::new(),
                });
            }
            if let Some(relation) = relations.last_mut() {
                relation.columns.push(column);
                relation.ref_columns.extend(ref_column);
            }
        }
        // `REFERENCES parent` without a column list points at the parent's
        // primary key, which the pragma leaves blank.
        for relation in &mut relations[first..] {
            if relation.ref_columns.is_empty() {
                relation.ref_columns = sqlite_pk_columns(&conn, &relation.ref_table)?;
            }
        }
    }
    Ok(relations)
}

fn sqlite_pk_columns(conn: &SqliteConn<'_>, table: &str) -> Result<Vec<String>, EngineError> {
    const PK_SQL: &str = "SELECT name FROM pragma_table_info(?1) WHERE pk > 0 ORDER BY pk";
    let mut stmt = conn.prepare_bound(PK_SQL, &[&table])?;
    let columns = stmt
        .query_map([table], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(columns)
}

fn table_count_sync(inner: &SqliteInner, name: &str) -> Result<i64, EngineError> {
    let conn = lock_conn(inner)?;
    let trimmed = name.trim_matches(|c| matches!(c, '"' | '\'' | '`' | '[' | ']'));
    let count: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM {}", quote_ident(trimmed)),
        &[],
        |row| row.get(0),
    )?;
    Ok(count)
}

fn run_query_sync(
    inner: &SqliteInner,
    sql: &str,
    max_rows: usize,
) -> Result<QueryData, EngineError> {
    let started = Instant::now();
    let conn = lock_conn(inner)?;
    let was_in_tx = !conn.is_autocommit();
    // changes() keeps the last INSERT/UPDATE/DELETE's count through other
    // statements; an unchanged total says this one (DDL, say) changed none.
    let total_before = conn.conn.total_changes();

    let mut stmt = conn.prepare(sql)?;
    let columns: Vec<String> = stmt
        .column_names()
        .into_iter()
        .map(str::to_string)
        .collect();
    let col_count = columns.len();
    let mut column_values: Vec<Vec<Value>> = vec![Vec::new(); col_count];
    let mut count = 0usize;
    let mut truncated = false;

    {
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            if count >= max_rows {
                truncated = true;
                break;
            }
            for (i, values) in column_values.iter_mut().enumerate() {
                values.push(value_ref_to_json(row.get_ref(i)?));
            }
            count += 1;
        }
    }
    drop(stmt);
    let rows_affected = (col_count == 0).then(|| {
        if conn.conn.total_changes() == total_before {
            0
        } else {
            conn.conn.changes()
        }
    });
    // A transaction the editor ended (COMMIT, ROLLBACK) settles the GUI
    // changes made inside it; changes still held outside any transaction
    // belong to one an error rolled back.
    if conn.is_autocommit() && (was_in_tx || conn.log.has_pending()) {
        let keyword = sql
            .trim_start()
            .split(|c: char| !c.is_ascii_alphabetic())
            .next()
            .unwrap_or("")
            .to_ascii_uppercase();
        let committed = was_in_tx && matches!(keyword.as_str(), "COMMIT" | "END" | "RELEASE");
        conn.log.ended(committed);
    }

    let (schema, batches) = build_arrow(&columns, column_values, count)?;
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    let (source_table, pk) = detect_source(&conn, sql, &columns);

    Ok(QueryData {
        kind: "sqlite",
        columns,
        schema,
        batches,
        row_count: count,
        elapsed_ms,
        truncated,
        source_table,
        pk,
        // A BOOLEAN column's 1 and 0 show as booleans once the table's
        // structure is known; the result alone doesn't say.
        column_kinds: Vec::new(),
        rows_affected,
    })
}

fn build_arrow(
    columns: &[String],
    column_values: Vec<Vec<Value>>,
    row_count: usize,
) -> Result<(SchemaRef, Vec<RecordBatch>), EngineError> {
    if columns.is_empty() {
        return Ok((Arc::new(Schema::empty()), Vec::new()));
    }

    let mut fields = Vec::with_capacity(columns.len());
    let mut arrays: Vec<ArrayRef> = Vec::with_capacity(columns.len());
    for (name, values) in columns.iter().zip(column_values) {
        let (dtype, array) = build_column(values);
        fields.push(Field::new(name, dtype, true));
        arrays.push(array);
    }
    let schema = Arc::new(Schema::new(fields));

    let mut batches = Vec::new();
    let mut offset = 0usize;
    while offset < row_count {
        let len = BATCH_CHUNK.min(row_count - offset);
        let sliced: Vec<ArrayRef> = arrays.iter().map(|a| a.slice(offset, len)).collect();
        batches.push(RecordBatch::try_new(schema.clone(), sliced)?);
        offset += len;
    }
    Ok((schema, batches))
}

fn build_column(values: Vec<Value>) -> (DataType, ArrayRef) {
    let mut has_string = false;
    let mut has_float = false;
    let mut all_null = true;

    for v in &values {
        match v {
            Value::Null => {}
            Value::Number(n) => {
                all_null = false;
                if n.is_f64() {
                    has_float = true;
                }
            }
            _ => {
                all_null = false;
                has_string = true;
            }
        }
    }

    if all_null || has_string {
        let mut builder = StringBuilder::new();
        for v in &values {
            match v {
                Value::Null => builder.append_null(),
                Value::String(s) => builder.append_value(s),
                other => builder.append_value(other.to_string()),
            }
        }
        (DataType::Utf8, Arc::new(builder.finish()))
    } else if has_float {
        let mut builder = Float64Builder::new();
        for v in &values {
            match v {
                Value::Number(n) => builder.append_value(n.as_f64().unwrap_or(f64::NAN)),
                _ => builder.append_null(),
            }
        }
        (DataType::Float64, Arc::new(builder.finish()))
    } else {
        let mut builder = Int64Builder::new();
        for v in &values {
            match v {
                Value::Number(n) => builder.append_value(n.as_i64().unwrap_or_default()),
                _ => builder.append_null(),
            }
        }
        (DataType::Int64, Arc::new(builder.finish()))
    }
}

fn detect_source(
    conn: &SqliteConn<'_>,
    sql: &str,
    columns: &[String],
) -> (Option<String>, Option<Vec<String>>) {
    let lower = sql.to_lowercase();
    let trimmed = lower.trim_start();
    if !(trimmed.starts_with("select") || trimmed.starts_with("with")) {
        return (None, None);
    }
    if lower.contains(" join ") {
        return (None, None);
    }
    let Some(pos) = lower.find(" from ") else {
        return (None, None);
    };
    let rest = &sql[pos + 6..];
    let token: String = rest
        .trim_start()
        .chars()
        .take_while(|c| !c.is_whitespace() && !matches!(c, ';' | ',' | '(' | ')'))
        .collect();
    if token.is_empty() || token.starts_with('(') {
        return (None, None);
    }
    let name = token
        .trim_matches(|c| matches!(c, '"' | '\'' | '`' | '[' | ']'))
        .to_string();
    if name.is_empty() || name.contains('.') {
        return (None, None);
    }

    let exists = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            &[&name],
            |row| row.get::<_, i64>(0),
        )
        .map(|c| c > 0)
        .unwrap_or(false);
    if !exists {
        return (None, None);
    }

    let mut pk_indexed: Vec<(i64, String)> = Vec::new();
    if let Ok(mut stmt) = conn.prepare(&format!("PRAGMA table_info({})", quote_ident(&name))) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(5)?, row.get::<_, String>(1)?))
        }) {
            for row in rows.flatten() {
                if row.0 > 0 {
                    pk_indexed.push(row);
                }
            }
        }
    }
    if pk_indexed.is_empty() {
        return (Some(name), None);
    }
    pk_indexed.sort_by_key(|(i, _)| *i);
    let pk_names: Vec<String> = pk_indexed.into_iter().map(|(_, n)| n).collect();
    let columns_lower: Vec<String> = columns.iter().map(|c| c.to_lowercase()).collect();
    let all_present = pk_names
        .iter()
        .all(|p| columns_lower.contains(&p.to_lowercase()));
    if !all_present {
        return (Some(name), None);
    }
    (Some(name), Some(pk_names))
}

fn edit_sync(inner: &SqliteInner, target: &EditTarget) -> Result<u64, EngineError> {
    if target.pk.is_empty() {
        return Err(EngineError::NotEditable(
            "기본 키가 없어 편집할 수 없습니다".into(),
        ));
    }
    let conn = lock_conn(inner)?;
    let mut params: Vec<rusqlite::types::Value> = Vec::with_capacity(target.pk.len() + 1);
    let value_sql = match target.expr {
        Some(ValueExpr::Now) => SQLITE_NOW.to_string(),
        Some(ValueExpr::Default) => {
            sqlite_default_sql(sqlite_column_default(&conn, &target.table, &target.column)?)?
        }
        None => {
            params.push(match &target.value {
                Some(s) => sqlite_bound(&conn, target, s)?,
                None => rusqlite::types::Value::Null,
            });
            "?1".to_string()
        }
    };
    let mut sql = format!(
        "UPDATE {} SET {} = {value_sql} WHERE ",
        quote_ident(&target.table),
        quote_ident(&target.column)
    );
    for (i, pk) in target.pk.iter().enumerate() {
        if i > 0 {
            sql.push_str(" AND ");
        }
        params.push(sqlite_key(&conn, &target.table, pk)?);
        sql.push_str(&format!("{} = ?{}", quote_ident(&pk.column), params.len()));
    }

    let changed = conn.change(&sql, &sqlite_refs(&params))?;
    Ok(changed as u64)
}

// SQLite's NOW(): the current UTC time as its date functions write it.
const SQLITE_NOW: &str = "CURRENT_TIMESTAMP";

// SQLite has no `SET col = DEFAULT`, so DEFAULT writes the column's default
// as the schema declares it: SQLite's own text from CREATE TABLE, which it
// limits to a constant expression, never anything from the client. A column
// without one defaults to NULL, as an INSERT leaving it out would.
fn sqlite_default_sql(declared: Option<String>) -> Result<String, EngineError> {
    let Some(expr) = declared else {
        return Ok("NULL".into());
    };
    // `DEFAULT active`, `DEFAULT "x"`, `[x]` and `` `x` `` are strings in
    // CREATE TABLE, but in an UPDATE they would name a column: written as
    // the string they are.
    if let Some(text) = sqlite_default_name(expr.trim()) {
        return Ok(format!("'{}'", text.replace('\'', "''")));
    }
    // A hand-edited schema could hold one; it would take this statement's own.
    if has_bind_parameter(&expr) {
        return Err(EngineError::BadRequest(
            "기본값에 바인드 매개변수가 있어 DEFAULT로 쓸 수 없습니다".into(),
        ));
    }
    // pragma_table_info drops the outer parentheses but keeps a trailing
    // `-- comment`, which would swallow the closing one: it ends a line here.
    Ok(if expr.contains("--") {
        format!("({expr}\n)")
    } else {
        format!("({expr})")
    })
}

// Bare words SQLite reads in a DEFAULT as values, not as strings.
const SQLITE_DEFAULT_WORDS: [&str; 6] = [
    "null",
    "true",
    "false",
    "current_time",
    "current_date",
    "current_timestamp",
];

// The text of a default spelled as one name: a bare word, "…" or `…` with
// their quotes doubled inside, or […].
fn sqlite_default_name(expr: &str) -> Option<String> {
    for quote in ['"', '`'] {
        if let Some(inner) = expr
            .strip_prefix(quote)
            .and_then(|rest| rest.strip_suffix(quote))
        {
            let doubled = format!("{quote}{quote}");
            if inner.replace(&doubled, "").contains(quote) {
                return None;
            }
            return Some(inner.replace(&doubled, &quote.to_string()));
        }
    }
    if let Some(inner) = expr
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
    {
        return (!inner.contains(']')).then(|| inner.to_string());
    }
    let mut chars = expr.chars();
    let first = chars.next()?;
    let bare = (first.is_ascii_alphabetic() || first == '_' || !first.is_ascii())
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '$' || !ch.is_ascii());
    (bare && !SQLITE_DEFAULT_WORDS.contains(&expr.to_ascii_lowercase().as_str()))
        .then(|| expr.to_string())
}

// Whether an expression holds a bind parameter (`?`, `?1`, `:x`, `@x`, `$x`)
// outside its strings, quoted names and comments. Unclosed ones count.
fn has_bind_parameter(sql: &str) -> bool {
    let chars: Vec<char> = sql.chars().collect();
    let word = |ch: char| ch.is_ascii_alphanumeric() || ch == '_' || ch == '$' || !ch.is_ascii();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        let close = match ch {
            '\'' | '"' | '`' => Some(ch),
            '[' => Some(']'),
            _ => None,
        };
        if let Some(close) = close {
            match chars[i + 1..].iter().position(|&c| c == close) {
                // A doubled quote is two strings side by side.
                Some(offset) => i += offset + 2,
                None => return true,
            }
            continue;
        }
        if ch == '-' && chars.get(i + 1) == Some(&'-') {
            match chars[i..].iter().position(|&c| c == '\n') {
                Some(offset) => i += offset + 1,
                None => return false,
            }
            continue;
        }
        if ch == '/' && chars.get(i + 1) == Some(&'*') {
            match chars[i + 2..]
                .windows(2)
                .position(|pair| pair == ['*', '/'])
            {
                Some(offset) => i += offset + 4,
                None => return true,
            }
            continue;
        }
        let starts_name = chars
            .get(i + 1)
            .is_some_and(|&next| word(next) && next != '$');
        let after_word = i > 0 && word(chars[i - 1]);
        if ch == '?' || (matches!(ch, ':' | '@' | '$') && starts_name && !after_word) {
            return true;
        }
        i += 1;
    }
    false
}

/// Whether a column is declared binary: its type names BLOB, as SQLite's own
/// affinity rule reads it, or is another engine's binary type, as the grid
/// takes it.
fn sqlite_blob_column(
    conn: &SqliteConn<'_>,
    table: &str,
    column: &str,
) -> Result<bool, EngineError> {
    use rusqlite::OptionalExtension;
    let declared = conn
        .query_row(
            "SELECT type FROM pragma_table_info(?1) WHERE name = ?2 COLLATE NOCASE",
            &[&table as &dyn rusqlite::ToSql, &column],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    Ok(declared.is_some_and(|kind| binary_type(&kind)))
}

fn binary_type(declared: &str) -> bool {
    let kind = declared.trim().to_ascii_lowercase();
    kind.contains("blob")
        || ["bytea", "bytes", "binary", "varbinary", "image"]
            .iter()
            .any(|name| {
                kind.strip_prefix(name).is_some_and(|rest| {
                    !rest.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_')
                })
            })
}

/// An edited cell's text as bound. SQLite keeps any type anywhere, so the
/// cell's own type decides: a blob, or nothing in a column declared BLOB,
/// takes hex as bytes, and refuses other text where the column is declared
/// BLOB (as every engine's binary column does); any other cell keeps text as
/// text, hex-shaped or not.
fn sqlite_bound(
    conn: &SqliteConn<'_>,
    target: &EditTarget,
    text: &str,
) -> Result<rusqlite::types::Value, EngineError> {
    let held = sqlite_cell_type(conn, target)?;
    let binary = match held.as_deref() {
        Some("blob") => true,
        Some("null") | None => false,
        Some(_) => return Ok(rusqlite::types::Value::Text(text.to_string())),
    };
    if sqlite_blob_column(conn, &target.table, &target.column)? {
        return Ok(rusqlite::types::Value::Blob(
            hex_bytes(text).ok_or_else(not_hex)?,
        ));
    }
    match shown_hex_bytes(text) {
        Some(bytes) if binary => Ok(rusqlite::types::Value::Blob(bytes)),
        _ => Ok(rusqlite::types::Value::Text(text.to_string())),
    }
}

/// The type of what the cell an edit targets holds now (`typeof`), or None
/// when no row has its key.
fn sqlite_cell_type(
    conn: &SqliteConn<'_>,
    target: &EditTarget,
) -> Result<Option<String>, EngineError> {
    use rusqlite::OptionalExtension;
    let mut sql = format!(
        "SELECT typeof({}) FROM {} WHERE ",
        quote_ident(&target.column),
        quote_ident(&target.table)
    );
    let mut params = Vec::with_capacity(target.pk.len());
    for (index, pk) in target.pk.iter().enumerate() {
        if index > 0 {
            sql.push_str(" AND ");
        }
        params.push(sqlite_key(conn, &target.table, pk)?);
        sql.push_str(&format!("{} = ?{}", quote_ident(&pk.column), params.len()));
    }
    Ok(conn
        .query_row(&sql, &sqlite_refs(&params), |row| row.get::<_, String>(0))
        .optional()?)
}

/// A key value as bound: a binary key shown as hex stands for its bytes.
fn sqlite_key(
    conn: &SqliteConn<'_>,
    table: &str,
    key: &PkValue,
) -> Result<rusqlite::types::Value, EngineError> {
    if let Value::String(text) = &key.value {
        if let Some(bytes) = shown_hex_bytes(text) {
            if sqlite_blob_column(conn, table, &key.column)? {
                return Ok(rusqlite::types::Value::Blob(bytes));
            }
        }
    }
    Ok(json_to_sql(&key.value))
}

fn sqlite_column_default(
    conn: &SqliteConn<'_>,
    table: &str,
    column: &str,
) -> Result<Option<String>, EngineError> {
    use rusqlite::OptionalExtension;
    conn.query_row(
        // Column names are matched without case, as SQLite itself does.
        "SELECT dflt_value FROM pragma_table_info(?1) WHERE name = ?2 COLLATE NOCASE",
        &[&table as &dyn rusqlite::ToSql, &column],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()?
    .ok_or_else(|| EngineError::BadRequest(format!("열을 찾을 수 없습니다: {column}")))
}

fn sqlite_refs(params: &[rusqlite::types::Value]) -> Vec<&dyn rusqlite::ToSql> {
    params
        .iter()
        .map(|param| param as &dyn rusqlite::ToSql)
        .collect()
}

fn json_to_sql(v: &Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as SqlValue;
    match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(*b as i64),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else {
                SqlValue::Real(n.as_f64().unwrap_or(f64::NAN))
            }
        }
        Value::String(s) => SqlValue::Text(s.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

fn insert_sync(
    inner: &SqliteInner,
    table: &str,
    values: &[InsertValue],
) -> Result<u64, EngineError> {
    let conn = lock_conn(inner)?;
    let changed = if values.is_empty() {
        conn.change(
            &format!("INSERT INTO {} DEFAULT VALUES", quote_ident(table)),
            &[],
        )?
    } else {
        let columns = values
            .iter()
            .map(|value| quote_ident(&value.column))
            .collect::<Vec<_>>()
            .join(", ");
        let mut params: Vec<rusqlite::types::Value> = Vec::with_capacity(values.len());
        let mut placeholders = Vec::with_capacity(values.len());
        for value in values {
            // DEFAULT never gets here (Engine::insert_values leaves it out).
            if value.expr == Some(ValueExpr::Now) {
                placeholders.push(SQLITE_NOW.to_string());
                continue;
            }
            params.push(match &value.value {
                Some(text) if sqlite_blob_column(&conn, table, &value.column)? => {
                    rusqlite::types::Value::Blob(hex_bytes(text).ok_or_else(not_hex)?)
                }
                Some(text) => rusqlite::types::Value::Text(text.clone()),
                None => rusqlite::types::Value::Null,
            });
            placeholders.push(format!("?{}", params.len()));
        }
        let sql = format!(
            "INSERT INTO {} ({columns}) VALUES ({})",
            quote_ident(table),
            placeholders.join(", ")
        );
        conn.change(&sql, &sqlite_refs(&params))?
    };
    Ok(changed as u64)
}

fn delete_sync(inner: &SqliteInner, table: &str, pk: &[PkValue]) -> Result<u64, EngineError> {
    if pk.is_empty() {
        return Err(EngineError::BadRequest("PK 조건이 필요합니다".into()));
    }
    let conn = lock_conn(inner)?;
    let mut sql = format!("DELETE FROM {} WHERE ", quote_ident(table));
    for (index, condition) in pk.iter().enumerate() {
        if index > 0 {
            sql.push_str(" AND ");
        }
        sql.push_str(&format!(
            "{} = ?{}",
            quote_ident(&condition.column),
            index + 1
        ));
    }
    let params = pk
        .iter()
        .map(|item| sqlite_key(&conn, table, item))
        .collect::<Result<Vec<_>, _>>()?;
    let changed = conn.change(&sql, &sqlite_refs(&params))?;
    Ok(changed as u64)
}

/// A SQLite partial index's predicate: what follows `WHERE` after the
/// column list's closing parenthesis in `CREATE INDEX … ON t (…) WHERE …`.
/// Quotes and nested parentheses inside the column list are skipped.
fn index_predicate(sql: &str) -> Option<String> {
    let open = sql.find('(')?;
    let mut depth = 0usize;
    let mut quote: Option<char> = None;
    let mut close = None;
    for (at, ch) in sql[open..].char_indices() {
        match quote {
            Some(end) if ch == end => quote = None,
            Some(_) => {}
            None => match ch {
                '\'' | '"' | '`' => quote = Some(ch),
                '[' => quote = Some(']'),
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        close = Some(open + at + 1);
                        break;
                    }
                }
                _ => {}
            },
        }
    }
    let rest = sql[close?..].trim_start();
    let keyword = rest.get(..5)?;
    if !keyword.eq_ignore_ascii_case("where")
        || !rest[5..].starts_with(|c: char| c.is_whitespace() || c == '(')
    {
        return None;
    }
    let predicate = rest[5..].trim().trim_end_matches(';').trim();
    (!predicate.is_empty()).then(|| predicate.to_string())
}

fn table_detail_sync(inner: &SqliteInner, name: &str) -> Result<TableDetail, EngineError> {
    let conn = lock_conn(inner)?;
    let name = name
        .trim_matches(|c| matches!(c, '"' | '\'' | '`' | '[' | ']'))
        .to_string();
    let exists: bool = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type IN ('table','view') AND name = ?1",
        &[&name],
        |row| row.get::<_, i64>(0),
    )? > 0;
    if !exists {
        return Err(EngineError::TableNotFound);
    }

    let mut columns = Vec::new();
    let mut col_stmt = conn.prepare(&format!("PRAGMA table_info({})", quote_ident(&name)))?;
    for row in col_stmt.query_map([], |row| {
        Ok(ColumnSchema {
            name: row.get(1)?,
            decl_type: row.get(2)?,
            not_null: row.get::<_, i64>(3)? != 0,
            pk: row.get::<_, i64>(5)? > 0,
            default: row.get(4)?,
            enum_values: None,
        })
    })? {
        columns.push(row?);
    }

    let mut indexes = Vec::new();
    let mut index_stmt = conn.prepare(&format!("PRAGMA index_list({})", quote_ident(&name)))?;
    let index_rows = index_stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)? != 0,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (index_name, unique, origin) in index_rows {
        let mut index_columns = Vec::new();
        if let Ok(mut info_stmt) =
            conn.prepare(&format!("PRAGMA index_info({})", quote_ident(&index_name)))
        {
            if let Ok(rows) = info_stmt.query_map([], |row| row.get::<_, Option<String>>(2)) {
                for column in rows.flatten().flatten() {
                    index_columns.push(column);
                }
            }
        }
        // The statement the index was made with; none for an automatic one
        // (a UNIQUE or PRIMARY KEY constraint's).
        let definition: Option<String> = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?1",
                &[&index_name],
                |row| row.get(0),
            )
            .ok()
            .flatten();
        let predicate = definition.as_deref().and_then(index_predicate);
        indexes.push(IndexInfo {
            name: index_name,
            unique,
            primary: origin == "pk",
            columns: index_columns,
            definition,
            predicate,
            ..IndexInfo::default()
        });
    }
    indexes.sort_by(|a, b| a.name.cmp(&b.name));

    let mut foreign_steps: Vec<(i64, i64, String, String, Option<String>)> = Vec::new();
    if let Ok(mut fk_stmt) =
        conn.prepare(&format!("PRAGMA foreign_key_list({})", quote_ident(&name)))
    {
        if let Ok(rows) = fk_stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        }) {
            for row in rows.flatten() {
                foreign_steps.push(row);
            }
        }
    }
    foreign_steps.sort_by_key(|(id, seq, _, _, _)| (*id, *seq));
    let mut foreign_keys: Vec<ForeignKeyInfo> = Vec::new();
    for (id, _, ref_table, column, ref_column) in foreign_steps {
        match foreign_keys.last_mut() {
            Some(existing) if existing.name == format!("fk_{id}") => {
                existing.columns.push(column);
                if let Some(ref_column) = ref_column {
                    existing.ref_columns.push(ref_column);
                }
            }
            _ => foreign_keys.push(ForeignKeyInfo {
                name: format!("fk_{id}"),
                columns: vec![column],
                ref_table,
                ref_columns: ref_column.into_iter().collect(),
            }),
        }
    }

    let mut ddl_parts: Vec<String> = Vec::new();
    if let Ok(mut ddl_stmt) = conn.prepare_bound(
        "SELECT sql FROM sqlite_master WHERE tbl_name = ?1 AND type IN ('table','index')
         AND sql IS NOT NULL
         ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name",
        &[&name],
    ) {
        if let Ok(rows) = ddl_stmt.query_map([&name], |row| row.get::<_, String>(0)) {
            for row in rows.flatten() {
                ddl_parts.push(row);
            }
        }
    }
    let mut triggers: Vec<TriggerInfo> = Vec::new();
    if let Ok(mut trigger_stmt) = conn.prepare_bound(
        "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?1
         ORDER BY name",
        &[&name],
    ) {
        if let Ok(rows) = trigger_stmt.query_map([&name], |row| {
            Ok(TriggerInfo {
                name: row.get(0)?,
                timing: None,
                event: None,
                definition: row.get(1)?,
            })
        }) {
            triggers.extend(rows.flatten());
        }
    }

    let ddl = if ddl_parts.is_empty() {
        None
    } else {
        Some(ddl_parts.join(";\n"))
    };

    let row_count_estimate = conn
        .query_row(
            &format!("SELECT count(*) FROM {}", quote_ident(&name)),
            &[],
            |row| row.get::<_, i64>(0),
        )
        .ok();

    // Page sizes come from the dbstat virtual table; a build without it
    // (the query errors) leaves the sizes unknown. A name with no pages
    // (a view, or a WITHOUT ROWID primary key that lives in the table itself)
    // sums to NULL. dbstat walks every page of the table and of each index
    // while the connection is held, so a large database skips it.
    let database_bytes = conn
        .query_row(
            "SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()",
            &[],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(i64::MAX);
    let measure = database_bytes <= DBSTAT_MAX_BYTES;
    let dbstat_bytes = |object: &str| {
        if !measure {
            return None;
        }
        conn.query_row(
            "SELECT SUM(pgsize) FROM dbstat WHERE name = ?1 AND aggregate = TRUE",
            &[&object],
            |row| row.get::<_, Option<i64>>(0),
        )
        .ok()
    };
    let data_bytes = dbstat_bytes(&name).flatten();
    let index_bytes = data_bytes.and_then(|_| {
        indexes
            .iter()
            .map(|index| dbstat_bytes(&index.name).map(|bytes| bytes.unwrap_or(0)))
            .sum::<Option<i64>>()
    });
    let size_bytes = data_bytes
        .zip(index_bytes)
        .map(|(data, index)| data + index);

    Ok(TableDetail {
        name,
        row_count_estimate,
        size_bytes,
        data_bytes,
        index_bytes,
        comment: None,
        columns,
        indexes,
        foreign_keys,
        triggers,
        ddl,
        schema: None,
    })
}

/// Above this database size, table detail leaves SQLite sizes unknown rather
/// than walking every page to measure them.
const DBSTAT_MAX_BYTES: i64 = 256 * 1024 * 1024;

fn server_info_sync(inner: &SqliteInner) -> Result<ServerInfo, EngineError> {
    let conn = lock_conn(inner)?;
    let version: String = conn.query_row("SELECT sqlite_version()", &[], |row| row.get(0))?;
    let page_count: i64 = conn.query_row("PRAGMA page_count", &[], |row| row.get(0))?;
    let page_size: i64 = conn.query_row("PRAGMA page_size", &[], |row| row.get(0))?;
    Ok(ServerInfo {
        driver: "sqlite".into(),
        version: Some(version),
        database: inner.path.as_ref().map(|path| path.display().to_string()),
        encoding: Some("UTF-8".into()),
        uptime: None,
        size_bytes: Some(page_count.saturating_mul(page_size)),
        sessions: None,
        can_kill: false,
        topology: None,
        host: None,
    })
}

fn objects_sync(inner: &SqliteInner, include_system: bool) -> Result<DbObjects, EngineError> {
    let conn = lock_conn(inner)?;
    let mut views = Vec::new();
    let mut triggers = Vec::new();
    let sql = if include_system {
        "SELECT type, name FROM sqlite_master WHERE type IN ('view','trigger') ORDER BY type, name"
    } else {
        "SELECT type, name FROM sqlite_master WHERE type IN ('view','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type, name"
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (kind, name) in rows {
        if kind == "view" {
            views.push(name);
        } else {
            triggers.push(name);
        }
    }
    Ok(DbObjects {
        views,
        functions: Vec::new(),
        triggers,
        sequences: Vec::new(),
        procedures: Vec::new(),
    })
}

fn object_definition_sync(
    inner: &SqliteInner,
    kind: &str,
    name: &str,
) -> Result<Option<ObjectDefinition>, EngineError> {
    if kind != "view" && kind != "trigger" {
        return Ok(None);
    }
    let conn = lock_conn(inner)?;
    let name = name
        .trim_matches(|c| matches!(c, '"' | '\'' | '`' | '[' | ']'))
        .to_string();
    let ddl = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = ?1 AND name = ?2",
            &[&kind, &name],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten();
    let exists = matches!(kind, "view" | "trigger")
        && conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = ?1 AND name = ?2",
                &[&kind, &name],
                |row| row.get::<_, i64>(0),
            )
            .map(|count| count > 0)
            .unwrap_or(false);
    if !exists {
        return Ok(None);
    }
    Ok(Some(ObjectDefinition {
        name,
        kind: kind.to_string(),
        ddl,
    }))
}

/// A float as text: a REAL with the digits it was stored with (widened to
/// f64 as it is, 3.14 would read 3.140000104904175), and infinity and NaN
/// as PostgreSQL writes them.
pub(crate) fn float_text<F: Into<f64> + std::fmt::Display + Copy>(value: F) -> String {
    let wide: f64 = value.into();
    if wide.is_finite() {
        value.to_string()
    } else if wide.is_nan() {
        "NaN".into()
    } else if wide > 0.0 {
        "Infinity".into()
    } else {
        "-Infinity".into()
    }
}

/// Past this many bytes a binary cell shows only its size, and can't be
/// edited back: its hex is twice its size, for every row of a result.
pub(crate) const BLOB_HEX_MAX: usize = 16 << 10;

/// Binary as hex, as TablePlus shows it, in the engine's own notation:
/// `\x00ff` on PostgreSQL (its text form), `0x00FF` on the others.
pub(crate) fn hex_cell(bytes: &[u8], postgres: bool) -> Value {
    if bytes.len() > BLOB_HEX_MAX {
        return Value::from(format!("<blob {} bytes>", bytes.len()));
    }
    Value::from(hex_text(bytes, postgres))
}

pub(crate) fn hex_text(bytes: &[u8], postgres: bool) -> String {
    let digits: &[u8; 16] = if postgres {
        b"0123456789abcdef"
    } else {
        b"0123456789ABCDEF"
    };
    let mut text = String::with_capacity(2 + bytes.len() * 2);
    text.push_str(if postgres { "\\x" } else { "0x" });
    for byte in bytes {
        text.push(char::from(digits[usize::from(byte >> 4)]));
        text.push(char::from(digits[usize::from(byte & 0x0f)]));
    }
    text
}

/// The bytes a binary cell's text stands for: its hex as shown (`\x00ff`,
/// `0x00FF`), as a literal (`X'00FF'`) or bare; None when it isn't hex, so
/// text never lands in a binary column as its own characters.
pub(crate) fn hex_bytes(text: &str) -> Option<Vec<u8>> {
    let text = text.trim();
    let digits = if let Some(rest) = text
        .strip_prefix("\\x")
        .or_else(|| text.strip_prefix("0x"))
        .or_else(|| text.strip_prefix("0X"))
    {
        rest
    } else if text.len() >= 3
        && (text.starts_with("X'") || text.starts_with("x'"))
        && text.ends_with('\'')
    {
        &text[2..text.len() - 1]
    } else {
        text
    };
    if digits.len() % 2 != 0 || !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    (0..digits.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&digits[at..at + 2], 16).ok())
        .collect()
}

/// The bytes of hex written as a cell shows it (`\x00ff`, `0x00FF`,
/// `X'00FF'`): only then, so text like `ab` stays the characters it is
/// where it might be either (a key, a SQLite cell of any type).
pub(crate) fn shown_hex_bytes(text: &str) -> Option<Vec<u8>> {
    let text = text.trim();
    let marked = ["\\x", "0x", "0X", "X'", "x'"]
        .iter()
        .any(|prefix| text.starts_with(prefix));
    if marked {
        hex_bytes(text)
    } else {
        None
    }
}

/// What a binary column refuses: text that isn't hex.
pub(crate) fn not_hex() -> EngineError {
    EngineError::BadRequest("이진 값은 16진수로 입력하세요 (예: 0x00FF)".into())
}

/// A REAL as a JSON number at the digits it was stored with, or as text
/// where JSON has no number.
pub(crate) fn real_json(value: f32) -> Value {
    let text = float_text(value);
    match text.parse::<f64>() {
        Ok(number) if number.is_finite() => Value::from(number),
        _ => Value::from(text),
    }
}

/// A DOUBLE PRECISION as a JSON number, or as text where JSON has none
/// (serde_json would turn infinity and NaN into null).
pub(crate) fn double_json(value: f64) -> Value {
    if value.is_finite() {
        Value::from(value)
    } else {
        Value::from(float_text(value))
    }
}

pub(crate) fn humanize_uptime_ko(seconds: i64) -> String {
    let seconds = seconds.max(0);
    if seconds < 60 {
        return format!("{seconds}초");
    }
    let days = seconds / 86_400;
    let hours = (seconds / 3_600) % 24;
    let minutes = (seconds / 60) % 60;
    let mut parts = Vec::new();
    if days > 0 {
        parts.push(format!("{days}일"));
    }
    if hours > 0 {
        parts.push(format!("{hours}시간"));
    }
    if minutes > 0 {
        parts.push(format!("{minutes}분"));
    }
    if parts.is_empty() {
        parts.push(format!("{seconds}초"));
    }
    parts.join(" ")
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn value_ref_to_json(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => Value::from(f),
        ValueRef::Text(bytes) => Value::from(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Blob(bytes) => hex_cell(bytes, false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tablepeek_types::PkValue;

    /// The typed settings the docker-gated tests build, connected through the
    /// registry as a client's config would be.
    trait SwapTyped {
        async fn swap_typed<T: serde::Serialize>(
            &self,
            engine: &str,
            config: &T,
            password: Option<&str>,
        ) -> Result<EngineMeta, EngineError>;

        async fn swap_to_postgres(
            &self,
            config: &tablepeek_types::PostgresConfig,
        ) -> Result<EngineMeta, EngineError> {
            self.swap_typed("postgres", config, config.password.as_deref())
                .await
        }

        async fn swap_to_cockroach(
            &self,
            config: &tablepeek_types::PostgresConfig,
        ) -> Result<EngineMeta, EngineError> {
            self.swap_typed("cockroach", config, config.password.as_deref())
                .await
        }

        async fn swap_to_mysql(
            &self,
            config: &tablepeek_types::MySqlConfig,
        ) -> Result<EngineMeta, EngineError> {
            self.swap_typed("mysql", config, config.password.as_deref())
                .await
        }

        async fn swap_to_mssql(
            &self,
            config: &tablepeek_types::MssqlConfig,
        ) -> Result<EngineMeta, EngineError> {
            self.swap_typed("mssql", config, config.password.as_deref())
                .await
        }
    }

    impl SwapTyped for Engine {
        async fn swap_typed<T: serde::Serialize>(
            &self,
            engine: &str,
            config: &T,
            password: Option<&str>,
        ) -> Result<EngineMeta, EngineError> {
            // Typed settings never serialize their password; it goes in by hand.
            let Value::Object(mut map) = serde_json::to_value(config).unwrap() else {
                unreachable!("settings serialize as an object");
            };
            if let Some(password) = password {
                map.insert("password".into(), Value::String(password.into()));
            }
            self.swap_to(registry::require(engine)?, &map, &NetRoute::Direct)
                .await
        }
    }

    fn temp_db(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "tablepeek-test-{}-{}-{name}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn binary_shows_as_hex_and_reads_back() {
        assert_eq!(
            hex_cell(&[0x00, 0xff, 0x10], true),
            Value::from("\\x00ff10")
        );
        assert_eq!(
            hex_cell(&[0x00, 0xff, 0x10], false),
            Value::from("0x00FF10")
        );
        assert_eq!(hex_cell(&[], false), Value::from("0x"));
        // Too big to show: its size, which reads back as no bytes at all.
        let big = vec![0u8; BLOB_HEX_MAX + 1];
        let shown = hex_cell(&big, false);
        assert_eq!(
            shown,
            Value::from(format!("<blob {} bytes>", BLOB_HEX_MAX + 1))
        );
        assert_eq!(hex_bytes(shown.as_str().unwrap()), None);

        for text in [
            "\\x00ff10",
            "0x00FF10",
            "0X00ff10",
            "X'00FF10'",
            "x'00ff10'",
            "00ff10",
            " 0x00FF10 ",
        ] {
            assert_eq!(hex_bytes(text), Some(vec![0x00, 0xff, 0x10]), "{text}");
        }
        assert_eq!(hex_bytes("0x"), Some(vec![]));
        for text in ["0x0", "0xZZ", "hello", "X'00FF", "\\x0g"] {
            assert_eq!(hex_bytes(text), None, "{text}");
        }

        for declared in [
            "BLOB",
            "longblob",
            "VARBINARY(16)",
            "binary",
            "bytea",
            "image",
        ] {
            assert!(binary_type(declared), "{declared}");
        }
        for declared in ["", "TEXT", "binaryish", "bytes_count", "imagery"] {
            assert!(!binary_type(declared), "{declared}");
        }
    }

    #[test]
    fn floats_keep_their_stored_digits_and_infinities() {
        assert_eq!(real_json(1.1), serde_json::json!(1.1));
        assert_eq!(real_json(-1.5e-10), serde_json::json!(-1.5e-10));
        assert_eq!(real_json(3.4e38), serde_json::json!(3.4e38));
        assert_eq!(real_json(f32::INFINITY), Value::from("Infinity"));
        assert_eq!(double_json(0.1), serde_json::json!(0.1));
        assert_eq!(double_json(f64::NEG_INFINITY), Value::from("-Infinity"));
        assert_eq!(double_json(f64::NAN), Value::from("NaN"));
    }

    #[tokio::test]
    async fn demo_seed_and_meta() {
        let engine = Engine::open_demo(250).unwrap();
        let meta = engine.meta(false).await.unwrap();
        assert_eq!(meta.kind, "sqlite");
        assert!(meta.demo);
        assert!(meta.path.is_none());
        assert_eq!(meta.tables, vec!["demo"]);

        let result = engine
            .execute("SELECT count(*) FROM demo", 10)
            .await
            .unwrap();
        assert_eq!(result.rows[0][0], Value::from(250));
    }

    #[tokio::test]
    async fn query_returns_arrow_data() {
        let engine = Engine::open_demo(100).unwrap();
        let data = engine
            .query("SELECT id, name FROM demo ORDER BY id", 1000)
            .await
            .unwrap();
        assert_eq!(data.row_count, 100);
        assert_eq!(data.columns, vec!["id", "name"]);
        assert_eq!(data.source_table.as_deref(), Some("demo"));
        assert_eq!(data.pk.as_deref(), Some(&["id".to_string()][..]));

        let (batch, count) = data.slice_rows(5, 3).unwrap();
        assert_eq!(count, 3);
        assert_eq!(batch.num_rows(), 3);
        let ids = batch
            .column(0)
            .as_any()
            .downcast_ref::<Int64Array>()
            .unwrap();
        assert_eq!(ids.value(0), 6);

        let ipc = data.encode_ipc(&batch).unwrap();
        assert!(!ipc.is_empty());
    }

    #[tokio::test]
    async fn join_query_has_no_source_table() {
        let engine = Engine::open_demo(10).unwrap();
        let data = engine
            .query("SELECT a.id FROM demo a JOIN demo b ON a.id = b.id", 100)
            .await
            .unwrap();
        assert!(data.source_table.is_none());
        assert!(data.pk.is_none());
    }

    #[tokio::test]
    async fn truncates_at_max_rows() {
        let engine = Engine::open_demo(100).unwrap();
        let data = engine.query("SELECT id FROM demo", 7).await.unwrap();
        assert_eq!(data.row_count, 7);
        assert!(data.truncated);
    }

    #[tokio::test]
    async fn statements_without_rows_report_rows_affected() {
        let engine = Engine::open_demo(10).unwrap();
        let update = engine
            .query("UPDATE demo SET name = name WHERE id <= 3", 100)
            .await
            .unwrap();
        assert!(update.columns.is_empty());
        assert_eq!(update.rows_affected, Some(3));
        // SQLite's changes() still holds the UPDATE's 3 here.
        let ddl = engine
            .query("CREATE TABLE affected_probe(id INTEGER)", 100)
            .await
            .unwrap();
        assert_eq!(ddl.rows_affected, Some(0));
        let select = engine.query("SELECT id FROM demo", 100).await.unwrap();
        assert_eq!(select.rows_affected, None);
    }

    #[tokio::test]
    async fn edit_and_transaction_roundtrip() {
        let engine = Engine::open_demo(5).unwrap();

        let target = EditTarget {
            table: "demo".into(),
            pk: vec![PkValue {
                column: "id".into(),
                value: Value::from(1),
            }],
            column: "name".into(),
            value: Some("수정됨".into()),
            expr: None,
        };
        let changed = engine.edit(&target).await.unwrap();
        assert_eq!(changed, 1);
        let check = engine
            .execute("SELECT name FROM demo WHERE id = 1", 1)
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], Value::from("수정됨"));

        engine.begin_tx().await.unwrap();
        let target2 = EditTarget {
            value: Some("롤백됨".into()),
            ..target.clone()
        };
        engine.edit(&target2).await.unwrap();
        engine.rollback_tx().await.unwrap();
        let check = engine
            .execute("SELECT name FROM demo WHERE id = 1", 1)
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], Value::from("수정됨"));

        engine.begin_tx().await.unwrap();
        engine.edit(&target2).await.unwrap();
        engine.commit_tx().await.unwrap();
        let check = engine
            .execute("SELECT name FROM demo WHERE id = 1", 1)
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], Value::from("롤백됨"));
    }

    #[test]
    fn sqlite_defaults_are_written_as_declared() {
        let sql = |declared: &str| sqlite_default_sql(Some(declared.into())).unwrap();
        assert_eq!(sqlite_default_sql(None).unwrap(), "NULL");
        assert_eq!(sql("'new'"), "('new')");
        assert_eq!(sql("2 + 5"), "(2 + 5)");
        assert_eq!(sql("-5"), "(-5)");
        assert_eq!(sql("x'41'"), "(x'41')");
        // Bare words SQLite reads as values stay values, in any case.
        assert_eq!(sql("CURRENT_TIMESTAMP"), "(CURRENT_TIMESTAMP)");
        assert_eq!(sql("current_date"), "(current_date)");
        assert_eq!(sql("NULL"), "(NULL)");
        assert_eq!(sql("true"), "(true)");
        // A default spelled as one name is a string, its quotes undone and redone.
        assert_eq!(sql("\"note\""), "'note'");
        assert_eq!(sql("\"say \"\"hi\"\" it's\""), "'say \"hi\" it''s'");
        assert_eq!(sql("active"), "'active'");
        assert_eq!(sql("a$b"), "'a$b'");
        assert_eq!(sql("한글"), "'한글'");
        assert_eq!(sql("[b2]"), "'b2'");
        assert_eq!(sql("`c2`"), "'c2'");
        assert_eq!(sql("`it``s`"), "'it`s'");
        // Not one name: left as the expression it is.
        assert_eq!(sql("\"a\" || \"b\""), "(\"a\" || \"b\")");
        // A trailing comment ends its line before the closing parenthesis.
        assert_eq!(sql("'x' -- trailing note"), "('x' -- trailing note\n)");
        // Bind parameters outside strings, names and comments are refused.
        for declared in ["?", "?1 + 1", "1 + :x", "@x", "$x", "('a' || ?)"] {
            assert!(
                matches!(
                    sqlite_default_sql(Some(declared.into())),
                    Err(EngineError::BadRequest(_))
                ),
                "{declared}"
            );
        }
        for declared in [
            "'?'",
            "'it''s ?'",
            "\"a?\" || 1",
            "[x?]",
            "1 -- why?",
            "1 /* :x */",
            "strftime('%s', 'now')",
        ] {
            assert!(
                sqlite_default_sql(Some(declared.into())).is_ok(),
                "{declared}"
            );
        }
    }

    fn expr_target(id: i64, column: &str, expr: ValueExpr) -> EditTarget {
        EditTarget {
            table: "items".into(),
            pk: vec![PkValue {
                column: "id".into(),
                value: Value::from(id),
            }],
            column: column.into(),
            value: None,
            expr: Some(expr),
        }
    }

    #[tokio::test]
    async fn sqlite_default_names_are_strings_not_columns() {
        let path = temp_db("default-names");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE items(
                    id INTEGER PRIMARY KEY,
                    active TEXT, b2 TEXT, c2 TEXT, d2 TEXT,
                    status TEXT DEFAULT active,
                    b TEXT DEFAULT [b2],
                    c TEXT DEFAULT `c2`,
                    d TEXT DEFAULT \"d2\",
                    f TEXT DEFAULT ('x' -- trailing note
                    )
                 );
                 INSERT INTO items VALUES (1, 'SECRET', 'B2', 'C2', 'D2', 'old', 'old', 'old', 'old', 'old');",
            )
            .unwrap();
        }
        let engine = Engine::open_file(&path).unwrap();
        // Each reads as SQLite's own INSERT would fill it, never another column.
        for column in ["status", "b", "c", "d", "f"] {
            assert_eq!(
                engine
                    .edit(&expr_target(1, column, ValueExpr::Default))
                    .await
                    .unwrap(),
                1,
                "{column}"
            );
        }
        let row = engine
            .execute("SELECT status, b, c, d, f FROM items WHERE id = 1", 1)
            .await
            .unwrap();
        let expected: Vec<Value> = ["active", "b2", "c2", "d2", "x"]
            .into_iter()
            .map(Value::from)
            .collect();
        assert_eq!(row.rows[0], expected);
    }

    #[tokio::test]
    async fn sqlite_set_value_writes_default_and_the_time() {
        let path = temp_db("value-expr");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE items(
                    id INTEGER PRIMARY KEY,
                    status TEXT DEFAULT 'new',
                    qty INTEGER NOT NULL DEFAULT (2 + 5),
                    note TEXT,
                    seen TEXT,
                    kind TEXT DEFAULT \"note\"
                 );
                 INSERT INTO items(id, status, qty, note, seen, kind) VALUES (1, 'old', 1, 'x', NULL, 'k');",
            )
            .unwrap();
        }
        let engine = Engine::open_file(&path).unwrap();
        let log = engine.sql_log().clone();
        let newest = || log.since(None).0.last().map_or(0, |entry| entry.seq);
        let mark = newest();

        // DEFAULT: the declared default (an expression too), else NULL.
        for column in ["status", "qty", "note"] {
            let changed = engine
                .edit(&expr_target(1, column, ValueExpr::Default))
                .await
                .unwrap();
            assert_eq!(changed, 1, "{column}");
        }
        // `DEFAULT "note"` is the string, not the column note; names match
        // without case.
        engine
            .edit(&expr_target(1, "KIND", ValueExpr::Default))
            .await
            .unwrap();
        let kind = engine
            .execute("SELECT kind FROM items WHERE id = 1", 1)
            .await
            .unwrap();
        assert_eq!(kind.rows[0][0], Value::from("note"));
        // NOW(): SQLite's CURRENT_TIMESTAMP.
        engine
            .edit(&expr_target(1, "seen", ValueExpr::Now))
            .await
            .unwrap();
        let row = engine
            .execute(
                "SELECT status, qty, note, seen IS NOT NULL, \
                 abs(strftime('%s', seen) - strftime('%s', 'now')) < 60 FROM items WHERE id = 1",
                1,
            )
            .await
            .unwrap();
        assert_eq!(
            row.rows[0],
            vec![
                Value::from("new"),
                Value::from(7),
                Value::Null,
                Value::from(1),
                Value::from(1)
            ]
        );
        let logged: Vec<String> = log
            .since(Some(mark))
            .0
            .into_iter()
            .map(|entry| entry.sql)
            .collect();
        assert!(
            logged.contains(
                &"UPDATE \"items\" SET \"status\" = ('new') WHERE \"id\" = 1;".to_string()
            ),
            "{logged:?}"
        );
        // PRAGMA gives `(2 + 5)` as `2 + 5`: the parentheses keep it one value.
        assert!(
            logged
                .contains(&"UPDATE \"items\" SET \"qty\" = (2 + 5) WHERE \"id\" = 1;".to_string()),
            "{logged:?}"
        );
        assert!(
            logged.contains(&"UPDATE \"items\" SET \"note\" = NULL WHERE \"id\" = 1;".to_string()),
            "{logged:?}"
        );
        assert!(
            logged.contains(
                &"UPDATE \"items\" SET \"seen\" = CURRENT_TIMESTAMP WHERE \"id\" = 1;".to_string()
            ),
            "{logged:?}"
        );

        // A new row: DEFAULT is left out, NOW() written, values bound after it.
        let values = vec![
            InsertValue {
                column: "id".into(),
                value: Some("2".into()),
                expr: None,
            },
            InsertValue {
                column: "status".into(),
                value: None,
                expr: Some(ValueExpr::Default),
            },
            InsertValue {
                column: "seen".into(),
                value: None,
                expr: Some(ValueExpr::Now),
            },
            InsertValue {
                column: "note".into(),
                value: Some("n".into()),
                expr: None,
            },
        ];
        assert_eq!(engine.insert_values("items", &values).await.unwrap(), 1);
        let row = engine
            .execute(
                "SELECT status, qty, note, seen IS NOT NULL FROM items WHERE id = 2",
                1,
            )
            .await
            .unwrap();
        assert_eq!(
            row.rows[0],
            vec![
                Value::from("new"),
                Value::from(7),
                Value::from("n"),
                Value::from(1)
            ]
        );
        let logged: Vec<String> = log
            .since(None)
            .0
            .into_iter()
            .map(|entry| entry.sql)
            .collect();
        assert!(logged.contains(
            &"INSERT INTO \"items\" (\"id\", \"seen\", \"note\") VALUES ('2', CURRENT_TIMESTAMP, 'n');".to_string()
        ), "{logged:?}");

        // A column the table doesn't have is refused, not guessed.
        let missing = engine
            .edit(&expr_target(1, "nope", ValueExpr::Default))
            .await;
        assert!(
            matches!(missing, Err(EngineError::BadRequest(_))),
            "{missing:?}"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn sqlite_binary_edits_follow_what_the_cell_holds() {
        let path = temp_db("binary-edits");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE files(id INTEGER PRIMARY KEY, data BLOB, note);
                 INSERT INTO files VALUES (1, X'CAFE', X'01'), (2, 'cafe', 'x'), (3, NULL, NULL);",
            )
            .unwrap();
        }
        let engine = Engine::open_file(&path).unwrap();
        let edit = |id: i64, column: &str, value: &str| EditTarget {
            table: "files".into(),
            pk: vec![PkValue {
                column: "id".into(),
                value: Value::from(id),
            }],
            column: column.into(),
            value: Some(value.into()),
            expr: None,
        };
        let held = |id: i64, column: &str| {
            let conn = Connection::open(&path).unwrap();
            conn.query_row(
                &format!(
                    "SELECT typeof({column}) || ':' || hex({column}) FROM files WHERE id = {id}"
                ),
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap()
        };

        // A blob takes hex as bytes, and a column declared BLOB refuses text.
        engine.edit(&edit(1, "data", "0xBEEF")).await.unwrap();
        assert_eq!(held(1, "data"), "blob:BEEF");
        assert!(engine.edit(&edit(1, "data", "hello")).await.is_err());
        // Text in a BLOB column stays text, even when it looks like hex.
        engine.edit(&edit(2, "data", "beef")).await.unwrap();
        assert_eq!(held(2, "data"), "text:62656566");
        // An empty cell of a BLOB column takes only hex.
        assert!(engine.edit(&edit(3, "data", "hello")).await.is_err());
        engine.edit(&edit(3, "data", "01")).await.unwrap();
        assert_eq!(held(3, "data"), "blob:01");
        // A column of no type: a blob takes hex written as shown, else text.
        engine.edit(&edit(1, "note", "0x02")).await.unwrap();
        assert_eq!(held(1, "note"), "blob:02");
        engine.edit(&edit(1, "note", "hi")).await.unwrap();
        assert_eq!(held(1, "note"), "text:6869");
        engine.edit(&edit(2, "note", "0x03")).await.unwrap();
        assert_eq!(held(2, "note"), "text:30783033");
    }

    #[tokio::test]
    async fn sqlite_statements_and_changes_reach_the_log() {
        let path = temp_db("sql-log");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT);
                 INSERT INTO people(id, name) VALUES (1, 'Ann');",
            )
            .unwrap();
        }
        let engine = Engine::open_file(&path).unwrap();
        let log = engine.sql_log().clone();
        let mut changes = log.take_changes().unwrap();
        let sqls = |after: Option<u64>| -> Vec<String> {
            let (entries, reset) = log.since(after);
            assert_eq!(reset, after.is_none());
            entries.into_iter().map(|entry| entry.sql).collect()
        };
        let newest = || log.since(None).0.last().map_or(0, |entry| entry.seq);
        // Opening the file checks it is a database.
        assert_eq!(sqls(None), vec!["SELECT count(*) FROM sqlite_master;"]);

        engine.schema(false).await.unwrap();
        engine.table_detail("people").await.unwrap();
        let mark = newest();
        engine.query("SELECT * FROM people", 100).await.unwrap();
        let logged = sqls(None);
        assert!(logged.contains(&"PRAGMA table_info(\"people\");".to_string()));
        assert!(logged.contains(
            &"SELECT count(*) FROM sqlite_master WHERE type IN ('table','view') AND name = 'people';"
                .to_string()
        ));
        // The user's statement, then the hidden lookups for its table and key.
        assert_eq!(
            sqls(Some(mark)),
            vec![
                "SELECT * FROM people;",
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'people';",
                "PRAGMA table_info(\"people\");",
            ]
        );

        let mark = newest();
        let update = "UPDATE \"people\" SET \"name\" = 'O''Neil' WHERE \"id\" = 1";
        let insert = "INSERT INTO \"people\" (\"id\", \"name\") VALUES ('2', NULL)";
        let delete = "DELETE FROM \"people\" WHERE \"id\" = 2";
        let failed = "INSERT INTO \"people\" (\"nope\") VALUES ('x')";
        engine.begin_tx().await.unwrap();
        engine
            .edit(&EditTarget {
                table: "people".into(),
                pk: vec![PkValue {
                    column: "id".into(),
                    value: Value::from(1),
                }],
                column: "name".into(),
                value: Some("O'Neil".into()),
                expr: None,
            })
            .await
            .unwrap();
        engine
            .insert_row(
                "people",
                &[("id".into(), Some("2".into())), ("name".into(), None)],
            )
            .await
            .unwrap();
        engine
            .delete_row(
                "people",
                &[PkValue {
                    column: "id".into(),
                    value: Value::from(2),
                }],
            )
            .await
            .unwrap();
        assert!(engine
            .insert_row("people", &[("nope".into(), Some("x".into()))])
            .await
            .is_err());
        engine.commit_tx().await.unwrap();
        // An edit first asks what the cell holds, and a new value whether
        // its column is binary (which takes hex only), as other engines look
        // a column's type up.
        let blob_check = |column: &str| {
            format!("SELECT type FROM pragma_table_info('people') WHERE name = '{column}' COLLATE NOCASE;")
        };
        assert_eq!(
            sqls(Some(mark)),
            vec![
                "BEGIN;".to_string(),
                "SELECT typeof(\"name\") FROM \"people\" WHERE \"id\" = 1;".to_string(),
                format!("{update};"),
                blob_check("id"),
                format!("{insert};"),
                format!("{delete};"),
                blob_check("nope"),
                format!("{failed};"),
                "COMMIT;".to_string(),
            ]
        );
        // Only changes that went through reach History, once committed.
        let changed: Vec<String> = std::iter::from_fn(|| changes.try_recv().ok())
            .map(|change| change.sql)
            .collect();
        assert_eq!(changed, vec![update, insert, delete]);

        // A backend swap keeps the log and its numbering.
        let mark = newest();
        engine.swap_to_demo(3).await.unwrap();
        let (entries, reset) = log.since(Some(mark));
        assert!(!reset);
        assert_eq!(entries[0].seq, mark + 1);
        assert_eq!(
            entries[0].sql,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"
        );

        std::fs::remove_file(&path).unwrap();
    }

    fn people_db(name: &str) -> PathBuf {
        let path = temp_db(name);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT);
             INSERT INTO people(id, name) VALUES (1, 'Ann'), (2, 'Bo');",
        )
        .unwrap();
        path
    }

    fn rename(id: i64, name: &str) -> EditTarget {
        EditTarget {
            table: "people".into(),
            pk: vec![PkValue {
                column: "id".into(),
                value: Value::from(id),
            }],
            column: "name".into(),
            value: Some(name.into()),
            expr: None,
        }
    }

    fn drain_changes(
        changes: &mut tokio::sync::mpsc::UnboundedReceiver<sql_log::Change>,
    ) -> Vec<sql_log::Change> {
        std::iter::from_fn(|| changes.try_recv().ok()).collect()
    }

    #[tokio::test]
    async fn changes_reach_history_only_once_committed() {
        let path = people_db("tx-changes");
        let engine = Engine::open_file(&path).unwrap();
        let mut changes = engine.sql_log().take_changes().unwrap();

        // Outside a transaction a change goes out at once, with its count.
        assert_eq!(engine.edit(&rename(1, "A1")).await.unwrap(), 1);
        let now = drain_changes(&mut changes);
        assert_eq!(now.len(), 1);
        assert_eq!(
            now[0].sql,
            "UPDATE \"people\" SET \"name\" = 'A1' WHERE \"id\" = 1"
        );
        assert_eq!(now[0].rows, 1);

        // A row that is not there changes nothing and is not History.
        assert_eq!(engine.edit(&rename(99, "nobody")).await.unwrap(), 0);
        assert!(drain_changes(&mut changes).is_empty());

        // Held until COMMIT.
        engine.begin_tx().await.unwrap();
        engine.edit(&rename(1, "A2")).await.unwrap();
        engine
            .delete_row(
                "people",
                &[PkValue {
                    column: "id".into(),
                    value: Value::from(2),
                }],
            )
            .await
            .unwrap();
        assert!(drain_changes(&mut changes).is_empty());
        engine.commit_tx().await.unwrap();
        let committed: Vec<u64> = drain_changes(&mut changes)
            .iter()
            .map(|change| change.rows)
            .collect();
        assert_eq!(committed, vec![1, 1]);

        // Dropped on ROLLBACK.
        engine.begin_tx().await.unwrap();
        engine.edit(&rename(1, "rolled back")).await.unwrap();
        engine.rollback_tx().await.unwrap();
        assert!(drain_changes(&mut changes).is_empty());

        // A statement the GUI ran asking for History follows the same rule.
        let ran = || sql_log::Change {
            sql: "DROP TABLE gone".into(),
            ms: 3,
            rows: 0,
        };
        engine.file_change(ran()).await;
        assert_eq!(drain_changes(&mut changes), vec![ran()]);
        engine.begin_tx().await.unwrap();
        engine.file_change(ran()).await;
        assert!(drain_changes(&mut changes).is_empty());
        engine.rollback_tx().await.unwrap();
        assert!(drain_changes(&mut changes).is_empty());

        // A transaction the editor opens and ends counts too.
        engine.query("BEGIN", 1).await.unwrap();
        engine.edit(&rename(1, "A3")).await.unwrap();
        assert!(drain_changes(&mut changes).is_empty());
        engine.query("COMMIT", 1).await.unwrap();
        assert_eq!(drain_changes(&mut changes).len(), 1);
        engine.query("BEGIN", 1).await.unwrap();
        engine.edit(&rename(1, "A4")).await.unwrap();
        engine.query("ROLLBACK", 1).await.unwrap();
        assert!(drain_changes(&mut changes).is_empty());

        // A backend swap abandons the open transaction's changes.
        engine.begin_tx().await.unwrap();
        engine.edit(&rename(1, "A5")).await.unwrap();
        engine.swap_to_demo(1).await.unwrap();
        engine.sql_log().settle(true);
        assert!(drain_changes(&mut changes).is_empty());

        std::fs::remove_file(&path).unwrap();
    }

    #[tokio::test]
    async fn in_tx_reflects_autocommit_state() {
        let engine = Engine::open_demo(3).unwrap();
        assert!(!engine.in_tx().await.unwrap());
        engine.begin_tx().await.unwrap();
        assert!(engine.in_tx().await.unwrap());
        let err = engine.begin_tx().await.unwrap_err();
        assert!(err.to_string().contains("이미 트랜잭션"));
        engine.rollback_tx().await.unwrap();
        assert!(!engine.in_tx().await.unwrap());
        let err = engine.commit_tx().await.unwrap_err();
        assert!(err.to_string().contains("진행 중인 트랜잭션"));
    }

    #[tokio::test]
    async fn patch_cell_updates_values_and_types() {
        let engine = Engine::open_demo(5).unwrap();
        let mut data = engine
            .query("SELECT id, name FROM demo ORDER BY id", 100)
            .await
            .unwrap();
        assert_eq!(data.cell_string(2, 1).as_deref(), Some("user_3"));

        data.patch_cell(2, 1, Some("수정됨")).unwrap();
        assert_eq!(data.cell_string(2, 1).as_deref(), Some("수정됨"));
        assert_eq!(data.rows_json()[2][1], Value::from("수정됨"));

        data.patch_cell(1, 0, Some("77")).unwrap();
        assert_eq!(data.rows_json()[1][0], Value::from(77));
        assert!(matches!(data.schema.field(0).data_type(), DataType::Int64));

        data.patch_cell(0, 0, Some("정수아님")).unwrap();
        assert!(matches!(data.schema.field(0).data_type(), DataType::Utf8));
        assert_eq!(data.rows_json()[0][0], Value::from("정수아님"));
        assert_eq!(data.rows_json()[3][0], Value::from("4"));

        data.patch_cell(0, 0, None).unwrap();
        assert_eq!(data.rows_json()[0][0], Value::Null);
        assert!(data.cell_string(0, 0).is_none());

        let err = data.patch_cell(99, 0, Some("x")).unwrap_err();
        assert!(err.to_string().contains("행 범위"));
    }

    fn pg_tls_config() -> Option<tablepeek_types::PostgresConfig> {
        std::env::var("TABLEPEEK_TEST_PG_TLS").ok()?;
        let ssl_root_cert = std::env::var("TABLEPEEK_TEST_PG_TLS_CA").ok()?;
        Some(tablepeek_types::PostgresConfig {
            host: "127.0.0.1".into(),
            port: 5434,
            user: "tablepeek".into(),
            password: Some("tablepeek_test_pw".into()),
            database: "tablepeek_test".into(),
            ssl_mode: tablepeek_types::SslMode::Require,
            ssl_root_cert: Some(ssl_root_cert),
            ssl_client_cert: None,
            ssl_client_key: None,
        })
    }

    #[tokio::test]
    async fn pg_tls_require_uses_encrypted_connection() {
        let Some(config) = pg_tls_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        let meta = engine.swap_to_postgres(&config).await.unwrap();
        assert_eq!(meta.kind, "postgres");
        let data = engine
            .query(
                "SELECT ssl::text FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
                10,
            )
            .await
            .unwrap();
        assert_eq!(data.cell_string(0, 0).as_deref(), Some("true"));
    }

    fn pg_config() -> Option<tablepeek_types::PostgresConfig> {
        std::env::var("TABLEPEEK_TEST_PG").ok()?;
        Some(tablepeek_types::PostgresConfig {
            host: "127.0.0.1".into(),
            port: 5433,
            user: "tablepeek".into(),
            password: Some("tablepeek_test_pw".into()),
            database: "tablepeek_test".into(),
            ssl_mode: tablepeek_types::SslMode::Disable,
            ssl_root_cert: None,
            ssl_client_cert: None,
            ssl_client_key: None,
        })
    }

    #[tokio::test]
    async fn pg_a_table_swapped_or_rekeyed_elsewhere_is_not_edited_blindly() {
        let Some(config) = pg_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_postgres(&config).await.unwrap();
        let elsewhere = Engine::open_demo(1).unwrap();
        elsewhere.swap_to_postgres(&config).await.unwrap();
        for sql in [
            "DROP TABLE IF EXISTS tp_swap, tp_swap_old, tp_swap_new",
            "CREATE TABLE tp_swap (id int PRIMARY KEY, note text)",
            "CREATE TABLE tp_swap_new (id int PRIMARY KEY, note text)",
            "INSERT INTO tp_swap VALUES (1, 'old')",
            "INSERT INTO tp_swap_new VALUES (1, 'new')",
        ] {
            engine.execute(sql, 1).await.unwrap();
        }
        let data = engine.query("SELECT * FROM tp_swap", 10).await.unwrap();
        assert_eq!(data.source_table.as_deref(), Some("tp_swap"));

        // Another session swaps the tables: the one just read is tp_swap_old now.
        elsewhere
            .execute("ALTER TABLE tp_swap RENAME TO tp_swap_old", 1)
            .await
            .unwrap();
        elsewhere
            .execute("ALTER TABLE tp_swap_new RENAME TO tp_swap", 1)
            .await
            .unwrap();
        let data = engine.query("SELECT * FROM tp_swap_old", 10).await.unwrap();
        assert_eq!(data.source_table.as_deref(), Some("tp_swap_old"));
        assert_eq!(data.pk, Some(vec!["id".to_string()]));

        // …and widens its key, so id alone matches two rows.
        for sql in [
            "ALTER TABLE tp_swap_old ADD COLUMN rev int NOT NULL DEFAULT 0",
            "ALTER TABLE tp_swap_old DROP CONSTRAINT tp_swap_pkey, ADD PRIMARY KEY (id, rev)",
            "INSERT INTO tp_swap_old VALUES (1, 'twin', 1)",
        ] {
            elsewhere.execute(sql, 1).await.unwrap();
        }
        let target = EditTarget {
            table: "tp_swap_old".into(),
            pk: vec![PkValue {
                column: "id".into(),
                value: Value::from(1),
            }],
            column: "note".into(),
            value: Some("edited".into()),
            expr: None,
        };
        let err = engine.edit(&target).await.unwrap_err();
        assert!(matches!(err, EngineError::NotEditable(_)), "{err}");
        let err = engine
            .delete_row("tp_swap_old", &target.pk)
            .await
            .unwrap_err();
        assert!(matches!(err, EngineError::NotEditable(_)), "{err}");
        let notes = engine
            .query("SELECT note FROM tp_swap_old ORDER BY rev", 10)
            .await
            .unwrap();
        assert_eq!(notes.cell_string(0, 0).as_deref(), Some("old"));
        assert_eq!(notes.cell_string(1, 0).as_deref(), Some("twin"));
        let data = engine.query("SELECT * FROM tp_swap_old", 10).await.unwrap();
        assert_eq!(data.pk, Some(vec!["id".to_string(), "rev".to_string()]));

        // A key dropped inside a transaction that is rolled back comes back.
        engine.begin_tx().await.unwrap();
        engine
            .execute("ALTER TABLE tp_swap DROP CONSTRAINT tp_swap_new_pkey", 1)
            .await
            .unwrap();
        let data = engine.query("SELECT * FROM tp_swap", 10).await.unwrap();
        assert_eq!(data.pk, None);
        engine.rollback_tx().await.unwrap();
        let data = engine.query("SELECT * FROM tp_swap", 10).await.unwrap();
        assert_eq!(data.pk, Some(vec!["id".to_string()]));

        engine
            .execute("DROP TABLE tp_swap, tp_swap_old", 1)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn pg_commit_of_an_aborted_transaction_rolls_back() {
        let Some(config) = pg_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_postgres(&config).await.unwrap();
        let mut changes = engine.sql_log().take_changes().unwrap();
        engine
            .execute("DROP TABLE IF EXISTS tp_abort", 1)
            .await
            .unwrap();
        engine
            .execute("CREATE TABLE tp_abort (id int PRIMARY KEY, note text)", 1)
            .await
            .unwrap();
        engine
            .execute("INSERT INTO tp_abort VALUES (1, 'a'), (2, 'b')", 1)
            .await
            .unwrap();
        let target = |id: i64, column: &str, value: &str| EditTarget {
            table: "tp_abort".into(),
            pk: vec![PkValue {
                column: "id".into(),
                value: Value::from(id),
            }],
            column: column.into(),
            value: Some(value.into()),
            expr: None,
        };

        // The third edit hits the key; the user then clicks Commit.
        engine.begin_tx().await.unwrap();
        engine.edit(&target(1, "note", "x")).await.unwrap();
        engine.edit(&target(2, "note", "y")).await.unwrap();
        assert!(engine.edit(&target(2, "id", "1")).await.is_err());
        let err = engine.commit_tx().await.unwrap_err();
        assert!(matches!(err, EngineError::TxRolledBack(_)), "{err}");
        assert!(!engine.in_tx().await.unwrap());
        assert!(drain_changes(&mut changes).is_empty());
        let note = engine
            .execute("SELECT note FROM tp_abort WHERE id = 1", 1)
            .await
            .unwrap();
        assert_eq!(note.rows[0][0], Value::from("a"));

        // The same COMMIT typed in the editor says so too.
        engine.execute("BEGIN", 1).await.unwrap();
        engine.edit(&target(1, "note", "w")).await.unwrap();
        assert!(engine.execute("SELECT 1/0", 1).await.is_err());
        let err = engine.execute("COMMIT", 1).await.unwrap_err();
        assert!(matches!(err, EngineError::TxRolledBack(_)), "{err}");
        assert!(!engine.in_tx().await.unwrap());
        assert!(drain_changes(&mut changes).is_empty());

        // A transaction opened and ended from the editor holds changes too.
        engine.execute("BEGIN", 1).await.unwrap();
        assert!(engine.in_tx().await.unwrap());
        engine.edit(&target(1, "note", "z")).await.unwrap();
        assert!(drain_changes(&mut changes).is_empty());
        engine.execute("COMMIT", 1).await.unwrap();
        assert!(!engine.in_tx().await.unwrap());
        assert_eq!(drain_changes(&mut changes).len(), 1);

        // A COMMIT that never ran (refused at Parse) leaves it open.
        engine.execute("BEGIN", 1).await.unwrap();
        assert!(engine.execute("COMMIT; SELECT 1", 1).await.is_err());
        assert!(engine.in_tx().await.unwrap());
        engine.rollback_tx().await.unwrap();

        // A COMMIT that fails (a deferred foreign key) ends the transaction.
        for sql in [
            "DROP TABLE IF EXISTS tp_child",
            "CREATE TABLE tp_child (id int, parent int REFERENCES tp_abort (id) \
             DEFERRABLE INITIALLY DEFERRED)",
            "BEGIN",
            "INSERT INTO tp_child VALUES (1, 99)",
        ] {
            engine.execute(sql, 1).await.unwrap();
        }
        engine.edit(&target(1, "note", "v")).await.unwrap();
        assert!(engine.execute("COMMIT", 1).await.is_err());
        assert!(!engine.in_tx().await.unwrap());
        assert!(drain_changes(&mut changes).is_empty());

        engine.execute("DROP TABLE tp_child", 1).await.unwrap();
        engine.execute("DROP TABLE tp_abort", 1).await.unwrap();
    }

    #[tokio::test]
    async fn pg_table_detail_keeps_open_transaction() {
        let Some(config) = pg_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_postgres(&config).await.unwrap();
        engine
            .execute("DROP TABLE IF EXISTS tp_detail_tx", 1)
            .await
            .unwrap();
        engine
            .execute(
                "CREATE TABLE tp_detail_tx (id int PRIMARY KEY, note text)",
                1,
            )
            .await
            .unwrap();
        engine
            .execute("COMMENT ON TABLE tp_detail_tx IS 'notes'", 1)
            .await
            .unwrap();

        // Reading table info in the middle of the user's transaction must
        // leave it committable, with nothing (no savepoint) left behind.
        engine.begin_tx().await.unwrap();
        engine
            .execute("INSERT INTO tp_detail_tx VALUES (1, 'kept')", 1)
            .await
            .unwrap();
        let detail = engine.table_detail("tp_detail_tx").await.unwrap();
        assert_eq!(detail.comment.as_deref(), Some("notes"));
        assert!(detail.size_bytes.is_some());
        assert_eq!(
            detail.size_bytes,
            Some(detail.data_bytes.unwrap() + detail.index_bytes.unwrap())
        );
        let release = engine
            .execute("RELEASE SAVEPOINT tablepeek_detail", 1)
            .await;
        assert!(
            release.is_err(),
            "the detail savepoint should already be released"
        );
        engine.rollback_tx().await.unwrap();

        engine.begin_tx().await.unwrap();
        engine
            .execute("INSERT INTO tp_detail_tx VALUES (2, 'kept')", 1)
            .await
            .unwrap();
        engine.table_detail("tp_detail_tx").await.unwrap();
        engine.commit_tx().await.unwrap();
        let check = engine
            .execute("SELECT note FROM tp_detail_tx WHERE id = 2", 1)
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], Value::from("kept"));

        // Outside a transaction no savepoint is taken at all.
        let detail = engine.table_detail("tp_detail_tx").await.unwrap();
        assert_eq!(detail.comment.as_deref(), Some("notes"));
        engine.execute("DROP TABLE tp_detail_tx", 1).await.unwrap();
    }

    #[tokio::test]
    async fn pg_query_edit_tx_roundtrip() {
        let Some(config) = pg_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        let meta = engine.swap_to_postgres(&config).await.unwrap();
        assert_eq!(meta.kind, "postgres");
        assert!(meta.path.as_deref().unwrap().contains("tablepeek_test"));
        assert!(meta.tables.contains(&"users".to_string()));

        let data = engine
            .query(
                "SELECT id, name, score, active FROM users ORDER BY id LIMIT 3",
                100,
            )
            .await
            .unwrap();
        assert_eq!(data.source_table.as_deref(), Some("users"));
        assert_eq!(data.pk.as_deref(), Some(&["id".to_string()][..]));
        let rows = data.rows_json();
        assert_eq!(rows[0][0], Value::from(1));
        assert_eq!(rows[0][1], Value::from("사용자_1"));
        assert_eq!(rows[0][2], Value::from("1.50"));
        assert_eq!(rows[0][3], Value::from("false"));

        let target = EditTarget {
            table: "users".into(),
            pk: vec![PkValue {
                column: "id".into(),
                value: Value::from(3),
            }],
            column: "name".into(),
            value: Some("피지수정".into()),
            expr: None,
        };
        assert_eq!(engine.edit(&target).await.unwrap(), 1);
        let check = engine
            .execute("SELECT name FROM users WHERE id = 3", 1)
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], Value::from("피지수정"));

        let numeric = EditTarget {
            column: "score".into(),
            value: Some("42.75".into()),
            ..target.clone()
        };
        engine.edit(&numeric).await.unwrap();
        let check = engine
            .execute("SELECT score FROM users WHERE id = 3", 1)
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], Value::from("42.75"));

        engine.begin_tx().await.unwrap();
        assert!(engine.in_tx().await.unwrap());
        let rolled = EditTarget {
            value: Some("롤백될이름".into()),
            ..target.clone()
        };
        engine.edit(&rolled).await.unwrap();
        engine.rollback_tx().await.unwrap();
        assert!(!engine.in_tx().await.unwrap());
        let check = engine
            .execute("SELECT name FROM users WHERE id = 3", 1)
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], Value::from("피지수정"));

        let schema = engine.schema(false).await.unwrap();
        let users = schema.iter().find(|table| table.name == "users").unwrap();
        let id_col = users.columns.iter().find(|col| col.name == "id").unwrap();
        assert!(id_col.pk);
        assert!(id_col.not_null);
        assert_eq!(id_col.decl_type.as_deref(), Some("integer"));
    }

    #[tokio::test]
    async fn pg_insert_delete_and_table_detail() {
        let Some(config) = pg_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_postgres(&config).await.unwrap();

        let table = format!("tablepeek_rowtest_{}", std::process::id());
        engine
            .execute(
                &format!(
                    "CREATE TABLE {table} (id integer PRIMARY KEY, name text NOT NULL, qty integer DEFAULT 0)"
                ),
                1,
            )
            .await
            .unwrap();

        let values = vec![
            ("id".to_string(), Some("41".to_string())),
            ("name".to_string(), Some("tablepeek_왕복".to_string())),
        ];
        assert_eq!(engine.insert_row(&table, &values).await.unwrap(), 1);
        let inserted = engine
            .execute(&format!("SELECT count(*) FROM {table}"), 1)
            .await
            .unwrap();
        assert_eq!(inserted.rows[0][0], Value::from(1));
        let pk = vec![PkValue {
            column: "id".into(),
            value: Value::from(41),
        }];
        assert_eq!(engine.delete_row(&table, &pk).await.unwrap(), 1);
        assert_eq!(engine.delete_row(&table, &pk).await.unwrap(), 0);

        engine
            .execute(&format!("ANALYZE {table}"), 1)
            .await
            .unwrap();
        let detail = engine.table_detail(&table).await.unwrap();
        assert_eq!(detail.name, table);
        assert!(detail.row_count_estimate.is_some());
        assert!(detail.size_bytes.is_some());
        let id_col = detail.columns.iter().find(|c| c.name == "id").unwrap();
        assert!(id_col.pk);
        assert!(detail.indexes.iter().any(|index| index.primary));
        assert!(detail.ddl.as_deref().unwrap().contains("CREATE TABLE"));

        engine
            .execute(&format!("DROP TABLE {table}"), 1)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn pg_set_value_writes_default_and_the_time() {
        let Some(config) = pg_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_postgres(&config).await.unwrap();
        let table = format!("tablepeek_exprtest_{}", std::process::id());
        engine.execute(&format!("CREATE TABLE {table} (id integer PRIMARY KEY, status text DEFAULT 'new', note text, seen timestamptz, day date)"), 1).await.unwrap();
        engine
            .insert_row(
                &table,
                &[
                    ("id".to_string(), Some("1".to_string())),
                    ("status".to_string(), Some("old".to_string())),
                    ("note".to_string(), Some("x".to_string())),
                ],
            )
            .await
            .unwrap();
        let target = |column: &str, expr| EditTarget {
            table: table.clone(),
            pk: vec![PkValue {
                column: "id".into(),
                value: Value::from(1),
            }],
            column: column.into(),
            value: None,
            expr: Some(expr),
        };
        for (column, expr) in [
            ("status", ValueExpr::Default),
            ("note", ValueExpr::Default),
            ("seen", ValueExpr::Now),
            ("day", ValueExpr::Now),
        ] {
            assert_eq!(
                engine.edit(&target(column, expr)).await.unwrap(),
                1,
                "{column}"
            );
        }
        let values = vec![
            InsertValue {
                column: "id".into(),
                value: Some("2".into()),
                expr: None,
            },
            InsertValue {
                column: "status".into(),
                value: None,
                expr: Some(ValueExpr::Default),
            },
            InsertValue {
                column: "seen".into(),
                value: None,
                expr: Some(ValueExpr::Now),
            },
            InsertValue {
                column: "day".into(),
                value: None,
                expr: Some(ValueExpr::Now),
            },
            InsertValue {
                column: "note".into(),
                value: Some("n".into()),
                expr: None,
            },
        ];
        assert_eq!(engine.insert_values(&table, &values).await.unwrap(), 1);
        let rows = engine.execute(&format!("SELECT id, status, note, abs(extract(epoch FROM now() - seen)) < 60, day = current_date FROM {table} ORDER BY id"), 2).await.unwrap();
        assert_eq!(
            rows.rows,
            vec![
                vec![
                    Value::from(1),
                    Value::from("new"),
                    Value::Null,
                    Value::from("true"),
                    Value::from("true")
                ],
                vec![
                    Value::from(2),
                    Value::from("new"),
                    Value::from("n"),
                    Value::from("true"),
                    Value::from("true")
                ]
            ]
        );
        engine
            .execute(&format!("DROP TABLE {table}"), 1)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn pg_cancel_interrupts_running_query() {
        let Some(config) = pg_config() else {
            return;
        };
        let engine = Arc::new(Engine::open_demo(1).unwrap());
        engine.swap_to_postgres(&config).await.unwrap();

        let query_engine = engine.clone();
        let handle =
            tokio::spawn(async move { query_engine.query("SELECT pg_sleep(30)", 10).await });
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        engine.cancel();
        let result = handle.await.unwrap();
        let err = match result {
            Ok(_) => panic!("취소되지 않았습니다"),
            Err(err) => err,
        };
        assert!(err.is_interrupted(), "err = {err}");
    }

    fn cockroach_config() -> Option<tablepeek_types::PostgresConfig> {
        std::env::var("TABLEPEEK_TEST_COCKROACH").ok()?;
        Some(tablepeek_types::PostgresConfig {
            host: "127.0.0.1".into(),
            port: 26258,
            user: "root".into(),
            password: None,
            database: "defaultdb".into(),
            ssl_mode: tablepeek_types::SslMode::Disable,
            ssl_root_cert: None,
            ssl_client_cert: None,
            ssl_client_key: None,
        })
    }

    #[tokio::test]
    async fn cockroach_set_value_writes_default_and_the_time() {
        let Some(config) = cockroach_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_cockroach(&config).await.unwrap();
        let table = format!("tablepeek_exprtest_{}", std::process::id());
        engine.execute(&format!("CREATE TABLE {table} (id INT8 PRIMARY KEY, status STRING DEFAULT 'new', note STRING, seen TIMESTAMPTZ, day DATE)"), 1).await.unwrap();
        engine
            .insert_row(
                &table,
                &[
                    ("id".to_string(), Some("1".to_string())),
                    ("status".to_string(), Some("old".to_string())),
                    ("note".to_string(), Some("x".to_string())),
                ],
            )
            .await
            .unwrap();
        let target = |column: &str, expr| EditTarget {
            table: table.clone(),
            pk: vec![PkValue {
                column: "id".into(),
                value: Value::from(1),
            }],
            column: column.into(),
            value: None,
            expr: Some(expr),
        };
        for (column, expr) in [
            ("status", ValueExpr::Default),
            ("note", ValueExpr::Default),
            ("seen", ValueExpr::Now),
            ("day", ValueExpr::Now),
        ] {
            assert_eq!(
                engine.edit(&target(column, expr)).await.unwrap(),
                1,
                "{column}"
            );
        }
        let values = vec![
            InsertValue {
                column: "id".into(),
                value: Some("2".into()),
                expr: None,
            },
            InsertValue {
                column: "status".into(),
                value: None,
                expr: Some(ValueExpr::Default),
            },
            InsertValue {
                column: "seen".into(),
                value: None,
                expr: Some(ValueExpr::Now),
            },
            InsertValue {
                column: "day".into(),
                value: None,
                expr: Some(ValueExpr::Now),
            },
            InsertValue {
                column: "note".into(),
                value: Some("n".into()),
                expr: None,
            },
        ];
        assert_eq!(engine.insert_values(&table, &values).await.unwrap(), 1);
        let rows = engine.execute(&format!("SELECT id, status, note, abs(extract(epoch FROM now() - seen)) < 60, day = current_date FROM {table} ORDER BY id"), 2).await.unwrap();
        assert_eq!(
            rows.rows,
            vec![
                vec![
                    Value::from(1),
                    Value::from("new"),
                    Value::Null,
                    Value::from("true"),
                    Value::from("true")
                ],
                vec![
                    Value::from(2),
                    Value::from("new"),
                    Value::from("n"),
                    Value::from("true"),
                    Value::from("true")
                ]
            ]
        );
        engine
            .execute(&format!("DROP TABLE {table}"), 1)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn cockroach_query_edit_tx_roundtrip() {
        let Some(config) = cockroach_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        let meta = engine.swap_to_cockroach(&config).await.unwrap();
        assert_eq!(meta.kind, "cockroach");
        assert!(meta.path.as_deref().unwrap().contains("defaultdb"));
        assert!(meta.tables.contains(&"users".to_string()));
        assert!(meta.tables.contains(&"orders".to_string()));
        assert!(!meta
            .tables
            .iter()
            .any(|table| table.contains("crdb_internal")));

        let schema = engine.schema(false).await.unwrap();
        let users = schema.iter().find(|table| table.name == "users").unwrap();
        let id_col = users.columns.iter().find(|col| col.name == "id").unwrap();
        assert!(id_col.pk);
        assert!(id_col.not_null);
        assert!(id_col.decl_type.is_some());
        assert!(!schema
            .iter()
            .any(|table| table.name.contains("crdb_internal")));

        let data = engine
            .query(
                "SELECT id, name, score, created_at FROM users ORDER BY id",
                10_000,
            )
            .await
            .unwrap();
        assert_eq!(data.kind, "cockroach");
        assert_eq!(data.row_count, 5000);
        assert_eq!(data.source_table.as_deref(), Some("users"));
        assert_eq!(data.pk.as_deref(), Some(&["id".to_string()][..]));
        let rows = data.rows_json();
        assert_eq!(rows[0][0], Value::from(1));
        assert_eq!(rows[0][1], Value::from("사용자_1"));
        assert!(rows[1][2].as_str().unwrap().parse::<f64>().is_ok());
        assert!(rows[0][3].as_str().unwrap().starts_with("2024-01-01 00:01"));

        let orders = engine
            .execute("SELECT count(*) FROM orders", 10)
            .await
            .unwrap();
        assert_eq!(orders.rows[0][0], Value::from(20_000));

        let target_id = i64::from(1 + std::process::id() % 4999);
        let baseline = engine
            .execute(
                &format!("SELECT score FROM users WHERE id = {target_id}"),
                1,
            )
            .await
            .unwrap()
            .rows[0][0]
            .clone();
        assert!(baseline.is_string());

        let target = EditTarget {
            table: "users".into(),
            pk: vec![PkValue {
                column: "id".into(),
                value: Value::from(target_id),
            }],
            column: "score".into(),
            value: Some("99.25".into()),
            expr: None,
        };
        assert_eq!(engine.edit(&target).await.unwrap(), 1);
        let check = engine
            .execute(
                &format!("SELECT score FROM users WHERE id = {target_id}"),
                1,
            )
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], Value::from("99.25"));

        engine.begin_tx().await.unwrap();
        let rolled = EditTarget {
            value: Some("11.11".into()),
            ..target.clone()
        };
        engine.edit(&rolled).await.unwrap();
        engine.rollback_tx().await.unwrap();
        let check = engine
            .execute(
                &format!("SELECT score FROM users WHERE id = {target_id}"),
                1,
            )
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], Value::from("99.25"));

        engine.begin_tx().await.unwrap();
        engine.edit(&rolled).await.unwrap();
        engine.commit_tx().await.unwrap();
        let check = engine
            .execute(
                &format!("SELECT score FROM users WHERE id = {target_id}"),
                1,
            )
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], Value::from("11.11"));

        let restored = EditTarget {
            value: baseline.as_str().map(str::to_string),
            ..target.clone()
        };
        engine.edit(&restored).await.unwrap();
        let check = engine
            .execute(
                &format!("SELECT score FROM users WHERE id = {target_id}"),
                1,
            )
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], baseline);

        let meta = engine.meta(false).await.unwrap();
        assert_eq!(meta.kind, "cockroach");
    }

    #[tokio::test]
    async fn cockroach_insert_delete_and_table_detail() {
        let Some(config) = cockroach_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_cockroach(&config).await.unwrap();

        let table = format!("tablepeek_rowtest_{}", std::process::id());
        let _ = engine
            .execute(&format!("DROP TABLE IF EXISTS {table}"), 1)
            .await;
        engine
            .execute(
                &format!(
                    "CREATE TABLE {table} (id INT8 PRIMARY KEY, name STRING NOT NULL, qty INT8 DEFAULT 0)"
                ),
                1,
            )
            .await
            .unwrap();

        let values = vec![
            ("id".to_string(), Some("41".to_string())),
            ("name".to_string(), Some("tablepeek_왕복".to_string())),
        ];
        assert_eq!(engine.insert_row(&table, &values).await.unwrap(), 1);
        let pk = vec![PkValue {
            column: "id".into(),
            value: Value::from(41),
        }];
        assert_eq!(engine.delete_row(&table, &pk).await.unwrap(), 1);
        assert_eq!(engine.delete_row(&table, &pk).await.unwrap(), 0);

        let detail = engine.table_detail(&table).await.unwrap();
        assert_eq!(detail.name, table);
        assert!(detail.row_count_estimate.is_some());
        let id_col = detail.columns.iter().find(|c| c.name == "id").unwrap();
        assert!(id_col.pk);
        assert!(detail.indexes.iter().any(|index| index.primary));

        // The estimate is the table statistics' row count, read without
        // crdb_internal (refused from v26.3).
        for sql in [
            format!(
                "INSERT INTO {table} (id, name) SELECT i, 'r' FROM generate_series(1, 37) AS g(i)"
            ),
            format!("CREATE STATISTICS tp_rows FROM {table}"),
        ] {
            engine.execute(&sql, 1).await.unwrap();
        }
        let detail = engine.table_detail(&table).await.unwrap();
        assert_eq!(detail.row_count_estimate, Some(37));

        engine
            .execute(&format!("DROP TABLE {table}"), 1)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn cockroach_cancel_interrupts_running_query() {
        let Some(config) = cockroach_config() else {
            return;
        };
        let engine = Arc::new(Engine::open_demo(1).unwrap());
        engine.swap_to_cockroach(&config).await.unwrap();

        let query_engine = engine.clone();
        let handle =
            tokio::spawn(async move { query_engine.query("SELECT pg_sleep(30)", 10).await });
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        engine.cancel();
        let result = handle.await.unwrap();
        let err = match result {
            Ok(_) => panic!("취소되지 않았습니다"),
            Err(err) => err,
        };
        assert!(err.is_interrupted(), "err = {err}");
    }

    fn mysql_tls_config() -> Option<tablepeek_types::MySqlConfig> {
        std::env::var("TABLEPEEK_TEST_MYSQL_TLS").ok()?;
        let ssl_root_cert = std::env::var("TABLEPEEK_TEST_MYSQL_TLS_CA").ok()?;
        Some(tablepeek_types::MySqlConfig {
            host: "127.0.0.1".into(),
            port: 3308,
            user: "root".into(),
            password: Some("root_pw".into()),
            database: "tablepeek_test".into(),
            ssl_mode: tablepeek_types::SslMode::Require,
            ssl_root_cert: Some(ssl_root_cert),
            ssl_client_cert: None,
            ssl_client_key: None,
        })
    }

    #[tokio::test]
    async fn mysql_tls_require_uses_encrypted_connection() {
        let Some(config) = mysql_tls_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        let meta = engine.swap_to_mysql(&config).await.unwrap();
        assert_eq!(meta.kind, "mysql");
        let data = engine
            .query("SHOW STATUS LIKE 'Ssl_cipher'", 10)
            .await
            .unwrap();
        assert!(data
            .cell_string(0, 1)
            .is_some_and(|cipher| !cipher.trim().is_empty()));
    }

    fn mysql_config() -> Option<tablepeek_types::MySqlConfig> {
        std::env::var("TABLEPEEK_TEST_MYSQL").ok()?;
        // Another port when 3307 is taken (a tunnel to a real server, say).
        let port = std::env::var("TABLEPEEK_TEST_MYSQL_PORT")
            .ok()
            .and_then(|port| port.parse().ok())
            .unwrap_or(3307);
        Some(tablepeek_types::MySqlConfig {
            host: "127.0.0.1".into(),
            port,
            user: "root".into(),
            password: Some("root_pw".into()),
            database: "tablepeek_test".into(),
            ssl_mode: tablepeek_types::SslMode::Disable,
            ssl_root_cert: None,
            ssl_client_cert: None,
            ssl_client_key: None,
        })
    }

    #[tokio::test]
    async fn mysql_an_edit_checks_the_key_again() {
        let Some(config) = mysql_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_mysql(&config).await.unwrap();
        let elsewhere = Engine::open_demo(1).unwrap();
        elsewhere.swap_to_mysql(&config).await.unwrap();
        for sql in [
            "DROP TABLE IF EXISTS tp_key",
            "CREATE TABLE tp_key (id INT NOT NULL, rev INT NOT NULL DEFAULT 0, \
             note VARCHAR(20), PRIMARY KEY (id))",
            "INSERT INTO tp_key VALUES (1, 0, 'a')",
        ] {
            engine.execute(sql, 1).await.unwrap();
        }
        let data = engine.query("SELECT * FROM tp_key", 10).await.unwrap();
        assert_eq!(data.pk, Some(vec!["id".to_string()]));

        // Another session widens the key, so id alone matches two rows.
        for sql in [
            "ALTER TABLE tp_key DROP PRIMARY KEY, ADD PRIMARY KEY (id, rev)",
            "INSERT INTO tp_key VALUES (1, 1, 'b')",
        ] {
            elsewhere.execute(sql, 1).await.unwrap();
        }
        // The kept lookup still says id…
        let data = engine.query("SELECT * FROM tp_key", 10).await.unwrap();
        assert_eq!(data.pk, Some(vec!["id".to_string()]));
        // …but a write asks again, refuses, and forgets it.
        let target = |table: &str| EditTarget {
            table: table.into(),
            pk: vec![PkValue {
                column: "id".into(),
                value: Value::from(1),
            }],
            column: "note".into(),
            value: Some("edited".into()),
            expr: None,
        };
        let err = engine.edit(&target("tp_key")).await.unwrap_err();
        assert!(matches!(err, EngineError::NotEditable(_)), "{err}");
        let err = engine
            .delete_row("tp_key", &target("tp_key").pk)
            .await
            .unwrap_err();
        assert!(matches!(err, EngineError::NotEditable(_)), "{err}");
        let notes = engine
            .query("SELECT note FROM tp_key ORDER BY rev", 10)
            .await
            .unwrap();
        assert_eq!(notes.cell_string(0, 0).as_deref(), Some("a"));
        assert_eq!(notes.cell_string(1, 0).as_deref(), Some("b"));
        let data = engine.query("SELECT * FROM tp_key", 10).await.unwrap();
        assert_eq!(data.pk, Some(vec!["id".to_string(), "rev".to_string()]));

        // A table dropped elsewhere says so, not that its key changed.
        elsewhere.execute("DROP TABLE tp_key", 1).await.unwrap();
        let err = engine.edit(&target("tp_key")).await.unwrap_err();
        assert!(matches!(err, EngineError::TableNotFound), "{err}");
    }

    #[tokio::test]
    async fn mysql_a_text_key_in_another_collation_is_found() {
        let Some(config) = mysql_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_mysql(&config).await.unwrap();
        // The connection and the key column collate differently, as with a
        // MySQL 8 table (utf8mb4_0900_ai_ci) read over utf8mb4_general_ci.
        for sql in [
            "SET NAMES utf8mb4 COLLATE utf8mb4_general_ci",
            "DROP TABLE IF EXISTS tp_coll",
            "CREATE TABLE tp_coll (code VARCHAR(20) COLLATE utf8mb4_0900_ai_ci NOT NULL, \
             note VARCHAR(20), PRIMARY KEY (code))",
            r"INSERT INTO tp_coll VALUES ('k1', 'a'), ('it''s \\ ok', 'b')",
        ] {
            engine.execute(sql, 1).await.unwrap();
        }
        let key = |code: &str| {
            vec![PkValue {
                column: "code".into(),
                value: Value::from(code),
            }]
        };
        let edit = |code: &str, note: &str| EditTarget {
            table: "tp_coll".into(),
            pk: key(code),
            column: "note".into(),
            value: Some(note.into()),
            expr: None,
        };
        assert_eq!(engine.edit(&edit("k1", "edited")).await.unwrap(), 1);
        assert_eq!(engine.edit(&edit(r"it's \ ok", "quoted")).await.unwrap(), 1);
        let notes = engine
            .query("SELECT note FROM tp_coll ORDER BY code", 10)
            .await
            .unwrap();
        assert_eq!(notes.cell_string(0, 0).as_deref(), Some("quoted"));
        assert_eq!(notes.cell_string(1, 0).as_deref(), Some("edited"));
        assert_eq!(engine.delete_row("tp_coll", &key("k1")).await.unwrap(), 1);

        // With NO_BACKSLASH_ESCAPES a backslash is an ordinary character.
        for sql in [
            "SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',NO_BACKSLASH_ESCAPES')",
            r"INSERT INTO tp_coll VALUES ('c:\x', 'c')",
        ] {
            engine.execute(sql, 1).await.unwrap();
        }
        assert_eq!(engine.edit(&edit(r"c:\x", "plain")).await.unwrap(), 1);
        assert_eq!(
            engine.delete_row("tp_coll", &key(r"c:\x")).await.unwrap(),
            1
        );
        assert_eq!(
            engine
                .delete_row("tp_coll", &key(r"it's \ ok"))
                .await
                .unwrap(),
            1
        );
        engine.execute("DROP TABLE tp_coll", 1).await.unwrap();
    }

    #[tokio::test]
    async fn mysql_editor_transactions_and_ddl_settle_history() {
        let Some(config) = mysql_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_mysql(&config).await.unwrap();
        let mut changes = engine.sql_log().take_changes().unwrap();
        for sql in [
            "DROP TABLE IF EXISTS tp_tx",
            "DROP TABLE IF EXISTS tp_tx_other",
            "CREATE TABLE tp_tx (id INT PRIMARY KEY, note VARCHAR(20))",
            "INSERT INTO tp_tx VALUES (1, 'a')",
        ] {
            engine.execute(sql, 1).await.unwrap();
        }
        let rename = |note: &str| EditTarget {
            table: "tp_tx".into(),
            pk: vec![PkValue {
                column: "id".into(),
                value: Value::from(1),
            }],
            column: "note".into(),
            value: Some(note.into()),
            expr: None,
        };

        engine.execute("START TRANSACTION", 1).await.unwrap();
        assert!(engine.in_tx().await.unwrap());
        engine.edit(&rename("b")).await.unwrap();
        assert!(drain_changes(&mut changes).is_empty());
        // DDL commits the open transaction first.
        engine
            .execute("CREATE TABLE tp_tx_other (id INT)", 1)
            .await
            .unwrap();
        assert!(!engine.in_tx().await.unwrap());
        assert_eq!(drain_changes(&mut changes).len(), 1);

        // DDL that fails has still committed the open transaction.
        engine.execute("START TRANSACTION", 1).await.unwrap();
        engine.edit(&rename("d")).await.unwrap();
        assert!(engine
            .execute("ALTER TABLE tp_tx_missing ADD c INT", 1)
            .await
            .is_err());
        assert!(!engine.in_tx().await.unwrap());
        assert_eq!(drain_changes(&mut changes).len(), 1);

        engine.execute("BEGIN", 1).await.unwrap();
        engine.edit(&rename("c")).await.unwrap();
        engine.execute("ROLLBACK", 1).await.unwrap();
        assert!(!engine.in_tx().await.unwrap());
        assert!(drain_changes(&mut changes).is_empty());

        engine.execute("DROP TABLE tp_tx", 1).await.unwrap();
        engine.execute("DROP TABLE tp_tx_other", 1).await.unwrap();
    }

    #[tokio::test]
    async fn mysql_query_edit_tx_roundtrip() {
        let Some(config) = mysql_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        let meta = engine.swap_to_mysql(&config).await.unwrap();
        assert_eq!(meta.kind, "mysql");
        assert!(meta.path.as_deref().unwrap().contains("tablepeek_test"));
        assert!(meta.tables.contains(&"users".to_string()));
        assert!(meta.tables.contains(&"orders".to_string()));

        let schema = engine.schema(false).await.unwrap();
        let users = schema.iter().find(|table| table.name == "users").unwrap();
        let id_col = users.columns.iter().find(|col| col.name == "id").unwrap();
        assert!(id_col.pk);
        assert!(id_col.not_null);
        let score_col = users
            .columns
            .iter()
            .find(|col| col.name == "score")
            .unwrap();
        assert!(!score_col.pk);

        let data = engine
            .query(
                "SELECT id, name, score, created_at FROM users ORDER BY id",
                10_000,
            )
            .await
            .unwrap();
        assert_eq!(data.row_count, 5000);
        assert_eq!(data.source_table.as_deref(), Some("users"));
        assert_eq!(data.pk.as_deref(), Some(&["id".to_string()][..]));
        let rows = data.rows_json();
        assert_eq!(rows[0][0], Value::from(1));
        assert_eq!(rows[0][1], Value::from("사용자_1"));
        assert!(rows[1][2].as_str().unwrap().parse::<f64>().is_ok());
        assert!(rows[0][3].as_str().unwrap().starts_with("2024-01-01 00:01"));

        let target_id = i64::from(1 + std::process::id() % 4999);
        let baseline = engine
            .execute(
                &format!("SELECT score FROM users WHERE id = {target_id}"),
                1,
            )
            .await
            .unwrap()
            .rows[0][0]
            .clone();
        assert!(baseline.is_string());

        let orders = engine
            .execute("SELECT count(*) FROM orders", 10)
            .await
            .unwrap();
        assert_eq!(orders.rows[0][0], Value::from(20_000));

        let target = EditTarget {
            table: "users".into(),
            pk: vec![PkValue {
                column: "id".into(),
                value: Value::from(target_id),
            }],
            column: "score".into(),
            value: Some("99.25".into()),
            expr: None,
        };
        assert_eq!(engine.edit(&target).await.unwrap(), 1);
        let check = engine
            .execute(
                &format!("SELECT score FROM users WHERE id = {target_id}"),
                1,
            )
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], Value::from("99.25"));

        engine.begin_tx().await.unwrap();
        assert!(engine.in_tx().await.unwrap());
        let rolled = EditTarget {
            value: Some("11.11".into()),
            ..target.clone()
        };
        engine.edit(&rolled).await.unwrap();
        engine.rollback_tx().await.unwrap();
        assert!(!engine.in_tx().await.unwrap());
        let check = engine
            .execute(
                &format!("SELECT score FROM users WHERE id = {target_id}"),
                1,
            )
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], Value::from("99.25"));

        engine.begin_tx().await.unwrap();
        engine.edit(&rolled).await.unwrap();
        engine.commit_tx().await.unwrap();
        let check = engine
            .execute(
                &format!("SELECT score FROM users WHERE id = {target_id}"),
                1,
            )
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], Value::from("11.11"));

        let restored = EditTarget {
            value: baseline.as_str().map(str::to_string),
            ..target.clone()
        };
        engine.edit(&restored).await.unwrap();
        let check = engine
            .execute(
                &format!("SELECT score FROM users WHERE id = {target_id}"),
                1,
            )
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], baseline);
    }

    #[tokio::test]
    async fn mysql_insert_delete_and_table_detail() {
        let Some(config) = mysql_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_mysql(&config).await.unwrap();

        let table = format!("tablepeek_rowtest_{}", std::process::id());
        engine
            .execute(
                &format!(
                    "CREATE TABLE {table} (id int PRIMARY KEY, name varchar(50) NOT NULL, qty int DEFAULT 0)"
                ),
                1,
            )
            .await
            .unwrap();

        let values = vec![
            ("id".to_string(), Some("41".to_string())),
            ("name".to_string(), Some("tablepeek_왕복".to_string())),
        ];
        assert_eq!(engine.insert_row(&table, &values).await.unwrap(), 1);
        let pk = vec![PkValue {
            column: "id".into(),
            value: Value::from(41),
        }];
        assert_eq!(engine.delete_row(&table, &pk).await.unwrap(), 1);
        assert_eq!(engine.delete_row(&table, &pk).await.unwrap(), 0);

        let detail = engine.table_detail(&table).await.unwrap();
        assert_eq!(detail.name, table);
        assert!(detail.row_count_estimate.is_some());
        assert!(detail.size_bytes.is_some());
        let id_col = detail.columns.iter().find(|c| c.name == "id").unwrap();
        assert!(id_col.pk);
        assert!(detail.indexes.iter().any(|index| index.primary));
        assert!(detail.ddl.as_deref().unwrap().contains("CREATE TABLE"));

        engine
            .execute(&format!("DROP TABLE {table}"), 1)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn mysql_set_value_writes_default_and_the_time() {
        let Some(config) = mysql_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_mysql(&config).await.unwrap();
        let table = format!("tablepeek_exprtest_{}", std::process::id());
        engine.execute(&format!("CREATE TABLE {table} (id INT PRIMARY KEY, status VARCHAR(20) DEFAULT 'new', note VARCHAR(20) NULL, seen DATETIME NULL, day DATE NULL)"), 1).await.unwrap();
        engine
            .insert_row(
                &table,
                &[
                    ("id".to_string(), Some("1".to_string())),
                    ("status".to_string(), Some("old".to_string())),
                    ("note".to_string(), Some("x".to_string())),
                ],
            )
            .await
            .unwrap();
        let target = |column: &str, expr| EditTarget {
            table: table.clone(),
            pk: vec![PkValue {
                column: "id".into(),
                value: Value::from(1),
            }],
            column: column.into(),
            value: None,
            expr: Some(expr),
        };
        for (column, expr) in [
            ("status", ValueExpr::Default),
            ("note", ValueExpr::Default),
            ("seen", ValueExpr::Now),
            ("day", ValueExpr::Now),
        ] {
            assert_eq!(
                engine.edit(&target(column, expr)).await.unwrap(),
                1,
                "{column}"
            );
        }
        let values = vec![
            InsertValue {
                column: "id".into(),
                value: Some("2".into()),
                expr: None,
            },
            InsertValue {
                column: "status".into(),
                value: None,
                expr: Some(ValueExpr::Default),
            },
            InsertValue {
                column: "seen".into(),
                value: None,
                expr: Some(ValueExpr::Now),
            },
            InsertValue {
                column: "day".into(),
                value: None,
                expr: Some(ValueExpr::Now),
            },
            InsertValue {
                column: "note".into(),
                value: Some("n".into()),
                expr: None,
            },
        ];
        assert_eq!(engine.insert_values(&table, &values).await.unwrap(), 1);
        let rows = engine.execute(&format!("SELECT id, status, note, ABS(TIMESTAMPDIFF(SECOND, seen, NOW())) < 60, day = CURDATE() FROM {table} ORDER BY id"), 2).await.unwrap();
        assert_eq!(
            rows.rows,
            vec![
                vec![
                    Value::from(1),
                    Value::from("new"),
                    Value::Null,
                    Value::from(1),
                    Value::from(1)
                ],
                vec![
                    Value::from(2),
                    Value::from("new"),
                    Value::from("n"),
                    Value::from(1),
                    Value::from(1)
                ]
            ]
        );
        engine
            .execute(&format!("DROP TABLE {table}"), 1)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn mysql_cancel_interrupts_running_query() {
        let Some(config) = mysql_config() else {
            return;
        };
        let engine = Arc::new(Engine::open_demo(1).unwrap());
        engine.swap_to_mysql(&config).await.unwrap();

        let query_engine = engine.clone();
        let handle = tokio::spawn(async move {
            query_engine
                .query(
                    "SELECT COUNT(*) FROM orders a JOIN orders b ON a.user_id + b.user_id > 0",
                    10,
                )
                .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        engine.cancel();
        let result = handle.await.unwrap();
        let err = match result {
            Ok(_) => panic!("취소되지 않았습니다"),
            Err(err) => err,
        };
        assert!(err.is_interrupted(), "err = {err}");
    }

    // SQL Server's catalog views lock the same system rows that DDL in another
    // session of the database takes, so a schema read running beside another
    // test's CREATE or DROP TABLE is picked as a deadlock victim (error 1205),
    // whatever the tables are called. The tests that use the server take turns;
    // the guard is held until the test ends.
    static MSSQL_TURN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    async fn mssql_config() -> Option<(
        tablepeek_types::MssqlConfig,
        tokio::sync::MutexGuard<'static, ()>,
    )> {
        std::env::var("TABLEPEEK_TEST_MSSQL").ok()?;
        let turn = MSSQL_TURN.lock().await;
        let config = tablepeek_types::MssqlConfig {
            host: "127.0.0.1".into(),
            port: 14330,
            user: "sa".into(),
            password: Some("MsSql_test_pw1".into()),
            database: "tablepeek_test".into(),
            encrypt: false,
        };
        Some((config, turn))
    }

    #[tokio::test]
    async fn mssql_an_edit_checks_the_key_again() {
        let Some((config, _turn)) = mssql_config().await else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_mssql(&config).await.unwrap();
        let elsewhere = Engine::open_demo(1).unwrap();
        elsewhere.swap_to_mssql(&config).await.unwrap();
        for sql in [
            "DROP TABLE IF EXISTS tp_key",
            "CREATE TABLE tp_key (id INT NOT NULL, rev INT NOT NULL DEFAULT 0, \
             note NVARCHAR(20), CONSTRAINT tp_key_pk PRIMARY KEY (id))",
            "INSERT INTO tp_key VALUES (1, 0, 'a')",
        ] {
            engine.execute(sql, 1).await.unwrap();
        }
        let data = engine.query("SELECT * FROM tp_key", 10).await.unwrap();
        assert_eq!(data.pk, Some(vec!["id".to_string()]));

        // Another session widens the key, so id alone matches two rows.
        for sql in [
            "ALTER TABLE tp_key DROP CONSTRAINT tp_key_pk",
            "ALTER TABLE tp_key ADD CONSTRAINT tp_key_pk PRIMARY KEY (id, rev)",
            "INSERT INTO tp_key VALUES (1, 1, 'b')",
        ] {
            elsewhere.execute(sql, 1).await.unwrap();
        }
        // The kept lookup still says id…
        let data = engine.query("SELECT * FROM tp_key", 10).await.unwrap();
        assert_eq!(data.pk, Some(vec!["id".to_string()]));
        // …but a write asks again, refuses, and forgets it.
        let target = EditTarget {
            table: "tp_key".into(),
            pk: vec![PkValue {
                column: "id".into(),
                value: Value::from(1),
            }],
            column: "note".into(),
            value: Some("edited".into()),
            expr: None,
        };
        let err = engine.edit(&target).await.unwrap_err();
        assert!(matches!(err, EngineError::NotEditable(_)), "{err}");
        let err = engine.delete_row("tp_key", &target.pk).await.unwrap_err();
        assert!(matches!(err, EngineError::NotEditable(_)), "{err}");
        let notes = engine
            .query("SELECT note FROM tp_key ORDER BY rev", 10)
            .await
            .unwrap();
        assert_eq!(notes.cell_string(0, 0).as_deref(), Some("a"));
        assert_eq!(notes.cell_string(1, 0).as_deref(), Some("b"));
        let data = engine.query("SELECT * FROM tp_key", 10).await.unwrap();
        assert_eq!(data.pk, Some(vec!["id".to_string(), "rev".to_string()]));

        // A table dropped elsewhere says so, not that its key changed.
        elsewhere.execute("DROP TABLE tp_key", 1).await.unwrap();
        let err = engine.edit(&target).await.unwrap_err();
        assert!(matches!(err, EngineError::TableNotFound), "{err}");
    }

    #[tokio::test]
    async fn mssql_query_edit_tx_roundtrip() {
        let Some((config, _turn)) = mssql_config().await else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        let meta = engine.swap_to_mssql(&config).await.unwrap();
        assert_eq!(meta.kind, "mssql");
        assert!(meta.path.as_deref().unwrap().contains("tablepeek_test"));
        assert!(meta.tables.contains(&"users".to_string()));
        assert!(meta.tables.contains(&"orders".to_string()));

        let schema = engine.schema(false).await.unwrap();
        let users = schema.iter().find(|table| table.name == "users").unwrap();
        let id_col = users.columns.iter().find(|col| col.name == "id").unwrap();
        assert!(id_col.pk);
        assert!(id_col.not_null);
        assert_eq!(id_col.decl_type.as_deref(), Some("int"));
        let name_col = users.columns.iter().find(|col| col.name == "name").unwrap();
        assert_eq!(name_col.decl_type.as_deref(), Some("nvarchar(50)"));
        assert!(name_col.not_null);
        let score_col = users
            .columns
            .iter()
            .find(|col| col.name == "score")
            .unwrap();
        assert!(!score_col.pk);
        assert_eq!(score_col.decl_type.as_deref(), Some("decimal(10,2)"));

        let data = engine
            .query(
                "SELECT id, name, score, created_at FROM users ORDER BY id",
                10_000,
            )
            .await
            .unwrap();
        assert_eq!(data.kind, "mssql");
        assert_eq!(data.row_count, 5000);
        assert_eq!(data.source_table.as_deref(), Some("users"));
        assert_eq!(data.pk.as_deref(), Some(&["id".to_string()][..]));
        let rows = data.rows_json();
        assert_eq!(rows[0][0], Value::from(1));
        assert_eq!(rows[0][1], Value::from("사용자_1"));
        assert!(rows[1][2].as_str().unwrap().parse::<f64>().is_ok());
        assert!(rows[0][3].as_str().unwrap().starts_with("2024-01-01 00:01"));

        let orders = engine
            .execute("SELECT count(*) FROM orders", 10)
            .await
            .unwrap();
        assert_eq!(orders.rows[0][0], Value::from(20_000));

        let target_id = i64::from(1 + std::process::id() % 4999);
        let baseline = engine
            .execute(
                &format!("SELECT score FROM users WHERE id = {target_id}"),
                1,
            )
            .await
            .unwrap()
            .rows[0][0]
            .clone();
        assert!(baseline.is_string());

        let target = EditTarget {
            table: "users".into(),
            pk: vec![PkValue {
                column: "id".into(),
                value: Value::from(target_id),
            }],
            column: "score".into(),
            value: Some("99.25".into()),
            expr: None,
        };
        assert_eq!(engine.edit(&target).await.unwrap(), 1);
        let check = engine
            .execute(
                &format!("SELECT score FROM users WHERE id = {target_id}"),
                1,
            )
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], Value::from("99.25"));

        engine.begin_tx().await.unwrap();
        assert!(engine.in_tx().await.unwrap());
        let rolled = EditTarget {
            value: Some("11.11".into()),
            ..target.clone()
        };
        engine.edit(&rolled).await.unwrap();
        engine.rollback_tx().await.unwrap();
        assert!(!engine.in_tx().await.unwrap());
        let check = engine
            .execute(
                &format!("SELECT score FROM users WHERE id = {target_id}"),
                1,
            )
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], Value::from("99.25"));

        engine.begin_tx().await.unwrap();
        engine.edit(&rolled).await.unwrap();
        engine.commit_tx().await.unwrap();
        let check = engine
            .execute(
                &format!("SELECT score FROM users WHERE id = {target_id}"),
                1,
            )
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], Value::from("11.11"));

        let name_target = EditTarget {
            column: "name".into(),
            value: Some("이름수정".into()),
            ..target.clone()
        };
        assert_eq!(engine.edit(&name_target).await.unwrap(), 1);
        let check = engine
            .execute(&format!("SELECT name FROM users WHERE id = {target_id}"), 1)
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], Value::from("이름수정"));
        let restore_name = EditTarget {
            value: Some(format!("사용자_{target_id}")),
            ..name_target
        };
        engine.edit(&restore_name).await.unwrap();

        let restored = EditTarget {
            value: baseline.as_str().map(str::to_string),
            ..target.clone()
        };
        engine.edit(&restored).await.unwrap();
        let check = engine
            .execute(
                &format!("SELECT score FROM users WHERE id = {target_id}"),
                1,
            )
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], baseline);
    }

    #[tokio::test]
    async fn mssql_insert_delete_and_table_detail() {
        let Some((config, _turn)) = mssql_config().await else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_mssql(&config).await.unwrap();

        let table = format!("tablepeek_rowtest_{}", std::process::id());
        engine
            .execute(
                &format!(
                    "CREATE TABLE {table} (id int PRIMARY KEY, name nvarchar(50) NOT NULL, qty int DEFAULT 0)"
                ),
                1,
            )
            .await
            .unwrap();

        let values = vec![
            ("id".to_string(), Some("41".to_string())),
            ("name".to_string(), Some("tablepeek_왕복".to_string())),
        ];
        assert_eq!(engine.insert_row(&table, &values).await.unwrap(), 1);
        let pk = vec![PkValue {
            column: "id".into(),
            value: Value::from(41),
        }];
        assert_eq!(engine.delete_row(&table, &pk).await.unwrap(), 1);
        assert_eq!(engine.delete_row(&table, &pk).await.unwrap(), 0);

        let detail = engine.table_detail(&table).await.unwrap();
        assert_eq!(detail.name, table);
        assert!(detail.row_count_estimate.is_some());
        assert!(detail.size_bytes.is_some());
        let id_col = detail.columns.iter().find(|c| c.name == "id").unwrap();
        assert!(id_col.pk);
        assert!(detail.indexes.iter().any(|index| index.primary));
        assert!(detail.ddl.as_deref().unwrap().contains("CREATE TABLE"));

        engine
            .execute(&format!("DROP TABLE {table}"), 1)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn mssql_set_value_writes_default_and_the_time() {
        let Some((config, _turn)) = mssql_config().await else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_mssql(&config).await.unwrap();
        let table = format!("tablepeek_exprtest_{}", std::process::id());
        engine.execute(&format!("CREATE TABLE {table} (id INT PRIMARY KEY, status NVARCHAR(20) DEFAULT 'new', note NVARCHAR(20) NULL, seen DATETIME2 NULL, day DATE NULL)"), 1).await.unwrap();
        engine
            .insert_row(
                &table,
                &[
                    ("id".to_string(), Some("1".to_string())),
                    ("status".to_string(), Some("old".to_string())),
                    ("note".to_string(), Some("x".to_string())),
                ],
            )
            .await
            .unwrap();
        let target = |column: &str, expr| EditTarget {
            table: table.clone(),
            pk: vec![PkValue {
                column: "id".into(),
                value: Value::from(1),
            }],
            column: column.into(),
            value: None,
            expr: Some(expr),
        };
        for (column, expr) in [
            ("status", ValueExpr::Default),
            ("note", ValueExpr::Default),
            ("seen", ValueExpr::Now),
            ("day", ValueExpr::Now),
        ] {
            assert_eq!(
                engine.edit(&target(column, expr)).await.unwrap(),
                1,
                "{column}"
            );
        }
        let values = vec![
            InsertValue {
                column: "id".into(),
                value: Some("2".into()),
                expr: None,
            },
            InsertValue {
                column: "status".into(),
                value: None,
                expr: Some(ValueExpr::Default),
            },
            InsertValue {
                column: "seen".into(),
                value: None,
                expr: Some(ValueExpr::Now),
            },
            InsertValue {
                column: "day".into(),
                value: None,
                expr: Some(ValueExpr::Now),
            },
            InsertValue {
                column: "note".into(),
                value: Some("n".into()),
                expr: None,
            },
        ];
        assert_eq!(engine.insert_values(&table, &values).await.unwrap(), 1);
        let rows = engine.execute(&format!("SELECT id, status, note, CASE WHEN ABS(DATEDIFF(SECOND, seen, GETDATE())) < 60 THEN 1 ELSE 0 END, CASE WHEN day = CAST(GETDATE() AS date) THEN 1 ELSE 0 END FROM {table} ORDER BY id"), 2).await.unwrap();
        assert_eq!(
            rows.rows,
            vec![
                vec![
                    Value::from(1),
                    Value::from("new"),
                    Value::Null,
                    Value::from(1),
                    Value::from(1)
                ],
                vec![
                    Value::from(2),
                    Value::from("new"),
                    Value::from("n"),
                    Value::from(1),
                    Value::from(1)
                ]
            ]
        );
        engine
            .execute(&format!("DROP TABLE {table}"), 1)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn mssql_cancel_interrupts_running_query() {
        let Some((config, _turn)) = mssql_config().await else {
            return;
        };
        let engine = Arc::new(Engine::open_demo(1).unwrap());
        engine.swap_to_mssql(&config).await.unwrap();

        let query_engine = engine.clone();
        let handle =
            tokio::spawn(async move { query_engine.query("WAITFOR DELAY '00:00:30'", 10).await });
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
        engine.cancel();
        let result = handle.await.unwrap();
        let err = match result {
            Ok(_) => panic!("취소되지 않았습니다"),
            Err(err) => err,
        };
        assert!(err.is_interrupted(), "err = {err}");

        let check = engine.execute("SELECT 1 AS one", 1).await.unwrap();
        assert_eq!(check.rows[0][0], Value::from(1));
    }

    #[tokio::test]
    async fn edit_without_pk_is_rejected() {
        let engine = Engine::open_demo(1).unwrap();
        let err = engine
            .edit(&EditTarget {
                table: "demo".into(),
                pk: vec![],
                column: "name".into(),
                value: Some("x".into()),
                expr: None,
            })
            .await
            .unwrap_err();
        assert!(matches!(err, EngineError::NotEditable(_)));
    }

    #[tokio::test]
    async fn sqlite_table_detail_lists_triggers() {
        let db = temp_db("triggers");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE jobs (id INTEGER PRIMARY KEY, state TEXT);
                 CREATE TABLE audit (note TEXT);
                 CREATE TRIGGER jobs_ai AFTER INSERT ON jobs
                 BEGIN INSERT INTO audit VALUES ('in'); END;
                 CREATE TRIGGER jobs_bd BEFORE DELETE ON jobs
                 BEGIN INSERT INTO audit VALUES ('out'); END;",
            )
            .unwrap();
        }

        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_file(&db).await.unwrap();

        let detail = engine.table_detail("jobs").await.unwrap();
        let names: Vec<&str> = detail.triggers.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["jobs_ai", "jobs_bd"]);
        assert!(detail.triggers[0]
            .definition
            .as_deref()
            .unwrap()
            .contains("AFTER INSERT ON jobs"));
        assert!(engine
            .table_detail("audit")
            .await
            .unwrap()
            .triggers
            .is_empty());
    }

    #[test]
    fn trigger_timing_event_parses_pg_definition() {
        let parsed = crate::postgres::trigger_timing_event(
            "CREATE TRIGGER t BEFORE INSERT OR UPDATE OF a, b ON public.x FOR EACH ROW EXECUTE FUNCTION f()",
        );
        assert_eq!(
            parsed,
            (Some("BEFORE".into()), Some("INSERT OR UPDATE".into()))
        );
        let parsed = crate::postgres::trigger_timing_event(
            "CREATE TRIGGER t INSTEAD OF DELETE ON v FOR EACH ROW EXECUTE FUNCTION f()",
        );
        assert_eq!(parsed, (Some("INSTEAD OF".into()), Some("DELETE".into())));
    }

    #[tokio::test]
    async fn sqlite_insert_delete_and_table_detail() {
        let db = temp_db("rowops");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE items (
                     id INTEGER PRIMARY KEY,
                     name TEXT NOT NULL DEFAULT '무명',
                     qty INTEGER DEFAULT 0
                 );
                 CREATE UNIQUE INDEX items_name_idx ON items(name);
                 INSERT INTO items (name, qty) VALUES ('기존', 1);",
            )
            .unwrap();
        }

        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_file(&db).await.unwrap();

        assert_eq!(engine.insert_row("items", &[]).await.unwrap(), 1);
        let rows = engine
            .execute("SELECT name, qty FROM items WHERE id = 2", 1)
            .await
            .unwrap();
        assert_eq!(rows.rows[0][0], Value::from("무명"));
        assert_eq!(rows.rows[0][1], Value::from(0));

        let values = vec![
            ("name".to_string(), Some("삽입".to_string())),
            ("qty".to_string(), Some("7".to_string())),
        ];
        assert_eq!(engine.insert_row("items", &values).await.unwrap(), 1);
        let rows = engine
            .execute("SELECT name, qty FROM items WHERE id = 3", 1)
            .await
            .unwrap();
        assert_eq!(rows.rows[0][0], Value::from("삽입"));
        assert_eq!(rows.rows[0][1], Value::from(7));

        let err = engine.delete_row("items", &[]).await.unwrap_err();
        assert!(matches!(err, EngineError::BadRequest(_)));
        assert_eq!(err.to_string(), "PK 조건이 필요합니다");

        let pk = vec![PkValue {
            column: "id".into(),
            value: Value::from(3),
        }];
        assert_eq!(engine.delete_row("items", &pk).await.unwrap(), 1);
        assert_eq!(engine.delete_row("items", &pk).await.unwrap(), 0);

        let detail = engine.table_detail("items").await.unwrap();
        assert_eq!(detail.name, "items");
        assert_eq!(detail.row_count_estimate, Some(2));
        assert_eq!(
            detail.size_bytes,
            detail
                .data_bytes
                .zip(detail.index_bytes)
                .map(|(data, index)| data + index)
        );
        assert!(detail.foreign_keys.is_empty());

        let id_col = detail.columns.iter().find(|c| c.name == "id").unwrap();
        assert!(id_col.pk);
        let name_col = detail.columns.iter().find(|c| c.name == "name").unwrap();
        assert!(name_col.not_null);
        assert_eq!(name_col.default.as_deref(), Some("'무명'"));
        let qty_col = detail.columns.iter().find(|c| c.name == "qty").unwrap();
        assert_eq!(qty_col.default.as_deref(), Some("0"));

        let index = detail
            .indexes
            .iter()
            .find(|index| index.name == "items_name_idx")
            .unwrap();
        assert!(index.unique);
        assert!(!index.primary);
        assert_eq!(index.columns, vec!["name".to_string()]);

        let ddl = detail.ddl.unwrap();
        assert!(ddl.contains("CREATE TABLE"));
        assert!(ddl.contains("items_name_idx"));

        std::fs::remove_file(&db).unwrap();
    }

    #[tokio::test]
    async fn sqlite_table_detail_sizes() {
        let db = temp_db("sizes");
        let dbstat_available = {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
                 CREATE INDEX notes_body_idx ON notes(body);
                 INSERT INTO notes (body) VALUES ('a'), ('b'), ('c');
                 CREATE VIEW notes_view AS SELECT body FROM notes;",
            )
            .unwrap();
            conn.query_row("SELECT count(*) FROM dbstat", [], |row| {
                row.get::<_, i64>(0)
            })
            .is_ok()
        };

        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_file(&db).await.unwrap();

        let detail = engine.table_detail("notes").await.unwrap();
        assert_eq!(detail.data_bytes.is_some(), dbstat_available);
        assert_eq!(detail.index_bytes.is_some(), dbstat_available);
        if let (Some(data), Some(index)) = (detail.data_bytes, detail.index_bytes) {
            assert!(data > 0);
            assert!(index > 0);
            assert_eq!(detail.size_bytes, Some(data + index));
        } else {
            assert!(detail.size_bytes.is_none());
        }
        assert!(detail.comment.is_none());

        let view = engine.table_detail("notes_view").await.unwrap();
        assert!(view.data_bytes.is_none());
        assert!(view.index_bytes.is_none());
        assert!(view.size_bytes.is_none());

        std::fs::remove_file(&db).unwrap();
    }

    #[tokio::test]
    async fn open_file_and_swap() {
        let db = temp_db("swap");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE people(name TEXT); INSERT INTO people VALUES ('a'), ('b');",
            )
            .unwrap();
        }

        let engine = Engine::open_demo(5).unwrap();
        let meta = engine.swap_to_file(&db).await.unwrap();
        assert!(!meta.demo);
        assert_eq!(meta.path.as_deref(), Some(db.to_str().unwrap()));
        assert_eq!(meta.tables, vec!["people"]);

        let schema = engine.schema(false).await.unwrap();
        assert_eq!(schema[0].name, "people");
        assert_eq!(schema[0].columns[0].name, "name");

        let meta = engine.swap_to_demo(7).await.unwrap();
        assert!(meta.demo);
        let result = engine
            .execute("SELECT count(*) FROM demo", 10)
            .await
            .unwrap();
        assert_eq!(result.rows[0][0], Value::from(7));

        std::fs::remove_file(&db).unwrap();
    }

    #[tokio::test]
    async fn missing_file_is_not_found() {
        let engine = Engine::open_demo(1).unwrap();
        let missing = temp_db("missing");
        let err = engine.swap_to_file(&missing).await.unwrap_err();
        assert!(matches!(err, EngineError::NotFound(_)));
        assert!(engine.meta(false).await.unwrap().demo);
    }

    #[tokio::test]
    async fn junk_file_is_not_a_sqlite_file() {
        let junk = temp_db("junk");
        std::fs::write(&junk, b"not a database at all, just plain text bytes").unwrap();
        let err = match Engine::open_file(&junk) {
            Ok(_) => panic!("junk file must not open"),
            Err(err) => err,
        };
        assert!(matches!(err, EngineError::NotAFile(_)));
        std::fs::remove_file(&junk).unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_interrupts_running_query() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let engine = Arc::new(Engine::open_demo(20_000).unwrap());
        let engine_for_task = engine.clone();
        let handle = tokio::spawn(async move {
            engine_for_task
                .query("SELECT count(*) FROM demo a, demo b, demo c", 10)
                .await
        });

        let done = Arc::new(AtomicBool::new(false));
        let done_for_canceler = done.clone();
        let engine_for_canceler = engine.clone();
        let canceler = tokio::spawn(async move {
            loop {
                if done_for_canceler.load(Ordering::Relaxed) {
                    break;
                }
                engine_for_canceler.cancel();
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        });

        let result = tokio::time::timeout(std::time::Duration::from_secs(10), handle)
            .await
            .expect("query did not stop after cancel")
            .unwrap();
        done.store(true, Ordering::Relaxed);
        let _ = canceler.await;

        let err = match result {
            Ok(_) => panic!("query should have been interrupted"),
            Err(err) => err,
        };
        assert!(err.is_interrupted(), "expected interrupt, got {err:?}");
    }

    fn relation(table: &str, columns: &[&str], ref_table: &str, ref_columns: &[&str]) -> Relation {
        let owned = |names: &[&str]| names.iter().map(|name| name.to_string()).collect();
        Relation {
            table: table.into(),
            columns: owned(columns),
            ref_table: ref_table.into(),
            ref_columns: owned(ref_columns),
        }
    }

    /// The relations among the given tables, in a fixed order.
    async fn relations_of(engine: &Engine, tables: &[&str]) -> Vec<Relation> {
        let mut relations: Vec<Relation> = engine
            .relations(false)
            .await
            .unwrap()
            .into_iter()
            .filter(|relation| tables.contains(&relation.table.as_str()))
            .collect();
        relations.sort_by(|a, b| (&a.table, &a.columns).cmp(&(&b.table, &b.columns)));
        relations
    }

    #[tokio::test]
    async fn sqlite_relations_list_every_foreign_key() {
        let engine = Engine::open_demo(1).unwrap();
        for sql in [
            "CREATE TABLE parent (a INTEGER, b INTEGER, PRIMARY KEY (a, b))",
            "CREATE TABLE child (id INTEGER PRIMARY KEY, pb INTEGER, pa INTEGER, \
             FOREIGN KEY (pb, pa) REFERENCES parent (b, a))",
            "CREATE TABLE note (id INTEGER PRIMARY KEY, child_id INTEGER REFERENCES child, \
             x INTEGER, y INTEGER, FOREIGN KEY (x, y) REFERENCES parent)",
        ] {
            engine.execute(sql, 1).await.unwrap();
        }
        let all = engine.relations(false).await.unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(
            relations_of(&engine, &["child", "note"]).await,
            vec![
                relation("child", &["pb", "pa"], "parent", &["b", "a"]),
                relation("note", &["child_id"], "child", &["id"]),
                relation("note", &["x", "y"], "parent", &["a", "b"]),
            ]
        );
    }

    /// Creates a composite and a single-column key, one of them from a table
    /// outside the default schema, checks them, and drops the tables again.
    async fn check_server_relations(engine: &Engine, setup: &[&str], teardown: &[&str]) {
        for sql in teardown.iter().chain(setup) {
            engine.execute(sql, 1).await.unwrap();
        }
        let relations = relations_of(engine, &["tp_rel_child", "tp_rel.tp_rel_item"]).await;
        for sql in teardown {
            engine.execute(sql, 1).await.unwrap();
        }
        assert_eq!(
            relations,
            vec![
                relation("tp_rel.tp_rel_item", &["child_id"], "tp_rel_child", &["id"]),
                relation("tp_rel_child", &["pb", "pa"], "tp_rel_parent", &["b", "a"]),
            ]
        );
    }

    const PG_RELATION_SETUP: &[&str] = &[
        "CREATE SCHEMA tp_rel",
        "CREATE TABLE tp_rel_parent (a INT, b INT, PRIMARY KEY (a, b))",
        "CREATE TABLE tp_rel_child (id INT PRIMARY KEY, pb INT, pa INT, \
         FOREIGN KEY (pb, pa) REFERENCES tp_rel_parent (b, a))",
        "CREATE TABLE tp_rel.tp_rel_item (id INT PRIMARY KEY, \
         child_id INT REFERENCES tp_rel_child (id))",
    ];
    const PG_RELATION_TEARDOWN: &[&str] = &[
        "DROP TABLE IF EXISTS tp_rel.tp_rel_item",
        "DROP SCHEMA IF EXISTS tp_rel",
        "DROP TABLE IF EXISTS tp_rel_child",
        "DROP TABLE IF EXISTS tp_rel_parent",
    ];

    #[tokio::test]
    async fn pg_relations_list_every_foreign_key() {
        let Some(config) = pg_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_postgres(&config).await.unwrap();
        check_server_relations(&engine, PG_RELATION_SETUP, PG_RELATION_TEARDOWN).await;
    }

    #[tokio::test]
    async fn cockroach_relations_list_every_foreign_key() {
        let Some(config) = cockroach_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_cockroach(&config).await.unwrap();
        check_server_relations(&engine, PG_RELATION_SETUP, PG_RELATION_TEARDOWN).await;
    }

    #[tokio::test]
    async fn mysql_relations_list_every_foreign_key() {
        let Some(config) = mysql_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_mysql(&config).await.unwrap();
        for sql in [
            "DROP TABLE IF EXISTS tp_rel_child",
            "DROP TABLE IF EXISTS tp_rel_parent",
            "CREATE TABLE tp_rel_parent (a INT, b INT, PRIMARY KEY (a, b), KEY ba (b, a))",
            "CREATE TABLE tp_rel_child (id INT PRIMARY KEY, pb INT, pa INT, \
             FOREIGN KEY (pb, pa) REFERENCES tp_rel_parent (b, a))",
            "CREATE TABLE tp_rel_item (id INT PRIMARY KEY, child_id INT, \
             FOREIGN KEY (child_id) REFERENCES tp_rel_child (id))",
        ] {
            engine.execute(sql, 1).await.unwrap();
        }
        let relations = relations_of(&engine, &["tp_rel_child", "tp_rel_item"]).await;
        for sql in [
            "DROP TABLE tp_rel_item",
            "DROP TABLE tp_rel_child",
            "DROP TABLE tp_rel_parent",
        ] {
            engine.execute(sql, 1).await.unwrap();
        }
        assert_eq!(
            relations,
            vec![
                relation("tp_rel_child", &["pb", "pa"], "tp_rel_parent", &["b", "a"]),
                relation("tp_rel_item", &["child_id"], "tp_rel_child", &["id"]),
            ]
        );
    }

    #[tokio::test]
    async fn mssql_relations_list_every_foreign_key() {
        let Some((config, _turn)) = mssql_config().await else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_mssql(&config).await.unwrap();
        check_server_relations(
            &engine,
            &[
                "EXEC('CREATE SCHEMA tp_rel')",
                "CREATE TABLE tp_rel_parent (a INT NOT NULL, b INT NOT NULL, \
                 PRIMARY KEY (a, b), UNIQUE (b, a))",
                "CREATE TABLE tp_rel_child (id INT PRIMARY KEY, pb INT, pa INT, \
                 FOREIGN KEY (pb, pa) REFERENCES tp_rel_parent (b, a))",
                "CREATE TABLE tp_rel.tp_rel_item (id INT PRIMARY KEY, \
                 child_id INT REFERENCES tp_rel_child (id))",
            ],
            &[
                "DROP TABLE IF EXISTS tp_rel.tp_rel_item",
                "IF SCHEMA_ID('tp_rel') IS NOT NULL EXEC('DROP SCHEMA tp_rel')",
                "DROP TABLE IF EXISTS tp_rel_child",
                "DROP TABLE IF EXISTS tp_rel_parent",
            ],
        )
        .await;
    }

    use tablepeek_types::IndexPart;

    /// The index of `detail` named `name`.
    fn index_named<'a>(detail: &'a TableDetail, name: &str) -> &'a IndexInfo {
        detail
            .indexes
            .iter()
            .find(|index| index.name == name)
            .unwrap_or_else(|| panic!("{name}: {:?}", detail.indexes))
    }

    async fn run_all(engine: &Engine, statements: &[&str]) {
        for sql in statements {
            engine
                .execute(sql, 1)
                .await
                .unwrap_or_else(|err| panic!("{sql}: {err}"));
        }
    }

    #[test]
    fn sqlite_partial_index_predicate_is_read_from_its_statement() {
        let cases = [
            ("CREATE INDEX i ON t (a) WHERE b > 1", Some("b > 1")),
            (
                "create index i on t(a) where(b is not null)",
                Some("(b is not null)"),
            ),
            (
                "CREATE INDEX i ON t (c COLLATE NOCASE, \"x)\") WHERE c <> ')'",
                Some("c <> ')'"),
            ),
            ("CREATE INDEX i ON t (lower(c), [a)])", None),
            ("CREATE INDEX i ON t (a) WHEREVER", None),
        ];
        for (sql, predicate) in cases {
            assert_eq!(index_predicate(sql).as_deref(), predicate, "{sql}");
        }
    }

    #[tokio::test]
    async fn sqlite_indexes_carry_definition_and_predicate() {
        let engine = Engine::open_demo(1).unwrap();
        run_all(
            &engine,
            &[
                "CREATE TABLE tp_idx (id INTEGER PRIMARY KEY, a INT, b INT, c TEXT UNIQUE)",
                "CREATE INDEX tp_idx_part ON tp_idx (a) WHERE b > 1",
                "CREATE INDEX tp_idx_expr ON tp_idx (lower(c), a)",
            ],
        )
        .await;
        let detail = engine.table_detail("tp_idx").await.unwrap();
        let partial = index_named(&detail, "tp_idx_part");
        assert_eq!(
            partial.definition.as_deref(),
            Some("CREATE INDEX tp_idx_part ON tp_idx (a) WHERE b > 1")
        );
        assert_eq!(partial.predicate.as_deref(), Some("b > 1"));
        let expression = index_named(&detail, "tp_idx_expr");
        assert_eq!(
            expression.definition.as_deref(),
            Some("CREATE INDEX tp_idx_expr ON tp_idx (lower(c), a)")
        );
        assert_eq!(expression.predicate, None);
        // The UNIQUE constraint's own index has no statement.
        let automatic = detail
            .indexes
            .iter()
            .find(|index| index.name.starts_with("sqlite_autoindex"))
            .unwrap();
        assert_eq!(automatic.definition, None);
        // Left out of the JSON when absent; `where` when present.
        let json = serde_json::to_value(&detail.indexes).unwrap();
        let shown = json.as_array().unwrap();
        assert!(shown.iter().any(|index| index["where"] == "b > 1"));
        assert!(shown
            .iter()
            .any(|index| index.get("definition").is_none() && index.get("where").is_none()));
    }

    /// Partial, expression and INCLUDE indexes on a PostgreSQL-speaking server.
    async fn check_pg_like_indexes(engine: &Engine, include: &str) {
        run_all(
            engine,
            &[
                "DROP TABLE IF EXISTS tp_idx",
                "CREATE TABLE tp_idx (id INT PRIMARY KEY, a INT, b TEXT, c TEXT)",
                "CREATE INDEX tp_idx_part ON tp_idx (a) WHERE a > 0",
                "CREATE INDEX tp_idx_expr ON tp_idx (lower(b) DESC, a)",
                &format!("CREATE INDEX tp_idx_incl ON tp_idx (a) {include} (c)"),
            ],
        )
        .await;
        let detail = engine.table_detail("tp_idx").await.unwrap();
        let partial = index_named(&detail, "tp_idx_part");
        assert!(
            partial
                .predicate
                .as_deref()
                .is_some_and(|p| p.contains("a > 0")),
            "{partial:?}"
        );
        assert!(
            partial
                .definition
                .as_deref()
                .is_some_and(|d| d.contains("tp_idx_part") && d.contains("WHERE")),
            "{partial:?}"
        );
        let expression = index_named(&detail, "tp_idx_expr");
        let parts = expression.parts.as_ref().unwrap();
        assert_eq!(parts.len(), 2, "{expression:?}");
        assert!(
            parts[0].column.is_none()
                && parts[0]
                    .expression
                    .as_deref()
                    .is_some_and(|e| e.contains("lower")),
            "{expression:?}"
        );
        assert_eq!(parts[1].column.as_deref(), Some("a"));
        assert_eq!(parts[1].expression, None);
        assert_eq!((parts[0].descending, parts[1].descending), (true, false));
        assert_eq!(expression.predicate, None);
        let included = index_named(&detail, "tp_idx_incl");
        assert_eq!(
            included.included,
            Some(vec!["c".to_string()]),
            "{included:?}"
        );
        assert_eq!(included.parts.as_ref().unwrap().len(), 1);
        // The columns field is as before.
        assert_eq!(index_named(&detail, "tp_idx_part").columns, vec!["a"]);
        run_all(engine, &["DROP TABLE tp_idx"]).await;
    }

    #[tokio::test]
    async fn pg_indexes_carry_definition_predicate_parts_and_include() {
        let Some(config) = pg_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_postgres(&config).await.unwrap();
        check_pg_like_indexes(&engine, "INCLUDE").await;
    }

    #[tokio::test]
    async fn cockroach_indexes_carry_definition_predicate_parts_and_storing() {
        let Some(config) = cockroach_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_cockroach(&config).await.unwrap();
        check_pg_like_indexes(&engine, "STORING").await;
    }

    #[tokio::test]
    async fn mysql_indexes_carry_prefix_lengths_and_expressions() {
        let Some(config) = mysql_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_mysql(&config).await.unwrap();
        run_all(
            &engine,
            &[
                "DROP TABLE IF EXISTS tp_idx",
                "CREATE TABLE tp_idx (id INT PRIMARY KEY, a INT, b VARCHAR(100), \
                 INDEX tp_idx_prefix (b(10) DESC, a), INDEX tp_idx_expr ((lower(b))))",
            ],
        )
        .await;
        let detail = engine.table_detail("tp_idx").await.unwrap();
        let prefix = index_named(&detail, "tp_idx_prefix");
        assert_eq!(prefix.columns, vec!["b", "a"]);
        assert_eq!(
            prefix.parts.as_deref().unwrap(),
            &[
                IndexPart {
                    column: Some("b".into()),
                    expression: None,
                    prefix_length: Some(10),
                    descending: true,
                },
                IndexPart {
                    column: Some("a".into()),
                    expression: None,
                    prefix_length: None,
                    descending: false,
                },
            ]
        );
        let expression = index_named(&detail, "tp_idx_expr");
        let parts = expression.parts.as_deref().unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].column, None);
        assert!(
            parts[0]
                .expression
                .as_deref()
                .is_some_and(|e| e.contains("lower")),
            "{expression:?}"
        );
        assert_eq!(expression.definition, None);
        run_all(&engine, &["DROP TABLE tp_idx"]).await;
    }

    #[tokio::test]
    async fn mssql_filtered_indexes_carry_predicate_and_included_columns() {
        let Some((config, _turn)) = mssql_config().await else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_mssql(&config).await.unwrap();
        run_all(
            &engine,
            &[
                "DROP TABLE IF EXISTS tp_idx",
                "CREATE TABLE tp_idx (id INT PRIMARY KEY, a INT, b NVARCHAR(50), c NVARCHAR(50))",
                "CREATE INDEX tp_idx_part ON tp_idx (a DESC) INCLUDE (b, c) WHERE a > 0",
                "CREATE INDEX tp_idx_plain ON tp_idx (b)",
            ],
        )
        .await;
        let detail = engine.table_detail("tp_idx").await.unwrap();
        let partial = index_named(&detail, "tp_idx_part");
        assert_eq!(partial.columns, vec!["a"]);
        let parts = partial.parts.as_deref().unwrap();
        assert_eq!(parts.len(), 1);
        assert!(parts[0].descending && parts[0].column.as_deref() == Some("a"));
        assert_eq!(partial.predicate.as_deref(), Some("([a]>(0))"));
        assert_eq!(
            partial.included,
            Some(vec!["b".to_string(), "c".to_string()])
        );
        let plain = index_named(&detail, "tp_idx_plain");
        assert_eq!((&plain.predicate, &plain.included), (&None, &None));
        run_all(&engine, &["DROP TABLE tp_idx"]).await;
    }

    /// A database's error as the reply carries it: first line, code, fields.
    fn driver_parts(err: &EngineError) -> (&str, Option<&str>, &ErrorFields) {
        match err {
            EngineError::Driver {
                message,
                code,
                fields,
                ..
            } => (message.as_str(), code.as_deref(), fields),
            other => panic!("not a driver error: {other:?}"),
        }
    }

    fn failed<T>(outcome: Result<T, EngineError>) -> EngineError {
        match outcome {
            Ok(_) => panic!("succeeded"),
            Err(err) => err,
        }
    }

    #[test]
    fn sqlite_errors_carry_code_and_offset() {
        let conn = Connection::open_in_memory().unwrap();
        // The offset counts characters, not the bytes of '한'.
        let sql = "SELECT '한' FRO nope";
        let err: EngineError = conn.prepare(sql).unwrap_err().into();
        let (message, code, fields) = driver_parts(&err);
        assert_eq!(message, "near \"nope\": syntax error");
        assert_eq!(code, Some("1"));
        assert_eq!(fields.server_code, Some(1));
        let at = sql.chars().position(|c| c == 'n').unwrap() as u32 + 1;
        assert_eq!(fields.position.and_then(|p| p.offset), Some(at));
        assert!(
            fields.raw.as_deref().unwrap().contains("at offset"),
            "{fields:?}"
        );
        // A constraint: the extended code tells which kind.
        conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, n INT CHECK (n >= 0))")
            .unwrap();
        let err: EngineError = conn
            .execute("INSERT INTO t VALUES (1, -5)", [])
            .unwrap_err()
            .into();
        let (message, _, fields) = driver_parts(&err);
        assert_eq!(message, "CHECK constraint failed: n >= 0");
        assert_eq!(fields.server_code, Some(275)); // SQLITE_CONSTRAINT_CHECK
        assert_eq!(fields.raw, None);
        assert_eq!(
            err.to_string(),
            "SQLite 오류: CHECK constraint failed: n >= 0"
        );
    }

    #[test]
    fn char_offsets_count_from_one() {
        assert_eq!(char_offset("abc", 0), Some(1));
        assert_eq!(char_offset("한x", 3), Some(2));
        // Inside a character or past the end: no position rather than a wrong one.
        assert_eq!(char_offset("한x", 1), None);
        assert_eq!(char_offset("abc", 9), None);
    }

    #[tokio::test]
    async fn pg_errors_carry_sqlstate_position_and_details() {
        let Some(config) = pg_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_postgres(&config).await.unwrap();
        let err = failed(engine.query("SELECT * FROM orderz", 10).await);
        let (message, code, fields) = driver_parts(&err);
        assert_eq!(message, "relation \"orderz\" does not exist");
        assert_eq!(code, Some("42P01"));
        assert_eq!(fields.sqlstate.as_deref(), Some("42P01"));
        assert_eq!(fields.position.and_then(|p| p.offset), Some(15));
        assert!(fields.raw.as_deref().unwrap().ends_with("[SQLSTATE 42P01]"));
        let err = failed(engine.query("SELECT 1 FROMM tp", 10).await);
        let (_, _, fields) = driver_parts(&err);
        assert_eq!(fields.sqlstate.as_deref(), Some("42601"));
        assert_eq!(fields.position.and_then(|p| p.offset), Some(16));

        let table = format!("tp_err_check_{}", std::process::id());
        engine
            .execute(
                &format!("CREATE TABLE {table} (id int PRIMARY KEY, qty int CHECK (qty >= 0))"),
                1,
            )
            .await
            .unwrap();
        let err = engine
            .execute(&format!("INSERT INTO {table} VALUES (1, -5)"), 1)
            .await
            .unwrap_err();
        engine
            .execute(&format!("DROP TABLE {table}"), 1)
            .await
            .unwrap();
        let (message, _, fields) = driver_parts(&err);
        assert!(
            message.starts_with(&format!(
                "new row for relation \"{table}\" violates check constraint"
            )),
            "{message}"
        );
        assert!(!message.contains("SQLSTATE"), "{message}");
        assert_eq!(fields.sqlstate.as_deref(), Some("23514"));
        let details = fields.details.as_ref().unwrap();
        assert_eq!(details["table"], Value::from(table.clone()));
        assert_eq!(
            details["constraint"],
            Value::from(format!("{table}_qty_check"))
        );
        assert!(
            details["detail"].as_str().unwrap().contains("(1, -5)"),
            "{details}"
        );

        // A wrong password is the server's refusal, not an internal or TLS
        // failure, with or without TLS asked for.
        for ssl_mode in [
            tablepeek_types::SslMode::Disable,
            tablepeek_types::SslMode::Prefer,
        ] {
            let wrong = tablepeek_types::PostgresConfig {
                password: Some("wrong_pw".into()),
                ssl_mode,
                ..config.clone()
            };
            let err = Engine::open_demo(1)
                .unwrap()
                .swap_to_postgres(&wrong)
                .await
                .unwrap_err();
            let (message, _, fields) = driver_parts(&err);
            assert_eq!(
                message,
                "password authentication failed for user \"tablepeek\""
            );
            assert_eq!(fields.sqlstate.as_deref(), Some("28P01"));
        }
    }

    #[tokio::test]
    async fn cockroach_errors_carry_sqlstate() {
        let Some(config) = cockroach_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_cockroach(&config).await.unwrap();
        let err = failed(engine.query("SELECT * FROM orderz", 10).await);
        let (message, _, fields) = driver_parts(&err);
        assert_eq!(message, "relation \"orderz\" does not exist");
        assert_eq!(fields.sqlstate.as_deref(), Some("42P01"));
    }

    #[tokio::test]
    async fn mysql_errors_carry_errno_sqlstate_and_line() {
        let Some(config) = mysql_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_mysql(&config).await.unwrap();
        let err = failed(engine.query("SELECT 1;\nSELEC 2", 10).await);
        let (message, code, fields) = driver_parts(&err);
        assert!(
            message.starts_with("You have an error in your SQL syntax"),
            "{message}"
        );
        assert_eq!(code, Some("1064"));
        assert_eq!(fields.server_code, Some(1064));
        assert_eq!(fields.sqlstate.as_deref(), Some("42000"));
        assert!(fields.position.and_then(|p| p.line).is_some(), "{fields:?}");
        let raw = fields.raw.as_deref().unwrap();
        assert!(raw.contains("1064") && raw.contains("42000"), "{raw}");
        let wrong = tablepeek_types::MySqlConfig {
            password: Some("wrong_pw".into()),
            ..config.clone()
        };
        let err = Engine::open_demo(1)
            .unwrap()
            .swap_to_mysql(&wrong)
            .await
            .unwrap_err();
        let (message, _, fields) = driver_parts(&err);
        assert!(
            message.starts_with("Access denied for user 'root'"),
            "{message}"
        );
        assert_eq!(fields.server_code, Some(1045));
    }

    #[tokio::test]
    async fn mssql_errors_carry_number_and_line() {
        let Some((config, _turn)) = mssql_config().await else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        engine.swap_to_mssql(&config).await.unwrap();
        let err = failed(engine.query("SELECT 1\nSELECT * FROM", 10).await);
        let (message, code, fields) = driver_parts(&err);
        assert_eq!(message, "Incorrect syntax near 'FROM'.");
        assert_eq!(code, Some("102"));
        assert_eq!(fields.server_code, Some(102));
        assert_eq!(fields.position.and_then(|p| p.line), Some(2));
        let wrong = tablepeek_types::MssqlConfig {
            password: Some("Wrong_pw1".into()),
            ..config.clone()
        };
        let err = Engine::open_demo(1)
            .unwrap()
            .swap_to_mssql(&wrong)
            .await
            .unwrap_err();
        let (message, _, fields) = driver_parts(&err);
        assert!(
            message.starts_with("Login failed for user 'sa'"),
            "{message}"
        );
        assert_eq!(fields.server_code, Some(18456));
    }
}
