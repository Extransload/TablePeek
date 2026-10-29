//! Connecting to the special servers of `make test-db ENGINE=…`: X.509 over
//! required TLS (`mongodb-x509`), LDAP on Enterprise (`mongodb-ldap`),
//! Kerberos against a KDC of its own (`mongodb-kerberos`), OIDC against a
//! local identity provider (`mongodb-oidc`), AWS IAM against an STS
//! stand-in (`mongodb-aws`), a sharded cluster (`mongodb-sharded`), and a
//! replica set reachable only by names its own network resolves
//! (`mongodb-rs`), here through a tunnel that leads each member name to the
//! member's host port. Each test runs only with its
//! `TABLEPEEK_TEST_MONGODB_*` variable set.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};
use tablepeek_types::ConnConfig;

use super::*;
use crate::driver::{CommandRequest, DocumentDriver, FindRequest, InsertRequest, QueryOptions};
use crate::registry::{Forwarder, TunnelStream};

fn enabled(name: &str) -> bool {
    std::env::var(format!("TABLEPEEK_TEST_MONGODB_{name}")).is_ok()
}

fn config(value: Value) -> ConnConfig {
    let Value::Object(map) = value else {
        unreachable!()
    };
    map
}

fn testdb(path: &str) -> String {
    format!("{}/../../testdb/{path}", env!("CARGO_MANIFEST_DIR"))
}

async fn connect(value: Value, net: &NetRoute) -> Result<Arc<dyn Driver>, EngineError> {
    FACTORY.connect(&config(value), net, SqlLog::new()).await
}

fn find(db: &str, coll: &str, filter: Value) -> FindRequest {
    FindRequest {
        db: db.into(),
        coll: coll.into(),
        filter,
        projection: None,
        sort: None,
        skip: None,
        limit: 20,
        options: QueryOptions::default(),
        poll: false,
    }
}

