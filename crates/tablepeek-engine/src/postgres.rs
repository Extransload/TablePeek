use std::fmt::Write as _;
use std::fs::File;
use std::io::BufReader;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use fallible_iterator::FallibleIterator;
use futures_util::StreamExt;
use postgres_protocol::types::ArrayDimension;
use rustls::RootCertStore;
use serde_json::Value;
use tablepeek_types::{
    ColumnSchema, DbObjects, EditTarget, EngineMeta, ForeignKeyInfo, IndexInfo, InsertValue,
    ObjectDefinition, PkValue, PostgresConfig, ServerInfo, ServerSession, SslMode, TableDetail,
    TableSchema, TriggerInfo, ValueExpr,
};
use tokio_postgres::config::SslMode as PgSslMode;
use tokio_postgres::types::{FromSql, Kind, ToSql, Type};
use tokio_postgres::{Client, NoTls, Row, Statement};
use tokio_postgres_rustls::MakeRustlsConnect;

use crate::source_cache::{key_unchanged, KEY_CHANGED};
use crate::sql_log::{inline_params, Change, Dialect, LogParam, SqlLog};
use crate::sql_parse::{tx_controls, TxControl};
use crate::{
    build_arrow, double_json, float_text, humanize_uptime_ko, postgres_message, real_json,
    EngineError, QueryData,
};

pub struct PostgresInner {
    client: Arc<tokio::sync::Mutex<Client>>,
    cancel: tokio_postgres::CancelToken,
    tls: Option<MakeRustlsConnect>,
    label: String,
    tx: TxState,
    kind: &'static str,
    backend_pid: i32,
    log: SqlLog,
}

/// The session's transaction as far as the engine can tell: open (from the
/// toolbar or a BEGIN run in the editor) and aborted by a failed statement,
/// after which PostgreSQL refuses all but ROLLBACK and answers COMMIT with a
/// rollback.
#[derive(Default)]
struct TxState {
    open: AtomicBool,
    aborted: AtomicBool,
}

impl TxState {
    fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }

    fn is_aborted(&self) -> bool {
        self.aborted.load(Ordering::SeqCst)
    }

    /// A statement failed: inside a transaction, that aborts it.
    fn failed(&self) {
        if self.is_open() {
            self.aborted.store(true, Ordering::SeqCst);
        }
    }

    /// ROLLBACK TO SAVEPOINT went through: the transaction is usable again.
    fn recovered(&self) {
        self.aborted.store(false, Ordering::SeqCst);
    }

    fn begin(&self, log: &SqlLog) {
        if !self.open.swap(true, Ordering::SeqCst) {
            self.aborted.store(false, Ordering::SeqCst);
            // Whatever an earlier, untracked transaction left behind.
            log.settle(false);
        }
    }

    /// Ends the transaction; its work counts as committed only when `commit`
    /// asked for it and nothing had aborted it. History follows.
    fn end(&self, commit: bool, log: &SqlLog) -> bool {
        let was_open = self.open.swap(false, Ordering::SeqCst);
        let kept = commit && !self.aborted.swap(false, Ordering::SeqCst);
        if was_open {
            log.ended(kept);
        } else {
            log.settle(false);
        }
        kept
    }

    /// Follows the transaction statements run from the editor; true when a
    /// COMMIT among them rolled back instead (the transaction had aborted).
    fn track(&self, controls: &[TxControl], log: &SqlLog) -> bool {
        let mut refused = false;
        for control in controls {
            match control {
                TxControl::Begin => self.begin(log),
                TxControl::Commit => refused |= !self.end(true, log),
                TxControl::Rollback => {
                    self.end(false, log);
                }
                TxControl::RollbackToSavepoint => self.recovered(),
                TxControl::ImplicitCommit => {}
            }
        }
        refused
    }
}

const ABORTED: &str = "트랜잭션이 오류로 중단되어 롤백했습니다";

/// Whether an error leaves an open transaction aborted: anything the server
/// raised, or a lost connection (the server drops what it had). One the
/// client raised (no row where one was expected, a value that would not
/// convert) does not.
fn aborts_transaction(err: &tokio_postgres::Error) -> bool {
    err.as_db_error().is_some()
        || err.is_closed()
        || std::error::Error::source(err).is_some_and(|source| source.is::<std::io::Error>())
}

/// A bound parameter that the console can also show.
pub(crate) trait PgParam: ToSql + Sync {
    fn log_param(&self) -> LogParam;
}

impl PgParam for String {
    fn log_param(&self) -> LogParam {
        LogParam::Text(self.clone())
    }
}

impl PgParam for &str {
    fn log_param(&self) -> LogParam {
        LogParam::Text((*self).to_string())
    }
}

impl PgParam for Option<String> {
    fn log_param(&self) -> LogParam {
        self.clone().map_or(LogParam::Null, LogParam::Text)
    }
}

impl PgParam for u32 {
    fn log_param(&self) -> LogParam {
        LogParam::UInt(u64::from(*self))
    }
}

impl PgParam for i32 {
    fn log_param(&self) -> LogParam {
        LogParam::Int(i64::from(*self))
    }
}

impl PgParam for i64 {
    fn log_param(&self) -> LogParam {
        LogParam::Int(*self)
    }
}

/// The locked client; every method logs its statement before sending it.
/// It deliberately has no way to reach the bare client.
pub(crate) struct PgConn<'a> {
    client: tokio::sync::MutexGuard<'a, Client>,
    log: &'a SqlLog,
    tx: &'a TxState,
}

impl PgConn<'_> {
    fn shown(sql: &str, params: &[&dyn PgParam]) -> String {
        if params.is_empty() {
            return sql.to_string();
        }
        let values: Vec<LogParam> = params.iter().map(|param| param.log_param()).collect();
        inline_params(sql, &values, Dialect::Postgres)
    }

    fn note(&self, sql: &str, params: &[&dyn PgParam]) {
        self.log
            .record(&Self::shown(sql, params), Dialect::Postgres);
    }

    /// Notes a failure, which aborts an open transaction.
    fn watch<T>(
        &self,
        result: Result<T, tokio_postgres::Error>,
    ) -> Result<T, tokio_postgres::Error> {
        if result.as_ref().is_err_and(aborts_transaction) {
            self.tx.failed();
        }
        result
    }

    fn bind<'p>(params: &'p [&'p dyn PgParam]) -> Vec<&'p (dyn ToSql + Sync)> {
        params
            .iter()
            .map(|param| *param as &(dyn ToSql + Sync))
            .collect()
    }

    async fn query(
        &self,
        sql: &str,
        params: &[&dyn PgParam],
    ) -> Result<Vec<Row>, tokio_postgres::Error> {
        self.note(sql, params);
        self.watch(self.client.query(sql, &Self::bind(params)).await)
    }

    async fn query_one(
        &self,
        sql: &str,
        params: &[&dyn PgParam],
    ) -> Result<Row, tokio_postgres::Error> {
        self.note(sql, params);
        self.watch(self.client.query_one(sql, &Self::bind(params)).await)
    }

    async fn query_opt(
        &self,
        sql: &str,
        params: &[&dyn PgParam],
    ) -> Result<Option<Row>, tokio_postgres::Error> {
        self.note(sql, params);
        self.watch(self.client.query_opt(sql, &Self::bind(params)).await)
    }

    async fn batch_execute(&self, sql: &str) -> Result<(), tokio_postgres::Error> {
        self.log.record(sql, Dialect::Postgres);
        self.watch(self.client.batch_execute(sql).await)
    }

    /// Logged here, once: `query_prepared` then runs it.
    async fn prepare(&self, sql: &str) -> Result<Statement, tokio_postgres::Error> {
        self.log.record(sql, Dialect::Postgres);
        self.watch(self.client.prepare(sql).await)
    }

    async fn query_prepared(
        &self,
        statement: &Statement,
    ) -> Result<tokio_postgres::RowStream, tokio_postgres::Error> {
        self.watch(
            self.client
                .query_raw(statement, std::iter::empty::<i32>())
                .await,
        )
    }

    /// Runs a data change made from the GUI; one that changed rows goes to
    /// History, at COMMIT when a transaction is open.
    async fn change(
        &self,
        sql: &str,
        params: &[&dyn PgParam],
    ) -> Result<u64, tokio_postgres::Error> {
        let shown = Self::shown(sql, params);
        self.log.record(&shown, Dialect::Postgres);
        let started = Instant::now();
        let changed = self.watch(self.client.execute(sql, &Self::bind(params)).await)?;
        if changed > 0 {
            let change = Change {
                sql: shown,
                ms: started.elapsed().as_millis() as u64,
                rows: changed,
            };
            self.log.changed(change, self.tx.is_open());
        }
        Ok(changed)
    }
}

impl PostgresInner {
    pub(crate) fn in_tx(&self) -> bool {
        self.tx.is_open()
    }

    async fn conn(&self) -> PgConn<'_> {
        PgConn {
            client: self.client.lock().await,
            log: &self.log,
            tx: &self.tx,
        }
    }

    // The cancel request is a protocol message, not SQL: nothing to log.
    // Done once the server has taken it.
    pub(crate) fn cancel(&self) -> tokio::task::JoinHandle<()> {
        let token = self.cancel.clone();
        let tls = self.tls.clone();
        tokio::spawn(async move {
            let _ = match tls {
                Some(tls) => token.cancel_query(tls).await,
                None => token.cancel_query(NoTls).await,
            };
        })
    }
}

