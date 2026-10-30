//! The security screens' requests: users, roles, role mappings and API keys
//! of Elasticsearch security (`/_security/…`) or the OpenSearch security
//! plugin (`/_plugins/_security/api/…`). Every list comes back as one object
//! per entry with the fields the screens show and `body`, the definition as
//! the server would take it back; every write is a `Trace::Change` request
//! (console and History, passwords masked).

use reqwest::Method;
use serde_json::{json, Map, Value};

use super::http::{Body, Trace};
use super::ops::id_segment;
use super::{SearchEngineDriver, Version};
use crate::search::{
    check_confirmed, ApiKeyRequest, SecurityDeleteRequest, SecurityKind, SecurityPutRequest,
    UserEnabledRequest, UserPasswordRequest,
};
use crate::EngineError;

/// OpenSearch's security REST API.
const OS_API: &str = "/_plugins/_security/api";

/// The OpenSearch release API keys (`apitokens`) came with.
const OS_API_KEYS: Version = Version(3, 7);

/// Why an OpenSearch user can't be switched off.
const OS_NO_DISABLE: &str =
    "OpenSearch 보안 플러그인의 사용자는 끌 수 없습니다 (지우거나 역할을 빼세요)";

fn bad(message: impl Into<String>) -> EngineError {
    EngineError::BadRequest(message.into())
}

/// A user, role or role mapping name as a path segment; never empty.
fn name_segment(name: &str) -> Result<String, EngineError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(bad("이름이 필요합니다"));
    }
    Ok(id_segment(name))
}

/// What a write of `kind` is called in the confirmation rule's message.
fn what(kind: SecurityKind) -> &'static str {
    match kind {
        SecurityKind::Users => "사용자를 바꾸려면",
        SecurityKind::Roles => "역할을 바꾸려면",
        SecurityKind::RoleMappings => "역할 매핑을 바꾸려면",
        SecurityKind::ApiKeys => "API 키를 바꾸려면",
    }
}

/// `object` without `keys`.
fn without(object: &Value, keys: &[&str]) -> Value {
    match object.as_object() {
        Some(map) => Value::Object(
            map.iter()
                .filter(|(key, _)| !keys.contains(&key.as_str()))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<Map<_, _>>(),
        ),
        None => object.clone(),
    }
}

fn flag(value: Option<&Value>) -> bool {
    value.and_then(Value::as_bool).unwrap_or(false)
}

/// The entries of a `{ name: definition }` reply, sorted by name.
fn named(reply: &Value) -> Vec<(&String, &Value)> {
    let mut entries: Vec<(&String, &Value)> = reply
        .as_object()
        .map(|map| map.iter().collect())
        .unwrap_or_default();
    entries.sort_by(|a, b| a.0.cmp(b.0));
    entries
}

/// One list entry of Elasticsearch: reserved (built in) when its metadata
/// says so.
fn es_entry(name: &str, definition: &Value, body: Value, extra: Value) -> Value {
    let mut entry = json!({
        "name": name,
        "reserved": flag(definition.pointer("/metadata/_reserved")),
        "body": body,
    });
    if let (Some(entry), Some(extra)) = (entry.as_object_mut(), extra.as_object()) {
        entry.extend(
            extra
                .iter()
                .map(|(key, value)| (key.clone(), value.clone())),
        );
    }
    entry
}

/// One list entry of OpenSearch: reserved, hidden or static as it says.
fn os_entry(name: &str, definition: &Value, extra: Value) -> Value {
    let mut entry = json!({
        "name": name,
        "reserved": flag(definition.get("reserved")) || flag(definition.get("static")),
        "hidden": flag(definition.get("hidden")),
        "body": without(definition, &["reserved", "hidden", "static", "hash"]),
    });
    if let (Some(entry), Some(extra)) = (entry.as_object_mut(), extra.as_object()) {
        entry.extend(
            extra
                .iter()
                .map(|(key, value)| (key.clone(), value.clone())),
        );
    }
    entry
}

