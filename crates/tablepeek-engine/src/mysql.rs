use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Instant;

use futures_util::StreamExt;
use mysql_async::consts::{ColumnFlags, ColumnType};
use mysql_async::prelude::{FromRow, Queryable};
use mysql_async::{
    ClientIdentity, Column, Conn, DriverError, Error as MyError, Opts, OptsBuilder, QueryResult,
    Row, SslOpts, TextProtocol, Value as MyValue,
};
use serde_json::Value;
use tablepeek_types::{
    ColumnSchema, DbObjects, EditTarget, EngineMeta, ForeignKeyInfo, IndexInfo, MySqlConfig,
    ObjectDefinition, PkValue, ServerInfo, ServerSession, SslMode, TableDetail, TableSchema,
    TriggerInfo,
};

use crate::source_cache::{key_unchanged, SourceCache, KEY_CHANGED};
use crate::sql_log::{inline_params, Change, Dialect, LogParam, SqlLog};
use crate::sql_parse::{parse_single_table, trim_ident, tx_controls, TxControl};
use crate::{build_arrow, humanize_uptime_ko, EngineError, QueryData};

/// A SELECT's table as information_schema names it (schema, table) and its
/// primary key columns; None when information_schema has no such table.
type Source = Option<(String, String, Vec<String>)>;

pub struct MySqlInner {
    conn: Arc<tokio::sync::Mutex<Conn>>,
    opts: Opts,
    connection_id: AtomicU64,
    label: String,
    in_tx: AtomicBool,
    // The server rolled the open transaction back (a deadlock, say): the
    // next COMMIT reports that rather than "no transaction".
    tx_lost: AtomicBool,
    // What SELECT DATABASE() last said, for reads; a statement that may
    // change it (USE) forgets it, and writes ask again.
    database: Mutex<Option<String>>,
    // By (schema, table) as the SELECT named them, the current database
    // standing in for a missing schema.
    sources: SourceCache<(String, String), Source>,
    log: SqlLog,
}

const SERVER_ROLLED_BACK: &str = "서버가 오류로 트랜잭션을 롤백했습니다";

impl MySqlInner {
    pub(crate) fn in_tx(&self) -> bool {
        self.in_tx.load(Ordering::SeqCst)
    }

    fn database(&self) -> MutexGuard<'_, Option<String>> {
        self.database.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The server rolled the open transaction back.
    fn lose_tx(&self) {
        if self.in_tx.swap(false, Ordering::SeqCst) {
            self.tx_lost.store(true, Ordering::SeqCst);
            self.log.ended(false);
        }
    }

    /// The open transaction ended (or one began) as the server reports.
    fn set_open(&self, open: bool, committed: bool) {
        let was_open = self.in_tx.swap(open, Ordering::SeqCst);
        self.tx_lost.store(false, Ordering::SeqCst);
        if was_open && !open {
            self.log.ended(committed);
        } else if open && !was_open {
            self.log.settle(false);
        }
    }

    async fn conn(&self) -> MyConn<'_> {
        MyConn {
            conn: self.conn.lock().await,
            log: &self.log,
        }
    }

    pub(crate) fn cancel(&self) {
        let opts = self.opts.clone();
        let connection_id = self.connection_id.load(Ordering::SeqCst);
        let log = self.log.clone();
        tokio::spawn(async move {
            if let Ok(mut conn) = Conn::new(opts).await {
                let sql = format!("KILL QUERY {connection_id}");
                log.record(&sql, Dialect::MySql);
                let _ = conn.query_drop(sql).await;
                let _ = conn.disconnect().await;
            }
        });
    }
}

/// The locked connection; every method logs its statement before sending it.
/// It deliberately has no way to reach the bare connection.
struct MyConn<'a> {
    conn: tokio::sync::MutexGuard<'a, Conn>,
    log: &'a SqlLog,
}

impl MyConn<'_> {
    fn shown(sql: &str, params: &[MyValue]) -> String {
        let values: Vec<LogParam> = params.iter().map(log_param).collect();
        inline_params(sql, &values, Dialect::MySql)
    }

    async fn query_iter<'q>(
        &'q mut self,
        sql: &'q str,
    ) -> Result<QueryResult<'q, 'static, TextProtocol>, MyError> {
        self.log.record(sql, Dialect::MySql);
        self.conn.query_iter(sql).await
    }

    async fn query<T, Q>(&mut self, sql: Q) -> Result<Vec<T>, MyError>
    where
        T: FromRow + Send + 'static,
        Q: AsRef<str>,
    {
        let sql = sql.as_ref();
        self.log.record(sql, Dialect::MySql);
        self.conn.query(sql).await
    }

    async fn query_first<T, Q>(&mut self, sql: Q) -> Result<Option<T>, MyError>
    where
        T: FromRow + Send + 'static,
        Q: AsRef<str>,
    {
        let sql = sql.as_ref();
        self.log.record(sql, Dialect::MySql);
        self.conn.query_first(sql).await
    }

    async fn query_drop(&mut self, sql: &str) -> Result<(), MyError> {
        self.log.record(sql, Dialect::MySql);
        self.conn.query_drop(sql).await
    }

    async fn exec<T, Q>(&mut self, sql: Q, params: Vec<MyValue>) -> Result<Vec<T>, MyError>
    where
        T: FromRow + Send + 'static,
        Q: AsRef<str>,
    {
        let sql = sql.as_ref();
        self.log.record(&Self::shown(sql, &params), Dialect::MySql);
        self.conn.exec(sql, params).await
    }

    async fn exec_first<T, Q>(&mut self, sql: Q, params: Vec<MyValue>) -> Result<Option<T>, MyError>
    where
        T: FromRow + Send + 'static,
        Q: AsRef<str>,
    {
        let sql = sql.as_ref();
        self.log.record(&Self::shown(sql, &params), Dialect::MySql);
        self.conn.exec_first(sql, params).await
    }

    /// Runs a data change made from the GUI; one that changed rows goes to
    /// History, at COMMIT when `in_tx`.
    async fn change(
        &mut self,
        sql: &str,
        params: Vec<MyValue>,
        in_tx: bool,
    ) -> Result<u64, MyError> {
        let shown = Self::shown(sql, &params);
        self.log.record(&shown, Dialect::MySql);
        let started = Instant::now();
        let result = self.conn.exec_iter(sql, params).await?;
        let changed = result.affected_rows();
        result.drop_result().await?;
        if changed > 0 {
            let change = Change {
                sql: shown,
                ms: started.elapsed().as_millis() as u64,
                rows: changed,
            };
            self.log.changed(change, in_tx);
        }
        Ok(changed)
    }
}

fn log_param(value: &MyValue) -> LogParam {
    match value {
        MyValue::NULL => LogParam::Null,
        MyValue::Bytes(bytes) => match std::str::from_utf8(bytes) {
            Ok(text) => LogParam::Text(text.to_string()),
            Err(_) => LogParam::Blob(bytes.clone()),
        },
        MyValue::Int(number) => LogParam::Int(*number),
        MyValue::UInt(number) => LogParam::UInt(*number),
        MyValue::Float(number) => LogParam::Float(f64::from(*number)),
        MyValue::Double(number) => LogParam::Float(*number),
        other => LogParam::Text(value_text(other)),
    }
}

