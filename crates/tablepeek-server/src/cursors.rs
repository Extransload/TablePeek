//! Cursors a document store's page keeps open between requests (the shell
//! tab's `find()`/`aggregate()` cursors). Each connection slot holds its own
//! table; a cursor is the engine's document stream, whose server cursor
//! closes when it is dropped: once read to the end, on `close`, when the
//! slot goes away, when it sat unread for the idle limit, or when a newer
//! one pushes it past the cap.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError, Weak};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::Value;
use tablepeek_engine::driver::DocStream;
use tablepeek_engine::EngineError;

/// How many cursors one connection keeps open; a newer one closes the one
/// read longest ago.
pub const CURSOR_CAP: usize = 32;
/// How long a cursor may sit unread before it is closed (MongoDB's own
/// default cursor timeout).
pub const CURSOR_IDLE: Duration = Duration::from_secs(10 * 60);

struct Entry {
    /// None while a request is reading it.
    stream: Option<DocStream>,
    used: Instant,
    /// The batch size it was opened with: `next`'s default.
    batch: u32,
}

struct Inner {
    open: HashMap<String, Entry>,
    idle: Duration,
    /// A sweeper task is running for this table.
    sweeping: bool,
}

/// Why a cursor can't be read.
#[derive(Debug, PartialEq, Eq)]
pub enum CursorMiss {
    /// Closed, read to the end, timed out, or never opened.
    Gone,
    /// Another request is reading it now.
    Busy,
}

pub struct CursorTable {
    inner: Arc<Mutex<Inner>>,
}

impl Default for CursorTable {
    fn default() -> Self {
        Self::with_idle(CURSOR_IDLE)
    }
}

impl CursorTable {
    pub fn with_idle(idle: Duration) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                open: HashMap::new(),
                idle,
                sweeping: false,
            })),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Keeps `stream` open under a new id, closing the cursor read longest
    /// ago past the cap. `batch` is the size its reads default to.
    pub fn insert(&self, stream: DocStream, batch: u32) -> String {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let start_sweeper = {
            let mut inner = self.lock();
            while inner.open.len() >= CURSOR_CAP {
                let oldest = inner
                    .open
                    .iter()
                    .min_by_key(|(_, entry)| (entry.stream.is_none(), entry.used))
                    .map(|(id, _)| id.clone());
                match oldest {
                    Some(oldest) => inner.open.remove(&oldest),
                    None => break,
                };
            }
            inner.open.insert(
                id.clone(),
                Entry {
                    stream: Some(stream),
                    used: Instant::now(),
                    batch,
                },
            );
            !std::mem::replace(&mut inner.sweeping, true)
        };
        if start_sweeper {
            tokio::spawn(sweep(Arc::downgrade(&self.inner)));
        }
        id
    }

    /// Takes the cursor out for one read, with its batch size; `put_back`
    /// returns it.
    pub fn take(&self, id: &str) -> Result<(DocStream, u32), CursorMiss> {
        let mut inner = self.lock();
        let entry = inner.open.get_mut(id).ok_or(CursorMiss::Gone)?;
        let stream = entry.stream.take().ok_or(CursorMiss::Busy)?;
        entry.used = Instant::now();
        Ok((stream, entry.batch))
    }

    /// Returns a cursor after a read; one closed meanwhile is dropped.
    pub fn put_back(&self, id: &str, stream: DocStream) {
        let mut inner = self.lock();
        if let Some(entry) = inner.open.get_mut(id) {
            entry.stream = Some(stream);
            entry.used = Instant::now();
        }
    }

    /// Closes a cursor; false if there was none.
    pub fn close(&self, id: &str) -> bool {
        // Dropped outside the lock.
        let entry = self.lock().open.remove(id);
        entry.is_some()
    }

    /// Closes every cursor (the slot is going away).
    pub fn close_all(&self) {
        let open = std::mem::take(&mut self.lock().open);
        drop(open);
    }

    #[cfg(test)]
    pub fn open_count(&self) -> usize {
        self.lock().open.len()
    }

    #[cfg(test)]
    pub fn set_idle(&self, idle: Duration) {
        self.lock().idle = idle;
    }

    #[cfg(test)]
    pub fn contains(&self, id: &str) -> bool {
        self.lock().open.contains_key(id)
    }
}

