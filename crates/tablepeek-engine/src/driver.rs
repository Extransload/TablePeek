//! What every engine implements. `Driver` is the part all engines share
//! (status, cancel, server info); each paradigm adds its own set of
//! operations: `SqlDriver` for SQL databases, `DocumentDriver` for document
//! stores, `SearchDriver` (crate::search) for search engines. An engine
//! answers `sql()`, `document()` or `search()` with itself for the
//! paradigm it speaks and None for the rest.

use std::path::PathBuf;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tablepeek_types::{
    Capabilities, CellRef, DbObjects, EditTarget, EngineMeta, InsertValue, ObjectDefinition,
    PkValue, Relation, ServerInfo, TableDetail, TableSchema,
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

    fn search(&self) -> Option<&dyn crate::search::SearchDriver> {
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
    /// The rows of `sql` from where an earlier read of the same statement
    /// stopped: `page` is the `next_page` that read gave. Only engines whose
    /// capabilities say `cursor_paging` have one.
    async fn query_from(
        &self,
        _sql: &str,
        _max_rows: usize,
        _page: &str,
    ) -> Result<QueryData, EngineError> {
        Err(EngineError::Unsupported(
            "이 엔진은 페이지 토큰으로 이어 읽을 수 없습니다".into(),
        ))
    }
    /// Walks `sql`'s rows from `skip.page` (None: the start), which is row
    /// `skip.offset` of the statement, past `skip.rows` of them without returning any,
    /// for a jump to a far page on an engine that pages by token
    /// (`cursor_paging`). Stops early once `budget` has passed, so the page
    /// can show progress and stop the walk between calls. Engines without
    /// page tokens have none.
    async fn skip_rows(
        &self,
        _sql: &str,
        _skip: &SkipRequest,
        _budget: std::time::Duration,
    ) -> Result<SkipOutcome, EngineError> {
        Err(EngineError::Unsupported(
            "이 엔진은 페이지 토큰으로 행을 건너뛸 수 없습니다".into(),
        ))
    }
    /// One part of the `SELECT COUNT(*)` `sql`, counted in parts the engine
    /// chooses (Cassandra's token ranges, several at once): `cursor` is the
    /// last part's (None: the first). Stops early once `budget` has passed,
    /// so the page can show progress and stop between parts. Only engines
    /// whose capabilities say `count_steps` have one.
    async fn count_step(
        &self,
        _sql: &str,
        _cursor: Option<&str>,
        _budget: std::time::Duration,
    ) -> Result<CountStep, EngineError> {
        Err(EngineError::Unsupported(
            "이 엔진은 행 수를 나눠 셀 수 없습니다".into(),
        ))
    }
    async fn edit(&self, target: &EditTarget) -> Result<u64, EngineError>;
    /// An edit with `seen`: every column of the row as the grid last knew
    /// it (what it read, with what this apply already wrote). Engines whose
    /// row identity can move (ClickHouse's part after a merge) find the row
    /// again by it, and counters change by the difference from it; the rest
    /// edit by key alone.
    async fn edit_seen(&self, target: &EditTarget, _seen: &[PkValue]) -> Result<u64, EngineError> {
        self.edit(target).await
    }
    /// Adds `target.value` (a whole number) to the column, as one write the
    /// database applies atomically (a CQL counter's `c = c + n`). Engines
    /// without such columns have none.
    async fn edit_add(&self, _target: &EditTarget) -> Result<u64, EngineError> {
        Err(EngineError::Unsupported(
            "이 엔진에는 값을 더해 바꾸는 컬럼이 없습니다".into(),
        ))
    }
    async fn insert_row(&self, table: &str, values: &[InsertValue]) -> Result<u64, EngineError>;
    async fn delete_row(&self, table: &str, pk: &[PkValue]) -> Result<u64, EngineError>;
    /// A delete with the row as the grid last knew it (see `edit_seen`).
    async fn delete_row_seen(
        &self,
        table: &str,
        pk: &[PkValue],
        _seen: &[PkValue],
    ) -> Result<u64, EngineError> {
        self.delete_row(table, pk).await
    }
    async fn table_detail(&self, name: &str) -> Result<TableDetail, EngineError>;
    async fn objects(&self, include_system: bool) -> Result<DbObjects, EngineError>;
    async fn object_definition(
        &self,
        kind: &str,
        name: &str,
    ) -> Result<Option<ObjectDefinition>, EngineError>;
    /// Ends another session: `id` as the server info's session list gives
    /// it (a number on most engines; ClickHouse's query id, Oracle's
    /// "sid,serial#").
    async fn kill_session(&self, id: &str) -> Result<(), EngineError>;
    async fn in_tx(&self) -> Result<bool, EngineError>;
    async fn tx(&self, op: TxOp) -> Result<(), EngineError>;

    /// How long, in seconds, the statements the page runs from now on may
    /// take before the server stops them (Settings' query time limit); 0 for
    /// no limit of the app's own. Engines that send a limit with each
    /// statement (ClickHouse's max_execution_time) keep it; the rest ignore it.
    fn set_query_timeout(&self, _secs: u64) {}

    /// The whole result of the read `sql` as a file the database writes
    /// itself, read as it arrives (ClickHouse's FORMAT CSV and
    /// JSONEachRow): faster than rows through the grid, with no row limit.
    /// Only engines whose dialect offers it have one.
    async fn export_native(
        &self,
        _sql: &str,
        _export: &NativeExport,
    ) -> Result<FileStream, EngineError> {
        Err(EngineError::Unsupported(
            "이 엔진은 데이터베이스가 직접 쓰는 파일로 내보낼 수 없습니다".into(),
        ))
    }

    /// The whole value of one binary cell (`capabilities.binary_cells`), in
    /// pieces as the server sends them: past what the grid shows of a large
    /// one. Read in the page's session, so it is the value the page sees.
    async fn read_cell(&self, _cell: &CellRef) -> Result<FileStream, EngineError> {
        Err(EngineError::Unsupported(
            "이 엔진은 바이너리 값을 통째로 읽지 않습니다".into(),
        ))
    }

    /// Replaces one binary cell with the bytes `data` brings, written to the
    /// server in pieces as they come, as a cell edit is: in the open
    /// transaction, else committed (a failure midway leaves the old value).
    /// Returns the rows changed.
    async fn write_cell(&self, _cell: &CellRef, _data: FileStream) -> Result<u64, EngineError> {
        Err(EngineError::Unsupported(
            "이 엔진은 바이너리 값을 통째로 바꾸지 않습니다".into(),
        ))
    }
}

/// Where `SqlDriver::skip_rows` starts and how far it goes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkipRequest {
    /// The token the walk starts from (a result's `next_page`, or an
    /// earlier walk's); None for the statement's first row.
    #[serde(default)]
    pub page: Option<String>,
    /// Which row of the statement `page` leads to.
    #[serde(default)]
    pub offset: usize,
    /// How many rows to pass.
    pub rows: usize,
    /// The walk notes the token wherever it passes a multiple of this many
    /// rows (the data tab's page size), so later jumps start nearer.
    #[serde(default)]
    pub mark_every: usize,
}

