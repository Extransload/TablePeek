//! The cluster's nodes as a connection knows them: the address the settings
//! name (the seed), and the nodes the cluster lists in `_nodes/http`, kept
//! to fail over to when a node can't be reached. Through an SSH or HTTP
//! tunnel every node gets its own local end leading through the tunnel to
//! the address the node publishes.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::{JoinHandle, JoinSet};

use crate::registry::Forwarder;

/// How long a node that refused a connection is passed over.
pub(super) const DOWN_FOR: Duration = Duration::from_secs(60);
/// How old the node list may get before the cluster tab reads it again.
pub(super) const SNIFF_EVERY: Duration = Duration::from_secs(60);
/// The header of the reply a local end gives a plain HTTP request when the
/// tunnel can't reach the node: the request never left this machine, so
/// another node may take it.
pub(super) const TUNNEL_ERROR: &str = "x-tablepeek-tunnel-error";

/// A node's published HTTP address as `(host, port)`: `10.0.0.5:9200`,
/// `es1.example.com/10.0.0.5:9200` (the name, which a certificate carries,
/// wins over the IP), or an IPv6 address in brackets.
pub(super) fn publish_address(text: &str) -> Option<(String, u16)> {
    let text = text.trim();
    let (name, address) = match text.split_once('/') {
        Some((name, address)) => (Some(name).filter(|name| !name.is_empty()), address),
        None => (None, text),
    };
    let (ip, port) = address.rsplit_once(':')?;
    let port: u16 = port.parse().ok()?;
    let ip = ip.trim_matches(['[', ']']);
    let host = name.unwrap_or(ip);
    if host.is_empty() || port == 0 {
        return None;
    }
    Some((host.to_string(), port))
}

/// Whether a node with these roles serves HTTP requests worth sending to:
/// every node but a dedicated master (cluster manager).
pub(super) fn serves_requests(roles: Option<&Value>) -> bool {
    let Some(roles) = roles.and_then(Value::as_array) else {
        return true;
    };
    if roles.is_empty() {
        // A coordinating-only node.
        return true;
    }
    roles.iter().any(|role| {
        !matches!(
            role.as_str(),
            Some("master" | "cluster_manager" | "voting_only")
        )
    })
}

/// The nodes `_nodes/http` lists, as `(name, host, port)`.
pub(super) fn listed_nodes(reply: &Value) -> Vec<(String, String, u16)> {
    let mut found: Vec<(String, String, u16)> = reply
        .get("nodes")
        .and_then(Value::as_object)
        .map(|nodes| {
            nodes
                .values()
                .filter(|node| serves_requests(node.get("roles")))
                .filter_map(|node| {
                    let address = node.pointer("/http/publish_address")?.as_str()?;
                    let (host, port) = publish_address(address)?;
                    let name = node
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    Some((name, host, port))
                })
                .collect()
        })
        .unwrap_or_default();
    found.sort();
    found
}

/// One node: where it is and whether it answered lately.
pub(super) struct Node<L> {
    pub host: String,
    pub port: u16,
    /// Its node name, once the cluster said it.
    pub name: Option<String>,
    /// The address the settings name.
    pub seed: bool,
    pub link: L,
    /// When a connection to it last failed.
    pub down_since: Option<Instant>,
}

impl<L> Node<L> {
    pub fn address(&self) -> String {
        if self.host.contains(':') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }

    fn usable(&self, now: Instant) -> bool {
        self.down_since
            .is_none_or(|since| now.duration_since(since) >= DOWN_FOR)
    }
}

/// The nodes and the one requests go to now.
pub(super) struct Nodes<L> {
    pub list: Vec<Node<L>>,
    pub current: usize,
    /// How many times requests moved to another node.
    pub failovers: u64,
    /// When the cluster last listed its nodes, and why it couldn't.
    pub sniffed: Option<Instant>,
    pub sniff_error: Option<String>,
    /// A failover happened; the list is read again after the next answer.
    pub stale: bool,
}

impl<L: Clone> Nodes<L> {
    pub fn new(seed: Node<L>) -> Self {
        Self {
            list: vec![seed],
            current: 0,
            failovers: 0,
            sniffed: None,
            sniff_error: None,
            stale: false,
        }
    }

    /// The node requests go to now.
    pub fn pick(&self) -> (usize, L) {
        let index = self.current.min(self.list.len() - 1);
        (index, self.list[index].link.clone())
    }

