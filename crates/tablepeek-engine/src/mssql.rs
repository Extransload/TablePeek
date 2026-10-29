use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Instant;

use futures_util::StreamExt;
use serde_json::Value;
use tablepeek_types::{
    ColumnSchema, DbObjects, EditTarget, EngineMeta, ErrorFields, ErrorPosition, ForeignKeyInfo,
    IndexInfo, IndexPart, InsertValue, MssqlConfig, ObjectDefinition, PkValue, Relation,
    ServerInfo, ServerSession, TableDetail, TableSchema, TriggerInfo, ValueExpr,
};
use tiberius::{
    AuthMethod, Client, ColumnData, Config, EncryptionLevel, ExecuteResult, FromSqlOwned,
    QueryItem, QueryStream, ToSql,
};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use crate::source_cache::{key_unchanged, SourceCache, KEY_CHANGED};
use crate::sql_log::{inline_params, Change, Dialect, LogParam, SqlLog};
use crate::sql_parse::{parse_single_table, trim_ident, tx_controls, TxControl};
use crate::{
    build_arrow, hex_bytes, hex_cell, hex_text, humanize_uptime_ko, not_hex, real_json,
    EngineError, QueryData,
};

type MssqlClient = Client<Compat<TcpStream>>;

/// A SELECT's table as its display name and primary key columns; None when
/// INFORMATION_SCHEMA has no such table.
type Source = Option<(String, Vec<String>)>;

pub struct MssqlInner {
    client: tokio::sync::Mutex<Option<MssqlClient>>,
    config: Config,
    database: String,
    default_schema: String,
    spid: AtomicI32,
    label: String,
    in_tx: AtomicBool,
    // A transaction was open when its session went (a cancel KILLs it): the
    // next COMMIT reports the rollback rather than "no transaction".
    tx_lost: Mutex<Option<&'static str>>,
    cancel_requested: AtomicBool,
    session_dead: AtomicBool,
    // By (schema, table) as the SELECT named them, the default schema
    // standing in for a missing one.
    sources: SourceCache<(String, String), Source>,
    log: SqlLog,
}

const CANCELLED: &str = "쿼리 취소로 세션이 끊겨 트랜잭션이 롤백되었습니다";
const SERVER_ROLLED_BACK: &str = "서버가 오류로 트랜잭션을 롤백했습니다";

impl MssqlInner {
    pub(crate) fn in_tx(&self) -> bool {
        self.in_tx.load(Ordering::SeqCst)
    }

    // Done once the KILL has run; None when there is no session to kill.
    pub(crate) fn cancel(&self) -> Option<tokio::task::JoinHandle<()>> {
        let spid = self.spid.load(Ordering::SeqCst);
        if spid == 0 {
            return None;
        }
        self.cancel_requested.store(true, Ordering::SeqCst);
        self.session_dead.store(true, Ordering::SeqCst);
        // The KILL ends the session and rolls its transaction back: say so
        // now, not at the next statement. This clears the sources without
        // the client lock, so a query still holding it may put one more;
        // session_dead has the next client() clear them again, under the
        // lock, before anything reads them.
        self.lose_tx(CANCELLED);
        let config = self.config.clone();
        let log = self.log.clone();
        Some(tokio::spawn(async move {
            if let Ok(mut client) = open_client(&config).await {
                let sql = format!("KILL {spid}");
                log.record(&sql, Dialect::Mssql);
                let _ = client.execute(sql, &[]).await;
                let _ = client.close().await;
            }
        }))
    }

    async fn client(
        &self,
    ) -> Result<tokio::sync::MutexGuard<'_, Option<MssqlClient>>, EngineError> {
        let mut guard = self.client.lock().await;
        if self.session_dead.swap(false, Ordering::SeqCst) {
            *guard = None;
        }
        if guard.is_none() {
            // A new session: whatever transaction the old one had is gone.
            self.lose_tx(CANCELLED);
            let mut client = open_client(&self.config).await?;
            self.spid
                .store(read_spid(&mut client, &self.log).await?, Ordering::SeqCst);
            *guard = Some(client);
        }
        Ok(guard)
    }

    /// Why the last transaction ended without a COMMIT or ROLLBACK of ours.
    fn lost(&self) -> MutexGuard<'_, Option<&'static str>> {
        self.tx_lost.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The session's transaction is gone (a KILL, or the server rolled it
    /// back): the next COMMIT reports `reason`.
    fn lose_tx(&self, reason: &'static str) {
        // Its DDL went with it, and a new session starts back in the
        // connection's database, whatever USE said.
        self.sources.clear();
        if self.in_tx.swap(false, Ordering::SeqCst) {
            *self.lost() = Some(reason);
            self.log.ended(false);
        } else {
            self.log.settle(false);
        }
    }

    fn take_cancelled(&self) -> bool {
        self.cancel_requested.swap(false, Ordering::SeqCst)
    }
}

fn build_config(config: &MssqlConfig) -> Config {
    let mut tiberius = Config::new();
    tiberius.host(config.host.as_str());
    tiberius.port(config.port);
    if !config.database.trim().is_empty() {
        tiberius.database(config.database.as_str());
    }
    tiberius.authentication(AuthMethod::sql_server(
        config.user.as_str(),
        config.password.clone().unwrap_or_default(),
    ));
    tiberius.application_name("tablepeek");
    if config.encrypt {
        tiberius.encryption(EncryptionLevel::Required);
        tiberius.trust_cert();
    } else {
        tiberius.encryption(EncryptionLevel::NotSupported);
    }
    tiberius
}

fn mssql_err(err: tiberius::error::Error) -> EngineError {
    let raw = err.to_string();
    let mut fields = ErrorFields::default();
    let message = match &err {
        // "Token error: '…' on server x executing y on line 1 (code: 102, …)":
        // the server's words lead; number and line go apart.
        tiberius::error::Error::Server(token) => {
            fields.server_code = Some(i64::from(token.code()));
            fields.position = (token.line() > 0).then(|| ErrorPosition {
                line: Some(token.line()),
                ..ErrorPosition::default()
            });
            fields.raw = Some(raw);
            token.message().to_string()
        }
        tiberius::error::Error::Tls(text) => format!("TLS 연결 실패: {text}"),
        _ => raw,
    };
    EngineError::mssql(message, fields)
}

async fn open_client(config: &Config) -> Result<MssqlClient, EngineError> {
    let tcp = TcpStream::connect(config.get_addr()).await.map_err(|err| {
        EngineError::mssql(
            format!("SQL Server 연결 실패: {err}"),
            ErrorFields::default(),
        )
    })?;
    let _ = tcp.set_nodelay(true);
    Client::connect(config.clone(), tcp.compat_write())
        .await
        .map_err(mssql_err)
}

async fn trancount(client: &mut MsConn<'_>) -> Option<i64> {
    let row = client
        .query("SELECT @@TRANCOUNT", &[])
        .await
        .ok()?
        .into_row()
        .await
        .ok()??;
    let values: Vec<ColumnData<'static>> = row.into_iter().collect();
    cd_i64(values.first())
}

async fn read_spid(client: &mut MssqlClient, log: &SqlLog) -> Result<i32, EngineError> {
    const SPID_SQL: &str = "SELECT @@SPID";
    log.record(SPID_SQL, Dialect::Mssql);
    let row = client
        .query(SPID_SQL, &[])
        .await
        .map_err(mssql_err)?
        .into_row()
        .await
        .map_err(mssql_err)?;
    Ok(row
        .and_then(|row| row.into_iter().next())
        .and_then(|value| cd_i64(Some(&value)))
        .unwrap_or_default() as i32)
}

fn take_client<'a>(
    guard: &'a mut tokio::sync::MutexGuard<'_, Option<MssqlClient>>,
    log: &'a SqlLog,
) -> Result<MsConn<'a>, EngineError> {
    let client = guard
        .as_mut()
        .ok_or_else(|| EngineError::Internal("SQL Server 연결이 준비되지 않았습니다".into()))?;
    Ok(MsConn { client, log })
}

/// The session's client; every method logs its statement before sending it.
/// It deliberately has no way to reach the bare client.
struct MsConn<'a> {
    client: &'a mut MssqlClient,
    log: &'a SqlLog,
}