fn build_opts(config: &MySqlConfig, tls: bool) -> Result<Opts, EngineError> {
    let mut builder = OptsBuilder::default()
        .ip_or_hostname(config.host.clone())
        .tcp_port(config.port)
        .user(Some(config.user.clone()))
        .pass(config.password.clone())
        .client_found_rows(true);
    if !config.database.trim().is_empty() {
        builder = builder.db_name(Some(config.database.clone()));
    }
    if tls && config.ssl_mode != SslMode::Disable {
        crate::ensure_crypto_provider();
        let mut ssl = SslOpts::default();
        if let Some(path) = config
            .ssl_root_cert
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
        {
            ssl = ssl.with_root_certs(vec![std::path::Path::new(path).to_path_buf().into()]);
        }
        match (
            config
                .ssl_client_cert
                .as_deref()
                .map(str::trim)
                .filter(|path| !path.is_empty()),
            config
                .ssl_client_key
                .as_deref()
                .map(str::trim)
                .filter(|path| !path.is_empty()),
        ) {
            (Some(cert_path), Some(key_path)) => {
                ssl = ssl.with_client_identity(Some(ClientIdentity::new(
                    std::path::Path::new(cert_path).to_path_buf().into(),
                    std::path::Path::new(key_path).to_path_buf().into(),
                )));
            }
            (None, None) => {}
            _ => {
                return Err(EngineError::Internal(
                    "TLS 클라이언트 인증서와 키는 함께 지정해야 합니다".into(),
                ));
            }
        }
        builder = builder.ssl_opts(Some(ssl));
    }
    Ok(builder.into())
}

fn mysql_err(err: mysql_async::Error) -> EngineError {
    EngineError::MySql(err.to_string())
}

