//! MongoDB, through the official driver. A connection is a `Client` (its own
//! pool); documents travel as canonical Extended JSON (see `docs`), and every
//! operation is written to the console as the MongoDB shell would read it
//! (see `shell`).

mod docs;
mod gridfs;
#[cfg(test)]
mod live_conn;
pub mod oidc;
mod route;
mod shell;

use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use futures_util::TryStreamExt;
use mongodb::bson::{doc, Bson, Document};
use mongodb::options::{
    AuthMechanism, ClientOptions, ReadPreference, ReadPreferenceOptions, SelectionCriteria,
    ServerAddress, Socks5Proxy, Tls, TlsOptions,
};
use mongodb::Client;
use serde::Deserialize;
use serde_json::json;
use tablepeek_types::{
    Capabilities, ConnConfig, EngineMeta, ErrorFields, ServerInfo, ServerSession,
};

use crate::driver::{CancelRequest, DocumentDriver, Driver};
use crate::registry::{
    check_host, parse_descriptor, percent_decode, redact_uri_passwords, typed_config,
    ConfigProblem, DriverFactory, EngineDescriptor, NetRoute, TunnelTarget,
};
use crate::sql_log::SqlLog;
use crate::EngineError;

pub struct Factory;

pub static FACTORY: Factory = Factory;

static DESCRIPTOR: LazyLock<EngineDescriptor> =
    LazyLock::new(|| parse_descriptor(include_str!("descriptor.json")));

const DEFAULT_PORT: u16 = 27017;
/// How long finding a server may take before connecting gives up.
const SELECTION_TIMEOUT: Duration = Duration::from_secs(5);
/// Databases MongoDB keeps for itself, listed only when system objects are.
const SYSTEM_DATABASES: [&str; 3] = ["admin", "config", "local"];

/// The connect form's values. Blank text counts as not given.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Settings {
    uri: Option<String>,
    host: Option<String>,
    port: Option<u16>,
    /// "none", "password", "x509", "aws", "ldap", "kerberos" or "oidc";
    /// see `auth`.
    auth: Option<String>,
    /// The user; for AWS the access key id, for Kerberos the principal, for
    /// OIDC a login hint (the client id of an Azure managed identity).
    user: Option<String>,
    /// The password; for AWS the secret access key.
    password: Option<String>,
    auth_source: Option<String>,
    auth_mechanism: Option<String>,
    aws_session_token: Option<String>,
    kerberos_service_name: Option<String>,
    kerberos_service_realm: Option<String>,
    /// The host in the service principal (`mongodb/<host>`), when it is
    /// not the address dialled (an IP, a tunnel, a load balancer).
    kerberos_service_host: Option<String>,
    /// "none", "forward" or "forwardAndReverse".
    kerberos_canonicalize: Option<String>,
    /// "human" (a browser login), "azure", "gcp" or "k8s".
    oidc_flow: Option<String>,
    oidc_token_resource: Option<String>,
    database: Option<String>,
    tls: Option<bool>,
    tls_ca_file: Option<String>,
    tls_cert_key_file: Option<String>,
    direct_connection: Option<bool>,
    replica_set: Option<String>,
    read_preference: Option<String>,
}

fn given(value: &Option<String>) -> Option<&str> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

/// How a connection proves who it is: the form's `auth` choice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Auth {
    /// No credential at all, whatever user or password is stored.
    None,
    /// A user and password (SCRAM, or the connection string's mechanism).
    Password,
    /// The client certificate, over TLS.
    X509,
    /// MONGODB-AWS: an access key and secret (and session token), or
    /// without a key the environment's credentials or role.
    Aws,
    /// PLAIN against the server's LDAP directory, in `$external`.
    Ldap,
    /// GSSAPI, with the ticket the system's Kerberos holds (`kinit`).
    Kerberos,
    /// MONGODB-OIDC: a browser login or the platform's workload identity.
    Oidc,
}

impl Auth {
    const ALL: [Auth; 7] = [
        Auth::None,
        Auth::Password,
        Auth::X509,
        Auth::Aws,
        Auth::Ldap,
        Auth::Kerberos,
        Auth::Oidc,
    ];

    fn name(self) -> &'static str {
        match self {
            Auth::None => "none",
            Auth::Password => "password",
            Auth::X509 => "x509",
            Auth::Aws => "aws",
            Auth::Ldap => "ldap",
            Auth::Kerberos => "kerberos",
            Auth::Oidc => "oidc",
        }
    }

    /// The choice a mechanism of its own stands for (PLAIN is how MongoDB
    /// asks an LDAP directory).
    fn of_mechanism(name: &str) -> Option<Auth> {
        [
            ("MONGODB-X509", Auth::X509),
            ("MONGODB-AWS", Auth::Aws),
            ("PLAIN", Auth::Ldap),
            ("GSSAPI", Auth::Kerberos),
            ("MONGODB-OIDC", Auth::Oidc),
        ]
        .into_iter()
        .find(|(mechanism, _)| name.eq_ignore_ascii_case(mechanism))
        .map(|(_, auth)| auth)
    }
}

/// The authentication `settings` ask for. Without an `auth` choice (a
/// profile saved before the form had one, or a request that leaves it out)
/// it is what the other settings imply: a mechanism with a choice of its
/// own (X.509, AWS, PLAIN for LDAP, GSSAPI for Kerberos, OIDC), typed or in
/// the connection string, means that choice; a user or password means a
/// password; nothing means none.
fn auth(settings: &Settings) -> Result<Auth, ConfigProblem> {
    if let Some(name) = given(&settings.auth) {
        return Auth::ALL
            .into_iter()
            .find(|auth| auth.name() == name)
            .ok_or_else(|| {
                ConfigProblem::invalid(format!("지원하지 않는 인증 방식입니다: {name}"))
            });
    }
    let uri = given(&settings.uri);
    let mechanism = given(&settings.auth_mechanism)
        .map(str::to_string)
        .or_else(|| uri.and_then(|uri| uri_option(uri, "authMechanism")));
    Ok(
        if let Some(auth) = mechanism.as_deref().and_then(Auth::of_mechanism) {
            auth
        } else if given(&settings.user).is_some()
            || given(&settings.password).is_some()
            || uri.and_then(uri_user).is_some()
        {
            Auth::Password
        } else {
            Auth::None
        },
    )
}

/// A host of a connection string and its port, if it names one.
type UriHost = (String, Option<u16>);

/// The hosts a connection string names, and whether it is an SRV name
/// (`mongodb+srv://`), read without resolving anything.
fn uri_hosts(uri: &str) -> Option<(bool, Vec<UriHost>)> {
    let (srv, rest) = if let Some(rest) = uri.strip_prefix("mongodb+srv://") {
        (true, rest)
    } else {
        (false, uri.strip_prefix("mongodb://")?)
    };
    let authority = rest.split(['/', '?']).next().unwrap_or("");
    let hosts = authority
        .rsplit_once('@')
        .map_or(authority, |(_, hosts)| hosts);
    let parsed = hosts
        .split(',')
        .filter(|host| !host.is_empty())
        .map(|host| {
            // [::1]:27017, host:27017 or a bare host.
            let (name, port) = match host.strip_prefix('[') {
                Some(v6) => match v6.split_once(']') {
                    Some((name, after)) => (name, after.strip_prefix(':')),
                    None => (v6, None),
                },
                None => match host.rsplit_once(':') {
                    Some((name, port)) => (name, Some(port)),
                    None => (host, None),
                },
            };
            (name.to_string(), port.and_then(|port| port.parse().ok()))
        })
        .collect();
    Some((srv, parsed))
}

fn settings(descriptor: &EngineDescriptor, config: &ConnConfig) -> Result<Settings, ConfigProblem> {
    let settings: Settings = typed_config(descriptor, config)?;
    if let Some(uri) = given(&settings.uri) {
        let Some((_, hosts)) = uri_hosts(uri) else {
            return Err(ConfigProblem::invalid(
                "연결 문자열은 mongodb:// 또는 mongodb+srv://로 시작해야 합니다",
            ));
        };
        if hosts.is_empty() {
            return Err(ConfigProblem::invalid("연결 문자열에 호스트가 없습니다"));
        }
    } else {
        let host = given(&settings.host)
            .ok_or_else(|| ConfigProblem::invalid("호스트 또는 연결 문자열을 입력하세요"))?;
        check_host(host)?;
    }
    let auth = auth(&settings)?;
    if let Some(mechanism) = given(&settings.auth_mechanism) {
        // A mechanism with a choice of its own is picked there (PLAIN stays
        // usable with a password, as before LDAP had a choice).
        match Auth::of_mechanism(mechanism) {
            Some(own) if auth == Auth::Password && own != Auth::Ldap => {
                return Err(ConfigProblem::invalid(format!(
                    "{mechanism}는 사용자·비밀번호가 아니라 인증 방식에서 고르세요"
                )));
            }
            Some(_) => {}
            None => {
                AuthMechanism::from_str(mechanism).map_err(|_| {
                    ConfigProblem::invalid(format!("지원하지 않는 인증 방식입니다: {mechanism}"))
                })?;
            }
        }
    }
    if auth == Auth::Oidc {
        match given(&settings.oidc_flow).unwrap_or("human") {
            "human" | "k8s" => {}
            "azure" | "gcp" if given(&settings.oidc_token_resource).is_none() => {
                return Err(ConfigProblem::invalid(
                    "Azure·GCP OIDC에는 토큰 리소스(audience)가 필요합니다",
                ));
            }
            "azure" | "gcp" => {}
            other => {
                return Err(ConfigProblem::invalid(format!(
                    "OIDC 방식이 올바르지 않습니다: {other}"
                )))
            }
        }
    }
    if let Some(canonicalize) = given(&settings.kerberos_canonicalize) {
        if !["none", "forward", "forwardAndReverse"].contains(&canonicalize) {
            return Err(ConfigProblem::invalid(format!(
                "호스트 이름 정규화 값이 올바르지 않습니다: {canonicalize}"
            )));
        }
    }
    if let Some(preference) = given(&settings.read_preference) {
        read_preference(preference)?;
    }
    Ok(settings)
}

fn read_preference(name: &str) -> Result<ReadPreference, ConfigProblem> {
    let options = || Some(ReadPreferenceOptions::default());
    Ok(match name {
        "primary" => ReadPreference::Primary,
        "primaryPreferred" => ReadPreference::PrimaryPreferred { options: options() },
        "secondary" => ReadPreference::Secondary { options: options() },
        "secondaryPreferred" => ReadPreference::SecondaryPreferred { options: options() },
        "nearest" => ReadPreference::Nearest { options: options() },
        other => {
            return Err(ConfigProblem::invalid(format!(
                "읽기 선호 값이 올바르지 않습니다: {other}"
            )))
        }
    })
}

