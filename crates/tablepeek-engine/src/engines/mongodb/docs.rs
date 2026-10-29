//! MongoDB's document operations. Requests and replies are canonical
//! Extended JSON: Decimal128, Int64, dates and ids keep their types both ways.

use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures_util::TryStreamExt;
use mongodb::bson::{doc, Bson, Document};
use mongodb::change_stream::event::ResumeToken;
use mongodb::options::{
    Collation, FullDocumentBeforeChangeType, FullDocumentType, Hint, IndexOptions,
    UpdateModifications,
};
use mongodb::{Collection, IndexModel, SearchIndexModel, SearchIndexType};
use serde_json::{json, Value};

use super::{mongo_err, shell, MongoDriver, Running};
use crate::driver::{
    command_writes, pipeline_writes, AggregateRequest, ByteReader, CollectionInfo, CommandRequest,
    CountRequest, CountResult, CreateIndexRequest, CursorOpenRequest, DeleteRequest,
    DistinctRequest, DocBatch, DocDatabase, DocStream, DocumentDriver, DropIndexRequest,
    DropSearchIndexRequest, ExplainRequest, ExportRequest, FindRequest, GridFsDownload,
    GridFsFileRef, GridFsFilesRequest, GridFsUploadRequest, InsertFailure, InsertOutcome,
    InsertRequest, PreviewSample, QueryOptions, ReplaceRequest, SearchIndexRequest, UpdateOutcome,
    UpdatePreview, UpdatePreviewRequest, UpdateRequest, WatchRequest, WriteOptions,
};
use crate::sql_log::Change;
use crate::EngineError;

/// How long counting with a filter may take before the count is "many".
const COUNT_LIMIT: Duration = Duration::from_secs(3);
/// MongoDB's code for an operation stopped by its maxTimeMS.
const MAX_TIME_EXPIRED: i32 = 50;
/// Most documents one aggregation reply carries.
const AGGREGATE_CAP: usize = 10_000;
/// The most documents an insert writes out in the console and History.
const SHOWN_DOCS: usize = 3;

pub(super) fn bad(message: impl Into<String>) -> EngineError {
    EngineError::BadRequest(message.into())
}

/// A value of the request, read as Extended JSON.
pub(super) fn bson(value: &Value) -> Result<Bson, EngineError> {
    Bson::try_from(value.clone()).map_err(|err| bad(format!("EJSON 값이 올바르지 않습니다: {err}")))
}

/// A document of the request (a filter, an update, …); null reads as empty.
pub(super) fn document(value: &Value, what: &str) -> Result<Document, EngineError> {
    match value {
        Value::Null => Ok(Document::new()),
        _ => match bson(value)? {
            Bson::Document(doc) => Ok(doc),
            _ => Err(bad(format!("{what}은(는) 객체여야 합니다"))),
        },
    }
}

pub(super) fn optional_document(
    value: &Option<Value>,
    what: &str,
) -> Result<Option<Document>, EngineError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => document(value, what).map(Some),
    }
}

fn pipeline(stages: &[Value]) -> Result<Vec<Document>, EngineError> {
    stages
        .iter()
        .map(|stage| document(stage, "파이프라인 단계"))
        .collect()
}

/// A reply value as canonical Extended JSON.
pub(super) fn json_of(value: Bson) -> Value {
    value.into_canonical_extjson()
}

pub(super) fn json_doc(doc: Document) -> Value {
    json_of(Bson::Document(doc))
}

fn pipeline_text(stages: &[Document]) -> String {
    let items: Vec<String> = stages.iter().map(shell::document).collect();
    format!("[{}]", items.join(", "))
}

/// A find as the shell writes it: `db.c.find({…}, {…}).sort({…}).skip(n).limit(n)`.
pub(super) fn find_text(
    db: &str,
    coll: &str,
    filter: &Document,
    projection: Option<&Document>,
    sort: Option<&Document>,
    skip: Option<u64>,
    limit: Option<i64>,
) -> String {
    let mut text = format!(
        "{}.find({}",
        shell::collection(db, coll),
        shell::document(filter)
    );
    if let Some(projection) = projection {
        text.push_str(&format!(", {}", shell::document(projection)));
    }
    text.push(')');
    if let Some(sort) = sort {
        text.push_str(&format!(".sort({})", shell::document(sort)));
    }
    if let Some(skip) = skip.filter(|skip| *skip > 0) {
        text.push_str(&format!(".skip({skip})"));
    }
    if let Some(limit) = limit {
        text.push_str(&format!(".limit({limit})"));
    }
    text
}

fn max_time(ms: Option<u64>) -> Option<Duration> {
    ms.filter(|ms| *ms > 0).map(Duration::from_millis)
}

/// A read's collation, hint and time limit, checked; the documents kept
/// for the console's text and for explain's command.
struct ReadOptions {
    collation: Option<(Document, Collation)>,
    hint: Option<Bson>,
    max_time: Option<Duration>,
}

impl ReadOptions {
    fn of(options: &QueryOptions) -> Result<Self, EngineError> {
        Self::parse(&options.collation, &options.hint, options.max_time_ms)
    }

    /// A write's: no time limit (the driver's writes take none).
    fn of_write(options: &WriteOptions) -> Result<Self, EngineError> {
        Self::parse(&options.collation, &options.hint, None)
    }

    fn parse(
        collation: &Option<Value>,
        hint: &Option<Value>,
        max_time_ms: Option<u64>,
    ) -> Result<Self, EngineError> {
        let collation = match optional_document(collation, "collation")? {
            Some(doc) => {
                let typed: Collation = mongodb::bson::from_document(doc.clone())
                    .map_err(|err| bad(format!("collation이 올바르지 않습니다: {err}")))?;
                Some((doc, typed))
            }
            None => None,
        };
        let hint = match hint {
            None | Some(Value::Null) => None,
            Some(Value::String(name)) if name.is_empty() => None,
            Some(Value::String(name)) => Some(Bson::String(name.clone())),
            Some(keys) => Some(Bson::Document(document(keys, "hint")?)),
        };
        Ok(Self {
            collation,
            hint,
            max_time: max_time(max_time_ms),
        })
    }

    fn collation(&self) -> Option<Collation> {
        self.collation.as_ref().map(|(_, typed)| typed.clone())
    }

    fn hint(&self) -> Option<Hint> {
        match self.hint.as_ref()? {
            Bson::String(name) => Some(Hint::Name(name.clone())),
            Bson::Document(keys) => Some(Hint::Keys(keys.clone())),
            _ => None,
        }
    }

