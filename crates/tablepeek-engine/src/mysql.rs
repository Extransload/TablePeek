use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use futures_util::StreamExt;
use mysql_async::consts::{ColumnFlags, ColumnType};
use mysql_async::prelude::Queryable;
use mysql_async::{
    ClientIdentity, Column, Conn, DriverError, Error as MyError, Opts, OptsBuilder, Row, SslOpts,
    Value as MyValue,
};
use serde_json::Value;
use tablepeek_types::{
    ColumnSchema, DbObjects, EditTarget, EngineMeta, ForeignKeyInfo, IndexInfo, MySqlConfig,
    ObjectDefinition, PkValue, ServerInfo, ServerSession, SslMode, TableDetail, TableSchema,
};

use crate::sql_parse::{parse_single_table, trim_ident};
use crate::{build_arrow, humanize_uptime_ko, EngineError, QueryData};

pub struct MySqlInner {
    conn: Arc<tokio::sync::Mutex<Conn>>,
    opts: Opts,
    connection_id: AtomicU64,
    label: String,
    in_tx: AtomicBool,
}

impl MySqlInner {
    pub(crate) fn in_tx(&self) -> bool {
        self.in_tx.load(Ordering::SeqCst)
    }

    pub(crate) fn cancel(&self) {
        let opts = self.opts.clone();
        let connection_id = self.connection_id.load(Ordering::SeqCst);
        tokio::spawn(async move {
            if let Ok(mut conn) = Conn::new(opts).await {
                let sql = format!("KILL QUERY {connection_id}");
                let _ = conn.query_drop(sql).await;
                let _ = conn.disconnect().await;
            }
        });
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

fn tls_fallback_allowed(err: &MyError) -> bool {
    match err {
        MyError::Io(mysql_async::IoError::Tls(_)) => true,
        MyError::Driver(DriverError::NoClientSslFlagFromServer) => true,
        MyError::Server(server) => matches!(server.code, 2026 | 3159),
        MyError::Other(source) => {
            let text = source.to_string().to_ascii_lowercase();
            text.contains("tls") || text.contains("ssl") || text.contains("certificate")
        }
        _ => false,
    }
}

pub(crate) async fn connect(config: &MySqlConfig) -> Result<Arc<MySqlInner>, EngineError> {
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
            return Err(EngineError::MySql(format!("MySQL TLS 연결 실패: {err}")));
        }
    };
    let connection_id = conn
        .query_first::<u64, _>("SELECT CONNECTION_ID()")
        .await
        .map_err(mysql_err)?
        .unwrap_or_default();
    let database = conn
        .query_first::<String, _>("SELECT DATABASE()")
        .await
        .map_err(mysql_err)?
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| config.database.clone());
    Ok(Arc::new(MySqlInner {
        conn: Arc::new(tokio::sync::Mutex::new(conn)),
        opts,
        connection_id: AtomicU64::new(connection_id),
        label: format!(
            "{}@{}:{}/{}",
            config.user, config.host, config.port, database
        ),
        in_tx: AtomicBool::new(false),
    }))
}

const TABLE_LIST_SQL: &str = "SELECT TABLE_NAME FROM information_schema.TABLES \
     WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME";

const TABLE_LIST_SYS_SQL: &str =
    "SELECT TABLE_SCHEMA, TABLE_NAME FROM information_schema.TABLES \
     WHERE TABLE_SCHEMA IN (DATABASE(), 'information_schema', 'mysql', 'performance_schema', 'sys') \
     ORDER BY TABLE_SCHEMA, TABLE_NAME";

const COLUMN_SQL_SYS: &str = "SELECT c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, \
     EXISTS (SELECT 1 FROM information_schema.KEY_COLUMN_USAGE k \
             WHERE k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME \
               AND k.COLUMN_NAME = c.COLUMN_NAME AND k.CONSTRAINT_NAME = 'PRIMARY') AS is_pk, \
     c.COLUMN_DEFAULT \
     FROM information_schema.COLUMNS c \
     WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ? \
     ORDER BY c.ORDINAL_POSITION";

