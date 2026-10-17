use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

use arrow::array::{
    Array, ArrayRef, Float64Array, Float64Builder, Int64Array, Int64Builder, StringArray,
    StringBuilder,
};
use arrow::datatypes::{DataType, Field, Schema, SchemaRef};
use arrow::ipc::writer::StreamWriter;
use arrow::record_batch::RecordBatch;
use prodb_types::{
    ColumnSchema, EditTarget, EngineMeta, MssqlConfig, MySqlConfig, PostgresConfig, QueryResult,
    TableSchema,
};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

mod mssql;
mod mysql;
mod postgres;
mod sql_parse;

pub const BATCH_CHUNK: usize = 65_536;

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("SQLite 오류: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("PostgreSQL 오류: {0}")]
    Postgres(#[from] tokio_postgres::Error),
    #[error("MySQL 오류: {0}")]
    MySql(String),
    #[error("SQL Server 오류: {0}")]
    Mssql(String),
    #[error("Arrow 오류: {0}")]
    Arrow(#[from] arrow::error::ArrowError),
    #[error("파일을 찾을 수 없습니다: {0}")]
    NotFound(String),
    #[error("SQLite 데이터베이스 파일이 아닙니다: {0}")]
    NotAFile(String),
    #[error("편집할 수 없습니다: {0}")]
    NotEditable(String),
    #[error("내부 오류: {0}")]
    Internal(String),
}

impl EngineError {
    pub fn is_interrupted(&self) -> bool {
        match self {
            EngineError::Sqlite(rusqlite::Error::SqliteFailure(e, _)) => {
                e.code == rusqlite::ErrorCode::OperationInterrupted
            }
            EngineError::Postgres(err) => {
                err.code() == Some(&tokio_postgres::error::SqlState::QUERY_CANCELED)
            }
            EngineError::MySql(message) => {
                let lower = message.to_lowercase();
                lower.contains("interrupted")
                    || lower.contains("killed")
                    || lower.contains("connection closed")
                    || lower.contains("connection reset")
            }
            EngineError::Mssql(message) => {
                let lower = message.to_lowercase();
                lower.contains("kill")
                    || lower.contains("interrupted")
                    || lower.contains("connection closed")
                    || lower.contains("connection reset")
                    || lower.contains("forcibly")
            }
            _ => false,
        }
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
        }
    }

    pub fn slice_rows(&self, offset: usize, limit: usize) -> Result<(RecordBatch, usize), EngineError> {
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
            let mut fields: Vec<Field> = self.schema.fields().iter().map(|f| (**f).clone()).collect();
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
            let existing = arr.as_any().downcast_ref::<StringArray>().ok_or_else(|| {
                EngineError::Internal("문자열 배열을 해석할 수 없습니다".into())
            })?;
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
}

impl SqliteInner {
    fn new(conn: Connection, path: Option<PathBuf>, demo: bool) -> Self {
        let interrupt = conn.get_interrupt_handle();
        Self {
            conn: Arc::new(Mutex::new(conn)),
            interrupt,
            path,
            demo,
        }
    }
}

#[derive(Clone)]
pub enum Backend {
    Sqlite { inner: Arc<SqliteInner> },
    Postgres { inner: Arc<postgres::PostgresInner> },
    MySql { inner: Arc<mysql::MySqlInner> },
    Mssql { inner: Arc<mssql::MssqlInner> },
}

#[derive(Clone)]
enum ActiveTarget {
    Sqlite(Arc<SqliteInner>),
    Postgres(Arc<postgres::PostgresInner>),
    MySql(Arc<mysql::MySqlInner>),
    Mssql(Arc<mssql::MssqlInner>),
}

/// 엔진: SQLite/PostgreSQL 백엔드. 쿼리는 컬럼형(Arrow) 결과로 반환되며,
/// 긴 쿼리는 취소를 지원한다.
pub struct Engine {
    backend: RwLock<Backend>,
    active: Mutex<Option<ActiveTarget>>,
}

impl Engine {
    pub fn open_demo(rows: usize) -> Result<Self, EngineError> {
        Ok(Self::from_inner(build_demo_inner(rows)?))
    }

    pub fn open_file(path: &Path) -> Result<Self, EngineError> {
        Ok(Self::from_inner(open_file_inner(path)?))
    }

    fn from_inner(inner: Arc<SqliteInner>) -> Self {
        Self {
            backend: RwLock::new(Backend::Sqlite { inner }),
            active: Mutex::new(None),
        }
    }

    fn backend_snapshot(&self) -> Result<Backend, EngineError> {
        self.backend
            .read()
            .map(|guard| guard.clone())
            .map_err(|_| EngineError::Internal("백엔드 잠금 실패".into()))
    }

    pub async fn swap_to_file(&self, path: &Path) -> Result<EngineMeta, EngineError> {
        let inner = open_file_inner(path)?;
        let meta = meta_sync(&inner)?;
        let mut guard = self
            .backend
            .write()
            .map_err(|_| EngineError::Internal("백엔드 잠금 실패".into()))?;
        *guard = Backend::Sqlite { inner };
        Ok(meta)
    }

    pub async fn swap_to_demo(&self, rows: usize) -> Result<EngineMeta, EngineError> {
        let inner = tokio::task::spawn_blocking(move || build_demo_inner(rows))
            .await
            .map_err(|e| EngineError::Internal(e.to_string()))??;
        let meta = meta_sync(&inner)?;
        let mut guard = self
            .backend
            .write()
            .map_err(|_| EngineError::Internal("백엔드 잠금 실패".into()))?;
        *guard = Backend::Sqlite { inner };
        Ok(meta)
    }

    pub async fn swap_to_postgres(
        &self,
        config: &PostgresConfig,
    ) -> Result<EngineMeta, EngineError> {
        let inner = postgres::connect(config, "postgres").await?;
        let meta = postgres::meta(&inner).await?;
        let mut guard = self
            .backend
            .write()
            .map_err(|_| EngineError::Internal("백엔드 잠금 실패".into()))?;
        *guard = Backend::Postgres { inner };
        Ok(meta)
    }

    pub async fn swap_to_cockroach(
        &self,
        config: &PostgresConfig,
    ) -> Result<EngineMeta, EngineError> {
        let inner = postgres::connect(config, "cockroach").await?;
        let meta = postgres::meta(&inner).await?;
        let mut guard = self
            .backend
            .write()
            .map_err(|_| EngineError::Internal("백엔드 잠금 실패".into()))?;
        *guard = Backend::Postgres { inner };
        Ok(meta)
    }

    pub async fn swap_to_mysql(&self, config: &MySqlConfig) -> Result<EngineMeta, EngineError> {
        let inner = mysql::connect(config).await?;
        let meta = mysql::meta(&inner).await?;
        let mut guard = self
            .backend
            .write()
            .map_err(|_| EngineError::Internal("백엔드 잠금 실패".into()))?;
        *guard = Backend::MySql { inner };
        Ok(meta)
    }

    pub async fn swap_to_mssql(&self, config: &MssqlConfig) -> Result<EngineMeta, EngineError> {
        let inner = mssql::connect(config).await?;
        let meta = mssql::meta(&inner).await?;
        let mut guard = self
            .backend
            .write()
            .map_err(|_| EngineError::Internal("백엔드 잠금 실패".into()))?;
        *guard = Backend::Mssql { inner };
        Ok(meta)
    }

    pub async fn meta(&self) -> Result<EngineMeta, EngineError> {
        match self.backend_snapshot()? {
            Backend::Sqlite { inner } => tokio::task::spawn_blocking(move || meta_sync(&inner))
                .await
                .map_err(|e| EngineError::Internal(e.to_string()))?,
            Backend::Postgres { inner } => postgres::meta(&inner).await,
            Backend::MySql { inner } => mysql::meta(&inner).await,
            Backend::Mssql { inner } => mssql::meta(&inner).await,
        }
    }

    pub async fn schema(&self) -> Result<Vec<TableSchema>, EngineError> {
        match self.backend_snapshot()? {
            Backend::Sqlite { inner } => tokio::task::spawn_blocking(move || schema_sync(&inner))
                .await
                .map_err(|e| EngineError::Internal(e.to_string()))?,
            Backend::Postgres { inner } => postgres::schema(&inner).await,
            Backend::MySql { inner } => mysql::schema(&inner).await,
            Backend::Mssql { inner } => mssql::schema(&inner).await,
        }
    }

    pub async fn query(&self, sql: &str, max_rows: usize) -> Result<QueryData, EngineError> {
        match self.backend_snapshot()? {
            Backend::Sqlite { inner } => {
                if let Ok(mut active) = self.active.lock() {
                    *active = Some(ActiveTarget::Sqlite(inner.clone()));
                }
                let sql_owned = sql.to_string();
                let inner_for_task = inner.clone();
                let result = tokio::task::spawn_blocking(move || {
                    run_query_sync(&inner_for_task, &sql_owned, max_rows)
                })
                .await
                .map_err(|e| EngineError::Internal(e.to_string()));
                if let Ok(mut active) = self.active.lock() {
                    *active = None;
                }
                result?
            }
            Backend::Postgres { inner } => {
                if let Ok(mut active) = self.active.lock() {
                    *active = Some(ActiveTarget::Postgres(inner.clone()));
                }
                let result = postgres::query(&inner, sql, max_rows).await;
                if let Ok(mut active) = self.active.lock() {
                    *active = None;
                }
                result
            }
            Backend::MySql { inner } => {
                if let Ok(mut active) = self.active.lock() {
                    *active = Some(ActiveTarget::MySql(inner.clone()));
                }
                let result = mysql::query(&inner, sql, max_rows).await;
                if let Ok(mut active) = self.active.lock() {
                    *active = None;
                }
                result
            }
            Backend::Mssql { inner } => {
                if let Ok(mut active) = self.active.lock() {
                    *active = Some(ActiveTarget::Mssql(inner.clone()));
                }
                let result = mssql::query(&inner, sql, max_rows).await;
                if let Ok(mut active) = self.active.lock() {
                    *active = None;
                }
                result
            }
        }
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
        if let Some(target) = self.active.lock().ok().and_then(|guard| guard.clone()) {
            match target {
                ActiveTarget::Sqlite(inner) => inner.interrupt.interrupt(),
                ActiveTarget::Postgres(inner) => inner.cancel(),
                ActiveTarget::MySql(inner) => inner.cancel(),
                ActiveTarget::Mssql(inner) => inner.cancel(),
            }
            return;
        }
        if let Ok(guard) = self.backend.read() {
            match &*guard {
                Backend::Sqlite { inner } => inner.interrupt.interrupt(),
                Backend::Postgres { inner } => inner.cancel(),
                Backend::MySql { inner } => inner.cancel(),
                Backend::Mssql { inner } => inner.cancel(),
            }
        }
    }

    pub async fn edit(&self, target: &EditTarget) -> Result<u64, EngineError> {
        match self.backend_snapshot()? {
            Backend::Sqlite { inner } => {
                let target = target.clone();
                tokio::task::spawn_blocking(move || edit_sync(&inner, &target))
                    .await
                    .map_err(|e| EngineError::Internal(e.to_string()))?
            }
            Backend::Postgres { inner } => postgres::edit(&inner, target).await,
            Backend::MySql { inner } => mysql::edit(&inner, target).await,
            Backend::Mssql { inner } => mssql::edit(&inner, target).await,
        }
    }

    pub async fn begin_tx(&self) -> Result<(), EngineError> {
        self.tx("BEGIN").await
    }

    pub async fn commit_tx(&self) -> Result<(), EngineError> {
        self.tx("COMMIT").await
    }

    pub async fn rollback_tx(&self) -> Result<(), EngineError> {
        self.tx("ROLLBACK").await
    }

    pub async fn in_tx(&self) -> Result<bool, EngineError> {
        match self.backend_snapshot()? {
            Backend::Sqlite { inner } => tokio::task::spawn_blocking(move || {
                let conn = lock_conn(&inner)?;
                Ok(!conn.is_autocommit())
            })
            .await
            .map_err(|e| EngineError::Internal(e.to_string()))?,
            Backend::Postgres { inner } => Ok(inner.in_tx()),
            Backend::MySql { inner } => Ok(inner.in_tx()),
            Backend::Mssql { inner } => Ok(inner.in_tx()),
        }
    }

    async fn tx(&self, statement: &'static str) -> Result<(), EngineError> {
        match self.backend_snapshot()? {
            Backend::Sqlite { inner } => tokio::task::spawn_blocking(move || {
                let conn = lock_conn(&inner)?;
                match statement {
                    "BEGIN" => {
                        if !conn.is_autocommit() {
                            return Err(EngineError::Internal(
                                "이미 트랜잭션이 진행 중입니다".into(),
                            ));
                        }
                    }
                    "COMMIT" | "ROLLBACK" => {
                        if conn.is_autocommit() {
                            return Err(EngineError::Internal(
                                "진행 중인 트랜잭션이 없습니다".into(),
                            ));
                        }
                    }
                    _ => {}
                }
                conn.execute_batch(statement)?;
                Ok(())
            })
            .await
            .map_err(|e| EngineError::Internal(e.to_string()))?,
            Backend::Postgres { inner } => postgres::tx(&inner, statement).await,
            Backend::MySql { inner } => mysql::tx(&inner, statement).await,
            Backend::Mssql { inner } => mssql::tx(&inner, statement).await,
        }
    }
}

fn lock_conn(inner: &SqliteInner) -> Result<std::sync::MutexGuard<'_, Connection>, EngineError> {
    inner
        .conn
        .lock()
        .map_err(|_| EngineError::Internal("커넥션 잠금 실패".into()))
}

fn build_demo_inner(rows: usize) -> Result<Arc<SqliteInner>, EngineError> {
    let conn = Connection::open_in_memory()?;
    seed_demo(&conn, rows)?;
    Ok(Arc::new(SqliteInner::new(conn, None, true)))
}

fn open_file_inner(path: &Path) -> Result<Arc<SqliteInner>, EngineError> {
    if !path.is_file() {
        return Err(EngineError::NotFound(path.display().to_string()));
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    let valid = conn
        .query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))
        .is_ok();
    if !valid {
        return Err(EngineError::NotAFile(path.display().to_string()));
    }
    Ok(Arc::new(SqliteInner::new(
        conn,
        Some(path.to_path_buf()),
        false,
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

fn meta_sync(inner: &SqliteInner) -> Result<EngineMeta, EngineError> {
    let conn = lock_conn(inner)?;
    let mut stmt = conn.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )?;
    let tables = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(EngineMeta {
        kind: "sqlite".into(),
        path: inner.path.as_ref().map(|p| p.display().to_string()),
        demo: inner.demo,
        tables,
    })
}

fn schema_sync(inner: &SqliteInner) -> Result<Vec<TableSchema>, EngineError> {
    let conn = lock_conn(inner)?;
    let mut stmt = conn.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )?;
    let names: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);

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
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        tables.push(TableSchema { name, columns });
    }
    Ok(tables)
}