    /// The fields a command document or the shell's options document takes:
    /// `collation`, `hint`, `maxTimeMS`.
    fn fields(&self) -> Document {
        let mut fields = Document::new();
        if let Some((doc, _)) = &self.collation {
            fields.insert("collation", doc.clone());
        }
        if let Some(hint) = &self.hint {
            fields.insert("hint", hint.clone());
        }
        if let Some(limit) = self.max_time {
            fields.insert("maxTimeMS", whole(limit.as_millis()));
        }
        fields
    }

    /// As a find's cursor methods: `.collation({…}).hint("…").maxTimeMS(n)`.
    fn cursor_text(&self) -> String {
        let mut text = String::new();
        if let Some((doc, _)) = &self.collation {
            text.push_str(&format!(".collation({})", shell::document(doc)));
        }
        if let Some(hint) = &self.hint {
            text.push_str(&format!(".hint({})", shell::value(hint)));
        }
        if let Some(limit) = self.max_time {
            text.push_str(&format!(".maxTimeMS({})", limit.as_millis()));
        }
        text
    }

    /// As the options argument of `aggregate` and `countDocuments`:
    /// `, { collation: {…}, … }`, or nothing.
    fn argument_text(&self) -> String {
        let fields = self.fields();
        if fields.is_empty() {
            String::new()
        } else {
            format!(", {}", shell::document(&fields))
        }
    }
}

/// An update as the driver takes it, and as the shell writes it: a document
/// of operators or a pipeline of stages.
fn update_modifications(update: &Value) -> Result<(UpdateModifications, String), EngineError> {
    Ok(match update {
        Value::Array(stages) => {
            let stages = pipeline(stages)?;
            let text = pipeline_text(&stages);
            (UpdateModifications::Pipeline(stages), text)
        }
        other => {
            let doc = document(other, "update")?;
            let text = shell::document(&doc);
            (UpdateModifications::Document(doc), text)
        }
    })
}

fn elapsed_ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

/// A count (milliseconds, a batch size) as the shell writes it: a plain
/// number when it fits an Int32, not `NumberLong("…")`.
fn whole(n: u128) -> Bson {
    i32::try_from(n)
        .map(Bson::Int32)
        .unwrap_or_else(|_| Bson::Int64(i64::try_from(n).unwrap_or(i64::MAX)))
}

impl MongoDriver {
    pub(super) fn collection(
        &self,
        db: &str,
        coll: &str,
    ) -> Result<Collection<Document>, EngineError> {
        if db.is_empty() || coll.is_empty() {
            return Err(bad("데이터베이스와 컬렉션을 지정하세요"));
        }
        Ok(self.client.database(db).collection(coll))
    }

    /// A write that went through, for History (cut like the console's).
    pub(super) fn changed(&self, text: String, started: Instant, rows: u64) {
        if rows > 0 {
            let text = if text.len() > crate::sql_log::COMMAND_CAP {
                crate::sql_log::clip_command(&text).into_owned()
            } else {
                text
            };
            self.log.changed(
                Change {
                    sql: text,
                    ms: started.elapsed().as_millis() as u64,
                    rows,
                },
                false,
            );
        }
    }

    /// The server's own `$indexStats` use counts per index, None without the
    /// right to read them.
    async fn index_ops(&self, coll: &Collection<Document>) -> Option<Vec<(String, Bson)>> {
        let cursor = coll
            .aggregate(vec![doc! { "$indexStats": {} }])
            .await
            .ok()?;
        let stats: Vec<Document> = cursor.try_collect().await.ok()?;
        Some(
            stats
                .into_iter()
                .filter_map(|stat| {
                    let name = stat.get_str("name").ok()?.to_string();
                    let ops = stat.get_document("accesses").ok()?.get("ops")?.clone();
                    Some((name, ops))
                })
                .collect(),
        )
    }

    async fn storage_stats(&self, coll: &Collection<Document>) -> Result<Document, EngineError> {
        let cursor = coll
            .aggregate(vec![doc! { "$collStats": { "storageStats": {} } }])
            .await
            .map_err(mongo_err)?;
        let mut stats: Vec<Document> = cursor.try_collect().await.map_err(mongo_err)?;
        let first = stats.pop().unwrap_or_default();
        Ok(first
            .get_document("storageStats")
            .cloned()
            .unwrap_or_default())
    }
}

