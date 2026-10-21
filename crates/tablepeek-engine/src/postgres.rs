use std::fs::File;
use std::io::BufReader;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use futures_util::StreamExt;
use rustls::RootCertStore;
use serde_json::Value;
use tokio_postgres::config::SslMode as PgSslMode;
use tokio_postgres::types::{FromSqlOwned, ToSql, Type};
use tokio_postgres::{Client, NoTls, Row};
use tokio_postgres_rustls::MakeRustlsConnect;
use tablepeek_types::{
    ColumnSchema, DbObjects, EditTarget, EngineMeta, ForeignKeyInfo, IndexInfo, ObjectDefinition,
    PkValue, PostgresConfig, ServerInfo, ServerSession, SslMode, TableDetail, TableSchema,
};

use crate::{build_arrow, humanize_uptime_ko, postgres_message, EngineError, QueryData};

pub struct PostgresInner {
    pub(crate) client: Arc<tokio::sync::Mutex<Client>>,
    cancel: tokio_postgres::CancelToken,
    tls: Option<MakeRustlsConnect>,
    label: String,
    in_tx: AtomicBool,
    kind: &'static str,
    backend_pid: i32,
}

impl PostgresInner {
    pub(crate) fn in_tx(&self) -> bool {
        self.in_tx.load(Ordering::SeqCst)
    }

    pub(crate) fn cancel(&self) {
        let token = self.cancel.clone();
        if let Some(tls) = self.tls.clone() {
            tokio::spawn(async move {
                let _ = token.cancel_query(tls).await;
            });
        } else {
            tokio::spawn(async move {
                let _ = token.cancel_query(NoTls).await;
            });
        }
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
    let backend_pid: i32 = client
        .query_one("SELECT pg_backend_pid()::bigint", &[])
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
        in_tx: AtomicBool::new(false),
        kind,
        backend_pid,
    }))
}

pub(crate) async fn meta(
    inner: &PostgresInner,
    include_system: bool,
) -> Result<EngineMeta, EngineError> {
    let client = inner.client.lock().await;
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
    let client = inner.client.lock().await;
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
    let client = inner.client.lock().await;
    let statement = client.prepare(sql).await?;
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

    {
        let stream = client
            .query_raw(&statement, std::iter::empty::<i32>())
            .await?;
        futures_util::pin_mut!(stream);
        while let Some(row) = stream.next().await {
            let row: Row = row?;
            if count >= max_rows {
                truncated = true;
                break;
            }
            for i in 0..col_count {
                column_values[i].push(pg_value(&row, i, &col_types[i]));
            }
            count += 1;
        }
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
    })
}

pub(crate) async fn edit(inner: &PostgresInner, target: &EditTarget) -> Result<u64, EngineError> {
    if target.pk.is_empty() {
        return Err(EngineError::NotEditable(
            "기본 키가 없어 편집할 수 없습니다".into(),
        ));
    }
    let client = inner.client.lock().await;
    let table = qualified_from_display(&target.table);
    let column_type = column_type_of(&client, &table, &target.column).await?;

    let mut sql = format!(
        "UPDATE {table} SET {} = ($1::text)::{column_type} WHERE ",
        quote_ident(&target.column)
    );
    let mut params: Vec<Option<String>> = vec![target.value.clone()];
    for (index, pk) in target.pk.iter().enumerate() {
        if index > 0 {
            sql.push_str(" AND ");
        }
        let pk_type = column_type_of(&client, &table, &pk.column).await?;
        let position = index + 2;
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
        params.push(pk_value_string(&pk.value));
    }

    let refs: Vec<&(dyn ToSql + Sync)> = params
        .iter()
        .map(|param| param as &(dyn ToSql + Sync))
        .collect();
    let changed = client.execute(&sql, &refs).await?;
    Ok(changed)
}