// rustls failures (an untrusted certificate, say) reach mysql_async as plain
// I/O errors that wrap the rustls::Error.
fn is_tls_io_error(err: &std::io::Error) -> bool {
    let mut current = err
        .get_ref()
        .map(|inner| inner as &(dyn std::error::Error + 'static));
    while let Some(inner) = current {
        if inner.is::<rustls::Error>() {
            return true;
        }
        current = inner.source();
    }
    false
}

fn tls_fallback_allowed(err: &MyError) -> bool {
    match err {
        MyError::Io(mysql_async::IoError::Tls(_)) => true,
        MyError::Io(mysql_async::IoError::Io(io)) => is_tls_io_error(io),
        MyError::Driver(DriverError::NoClientSslFlagFromServer) => true,
        MyError::Server(server) => matches!(server.code, 2026 | 3159),
        MyError::Other(source) => {
            let text = source.to_string().to_ascii_lowercase();
            text.contains("tls") || text.contains("ssl") || text.contains("certificate")
        }
        _ => false,
    }
}

pub(crate) async fn connect(
    config: &MySqlConfig,
    log: SqlLog,
) -> Result<Arc<MySqlInner>, EngineError> {
    let opts = build_opts(config, true)?;
    let (mut conn, opts) = match Conn::new(opts.clone()).await {
        Ok(conn) => (conn, opts),
        Err(err) if config.ssl_mode == SslMode::Prefer && tls_fallback_allowed(&err) => {
            let fallback = build_opts(config, false)?;
            let conn = Conn::new(fallback.clone()).await.map_err(|fallback_err| {
                EngineError::MySql(format!(
                    "MySQL TLS 연결 실패: {err}; 평문 재시도 실패: {fallback_err}"
                ))
            })?;
            (conn, fallback)
        }
        Err(err) => {
            let label = if config.ssl_mode != SslMode::Disable && tls_fallback_allowed(&err) {
                "MySQL TLS 연결 실패"
            } else {
                "MySQL 연결 실패"
            };
            return Err(EngineError::MySql(format!("{label}: {err}")));
        }
    };
    // Not yet behind MyConn: logged by hand.
    log.record("SELECT CONNECTION_ID()", Dialect::MySql);
    let connection_id = conn
        .query_first::<u64, _>("SELECT CONNECTION_ID()")
        .await
        .map_err(mysql_err)?
        .unwrap_or_default();
    log.record("SELECT DATABASE()", Dialect::MySql);
    let current = conn
        .query_first::<String, _>("SELECT DATABASE()")
        .await
        .map_err(mysql_err)?
        .filter(|name| !name.is_empty());
    let database = current.clone().unwrap_or_else(|| config.database.clone());
    Ok(Arc::new(MySqlInner {
        conn: Arc::new(tokio::sync::Mutex::new(conn)),
        opts,
        connection_id: AtomicU64::new(connection_id),
        label: format!(
            "{}@{}:{}/{}",
            config.user, config.host, config.port, database
        ),
        in_tx: AtomicBool::new(false),
        tx_lost: AtomicBool::new(false),
        database: Mutex::new(current),
        sources: SourceCache::default(),
        log,
    }))
}

const TABLE_LIST_SQL: &str = "SELECT TABLE_NAME FROM information_schema.TABLES \
     WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME";

const TABLE_LIST_SYS_SQL: &str =
    "SELECT TABLE_SCHEMA, TABLE_NAME FROM information_schema.TABLES \
     WHERE TABLE_SCHEMA IN (DATABASE(), 'information_schema', 'mysql', 'performance_schema', 'sys') \
     ORDER BY TABLE_SCHEMA, TABLE_NAME";

const SCHEMA_COLUMNS_SQL: &str = "SELECT c.TABLE_SCHEMA, c.TABLE_NAME, c.COLUMN_NAME, \
     c.COLUMN_TYPE, c.IS_NULLABLE, (k.COLUMN_NAME IS NOT NULL) AS is_pk, c.COLUMN_DEFAULT \
     FROM information_schema.COLUMNS c \
     LEFT JOIN information_schema.KEY_COLUMN_USAGE k \
       ON k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME \
      AND k.COLUMN_NAME = c.COLUMN_NAME AND k.CONSTRAINT_NAME = 'PRIMARY' \
     WHERE c.TABLE_SCHEMA = DATABASE() \
     ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION";

const SCHEMA_COLUMNS_SYS_SQL: &str = "SELECT c.TABLE_SCHEMA, c.TABLE_NAME, c.COLUMN_NAME, \
     c.COLUMN_TYPE, c.IS_NULLABLE, (k.COLUMN_NAME IS NOT NULL) AS is_pk, c.COLUMN_DEFAULT \
     FROM information_schema.COLUMNS c \
     LEFT JOIN information_schema.KEY_COLUMN_USAGE k \
       ON k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME \
      AND k.COLUMN_NAME = c.COLUMN_NAME AND k.CONSTRAINT_NAME = 'PRIMARY' \
     WHERE c.TABLE_SCHEMA IN (DATABASE(), 'information_schema', 'mysql', 'performance_schema', 'sys') \
     ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION";

const COLUMN_SQL_SCHEMA: &str = "SELECT c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, \
     EXISTS (SELECT 1 FROM information_schema.KEY_COLUMN_USAGE k \
             WHERE k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME \
               AND k.COLUMN_NAME = c.COLUMN_NAME AND k.CONSTRAINT_NAME = 'PRIMARY') AS is_pk, \
     c.COLUMN_DEFAULT \
     FROM information_schema.COLUMNS c \
     WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ? \
     ORDER BY c.ORDINAL_POSITION";

const TABLE_LOOKUP_SQL: &str = "SELECT TABLE_SCHEMA, TABLE_NAME FROM information_schema.TABLES \
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1";

const PK_SQL: &str = "SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE \
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' \
     ORDER BY ORDINAL_POSITION";

const COLUMN_TYPE_SQL: &str = "SELECT DATA_TYPE, COLUMN_TYPE FROM information_schema.COLUMNS \
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?";

pub(crate) async fn meta(
    inner: &MySqlInner,
    include_system: bool,
) -> Result<EngineMeta, EngineError> {
    let mut conn = inner.conn().await;
    // A reload picks up schema changes made elsewhere: so do the sources.
    inner.sources.clear();
    let tables: Vec<String> = if include_system {
        let current: Option<String> = conn
            .query_first("SELECT DATABASE()")
            .await
            .map_err(mysql_err)?;
        let rows: Vec<(String, String)> =
            conn.query(TABLE_LIST_SYS_SQL).await.map_err(mysql_err)?;
        rows.into_iter()
            .map(|(schema, table)| {
                if current.as_deref() == Some(schema.as_str()) {
                    table
                } else {
                    format!("{schema}.{table}")
                }
            })
            .collect()
    } else {
        conn.query(TABLE_LIST_SQL).await.map_err(mysql_err)?
    };
    Ok(EngineMeta {
        kind: "mysql".into(),
        path: Some(inner.label.clone()),
        demo: false,
        tables,
    })
}

pub(crate) async fn schema(
    inner: &MySqlInner,
    include_system: bool,
) -> Result<Vec<TableSchema>, EngineError> {
    let mut conn = inner.conn().await;
    inner.sources.clear();
    let mut entries: Vec<(Option<String>, String)> = Vec::new();
    let current: Option<String> = if include_system {
        conn.query_first("SELECT DATABASE()")
            .await
            .map_err(mysql_err)?
    } else {
        None
    };
    if include_system {
        let rows: Vec<(String, String)> =
            conn.query(TABLE_LIST_SYS_SQL).await.map_err(mysql_err)?;
        for (schema, table) in rows {
            if current.as_deref() == Some(schema.as_str()) {
                entries.push((None, table));
            } else {
                entries.push((Some(schema), table));
            }
        }
    } else {
        let tables: Vec<String> = conn.query(TABLE_LIST_SQL).await.map_err(mysql_err)?;
        for table in tables {
            entries.push((None, table));
        }
    }
    // All columns in one round trip instead of one query per table: over a
    // tunnel the per-table queries made the schema load scale with latency.
    let rows: Vec<Row> = conn
        .query(if include_system {
            SCHEMA_COLUMNS_SYS_SQL
        } else {
            SCHEMA_COLUMNS_SQL
        })
        .await
        .map_err(mysql_err)?;
    let mut columns_by_table: HashMap<(Option<String>, String), Vec<ColumnSchema>> =
        HashMap::new();
    for row in rows {
        let schema: Option<String> = row.get::<String, _>(0);
        let schema_part = match schema {
            Some(schema) if include_system && current.as_deref() != Some(schema.as_str()) => {
                Some(schema)
            }
            _ => None,
        };
        let table = row.get::<String, _>(1).unwrap_or_default();
        columns_by_table
            .entry((schema_part, table))
            .or_default()
            .push(ColumnSchema {
                name: row.get::<String, _>(2).unwrap_or_default(),
                decl_type: row.get::<String, _>(3),
                not_null: row
                    .get::<String, _>(4)
                    .map(|value| value == "NO")
                    .unwrap_or(false),
                pk: row
                    .get::<i64, _>(5)
                    .map(|value| value != 0)
                    .unwrap_or(false),
                default: row.get::<Option<String>, _>(6).flatten(),
                enum_values: None,
            });
    }
    let mut out = Vec::with_capacity(entries.len());
    for (schema_part, table) in entries {
        let columns = columns_by_table
            .remove(&(schema_part.clone(), table.clone()))
            .unwrap_or_default();
        let name = match schema_part {
            Some(schema) => format!("{schema}.{table}"),
            None => table,
        };
        out.push(TableSchema { name, columns });
    }
    Ok(out)
}

pub(crate) async fn query(
    inner: &MySqlInner,
    sql: &str,
    max_rows: usize,
) -> Result<QueryData, EngineError> {
    let started = Instant::now();
    let controls = tx_controls(sql, Dialect::MySql);
    let mut conn = inner.conn().await;
    // USE, DDL and the like.
    if inner.sources.before_statement(sql, Dialect::MySql) {
        *inner.database() = None;
    }
    let read = first_result(&mut conn, sql, max_rows).await;
    let read = match read {
        Ok(read) => read,
        Err(err) => {
            // A batch that failed partway may have run some of it, a
            // statement the classifier passed among it.
            inner.sources.clear();
            *inner.database() = None;
            if inner.in_tx() || !controls.is_empty() {
                after_failed_batch(inner, &mut conn, &err, &controls).await;
            }
            return Err(mysql_err(err));
        }
    };
    let columns: Vec<String> = read
        .columns
        .iter()
        .map(|column| column.name_str().to_string())
        .collect();
    // BEGIN, COMMIT and the like run from the editor move the transaction.
    track(inner, &controls);

    let (source_table, pk) = detect_source(inner, &mut conn, sql, &read.columns, &columns).await;
    // TINYINT(1), BOOLEAN's own type: 1 and 0 that mean true and false.
    let column_kinds = read
        .columns
        .iter()
        .map(|column| {
            (column.column_type() == ColumnType::MYSQL_TYPE_TINY && column.column_length() == 1)
                .then_some("boolean")
        })
        .collect();
    let (schema, batches) = build_arrow(&columns, read.values, read.count)?;
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    Ok(QueryData {
        kind: "mysql",
        columns,
        schema,
        batches,
        row_count: read.count,
        elapsed_ms,
        truncated: read.truncated,
        source_table,
        pk,
        column_kinds,
    })
}

/// The first result set of a query, up to `max_rows` rows.
struct FirstResult {
    columns: Vec<Column>,
    /// One list per column.
    values: Vec<Vec<Value>>,
    count: usize,
    truncated: bool,
}

async fn first_result(
    conn: &mut MyConn<'_>,
    sql: &str,
    max_rows: usize,
) -> Result<FirstResult, MyError> {
    let mut result = conn.query_iter(sql).await?;
    let columns: Vec<Column> = result
        .columns()
        .map(|columns| columns.to_vec())
        .unwrap_or_default();
    let mut values: Vec<Vec<Value>> = vec![Vec::new(); columns.len()];
    let mut count = 0usize;
    let mut truncated = false;
    {
        let mut stream = result.stream::<Row>().await?;
        if let Some(stream) = stream.as_mut() {
            while let Some(row) = stream.next().await {
                let row = row?;
                if count >= max_rows {
                    truncated = true;
                    break;
                }
                for (index, value) in row.unwrap().iter().enumerate() {
                    if let Some(column) = columns.get(index) {
                        values[index].push(json_value(value, column));
                    }
                }
                count += 1;
            }
        }
    }
    // The rest of a multi-statement batch: a statement that failed there
    // fails this query, not the next one.
    result.drop_result().await?;
    Ok(FirstResult {
        columns,
        values,
        count,
        truncated,
    })
}

/// A query failed, maybe partway through a batch, so the controls it
/// classified may not all have run: find out where the transaction stands.
/// A deadlock rolls it back for sure; otherwise ask the server.
async fn after_failed_batch(
    inner: &MySqlInner,
    conn: &mut MyConn<'_>,
    err: &MyError,
    controls: &[TxControl],
) {
    if inner.in_tx() && rolled_back_by_server(conn, err).await {
        inner.lose_tx();
        return;
    }
    let implicit = controls.contains(&TxControl::ImplicitCommit);
    let Some(open) = server_in_tx(conn, implicit).await else {
        return;
    };
    let committed = (implicit || controls.contains(&TxControl::Commit))
        && !controls.contains(&TxControl::Rollback);
    inner.set_open(open, committed);
}

/// Whether InnoDB rolled the whole transaction back over this error: a
/// deadlock always does, a lock wait timeout only with
/// innodb_rollback_on_timeout.
async fn rolled_back_by_server(conn: &mut MyConn<'_>, err: &MyError) -> bool {
    match err {
        MyError::Server(server) if server.code == 1213 => true,
        MyError::Server(server) if server.code == 1205 => {
            conn.query_first::<i64, _>("SELECT @@innodb_rollback_on_timeout")
                .await
                .ok()
                .flatten()
                == Some(1)
        }
        _ => false,
    }
}

/// A data change failed: a deadlock may have taken the transaction with it.
async fn after_failed_change(inner: &MySqlInner, conn: &mut MyConn<'_>, err: &MyError) {
    if inner.in_tx() && rolled_back_by_server(conn, err).await {
        inner.lose_tx();
    }
}

/// Whether the server has a transaction open; None when it cannot tell.
/// MariaDB says outright. MySQL lists a transaction in InnoDB only once it
/// has read or written: an unlisted one holding changes is over, and after
/// a failed implicit commit (`implicit`) it is taken to be.
async fn server_in_tx(conn: &mut MyConn<'_>, implicit: bool) -> Option<bool> {
    if let Ok(Some(flag)) = conn.query_first::<i64, _>("SELECT @@in_transaction").await {
        return Some(flag != 0);
    }
    let listed = conn
        .query_first::<i64, _>(
            "SELECT COUNT(*) FROM information_schema.INNODB_TRX \
             WHERE trx_mysql_thread_id = CONNECTION_ID()",
        )
        .await
        .ok()
        .flatten()?;
    if listed > 0 {
        Some(true)
    } else if implicit || conn.log.has_pending() {
        Some(false)
    } else {
        None
    }
}

pub(crate) async fn edit(inner: &MySqlInner, target: &EditTarget) -> Result<u64, EngineError> {
    if target.pk.is_empty() {
        return Err(EngineError::NotEditable(
            "기본 키가 없어 편집할 수 없습니다".into(),
        ));
    }
    let mut conn = inner.conn().await;
    let (schema_part, table) = split_display_table(&target.table);
    let schema = match schema_part {
        Some(schema) => schema,
        None => ask_database(inner, &mut conn).await?,
    };
    check_key(inner, &mut conn, &schema, &table, &target.pk).await?;
    let table_ref = qualified(&schema, &table);
    let (data_type, column_type) =
        column_type_of(&mut conn, &schema, &table, &target.column).await?;
    let cast = cast_type(&data_type, &column_type);

    let mut sql = format!(
        "UPDATE {table_ref} SET {} = CAST(? AS {cast}) WHERE ",
        quote_ident(&target.column)
    );
    let mut params: Vec<MyValue> = Vec::with_capacity(target.pk.len() + 1);
    params.push(match &target.value {
        Some(text) => MyValue::from(text.clone()),
        None => MyValue::NULL,
    });
    for (index, pk) in target.pk.iter().enumerate() {
        if index > 0 {
            sql.push_str(" AND ");
        }
        let (pk_data_type, pk_column_type) =
            column_type_of(&mut conn, &schema, &table, &pk.column).await?;
        let pk_cast = cast_type(&pk_data_type, &pk_column_type);
        sql.push_str(&format!(
            "{} <=> CAST(? AS {pk_cast})",
            quote_ident(&pk.column)
        ));
        params.push(pk_value(&pk.value));
    }

    let result = conn.change(&sql, params, inner.in_tx()).await;
    if let Err(err) = &result {
        after_failed_change(inner, &mut conn, err).await;
    }
    result.map_err(mysql_err)
}

pub(crate) async fn insert_row(
    inner: &MySqlInner,
    table: &str,
    values: &[(String, Option<String>)],
) -> Result<u64, EngineError> {
    let mut conn = inner.conn().await;
    let (schema_part, table_name) = split_display_table(table);
    let schema = match schema_part {
        Some(schema) => schema,
        None => ask_database(inner, &mut conn).await?,
    };
    let table_ref = qualified(&schema, &table_name);
    let sql = if values.is_empty() {
        format!("INSERT INTO {table_ref} () VALUES ()")
    } else {
        let columns = values
            .iter()
            .map(|(column, _)| quote_ident(column))
            .collect::<Vec<_>>()
            .join(", ");
        let mut placeholders = Vec::with_capacity(values.len());
        for (column, _) in values.iter() {
            let (data_type, column_type) =
                column_type_of(&mut conn, &schema, &table_name, column).await?;
            let cast = cast_type(&data_type, &column_type);
            placeholders.push(format!("CAST(? AS {cast})"));
        }
        format!(
            "INSERT INTO {table_ref} ({columns}) VALUES ({})",
            placeholders.join(", ")
        )
    };
    let params: Vec<MyValue> = values
        .iter()
        .map(|(_, value)| match value {
            Some(text) => MyValue::from(text.clone()),
            None => MyValue::NULL,
        })
        .collect();
    let result = conn.change(&sql, params, inner.in_tx()).await;
    if let Err(err) = &result {
        after_failed_change(inner, &mut conn, err).await;
    }
    result.map_err(mysql_err)
}

pub(crate) async fn delete_row(
    inner: &MySqlInner,
    table: &str,
    pk: &[PkValue],
) -> Result<u64, EngineError> {
    if pk.is_empty() {
        return Err(EngineError::BadRequest("PK 조건이 필요합니다".into()));
    }
    let mut conn = inner.conn().await;
    let (schema_part, table_name) = split_display_table(table);
    let schema = match schema_part {
        Some(schema) => schema,
        None => ask_database(inner, &mut conn).await?,
    };
    check_key(inner, &mut conn, &schema, &table_name, pk).await?;
    let table_ref = qualified(&schema, &table_name);
    let mut sql = format!("DELETE FROM {table_ref} WHERE ");
    let mut params: Vec<MyValue> = Vec::with_capacity(pk.len());
    for (index, condition) in pk.iter().enumerate() {
        if index > 0 {
            sql.push_str(" AND ");
        }
        let (data_type, column_type) =
            column_type_of(&mut conn, &schema, &table_name, &condition.column).await?;
        let cast = cast_type(&data_type, &column_type);
        sql.push_str(&format!(
            "{} <=> CAST(? AS {cast})",
            quote_ident(&condition.column)
        ));
        params.push(pk_value(&condition.value));
    }
    let result = conn.change(&sql, params, inner.in_tx()).await;
    if let Err(err) = &result {
        after_failed_change(inner, &mut conn, err).await;
    }
    result.map_err(mysql_err)
}

pub(crate) async fn table_detail(
    inner: &MySqlInner,
    name: &str,
) -> Result<TableDetail, EngineError> {
    let mut conn = inner.conn().await;
    // Opening a table's structure shows its key as it is now: so should the
    // next SELECT.
    inner.sources.clear();
    let (schema_part, table_name) = split_display_table(name);
    let schema = match schema_part.as_deref() {
        Some(schema) => schema.to_string(),
        None => current_schema(inner, &mut conn).await?,
    };
    let exists: Option<(String, String)> = conn
        .exec_first(
            TABLE_LOOKUP_SQL,
            vec![
                MyValue::from(schema.clone()),
                MyValue::from(table_name.clone()),
            ],
        )
        .await
        .map_err(mysql_err)?;
    let Some((canonical_schema, canonical_table)) = exists else {
        return Err(EngineError::TableNotFound);
    };

    let rows: Vec<Row> = conn
        .exec(
            COLUMN_SQL_SCHEMA,
            vec![
                MyValue::from(canonical_schema.clone()),
                MyValue::from(canonical_table.clone()),
            ],
        )
        .await
        .unwrap_or_default();
    let columns = rows
        .iter()
        .map(|row| ColumnSchema {
            name: row.get::<String, _>(0).unwrap_or_default(),
            decl_type: row.get::<String, _>(1),
            not_null: row
                .get::<String, _>(2)
                .map(|value| value == "NO")
                .unwrap_or(false),
            pk: row
                .get::<i64, _>(3)
                .map(|value| value != 0)
                .unwrap_or(false),
            default: row.get::<Option<String>, _>(4).flatten(),
            enum_values: row.get::<String, _>(1).as_deref().and_then(enum_values),
        })
        .collect::<Vec<_>>();

    let mut indexes: Vec<IndexInfo> = Vec::new();
    let index_rows: Vec<(String, i64, Option<String>)> = conn
        .exec(
            "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX",
            vec![
                MyValue::from(canonical_schema.clone()),
                MyValue::from(canonical_table.clone()),
            ],
        )
        .await
        .unwrap_or_default();
    for (index_name, non_unique, column) in index_rows {
        match indexes.last_mut() {
            Some(existing) if existing.name == index_name => {
                if let Some(column) = column {
                    existing.columns.push(column);
                }
            }
            _ => indexes.push(IndexInfo {
                name: index_name.clone(),
                unique: non_unique == 0,
                primary: index_name == "PRIMARY",
                columns: column.into_iter().collect(),
            }),
        }
    }
    indexes.sort_by(|a, b| a.name.cmp(&b.name));

    let mut foreign_keys: Vec<ForeignKeyInfo> = Vec::new();
    let fk_rows: Vec<(String, String, String, String)> = conn
        .exec(
            "SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME \
             FROM information_schema.KEY_COLUMN_USAGE \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL \
             ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION",
            vec![
                MyValue::from(canonical_schema.clone()),
                MyValue::from(canonical_table.clone()),
            ],
        )
        .await
        .unwrap_or_default();
    for (constraint, column, ref_table, ref_column) in fk_rows {
        match foreign_keys.last_mut() {
            Some(existing) if existing.name == constraint => {
                existing.columns.push(column);
                existing.ref_columns.push(ref_column);
            }
            _ => foreign_keys.push(ForeignKeyInfo {
                name: constraint,
                columns: vec![column],
                ref_table,
                ref_columns: vec![ref_column],
            }),
        }
    }

    let (row_count_estimate, data_bytes, index_bytes, comment) = conn
        .exec_first::<(Option<u64>, Option<u64>, Option<u64>, Option<String>), _>(
            "SELECT TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, \
             CASE WHEN TABLE_TYPE = 'VIEW' THEN NULL ELSE TABLE_COMMENT END \
             FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
            vec![
                MyValue::from(canonical_schema.clone()),
                MyValue::from(canonical_table.clone()),
            ],
        )
        .await
        .ok()
        .flatten()
        .map(|(rows, data, index, comment)| {
            (
                rows.map(|value| value as i64),
                data.map(|value| value as i64),
                index.map(|value| value as i64),
                comment.filter(|text| !text.is_empty()),
            )
        })
        .unwrap_or((None, None, None, None));
    let size_bytes = data_bytes
        .zip(index_bytes)
        .map(|(data, index)| data + index);

    let trigger_rows: Vec<(String, String, String, String)> = conn
        .exec(
            "SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT \
             FROM information_schema.TRIGGERS \
             WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? \
             ORDER BY ACTION_ORDER, TRIGGER_NAME",
            vec![
                MyValue::from(canonical_schema.clone()),
                MyValue::from(canonical_table.clone()),
            ],
        )
        .await
        .unwrap_or_default();
    let triggers = trigger_rows
        .into_iter()
        .map(|(name, timing, event, statement)| TriggerInfo {
            definition: Some(format!(
                "CREATE TRIGGER {} {timing} {event} ON {} FOR EACH ROW {statement}",
                quote_ident(&name),
                quote_ident(&canonical_table),
            )),
            name,
            timing: Some(timing),
            event: Some(event),
        })
        .collect();

    let table_ref = qualified(&canonical_schema, &canonical_table);
    Ok(TableDetail {
        name: if schema_part.is_some() {
            format!("{canonical_schema}.{canonical_table}")
        } else {
            canonical_table.clone()
        },
        row_count_estimate,
        size_bytes,
        data_bytes,
        index_bytes,
        comment,
        ddl: Some(build_create_table(&table_ref, &columns)),
        columns,
        indexes,
        foreign_keys,
        triggers,
        schema: Some(canonical_schema.clone()),
    })
}

pub(crate) async fn server_info(inner: &MySqlInner) -> Result<ServerInfo, EngineError> {
    let mut conn = inner.conn().await;
    let version = conn
        .query_first::<String, _>("SELECT VERSION()")
        .await
        .map_err(mysql_err)?;
    let database = conn
        .query_first::<String, _>("SELECT DATABASE()")
        .await
        .map_err(mysql_err)?;
    let encoding = conn
        .query_first::<String, _>(
            "SELECT DEFAULT_CHARACTER_SET_NAME FROM information_schema.SCHEMATA \
             WHERE SCHEMA_NAME = DATABASE()",
        )
        .await
        .map_err(mysql_err)?;
    let uptime = conn
        .query_first::<(String, String), _>("SHOW GLOBAL STATUS LIKE 'Uptime'")
        .await
        .map_err(mysql_err)?
        .and_then(|(_, value)| value.parse::<i64>().ok())
        .map(humanize_uptime_ko);
    let size_bytes = conn
        .query_first::<Option<u64>, _>(
            "SELECT SUM(DATA_LENGTH + INDEX_LENGTH) FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = DATABASE()",
        )
        .await
        .map_err(mysql_err)?
        .flatten()
        .map(|value| value as i64);
    let current_id = inner.connection_id.load(Ordering::SeqCst);
    let sessions = conn
        .query::<(
            u64,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<i64>,
            Option<String>,
        ), _>(
            "SELECT ID, USER, DB, COMMAND, TIME, INFO FROM information_schema.PROCESSLIST \
             ORDER BY ID",
        )
        .await
        .map_err(mysql_err)?
        .into_iter()
        .map(|(id, user, database, state, time, query)| ServerSession {
            id: id.to_string(),
            user,
            database,
            state,
            query,
            elapsed_ms: time.map(|seconds| seconds.saturating_mul(1000)),
            is_current: id == current_id,
        })
        .collect::<Vec<_>>();
    Ok(ServerInfo {
        driver: "mysql".into(),
        version,
        database,
        encoding,
        uptime,
        size_bytes,
        sessions: Some(sessions),
        can_kill: true,
    })
}

pub(crate) async fn objects(
    inner: &MySqlInner,
    include_system: bool,
) -> Result<DbObjects, EngineError> {
    let mut conn = inner.conn().await;
    let current: Option<String> = conn
        .query_first("SELECT DATABASE()")
        .await
        .map_err(mysql_err)?;
    let qualify = |schema: String, name: String| -> String {
        if current.as_deref() == Some(schema.as_str()) {
            name
        } else {
            format!("{schema}.{name}")
        }
    };
    let views: Vec<String> = if include_system {
        conn.query::<(String, String), _>(
            "SELECT TABLE_SCHEMA, TABLE_NAME FROM information_schema.VIEWS \
             WHERE TABLE_SCHEMA IN (DATABASE(), 'information_schema', 'sys') ORDER BY TABLE_SCHEMA, TABLE_NAME",
        )
        .await
        .map_err(mysql_err)?
        .into_iter()
        .map(|(schema, name)| qualify(schema, name))
        .collect()
    } else {
        conn.query(
            "SELECT TABLE_NAME FROM information_schema.VIEWS \
             WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME",
        )
        .await
        .map_err(mysql_err)?
    };
    let mut functions: Vec<String> = Vec::new();
    let mut procedures: Vec<String> = Vec::new();
    let routine_rows: Vec<(String, String, String)> = if include_system {
        conn.query(
            "SELECT ROUTINE_SCHEMA, ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES \
             WHERE ROUTINE_SCHEMA IN (DATABASE(), 'sys') ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME",
        )
        .await
        .map_err(mysql_err)?
    } else {
        conn.query(
            "SELECT ROUTINE_SCHEMA, ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES \
             WHERE ROUTINE_SCHEMA = DATABASE() ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME",
        )
        .await
        .map_err(mysql_err)?
    };
    for (schema, name, kind) in routine_rows {
        let display = qualify(schema, name);
        if kind == "PROCEDURE" {
            procedures.push(display);
        } else {
            functions.push(display);
        }
    }
    let triggers: Vec<String> = if include_system {
        conn.query::<(String, String), _>(
            "SELECT TRIGGER_SCHEMA, TRIGGER_NAME FROM information_schema.TRIGGERS \
             WHERE TRIGGER_SCHEMA IN (DATABASE(), 'sys') ORDER BY TRIGGER_SCHEMA, TRIGGER_NAME",
        )
        .await
        .map_err(mysql_err)?
        .into_iter()
        .map(|(schema, name)| qualify(schema, name))
        .collect()
    } else {
        conn.query(
            "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS \
             WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY TRIGGER_NAME",
        )
        .await
        .map_err(mysql_err)?
    };
    Ok(DbObjects {
        views,
        functions,
        triggers,
        sequences: Vec::new(),
        procedures,
    })
}

pub(crate) async fn table_count(inner: &MySqlInner, name: &str) -> Result<i64, EngineError> {
    let mut conn = inner.conn().await;
    let qualified: Vec<String> = name.split('.').map(quote_ident).collect();
    let sql = format!("SELECT COUNT(*) FROM {}", qualified.join("."));
    conn.query_first::<i64, _>(sql)
        .await
        .map_err(mysql_err)?
        .ok_or_else(|| EngineError::Internal("행 수를 가져오지 못했습니다".into()))
}

pub(crate) async fn databases(inner: &MySqlInner) -> Result<Vec<String>, EngineError> {
    let mut conn = inner.conn().await;
    let rows: Vec<String> = conn.query("SHOW DATABASES").await.map_err(mysql_err)?;
    Ok(rows)
}

pub(crate) async fn object_definition(
    inner: &MySqlInner,
    kind: &str,
    name: &str,
) -> Result<Option<ObjectDefinition>, EngineError> {
    let mut conn = inner.conn().await;
    let (schema_part, object_name) = split_display_table(name);
    let schema = match schema_part {
        Some(schema) => schema,
        None => current_schema(inner, &mut conn).await?,
    };
    let object_ref = qualified(&schema, &object_name);
    let ddl = match kind {
        "view" => conn
            .query_first::<Row, _>(format!("SHOW CREATE VIEW {object_ref}"))
            .await
            .ok()
            .flatten()
            .and_then(|row| row.get::<String, _>(1)),
        "function" => conn
            .query_first::<Row, _>(format!("SHOW CREATE FUNCTION {object_ref}"))
            .await
            .ok()
            .flatten()
            .and_then(|row| row.get::<String, _>(2)),
        "procedure" => conn
            .query_first::<Row, _>(format!("SHOW CREATE PROCEDURE {object_ref}"))
            .await
            .ok()
            .flatten()
            .and_then(|row| row.get::<String, _>(2)),
        "trigger" => conn
            .query_first::<Row, _>(format!("SHOW CREATE TRIGGER {object_ref}"))
            .await
            .ok()
            .flatten()
            .and_then(|row| row.get::<String, _>(2)),
        _ => None,
    };
    let Some(ddl) = ddl else {
        return Ok(None);
    };
    Ok(Some(ObjectDefinition {
        name: object_name,
        kind: kind.to_string(),
        ddl: Some(ddl),
    }))
}

pub(crate) async fn kill_session(inner: &MySqlInner, id: u64) -> Result<(), EngineError> {
    let current_id = inner.connection_id.load(Ordering::SeqCst);
    if id == current_id {
        return Err(EngineError::BadRequest(
            "자신의 연결은 종료할 수 없습니다".into(),
        ));
    }
    let mut conn = inner.conn().await;
    conn.query_drop(&format!("KILL {id}"))
        .await
        .map_err(mysql_err)
}

fn build_create_table(table_ref: &str, columns: &[ColumnSchema]) -> String {
    let mut lines = Vec::new();
    let mut pk_columns = Vec::new();
    for column in columns {
        let mut line = format!(
            "  {} {}",
            quote_ident(&column.name),
            column.decl_type.as_deref().unwrap_or("text")
        );
        if column.not_null {
            line.push_str(" NOT NULL");
        }
        if let Some(default) = column.default.as_deref() {
            if !default.is_empty() {
                line.push_str(&format!(" DEFAULT {default}"));
            }
        }
        lines.push(line);
        if column.pk {
            pk_columns.push(quote_ident(&column.name));
        }
    }
    if !pk_columns.is_empty() {
        lines.push(format!("  PRIMARY KEY ({})", pk_columns.join(", ")));
    }
    format!("CREATE TABLE {table_ref} (\n{}\n)", lines.join(",\n"))
}

pub(crate) async fn tx(inner: &MySqlInner, statement: &str) -> Result<(), EngineError> {
    // Everything below runs under the lock, so no change slips between the
    // statement and the bookkeeping.
    let mut conn = inner.conn().await;
    let active = inner.in_tx();
    match statement {
        "BEGIN" if active => {
            return Err(EngineError::Internal(
                "이미 트랜잭션이 진행 중입니다".into(),
            ));
        }
        "COMMIT" | "ROLLBACK" if !active => {
            if inner.tx_lost.swap(false, Ordering::SeqCst) {
                // A ROLLBACK asks for what already happened.
                return match statement {
                    "COMMIT" => Err(EngineError::TxRolledBack(SERVER_ROLLED_BACK.into())),
                    _ => Ok(()),
                };
            }
            return Err(EngineError::Internal(
                "진행 중인 트랜잭션이 없습니다".into(),
            ));
        }
        _ => {}
    }
    conn.query_drop(statement).await.map_err(mysql_err)?;
    inner.set_open(statement == "BEGIN", statement == "COMMIT");
    drop(conn);
    Ok(())
}

/// Follows transaction statements run from the editor, under the connection
/// lock: History gets the changes they commit and loses those they roll back.
fn track(inner: &MySqlInner, controls: &[TxControl]) {
    for control in controls {
        match control {
            // BEGIN commits a transaction already open.
            TxControl::Begin => {
                if inner.in_tx() {
                    inner.set_open(false, true);
                }
                inner.set_open(true, false);
            }
            TxControl::Commit => inner.set_open(false, true),
            TxControl::Rollback => inner.set_open(false, false),
            TxControl::ImplicitCommit => {
                if inner.in_tx() {
                    inner.set_open(false, true);
                }
            }
            TxControl::RollbackToSavepoint => {}
        }
    }
}

/// The current database, for reads: asked for only when no answer is kept.
async fn current_schema(inner: &MySqlInner, conn: &mut MyConn<'_>) -> Result<String, EngineError> {
    let kept = inner.database().clone();
    if let Some(database) = kept {
        return Ok(database);
    }
    ask_database(inner, conn).await
}

/// The current database as the server says it now, for writes: a USE the
/// classifier missed must not send a change to another database's table.
async fn ask_database(inner: &MySqlInner, conn: &mut MyConn<'_>) -> Result<String, EngineError> {
    let database = conn
        .query_first::<String, _>("SELECT DATABASE()")
        .await
        .map_err(mysql_err)?
        .ok_or_else(|| EngineError::Internal("데이터베이스가 선택되지 않았습니다".into()))?;
    *inner.database() = Some(database.clone());
    Ok(database)
}

/// Refuses a write keyed on columns that aren't the table's primary key now
/// (see `key_unchanged`), and forgets the cached keys that said otherwise.
async fn check_key(
    inner: &MySqlInner,
    conn: &mut MyConn<'_>,
    schema: &str,
    table: &str,
    pk: &[PkValue],
) -> Result<(), EngineError> {
    let current: Vec<String> = conn
        .exec(
            PK_SQL,
            vec![
                MyValue::from(schema.to_string()),
                MyValue::from(table.to_string()),
            ],
        )
        .await
        .map_err(mysql_err)?;
    if key_unchanged(&current, pk, true) {
        return Ok(());
    }
    inner.sources.clear();
    if current.is_empty() {
        // No key at all: dropped, or no such table in this database.
        let found: Option<(String, String)> = conn
            .exec_first(
                TABLE_LOOKUP_SQL,
                vec![
                    MyValue::from(schema.to_string()),
                    MyValue::from(table.to_string()),
                ],
            )
            .await
            .map_err(mysql_err)?;
        if found.is_none() {
            return Err(EngineError::TableNotFound);
        }
    }
    Err(EngineError::NotEditable(KEY_CHANGED.into()))
}

async fn column_type_of(
    conn: &mut MyConn<'_>,
    schema: &str,
    table: &str,
    column: &str,
) -> Result<(String, String), EngineError> {
    conn.exec_first::<(String, String), _>(
        COLUMN_TYPE_SQL,
        vec![
            MyValue::from(schema.to_string()),
            MyValue::from(table.to_string()),
            MyValue::from(column.to_string()),
        ],
    )
    .await
    .map_err(mysql_err)?
    .ok_or_else(|| EngineError::NotEditable(format!("컬럼을 찾을 수 없습니다: {column}")))
}

/// The values of an ENUM or SET column type (`enum('a','it''s')`), in order.
fn enum_values(column_type: &str) -> Option<Vec<String>> {
    let lower = column_type.to_ascii_lowercase();
    let body = if lower.starts_with("enum(") {
        &column_type[5..]
    } else if lower.starts_with("set(") {
        &column_type[4..]
    } else {
        return None;
    };
    let mut values = Vec::new();
    let mut chars = body.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                let mut value = String::new();
                while let Some(c) = chars.next() {
                    if c == '\'' {
                        if chars.peek() == Some(&'\'') {
                            chars.next();
                        } else {
                            break;
                        }
                    }
                    value.push(c);
                }
                values.push(value);
            }
            ')' => break,
            _ => {}
        }
    }
    Some(values)
}