impl MsConn<'_> {
    fn shown(sql: &str, params: &[&dyn ToSql]) -> String {
        if params.is_empty() {
            return sql.to_string();
        }
        let values: Vec<LogParam> = params.iter().map(|param| log_param(*param)).collect();
        inline_params(sql, &values, Dialect::Mssql)
    }

    async fn query<'q>(
        &'q mut self,
        sql: &'q str,
        params: &'q [&'q dyn ToSql],
    ) -> Result<QueryStream<'q>, tiberius::error::Error> {
        self.log.record(&Self::shown(sql, params), Dialect::Mssql);
        self.client.query(sql, params).await
    }

    async fn execute(
        &mut self,
        sql: &str,
        params: &[&dyn ToSql],
    ) -> Result<ExecuteResult, tiberius::error::Error> {
        self.log.record(&Self::shown(sql, params), Dialect::Mssql);
        self.client.execute(sql, params).await
    }

    /// Runs a data change made from the GUI; one that changed rows goes to
    /// History, at COMMIT when `in_tx`.
    async fn change(
        &mut self,
        sql: &str,
        params: &[&dyn ToSql],
        in_tx: bool,
    ) -> Result<u64, tiberius::error::Error> {
        let shown = Self::shown(sql, params);
        self.log.record(&shown, Dialect::Mssql);
        let started = Instant::now();
        let changed = self.client.execute(sql, params).await?.total();
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

    // The driver sends these as transaction manager requests, not SQL; the
    // console shows the statements they stand for.
    async fn begin_transaction(&mut self) -> Result<(), tiberius::error::Error> {
        self.log.record("BEGIN TRANSACTION", Dialect::Mssql);
        self.client.begin_transaction().await
    }

    async fn commit_transaction(&mut self) -> Result<(), tiberius::error::Error> {
        self.log.record("COMMIT", Dialect::Mssql);
        self.client.commit_transaction().await
    }

    async fn rollback_transaction(&mut self) -> Result<(), tiberius::error::Error> {
        self.log.record("ROLLBACK", Dialect::Mssql);
        self.client.rollback_transaction().await
    }
}

fn log_param(param: &dyn ToSql) -> LogParam {
    match param.to_sql() {
        ColumnData::String(text) => {
            text.map_or(LogParam::Null, |text| LogParam::Text(text.into_owned()))
        }
        ColumnData::U8(number) => number.map_or(LogParam::Null, |n| LogParam::Int(n.into())),
        ColumnData::I16(number) => number.map_or(LogParam::Null, |n| LogParam::Int(n.into())),
        ColumnData::I32(number) => number.map_or(LogParam::Null, |n| LogParam::Int(n.into())),
        ColumnData::I64(number) => number.map_or(LogParam::Null, LogParam::Int),
        ColumnData::F32(number) => number.map_or(LogParam::Null, |n| LogParam::Float(n.into())),
        ColumnData::F64(number) => number.map_or(LogParam::Null, LogParam::Float),
        ColumnData::Bit(flag) => flag.map_or(LogParam::Null, LogParam::Bool),
        ColumnData::Binary(bytes) => {
            bytes.map_or(LogParam::Null, |bytes| LogParam::Blob(bytes.into_owned()))
        }
        ColumnData::Guid(guid) => {
            guid.map_or(LogParam::Null, |guid| LogParam::Text(guid.to_string()))
        }
        other => LogParam::Text(format!("{other:?}")),
    }
}

const CONNECT_INFO_SQL: &str = "SELECT @@SPID, DB_NAME(), ISNULL(SCHEMA_NAME(), 'dbo')";

const TABLE_LIST_SQL: &str = "SELECT s.name, t.name
     FROM sys.tables t
     JOIN sys.schemas s ON s.schema_id = t.schema_id
     ORDER BY s.name, t.name";

// Foreign keys of the tables TABLE_LIST_SQL lists, one row per column pair.
const RELATIONS_SQL: &str = "SELECT s.name, t.name, fk.name, pc.name, rs.name, rt.name, rc.name
     FROM sys.foreign_keys fk
     JOIN sys.tables t ON t.object_id = fk.parent_object_id
     JOIN sys.schemas s ON s.schema_id = t.schema_id
     JOIN sys.objects rt ON rt.object_id = fk.referenced_object_id
     JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
     JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
     JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id
       AND pc.column_id = fkc.parent_column_id
     JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id
       AND rc.column_id = fkc.referenced_column_id
     ORDER BY s.name, t.name, fk.name, fkc.constraint_column_id";

const COLUMN_SQL: &str = "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.CHARACTER_MAXIMUM_LENGTH,
            c.NUMERIC_PRECISION, c.NUMERIC_SCALE, c.IS_NULLABLE, c.COLUMN_DEFAULT,
            CASE WHEN EXISTS (
                SELECT 1
                FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
                  ON tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
                 AND tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
                 AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
                 AND tc.TABLE_NAME = kcu.TABLE_NAME
                WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
                  AND kcu.TABLE_SCHEMA = c.TABLE_SCHEMA
                  AND kcu.TABLE_NAME = c.TABLE_NAME
                  AND kcu.COLUMN_NAME = c.COLUMN_NAME
            ) THEN 1 ELSE 0 END AS is_pk
     FROM INFORMATION_SCHEMA.COLUMNS c
     WHERE c.TABLE_SCHEMA = @P1 AND c.TABLE_NAME = @P2
     ORDER BY c.ORDINAL_POSITION";

const TABLE_LOOKUP_SQL: &str = "SELECT TOP 1 TABLE_SCHEMA, TABLE_NAME
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = @P1 AND TABLE_NAME = @P2";

const PK_SQL: &str = "SELECT kcu.COLUMN_NAME
     FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
     JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
       ON tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
      AND tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
      AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
      AND tc.TABLE_NAME = kcu.TABLE_NAME
     WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
       AND kcu.TABLE_SCHEMA = @P1
       AND kcu.TABLE_NAME = @P2
     ORDER BY kcu.ORDINAL_POSITION";

const COLUMN_TYPE_SQL: &str = "SELECT DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = @P1 AND TABLE_NAME = @P2 AND COLUMN_NAME = @P3";

pub(crate) async fn connect(
    config: &MssqlConfig,
    log: SqlLog,
) -> Result<Arc<MssqlInner>, EngineError> {
    let tiberius_config = build_config(config);
    let mut client = open_client(&tiberius_config).await?;
    // Not yet behind MsConn: logged by hand.
    log.record(CONNECT_INFO_SQL, Dialect::Mssql);
    let row = client
        .query(CONNECT_INFO_SQL, &[])
        .await
        .map_err(mssql_err)?
        .into_row()
        .await
        .map_err(mssql_err)?
        .ok_or_else(|| EngineError::Internal("SQL Server 접속 정보를 읽지 못했습니다".into()))?;
    let mut values = row.into_iter();
    let spid = values
        .next()
        .as_ref()
        .and_then(|value| cd_i64(Some(value)))
        .unwrap_or_default() as i32;
    let database = values
        .next()
        .as_ref()
        .and_then(|value| cd_string(Some(value)))
        .unwrap_or_default();
    let default_schema = values
        .next()
        .as_ref()
        .and_then(|value| cd_string(Some(value)))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "dbo".into());
    Ok(Arc::new(MssqlInner {
        client: tokio::sync::Mutex::new(Some(client)),
        config: tiberius_config,
        label: format!(
            "{}@{}:{}/{}",
            config.user, config.host, config.port, database
        ),
        database,
        default_schema,
        spid: AtomicI32::new(spid),
        in_tx: AtomicBool::new(false),
        tx_lost: Mutex::new(None),
        cancel_requested: AtomicBool::new(false),
        session_dead: AtomicBool::new(false),
        sources: SourceCache::default(),
        log,
    }))
}

pub(crate) async fn meta(
    inner: &MssqlInner,
    include_system: bool,
) -> Result<EngineMeta, EngineError> {
    let _ = include_system;
    let mut guard = inner.client().await?;
    // A reload picks up schema changes made elsewhere: so do the sources.
    inner.sources.clear();
    let mut client = take_client(&mut guard, &inner.log)?;
    let rows = client
        .query(TABLE_LIST_SQL, &[])
        .await
        .map_err(mssql_err)?
        .into_first_result()
        .await
        .map_err(mssql_err)?;
    let tables = rows
        .iter()
        .filter_map(|row| {
            let schema: Option<&str> = row.get(0);
            let table: Option<&str> = row.get(1);
            table.map(|table| display_name(schema.unwrap_or("dbo"), table))
        })
        .collect();
    Ok(EngineMeta {
        kind: "mssql".into(),
        path: Some(inner.label.clone()),
        demo: false,
        tables,
        capabilities: None,
    })
}