pub(crate) async fn insert_row(
    inner: &PostgresInner,
    table: &str,
    values: &[(String, Option<String>)],
) -> Result<u64, EngineError> {
    let client = inner.client.lock().await;
    let table_ref = qualified_from_display(table);
    let sql = if values.is_empty() {
        format!("INSERT INTO {table_ref} DEFAULT VALUES")
    } else {
        let columns = values
            .iter()
            .map(|(column, _)| quote_ident(column))
            .collect::<Vec<_>>()
            .join(", ");
        let mut placeholders = Vec::with_capacity(values.len());
        for (index, (column, _)) in values.iter().enumerate() {
            let column_type = column_type_of(&client, &table_ref, column).await?;
            placeholders.push(format!("(${}::text)::{column_type}", index + 1));
        }
        format!(
            "INSERT INTO {table_ref} ({columns}) VALUES ({})",
            placeholders.join(", ")
        )
    };
    let params: Vec<Option<String>> = values.iter().map(|(_, value)| value.clone()).collect();
    let refs: Vec<&(dyn ToSql + Sync)> = params
        .iter()
        .map(|param| param as &(dyn ToSql + Sync))
        .collect();
    let changed = client.execute(&sql, &refs).await?;
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
    let client = inner.client.lock().await;
    let table_ref = qualified_from_display(table);
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
    let refs: Vec<&(dyn ToSql + Sync)> = params
        .iter()
        .map(|param| param as &(dyn ToSql + Sync))
        .collect();
    let changed = client.execute(&sql, &refs).await?;
    Ok(changed)
}

const DETAIL_SAVEPOINT: &str = "tablepeek_detail";