fn cast_type(data_type: &str, column_type: &str) -> &'static str {
    let unsigned = column_type.to_lowercase().contains("unsigned");
    match data_type.to_lowercase().as_str() {
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" => {
            if unsigned {
                "UNSIGNED"
            } else {
                "SIGNED"
            }
        }
        "decimal" | "numeric" => "DECIMAL(65,30)",
        "float" | "double" | "real" => "DOUBLE",
        "date" => "DATE",
        "datetime" | "timestamp" => "DATETIME",
        "time" => "TIME",
        "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob" | "geometry" => {
            "BINARY"
        }
        "json" => "JSON",
        _ => "CHAR",
    }
}

fn split_display_table(display: &str) -> (Option<String>, String) {
    match display.split_once('.') {
        Some((schema, table)) => (Some(trim_ident(schema)), trim_ident(table)),
        None => (None, trim_ident(display)),
    }
}

fn qualified(schema: &str, table: &str) -> String {
    format!("{}.{}", quote_ident(schema), quote_ident(table))
}

fn quote_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

fn pk_value(value: &Value) -> MyValue {
    match value {
        Value::Null => MyValue::NULL,
        Value::Bool(flag) => MyValue::Int(i64::from(*flag)),
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                MyValue::Int(integer)
            } else if let Some(integer) = number.as_u64() {
                MyValue::UInt(integer)
            } else {
                MyValue::Double(number.as_f64().unwrap_or_default())
            }
        }
        Value::String(text) => MyValue::from(text.clone()),
        other => MyValue::from(other.to_string()),
    }
}

