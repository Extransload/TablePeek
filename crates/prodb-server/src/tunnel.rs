use std::sync::Arc;
use std::time::Duration;

use prodb_types::SshConfig;
use russh::client::{Config, Handle, Msg};
use russh::keys::PrivateKeyWithHashAlg;
use russh::{Channel, ChannelMsg};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use tokio::task::JoinSet;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const CHUNK: usize = 32 * 1024;

pub struct Tunnel {
    pub local_port: u16,
    shutdown: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        if let Some(sender) = self.shutdown.take() {
            let _ = sender.send(());
        }
        self.task.abort();
    }
}

struct TunnelClient;

impl russh::client::Handler for TunnelClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

pub async fn open(ssh: &SshConfig, target_host: &str, target_port: u16) -> Result<Tunnel, String> {
    let has_key = ssh
        .private_key_path
        .as_deref()
        .map(|path| !path.trim().is_empty())
        .unwrap_or(false);
    let has_password = ssh
        .password
        .as_deref()
        .map(|password| !password.is_empty())
        .unwrap_or(false);
    if !has_key && !has_password {
        return Err("SSH 인증 정보가 없습니다".into());
    }

    let handle = tokio::time::timeout(CONNECT_TIMEOUT, connect_and_auth(ssh))
        .await
        .map_err(|_| "SSH 연결 또는 인증 시간이 초과되었습니다".to_string())??;

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|err| format!("터널 로컬 포트를 열 수 없습니다: {err}"))?;
    let local_port = listener
        .local_addr()
        .map_err(|err| format!("터널 로컬 주소를 확인할 수 없습니다: {err}"))?
        .port();

    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
    let target_host = target_host.to_string();
    let task = tokio::spawn(async move {
        let mut tasks: JoinSet<()> = JoinSet::new();
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => break,
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { break };
                    match handle
                        .channel_open_direct_tcpip(
                            target_host.clone(),
                            u32::from(target_port),
                            "127.0.0.1",
                            0,
                        )
                        .await
                    {
                        Ok(channel) => {
                            tasks.spawn(forward(channel, stream));
                        }
                        Err(_) => {}
                    }
                }
                Some(_) = tasks.join_next() => {}
            }
        }
    });

    Ok(Tunnel {
        local_port,
        shutdown: Some(shutdown_tx),
        task,
    })
}

async fn connect_and_auth(ssh: &SshConfig) -> Result<Handle<TunnelClient>, String> {
    let config = Arc::new(Config {
        nodelay: true,
        ..Config::default()
    });
    let mut handle = russh::client::connect(config, (ssh.host.as_str(), ssh.port), TunnelClient)
        .await
        .map_err(|err| format!("SSH 서버에 연결할 수 없습니다: {err}"))?;

    let has_key = ssh
        .private_key_path
        .as_deref()
        .map(|path| !path.trim().is_empty())
        .unwrap_or(false);

    if has_key {
        let path = ssh.private_key_path.as_deref().unwrap_or("").trim();
        let key = russh::keys::load_secret_key(path, None).map_err(|err| match err {
            russh::keys::Error::KeyIsEncrypted => {
                "암호화된 SSH 키는 아직 지원하지 않습니다. 암호 없는 키를 사용하세요".to_string()
            }
            other => format!("SSH 키를 불러올 수 없습니다: {other}"),
        })?;
        let hash_alg = handle
            .best_supported_rsa_hash()
            .await
            .map_err(|err| format!("SSH 협상에 실패했습니다: {err}"))?
            .flatten();
        let result = handle
            .authenticate_publickey(
                ssh.user.clone(),
                PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
            )
            .await
            .map_err(|err| format!("SSH 키 인증에 실패했습니다: {err}"))?;
        if !result.success() {
            return Err("SSH 키 인증에 실패했습니다".into());
        }
    } else if let Some(password) = ssh.password.clone() {
        let result = handle
            .authenticate_password(ssh.user.clone(), password)
            .await
            .map_err(|err| format!("SSH 비밀번호 인증에 실패했습니다: {err}"))?;
        if !result.success() {
            return Err("SSH 비밀번호 인증에 실패했습니다".into());
        }
    }

    Ok(handle)
}