/// How far `SqlDriver::skip_rows` got.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SkipOutcome {
    /// Where the rows after the passed ones start; None when the statement
    /// has no more rows.
    pub page: Option<String>,
    pub skipped: usize,
    /// The tokens noted on the way: `[offset, token]`, each offset a
    /// multiple of `mark_every` counted from the statement's first row.
    pub marks: Vec<(usize, String)>,
}

/// One part of a count (`SqlDriver::count_step`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CountStep {
    /// The rows the parts counted this time hold.
    pub rows: i64,
    /// Where the next step starts; None once every part is counted.
    pub cursor: Option<String>,
    /// How much of the whole is counted so far, from 0 to 1.
    pub done: f64,
}

/// A file's bytes as the database sends them.
pub type FileStream = futures_util::stream::BoxStream<'static, Result<Vec<u8>, EngineError>>;

/// What `export_native` writes: "csv" (with the page's CSV options) or
/// "json" (an array of objects, as the page's JSON export).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeExport {
    pub format: String,
    #[serde(default)]
    pub header: bool,
    #[serde(default = "default_delimiter")]
    pub delimiter: char,
    /// Records end with CRLF rather than LF.
    #[serde(default)]
    pub crlf: bool,
    /// NULL as the word NULL rather than an empty field.
    #[serde(default)]
    pub null_word: bool,
    /// CSV: arrays, maps and tuples as JSON text (as the grid shows them)
    /// rather than in the database's own text form.
    #[serde(default)]
    pub nested_json: bool,
}

