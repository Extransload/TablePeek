//! The session an Oracle connection works through. The driver is
//! synchronous, so each call runs on a blocking thread while the async side
//! waits; one call at a time, under `session`'s lock.
//!
//! A cancel stops the statement and keeps the session and its transaction,
//! as sqlplus's Ctrl-C does: the server rolls back the statement alone and
//! the call fails with ORA-01013. It goes the first way this session can:
//! 1. An out-of-band break (TCP urgent data) on the session's own
//!    connection, which needs no privilege. The server must take them (its
//!    accept says so and the check after it passes): not over a tunnel or a
//!    proxy that drops urgent data, nor a server with DISABLE_OOB=ON.
//! 2. `ALTER SYSTEM CANCEL SQL 'sid,serial#'` over a session of its own,
//!    with the ALTER SYSTEM privilege.
//! 3. Otherwise, or if the call still runs a few seconds later, the session
//!    is ended (`ALTER SYSTEM KILL SESSION … IMMEDIATE` where allowed) and
//!    given up: the waiting call returns at once, the thread finishes on its
//!    own and its session closes, and the next call opens a new session; the
//!    transaction is lost (`cancel_ends_session` says when this is the only
//!    way).

use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use oracledb::{BreakHandle, Connection, ErrorKind, Row, ToDbValue};
use tablepeek_types::ErrorFields;
use tokio::sync::Notify;

use super::Settings;
use crate::driver::TxOp;
use crate::source_cache::SourceCache;
use crate::sql_log::{inline_params, Change, Dialect, LogParam, SqlLog};
use crate::{char_offset, EngineError};

/// A SELECT's table as its display name and primary key columns; None when
/// the catalog has no such table.
pub(super) type Source = Option<(String, Vec<String>)>;

pub(super) const CANCELLED: &str = "쿼리 취소로 세션을 다시 열어 트랜잭션이 롤백되었습니다";
const CONNECTION_LOST: &str = "연결이 끊겨 트랜잭션이 롤백되었습니다";

/// One server session.
pub(super) struct Session {
    pub(super) conn: Connection,
    sid: u64,
    serial: u64,
    /// Breaks a call out of band; None where the connection can't.
    breaker: Option<BreakHandle>,
}

/// The statement running now: whose session, how to break it, how to give
/// up on it, and when it has ended.
struct Running {
    sid: u64,
    serial: u64,
    breaker: Option<BreakHandle>,
    abandon: Arc<Notify>,
    ended: tokio::sync::watch::Receiver<bool>,
}

pub(crate) struct OracleInner {
    settings: Arc<Settings>,
    session: tokio::sync::Mutex<Option<Arc<Session>>>,
    running: Mutex<Option<Running>>,
    pub(super) label: String,
    in_tx: AtomicBool,
    // A transaction was open when its session went (a cancel that dropped
    // it, a lost connection): the next COMMIT reports the rollback.
    tx_lost: Mutex<Option<&'static str>>,
    cancel_requested: AtomicBool,
    // How the session open now can stop a statement and keep itself: an
    // out-of-band break, and ALTER SYSTEM CANCEL SQL (the privilege).
    out_of_band: AtomicBool,
    cancel_sql: AtomicBool,
    // The page's query time limit in seconds, 0 for none.
    query_timeout: AtomicU64,
    // The user who logged in and the schema bare names resolve in (ALTER
    // SESSION SET CURRENT_SCHEMA moves it), as of the last check.
    user: Mutex<String>,
    schema: Mutex<String>,
    // By (owner, table) as the SELECT named them.
    pub(super) sources: SourceCache<(String, String), Source>,
    pub(super) ddl: super::catalog::DdlCache,
    pub(super) log: SqlLog,
}

/// What a blocking call works with: the session, and the log every
/// statement goes to before it is sent.
pub(super) struct Ctx<'a> {
    pub(super) conn: &'a Connection,
    pub(super) log: &'a SqlLog,
}