/// The table a SELECT read and its primary key, when the result holds every
/// key column. The lookups run on a table's first SELECT only; failed ones
/// are not kept.
async fn detect_source(
    inner: &MySqlInner,
    conn: &mut MyConn<'_>,
    sql: &str,
    result: &[Column],
    columns: &[String],
) -> (Option<String>, Option<Vec<String>>) {
    let Some((schema_part, table_part)) = parse_single_table(sql) else {
        return (None, None);
    };
    let display = |schema: &str, table: &str| {
        if schema_part.is_some() {
            format!("{schema}.{table}")
        } else {
            table.to_string()
        }
    };
    // The result's own columns say where the server found the table; the
    // kept database is a guess a missed USE could make wrong.
    let schema = schema_part
        .clone()
        .or_else(|| result_schema(result, &table_part))
        .or_else(|| inner.database().clone());
    let schema = match schema {
        Some(schema) => schema,
        None => match current_schema(inner, conn).await {
            Ok(schema) => schema,
            Err(_) => return (None, None),
        },
    };

    let key = (schema, table_part);
    let (canonical_schema, canonical_table, pk_rows) = match inner.sources.get(&key) {
        Some(Some(source)) => source,
        Some(None) => return (None, None),
        None => {
            let canonical: Option<(String, String)> = match conn
                .exec_first(
                    TABLE_LOOKUP_SQL,
                    vec![MyValue::from(key.0.clone()), MyValue::from(key.1.clone())],
                )
                .await
            {
                Ok(canonical) => canonical,
                Err(_) => return (None, None),
            };
            let Some((canonical_schema, canonical_table)) = canonical else {
                inner.sources.put(key, None);
                return (None, None);
            };
            let pk_rows: Vec<String> = match conn
                .exec(
                    PK_SQL,
                    vec![
                        MyValue::from(canonical_schema.clone()),
                        MyValue::from(canonical_table.clone()),
                    ],
                )
                .await
            {
                Ok(rows) => rows,
                Err(_) => return (Some(display(&canonical_schema, &canonical_table)), None),
            };
            let source = (canonical_schema, canonical_table, pk_rows);
            inner.sources.put(key, Some(source.clone()));
            source
        }
    };

    let display = display(&canonical_schema, &canonical_table);
    if pk_rows.is_empty() {
        return (Some(display), None);
    }
    let columns_lower: Vec<String> = columns.iter().map(|name| name.to_lowercase()).collect();
    let all_present = pk_rows
        .iter()
        .all(|name| columns_lower.contains(&name.to_lowercase()));
    if !all_present {
        return (Some(display), None);
    }
    (Some(display), Some(pk_rows))
}

