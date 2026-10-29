//! What every engine implements. `Driver` is the part all engines share
//! (status, cancel, server info); each paradigm adds its own set of
//! operations: `SqlDriver` for SQL databases, `DocumentDriver` for document
//! stores. An engine answers `sql()` or `document()` with itself for the
//! paradigm it speaks and None for the rest.

use std::path::PathBuf;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tablepeek_types::{
    Capabilities, DbObjects, EditTarget, EngineMeta, InsertValue, ObjectDefinition, PkValue,
    Relation, ServerInfo, TableDetail, TableSchema,
};

use crate::sql_log::Dialect;
use crate::{EngineError, QueryData};

/// How a cancel request went out.
pub enum CancelRequest {
    /// It took effect at once, or there was nothing to cancel.
    Done,
    /// It went over a connection of its own and is done when `request`
    /// finishes. `lands_later`: the server acts on it a moment after it was
    /// sent (PostgreSQL's), not once it is done (a KILL).
    Sent {
        request: tokio::task::JoinHandle<()>,
        lands_later: bool,
    },
}

/// A transaction control the GUI sends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TxOp {
    Begin,
    Commit,
    Rollback,
}

impl TxOp {
    /// The statement as SQL engines write it.
    pub fn statement(self) -> &'static str {
        match self {
            TxOp::Begin => "BEGIN",
            TxOp::Commit => "COMMIT",
            TxOp::Rollback => "ROLLBACK",
        }
    }
}

/// One open connection of an engine.
#[async_trait]
pub trait Driver: Send + Sync {
    /// The engine's id, as its descriptor names it ("postgres").
    fn id(&self) -> &'static str;

    /// What this connection can do. Starts from the descriptor's values; an
    /// engine whose abilities depend on the server's version or the user's
    /// rights reports what it found once connected.
    fn capabilities(&self) -> Capabilities;

    async fn meta(&self, include_system: bool) -> Result<EngineMeta, EngineError>;

    /// Asks the database to stop the statement running now.
    fn cancel(&self) -> CancelRequest;

    async fn server_info(&self) -> Result<ServerInfo, EngineError>;

    /// The local file this connection holds, for engines that open one.
    fn file(&self) -> Option<PathBuf> {
        None
    }

    /// Called once the engine has let go of this connection. Connections end
    /// when the driver is dropped; a driver that must do more first (end a
    /// server session, flush) does it here.
    async fn close(&self) {}

    fn sql(&self) -> Option<&dyn SqlDriver> {
        None
    }

    fn document(&self) -> Option<&dyn DocumentDriver> {
        None
    }
}

/// The operations of a SQL database.
#[async_trait]
pub trait SqlDriver: Send + Sync {
    /// How statements are written to the console log.
    fn dialect(&self) -> Dialect;

    /// A failed statement aborts the whole open transaction until a
    /// ROLLBACK (TO SAVEPOINT), as on PostgreSQL.
    fn failure_aborts_transaction(&self) -> bool {
        false
    }

    async fn schema(&self, include_system: bool) -> Result<Vec<TableSchema>, EngineError>;
    async fn relations(&self, include_system: bool) -> Result<Vec<Relation>, EngineError>;
    async fn table_count(&self, name: &str) -> Result<i64, EngineError>;
    /// The databases a connection could switch to; empty where there are none.
    async fn databases(&self) -> Result<Vec<String>, EngineError>;
    async fn query(&self, sql: &str, max_rows: usize) -> Result<QueryData, EngineError>;
    async fn edit(&self, target: &EditTarget) -> Result<u64, EngineError>;
    async fn insert_row(&self, table: &str, values: &[InsertValue]) -> Result<u64, EngineError>;
    async fn delete_row(&self, table: &str, pk: &[PkValue]) -> Result<u64, EngineError>;
    async fn table_detail(&self, name: &str) -> Result<TableDetail, EngineError>;
    async fn objects(&self, include_system: bool) -> Result<DbObjects, EngineError>;
    async fn object_definition(
        &self,
        kind: &str,
        name: &str,
    ) -> Result<Option<ObjectDefinition>, EngineError>;
    async fn kill_session(&self, id: u64) -> Result<(), EngineError>;
    async fn in_tx(&self) -> Result<bool, EngineError>;
    async fn tx(&self, op: TxOp) -> Result<(), EngineError>;
}

