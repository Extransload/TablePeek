//! Work over a whole table done in steps the page follows: an exact count
//! split into token ranges counted several at once, a walk past rows to a
//! far page without sending them to the page, and the row estimate sampled
//! from the token ring.
//!
//! Keys' tokens (Murmur3Partitioner) are 64-bit numbers over the whole
//! ring, and every key's token lies in (i64::MIN, i64::MAX]: ranges
//! `token(pk) > lo AND token(pk) <= hi` that tile it count every row once.

use std::ops::ControlFlow;
use std::time::{Duration, Instant};

use futures_util::future::{join_all, BoxFuture};
use scylla::errors::{DbError, ExecutionError, RequestAttemptError};
use scylla::response::PagingState;
use scylla::value::{CqlValue, MaybeUnset, Row};
use serde_json::Value;

use super::schema::{self, ColumnKind, TableInfo};
use super::{cql, decode_page, encode_page, values, CassandraDriver, PAGE_CAP};
use crate::driver::{CountStep, SkipOutcome, SkipRequest};
use crate::sql_log::Dialect;
use crate::{EngineError, QueryData};

/// Writes a table copy sends at once: enough to keep a node busy without
/// swamping a small one (the 1.2 GB test container).
const COPY_PARALLEL: usize = 16;

/// The ring's width: 2^64 tokens.
const RING: i128 = 1 << 64;
/// Ranges counted at once. Each is a range scan on the replicas; more at
/// once filled a small node's heap.
const PARALLEL: u32 = 8;
/// The most ranges a count is split into, and about how many rows one
/// range should hold.
const MAX_PARTS: u32 = 4096;
const ROWS_PER_PART: f64 = 50_000.0;
/// Parts when the table's size can't be sampled.
const UNKNOWN_PARTS: u32 = 64;
/// A range whose count times out is counted again as this many smaller
/// ones, at most this many times over.
const SPLIT: i128 = 8;
const SPLIT_DEPTH: u32 = 3;
/// Partitions the estimate reads from each quarter of the ring.
const SAMPLE: usize = 256;
/// How long one of the estimate's reads may take.
const ESTIMATE_TIMEOUT: Duration = Duration::from_secs(10);

/// Range `part` of the ring cut into `parts` equal ones: (lo, hi].
fn bounds(part: u32, parts: u32) -> (i64, i64) {
    let width = RING / i128::from(parts);
    let lo = i128::from(i64::MIN) + width * i128::from(part);
    let hi = if part + 1 == parts {
        i128::from(i64::MAX)
    } else {
        lo + width
    };
    (lo as i64, hi as i64)
}

/// `token("a", "b")` over a table's partition key.
fn token_call(info: &TableInfo) -> Option<String> {
    let columns: Vec<String> = info
        .partition_columns()
        .map(|column| values::quote_name(&column.name))
        .collect();
    (!columns.is_empty()).then(|| format!("token({})", columns.join(", ")))
}

/// A wait the server gave up on (its read timeout, or the driver's): a
/// smaller range may make it.
fn timed_out(err: &ExecutionError) -> bool {
    matches!(
        err,
        ExecutionError::RequestTimeout(_)
            | ExecutionError::LastAttemptError(RequestAttemptError::DbError(
                DbError::ReadTimeout { .. } | DbError::ReadFailure { .. },
                _
            ))
    )
}

/// The first column of a result's first row, as a number (COUNT's bigint).
fn first_number(
    driver: &CassandraDriver,
    result: scylla::response::query_result::QueryResult,
) -> Result<i64, EngineError> {
    let rows = result
        .into_rows_result()
        .map_err(|err| driver.internal(err))?;
    let first = rows
        .rows::<Row>()
        .map_err(|err| driver.internal(err))?
        .next()
        .transpose()
        .map_err(|err| driver.internal(err))?;
    Ok(first
        .and_then(|row| row.columns.into_iter().next().flatten())
        .and_then(|value| values::counter_of(&value))
        .unwrap_or_default())
}