#[async_trait]
impl DocumentDriver for MongoDriver {
    async fn databases(&self) -> Result<Vec<DocDatabase>, EngineError> {
        self.log
            .record_command("db.adminCommand({ listDatabases: 1 })");
        let reply = self
            .client
            .database("admin")
            .run_command(doc! { "listDatabases": 1, "authorizedDatabases": true })
            .await
            .map_err(mongo_err)?;
        let mut databases: Vec<DocDatabase> = reply
            .get_array("databases")
            .map(|list| {
                list.iter()
                    .filter_map(Bson::as_document)
                    .filter_map(|entry| {
                        Some(DocDatabase {
                            name: entry.get_str("name").ok()?.to_string(),
                            size_on_disk: entry
                                .get("sizeOnDisk")
                                .and_then(super::number)
                                .map(|size| size as u64),
                            empty: entry.get_bool("empty").unwrap_or(false),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        // A user allowed into one database may not see it listed.
        if let Some(db) = &self.default_db {
            if !databases.iter().any(|known| &known.name == db) {
                databases.push(DocDatabase {
                    name: db.clone(),
                    size_on_disk: None,
                    empty: false,
                });
            }
        }
        databases.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(databases)
    }

    async fn collections(&self, db: &str) -> Result<Vec<CollectionInfo>, EngineError> {
        let database = self.client.database(db);
        self.log
            .record_command(&format!("{}.getCollectionInfos()", shell::database(db)));
        let cursor = database
            .run_cursor_command(doc! { "listCollections": 1 })
            .await
            .map_err(mongo_err)?;
        let specs: Vec<Document> = cursor.try_collect().await.map_err(mongo_err)?;
        let mut collections = Vec::with_capacity(specs.len());
        for spec in specs {
            let Ok(name) = spec.get_str("name") else {
                continue;
            };
            let kind = spec.get_str("type").unwrap_or("collection").to_string();
            // Views have no count of their own; a collection's is the
            // estimate from its metadata, cheap at any size.
            let count = if kind == "view" {
                None
            } else {
                database
                    .collection::<Document>(name)
                    .estimated_document_count()
                    .await
                    .ok()
            };
            collections.push(CollectionInfo {
                name: name.to_string(),
                kind,
                options: spec
                    .get_document("options")
                    .ok()
                    .cloned()
                    .map(json_doc)
                    .unwrap_or_else(|| json!({})),
                count,
            });
        }
        collections.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(collections)
    }

    async fn stats(&self, db: &str, coll: &str) -> Result<Value, EngineError> {
        let collection = self.collection(db, coll)?;
        self.log
            .record_command(&format!("{}.stats()", shell::collection(db, coll)));
        let stats = self.storage_stats(&collection).await?;
        let pick = |key: &str| stats.get(key).cloned().unwrap_or(Bson::Null);
        Ok(json_doc(doc! {
            "count": pick("count"),
            "size": pick("size"),
            "avgObjSize": pick("avgObjSize"),
            "storageSize": pick("storageSize"),
            "nindexes": pick("nindexes"),
            "totalIndexSize": pick("totalIndexSize"),
            "indexSizes": pick("indexSizes"),
        }))
    }

    async fn find(&self, req: &FindRequest) -> Result<DocBatch, EngineError> {
        let collection = self.collection(&req.db, &req.coll)?;
        let filter = document(&req.filter, "filter")?;
        let projection = optional_document(&req.projection, "projection")?;
        let sort = optional_document(&req.sort, "sort")?;
        let options = ReadOptions::of(&req.options)?;
        let text = find_text(
            &req.db,
            &req.coll,
            &filter,
            projection.as_ref(),
            sort.as_ref(),
            req.skip,
            Some(req.limit),
        ) + &options.cursor_text();
        if !req.quiet() {
            self.log.record_command(&text);
        }

        let (_running, tag) = Running::start(&self.running);
        let started = Instant::now();
        let mut action = collection.find(filter).limit(req.limit).comment(tag);
        if let Some(projection) = projection {
            action = action.projection(projection);
        }
        if let Some(sort) = sort {
            action = action.sort(sort);
        }
        if let Some(skip) = req.skip {
            action = action.skip(skip);
        }
        if let Some(collation) = options.collation() {
            action = action.collation(collation);
        }
        if let Some(hint) = options.hint() {
            action = action.hint(hint);
        }
        if let Some(limit) = options.max_time {
            action = action.max_time(limit);
        }
        let cursor = action.await.map_err(mongo_err)?;
        let docs: Vec<Document> = cursor.try_collect().await.map_err(mongo_err)?;
        Ok(DocBatch {
            docs: docs.into_iter().map(json_doc).collect(),
            elapsed_ms: elapsed_ms(started),
        })
    }

    async fn count(&self, req: &CountRequest) -> Result<CountResult, EngineError> {
        let collection = self.collection(&req.db, &req.coll)?;
        let filter = document(&req.filter, "filter")?;
        let options = ReadOptions::of(&req.options)?;
        let target = shell::collection(&req.db, &req.coll);
        let (_running, tag) = Running::start(&self.running);
        // Without a filter the estimate from the metadata: no query for a
        // collation or a hint to shape.
        if filter.is_empty() {
            let mut action = collection.estimated_document_count().comment(tag);
            let mut text = format!("{target}.estimatedDocumentCount(");
            if let Some(limit) = options.max_time {
                text.push_str(&format!("{{ maxTimeMS: {} }}", limit.as_millis()));
                action = action.max_time(limit);
            }
            text.push(')');
            self.log.record_command(&text);
            let count = action.await.map_err(mongo_err)?;
            return Ok(CountResult {
                count: Some(count),
                exact: false,
            });
        }
        let limit = options.max_time.unwrap_or(COUNT_LIMIT);
        let mut fields = options.fields();
        fields.insert("maxTimeMS", whole(limit.as_millis()));
        self.log.record_command(&format!(
            "{target}.countDocuments({}, {})",
            shell::document(&filter),
            shell::document(&fields)
        ));
        let mut action = collection
            .count_documents(filter)
            .max_time(limit)
            .comment(tag);
        if let Some(collation) = options.collation() {
            action = action.collation(collation);
        }
        if let Some(hint) = options.hint() {
            action = action.hint(hint);
        }
        match action.await.map_err(mongo_err) {
            Ok(count) => Ok(CountResult {
                count: Some(count),
                exact: true,
            }),
            // Too many to count in time: the page shows "many".
            Err(err) if timed_out(&err) => Ok(CountResult {
                count: None,
                exact: false,
            }),
            Err(err) => Err(err),
        }
    }

    async fn aggregate(&self, req: &AggregateRequest) -> Result<DocBatch, EngineError> {
        let collection = self.collection(&req.db, &req.coll)?;
        let stages = pipeline(&req.pipeline)?;
        let writes = pipeline_writes(&req.pipeline);
        let options = ReadOptions::of(&req.options)?;
        let text = format!(
            "{}.aggregate({}{})",
            shell::collection(&req.db, &req.coll),
            pipeline_text(&stages),
            options.argument_text()
        );
        self.log.record_command(&text);
        let started = Instant::now();
        let mut action = collection.aggregate(stages);
        // A pipeline that writes ($out, $merge) carries no tag, so a cancel
        // never leaves its outcome unknown.
        let _running = if writes {
            None
        } else {
            let (running, tag) = Running::start(&self.running);
            action = action.comment(tag);
            Some(running)
        };
        if let Some(collation) = options.collation() {
            action = action.collation(collation);
        }
        if let Some(hint) = options.hint() {
            action = action.hint(hint);
        }
        if let Some(limit) = options.max_time {
            action = action.max_time(limit);
        }
        let mut cursor = action.await.map_err(mongo_err)?;
        let mut docs = Vec::new();
        while let Some(doc) = cursor.try_next().await.map_err(mongo_err)? {
            docs.push(json_doc(doc));
            if docs.len() == AGGREGATE_CAP {
                break;
            }
        }
        if writes {
            self.changed(text, started, 1);
        }
        Ok(DocBatch {
            docs,
            elapsed_ms: elapsed_ms(started),
        })
    }

    async fn distinct(&self, req: &DistinctRequest) -> Result<Vec<Value>, EngineError> {
        let collection = self.collection(&req.db, &req.coll)?;
        let filter = document(&req.filter, "filter")?;
        self.log.record_command(&format!(
            "{}.distinct({}, {})",
            shell::collection(&req.db, &req.coll),
            shell::quote(&req.key),
            shell::document(&filter)
        ));
        let (_running, tag) = Running::start(&self.running);
        let values = collection
            .distinct(&req.key, filter)
            .comment(tag)
            .await
            .map_err(mongo_err)?;
        Ok(values.into_iter().map(json_of).collect())
    }

    async fn insert(&self, req: &InsertRequest) -> Result<InsertOutcome, EngineError> {
        let collection = self.collection(&req.db, &req.coll)?;
        if req.docs.is_empty() {
            return Err(bad("추가할 문서가 없습니다"));
        }
        let mut docs = req
            .docs
            .iter()
            .map(|doc| document(doc, "문서"))
            .collect::<Result<Vec<_>, _>>()?;
        // Past a few documents only the first two are written out: an
        // import's batch of 1,000 would swamp the console and History.
        let items: Vec<String> = docs
            .iter()
            .take(if docs.len() > SHOWN_DOCS {
                2
            } else {
                SHOWN_DOCS
            })
            .map(shell::document)
            .collect();
        let listed = if docs.len() > SHOWN_DOCS {
            format!(
                "{}, /* 외 {}개 */",
                items.join(", "),
                docs.len() - items.len()
            )
        } else {
            items.join(", ")
        };
        let target = shell::collection(&req.db, &req.coll);
        let ordered = req.ordered.unwrap_or(true);
        let text = if docs.len() == 1 && ordered {
            format!("{target}.insertOne({listed})")
        } else if ordered {
            format!("{target}.insertMany([{listed}])")
        } else {
            format!("{target}.insertMany([{listed}], {{ ordered: false }})")
        };
        self.log.record_command(&text);
        let started = Instant::now();
        if req.ordered.is_none() {
            let result = collection.insert_many(docs).await.map_err(mongo_err)?;
            let mut ids: Vec<(usize, Bson)> = result.inserted_ids.into_iter().collect();
            ids.sort_by_key(|(index, _)| *index);
            self.changed(text, started, ids.len() as u64);
            return Ok(InsertOutcome {
                inserted_ids: ids.into_iter().map(|(_, id)| json_of(id)).collect(),
                errors: Vec::new(),
            });
        }
        // Failures are reported per document: each gets its `_id` here, as
        // the driver would, so the ids of the ones that went in are known.
        let ids: Vec<Bson> = docs
            .iter_mut()
            .map(|doc| {
                doc.get("_id").cloned().unwrap_or_else(|| {
                    let id = Bson::ObjectId(mongodb::bson::oid::ObjectId::new());
                    doc.insert("_id", id.clone());
                    id
                })
            })
            .collect();
        let errors = match collection.insert_many(docs).ordered(ordered).await {
            Ok(_) => Vec::new(),
            Err(err) => match err.kind.as_ref() {
                mongodb::error::ErrorKind::InsertMany(failure)
                    if failure.write_concern_error.is_none() =>
                {
                    failure
                        .write_errors
                        .iter()
                        .flatten()
                        .map(|write| InsertFailure {
                            index: write.index,
                            code: format!("mongo_{}", write.code),
                            message: crate::registry::redact_uri_passwords(&write.message),
                            server_code: i64::from(write.code),
                            code_name: write.code_name.clone(),
                            details: super::err_info(write.details.as_ref())
                                .map(|info| serde_json::json!({ "errInfo": info })),
                        })
                        .collect()
                }
                _ => return Err(mongo_err(err)),
            },
        };
        // Ordered, everything before the failure went in and nothing after.
        let failed: std::collections::HashSet<usize> =
            errors.iter().map(|failure| failure.index).collect();
        let stop = if ordered {
            failed.iter().min().copied().unwrap_or(ids.len())
        } else {
            ids.len()
        };
        let inserted_ids: Vec<Value> = ids
            .into_iter()
            .take(stop)
            .enumerate()
            .filter(|(index, _)| !failed.contains(index))
            .map(|(_, id)| json_of(id))
            .collect();
        self.changed(text, started, inserted_ids.len() as u64);
        Ok(InsertOutcome {
            inserted_ids,
            errors,
        })
    }

    async fn update(&self, req: &UpdateRequest) -> Result<UpdateOutcome, EngineError> {
        let collection = self.collection(&req.db, &req.coll)?;
        let filter = document(&req.filter, "filter")?;
        let (update, update_text) = update_modifications(&req.update)?;
        let options = ReadOptions::of_write(&req.options)?;
        let method = if req.many { "updateMany" } else { "updateOne" };
        let mut shown = Document::new();
        if req.upsert {
            shown.insert("upsert", true);
        }
        shown.extend(options.fields());
        let mut text = format!(
            "{}.{method}({}, {update_text}",
            shell::collection(&req.db, &req.coll),
            shell::document(&filter)
        );
        if !shown.is_empty() {
            text.push_str(&format!(", {}", shell::document(&shown)));
        }
        text.push(')');
        self.log.record_command(&text);
        let started = Instant::now();
        let mut action = if req.many {
            collection.update_many(filter, update)
        } else {
            collection.update_one(filter, update)
        }
        .upsert(req.upsert);
        if let Some(collation) = options.collation() {
            action = action.collation(collation);
        }
        if let Some(hint) = options.hint() {
            action = action.hint(hint);
        }
        let result = action.await.map_err(mongo_err)?;
        self.changed(
            text,
            started,
            result.modified_count + u64::from(result.upserted_id.is_some()),
        );
        Ok(UpdateOutcome {
            matched: result.matched_count,
            modified: result.modified_count,
        })
    }

    async fn replace(&self, req: &ReplaceRequest) -> Result<UpdateOutcome, EngineError> {
        let collection = self.collection(&req.db, &req.coll)?;
        let filter = document(&req.filter, "filter")?;
        let replacement = document(&req.replacement, "replacement")?;
        let options = ReadOptions::of_write(&req.options)?;
        let text = format!(
            "{}.replaceOne({}, {}{})",
            shell::collection(&req.db, &req.coll),
            shell::document(&filter),
            shell::document(&replacement),
            options.argument_text()
        );
        self.log.record_command(&text);
        let started = Instant::now();
        let mut action = collection.replace_one(filter, replacement);
        if let Some(collation) = options.collation() {
            action = action.collation(collation);
        }
        if let Some(hint) = options.hint() {
            action = action.hint(hint);
        }
        let result = action.await.map_err(mongo_err)?;
        self.changed(text, started, result.modified_count);
        Ok(UpdateOutcome {
            matched: result.matched_count,
            modified: result.modified_count,
        })
    }

    async fn delete(&self, req: &DeleteRequest) -> Result<u64, EngineError> {
        let collection = self.collection(&req.db, &req.coll)?;
        let filter = document(&req.filter, "filter")?;
        let options = ReadOptions::of_write(&req.options)?;
        let method = if req.many { "deleteMany" } else { "deleteOne" };
        let text = format!(
            "{}.{method}({}{})",
            shell::collection(&req.db, &req.coll),
            shell::document(&filter),
            options.argument_text()
        );
        self.log.record_command(&text);
        let started = Instant::now();
        let mut action = if req.many {
            collection.delete_many(filter)
        } else {
            collection.delete_one(filter)
        };
        if let Some(collation) = options.collation() {
            action = action.collation(collation);
        }
        if let Some(hint) = options.hint() {
            action = action.hint(hint);
        }
        let result = action.await.map_err(mongo_err)?;
        self.changed(text, started, result.deleted_count);
        Ok(result.deleted_count)
    }

    async fn indexes(&self, db: &str, coll: &str) -> Result<Vec<Value>, EngineError> {
        let collection = self.collection(db, coll)?;
        self.log
            .record_command(&format!("{}.getIndexes()", shell::collection(db, coll)));
        let cursor = self
            .client
            .database(db)
            .run_cursor_command(doc! { "listIndexes": coll })
            .await
            .map_err(mongo_err)?;
        let specs: Vec<Document> = cursor.try_collect().await.map_err(mongo_err)?;
        // Sizes and use counts need rights a user may not have: null then.
        let sizes = self
            .storage_stats(&collection)
            .await
            .ok()
            .and_then(|stats| stats.get_document("indexSizes").ok().cloned());
        let ops = self.index_ops(&collection).await;
        Ok(specs
            .into_iter()
            .map(|mut spec| {
                let name = spec.get_str("name").unwrap_or("").to_string();
                spec.remove("v");
                let size = sizes
                    .as_ref()
                    .and_then(|sizes| sizes.get(&name).cloned())
                    .unwrap_or(Bson::Null);
                let used = ops
                    .as_ref()
                    .and_then(|ops| ops.iter().find(|(index, _)| *index == name))
                    .map(|(_, ops)| ops.clone())
                    .unwrap_or(Bson::Null);
                spec.insert("size", size);
                spec.insert("ops", used);
                json_doc(spec)
            })
            .collect())
    }

    async fn create_index(&self, req: &CreateIndexRequest) -> Result<String, EngineError> {
        let collection = self.collection(&req.db, &req.coll)?;
        let keys = document(&req.keys, "keys")?;
        if keys.is_empty() {
            return Err(bad("인덱스 키를 지정하세요"));
        }
        let options = document(&req.options, "options")?;
        let text = format!(
            "{}.createIndex({}, {})",
            shell::collection(&req.db, &req.coll),
            shell::document(&keys),
            shell::document(&options)
        );
        let index_options: IndexOptions = mongodb::bson::from_document(options)
            .map_err(|err| bad(format!("인덱스 옵션이 올바르지 않습니다: {err}")))?;
        self.log.record_command(&text);
        let started = Instant::now();
        let model = IndexModel::builder()
            .keys(keys)
            .options(Some(index_options))
            .build();
        let result = collection.create_index(model).await.map_err(mongo_err)?;
        self.changed(text, started, 1);
        Ok(result.index_name)
    }

    async fn drop_index(&self, req: &DropIndexRequest) -> Result<(), EngineError> {
        let collection = self.collection(&req.db, &req.coll)?;
        let text = format!(
            "{}.dropIndex({})",
            shell::collection(&req.db, &req.coll),
            shell::quote(&req.name)
        );
        self.log.record_command(&text);
        let started = Instant::now();
        collection.drop_index(&req.name).await.map_err(mongo_err)?;
        self.changed(text, started, 1);
        Ok(())
    }

    async fn explain(&self, req: &ExplainRequest) -> Result<Value, EngineError> {
        self.collection(&req.db, &req.coll)?;
        let target = shell::collection(&req.db, &req.coll);
        let options = ReadOptions::of(&req.options)?;
        let (mut command, text) = match (&req.find, &req.aggregate) {
            (Some(find), None) => {
                let filter = document(&find.filter, "filter")?;
                let mut command = doc! { "find": &req.coll, "filter": filter.clone() };
                let mut text = format!("{target}.find({})", shell::document(&filter));
                if let Some(projection) = optional_document(&find.projection, "projection")? {
                    command.insert("projection", projection);
                }
                if let Some(sort) = optional_document(&find.sort, "sort")? {
                    text.push_str(&format!(".sort({})", shell::document(&sort)));
                    command.insert("sort", sort);
                }
                if let Some(skip) = find.skip.filter(|skip| *skip > 0) {
                    text.push_str(&format!(".skip({skip})"));
                    command.insert("skip", skip as i64);
                }
                if let Some(limit) = find.limit.filter(|limit| *limit > 0) {
                    text.push_str(&format!(".limit({limit})"));
                    command.insert("limit", limit);
                }
                text.push_str(&options.cursor_text());
                (command, text)
            }
            (None, Some(aggregate)) => {
                let stages = pipeline(&aggregate.pipeline)?;
                let text = format!(
                    "{target}.aggregate({}{})",
                    pipeline_text(&stages),
                    options.argument_text()
                );
                (
                    doc! { "aggregate": &req.coll, "pipeline": stages, "cursor": {} },
                    text,
                )
            }
            _ => return Err(bad("find 또는 aggregate 중 하나를 지정하세요")),
        };
        if !matches!(
            req.verbosity.as_str(),
            "queryPlanner" | "executionStats" | "allPlansExecution"
        ) {
            return Err(bad(format!(
                "verbosity 값이 올바르지 않습니다: {}",
                req.verbosity
            )));
        }
        // The collation and the hint shape the query explained; the time
        // limit is the explain command's own.
        if let Some((collation, _)) = &options.collation {
            command.insert("collation", collation.clone());
        }
        if let Some(hint) = &options.hint {
            command.insert("hint", hint.clone());
        }
        self.log
            .record_command(&format!("{text}.explain({})", shell::quote(&req.verbosity)));
        let (_running, tag) = Running::start(&self.running);
        let mut explain = doc! {
            "explain": command,
            "verbosity": &req.verbosity,
            "comment": tag,
        };
        if let Some(limit) = options.max_time {
            explain.insert("maxTimeMS", whole(limit.as_millis()));
        }
        let reply = self
            .client
            .database(&req.db)
            .run_command(explain)
            .await
            .map_err(mongo_err)?;
        Ok(json_doc(reply))
    }

    async fn command(&self, req: &CommandRequest) -> Result<Value, EngineError> {
        let command = document(&req.command, "command")?;
        let text = format!(
            "{}.runCommand({})",
            shell::database(&req.db),
            shell::document(&command)
        );
        if !req.quiet() {
            self.log.record_command(&text);
        }
        let started = Instant::now();
        let reply = self
            .client
            .database(&req.db)
            .run_command(command)
            .await
            .map_err(mongo_err)?;
        if command_writes(&req.command) {
            self.changed(text, started, 1);
        }
        Ok(json_doc(reply))
    }

    async fn export(&self, req: &ExportRequest) -> Result<DocStream, EngineError> {
        let collection = self.collection(&req.db, &req.coll)?;
        let limit = req.limit.filter(|limit| *limit > 0);
        let options = ReadOptions::of(&req.options)?;
        // Not tagged: only the reader going away (the cursor dropped) stops it.
        let cursor = match &req.pipeline {
            Some(stages) => {
                if pipeline_writes(stages) {
                    return Err(bad("내보내는 파이프라인에는 $out·$merge를 쓸 수 없습니다"));
                }
                let mut stages = pipeline(stages)?;
                if let Some(limit) = limit {
                    stages.push(doc! { "$limit": limit });
                }
                self.log.record_command(&format!(
                    "{}.aggregate({}{})",
                    shell::collection(&req.db, &req.coll),
                    pipeline_text(&stages),
                    options.argument_text()
                ));
                let mut action = collection.aggregate(stages);
                if let Some(collation) = options.collation() {
                    action = action.collation(collation);
                }
                if let Some(hint) = options.hint() {
                    action = action.hint(hint);
                }
                if let Some(limit) = options.max_time {
                    action = action.max_time(limit);
                }
                action.await
            }
            None => {
                let filter = document(&req.filter, "filter")?;
                let projection = optional_document(&req.projection, "projection")?;
                let sort = optional_document(&req.sort, "sort")?;
                self.log.record_command(
                    &(find_text(
                        &req.db,
                        &req.coll,
                        &filter,
                        projection.as_ref(),
                        sort.as_ref(),
                        None,
                        limit,
                    ) + &options.cursor_text()),
                );
                let mut action = collection.find(filter);
                if let Some(projection) = projection {
                    action = action.projection(projection);
                }
                if let Some(sort) = sort {
                    action = action.sort(sort);
                }
                if let Some(limit) = limit {
                    action = action.limit(limit);
                }
                if let Some(collation) = options.collation() {
                    action = action.collation(collation);
                }
                if let Some(hint) = options.hint() {
                    action = action.hint(hint);
                }
                if let Some(limit) = options.max_time {
                    action = action.max_time(limit);
                }
                action.await
            }
        }
        .map_err(mongo_err)?;
        Ok(Box::pin(cursor.map_ok(json_doc).map_err(mongo_err)))
    }

    async fn perf(&self) -> Result<Value, EngineError> {
        // Not logged: the performance tab reads this every two seconds.
        // The lock table nobody charts stays on the server. (Leaving out
        // `metrics` would drop `mem` too.)
        let status = self
            .client
            .database("admin")
            .run_command(doc! { "serverStatus": 1, "locks": 0 })
            .await
            .map_err(mongo_err)?;
        let pick = |key: &str| status.get(key).cloned().unwrap_or(Bson::Null);
        let network = status.get_document("network").ok();
        let traffic = |key: &str| {
            network
                .and_then(|network| network.get(key).cloned())
                .unwrap_or(Bson::Null)
        };
        let mut perf = doc! {
            "time": pick("localTime"),
            "uptime": pick("uptime"),
            // "mongos" on a router, which has no `top` or `system.profile`.
            "process": pick("process"),
            "opcounters": pick("opcounters"),
            "connections": pick("connections"),
            "network": {
                "bytesIn": traffic("bytesIn"),
                "bytesOut": traffic("bytesOut"),
                "numRequests": traffic("numRequests"),
            },
            "mem": pick("mem"),
        };
        if let Some(repl) = status.get("opcountersRepl") {
            perf.insert("opcountersRepl", repl.clone());
        }
        if let Ok(cache) = status
            .get_document("wiredTiger")
            .and_then(|engine| engine.get_document("cache"))
        {
            let value = |key: &str| cache.get(key).cloned().unwrap_or(Bson::Null);
            perf.insert(
                "wiredTiger",
                doc! {
                    "cacheBytes": value("bytes currently in the cache"),
                    "cacheMax": value("maximum bytes configured"),
                    "dirtyBytes": value("tracked dirty bytes in the cache"),
                },
            );
        }
        if let Ok(lock) = status.get_document("globalLock") {
            let count = |section: &str, key: &str| {
                lock.get_document(section)
                    .ok()
                    .and_then(|section| section.get(key).cloned())
                    .unwrap_or(Bson::Null)
            };
            perf.insert(
                "globalLock",
                doc! {
                    "activeReaders": count("activeClients", "readers"),
                    "activeWriters": count("activeClients", "writers"),
                    "queueReaders": count("currentQueue", "readers"),
                    "queueWriters": count("currentQueue", "writers"),
                },
            );
        }
        Ok(json_doc(perf))
    }

    async fn update_preview(
        &self,
        req: &UpdatePreviewRequest,
    ) -> Result<UpdatePreview, EngineError> {
        let collection = self.collection(&req.db, &req.coll)?;
        let filter = document(&req.filter, "filter")?;
        let (update, update_text) = update_modifications(&req.update)?;
        let options = ReadOptions::of_write(&req.options)?;
        let target = shell::collection(&req.db, &req.coll);
        let mut fields = options.fields();
        fields.insert("maxTimeMS", whole(COUNT_LIMIT.as_millis()));
        self.log.record_command(&format!(
            "{target}.countDocuments({}, {})",
            shell::document(&filter),
            shell::document(&fields)
        ));
        let matched = {
            let (_running, tag) = Running::start(&self.running);
            let mut count = collection
                .count_documents(filter.clone())
                .max_time(COUNT_LIMIT)
                .comment(tag);
            if let Some(collation) = options.collation() {
                count = count.collation(collation);
            }
            if let Some(hint) = options.hint() {
                count = count.hint(hint);
            }
            match count.await.map_err(mongo_err) {
                Ok(count) => Some(count),
                Err(err) if timed_out(&err) => None,
                Err(err) => return Err(err),
            }
        };
        // Without transactions nothing could be undone: the count only.
        if self.topology == "standalone" {
            return Ok(UpdatePreview {
                matched,
                samples: Vec::new(),
                previewed: false,
            });
        }
        self.log.record_command(&format!(
            "// 미리보기: 트랜잭션 안에서 앞 {}건에 {target}.updateMany({}, {update_text}{})를 실행해 읽은 뒤 abortTransaction()",
            req.limit,
            shell::document(&filter),
            options.argument_text()
        ));
        let mut session = self.client.start_session().await.map_err(mongo_err)?;
        session.start_transaction().await.map_err(mongo_err)?;
        let samples = async {
            let mut find = collection.find(filter.clone()).limit(i64::from(req.limit));
            if let Some(collation) = options.collation() {
                find = find.collation(collation);
            }
            if let Some(hint) = options.hint() {
                find = find.hint(hint);
            }
            let mut cursor = find.session(&mut session).await?;
            let before: Vec<Document> = cursor.stream(&mut session).try_collect().await?;
            let mut samples = Vec::with_capacity(before.len());
            for doc in before {
                let id = doc.get("_id").cloned().unwrap_or(Bson::Null);
                // The filter stays in, so a positional `$` still finds its
                // array element; the collation too, so it matches the same way.
                let mut one = collection.update_one(
                    doc! { "$and": [filter.clone(), { "_id": id.clone() }] },
                    update.clone(),
                );
                if let Some(collation) = options.collation() {
                    one = one.collation(collation);
                }
                one.session(&mut session).await?;
                let after = collection
                    .find_one(doc! { "_id": id })
                    .session(&mut session)
                    .await?;
                samples.push(PreviewSample {
                    before: json_doc(doc),
                    after: after.map(json_doc).unwrap_or(Value::Null),
                });
            }
            Ok::<_, mongodb::error::Error>(samples)
        }
        .await;
        // Never committed: should the abort itself fail, the server drops
        // the transaction when the session ends.
        let _ = session.abort_transaction().await;
        Ok(UpdatePreview {
            matched,
            samples: samples.map_err(mongo_err)?,
            previewed: true,
        })
    }

    async fn search_indexes(&self, db: &str, coll: &str) -> Result<Vec<Value>, EngineError> {
        let collection = self.collection(db, coll)?;
        self.log.record_command(&format!(
            "{}.getSearchIndexes()",
            shell::collection(db, coll)
        ));
        let cursor = collection.list_search_indexes().await.map_err(search_err)?;
        let indexes: Vec<Document> = cursor.try_collect().await.map_err(search_err)?;
        Ok(indexes
            .into_iter()
            .map(|mut index| {
                // Servers before 7.0.x leave out the type of a plain index.
                if !index.contains_key("type") {
                    index.insert("type", "search");
                }
                json_doc(index)
            })
            .collect())
    }

    async fn create_search_index(&self, req: &SearchIndexRequest) -> Result<String, EngineError> {
        let collection = self.collection(&req.db, &req.coll)?;
        if req.name.is_empty() {
            return Err(bad("검색 인덱스 이름을 지정하세요"));
        }
        let definition = document(&req.definition, "definition")?;
        let kind = match req.kind.as_deref() {
            None | Some("") => None,
            Some("search") => Some(SearchIndexType::Search),
            Some("vectorSearch") => Some(SearchIndexType::VectorSearch),
            Some(other) => {
                return Err(bad(format!(
                    "검색 인덱스 종류는 search 또는 vectorSearch입니다: {other}"
                )))
            }
        };
        let mut spec = doc! { "name": &req.name };
        if let Some(kind) = req.kind.as_deref().filter(|kind| !kind.is_empty()) {
            spec.insert("type", kind);
        }
        spec.insert("definition", definition.clone());
        let text = format!(
            "{}.createSearchIndex({})",
            shell::collection(&req.db, &req.coll),
            shell::document(&spec)
        );
        self.log.record_command(&text);
        let started = Instant::now();
        let model = SearchIndexModel::builder()
            .name(req.name.clone())
            .index_type(kind)
            .definition(definition)
            .build();
        let name = collection
            .create_search_index(model)
            .await
            .map_err(search_err)?;
        self.changed(text, started, 1);
        Ok(name)
    }

    async fn update_search_index(&self, req: &SearchIndexRequest) -> Result<(), EngineError> {
        let collection = self.collection(&req.db, &req.coll)?;
        let definition = document(&req.definition, "definition")?;
        let text = format!(
            "{}.updateSearchIndex({}, {})",
            shell::collection(&req.db, &req.coll),
            shell::quote(&req.name),
            shell::document(&definition)
        );
        self.log.record_command(&text);
        let started = Instant::now();
        collection
            .update_search_index(&req.name, definition)
            .await
            .map_err(search_err)?;
        self.changed(text, started, 1);
        Ok(())
    }

    async fn drop_search_index(&self, req: &DropSearchIndexRequest) -> Result<(), EngineError> {
        let collection = self.collection(&req.db, &req.coll)?;
        let text = format!(
            "{}.dropSearchIndex({})",
            shell::collection(&req.db, &req.coll),
            shell::quote(&req.name)
        );
        self.log.record_command(&text);
        let started = Instant::now();
        collection
            .drop_search_index(&req.name)
            .await
            .map_err(search_err)?;
        self.changed(text, started, 1);
        Ok(())
    }

    async fn watch(&self, req: &WatchRequest) -> Result<DocStream, EngineError> {
        if req.db.is_empty() {
            return Err(bad("데이터베이스를 지정하세요"));
        }
        if self.topology == "standalone" {
            return Err(EngineError::Unsupported(
                "변경 스트림은 레플리카셋이나 샤드 클러스터에서만 열 수 있습니다 (이 서버는 단일 서버입니다)"
                    .into(),
            ));
        }
        let stages = pipeline(req.pipeline.as_deref().unwrap_or_default())?;
        let mut options = Document::new();
        let full_document = match req.full_document.as_deref() {
            None | Some("") | Some("default") => None,
            Some("updateLookup") => Some(FullDocumentType::UpdateLookup),
            Some("whenAvailable") => Some(FullDocumentType::WhenAvailable),
            Some("required") => Some(FullDocumentType::Required),
            Some(other) => {
                return Err(bad(format!("fullDocument 값이 올바르지 않습니다: {other}")))
            }
        };
        if full_document.is_some() {
            options.insert("fullDocument", req.full_document.as_deref());
        }
        let before_change = match req.full_document_before_change.as_deref() {
            None | Some("") => None,
            Some("off") => Some(FullDocumentBeforeChangeType::Off),
            Some("whenAvailable") => Some(FullDocumentBeforeChangeType::WhenAvailable),
            Some("required") => Some(FullDocumentBeforeChangeType::Required),
            Some(other) => {
                return Err(bad(format!(
                    "fullDocumentBeforeChange 값이 올바르지 않습니다: {other}"
                )))
            }
        };
        if before_change.is_some() {
            options.insert(
                "fullDocumentBeforeChange",
                req.full_document_before_change.as_deref(),
            );
        }
        let resume_after = match &req.resume_after {
            None | Some(Value::Null) => None,
            Some(token) => {
                let token = document(token, "resumeAfter")?;
                options.insert("resumeAfter", token.clone());
                Some(
                    mongodb::bson::from_document::<ResumeToken>(token)
                        .map_err(|err| bad(format!("resumeAfter가 올바르지 않습니다: {err}")))?,
                )
            }
        };
        let database = self.client.database(&req.db);
        let coll = req.coll.as_deref().filter(|coll| !coll.is_empty());
        let collection = coll.map(|coll| database.collection::<Document>(coll));
        let (target, mut action) = match (coll, &collection) {
            (Some(coll), Some(collection)) => {
                (shell::collection(&req.db, coll), collection.watch())
            }
            _ => (shell::database(&req.db), database.watch()),
        };
        let mut text = format!("{target}.watch({}", pipeline_text(&stages));
        if !options.is_empty() {
            text.push_str(&format!(", {}", shell::document(&options)));
        }
        text.push(')');
        self.log.record_command(&text);
        action = action.pipeline(stages);
        if let Some(full_document) = full_document {
            action = action.full_document(full_document);
        }
        if let Some(before_change) = before_change {
            action = action.full_document_before_change(before_change);
        }
        if let Some(token) = resume_after {
            action = action.resume_after(token);
        }
        // Not tagged: it waits for changes for as long as the page reads it,
        // and closes when the page goes away.
        let stream = action.await.map_err(mongo_err)?;
        Ok(Box::pin(
            stream
                .with_type::<Document>()
                .map_ok(json_doc)
                .map_err(mongo_err),
        ))
    }

    async fn gridfs_buckets(&self, db: &str) -> Result<Vec<String>, EngineError> {
        self.buckets(db).await
    }

    async fn gridfs_files(&self, req: &GridFsFilesRequest) -> Result<Vec<Value>, EngineError> {
        self.files(req).await
    }

    async fn gridfs_download(&self, req: &GridFsFileRef) -> Result<GridFsDownload, EngineError> {
        self.download(req).await
    }

    async fn gridfs_upload(
        &self,
        req: &GridFsUploadRequest,
        body: ByteReader,
    ) -> Result<Value, EngineError> {
        self.upload(req, body).await
    }

    async fn gridfs_delete(&self, req: &GridFsFileRef) -> Result<(), EngineError> {
        self.delete_file(req).await
    }

    async fn cursor(&self, req: &CursorOpenRequest) -> Result<DocStream, EngineError> {
        let collection = self.collection(&req.db, &req.coll)?;
        let target = shell::collection(&req.db, &req.coll);
        // Not tagged: it stays open between the page's reads, which only
        // closing it (or going idle) ends.
        let cursor = match (&req.find, &req.aggregate) {
            (Some(find), None) => {
                let filter = document(&find.filter, "filter")?;
                let projection = optional_document(&find.projection, "projection")?;
                let sort = optional_document(&find.sort, "sort")?;
                let options = ReadOptions::of(&find.options)?;
                let limit = find.limit.filter(|limit| *limit > 0);
                self.log.record_command(&format!(
                    "{}{}.batchSize({})",
                    find_text(
                        &req.db,
                        &req.coll,
                        &filter,
                        projection.as_ref(),
                        sort.as_ref(),
                        find.skip,
                        limit,
                    ),
                    options.cursor_text(),
                    req.batch_size
                ));
                let mut action = collection.find(filter).batch_size(req.batch_size);
                if let Some(projection) = projection {
                    action = action.projection(projection);
                }
                if let Some(sort) = sort {
                    action = action.sort(sort);
                }
                if let Some(skip) = find.skip {
                    action = action.skip(skip);
                }
                if let Some(limit) = limit {
                    action = action.limit(limit);
                }
                if let Some(collation) = options.collation() {
                    action = action.collation(collation);
                }
                if let Some(hint) = options.hint() {
                    action = action.hint(hint);
                }
                if let Some(limit) = options.max_time {
                    action = action.max_time(limit);
                }
                action.await.map_err(mongo_err)?
            }
            (None, Some(aggregate)) => {
                let stages = pipeline(&aggregate.pipeline)?;
                let writes = pipeline_writes(&aggregate.pipeline);
                let options = ReadOptions::of(&aggregate.options)?;
                let mut shown = options.fields();
                shown.insert("batchSize", whole(u128::from(req.batch_size)));
                let text = format!(
                    "{target}.aggregate({}, {})",
                    pipeline_text(&stages),
                    shell::document(&shown)
                );
                self.log.record_command(&text);
                let started = Instant::now();
                let mut action = collection.aggregate(stages).batch_size(req.batch_size);
                if let Some(collation) = options.collation() {
                    action = action.collation(collation);
                }
                if let Some(hint) = options.hint() {
                    action = action.hint(hint);
                }
                if let Some(limit) = options.max_time {
                    action = action.max_time(limit);
                }
                let cursor = action.await.map_err(mongo_err)?;
                // `$out` and `$merge` have written once the aggregation opened.
                if writes {
                    self.changed(text, started, 1);
                }
                cursor
            }
            _ => return Err(bad("find 또는 aggregate 중 하나를 지정하세요")),
        };
        Ok(Box::pin(cursor.map_ok(json_doc).map_err(mongo_err)))
    }
}

/// Whether a read stopped at its maxTimeMS.
fn timed_out(err: &EngineError) -> bool {
    matches!(err, EngineError::Driver { code, .. }
        if code.as_deref() == Some(&MAX_TIME_EXPIRED.to_string()))
}

/// The codes a server without Atlas Search answers its commands with:
/// SearchNotEnabled, the stage only Atlas runs, an unknown stage or command.
const SEARCH_MISSING: [&str; 5] = ["31082", "6047401", "40324", "59", "115"];

/// A search index command's error; on a server without search, one that
/// says so.
fn search_err(err: mongodb::error::Error) -> EngineError {
    match mongo_err(err) {
        EngineError::Driver {
            code: Some(code),
            message,
            ..
        } if SEARCH_MISSING.contains(&code.as_str()) => EngineError::Unsupported(format!(
            "이 서버는 Atlas Search 인덱스를 지원하지 않습니다. Atlas 클러스터나 검색(mongot)이 있는 서버에서 쓸 수 있습니다 (MongoDB: {message})"
        )),
        other => other,
    }
}