async fn forward(channel: Channel<Msg>, stream: TcpStream) {
    let (mut read_half, write_half) = channel.split();
    let (mut local_read, mut local_write) = stream.into_split();
    let mut buf = vec![0u8; CHUNK];

    let to_remote = async {
        loop {
            match local_read.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if write_half.data_bytes(buf[..n].to_vec()).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = write_half.eof().await;
    };

    let to_local = async {
        while let Some(msg) = read_half.wait().await {
            match msg {
                ChannelMsg::Data { data } => {
                    if local_write.write_all(&data).await.is_err() {
                        break;
                    }
                }
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        let _ = local_write.shutdown().await;
    };

    tokio::join!(to_remote, to_local);
}

#[cfg(test)]
mod tests {
    use super::*;
    use prodb_types::{PostgresConfig, SslMode};

    fn docker_enabled() -> bool {
        std::env::var("PRODB_TEST_DOCKER").is_ok()
    }

    fn pg_container_ip() -> String {
        let output = std::process::Command::new("docker")
            .args([
                "inspect",
                "-f",
                "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
                "prodb-pg",
            ])
            .output()
            .expect("docker inspect를 실행할 수 없습니다");
        assert!(output.status.success(), "docker inspect prodb-pg 실패");
        let ip = String::from_utf8_lossy(&output.stdout).trim().to_string();
        assert!(!ip.is_empty(), "prodb-pg 컨테이너 IP를 확인할 수 없습니다");
        ip
    }

    fn test_ssh_config() -> SshConfig {
        SshConfig {
            host: "127.0.0.1".into(),
            port: 2222,
            user: "linuxserver.io".into(),
            password: None,
            private_key_path: Some("/tmp/prodb-ssh/id_ed25519".into()),
        }
    }

    fn test_pg_config(host: &str, port: u16) -> PostgresConfig {
        PostgresConfig {
            host: host.into(),
            port,
            user: "prodb".into(),
            password: Some("prodb_test_pw".into()),
            database: "prodb_test".into(),
            ssl_mode: SslMode::Disable,
        }
    }

    #[tokio::test]
    async fn open_rejects_missing_credentials() {
        let ssh = SshConfig {
            host: "127.0.0.1".into(),
            port: 2222,
            user: "linuxserver.io".into(),
            password: None,
            private_key_path: None,
        };
        let err = open(&ssh, "127.0.0.1", 5432).await.err().unwrap();
        assert_eq!(err, "SSH 인증 정보가 없습니다");
    }

    #[tokio::test]
    async fn tunnel_reaches_postgres_container() {
        if !docker_enabled() {
            return;
        }
        let tunnel = open(&test_ssh_config(), &pg_container_ip(), 5432)
            .await
            .expect("SSH 터널을 열 수 없습니다");
        let config = test_pg_config("127.0.0.1", tunnel.local_port);
        let engine = prodb_engine::Engine::open_demo(1).unwrap();
        let meta = engine
            .swap_to_postgres(&config)
            .await
            .expect("터널을 통한 PostgreSQL 연결 실패");
        assert_eq!(meta.kind, "postgres");
        let data = engine
            .query("SELECT 1", 10)
            .await
            .expect("터널을 통한 쿼리 실패");
        assert_eq!(data.row_count, 1);
        drop(tunnel);
    }

    #[tokio::test]
    async fn direct_connect_without_ssh() {
        if !docker_enabled() {
            return;
        }
        let config = test_pg_config("127.0.0.1", 5433);
        let engine = prodb_engine::Engine::open_demo(1).unwrap();
        let meta = engine
            .swap_to_postgres(&config)
            .await
            .expect("직접 PostgreSQL 연결 실패");
        assert_eq!(meta.kind, "postgres");
        let data = engine.query("SELECT 1", 10).await.expect("직접 쿼리 실패");
        assert_eq!(data.row_count, 1);
    }
}