/// Writes and reads back one document in a scratch collection.
async fn round_trip(ops: &dyn DocumentDriver) {
    let coll = format!("tp_{}", uuid::Uuid::new_v4().simple());
    ops.insert(&InsertRequest {
        db: "tablepeek_test".into(),
        coll: coll.clone(),
        docs: vec![json!({ "n": 1 })],
        ordered: None,
    })
    .await
    .expect("insert failed");
    let found = ops
        .find(&find("tablepeek_test", &coll, json!({})))
        .await
        .expect("find failed");
    assert_eq!(found.docs.len(), 1);
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
async fn x509_logs_in_with_the_client_certificate() {
    if !enabled("X509") {
        return;
    }
    let base = json!({
        "host": "localhost", "port": 27020, "auth": "x509", "tls": true,
        "tls_ca_file": testdb("x509/ca.pem"),
        "tls_cert_key_file": testdb("x509/client.pem"),
    });
    let driver = connect(base.clone(), &NetRoute::Direct)
        .await
        .expect("X.509 connect failed");
    round_trip(driver.document().unwrap()).await;

    // Without the certificate it is refused before anything is sent.
    let mut bare = base.clone();
    bare.as_object_mut().unwrap().remove("tls_cert_key_file");
    let err = connect(bare, &NetRoute::Direct).await.err().unwrap();
    assert_eq!(
        err.to_string(),
        "X.509 인증에는 클라이언트 인증서·키 파일이 필요합니다"
    );
    // TLS is required: a plain connection gets nowhere.
    let plain = connect(
        json!({ "host": "localhost", "port": 27020, "auth": "none" }),
        &NetRoute::Direct,
    )
    .await;
    assert!(plain.is_err());
}

#[tokio::test]
async fn ldap_checks_the_password_against_the_directory() {
    if !enabled("LDAP") {
        return;
    }
    let base = json!({
        "host": "127.0.0.1", "port": 27021, "auth": "ldap", "user": "ann",
        "password": "ann_ldap_pw", "auth_source": "admin"
    });
    let driver = connect(base.clone(), &NetRoute::Direct)
        .await
        .expect("LDAP connect failed");
    round_trip(driver.document().unwrap()).await;

    let mut wrong = base;
    wrong["password"] = json!("wrong");
    let err = connect(wrong, &NetRoute::Direct).await.err().unwrap();
    assert!(err.to_string().contains("인증 실패"), "{err}");
}

/// Who the server says this connection logged in as.
async fn logged_in_as(ops: &dyn DocumentDriver) -> String {
    let status = ops
        .command(&CommandRequest {
            db: "admin".into(),
            command: json!({ "connectionStatus": 1 }),
            confirmed: false,
            poll: false,
        })
        .await
        .expect("connectionStatus failed");
    status.to_string()
}

#[tokio::test]
async fn aws_logs_in_with_keys_tokens_and_the_environment() {
    if !enabled("AWS") {
        return;
    }
    // The test STS (testdb/aws/sts.py) knows this key; with the session
    // token the caller is an assumed role.
    let base = json!({
        "host": "127.0.0.1", "port": 27024, "auth": "aws",
        "user": "AKIATABLEPEEKTEST", "password": "tablepeek_aws_secret",
    });
    let driver = connect(base.clone(), &NetRoute::Direct)
        .await
        .expect("AWS key connect failed");
    let ops = driver.document().unwrap();
    round_trip(ops).await;
    assert!(
        logged_in_as(ops)
            .await
            .contains("arn:aws:iam::123456789012:user/tablepeek"),
        "not the IAM user"
    );

    let mut session = base.clone();
    session["aws_session_token"] = json!("tablepeek_session_token");
    let driver = connect(session, &NetRoute::Direct)
        .await
        .expect("AWS session token connect failed");
    assert!(
        logged_in_as(driver.document().unwrap())
            .await
            .contains("arn:aws:sts::123456789012:assumed-role/tablepeek-role/*"),
        "not the assumed role"
    );

    // A wrong secret breaks the signature STS checks.
    let mut wrong = base;
    wrong["password"] = json!("wrong");
    let err = connect(wrong, &NetRoute::Direct).await.err().unwrap();
    assert!(err.to_string().contains("인증 실패"), "{err}");

    // No key in the form: the driver reads the environment's.
    std::env::set_var("AWS_ACCESS_KEY_ID", "AKIATABLEPEEKTEST");
    std::env::set_var("AWS_SECRET_ACCESS_KEY", "tablepeek_aws_secret");
    let from_env = connect(
        json!({ "host": "127.0.0.1", "port": 27024, "auth": "aws" }),
        &NetRoute::Direct,
    )
    .await;
    std::env::remove_var("AWS_ACCESS_KEY_ID");
    std::env::remove_var("AWS_SECRET_ACCESS_KEY");
    let driver = from_env.expect("AWS environment connect failed");
    assert!(
        logged_in_as(driver.document().unwrap())
            .await
            .contains("arn:aws:iam::123456789012:user/tablepeek"),
        "not the IAM user"
    );
}

/// A ticket for ann@TABLEPEEK.TEST from the test KDC, in a cache of the
/// test's own: KRB5_CONFIG and KRB5CCNAME point this process (and so the
/// GSSAPI library the driver calls) at testdb/kerberos, never at the
/// system's Kerberos settings or tickets. macOS has Heimdal's kinit, which
/// reads the password only with --password-file; MIT's reads standard
/// input.
#[cfg(any(target_os = "macos", feature = "kerberos"))]
fn kinit() {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let cache = std::env::temp_dir().join("tablepeek-test-krb5cc");
    std::env::set_var("KRB5_CONFIG", testdb("kerberos/krb5.conf"));
    std::env::set_var("KRB5CCNAME", format!("FILE:{}", cache.display()));
    let heimdal = Command::new("kinit")
        .arg("--version")
        .output()
        .map(|out| {
            String::from_utf8_lossy(&out.stdout).contains("Heimdal")
                || String::from_utf8_lossy(&out.stderr).contains("Heimdal")
        })
        .unwrap_or(false);
    let mut command = Command::new("kinit");
    if heimdal {
        command.arg("--password-file=STDIN");
    }
    let mut child = command
        .arg("ann@TABLEPEEK.TEST")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .expect("kinit is missing");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"ann_krb_pw\n")
        .unwrap();
    assert!(child.wait().unwrap().success(), "kinit failed");
}

/// Only in builds with GSSAPI (macOS, or `--features kerberos`).
#[cfg(any(target_os = "macos", feature = "kerberos"))]
#[tokio::test]
async fn kerberos_logs_in_with_the_ticket() {
    if !enabled("KERBEROS") {
        return;
    }
    kinit();
    // The server's principal is mongodb/kerberos.tablepeek.test, a name this
    // machine does not resolve: dial the address, name the host.
    let base = json!({
        "host": "127.0.0.1", "port": 27022, "auth": "kerberos",
        "user": "ann@TABLEPEEK.TEST",
        "kerberos_service_host": "kerberos.tablepeek.test",
    });
    let driver = connect(base.clone(), &NetRoute::Direct)
        .await
        .expect("Kerberos connect failed");
    let ops = driver.document().unwrap();
    round_trip(ops).await;
    assert!(
        logged_in_as(ops).await.contains("ann@TABLEPEEK.TEST"),
        "not logged in as ann"
    );

    // Without it the ticket asked for is mongodb/127.0.0.1, which the KDC
    // does not know.
    let mut by_address = base;
    by_address
        .as_object_mut()
        .unwrap()
        .remove("kerberos_service_host");
    assert!(connect(by_address, &NetRoute::Direct).await.is_err());
}

