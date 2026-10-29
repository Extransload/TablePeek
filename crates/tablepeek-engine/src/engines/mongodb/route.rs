//! A replica set or sharded cluster behind an SSH or HTTP tunnel.
//!
//! The driver keeps discovering the deployment as usual (the members a seed
//! answers with, which one is primary, a primary that steps down, the
//! secondary a read preference asks for), but every connection it opens
//! goes to a SOCKS5 server of our own on 127.0.0.1, which leads it through
//! the tunnel to the member it names. Members keep their real names, so
//! TLS still checks the certificate against them. An SRV name is resolved
//! here, into the seed list and options its SRV and TXT records give.

use std::net::SocketAddr;
use std::sync::Arc;

use hickory_resolver::config::{ConnectionConfig, NameServerConfig, ResolverConfig};
use hickory_resolver::proto::rr::{Name, RData};
use hickory_resolver::TokioResolver;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinSet;

use crate::registry::Forwarder;
use crate::EngineError;

/// How long a SOCKS client may take to say where it is going.
const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// The SOCKS5 server one connection's driver goes through; it stops when
/// dropped. Only the driver knows the user and password it asks for, so
/// another program on this machine can't borrow the tunnel.
pub(super) struct Socks {
    pub port: u16,
    pub user: String,
    pub password: String,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Socks {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Socks {
    pub(super) async fn start(forwarder: Arc<dyn Forwarder>) -> Result<Socks, EngineError> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|err| {
            EngineError::Internal(format!("터널 로컬 포트를 열 수 없습니다: {err}"))
        })?;
        let port = listener
            .local_addr()
            .map_err(|err| {
                EngineError::Internal(format!("터널 로컬 주소를 확인할 수 없습니다: {err}"))
            })?
            .port();
        let user = "tablepeek".to_string();
        let password = uuid::Uuid::new_v4().simple().to_string();
        let secret = password.clone();
        let task = tokio::spawn(async move {
            // Dropping the set (when the task is aborted) ends every stream.
            let mut streams: JoinSet<()> = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { break };
                        let forwarder = forwarder.clone();
                        let secret = secret.clone();
                        streams.spawn(async move {
                            let _ = serve(stream, forwarder.as_ref(), &secret).await;
                        });
                    }
                    Some(_) = streams.join_next() => {}
                }
            }
        });
        Ok(Socks {
            port,
            user,
            password,
            task,
        })
    }
}