impl Ctx<'_> {
    /// The statement as the console shows it, bound values written in.
    pub(super) fn shown(sql: &str, params: &[LogParam]) -> String {
        if params.is_empty() {
            sql.to_string()
        } else {
            inline_params(sql, params, Dialect::Oracle)
        }
    }

    /// Every row of a catalog read.
    pub(super) fn rows(
        &self,
        sql: &str,
        params: &[&dyn ToDbValue],
        shown: &[LogParam],
    ) -> Result<Vec<Row>, oracledb::Error> {
        self.log.record(&Self::shown(sql, shown), Dialect::Oracle);
        self.conn.query(sql, params)?.collect()
    }

    /// Catalog rows read with text binds, logged with them.
    pub(super) fn rows_with(&self, sql: &str, binds: &[&str]) -> Result<Vec<Row>, EngineError> {
        let params: Vec<&dyn ToDbValue> = binds.iter().map(|bind| bind as &dyn ToDbValue).collect();
        let shown: Vec<LogParam> = binds
            .iter()
            .map(|bind| LogParam::Text((*bind).to_string()))
            .collect();
        self.rows(sql, &params, &shown)
            .map_err(|err| ora_err(err, None))
    }

    /// Runs a statement that returns no rows.
    pub(super) fn execute(
        &self,
        sql: &str,
        params: &[&dyn ToDbValue],
        shown: &[LogParam],
    ) -> Result<oracledb::ExecResult, oracledb::Error> {
        self.log.record(&Self::shown(sql, shown), Dialect::Oracle);
        self.conn.execute(sql, params)
    }

    /// Runs a data change made from the GUI; one that changed rows goes to
    /// History, at COMMIT when `in_tx`. `counted`: a PL/SQL block that
    /// returns SQL%ROWCOUNT through its last (out) bind.
    pub(super) fn change(
        &self,
        sql: &str,
        params: &[&dyn ToDbValue],
        shown: &[LogParam],
        in_tx: bool,
        counted: bool,
    ) -> Result<u64, oracledb::Error> {
        let text = Self::shown(sql, shown);
        self.log.record(&text, Dialect::Oracle);
        let started = Instant::now();
        let mut result = self.conn.execute(sql, params)?;
        let changed = if counted {
            result.out_bind_data().get::<Option<u64>>(0)?.unwrap_or(0)
        } else {
            result.rows_affected()
        };
        if changed > 0 {
            let change = Change {
                sql: text,
                ms: started.elapsed().as_millis() as u64,
                rows: changed,
            };
            self.log.changed(change, in_tx);
        }
        Ok(changed)
    }

    /// COMMIT outside a transaction of the user's: what each statement does
    /// when no transaction was begun, as other engines autocommit.
    pub(super) fn autocommit(&self) -> Result<(), oracledb::Error> {
        self.log.record("COMMIT", Dialect::Oracle);
        self.conn.commit()
    }
}

/// Text of a column, or None for NULL.
pub(super) fn text(row: &Row, index: usize) -> Option<String> {
    row.get::<Option<String>>(index).ok().flatten()
}

/// A number column as i64, or None for NULL or a fraction.
pub(super) fn int(row: &Row, index: usize) -> Option<i64> {
    row.get::<Option<i64>>(index).ok().flatten()
}

/// A CLOB read whole, whether the driver gave it as text or as a locator.
pub(super) fn clob(row: &mut Row, index: usize) -> Option<String> {
    if let Ok(found) = row.get::<Option<String>>(index) {
        return found;
    }
    let mut lob = row.take::<Option<oracledb::Lob>>(index).ok().flatten()?;
    let mut out = String::new();
    lob.read_to_string(&mut out).ok()?;
    Some(out)
}

/// Lets a session go on a blocking thread: closing it is a round trip to the
/// server, which must not hold an async thread (through a tunnel, the
/// thread that would carry it).
fn close_later(session: Option<Arc<Session>>) {
    if let (Some(session), Ok(runtime)) = (session, tokio::runtime::Handle::try_current()) {
        runtime.spawn_blocking(move || drop(session));
    }
}

/// How long a stopped call has to come back before the next way is tried.
const CANCEL_GRACE: Duration = Duration::from_secs(5);

/// Whether the call `ended` watches has ended, or does within CANCEL_GRACE.
async fn ends_soon(ended: &mut tokio::sync::watch::Receiver<bool>) -> bool {
    // A closed channel means the call's run is over too.
    tokio::time::timeout(CANCEL_GRACE, ended.wait_for(|done| *done))
        .await
        .is_ok()
}

/// Breaks the running call out of band. It may be between two round trips,
/// when nothing can be sent: tried again until a break is on its way, the
/// call ends, or CANCEL_GRACE passes. False if no break went.
async fn break_out_of_band(
    breaker: &BreakHandle,
    ended: &mut tokio::sync::watch::Receiver<bool>,
) -> bool {
    let deadline = Instant::now() + CANCEL_GRACE;
    loop {
        match breaker.break_call() {
            Ok(true) => return true,
            Ok(false) if *ended.borrow() => return true,
            Ok(false) if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            _ => return false,
        }
    }
}