/// The database every result column comes from, when each is a column of
/// `table` itself (an expression has none): where the server found an
/// unqualified table, so the current database, without asking for it.
fn result_schema(result: &[Column], table: &str) -> Option<String> {
    let schema = result.first()?.schema_ref();
    let of_table = |column: &Column| {
        !column.schema_ref().is_empty()
            && column.schema_ref() == schema
            && column
                .org_table_ref()
                .eq_ignore_ascii_case(table.as_bytes())
    };
    result
        .iter()
        .all(of_table)
        .then(|| String::from_utf8_lossy(schema).into_owned())
}

fn json_value(value: &MyValue, column: &Column) -> Value {
    if matches!(value, MyValue::NULL) {
        return Value::Null;
    }
    let flags = column.flags();
    match column.column_type() {
        ColumnType::MYSQL_TYPE_TINY
        | ColumnType::MYSQL_TYPE_SHORT
        | ColumnType::MYSQL_TYPE_INT24
        | ColumnType::MYSQL_TYPE_LONG
        | ColumnType::MYSQL_TYPE_LONGLONG
        | ColumnType::MYSQL_TYPE_YEAR => {
            int_json(value, flags.contains(ColumnFlags::UNSIGNED_FLAG))
        }
        ColumnType::MYSQL_TYPE_FLOAT | ColumnType::MYSQL_TYPE_DOUBLE => float_json(value),
        ColumnType::MYSQL_TYPE_DECIMAL | ColumnType::MYSQL_TYPE_NEWDECIMAL => text_json(value),
        ColumnType::MYSQL_TYPE_DATE | ColumnType::MYSQL_TYPE_NEWDATE => date_json(value),
        ColumnType::MYSQL_TYPE_DATETIME
        | ColumnType::MYSQL_TYPE_TIMESTAMP
        | ColumnType::MYSQL_TYPE_DATETIME2
        | ColumnType::MYSQL_TYPE_TIMESTAMP2 => datetime_json(value),
        ColumnType::MYSQL_TYPE_TIME | ColumnType::MYSQL_TYPE_TIME2 => time_json(value),
        ColumnType::MYSQL_TYPE_BIT => bit_json(value),
        ColumnType::MYSQL_TYPE_JSON => text_json(value),
        ColumnType::MYSQL_TYPE_ENUM | ColumnType::MYSQL_TYPE_SET => text_json(value),
        ColumnType::MYSQL_TYPE_GEOMETRY => blob_json(value),
        ColumnType::MYSQL_TYPE_TINY_BLOB
        | ColumnType::MYSQL_TYPE_MEDIUM_BLOB
        | ColumnType::MYSQL_TYPE_LONG_BLOB
        | ColumnType::MYSQL_TYPE_BLOB => {
            if flags.contains(ColumnFlags::BINARY_FLAG) {
                blob_json(value)
            } else {
                text_json(value)
            }
        }
        ColumnType::MYSQL_TYPE_VARCHAR
        | ColumnType::MYSQL_TYPE_VAR_STRING
        | ColumnType::MYSQL_TYPE_STRING => {
            if flags.contains(ColumnFlags::ENUM_FLAG) || flags.contains(ColumnFlags::SET_FLAG) {
                text_json(value)
            } else if flags.contains(ColumnFlags::BINARY_FLAG) {
                soft_text_json(value)
            } else {
                text_json(value)
            }
        }
        ColumnType::MYSQL_TYPE_NULL => Value::Null,
        _ => text_json(value),
    }
}

