use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use futures_util::StreamExt;
use mysql_async::consts::{ColumnFlags, ColumnType};
use mysql_async::prelude::Queryable;
use mysql_async::{Column, Conn, Opts, OptsBuilder, Row, Value as MyValue};
use prodb_types::{ColumnSchema, EditTarget, EngineMeta, MySqlConfig, SslMode, TableSchema};
use serde_json::Value;

use crate::sql_parse::{parse_single_table, trim_ident};
use crate::{build_arrow, EngineError, QueryData};

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

fn build_opts(config: &MySqlConfig) -> Opts {
    let mut builder = OptsBuilder::default()
        .ip_or_hostname(config.host.clone())
        .tcp_port(config.port)
        .user(Some(config.user.clone()))
        .pass(config.password.clone())
        .client_found_rows(true);
    if !config.database.trim().is_empty() {
        builder = builder.db_name(Some(config.database.clone()));
    }
    builder.into()
}

fn mysql_err(err: mysql_async::Error) -> EngineError {
    EngineError::MySql(err.to_string())
}

pub(crate) async fn connect(config: &MySqlConfig) -> Result<Arc<MySqlInner>, EngineError> {
    if config.ssl_mode != SslMode::Disable {
        return Err(EngineError::Internal(
            "TLS 연결은 아직 지원되지 않습니다. SSH 터널 사용을 권장합니다".into(),
        ));
    }
    let opts = build_opts(config);
    let mut conn = Conn::new(opts.clone())
        .await
        .map_err(|err| EngineError::MySql(format!("MySQL 연결 실패: {err}")))?;
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

const TABLE_LIST_SQL: &str =
    "SELECT TABLE_NAME FROM information_schema.TABLES \
     WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME";

const COLUMN_SQL: &str = "SELECT c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, \
     EXISTS (SELECT 1 FROM information_schema.KEY_COLUMN_USAGE k \
             WHERE k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME \
               AND k.COLUMN_NAME = c.COLUMN_NAME AND k.CONSTRAINT_NAME = 'PRIMARY') AS is_pk \
     FROM information_schema.COLUMNS c \
     WHERE c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = ? \
     ORDER BY c.ORDINAL_POSITION";

const TABLE_LOOKUP_SQL: &str = "SELECT TABLE_SCHEMA, TABLE_NAME FROM information_schema.TABLES \
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1";

const PK_SQL: &str = "SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE \
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' \
     ORDER BY ORDINAL_POSITION";

const COLUMN_TYPE_SQL: &str = "SELECT DATA_TYPE, COLUMN_TYPE FROM information_schema.COLUMNS \
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?";

pub(crate) async fn meta(inner: &MySqlInner) -> Result<EngineMeta, EngineError> {
    let mut conn = inner.conn.lock().await;
    let tables: Vec<String> = conn.query(TABLE_LIST_SQL).await.map_err(mysql_err)?;
    Ok(EngineMeta {
        kind: "mysql".into(),
        path: Some(inner.label.clone()),
        demo: false,
        tables,
    })
}

pub(crate) async fn schema(inner: &MySqlInner) -> Result<Vec<TableSchema>, EngineError> {
    let mut conn = inner.conn.lock().await;
    let tables: Vec<String> = conn.query(TABLE_LIST_SQL).await.map_err(mysql_err)?;
    let mut out = Vec::with_capacity(tables.len());
    for table in tables {
        let rows: Vec<Row> = conn
            .exec(COLUMN_SQL, vec![MyValue::from(table.clone())])
            .await
            .map_err(mysql_err)?;
        let columns = rows
            .iter()
            .map(|row| ColumnSchema {
                name: row.get::<String, _>(0).unwrap_or_default(),
                decl_type: row.get::<String, _>(1),
                not_null: row
                    .get::<String, _>(2)
                    .map(|value| value == "NO")
                    .unwrap_or(false),
                pk: row.get::<i64, _>(3).map(|value| value != 0).unwrap_or(false),
            })
            .collect();
        out.push(TableSchema {
            name: table,
            columns,
        });
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

pub(crate) async fn tx(inner: &MySqlInner, statement: &str) -> Result<(), EngineError> {
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
                blob_json(value)
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
    } else if micros % 1000 == 0 {
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