fn tls_connector(config: &PostgresConfig) -> Result<MakeRustlsConnect, EngineError> {
    crate::ensure_crypto_provider();
    let mut roots = RootCertStore::empty();
    if let Some(path) = config
        .ssl_root_cert
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        let mut reader = BufReader::new(File::open(path).map_err(|err| {
            EngineError::Internal(format!("TLS CA 인증서를 열 수 없습니다({path}): {err}"))
        })?);
        let certs = rustls_pemfile::certs(&mut reader)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| EngineError::Internal(format!("TLS CA 인증서 형식 오류: {err}")))?;
        if certs.is_empty() {
            return Err(EngineError::Internal(format!(
                "TLS CA 인증서에 인증서가 없습니다: {path}"
            )));
        }
        for cert in certs {
            roots
                .add(cert)
                .map_err(|err| EngineError::Internal(format!("TLS CA 인증서 오류: {err}")))?;
        }
    } else {
        let native = rustls_native_certs::load_native_certs();
        if native.certs.is_empty() {
            return Err(EngineError::Internal(
                "시스템 루트 인증서를 불러오지 못했습니다. CA 인증서 경로를 지정하세요".into(),
            ));
        }
        for cert in native.certs {
            let _ = roots.add(cert);
        }
    }

    let builder = rustls::ClientConfig::builder().with_root_certificates(roots);
    let client_config = match (
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
            let mut cert_reader = BufReader::new(File::open(cert_path).map_err(|err| {
                EngineError::Internal(format!(
                    "TLS 클라이언트 인증서를 열 수 없습니다({cert_path}): {err}"
                ))
            })?);
            let chain = rustls_pemfile::certs(&mut cert_reader)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| {
                    EngineError::Internal(format!("TLS 클라이언트 인증서 형식 오류: {err}"))
                })?;
            if chain.is_empty() {
                return Err(EngineError::Internal(format!(
                    "TLS 클라이언트 인증서에 인증서가 없습니다: {cert_path}"
                )));
            }
            let mut key_reader = BufReader::new(File::open(key_path).map_err(|err| {
                EngineError::Internal(format!(
                    "TLS 클라이언트 키를 열 수 없습니다({key_path}): {err}"
                ))
            })?);
            let key = rustls_pemfile::private_key(&mut key_reader)
                .map_err(|err| {
                    EngineError::Internal(format!("TLS 클라이언트 키 형식 오류: {err}"))
                })?
                .ok_or_else(|| {
                    EngineError::Internal(format!(
                        "TLS 클라이언트 키에 private key가 없습니다: {key_path}"
                    ))
                })?;
            builder.with_client_auth_cert(chain, key).map_err(|err| {
                EngineError::Internal(format!("TLS 클라이언트 인증서 오류: {err}"))
            })?
        }
        (None, None) => builder.with_no_client_auth(),
        _ => {
            return Err(EngineError::Internal(
                "TLS 클라이언트 인증서와 키는 함께 지정해야 합니다".into(),
            ));
        }
    };
    Ok(MakeRustlsConnect::new(client_config))
}

pub(crate) async fn connect(
    config: &PostgresConfig,
    kind: &'static str,
    log: SqlLog,
) -> Result<Arc<PostgresInner>, EngineError> {
    let mut pg = tokio_postgres::Config::new();
    pg.host(&config.host)
        .port(config.port)
        .user(&config.user)
        .dbname(&config.database)
        .application_name("tablepeek");
    if let Some(password) = &config.password {
        pg.password(password);
    }
    let (client, cancel, tls) = match config.ssl_mode {
        SslMode::Disable => {
            pg.ssl_mode(PgSslMode::Disable);
            let (client, connection) = pg.connect(NoTls).await.map_err(|err| {
                EngineError::Internal(format!("PostgreSQL 연결 실패: {}", postgres_message(&err)))
            })?;
            tokio::spawn(async move {
                let _ = connection.await;
            });
            let cancel = client.cancel_token();
            (client, cancel, None)
        }
        SslMode::Prefer | SslMode::Require => {
            pg.ssl_mode(if config.ssl_mode == SslMode::Require {
                PgSslMode::Require
            } else {
                PgSslMode::Prefer
            });
            let connector = tls_connector(config)?;
            let (client, connection) = pg.connect(connector.clone()).await.map_err(|err| {
                EngineError::Internal(format!(
                    "PostgreSQL TLS 연결 실패: {}",
                    postgres_message(&err)
                ))
            })?;
            tokio::spawn(async move {
                let _ = connection.await;
            });
            let cancel = client.cancel_token();
            (client, cancel, Some(connector))
        }
    };
    const PID_SQL: &str = "SELECT pg_backend_pid()::bigint";
    log.record(PID_SQL, Dialect::Postgres);
    let backend_pid: i32 = client
        .query_one(PID_SQL, &[])
        .await
        .ok()
        .and_then(|row| row.get::<_, Option<i64>>(0))
        .unwrap_or(0) as i32;
    Ok(Arc::new(PostgresInner {
        client: Arc::new(tokio::sync::Mutex::new(client)),
        cancel,
        tls,
        label: format!(
            "{}@{}:{}/{}",
            config.user, config.host, config.port, config.database
        ),
        tx: TxState::default(),
        kind,
        backend_pid,
        log,
    }))
}

pub(crate) async fn meta(
    inner: &PostgresInner,
    include_system: bool,
) -> Result<EngineMeta, EngineError> {
    let client = inner.conn().await;
    let rows = client
        .query(&table_list_sql(inner.kind, include_system), &[])
        .await?;
    let tables = rows
        .iter()
        .map(|row| display_name(&row.get::<_, String>(0), &row.get::<_, String>(1)))
        .collect();
    Ok(EngineMeta {
        kind: inner.kind.into(),
        path: Some(inner.label.clone()),
        demo: false,
        tables,
    })
}

pub(crate) async fn schema(
    inner: &PostgresInner,
    include_system: bool,
) -> Result<Vec<TableSchema>, EngineError> {
    let client = inner.conn().await;
    // One query for every table and its columns (rows arrive grouped by table)
    // instead of a separate column query per table.
    let rows = client
        .query(&schema_sql(inner.kind, include_system), &[])
        .await?;
    let mut out: Vec<TableSchema> = Vec::new();
    let mut current: Option<(String, String)> = None;
    for row in rows {
        let schema_name: String = row.get(0);
        let table_name: String = row.get(1);
        let same_table = current
            .as_ref()
            .is_some_and(|(schema, table)| *schema == schema_name && *table == table_name);
        if !same_table {
            out.push(TableSchema {
                name: display_name(&schema_name, &table_name),
                columns: Vec::new(),
            });
            current = Some((schema_name, table_name));
        }
        let Some(column_name) = row.get::<_, Option<String>>(2) else {
            continue;
        };
        if let Some(table) = out.last_mut() {
            table.columns.push(ColumnSchema {
                name: column_name,
                decl_type: row.get(3),
                not_null: row.get::<_, Option<bool>>(4).unwrap_or(false),
                pk: row.get(5),
                default: row.get(6),
                enum_values: None,
            });
        }
    }
    Ok(out)
}

pub(crate) async fn query(
    inner: &PostgresInner,
    sql: &str,
    max_rows: usize,
) -> Result<QueryData, EngineError> {
    let started = Instant::now();
    let controls = tx_controls(sql, Dialect::Postgres);
    let client = inner.conn().await;
    // Errors carry whether the statement got past Parse: one that never
    // ran cannot have ended a transaction.
    let read = async {
        let statement = client.prepare(sql).await.map_err(|err| (err, false))?;
        let columns: Vec<String> = statement
            .columns()
            .iter()
            .map(|col| col.name().to_string())
            .collect();
        let col_types: Vec<Type> = statement
            .columns()
            .iter()
            .map(|col| col.type_().clone())
            .collect();
        let col_count = columns.len();
        let mut column_values: Vec<Vec<Value>> = vec![Vec::new(); col_count];
        let mut count = 0usize;
        let mut truncated = false;
        let stream = client
            .query_prepared(&statement)
            .await
            .map_err(|err| (err, true))?;
        futures_util::pin_mut!(stream);
        while let Some(row) = stream.next().await {
            let row: Row = row.map_err(|err| {
                if aborts_transaction(&err) {
                    client.tx.failed();
                }
                (err, true)
            })?;
            if count >= max_rows {
                truncated = true;
                break;
            }
            for i in 0..col_count {
                column_values[i].push(pg_value(&row, i, &col_types[i]));
            }
            count += 1;
        }
        // Known once the stream ran out, which one with no columns always does.
        let rows_affected = if col_count == 0 {
            stream.rows_affected()
        } else {
            None
        };
        Ok::<_, (tokio_postgres::Error, bool)>((
            statement,
            columns,
            column_values,
            count,
            truncated,
            rows_affected,
        ))
    }
    .await;
    let (statement, columns, column_values, count, truncated, rows_affected) = match read {
        Ok(read) => read,
        Err((err, ran)) => return Err(statement_failed(inner, &controls, err, ran)),
    };

    // BEGIN, COMMIT and the like run from the editor move the transaction;
    // a COMMIT PostgreSQL turned into a rollback is reported as one.
    if inner.tx.track(&controls, &inner.log) {
        return Err(EngineError::TxRolledBack(ABORTED.into()));
    }
    let (source_table, pk) = detect_source(&client, &statement, &columns).await;
    let (schema, batches) = build_arrow(&columns, column_values, count)?;
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    Ok(QueryData {
        kind: inner.kind,
        columns,
        schema,
        batches,
        row_count: count,
        elapsed_ms,
        truncated,
        source_table,
        pk,
        // Booleans arrive as true and false.
        column_kinds: Vec::new(),
        rows_affected,
    })
}

/// The error a failed editor statement reports. A COMMIT or ROLLBACK among
/// `controls` that `ran` (got past Parse) has ended the transaction anyway
/// (PostgreSQL closes the block even when its COMMIT fails, on a deferred
/// constraint or a serialization failure), so History drops what it held; a
/// COMMIT lost with the connection may or may not have gone through.
fn statement_failed(
    inner: &PostgresInner,
    controls: &[TxControl],
    err: tokio_postgres::Error,
    ran: bool,
) -> EngineError {
    if failure_ends_tx(controls, ran) && inner.tx.is_open() {
        inner.tx.end(false, &inner.log);
        if controls.contains(&TxControl::Commit) && err.as_db_error().is_none() {
            return EngineError::TxOutcomeUnknown(format!(
                "연결이 끊겨 커밋되었는지 알 수 없습니다: {}",
                postgres_message(&err)
            ));
        }
    }
    err.into()
}

/// Whether a failed editor statement ended the transaction: a COMMIT or
/// ROLLBACK that got past Parse did, whatever went wrong after.
fn failure_ends_tx(controls: &[TxControl], ran: bool) -> bool {
    ran && controls
        .iter()
        .any(|control| matches!(control, TxControl::Commit | TxControl::Rollback))
}