pub(crate) async fn schema(
    inner: &MssqlInner,
    include_system: bool,
) -> Result<Vec<TableSchema>, EngineError> {
    let _ = include_system;
    let mut guard = inner.client().await?;
    inner.sources.clear();
    let mut client = take_client(&mut guard, &inner.log)?;
    let tables = client
        .query(TABLE_LIST_SQL, &[])
        .await
        .map_err(mssql_err)?
        .into_first_result()
        .await
        .map_err(mssql_err)?;
    let mut out = Vec::with_capacity(tables.len());
    for row in tables {
        let values: Vec<ColumnData<'static>> = row.into_iter().collect();
        let schema_name = cd_string(values.first());
        let table_name = cd_string(values.get(1));
        let (schema_name, table_name) = match (schema_name, table_name) {
            (Some(schema_name), Some(table_name)) => (schema_name, table_name),
            _ => continue,
        };
        let rows = client
            .query(
                COLUMN_SQL,
                &[&schema_name as &dyn ToSql, &table_name as &dyn ToSql],
            )
            .await
            .map_err(mssql_err)?
            .into_first_result()
            .await
            .map_err(mssql_err)?;
        let columns = rows
            .into_iter()
            .map(|row| {
                let values: Vec<ColumnData<'static>> = row.into_iter().collect();
                let name = cd_string(values.first()).unwrap_or_default();
                let data_type = cd_string(values.get(1)).unwrap_or_default();
                let max_len = cd_i64(values.get(2));
                let precision = cd_i64(values.get(3));
                let scale = cd_i64(values.get(4));
                let not_null = cd_string(values.get(5))
                    .map(|value| value == "NO")
                    .unwrap_or(false);
                let default = cd_string(values.get(6));
                let pk = cd_i64(values.get(7))
                    .map(|value| value != 0)
                    .unwrap_or(false);
                ColumnSchema {
                    name,
                    decl_type: Some(decl_type(&data_type, max_len, precision, scale)),
                    not_null,
                    pk,
                    default,
                    enum_values: None,
                }
            })
            .collect();
        out.push(TableSchema {
            name: display_name(&schema_name, &table_name),
            columns,
        });
    }
    Ok(out)
}

pub(crate) async fn relations(
    inner: &MssqlInner,
    include_system: bool,
) -> Result<Vec<Relation>, EngineError> {
    let _ = include_system;
    let mut guard = inner.client().await?;
    let mut client = take_client(&mut guard, &inner.log)?;
    let rows = client
        .query(RELATIONS_SQL, &[])
        .await
        .map_err(mssql_err)?
        .into_first_result()
        .await
        .map_err(mssql_err)?;
    let mut out: Vec<Relation> = Vec::new();
    let mut current: Option<(String, String, String)> = None;
    for row in rows {
        let values: Vec<ColumnData<'static>> = row.into_iter().collect();
        let text = |index: usize| cd_string(values.get(index)).unwrap_or_default();
        let key = (text(0), text(1), text(2));
        if current.as_ref() != Some(&key) {
            out.push(Relation {
                table: display_name(&key.0, &key.1),
                columns: Vec::new(),
                ref_table: display_name(&text(4), &text(5)),
                ref_columns: Vec::new(),
            });
            current = Some(key);
        }
        if let Some(relation) = out.last_mut() {
            relation.columns.push(text(3));
            relation.ref_columns.push(text(6));
        }
    }
    Ok(out)
}

pub(crate) async fn query(
    inner: &MssqlInner,
    sql: &str,
    max_rows: usize,
) -> Result<QueryData, EngineError> {
    let started = Instant::now();
    let mut guard = inner.client().await?;
    let mut client = take_client(&mut guard, &inner.log)?;
    let mut columns: Vec<String> = Vec::new();
    let mut column_values: Vec<Vec<Value>> = Vec::new();
    let mut count = 0usize;
    let mut truncated = false;

    let control = tx_controls(sql, Dialect::Mssql).pop();
    // USE, DDL, COMMIT/ROLLBACK and the like.
    inner.sources.before_statement(sql, Dialect::Mssql);
    let outcome: Result<(), tiberius::error::Error> = async {
        let mut stream = client.query(sql, &[]).await?;
        while let Some(item) = stream.next().await {
            match item? {
                QueryItem::Metadata(result_meta) => {
                    columns = result_meta
                        .columns()
                        .iter()
                        .map(|column| column.name().to_string())
                        .collect();
                    column_values = vec![Vec::new(); columns.len()];
                }
                QueryItem::Row(row) => {
                    if count >= max_rows {
                        truncated = true;
                        break;
                    }
                    for (index, value) in row.into_iter().enumerate() {
                        if index < column_values.len() {
                            column_values[index].push(column_json(value));
                        }
                    }
                    count += 1;
                }
            }
        }
        Ok(())
    }
    .await;
    if outcome.is_err() {
        // A batch that failed partway may have run some of it, or had a
        // transaction it opened unseen (IMPLICIT_TRANSACTIONS) rolled back.
        inner.sources.clear();
    }
    // A transaction statement run from the editor (nested, or behind IF),
    // or a failure inside a transaction (a deadlock victim, XACT_ABORT): ask
    // the server whether one is open now, and settle History if it ended.
    let mut unknown = false;
    if control.is_some() || (outcome.is_err() && inner.in_tx()) {
        if let Some(count) = trancount(&mut client).await {
            let open = count > 0;
            let was_open = inner.in_tx.swap(open, Ordering::SeqCst);
            if was_open {
                let end = batch_end(control, outcome.is_ok(), open);
                if end != BatchEnd::StillOpen {
                    // Even a failed SELECT (a deadlock victim) may have
                    // rolled the transaction back, and its DDL with it.
                    inner.sources.clear();
                    unknown = end == BatchEnd::Unknown;
                    *inner.lost() =
                        (end == BatchEnd::ServerRolledBack).then_some(SERVER_ROLLED_BACK);
                    inner.log.ended(end == BatchEnd::Committed);
                }
            } else if open {
                *inner.lost() = None;
                inner.log.settle(false);
            }
        }
    }
    let outcome = outcome.map_err(mssql_err);
    if unknown {
        if let Err(err) = &outcome {
            return Err(EngineError::TxOutcomeUnknown(format!(
                "배치가 실패해 트랜잭션이 커밋되었는지 알 수 없습니다: {err}"
            )));
        }
    }

    if inner.take_cancelled() {
        outcome.map_err(|err| {
            EngineError::mssql(
                format!("KILL 요청으로 쿼리가 취소되었습니다: {err}"),
                ErrorFields::default(),
            )
        })?;
    } else {
        outcome?;
    }

    let (source_table, pk) = detect_source(inner, &mut client, sql, &columns).await;
    let (schema, batches) = build_arrow(&columns, column_values, count)?;
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    Ok(QueryData {
        kind: "mssql",
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
        // The query stream keeps its DONE tokens' row counts to itself.
        rows_affected: None,
    })
}

/// What a cell is written as: its text bound at `position` and cast to the
/// column's type, or the keyword or function an expression stands for. The
/// time is GETDATE(), except in a datetimeoffset, which would take that local
/// time as UTC: there the offset comes along.
fn value_sql(expr: Option<ValueExpr>, position: usize, cast: &str) -> String {
    match expr {
        None => bound_sql(position, cast),
        Some(ValueExpr::Default) => "DEFAULT".into(),
        Some(ValueExpr::Now) if cast == "DATETIMEOFFSET" => "SYSDATETIMEOFFSET()".into(),
        Some(ValueExpr::Now) => "GETDATE()".into(),
    }
}

/// The cast every binary column takes (see cast_type).
const BINARY_CAST: &str = "VARBINARY(MAX)";

/// A bound parameter as the column's type: binary from its hex (CONVERT
/// style 1 reads `0x00FF`; CAST would take the characters), anything else
/// cast from its text.
fn bound_sql(position: usize, cast: &str) -> String {
    if cast == BINARY_CAST {
        format!("CONVERT({cast}, @P{position}, 1)")
    } else {
        format!("CAST(@P{position} AS {cast})")
    }
}

/// The text bound for a column: a binary one's hex, however it was typed,
/// as `0x00FF`.
fn bound_text(cast: &str, value: Option<String>) -> Result<Option<String>, EngineError> {
    match value {
        Some(text) if cast == BINARY_CAST => {
            let bytes = hex_bytes(&text).ok_or_else(not_hex)?;
            Ok(Some(hex_text(&bytes, false)))
        }
        other => Ok(other),
    }
}

