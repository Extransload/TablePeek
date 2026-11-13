//! The byte stream a connection runs over: TCP to the server (or to a
//! tunnel's local end, or through the tunnel itself), with TLS on top when
//! the settings ask for it. TLS is done here with the rustls the other
//! engines use, so the certificate is checked against the server's own name
//! even through a tunnel, and a client certificate can be presented.

use std::sync::Arc;
use std::time::Duration;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use tokio_rustls::TlsConnector;

use super::reply::driver_error;
use super::Settings;
use crate::registry::{NetRoute, TunnelStream};
use crate::EngineError;

/// How long opening the TCP connection and the TLS handshake may each take.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Where connections go and how.
pub(super) struct Target {
    /// The server as the settings name it: what a tunnel leads to and the
    /// name its certificate is checked against.
    host: String,
    port: u16,
    route: NetRoute,
    tls: Option<(TlsConnector, ServerName<'static>)>,
}

impl Target {
    pub(super) fn new(
        settings: &Settings,
        host: &str,
        port: u16,
        tls: bool,
        route: &NetRoute,
    ) -> Result<Self, EngineError> {
        let tls = if tls {
            let config = tls_config(settings)?;
            let name = ServerName::try_from(host.trim_matches(['[', ']']).to_string())
                .map_err(|err| EngineError::BadRequest(format!("TLS 서버 이름 오류: {err}")))?;
            Some((TlsConnector::from(Arc::new(config)), name))
        } else {
            None
        };
        Ok(Self {
            host: host.to_string(),
            port,
            route: route.clone(),
            tls,
        })
    }

    /// A new stream to the server, TLS done when it is on.
    pub(super) async fn stream(&self) -> Result<Box<dyn TunnelStream>, EngineError> {
        let raw: Box<dyn TunnelStream> = match &self.route {
            NetRoute::Direct => Box::new(tcp(&self.host, self.port).await?),
            NetRoute::Via { host, port } => Box::new(tcp(host, *port).await?),
            NetRoute::Tunnel(forwarder) => forwarder
                .connect(&self.host, self.port)
                .await
                .map_err(driver_error)?,
        };
        let Some((connector, name)) = &self.tls else {
            return Ok(raw);
        };
        let stream = tokio::time::timeout(CONNECT_TIMEOUT, connector.connect(name.clone(), raw))
            .await
            .map_err(|_| driver_error("TLS 연결 실패: 서버가 응답하지 않습니다 (시간 초과)"))?
            .map_err(|err| driver_error(format!("TLS 연결 실패: {err}")))?;
        Ok(Box::new(stream))
    }
}

async fn tcp(host: &str, port: u16) -> Result<tokio::net::TcpStream, EngineError> {
    let address = (host.trim_matches(['[', ']']), port);
    let stream = tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::TcpStream::connect(address))
        .await
        .map_err(|_| driver_error(format!("{host}:{port}에서 응답이 없습니다 (시간 초과)")))?
        .map_err(|err| driver_error(format!("{host}:{port}에 연결할 수 없습니다: {err}")))?;
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

/// The TLS settings: the server's certificate checked against the CA file
/// (or the system's roots), or not at all; the client certificate and key
/// when both are given.
fn tls_config(settings: &Settings) -> Result<rustls::ClientConfig, EngineError> {
    let given = |value: &Option<String>| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let ca = if settings.tls_skip_verify {
        None
    } else {
        given(&settings.tls_ca_file)
    };
    let mut config = crate::postgres::rustls_client_config(
        ca.as_deref(),
        given(&settings.tls_client_cert).as_deref(),
        given(&settings.tls_client_key).as_deref(),
    )?;
    if settings.tls_skip_verify {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        config
            .dangerous()
            .set_certificate_verifier(Arc::new(Unchecked(provider)));
    }
    Ok(config)
}

/// Takes any certificate (the settings' "don't check"); the handshake's
/// signatures are still checked.
#[derive(Debug)]
struct Unchecked(Arc<CryptoProvider>);

impl ServerCertVerifier for Unchecked {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}