fn default_delimiter() -> char {
    ','
}

/// A session id that must be a number (a PostgreSQL pid, a MySQL thread id,
/// a SQL Server spid).
pub fn numeric_session_id(id: &str) -> Result<u64, EngineError> {
    id.trim()
        .parse()
        .map_err(|_| EngineError::BadRequest("세션 ID가 올바르지 않습니다".into()))
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
    /// What an update would do, without leaving any change: the documents
    /// it matches and, where the server runs transactions, the first few as
    /// they are and as they would be (changed inside a transaction that is
    /// then aborted).
    async fn update_preview(
        &self,
        req: &UpdatePreviewRequest,
    ) -> Result<UpdatePreview, EngineError>;
    /// The collection's Atlas Search (and Vector Search) indexes; a server
    /// without search answers `Unsupported`, as do the three below.
    async fn search_indexes(&self, db: &str, coll: &str) -> Result<Vec<Value>, EngineError>;
    /// The new index's name.
    async fn create_search_index(&self, req: &SearchIndexRequest) -> Result<String, EngineError>;
    async fn update_search_index(&self, req: &SearchIndexRequest) -> Result<(), EngineError>;
    async fn drop_search_index(&self, req: &DropSearchIndexRequest) -> Result<(), EngineError>;
    /// A change stream on a collection or a whole database, event by event
    /// as canonical Extended JSON. It waits for changes as it is consumed;
    /// dropping it closes it on the server.
    async fn watch(&self, req: &WatchRequest) -> Result<DocStream, EngineError>;
    /// The GridFS buckets of a database: the prefixes with both a `.files`
    /// and a `.chunks` collection.
    async fn gridfs_buckets(&self, db: &str) -> Result<Vec<String>, EngineError>;
    /// The bucket's file documents, as stored.
    async fn gridfs_files(&self, req: &GridFsFilesRequest) -> Result<Vec<Value>, EngineError>;
    /// A file's document and its bytes, read chunk by chunk as consumed.
    async fn gridfs_download(&self, req: &GridFsFileRef) -> Result<GridFsDownload, EngineError>;
    /// Stores `body` as a new file, reading it as it arrives; answers the
    /// file's id. A failure midway removes the chunks already written.
    async fn gridfs_upload(
        &self,
        req: &GridFsUploadRequest,
        body: ByteReader,
    ) -> Result<Value, EngineError>;
    /// Removes a file's document and its chunks.
    async fn gridfs_delete(&self, req: &GridFsFileRef) -> Result<(), EngineError>;
    /// A find or an aggregation left open on the server, read batch by
    /// batch as the stream is consumed (the shell's cursors); dropping the
    /// stream closes it there. Checked by `check_cursor` first.
    async fn cursor(&self, req: &CursorOpenRequest) -> Result<DocStream, EngineError>;
}

/// Documents read one by one, as canonical Extended JSON.
pub type DocStream = futures_util::stream::BoxStream<'static, Result<Value, EngineError>>;

/// Bytes as they arrive (an upload's request body).
pub type ByteReader = std::pin::Pin<Box<dyn futures_util::io::AsyncBufRead + Send>>;

/// A GridFS file on its way out: its document (canonical Extended JSON),
/// the name and length the reply's headers carry, and the bytes.
pub struct GridFsDownload {
    pub file: Value,
    pub filename: Option<String>,
    pub length: u64,
    /// The legacy `contentType` field, where the file has one.
    pub content_type: Option<String>,
    pub bytes: futures_util::stream::BoxStream<'static, Result<Vec<u8>, EngineError>>,
}

