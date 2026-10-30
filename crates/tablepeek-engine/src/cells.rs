//! What the engines' binary cells (`capabilities.binary_cells`) share: the
//! stream a cell's value goes out on, a piece at a time, and the upload cut
//! into pieces of the size a write wants, so a value of any size never sits
//! whole in memory.

use std::future::Future;
use std::sync::{Arc, Mutex, PoisonError};

use futures_util::StreamExt;
use tokio::sync::{mpsc, oneshot};

use crate::driver::FileStream;
use crate::EngineError;

/// How much of a value one read sends, and the least one append writes.
pub(crate) const PIECE: usize = 1 << 20;

/// The most one append writes. An engine that rewrites the whole value on
/// each append (PostgreSQL, MySQL, SQL Server's image) appends pieces as
/// large as what it already holds, up to this, so the bytes it rewrites in
/// all stay a small multiple of the value's size.
const MAX_APPEND: usize = 16 << 20;

/// The size of the next append after `written` bytes.
pub(crate) fn append_size(written: u64) -> usize {
    usize::try_from(written)
        .unwrap_or(MAX_APPEND)
        .clamp(PIECE, MAX_APPEND)
}

pub(crate) fn no_key() -> EngineError {
    EngineError::NotEditable("기본 키가 없어 행을 찾을 수 없습니다".into())
}

pub(crate) fn not_binary(column: &str) -> EngineError {
    EngineError::BadRequest(format!("바이너리 컬럼이 아닙니다: {column}"))
}

pub(crate) fn null_value() -> EngineError {
    EngineError::BadRequest("값이 NULL입니다".into())
}

pub(crate) fn no_row() -> EngineError {
    EngineError::NotFound("이 키의 행이 없습니다. 다른 곳에서 지워졌거나 키가 바뀌었습니다".into())
}

/// A value past what the column or the server takes: `limit` bytes, and
/// what sets it (a column type, a server setting).
pub(crate) fn too_large(limit: u64, what: &str) -> EngineError {
    EngineError::BadRequest(format!(
        "값이 너무 큽니다: {limit}바이트까지만 쓸 수 있습니다 ({what})"
    ))
}

/// Where the answer to whether a read found its value goes.
type Answer = oneshot::Sender<Result<(), EngineError>>;

/// The answer to whether a read found its value: given once, by whichever
/// comes first.
#[derive(Clone)]
pub(crate) struct Found(Arc<Mutex<Option<Answer>>>);

impl Found {
    /// The value is there: its pieces follow.
    pub(crate) fn yes(&self) {
        let _ = self.answer(Ok(()));
    }

    /// Gives `outcome` as the answer; hands an error back when the answer
    /// was given already.
    fn answer(&self, outcome: Result<(), EngineError>) -> Option<EngineError> {
        let sender = self.0.lock().unwrap_or_else(PoisonError::into_inner).take();
        match sender {
            Some(sender) => {
                let _ = sender.send(outcome);
                None
            }
            None => outcome.err(),
        }
    }
}

/// Where a read sends the value's pieces.
#[derive(Clone)]
pub(crate) struct Pieces(mpsc::Sender<Result<Vec<u8>, EngineError>>);

impl Pieces {
    /// Sends a piece; false once the download has stopped.
    pub(crate) async fn send(&self, piece: Vec<u8>) -> bool {
        self.0.send(Ok(piece)).await.is_ok()
    }

    /// `send` from a blocking thread.
    pub(crate) fn blocking_send(&self, piece: Vec<u8>) -> bool {
        self.0.blocking_send(Ok(piece)).is_ok()
    }
}

/// Runs `read` on its own task: it looks the cell up, says `Found::yes`,
/// then sends the value through `Pieces`. An error before `yes` is this
/// call's; one after ends the stream with it, so a broken read never passes
/// for the whole value.
pub(crate) async fn read_stream<F, Fut>(read: F) -> Result<FileStream, EngineError>
where
    F: FnOnce(Found, Pieces) -> Fut,
    Fut: Future<Output = Result<(), EngineError>> + Send + 'static,
{
    let (answer, ready) = oneshot::channel();
    let found = Found(Arc::new(Mutex::new(Some(answer))));
    let (sender, received) = mpsc::channel(2);
    let pieces = Pieces(sender);
    let task = read(found.clone(), pieces.clone());
    tokio::spawn(async move {
        let outcome = task.await;
        if let Some(err) = found.answer(outcome) {
            let _ = pieces.0.send(Err(err)).await;
        }
    });
    match ready.await {
        Ok(Ok(())) => {}
        Ok(Err(err)) => return Err(err),
        Err(_) => {
            return Err(EngineError::Internal(
                "바이너리 값을 읽지 못했습니다".into(),
            ))
        }
    }
    Ok(Box::pin(futures_util::stream::unfold(
        received,
        |mut received| async move { received.recv().await.map(|piece| (piece, received)) },
    )))
}

/// An upload cut into pieces of the size each write asks for.
pub(crate) struct Chunks {
    data: FileStream,
    buffer: Vec<u8>,
    ended: bool,
    /// The bytes handed out so far.
    pub(crate) taken: u64,
}

impl Chunks {
    pub(crate) fn new(data: FileStream) -> Self {
        Self {
            data,
            buffer: Vec::new(),
            ended: false,
            taken: 0,
        }
    }

    /// The next `size` bytes (fewer at the end), or None once all are
    /// taken; an upload that broke off is the error it brought.
    pub(crate) async fn next(&mut self, size: usize) -> Result<Option<Vec<u8>>, EngineError> {
        while !self.ended && self.buffer.len() < size {
            match self.data.next().await {
                Some(piece) => self.buffer.extend_from_slice(&piece?),
                None => self.ended = true,
            }
        }
        if self.buffer.is_empty() {
            return Ok(None);
        }
        let rest = if self.buffer.len() > size {
            self.buffer.split_off(size)
        } else {
            Vec::new()
        };
        let chunk = std::mem::replace(&mut self.buffer, rest);
        self.taken += chunk.len() as u64;
        Ok(Some(chunk))
    }

    /// The whole upload as one value, refused past `limit` bytes (what the
    /// column or the server takes) as soon as it gets there.
    pub(crate) async fn whole(&mut self, limit: u64, what: &str) -> Result<Vec<u8>, EngineError> {
        let mut bytes = Vec::new();
        while let Some(chunk) = self.next(PIECE).await? {
            bytes.extend_from_slice(&chunk);
            if bytes.len() as u64 > limit {
                return Err(too_large(limit, what));
            }
        }
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests;