    /// `index` refused a connection: it is passed over for a while and the
    /// next node that may be up becomes the current one. None when every
    /// node has had its try (`tried` of them so far).
    pub fn fail_over(&mut self, index: usize, tried: usize) -> Option<String> {
        let now = Instant::now();
        if let Some(node) = self.list.get_mut(index) {
            node.down_since = Some(now);
        }
        let count = self.list.len();
        if tried >= count {
            return None;
        }
        // The next node that isn't down; with every one down, simply the
        // next (each gets one try).
        let order = (1..count).map(|step| (index + step) % count);
        let next = order
            .clone()
            .find(|&candidate| self.list[candidate].usable(now))
            .or_else(|| order.into_iter().next())?;
        self.current = next;
        self.failovers += 1;
        self.stale = true;
        Some(self.list[next].address())
    }

    /// `index` answered.
    pub fn answered(&mut self, index: usize) {
        if let Some(node) = self.list.get_mut(index) {
            node.down_since = None;
        }
    }

    /// Whether `host:port` is known already.
    pub fn has(&self, host: &str, port: u16) -> bool {
        self.list
            .iter()
            .any(|node| node.port == port && node.host.eq_ignore_ascii_case(host))
    }

    /// Takes in what the cluster listed: names the known nodes, adds the
    /// `added` ones (their links already made), and drops nodes that left
    /// the cluster (never the seed or the one in use).
    pub fn merge(
        &mut self,
        listed: &[(String, String, u16)],
        seed_name: Option<&str>,
        added: Vec<Node<L>>,
    ) {
        for node in &mut self.list {
            if let Some((name, ..)) = listed
                .iter()
                .find(|(_, host, port)| *port == node.port && host.eq_ignore_ascii_case(&node.host))
            {
                node.name = Some(name.clone());
            } else if node.seed {
                if let Some(name) = seed_name {
                    node.name = Some(name.to_string());
                }
            }
        }
        for node in added {
            if !self.has(&node.host, node.port) {
                self.list.push(node);
            }
        }
        let current = self.list[self.current.min(self.list.len() - 1)].address();
        self.list.retain(|node| {
            node.seed
                || node.address() == current
                || listed.iter().any(|(_, host, port)| {
                    *port == node.port && host.eq_ignore_ascii_case(&node.host)
                })
        });
        self.current = self
            .list
            .iter()
            .position(|node| node.address() == current)
            .unwrap_or(0);
    }

    /// The list as the cluster tab shows it.
    pub fn describe(&self, sniff: bool) -> Value {
        let now = Instant::now();
        let current = self.current.min(self.list.len() - 1);
        json!({
            "sniff": sniff,
            "current": self.list[current].address(),
            "failovers": self.failovers,
            "sniff_error": self.sniff_error,
            "nodes": self.list.iter().enumerate().map(|(index, node)| json!({
                "address": node.address(),
                "name": node.name,
                "seed": node.seed,
                "current": index == current,
                "down": !node.usable(now),
            })).collect::<Vec<_>>(),
        })
    }
}

/// One local end per address behind a tunnel, opened the first time a node
/// needs it; they all stop when this is dropped (with the connection).
pub(super) struct LocalEnds {
    forwarder: Arc<dyn Forwarder>,
    /// Whether the requests are HTTPS: a node the tunnel can't reach then
    /// fails the TLS handshake (a connect error); plain HTTP gets a reply
    /// marked `TUNNEL_ERROR`.
    https: bool,
    ends: tokio::sync::Mutex<HashMap<(String, u16), SocketAddr>>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

impl Drop for LocalEnds {
    fn drop(&mut self) {
        let tasks = self.tasks.get_mut().unwrap_or_else(PoisonError::into_inner);
        for task in tasks.drain(..) {
            task.abort();
        }
    }
}

/// What a local end answers a plain HTTP request the tunnel couldn't take
/// to its node.
fn unreachable_reply(host: &str, port: u16, why: &str) -> Vec<u8> {
    let text = format!("터널로 {host}:{port}에 연결할 수 없습니다: {why}");
    format!(
        "HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain; charset=utf-8\r\n{TUNNEL_ERROR}: 1\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
        text.len()
    )
    .into_bytes()
}

impl LocalEnds {
    pub fn new(forwarder: Arc<dyn Forwarder>, https: bool) -> Self {
        Self {
            forwarder,
            https,
            ends: tokio::sync::Mutex::new(HashMap::new()),
            tasks: Mutex::new(Vec::new()),
        }
    }