/// A `SELECT COUNT(*)` run as one statement.
pub(super) async fn single_count(
    driver: &CassandraDriver,
    cql: &str,
    timeout: Duration,
) -> Result<i64, EngineError> {
    driver.log.record(cql, Dialect::Cql);
    let statement = driver.statement(cql, PAGE_CAP, timeout);
    let (result, _) = driver
        .cancellable(
            driver
                .session
                .query_single_page(statement, &[], PagingState::start()),
        )
        .await?;
    first_number(driver, result)
}

/// The statement that counts one range of a count, with its range filled
/// in.
struct RangeCount {
    /// `SELECT COUNT(*) FROM t WHERE`
    head: String,
    token: String,
    /// ` AND <the count's own conditions>[ ALLOW FILTERING]`
    tail: String,
}

impl RangeCount {
    fn cql(&self, lo: i64, hi: i64) -> String {
        format!(
            "{} {token} > {lo} AND {token} <= {hi}{}",
            self.head,
            self.tail,
            token = self.token
        )
    }
}

/// The rows in (lo, hi]; a range the server times out on is counted again
/// in smaller ranges.
fn count_range<'a>(
    driver: &'a CassandraDriver,
    template: &'a RangeCount,
    lo: i64,
    hi: i64,
    depth: u32,
) -> BoxFuture<'a, Result<i64, ExecutionError>> {
    Box::pin(async move {
        let statement = driver.statement(&template.cql(lo, hi), PAGE_CAP, driver.page_timeout());
        match driver
            .session
            .query_single_page(statement, &[], PagingState::start())
            .await
        {
            Ok((result, _)) => Ok(result
                .into_rows_result()
                .ok()
                .and_then(|rows| {
                    rows.rows::<Row>()
                        .ok()?
                        .next()?
                        .ok()?
                        .columns
                        .into_iter()
                        .next()
                        .flatten()
                })
                .and_then(|value| values::counter_of(&value))
                .unwrap_or_default()),
            Err(err)
                if timed_out(&err)
                    && depth < SPLIT_DEPTH
                    && i128::from(hi) - i128::from(lo) > SPLIT =>
            {
                let width = (i128::from(hi) - i128::from(lo)) / SPLIT;
                let parts = (0..SPLIT).map(|index| {
                    let start = i128::from(lo) + width * index;
                    let end = if index + 1 == SPLIT {
                        i128::from(hi)
                    } else {
                        start + width
                    };
                    count_range(driver, template, start as i64, end as i64, depth + 1)
                });
                join_all(parts).await.into_iter().sum()
            }
            Err(err) => Err(err),
        }
    })
}

/// Where a count in ranges goes on: `parts:next`.
fn parse_cursor(cursor: &str) -> Option<(u32, u32)> {
    let (parts, next) = cursor.split_once(':')?;
    let parts: u32 = parts.parse().ok()?;
    let next: u32 = next.parse().ok()?;
    (parts > 0 && parts <= MAX_PARTS && next <= parts).then_some((parts, next))
}

/// How many ranges a table's count is split into: about ROWS_PER_PART
/// rows each, by its sampled size.
async fn parts_for(driver: &CassandraDriver, info: &TableInfo) -> u32 {
    match estimate_rows(driver, info).await {
        Some(rows) => {
            let wanted = (rows as f64 / ROWS_PER_PART).ceil().max(1.0) as u32;
            wanted.next_power_of_two().min(MAX_PARTS)
        }
        None => UNKNOWN_PARTS,
    }
}

