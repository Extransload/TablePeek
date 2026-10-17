use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::Arc;
use std::time::Instant;

use futures_util::StreamExt;
use prodb_types::{ColumnSchema, EditTarget, EngineMeta, MssqlConfig, TableSchema};
use serde_json::Value;
use tiberius::{
    AuthMethod, Client, ColumnData, Config, EncryptionLevel, FromSqlOwned, QueryItem, ToSql,
};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use crate::sql_parse::{parse_single_table, trim_ident};
use crate::{build_arrow, EngineError, QueryData};

type MssqlClient = Client<Compat<TcpStream>>;

pub struct MssqlInner {
    client: tokio::sync::Mutex<Option<MssqlClient>>,
    config: Config,
    database: String,
    default_schema: String,
    spid: AtomicI32,
    label: String,
    in_tx: AtomicBool,
    cancel_requested: AtomicBool,
    session_dead: AtomicBool,
}

impl MssqlInner {
    pub(crate) fn in_tx(&self) -> bool {
        self.in_tx.load(Ordering::SeqCst)
    }

    pub(crate) fn cancel(&self) {
        let spid = self.spid.load(Ordering::SeqCst);
        if spid == 0 {
            return;
        }
        self.cancel_requested.store(true, Ordering::SeqCst);
        self.session_dead.store(true, Ordering::SeqCst);
        let config = self.config.clone();
        tokio::spawn(async move {
            if let Ok(mut client) = open_client(&config).await {
                let sql = format!("KILL {spid}");
                let _ = client.execute(sql, &[]).await;
                let _ = client.close().await;
            }
        });
    }

    async fn client(
        &self,
    ) -> Result<tokio::sync::MutexGuard<'_, Option<MssqlClient>>, EngineError> {
        let mut guard = self.client.lock().await;
        if self.session_dead.swap(false, Ordering::SeqCst) {
            *guard = None;
        }
        if guard.is_none() {
            let mut client = open_client(&self.config).await?;
            self.spid
                .store(read_spid(&mut client).await?, Ordering::SeqCst);
            *guard = Some(client);
        }
        Ok(guard)
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
    tiberius.application_name("prodb");
    if config.encrypt {
        tiberius.encryption(EncryptionLevel::Required);
        tiberius.trust_cert();
    } else {
        tiberius.encryption(EncryptionLevel::NotSupported);
    }
    tiberius
}

fn mssql_err(err: tiberius::error::Error) -> EngineError {
    EngineError::Mssql(err.to_string())
}

async fn open_client(config: &Config) -> Result<MssqlClient, EngineError> {
    let tcp = TcpStream::connect(config.get_addr())
        .await
        .map_err(|err| EngineError::Mssql(format!("SQL Server 연결 실패: {err}")))?;
    let _ = tcp.set_nodelay(true);
    Client::connect(config.clone(), tcp.compat_write())
        .await
        .map_err(|err| EngineError::Mssql(format!("SQL Server 연결 실패: {err}")))
}

async fn read_spid(client: &mut MssqlClient) -> Result<i32, EngineError> {
    let row = client
        .query("SELECT @@SPID", &[])
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
) -> Result<&'a mut MssqlClient, EngineError> {
    guard
        .as_mut()
        .ok_or_else(|| EngineError::Internal("SQL Server 연결이 준비되지 않았습니다".into()))
}

const CONNECT_INFO_SQL: &str = "SELECT @@SPID, DB_NAME(), ISNULL(SCHEMA_NAME(), 'dbo')";

const TABLE_LIST_SQL: &str = "SELECT s.name, t.name
     FROM sys.tables t
     JOIN sys.schemas s ON s.schema_id = t.schema_id
     ORDER BY s.name, t.name";

const COLUMN_SQL: &str = "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.CHARACTER_MAXIMUM_LENGTH,
            c.NUMERIC_PRECISION, c.NUMERIC_SCALE, c.IS_NULLABLE,
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

pub(crate) async fn connect(config: &MssqlConfig) -> Result<Arc<MssqlInner>, EngineError> {
    let tiberius_config = build_config(config);
    let mut client = open_client(&tiberius_config).await?;
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
        cancel_requested: AtomicBool::new(false),
        session_dead: AtomicBool::new(false),
    }))
}

pub(crate) async fn meta(inner: &MssqlInner) -> Result<EngineMeta, EngineError> {
    let mut guard = inner.client().await?;
    let client = take_client(&mut guard)?;
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
    })
}