/// The operations of a document store (MongoDB and the like). Documents,
/// filters and every other value travel as canonical Extended JSON; the
/// request and reply shapes are the `/api/doc/*` bodies (docs/MONGODB.md §6).
#[async_trait]
pub trait DocumentDriver: Send + Sync {
    async fn databases(&self) -> Result<Vec<DocDatabase>, EngineError>;
    async fn collections(&self, db: &str) -> Result<Vec<CollectionInfo>, EngineError>;
    /// `{ count, size, avgObjSize, storageSize, nindexes, totalIndexSize, indexSizes }`.
    async fn stats(&self, db: &str, coll: &str) -> Result<Value, EngineError>;
    async fn find(&self, req: &FindRequest) -> Result<DocBatch, EngineError>;
    /// Estimated without a filter, counted with one (giving up after a few
    /// seconds, when the count is unknown).
    async fn count(&self, req: &CountRequest) -> Result<CountResult, EngineError>;
    /// Reads up to 10,000 documents; a pipeline that writes (`$out`,
    /// `$merge`) runs only once the server has checked `confirmed`.
    async fn aggregate(&self, req: &AggregateRequest) -> Result<DocBatch, EngineError>;
    async fn distinct(&self, req: &DistinctRequest) -> Result<Vec<Value>, EngineError>;
    /// The ids of the inserted documents, in order; with `ordered: false`
    /// the documents that failed are skipped and listed in `errors`.
    async fn insert(&self, req: &InsertRequest) -> Result<InsertOutcome, EngineError>;
    /// An update whose filter carries the values the page last read, so a
    /// document changed elsewhere meanwhile matches nothing.
    async fn update(&self, req: &UpdateRequest) -> Result<UpdateOutcome, EngineError>;
    async fn replace(&self, req: &ReplaceRequest) -> Result<UpdateOutcome, EngineError>;
    /// How many documents went.
    async fn delete(&self, req: &DeleteRequest) -> Result<u64, EngineError>;
    async fn indexes(&self, db: &str, coll: &str) -> Result<Vec<Value>, EngineError>;
    /// The new index's name.
    async fn create_index(&self, req: &CreateIndexRequest) -> Result<String, EngineError>;
    async fn drop_index(&self, req: &DropIndexRequest) -> Result<(), EngineError>;
    /// The database's own explain output.
    async fn explain(&self, req: &ExplainRequest) -> Result<Value, EngineError>;
    /// One of the database commands the shell tab and the admin screens may
    /// send; see `SHELL_COMMANDS` and `check_command`.
    async fn command(&self, req: &CommandRequest) -> Result<Value, EngineError>;
    /// Every document of a find or an aggregation, one by one, for an
    /// export. The stream reads from the server as it is consumed; dropping
    /// it closes the cursor there.
    async fn export(&self, req: &ExportRequest) -> Result<DocStream, EngineError>;
    /// The part of the server's status the performance tab charts (see
    /// `/api/doc/perf`).
    async fn perf(&self) -> Result<Value, EngineError>;
}

/// Documents read one by one, as canonical Extended JSON.
pub type DocStream = futures_util::stream::BoxStream<'static, Result<Value, EngineError>>;

/// Commands `/api/doc/command` passes on. Reads go as sent; the ones
/// `check_command` names need `confirmed`.
pub const SHELL_COMMANDS: [&str; 19] = [
    "collStats",
    "dbStats",
    "drop",
    "listCollections",
    "listIndexes",
    "ping",
    "buildInfo",
    "serverStatus",
    "create",
    "renameCollection",
    "dropDatabase",
    "collMod",
    "currentOp",
    "killOp",
    "top",
    "profile",
    "hostInfo",
    "replSetGetStatus",
    "listDatabases",
];