/// What a cell is written as: its text bound at `position` and cast to the
/// column's type, or the keyword or function an expression stands for (the
/// time cast the same way, so a date or time column takes it as it is).
fn value_sql(expr: Option<ValueExpr>, position: usize, column_type: &str) -> String {
    match expr {
        None => format!("(${position}::text)::{column_type}"),
        Some(ValueExpr::Default) => "DEFAULT".into(),
        Some(ValueExpr::Now) => format!("now()::{column_type}"),
    }
}

pub(crate) async fn edit(inner: &PostgresInner, target: &EditTarget) -> Result<u64, EngineError> {
    if target.pk.is_empty() {
        return Err(EngineError::NotEditable(
            "기본 키가 없어 편집할 수 없습니다".into(),
        ));
    }
    let client = inner.conn().await;
    let table = qualified_from_display(&target.table);
    check_key(&client, &table, &target.pk).await?;
    let column_type = column_type_of(&client, &table, &target.column).await?;

    let mut params: Vec<Option<String>> = Vec::with_capacity(target.pk.len() + 1);
    if target.expr.is_none() {
        params.push(target.value.clone());
    }
    let mut sql = format!(
        "UPDATE {table} SET {} = {} WHERE ",
        quote_ident(&target.column),
        value_sql(target.expr, 1, &column_type)
    );
    for (index, pk) in target.pk.iter().enumerate() {
        if index > 0 {
            sql.push_str(" AND ");
        }
        let pk_type = column_type_of(&client, &table, &pk.column).await?;
        params.push(pk_value_string(&pk.value));
        let position = params.len();
        if pk.value.is_null() {
            sql.push_str(&format!(
                "{} IS NOT DISTINCT FROM (${position}::text)::{pk_type}",
                quote_ident(&pk.column)
            ));
        } else {
            sql.push_str(&format!(
                "{} = (${position}::text)::{pk_type}",
                quote_ident(&pk.column)
            ));
        }
    }

    let refs: Vec<&dyn PgParam> = params.iter().map(|param| param as &dyn PgParam).collect();
    let changed = client.change(&sql, &refs).await?;
    Ok(changed)
}

pub(crate) async fn insert_row(
    inner: &PostgresInner,
    table: &str,
    values: &[InsertValue],
) -> Result<u64, EngineError> {
    let client = inner.conn().await;
    let table_ref = qualified_from_display(table);
    let mut params: Vec<Option<String>> = Vec::with_capacity(values.len());
    let sql = if values.is_empty() {
        format!("INSERT INTO {table_ref} DEFAULT VALUES")
    } else {
        let columns = values
            .iter()
            .map(|value| quote_ident(&value.column))
            .collect::<Vec<_>>()
            .join(", ");
        let mut placeholders = Vec::with_capacity(values.len());
        for value in values {
            let column_type = column_type_of(&client, &table_ref, &value.column).await?;
            if value.expr.is_none() {
                params.push(value.value.clone());
            }
            placeholders.push(value_sql(value.expr, params.len(), &column_type));
        }
        format!(
            "INSERT INTO {table_ref} ({columns}) VALUES ({})",
            placeholders.join(", ")
        )
    };
    let refs: Vec<&dyn PgParam> = params.iter().map(|param| param as &dyn PgParam).collect();
    let changed = client.change(&sql, &refs).await?;
    Ok(changed)
}

pub(crate) async fn delete_row(
    inner: &PostgresInner,
    table: &str,
    pk: &[PkValue],
) -> Result<u64, EngineError> {
    if pk.is_empty() {
        return Err(EngineError::BadRequest("PK 조건이 필요합니다".into()));
    }
    let client = inner.conn().await;
    let table_ref = qualified_from_display(table);
    check_key(&client, &table_ref, pk).await?;
    let mut sql = format!("DELETE FROM {table_ref} WHERE ");
    let mut params: Vec<Option<String>> = Vec::with_capacity(pk.len());
    for (index, condition) in pk.iter().enumerate() {
        if index > 0 {
            sql.push_str(" AND ");
        }
        let pk_type = column_type_of(&client, &table_ref, &condition.column).await?;
        let position = index + 1;
        if condition.value.is_null() {
            sql.push_str(&format!(
                "{} IS NOT DISTINCT FROM (${position}::text)::{pk_type}",
                quote_ident(&condition.column)
            ));
        } else {
            sql.push_str(&format!(
                "{} = (${position}::text)::{pk_type}",
                quote_ident(&condition.column)
            ));
        }
        params.push(pk_value_string(&condition.value));
    }
    let refs: Vec<&dyn PgParam> = params.iter().map(|param| param as &dyn PgParam).collect();
    let changed = client.change(&sql, &refs).await?;
    Ok(changed)
}

const DETAIL_SAVEPOINT: &str = "tablepeek_detail";

pub(crate) async fn table_detail(
    inner: &PostgresInner,
    name: &str,
) -> Result<TableDetail, EngineError> {
    let client = inner.conn().await;
    // The lookups below may fail on servers that lack a catalog view or
    // function (CockroachDB has no pg_table_size, say). Inside the user's open
    // transaction one failed statement aborts it, and a later COMMIT quietly
    // rolls back, so there a savepoint fences them off. now() is the
    // transaction's start, so it differs from statement_timestamp() only
    // inside an explicit transaction block.
    let in_block = client
        .query_one("SELECT now() <> statement_timestamp()", &[])
        .await
        .map(|row| row.get::<_, bool>(0))
        .unwrap_or(true);
    let fenced = in_block
        && client
            .batch_execute(&format!("SAVEPOINT {DETAIL_SAVEPOINT}"))
            .await
            .is_ok();
    let detail = table_detail_in(&client, inner, name, fenced).await;
    if fenced {
        if detail.is_err() {
            recover(&client, fenced).await;
        }
        let _ = client
            .batch_execute(&format!("RELEASE SAVEPOINT {DETAIL_SAVEPOINT}"))
            .await;
    }
    detail
}

// After a failed lookup inside the fence, return to the savepoint so the
// transaction stays usable for the next statement.
async fn recover(client: &PgConn<'_>, fenced: bool) {
    if fenced
        && client
            .batch_execute(&format!("ROLLBACK TO SAVEPOINT {DETAIL_SAVEPOINT}"))
            .await
            .is_ok()
    {
        client.tx.recovered();
    }
}

async fn ok_or_recover<T>(
    client: &PgConn<'_>,
    fenced: bool,
    result: Result<T, tokio_postgres::Error>,
) -> Option<T> {
    match result {
        Ok(value) => Some(value),
        Err(_) => {
            recover(client, fenced).await;
            None
        }
    }
}

/// Splits "CREATE TRIGGER n BEFORE INSERT OR UPDATE ON t ..." into timing and event.
pub(crate) fn trigger_timing_event(definition: &str) -> (Option<String>, Option<String>) {
    let upper = definition.to_uppercase();
    let words: Vec<&str> = upper.split_whitespace().collect();
    let Some(start) = words
        .iter()
        .position(|word| matches!(*word, "BEFORE" | "AFTER" | "INSTEAD"))
    else {
        return (None, None);
    };
    let (timing, rest) = if words[start] == "INSTEAD" {
        ("INSTEAD OF", words.get(start + 2..).unwrap_or(&[]))
    } else {
        (words[start], words.get(start + 1..).unwrap_or(&[]))
    };
    let mut events: Vec<&str> = Vec::new();
    for word in rest {
        match *word {
            "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE" => events.push(word),
            "OR" => {}
            "OF" if events.last() == Some(&"UPDATE") => {}
            "ON" => break,
            _ => {}
        }
    }
    let event = (!events.is_empty()).then(|| events.join(" OR "));
    (Some(timing.to_string()), event)
}