/// Options every read that runs a query takes (find, count, aggregate,
/// explain, export): how strings compare, the index to use, and how long
/// the server may take.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct QueryOptions {
    /// A collation document (`{ locale, strength, … }`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collation: Option<Value>,
    /// An index name or a key document.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<Value>,
    #[serde(default, rename = "maxTimeMS", skip_serializing_if = "Option::is_none")]
    pub max_time_ms: Option<u64>,
}

/// What a write takes of the query options (update, replace, delete and
/// the update preview): how its filter compares strings, and the index to
/// find the documents by.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WriteOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collation: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<Value>,
}

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
    #[serde(flatten)]
    pub options: QueryOptions,
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
    #[serde(flatten)]
    pub options: QueryOptions,
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
    /// `maxTimeMS` replaces the three-second limit of a count with a filter.
    #[serde(flatten)]
    pub options: QueryOptions,
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
    #[serde(flatten)]
    pub options: QueryOptions,
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
    #[serde(flatten)]
    pub options: WriteOptions,
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
    #[serde(flatten)]
    pub options: WriteOptions,
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
    #[serde(flatten)]
    pub options: WriteOptions,
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
    /// Applied to the find or the aggregation explained.
    #[serde(flatten)]
    pub options: QueryOptions,
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

fn default_cursor_batch() -> u32 {
    101
}

/// The most documents one cursor batch carries.
pub const CURSOR_BATCH_LIMIT: u32 = 1000;

/// `/api/doc/cursor/open`: a find or an aggregation whose documents are
/// read `batchSize` at a time with `/api/doc/cursor/next`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CursorOpenRequest {
    pub db: String,
    pub coll: String,
    #[serde(default)]
    pub find: Option<CursorFind>,
    #[serde(default)]
    pub aggregate: Option<CursorAggregate>,
    /// 1–1000; the first batch and the default for the next ones.
    #[serde(default = "default_cursor_batch", rename = "batchSize")]
    pub batch_size: u32,
    /// The user confirmed an aggregation that writes (`$out`, `$merge`).
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CursorFind {
    #[serde(default = "empty_filter")]
    pub filter: Value,
    #[serde(default)]
    pub projection: Option<Value>,
    #[serde(default)]
    pub sort: Option<Value>,
    #[serde(default)]
    pub skip: Option<u64>,
    /// None or 0: every document.
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(flatten)]
    pub options: QueryOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CursorAggregate {
    pub pipeline: Vec<Value>,
    #[serde(flatten)]
    pub options: QueryOptions,
}

fn default_preview_limit() -> u32 {
    5
}

/// The most documents an update preview shows before and after.
pub const PREVIEW_LIMIT: u32 = 20;

