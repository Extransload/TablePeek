use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use futures_util::StreamExt;
use prodb_types::{ColumnSchema, EditTarget, EngineMeta, PostgresConfig, SslMode, TableSchema};
use serde_json::Value;
use tokio_postgres::types::{FromSqlOwned, ToSql, Type};
use tokio_postgres::{Client, NoTls, Row};

use crate::{build_arrow, EngineError, QueryData};

pub struct PostgresInner {
    pub(crate) client: Arc<tokio::sync::Mutex<Client>>,
    cancel: tokio_postgres::CancelToken,
    label: String,
    in_tx: AtomicBool,
    kind: &'static str,
}

impl PostgresInner {
    pub(crate) fn in_tx(&self) -> bool {
        self.in_tx.load(Ordering::SeqCst)
    }

    pub(crate) fn cancel(&self) {
        let token = self.cancel.clone();
        tokio::spawn(async move {
            let _ = token.cancel_query(NoTls).await;
        });
    }
}

pub(crate) async fn connect(
    config: &PostgresConfig,
    kind: &'static str,
) -> Result<Arc<PostgresInner>, EngineError> {
    if config.ssl_mode != SslMode::Disable {
        return Err(EngineError::Internal(
            "TLS 연결은 아직 지원되지 않습니다. SSH 터널 사용을 권장합니다".into(),
        ));
    }
    let mut pg = tokio_postgres::Config::new();
    pg.host(&config.host)
        .port(config.port)
        .user(&config.user)
        .dbname(&config.database)
        .application_name("prodb");
    if let Some(password) = &config.password {
        pg.password(password);
    }
    let (client, connection) = pg
        .connect(NoTls)
        .await
        .map_err(|err| EngineError::Internal(format!("PostgreSQL 연결 실패: {err}")))?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let cancel = client.cancel_token();
    Ok(Arc::new(PostgresInner {
        client: Arc::new(tokio::sync::Mutex::new(client)),
        cancel,
        label: format!(
            "{}@{}:{}/{}",
            config.user, config.host, config.port, config.database
        ),
        in_tx: AtomicBool::new(false),
        kind,
    }))
}

pub(crate) async fn meta(inner: &PostgresInner) -> Result<EngineMeta, EngineError> {
    let client = inner.client.lock().await;
    let rows = client.query(table_list_sql(inner.kind), &[]).await?;
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

pub(crate) async fn schema(inner: &PostgresInner) -> Result<Vec<TableSchema>, EngineError> {
    let client = inner.client.lock().await;
    let rows = client.query(table_list_sql(inner.kind), &[]).await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let schema_name: String = row.get(0);
        let table_name: String = row.get(1);
        let qualified = qualified(&schema_name, &table_name);
        let columns = client
            .query(COLUMN_SQL, &[&qualified])
            .await?
            .iter()
            .map(|col| ColumnSchema {
                name: col.get(0),
                decl_type: Some(col.get(1)),
                not_null: col.get(2),
                pk: col.get(3),
            })
            .collect();
        out.push(TableSchema {
            name: display_name(&schema_name, &table_name),
            columns,
        });
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
    let col_types: Vec<Type> = statement.columns().iter().map(|col| col.type_().clone()).collect();
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

pub(crate) async fn tx(inner: &PostgresInner, statement: &str) -> Result<(), EngineError> {
    let active = inner.in_tx();
    match statement {
        "BEGIN" if active => {
            return Err(EngineError::Internal("이미 트랜잭션이 진행 중입니다".into()));
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

const TABLE_LIST_SQL: &str = "SELECT n.nspname, c.relname
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r','p','v','m')
       AND n.nspname NOT IN ('pg_catalog','information_schema')
       AND n.nspname NOT LIKE 'pg_toast%'
       AND n.nspname NOT LIKE 'pg_temp%'
     ORDER BY n.nspname, c.relname";

const COCKROACH_TABLE_LIST_SQL: &str = "SELECT n.nspname, c.relname
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r','p','v','m')
       AND n.nspname NOT IN ('pg_catalog','information_schema','crdb_internal','pg_extension')
       AND n.nspname NOT LIKE 'pg_toast%'
       AND n.nspname NOT LIKE 'pg_temp%'
     ORDER BY n.nspname, c.relname";

fn table_list_sql(kind: &str) -> &'static str {
    if kind == "cockroach" {
        COCKROACH_TABLE_LIST_SQL
    } else {
        TABLE_LIST_SQL
    }
}

const COLUMN_SQL: &str = "SELECT a.attname,
            format_type(a.atttypid, a.atttypmod),
            a.attnotnull,
            EXISTS (
                SELECT 1 FROM pg_index i
                WHERE i.indrelid = a.attrelid
                  AND i.indisprimary
                  AND a.attnum = ANY(i.indkey)
            ) AS is_pk
     FROM pg_attribute a
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
        Ok(Some(row)) => Some(display_name(&row.get::<_, String>(0), &row.get::<_, String>(1))),
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

async fn column_type_of(
    client: &Client,
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
        Type::TIMESTAMPTZ => from_pg::<chrono::DateTime<chrono::Utc>, _>(row, index, dtype, |value| {
            Value::from(value.format("%Y-%m-%d %H:%M:%S%:z").to_string())
        }),
        Type::UUID => from_pg::<uuid::Uuid, _>(row, index, dtype, |value| {
            Value::from(value.to_string())
        }),
        Type::JSON | Type::JSONB => from_pg::<Value, _>(row, index, dtype, |value| {
            Value::from(value.to_string())
        }),
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