pub(crate) async fn edit(inner: &MssqlInner, target: &EditTarget) -> Result<u64, EngineError> {
    if target.pk.is_empty() {
        return Err(EngineError::NotEditable(
            "기본 키가 없어 편집할 수 없습니다".into(),
        ));
    }
    let mut guard = inner.client().await?;
    let mut client = take_client(&mut guard, &inner.log)?;
    let (schema_part, table) = split_display_table(&target.table);
    let schema = schema_part.unwrap_or_else(|| inner.default_schema.clone());
    let table_ref = qualified(&inner.database, &schema, &table);
    check_key(inner, &mut client, &schema, &table, &target.pk).await?;
    let column_type = column_type_of(&mut client, &schema, &table, &target.column).await?;
    let cast = cast_type(&column_type);

    let mut params: Vec<Option<String>> = Vec::with_capacity(target.pk.len() + 1);
    if target.expr.is_none() {
        params.push(bound_text(cast, target.value.clone())?);
    }
    let mut sql = format!(
        "UPDATE {table_ref} SET {} = {} WHERE ",
        quote_ident(&target.column),
        value_sql(target.expr, 1, cast)
    );
    for (index, pk) in target.pk.iter().enumerate() {
        if index > 0 {
            sql.push_str(" AND ");
        }
        let pk_type = column_type_of(&mut client, &schema, &table, &pk.column).await?;
        let pk_cast = cast_type(&pk_type);
        params.push(bound_text(pk_cast, pk_value_string(&pk.value))?);
        let position = params.len();
        let quoted = quote_ident(&pk.column);
        let bound = bound_sql(position, pk_cast);
        sql.push_str(&format!(
            "({quoted} = {bound} OR ({quoted} IS NULL AND @P{position} IS NULL))"
        ));
    }

    let refs: Vec<&dyn ToSql> = params.iter().map(|param| param as &dyn ToSql).collect();
    let result = client.change(&sql, &refs, inner.in_tx()).await;
    if result.is_err() {
        check_tx(inner, &mut client).await;
    }
    result.map_err(mssql_err)
}

pub(crate) async fn insert_row(
    inner: &MssqlInner,
    table: &str,
    values: &[InsertValue],
) -> Result<u64, EngineError> {
    let mut guard = inner.client().await?;
    let mut client = take_client(&mut guard, &inner.log)?;
    let (schema_part, table_name) = split_display_table(table);
    let schema = schema_part.unwrap_or_else(|| inner.default_schema.clone());
    let table_ref = qualified(&inner.database, &schema, &table_name);
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
            let column_type =
                column_type_of(&mut client, &schema, &table_name, &value.column).await?;
            let cast = cast_type(&column_type);
            if value.expr.is_none() {
                params.push(bound_text(cast, value.value.clone())?);
            }
            placeholders.push(value_sql(value.expr, params.len(), cast));
        }
        format!(
            "INSERT INTO {table_ref} ({columns}) VALUES ({})",
            placeholders.join(", ")
        )
    };
    let refs: Vec<&dyn ToSql> = params.iter().map(|param| param as &dyn ToSql).collect();
    let result = client.change(&sql, &refs, inner.in_tx()).await;
    if result.is_err() {
        check_tx(inner, &mut client).await;
    }
    result.map_err(mssql_err)
}

pub(crate) async fn delete_row(
    inner: &MssqlInner,
    table: &str,
    pk: &[PkValue],
) -> Result<u64, EngineError> {
    if pk.is_empty() {
        return Err(EngineError::BadRequest("PK 조건이 필요합니다".into()));
    }
    let mut guard = inner.client().await?;
    let mut client = take_client(&mut guard, &inner.log)?;
    let (schema_part, table_name) = split_display_table(table);
    let schema = schema_part.unwrap_or_else(|| inner.default_schema.clone());
    let table_ref = qualified(&inner.database, &schema, &table_name);
    check_key(inner, &mut client, &schema, &table_name, pk).await?;
    let mut sql = format!("DELETE FROM {table_ref} WHERE ");
    let mut params: Vec<Option<String>> = Vec::with_capacity(pk.len());
    for (index, condition) in pk.iter().enumerate() {
        if index > 0 {
            sql.push_str(" AND ");
        }
        let column_type =
            column_type_of(&mut client, &schema, &table_name, &condition.column).await?;
        let cast = cast_type(&column_type);
        let position = index + 1;
        let quoted = quote_ident(&condition.column);
        let bound = bound_sql(position, cast);
        sql.push_str(&format!(
            "({quoted} = {bound} OR ({quoted} IS NULL AND @P{position} IS NULL))"
        ));
        params.push(bound_text(cast, pk_value_string(&condition.value))?);
    }
    let refs: Vec<&dyn ToSql> = params.iter().map(|param| param as &dyn ToSql).collect();
    let result = client.change(&sql, &refs, inner.in_tx()).await;
    if result.is_err() {
        check_tx(inner, &mut client).await;
    }
    result.map_err(mssql_err)
}