/// `/api/doc/update/preview`: the update as it would go with `many`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdatePreviewRequest {
    pub db: String,
    pub coll: String,
    #[serde(default = "empty_filter")]
    pub filter: Value,
    /// A document of operators or a pipeline, as `update` takes it.
    pub update: Value,
    /// How many documents to show before and after (1–20).
    #[serde(default = "default_preview_limit")]
    pub limit: u32,
    #[serde(flatten)]
    pub options: WriteOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdatePreview {
    /// Null when counting took too long (three seconds), as `count` does.
    pub matched: Option<u64>,
    pub samples: Vec<PreviewSample>,
    /// False where the server runs no transactions: `samples` is empty.
    pub previewed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewSample {
    pub before: Value,
    pub after: Value,
}

/// Creating (`POST`) or changing (`PUT`) an Atlas Search index. `type`
/// ("search" or "vectorSearch") only counts when creating.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchIndexRequest {
    pub db: String,
    pub coll: String,
    pub name: String,
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    pub definition: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DropSearchIndexRequest {
    pub db: String,
    pub coll: String,
    pub name: String,
    #[serde(default)]
    pub confirmed: bool,
}

/// A change stream: on `coll`, or on every collection of `db` without one.
/// `fullDocument` ("updateLookup", "whenAvailable", "required") and
/// `fullDocumentBeforeChange` ("whenAvailable", "required", "off") as the
/// server takes them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchRequest {
    pub db: String,
    #[serde(default)]
    pub coll: Option<String>,
    #[serde(default)]
    pub pipeline: Option<Vec<Value>>,
    #[serde(default, rename = "fullDocument")]
    pub full_document: Option<String>,
    #[serde(default, rename = "fullDocumentBeforeChange")]
    pub full_document_before_change: Option<String>,
    /// An event's `_id` (its resume token): the stream goes on after it, so
    /// a page that lost its stream reconnects without missing changes.
    #[serde(default, rename = "resumeAfter")]
    pub resume_after: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GridFsFilesRequest {
    pub db: String,
    pub bucket: String,
    #[serde(default = "empty_filter")]
    pub filter: Value,
    #[serde(default)]
    pub sort: Option<Value>,
    #[serde(default)]
    pub skip: Option<u64>,
    #[serde(default = "default_limit")]
    pub limit: i64,
}

/// One file of a bucket: its `_id` as canonical Extended JSON. `confirmed`
/// is what a delete needs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GridFsFileRef {
    pub db: String,
    pub bucket: String,
    pub id: Value,
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GridFsUploadRequest {
    pub db: String,
    pub bucket: String,
    pub filename: String,
    /// The file document's `metadata`, as canonical Extended JSON.
    #[serde(default)]
    pub metadata: Option<Value>,
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

/// The rule of `/api/doc/update/preview`: between 1 and `PREVIEW_LIMIT`
/// documents. Its filter may be empty: nothing it does is left behind.
pub fn check_preview(req: &UpdatePreviewRequest) -> Result<(), EngineError> {
    if req.limit == 0 || req.limit > PREVIEW_LIMIT {
        return Err(EngineError::BadRequest(format!(
            "미리 볼 문서 수는 1~{PREVIEW_LIMIT}개입니다"
        )));
    }
    Ok(())
}

/// The rule of the deletes outside `command` (a search index, a GridFS
/// file): only once confirmed. `what` carries its object particle
/// ("파일을").
pub fn check_drop(confirmed: bool, what: &str) -> Result<(), EngineError> {
    if !confirmed {
        return Err(EngineError::BadRequest(format!(
            "{what} 삭제하려면 확인이 필요합니다 (confirmed: true)"
        )));
    }
    Ok(())
}

/// The batch size a cursor request may ask for: 1 to `CURSOR_BATCH_LIMIT`.
pub fn check_batch_size(size: u32) -> Result<(), EngineError> {
    if size == 0 || size > CURSOR_BATCH_LIMIT {
        return Err(EngineError::BadRequest(format!(
            "batchSize는 1~{CURSOR_BATCH_LIMIT}입니다"
        )));
    }
    Ok(())
}

/// The rules of `/api/doc/cursor/open`: one of `find` and `aggregate`, a
/// batch size in range, and an aggregation that writes only once
/// confirmed. Answers whether it writes.
pub fn check_cursor(req: &CursorOpenRequest) -> Result<bool, EngineError> {
    check_batch_size(req.batch_size)?;
    match (&req.find, &req.aggregate) {
        (Some(_), None) => Ok(false),
        (None, Some(aggregate)) => {
            let writes = pipeline_writes(&aggregate.pipeline);
            if writes && !req.confirmed {
                return Err(EngineError::BadRequest(
                    "$out·$merge가 있는 파이프라인은 확인이 필요합니다 (confirmed: true)".into(),
                ));
            }
            Ok(writes)
        }
        _ => Err(EngineError::BadRequest(
            "find 또는 aggregate 중 하나를 지정하세요".into(),
        )),
    }
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
            options: QueryOptions::default(),
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
            options: QueryOptions::default(),
            poll,
        };
        assert!(find("system.profile", true).quiet());
        assert!(!find("system.profile", false).quiet());
        assert!(!find("orders", true).quiet());
    }

    #[test]
    fn query_options_read_beside_the_request() {
        let find: FindRequest = serde_json::from_value(json!({
            "db": "shop", "coll": "orders", "filter": { "name": "kim" },
            "collation": { "locale": "ko", "strength": 2 },
            "hint": "name_1", "maxTimeMS": 500
        }))
        .unwrap();
        assert_eq!(find.limit, 20);
        assert_eq!(find.options.hint, Some(json!("name_1")));
        assert_eq!(find.options.max_time_ms, Some(500));
        assert_eq!(find.options.collation.unwrap()["locale"], "ko");
        let count: CountRequest =
            serde_json::from_value(json!({ "db": "shop", "coll": "orders", "hint": { "a": 1 } }))
                .unwrap();
        assert_eq!(count.options.hint, Some(json!({ "a": 1 })));
        assert!(count.options.max_time_ms.is_none());
        let explain: ExplainRequest = serde_json::from_value(json!({
            "db": "shop", "coll": "orders", "find": { "filter": {} }, "maxTimeMS": 10
        }))
        .unwrap();
        assert_eq!(explain.options.max_time_ms, Some(10));
        assert_eq!(explain.verbosity, "executionStats");
        let delete: DeleteRequest = serde_json::from_value(json!({
            "db": "shop", "coll": "orders", "filter": { "name": "kim" }, "many": true,
            "collation": { "locale": "ko" }, "hint": "name_1"
        }))
        .unwrap();
        assert_eq!(delete.options.hint, Some(json!("name_1")));
        assert_eq!(delete.options.collation.unwrap()["locale"], "ko");
        let update: UpdateRequest = serde_json::from_value(json!({
            "db": "shop", "coll": "orders", "filter": {}, "update": { "$set": { "a": 1 } }
        }))
        .unwrap();
        assert!(update.options.collation.is_none() && update.options.hint.is_none());
    }

    #[test]
    fn previews_take_one_to_twenty_and_drops_need_confirming() {
        let preview = |limit: Option<u32>| {
            let mut body =
                json!({ "db": "shop", "coll": "orders", "update": { "$set": { "a": 1 } } });
            if let Some(limit) = limit {
                body["limit"] = json!(limit);
            }
            serde_json::from_value::<UpdatePreviewRequest>(body).unwrap()
        };
        assert_eq!(preview(None).limit, 5);
        // An empty filter is fine: a preview leaves nothing behind.
        assert!(is_empty_filter(&preview(None).filter));
        check_preview(&preview(None)).unwrap();
        check_preview(&preview(Some(20))).unwrap();
        assert!(check_preview(&preview(Some(0))).is_err());
        assert!(check_preview(&preview(Some(21))).is_err());
        assert!(check_drop(false, "검색 인덱스를").is_err());
        check_drop(true, "검색 인덱스를").unwrap();
    }

    #[test]
    fn cursors_take_one_query_a_bounded_batch_and_confirmed_writes() {
        let open = |body: Value| serde_json::from_value::<CursorOpenRequest>(body).unwrap();
        let find = open(json!({ "db": "shop", "coll": "orders",
                                "find": { "filter": { "a": 1 }, "collation": { "locale": "en" }, "maxTimeMS": 5 } }));
        assert_eq!(find.batch_size, 101);
        assert_eq!(find.find.as_ref().unwrap().options.max_time_ms, Some(5));
        assert!(!check_cursor(&find).unwrap());
        for size in [0, 1001] {
            let body = json!({ "db": "d", "coll": "c", "find": {}, "batchSize": size });
            assert!(check_cursor(&open(body)).is_err(), "{size}");
        }
        check_cursor(&open(
            json!({ "db": "d", "coll": "c", "find": {}, "batchSize": 1000 }),
        ))
        .unwrap();
        assert!(check_cursor(&open(json!({ "db": "d", "coll": "c" }))).is_err());
        assert!(check_cursor(&open(
            json!({ "db": "d", "coll": "c", "find": {}, "aggregate": { "pipeline": [] } })
        ))
        .is_err());
        let out = json!({ "db": "d", "coll": "c", "aggregate": { "pipeline": [{ "$out": "x" }], "hint": "_id_" } });
        assert!(check_cursor(&open(out.clone())).is_err());
        let mut confirmed = out;
        confirmed["confirmed"] = json!(true);
        assert!(check_cursor(&open(confirmed)).unwrap());
    }
}