const OIDC_ISSUER: &str = "https://127.0.0.1:8180/tablepeek";

/// The provider's certificate comes from the test CA, which this process
/// (TablePeek's requests to the provider) trusts through SSL_CERT_FILE.
fn trust_test_ca() -> reqwest::Client {
    std::env::set_var("SSL_CERT_FILE", testdb("x509/ca.pem"));
    let ca = std::fs::read(testdb("x509/ca.pem")).expect("run testdb/x509/gen.sh first");
    reqwest::Client::builder()
        .add_root_certificate(reqwest::Certificate::from_pem(&ca).unwrap())
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}

/// The browser login TablePeek waits on for the test provider.
async fn waiting_login() -> oidc::PendingLogin {
    for _ in 0..100 {
        if let Some(login) = oidc::pending()
            .into_iter()
            .find(|login| login.issuer == OIDC_ISSUER)
        {
            return login;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    panic!("no browser login was offered");
}

/// Plays the browser: signs in as `user` on the provider's page and hands
/// TablePeek what the provider sends back to the callback.
async fn sign_in(browser: &reqwest::Client, login: &oidc::PendingLogin, user: &str) {
    let reply = browser
        .post(&login.url)
        .form(&[("username", user)])
        .send()
        .await
        .expect("the login page failed");
    let back =
        reqwest::Url::parse(reply.headers()[reqwest::header::LOCATION].to_str().unwrap()).unwrap();
    assert_eq!(back.path(), "/api/oidc/callback");
    let param = |name: &str| {
        back.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
            .unwrap()
    };
    assert!(oidc::finish(&param("state"), Ok(param("code"))));
}

#[tokio::test]
async fn oidc_logs_in_through_the_browser_and_as_a_machine() {
    if !enabled("OIDC") {
        return;
    }
    let browser = trust_test_ca();
    // Never followed: the test hands the callback's code over itself.
    oidc::set_redirect_base("http://127.0.0.1:9");
    let human = json!({
        "host": "127.0.0.1", "port": 27023, "auth": "oidc", "oidc_flow": "human",
        "user": "ann",
    });

    // The human flow: the login page, then the code for a token.
    let connecting = tokio::spawn({
        let human = human.clone();
        async move { connect(human, &NetRoute::Direct).await }
    });
    let login = waiting_login().await;
    assert!(login.url.starts_with(&format!("{OIDC_ISSUER}/authorize?")));
    assert!(login.url.contains("code_challenge_method=S256"));
    sign_in(&browser, &login, "ann").await;
    let driver = connecting
        .await
        .unwrap()
        .expect("OIDC browser login failed");
    let ops = driver.document().unwrap();
    round_trip(ops).await;
    assert!(logged_in_as(ops).await.contains("tp/ann"), "not tp/ann");

    // Giving the login up fails the connect.
    let connecting = tokio::spawn({
        let human = human.clone();
        async move { connect(human, &NetRoute::Direct).await }
    });
    let login = waiting_login().await;
    assert!(oidc::cancel(&login.id));
    let err = connecting.await.unwrap().err().unwrap();
    assert!(
        err.to_string().contains("브라우저 로그인을 취소했습니다"),
        "{err}"
    );

    // The machine flow: a workload token in the file Kubernetes (here the
    // provider's client credentials) leaves for the driver.
    let token: Value = browser
        .post(format!("{OIDC_ISSUER}/token"))
        .form(&[
            ("grant_type", "client_credentials"),
            ("client_id", "tablepeek"),
            ("client_secret", "unused"),
            ("scope", "tablepeek"),
        ])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let file = std::env::temp_dir().join("tablepeek-test-oidc-token");
    std::fs::write(&file, token["access_token"].as_str().unwrap()).unwrap();
    std::env::set_var("AZURE_FEDERATED_TOKEN_FILE", &file);
    let driver = connect(
        json!({ "host": "127.0.0.1", "port": 27023, "auth": "oidc", "oidc_flow": "k8s" }),
        &NetRoute::Direct,
    )
    .await
    .expect("OIDC machine login failed");
    let ops = driver.document().unwrap();
    round_trip(ops).await;
    assert!(
        logged_in_as(ops).await.contains("tp/tablepeek-machine"),
        "not tp/tablepeek-machine"
    );
}

#[tokio::test]
async fn sharded_clusters_open_and_report_performance() {
    if !enabled("SHARDED") {
        return;
    }
    let driver = connect(
        json!({ "host": "127.0.0.1", "port": 27040, "database": "tablepeek_test" }),
        &NetRoute::Direct,
    )
    .await
    .expect("mongos connect failed");
    assert_eq!(driver.capabilities().transactions, "replica_set");
    driver.meta(false).await.expect("meta failed");
    let ops = driver.document().unwrap();
    round_trip(ops).await;
    let perf = ops.perf().await.expect("perf failed");
    assert!(perf.get("opcounters").is_some(), "{perf}");
}

/// Leads rsN.tablepeek.test:27017 to the member's host port 2703N, as an
/// SSH server inside the set's network would.
struct Members;

#[async_trait]
impl Forwarder for Members {
    async fn connect(&self, host: &str, port: u16) -> Result<Box<dyn TunnelStream>, String> {
        let member = host
            .strip_prefix("rs")
            .and_then(|rest| rest.strip_suffix(".tablepeek.test"))
            .and_then(|n| n.parse::<u16>().ok())
            .filter(|_| port == 27017)
            .ok_or_else(|| format!("unknown member {host}:{port}"))?;
        let stream = tokio::net::TcpStream::connect(("127.0.0.1", 27030 + member))
            .await
            .map_err(|err| err.to_string())?;
        Ok(Box::new(stream))
    }
}

/// The member that served the latest read: its startup log's hostname.
async fn served_by(ops: &dyn DocumentDriver) -> String {
    let mut req = find("local", "startup_log", json!({}));
    req.sort = Some(json!({ "startTime": -1 }));
    req.limit = 1;
    let found = ops.find(&req).await.expect("startup_log read failed");
    found.docs[0]["hostname"].as_str().unwrap_or("").to_string()
}

#[tokio::test]
async fn replica_sets_behind_a_tunnel_follow_their_members() {
    if !enabled("RS") {
        return;
    }
    let tunnel = NetRoute::Tunnel(Arc::new(Members));
    let seeds = "mongodb://rs1.tablepeek.test,rs2.tablepeek.test/?replicaSet=rs1";
    let driver = connect(
        json!({ "uri": seeds, "database": "tablepeek_test" }),
        &tunnel,
    )
    .await
    .expect("seed list connect failed");
    assert_eq!(driver.capabilities().transactions, "replica_set");
    round_trip(driver.document().unwrap()).await;

    // The SRV name, resolved by the tests' DNS server.
    let settings = settings(
        &DESCRIPTOR,
        &config(json!({ "uri": "mongodb+srv://rs.tablepeek.test/tablepeek_test?tls=false" })),
    )
    .unwrap();
    let nameserver = "127.0.0.1:1053".parse().unwrap();
    let srv = MongoDriver::open(
        settings,
        &tunnel,
        "srv".into(),
        SqlLog::new(),
        Some(nameserver),
    )
    .await
    .expect("SRV connect failed");
    round_trip(srv.document().unwrap()).await;

    // A secondary read preference reads from a secondary.
    let secondary = connect(
        json!({ "uri": seeds, "read_preference": "secondary" }),
        &tunnel,
    )
    .await
    .expect("secondary connect failed");
    let primary = served_by(driver.document().unwrap()).await;
    let read = served_by(secondary.document().unwrap()).await;
    assert!(
        read.starts_with("rs") && read != primary,
        "{read} vs {primary}"
    );
}

#[test]
fn seed_lists_carry_the_txt_options() {
    if !enabled("RS") {
        return;
    }
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let uri = runtime
        .block_on(route::seed_list(
            "mongodb+srv://u@rs.tablepeek.test/db?srvMaxHosts=2",
            Some("127.0.0.1:1053".parse().unwrap()),
        ))
        .unwrap();
    assert!(uri.starts_with("mongodb://u@rs"), "{uri}");
    assert_eq!(
        uri.split('/').nth(2).unwrap().split(',').count(),
        2,
        "{uri}"
    );
    assert!(
        uri.ends_with("/db?replicaSet=rs1&authSource=admin&tls=true"),
        "{uri}"
    );
}
