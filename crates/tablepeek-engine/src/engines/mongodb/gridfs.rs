//! GridFS buckets through the driver's bucket API. Files go in and out as
//! streams: an upload is written chunk by chunk as the request body
//! arrives, a download read chunk by chunk as the reply is sent. The
//! console and History write these as `mongofiles` would be run.

use std::collections::HashSet;
use std::time::Instant;

use futures_util::io::{AsyncReadExt, AsyncWriteExt};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, Bson, Document};
use mongodb::error::{ErrorKind, GridFsErrorKind};
use mongodb::gridfs::GridFsBucket;
use mongodb::options::GridFsBucketOptions;
use serde_json::Value;

use super::docs::{bad, bson, document, find_text, json_doc, json_of, optional_document};
use super::{mongo_err, MongoDriver};
use crate::driver::{
    ByteReader, GridFsDownload, GridFsFileRef, GridFsFilesRequest, GridFsUploadRequest,
};
use crate::EngineError;

/// The chunk size the driver writes with, and reads by when a file's
/// document doesn't say.
const DEFAULT_CHUNK: usize = 255 * 1024;

/// `mongofiles --db=… --prefix=… <command>`.
fn mongofiles(db: &str, bucket: &str, command: &str) -> String {
    format!(
        "mongofiles --db={} --prefix={} {command}",
        shell_word(db),
        shell_word(bucket)
    )
}

/// A word a POSIX shell reads as it is: in single quotes when it needs them.
fn shell_word(text: &str) -> String {
    let plain = !text.is_empty()
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:@".contains(c));
    if plain {
        text.to_string()
    } else {
        format!("'{}'", text.replace('\'', r"'\''"))
    }
}

/// A file id as mongofiles takes it: Extended JSON (`{"$oid":"…"}`).
fn id_word(id: &Bson) -> String {
    shell_word(&id.clone().into_relaxed_extjson().to_string())
}

/// A failure of the bytes on their way: the driver's error inside it where
/// there is one.
fn io_err(err: std::io::Error) -> EngineError {
    match err
        .into_inner()
        .map(|inner| inner.downcast::<mongodb::error::Error>())
    {
        Some(Ok(driver)) => mongo_err(*driver),
        Some(Err(other)) => EngineError::Internal(other.to_string()),
        None => EngineError::Internal("파일 전송이 중간에 끊겼습니다".into()),
    }
}

/// A missing file as `not_found`; any other failure as the driver's.
fn file_err(err: mongodb::error::Error, id: &Bson) -> EngineError {
    match err.kind.as_ref() {
        ErrorKind::GridFs(GridFsErrorKind::FileNotFound { .. }) => {
            EngineError::NotFound(id.clone().into_relaxed_extjson().to_string())
        }
        _ => mongo_err(err),
    }
}

impl MongoDriver {
    fn bucket(&self, db: &str, bucket: &str) -> Result<GridFsBucket, EngineError> {
        if db.is_empty() || bucket.is_empty() {
            return Err(bad("데이터베이스와 버킷을 지정하세요"));
        }
        Ok(self.client.database(db).gridfs_bucket(
            GridFsBucketOptions::builder()
                .bucket_name(bucket.to_string())
                .build(),
        ))
    }

    pub(super) async fn buckets(&self, db: &str) -> Result<Vec<String>, EngineError> {
        if db.is_empty() {
            return Err(bad("데이터베이스를 지정하세요"));
        }
        self.log.record_command(&format!(
            "{}.getCollectionNames()",
            super::shell::database(db)
        ));
        let names: HashSet<String> = self
            .client
            .database(db)
            .list_collection_names()
            .await
            .map_err(mongo_err)?
            .into_iter()
            .collect();
        let mut buckets: Vec<String> = names
            .iter()
            .filter_map(|name| name.strip_suffix(".files"))
            .filter(|prefix| names.contains(&format!("{prefix}.chunks")))
            .map(str::to_string)
            .collect();
        buckets.sort();
        Ok(buckets)
    }

    /// The bucket's `.files` documents as stored: any field an uploader
    /// added (`contentType`, `md5`, …) comes along.
    pub(super) async fn files(&self, req: &GridFsFilesRequest) -> Result<Vec<Value>, EngineError> {
        if req.bucket.is_empty() {
            return Err(bad("버킷을 지정하세요"));
        }
        let files = format!("{}.files", req.bucket);
        let collection = self.collection(&req.db, &files)?;
        let filter = document(&req.filter, "filter")?;
        let sort = optional_document(&req.sort, "sort")?;
        self.log.record_command(&find_text(
            &req.db,
            &files,
            &filter,
            None,
            sort.as_ref(),
            req.skip,
            Some(req.limit),
        ));
        let mut action = collection.find(filter).limit(req.limit);
        if let Some(sort) = sort {
            action = action.sort(sort);
        }
        if let Some(skip) = req.skip {
            action = action.skip(skip);
        }
        let docs: Vec<Document> = action
            .await
            .map_err(mongo_err)?
            .try_collect()
            .await
            .map_err(mongo_err)?;
        Ok(docs.into_iter().map(json_doc).collect())
    }