pub(crate) async fn table_detail(
    inner: &MssqlInner,
    name: &str,
) -> Result<TableDetail, EngineError> {
    let mut guard = inner.client().await?;
    // Opening a table's structure shows its key as it is now: so should the
    // next SELECT.
    inner.sources.clear();
    let mut client = take_client(&mut guard, &inner.log)?;
    let (schema_part, table_name) = split_display_table(name);
    let schema = schema_part
        .clone()
        .unwrap_or_else(|| inner.default_schema.clone());
    let object_ref = format!("[{}].[{}]", schema, table_name);
    let lookup = client
        .query(
            TABLE_LOOKUP_SQL,
            &[&schema as &dyn ToSql, &table_name as &dyn ToSql],
        )
        .await
        .map_err(mssql_err)?
        .into_first_result()
        .await
        .map_err(mssql_err)?;
    if lookup.is_empty() {
        return Err(EngineError::TableNotFound);
    }

    let rows = client
        .query(
            COLUMN_SQL,
            &[&schema as &dyn ToSql, &table_name as &dyn ToSql],
        )
        .await
        .map_err(mssql_err)?
        .into_first_result()
        .await
        .map_err(mssql_err)?;
    let columns = rows
        .into_iter()
        .map(|row| {
            let values: Vec<ColumnData<'static>> = row.into_iter().collect();
            let name = cd_string(values.first()).unwrap_or_default();
            let data_type = cd_string(values.get(1)).unwrap_or_default();
            let max_len = cd_i64(values.get(2));
            let precision = cd_i64(values.get(3));
            let scale = cd_i64(values.get(4));
            let not_null = cd_string(values.get(5))
                .map(|value| value == "NO")
                .unwrap_or(false);
            let default = cd_string(values.get(6));
            let pk = cd_i64(values.get(7))
                .map(|value| value != 0)
                .unwrap_or(false);
            ColumnSchema {
                name,
                decl_type: Some(decl_type(&data_type, max_len, precision, scale)),
                not_null,
                pk,
                default,
                enum_values: None,
            }
        })
        .collect::<Vec<_>>();

    let mut indexes: Vec<IndexInfo> = Vec::new();
    let index_rows = client
        .query(
            "SELECT i.name, i.is_unique, i.is_primary_key, c.name, ic.is_descending_key
             FROM sys.indexes i
             JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
             JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
             WHERE i.object_id = OBJECT_ID(@P1) AND i.type > 0 AND ic.is_included_column = 0
             ORDER BY i.name, ic.key_ordinal",
            &[&object_ref as &dyn ToSql],
        )
        .await
        .map_err(mssql_err)?
        .into_first_result()
        .await
        .map_err(mssql_err)?;
    for row in index_rows {
        let values: Vec<ColumnData<'static>> = row.into_iter().collect();
        let index_name = cd_string(values.first()).unwrap_or_default();
        let unique = cd_i64(values.get(1))
            .map(|value| value != 0)
            .unwrap_or(false);
        let primary = cd_i64(values.get(2))
            .map(|value| value != 0)
            .unwrap_or(false);
        let column = cd_string(values.get(3));
        let part = IndexPart {
            column: column.clone(),
            descending: cd_i64(values.get(4)).is_some_and(|value| value != 0),
            ..IndexPart::default()
        };
        match indexes.last_mut() {
            Some(existing) if existing.name == index_name => {
                if let Some(column) = column {
                    existing.columns.push(column);
                }
                existing.parts.get_or_insert_with(Vec::new).push(part);
            }
            _ => indexes.push(IndexInfo {
                name: index_name,
                unique,
                primary,
                columns: column.into_iter().collect(),
                parts: Some(vec![part]),
                ..IndexInfo::default()
            }),
        }
    }
    // A filtered index's predicate and the INCLUDE columns, which the key
    // columns above leave out.
    let extra_rows = client
        .query(
            "SELECT i.name, i.filter_definition, c.name
             FROM sys.indexes i
             LEFT JOIN sys.index_columns ic
               ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 1
             LEFT JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
             WHERE i.object_id = OBJECT_ID(@P1) AND i.type > 0
               AND (i.has_filter = 1 OR ic.column_id IS NOT NULL)
             ORDER BY i.name, ic.index_column_id",
            &[&object_ref as &dyn ToSql],
        )
        .await
        .map_err(mssql_err)?
        .into_first_result()
        .await
        .map_err(mssql_err)?;
    for row in extra_rows {
        let values: Vec<ColumnData<'static>> = row.into_iter().collect();
        let index_name = cd_string(values.first()).unwrap_or_default();
        let Some(index) = indexes.iter_mut().find(|index| index.name == index_name) else {
            continue;
        };
        if let Some(filter) = cd_string(values.get(1)) {
            index.predicate = Some(filter);
        }
        if let Some(column) = cd_string(values.get(2)) {
            index.included.get_or_insert_with(Vec::new).push(column);
        }
    }
    indexes.sort_by(|a, b| a.name.cmp(&b.name));

    let mut foreign_keys: Vec<ForeignKeyInfo> = Vec::new();
    let fk_rows = client
        .query(
            "SELECT fk.name, pc.name, OBJECT_SCHEMA_NAME(fk.referenced_object_id),
                    OBJECT_NAME(fk.referenced_object_id), rc.name
             FROM sys.foreign_keys fk
             JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
             JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id
               AND pc.column_id = fkc.parent_column_id
             JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id
               AND rc.column_id = fkc.referenced_column_id
             WHERE fk.parent_object_id = OBJECT_ID(@P1)
             ORDER BY fk.name, fkc.constraint_column_id",
            &[&object_ref as &dyn ToSql],
        )
        .await
        .map_err(mssql_err)?
        .into_first_result()
        .await
        .map_err(mssql_err)?;
    for row in fk_rows {
        let values: Vec<ColumnData<'static>> = row.into_iter().collect();
        let constraint = cd_string(values.first()).unwrap_or_default();
        let column = cd_string(values.get(1)).unwrap_or_default();
        let ref_schema = cd_string(values.get(2)).unwrap_or_else(|| "dbo".into());
        let ref_table = cd_string(values.get(3)).unwrap_or_default();
        let ref_column = cd_string(values.get(4)).unwrap_or_default();
        match foreign_keys.last_mut() {
            Some(existing) if existing.name == constraint => {
                existing.columns.push(column);
                existing.ref_columns.push(ref_column);
            }
            _ => foreign_keys.push(ForeignKeyInfo {
                name: constraint,
                columns: vec![column],
                ref_table: display_name(&ref_schema, &ref_table),
                ref_columns: vec![ref_column],
            }),
        }
    }

    let stats = client
        .query(
            "SELECT (SELECT SUM(p.rows) FROM sys.partitions p
                     WHERE p.object_id = OBJECT_ID(@P1) AND p.index_id IN (0,1)),
                    (SELECT SUM(au.total_pages) * 8192
                     FROM sys.allocation_units au
                     JOIN sys.partitions p ON p.partition_id = au.container_id
                     WHERE p.object_id = OBJECT_ID(@P1))",
            &[&object_ref as &dyn ToSql],
        )
        .await
        .map_err(mssql_err)?
        .into_first_result()
        .await
        .map_err(mssql_err)?;
    let (row_count_estimate, size_bytes) = stats
        .into_iter()
        .next()
        .map(|row| {
            let values: Vec<ColumnData<'static>> = row.into_iter().collect();
            (cd_i64(values.first()), cd_i64(values.get(1)))
        })
        .unwrap_or((None, None));

    // Data size and comment are extras: a failure here leaves them empty
    // instead of failing the whole detail.
    let extra = match client
        .query(
            "SELECT (SELECT SUM(au.total_pages) * 8192
                     FROM sys.allocation_units au
                     JOIN sys.partitions p ON p.partition_id = au.container_id
                     WHERE p.object_id = OBJECT_ID(@P1) AND p.index_id IN (0,1)),
                    (SELECT CAST(ep.value AS nvarchar(4000))
                     FROM sys.extended_properties ep
                     WHERE ep.class = 1 AND ep.major_id = OBJECT_ID(@P1)
                       AND ep.minor_id = 0 AND ep.name = 'MS_Description')",
            &[&object_ref as &dyn ToSql],
        )
        .await
    {
        Ok(stream) => stream.into_row().await.ok().flatten(),
        Err(_) => None,
    };
    let (data_bytes, comment) = extra
        .map(|row| {
            let values: Vec<ColumnData<'static>> = row.into_iter().collect();
            (cd_i64(values.first()), cd_string(values.get(1)))
        })
        .unwrap_or((None, None));
    let comment = comment.filter(|text| !text.is_empty());
    let index_bytes = size_bytes
        .zip(data_bytes)
        .map(|(total, data)| (total - data).max(0));

    // Triggers are an extra too: a failure leaves the list empty.
    let mut triggers: Vec<TriggerInfo> = Vec::new();
    if let Ok(stream) = client
        .query(
            "SELECT tr.name, OBJECT_DEFINITION(tr.object_id), tr.is_instead_of_trigger,
                    STUFF((SELECT ' OR ' + te.type_desc
                           FROM sys.trigger_events te WHERE te.object_id = tr.object_id
                           FOR XML PATH('')), 1, 4, '')
             FROM sys.triggers tr
             WHERE tr.parent_id = OBJECT_ID(@P1)
             ORDER BY tr.name",
            &[&object_ref as &dyn ToSql],
        )
        .await
    {
        for row in stream.into_first_result().await.unwrap_or_default() {
            let values: Vec<ColumnData<'static>> = row.into_iter().collect();
            let instead_of = cd_i64(values.get(2)).map(|value| value != 0);
            triggers.push(TriggerInfo {
                name: cd_string(values.first()).unwrap_or_default(),
                timing: instead_of.map(|flag| if flag { "INSTEAD OF" } else { "AFTER" }.into()),
                event: cd_string(values.get(3)),
                definition: cd_string(values.get(1)),
            });
        }
    }

    let table_ref = qualified(&inner.database, &schema, &table_name);
    Ok(TableDetail {
        name: if schema_part.is_some() {
            format!("{schema}.{table_name}")
        } else {
            table_name.clone()
        },
        row_count_estimate,
        size_bytes,
        data_bytes,
        index_bytes,
        comment,
        ddl: Some(build_create_table(&table_ref, &schema, &columns)),
        columns,
        indexes,
        foreign_keys,
        triggers,
        schema: Some(schema.clone()),
    })
}

pub(crate) async fn server_info(inner: &MssqlInner) -> Result<ServerInfo, EngineError> {
    let mut guard = inner.client().await?;
    let mut client = take_client(&mut guard, &inner.log)?;
    let row = client
        .query(
            "SELECT LEFT(@@VERSION, CHARINDEX(CHAR(10), @@VERSION + CHAR(10)) - 1),
                    DB_NAME(),
                    CONVERT(varchar(128), SERVERPROPERTY('Collation')),
                    DATEDIFF(SECOND, sqlserver_start_time, GETDATE())
             FROM sys.dm_os_sys_info",
            &[],
        )
        .await
        .map_err(mssql_err)?
        .into_row()
        .await
        .map_err(mssql_err)?;
    let (version, database, encoding, uptime_seconds) = match row {
        Some(row) => {
            let values: Vec<ColumnData<'static>> = row.into_iter().collect();
            (
                cd_string(values.first()),
                cd_string(values.get(1)),
                cd_string(values.get(2)),
                cd_i64(values.get(3)),
            )
        }
        None => (None, None, None, None),
    };
    let size_row = client
        .query("SELECT SUM(size) * 8192 FROM sys.database_files", &[])
        .await
        .map_err(mssql_err)?
        .into_row()
        .await
        .map_err(mssql_err)?;
    let size_bytes = size_row.and_then(|row| {
        let values: Vec<ColumnData<'static>> = row.into_iter().collect();
        cd_i64(values.first())
    });
    let current_spid = inner.spid.load(Ordering::SeqCst);
    let session_rows = client
        .query(
            "SELECT s.session_id, s.login_name, DB_NAME(s.database_id), s.status,
                    r.total_elapsed_time, SUBSTRING(t.text, 1, 400)
             FROM sys.dm_exec_sessions s
             LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
             OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
             WHERE s.is_user_process = 1
             ORDER BY s.session_id",
            &[],
        )
        .await
        .map_err(mssql_err)?
        .into_first_result()
        .await
        .map_err(mssql_err)?;
    let sessions = session_rows
        .into_iter()
        .map(|row| {
            let values: Vec<ColumnData<'static>> = row.into_iter().collect();
            let id = cd_i64(values.first()).unwrap_or_default();
            ServerSession {
                id: id.to_string(),
                user: cd_string(values.get(1)),
                database: cd_string(values.get(2)),
                state: cd_string(values.get(3)),
                query: cd_string(values.get(5)),
                elapsed_ms: cd_i64(values.get(4)),
                is_current: id as i32 == current_spid,
            }
        })
        .collect::<Vec<_>>();
    Ok(ServerInfo {
        driver: "mssql".into(),
        version,
        database,
        encoding,
        uptime: uptime_seconds.map(humanize_uptime_ko),
        size_bytes,
        sessions: Some(sessions),
        can_kill: true,
        topology: None,
        host: None,
    })
}