/// Runs an ALTER SYSTEM about the running call over a session of its own;
/// whether the server took it.
async fn run_aside(settings: &Arc<Settings>, log: &SqlLog, sql: String) -> bool {
    let settings = settings.clone();
    let log = log.clone();
    let done = tokio::task::spawn_blocking(move || {
        let conn =
            oracledb::connect(settings.driver_config()?).map_err(|err| ora_err(err, None))?;
        log.record(&sql, Dialect::Oracle);
        conn.execute(&sql, &[]).map_err(|err| ora_err(err, None))?;
        Ok::<(), EngineError>(())
    })
    .await;
    matches!(done, Ok(Ok(())))
}

impl Drop for OracleInner {
    fn drop(&mut self) {
        close_later(self.session.get_mut().take());
    }
}

impl OracleInner {
    pub(super) async fn connect(
        settings: Settings,
        label: String,
        log: SqlLog,
    ) -> Result<Arc<OracleInner>, EngineError> {
        let settings = Arc::new(settings);
        let opened = {
            let settings = settings.clone();
            let log = log.clone();
            tokio::task::spawn_blocking(move || open_session(&settings, &log))
                .await
                .map_err(|err| {
                    EngineError::Internal(format!("Oracle 접속이 중단되었습니다: {err}"))
                })??
        };
        let inner = Arc::new(OracleInner {
            settings,
            running: Mutex::new(None),
            label,
            in_tx: AtomicBool::new(false),
            tx_lost: Mutex::new(None),
            cancel_requested: AtomicBool::new(false),
            out_of_band: AtomicBool::new(opened.session.breaker.is_some()),
            cancel_sql: AtomicBool::new(opened.alter_system),
            query_timeout: AtomicU64::new(0),
            user: Mutex::new(opened.user),
            schema: Mutex::new(opened.schema),
            session: tokio::sync::Mutex::new(Some(Arc::new(opened.session))),
            sources: SourceCache::default(),
            ddl: super::catalog::DdlCache::default(),
            log,
        });
        Ok(inner)
    }

    /// Whether a cancel may have to end the session: it can neither break
    /// the call out of band nor run ALTER SYSTEM CANCEL SQL.
    pub(super) fn cancel_ends_session(&self) -> bool {
        !self.out_of_band.load(Ordering::SeqCst) && !self.cancel_sql.load(Ordering::SeqCst)
    }

    pub(crate) fn in_tx(&self) -> bool {
        self.in_tx.load(Ordering::SeqCst)
    }

    pub(super) fn set_query_timeout(&self, secs: u64) {
        self.query_timeout.store(secs, Ordering::SeqCst);
    }

    /// The page's time limit for a statement, or None.
    pub(super) fn query_timeout(&self) -> Option<Duration> {
        match self.query_timeout.load(Ordering::SeqCst) {
            0 => None,
            secs => Some(Duration::from_secs(secs)),
        }
    }