    pub(super) async fn download(
        &self,
        req: &GridFsFileRef,
    ) -> Result<GridFsDownload, EngineError> {
        let bucket = self.bucket(&req.db, &req.bucket)?;
        let id = bson(&req.id)?;
        self.log.record_command(&mongofiles(
            &req.db,
            &req.bucket,
            &format!("get_id {}", id_word(&id)),
        ));
        let file = self
            .client
            .database(&req.db)
            .collection::<Document>(&format!("{}.files", req.bucket))
            .find_one(doc! { "_id": id.clone() })
            .await
            .map_err(mongo_err)?
            .ok_or_else(|| EngineError::NotFound(id.clone().into_relaxed_extjson().to_string()))?;
        let chunk = file
            .get("chunkSize")
            .and_then(super::number)
            .map(|size| size as usize)
            .filter(|size| *size > 0)
            .unwrap_or(DEFAULT_CHUNK);
        let reader = bucket
            .open_download_stream(id.clone())
            .await
            .map_err(|err| file_err(err, &id))?;
        // One chunk's worth at a time, each handed on as it was read.
        let bytes = futures_util::stream::try_unfold(reader, move |mut reader| async move {
            let mut buf = vec![0u8; chunk];
            let read = reader.read(&mut buf).await.map_err(io_err)?;
            if read == 0 {
                return Ok(None);
            }
            buf.truncate(read);
            Ok(Some((buf, reader)))
        });
        Ok(GridFsDownload {
            filename: file.get_str("filename").ok().map(str::to_string),
            length: file
                .get("length")
                .and_then(super::number)
                .map_or(0, |length| length as u64),
            content_type: file.get_str("contentType").ok().map(str::to_string),
            file: json_doc(file),
            bytes: Box::pin(bytes),
        })
    }

    pub(super) async fn upload(
        &self,
        req: &GridFsUploadRequest,
        body: ByteReader,
    ) -> Result<Value, EngineError> {
        let bucket = self.bucket(&req.db, &req.bucket)?;
        if req.filename.is_empty() {
            return Err(bad("파일 이름을 지정하세요"));
        }
        let metadata = optional_document(&req.metadata, "metadata")?;
        let mut text = mongofiles(
            &req.db,
            &req.bucket,
            &format!("put {}", shell_word(&req.filename)),
        );
        if let Some(metadata) = &metadata {
            text.push_str(&format!(
                " # metadata: {}",
                super::shell::document(metadata)
            ));
        }
        self.log.record_command(&text);
        let started = Instant::now();
        let mut action = bucket.open_upload_stream(&req.filename);
        if let Some(metadata) = metadata {
            action = action.metadata(metadata);
        }
        let mut upload = action.await.map_err(mongo_err)?;
        // Chunks go to the server as they fill; a body that breaks off
        // takes the ones written with it.
        if let Err(err) = futures_util::io::copy_buf(body, &mut upload).await {
            let _ = upload.abort().await;
            return Err(io_err(err));
        }
        upload.close().await.map_err(io_err)?;
        let id = upload.id().clone();
        self.changed(text, started, 1);
        Ok(json_of(id))
    }

    pub(super) async fn delete_file(&self, req: &GridFsFileRef) -> Result<(), EngineError> {
        let bucket = self.bucket(&req.db, &req.bucket)?;
        let id = bson(&req.id)?;
        let text = mongofiles(&req.db, &req.bucket, &format!("delete_id {}", id_word(&id)));
        self.log.record_command(&text);
        let started = Instant::now();
        bucket
            .delete(id.clone())
            .await
            .map_err(|err| file_err(err, &id))?;
        self.changed(text, started, 1);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mongofiles_lines_quote_what_the_shell_would_split() {
        assert_eq!(
            mongofiles("shop", "fs", "put report.pdf"),
            "mongofiles --db=shop --prefix=fs put report.pdf"
        );
        assert_eq!(shell_word("월간 보고서.pdf"), "'월간 보고서.pdf'");
        assert_eq!(shell_word("it's"), r"'it'\''s'");
        assert_eq!(shell_word(""), "''");
        let id = Bson::ObjectId("65f1a0c2b7e4d3a1f0e9c8b7".parse().unwrap());
        assert_eq!(id_word(&id), r#"'{"$oid":"65f1a0c2b7e4d3a1f0e9c8b7"}'"#);
    }
}
