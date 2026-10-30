//! A cluster behind an SSH or HTTP tunnel.
//!
//! The driver keeps discovering the cluster as usual (the peers a node
//! lists, nodes that join, leave or go down) and keeps sending each
//! statement to a replica of its partition, but every node it learns of is
//! reached through a local end of our own on 127.0.0.1, which leads through
//! the tunnel to the address the node names itself by.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use scylla::errors::TranslationError;
use scylla::policies::address_translator::{AddressTranslator, UntranslatedPeer};
use tokio::net::TcpListener;
use tokio::task::{JoinHandle, JoinSet};

use crate::registry::Forwarder;

/// One local end per node, opened the first time the driver asks for the
/// node; they all stop when the session (which owns this) is dropped.
pub(super) struct ThroughTunnel {
    forwarder: Arc<dyn Forwarder>,
    /// The nodes' CQL port: the driver hands every peer the contact point's
    /// port, which here is a local end's.
    port: u16,
    ends: tokio::sync::Mutex<HashMap<(String, u16), SocketAddr>>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

impl Drop for ThroughTunnel {
    fn drop(&mut self) {
        let tasks = self.tasks.get_mut().unwrap_or_else(PoisonError::into_inner);
        for task in tasks.drain(..) {
            task.abort();
        }
    }
}

impl ThroughTunnel {
    pub(super) fn new(forwarder: Arc<dyn Forwarder>, port: u16) -> Self {
        Self {
            forwarder,
            port,
            ends: tokio::sync::Mutex::new(HashMap::new()),
            tasks: Mutex::new(Vec::new()),
        }
    }

    /// The local address leading to `host:port` as the tunnel's far end
    /// names it.
    pub(super) async fn end(&self, host: &str, port: u16) -> std::io::Result<SocketAddr> {
        let key = (host.to_string(), port);
        // Held while binding, so two connections to a new node share one end.
        let mut ends = self.ends.lock().await;
        if let Some(end) = ends.get(&key) {
            return Ok(*end);
        }
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let end = listener.local_addr()?;
        let forwarder = self.forwarder.clone();
        let target = key.0.clone();
        let task = tokio::spawn(async move {
            // Dropping the set (when the task is aborted) ends every stream.
            let mut streams: JoinSet<()> = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((mut local, _)) = accepted else { break };
                        let forwarder = forwarder.clone();
                        let target = target.clone();
                        streams.spawn(async move {
                            if let Ok(mut remote) = forwarder.connect(&target, port).await {
                                let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
                            }
                        });
                    }
                    Some(_) = streams.join_next() => {}
                }
            }
        });
        self.tasks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(task);
        ends.insert(key, end);
        Ok(end)
    }
}

#[async_trait]
impl AddressTranslator for ThroughTunnel {
    async fn translate_address(
        &self,
        peer: &UntranslatedPeer,
    ) -> Result<SocketAddr, TranslationError> {
        let address = peer.untranslated_address();
        self.end(&address.ip().to_string(), self.port)
            .await
            .map_err(|err| TranslationError::IoError(Arc::new(err)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::TunnelStream;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    /// Leads every stream to one local echo server, noting where each was
    /// meant to go.
    struct Recorder {
        echo: u16,
        asked: Mutex<Vec<(String, u16)>>,
    }

    #[async_trait]
    impl Forwarder for Recorder {
        async fn connect(&self, host: &str, port: u16) -> Result<Box<dyn TunnelStream>, String> {
            self.asked.lock().unwrap().push((host.to_string(), port));
            let stream = TcpStream::connect(("127.0.0.1", self.echo))
                .await
                .map_err(|err| err.to_string())?;
            Ok(Box::new(stream))
        }
    }

    #[tokio::test]
    async fn each_node_gets_its_own_end_through_the_tunnel() {
        let echo = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = echo.accept().await {
                tokio::spawn(async move {
                    let mut byte = [0u8; 1];
                    while stream.read_exact(&mut byte).await.is_ok() {
                        let _ = stream.write_all(&byte).await;
                    }
                });
            }
        });
        let recorder = Arc::new(Recorder {
            echo: echo_port,
            asked: Mutex::new(Vec::new()),
        });
        let through = ThroughTunnel::new(recorder.clone(), 9042);
        let first = through.end("10.0.0.5", 9042).await.unwrap();
        let second = through.end("10.0.0.6", 9042).await.unwrap();
        assert_ne!(first, second);
        assert_eq!(through.end("10.0.0.5", 9042).await.unwrap(), first);

        for (end, byte) in [(first, b'a'), (second, b'b')] {
            let mut client = TcpStream::connect(end).await.unwrap();
            client.write_all(&[byte]).await.unwrap();
            let mut back = [0u8; 1];
            client.read_exact(&mut back).await.unwrap();
            assert_eq!(back, [byte]);
        }
        assert_eq!(
            *recorder.asked.lock().unwrap(),
            [
                ("10.0.0.5".to_string(), 9042),
                ("10.0.0.6".to_string(), 9042)
            ]
        );

        drop(through);
        tokio::task::yield_now().await;
        assert!(TcpStream::connect(first).await.is_err());
    }
}