    fn lost(&self) -> MutexGuard<'_, Option<&'static str>> {
        self.tx_lost.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn running(&self) -> MutexGuard<'_, Option<Running>> {
        self.running.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The schema bare names resolve in.
    pub(super) fn schema(&self) -> String {
        self.schema
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub(super) fn set_schema(&self, schema: String) {
        *self.schema.lock().unwrap_or_else(PoisonError::into_inner) = schema;
    }

    /// The user the connection logged in as.
    pub(super) fn user(&self) -> String {
        self.user
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub(super) fn take_cancelled(&self) -> bool {
        self.cancel_requested.swap(false, Ordering::SeqCst)
    }

    /// The session's transaction is gone: the next COMMIT reports `reason`.
    pub(super) fn lose_tx(&self, reason: &'static str) {
        self.sources.clear();
        if self.in_tx.swap(false, Ordering::SeqCst) {
            *self.lost() = Some(reason);
            self.log.ended(false);
        } else {
            self.log.settle(false);
        }
    }

    /// The open transaction ended (or one began) as the statements say.
    pub(super) fn set_open(&self, open: bool, committed: bool) {
        let was_open = self.in_tx.swap(open, Ordering::SeqCst);
        *self.lost() = None;
        if was_open && !open {
            self.log.ended(committed);
        } else if open && !was_open {
            self.log.settle(false);
        }
    }

    /// Runs `work` on a blocking thread with the session, opening a new one
    /// first if the last was given up. A cancel that can't stop the statement
    /// on the server ends the wait (see the module comment).
    pub(super) async fn run<T, F>(&self, work: F) -> Result<T, EngineError>
    where
        T: Send + 'static,
        F: FnOnce(&Ctx<'_>) -> Result<T, EngineError> + Send + 'static,
    {
        let mut guard = self.session.lock().await;
        if guard.is_none() {
            // A new session: whatever transaction the old one had is gone.
            self.lose_tx(CANCELLED);
            let settings = self.settings.clone();
            let log = self.log.clone();
            let opened = tokio::task::spawn_blocking(move || open_session(&settings, &log))
                .await
                .map_err(|err| {
                    EngineError::Internal(format!("Oracle 접속이 중단되었습니다: {err}"))
                })??;
            *self.user.lock().unwrap_or_else(PoisonError::into_inner) = opened.user;
            self.set_schema(opened.schema);
            self.out_of_band
                .store(opened.session.breaker.is_some(), Ordering::SeqCst);
            self.cancel_sql.store(opened.alter_system, Ordering::SeqCst);
            *guard = Some(Arc::new(opened.session));
        }
        let Some(session) = guard.clone() else {
            return Err(EngineError::Internal(
                "Oracle 세션이 준비되지 않았습니다".into(),
            ));
        };
        let abandon = Arc::new(Notify::new());
        let (ended, ended_watch) = tokio::sync::watch::channel(false);
        *self.running() = Some(Running {
            sid: session.sid,
            serial: session.serial,
            breaker: session.breaker.clone(),
            abandon: abandon.clone(),
            ended: ended_watch,
        });
        let log = self.log.clone();
        let task = tokio::task::spawn_blocking(move || {
            let ctx = Ctx {
                conn: &session.conn,
                log: &log,
            };
            work(&ctx)
        });
        let outcome = tokio::select! {
            joined = task => joined.unwrap_or_else(|err| {
                Err(EngineError::Internal(format!("Oracle 작업이 중단되었습니다: {err}")))
            }),
            () = abandon.notified() => {
                close_later(guard.take());
                self.lose_tx(CANCELLED);
                self.cancel_requested.store(false, Ordering::SeqCst);
                Err(EngineError::Driver {
                    engine: "oracle",
                    code: None,
                    message: "쿼리를 취소했습니다. 서버의 세션을 끝내지 못해 세션을 닫고 다시 엽니다".into(),
                    interrupted: true,
                    fields: Box::default(),
                })
            }
        };
        let _ = ended.send(true);
        *self.running() = None;
        if let Err(err) = &outcome {
            if session_gone(err) {
                close_later(guard.take());
                let cancelled = self.cancel_requested.load(Ordering::SeqCst);
                self.lose_tx(if cancelled {
                    CANCELLED
                } else {
                    CONNECTION_LOST
                });
            }
        }
        outcome
    }

    /// Stops the statement running now, keeping the session where it can
    /// (see the module comment). Done once the call has ended or the session
    /// was given up; None when nothing runs.
    pub(crate) fn cancel(&self) -> Option<tokio::task::JoinHandle<()>> {
        let (sid, serial, breaker, abandon, mut ended) = {
            let running = self.running();
            let running = running.as_ref()?;
            (
                running.sid,
                running.serial,
                running.breaker.clone(),
                running.abandon.clone(),
                running.ended.clone(),
            )
        };
        self.cancel_requested.store(true, Ordering::SeqCst);
        let settings = self.settings.clone();
        let log = self.log.clone();
        let privileged = self.cancel_sql.load(Ordering::SeqCst);
        Some(tokio::spawn(async move {
            if let Some(breaker) = breaker {
                if break_out_of_band(&breaker, &mut ended).await && ends_soon(&mut ended).await {
                    return;
                }
            }
            if privileged {
                for sql in [
                    format!("ALTER SYSTEM CANCEL SQL '{sid},{serial}'"),
                    format!("ALTER SYSTEM KILL SESSION '{sid},{serial}' IMMEDIATE"),
                ] {
                    if run_aside(&settings, &log, sql).await && ends_soon(&mut ended).await {
                        return;
                    }
                }
            }
            abandon.notify_one();
        }))
    }

    /// BEGIN, COMMIT and ROLLBACK from the GUI. Oracle has no BEGIN: a
    /// transaction is open from its first change until COMMIT or ROLLBACK,
    /// so BEGIN only stops the commit after every statement.
    pub(super) async fn tx(&self, op: TxOp) -> Result<(), EngineError> {
        let active = self.in_tx();
        match op {
            TxOp::Begin if active => {
                return Err(EngineError::BadRequest(
                    "이미 트랜잭션이 진행 중입니다".into(),
                ));
            }
            TxOp::Commit | TxOp::Rollback if !active => {
                let lost = self.lost().take();
                if let Some(reason) = lost {
                    self.log.settle(false);
                    return match op {
                        TxOp::Commit => Err(EngineError::TxRolledBack(reason.into())),
                        _ => Ok(()),
                    };
                }
                return Err(EngineError::BadRequest(
                    "진행 중인 트랜잭션이 없습니다".into(),
                ));
            }
            _ => {}
        }
        // A rollback takes the transaction's DDL with it.
        self.sources.clear();
        if op == TxOp::Begin {
            // Opens the session first (a cancel may have dropped it): a new
            // one opened later would end this transaction.
            self.run(|_| Ok(())).await?;
            self.set_open(true, false);
            return Ok(());
        }
        let commit = op == TxOp::Commit;
        let outcome = self
            .run(move |ctx| {
                let statement = if commit { "COMMIT" } else { "ROLLBACK" };
                ctx.log.record(statement, Dialect::Oracle);
                if commit {
                    ctx.conn.commit()
                } else {
                    ctx.conn.rollback()
                }
                .map_err(|err| ora_err(err, None))
            })
            .await;
        match outcome {
            Ok(()) => {
                self.set_open(false, commit);
                Ok(())
            }
            // The session went with the transaction (run() said so).
            Err(err) if !self.in_tx() => match op {
                TxOp::Commit => Err(EngineError::TxRolledBack(format!(
                    "커밋하지 못해 트랜잭션이 롤백되었습니다: {err}"
                ))),
                _ => Ok(()),
            },
            Err(err) => Err(err),
        }
    }
}

struct Opened {
    session: Session,
    user: String,
    schema: String,
    /// The user may run ALTER SYSTEM (CANCEL SQL, KILL SESSION).
    alter_system: bool,
}

/// The session settings every session starts with: the formats DATE and
/// TIMESTAMP text is read and written in (the grid's, the page's filters'
/// and dumps'), a `.` decimal point, and DBMS_OUTPUT collected for the
/// editor to show after a PL/SQL block.
const SESSION_SETUP: [&str; 2] = [
    "ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS' \
     NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF' \
     NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM' \
     NLS_NUMERIC_CHARACTERS = '.,'",
    "BEGIN DBMS_OUTPUT.ENABLE(NULL); END;",
];

const WHO_SQL: &str = "SELECT SYS_CONTEXT('USERENV', 'SESSION_USER'), \
     SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA'), \
     (SELECT COUNT(*) FROM session_privs WHERE privilege = 'ALTER SYSTEM') FROM DUAL";

/// Reads the session's schema again (after ALTER SESSION SET CURRENT_SCHEMA).
pub(super) fn current_schema(ctx: &Ctx<'_>) -> Result<String, EngineError> {
    let rows = ctx
        .rows(WHO_SQL, &[], &[])
        .map_err(|err| ora_err(err, None))?;
    Ok(rows
        .first()
        .and_then(|row| text(row, 1))
        .unwrap_or_default())
}

fn open_session(settings: &Settings, log: &SqlLog) -> Result<Opened, EngineError> {
    let conn = oracledb::connect(settings.driver_config()?)
        .map_err(|err| connect_error(err, &settings.connect_string))?;
    let sid = conn.session_id().map_err(|err| ora_err(err, None))? as u64;
    let serial = conn.serial_num().map_err(|err| ora_err(err, None))? as u64;
    // Asked for before any call runs: it takes the connection's lock.
    let breaker = conn.break_handle().map_err(|err| ora_err(err, None))?;
    let ctx = Ctx { conn: &conn, log };
    for sql in SESSION_SETUP {
        ctx.execute(sql, &[], &[])
            .map_err(|err| ora_err(err, Some(sql)))?;
    }
    let rows = ctx
        .rows(WHO_SQL, &[], &[])
        .map_err(|err| ora_err(err, None))?;
    let user = rows
        .first()
        .and_then(|row| text(row, 0))
        .unwrap_or_default();
    let schema = rows
        .first()
        .and_then(|row| text(row, 1))
        .unwrap_or_else(|| user.clone());
    let alter_system = rows.first().and_then(|row| int(row, 2)).unwrap_or(0) > 0;
    Ok(Opened {
        session: Session {
            conn,
            sid,
            serial,
            breaker,
        },
        user,
        schema,
        alter_system,
    })
}

/// Whether the error means the session is no longer usable: the next call
/// opens a new one.
fn session_gone(err: &EngineError) -> bool {
    let EngineError::Driver { code, fields, .. } = err else {
        return false;
    };
    if fields
        .details
        .as_ref()
        .and_then(|details| details.get("dead"))
        .is_some()
    {
        return true;
    }
    // ORA-00028 session killed, 01012 not logged on, 02396 idle time,
    // 03113/03114/03135 connection lost.
    matches!(
        code.as_deref(),
        Some("28" | "1012" | "2396" | "3113" | "3114" | "3135")
    )
}

/// A driver error as the engine reports it: an ORA error's number, its
/// first line and where in `sql` it points; any other error's text.
pub(super) fn ora_err(err: oracledb::Error, sql: Option<&str>) -> EngineError {
    let raw = err.to_string();
    let mut fields = ErrorFields::default();
    let mut interrupted = false;
    let (code, message) = match err.kind() {
        ErrorKind::DbError(db) => {
            let number = db.code();
            fields.server_code = Some(number as i64);
            interrupted = number == 1013;
            if let (Some(sql), offset) = (sql, db.offset()) {
                if offset > 0 {
                    fields.position = char_offset(sql, offset.min(sql.len())).map(|offset| {
                        tablepeek_types::ErrorPosition {
                            offset: Some(offset),
                            ..Default::default()
                        }
                    });
                }
            }
            let message = db.message().trim();
            let first = message.lines().next().unwrap_or(message).to_string();
            if first != message {
                fields.raw = Some(message.to_string());
            }
            (Some(number.to_string()), first)
        }
        ErrorKind::CallTimeoutExceeded => {
            interrupted = true;
            (
                None,
                "쿼리 시간 제한을 넘어 서버에서 문장을 멈췄습니다".to_string(),
            )
        }
        ErrorKind::TlsOperation => (None, format!("TLS 연결 실패: {raw}")),
        ErrorKind::ListenerRefusedConnection(_, _, _, number) => {
            fields.server_code = Some(*number as i64);
            (Some(number.to_string()), raw.clone())
        }
        ErrorKind::InvalidServiceName(..) => {
            fields.server_code = Some(12514);
            (Some("12514".into()), raw.clone())
        }
        ErrorKind::InvalidSid(..) => {
            fields.server_code = Some(12505);
            (Some("12505".into()), raw.clone())
        }
        ErrorKind::DeadConnection | ErrorKind::UnableToRecover | ErrorKind::NotConnected => {
            fields.details = Some(serde_json::json!({ "dead": true }));
            (None, format!("Oracle 연결이 끊겼습니다: {raw}"))
        }
        ErrorKind::StreamOperation => {
            fields.details = Some(serde_json::json!({ "dead": true }));
            // rustls refusing the server's certificate (its name, its issuer)
            // comes as a stream error.
            if raw.contains("certificate") {
                (None, format!("TLS 연결 실패: {raw}"))
            } else {
                (None, format!("Oracle 연결 실패: {raw}"))
            }
        }
        _ => (None, raw.clone()),
    };
    if fields.raw.is_none() && raw != message {
        fields.raw = Some(raw);
    }
    EngineError::Driver {
        engine: "oracle",
        code,
        message,
        interrupted,
        fields: Box::new(fields),
    }
}

/// A connect failure, said for the connect form: a connect string the driver
/// can't read names the string.
pub(super) fn connect_error(err: oracledb::Error, connect_string: &str) -> EngineError {
    match err.kind() {
        ErrorKind::InvalidConnectString(..) | ErrorKind::TnsAliasNotFound(..) => {
            EngineError::BadRequest(format!(
                "연결 문자열을 읽을 수 없습니다 ({connect_string}): {err}"
            ))
        }
        ErrorKind::NoConfigDir => {
            EngineError::BadRequest("TNS 별칭을 쓰려면 tnsnames.ora 파일을 고르세요".into())
        }
        _ => ora_err(err, None),
    }
}