pub(crate) async fn objects(
    inner: &MssqlInner,
    include_system: bool,
) -> Result<DbObjects, EngineError> {
    let _ = include_system;
    let mut guard = inner.client().await?;
    let mut client = take_client(&mut guard, &inner.log)?;
    let pair_rows = |rows: Vec<tiberius::Row>| {
        rows.into_iter()
            .map(|row| {
                let values: Vec<ColumnData<'static>> = row.into_iter().collect();
                let schema = cd_string(values.first()).unwrap_or_else(|| "dbo".into());
                let name = cd_string(values.get(1)).unwrap_or_default();
                display_name(&schema, &name)
            })
            .collect::<Vec<_>>()
    };
    let views = pair_rows(
        client
            .query(
                "SELECT s.name, v.name FROM sys.views v
                 JOIN sys.schemas s ON s.schema_id = v.schema_id
                 WHERE v.is_ms_shipped = 0
                 ORDER BY s.name, v.name",
                &[],
            )
            .await
            .map_err(mssql_err)?
            .into_first_result()
            .await
            .map_err(mssql_err)?,
    );
    let functions = pair_rows(
        client
            .query(
                "SELECT s.name, o.name FROM sys.objects o
                 JOIN sys.schemas s ON s.schema_id = o.schema_id
                 WHERE o.type IN ('FN','IF','TF') AND o.is_ms_shipped = 0
                 ORDER BY s.name, o.name",
                &[],
            )
            .await
            .map_err(mssql_err)?
            .into_first_result()
            .await
            .map_err(mssql_err)?,
    );
    let procedures = pair_rows(
        client
            .query(
                "SELECT s.name, o.name FROM sys.objects o
                 JOIN sys.schemas s ON s.schema_id = o.schema_id
                 WHERE o.type = 'P' AND o.is_ms_shipped = 0
                 ORDER BY s.name, o.name",
                &[],
            )
            .await
            .map_err(mssql_err)?
            .into_first_result()
            .await
            .map_err(mssql_err)?,
    );
    let triggers = pair_rows(
        client
            .query(
                "SELECT s.name, tr.name FROM sys.triggers tr
                 LEFT JOIN sys.objects o ON o.object_id = tr.parent_id
                 LEFT JOIN sys.schemas s ON s.schema_id = o.schema_id
                 WHERE tr.is_ms_shipped = 0
                 ORDER BY tr.name",
                &[],
            )
            .await
            .map_err(mssql_err)?
            .into_first_result()
            .await
            .map_err(mssql_err)?,
    );
    let sequences = pair_rows(
        client
            .query(
                "SELECT s.name, sq.name FROM sys.sequences sq
                 JOIN sys.schemas s ON s.schema_id = sq.schema_id
                 ORDER BY s.name, sq.name",
                &[],
            )
            .await
            .map_err(mssql_err)?
            .into_first_result()
            .await
            .map_err(mssql_err)?,
    );
    Ok(DbObjects {
        views: sort_dedup(views),
        functions: sort_dedup(functions),
        triggers: sort_dedup(triggers),
        sequences: sort_dedup(sequences),
        procedures: sort_dedup(procedures),
    })
}

pub(crate) async fn table_count(inner: &MssqlInner, name: &str) -> Result<i64, EngineError> {
    let mut guard = inner.client().await?;
    let mut client = take_client(&mut guard, &inner.log)?;
    let (schema_part, table_name) = split_display_table(name);
    let schema = schema_part.unwrap_or_else(|| inner.default_schema.clone());
    let table_ref = qualified(&inner.database, &schema, &table_name);
    let row = client
        .query(&format!("SELECT COUNT(*) FROM {table_ref}"), &[])
        .await
        .map_err(mssql_err)?
        .into_row()
        .await
        .map_err(mssql_err)?;
    Ok(row
        .map(|row| {
            let values: Vec<ColumnData<'static>> = row.into_iter().collect();
            cd_i64(values.first()).unwrap_or(0)
        })
        .unwrap_or(0))
}

pub(crate) async fn databases(inner: &MssqlInner) -> Result<Vec<String>, EngineError> {
    let mut guard = inner.client().await?;
    let mut client = take_client(&mut guard, &inner.log)?;
    let rows = client
        .query(
            "SELECT name FROM sys.databases WHERE state = 0 ORDER BY name",
            &[],
        )
        .await
        .map_err(mssql_err)?
        .into_first_result()
        .await
        .map_err(mssql_err)?;
    Ok(rows
        .iter()
        .filter_map(|row| row.get::<&str, _>(0).map(str::to_string))
        .collect())
}

pub(crate) async fn object_definition(
    inner: &MssqlInner,
    kind: &str,
    name: &str,
) -> Result<Option<ObjectDefinition>, EngineError> {
    let mut guard = inner.client().await?;
    let mut client = take_client(&mut guard, &inner.log)?;
    let (schema_part, object_name) = split_display_table(name);
    let schema = schema_part
        .clone()
        .unwrap_or_else(|| inner.default_schema.clone());
    let object_ref = format!("[{}].[{}]", schema, object_name);
    let row = client
        .query(
            "SELECT o.type, OBJECT_DEFINITION(o.object_id)
             FROM sys.objects o
             WHERE o.object_id = OBJECT_ID(@P1)",
            &[&object_ref as &dyn ToSql],
        )
        .await
        .map_err(mssql_err)?
        .into_row()
        .await
        .map_err(mssql_err)?;
    let Some(row) = row else {
        return Ok(None);
    };
    let values: Vec<ColumnData<'static>> = row.into_iter().collect();
    let object_type = cd_string(values.first()).unwrap_or_default();
    let ddl = cd_string(values.get(1));
    let expected = match kind {
        "view" => object_type.trim() == "V",
        "function" => matches!(object_type.trim(), "FN" | "IF" | "TF"),
        "procedure" => object_type.trim() == "P",
        _ => false,
    };
    if !expected {
        return Ok(None);
    }
    Ok(Some(ObjectDefinition {
        name: if schema_part.is_some() {
            format!("{schema}.{object_name}")
        } else {
            object_name
        },
        kind: kind.to_string(),
        ddl,
    }))
}

pub(crate) async fn kill_session(inner: &MssqlInner, id: u64) -> Result<(), EngineError> {
    let current_spid = inner.spid.load(Ordering::SeqCst);
    if current_spid != 0 && id as i32 == current_spid {
        return Err(EngineError::BadRequest(
            "자신의 연결은 종료할 수 없습니다".into(),
        ));
    }
    let mut guard = inner.client().await?;
    let mut client = take_client(&mut guard, &inner.log)?;
    client
        .execute(&format!("KILL {id}"), &[])
        .await
        .map_err(mssql_err)?;
    Ok(())
}