fn empty_filter() -> Value {
    Value::Object(serde_json::Map::new())
}

fn default_limit() -> i64 {
    20
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocDatabase {
    pub name: String,
    #[serde(rename = "sizeOnDisk")]
    pub size_on_disk: Option<u64>,
    pub empty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionInfo {
    pub name: String,
    /// "collection", "view" or "timeseries".
    #[serde(rename = "type")]
    pub kind: String,
    pub options: Value,
    /// Estimated; null where there is none (views).
    pub count: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FindRequest {
    pub db: String,
    pub coll: String,
    #[serde(default = "empty_filter")]
    pub filter: Value,
    #[serde(default)]
    pub projection: Option<Value>,
    #[serde(default)]
    pub sort: Option<Value>,
    #[serde(default)]
    pub skip: Option<u64>,
    #[serde(default = "default_limit")]
    pub limit: i64,
    #[serde(default, rename = "maxTimeMS")]
    pub max_time_ms: Option<u64>,
    /// A screen's repeated read (the performance tab's slow-operation list):
    /// kept out of the console when it reads `system.profile`.
    #[serde(default)]
    pub poll: bool,
}

impl FindRequest {
    /// Whether this read is a poll the console skips: only one of
    /// `system.profile`, so the user's own finds always show.
    pub fn quiet(&self) -> bool {
        self.poll && self.coll == "system.profile"
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AggregateRequest {
    pub db: String,
    pub coll: String,
    pub pipeline: Vec<Value>,
    #[serde(default, rename = "maxTimeMS")]
    pub max_time_ms: Option<u64>,
    /// The user confirmed a pipeline that writes (`$out`, `$merge`).
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocBatch {
    pub docs: Vec<Value>,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CountRequest {
    pub db: String,
    pub coll: String,
    #[serde(default = "empty_filter")]
    pub filter: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CountResult {
    /// Null when counting took too long.
    pub count: Option<u64>,
    pub exact: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DistinctRequest {
    pub db: String,
    pub coll: String,
    pub key: String,
    #[serde(default = "empty_filter")]
    pub filter: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InsertRequest {
    pub db: String,
    pub coll: String,
    pub docs: Vec<Value>,
    /// Given, a document that fails is reported in the reply's `errors`:
    /// false skips it and goes on with the rest, true stops there (an
    /// import's two modes). Left out, the documents go in order and a
    /// failure fails the whole request (the shell's and the editor's insert).
    #[serde(default)]
    pub ordered: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InsertOutcome {
    /// The ids of the documents that went in, in the order sent.
    #[serde(rename = "insertedIds")]
    pub inserted_ids: Vec<Value>,
    /// The documents that didn't, by their place in the request.
    pub errors: Vec<InsertFailure>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InsertFailure {
    pub index: usize,
    /// `mongo_<code>` (`mongo_11000` for a duplicate key), like error replies.
    pub code: String,
    pub message: String,
    /// The server's number and codeName, as error replies carry them.
    pub server_code: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code_name: Option<String>,
    /// `{ errInfo }`: why validation failed, as canonical Extended JSON.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

/// What `/api/doc/export` reads: a find (filter, projection, sort, limit),
/// or the aggregation `pipeline` when there is one.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportRequest {
    pub db: String,
    pub coll: String,
    #[serde(default = "empty_filter")]
    pub filter: Value,
    #[serde(default)]
    pub projection: Option<Value>,
    #[serde(default)]
    pub sort: Option<Value>,
    /// None or 0: every document.
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub pipeline: Option<Vec<Value>>,
}

/// `filter` picks the documents; the page's own edits put the document's
/// `_id` and the values it last read in it, so a change made elsewhere
/// matches nothing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateRequest {
    pub db: String,
    pub coll: String,
    pub filter: Value,
    pub update: Value,
    #[serde(default)]
    pub many: bool,
    #[serde(default)]
    pub upsert: bool,
    /// The user confirmed a write with an empty filter.
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateOutcome {
    pub matched: u64,
    pub modified: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplaceRequest {
    pub db: String,
    pub coll: String,
    pub filter: Value,
    pub replacement: Value,
    /// The user confirmed a write with an empty filter.
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteRequest {
    pub db: String,
    pub coll: String,
    pub filter: Value,
    #[serde(default)]
    pub many: bool,
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateIndexRequest {
    pub db: String,
    pub coll: String,
    pub keys: Value,
    #[serde(default = "empty_filter")]
    pub options: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DropIndexRequest {
    pub db: String,
    pub coll: String,
    pub name: String,
}

/// What `explain` runs: a find (its filter, projection, sort, skip and
/// limit) or an aggregation pipeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExplainRequest {
    pub db: String,
    pub coll: String,
    #[serde(default)]
    pub find: Option<ExplainFind>,
    #[serde(default)]
    pub aggregate: Option<ExplainAggregate>,
    #[serde(default = "default_verbosity")]
    pub verbosity: String,
}

fn default_verbosity() -> String {
    "executionStats".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExplainFind {
    #[serde(default = "empty_filter")]
    pub filter: Value,
    #[serde(default)]
    pub projection: Option<Value>,
    #[serde(default)]
    pub sort: Option<Value>,
    #[serde(default)]
    pub skip: Option<u64>,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExplainAggregate {
    pub pipeline: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandRequest {
    pub db: String,
    pub command: Value,
    #[serde(default)]
    pub confirmed: bool,
    /// A screen's repeated status read (the performance tab every two
    /// seconds): kept out of the console. Honoured only for the read-only
    /// status commands of `POLL_COMMANDS` and `profile: -1`; anything else
    /// is logged as always.
    #[serde(default)]
    pub poll: bool,
}

/// Status reads a poll may send without a console line each time.
pub const POLL_COMMANDS: [&str; 6] = [
    "currentOp",
    "top",
    "serverStatus",
    "hostInfo",
    "replSetGetStatus",
    "listDatabases",
];

impl CommandRequest {
    /// Whether this command is a poll the console skips (see `poll`).
    pub fn quiet(&self) -> bool {
        self.poll
            && !command_writes(&self.command)
            && command_name(&self.command)
                .is_some_and(|name| POLL_COMMANDS.contains(&name) || name == "profile")
    }
}

/// Whether `filter` matches every document: absent, or an empty object.
pub fn is_empty_filter(filter: &Value) -> bool {
    match filter {
        Value::Null => true,
        Value::Object(map) => map.is_empty(),
        _ => false,
    }
}

/// The rule every document store's writes follow, whatever the engine: a
/// write whose filter is empty (any document, or every one with `many`)
/// needs the user's confirmation. Any other filter goes as sent; the page's
/// own edits carry the document's `_id` and the values it last read.
pub fn check_write(filter: &Value, confirmed: bool) -> Result<(), EngineError> {
    if is_empty_filter(filter) && !confirmed {
        return Err(EngineError::BadRequest(
            "조건 없이 문서를 바꾸려면 확인이 필요합니다 (confirmed: true)".into(),
        ));
    }
    Ok(())
}

/// A number as Extended JSON writes it, relaxed (`-1`) or canonical
/// (`{ "$numberInt": "-1" }`).
fn ejson_number(value: &Value) -> Option<f64> {
    if let Some(number) = value.as_f64() {
        return Some(number);
    }
    let (key, text) = value.as_object()?.iter().next()?;
    matches!(key.as_str(), "$numberInt" | "$numberLong" | "$numberDouble")
        .then(|| text.as_str()?.parse().ok())
        .flatten()
}

/// The command's name: its first key.
fn command_name(command: &Value) -> Option<&str> {
    command
        .as_object()
        .and_then(|command| command.keys().next())
        .map(String::as_str)
}

/// Whether a whitelisted command changes something (it goes to History):
/// the ones that need `confirmed`, and `create`.
pub fn command_writes(command: &Value) -> bool {
    match command_name(command) {
        Some("create") => true,
        Some(name) => confirmation_needed(name, command),
        None => false,
    }
}

/// Commands that drop, rename, change or stop something; `profile` only
/// when it sets a level (`-1` just reads it).
fn confirmation_needed(name: &str, command: &Value) -> bool {
    match name {
        "drop" | "dropDatabase" | "renameCollection" | "collMod" | "killOp" => true,
        "profile" => command
            .get("profile")
            .and_then(ejson_number)
            .is_none_or(|level| level != -1.0),
        _ => false,
    }
}

/// The rules of `/api/doc/command`: a whitelisted command; one that drops,
/// renames, changes or stops something only once confirmed; and
/// `renameCollection` sent to `admin`, where MongoDB takes it.
pub fn check_command(req: &CommandRequest) -> Result<(), EngineError> {
    let name = command_name(&req.command)
        .ok_or_else(|| EngineError::BadRequest("명령이 비어 있습니다".into()))?;
    if !SHELL_COMMANDS.contains(&name) {
        return Err(EngineError::BadRequest(format!(
            "지원하지 않는 명령입니다: {name}"
        )));
    }
    if name == "renameCollection" && req.db != "admin" {
        return Err(EngineError::BadRequest(
            "renameCollection은 admin 데이터베이스에서 실행하세요".into(),
        ));
    }
    if !req.confirmed && confirmation_needed(name, &req.command) {
        return Err(EngineError::BadRequest(if name == "drop" {
            "컬렉션을 삭제하려면 확인이 필요합니다 (confirmed: true)".into()
        } else {
            format!("{name} 명령은 확인이 필요합니다 (confirmed: true)")
        }));
    }
    Ok(())
}

/// Whether a pipeline writes: a stage that is `$out` or `$merge`.
pub fn pipeline_writes(stages: &[Value]) -> bool {
    stages.iter().any(|stage| {
        stage
            .as_object()
            .is_some_and(|stage| stage.contains_key("$out") || stage.contains_key("$merge"))
    })
}

/// The rule of `/api/doc/aggregate`: a pipeline that writes needs the
/// user's confirmation. Answers whether it writes.
pub fn check_aggregate(req: &AggregateRequest) -> Result<bool, EngineError> {
    let writes = pipeline_writes(&req.pipeline);
    if writes && !req.confirmed {
        return Err(EngineError::BadRequest(
            "$out·$merge가 있는 파이프라인은 확인이 필요합니다 (confirmed: true)".into(),
        ));
    }
    Ok(writes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn command(db: &str, command: Value, confirmed: bool) -> CommandRequest {
        CommandRequest {
            db: db.into(),
            command,
            confirmed,
            poll: false,
        }
    }

    #[test]
    fn commands_follow_the_whitelist_and_confirmation_rules() {
        let reads = [
            (
                "shop",
                json!({ "create": "logs", "capped": true, "size": 4096 }),
            ),
            (
                "admin",
                json!({ "currentOp": 1, "active": true, "$all": true }),
            ),
            ("admin", json!({ "top": 1 })),
            ("shop", json!({ "profile": -1 })),
            ("shop", json!({ "profile": { "$numberInt": "-1" } })),
            ("admin", json!({ "hostInfo": 1 })),
            ("admin", json!({ "replSetGetStatus": 1 })),
            ("admin", json!({ "listDatabases": 1 })),
            ("shop", json!({ "ping": 1 })),
        ];
        for (db, cmd) in reads {
            check_command(&command(db, cmd.clone(), false))
                .unwrap_or_else(|err| panic!("{cmd}: {err}"));
        }
        let confirmed = [
            ("shop", json!({ "drop": "logs" })),
            ("shop", json!({ "dropDatabase": 1 })),
            (
                "shop",
                json!({ "collMod": "orders", "validationLevel": "moderate" }),
            ),
            ("admin", json!({ "killOp": 1, "op": 1234 })),
            ("shop", json!({ "profile": 1, "slowms": 50 })),
            ("shop", json!({ "profile": { "$numberInt": "0" } })),
            (
                "admin",
                json!({ "renameCollection": "shop.a", "to": "shop.b", "dropTarget": false }),
            ),
        ];
        for (db, cmd) in confirmed {
            assert!(
                check_command(&command(db, cmd.clone(), false)).is_err(),
                "{cmd}"
            );
            check_command(&command(db, cmd.clone(), true))
                .unwrap_or_else(|err| panic!("{cmd}: {err}"));
            assert!(command_writes(&cmd), "{cmd}");
        }
        assert!(command_writes(&json!({ "create": "x" })));
        assert!(!command_writes(&json!({ "profile": -1 })));
        assert!(!command_writes(&json!({ "currentOp": 1 })));
        // renameCollection runs from admin only.
        let rename = json!({ "renameCollection": "shop.a", "to": "shop.b" });
        assert!(check_command(&command("shop", rename, true)).is_err());
        for refused in [
            json!({ "createUser": "x", "pwd": "y" }),
            json!({ "shutdown": 1 }),
            json!({}),
        ] {
            assert!(
                check_command(&command("admin", refused.clone(), true)).is_err(),
                "{refused}"
            );
        }
    }

    #[test]
    fn pipelines_that_write_need_confirmation() {
        let request = |pipeline: Value, confirmed: bool| AggregateRequest {
            db: "shop".into(),
            coll: "orders".into(),
            pipeline: serde_json::from_value(pipeline).unwrap(),
            max_time_ms: None,
            confirmed,
        };
        let read = json!([{ "$match": { "status": "paid" } }, { "$limit": 5 }]);
        assert!(!check_aggregate(&request(read, false)).unwrap());
        for writing in [
            json!([{ "$match": {} }, { "$out": "copy" }]),
            json!([{ "$merge": { "into": "copy" } }]),
        ] {
            assert!(check_aggregate(&request(writing.clone(), false)).is_err());
            assert!(check_aggregate(&request(writing, true)).unwrap());
        }
    }

    #[test]
    fn polls_quiet_only_status_reads() {
        let poll = |command: Value, poll: bool| CommandRequest {
            db: "admin".into(),
            command,
            confirmed: true,
            poll,
        };
        for quiet in [
            json!({ "currentOp": 1, "$all": true }),
            json!({ "top": 1 }),
            json!({ "serverStatus": 1 }),
            json!({ "hostInfo": 1 }),
            json!({ "replSetGetStatus": 1 }),
            json!({ "listDatabases": 1 }),
            json!({ "profile": -1 }),
        ] {
            assert!(poll(quiet.clone(), true).quiet(), "{quiet}");
            assert!(!poll(quiet.clone(), false).quiet(), "{quiet}");
        }
        // Writes and other reads are logged whatever the flag says.
        for loud in [
            json!({ "killOp": 1, "op": 3 }),
            json!({ "profile": 1 }),
            json!({ "drop": "c" }),
            json!({ "collStats": "c" }),
        ] {
            assert!(!poll(loud.clone(), true).quiet(), "{loud}");
        }
        let find = |coll: &str, poll: bool| FindRequest {
            db: "shop".into(),
            coll: coll.into(),
            filter: json!({}),
            projection: None,
            sort: None,
            skip: None,
            limit: 50,
            max_time_ms: None,
            poll,
        };
        assert!(find("system.profile", true).quiet());
        assert!(!find("system.profile", false).quiet());
        assert!(!find("orders", true).quiet());
    }
}