fn json_uint(number: u64) -> Value {
    if number <= i64::MAX as u64 {
        Value::from(number as i64)
    } else {
        Value::from(number.to_string())
    }
}

fn int_json(value: &MyValue, unsigned: bool) -> Value {
    match value {
        MyValue::Int(number) => Value::from(*number),
        MyValue::UInt(number) => json_uint(*number),
        MyValue::Bytes(bytes) => {
            let text = String::from_utf8_lossy(bytes);
            let parsed = if unsigned {
                text.trim().parse::<u64>().map(json_uint)
            } else {
                text.trim().parse::<i64>().map(Value::from)
            };
            parsed.unwrap_or_else(|_| Value::from(text.into_owned()))
        }
        other => Value::from(value_text(other)),
    }
}

fn float_json(value: &MyValue) -> Value {
    match value {
        MyValue::Float(number) => Value::from(f64::from(*number)),
        MyValue::Double(number) => Value::from(*number),
        MyValue::Int(number) => Value::from(*number as f64),
        MyValue::UInt(number) => Value::from(*number as f64),
        MyValue::Bytes(bytes) => {
            let text = String::from_utf8_lossy(bytes);
            text.trim()
                .parse::<f64>()
                .map(Value::from)
                .unwrap_or_else(|_| Value::from(text.into_owned()))
        }
        other => Value::from(value_text(other)),
    }
}