/// One step of an exact count: on a table whose keys spread over the token
/// ring, a few waves of PARALLEL token ranges counted at once until
/// `budget` has passed; anything else (a count restricting the partition
/// key, a table too small to split) as one statement.
pub(super) async fn count_step(
    driver: &CassandraDriver,
    sql: &str,
    cursor: Option<&str>,
    budget: Duration,
) -> Result<CountStep, EngineError> {
    let statements = cql::split(sql);
    let [statement] = statements.as_slice() else {
        return Err(EngineError::BadRequest(
            "행 수는 SELECT COUNT(*) 문 하나로 셉니다".into(),
        ));
    };
    let whole = || async {
        let rows = single_count(
            driver,
            statement,
            driver.page_timeout().max(Duration::from_secs(120)),
        )
        .await?;
        Ok::<_, EngineError>(CountStep {
            rows,
            cursor: None,
            done: 1.0,
        })
    };
    let Some(shape) = cql::count_shape(statement) else {
        return whole().await;
    };
    let Some(keyspace) = shape.keyspace.clone().or_else(|| driver.keyspace()) else {
        return whole().await;
    };
    if !driver.product.token_ring {
        return whole().await;
    }
    let Ok(info) = driver.table_info(&keyspace, &shape.table).await else {
        return whole().await;
    };
    let partition: Vec<&str> = info
        .partition_columns()
        .map(|column| column.name.as_str())
        .collect();
    let Some(token) = token_call(&info) else {
        return whole().await;
    };
    if shape
        .condition
        .is_some_and(|condition| cql::restricts(condition, &partition))
    {
        // One partition (or a few) named by its key: no range to split.
        return whole().await;
    }
    let (parts, mut next) = match cursor {
        Some(cursor) => parse_cursor(cursor).ok_or_else(|| {
            EngineError::BadRequest("행 수 세기의 이어 셀 자리가 올바르지 않습니다".into())
        })?,
        None => (parts_for(driver, &info).await, 0),
    };
    if parts <= 1 {
        return whole().await;
    }
    let template = RangeCount {
        head: format!("SELECT COUNT(*) FROM {} WHERE", shape.name),
        token,
        tail: format!(
            "{}{}",
            shape
                .condition
                .map(|condition| format!(" AND {condition}"))
                .unwrap_or_default(),
            if shape.allow_filtering {
                " ALLOW FILTERING"
            } else {
                ""
            }
        ),
    };
    let first = next;
    let started = Instant::now();
    let mut rows = 0i64;
    while next < parts {
        let end = (next + PARALLEL).min(parts);
        let wave = driver
            .cancellable(async {
                join_all((next..end).map(|part| {
                    let (lo, hi) = bounds(part, parts);
                    count_range(driver, &template, lo, hi, 0)
                }))
                .await
                .into_iter()
                .sum::<Result<i64, ExecutionError>>()
            })
            .await;
        match wave {
            Ok(counted) => rows += counted,
            // A condition the server won't take beside a token range (an
            // index it can't scan by range): counted whole instead.
            Err(EngineError::Driver {
                code: Some(code), ..
            }) if first == 0 && next == 0 && (code == "2200" || code == "2000") => {
                return whole().await;
            }
            // The node is overloaded or timing out under PARALLEL scans:
            // the same ranges once more, one at a time.
            Err(EngineError::Driver {
                code: Some(code), ..
            }) if matches!(code.as_str(), "1001" | "1100" | "1200" | "1300") => {
                for part in next..end {
                    let (lo, hi) = bounds(part, parts);
                    rows += driver
                        .cancellable(count_range(driver, &template, lo, hi, 0))
                        .await?;
                }
            }
            Err(err) => return Err(err),
        }
        next = end;
        if started.elapsed() >= budget {
            break;
        }
    }
    if next > first {
        driver.log.record_command(&format!(
            "-- {} · 토큰 범위 {}–{} / {parts} ({PARALLEL}개씩 동시에): {rows}행",
            template.cql(bounds(first, parts).0, bounds(next - 1, parts).1),
            first + 1,
            next
        ));
    }
    Ok(CountStep {
        rows,
        cursor: (next < parts).then(|| format!("{parts}:{next}")),
        done: f64::from(next) / f64::from(parts),
    })
}