const COLUMN_SQL: &str = "SELECT c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, \
     EXISTS (SELECT 1 FROM information_schema.KEY_COLUMN_USAGE k \
             WHERE k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME \
               AND k.COLUMN_NAME = c.COLUMN_NAME AND k.CONSTRAINT_NAME = 'PRIMARY') AS is_pk, \
     c.COLUMN_DEFAULT \
     FROM information_schema.COLUMNS c \
     WHERE c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = ? \
     ORDER BY c.ORDINAL_POSITION";

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
    let mut conn = inner.conn.lock().await;
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
    let mut conn = inner.conn.lock().await;
    let mut entries: Vec<(Option<String>, String)> = Vec::new();
    if include_system {
        let current: Option<String> = conn
            .query_first("SELECT DATABASE()")
            .await
            .map_err(mysql_err)?;
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
    let mut out = Vec::with_capacity(entries.len());
    for (schema_part, table) in entries {
        let rows: Vec<Row> = match &schema_part {
            Some(schema) => conn
                .exec(COLUMN_SQL_SYS, (schema.clone(), table.clone()))
                .await
                .map_err(mysql_err)?,
            None => conn
                .exec(COLUMN_SQL, vec![MyValue::from(table.clone())])
                .await
                .map_err(mysql_err)?,
        };
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
            })
            .collect();
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
    let mut conn = inner.conn.lock().await;
    let mut result = conn.query_iter(sql).await.map_err(mysql_err)?;
    let columns_meta: Vec<Column> = result
        .columns()
        .map(|columns| columns.to_vec())
        .unwrap_or_default();
    let columns: Vec<String> = columns_meta
        .iter()
        .map(|column| column.name_str().to_string())
        .collect();
    let col_count = columns.len();
    let mut column_values: Vec<Vec<Value>> = vec![Vec::new(); col_count];
    let mut count = 0usize;
    let mut truncated = false;

    {
        let mut stream = result.stream::<Row>().await.map_err(mysql_err)?;
        if let Some(stream) = stream.as_mut() {
            while let Some(row) = stream.next().await {
                let row = row.map_err(mysql_err)?;
                if count >= max_rows {
                    truncated = true;
                    break;
                }
                let values = row.unwrap();
                for (index, value) in values.iter().enumerate() {
                    if index < col_count {
                        column_values[index].push(json_value(value, &columns_meta[index]));
                    }
                }
                count += 1;
            }
        }
    }
    drop(result);

    let (source_table, pk) = detect_source(&mut conn, sql, &columns).await;
    let (schema, batches) = build_arrow(&columns, column_values, count)?;
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    Ok(QueryData {
        kind: "mysql",
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

pub(crate) async fn edit(inner: &MySqlInner, target: &EditTarget) -> Result<u64, EngineError> {
    if target.pk.is_empty() {
        return Err(EngineError::NotEditable(
            "기본 키가 없어 편집할 수 없습니다".into(),
        ));
    }
    let mut conn = inner.conn.lock().await;
    let (schema_part, table) = split_display_table(&target.table);
    let schema = match schema_part {
        Some(schema) => schema,
        None => current_schema(&mut conn).await?,
    };
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

    let result = conn.exec_iter(sql, params).await.map_err(mysql_err)?;
    let changed = result.affected_rows();
    result.drop_result().await.map_err(mysql_err)?;
    Ok(changed)
}

pub(crate) async fn insert_row(
    inner: &MySqlInner,
    table: &str,
    values: &[(String, Option<String>)],
) -> Result<u64, EngineError> {
    let mut conn = inner.conn.lock().await;
    let (schema_part, table_name) = split_display_table(table);
    let schema = match schema_part {
        Some(schema) => schema,
        None => current_schema(&mut conn).await?,
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
    let result = conn.exec_iter(sql, params).await.map_err(mysql_err)?;
    let changed = result.affected_rows();
    result.drop_result().await.map_err(mysql_err)?;
    Ok(changed)
}

pub(crate) async fn delete_row(
    inner: &MySqlInner,
    table: &str,
    pk: &[PkValue],
) -> Result<u64, EngineError> {
    if pk.is_empty() {
        return Err(EngineError::BadRequest("PK 조건이 필요합니다".into()));
    }
    let mut conn = inner.conn.lock().await;
    let (schema_part, table_name) = split_display_table(table);
    let schema = match schema_part {
        Some(schema) => schema,
        None => current_schema(&mut conn).await?,
    };
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
    let result = conn.exec_iter(sql, params).await.map_err(mysql_err)?;
    let changed = result.affected_rows();
    result.drop_result().await.map_err(mysql_err)?;
    Ok(changed)
}

pub(crate) async fn table_detail(
    inner: &MySqlInner,
    name: &str,
) -> Result<TableDetail, EngineError> {
    let mut conn = inner.conn.lock().await;
    let (schema_part, table_name) = split_display_table(name);
    let schema = match schema_part.as_deref() {
        Some(schema) => schema.to_string(),
        None => current_schema(&mut conn).await?,
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

    let stats: Option<(Option<u64>, Option<u64>)> = conn
        .exec_first(
            "SELECT TABLE_ROWS, DATA_LENGTH + INDEX_LENGTH FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
            vec![
                MyValue::from(canonical_schema.clone()),
                MyValue::from(canonical_table.clone()),
            ],
        )
        .await
        .ok()
        .flatten();
    let (row_count_estimate, size_bytes) = stats
        .map(|(rows, size)| {
            (
                rows.map(|value| value as i64),
                size.map(|value| value as i64),
            )
        })
        .unwrap_or((None, None));

    let table_ref = qualified(&canonical_schema, &canonical_table);
    Ok(TableDetail {
        name: if schema_part.is_some() {
            format!("{canonical_schema}.{canonical_table}")
        } else {
            canonical_table.clone()
        },
        row_count_estimate,
        size_bytes,
        ddl: Some(build_create_table(&table_ref, &columns)),
        columns,
        indexes,
        foreign_keys,
        schema: Some(canonical_schema.clone()),
    })
}

pub(crate) async fn server_info(inner: &MySqlInner) -> Result<ServerInfo, EngineError> {
    let mut conn = inner.conn.lock().await;
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
    let mut conn = inner.conn.lock().await;
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
    let mut conn = inner.conn.lock().await;
    let qualified: Vec<String> = name.split('.').map(quote_ident).collect();
    let sql = format!("SELECT COUNT(*) FROM {}", qualified.join("."));
    conn.query_first::<i64, _>(sql)
        .await
        .map_err(mysql_err)?
        .ok_or_else(|| EngineError::Internal("행 수를 가져오지 못했습니다".into()))
}

pub(crate) async fn databases(inner: &MySqlInner) -> Result<Vec<String>, EngineError> {
    let mut conn = inner.conn.lock().await;
    let rows: Vec<String> = conn.query("SHOW DATABASES").await.map_err(mysql_err)?;
    Ok(rows)
}

pub(crate) async fn object_definition(
    inner: &MySqlInner,
    kind: &str,
    name: &str,
) -> Result<Option<ObjectDefinition>, EngineError> {
    let mut conn = inner.conn.lock().await;
    let (schema_part, object_name) = split_display_table(name);
    let schema = match schema_part {
        Some(schema) => schema,
        None => current_schema(&mut conn).await?,
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
    let mut conn = inner.conn.lock().await;
    conn.query_drop(format!("KILL {id}"))
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
    let mut conn = inner.conn.lock().await;
    conn.query_drop(statement).await.map_err(mysql_err)?;
    drop(conn);
    inner.in_tx.store(statement == "BEGIN", Ordering::SeqCst);
    Ok(())
}

async fn current_schema(conn: &mut Conn) -> Result<String, EngineError> {
    conn.query_first::<String, _>("SELECT DATABASE()")
        .await
        .map_err(mysql_err)?
        .ok_or_else(|| EngineError::Internal("데이터베이스가 선택되지 않았습니다".into()))
}

async fn column_type_of(
    conn: &mut Conn,
    schema: &str,
    table: &str,
    column: &str,
) -> Result<(String, String), EngineError> {
    conn.exec_first::<(String, String), _, _>(
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

async fn detect_source(
    conn: &mut Conn,
    sql: &str,
    columns: &[String],
) -> (Option<String>, Option<Vec<String>>) {
    let Some((schema_part, table_part)) = parse_single_table(sql) else {
        return (None, None);
    };
    let schema = match schema_part.as_ref() {
        Some(schema) => schema.clone(),
        None => match current_schema(conn).await {
            Ok(schema) => schema,
            Err(_) => return (None, None),
        },
    };

    let canonical: Option<(String, String)> = conn
        .exec_first(
            TABLE_LOOKUP_SQL,
            vec![
                MyValue::from(schema.clone()),
                MyValue::from(table_part.clone()),
            ],
        )
        .await
        .ok()
        .flatten();
    let Some((canonical_schema, canonical_table)) = canonical else {
        return (None, None);
    };

    let display = if schema_part.is_some() {
        format!("{canonical_schema}.{canonical_table}")
    } else {
        canonical_table.clone()
    };

    let pk_rows: Vec<String> = match conn
        .exec(
            PK_SQL,
            vec![
                MyValue::from(canonical_schema),
                MyValue::from(canonical_table),
            ],
        )
        .await
    {
        Ok(rows) => rows,
        Err(_) => return (Some(display), None),
    };
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
    fn prefer_falls_back_only_for_tls_failures() {
        assert!(tls_fallback_allowed(&server(2026)));
        assert!(tls_fallback_allowed(&server(3159)));
        assert!(tls_fallback_allowed(&MyError::Driver(
            DriverError::NoClientSslFlagFromServer
        )));
        assert!(!tls_fallback_allowed(&server(1045)));
        assert!(!tls_fallback_allowed(&server(1049)));
    }
}