#[async_trait]
impl DriverFactory for Factory {
    fn descriptor(&self) -> &'static EngineDescriptor {
        &DESCRIPTOR
    }

    fn validate(&self, config: &ConnConfig) -> Result<(), ConfigProblem> {
        settings(self.descriptor(), config).map(|_| ())
    }

    /// A profile saved before the form had an authentication choice gets
    /// the one its settings imply (see `auth`).
    fn upgrade_config(&self, config: &mut ConnConfig) {
        if config.contains_key("auth") {
            return;
        }
        if let Ok(auth) =
            typed_config(self.descriptor(), config).and_then(|settings| auth(&settings))
        {
            config.insert("auth".into(), serde_json::Value::String(auth.name().into()));
        }
    }

    /// A user and password, an LDAP login, or an AWS access key take one
    /// (an AWS secret key is the password); no authentication, X.509,
    /// Kerberos (a ticket), OIDC, and AWS from the environment never read a
    /// stored password or ask for one.
    fn needs_password(&self, config: &ConnConfig) -> bool {
        let Ok(settings) = typed_config::<Settings>(self.descriptor(), config) else {
            return true;
        };
        match auth(&settings) {
            Ok(Auth::None | Auth::X509 | Auth::Kerberos | Auth::Oidc) => false,
            Ok(Auth::Aws) => {
                given(&settings.user).is_some() || given(&settings.uri).and_then(uri_user).is_some()
            }
            Ok(Auth::Password | Auth::Ldap) | Err(_) => true,
        }
    }

    /// A tunnel leads to one server, or, for an SRV name or a list of
    /// hosts, to every member the driver finds (see `route`).
    fn tunnel_target(&self, config: &ConnConfig) -> Result<TunnelTarget, ConfigProblem> {
        let settings = settings(self.descriptor(), config)?;
        match given(&settings.uri) {
            Some(uri) => match uri_hosts(uri) {
                Some((false, hosts)) if hosts.len() == 1 => {
                    let (host, port) = hosts.into_iter().next().unwrap_or_default();
                    Ok(TunnelTarget::Address(host, port.unwrap_or(DEFAULT_PORT)))
                }
                _ => Ok(TunnelTarget::Members),
            },
            None => Ok(TunnelTarget::Address(
                given(&settings.host).unwrap_or("127.0.0.1").to_string(),
                settings.port.unwrap_or(DEFAULT_PORT),
            )),
        }
    }

    /// From a connection string, its user, hosts and database, never its
    /// password.
    fn address(&self, config: &ConnConfig) -> String {
        let Ok(settings) = settings(self.descriptor(), config) else {
            return self.descriptor().detail(config);
        };
        match given(&settings.uri) {
            Some(uri) => {
                let hosts = uri_hosts(uri)
                    .map(|(_, hosts)| {
                        hosts
                            .iter()
                            .map(|(host, port)| match port {
                                Some(port) => format!("{host}:{port}"),
                                None => host.clone(),
                            })
                            .collect::<Vec<_>>()
                            .join(",")
                    })
                    .unwrap_or_default();
                let user = given(&settings.user)
                    .map(str::to_string)
                    .or_else(|| uri_user(uri));
                let database = given(&settings.database)
                    .map(str::to_string)
                    .or_else(|| uri_database(uri))
                    .unwrap_or_default();
                match user {
                    Some(user) => format!("{user}@{hosts}/{database}"),
                    None => format!("{hosts}/{database}"),
                }
            }
            None => self.descriptor().detail(config),
        }
    }

    async fn connect(
        &self,
        config: &ConnConfig,
        net: &NetRoute,
        log: SqlLog,
    ) -> Result<Arc<dyn Driver>, EngineError> {
        let settings = settings(self.descriptor(), config)
            .map_err(|problem| EngineError::BadRequest(problem.message))?;
        let label = self.address(config);
        MongoDriver::open(settings, net, label, log, None).await
    }
}

/// The user a connection string names, without its password.
fn uri_user(uri: &str) -> Option<String> {
    let rest = uri.split_once("://")?.1;
    let authority = rest.split(['/', '?']).next()?;
    let (credentials, _) = authority.rsplit_once('@')?;
    let user = credentials.split(':').next()?;
    (!user.is_empty()).then(|| percent_decode(user))
}

/// The default database a connection string names.
fn uri_database(uri: &str) -> Option<String> {
    let rest = uri.split_once("://")?.1;
    let path = rest.split('?').next()?.split_once('/')?.1;
    (!path.is_empty()).then(|| percent_decode(path))
}

/// An option of a connection string (`?authMechanism=…`), its name matched
/// regardless of case as the driver does.
fn uri_option(uri: &str, name: &str) -> Option<String> {
    let query = uri.split_once('?')?.1;
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        key.eq_ignore_ascii_case(name)
            .then(|| percent_decode(value))
    })
}

/// Turns a driver error into the engine's: the server's code, codeName,
/// message and errInfo where it gave them (`mongo_11000` reaches the page);
/// for a connection that failed, one line saying why (a wrong password, no
/// reachable primary, a refused port), the driver's whole dump kept as `raw`.
pub(crate) fn mongo_err(err: mongodb::error::Error) -> EngineError {
    use mongodb::error::{ErrorKind, WriteFailure};
    let mut fields = ErrorFields::default();
    let (code, message) = match err.kind.as_ref() {
        ErrorKind::Command(command) => {
            fields.code_name = Some(command.code_name.clone()).filter(|name| !name.is_empty());
            (Some(command.code), command.message.clone())
        }
        ErrorKind::Write(WriteFailure::WriteError(write)) => {
            fields.code_name = write.code_name.clone();
            fields.details =
                err_info(write.details.as_ref()).map(|info| json!({ "errInfo": info }));
            (Some(write.code), write.message.clone())
        }
        ErrorKind::Write(WriteFailure::WriteConcernError(concern)) => {
            fields.code_name = Some(concern.code_name.clone()).filter(|name| !name.is_empty());
            fields.details =
                err_info(concern.details.as_ref()).map(|info| json!({ "errInfo": info }));
            (Some(concern.code), concern.message.clone())
        }
        ErrorKind::InsertMany(insert) => {
            let writes = insert.write_errors.as_deref().unwrap_or_default();
            match writes.first() {
                Some(write) => {
                    fields.code_name = write.code_name.clone();
                    let mut details = json!({
                        "writeErrors": writes.iter().map(|write| {
                            let mut entry = json!({
                                "index": write.index,
                                "code": write.code,
                                "message": redact_uri_passwords(&write.message),
                            });
                            if let Some(name) = &write.code_name {
                                entry["code_name"] = json!(name);
                            }
                            if let Some(info) = err_info(write.details.as_ref()) {
                                entry["errInfo"] = info;
                            }
                            entry
                        }).collect::<Vec<_>>(),
                    });
                    if let Some(info) = err_info(write.details.as_ref()) {
                        details["errInfo"] = info;
                    }
                    fields.details = Some(details);
                    (Some(write.code), write.message.clone())
                }
                None => match insert.write_concern_error.as_ref() {
                    Some(concern) => (Some(concern.code), concern.message.clone()),
                    None => (None, err.kind.to_string()),
                },
            }
        }
        ErrorKind::Authentication { message, .. } => {
            // The server's refusal (18 AuthenticationFailed) is the cause.
            let refused = std::error::Error::source(&err)
                .and_then(|source| {
                    source.downcast_ref::<mongodb::error::Error>().or_else(|| {
                        source
                            .downcast_ref::<Box<mongodb::error::Error>>()
                            .map(|boxed| &**boxed)
                    })
                })
                .and_then(|source| match source.kind.as_ref() {
                    ErrorKind::Command(command) => Some(command),
                    _ => None,
                });
            match refused {
                Some(command) => {
                    fields.code_name =
                        Some(command.code_name.clone()).filter(|name| !name.is_empty());
                    (
                        Some(command.code),
                        format!("MongoDB 인증 실패: {}", command.message),
                    )
                }
                None => (None, format!("MongoDB 인증 실패: {message}")),
            }
        }
        ErrorKind::ServerSelection { message, .. } => {
            let (summary, details) = selection_summary(message);
            fields.details = Some(details);
            (None, summary)
        }
        ErrorKind::DnsResolve { message, .. } => (None, format!("DNS 조회 실패: {message}")),
        ErrorKind::Io(io) => (None, io_summary(&io.to_string(), None)),
        ErrorKind::InvalidTlsConfig { message, .. } => (None, format!("TLS 설정 오류: {message}")),
        // A browser login that failed says why itself.
        ErrorKind::Custom(_) if err.get_custom::<oidc::LoginFailed>().is_some() => (
            None,
            err.get_custom::<oidc::LoginFailed>()
                .map(|failed| failed.0.clone())
                .unwrap_or_default(),
        ),
        // The kind's own words, without the labels and source dump.
        other => (None, other.to_string()),
    };
    // The driver may echo the connection string it was given.
    let message = redact_uri_passwords(&message);
    let raw = redact_uri_passwords(&err.to_string());
    fields.server_code = code.map(i64::from);
    fields.raw = (raw != message).then_some(raw);
    EngineError::Driver {
        engine: "mongodb",
        code: code.map(|code| code.to_string()),
        message,
        // Interrupted (11601) is what killOp leaves.
        interrupted: matches!(code, Some(11601) | Some(11602)),
        fields: Box::new(fields),
    }
}

/// A write's errInfo (why validation failed, say) as canonical Extended JSON.
pub(crate) fn err_info(details: Option<&Document>) -> Option<serde_json::Value> {
    details
        .filter(|info| !info.is_empty())
        .map(|info| Bson::Document(info.clone()).into_canonical_extjson())
}