/// Closes the cursors left unread past the idle limit, every quarter of it,
/// while the table has any.
async fn sweep(table: Weak<Mutex<Inner>>) {
    loop {
        let idle = match table.upgrade() {
            Some(inner) => inner.lock().unwrap_or_else(PoisonError::into_inner).idle,
            None => return,
        };
        tokio::time::sleep((idle / 4).clamp(Duration::from_millis(10), Duration::from_secs(30)))
            .await;
        let Some(inner) = table.upgrade() else {
            return;
        };
        let expired: Vec<Entry> = {
            let mut inner = inner.lock().unwrap_or_else(PoisonError::into_inner);
            let idle = inner.idle;
            let ids: Vec<String> = inner
                .open
                .iter()
                .filter(|(_, entry)| entry.stream.is_some() && entry.used.elapsed() >= idle)
                .map(|(id, _)| id.clone())
                .collect();
            let expired = ids.iter().filter_map(|id| inner.open.remove(id)).collect();
            if inner.open.is_empty() {
                inner.sweeping = false;
                return;
            }
            expired
        };
        drop(expired);
    }
}

/// Up to `size` documents from `stream`, and whether it has ended.
pub async fn read_batch(
    stream: &mut DocStream,
    size: usize,
) -> Result<(Vec<Value>, bool), EngineError> {
    let mut batch = Vec::with_capacity(size);
    while batch.len() < size {
        match stream.next().await {
            Some(doc) => batch.push(doc?),
            None => return Ok((batch, true)),
        }
    }
    Ok((batch, false))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn numbers(count: usize) -> DocStream {
        Box::pin(futures_util::stream::iter(
            (0..count).map(|n| Ok(serde_json::json!({ "n": n }))),
        ))
    }

    #[tokio::test]
    async fn batches_end_and_the_table_closes_what_it_must() {
        let mut stream = numbers(5);
        let (first, done) = read_batch(&mut stream, 3).await.unwrap();
        assert_eq!((first.len(), done), (3, false));
        let (rest, done) = read_batch(&mut stream, 3).await.unwrap();
        assert_eq!((rest.len(), done), (2, true));

        let table = CursorTable::default();
        let id = table.insert(numbers(1), 7);
        let (taken, batch) = table.take(&id).unwrap();
        assert_eq!(batch, 7);
        assert_eq!(table.take(&id).err(), Some(CursorMiss::Busy));
        table.put_back(&id, taken);
        assert!(table.take(&id).is_ok());
        assert!(table.close(&id));
        assert!(!table.close(&id));
        assert_eq!(table.take(&id).err(), Some(CursorMiss::Gone));
        // A cursor closed while a read had it is dropped on its return.
        let id = table.insert(numbers(1), 7);
        let (taken, _) = table.take(&id).unwrap();
        table.close(&id);
        table.put_back(&id, taken);
        assert!(!table.contains(&id));

        // Past the cap the cursor read longest ago goes, not a busy one.
        let first = table.insert(numbers(1), 7);
        let busy = table.take(&first).unwrap();
        let second = table.insert(numbers(1), 7);
        for _ in 0..CURSOR_CAP - 1 {
            table.insert(numbers(1), 7);
        }
        assert_eq!(table.open_count(), CURSOR_CAP);
        assert!(table.contains(&first) && !table.contains(&second));
        drop(busy);
        table.close_all();
        assert_eq!(table.open_count(), 0);
    }

    #[tokio::test]
    async fn idle_cursors_close() {
        let table = CursorTable::with_idle(Duration::from_millis(60));
        let idle = table.insert(numbers(1), 7);
        let kept = table.insert(numbers(1), 7);
        for _ in 0..6 {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let (stream, _) = table.take(&kept).unwrap();
            table.put_back(&kept, stream);
        }
        assert!(!table.contains(&idle));
        assert!(table.contains(&kept));
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(table.open_count(), 0);
    }
}