/// Walks a SELECT's rows from a token, a page of up to PAGE_CAP rows at a
/// time, counting them without reading them, until `skip.rows` are passed,
/// the rows end or `budget` has passed. Pages end on multiples of
/// `skip.mark_every` (counted from the statement's first row) where they
/// can, and the token there is noted for later jumps.
pub(super) async fn skip_rows(
    driver: &CassandraDriver,
    sql: &str,
    skip: &SkipRequest,
    budget: Duration,
) -> Result<SkipOutcome, EngineError> {
    let statements = cql::split(sql);
    let [statement] = statements.as_slice() else {
        return Err(EngineError::BadRequest(
            "페이지는 SELECT 문 하나에서만 건너뜁니다".into(),
        ));
    };
    if cql::first_word(statement).as_deref() != Some("SELECT") {
        return Err(EngineError::BadRequest(
            "페이지는 SELECT 문 하나에서만 건너뜁니다".into(),
        ));
    }
    if skip.rows == 0 {
        return Err(EngineError::BadRequest("건너뛸 행 수가 0입니다".into()));
    }
    let started = Instant::now();
    let mut state = match &skip.page {
        Some(token) => decode_page(token)?,
        None => PagingState::start(),
    };
    let every = skip.mark_every.max(1);
    let mut skipped = 0usize;
    let mut marks = Vec::new();
    let mut requests = 0usize;
    let end = loop {
        if skipped >= skip.rows {
            break Some(encode_page(&state));
        }
        let at = skip.offset + skipped;
        // Up to the next multiple of `every`, and as many whole pages of
        // it after that as fit in PAGE_CAP.
        let to_mark = every - at % every;
        let size = if to_mark >= PAGE_CAP {
            PAGE_CAP
        } else {
            to_mark + (PAGE_CAP - to_mark) / every * every
        };
        let mut size = size.min(skip.rows - skipped).max(1);
        // Cut short by the target: stop first at the last multiple of
        // `every` before it, so the page the jump lands near has a token.
        let end = at + size;
        let aligned = end - end % every;
        if !end.is_multiple_of(every) && aligned > at {
            size = aligned - at;
        }
        let page = driver.statement(statement, size, driver.page_timeout());
        let (result, response) = driver
            .cancellable(driver.session.query_single_page(page, &[], state))
            .await?;
        requests += 1;
        if result.is_rows() {
            skipped += result
                .into_rows_result()
                .map_err(|err| driver.internal(err))?
                .rows_num();
        }
        match response.into_paging_control_flow() {
            ControlFlow::Break(()) => break None,
            ControlFlow::Continue(next) => {
                if (skip.offset + skipped).is_multiple_of(every) {
                    marks.push((skip.offset + skipped, encode_page(&next)));
                }
                state = next;
            }
        }
        if started.elapsed() >= budget {
            break Some(encode_page(&state));
        }
    };
    driver.log.record_command(&format!(
        "-- {statement} · {}행째부터 {skipped}행을 건너뜀 (페이지 {requests}번, 화면으로 보내지 않음)",
        skip.offset + 1
    ));
    Ok(SkipOutcome {
        page: end,
        skipped,
        marks,
    })
}

/// Every row of a read, all its pages, unlogged (the estimate's samples).
async fn sample_rows(driver: &CassandraDriver, cql: &str) -> Result<Vec<Row>, EngineError> {
    let mut rows = Vec::new();
    let mut state = PagingState::start();
    loop {
        let statement = driver.statement(cql, SAMPLE, ESTIMATE_TIMEOUT);
        let (result, response) = driver
            .cancellable(driver.session.query_single_page(statement, &[], state))
            .await?;
        if result.is_rows() {
            let result = result
                .into_rows_result()
                .map_err(|err| driver.internal(err))?;
            for row in result.rows::<Row>().map_err(|err| driver.internal(err))? {
                rows.push(row.map_err(|err| driver.internal(err))?);
            }
        }
        match response.into_paging_control_flow() {
            ControlFlow::Break(()) => return Ok(rows),
            ControlFlow::Continue(next) => state = next,
        }
    }
}