pub(crate) async fn schema(inner: &MssqlInner) -> Result<Vec<TableSchema>, EngineError> {
    let mut guard = inner.client().await?;
    let client = take_client(&mut guard)?;
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
                let pk = cd_i64(values.get(6)).map(|value| value != 0).unwrap_or(false);
                ColumnSchema {
                    name,
                    decl_type: Some(decl_type(&data_type, max_len, precision, scale)),
                    not_null,
                    pk,
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

pub(crate) async fn query(
    inner: &MssqlInner,
    sql: &str,
    max_rows: usize,
) -> Result<QueryData, EngineError> {
    let started = Instant::now();
    let mut guard = inner.client().await?;
    let client = take_client(&mut guard)?;
    let mut columns: Vec<String> = Vec::new();
    let mut column_values: Vec<Vec<Value>> = Vec::new();
    let mut count = 0usize;
    let mut truncated = false;

    let outcome: Result<(), EngineError> = async {
        let mut stream = client.query(sql, &[]).await.map_err(mssql_err)?;
        while let Some(item) = stream.next().await {
            match item.map_err(mssql_err)? {
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

    if inner.take_cancelled() {
        if let Err(err) = outcome {
            return Err(EngineError::Mssql(format!(
                "KILL 요청으로 쿼리가 취소되었습니다: {err}"
            )));
        }
    } else if let Err(err) = outcome {
        return Err(err);
    }

    let (source_table, pk) = detect_source(inner, client, sql, &columns).await;
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
    })
}

pub(crate) async fn edit(inner: &MssqlInner, target: &EditTarget) -> Result<u64, EngineError> {
    if target.pk.is_empty() {
        return Err(EngineError::NotEditable(
            "기본 키가 없어 편집할 수 없습니다".into(),
        ));
    }
    let mut guard = inner.client().await?;
    let client = take_client(&mut guard)?;
    let (schema_part, table) = split_display_table(&target.table);
    let schema = schema_part.unwrap_or_else(|| inner.default_schema.clone());
    let table_ref = qualified(&inner.database, &schema, &table);
    let column_type = column_type_of(client, &schema, &table, &target.column).await?;
    let cast = cast_type(&column_type);

    let mut sql = format!(
        "UPDATE {table_ref} SET {} = CAST(@P1 AS {cast}) WHERE ",
        quote_ident(&target.column)
    );
    let mut params: Vec<Option<String>> = vec![target.value.clone()];
    for (index, pk) in target.pk.iter().enumerate() {
        if index > 0 {
            sql.push_str(" AND ");
        }
        let pk_type = column_type_of(client, &schema, &table, &pk.column).await?;
        let pk_cast = cast_type(&pk_type);
        let position = index + 2;
        let quoted = quote_ident(&pk.column);
        sql.push_str(&format!(
            "({quoted} = CAST(@P{position} AS {pk_cast}) \
             OR ({quoted} IS NULL AND @P{position} IS NULL))"
        ));
        params.push(pk_value_string(&pk.value));
    }

    let refs: Vec<&dyn ToSql> = params.iter().map(|param| param as &dyn ToSql).collect();
    let result = client.execute(sql, &refs).await.map_err(mssql_err)?;
    Ok(result.total())
}

pub(crate) async fn tx(inner: &MssqlInner, statement: &str) -> Result<(), EngineError> {
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
    let mut guard = inner.client().await?;
    let client = take_client(&mut guard)?;
    match statement {
        "BEGIN" => client.begin_transaction().await.map_err(mssql_err)?,
        "COMMIT" => client.commit_transaction().await.map_err(mssql_err)?,
        "ROLLBACK" => client.rollback_transaction().await.map_err(mssql_err)?,
        _ => {}
    }
    drop(guard);
    inner.in_tx.store(statement == "BEGIN", Ordering::SeqCst);
    Ok(())
}

async fn column_type_of(
    client: &mut MssqlClient,
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

async fn detect_source(
    inner: &MssqlInner,
    client: &mut MssqlClient,
    sql: &str,
    columns: &[String],
) -> (Option<String>, Option<Vec<String>>) {
    let Some((schema_part, table_part)) = parse_single_table(sql) else {
        return (None, None);
    };
    let schema = schema_part.unwrap_or_else(|| inner.default_schema.clone());

    let lookup = match client
        .query(
            TABLE_LOOKUP_SQL,
            &[&schema as &dyn ToSql, &table_part as &dyn ToSql],
        )
        .await
    {
        Ok(stream) => match stream.into_first_result().await {
            Ok(rows) => rows.first().and_then(|row| {
                let schema: Option<&str> = row.get(0);
                let table: Option<&str> = row.get(1);
                match (schema, table) {
                    (Some(schema), Some(table)) => Some((schema.to_string(), table.to_string())),
                    _ => None,
                }
            }),
            Err(_) => None,
        },
        Err(_) => None,
    };
    let Some((canonical_schema, canonical_table)) = lookup else {
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
        ColumnData::F32(value) => value
            .map(|number| Value::from(f64::from(number)))
            .unwrap_or(Value::Null),
        ColumnData::F64(value) => value.map(Value::from).unwrap_or(Value::Null),
        ColumnData::Bit(value) => value.map(Value::Bool).unwrap_or(Value::Null),
        ColumnData::String(value) => value
            .map(|text| Value::from(text.into_owned()))
            .unwrap_or(Value::Null),
        ColumnData::Guid(value) => value
            .map(|guid| Value::from(guid.to_string()))
            .unwrap_or(Value::Null),
        ColumnData::Binary(value) => value
            .map(|bytes| Value::from(format!("<blob {} bytes>", bytes.len())))
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