    /// The local address leading to `host:port` as the tunnel's far end
    /// names it.
    pub async fn end(&self, host: &str, port: u16) -> std::io::Result<SocketAddr> {
        let key = (host.to_string(), port);
        // Held while binding, so two links to a new node share one end.
        let mut ends = self.ends.lock().await;
        if let Some(end) = ends.get(&key) {
            return Ok(*end);
        }
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let end = listener.local_addr()?;
        let forwarder = self.forwarder.clone();
        let https = self.https;
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
                            match forwarder.connect(&target, port).await {
                                Ok(mut remote) => {
                                    let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
                                }
                                Err(why) if !https => {
                                    let reply = unreachable_reply(&target, port, &why);
                                    let _ = local.write_all(&reply).await;
                                    let _ = local.shutdown().await;
                                    // Read the request until the client closes,
                                    // so closing doesn't reset the connection
                                    // before the reply is read.
                                    let mut sink = [0u8; 4096];
                                    let _ = tokio::time::timeout(Duration::from_secs(5), async {
                                        while matches!(local.read(&mut sink).await, Ok(n) if n > 0) {}
                                    })
                                    .await;
                                }
                                // Closed before the handshake: a connect error.
                                Err(_) => {}
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publish_addresses_read_with_names_ips_and_brackets() {
        assert_eq!(
            publish_address("10.0.0.5:9200"),
            Some(("10.0.0.5".into(), 9200))
        );
        assert_eq!(
            publish_address("es1.example.com/10.0.0.5:9201"),
            Some(("es1.example.com".into(), 9201))
        );
        assert_eq!(
            publish_address("/10.0.0.5:9200"),
            Some(("10.0.0.5".into(), 9200))
        );
        assert_eq!(publish_address("[::1]:9200"), Some(("::1".into(), 9200)));
        assert_eq!(publish_address("nonsense"), None);
        assert_eq!(publish_address("host:0"), None);
    }

    #[test]
    fn dedicated_masters_are_left_out_of_the_list() {
        let reply = json!({ "nodes": {
            "a": { "name": "es-a", "roles": ["data", "master"], "http": { "publish_address": "10.0.0.1:9200" } },
            "m": { "name": "es-m", "roles": ["master"], "http": { "publish_address": "10.0.0.2:9200" } },
            "c": { "name": "os-c", "roles": ["cluster_manager"], "http": { "publish_address": "10.0.0.3:9200" } },
            "x": { "name": "es-x", "roles": [], "http": { "publish_address": "10.0.0.4:9200" } },
            "n": { "name": "es-n", "roles": ["ingest"] }
        } });
        assert_eq!(
            listed_nodes(&reply),
            vec![
                ("es-a".to_string(), "10.0.0.1".to_string(), 9200),
                ("es-x".to_string(), "10.0.0.4".to_string(), 9200),
            ]
        );
    }

    fn node(host: &str, seed: bool) -> Node<()> {
        Node {
            host: host.into(),
            port: 9200,
            name: None,
            seed,
            link: (),
            down_since: None,
        }
    }

    #[test]
    fn a_refused_node_hands_over_to_the_next_one_up() {
        let mut nodes = Nodes::new(node("seed", true));
        nodes.merge(
            &[
                ("a".into(), "a".into(), 9200),
                ("b".into(), "b".into(), 9200),
            ],
            Some("s"),
            vec![node("a", false), node("b", false)],
        );
        assert_eq!(nodes.list.len(), 3);
        assert_eq!(nodes.list[0].name.as_deref(), Some("s"));
        assert_eq!(nodes.fail_over(0, 1).as_deref(), Some("a:9200"));
        assert_eq!(nodes.pick().0, 1);
        // a is down too: on to b, skipping the seed that is still down.
        assert_eq!(nodes.fail_over(1, 2).as_deref(), Some("b:9200"));
        // Every node had its try.
        assert_eq!(nodes.fail_over(2, 3), None);
        assert_eq!(nodes.failovers, 2);
        nodes.answered(2);
        let described = nodes.describe(true);
        assert_eq!(described["current"], "b:9200");
        assert_eq!(described["nodes"][0]["down"], true);
        assert_eq!(described["nodes"][2]["down"], false);
        // b left the cluster but is in use; a left and goes.
        nodes.merge(&[], Some("s"), Vec::new());
        let left: Vec<String> = nodes.list.iter().map(Node::address).collect();
        assert_eq!(left, ["seed:9200", "b:9200"]);
        assert_eq!(nodes.current, 1);
    }
}