/// About how many rows a table holds, sampled from its token ring: the
/// first SAMPLE partitions of each quarter of the ring give the density of
/// partitions (all of them where a quarter has fewer), and COUNT(*) of a
/// few of those partitions gives the rows a partition holds. Up to date
/// with what was just written, unlike the server's size estimates (which
/// wait for a flush). None where the keys' tokens aren't 64-bit numbers or
/// the samples can't be read.
pub(super) async fn estimate_rows(driver: &CassandraDriver, info: &TableInfo) -> Option<i64> {
    if !driver.product.token_ring {
        return None;
    }
    let token = token_call(info)?;
    const QUARTERS: u32 = 4;
    let samples = join_all((0..QUARTERS).map(|quarter| {
        let (lo, hi) = bounds(quarter, QUARTERS);
        let cql = format!(
            "SELECT {token} FROM {} WHERE {token} > {lo} AND {token} <= {hi} PER PARTITION LIMIT 1 LIMIT {SAMPLE}",
            info.quoted()
        );
        async move { sample_rows(driver, &cql).await }
    }))
    .await;
    let mut partitions = 0f64;
    let mut picked: Vec<i64> = Vec::new();
    for (quarter, sample) in (0u32..).zip(samples) {
        let tokens: Vec<i64> = sample
            .ok()?
            .into_iter()
            .filter_map(|row| match row.columns.into_iter().next().flatten() {
                Some(scylla::value::CqlValue::BigInt(token)) => Some(token),
                _ => None,
            })
            .collect();
        let (lo, hi) = bounds(quarter, QUARTERS);
        match tokens.last() {
            Some(last) if tokens.len() >= SAMPLE => {
                let span = (i128::from(*last) - i128::from(lo)).max(1);
                partitions +=
                    SAMPLE as f64 * (i128::from(hi) - i128::from(lo)) as f64 / span as f64;
            }
            _ => partitions += tokens.len() as f64,
        }
        let stride = (tokens.len() / 4).max(1);
        picked.extend(tokens.iter().step_by(stride).take(4).copied());
    }
    let clustered = info
        .columns
        .iter()
        .any(|column| column.kind == ColumnKind::Clustering);
    let per_partition = if clustered && !picked.is_empty() {
        let counts = join_all(picked.iter().map(|token_value| {
            let cql = format!(
                "SELECT COUNT(*) FROM {} WHERE {token} = {token_value}",
                info.quoted()
            );
            async move {
                let statement = driver.statement(&cql, PAGE_CAP, ESTIMATE_TIMEOUT);
                let (result, _) = driver
                    .cancellable(driver.session.query_single_page(
                        statement,
                        &[],
                        PagingState::start(),
                    ))
                    .await?;
                first_number(driver, result)
            }
        }))
        .await;
        let counted: Vec<i64> = counts.into_iter().filter_map(Result::ok).collect();
        if counted.is_empty() {
            1.0
        } else {
            counted.iter().sum::<i64>() as f64 / counted.len() as f64
        }
    } else {
        1.0
    };
    let rows = (partitions * per_partition).round() as i64;
    driver.log.record_command(&format!(
        "-- {} 행 수 추정: 파티션 약 {} × 파티션당 약 {per_partition:.1}행 (토큰 링 표본)",
        info.quoted(),
        partitions.round() as i64
    ));
    Some(rows)
}