fn build_create_table(table_ref: &str, _schema: &str, columns: &[ColumnSchema]) -> String {
    let mut lines = Vec::new();
    let mut pk_columns = Vec::new();
    for column in columns {
        let mut line = format!(
            "  {} {}",
            quote_ident(&column.name),
            column.decl_type.as_deref().unwrap_or("nvarchar(max)")
        );
        if column.not_null {
            line.push_str(" NOT NULL");
        }
        if let Some(default) = column.default.as_deref() {
            if !default.trim().is_empty() {
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

fn sort_dedup(mut names: Vec<String>) -> Vec<String> {
    names.sort();
    names.dedup();
    names
}

pub(crate) async fn tx(inner: &MssqlInner, statement: &str) -> Result<(), EngineError> {
    // The session first: a cancel may have ended it, and its transaction.
    let mut guard = inner.client().await?;
    // A rollback takes the transaction's DDL with it.
    inner.sources.clear();
    let active = inner.in_tx();
    match statement {
        "BEGIN" if active => {
            return Err(EngineError::BadRequest(
                "이미 트랜잭션이 진행 중입니다".into(),
            ));
        }
        "COMMIT" | "ROLLBACK" if !active => {
            let lost = inner.lost().take();
            if let Some(reason) = lost {
                inner.log.settle(false);
                // A ROLLBACK asks for what already happened.
                return match statement {
                    "COMMIT" => Err(EngineError::TxRolledBack(reason.into())),
                    _ => Ok(()),
                };
            }
            return Err(EngineError::BadRequest(
                "진행 중인 트랜잭션이 없습니다".into(),
            ));
        }
        _ => {}
    }
    let mut client = take_client(&mut guard, &inner.log)?;
    let outcome = match statement {
        "BEGIN" => client.begin_transaction().await,
        "COMMIT" => client.commit_transaction().await,
        "ROLLBACK" => client.rollback_transaction().await,
        _ => Ok(()),
    };
    // Under the lock, so no change slips between the statement and these.
    if let Err(err) = outcome {
        // A COMMIT or ROLLBACK that fails may find the transaction already
        // rolled back by the server (a doomed one cannot commit).
        if statement != "BEGIN" && trancount(&mut client).await == Some(0) {
            inner.in_tx.store(false, Ordering::SeqCst);
            *inner.lost() = None;
            inner.log.ended(false);
            return match statement {
                "COMMIT" => Err(EngineError::TxRolledBack(format!(
                    "커밋하지 못해 트랜잭션을 롤백했습니다: {err}"
                ))),
                _ => Ok(()),
            };
        }
        return Err(mssql_err(err));
    }
    inner.in_tx.store(statement == "BEGIN", Ordering::SeqCst);
    *inner.lost() = None;
    if statement == "BEGIN" {
        inner.log.settle(false);
    } else {
        inner.log.ended(statement == "COMMIT");
    }
    drop(guard);
    Ok(())
}

/// How a transaction open before an editor batch fared in it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BatchEnd {
    StillOpen,
    Committed,
    RolledBack,
    /// No COMMIT or ROLLBACK of the user's ended it: SQL Server did (a
    /// deadlock victim, an error with XACT_ABORT on).
    ServerRolledBack,
    /// The batch failed but had a COMMIT, which may have run before the
    /// failure or not at all: neither a deadlock nor XACT_ABORT tells,
    /// since the batch's order is unknown.
    Unknown,
}

/// From the batch's last transaction statement (`control`), whether it went
/// through, and whether @@TRANCOUNT still shows a transaction.
fn batch_end(control: Option<TxControl>, succeeded: bool, open_after: bool) -> BatchEnd {
    if open_after {
        return BatchEnd::StillOpen;
    }
    match (control, succeeded) {
        (Some(TxControl::Commit), true) => BatchEnd::Committed,
        (Some(TxControl::Commit), false) => BatchEnd::Unknown,
        // Closed by the user's ROLLBACK or by the server: not committed
        // either way.
        (Some(TxControl::Rollback), _) => BatchEnd::RolledBack,
        _ => BatchEnd::ServerRolledBack,
    }
}

/// A statement failed inside a transaction: SQL Server may have rolled the
/// whole transaction back (a deadlock victim, XACT_ABORT). Ask.
async fn check_tx(inner: &MssqlInner, client: &mut MsConn<'_>) {
    if inner.in_tx() && trancount(client).await == Some(0) {
        inner.lose_tx(SERVER_ROLLED_BACK);
    }
}

async fn column_type_of(
    client: &mut MsConn<'_>,
    schema: &str,
    table: &str,
    column: &str,
) -> Result<String, EngineError> {
    let rows = client
        .query(
            COLUMN_TYPE_SQL,
            &[
                &schema as &dyn ToSql,
                &table as &dyn ToSql,
                &column as &dyn ToSql,
            ],
        )
        .await
        .map_err(mssql_err)?
        .into_first_result()
        .await
        .map_err(mssql_err)?;
    rows.first()
        .and_then(|row| row.get::<&str, _>(0))
        .map(str::to_string)
        .ok_or_else(|| EngineError::NotEditable(format!("컬럼을 찾을 수 없습니다: {column}")))
}

/// Refuses a write keyed on columns that aren't the table's primary key now
/// (see `key_unchanged`), and forgets the cached keys that said otherwise.
/// It looks in the database the write goes to, which a USE doesn't move.
async fn check_key(
    inner: &MssqlInner,
    client: &mut MsConn<'_>,
    schema: &str,
    table: &str,
    pk: &[PkValue],
) -> Result<(), EngineError> {
    let catalog = if inner.database.trim().is_empty() {
        String::new()
    } else {
        format!("{}.", quote_ident(&inner.database))
    };
    let sql = format!(
        "SELECT kcu.COLUMN_NAME
         FROM {catalog}INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         JOIN {catalog}INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
           ON tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
          AND tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
          AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
          AND tc.TABLE_NAME = kcu.TABLE_NAME
         WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
           AND kcu.TABLE_SCHEMA = @P1
           AND kcu.TABLE_NAME = @P2"
    );
    let rows = client
        .query(&sql, &[&schema as &dyn ToSql, &table as &dyn ToSql])
        .await
        .map_err(mssql_err)?
        .into_first_result()
        .await
        .map_err(mssql_err)?;
    let current: Vec<String> = rows
        .iter()
        .filter_map(|row| row.get::<&str, _>(0).map(str::to_string))
        .collect();
    if key_unchanged(&current, pk, true) {
        return Ok(());
    }
    inner.sources.clear();
    if current.is_empty() {
        // No key at all: dropped, or no such table in this database.
        let sql = format!(
            "SELECT 1 FROM {catalog}INFORMATION_SCHEMA.TABLES \
             WHERE TABLE_SCHEMA = @P1 AND TABLE_NAME = @P2"
        );
        let rows = client
            .query(&sql, &[&schema as &dyn ToSql, &table as &dyn ToSql])
            .await
            .map_err(mssql_err)?
            .into_first_result()
            .await
            .map_err(mssql_err)?;
        if rows.is_empty() {
            return Err(EngineError::TableNotFound);
        }
    }
    Err(EngineError::NotEditable(KEY_CHANGED.into()))
}

/// The table a SELECT read and its primary key, when the result holds every
/// key column. The lookups run on a table's first SELECT only; failed ones
/// are not kept.
async fn detect_source(
    inner: &MssqlInner,
    client: &mut MsConn<'_>,
    sql: &str,
    columns: &[String],
) -> (Option<String>, Option<Vec<String>>) {
    let Some((schema_part, table_part)) = parse_single_table(sql) else {
        return (None, None);
    };
    let schema = schema_part.unwrap_or_else(|| inner.default_schema.clone());

    let key = (schema, table_part);
    let (display, pk) = match inner.sources.get(&key) {
        Some(Some(source)) => source,
        Some(None) => return (None, None),
        None => {
            // None when the lookup failed, Some(None) when it found nothing.
            let lookup = match client
                .query(
                    TABLE_LOOKUP_SQL,
                    &[&key.0 as &dyn ToSql, &key.1 as &dyn ToSql],
                )
                .await
            {
                Ok(stream) => match stream.into_first_result().await {
                    Ok(rows) => Some(rows.first().and_then(|row| {
                        let schema: Option<&str> = row.get(0);
                        let table: Option<&str> = row.get(1);
                        match (schema, table) {
                            (Some(schema), Some(table)) => {
                                Some((schema.to_string(), table.to_string()))
                            }
                            _ => None,
                        }
                    })),
                    Err(_) => None,
                },
                Err(_) => None,
            };
            let Some(found) = lookup else {
                return (None, None);
            };
            let Some((canonical_schema, canonical_table)) = found else {
                inner.sources.put(key, None);
                return (None, None);
            };
            let display = display_name(&canonical_schema, &canonical_table);

            let pk_rows = match client
                .query(
                    PK_SQL,
                    &[
                        &canonical_schema as &dyn ToSql,
                        &canonical_table as &dyn ToSql,
                    ],
                )
                .await
            {
                Ok(stream) => match stream.into_first_result().await {
                    Ok(rows) => rows,
                    Err(_) => return (Some(display), None),
                },
                Err(_) => return (Some(display), None),
            };
            let pk: Vec<String> = pk_rows
                .iter()
                .filter_map(|row| row.get::<&str, _>(0).map(str::to_string))
                .collect();
            inner.sources.put(key, Some((display.clone(), pk.clone())));
            (display, pk)
        }
    };
    if pk.is_empty() {
        return (Some(display), None);
    }
    let columns_lower: Vec<String> = columns.iter().map(|name| name.to_lowercase()).collect();
    let all_present = pk
        .iter()
        .all(|name| columns_lower.contains(&name.to_lowercase()));
    if !all_present {
        return (Some(display), None);
    }
    (Some(display), Some(pk))
}

fn display_name(schema: &str, table: &str) -> String {
    if schema.eq_ignore_ascii_case("dbo") {
        table.to_string()
    } else {
        format!("{schema}.{table}")
    }
}

fn split_display_table(display: &str) -> (Option<String>, String) {
    match display.split_once('.') {
        Some((schema, table)) => (Some(trim_ident(schema)), trim_ident(table)),
        None => (None, trim_ident(display)),
    }
}

fn qualified(database: &str, schema: &str, table: &str) -> String {
    if database.trim().is_empty() {
        format!("{}.{}", quote_ident(schema), quote_ident(table))
    } else {
        format!(
            "{}.{}.{}",
            quote_ident(database),
            quote_ident(schema),
            quote_ident(table)
        )
    }
}

fn quote_ident(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}

fn cast_type(declared: &str) -> &'static str {
    match declared.to_lowercase().as_str() {
        "tinyint" => "TINYINT",
        "smallint" => "SMALLINT",
        "int" => "INT",
        "bigint" => "BIGINT",
        "decimal" | "numeric" => "DECIMAL(38,10)",
        "money" | "smallmoney" => "MONEY",
        "float" => "FLOAT",
        "real" => "REAL",
        "bit" => "BIT",
        "date" => "DATE",
        "time" => "TIME",
        "datetime" | "datetime2" | "smalldatetime" => "DATETIME2",
        "datetimeoffset" => "DATETIMEOFFSET",
        "uniqueidentifier" => "UNIQUEIDENTIFIER",
        "binary" | "varbinary" | "image" | "timestamp" | "rowversion" => "VARBINARY(MAX)",
        _ => "NVARCHAR(MAX)",
    }
}

fn decl_type(
    data_type: &str,
    max_len: Option<i64>,
    precision: Option<i64>,
    scale: Option<i64>,
) -> String {
    let lower = data_type.to_lowercase();
    match lower.as_str() {
        "char" | "varchar" | "nchar" | "nvarchar" | "binary" | "varbinary" => match max_len {
            Some(-1) => format!("{lower}(max)"),
            Some(len) => format!("{lower}({len})"),
            None => lower,
        },
        "decimal" | "numeric" => match (precision, scale) {
            (Some(precision), Some(scale)) => format!("{lower}({precision},{scale})"),
            _ => lower,
        },
        _ => lower,
    }
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

fn cd_i64(value: Option<&ColumnData<'_>>) -> Option<i64> {
    match value? {
        ColumnData::U8(value) => value.map(i64::from),
        ColumnData::I16(value) => value.map(i64::from),
        ColumnData::I32(value) => value.map(i64::from),
        ColumnData::I64(value) => *value,
        ColumnData::Bit(value) => (*value).map(i64::from),
        _ => None,
    }
}

fn cd_string(value: Option<&ColumnData<'_>>) -> Option<String> {
    match value? {
        ColumnData::String(text) => text.as_ref().map(|text| text.to_string()),
        _ => None,
    }
}

fn column_json(data: ColumnData<'static>) -> Value {
    if matches!(
        &data,
        ColumnData::DateTime(_) | ColumnData::SmallDateTime(_) | ColumnData::DateTime2(_)
    ) {
        return chrono_text::<chrono::NaiveDateTime>(data);
    }
    if matches!(&data, ColumnData::Date(_)) {
        return chrono_text::<chrono::NaiveDate>(data);
    }
    if matches!(&data, ColumnData::Time(_)) {
        return chrono_text::<chrono::NaiveTime>(data);
    }
    if matches!(&data, ColumnData::DateTimeOffset(_)) {
        return chrono_text::<chrono::DateTime<chrono::FixedOffset>>(data);
    }
    match data {
        ColumnData::U8(value) => value
            .map(|number| Value::from(i64::from(number)))
            .unwrap_or(Value::Null),
        ColumnData::I16(value) => value
            .map(|number| Value::from(i64::from(number)))
            .unwrap_or(Value::Null),
        ColumnData::I32(value) => value
            .map(|number| Value::from(i64::from(number)))
            .unwrap_or(Value::Null),
        ColumnData::I64(value) => value.map(Value::from).unwrap_or(Value::Null),
        ColumnData::F32(value) => value.map(real_json).unwrap_or(Value::Null),
        ColumnData::F64(value) => value.map(Value::from).unwrap_or(Value::Null),
        ColumnData::Bit(value) => value.map(Value::Bool).unwrap_or(Value::Null),
        ColumnData::String(value) => value
            .map(|text| Value::from(text.into_owned()))
            .unwrap_or(Value::Null),
        ColumnData::Guid(value) => value
            .map(|guid| Value::from(guid.to_string()))
            .unwrap_or(Value::Null),
        ColumnData::Binary(value) => value
            .map(|bytes| hex_cell(&bytes, false))
            .unwrap_or(Value::Null),
        ColumnData::Numeric(value) => value
            .map(|number| Value::from(number.to_string()))
            .unwrap_or(Value::Null),
        ColumnData::Xml(value) => value
            .map(|xml| Value::from(xml.to_string()))
            .unwrap_or(Value::Null),
        ColumnData::DateTime(_)
        | ColumnData::SmallDateTime(_)
        | ColumnData::Time(_)
        | ColumnData::Date(_)
        | ColumnData::DateTime2(_)
        | ColumnData::DateTimeOffset(_) => Value::Null,
    }
}

fn chrono_text<T>(data: ColumnData<'static>) -> Value
where
    T: FromSqlOwned + std::fmt::Display,
{
    match T::from_sql_owned(data) {
        Ok(Some(value)) => Value::from(value.to_string()),
        Ok(None) => Value::Null,
        Err(_) => Value::from("<datetime>"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_value_expressions_are_written_by_the_server() {
        assert_eq!(
            value_sql(None, 2, "NVARCHAR(MAX)"),
            "CAST(@P2 AS NVARCHAR(MAX))"
        );
        assert_eq!(value_sql(Some(ValueExpr::Default), 1, "INT"), "DEFAULT");
        assert_eq!(value_sql(Some(ValueExpr::Now), 1, "DATETIME2"), "GETDATE()");
        assert_eq!(
            value_sql(Some(ValueExpr::Now), 1, "DATETIMEOFFSET"),
            "SYSDATETIMEOFFSET()"
        );
    }

    // A session with no server behind it: the cancel's KILL connects to a
    // port nobody listens on and goes nowhere.
    fn idle_session(log: SqlLog) -> MssqlInner {
        let mut config = Config::new();
        config.host("127.0.0.1");
        config.port(1);
        MssqlInner {
            client: tokio::sync::Mutex::new(None),
            config,
            database: String::new(),
            default_schema: "dbo".into(),
            spid: AtomicI32::new(51),
            label: String::new(),
            in_tx: AtomicBool::new(true),
            tx_lost: Mutex::new(None),
            cancel_requested: AtomicBool::new(false),
            session_dead: AtomicBool::new(false),
            sources: SourceCache::default(),
            log,
        }
    }

    #[test]
    fn batch_end_claims_only_what_it_knows() {
        use BatchEnd::*;
        use TxControl::{Begin, Commit, Rollback};
        // The user's COMMIT or ROLLBACK, the batch went through.
        assert_eq!(batch_end(Some(Commit), true, false), Committed);
        assert_eq!(batch_end(Some(Rollback), true, false), RolledBack);
        // UPDATE …; COMMIT; SELECT 1/0, or UPDATE …; INSERT <dup>; COMMIT:
        // whether the COMMIT ran is unknown, XACT_ABORT or not.
        assert_eq!(batch_end(Some(Commit), false, false), Unknown);
        // A failed batch with a ROLLBACK: rolled back by one or the other.
        assert_eq!(batch_end(Some(Rollback), false, false), RolledBack);
        // A failure and no COMMIT or ROLLBACK (a deadlock victim, XACT_ABORT).
        assert_eq!(batch_end(None, false, false), ServerRolledBack);
        assert_eq!(batch_end(Some(Begin), false, false), ServerRolledBack);
        // Nested COMMIT, or a failure the transaction survived.
        assert_eq!(batch_end(Some(Commit), true, true), StillOpen);
        assert_eq!(batch_end(None, false, true), StillOpen);
    }

    #[tokio::test]
    async fn a_cancel_ends_the_transaction_at_once() {
        let log = SqlLog::new();
        let mut changes = log.take_changes().unwrap();
        let inner = idle_session(log.clone());
        let held = Change {
            sql: "UPDATE t SET a = 1".into(),
            ms: 0,
            rows: 1,
        };
        log.changed(held, inner.in_tx());
        let key = ("dbo".to_string(), "t".to_string());
        inner
            .sources
            .put(key.clone(), Some(("t".into(), vec!["id".into()])));

        inner.cancel();
        // The reply to the cancelled query already says no transaction, and
        // what it held is not History.
        assert!(!inner.in_tx());
        assert_eq!(*inner.lost(), Some(CANCELLED));
        assert!(inner.session_dead.load(Ordering::SeqCst));
        // The rollback may have undone DDL, and the next session starts in
        // the connection's database: no source survives.
        assert_eq!(inner.sources.get(&key), None);
        log.settle(true);
        assert!(changes.try_recv().is_err());
    }
}
