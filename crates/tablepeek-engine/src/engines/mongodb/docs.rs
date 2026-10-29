//! MongoDB's document operations. Requests and replies are canonical
//! Extended JSON: Decimal128, Int64, dates and ids keep their types both ways.

use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures_util::TryStreamExt;
use mongodb::bson::{doc, Bson, Document};
use mongodb::options::IndexOptions;
use mongodb::{Collection, IndexModel};
use serde_json::{json, Value};

use super::{mongo_err, shell, MongoDriver, Running};
use crate::driver::{
    command_writes, pipeline_writes, AggregateRequest, CollectionInfo, CommandRequest,
    CountRequest, CountResult, CreateIndexRequest, DeleteRequest, DistinctRequest, DocBatch,
    DocDatabase, DocStream, DocumentDriver, DropIndexRequest, ExplainRequest, ExportRequest,
    FindRequest, InsertFailure, InsertOutcome, InsertRequest, ReplaceRequest, UpdateOutcome,
    UpdateRequest,
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

fn bad(message: impl Into<String>) -> EngineError {
    EngineError::BadRequest(message.into())
}

/// A value of the request, read as Extended JSON.
fn bson(value: &Value) -> Result<Bson, EngineError> {
    Bson::try_from(value.clone()).map_err(|err| bad(format!("EJSON 값이 올바르지 않습니다: {err}")))
}

/// A document of the request (a filter, an update, …); null reads as empty.
fn document(value: &Value, what: &str) -> Result<Document, EngineError> {
    match value {
        Value::Null => Ok(Document::new()),
        _ => match bson(value)? {
            Bson::Document(doc) => Ok(doc),
            _ => Err(bad(format!("{what}은(는) 객체여야 합니다"))),
        },
    }
}

fn optional_document(value: &Option<Value>, what: &str) -> Result<Option<Document>, EngineError> {
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
fn json_of(value: Bson) -> Value {
    value.into_canonical_extjson()
}

fn json_doc(doc: Document) -> Value {
    json_of(Bson::Document(doc))
}

fn pipeline_text(stages: &[Document]) -> String {
    let items: Vec<String> = stages.iter().map(shell::document).collect();
    format!("[{}]", items.join(", "))
}

/// A find as the shell writes it: `db.c.find({…}, {…}).sort({…}).skip(n).limit(n)`.
fn find_text(
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

fn elapsed_ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

impl MongoDriver {
    fn collection(&self, db: &str, coll: &str) -> Result<Collection<Document>, EngineError> {
        if db.is_empty() || coll.is_empty() {
            return Err(bad("데이터베이스와 컬렉션을 지정하세요"));
        }
        Ok(self.client.database(db).collection(coll))
    }

    /// A write that went through, for History (cut like the console's).
    fn changed(&self, text: String, started: Instant, rows: u64) {
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
        let text = find_text(
            &req.db,
            &req.coll,
            &filter,
            projection.as_ref(),
            sort.as_ref(),
            req.skip,
            Some(req.limit),
        );
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
        if let Some(limit) = max_time(req.max_time_ms) {
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
        let target = shell::collection(&req.db, &req.coll);
        let (_running, tag) = Running::start(&self.running);
        if filter.is_empty() {
            self.log
                .record_command(&format!("{target}.estimatedDocumentCount()"));
            let count = collection
                .estimated_document_count()
                .comment(tag)
                .await
                .map_err(mongo_err)?;
            return Ok(CountResult {
                count: Some(count),
                exact: false,
            });
        }
        self.log.record_command(&format!(
            "{target}.countDocuments({}, {{ maxTimeMS: {} }})",
            shell::document(&filter),
            COUNT_LIMIT.as_millis()
        ));
        match collection
            .count_documents(filter)
            .max_time(COUNT_LIMIT)
            .comment(tag)
            .await
        {
            Ok(count) => Ok(CountResult {
                count: Some(count),
                exact: true,
            }),
            // Too many to count in time: the page shows "many".
            Err(err) => match mongo_err(err) {
                EngineError::Driver { code, .. }
                    if code.as_deref() == Some(&MAX_TIME_EXPIRED.to_string()) =>
                {
                    Ok(CountResult {
                        count: None,
                        exact: false,
                    })
                }
                other => Err(other),
            },
        }
    }

    async fn aggregate(&self, req: &AggregateRequest) -> Result<DocBatch, EngineError> {
        let collection = self.collection(&req.db, &req.coll)?;
        let stages = pipeline(&req.pipeline)?;
        let writes = pipeline_writes(&req.pipeline);
        let text = format!(
            "{}.aggregate({})",
            shell::collection(&req.db, &req.coll),
            pipeline_text(&stages)
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
        if let Some(limit) = max_time(req.max_time_ms) {
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
        // An update is a document of operators or a pipeline of stages.
        let (update, update_text) = match &req.update {
            Value::Array(stages) => {
                let stages = pipeline(stages)?;
                let text = pipeline_text(&stages);
                (
                    mongodb::options::UpdateModifications::Pipeline(stages),
                    text,
                )
            }
            other => {
                let doc = document(other, "update")?;
                let text = shell::document(&doc);
                (mongodb::options::UpdateModifications::Document(doc), text)
            }
        };
        let method = if req.many { "updateMany" } else { "updateOne" };
        let mut text = format!(
            "{}.{method}({}, {update_text}",
            shell::collection(&req.db, &req.coll),
            shell::document(&filter)
        );
        if req.upsert {
            text.push_str(", { upsert: true }");
        }
        text.push(')');
        self.log.record_command(&text);
        let started = Instant::now();
        let result = if req.many {
            collection
                .update_many(filter, update)
                .upsert(req.upsert)
                .await
        } else {
            collection
                .update_one(filter, update)
                .upsert(req.upsert)
                .await
        }
        .map_err(mongo_err)?;
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
        let text = format!(
            "{}.replaceOne({}, {})",
            shell::collection(&req.db, &req.coll),
            shell::document(&filter),
            shell::document(&replacement)
        );
        self.log.record_command(&text);
        let started = Instant::now();
        let result = collection
            .replace_one(filter, replacement)
            .await
            .map_err(mongo_err)?;
        self.changed(text, started, result.modified_count);
        Ok(UpdateOutcome {
            matched: result.matched_count,
            modified: result.modified_count,
        })
    }

    async fn delete(&self, req: &DeleteRequest) -> Result<u64, EngineError> {
        let collection = self.collection(&req.db, &req.coll)?;
        let filter = document(&req.filter, "filter")?;
        let method = if req.many { "deleteMany" } else { "deleteOne" };
        let text = format!(
            "{}.{method}({})",
            shell::collection(&req.db, &req.coll),
            shell::document(&filter)
        );
        self.log.record_command(&text);
        let started = Instant::now();
        let result = if req.many {
            collection.delete_many(filter).await
        } else {
            collection.delete_one(filter).await
        }
        .map_err(mongo_err)?;
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
        let (command, text) = match (&req.find, &req.aggregate) {
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
                (command, text)
            }
            (None, Some(aggregate)) => {
                let stages = pipeline(&aggregate.pipeline)?;
                let text = format!("{target}.aggregate({})", pipeline_text(&stages));
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
        self.log
            .record_command(&format!("{text}.explain({})", shell::quote(&req.verbosity)));
        let (_running, tag) = Running::start(&self.running);
        let reply = self
            .client
            .database(&req.db)
            .run_command(doc! {
                "explain": command,
                "verbosity": &req.verbosity,
                "comment": tag,
            })
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
                    "{}.aggregate({})",
                    shell::collection(&req.db, &req.coll),
                    pipeline_text(&stages)
                ));
                collection.aggregate(stages).await
            }
            None => {
                let filter = document(&req.filter, "filter")?;
                let projection = optional_document(&req.projection, "projection")?;
                let sort = optional_document(&req.sort, "sort")?;
                self.log.record_command(&find_text(
                    &req.db,
                    &req.coll,
                    &filter,
                    projection.as_ref(),
                    sort.as_ref(),
                    None,
                    limit,
                ));
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
}