pub(crate) async fn table_detail(
    inner: &PostgresInner,
    name: &str,
) -> Result<TableDetail, EngineError> {
    let client = inner.client.lock().await;
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
async fn recover(client: &Client, fenced: bool) {
    if fenced {
        let _ = client
            .batch_execute(&format!("ROLLBACK TO SAVEPOINT {DETAIL_SAVEPOINT}"))
            .await;
    }
}

async fn ok_or_recover<T>(
    client: &Client,
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

async fn table_detail_in(
    client: &Client,
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

    let columns = client
        .query(COLUMN_SQL, &[&qualified_ref])
        .await?
        .iter()
        .map(|col| ColumnSchema {
            name: col.get(0),
            decl_type: Some(col.get(1)),
            not_null: col.get(2),
            pk: col.get(3),
            default: col.get(4),
        })
        .collect::<Vec<_>>();

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
            .query_opt("SELECT reltuples::bigint FROM pg_class WHERE oid = $1", &[&oid])
            .await,
    )
    .await
    .flatten()
    .and_then(|row| row.get::<_, Option<i64>>(0))
    .filter(|count| *count >= 0);
    if row_count_estimate.is_none() && inner.kind == "cockroach" {
        let table_id = i64::from(oid);
        row_count_estimate = ok_or_recover(
            client,
            fenced,
            client
                .query_opt(
                    "SELECT estimated_row_count FROM crdb_internal.table_row_statistics \
                     WHERE table_id = $1",
                    &[&table_id],
                )
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
        schema: Some(schema_name.clone()),
    })
}

pub(crate) async fn server_info(inner: &PostgresInner) -> Result<ServerInfo, EngineError> {
    let client = inner.client.lock().await;
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

async fn pg_sessions(client: &Client, backend_pid: i32) -> Result<Vec<ServerSession>, EngineError> {
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
    let client = inner.client.lock().await;
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
    let client = inner.client.lock().await;
    let row = client
        .query_one(
            &format!("SELECT COUNT(*) FROM {}", qualified_from_display(name)),
            &[],
        )
        .await?;
    Ok(row.get::<_, i64>(0))
}

pub(crate) async fn databases(inner: &PostgresInner) -> Result<Vec<String>, EngineError> {
    let client = inner.client.lock().await;
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
    let client = inner.client.lock().await;
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

async fn exists_in(client: &Client, sql: &str, schema_name: &str, object_name: &str) -> bool {
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
    let client = inner.client.lock().await;
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
    let client = inner.client.lock().await;
    client.batch_execute(statement).await?;
    drop(client);
    inner.in_tx.store(statement == "BEGIN", Ordering::SeqCst);
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

const PK_SQL: &str = "SELECT a.attname
     FROM pg_index i
     JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
     WHERE i.indrelid = $1 AND i.indisprimary
     ORDER BY k.ord";

async fn detect_source(
    client: &Client,
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

    let source_table = match client
        .query_opt(
            "SELECT n.nspname, c.relname FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = $1",
            &[&oid],
        )
        .await
    {
        Ok(Some(row)) => Some(display_name(
            &row.get::<_, String>(0),
            &row.get::<_, String>(1),
        )),
        _ => None,
    };

    let pk = match client.query(PK_SQL, &[&oid]).await {
        Ok(rows) => {
            let names: Vec<String> = rows.iter().map(|row| row.get::<_, String>(0)).collect();
            if names.is_empty() || !names.iter().all(|name| columns.contains(name)) {
                None
            } else {
                Some(names)
            }
        }
        Err(_) => None,
    };

    (source_table, pk)
}

async fn column_type_of(client: &Client, table: &str, column: &str) -> Result<String, EngineError> {
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

fn pg_value(row: &Row, index: usize, dtype: &Type) -> Value {
    match *dtype {
        Type::INT2 => from_pg::<i16, _>(row, index, dtype, |value| Value::from(i64::from(value))),
        Type::INT4 => from_pg::<i32, _>(row, index, dtype, |value| Value::from(i64::from(value))),
        Type::INT8 => from_pg::<i64, _>(row, index, dtype, Value::from),
        Type::OID => from_pg::<u32, _>(row, index, dtype, |value| Value::from(i64::from(value))),
        Type::FLOAT4 => from_pg::<f32, _>(row, index, dtype, |value| Value::from(f64::from(value))),
        Type::FLOAT8 => from_pg::<f64, _>(row, index, dtype, Value::from),
        Type::NUMERIC => from_pg::<rust_decimal::Decimal, _>(row, index, dtype, |value| {
            Value::from(value.to_string())
        }),
        Type::CHAR => from_pg::<i8, _>(row, index, dtype, |value| {
            Value::from(char::from(value as u8).to_string())
        }),
        Type::BOOL => from_pg::<bool, _>(row, index, dtype, Value::Bool),
        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME | Type::UNKNOWN => {
            from_pg::<String, _>(row, index, dtype, Value::from)
        }
        Type::DATE => from_pg::<chrono::NaiveDate, _>(row, index, dtype, |value| {
            Value::from(value.to_string())
        }),
        Type::TIME => from_pg::<chrono::NaiveTime, _>(row, index, dtype, |value| {
            Value::from(value.to_string())
        }),
        Type::TIMESTAMP => from_pg::<chrono::NaiveDateTime, _>(row, index, dtype, |value| {
            Value::from(value.to_string())
        }),
        Type::TIMESTAMPTZ => {
            from_pg::<chrono::DateTime<chrono::Utc>, _>(row, index, dtype, |value| {
                Value::from(value.format("%Y-%m-%d %H:%M:%S%:z").to_string())
            })
        }
        Type::UUID => {
            from_pg::<uuid::Uuid, _>(row, index, dtype, |value| Value::from(value.to_string()))
        }
        Type::JSON | Type::JSONB => {
            from_pg::<Value, _>(row, index, dtype, |value| Value::from(value.to_string()))
        }
        Type::BYTEA => from_pg::<Vec<u8>, _>(row, index, dtype, |value| {
            Value::from(format!("<blob {} bytes>", value.len()))
        }),
        _ => Value::from(format!("<{}>", dtype.name())),
    }
}

fn from_pg<T, F>(row: &Row, index: usize, dtype: &Type, convert: F) -> Value
where
    T: FromSqlOwned,
    F: FnOnce(T) -> Value,
{
    match row.try_get::<usize, Option<T>>(index) {
        Ok(Some(value)) => convert(value),
        Ok(None) => Value::Null,
        Err(_) => Value::from(format!("<{}>", dtype.name())),
    }
}