fn text_json(value: &MyValue) -> Value {
    match value {
        MyValue::Bytes(bytes) => Value::from(String::from_utf8_lossy(bytes).into_owned()),
        MyValue::Int(number) => Value::from(*number),
        MyValue::UInt(number) => json_uint(*number),
        MyValue::Float(number) => Value::from(f64::from(*number)),
        MyValue::Double(number) => Value::from(*number),
        MyValue::Date(..) => Value::from(value_text(value)),
        MyValue::Time(..) => Value::from(value_text(value)),
        MyValue::NULL => Value::Null,
    }
}

fn date_json(value: &MyValue) -> Value {
    match value {
        MyValue::Date(year, month, day, ..) => {
            Value::from(format!("{year:04}-{month:02}-{day:02}"))
        }
        other => text_json(other),
    }
}

fn datetime_json(value: &MyValue) -> Value {
    match value {
        MyValue::Date(year, month, day, hour, minute, second, micros) => Value::from(format!(
            "{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}{}",
            fraction(*micros)
        )),
        other => text_json(other),
    }
}

fn time_json(value: &MyValue) -> Value {
    match value {
        MyValue::Time(negative, days, hours, minutes, seconds, micros) => {
            let total_hours = days * 24 + u32::from(*hours);
            let sign = if *negative { "-" } else { "" };
            Value::from(format!(
                "{sign}{total_hours:02}:{minutes:02}:{seconds:02}{}",
                fraction(*micros)
            ))
        }
        other => text_json(other),
    }
}

fn fraction(micros: u32) -> String {
    if micros == 0 {
        String::new()
    } else if micros.is_multiple_of(1000) {
        format!(".{:03}", micros / 1000)
    } else {
        format!(".{micros:06}")
    }
}

fn bit_json(value: &MyValue) -> Value {
    match value {
        MyValue::Bytes(bytes) => {
            let mut number = 0u64;
            for byte in bytes {
                number = (number << 8) | u64::from(*byte);
            }
            json_uint(number)
        }
        MyValue::Int(number) => Value::from(*number),
        MyValue::UInt(number) => json_uint(*number),
        other => text_json(other),
    }
}

fn soft_text_json(value: &MyValue) -> Value {
    match value {
        MyValue::Bytes(bytes) => match std::str::from_utf8(bytes) {
            Ok(text) => Value::from(text.to_string()),
            Err(_) => Value::from(format!("<blob {} bytes>", bytes.len())),
        },
        other => text_json(other),
    }
}

fn blob_json(value: &MyValue) -> Value {
    match value {
        MyValue::Bytes(bytes) => Value::from(format!("<blob {} bytes>", bytes.len())),
        other => text_json(other),
    }
}

fn value_text(value: &MyValue) -> String {
    match value {
        MyValue::NULL => String::new(),
        MyValue::Bytes(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        MyValue::Int(number) => number.to_string(),
        MyValue::UInt(number) => number.to_string(),
        MyValue::Float(number) => number.to_string(),
        MyValue::Double(number) => number.to_string(),
        MyValue::Date(year, month, day, hour, minute, second, micros) => {
            if *hour == 0 && *minute == 0 && *second == 0 && *micros == 0 {
                format!("{year:04}-{month:02}-{day:02}")
            } else {
                format!(
                    "{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}{}",
                    fraction(*micros)
                )
            }
        }
        MyValue::Time(negative, days, hours, minutes, seconds, micros) => {
            let total_hours = days * 24 + u32::from(*hours);
            let sign = if *negative { "-" } else { "" };
            format!(
                "{sign}{total_hours:02}:{minutes:02}:{seconds:02}{}",
                fraction(*micros)
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(code: u16) -> MyError {
        MyError::Server(mysql_async::ServerError {
            code,
            message: "test".into(),
            state: "HY000".into(),
        })
    }

    #[test]
    fn reads_enum_and_set_values_from_the_column_type() {
        assert_eq!(
            enum_values("enum('a','it''s','b,c')"),
            Some(vec!["a".to_string(), "it's".into(), "b,c".into()])
        );
        assert_eq!(
            enum_values("SET('x','y')"),
            Some(vec!["x".to_string(), "y".into()])
        );
        assert_eq!(enum_values("enum('')"), Some(vec![String::new()]));
        assert_eq!(enum_values("varchar(10)"), None);
    }

    #[test]
    fn prefer_falls_back_only_for_tls_failures() {
        assert!(tls_fallback_allowed(&server(2026)));
        assert!(tls_fallback_allowed(&server(3159)));
        assert!(tls_fallback_allowed(&MyError::Driver(
            DriverError::NoClientSslFlagFromServer
        )));
        assert!(!tls_fallback_allowed(&server(1045)));
        assert!(!tls_fallback_allowed(&server(1049)));
    }

    #[test]
    fn prefer_falls_back_for_untrusted_certificates() {
        let untrusted = std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer),
        );
        assert!(tls_fallback_allowed(&MyError::Io(mysql_async::IoError::Io(
            untrusted
        ))));
        let refused = std::io::Error::from(std::io::ErrorKind::ConnectionRefused);
        assert!(!tls_fallback_allowed(&MyError::Io(mysql_async::IoError::Io(
            refused
        ))));
    }

    #[test]
    fn the_result_names_the_database_only_when_every_column_is_the_tables() {
        let column = |schema: &str, org_table: &str| {
            Column::new(ColumnType::MYSQL_TYPE_LONG)
                .with_schema(schema.as_bytes())
                .with_org_table(org_table.as_bytes())
        };
        let shop = [column("shop", "users"), column("shop", "users")];
        assert_eq!(result_schema(&shop, "users"), Some("shop".into()));
        // lower_case_table_names lowers what the server reports.
        assert_eq!(result_schema(&shop, "Users"), Some("shop".into()));
        // An expression (COUNT(*), 1 + id) comes from no table.
        let expression = [column("shop", "users"), column("", "")];
        assert_eq!(result_schema(&expression, "users"), None);
        // Columns of another table or database: not this one's to tell.
        assert_eq!(result_schema(&shop, "orders"), None);
        let mixed = [column("shop", "users"), column("audit", "users")];
        assert_eq!(result_schema(&mixed, "users"), None);
        assert_eq!(result_schema(&[], "users"), None);
    }
}