/// One line for a server selection that timed out, from the topology the
/// driver describes ("Topology: { Type: ReplicaSetNoPrimary, Set Name: rs0,
/// Servers: [ { Address: mongo1:27017, Type: Unknown, Error: Kind: …, labels:
/// {} } ] }"), and that topology as details.
fn selection_summary(message: &str) -> (String, serde_json::Value) {
    let topology = message
        .split_once("Topology: { ")
        .map_or("", |(_, rest)| rest);
    let field = |text: &str, name: &str| -> Option<String> {
        let (_, rest) = text.split_once(&format!("{name}: "))?;
        let end = rest.find([',', ' ', '}']).unwrap_or(rest.len());
        Some(rest[..end].to_string()).filter(|value| !value.is_empty())
    };
    let kind = field(topology, "Type");
    let set_name = field(topology, "Set Name");
    let servers: Vec<(String, Option<String>, Option<String>)> = topology
        .split("{ Address: ")
        .skip(1)
        .map(|server| {
            let address = server.split(',').next().unwrap_or("").trim().to_string();
            let kind = field(server, "Type");
            let error = server.split_once("Error: ").map(|(_, rest)| {
                let rest = rest.strip_prefix("Kind: ").unwrap_or(rest);
                let end = rest.find(", labels:").unwrap_or(rest.len());
                rest[..end].trim_end_matches([' ', '}', ']']).to_string()
            });
            (address, kind, error)
        })
        .collect();
    let details = json!({
        "topology": kind,
        "set_name": set_name,
        "servers": servers.iter().map(|(address, kind, error)| json!({
            "address": address,
            "type": kind,
            "error": error,
        })).collect::<Vec<_>>(),
    });
    let addresses = servers
        .iter()
        .map(|(address, ..)| address.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let first_error = servers
        .iter()
        .find_map(|(address, _, error)| error.as_deref().map(|error| (address.as_str(), error)));
    let summary = if kind.as_deref() == Some("ReplicaSetNoPrimary") {
        // Members are reached at the names the set reports for them, which
        // from here may not resolve (a container's hostname).
        let set = set_name.as_deref().unwrap_or("?");
        let members = if addresses.is_empty() {
            String::new()
        } else {
            format!(" (멤버: {addresses})")
        };
        format!(
            "복제 세트 '{set}'에서 닿을 수 있는 프라이머리가 없습니다{members} — 이 서버 하나에만 붙으려면 직접 연결(directConnection)을 켜세요"
        )
    } else if let Some((address, error)) = first_error {
        io_summary(error, Some(address))
    } else {
        let head = message.split(". Topology").next().unwrap_or(message);
        format!("서버를 고르지 못했습니다: {head}")
    };
    (summary, details)
}

/// One line for a network failure, by what the system said.
fn io_summary(error: &str, address: Option<&str>) -> String {
    let lower = error.to_lowercase();
    let at = address
        .map(|address| format!(": {address}"))
        .unwrap_or_default();
    if lower.contains("refused") {
        format!("서버에 연결할 수 없습니다 (연결 거부){at}")
    } else if lower.contains("lookup address")
        || lower.contains("nodename nor servname")
        || lower.contains("name or service not known")
        || lower.contains("no such host")
    {
        format!("호스트를 찾을 수 없습니다{at}")
    } else if lower.contains("timed out") || lower.contains("timeout") {
        format!("서버가 응답하지 않습니다 (시간 초과){at}")
    } else if lower.contains("tls") || lower.contains("certificate") || lower.contains("handshake")
    {
        format!("TLS 연결 실패{at}: {error}")
    } else {
        format!("서버에 연결할 수 없습니다{at}: {error}")
    }
}

/// An error of connecting that the driver didn't raise (an SRV name that
/// doesn't resolve), shaped as the driver's are: `mongodb_error`.
pub(super) fn failure(message: String) -> EngineError {
    EngineError::Driver {
        engine: "mongodb",
        code: None,
        message,
        interrupted: false,
        fields: Box::default(),
    }
}

/// The hosts an OIDC browser login may send its token to: the driver's own
/// list (Atlas, this machine) plus the hosts the settings name, and their
/// domain, which the members they lead to usually share.
fn oidc_allowed_hosts(hosts: &[ServerAddress]) -> Vec<Bson> {
    let mut allowed: Vec<String> = [
        "*.mongodb.net",
        "*.mongodb-qa.net",
        "*.mongodb-dev.net",
        "*.mongodbgov.net",
        "*.mongo.com",
        "localhost",
        "127.0.0.1",
        "::1",
    ]
    .map(String::from)
    .into();
    for address in hosts {
        let ServerAddress::Tcp { host, .. } = address else {
            continue;
        };
        let wildcard = host
            .split_once('.')
            .filter(|(_, parent)| parent.contains('.'))
            .map(|(_, parent)| format!("*.{parent}"));
        for pattern in wildcard.into_iter().chain([host.clone()]) {
            if !allowed.contains(&pattern) {
                allowed.push(pattern);
            }
        }
    }
    allowed.into_iter().map(Bson::String).collect()
}

pub(crate) struct MongoDriver {
    client: Client,
    label: String,
    default_db: Option<String>,
    /// "standalone", "replica_set" or "sharded", from the server's hello.
    topology: String,
    log: SqlLog,
    /// The comment tag of the read running now: a cancel kills the
    /// operations carrying it.
    running: Arc<Mutex<Option<String>>>,
    /// The SOCKS hop into a tunnel to a replica set or cluster, while the
    /// client uses it.
    _socks: Option<route::Socks>,
}

impl MongoDriver {
    /// `nameserver` resolves an SRV name instead of the system's DNS
    /// (tests).
    async fn open(
        settings: Settings,
        net: &NetRoute,
        label: String,
        log: SqlLog,
        nameserver: Option<std::net::SocketAddr>,
    ) -> Result<Arc<dyn Driver>, EngineError> {
        crate::ensure_crypto_provider();
        // Through a tunnel an SRV name is read here, so the driver starts
        // from the members it stands for (see `route`).
        let srv_seeds = matches!(net, NetRoute::Tunnel(_)).then_some(nameserver);
        let mut options = Self::client_options(&settings, srv_seeds).await?;
        // Through a tunnel to one server there is that one to talk to,
        // never the set's other members it would report. Through one to a
        // replica set or cluster, every member is reached by its name over
        // the SOCKS hop.
        let socks = match net {
            NetRoute::Direct => None,
            NetRoute::Via { host, port } => {
                options.hosts = vec![ServerAddress::Tcp {
                    host: host.clone(),
                    port: Some(*port),
                }];
                options.direct_connection = Some(true);
                None
            }
            NetRoute::Tunnel(forwarder) => {
                let socks = route::Socks::start(forwarder.clone()).await?;
                options.socks5_proxy = Some(
                    Socks5Proxy::builder()
                        .host("127.0.0.1".to_string())
                        .port(Some(socks.port))
                        .authentication(Some((socks.user.clone(), socks.password.clone())))
                        .build(),
                );
                Some(socks)
            }
        };
        options.server_selection_timeout = Some(SELECTION_TIMEOUT);
        options.connect_timeout = Some(SELECTION_TIMEOUT);
        options.app_name = Some("TablePeek".into());
        let default_db = options.default_database.clone();
        let client = Client::with_options(options).map_err(mongo_err)?;
        log.record_command("db.hello()");
        let hello = client
            .database("admin")
            .run_command(doc! { "hello": 1 })
            .await
            .map_err(mongo_err)?;
        let topology = if hello.get_str("msg") == Ok("isdbgrid") {
            "sharded"
        } else if hello.contains_key("setName") {
            "replica_set"
        } else {
            "standalone"
        };
        // The driver connects lazily: a wrong password shows only now.
        if let Some(db) = default_db.as_deref() {
            client
                .database(db)
                .run_command(doc! { "ping": 1 })
                .await
                .map_err(mongo_err)?;
        }
        Ok(Arc::new(MongoDriver {
            client,
            label,
            default_db,
            topology: topology.into(),
            log,
            running: Arc::new(Mutex::new(None)),
            _socks: socks,
        }))
    }

    /// The driver's options for `settings`, before any tunnel. With
    /// `srv_seeds` (and the DNS server it may name) an SRV name is resolved
    /// here into the members it stands for.
    async fn client_options(
        settings: &Settings,
        srv_seeds: Option<Option<std::net::SocketAddr>>,
    ) -> Result<ClientOptions, EngineError> {
        let mut options = match given(&settings.uri) {
            Some(uri) if srv_seeds.is_some() && uri.starts_with("mongodb+srv://") => {
                let nameserver = srv_seeds.flatten();
                let seeds = route::seed_list(uri, nameserver).await?;
                ClientOptions::parse(&seeds).await.map_err(mongo_err)?
            }
            Some(uri) => ClientOptions::parse(uri).await.map_err(mongo_err)?,
            None => {
                let mut options = ClientOptions::default();
                options.hosts = vec![ServerAddress::Tcp {
                    host: given(&settings.host).unwrap_or("127.0.0.1").to_string(),
                    port: Some(settings.port.unwrap_or(DEFAULT_PORT)),
                }];
                options
            }
        };
        let auth = auth(settings).map_err(|problem| EngineError::BadRequest(problem.message))?;
        let bad = |message: &str| EngineError::BadRequest(message.into());
        // Fields typed in the form win over the connection string's.
        let mut credential = options.credential.take().unwrap_or_default();
        let user = given(&settings.user).map(str::to_string);
        let password = given(&settings.password).map(str::to_string);
        let mut properties = credential.mechanism_properties.take().unwrap_or_default();
        let mut set_property = |name: &str, value: Option<&str>| {
            if let Some(value) = value {
                properties.insert(name, value);
            }
        };
        match auth {
            Auth::None | Auth::Password | Auth::X509 | Auth::Ldap => {}
            Auth::Aws => {
                set_property("AWS_SESSION_TOKEN", given(&settings.aws_session_token));
            }
            Auth::Kerberos => {
                set_property("SERVICE_NAME", given(&settings.kerberos_service_name));
                set_property("SERVICE_REALM", given(&settings.kerberos_service_realm));
                set_property("SERVICE_HOST", given(&settings.kerberos_service_host));
                set_property(
                    "CANONICALIZE_HOST_NAME",
                    given(&settings.kerberos_canonicalize),
                );
            }
            Auth::Oidc => match given(&settings.oidc_flow).unwrap_or("human") {
                "human" => {}
                environment => {
                    set_property("ENVIRONMENT", Some(environment));
                    set_property("TOKEN_RESOURCE", given(&settings.oidc_token_resource));
                }
            },
        }
        credential.mechanism_properties = (!properties.is_empty()).then_some(properties);
        match auth {
            // Not even a user the connection string names.
            Auth::None => credential = Default::default(),
            Auth::Password => {
                if user.is_some() {
                    credential.username = user;
                }
                if credential.username.is_none() {
                    return Err(bad("사용자를 입력하세요"));
                }
                if password.is_some() {
                    credential.password = password;
                }
                if let Some(name) = given(&settings.auth_mechanism) {
                    credential.mechanism = Some(AuthMechanism::from_str(name).map_err(mongo_err)?);
                }
                // Another mechanism the connection string names has a
                // choice of its own; a password means SCRAM (or PLAIN).
                if !matches!(
                    credential.mechanism,
                    None | Some(
                        AuthMechanism::ScramSha1
                            | AuthMechanism::ScramSha256
                            | AuthMechanism::Plain
                    )
                ) {
                    credential.mechanism = None;
                    credential.mechanism_properties = None;
                    // Its $external source went with it.
                    credential.source = None;
                }
                if let Some(source) = given(&settings.auth_source) {
                    credential.source = Some(source.to_string());
                } else if credential.source.is_none()
                    && matches!(
                        credential.mechanism,
                        None | Some(AuthMechanism::ScramSha1 | AuthMechanism::ScramSha256)
                    )
                {
                    credential.source = Some("admin".into());
                }
            }
            // The certificate says who it is; a password or another
            // database would only make the server refuse it.
            Auth::X509 => {
                credential.mechanism = Some(AuthMechanism::MongoDbX509);
                credential.password = None;
                credential.source = None;
                credential.mechanism_properties = None;
            }
            // The directory checks the password; users live in $external.
            Auth::Ldap => {
                if user.is_some() {
                    credential.username = user;
                }
                if password.is_some() {
                    credential.password = password;
                }
                if credential.username.is_none() {
                    return Err(bad("LDAP 사용자를 입력하세요"));
                }
                if credential.password.is_none() {
                    return Err(bad("LDAP 비밀번호를 입력하세요"));
                }
                credential.mechanism = Some(AuthMechanism::Plain);
                credential.source = Some("$external".into());
                credential.mechanism_properties = None;
            }
            // A key and its secret, or none at all: the environment's
            // credentials or the role the machine runs as.
            Auth::Aws => {
                if user.is_some() {
                    credential.username = user;
                }
                if password.is_some() {
                    credential.password = password;
                }
                if credential.username.is_some() && credential.password.is_none() {
                    return Err(bad("AWS 비밀 액세스 키를 입력하세요"));
                }
                if credential.username.is_none() {
                    // The environment brings its own session token too.
                    credential.password = None;
                    credential.mechanism_properties = None;
                }
                credential.mechanism = Some(AuthMechanism::MongoDbAws);
                credential.source = Some("$external".into());
            }
            // The ticket `kinit` left; the principal names whose it is.
            Auth::Kerberos => {
                #[cfg(any(target_os = "macos", feature = "kerberos"))]
                {
                    if user.is_some() {
                        credential.username = user;
                    }
                    if credential.username.is_none() {
                        return Err(bad("Kerberos 사용자 주체(principal)를 입력하세요"));
                    }
                    credential.mechanism = Some(AuthMechanism::Gssapi);
                    credential.source = Some("$external".into());
                    credential.password = None;
                }
                #[cfg(not(any(target_os = "macos", feature = "kerberos")))]
                return Err(bad(
                    "이 TablePeek 빌드에는 Kerberos(GSSAPI) 인증이 없습니다 (--features kerberos로 빌드하세요)",
                ));
            }
            Auth::Oidc => {
                credential.mechanism = Some(AuthMechanism::MongoDbOidc);
                credential.source = Some("$external".into());
                credential.password = None;
                match given(&settings.oidc_flow).unwrap_or("human") {
                    "human" => {
                        if user.is_some() {
                            credential.username = user;
                        }
                        let mut properties =
                            credential.mechanism_properties.take().unwrap_or_default();
                        properties.insert("ALLOWED_HOSTS", oidc_allowed_hosts(&options.hosts));
                        credential.mechanism_properties = Some(properties);
                        credential.oidc_callback = oidc::callback(credential.username.clone());
                    }
                    // Azure takes the managed identity's client id as the
                    // user; the others take none.
                    "azure" => {
                        if user.is_some() {
                            credential.username = user;
                        }
                    }
                    _ => credential.username = None,
                }
            }
        }
        options.credential = (auth != Auth::None).then_some(credential);
        if let Some(database) = given(&settings.database) {
            options.default_database = Some(database.to_string());
        }
        // X.509 always goes over TLS. TLS options the connection string
        // gave stay unless a file is picked in the form.
        if settings.tls == Some(true) || auth == Auth::X509 {
            let mut tls = match options.tls.take() {
                Some(Tls::Enabled(tls)) => tls,
                _ => TlsOptions::default(),
            };
            if let Some(path) = given(&settings.tls_ca_file) {
                tls.ca_file_path = Some(PathBuf::from(path));
            }
            if let Some(path) = given(&settings.tls_cert_key_file) {
                tls.cert_key_file_path = Some(PathBuf::from(path));
            }
            if auth == Auth::X509 && tls.cert_key_file_path.is_none() {
                return Err(EngineError::BadRequest(
                    "X.509 인증에는 클라이언트 인증서·키 파일이 필요합니다".into(),
                ));
            }
            options.tls = Some(Tls::Enabled(tls));
        }
        if settings.direct_connection == Some(true) {
            options.direct_connection = Some(true);
        }
        if let Some(name) = given(&settings.replica_set) {
            options.repl_set_name = Some(name.to_string());
        }
        if let Some(name) = given(&settings.read_preference) {
            let preference = read_preference(name)
                .map_err(|problem| EngineError::BadRequest(problem.message))?;
            options.selection_criteria = Some(SelectionCriteria::ReadPreference(preference));
        }
        Ok(options)
    }

    /// Database names, without MongoDB's own unless `include_system`.
    async fn database_names(&self, include_system: bool) -> Result<Vec<String>, EngineError> {
        self.log
            .record_command("db.adminCommand({ listDatabases: 1, nameOnly: true })");
        let reply = self
            .client
            .database("admin")
            .run_command(doc! { "listDatabases": 1, "nameOnly": true, "authorizedDatabases": true })
            .await
            .map_err(mongo_err)?;
        let mut names: Vec<String> = reply
            .get_array("databases")
            .map(|list| {
                list.iter()
                    .filter_map(|entry| entry.as_document()?.get_str("name").ok())
                    .filter(|name| include_system || !SYSTEM_DATABASES.contains(name))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        // A user allowed into one database may not list any.
        if let Some(db) = &self.default_db {
            if !names.contains(db) {
                names.push(db.clone());
            }
        }
        names.sort();
        Ok(names)
    }
}

#[async_trait]
impl Driver for MongoDriver {
    fn id(&self) -> &'static str {
        "mongodb"
    }

    /// Transactions need a replica set or a sharded cluster.
    fn capabilities(&self) -> Capabilities {
        let mut capabilities = DESCRIPTOR.capabilities.clone();
        capabilities.transactions = if self.topology == "standalone" {
            "none".into()
        } else {
            "replica_set".into()
        };
        capabilities
    }

    /// Collections as `db.collection`, every database's: the list the
    /// sidebar falls back to.
    async fn meta(&self, include_system: bool) -> Result<EngineMeta, EngineError> {
        let mut tables = Vec::new();
        for db in self.database_names(include_system).await? {
            let names = self
                .client
                .database(&db)
                .list_collection_names()
                .await
                .map_err(mongo_err)?;
            let mut names: Vec<String> = names
                .into_iter()
                .filter(|name| include_system || !name.starts_with("system."))
                .map(|name| format!("{db}.{name}"))
                .collect();
            names.sort();
            tables.extend(names);
        }
        Ok(EngineMeta {
            kind: "mongodb".into(),
            path: Some(self.label.clone()),
            demo: false,
            tables,
            capabilities: None,
        })
    }

    /// Kills the operations of the read running now, found by its comment.
    fn cancel(&self) -> CancelRequest {
        let Some(tag) = self
            .running
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
        else {
            return CancelRequest::Done;
        };
        let client = self.client.clone();
        let log = self.log.clone();
        let request = tokio::spawn(async move {
            let admin = client.database("admin");
            let pipeline = vec![
                doc! { "$currentOp": { "allUsers": true } },
                doc! { "$match": { "$or": [
                    { "command.comment": &tag },
                    { "cursor.originatingCommand.comment": &tag },
                ] } },
            ];
            let Ok(cursor) = admin.aggregate(pipeline).await else {
                return;
            };
            let Ok(ops) = cursor.try_collect::<Vec<Document>>().await else {
                return;
            };
            for op in ops {
                if let Some(opid) = op.get("opid").cloned() {
                    log.record_command(&format!("db.killOp({})", shell::value(&opid)));
                    let _ = admin.run_command(doc! { "killOp": 1, "op": opid }).await;
                }
            }
        });
        CancelRequest::Sent {
            request,
            lands_later: false,
        }
    }

    async fn server_info(&self) -> Result<ServerInfo, EngineError> {
        let admin = self.client.database("admin");
        self.log.record_command("db.adminCommand({ buildInfo: 1 })");
        let build = admin
            .run_command(doc! { "buildInfo": 1 })
            .await
            .map_err(mongo_err)?;
        let version = build.get_str("version").ok().map(str::to_string);
        self.log.record_command("db.adminCommand({ hello: 1 })");
        let hello = admin
            .run_command(doc! { "hello": 1 })
            .await
            .map_err(mongo_err)?;
        let host = hello.get_str("me").ok().map(str::to_string);
        // Uptime and sessions need rights a user may not have.
        self.log.record_command("db.serverStatus()");
        let uptime = admin
            .run_command(doc! { "serverStatus": 1 })
            .await
            .ok()
            .and_then(|status| number(status.get("uptime")?))
            .map(|seconds| crate::humanize_uptime_ko(seconds as i64));
        self.log
            .record_command("db.adminCommand({ listDatabases: 1 })");
        let size_bytes = admin
            .run_command(doc! { "listDatabases": 1, "authorizedDatabases": true })
            .await
            .ok()
            .and_then(|reply| number(reply.get("totalSize")?))
            .map(|size| size as i64);
        let sessions = self.sessions().await;
        Ok(ServerInfo {
            driver: "mongodb".into(),
            version,
            database: self.default_db.clone(),
            encoding: None,
            uptime,
            size_bytes,
            sessions,
            can_kill: false,
            topology: Some(self.topology.clone()),
            host,
        })
    }

    fn document(&self) -> Option<&dyn DocumentDriver> {
        Some(self)
    }
}

impl MongoDriver {
    /// Operations running now, from `$currentOp`; None without the right to
    /// see them.
    async fn sessions(&self) -> Option<Vec<ServerSession>> {
        self.log
            .record_command("db.aggregate([{ $currentOp: { allUsers: true } }])");
        let cursor = self
            .client
            .database("admin")
            .aggregate(vec![
                doc! { "$currentOp": { "allUsers": true, "idleConnections": false } },
            ])
            .await
            .ok()?;
        let ops: Vec<Document> = cursor.try_collect().await.ok()?;
        Some(
            ops.into_iter()
                .map(|op| {
                    let command = op.get_document("command").ok();
                    ServerSession {
                        id: op.get("opid").map(shell::value).unwrap_or_default(),
                        user: op
                            .get_array("effectiveUsers")
                            .ok()
                            .and_then(|users| users.first()?.as_document()?.get_str("user").ok())
                            .map(str::to_string),
                        database: op
                            .get_str("ns")
                            .ok()
                            .and_then(|ns| ns.split('.').next())
                            .map(str::to_string),
                        state: op.get_str("op").ok().map(str::to_string),
                        query: command
                            .map(|command| shell::value(&Bson::Document(command.clone()))),
                        elapsed_ms: op
                            .get("microsecs_running")
                            .and_then(number)
                            .map(|micros| (micros / 1000.0) as i64),
                        // This very listing: its pipeline starts with $currentOp.
                        is_current: command
                            .and_then(|command| command.get_array("pipeline").ok())
                            .and_then(|pipeline| pipeline.first()?.as_document())
                            .is_some_and(|stage| stage.contains_key("$currentOp")),
                    }
                })
                .collect(),
        )
    }
}

/// Any BSON number as f64.
fn number(value: &Bson) -> Option<f64> {
    match value {
        Bson::Int32(n) => Some(f64::from(*n)),
        Bson::Int64(n) => Some(*n as f64),
        Bson::Double(n) => Some(*n),
        _ => None,
    }
}

/// Holds a read's comment tag as the one running while it runs.
struct Running {
    slot: Arc<Mutex<Option<String>>>,
}

impl Running {
    fn start(slot: &Arc<Mutex<Option<String>>>) -> (Self, String) {
        let tag = format!("tablepeek:{}", uuid::Uuid::new_v4().simple());
        *slot.lock().unwrap_or_else(PoisonError::into_inner) = Some(tag.clone());
        (Self { slot: slot.clone() }, tag)
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        *self.slot.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn config(value: Value) -> ConnConfig {
        match value {
            Value::Object(map) => map,
            _ => unreachable!(),
        }
    }

    #[test]
    fn selection_timeouts_say_which_topology_failed() {
        let (summary, details) = selection_summary(
            "Server selection timeout: No available servers. Topology: { Type: \
             ReplicaSetNoPrimary, Set Name: rs0, Servers: [ { Address: mongo1:27017, Type: \
             Unknown, Error: Kind: I/O error: failed to lookup address information: nodename \
             nor servname provided, or not known, labels: {} } ] }",
        );
        assert!(
            summary.starts_with(
                "복제 세트 'rs0'에서 닿을 수 있는 프라이머리가 없습니다 (멤버: mongo1:27017)"
            ),
            "{summary}"
        );
        assert!(summary.contains("directConnection"), "{summary}");
        assert_eq!(details["topology"], json!("ReplicaSetNoPrimary"));
        assert_eq!(details["set_name"], json!("rs0"));
        assert_eq!(details["servers"][0]["address"], json!("mongo1:27017"));
        assert!(details["servers"][0]["error"]
            .as_str()
            .unwrap()
            .starts_with("I/O error: failed to lookup"));
        // One server that refused: the port, not the topology.
        let (summary, details) = selection_summary(
            "Server selection timeout: No available servers. Topology: { Type: Unknown, \
             Servers: [ { Address: 127.0.0.1:1, Type: Unknown, Error: Kind: I/O error: \
             Connection refused (os error 61), labels: {} } ] }",
        );
        assert_eq!(
            summary,
            "서버에 연결할 수 없습니다 (연결 거부): 127.0.0.1:1"
        );
        assert_eq!(details["topology"], json!("Unknown"));
        let (summary, _) = selection_summary(
            "Server selection timeout: No available servers. Topology: { Type: ReplicaSetNoPrimary, Set Name: rs0 }",
        );
        assert_eq!(
            summary,
            "복제 세트 'rs0'에서 닿을 수 있는 프라이머리가 없습니다 — 이 서버 하나에만 붙으려면 직접 연결(directConnection)을 켜세요"
        );
    }

    #[test]
    fn reads_hosts_from_connection_strings() {
        assert_eq!(
            uri_hosts("mongodb://u:p%40ss@a:27018,b/shop?replicaSet=rs0"),
            Some((
                false,
                vec![("a".to_string(), Some(27018)), ("b".to_string(), None)]
            ))
        );
        assert_eq!(
            uri_hosts("mongodb+srv://cluster0.example.net/"),
            Some((true, vec![("cluster0.example.net".to_string(), None)]))
        );
        assert_eq!(
            uri_hosts("mongodb://[::1]:27019"),
            Some((false, vec![("::1".to_string(), Some(27019))]))
        );
        assert_eq!(uri_hosts("postgres://h"), None);
        assert_eq!(
            uri_user("mongodb://app:secret@h/db").as_deref(),
            Some("app")
        );
        assert_eq!(
            uri_database("mongodb://h/shop?x=1").as_deref(),
            Some("shop")
        );
        assert_eq!(percent_decode("p%40ss"), "p@ss");
    }

    #[test]
    fn validates_and_names_where_tunnels_lead() {
        let factory = &FACTORY;
        assert_eq!(
            factory.validate(&ConnConfig::new()).unwrap_err().message,
            "MongoDB 접속 정보가 없습니다"
        );
        assert!(factory
            .validate(&config(json!({ "uri": "http://h" })))
            .is_err());
        assert!(factory.validate(&config(json!({ "port": 27017 }))).is_err());
        let single = config(json!({ "uri": "mongodb://u:pw@db:27018/shop" }));
        assert_eq!(
            factory.tunnel_target(&single),
            Ok(TunnelTarget::Address("db".into(), 27018))
        );
        // An SRV name or a seed list: every member, through the tunnel.
        for members in [
            json!({ "uri": "mongodb+srv://cluster0.example.net" }),
            json!({ "uri": "mongodb://a,b/shop" }),
        ] {
            assert_eq!(
                factory.tunnel_target(&config(members)),
                Ok(TunnelTarget::Members)
            );
        }
        let fields = config(json!({ "host": "db", "user": "app", "database": "shop" }));
        assert_eq!(
            factory.tunnel_target(&fields),
            Ok(TunnelTarget::Address("db".into(), 27017))
        );
        assert_eq!(factory.address(&fields), "app@db:27017/shop");
        // A connection string's password never reaches the label.
        assert_eq!(factory.address(&single), "u@db:27018/shop");
    }

    /// The auth choice a profile saved before the form had one gets.
    fn upgraded(value: Value) -> Option<Value> {
        let mut config = config(value);
        FACTORY.upgrade_config(&mut config);
        config.get("auth").cloned()
    }

    #[test]
    fn profiles_without_an_auth_choice_get_the_one_they_imply() {
        for (old, want) in [
            (json!({ "host": "db" }), "none"),
            (json!({ "host": "db", "user": "app" }), "password"),
            (json!({ "host": "db", "user": " " }), "none"),
            (json!({ "uri": "mongodb://app@a,b/shop" }), "password"),
            (
                json!({ "host": "db", "auth_mechanism": "MONGODB-X509", "tls": true }),
                "x509",
            ),
            // The X.509 mechanism wins over the certificate's subject as a user.
            (
                json!({ "uri": "mongodb://CN=app@a,b/?authMechanism=mongodb-x509&tls=true" }),
                "x509",
            ),
            (
                json!({ "host": "db", "user": "app", "auth_mechanism": "SCRAM-SHA-1" }),
                "password",
            ),
            // Mechanisms with a choice of their own, from a connection string.
            (
                json!({ "uri": "mongodb://AKIA@db/?authMechanism=MONGODB-AWS" }),
                "aws",
            ),
            (
                json!({ "uri": "mongodb://ann@db/?authMechanism=PLAIN&authSource=$external" }),
                "ldap",
            ),
            (
                json!({ "uri": "mongodb://ann%40EXAMPLE.COM@db/?authMechanism=GSSAPI" }),
                "kerberos",
            ),
            (
                json!({ "uri": "mongodb://db/?authMechanism=MONGODB-OIDC" }),
                "oidc",
            ),
        ] {
            assert_eq!(upgraded(old.clone()), Some(json!(want)), "{old}");
        }
        // A choice already made stays, even where the rest would say otherwise.
        assert_eq!(
            upgraded(json!({ "host": "db", "user": "app", "auth": "none" })),
            Some(json!("none"))
        );
    }

    #[test]
    fn only_choices_with_a_secret_take_a_password() {
        let needs = |value: Value| FACTORY.needs_password(&config(value));
        assert!(needs(
            json!({ "host": "db", "auth": "password", "user": "app" })
        ));
        assert!(needs(
            json!({ "host": "db", "auth": "ldap", "user": "ann" })
        ));
        assert!(!needs(
            json!({ "host": "db", "auth": "none", "user": "app" })
        ));
        assert!(!needs(json!({ "host": "db", "auth": "x509", "tls": true })));
        assert!(!needs(
            json!({ "host": "db", "auth": "kerberos", "user": "ann@EXAMPLE.COM" })
        ));
        assert!(!needs(json!({ "host": "db", "auth": "oidc" })));
        // AWS takes its secret key only with an access key; without one the
        // environment or role signs.
        assert!(needs(
            json!({ "host": "db", "auth": "aws", "user": "AKIA1" })
        ));
        assert!(!needs(json!({ "host": "db", "auth": "aws" })));
        // Saved before the choice: by what the profile has.
        assert!(needs(json!({ "host": "db", "user": "app" })));
        assert!(!needs(json!({ "host": "db" })));
    }

    #[test]
    fn auth_choices_are_checked() {
        let factory = &FACTORY;
        for good in [
            "none", "password", "x509", "aws", "ldap", "kerberos", "oidc",
        ] {
            assert!(factory
                .validate(&config(json!({ "host": "db", "auth": good })))
                .is_ok());
        }
        assert_eq!(
            factory
                .validate(&config(json!({ "host": "db", "auth": "ntlm" })))
                .unwrap_err()
                .message,
            "지원하지 않는 인증 방식입니다: ntlm"
        );
        // A mechanism with a choice of its own is never a password's.
        for own in ["MONGODB-X509", "MONGODB-AWS", "GSSAPI", "MONGODB-OIDC"] {
            assert!(factory
                .validate(&config(json!({
                    "host": "db", "auth": "password", "user": "app", "auth_mechanism": own
                })))
                .is_err());
        }
        for fine in ["SCRAM-SHA-256", "PLAIN"] {
            assert!(factory
                .validate(&config(json!({
                    "host": "db", "auth": "password", "user": "app", "auth_mechanism": fine
                })))
                .is_ok());
        }
        let oidc = |flow: &str, resource: Option<&str>| {
            let mut value = json!({ "host": "db", "auth": "oidc", "oidc_flow": flow });
            if let Some(resource) = resource {
                value["oidc_token_resource"] = json!(resource);
            }
            factory.validate(&config(value))
        };
        assert!(oidc("human", None).is_ok());
        assert!(oidc("k8s", None).is_ok());
        assert!(oidc("azure", Some("api://mongo")).is_ok());
        assert_eq!(
            oidc("gcp", None).unwrap_err().message,
            "Azure·GCP OIDC에는 토큰 리소스(audience)가 필요합니다"
        );
        assert!(oidc("okta", None).is_err());
        assert!(factory
            .validate(&config(json!({
                "host": "db", "auth": "kerberos", "kerberos_canonicalize": "sometimes"
            })))
            .is_err());
    }

    /// The driver options `value` gives, before any tunnel.
    async fn options(value: Value) -> Result<ClientOptions, EngineError> {
        let settings = settings(&DESCRIPTOR, &config(value)).unwrap();
        MongoDriver::client_options(&settings, None).await
    }

    #[tokio::test]
    async fn each_choice_sends_its_own_credential() {
        let credential = |options: ClientOptions| options.credential.unwrap();
        let property = |options: &ClientOptions, name: &str| {
            options
                .credential
                .as_ref()
                .and_then(|credential| credential.mechanism_properties.as_ref())
                .and_then(|properties| properties.get(name).cloned())
        };

        // LDAP: PLAIN in $external, whatever authSource the form kept.
        let ldap = credential(
            options(json!({
                "host": "db", "auth": "ldap", "user": "ann", "password": "pw", "auth_source": "admin"
            }))
            .await
            .unwrap(),
        );
        assert_eq!(ldap.mechanism, Some(AuthMechanism::Plain));
        assert_eq!(ldap.source.as_deref(), Some("$external"));
        assert_eq!(ldap.username.as_deref(), Some("ann"));
        assert_eq!(ldap.password.as_deref(), Some("pw"));
        assert!(matches!(
            options(json!({ "host": "db", "auth": "ldap", "user": "ann" })).await,
            Err(EngineError::BadRequest(message)) if message == "LDAP 비밀번호를 입력하세요"
        ));

        // AWS with a key: the key, its secret and the session token.
        let keyed = options(json!({
            "host": "db", "auth": "aws", "user": "AKIA1", "password": "secret",
            "aws_session_token": "token"
        }))
        .await
        .unwrap();
        assert_eq!(
            property(&keyed, "AWS_SESSION_TOKEN"),
            Some(Bson::from("token"))
        );
        let keyed = credential(keyed);
        assert_eq!(keyed.mechanism, Some(AuthMechanism::MongoDbAws));
        assert_eq!(keyed.username.as_deref(), Some("AKIA1"));
        assert_eq!(keyed.password.as_deref(), Some("secret"));
        // Without one: nothing but the mechanism, even a stale token.
        let ambient = credential(
            options(json!({
                "host": "db", "auth": "aws", "password": "stale", "aws_session_token": "stale"
            }))
            .await
            .unwrap(),
        );
        assert_eq!(ambient.mechanism, Some(AuthMechanism::MongoDbAws));
        assert!(ambient.username.is_none() && ambient.password.is_none());
        assert!(ambient.mechanism_properties.is_none());
        assert!(matches!(
            options(json!({ "host": "db", "auth": "aws", "user": "AKIA1" })).await,
            Err(EngineError::BadRequest(_))
        ));

        // OIDC on a platform: its environment and token resource.
        let azure = options(json!({
            "host": "db", "auth": "oidc", "oidc_flow": "azure",
            "oidc_token_resource": "api://mongo", "user": "client-id", "password": "ignored"
        }))
        .await
        .unwrap();
        assert_eq!(property(&azure, "ENVIRONMENT"), Some(Bson::from("azure")));
        assert_eq!(
            property(&azure, "TOKEN_RESOURCE"),
            Some(Bson::from("api://mongo"))
        );
        let azure = credential(azure);
        assert_eq!(azure.mechanism, Some(AuthMechanism::MongoDbOidc));
        assert_eq!(azure.username.as_deref(), Some("client-id"));
        assert!(azure.password.is_none());
        // A browser login: no environment, and the hosts named are allowed.
        let human = options(json!({
            "uri": "mongodb://db1.corp.example:27017,db2.corp.example/?replicaSet=rs0",
            "auth": "oidc", "oidc_flow": "human"
        }))
        .await
        .unwrap();
        assert_eq!(property(&human, "ENVIRONMENT"), None);
        let Some(Bson::Array(allowed)) = property(&human, "ALLOWED_HOSTS") else {
            panic!("no ALLOWED_HOSTS");
        };
        for host in [
            "db1.corp.example",
            "db2.corp.example",
            "*.corp.example",
            "*.mongodb.net",
        ] {
            assert!(allowed.contains(&Bson::from(host)), "{host}");
        }

        // Kerberos: the principal and the service properties typed.
        let kerberos = options(json!({
            "host": "db", "auth": "kerberos", "user": "ann@EXAMPLE.COM",
            "kerberos_service_name": "mongo", "kerberos_service_realm": "EXAMPLE.COM",
            "kerberos_service_host": "db.example.com", "kerberos_canonicalize": "forward"
        }))
        .await;
        #[cfg(any(target_os = "macos", feature = "kerberos"))]
        {
            let kerberos = kerberos.unwrap();
            assert_eq!(
                property(&kerberos, "SERVICE_NAME"),
                Some(Bson::from("mongo"))
            );
            assert_eq!(
                property(&kerberos, "SERVICE_REALM"),
                Some(Bson::from("EXAMPLE.COM"))
            );
            assert_eq!(
                property(&kerberos, "SERVICE_HOST"),
                Some(Bson::from("db.example.com"))
            );
            assert_eq!(
                property(&kerberos, "CANONICALIZE_HOST_NAME"),
                Some(Bson::from("forward"))
            );
            let kerberos = credential(kerberos);
            assert_eq!(kerberos.mechanism, Some(AuthMechanism::Gssapi));
            assert_eq!(kerberos.source.as_deref(), Some("$external"));
            assert_eq!(kerberos.username.as_deref(), Some("ann@EXAMPLE.COM"));
        }
        #[cfg(not(any(target_os = "macos", feature = "kerberos")))]
        assert!(matches!(kerberos, Err(EngineError::BadRequest(_))));

        // A password choice drops a mechanism of another choice the
        // connection string names.
        let password = credential(
            options(json!({
                "uri": "mongodb://app:pw@db/?authMechanism=MONGODB-AWS", "auth": "password"
            }))
            .await
            .unwrap(),
        );
        assert_eq!(password.mechanism, None);
        assert_eq!(password.source.as_deref(), Some("admin"));
    }
}

/// Against the test server of `make test-db ENGINE=mongodb` (a one-member
/// replica set on 127.0.0.1:27018, seeded `shop`); writes go to a scratch
/// collection in `tablepeek_test`.
#[cfg(test)]
mod live {
    use super::*;
    use crate::driver::{
        AggregateRequest, CommandRequest, CountRequest, CreateIndexRequest, DistinctRequest,
        DropIndexRequest, ExplainFind, ExplainRequest, ExportRequest, FindRequest, InsertRequest,
        QueryOptions, UpdateRequest,
    };
    use futures_util::StreamExt;
    use serde_json::{json, Value};

    fn enabled() -> bool {
        std::env::var("TABLEPEEK_TEST_MONGODB").is_ok()
    }

    async fn connect(auth: bool) -> Arc<dyn Driver> {
        let mut config = json!({
            "host": "127.0.0.1", "port": 27018, "direct_connection": true,
            "database": "tablepeek_test"
        });
        if auth {
            config["user"] = json!("tablepeek");
            config["password"] = json!("tablepeek_test_pw");
            config["auth_source"] = json!("admin");
        }
        let Value::Object(config) = config else {
            unreachable!()
        };
        FACTORY
            .connect(&config, &NetRoute::Direct, SqlLog::new())
            .await
            .expect("MongoDB 연결 실패")
    }

    fn scratch() -> String {
        format!("tp_{}", uuid::Uuid::new_v4().simple())
    }

    async fn drop_collection(ops: &dyn DocumentDriver, coll: &str) {
        let _ = ops
            .command(&CommandRequest {
                db: "tablepeek_test".into(),
                command: json!({ "drop": coll }),
                confirmed: true,
                poll: false,
            })
            .await;
    }

    #[tokio::test]
    async fn connects_and_lists() {
        if !enabled() {
            return;
        }
        for auth in [false, true] {
            let driver = connect(auth).await;
            assert_eq!(driver.capabilities().transactions, "replica_set");
            let meta = driver.meta(false).await.unwrap();
            assert_eq!(meta.kind, "mongodb");
            assert!(
                meta.tables.iter().any(|name| name == "shop.orders"),
                "{:?}",
                meta.tables
            );
            let ops = driver.document().unwrap();
            let databases = ops.databases().await.unwrap();
            assert!(databases.iter().any(|db| db.name == "shop"));
            let collections = ops.collections("shop").await.unwrap();
            let orders = collections.iter().find(|c| c.name == "orders").unwrap();
            assert_eq!(orders.kind, "collection");
            assert_eq!(orders.count, Some(2000));
            let view = collections
                .iter()
                .find(|c| c.name == "order_totals_by_status")
                .unwrap();
            assert_eq!(view.kind, "view");
            assert_eq!(view.count, None);
            let stats = ops.stats("shop", "orders").await.unwrap();
            assert!(stats.get("indexSizes").is_some(), "{stats}");
            let info = driver.server_info().await.unwrap();
            assert_eq!(info.topology.as_deref(), Some("replica_set"));
            assert!(info.version.is_some());
        }
        // A wrong password fails at connect, not at the first query.
        let Value::Object(config) = json!({
            "host": "127.0.0.1", "port": 27018, "direct_connection": true,
            "user": "tablepeek", "password": "wrong"
        }) else {
            unreachable!()
        };
        let err = FACTORY
            .connect(&config, &NetRoute::Direct, SqlLog::new())
            .await
            .err()
            .expect("wrong password connects");
        assert!(
            err.to_string().contains("Authentication") || err.to_string().contains("auth"),
            "{err}"
        );
    }

    #[tokio::test]
    async fn the_auth_choice_decides_what_is_sent() {
        if !enabled() {
            return;
        }
        let open = |value: Value| async move {
            let Value::Object(config) = value else {
                unreachable!()
            };
            FACTORY
                .connect(&config, &NetRoute::Direct, SqlLog::new())
                .await
        };
        let base = json!({
            "host": "127.0.0.1", "port": 27018, "direct_connection": true,
            "database": "tablepeek_test", "user": "tablepeek", "password": "wrong"
        });
        // No authentication: a stored user and password are left out, so a
        // wrong one can't fail the login.
        let mut none = base.clone();
        none["auth"] = json!("none");
        assert!(open(none).await.is_ok());
        // A user and password: sent, and the wrong one fails.
        let mut wrong = base.clone();
        wrong["auth"] = json!("password");
        assert!(open(wrong.clone()).await.is_err());
        wrong["password"] = json!("tablepeek_test_pw");
        wrong["auth_source"] = json!("admin");
        let driver = open(wrong).await.expect("password login");
        assert!(driver.meta(false).await.is_ok());
        // X.509 never sends the password and needs a client certificate,
        // asked for before anything is sent.
        let mut x509 = base.clone();
        x509["auth"] = json!("x509");
        let err = open(x509).await.err().expect("X.509 without a certificate");
        assert_eq!(
            err.to_string(),
            "X.509 인증에는 클라이언트 인증서·키 파일이 필요합니다"
        );
        // Password login with no user anywhere is refused up front.
        let Value::Object(mut no_user) = base.clone() else {
            unreachable!()
        };
        no_user.remove("user");
        no_user.insert("auth".into(), json!("password"));
        let err = open(Value::Object(no_user)).await.err().expect("no user");
        assert_eq!(err.to_string(), "사용자를 입력하세요");
    }

    #[tokio::test]
    async fn reads_shop() {
        if !enabled() {
            return;
        }
        let driver = connect(true).await;
        let ops = driver.document().unwrap();
        let batch = ops
            .find(&FindRequest {
                db: "shop".into(),
                coll: "orders".into(),
                filter: json!({}),
                projection: Some(json!({ "status": 1 })),
                sort: Some(json!({ "_id": 1 })),
                skip: Some(1),
                limit: 2,
                options: QueryOptions {
                    max_time_ms: Some(5_000),
                    ..QueryOptions::default()
                },
                poll: false,
            })
            .await
            .unwrap();
        assert_eq!(batch.docs.len(), 2);
        assert!(batch.docs[0]["_id"].get("$oid").is_some() || batch.docs[0].get("_id").is_some());
        let estimated = ops
            .count(&CountRequest {
                db: "shop".into(),
                coll: "orders".into(),
                filter: json!({}),
                options: QueryOptions::default(),
            })
            .await
            .unwrap();
        assert_eq!((estimated.count, estimated.exact), (Some(2000), false));
        let exact = ops
            .count(&CountRequest {
                db: "shop".into(),
                coll: "orders".into(),
                filter: json!({ "_id": { "$exists": true } }),
                options: QueryOptions::default(),
            })
            .await
            .unwrap();
        assert_eq!((exact.count, exact.exact), (Some(2000), true));
        let grouped = ops
            .aggregate(&AggregateRequest {
                db: "shop".into(),
                coll: "orders".into(),
                pipeline: vec![
                    json!({ "$group": { "_id": "$status", "n": { "$sum": 1 } } }),
                    json!({ "$sort": { "_id": 1 } }),
                ],
                options: QueryOptions::default(),
                confirmed: false,
            })
            .await
            .unwrap();
        assert!(!grouped.docs.is_empty());
        let statuses = ops
            .distinct(&DistinctRequest {
                db: "shop".into(),
                coll: "orders".into(),
                key: "status".into(),
                filter: json!({}),
            })
            .await
            .unwrap();
        assert_eq!(statuses.len(), grouped.docs.len());
        let plan = ops
            .explain(&ExplainRequest {
                db: "shop".into(),
                coll: "orders".into(),
                find: Some(ExplainFind {
                    filter: json!({ "status": "paid" }),
                    projection: None,
                    sort: None,
                    skip: None,
                    limit: Some(5),
                }),
                aggregate: None,
                verbosity: "executionStats".into(),
                options: QueryOptions::default(),
            })
            .await
            .unwrap();
        assert!(plan.get("queryPlanner").is_some(), "{plan}");
        assert!(
            plan["executionStats"].get("totalDocsExamined").is_some(),
            "{plan}"
        );
    }

    #[tokio::test]
    async fn types_survive_a_round_trip() {
        if !enabled() {
            return;
        }
        let driver = connect(false).await;
        let ops = driver.document().unwrap();
        let coll = scratch();
        let doc = json!({
            "_id": { "$oid": "64b7f0c2a1b2c3d4e5f60718" },
            "price": { "$numberDecimal": "12345678901234567890.123456789" },
            "big": { "$numberLong": "9007199254740993" },
            "small": { "$numberInt": "7" },
            "ratio": { "$numberDouble": "0.1" },
            "at": { "$date": { "$numberLong": "1700000000123" } },
            "uuid": { "$binary": { "base64": "ASNFZ4mrze8BI0VniavN7w==", "subType": "04" } },
            "raw": { "$binary": { "base64": "AAEC", "subType": "00" } },
            "nested": { "list": [{ "$numberLong": "1" }, null, true] }
        });
        let ids = ops
            .insert(&InsertRequest {
                db: "tablepeek_test".into(),
                coll: coll.clone(),
                docs: vec![doc.clone()],
                ordered: None,
            })
            .await
            .unwrap();
        assert_eq!(
            ids.inserted_ids,
            vec![json!({ "$oid": "64b7f0c2a1b2c3d4e5f60718" })]
        );
        assert!(ids.errors.is_empty());
        let found = ops
            .find(&FindRequest {
                db: "tablepeek_test".into(),
                coll: coll.clone(),
                filter: json!({ "_id": { "$oid": "64b7f0c2a1b2c3d4e5f60718" } }),
                projection: None,
                sort: None,
                skip: None,
                limit: 1,
                options: QueryOptions::default(),
                poll: false,
            })
            .await
            .unwrap();
        assert_eq!(found.docs, vec![doc]);
        drop_collection(ops, &coll).await;
    }

    #[tokio::test]
    async fn guarded_updates_notice_changes_made_elsewhere() {
        if !enabled() {
            return;
        }
        let driver = connect(false).await;
        let ops = driver.document().unwrap();
        let coll = scratch();
        ops.insert(&InsertRequest {
            db: "tablepeek_test".into(),
            coll: coll.clone(),
            docs: vec![json!({ "_id": 1, "status": "pending", "items": [{ "qty": 2 }] })],
            ordered: None,
        })
        .await
        .unwrap();
        let guarded = |status: &str| UpdateRequest {
            db: "tablepeek_test".into(),
            coll: coll.clone(),
            filter: json!({ "_id": 1, "status": status, "items.0": { "qty": 2 } }),
            update: json!({ "$set": { "status": "paid" } }),
            many: false,
            upsert: false,
            confirmed: false,
            options: crate::driver::WriteOptions::default(),
        };
        let first = ops.update(&guarded("pending")).await.unwrap();
        assert_eq!((first.matched, first.modified), (1, 1));
        // Read before the first update: the guard no longer matches.
        let stale = ops.update(&guarded("pending")).await.unwrap();
        assert_eq!((stale.matched, stale.modified), (0, 0));
        // A shell write needs no `_id`: any filter but an empty one goes as sent.
        let by_status = UpdateRequest {
            db: "tablepeek_test".into(),
            coll: coll.clone(),
            filter: json!({ "status": "paid" }),
            update: json!({ "$set": { "status": "shipped" } }),
            many: false,
            upsert: false,
            confirmed: false,
            options: crate::driver::WriteOptions::default(),
        };
        crate::driver::check_write(&by_status.filter, by_status.confirmed).unwrap();
        let shipped = ops.update(&by_status).await.unwrap();
        assert_eq!((shipped.matched, shipped.modified), (1, 1));
        assert!(crate::driver::check_write(&json!({}), false).is_err());
        assert!(crate::driver::check_write(&Value::Null, false).is_err());
        crate::driver::check_write(&json!({}), true).unwrap();
        drop_collection(ops, &coll).await;
    }

    #[tokio::test]
    async fn indexes_come_and_go() {
        if !enabled() {
            return;
        }
        let driver = connect(true).await;
        let ops = driver.document().unwrap();
        let coll = scratch();
        ops.insert(&InsertRequest {
            db: "tablepeek_test".into(),
            coll: coll.clone(),
            docs: vec![json!({ "status": "a" }), json!({ "status": "b" })],
            ordered: None,
        })
        .await
        .unwrap();
        let name = ops
            .create_index(&CreateIndexRequest {
                db: "tablepeek_test".into(),
                coll: coll.clone(),
                keys: json!({ "status": 1, "at": -1 }),
                options: json!({ "unique": false, "sparse": true }),
            })
            .await
            .unwrap();
        assert_eq!(name, "status_1_at_-1");
        let indexes = ops.indexes("tablepeek_test", &coll).await.unwrap();
        let made = indexes
            .iter()
            .find(|index| index["name"] == json!(name))
            .unwrap();
        assert_eq!(made["sparse"], json!(true));
        assert!(
            made.get("size").is_some() && made.get("ops").is_some(),
            "{made}"
        );
        ops.drop_index(&DropIndexRequest {
            db: "tablepeek_test".into(),
            coll: coll.clone(),
            name: name.clone(),
        })
        .await
        .unwrap();
        let indexes = ops.indexes("tablepeek_test", &coll).await.unwrap();
        assert!(indexes.iter().all(|index| index["name"] != json!(name)));
        // A server error keeps its code.
        let err = ops
            .insert(&InsertRequest {
                db: "tablepeek_test".into(),
                coll: coll.clone(),
                docs: vec![json!({ "_id": 1 }), json!({ "_id": 1 })],
                ordered: None,
            })
            .await
            .unwrap_err();
        assert!(
            matches!(&err, EngineError::Driver { code: Some(code), .. } if code == "11000"),
            "{err:?}"
        );
        drop_collection(ops, &coll).await;
    }

    #[tokio::test]
    async fn cancel_stops_the_running_read() {
        if !enabled() {
            return;
        }
        let driver = connect(false).await;
        let reader = driver.clone();
        let read = tokio::spawn(async move {
            reader
                .document()
                .unwrap()
                .find(&FindRequest {
                    db: "shop".into(),
                    coll: "orders".into(),
                    // Slow on purpose: a tenth of a second per document.
                    filter: json!({ "$where": "sleep(100) || true" }),
                    projection: None,
                    sort: None,
                    skip: None,
                    limit: 1000,
                    options: QueryOptions::default(),
                    poll: false,
                })
                .await
        });
        tokio::time::sleep(Duration::from_millis(500)).await;
        let CancelRequest::Sent { request, .. } = driver.cancel() else {
            panic!("nothing was running");
        };
        request.await.unwrap();
        let err = tokio::time::timeout(Duration::from_secs(10), read)
            .await
            .expect("the read went on")
            .unwrap()
            .unwrap_err();
        assert!(err.is_interrupted(), "{err:?}");
        assert!(matches!(driver.cancel(), CancelRequest::Done));
    }

    /// A connection whose History (the changes it reports) the test reads.
    async fn connect_logged() -> (
        Arc<dyn Driver>,
        tokio::sync::mpsc::UnboundedReceiver<crate::sql_log::Change>,
    ) {
        let log = SqlLog::new();
        let changes = log.take_changes().unwrap();
        let Value::Object(config) = json!({
            "host": "127.0.0.1", "port": 27018, "direct_connection": true,
            "user": "tablepeek", "password": "tablepeek_test_pw", "auth_source": "admin"
        }) else {
            unreachable!()
        };
        let driver = FACTORY
            .connect(&config, &NetRoute::Direct, log)
            .await
            .expect("MongoDB 연결 실패");
        (driver, changes)
    }

    fn history(
        changes: &mut tokio::sync::mpsc::UnboundedReceiver<crate::sql_log::Change>,
    ) -> Vec<String> {
        std::iter::from_fn(|| changes.try_recv().ok())
            .map(|change| change.sql)
            .collect()
    }

    async fn run(ops: &dyn DocumentDriver, db: &str, command: Value) -> Value {
        ops.command(&CommandRequest {
            db: db.into(),
            command: command.clone(),
            confirmed: true,
            poll: false,
        })
        .await
        .unwrap_or_else(|err| panic!("{command}: {err}"))
    }

    #[tokio::test]
    async fn unordered_insert_skips_failed_documents() {
        if !enabled() {
            return;
        }
        let (driver, mut changes) = connect_logged().await;
        let ops = driver.document().unwrap();
        let coll = scratch();
        let outcome = ops
            .insert(&InsertRequest {
                db: "tablepeek_test".into(),
                coll: coll.clone(),
                docs: vec![
                    json!({ "_id": 1 }),
                    json!({ "_id": 1 }),
                    json!({ "_id": 2 }),
                    json!({ "name": "no id" }),
                    json!({ "_id": 2 }),
                ],
                ordered: Some(false),
            })
            .await
            .unwrap();
        assert_eq!(outcome.inserted_ids.len(), 3, "{outcome:?}");
        assert_eq!(outcome.inserted_ids[0], json!({ "$numberInt": "1" }));
        assert_eq!(outcome.inserted_ids[1], json!({ "$numberInt": "2" }));
        assert!(outcome.inserted_ids[2].get("$oid").is_some(), "{outcome:?}");
        let failed: Vec<(usize, &str)> = outcome
            .errors
            .iter()
            .map(|failure| (failure.index, failure.code.as_str()))
            .collect();
        assert_eq!(failed, vec![(1, "mongo_11000"), (4, "mongo_11000")]);
        let stored = ops
            .count(&CountRequest {
                db: "tablepeek_test".into(),
                coll: coll.clone(),
                filter: json!({ "_id": { "$exists": true } }),
                options: QueryOptions::default(),
            })
            .await
            .unwrap();
        assert_eq!(stored.count, Some(3));
        let written = history(&mut changes);
        assert!(
            written.iter().any(|sql| sql.ends_with(
                r#".insertMany([{ _id: 1 }, { _id: 1 }, /* 외 3개 */], { ordered: false })"#
            )),
            "{written:?}"
        );
        // Ordered with errors asked for: the ones before the failure went
        // in, the failure is reported, nothing after it is tried.
        let stopped = ops
            .insert(&InsertRequest {
                db: "tablepeek_test".into(),
                coll: coll.clone(),
                docs: vec![
                    json!({ "_id": 10 }),
                    json!({ "_id": 1 }),
                    json!({ "_id": 11 }),
                ],
                ordered: Some(true),
            })
            .await
            .unwrap();
        assert_eq!(stopped.inserted_ids, vec![json!({ "$numberInt": "10" })]);
        assert_eq!(stopped.errors.len(), 1);
        assert_eq!(
            (stopped.errors[0].index, stopped.errors[0].code.as_str()),
            (1, "mongo_11000")
        );
        drop_collection(ops, &coll).await;
    }

    #[tokio::test]
    async fn aggregate_out_writes_and_goes_to_history() {
        if !enabled() {
            return;
        }
        let (driver, mut changes) = connect_logged().await;
        let ops = driver.document().unwrap();
        let (source, target) = (scratch(), scratch());
        ops.insert(&InsertRequest {
            db: "tablepeek_test".into(),
            coll: source.clone(),
            docs: vec![json!({ "n": 1 }), json!({ "n": 2 }), json!({ "n": 3 })],
            ordered: None,
        })
        .await
        .unwrap();
        let request = AggregateRequest {
            db: "tablepeek_test".into(),
            coll: source.clone(),
            pipeline: vec![
                json!({ "$match": { "n": { "$gte": 2 } } }),
                json!({ "$out": target }),
            ],
            options: QueryOptions::default(),
            confirmed: true,
        };
        assert!(crate::driver::check_aggregate(&request).unwrap());
        let batch = ops.aggregate(&request).await.unwrap();
        assert!(batch.docs.is_empty());
        let copied = ops
            .count(&CountRequest {
                db: "tablepeek_test".into(),
                coll: target.clone(),
                filter: json!({ "n": { "$exists": true } }),
                options: QueryOptions::default(),
            })
            .await
            .unwrap();
        assert_eq!(copied.count, Some(2));
        let written = history(&mut changes);
        assert!(
            written.iter().any(|sql| sql.contains("$out")),
            "{written:?}"
        );
        drop_collection(ops, &source).await;
        drop_collection(ops, &target).await;
    }

    #[tokio::test]
    async fn export_streams_every_document() {
        if !enabled() {
            return;
        }
        let driver = connect(true).await;
        let ops = driver.document().unwrap();
        let request = |pipeline: Option<Vec<Value>>, limit: Option<i64>| ExportRequest {
            db: "shop".into(),
            coll: "orders".into(),
            filter: json!({}),
            projection: Some(json!({ "status": 1 })),
            sort: Some(json!({ "_id": 1 })),
            limit,
            pipeline,
            options: QueryOptions::default(),
        };
        // No limit: every document, past the first batch of 101.
        let all: Vec<_> = ops
            .export(&request(None, None))
            .await
            .unwrap()
            .collect()
            .await;
        assert_eq!(all.len(), 2000);
        assert!(all.iter().all(Result::is_ok));
        let first: Vec<Value> = ops
            .export(&request(None, Some(5)))
            .await
            .unwrap()
            .map(Result::unwrap)
            .collect()
            .await;
        assert_eq!(first.len(), 5);
        assert_eq!(first[0].as_object().unwrap().len(), 2, "{}", first[0]);
        let grouped: Vec<_> = ops
            .export(&request(
                Some(vec![json!({ "$group": { "_id": "$status" } })]),
                Some(2),
            ))
            .await
            .unwrap()
            .collect()
            .await;
        assert_eq!(grouped.len(), 2);
        let refused = ops
            .export(&request(Some(vec![json!({ "$out": "copy" })]), None))
            .await;
        assert!(matches!(refused, Err(EngineError::BadRequest(_))));
    }

    #[tokio::test]
    async fn perf_reads_server_status() {
        if !enabled() {
            return;
        }
        let driver = connect(true).await;
        let perf = driver.document().unwrap().perf().await.unwrap();
        for key in [
            "time",
            "uptime",
            "opcounters",
            "connections",
            "network",
            "mem",
        ] {
            assert!(
                perf.get(key).is_some_and(|value| !value.is_null()),
                "{key}: {perf}"
            );
        }
        assert!(perf["opcounters"].get("query").is_some(), "{perf}");
        assert!(perf["network"].get("bytesIn").is_some(), "{perf}");
        assert!(perf["wiredTiger"].get("cacheBytes").is_some(), "{perf}");
        assert!(perf["globalLock"].get("activeReaders").is_some(), "{perf}");
        // The test server is a replica set.
        assert!(perf.get("opcountersRepl").is_some(), "{perf}");
    }

    #[tokio::test]
    async fn admin_commands_run_and_writes_go_to_history() {
        if !enabled() {
            return;
        }
        let (driver, mut changes) = connect_logged().await;
        let ops = driver.document().unwrap();
        let db = format!("tp_db_{}", uuid::Uuid::new_v4().simple());
        run(
            ops,
            &db,
            json!({ "create": "people", "validator": { "$jsonSchema": { "required": ["name"] } } }),
        )
        .await;
        run(
            ops,
            &db,
            json!({ "create": "logs", "capped": true, "size": 65536, "max": 10 }),
        )
        .await;
        run(
            ops,
            &db,
            json!({ "create": "names", "viewOn": "people", "pipeline": [{ "$project": { "name": 1 } }] }),
        )
        .await;
        run(
            ops,
            &db,
            json!({ "collMod": "people", "validationLevel": "moderate", "validationAction": "warn" }),
        )
        .await;
        run(
            ops,
            &db,
            json!({ "collMod": "names", "viewOn": "people", "pipeline": [{ "$project": { "_id": 0, "name": 1 } }] }),
        )
        .await;
        run(
            ops,
            "admin",
            json!({ "renameCollection": format!("{db}.logs"), "to": format!("{db}.events"), "dropTarget": false }),
        )
        .await;
        let collections = ops.collections(&db).await.unwrap();
        let people = collections.iter().find(|c| c.name == "people").unwrap();
        assert_eq!(people.options["validationLevel"], json!("moderate"));
        assert!(collections.iter().any(|c| c.name == "events"));
        assert_eq!(
            collections.iter().find(|c| c.name == "names").unwrap().kind,
            "view"
        );
        let level = run(ops, &db, json!({ "profile": -1 })).await;
        assert!(level.get("was").is_some(), "{level}");
        let current = run(
            ops,
            "admin",
            json!({ "currentOp": 1, "active": true, "$all": true }),
        )
        .await;
        assert!(current["inprog"].is_array(), "{current}");
        let top = run(ops, "admin", json!({ "top": 1 })).await;
        assert!(top.get("totals").is_some(), "{top}");
        for read in [
            json!({ "hostInfo": 1 }),
            json!({ "replSetGetStatus": 1 }),
            json!({ "listDatabases": 1 }),
        ] {
            run(ops, "admin", read).await;
        }
        run(ops, &db, json!({ "dropDatabase": 1 })).await;
        let databases = ops.databases().await.unwrap();
        assert!(databases.iter().all(|known| known.name != db));
        let written = history(&mut changes);
        for name in ["create", "collMod", "renameCollection", "dropDatabase"] {
            assert!(
                written.iter().any(|sql| sql.contains(&format!("{name}:"))),
                "{name}: {written:?}"
            );
        }
        assert!(
            !written
                .iter()
                .any(|sql| sql.contains("currentOp") || sql.contains("profile")),
            "{written:?}"
        );
    }

    async fn connect_error(config: Value) -> EngineError {
        let Value::Object(config) = config else {
            unreachable!()
        };
        match FACTORY
            .connect(&config, &NetRoute::Direct, SqlLog::new())
            .await
        {
            Ok(_) => panic!("connected with {config:?}"),
            Err(err) => err,
        }
    }

    #[tokio::test]
    async fn connection_failures_say_why() {
        if !enabled() {
            return;
        }
        // A wrong password: the server's refusal, its code, no driver dump.
        let err = connect_error(json!({
            "host": "127.0.0.1", "port": 27018, "direct_connection": true,
            "user": "tablepeek", "password": "wrong_pw", "auth_source": "admin"
        }))
        .await;
        let EngineError::Driver {
            message, fields, ..
        } = &err
        else {
            panic!("{err:?}")
        };
        assert_eq!(
            message, "MongoDB 인증 실패: Authentication failed.",
            "{err:?}"
        );
        assert_eq!(fields.server_code, Some(18));
        assert_eq!(fields.code_name.as_deref(), Some("AuthenticationFailed"));
        assert!(
            fields.raw.as_deref().unwrap().contains("SCRAM"),
            "{fields:?}"
        );
        // The replica set without directConnection: its member, as the set
        // names it, is not the server reached here.
        let err = connect_error(json!({ "host": "127.0.0.1", "port": 27018 })).await;
        let EngineError::Driver {
            message, fields, ..
        } = &err
        else {
            panic!("{err:?}")
        };
        assert!(
            message.starts_with("복제 세트 'rs0'에서 닿을 수 있는 프라이머리가 없습니다"),
            "{message}"
        );
        assert!(message.contains("directConnection"), "{message}");
        let details = fields.details.as_ref().unwrap();
        assert_eq!(
            details["topology"],
            json!("ReplicaSetNoPrimary"),
            "{details}"
        );
        assert!(!message.contains("Topology"), "{message}");
        // Nothing listening.
        let err =
            connect_error(json!({ "host": "127.0.0.1", "port": 1, "direct_connection": true }))
                .await;
        let EngineError::Driver { message, .. } = &err else {
            panic!("{err:?}")
        };
        assert_eq!(
            message,
            "서버에 연결할 수 없습니다 (연결 거부): 127.0.0.1:1"
        );
    }

    #[tokio::test]
    async fn write_errors_carry_code_name_and_err_info() {
        if !enabled() {
            return;
        }
        let driver = connect(true).await;
        let ops = driver.document().unwrap();
        let coll = scratch();
        run(
            ops,
            "tablepeek_test",
            json!({
                "create": coll,
                "validator": { "$jsonSchema": { "required": ["name"] } }
            }),
        )
        .await;
        let insert = |docs: Vec<Value>, ordered: Option<bool>| InsertRequest {
            db: "tablepeek_test".into(),
            coll: coll.clone(),
            docs,
            ordered,
        };
        // Validation (121): which rule failed comes along as errInfo.
        let err = ops
            .insert(&insert(vec![json!({ "_id": 1 })], None))
            .await
            .unwrap_err();
        let EngineError::Driver {
            code,
            message,
            fields,
            ..
        } = &err
        else {
            panic!("{err:?}")
        };
        assert_eq!(code.as_deref(), Some("121"));
        assert_eq!(message, "Document failed validation");
        assert_eq!(fields.server_code, Some(121));
        let details = fields.details.as_ref().unwrap();
        assert_eq!(
            details["errInfo"]["details"]["schemaRulesNotSatisfied"][0]["operatorName"],
            json!("required"),
            "{details}"
        );
        assert_eq!(details["writeErrors"][0]["index"], json!(0), "{details}");
        assert_eq!(details["writeErrors"][0]["code"], json!(121), "{details}");
        // The same per document when failures are reported one by one.
        let outcome = ops
            .insert(&insert(
                vec![json!({ "_id": 2, "name": "a" }), json!({ "_id": 3 })],
                Some(false),
            ))
            .await
            .unwrap();
        assert_eq!(outcome.errors.len(), 1, "{outcome:?}");
        let failure = &outcome.errors[0];
        assert_eq!((failure.index, failure.server_code), (1, 121));
        assert!(
            failure.details.as_ref().unwrap()["errInfo"]["failingDocumentId"].is_object(),
            "{failure:?}"
        );
        // A duplicate key (11000): code and words, nothing to explain it with.
        let err = ops
            .insert(&insert(vec![json!({ "_id": 2, "name": "b" })], None))
            .await
            .unwrap_err();
        let EngineError::Driver {
            message, fields, ..
        } = &err
        else {
            panic!("{err:?}")
        };
        assert!(
            message.starts_with("E11000 duplicate key error"),
            "{message}"
        );
        assert_eq!(fields.server_code, Some(11000));
        drop_collection(ops, &coll).await;
    }
}