/// One SOCKS5 client (RFC 1928, user and password per RFC 1929, CONNECT
/// only): where it asks to go, through the tunnel, then its bytes both ways.
async fn serve(
    mut client: TcpStream,
    forwarder: &dyn Forwarder,
    secret: &str,
) -> std::io::Result<()> {
    let target = tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake(&mut client, secret))
        .await
        .map_err(|_| std::io::Error::other("SOCKS handshake timed out"))??;
    let Some((host, port)) = target else {
        return Ok(());
    };
    match forwarder.connect(&host, port).await {
        Ok(mut upstream) => {
            // Succeeded; the bound address means nothing here.
            client.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            tokio::io::copy_bidirectional(&mut client, &mut upstream).await?;
        }
        Err(_) => {
            // Host unreachable.
            client.write_all(&[5, 4, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        }
    }
    Ok(())
}

/// Reads the greeting, the login and the request; the address asked for,
/// or None when the client was turned away (and told why).
async fn handshake(client: &mut TcpStream, secret: &str) -> std::io::Result<Option<(String, u16)>> {
    let mut head = [0u8; 2];
    client.read_exact(&mut head).await?;
    if head[0] != 5 {
        return Ok(None);
    }
    let mut methods = vec![0u8; usize::from(head[1])];
    client.read_exact(&mut methods).await?;
    if !methods.contains(&2) {
        // No acceptable method.
        client.write_all(&[5, 0xff]).await?;
        return Ok(None);
    }
    client.write_all(&[5, 2]).await?;
    let mut version = [0u8; 2];
    client.read_exact(&mut version).await?;
    let mut user = vec![0u8; usize::from(version[1])];
    client.read_exact(&mut user).await?;
    let mut length = [0u8; 1];
    client.read_exact(&mut length).await?;
    let mut password = vec![0u8; usize::from(length[0])];
    client.read_exact(&mut password).await?;
    if password != secret.as_bytes() {
        client.write_all(&[1, 1]).await?;
        return Ok(None);
    }
    client.write_all(&[1, 0]).await?;
    let mut request = [0u8; 4];
    client.read_exact(&mut request).await?;
    if request[0] != 5 || request[1] != 1 {
        // Command not supported.
        client.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        return Ok(None);
    }
    let host = match request[3] {
        1 => {
            let mut ip = [0u8; 4];
            client.read_exact(&mut ip).await?;
            std::net::Ipv4Addr::from(ip).to_string()
        }
        4 => {
            let mut ip = [0u8; 16];
            client.read_exact(&mut ip).await?;
            std::net::Ipv6Addr::from(ip).to_string()
        }
        3 => {
            client.read_exact(&mut length).await?;
            let mut name = vec![0u8; usize::from(length[0])];
            client.read_exact(&mut name).await?;
            String::from_utf8_lossy(&name).into_owned()
        }
        _ => {
            // Address type not supported.
            client.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            return Ok(None);
        }
    };
    let mut port = [0u8; 2];
    client.read_exact(&mut port).await?;
    Ok(Some((host, u16::from_be_bytes(port))))
}

/// The options an SRV name's TXT record may set.
const TXT_OPTIONS: [&str; 3] = ["authSource", "replicaSet", "loadBalanced"];

/// `mongodb+srv://user@name/db?opts` as the plain connection string its
/// records stand for: `mongodb://user@member1:port1,…/db?opts`, with the
/// TXT record's options (the string's own win), TLS on unless the string
/// turns it off, and at most `srvMaxHosts` members. `nameserver` asks one
/// DNS server instead of the system's (tests).
pub(super) async fn seed_list(
    uri: &str,
    nameserver: Option<SocketAddr>,
) -> Result<String, EngineError> {
    let invalid = |message: String| EngineError::BadRequest(message);
    let rest = uri
        .strip_prefix("mongodb+srv://")
        .ok_or_else(|| invalid("SRV 연결 문자열이 아닙니다".into()))?;
    let end = rest.find(['/', '?']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    let (credentials, name) = match authority.rsplit_once('@') {
        Some((credentials, name)) => (Some(credentials), name),
        None => (None, authority),
    };
    if name.contains([',', ':']) {
        return Err(invalid(
            "mongodb+srv:// 주소에는 호스트 이름 하나만 쓰고 포트를 붙이지 않습니다".into(),
        ));
    }
    let (path, query) = match tail.split_once('?') {
        Some((path, query)) => (path, query),
        None => (tail, ""),
    };
    let mut options: Vec<(String, String)> = query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((key, value)) => (key.to_string(), value.to_string()),
            None => (pair.to_string(), String::new()),
        })
        .collect();
    let option = |options: &[(String, String)], name: &str| {
        options
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.clone())
    };
    let service = option(&options, "srvServiceName").unwrap_or_else(|| "mongodb".into());
    let max_hosts = option(&options, "srvMaxHosts").and_then(|value| value.parse::<usize>().ok());
    // Options a plain connection string refuses.
    options.retain(|(key, _)| {
        !key.eq_ignore_ascii_case("srvServiceName") && !key.eq_ignore_ascii_case("srvMaxHosts")
    });

    let resolver = resolver(nameserver)?;
    let dns_failed = |err: String| super::failure(format!("DNS 조회 실패: {err}"));
    let lookup = Name::from_str_relaxed(format!("_{service}._tcp.{name}."))
        .map_err(|err| dns_failed(err.to_string()))?;
    let records = resolver
        .srv_lookup(lookup)
        .await
        .map_err(|err| dns_failed(format!("{name}의 SRV 레코드: {err}")))?;
    // Members must sit in the SRV name's own domain (as the driver checks):
    // the part after its first label, or the whole name when it is short.
    let labels: Vec<&str> = name.split('.').collect();
    let domain = if labels.len() >= 3 {
        labels[1..].join(".")
    } else {
        name.to_string()
    };
    let mut members = Vec::new();
    for record in records.answers() {
        let RData::SRV(srv) = &record.data else {
            continue;
        };
        let host = srv.target.to_utf8().trim_end_matches('.').to_string();
        let parent = host.split_once('.').map_or("", |(_, parent)| parent);
        if !(parent == domain || parent.ends_with(&format!(".{domain}"))) {
            return Err(dns_failed(format!(
                "{name}의 SRV 레코드가 다른 도메인의 호스트를 가리킵니다: {host}"
            )));
        }
        members.push(format!("{host}:{}", srv.port));
    }
    if members.is_empty() {
        return Err(dns_failed(format!("{name}의 SRV 레코드가 없습니다")));
    }
    if let Some(max) = max_hosts.filter(|max| *max > 0) {
        members.truncate(max);
    }

    let txt = match resolver
        .txt_lookup(
            Name::from_str_relaxed(format!("{name}."))
                .map_err(|err| dns_failed(err.to_string()))?,
        )
        .await
    {
        Ok(lookup) => {
            let mut texts = lookup
                .answers()
                .iter()
                .filter_map(|record| match &record.data {
                    RData::TXT(txt) => Some(
                        txt.txt_data
                            .iter()
                            .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
                            .collect::<String>(),
                    ),
                    _ => None,
                });
            let first = texts.next();
            if texts.next().is_some() {
                return Err(dns_failed(format!("{name}의 TXT 레코드가 여러 개입니다")));
            }
            first
        }
        Err(err) if err.is_no_records_found() => None,
        Err(err) => return Err(dns_failed(format!("{name}의 TXT 레코드: {err}"))),
    };
    for pair in txt
        .iter()
        .flat_map(|text| text.split('&'))
        .filter(|pair| !pair.is_empty())
    {
        let Some((key, value)) = pair.split_once('=') else {
            return Err(dns_failed(format!(
                "TXT 레코드 값이 key=value가 아닙니다: {pair}"
            )));
        };
        let Some(known) = TXT_OPTIONS
            .iter()
            .find(|known| known.eq_ignore_ascii_case(key))
        else {
            return Err(dns_failed(format!(
                "TXT 레코드에 쓸 수 없는 옵션입니다: {key} (authSource, replicaSet, loadBalanced만)"
            )));
        };
        if option(&options, known).is_none() {
            options.push((known.to_string(), value.to_string()));
        }
    }
    if option(&options, "tls").is_none() && option(&options, "ssl").is_none() {
        options.push(("tls".into(), "true".into()));
    }

    let mut out = String::from("mongodb://");
    if let Some(credentials) = credentials {
        out.push_str(credentials);
        out.push('@');
    }
    out.push_str(&members.join(","));
    out.push_str(if path.is_empty() { "/" } else { path });
    let query = options
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&");
    if !query.is_empty() {
        out.push('?');
        out.push_str(&query);
    }
    Ok(out)
}