/// An API key of either server, one shape: `{ id, name, created_ms,
/// expires_ms, invalidated, user, realm, body }`.
fn api_key_entry(key: &Value) -> Value {
    let text = |names: &[&str]| {
        names
            .iter()
            .find_map(|name| key.get(*name).filter(|value| !value.is_null()))
            .cloned()
            .unwrap_or(Value::Null)
    };
    let millis = |names: &[&str]| match text(names) {
        Value::Number(number) => Value::Number(number),
        Value::String(date) => chrono::DateTime::parse_from_rfc3339(&date)
            .map(|at| json!(at.timestamp_millis()))
            .unwrap_or(Value::Null),
        _ => Value::Null,
    };
    let revoked = !matches!(text(&["revoked_at"]), Value::Null);
    json!({
        "id": text(&["id"]),
        "name": text(&["name"]),
        // OpenSearch's apitokens give the issue time as `iat`.
        "created_ms": millis(&["creation", "created_at", "creation_time", "iat"]),
        "expires_ms": millis(&["expiration", "expires_at", "expiration_time"]),
        "invalidated": flag(key.get("invalidated")) || revoked,
        "user": text(&["username", "created_by", "owner"]),
        "realm": text(&["realm"]),
        "body": key,
    })
}

impl SearchEngineDriver {
    async fn security_get(&self, path: &str) -> Result<Value, EngineError> {
        self.http
            .json(Method::GET, path, Body::None, Trace::Console, false)
            .await
    }