fn run_query_sync(
    inner: &SqliteInner,
    sql: &str,
    max_rows: usize,
) -> Result<QueryData, EngineError> {
    let started = Instant::now();
    let conn = lock_conn(inner)?;

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
            for i in 0..col_count {
                column_values[i].push(value_ref_to_json(row.get_ref(i)?));
            }
            count += 1;
        }
    }
    drop(stmt);

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

fn detect_source(conn: &Connection, sql: &str, columns: &[String]) -> (Option<String>, Option<Vec<String>>) {
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
            [&name],
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
    let mut sql = format!(
        "UPDATE {} SET {} = ?1 WHERE ",
        quote_ident(&target.table),
        quote_ident(&target.column)
    );
    for (i, pk) in target.pk.iter().enumerate() {
        if i > 0 {
            sql.push_str(" AND ");
        }
        sql.push_str(&format!("{} = ?{}", quote_ident(&pk.column), i + 2));
    }

    let mut params: Vec<rusqlite::types::Value> = Vec::with_capacity(target.pk.len() + 1);
    params.push(match &target.value {
        Some(s) => rusqlite::types::Value::Text(s.clone()),
        None => rusqlite::types::Value::Null,
    });
    for pk in &target.pk {
        params.push(json_to_sql(&pk.value));
    }

    let changed = conn.execute(&sql, rusqlite::params_from_iter(params))?;
    Ok(changed as u64)
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

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn value_ref_to_json(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => Value::from(f),
        ValueRef::Text(bytes) => Value::from(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Blob(bytes) => Value::from(format!("<blob {} bytes>", bytes.len())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use prodb_types::PkValue;

    fn temp_db(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "prodb-test-{}-{}-{name}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[tokio::test]
    async fn demo_seed_and_meta() {
        let engine = Engine::open_demo(250).unwrap();
        let meta = engine.meta().await.unwrap();
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
        let data = engine.query("SELECT id, name FROM demo ORDER BY id", 1000).await.unwrap();
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
        assert!(matches!(
            data.schema.field(0).data_type(),
            DataType::Int64
        ));

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

    fn pg_config() -> Option<prodb_types::PostgresConfig> {
        std::env::var("PRODB_TEST_PG").ok()?;
        Some(prodb_types::PostgresConfig {
            host: "127.0.0.1".into(),
            port: 5433,
            user: "prodb".into(),
            password: Some("prodb_test_pw".into()),
            database: "prodb_test".into(),
            ssl_mode: prodb_types::SslMode::Disable,
        })
    }

    #[tokio::test]
    async fn pg_query_edit_tx_roundtrip() {
        let Some(config) = pg_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        let meta = engine.swap_to_postgres(&config).await.unwrap();
        assert_eq!(meta.kind, "postgres");
        assert!(meta.path.as_deref().unwrap().contains("prodb_test"));
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

        let schema = engine.schema().await.unwrap();
        let users = schema.iter().find(|table| table.name == "users").unwrap();
        let id_col = users.columns.iter().find(|col| col.name == "id").unwrap();
        assert!(id_col.pk);
        assert!(id_col.not_null);
        assert_eq!(id_col.decl_type.as_deref(), Some("integer"));
    }

    #[tokio::test]
    async fn pg_cancel_interrupts_running_query() {
        let Some(config) = pg_config() else {
            return;
        };
        let engine = Arc::new(Engine::open_demo(1).unwrap());
        engine.swap_to_postgres(&config).await.unwrap();

        let query_engine = engine.clone();
        let handle = tokio::spawn(async move { query_engine.query("SELECT pg_sleep(30)", 10).await });
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        engine.cancel();
        let result = handle.await.unwrap();
        let err = match result {
            Ok(_) => panic!("취소되지 않았습니다"),
            Err(err) => err,
        };
        assert!(err.is_interrupted(), "err = {err}");
    }

    fn cockroach_config() -> Option<prodb_types::PostgresConfig> {
        std::env::var("PRODB_TEST_COCKROACH").ok()?;
        Some(prodb_types::PostgresConfig {
            host: "127.0.0.1".into(),
            port: 26258,
            user: "root".into(),
            password: None,
            database: "defaultdb".into(),
            ssl_mode: prodb_types::SslMode::Disable,
        })
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
        assert!(!meta.tables.iter().any(|table| table.contains("crdb_internal")));

        let schema = engine.schema().await.unwrap();
        let users = schema.iter().find(|table| table.name == "users").unwrap();
        let id_col = users.columns.iter().find(|col| col.name == "id").unwrap();
        assert!(id_col.pk);
        assert!(id_col.not_null);
        assert!(id_col.decl_type.is_some());
        assert!(!schema.iter().any(|table| table.name.contains("crdb_internal")));

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
        assert!(rows[0][3]
            .as_str()
            .unwrap()
            .starts_with("2024-01-01 00:01"));

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
        };
        assert_eq!(engine.edit(&target).await.unwrap(), 1);
        let check = engine
            .execute(&format!("SELECT score FROM users WHERE id = {target_id}"), 1)
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
            .execute(&format!("SELECT score FROM users WHERE id = {target_id}"), 1)
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], Value::from("99.25"));

        engine.begin_tx().await.unwrap();
        engine.edit(&rolled).await.unwrap();
        engine.commit_tx().await.unwrap();
        let check = engine
            .execute(&format!("SELECT score FROM users WHERE id = {target_id}"), 1)
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], Value::from("11.11"));

        let restored = EditTarget {
            value: baseline.as_str().map(str::to_string),
            ..target.clone()
        };
        engine.edit(&restored).await.unwrap();
        let check = engine
            .execute(&format!("SELECT score FROM users WHERE id = {target_id}"), 1)
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], baseline);

        let meta = engine.meta().await.unwrap();
        assert_eq!(meta.kind, "cockroach");
    }

    #[tokio::test]
    async fn cockroach_cancel_interrupts_running_query() {
        let Some(config) = cockroach_config() else {
            return;
        };
        let engine = Arc::new(Engine::open_demo(1).unwrap());
        engine.swap_to_cockroach(&config).await.unwrap();

        let query_engine = engine.clone();
        let handle = tokio::spawn(async move { query_engine.query("SELECT pg_sleep(30)", 10).await });
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        engine.cancel();
        let result = handle.await.unwrap();
        let err = match result {
            Ok(_) => panic!("취소되지 않았습니다"),
            Err(err) => err,
        };
        assert!(err.is_interrupted(), "err = {err}");
    }

    fn mysql_config() -> Option<prodb_types::MySqlConfig> {
        std::env::var("PRODB_TEST_MYSQL").ok()?;
        Some(prodb_types::MySqlConfig {
            host: "127.0.0.1".into(),
            port: 3307,
            user: "root".into(),
            password: Some("root_pw".into()),
            database: "prodb_test".into(),
            ssl_mode: prodb_types::SslMode::Disable,
        })
    }

    #[tokio::test]
    async fn mysql_query_edit_tx_roundtrip() {
        let Some(config) = mysql_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        let meta = engine.swap_to_mysql(&config).await.unwrap();
        assert_eq!(meta.kind, "mysql");
        assert!(meta.path.as_deref().unwrap().contains("prodb_test"));
        assert!(meta.tables.contains(&"users".to_string()));
        assert!(meta.tables.contains(&"orders".to_string()));

        let schema = engine.schema().await.unwrap();
        let users = schema.iter().find(|table| table.name == "users").unwrap();
        let id_col = users.columns.iter().find(|col| col.name == "id").unwrap();
        assert!(id_col.pk);
        assert!(id_col.not_null);
        let score_col = users.columns.iter().find(|col| col.name == "score").unwrap();
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
        assert!(rows[0][3]
            .as_str()
            .unwrap()
            .starts_with("2024-01-01 00:01"));

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
        };
        assert_eq!(engine.edit(&target).await.unwrap(), 1);
        let check = engine
            .execute(&format!("SELECT score FROM users WHERE id = {target_id}"), 1)
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
            .execute(&format!("SELECT score FROM users WHERE id = {target_id}"), 1)
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], Value::from("99.25"));

        engine.begin_tx().await.unwrap();
        engine.edit(&rolled).await.unwrap();
        engine.commit_tx().await.unwrap();
        let check = engine
            .execute(&format!("SELECT score FROM users WHERE id = {target_id}"), 1)
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], Value::from("11.11"));

        let restored = EditTarget {
            value: baseline.as_str().map(str::to_string),
            ..target.clone()
        };
        engine.edit(&restored).await.unwrap();
        let check = engine
            .execute(&format!("SELECT score FROM users WHERE id = {target_id}"), 1)
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], baseline);
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

    fn mssql_config() -> Option<prodb_types::MssqlConfig> {
        std::env::var("PRODB_TEST_MSSQL").ok()?;
        Some(prodb_types::MssqlConfig {
            host: "127.0.0.1".into(),
            port: 14330,
            user: "sa".into(),
            password: Some("MsSql_test_pw1".into()),
            database: "prodb_test".into(),
            encrypt: false,
        })
    }

    #[tokio::test]
    async fn mssql_query_edit_tx_roundtrip() {
        let Some(config) = mssql_config() else {
            return;
        };
        let engine = Engine::open_demo(1).unwrap();
        let meta = engine.swap_to_mssql(&config).await.unwrap();
        assert_eq!(meta.kind, "mssql");
        assert!(meta.path.as_deref().unwrap().contains("prodb_test"));
        assert!(meta.tables.contains(&"users".to_string()));
        assert!(meta.tables.contains(&"orders".to_string()));

        let schema = engine.schema().await.unwrap();
        let users = schema.iter().find(|table| table.name == "users").unwrap();
        let id_col = users.columns.iter().find(|col| col.name == "id").unwrap();
        assert!(id_col.pk);
        assert!(id_col.not_null);
        assert_eq!(id_col.decl_type.as_deref(), Some("int"));
        let name_col = users.columns.iter().find(|col| col.name == "name").unwrap();
        assert_eq!(name_col.decl_type.as_deref(), Some("nvarchar(50)"));
        assert!(name_col.not_null);
        let score_col = users.columns.iter().find(|col| col.name == "score").unwrap();
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
        assert!(rows[0][3]
            .as_str()
            .unwrap()
            .starts_with("2024-01-01 00:01"));

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
        };
        assert_eq!(engine.edit(&target).await.unwrap(), 1);
        let check = engine
            .execute(&format!("SELECT score FROM users WHERE id = {target_id}"), 1)
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
            .execute(&format!("SELECT score FROM users WHERE id = {target_id}"), 1)
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], Value::from("99.25"));

        engine.begin_tx().await.unwrap();
        engine.edit(&rolled).await.unwrap();
        engine.commit_tx().await.unwrap();
        let check = engine
            .execute(&format!("SELECT score FROM users WHERE id = {target_id}"), 1)
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
            .execute(&format!("SELECT score FROM users WHERE id = {target_id}"), 1)
            .await
            .unwrap();
        assert_eq!(check.rows[0][0], baseline);
    }

    #[tokio::test]
    async fn mssql_cancel_interrupts_running_query() {
        let Some(config) = mssql_config() else {
            return;
        };
        let engine = Arc::new(Engine::open_demo(1).unwrap());
        engine.swap_to_mssql(&config).await.unwrap();

        let query_engine = engine.clone();
        let handle =
            tokio::spawn(
                async move { query_engine.query("WAITFOR DELAY '00:00:30'", 10).await },
            );
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
            })
            .await
            .unwrap_err();
        assert!(matches!(err, EngineError::NotEditable(_)));
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

        let schema = engine.schema().await.unwrap();
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
        assert!(engine.meta().await.unwrap().demo);
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
}