/// The system's resolver, or one asking only `nameserver`.
fn resolver(nameserver: Option<SocketAddr>) -> Result<TokioResolver, EngineError> {
    let failed = |err: String| super::failure(format!("DNS 설정을 읽을 수 없습니다: {err}"));
    let builder = match nameserver {
        Some(address) => {
            let connections = [ConnectionConfig::udp(), ConnectionConfig::tcp()]
                .into_iter()
                .map(|mut connection| {
                    connection.port = address.port();
                    connection
                })
                .collect();
            let server = NameServerConfig::new(address.ip(), true, connections);
            TokioResolver::builder_with_config(
                ResolverConfig::from_name_servers(vec![server]),
                Default::default(),
            )
        }
        None => TokioResolver::builder_tokio().map_err(|err| failed(err.to_string()))?,
    };
    builder.build().map_err(|err| failed(err.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;

    /// Leads every stream to one local port, remembering where it was sent.
    struct Recorder {
        port: u16,
        asked: std::sync::Mutex<Vec<(String, u16)>>,
    }

    #[async_trait]
    impl Forwarder for Recorder {
        async fn connect(
            &self,
            host: &str,
            port: u16,
        ) -> Result<Box<dyn crate::registry::TunnelStream>, String> {
            self.asked.lock().unwrap().push((host.to_string(), port));
            let stream = TcpStream::connect(("127.0.0.1", self.port))
                .await
                .map_err(|err| err.to_string())?;
            Ok(Box::new(stream))
        }
    }

    #[tokio::test]
    async fn socks_leads_named_hosts_through_the_tunnel_with_its_password_only() {
        let echo = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = echo.accept().await {
                tokio::spawn(async move {
                    let mut buffer = [0u8; 4];
                    if stream.read_exact(&mut buffer).await.is_ok() {
                        let _ = stream.write_all(&buffer).await;
                    }
                });
            }
        });
        let recorder = Arc::new(Recorder {
            port: echo_port,
            asked: Default::default(),
        });
        let socks = Socks::start(recorder.clone()).await.unwrap();

        let greet = |password: &str| {
            let mut bytes = vec![5, 1, 2, 1, socks.user.len() as u8];
            bytes.extend(socks.user.as_bytes());
            bytes.push(password.len() as u8);
            bytes.extend(password.as_bytes());
            bytes
        };
        let mut client = TcpStream::connect(("127.0.0.1", socks.port)).await.unwrap();
        client.write_all(&greet(&socks.password)).await.unwrap();
        let mut reply = [0u8; 4];
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply, [5, 2, 1, 0]);
        let name = b"rs2.tablepeek.test";
        let mut request = vec![5, 1, 0, 3, name.len() as u8];
        request.extend(name);
        request.extend(27017u16.to_be_bytes());
        client.write_all(&request).await.unwrap();
        let mut granted = [0u8; 10];
        client.read_exact(&mut granted).await.unwrap();
        assert_eq!(granted[1], 0);
        client.write_all(b"ping").await.unwrap();
        let mut echoed = [0u8; 4];
        client.read_exact(&mut echoed).await.unwrap();
        assert_eq!(&echoed, b"ping");
        assert_eq!(
            recorder.asked.lock().unwrap().as_slice(),
            [("rs2.tablepeek.test".to_string(), 27017)]
        );

        let mut stranger = TcpStream::connect(("127.0.0.1", socks.port)).await.unwrap();
        stranger.write_all(&greet("guess")).await.unwrap();
        let mut refused = [0u8; 4];
        stranger.read_exact(&mut refused).await.unwrap();
        assert_eq!(refused, [5, 2, 1, 1]);
        assert_eq!(recorder.asked.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn seed_lists_refuse_ports_and_lists_in_srv_names() {
        for uri in [
            "mongodb+srv://cluster0.example.net:27017/",
            "mongodb+srv://a.example.net,b.example.net/",
        ] {
            assert!(matches!(
                seed_list(uri, None).await,
                Err(EngineError::BadRequest(_))
            ));
        }
    }
}