async fn table_detail_in(
    client: &PgConn<'_>,
    inner: &PostgresInner,
    name: &str,
    fenced: bool,
) -> Result<TableDetail, EngineError> {
    let (schema_name, table_name) = split_display(name);
    let relation = client
        .query_opt(
            "SELECT c.oid FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relname = $2
               AND c.relkind IN ('r','p','v','m','f')",
            &[&schema_name, &table_name],
        )
        .await?;
    let Some(row) = relation else {
        return Err(EngineError::TableNotFound);
    };
    let oid: u32 = row.get(0);
    let qualified_ref = qualified(&schema_name, &table_name);

    let mut columns = client
        .query(COLUMN_SQL, &[&qualified_ref])
        .await?
        .iter()
        .map(|col| ColumnSchema {
            name: col.get(0),
            decl_type: Some(col.get(1)),
            not_null: col.get(2),
            pk: col.get(3),
            default: col.get(4),
            enum_values: None,
        })
        .collect::<Vec<_>>();
    // Enum columns' values in their declared order; a server without
    // pg_enum leaves them out.
    let enums = client
        .query(
            "SELECT a.attname, array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
             FROM pg_attribute a
             JOIN pg_enum e ON e.enumtypid = a.atttypid
             WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
             GROUP BY a.attname",
            &[&oid],
        )
        .await;
    for row in ok_or_recover(client, fenced, enums)
        .await
        .unwrap_or_default()
    {
        let name: String = row.get(0);
        if let Some(column) = columns.iter_mut().find(|column| column.name == name) {
            column.enum_values = row.get(1);
        }
    }

    let mut indexes: Vec<IndexInfo> = Vec::new();
    if let Ok(index_rows) = client
        .query(
            "SELECT c2.relname, i.indisunique, i.indisprimary,
                    (SELECT array_agg(a.attname::text ORDER BY k.ord)
                     FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
                     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
             FROM pg_index i
             JOIN pg_class c2 ON c2.oid = i.indexrelid
             WHERE i.indrelid = $1
             ORDER BY c2.relname",
            &[&oid],
        )
        .await
    {
        for row in index_rows {
            indexes.push(IndexInfo {
                name: row.get(0),
                unique: row.get(1),
                primary: row.get(2),
                columns: row.get::<_, Option<Vec<String>>>(3).unwrap_or_default(),
            });
        }
    } else {
        recover(client, fenced).await;
    }
    indexes.sort_by(|a, b| a.name.cmp(&b.name));

    let mut foreign_keys: Vec<ForeignKeyInfo> = Vec::new();
    if let Ok(fk_rows) = client
        .query(
            "SELECT c.conname,
                    (SELECT array_agg(a.attname::text ORDER BY k.ord)
                     FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum),
                    fn.nspname, fc.relname,
                    (SELECT array_agg(a.attname::text ORDER BY k.ord)
                     FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
                     JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum)
             FROM pg_constraint c
             JOIN pg_class fc ON fc.oid = c.confrelid
             JOIN pg_namespace fn ON fn.oid = fc.relnamespace
             WHERE c.conrelid = $1 AND c.contype = 'f'
             ORDER BY c.conname",
            &[&oid],
        )
        .await
    {
        for row in fk_rows {
            let ref_schema: String = row.get(2);
            let ref_name: String = row.get(3);
            foreign_keys.push(ForeignKeyInfo {
                name: row.get(0),
                columns: row.get::<_, Option<Vec<String>>>(1).unwrap_or_default(),
                ref_table: display_name(&ref_schema, &ref_name),
                ref_columns: row.get::<_, Option<Vec<String>>>(4).unwrap_or_default(),
            });
        }
    } else {
        recover(client, fenced).await;
    }

    let mut row_count_estimate = ok_or_recover(
        client,
        fenced,
        client
            .query_opt(
                "SELECT reltuples::bigint FROM pg_class WHERE oid = $1",
                &[&oid],
            )
            .await,
    )
    .await
    .flatten()
    .and_then(|row| row.get::<_, Option<i64>>(0))
    .filter(|count| *count >= 0);
    if row_count_estimate.is_none() && inner.kind == "cockroach" {
        // CockroachDB leaves reltuples empty, and from v26.3 refuses
        // crdb_internal, where the estimate used to come from, unless a
        // session turns allow_unsafe_internals on. The newest statistics'
        // row count is the estimate (SHOW TABLES shows it only seconds
        // later); with none collected yet, SHOW TABLES says 0.
        let estimate_sql = format!(
            "SELECT COALESCE(\
             (SELECT row_count FROM [SHOW STATISTICS FOR TABLE {qualified_ref}] \
              ORDER BY created DESC LIMIT 1), \
             (SELECT estimated_row_count FROM [SHOW TABLES] \
              WHERE schema_name = $1 AND table_name = $2))"
        );
        row_count_estimate = ok_or_recover(
            client,
            fenced,
            client
                .query_opt(&estimate_sql, &[&schema_name, &table_name])
                .await,
        )
        .await
        .flatten()
        .and_then(|row| row.get::<_, Option<i64>>(0))
        .filter(|count| *count >= 0);
    }

    let sizes = ok_or_recover(
        client,
        fenced,
        client
            .query_opt(
                "SELECT pg_table_size($1::oid), pg_indexes_size($1::oid), \
                 pg_total_relation_size($1::oid)",
                &[&oid],
            )
            .await,
    )
    .await
    .flatten()
    .map(|row| {
        (
            row.get::<_, Option<i64>>(0),
            row.get::<_, Option<i64>>(1),
            row.get::<_, Option<i64>>(2),
        )
    });
    // CockroachDB may lack the split size functions; keep the total-only query
    // as a fallback so size_bytes never regresses.
    let (data_bytes, index_bytes, size_bytes) = match sizes {
        Some(sizes) => sizes,
        None => (
            None,
            None,
            ok_or_recover(
                client,
                fenced,
                client
                    .query_opt("SELECT pg_total_relation_size($1::oid)", &[&oid])
                    .await,
            )
            .await
            .flatten()
            .map(|row| row.get::<_, i64>(0)),
        ),
    };

    let comment = ok_or_recover(
        client,
        fenced,
        client
            .query_opt("SELECT obj_description($1::oid, 'pg_class')", &[&oid])
            .await,
    )
    .await
    .flatten()
    .and_then(|row| row.get::<_, Option<String>>(0))
    .filter(|text| !text.is_empty());

    // CockroachDB has no pg_trigger; a failed lookup just shows no triggers.
    let triggers = ok_or_recover(
        client,
        fenced,
        client
            .query(
                "SELECT t.tgname, pg_get_triggerdef(t.oid) FROM pg_trigger t \
                 WHERE t.tgrelid = $1 AND NOT t.tgisinternal ORDER BY t.tgname",
                &[&oid],
            )
            .await,
    )
    .await
    .unwrap_or_default()
    .into_iter()
    .map(|row| {
        let definition: Option<String> = row.get(1);
        let (timing, event) = definition
            .as_deref()
            .map(trigger_timing_event)
            .unwrap_or((None, None));
        TriggerInfo {
            name: row.get(0),
            timing,
            event,
            definition,
        }
    })
    .collect();

    Ok(TableDetail {
        name: display_name(&schema_name, &table_name),
        row_count_estimate,
        size_bytes,
        data_bytes,
        index_bytes,
        comment,
        ddl: Some(build_create_table(&qualified_ref, &columns)),
        columns,
        indexes,
        foreign_keys,
        triggers,
        schema: Some(schema_name.clone()),
    })
}

pub(crate) async fn server_info(inner: &PostgresInner) -> Result<ServerInfo, EngineError> {
    let client = inner.conn().await;
    let version: String = client.query_one("SELECT version()", &[]).await?.get(0);
    let database: Option<String> = client
        .query_opt("SELECT current_database()", &[])
        .await
        .ok()
        .flatten()
        .map(|row| row.get(0));
    let encoding = client
        .query_opt(
            "SELECT pg_encoding_to_char(encoding) FROM pg_database WHERE datname = current_database()",
            &[],
        )
        .await
        .ok()
        .flatten()
        .map(|row| row.get::<_, String>(0));
    let uptime = client
        .query_opt(
            "SELECT extract(epoch from (now() - pg_postmaster_start_time()))::bigint",
            &[],
        )
        .await
        .ok()
        .flatten()
        .map(|row| humanize_uptime_ko(row.get::<_, i64>(0)));
    let size_bytes = client
        .query_opt("SELECT pg_database_size(current_database())", &[])
        .await
        .ok()
        .flatten()
        .map(|row| row.get::<_, i64>(0));
    let sessions = pg_sessions(&client, inner.backend_pid).await.ok();
    Ok(ServerInfo {
        driver: inner.kind.into(),
        version: Some(version),
        database,
        encoding,
        uptime,
        size_bytes,
        sessions,
        can_kill: true,
    })
}

async fn pg_sessions(
    client: &PgConn<'_>,
    backend_pid: i32,
) -> Result<Vec<ServerSession>, EngineError> {
    let rows = client
        .query(
            "SELECT pid, usename, datname, state, query,
                    CASE WHEN query_start IS NOT NULL
                         THEN (extract(epoch from (now() - query_start)) * 1000)::bigint
                    END
             FROM pg_stat_activity
             ORDER BY pid",
            &[],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|row| {
            let pid: i32 = row.get(0);
            ServerSession {
                id: pid.to_string(),
                user: row.get(1),
                database: row.get(2),
                state: row.get(3),
                query: row.get(4),
                elapsed_ms: row.get(5),
                is_current: pid == backend_pid,
            }
        })
        .collect())
}