    async fn security_write(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, EngineError> {
        let body = body.map_or(Body::None, Body::Json);
        self.http
            .json(method, path, body, Trace::Change, false)
            .await
    }

    /// Whether this OpenSearch has API keys (3.7 and later).
    fn os_api_keys(&self) -> bool {
        self.version >= OS_API_KEYS
    }

    pub(super) async fn security_overview(&self) -> Result<Value, EngineError> {
        let mut kinds = json!({
            "users": { "available": true },
            "roles": { "available": true },
            "role_mappings": { "available": true },
            "api_keys": { "available": true },
        });
        if self.opensearch() {
            let reply = self
                .http
                .send(
                    Method::GET,
                    &format!("{OS_API}/account"),
                    Body::None,
                    Trace::Quiet,
                    false,
                )
                .await?;
            if !reply.ok() {
                // No security plugin: there is nothing to manage.
                let error = self.http.error(&reply);
                return Ok(json!({
                    "flavor": self.flavor,
                    "enabled": false,
                    "reason": format!("이 서버에는 보안 플러그인이 없거나 꺼져 있습니다 ({error})"),
                    "kinds": {},
                }));
            }
            let account = reply.value();
            let roles = account.get("roles").cloned().unwrap_or(Value::Null);
            let manage = roles.as_array().is_some_and(|roles| {
                roles
                    .iter()
                    .any(|role| role == "all_access" || role == "security_manager")
            });
            if !self.os_api_keys() {
                kinds["api_keys"] = json!({
                    "available": false,
                    "reason": format!("OpenSearch {}에는 API 키가 없습니다 (3.7부터)", self.version_text),
                });
            }
            return Ok(json!({
                "flavor": self.flavor,
                "enabled": true,
                "user": {
                    "name": account.get("user_name"),
                    "roles": roles,
                    "backend_roles": account.get("backend_roles"),
                },
                "manage": manage,
                "user_enabled": { "available": false, "reason": OS_NO_DISABLE },
                "kinds": kinds,
            }));
        }
        let reply = self
            .http
            .send(
                Method::GET,
                "/_security/_authenticate",
                Body::None,
                Trace::Quiet,
                false,
            )
            .await?;
        if !reply.ok() {
            let error = self.http.error(&reply);
            return Ok(json!({
                "flavor": self.flavor,
                "enabled": false,
                "reason": error.to_string(),
                "kinds": {},
            }));
        }
        let user = reply.value();
        // Older servers refuse privilege names they don't know yet
        // (`manage_own_api_key` came with 7.5): ask for fewer.
        let mut rights = None;
        for asked in [
            &["manage_security", "manage_api_key", "manage_own_api_key"][..],
            &["manage_security", "manage_api_key"][..],
            &["manage_security"][..],
        ] {
            rights = self
                .http
                .json(
                    Method::POST,
                    "/_security/user/_has_privileges",
                    Body::Json(&json!({ "cluster": asked })),
                    Trace::Quiet,
                    false,
                )
                .await
                .ok();
            if rights.is_some() {
                break;
            }
        }
        let right = |name: &str| {
            rights
                .as_ref()
                .and_then(|rights| rights.pointer(&format!("/cluster/{name}")))
                .and_then(Value::as_bool)
        };
        Ok(json!({
            "flavor": self.flavor,
            "enabled": true,
            "user": {
                "name": user.get("username"),
                "roles": user.get("roles"),
                "realm": user.pointer("/authentication_realm/name"),
            },
            "manage": right("manage_security"),
            "manage_api_keys": right("manage_api_key").or(right("manage_own_api_key")),
            "user_enabled": { "available": true, "reason": null },
            "kinds": kinds,
        }))
    }

    pub(super) async fn security_entries(&self, kind: SecurityKind) -> Result<Value, EngineError> {
        if self.opensearch() {
            return self.os_entries(kind).await;
        }
        let entries: Vec<Value> = match kind {
            SecurityKind::Users => {
                let reply = self.security_get("/_security/user").await?;
                named(&reply)
                    .into_iter()
                    .map(|(name, user)| {
                        es_entry(
                            name,
                            user,
                            without(user, &["username"]),
                            json!({
                                "enabled": user.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                                "roles": user.get("roles"),
                                "full_name": user.get("full_name"),
                                "email": user.get("email"),
                            }),
                        )
                    })
                    .collect()
            }
            SecurityKind::Roles => {
                let reply = self.security_get("/_security/role").await?;
                named(&reply)
                    .into_iter()
                    .map(|(name, role)| {
                        let indices: Vec<Value> = role
                            .get("indices")
                            .and_then(Value::as_array)
                            .map(|groups| {
                                groups
                                    .iter()
                                    .filter_map(|group| group.get("names"))
                                    .flat_map(|names| match names {
                                        Value::Array(names) => names.clone(),
                                        other => vec![other.clone()],
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        es_entry(
                            name,
                            role,
                            without(role, &["transient_metadata"]),
                            json!({ "cluster": role.get("cluster"), "indices": indices }),
                        )
                    })
                    .collect()
            }
            SecurityKind::RoleMappings => {
                let reply = self.security_get("/_security/role_mapping").await?;
                named(&reply)
                    .into_iter()
                    .map(|(name, mapping)| {
                        es_entry(
                            name,
                            mapping,
                            mapping.clone(),
                            json!({
                                "enabled": mapping.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                                "roles": mapping.get("roles"),
                                "rules": mapping.get("rules"),
                            }),
                        )
                    })
                    .collect()
            }
            SecurityKind::ApiKeys => {
                let raw_keys = match self.security_get("/_security/api_key").await {
                    Ok(reply) => reply.get("api_keys").cloned().unwrap_or(Value::Null),
                    // Before 7.x the list must name a key, user or realm:
                    // the keys of every realm a user logs in through.
                    Err(EngineError::Driver {
                        code: Some(code), ..
                    }) if code == "action_request_validation_exception" => {
                        self.api_keys_by_realm().await?
                    }
                    Err(err) => return Err(err),
                };
                let mut keys: Vec<Value> = raw_keys
                    .as_array()
                    .map(|keys| keys.iter().map(api_key_entry).collect())
                    .unwrap_or_default();
                keys.sort_by_key(|key| std::cmp::Reverse(key["created_ms"].as_i64().unwrap_or(0)));
                keys
            }
        };
        Ok(Value::Array(entries))
    }

    /// The API keys of Elasticsearch before 7.x, which lists them only by
    /// realm: the built-in realms' and the realm this user logged in
    /// through, merged by id.
    async fn api_keys_by_realm(&self) -> Result<Value, EngineError> {
        let mut realms: Vec<String> = ["reserved", "default_native", "default_file"]
            .map(str::to_string)
            .to_vec();
        let me = self.security_get("/_security/_authenticate").await?;
        for pointer in ["/authentication_realm/name", "/lookup_realm/name"] {
            if let Some(realm) = me.pointer(pointer).and_then(Value::as_str) {
                if !realms.iter().any(|known| known == realm) {
                    realms.push(realm.to_string());
                }
            }
        }
        let mut keys: Vec<Value> = Vec::new();
        for realm in realms {
            let path = format!("/_security/api_key?realm_name={}", id_segment(&realm));
            let reply = self.security_get(&path).await?;
            for key in reply
                .get("api_keys")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default()
            {
                if !keys.iter().any(|known| known.get("id") == key.get("id")) {
                    keys.push(key.clone());
                }
            }
        }
        Ok(Value::Array(keys))
    }

    async fn os_entries(&self, kind: SecurityKind) -> Result<Value, EngineError> {
        let entries: Vec<Value> = match kind {
            SecurityKind::Users => {
                let reply = self
                    .security_get(&format!("{OS_API}/internalusers"))
                    .await?;
                named(&reply)
                    .into_iter()
                    .map(|(name, user)| {
                        os_entry(
                            name,
                            user,
                            json!({
                                "roles": user.get("opendistro_security_roles"),
                                "backend_roles": user.get("backend_roles"),
                                "description": user.get("description"),
                            }),
                        )
                    })
                    .collect()
            }
            SecurityKind::Roles => {
                let reply = self.security_get(&format!("{OS_API}/roles")).await?;
                named(&reply)
                    .into_iter()
                    .map(|(name, role)| {
                        let indices: Vec<Value> = role
                            .get("index_permissions")
                            .and_then(Value::as_array)
                            .map(|groups| {
                                groups
                                    .iter()
                                    .filter_map(|group| group.get("index_patterns"))
                                    .filter_map(Value::as_array)
                                    .flatten()
                                    .cloned()
                                    .collect()
                            })
                            .unwrap_or_default();
                        os_entry(
                            name,
                            role,
                            json!({
                                "cluster": role.get("cluster_permissions"),
                                "indices": indices,
                                "description": role.get("description"),
                            }),
                        )
                    })
                    .collect()
            }
            SecurityKind::RoleMappings => {
                let reply = self.security_get(&format!("{OS_API}/rolesmapping")).await?;
                named(&reply)
                    .into_iter()
                    .map(|(name, mapping)| {
                        os_entry(
                            name,
                            mapping,
                            json!({
                                "users": mapping.get("users"),
                                "backend_roles": mapping.get("backend_roles"),
                                "hosts": mapping.get("hosts"),
                                "description": mapping.get("description"),
                            }),
                        )
                    })
                    .collect()
            }
            SecurityKind::ApiKeys => {
                self.require_os_api_keys()?;
                let reply = self.security_get(&format!("{OS_API}/apitokens")).await?;
                // A list, or keys by id.
                let keys: Vec<Value> = match &reply {
                    Value::Array(keys) => keys.clone(),
                    Value::Object(map) => match map.get("tokens").or_else(|| map.get("api_tokens"))
                    {
                        Some(Value::Array(keys)) => keys.clone(),
                        _ => map
                            .iter()
                            .map(|(id, key)| {
                                let mut key = key.clone();
                                if let Some(object) = key.as_object_mut() {
                                    object.entry("id").or_insert_with(|| json!(id));
                                }
                                key
                            })
                            .collect(),
                    },
                    _ => Vec::new(),
                };
                keys.iter().map(api_key_entry).collect()
            }
        };
        Ok(Value::Array(entries))
    }

    fn require_os_api_keys(&self) -> Result<(), EngineError> {
        if self.os_api_keys() {
            Ok(())
        } else {
            Err(EngineError::Unsupported(format!(
                "OpenSearch {}에는 API 키가 없습니다 (3.7부터)",
                self.version_text
            )))
        }
    }

    /// The path of one user, role or role mapping.
    fn entry_path(&self, kind: SecurityKind, name: &str) -> Result<String, EngineError> {
        let name = name_segment(name)?;
        let base = match (self.opensearch(), kind) {
            (false, SecurityKind::Users) => "/_security/user".to_string(),
            (false, SecurityKind::Roles) => "/_security/role".to_string(),
            (false, SecurityKind::RoleMappings) => "/_security/role_mapping".to_string(),
            (true, SecurityKind::Users) => format!("{OS_API}/internalusers"),
            (true, SecurityKind::Roles) => format!("{OS_API}/roles"),
            (true, SecurityKind::RoleMappings) => format!("{OS_API}/rolesmapping"),
            (_, SecurityKind::ApiKeys) => {
                return Err(bad("API 키는 만들기와 무효화만 할 수 있습니다"))
            }
        };
        Ok(format!("{base}/{name}"))
    }

    pub(super) async fn put_entry(&self, req: &SecurityPutRequest) -> Result<Value, EngineError> {
        check_confirmed(req.confirmed, what(req.kind))?;
        let path = self.entry_path(req.kind, &req.name)?;
        let body: Value = serde_json::from_str(req.body.get())
            .map_err(|err| bad(format!("본문이 JSON이 아닙니다: {err}")))?;
        let Some(object) = body.as_object() else {
            return Err(bad("본문은 JSON 객체여야 합니다"));
        };
        // An OpenSearch user replaced without a password would lose it:
        // without one, its other fields are patched in instead.
        if self.opensearch()
            && req.kind == SecurityKind::Users
            && !object.contains_key("password")
            && !object.contains_key("hash")
        {
            let exists = self
                .http
                .send(Method::GET, &path, Body::None, Trace::Quiet, false)
                .await?
                .ok();
            if exists {
                let patch: Vec<Value> = object
                    .iter()
                    .map(|(key, value)| json!({ "op": "add", "path": format!("/{key}"), "value": value }))
                    .collect();
                return self
                    .security_write(Method::PATCH, &path, Some(&Value::Array(patch)))
                    .await;
            }
            return Err(bad("새 사용자에는 비밀번호가 필요합니다"));
        }
        self.security_write(Method::PUT, &path, Some(&body)).await
    }

    pub(super) async fn delete_entries(
        &self,
        req: &SecurityDeleteRequest,
    ) -> Result<Value, EngineError> {
        check_confirmed(req.confirmed, what(req.kind))?;
        if req.names.is_empty() {
            return Err(bad("지울 항목이 없습니다"));
        }
        if req.kind == SecurityKind::ApiKeys {
            if self.opensearch() {
                self.require_os_api_keys()?;
                let mut replies = Vec::with_capacity(req.names.len());
                for id in &req.names {
                    let path = format!("{OS_API}/apitokens/{}", name_segment(id)?);
                    replies.push(self.security_write(Method::DELETE, &path, None).await?);
                }
                return Ok(json!({ "invalidated": req.names, "replies": replies }));
            }
            // `ids` came with 7.10; before it, one `id` a request.
            if self.version < Version(7, 10) {
                let mut replies = Vec::with_capacity(req.names.len());
                for id in &req.names {
                    replies.push(
                        self.security_write(
                            Method::DELETE,
                            "/_security/api_key",
                            Some(&json!({ "id": id })),
                        )
                        .await?,
                    );
                }
                return Ok(json!({ "invalidated": req.names, "replies": replies }));
            }
            return self
                .security_write(
                    Method::DELETE,
                    "/_security/api_key",
                    Some(&json!({ "ids": req.names })),
                )
                .await;
        }
        let mut replies = Vec::with_capacity(req.names.len());
        for name in &req.names {
            let path = self.entry_path(req.kind, name)?;
            replies.push(self.security_write(Method::DELETE, &path, None).await?);
        }
        Ok(json!({ "deleted": req.names, "replies": replies }))
    }

    pub(super) async fn set_password(
        &self,
        req: &UserPasswordRequest,
    ) -> Result<Value, EngineError> {
        check_confirmed(req.confirmed, "비밀번호를 바꾸려면")?;
        if req.password.is_empty() {
            return Err(bad("새 비밀번호를 입력하세요"));
        }
        let path = self.entry_path(SecurityKind::Users, &req.name)?;
        if self.opensearch() {
            let patch = json!([{ "op": "add", "path": "/password", "value": req.password }]);
            return self
                .security_write(Method::PATCH, &path, Some(&patch))
                .await;
        }
        self.security_write(
            Method::POST,
            &format!("{path}/_password"),
            Some(&json!({ "password": req.password })),
        )
        .await
    }

    pub(super) async fn set_enabled(&self, req: &UserEnabledRequest) -> Result<Value, EngineError> {
        check_confirmed(req.confirmed, "사용자를 켜거나 끄려면")?;
        if self.opensearch() {
            return Err(EngineError::Unsupported(OS_NO_DISABLE.into()));
        }
        let path = self.entry_path(SecurityKind::Users, &req.name)?;
        let action = if req.enabled { "_enable" } else { "_disable" };
        self.security_write(Method::PUT, &format!("{path}/{action}"), None)
            .await
    }

    pub(super) async fn new_api_key(&self, req: &ApiKeyRequest) -> Result<Value, EngineError> {
        check_confirmed(req.confirmed, "API 키를 만들려면")?;
        let body: Value = serde_json::from_str(req.body.get())
            .map_err(|err| bad(format!("본문이 JSON이 아닙니다: {err}")))?;
        if !body.is_object() {
            return Err(bad("본문은 JSON 객체여야 합니다"));
        }
        if self.opensearch() {
            self.require_os_api_keys()?;
            return self
                .security_write(Method::POST, &format!("{OS_API}/apitokens"), Some(&body))
                .await;
        }
        let mut key = self
            .security_write(Method::POST, "/_security/api_key", Some(&body))
            .await?;
        // Servers before 7.16 leave out the encoded form people paste.
        if key.get("encoded").is_none() {
            if let (Some(id), Some(secret)) = (
                key.get("id").and_then(Value::as_str),
                key.get("api_key").and_then(Value::as_str),
            ) {
                use base64::Engine as _;
                let encoded =
                    base64::engine::general_purpose::STANDARD.encode(format!("{id}:{secret}"));
                key["encoded"] = json!(encoded);
            }
        }
        Ok(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_keys_of_either_server_read_the_same() {
        let es = api_key_entry(&json!({
            "id": "k1", "name": "ci", "creation": 1700000000000_i64, "expiration": 1700003600000_i64,
            "invalidated": false, "username": "elastic", "realm": "reserved"
        }));
        assert_eq!(es["created_ms"], 1700000000000_i64);
        assert_eq!(es["expires_ms"], 1700003600000_i64);
        assert_eq!(es["user"], "elastic");
        assert_eq!(es["invalidated"], false);
        let os = api_key_entry(&json!({
            "id": "abc", "name": "pipeline", "created_at": "2026-10-01T00:00:00Z",
            "expires_at": "2026-11-01T00:00:00Z", "revoked_at": "2026-10-02T00:00:00Z", "created_by": "admin"
        }));
        assert_eq!(os["created_ms"], 1790812800000_i64);
        assert_eq!(os["invalidated"], true);
        assert_eq!(os["user"], "admin");
        // As OpenSearch 3.9 lists them: millisecond `iat` and `expires_at`.
        let listed = api_key_entry(&json!({
            "id": "dbma", "name": "k", "iat": 1793326736272_i64, "expires_at": 1795918736272_i64,
            "cluster_permissions": ["cluster_monitor"], "created_by": "admin"
        }));
        assert_eq!(listed["created_ms"], 1793326736272_i64);
        assert_eq!(listed["expires_ms"], 1795918736272_i64);
        assert_eq!(listed["invalidated"], false);
    }

    #[test]
    fn opensearch_entries_hide_the_hash_and_say_what_is_built_in() {
        let entry = os_entry(
            "kibanaserver",
            &json!({ "hash": "", "reserved": true, "hidden": false, "backend_roles": [], "description": "Demo" }),
            json!({ "description": "Demo" }),
        );
        assert_eq!(entry["reserved"], true);
        assert!(entry["body"].get("hash").is_none());
        assert!(entry["body"].get("reserved").is_none());
        assert_eq!(entry["body"]["description"], "Demo");
        let entry = es_entry(
            "elastic",
            &json!({ "metadata": { "_reserved": true } }),
            json!({}),
            json!({ "enabled": true }),
        );
        assert_eq!(entry["reserved"], true);
        assert_eq!(entry["enabled"], true);
    }
}