/// TablePeek's `CREATE TABLE new AS SELECT * FROM old`, which CQL lacks:
/// the new table gets the old one's columns, key, clustering order and
/// options, then every row, read a page at a time and written COPY_PARALLEL
/// at once (a counter table's by adding each counter). Answers how many
/// rows were copied. Write times and TTLs are the copy's own.
pub(super) async fn copy_table(
    driver: &CassandraDriver,
    target: (Option<String>, String),
    source: (Option<String>, String),
) -> Result<QueryData, EngineError> {
    let keyspace_of = |name: Option<String>, table: &str| {
        name.or_else(|| driver.keyspace()).ok_or_else(|| {
            EngineError::BadRequest(format!(
                "키스페이스를 고르지 않은 연결입니다. {table} 대신 키스페이스.{table} 으로 쓰세요"
            ))
        })
    };
    let source_keyspace = keyspace_of(source.0, &source.1)?;
    let target_keyspace = keyspace_of(target.0, &target.1)?;
    let info = driver.table_info(&source_keyspace, &source.1).await?;
    let (properties, _) =
        schema::properties(driver, &source_keyspace, &source.1, info.view).await?;
    // Options a new table can't take as they are (a view's base, the
    // server's own extensions) stay behind.
    let properties: Vec<_> = properties
        .into_iter()
        .filter(|property| property.name != "extensions")
        .collect();
    let mut copy = (*info).clone();
    copy.keyspace = target_keyspace;
    copy.name = target.1;
    copy.view = false;
    let ddl = schema::create_table(&copy, &properties);
    driver
        .read(ddl.trim_end_matches(';'), 1, None, false)
        .await?;
    let names: Vec<String> = info
        .columns
        .iter()
        .map(|column| values::quote_name(&column.name))
        .collect();
    let read = format!("SELECT {} FROM {}", names.join(", "), info.quoted());
    // The values each write binds, by where the column is in `read`.
    let (write, order): (String, Vec<usize>) = if info.counter() {
        let mut sets = Vec::new();
        let mut keys = Vec::new();
        let mut order = Vec::new();
        for (index, column) in info.columns.iter().enumerate() {
            if !column.kind.is_key() {
                let name = values::quote_name(&column.name);
                sets.push(format!("{name} = {name} + ?"));
                order.push(index);
            }
        }
        for (index, column) in info.columns.iter().enumerate() {
            if column.kind.is_key() {
                keys.push(format!("{} = ?", values::quote_name(&column.name)));
                order.push(index);
            }
        }
        (
            format!(
                "UPDATE {} SET {} WHERE {}",
                copy.quoted(),
                sets.join(", "),
                keys.join(" AND ")
            ),
            order,
        )
    } else {
        (
            format!(
                "INSERT INTO {} ({}) VALUES ({})",
                copy.quoted(),
                names.join(", "),
                vec!["?"; names.len()].join(", ")
            ),
            (0..names.len()).collect(),
        )
    };
    driver.log.record(&read, Dialect::Cql);
    driver.log.record(&write, Dialect::Cql);
    let mut prepared = driver
        .cancellable(async {
            driver
                .session
                .prepare(write.as_str())
                .await
                .map_err(ExecutionError::from)
        })
        .await?;
    prepared.set_consistency(*super::lock(&driver.consistency));
    prepared.set_request_timeout(Some(driver.page_timeout()));
    let mut state = PagingState::start();
    let mut copied = 0i64;
    loop {
        let statement = driver.statement(&read, PAGE_CAP, driver.page_timeout());
        let (result, response) = driver
            .cancellable(driver.session.query_single_page(statement, &[], state))
            .await?;
        let mut rows = Vec::new();
        if result.is_rows() {
            let result = result
                .into_rows_result()
                .map_err(|err| driver.internal(err))?;
            for row in result.rows::<Row>().map_err(|err| driver.internal(err))? {
                rows.push(row.map_err(|err| driver.internal(err))?);
            }
        }
        for wave in rows.chunks(COPY_PARALLEL) {
            let writes = wave.iter().map(|row| {
                let bound: Vec<MaybeUnset<CqlValue>> = order
                    .iter()
                    .map(|index| match row.columns.get(*index).cloned().flatten() {
                        Some(value) => MaybeUnset::Set(value),
                        None => MaybeUnset::Unset,
                    })
                    .collect();
                let prepared = &prepared;
                async move { driver.session.execute_unpaged(prepared, bound).await }
            });
            driver
                .cancellable(async {
                    join_all(writes)
                        .await
                        .into_iter()
                        .collect::<Result<Vec<_>, ExecutionError>>()
                })
                .await?;
            copied += wave.len() as i64;
        }
        match response.into_paging_control_flow() {
            ControlFlow::Break(()) => break,
            ControlFlow::Continue(next) => state = next,
        }
    }
    driver.log.record_command(&format!(
        "-- {} → {}: {copied}행 복사",
        info.quoted(),
        copy.quoted()
    ));
    driver.answer(&["copied"], vec![Value::from(copied)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_tile_the_ring() {
        for parts in [1u32, 2, 3, 16, 4096] {
            let mut previous = i64::MIN;
            for part in 0..parts {
                let (lo, hi) = bounds(part, parts);
                assert_eq!(lo, previous, "{parts}:{part}");
                assert!(hi > lo);
                previous = hi;
            }
            assert_eq!(previous, i64::MAX);
        }
        assert_eq!(parse_cursor("64:10"), Some((64, 10)));
        assert_eq!(parse_cursor("64:65"), None);
        assert_eq!(parse_cursor("x"), None);
    }
}