pub(crate) async fn objects(
    inner: &PostgresInner,
    include_system: bool,
) -> Result<DbObjects, EngineError> {
    let client = inner.conn().await;
    let system_filter = if include_system {
        "('')"
    } else if inner.kind == "cockroach" {
        "('pg_catalog','information_schema','crdb_internal','pg_extension')"
    } else {
        "('pg_catalog','information_schema')"
    };

    let views = client
        .query(
            &format!(
                "SELECT table_schema, table_name FROM information_schema.views
                 WHERE table_schema NOT IN {system_filter}
                 ORDER BY table_schema, table_name"
            ),
            &[],
        )
        .await
        .map(|rows| {
            rows.iter()
                .map(|row| display_name(&row.get::<_, String>(0), &row.get::<_, String>(1)))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let functions = client
        .query(
            &format!(
                "SELECT DISTINCT n.nspname, p.proname
                 FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname NOT IN {system_filter}
                   AND p.prokind = 'f'
                 ORDER BY n.nspname, p.proname"
            ),
            &[],
        )
        .await
        .map(|rows| {
            rows.iter()
                .map(|row| display_name(&row.get::<_, String>(0), &row.get::<_, String>(1)))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let procedures = client
        .query(
            &format!(
                "SELECT DISTINCT n.nspname, p.proname
                 FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname NOT IN {system_filter}
                   AND p.prokind = 'p'
                 ORDER BY n.nspname, p.proname"
            ),
            &[],
        )
        .await
        .map(|rows| {
            rows.iter()
                .map(|row| display_name(&row.get::<_, String>(0), &row.get::<_, String>(1)))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let triggers = client
        .query(
            &format!(
                "SELECT DISTINCT trigger_schema, trigger_name
                 FROM information_schema.triggers
                 WHERE trigger_schema NOT IN {system_filter}
                 ORDER BY trigger_schema, trigger_name"
            ),
            &[],
        )
        .await
        .map(|rows| {
            rows.iter()
                .map(|row| display_name(&row.get::<_, String>(0), &row.get::<_, String>(1)))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let sequences = client
        .query(
            &format!(
                "SELECT sequence_schema, sequence_name
                 FROM information_schema.sequences
                 WHERE sequence_schema NOT IN {system_filter}
                 ORDER BY sequence_schema, sequence_name"
            ),
            &[],
        )
        .await
        .map(|rows| {
            rows.iter()
                .map(|row| display_name(&row.get::<_, String>(0), &row.get::<_, String>(1)))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(DbObjects {
        views: sort_dedup(views),
        functions: sort_dedup(functions),
        triggers: sort_dedup(triggers),
        sequences: sort_dedup(sequences),
        procedures: sort_dedup(procedures),
    })
}

pub(crate) async fn table_count(inner: &PostgresInner, name: &str) -> Result<i64, EngineError> {
    let client = inner.conn().await;
    let row = client
        .query_one(
            &format!("SELECT COUNT(*) FROM {}", qualified_from_display(name)),
            &[],
        )
        .await?;
    Ok(row.get::<_, i64>(0))
}

pub(crate) async fn databases(inner: &PostgresInner) -> Result<Vec<String>, EngineError> {
    let client = inner.conn().await;
    if inner.kind == "cockroach" {
        let rows = client.query("SHOW DATABASES", &[]).await?;
        return Ok(rows
            .iter()
            .map(|row| row.get::<_, String>(0))
            .collect::<Vec<_>>());
    }
    let rows = client
        .query(
            "SELECT datname FROM pg_database
             WHERE datistemplate = false AND datallowconn
             ORDER BY datname",
            &[],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|row| row.get::<_, String>(0))
        .collect::<Vec<_>>())
}

pub(crate) async fn object_definition(
    inner: &PostgresInner,
    kind: &str,
    name: &str,
) -> Result<Option<ObjectDefinition>, EngineError> {
    let client = inner.conn().await;
    let (schema_name, object_name) = split_display(name);
    let found: Option<Option<String>> = match kind {
        "view" => match client
            .query_opt(
                "SELECT pg_get_viewdef(c.oid, true)
                 FROM pg_class c
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'v'",
                &[&schema_name, &object_name],
            )
            .await
        {
            Ok(Some(row)) => Some(Some(row.get::<_, String>(0))),
            Ok(None) => None,
            Err(err) => return Err(err.into()),
        },
        "function" => {
            let result = client
                .query_opt(
                    "SELECT p.oid::regprocedure::text, pg_get_functiondef(p.oid)
                     FROM pg_proc p
                     JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = $1 AND p.proname = $2
                     ORDER BY p.oid LIMIT 1",
                    &[&schema_name, &object_name],
                )
                .await;
            match result {
                Ok(Some(row)) => Some(Some(row.get::<_, String>(1))),
                Ok(None) => None,
                Err(_) => {
                    if exists_in(&client, PG_FUNCTION_EXISTS, &schema_name, &object_name).await {
                        Some(None)
                    } else {
                        None
                    }
                }
            }
        }
        "procedure" => {
            let result = client
                .query_opt(
                    "SELECT p.oid::regprocedure::text, pg_get_functiondef(p.oid)
                     FROM pg_proc p
                     JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind = 'p'
                     ORDER BY p.oid LIMIT 1",
                    &[&schema_name, &object_name],
                )
                .await;
            match result {
                Ok(Some(row)) => Some(Some(row.get::<_, String>(1))),
                Ok(None) => None,
                Err(_) => {
                    if exists_in(&client, PG_FUNCTION_EXISTS, &schema_name, &object_name).await {
                        Some(None)
                    } else {
                        None
                    }
                }
            }
        }
        "trigger" => {
            let result = client
                .query_opt(
                    "SELECT pg_get_triggerdef(t.oid)
                     FROM pg_trigger t
                     JOIN pg_class c ON c.oid = t.tgrelid
                     JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = $1 AND t.tgname = $2 AND NOT t.tgisinternal
                     ORDER BY t.oid LIMIT 1",
                    &[&schema_name, &object_name],
                )
                .await;
            match result {
                Ok(Some(row)) => Some(Some(row.get::<_, String>(0))),
                Ok(None) => None,
                Err(_) => {
                    if exists_in(&client, PG_TRIGGER_EXISTS, &schema_name, &object_name).await {
                        Some(None)
                    } else {
                        None
                    }
                }
            }
        }
        "sequence" => {
            let primary = client
                .query_opt(
                    "SELECT 1 FROM information_schema.sequences
                     WHERE sequence_schema = $1 AND sequence_name = $2",
                    &[&schema_name, &object_name],
                )
                .await
                .ok()
                .flatten();
            if primary.is_some()
                || exists_in(&client, PG_SEQUENCE_EXISTS, &schema_name, &object_name).await
            {
                Some(None)
            } else {
                None
            }
        }
        _ => None,
    };
    let Some(ddl) = found else {
        return Ok(None);
    };
    Ok(Some(ObjectDefinition {
        name: display_name(&schema_name, &object_name),
        kind: kind.to_string(),
        ddl,
    }))
}

const PG_FUNCTION_EXISTS: &str = "SELECT 1 FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = $1 AND p.proname = $2 LIMIT 1";

const PG_TRIGGER_EXISTS: &str = "SELECT 1 FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND t.tgname = $2 AND NOT t.tgisinternal LIMIT 1";

const PG_SEQUENCE_EXISTS: &str = "SELECT 1 FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'S' LIMIT 1";

async fn exists_in(client: &PgConn<'_>, sql: &str, schema_name: &str, object_name: &str) -> bool {
    client
        .query_opt(sql, &[&schema_name, &object_name])
        .await
        .ok()
        .flatten()
        .is_some()
}

pub(crate) async fn kill_session(inner: &PostgresInner, id: u64) -> Result<(), EngineError> {
    if inner.backend_pid != 0 && id == inner.backend_pid as u64 {
        return Err(EngineError::BadRequest(
            "자신의 연결은 종료할 수 없습니다".into(),
        ));
    }
    let client = inner.conn().await;
    let terminated = client
        .query_opt("SELECT pg_terminate_backend($1::int)", &[&(id as i32)])
        .await?;
    match terminated.and_then(|row| row.get::<_, Option<bool>>(0)) {
        Some(true) => Ok(()),
        _ => Err(EngineError::SessionNotFound),
    }
}

fn sort_dedup(mut names: Vec<String>) -> Vec<String> {
    names.sort();
    names.dedup();
    names
}

fn split_display(display: &str) -> (String, String) {
    match display.trim().split_once('.') {
        Some((schema, table)) => (trim_quotes(schema), trim_quotes(table)),
        None => ("public".into(), trim_quotes(display)),
    }
}

fn trim_quotes(name: &str) -> String {
    name.trim()
        .trim_matches(|c| matches!(c, '"' | '\'' | '`' | '[' | ']'))
        .to_string()
}

fn build_create_table(qualified_ref: &str, columns: &[ColumnSchema]) -> String {
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
        if column.default.is_some() {
            line.push_str(&format!(" DEFAULT {}", column.default.as_deref().unwrap()));
        }
        lines.push(line);
        if column.pk {
            pk_columns.push(quote_ident(&column.name));
        }
    }
    if !pk_columns.is_empty() {
        lines.push(format!("  PRIMARY KEY ({})", pk_columns.join(", ")));
    }
    format!("CREATE TABLE {qualified_ref} (\n{}\n)", lines.join(",\n"))
}

pub(crate) async fn tx(inner: &PostgresInner, statement: &str) -> Result<(), EngineError> {
    let active = inner.in_tx();
    match statement {
        "BEGIN" if active => {
            return Err(EngineError::Internal(
                "이미 트랜잭션이 진행 중입니다".into(),
            ));
        }
        "COMMIT" | "ROLLBACK" if !active => {
            return Err(EngineError::Internal(
                "진행 중인 트랜잭션이 없습니다".into(),
            ));
        }
        _ => {}
    }
    // Everything below runs under the lock, so no change slips between the
    // statement and the bookkeeping.
    let client = inner.conn().await;
    // PostgreSQL answers COMMIT of an aborted transaction with a rollback:
    // say so rather than report a commit.
    if statement == "COMMIT" && inner.tx.is_aborted() {
        let _ = client.batch_execute("ROLLBACK").await;
        inner.tx.end(false, &inner.log);
        return Err(EngineError::TxRolledBack(ABORTED.into()));
    }
    match client.batch_execute(statement).await {
        Ok(()) if statement == "BEGIN" => inner.tx.begin(&inner.log),
        Ok(()) => {
            inner.tx.end(statement == "COMMIT", &inner.log);
        }
        // A COMMIT the server refused (a deferred constraint, say) ended the
        // transaction rolled back; one lost with the connection may or may
        // not have committed. Either way it is over, and History keeps none
        // of it.
        Err(err) if statement == "COMMIT" => {
            inner.tx.end(false, &inner.log);
            let message = postgres_message(&err);
            return Err(if err.as_db_error().is_some() {
                EngineError::TxRolledBack(format!(
                    "커밋하지 못해 트랜잭션을 롤백했습니다: {message}"
                ))
            } else {
                EngineError::TxOutcomeUnknown(format!(
                    "연결이 끊겨 커밋되었는지 알 수 없습니다: {message}"
                ))
            });
        }
        Err(err) => return Err(err.into()),
    }
    Ok(())
}

fn schema_sql(kind: &str, include_system: bool) -> String {
    let tables = table_list_sql(kind, include_system);
    let filters = tables
        .split_once("WHERE ")
        .and_then(|(_, rest)| rest.split_once("\n     ORDER BY"))
        .map(|(filters, _)| filters.to_string())
        .unwrap_or_else(|| "true".to_string());
    format!(
        "SELECT n.nspname, c.relname, a.attname,
            format_type(a.atttypid, a.atttypmod),
            a.attnotnull,
            EXISTS (
                SELECT 1 FROM pg_index i
                WHERE i.indrelid = a.attrelid
                  AND i.indisprimary
                  AND a.attnum = ANY(i.indkey)
            ) AS is_pk,
            pg_get_expr(d.adbin, d.adrelid)
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_attribute a
       ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE {filters}
     ORDER BY n.nspname, c.relname, a.attnum"
    )
}

fn table_list_sql(kind: &str, include_system: bool) -> String {
    let mut filters = vec![
        "n.nspname NOT LIKE 'pg_toast%'",
        "n.nspname NOT LIKE 'pg_temp%'",
    ];
    if !include_system {
        filters.push(if kind == "cockroach" {
            "n.nspname NOT IN ('pg_catalog','information_schema','crdb_internal','pg_extension')"
        } else {
            "n.nspname NOT IN ('pg_catalog','information_schema')"
        });
    }
    format!(
        "SELECT n.nspname, c.relname
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r','p','v','m')
       AND {}
     ORDER BY n.nspname, c.relname",
        filters.join("\n       AND ")
    )
}

const COLUMN_SQL: &str = "SELECT a.attname,
            format_type(a.atttypid, a.atttypmod),
            a.attnotnull,
            EXISTS (
                SELECT 1 FROM pg_index i
                WHERE i.indrelid = a.attrelid
                  AND i.indisprimary
                  AND a.attnum = ANY(i.indkey)
            ) AS is_pk,
            pg_get_expr(d.adbin, d.adrelid)
     FROM pg_attribute a
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = $1::text::regclass
       AND a.attnum > 0
       AND NOT a.attisdropped
     ORDER BY a.attnum";

/// A SELECT's table by the oid its columns carry, and its primary key
/// columns in key order: one row per key column, or one with a NULL name for
/// a table without a key.
const SOURCE_SQL: &str = "SELECT n.nspname, c.relname, a.attname::text
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
     LEFT JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
     LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
     WHERE c.oid = $1
     ORDER BY k.ord";

/// A table's primary key columns now, by name.
const KEY_SQL: &str = "SELECT a.attname::text
     FROM pg_index i
     JOIN LATERAL unnest(i.indkey) AS k(attnum) ON true
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
     WHERE i.indrelid = $1::text::regclass AND i.indisprimary";

/// The table a SELECT read and its primary key, when the result holds every
/// key column: one catalog query per SELECT, never kept. A kept name could
/// outlive a rename in another session (a table swapped for another under
/// the same name) and send edits to the wrong table.
async fn detect_source(
    client: &PgConn<'_>,
    statement: &tokio_postgres::Statement,
    columns: &[String],
) -> (Option<String>, Option<Vec<String>>) {
    let mut oid: Option<u32> = None;
    for col in statement.columns() {
        match (col.table_oid(), oid) {
            (Some(current), None) => oid = Some(current),
            (Some(current), Some(existing)) if current == existing => {}
            _ => return (None, None),
        }
    }
    let Some(oid) = oid else {
        return (None, None);
    };
    let Ok(rows) = client.query(SOURCE_SQL, &[&oid]).await else {
        return (None, None);
    };
    let Some(first) = rows.first() else {
        return (None, None);
    };
    let source_table = display_name(&first.get::<_, String>(0), &first.get::<_, String>(1));
    let names: Vec<String> = rows
        .iter()
        .filter_map(|row| row.get::<_, Option<String>>(2))
        .collect();
    let pk =
        (!names.is_empty() && names.iter().all(|name| columns.contains(name))).then_some(names);
    (Some(source_table), pk)
}

/// Refuses a write keyed on columns that aren't the table's primary key now
/// (see `key_unchanged`).
async fn check_key(client: &PgConn<'_>, table: &str, pk: &[PkValue]) -> Result<(), EngineError> {
    let rows = client.query(KEY_SQL, &[&table]).await?;
    let current: Vec<String> = rows.iter().map(|row| row.get::<_, String>(0)).collect();
    if key_unchanged(&current, pk, false) {
        Ok(())
    } else {
        Err(EngineError::NotEditable(KEY_CHANGED.into()))
    }
}

async fn column_type_of(
    client: &PgConn<'_>,
    table: &str,
    column: &str,
) -> Result<String, EngineError> {
    let row = client
        .query_opt(
            "SELECT format_type(a.atttypid, a.atttypmod)
             FROM pg_attribute a
             WHERE a.attrelid = $1::text::regclass
               AND a.attname = $2
               AND a.attnum > 0
               AND NOT a.attisdropped",
            &[&table, &column],
        )
        .await?;
    row.map(|row| row.get::<_, String>(0))
        .ok_or_else(|| EngineError::NotEditable(format!("컬럼을 찾을 수 없습니다: {column}")))
}

fn display_name(schema: &str, table: &str) -> String {
    if schema == "public" {
        table.to_string()
    } else {
        format!("{schema}.{table}")
    }
}

fn qualified(schema: &str, table: &str) -> String {
    format!("{}.{}", quote_ident(schema), quote_ident(table))
}

fn qualified_from_display(display: &str) -> String {
    match display.split_once('.') {
        Some((schema, table)) => qualified(schema, table),
        None => qualified("public", display),
    }
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn pk_value_string(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(if *flag { "true".into() } else { "false".into() }),
        other => Some(other.to_string()),
    }
}

/// A value as the server sent it, in binary, whatever its type.
struct RawValue<'a>(&'a [u8]);

impl<'a> FromSql<'a> for RawValue<'a> {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        Ok(RawValue(raw))
    }

    fn accepts(_: &Type) -> bool {
        true
    }
}

fn pg_value(row: &Row, index: usize, dtype: &Type) -> Value {
    match row.try_get::<usize, Option<RawValue>>(index) {
        Ok(Some(RawValue(raw))) => pg_json(dtype, raw),
        Ok(None) => Value::Null,
        Err(_) => unreadable(dtype),
    }
}

/// One value for the grid: numbers and booleans as JSON ones, a blob as
/// its size, and everything else as text.
fn pg_json(dtype: &Type, raw: &[u8]) -> Value {
    let value = match *dtype {
        Type::INT2 => decode::<i16>(dtype, raw).map(|value| Value::from(i64::from(value))),
        Type::INT4 => decode::<i32>(dtype, raw).map(|value| Value::from(i64::from(value))),
        Type::INT8 => decode::<i64>(dtype, raw).map(Value::from),
        Type::OID => decode::<u32>(dtype, raw).map(|value| Value::from(i64::from(value))),
        Type::FLOAT4 => decode::<f32>(dtype, raw).map(real_json),
        Type::FLOAT8 => decode::<f64>(dtype, raw).map(double_json),
        Type::BOOL => decode::<bool>(dtype, raw).map(Value::Bool),
        Type::BYTEA => Some(Value::from(format!("<blob {} bytes>", raw.len()))),
        _ => pg_text(dtype, raw).map(Value::from),
    };
    value.unwrap_or_else(|| unreadable(dtype))
}

/// What a value of a type TablePeek can't read shows as.
fn unreadable(dtype: &Type) -> Value {
    Value::from(format!("<{}>", dtype.name()))
}

fn decode<'a, T: FromSql<'a>>(dtype: &Type, raw: &'a [u8]) -> Option<T> {
    T::from_sql(dtype, raw).ok()
}

/// A value as PostgreSQL prints it, read from its binary form, so that an
/// edit sends it back as it came; `None` for a type it can't read.
fn pg_text(dtype: &Type, raw: &[u8]) -> Option<String> {
    if let Some(word) = infinite_time(dtype, raw) {
        return Some(word.to_owned());
    }
    let text = match *dtype {
        Type::INT2 => decode::<i16>(dtype, raw)?.to_string(),
        Type::INT4 => decode::<i32>(dtype, raw)?.to_string(),
        Type::INT8 => decode::<i64>(dtype, raw)?.to_string(),
        Type::OID => decode::<u32>(dtype, raw)?.to_string(),
        Type::FLOAT4 => float_text(decode::<f32>(dtype, raw)?),
        Type::FLOAT8 => float_text(decode::<f64>(dtype, raw)?),
        Type::NUMERIC => numeric_text(raw)?,
        Type::BOOL => if decode::<bool>(dtype, raw)? {
            "t"
        } else {
            "f"
        }
        .to_owned(),
        Type::CHAR => char::from(decode::<i8>(dtype, raw)? as u8).to_string(),
        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME | Type::UNKNOWN => {
            decode::<&str>(dtype, raw)?.to_owned()
        }
        Type::DATE => decode::<chrono::NaiveDate>(dtype, raw)?.to_string(),
        Type::TIME => trim_fraction(decode::<chrono::NaiveTime>(dtype, raw)?.to_string()),
        Type::TIMESTAMP => trim_fraction(decode::<chrono::NaiveDateTime>(dtype, raw)?.to_string()),
        Type::TIMESTAMPTZ => trim_fraction(
            decode::<chrono::DateTime<chrono::Utc>>(dtype, raw)?
                .format("%Y-%m-%d %H:%M:%S%.f%:z")
                .to_string(),
        ),
        Type::UUID => decode::<uuid::Uuid>(dtype, raw)?.to_string(),
        // The text the server keeps: parsed, a number past f64's digits
        // would be rounded.
        Type::JSON => std::str::from_utf8(raw).ok()?.to_owned(),
        Type::JSONB => match raw.split_first()? {
            (1, text) => std::str::from_utf8(text).ok()?.to_owned(),
            _ => return None,
        },
        Type::BYTEA => raw.iter().fold(String::from("\\x"), |mut hex, byte| {
            let _ = write!(hex, "{byte:02x}");
            hex
        }),
        _ => match dtype.kind() {
            // An enum travels as its label.
            Kind::Enum(_) => std::str::from_utf8(raw).ok()?.to_owned(),
            Kind::Array(member) => array_text(member, raw)?,
            _ => return None,
        },
    };
    Some(text)
}

/// The infinite dates and times, which chrono has no value for.
fn infinite_time(dtype: &Type, raw: &[u8]) -> Option<&'static str> {
    let (positive, negative) = match *dtype {
        Type::DATE => (raw == i32::MAX.to_be_bytes(), raw == i32::MIN.to_be_bytes()),
        Type::TIMESTAMP | Type::TIMESTAMPTZ => {
            (raw == i64::MAX.to_be_bytes(), raw == i64::MIN.to_be_bytes())
        }
        _ => return None,
    };
    if positive {
        Some("infinity")
    } else if negative {
        Some("-infinity")
    } else {
        None
    }
}

/// Fractional seconds without trailing zeros, as PostgreSQL prints them
/// (chrono pads them to 3, 6 or 9 digits).
fn trim_fraction(text: String) -> String {
    let Some(dot) = text.find('.') else {
        return text;
    };
    let digits = text[dot + 1..]
        .bytes()
        .take_while(u8::is_ascii_digit)
        .count();
    let kept = text[dot + 1..dot + 1 + digits].trim_end_matches('0').len();
    let cut = if kept == 0 { dot } else { dot + 1 + kept };
    format!("{}{}", &text[..cut], &text[dot + 1 + digits..])
}

/// A NUMERIC with every digit it has: it can hold far more than any
/// binary number type, rust_decimal's 28 digits included.
fn numeric_text(raw: &[u8]) -> Option<String> {
    let word = |at: usize| {
        raw.get(at * 2..at * 2 + 2)
            .map(|b| u16::from_be_bytes([b[0], b[1]]))
    };
    let digit_count = usize::from(word(0)?);
    // The first digit's power of 10000.
    let weight = i32::from(word(1)? as i16);
    let sign = word(2)?;
    let scale = usize::from(word(3)?);
    if raw.len() != 8 + digit_count * 2 {
        return None;
    }
    let digit = |power: i32| {
        usize::try_from(power)
            .ok()
            .filter(|&at| at < digit_count)
            .and_then(|at| word(4 + at))
            .unwrap_or(0)
    };
    let mut text = match sign {
        0x0000 => String::new(),
        0x4000 => String::from("-"),
        0xC000 => return Some("NaN".into()),
        0xD000 => return Some("Infinity".into()),
        0xF000 => return Some("-Infinity".into()),
        _ => return None,
    };
    if weight < 0 {
        text.push('0');
    }
    for power in 0..=weight {
        if power == 0 {
            let _ = write!(text, "{}", digit(power));
        } else {
            let _ = write!(text, "{:04}", digit(power));
        }
    }
    if scale > 0 {
        let mut fraction = String::new();
        let mut power = weight + 1;
        while fraction.len() < scale {
            let _ = write!(fraction, "{:04}", digit(power));
            power += 1;
        }
        fraction.truncate(scale);
        text.push('.');
        text.push_str(&fraction);
    }
    Some(text)
}

/// An array as PostgreSQL prints it: `{a,"b c",NULL}`, nested braces for
/// more dimensions, and bounds in front when they don't start at 1.
fn array_text(member: &Type, raw: &[u8]) -> Option<String> {
    let array = postgres_protocol::types::array_from_sql(raw).ok()?;
    let dimensions: Vec<ArrayDimension> = array.dimensions().collect().ok()?;
    let mut elements = Vec::new();
    let mut values = array.values();
    while let Some(value) = values.next().ok()? {
        elements.push(match value {
            Some(raw) => array_element(pg_text(member, raw)?),
            None => "NULL".to_owned(),
        });
    }
    // Dimensions that don't hold the elements sent: better unreadable than wrong.
    let cells = dimensions
        .iter()
        .map(|dimension| i64::from(dimension.len))
        .product::<i64>();
    if i64::try_from(elements.len()).ok()? != if dimensions.is_empty() { 0 } else { cells } {
        return None;
    }
    let mut text = String::new();
    if dimensions
        .iter()
        .any(|dimension| dimension.lower_bound != 1)
    {
        for dimension in &dimensions {
            let upper = dimension.lower_bound + dimension.len - 1;
            let _ = write!(text, "[{}:{upper}]", dimension.lower_bound);
        }
        text.push('=');
    }
    if dimensions.is_empty() {
        text.push_str("{}");
    } else {
        nest_elements(&dimensions, &mut elements.into_iter(), &mut text);
    }
    Some(text)
}

fn nest_elements(
    dimensions: &[ArrayDimension],
    elements: &mut impl Iterator<Item = String>,
    text: &mut String,
) {
    text.push('{');
    for at in 0..dimensions[0].len {
        if at > 0 {
            text.push(',');
        }
        if dimensions.len() > 1 {
            nest_elements(&dimensions[1..], elements, text);
        } else {
            text.push_str(&elements.next().unwrap_or_default());
        }
    }
    text.push('}');
}

/// One array element, quoted where PostgreSQL would quote it.
fn array_element(text: String) -> String {
    let plain = !text.is_empty()
        && !text.eq_ignore_ascii_case("NULL")
        && !text
            .chars()
            .any(|c| matches!(c, '{' | '}' | ',' | '"' | '\\' | '\x0b') || c.is_ascii_whitespace());
    if plain {
        return text;
    }
    let mut quoted = String::with_capacity(text.len() + 2);
    quoted.push('"');
    for c in text.chars() {
        if c == '"' || c == '\\' {
            quoted.push('\\');
        }
        quoted.push(c);
    }
    quoted.push('"');
    quoted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_value_expressions_are_written_by_the_server() {
        assert_eq!(value_sql(None, 1, "integer"), "($1::text)::integer");
        assert_eq!(value_sql(Some(ValueExpr::Default), 1, "text"), "DEFAULT");
        assert_eq!(
            value_sql(Some(ValueExpr::Now), 1, "timestamp with time zone"),
            "now()::timestamp with time zone"
        );
        assert_eq!(value_sql(Some(ValueExpr::Now), 3, "date"), "now()::date");
    }

    /// A NUMERIC on the wire: base-10000 digits after a four-word header.
    fn numeric(weight: i16, sign: u16, scale: u16, digits: &[u16]) -> Vec<u8> {
        let mut raw = Vec::new();
        for word in [digits.len() as u16, weight as u16, sign, scale]
            .iter()
            .chain(digits)
        {
            raw.extend_from_slice(&word.to_be_bytes());
        }
        raw
    }

    #[test]
    fn numerics_keep_every_digit() {
        // NUMERIC(38, 10) at its largest: more than rust_decimal holds.
        let max = numeric(
            6,
            0,
            10,
            &[9999, 9999, 9999, 9999, 9999, 9999, 9999, 9999, 9999, 9900],
        );
        assert_eq!(
            numeric_text(&max).unwrap(),
            "9999999999999999999999999999.9999999999"
        );
        // The scale's trailing zeros stay, as PostgreSQL prints them.
        let long = numeric(4, 0, 10, &[1234, 5678, 9012, 3456, 7890, 1234, 5678, 9000]);
        assert_eq!(
            numeric_text(&long).unwrap(),
            "12345678901234567890.1234567890"
        );
        assert_eq!(
            numeric_text(&numeric(0, 0x4000, 2, &[80, 1900])).unwrap(),
            "-80.19"
        );
        assert_eq!(numeric_text(&numeric(-1, 0, 4, &[1])).unwrap(), "0.0001");
        assert_eq!(
            numeric_text(&numeric(-2, 0, 8, &[1])).unwrap(),
            "0.00000001"
        );
        assert_eq!(
            numeric_text(&numeric(-1, 0, 8, &[12, 3456])).unwrap(),
            "0.00123456"
        );
        assert_eq!(numeric_text(&numeric(1, 0, 0, &[1])).unwrap(), "10000");
        assert_eq!(numeric_text(&numeric(0, 0, 2, &[])).unwrap(), "0.00");
        assert_eq!(numeric_text(&numeric(0, 0xC000, 0, &[])).unwrap(), "NaN");
        assert_eq!(
            numeric_text(&numeric(0, 0xD000, 0, &[])).unwrap(),
            "Infinity"
        );
        assert_eq!(
            numeric_text(&numeric(0, 0xF000, 0, &[])).unwrap(),
            "-Infinity"
        );
        // A digit count that doesn't match the bytes is unreadable.
        assert_eq!(numeric_text(&numeric(0, 0, 0, &[1])[..9]), None);
    }

    /// An array on the wire: dimensions, then each element with its length.
    fn array(element: &Type, dimensions: &[(i32, i32)], elements: &[Option<&[u8]>]) -> Vec<u8> {
        let mut raw = Vec::new();
        raw.extend_from_slice(&(dimensions.len() as i32).to_be_bytes());
        raw.extend_from_slice(&i32::from(elements.iter().any(Option::is_none)).to_be_bytes());
        raw.extend_from_slice(&element.oid().to_be_bytes());
        for (len, lower_bound) in dimensions {
            raw.extend_from_slice(&len.to_be_bytes());
            raw.extend_from_slice(&lower_bound.to_be_bytes());
        }
        for value in elements {
            match value {
                Some(bytes) => {
                    raw.extend_from_slice(&(bytes.len() as i32).to_be_bytes());
                    raw.extend_from_slice(bytes);
                }
                None => raw.extend_from_slice(&(-1i32).to_be_bytes()),
            }
        }
        raw
    }

    #[test]
    fn arrays_read_as_postgresql_prints_them() {
        let text = |dimensions: &[(i32, i32)], elements: &[Option<&str>]| {
            let elements: Vec<Option<&[u8]>> = elements
                .iter()
                .map(|value| value.map(str::as_bytes))
                .collect();
            pg_text(
                &Type::TEXT_ARRAY,
                &array(&Type::TEXT, dimensions, &elements),
            )
            .unwrap()
        };
        assert_eq!(
            text(&[(2, 1)], &[Some("sale"), Some("best")]),
            "{sale,best}"
        );
        assert_eq!(
            text(&[(2, 1)], &[Some("limited"), Some("한정판")]),
            "{limited,한정판}"
        );
        assert_eq!(text(&[], &[]), "{}");
        assert_eq!(
            text(
                &[(7, 1)],
                &[
                    Some("a b"),
                    Some(""),
                    Some("null"),
                    Some("x,y"),
                    Some("q\"t"),
                    Some("back\\slash"),
                    None
                ]
            ),
            r#"{"a b","","null","x,y","q\"t","back\\slash",NULL}"#
        );

        let int = |n: i32| n.to_be_bytes();
        let (one, two, three, four) = (int(1), int(2), int(3), int(4));
        let grid = array(
            &Type::INT4,
            &[(2, 1), (2, 1)],
            &[Some(&one), Some(&two), Some(&three), Some(&four)],
        );
        assert_eq!(pg_text(&Type::INT4_ARRAY, &grid).unwrap(), "{{1,2},{3,4}}");
        let from_zero = array(&Type::INT4, &[(2, 0)], &[Some(&one), Some(&two)]);
        assert_eq!(
            pg_text(&Type::INT4_ARRAY, &from_zero).unwrap(),
            "[0:1]={1,2}"
        );
        let shifted = array(
            &Type::INT4,
            &[(2, 2), (2, 0)],
            &[Some(&one), Some(&two), Some(&three), Some(&four)],
        );
        assert_eq!(
            pg_text(&Type::INT4_ARRAY, &shifted).unwrap(),
            "[2:3][0:1]={{1,2},{3,4}}"
        );
        // More cells than elements sent: unreadable, not padded.
        let short = array(&Type::INT4, &[(3, 1)], &[Some(&one), Some(&two)]);
        assert_eq!(pg_text(&Type::INT4_ARRAY, &short), None);
    }

    #[test]
    fn array_elements_read_as_they_do_inside_postgresql_arrays() {
        let flags = array(&Type::BOOL, &[(3, 1)], &[Some(&[1]), Some(&[0]), None]);
        assert_eq!(pg_text(&Type::BOOL_ARRAY, &flags).unwrap(), "{t,f,NULL}");
        let blobs = array(&Type::BYTEA, &[(2, 1)], &[Some(&[0x00, 0xff]), Some(&[])]);
        assert_eq!(
            pg_text(&Type::BYTEA_ARRAY, &blobs).unwrap(),
            r#"{"\\x00ff","\\x"}"#
        );
        let half_past = 1_000_000i64 * 60 * 30 + 500_000;
        let times = array(
            &Type::TIMESTAMPTZ,
            &[(1, 1)],
            &[Some(&half_past.to_be_bytes())],
        );
        assert_eq!(
            pg_text(&Type::TIMESTAMPTZ_ARRAY, &times).unwrap(),
            r#"{"2000-01-01 00:30:00.5+00:00"}"#
        );
        let (big, small) = (
            numeric(
                6,
                0,
                10,
                &[9999, 9999, 9999, 9999, 9999, 9999, 9999, 9999, 9999, 9900],
            ),
            numeric(-1, 0x4000, 4, &[1]),
        );
        let numbers = array(&Type::NUMERIC, &[(2, 1)], &[Some(&big), Some(&small)]);
        assert_eq!(
            pg_text(&Type::NUMERIC_ARRAY, &numbers).unwrap(),
            "{9999999999999999999999999999.9999999999,-0.0001}"
        );
    }

    #[test]
    fn enums_read_as_their_labels() {
        let tier = Type::new(
            "customer_tier".into(),
            90_001,
            Kind::Enum(vec!["free".into(), "pro".into()]),
            "shop".into(),
        );
        assert_eq!(pg_text(&tier, b"pro").unwrap(), "pro");
        let tiers = Type::new(
            "_customer_tier".into(),
            90_002,
            Kind::Array(tier.clone()),
            "shop".into(),
        );
        let raw = array(&tier, &[(2, 1)], &[Some(b"free"), Some(b"pro")]);
        assert_eq!(pg_text(&tiers, &raw).unwrap(), "{free,pro}");
        // A type it has no reading for shows its name.
        let point = Type::new("point".into(), 600, Kind::Simple, "pg_catalog".into());
        assert_eq!(pg_json(&point, &[0; 16]), Value::from("<point>"));
    }

    #[test]
    fn timestamps_keep_their_fraction_of_a_second() {
        let at = |text: &str| {
            let at = chrono::DateTime::parse_from_rfc3339(text).unwrap();
            let epoch = chrono::DateTime::parse_from_rfc3339("2000-01-01T00:00:00Z").unwrap();
            let micros = (at - epoch).num_microseconds().unwrap();
            pg_text(&Type::TIMESTAMPTZ, &micros.to_be_bytes()).unwrap()
        };
        assert_eq!(
            at("2024-02-29T23:59:59.999+09:00"),
            "2024-02-29 14:59:59.999+00:00"
        );
        assert_eq!(
            at("2024-02-29T23:59:59.000123+09:00"),
            "2024-02-29 14:59:59.000123+00:00"
        );
        assert_eq!(at("2024-02-29T23:59:59+09:00"), "2024-02-29 14:59:59+00:00");
        // Without chrono's padding, as PostgreSQL prints it.
        assert_eq!(
            at("2024-02-29T23:59:59.5+09:00"),
            "2024-02-29 14:59:59.5+00:00"
        );
        let local = pg_text(&Type::TIMESTAMP, &1_500_000i64.to_be_bytes()).unwrap();
        assert_eq!(local, "2000-01-01 00:00:01.5");
        let clock = pg_text(&Type::TIME, &1_250_000i64.to_be_bytes()).unwrap();
        assert_eq!(clock, "00:00:01.25");
    }

    #[test]
    fn infinite_dates_and_times_read_as_words() {
        for dtype in [Type::TIMESTAMP, Type::TIMESTAMPTZ] {
            assert_eq!(
                pg_text(&dtype, &i64::MAX.to_be_bytes()).unwrap(),
                "infinity"
            );
            assert_eq!(
                pg_text(&dtype, &i64::MIN.to_be_bytes()).unwrap(),
                "-infinity"
            );
        }
        assert_eq!(
            pg_text(&Type::DATE, &i32::MAX.to_be_bytes()).unwrap(),
            "infinity"
        );
        assert_eq!(
            pg_text(&Type::DATE, &i32::MIN.to_be_bytes()).unwrap(),
            "-infinity"
        );
        assert_eq!(
            pg_text(&Type::DATE, &0i32.to_be_bytes()).unwrap(),
            "2000-01-01"
        );
    }

    #[test]
    fn grid_values_keep_their_json_kinds() {
        assert_eq!(pg_json(&Type::INT4, &5i32.to_be_bytes()), Value::from(5));
        assert_eq!(pg_json(&Type::BOOL, &[1]), Value::Bool(true));
        assert_eq!(
            pg_json(&Type::FLOAT4, &1.1f32.to_be_bytes()),
            serde_json::json!(1.1)
        );
        assert_eq!(
            pg_json(&Type::FLOAT8, &f64::INFINITY.to_be_bytes()),
            Value::from("Infinity")
        );
        assert_eq!(
            pg_json(&Type::BYTEA, &[0x00, 0xff, 0x10]),
            Value::from("<blob 3 bytes>")
        );
        assert_eq!(pg_json(&Type::TEXT, "한글".as_bytes()), Value::from("한글"));
        // A payload that doesn't fit its type shows the type's name.
        assert_eq!(pg_json(&Type::INT4, &[0, 0, 5]), Value::from("<int4>"));
        // JSON as the server keeps it, a number past f64's digits included.
        let document = r#"{"n": 12345678901234567890123, "s": "a"}"#;
        assert_eq!(
            pg_json(&Type::JSON, document.as_bytes()),
            Value::from(document)
        );
        let mut binary = vec![1];
        binary.extend_from_slice(document.as_bytes());
        assert_eq!(pg_json(&Type::JSONB, &binary), Value::from(document));
        assert_eq!(pg_json(&Type::JSONB, &[2, b'1']), Value::from("<jsonb>"));
    }

    #[test]
    fn floats_read_at_their_stored_digits() {
        assert_eq!(
            pg_text(&Type::FLOAT4, &1.1f32.to_be_bytes()).unwrap(),
            "1.1"
        );
        assert_eq!(
            pg_text(&Type::FLOAT4, &f32::INFINITY.to_be_bytes()).unwrap(),
            "Infinity"
        );
        assert_eq!(
            pg_text(&Type::FLOAT8, &f64::NAN.to_be_bytes()).unwrap(),
            "NaN"
        );
    }

    fn change(sql: &str) -> Change {
        Change {
            sql: sql.into(),
            ms: 0,
            rows: 1,
        }
    }

    fn drain(changes: &mut tokio::sync::mpsc::UnboundedReceiver<Change>) -> Vec<String> {
        std::iter::from_fn(|| changes.try_recv().ok())
            .map(|change| change.sql)
            .collect()
    }

    /// Whether PostgreSQL turned a COMMIT in `sql` into a rollback.
    fn run(tx: &TxState, sql: &str, log: &SqlLog) -> bool {
        tx.track(&tx_controls(sql, Dialect::Postgres), log)
    }

    #[test]
    fn only_a_transaction_statement_that_ran_ends_it_on_failure() {
        let controls = |sql: &str| tx_controls(sql, Dialect::Postgres);
        // Refused at Parse (an unsplit "COMMIT; SELECT 1"): never ran.
        assert!(!failure_ends_tx(&controls("COMMIT; SELECT 1"), false));
        // A COMMIT that failed while running (a deferred constraint).
        assert!(failure_ends_tx(&controls("COMMIT"), true));
        assert!(failure_ends_tx(&controls("ROLLBACK"), true));
        assert!(!failure_ends_tx(&controls("ROLLBACK TO SAVEPOINT s"), true));
        assert!(!failure_ends_tx(&controls("BEGIN"), true));
        assert!(!failure_ends_tx(&controls("SELECT 1/0"), true));
    }

    #[test]
    fn an_aborted_transaction_never_commits_its_changes() {
        let log = SqlLog::new();
        let mut changes = log.take_changes().unwrap();
        let tx = TxState::default();

        // A failure outside a transaction aborts nothing.
        tx.failed();
        assert!(!tx.is_aborted());

        // The toolbar's COMMIT after a failed statement.
        tx.begin(&log);
        log.changed(change("A"), tx.is_open());
        tx.failed();
        assert!(tx.is_aborted());
        assert!(!tx.end(true, &log));
        assert!(drain(&mut changes).is_empty());
        assert!(!tx.is_open() && !tx.is_aborted());

        // ROLLBACK TO SAVEPOINT makes the transaction usable again.
        tx.begin(&log);
        log.changed(change("B"), tx.is_open());
        tx.failed();
        tx.recovered();
        assert!(tx.end(true, &log));
        assert_eq!(drain(&mut changes), vec!["B"]);

        // The same from the editor.
        run(&tx, "BEGIN", &log);
        assert!(tx.is_open());
        log.changed(change("C"), tx.is_open());
        assert!(!run(&tx, "commit", &log));
        assert!(!tx.is_open());
        assert_eq!(drain(&mut changes), vec!["C"]);

        run(&tx, "START TRANSACTION", &log);
        log.changed(change("D"), tx.is_open());
        tx.failed();
        run(&tx, "ROLLBACK TO SAVEPOINT s", &log);
        run(&tx, "END", &log);
        assert_eq!(drain(&mut changes), vec!["D"]);

        // PostgreSQL answers this COMMIT with a rollback.
        run(&tx, "BEGIN", &log);
        log.changed(change("E"), tx.is_open());
        tx.failed();
        assert!(run(&tx, "COMMIT", &log));
        assert!(drain(&mut changes).is_empty());

        // COMMIT AND CHAIN starts the next transaction straight away.
        run(&tx, "BEGIN", &log);
        log.changed(change("G"), tx.is_open());
        assert!(!run(&tx, "COMMIT AND CHAIN", &log));
        assert!(tx.is_open());
        assert_eq!(drain(&mut changes), vec!["G"]);
        run(&tx, "ROLLBACK", &log);

        run(&tx, "BEGIN", &log);
        log.changed(change("F"), tx.is_open());
        run(&tx, "ROLLBACK", &log);
        assert!(!tx.is_open());
        assert!(drain(&mut changes).is_empty());
    }
}
