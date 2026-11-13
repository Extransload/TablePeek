# Elasticsearch · OpenSearch

Written: 2026-10-29 · Status: implemented (this document is the contract between the server and the web UI)

There are two engine definitions (`elasticsearch`, `opensearch`) and one driver (`crates/tablepeek-engine/src/engines/elasticsearch/`). The paradigm is `search` and the work screen is `workbench: "search"` (web: `web/src/engines/elasticsearch/`, `opensearch/`).

## 1. Scope

- Supported servers: Elasticsearch 6.8, 7.x, 8.x, 9.x and OpenSearch 1.x, 2.x, 3.x. On 6.x (servers with mapping types) the indexes the page handles are treated as typeless (`_doc`): mapping reads and writes and index creation use `include_type_name=false`, document updates use `/{index}/_doc/{id}/_update`, explain uses `/{index}/_doc/{id}/_explain`, bulk with a default index uses `/{index}/_doc/_bulk`, bulk without a default index adds `_type: "_doc"` to every action line, and SQL uses `/_xpack/sql`.
- The server kind (flavor) is decided at connect time from the root response (`GET /`): if `version.distribution` is `"opensearch"` it is OpenSearch, otherwise Elasticsearch. The SQL path (`_sql` / `_plugins/_sql`) and the PIT path (`_pit` / `_search/point_in_time`) follow it. The engine id (`meta.kind`, saved profile) stays whatever engine the user picked. If the picked engine and the server differ, the connection still works and `flavor` in `GET /api/search/cluster` reports the real kind. If the root response has no `version.number`, the connection is refused with "not an Elasticsearch or OpenSearch server response".
- Versions where features appear: point in time from Elasticsearch 7.10 and OpenSearch 2.4 (on older servers `/pit` returns `unsupported_capability`), data streams from 7.9 and OpenSearch 1.0 (servers without them return an empty list). Export uses PIT only on Elasticsearch 7.10+, scroll elsewhere.
- The HTTP client is `reqwest` (rustls, already used by the engine crate). The official Rust client (the `elasticsearch` crate) is not used because it brings a product-header check that rejects OpenSearch and a separate TLS stack.

## 2. Connection

| config key | Meaning |
|---|---|
| `url` | `http(s)://[user[:password]@]host[:port][/path]`. Takes precedence over `host`, `port`, `tls`, `path_prefix`. The password is moved to `password` on save (same rule as `uri` in other engines) |
| `cloud_id` | (Elasticsearch only) Elastic Cloud ID. Takes precedence over `url` and `host`, and turns TLS on |
| `host`, `port` | Default `127.0.0.1`, `9200` |
| `tls` | bool. On means `https` |
| `path_prefix` | Path of a cluster behind a proxy (`/es`) |
| `auth` | `none` · `basic` · `api_key` · `bearer`. If absent: `basic` when `user` is set, otherwise `none` |
| `user` | For `basic` |
| `password` (secret) | The password for `basic`, the API key for `api_key` (encoded value or `id:api_key`), the token for `bearer`. It is the first secret, so the keychain and ask-every-time rules apply as usual. With `none` it is neither read nor asked for |
| `tls_ca_file` | PEM CA. If absent, system roots |
| `tls_fingerprint` | Certificate SHA-256 fingerprint (hex, `:` allowed). Trusted if any certificate in the chain the server sends matches (the "HTTP CA certificate SHA-256 fingerprint" ES 8 shows on first start) |
| `tls_skip_verify` | bool. Do not verify the certificate (for development) |
| `tls_client_cert`, `tls_client_key` | Client certificate and key for PKI authentication (PEM, both) |
| `sniff` | bool, default on. After connecting, reads the cluster's node list via `_nodes/http`, and if the current node does not accept the connection, sends the same request to the next node (the request never got a connection, so resending is safe even for writes). Not used when there is a Cloud ID or a path prefix (behind a proxy) |

- Node list: the configured address (seed) comes first, followed by the HTTP addresses the cluster publishes (`publish_address`; for `name/IP:port`, the name). Dedicated master nodes are excluded. A node that did not accept a connection is skipped for 60 seconds; if all are blocked, each is tried once more. When the node changes, the console logs `# a:9200에 연결할 수 없어 노드 b:9200으로 바꿉니다` (cannot connect to a:9200, switching to node b:9200), and the list is re-read soon after. While the cluster tab is open, the list is re-read every 60 seconds. Without permission to read the node list, only the seed is used (the reason is shown in the cluster tab). The `host` in server info is the node that answered when it is not the seed.

- Tunnels: both SSH and HTTP. With `sniff` on, the driver takes the tunnel itself (`TunnelTarget::Members`) and opens a local endpoint per node (the same approach as other engines' per-node forwarders); with it off, it uses a local endpoint to a single address (`Address`). Requests go to the local endpoint, and the `Host` header is the original `host:port`. For a host name, the URL keeps the name and only that name resolves to the local endpoint (`reqwest`'s pinned name resolution; the port comes from the URL, so the local port is used), so TLS SNI and certificate verification use the original name; for an IP address, the URL points to the local endpoint and the certificate is verified against the original IP. If the tunnel cannot reach the node, the local endpoint answers with a 502 carrying `x-tablepeek-tunnel-error` for HTTP, or closes before the handshake for HTTPS, and the driver treats this as a connection failure and moves to the next node.
- Connection check: `GET /` (version and kind, 30-second limit). 401 gives `Authentication failed: …` (for a saved connection, the password is asked again), TLS failure gives `TLS 연결 실패: …` (TLS connection failed; connecting with TLS to a plaintext server says "turn TLS off"), a plaintext connection to an HTTPS-only server that gets dropped says "turn TLS on", and a refused connection gives `…에 연결할 수 없습니다` (cannot connect to …). TCP connect timeout is 10 seconds; there is no request timeout (long searches are stopped by cancel).
- HTTP proxy environment variables are honored only when there is no tunnel (requests to a tunnel's local endpoint do not go through the proxy).

## 3. Capabilities

| Capability | Value |
|---|---|
| `language` | `"es-dsl"` (Query DSL JSON, Dev Tools console, SQL tab) |
| `objects` | `["index", "alias", "data_stream"]` |
| `schema` | `"declared"` (mapping) |
| `edit_by_key` | `true` (read, update, delete documents by `_id`; conflict detection with `if_seq_no`/`if_primary_term`) |
| `transactions` | `"none"` |
| `foreign_keys` · `ddl` · `users` · `validation` | `false` |
| `databases` | `"none"` |
| `explain` | `"es-profile"` (Profile API, `_explain`, `_validate/query`) |
| `exact_count` | `true` (`_count`) |
| `dump` | `"es-bulk"` (index definition + `_bulk` NDJSON) |
| `import_formats` / `export_formats` | `["ndjson", "json", "csv"]` |
| `sessions` | `{ "kill": true }` (session = running task, kill = `_tasks/<id>/_cancel`) |
| `aggregation` | `true` (aggregation is Query DSL `aggs`) |
| `indexes` | `{ "create": false, "drop": false }` (no secondary-index concept; indexes themselves are managed through the routes below) |

## 4. Server API

All routes take the `conn` query parameter and the same token auth as before. Body and response keys are snake_case; values are the JSON the server returned, as is. `index` accepts a single name, a comma list, a wildcard (`logs-*`), an alias, or a data stream (create and delete are exceptions, see below). Reads run inside the connection's execution gate like page statements and stop on the existing WebSocket `cancel` (every request carries `X-Opaque-Id: tablepeek:<n>`, and cancel sends `_tasks/<id>/_cancel` for the task with that header). Writes are not cancelled.

Values pass through byte for byte. Documents and queries (`doc`, `body`, `query`, `script`, `sort`, `search_after`, `source`, `highlight`, `track_total_hits`, `actions`, index create/mapping/settings bodies, console `body`) go to the cluster as the exact JSON text the page sent, and cluster responses (`search`, `profile`, `doc/get`, `mapping`, `settings`, `explain`, `validate`, `analyze`, `sql/translate`, console `body`, SQL `rows`, `_source` in export lines, alias `filter`) go to the page as the exact text received. Integers beyond i64/u64 (`18446744073709551617123`), decimals as written (`1.10`), and numbers f64 cannot represent (`1e400`) stay intact. The server holds these values as serde_json `raw_value` (`Box<RawValue>`, `search::Raw`) and never reads them as f64. When keys must be added to these values (`from`, `size`, `sort` etc. in a search body, `{ "doc": … }`, `{ "query": … }`), only the top-level keys are read and the values are re-joined as text (key order may become alphabetical). The search response's `elapsed_ms` is inserted at the very start of the response text. `arbitrary_precision` is not used because it changes `serde_json::Value` behavior across the whole workspace. Responses the server computes itself (`indices`, `nodes`, `perf`, `tasks`, `shards`, `cluster`, `count`, bulk summary, write results) carry no document values and are ordinary JSON.

### 4.1 Cluster

| Method and path | Body | Response |
|---|---|---|
| `GET /api/search/cluster` | — | `{ flavor, version, distribution, build_flavor, lucene_version, cluster_name, cluster_uuid, node_name, tagline, health, connection }` (`health` = `_cluster/health` as is, `connection` = `{ sniff, current, failovers, sniff_error, nodes: [{ address, name, seed, current, down }] }`) |
| `GET /api/search/nodes` | — | `[{ id, name, ip, roles, master, version, heap_percent, ram_percent, cpu, load_1m, disk_used_percent, uptime }]` (`_cat/nodes`) |
| `GET /api/search/privileges?index=` | — | `{ known, cluster: { monitor, manage }, index: { read, write, create_index, delete_index, manage } }`. Elasticsearch uses `_security/user/_has_privileges` (all `true` if security is off); OpenSearch uses the roles from `_plugins/_security/api/account` (all `true` for `all_access`, all `true` without the security plugin, `known: false` otherwise). Without `index`, `*`. Not logged to the console |
| `GET /api/search/perf` | — | `{ time, nodes, docs, store_bytes, search: { query_total, query_time_ms, fetch_total, scroll_total, current }, indexing: { index_total, index_time_ms, delete_total, current }, get_total, refresh_total, merges_current, heap_used_bytes, heap_max_bytes, cpu_percent, open_fds, http_open, thread_pools: { search: { active, queue, rejected }, write: {…} } }` (sums from `_nodes/stats`; the web UI polls every 2 seconds and derives per-second values from the differences). Not logged to the console |
| `GET /api/search/tasks?actions=` | — | `[{ id, node, action, description, start_time_ms, running_time_ms, cancellable, cancelled, parent_task_id, opaque_id }]` (`_tasks?detailed`, `actions` e.g. `*search*`) |
| `POST /api/search/tasks/cancel` | `{ id, confirmed }` | Server response as is. Without `confirmed`, `bad_request` |
| `POST /api/search/stop` | — | The page's stop. Stops waiting reads and looks up in `_tasks` the task for the page's last request that has no response yet (`X-Opaque-Id`): read tasks are cancelled, and remaining tasks (writes, tasks the server cannot cancel) are reported together with the cancellable tasks in their task tree (child and parent tasks) as `{ stopped, request, cancelled: [task], running: [{ …task, related: [task] }] }`. Runs outside the gate |
| `GET /api/search/hot-threads?threads=&interval=` | — | `text/plain` (`_nodes/hot_threads`) |
| `GET /api/search/security` | — | `{ flavor, enabled, reason?, user: { name, roles, realm?/backend_roles? }, manage, manage_api_keys?, user_enabled: { available, reason }, kinds: { users, roles, role_mappings, api_keys: { available, reason? } } }`. Elasticsearch uses `_security/_authenticate` (if security is off, `enabled: false` with the server's reason) and `_has_privileges` (`manage_security`, `manage_api_key`/`manage_own_api_key`); OpenSearch uses `_plugins/_security/api/account` (`enabled: false` without the security plugin), and `manage` means the `all_access` or `security_manager` role. Disabling users is Elasticsearch only (`user_enabled.available`). OpenSearch API keys (`apitokens`) exist from 3.7, so older servers report `available: false` |
| `GET /api/search/security/list?kind=` | — | `kind`: `users`, `roles`, `role_mappings`, `api_keys`. Each item is `{ name, reserved, hidden?, body, … }` (`body` is a definition the server will accept back: OpenSearch's `hash`, `reserved`, `hidden`, `static` and Elasticsearch roles' `transient_metadata` are removed). Users have `enabled`, `roles`, `full_name`, `email` (OpenSearch: `roles`, `backend_roles`, `description`), roles have `cluster`, `indices` (index patterns), role mappings have `enabled`, `roles`, `rules` (OpenSearch: `users`, `backend_roles`, `hosts`), API keys are `{ id, name, created_ms, expires_ms, invalidated, user, realm, body }` |
| `POST /api/search/security/put` | `{ kind, name, body, confirmed }` | Create or replace (`PUT /_security/user/{name}` etc., OpenSearch `PUT /_plugins/_security/api/internalusers/{name}` etc.). Editing an existing OpenSearch user without a password switches to `PATCH` (JSON Patch `add`) so the password is not lost |
| `POST /api/search/security/delete` | `{ kind, names, confirmed }` | Delete. API keys are invalidated (Elasticsearch `DELETE /_security/api_key { ids }`, OpenSearch `DELETE …/apitokens/{id}`) |
| `POST /api/search/security/password` | `{ name, password, confirmed }` | Elasticsearch `_password`, OpenSearch `PATCH` of `/password` |
| `POST /api/search/security/enabled` | `{ name, enabled, confirmed }` | Elasticsearch `_enable`/`_disable`. OpenSearch has no user disabling, so `unsupported_capability` |
| `POST /api/search/security/api-key` | `{ body, confirmed }` | New key (server response as is; the secret appears only here). If `encoded` is missing, as on Elasticsearch before 7.16, `id:api_key` is base64-encoded and added |
| `GET /api/search/shards?index=` | — | Array of `_cat/shards` rows (sizes in bytes) |

- All security writes require `confirmed` (just as `_security` and `_plugins/_security` are `danger` in the console) and are logged to the console and run history. `password`, `hash`, and the `value` of OpenSearch's password JSON Patch are masked as `****`.

### 4.2 Indexes, aliases, data streams

| Method and path | Body | Response |
|---|---|---|
| `GET /api/search/indices?hidden=` | — | `[{ name, health, status, uuid, docs, deleted, size, pri_size, primaries, replicas, aliases, data_stream, hidden }]`. `docs` and `size` are `null` for closed indexes; sizes in bytes. With `hidden=true`, hidden indexes (including system indexes starting with `.`) too |
| `GET /api/search/aliases` | — | `[{ alias, index, filter, index_routing, search_routing, is_write_index, is_hidden }]` |
| `GET /api/search/data-streams` | — | `data_streams` from `_data_stream` as is (`[]` on servers without them) |
| `GET /api/search/mapping?index=` | — | `_mapping` as is (keyed by index name) |
| `GET /api/search/settings?index=&defaults=` | — | `_settings` as is |
| `GET /api/search/definition?index=` | — | `{ settings, mappings, aliases }`: a body that can recreate the index (server-assigned `uuid`, `creation_date`, `version`, `provided_name`, `routing` etc. removed). Used for "DDL" in the structure tab and for dumps |
| `PUT /api/search/mapping` | `{ index, body }` | `_mapping` (add field) response |
| `PUT /api/search/settings` | `{ index, body }` | `_settings` response |
| `POST /api/search/index/create` | `{ index, body? }` | Response as is. A name containing `*` or `,` gives `bad_request` |
| `POST /api/search/index/delete` | `{ index, confirmed }` | Requires `confirmed`. `*`, `,`, `_all` give `bad_request` |
| `POST /api/search/index/open` | `{ index }` | |
| `POST /api/search/index/close` | `{ index, confirmed }` | Requires `confirmed` |
| `POST /api/search/index/refresh` | `{ index }` | |
| `POST /api/search/reindex` | `{ body, confirmed, wait?: true }` | `body` is the `_reindex` body (`source`, `dest`, …). Requires `confirmed`. With `wait: false`, `{ task }` |
| `POST /api/search/aliases` | `{ actions, confirmed? }` | `_aliases`. Requires `confirmed` if there is a `remove_index` action |

### 4.3 Search and documents

| Method and path | Body | Response |
|---|---|---|
| `POST /api/search/search` | `{ index?, body?, from?, size?, sort?, search_after?, source?, highlight?, track_total_hits?, pit?: { id, keep_alive? }, profile? }` | Server response as is + `elapsed_ms`. Top-level keys override the same keys in `body` (`source` → `_source`). With `pit`, sent without `index` |
| `POST /api/search/count` | `{ index, query? }` | `{ count }` |
| `POST /api/search/pit` | `{ index, keep_alive?: "1m" }` | `{ id }` |
| `DELETE /api/search/pit` | `{ id }` | `{ ok }` |
| `POST /api/search/doc/get` | `{ index, id, routing? }` | `{ _index, _id, _version, _seq_no, _primary_term, found, _source }` (if missing, `found: false`, 200) |
| `POST /api/search/doc/index` | `{ index, id?, doc, op_type?: "index"\|"create", if_seq_no?, if_primary_term?, routing?, refresh?: "wait_for" }` | `{ _index, _id, _version, result, _seq_no, _primary_term }` |
| `POST /api/search/doc/update` | `{ index, id, doc, if_seq_no?, if_primary_term?, routing?, refresh? }` | Same as above (`_update` with partial document `{ doc }`) |
| `POST /api/search/doc/delete` | `{ index, id, if_seq_no?, if_primary_term?, routing?, refresh? }` | Same as above |
| `POST /api/search/delete-by-query` | `{ index, query, confirmed, conflicts?, max_docs?, refresh? }` | Server response as is. Requires `confirmed` |
| `POST /api/search/update-by-query` | `{ index, query?, script?, confirmed, conflicts?, max_docs?, refresh? }` | Server response as is. Requires `confirmed` |

- Conflicts: edits in the UI send the `_seq_no` and `_primary_term` received when the document was read as `if_seq_no` and `if_primary_term`. If the document changed elsewhere in between, `es_version_conflict_engine_exception` (409) comes back, and the web UI, as with MongoDB, re-reads it with `doc/get` and shows "Current value / Your change" (or "Deleted elsewhere" if it is gone). Overwrite sends without the two values.
- `refresh` defaults to `"wait_for"` (so the change shows up in a list read right after). Document, by-query, and index-management writes are logged to the console and run history.

### 4.4 Analysis and query plans

| Method and path | Body | Response |
|---|---|---|
| `POST /api/search/profile` | Same as `/search` | Response of a search with `profile: true`, as is |
| `POST /api/search/explain` | `{ index, id, query }` | `_explain` response as is |
| `POST /api/search/validate` | `{ index?, query }` | `_validate/query?explain=true&rewrite=true` response as is (`valid`, `explanations`, `error`) |
| `POST /api/search/analyze` | `{ index?, body }` | `_analyze` response as is (`tokens`) |

### 4.5 SQL

| Method and path | Body | Response |
|---|---|---|
| `POST /api/search/sql` | `{ query, fetch_size?, cursor? }` | `{ columns: [{ name, type }], rows: [[…]], cursor, elapsed_ms }` (Elasticsearch `_sql?format=json` and OpenSearch `_plugins/_sql?format=jdbc` in the same shape; column names are aliases when present). With `cursor`, the next page is requested with `{ cursor }` alone. Without `fetch_size`, Elasticsearch uses 1,000 and OpenSearch sends nothing (that server's default of 200 rows, no cursor). OpenSearch's next pages come with empty `columns` (the first page's are used) |
| `POST /api/search/sql/close` | `{ cursor }` | `{ ok }` |
| `POST /api/search/sql/translate` | `{ query }` | The Query DSL the SQL becomes (ES `_sql/translate`, OpenSearch `_plugins/_sql/_explain`) |

### 4.6 Dev Tools console

| Method and path | Body | Response |
|---|---|---|
| `POST /api/search/console` | `{ method, path, body?, confirmed? }` | `{ status, body, content_type, elapsed_ms, class }`. Even when the server returns 4xx or 5xx, it is wrapped in a 200 (so the console can show it). If the connection itself fails, it is an ordinary error |
| `GET /api/search/console/classify?method=&path=` | — | `{ class, reason }` |

- `method`: `GET`, `HEAD`, `POST`, `PUT`, `DELETE` (case-insensitive). `path` must be a path starting with `/` (plus query string). `://`, a leading `//`, whitespace, control characters, `#`, and `.` or `..` segments give `bad_request`.
- `body`: a JSON value (object or array) or a string. A string is sent as NDJSON (`application/x-ndjson`, with a trailing newline added) if the path contains `_bulk`, `_msearch`, or `_mtermvectors`; otherwise it is sent as JSON exactly as written (invalid JSON comes back as the server's parse error). `HEAD` sends no body.
- Classification (`class`):
  - `read`: `GET`, `HEAD`; `POST`/`PUT` whose endpoint (from the first path segment starting with `_`) is a read: `_search` (including …`/template`, `/scroll`, `/point_in_time`), `_msearch`, `_count`, `_explain`, `_validate/query`, `_analyze`, `_field_caps`, `_mget`, `_termvectors`, `_mtermvectors`, `_render/template`, `_pit`, `_async_search`, `_eql/search`, `_query`, `_knn_search`, `_terms_enum`, `_rank_eval`, `_sql` (…`/translate`, `/close`), `_plugins/_sql`, `_plugins/_ppl`, `_plugins/_asynchronous_search`, `_search_shards`, `_resolve/index`, `_mapping/field`, `_cat`; `DELETE` that closes a cursor (`_search/scroll`, `_pit`, `_search/point_in_time`, `_async_search`, `_plugins/_asynchronous_search`).
  - `danger`: any other `DELETE`; `POST`/`PUT` whose endpoint or a segment of it is `_delete_by_query`, `_update_by_query`, `_reindex`, `_close`, `_shrink`, `_split`, `_restore`, `_shutdown` (also a `shutdown` segment), `_cluster/settings`, `_cluster/voting_config_exclusions`, `_cluster/reroute`, `_security`, `_plugins/_security`; `_bulk` with a `delete` action line.
  - `write`: any other `POST`/`PUT` (indexing and updating documents, creating indexes, mappings and settings, `_refresh`, `_bulk`, `_tasks/…/_cancel` etc.). `reason` is the endpoint's first segment (or the method if none).
- The server rejects `danger` without `confirmed: true` (`bad_request`). The safe-mode confirmation (level 1 for `danger`, level 2 also for `write`) is done by the web UI, which adds `confirmed: true` after confirming.
- Every request is logged to the console as `METHOD /path` + body (one-line JSON; NDJSON as `# NDJSON n줄` (n lines)), and successful (2xx) `write` and `danger` requests are also logged to run history. Values of `password`, `new_password`, `password_hash`, `api_key` in the body are masked as `****`. `read` is cancelled like page statements; `write` and `danger` run as writes (not cancelled).

### 4.7 Import and export

| Method and path | Body | Response |
|---|---|---|
| `POST /api/search/bulk?index=&refresh=&confirmed=` | NDJSON text (`_bulk` format, including the final newline) | `{ took, errors, count, failed, failures: [{ position, index, id, status, type, reason }] }` (`failures` is the first 100). Requires `confirmed=true` if there is a `delete` action. The web UI sends in chunks of about 1,000 lines |
| `POST /api/search/export` | `{ index, query?, sort?, source?, limit? }` | NDJSON stream: one `{ _index, _id, _source }` per line, final line `{"$end": { count }}`; on failure midway, final line `{"$error": { code, message }}`. Elasticsearch 7.10+ reads 1,000 at a time with PIT + `search_after` (`_shard_doc`), others with scroll (`2m`). Closing the connection closes the PIT or scroll |

### 4.8 Errors

- Errors from the server are `es_<type>` (`es_index_not_found_exception`, `es_parsing_exception`, `es_version_conflict_engine_exception`, `es_security_exception` …), `message` = `reason`, `server_code` = HTTP status, `code_name` = `type`, `details` = `{ status, root_cause, caused_by?, failed_shards?, index? }`, `position` = `{ line, column }` (`line`/`col` of the error or the first root cause, or `[1:15]` / `line 1:15:` in the reason text), `raw` = the whole response body. `type` and `reason` come from the outermost `error`, except for `search_phase_execution_exception` ("all shards failed") where the whole search failed, in which case they come from the first root cause (`es_query_shard_exception` etc.). For the OpenSearch SQL plugin, `details` is appended after the reason. Cancelled tasks (`task_cancelled_exception`) and requests stopped by cancel are `interrupted`.
- Responses whose error body is not JSON (a proxy's HTML etc.) are `es_http_<status>`.
- Failures with no server response, such as connection, TLS, or timeout, are `elasticsearch_error` / `opensearch_error`.
- Both engine definitions have `error_code_prefix: "es"`, so they share the web UI's error rules.

## 5. Console and history

- Requests sent by the UI are logged to the console (⌘J) in Dev Tools notation: `POST /shop-orders/_search` followed by a one-line JSON body on the next line. Status reads the UI repeats (`cluster`, `nodes`, `perf`, `tasks`, `hot-threads`, `shards`) are not logged. Export logs only the first request.
- Writes (documents, by-query, indexes, aliases, mappings, settings, bulk, console `write`/`danger`) are also logged to run history.

## 6. MCP (read-only)

For search engine connections, the MCP server (`tablepeek mcp`) exposes `search_list_indices` (option for hidden indexes), `search_mapping`, `search_query` (Query DSL `query`, `aggs`, `sort`, `source`, `from`, at most 100 hits), and `search_sql` (only SQL that passes TablePeek's read-only check, at most 1,000 rows). There are no write tools.

## 7. Tests

- Test servers (`testdb/compose.yml` profiles, one at a time): `make test-db ENGINE=elasticsearch` (Elasticsearch 8.17, security on, HTTP, `127.0.0.1:9201`, `elastic` / `tablepeek_test_pw`), `elasticsearch-tls` (the same 8.17 over HTTPS, `9203`, node certificate signed by `testdb/elasticsearch-tls/gen.sh` with the test CA `testdb/x509/ca.pem`, client certificate optional, the trial license's PKI realm maps `testdb/x509/client.pem` (CN=tablepeek-client) to superuser), `elasticsearch-7` (7.9.3, no PIT, `9204`), `elasticsearch-6` (6.8.23, mapping types, no data streams, `9206`, x86-64 image so emulated on ARM), `opensearch` (OpenSearch 2.19, security plugin demo configuration, self-signed HTTPS, `127.0.0.1:9202`, `admin` / `TablePeek_test_pw1`), `opensearch-1` (1.3.20, no PIT, `9205`, `admin` / `admin`), `opensearch-3` (3.9.0, `9207`, `admin` / `TablePeek_test_pw1`, API keys (`api_tokens.enabled`) turned on in the security config `testdb/opensearch-3/config.yml`). All publish `http.publish_host: 127.0.0.1` and the outer port as `http.publish_port` so the node list is reachable from the host. Heap 512 MB, memory limit 1.2 GB. `testdb/search-shop.sh` loads `testdb/search-shop.ndjson` (200 customers, 100 products, 500 orders (nested `items`), 300 reviews, deterministic), the aliases `shop` and `orders`, and an index template with the data stream `logs-shop-default` (200 events) (on 6.x typeless with `include_type_name=false`, and without the data stream). OpenSearch exports the node certificate to `testdb/opensearch/node.pem` (for fingerprint tests).
- Engine tests (`make test-live ENGINE=…`, `TABLEPEEK_TEST_ELASTICSEARCH=1`, `_ELASTICSEARCH_TLS`, `_ELASTICSEARCH_7`, `_ELASTICSEARCH_6`, `TABLEPEEK_TEST_OPENSEARCH=1`, `_OPENSEARCH_1`, `_OPENSEARCH_3`, `engines/elasticsearch/live.rs`): the same suite (`whole`) runs against each server. Connection, kind, server info; cluster, nodes, performance; indexes (document counts, aliases, data streams, hidden), mappings, definitions, settings; search (filter, sort, from/size, `_source`, highlight, `search_after`, PIT; `unsupported_capability` on servers without PIT); count; error codes and positions; document create, read, update, replace, delete and the conflict from a stale `if_seq_no`; bulk (failure positions, `delete` requires confirmation); by-query writes (require confirmation); changing mappings, settings, aliases; close and open; analyze, explain, validate, profile; SQL (to the end of 500 rows with a cursor, close, translate, errors); console (status as is, body written as text); export (all and limited; scroll on servers without PIT); tasks, hot threads, shards; cancelling a slow search (immediate `interrupted`, and the server task is cancelled too); reindex; connection failures (wrong password, TLS the wrong way round, closed port); after connecting through a proxy and closing the proxy, failover to a node the cluster published (one node with `sniff: false`); security (overview; creating and editing roles, users, role mappings (editing without a password keeps login working); logging in as the new user; changing the password; disabling and enabling (Elasticsearch; `unsupported_capability` on OpenSearch); creating an API key, logging in with it, listing, invalidating, rejecting an invalidated key (`unsupported_capability` on OpenSearch before 3.7); deleting; rejecting writes without confirmation); stop (`stopped: false` when nothing is running; a slow `_update_by_query` is a write, so it is not cancelled but reported as `running` and then that task is cancelled; for a slow search the task is cancelled and what remains is only non-cancellable tasks and their related tasks). Elasticsearch HTTPS additionally covers verification by name (`localhost`), rejection with system roots, CA and node certificate fingerprints passing and a wrong fingerprint rejected, no verification, PKI login with only a client certificate (user `tablepeek-client`), and rejection of a certificate without a key. Elasticsearch 6.8 also covers `_type` in bulk without a default index. Elasticsearch also covers connecting with an API key (encoded value and `id:key`) and connecting with the other engine definition (kind follows the server); OpenSearch covers rejecting the self-signed certificate, connecting by fingerprint, and rejecting a wrong fingerprint.
- Server tests (`search.rs`): `unsupported_capability` on other engines, rejection of index deletion and pattern deletion without confirmation, tokens; against a real server: route shapes, console `danger` rejection and classification, `es_<type>` error codes, bulk → NDJSON export (`$end`), console logging, HTTP tunnel (a CONNECT proxy inside the test) by both name and IP address (nodes the cluster published also appear in the list through the tunnel), `/stop` and `/security`, rejection of security writes without confirmation, OpenSearch through the tunnel with the demo CA: IP address verification (passes) and a name not in the certificate (rejected), OpenSearch 3: creating an API key through the security routes (`os_` token), listing, invalidating. The engine tests also cover the OpenSearch demo CA (`127.0.0.1`, `localhost`), client certificates (rejected without a key), and an Elasticsearch read-only user's `privileges` and write rejection (`es_security_exception`). The 7.x and 6.x profiles turn API keys on (`xpack.security.authc.api_key.enabled`, off by default before 8.0), and 6.8 starts with a trial license because API keys are not in the basic license.
- Unit tests: console classification, path checks, secret masking (including OpenSearch password patches and `hash`), `_type` in 6.x bulk, error parsing (positions, root cause, HTML, cancel), inference of fingerprint, API key, Cloud ID, URL, and auth method, path encoding, bulk summary, task list, performance sums, reading `publish_address`, excluding dedicated masters and node failover order, two fake cluster nodes behind a tunnel (fake forwarder) where losing the seed fails over to the other node and losing all fails with the tunnel's reason, `sniff: false`, both servers' API key shapes, hiding `hash` in OpenSearch items.

## 8. Limits

- The document count is the number of top-level documents counted with one search (a `_index` terms aggregation); if that fails, the Lucene document count from `_cat` (including nested documents) is used. The document count on the performance screen is the node total (including nested documents and replicas). (By design: this defines which number is shown.)
- The console accepts only the Kibana Dev Tools request format (`METHOD /path` + JSON). Sending several requests at once, variables, and auto-indent are handled by the web UI. (By design.)
- Tasks the server cannot cancel run to completion even after stop (the Elasticsearch and OpenSearch tasks API rejects `_cancel` for `cancellable: false` tasks). Stop shows that fact along with the cancellable related tasks in that task tree, and lets you cancel them.
- OpenSearch API keys exist from 3.7 and are turned on with `api_tokens.enabled` in the security config (`_plugins/_security/api/apitokens`, OpenSearch docs "API keys — Introduced 3.7"). On older servers the API keys section is disabled with the reason. If the server has the feature turned off, the list request shows the server's error as is.
- Elasticsearch 5.x and earlier is not supported (the `include_type_name`, `if_seq_no`, and `_security` paths exist from 6.7).
- Elasticsearch before 7.x does not return the API key list without a key, user, or realm name (`action_request_validation_exception`). On those servers the list combines the default realms (`reserved`, `default_native`, `default_file`) and the current user's realm, so keys created by users who logged in through another named realm in the config (LDAP etc.) are visible only when logged in through that realm.

## 9. UI (web, `web/src/engines/elasticsearch/`)

- Work screen `workbench: "search"`. Sidebar (`SearchSidebar`): indexes (status dot, document count, closed/hidden markers), aliases (write index marker), data streams, search, a toggle for hidden and system indexes, and a context menu (open, new console tab, stats, import and export, `_refresh`, open and close, add alias, reindex, new index with the same settings and mapping, delete).
- Index tab (`SearchWorkbench`; aliases and data streams use the same tab): `Documents | Mapping | Settings | Aliases | SQL | Analyze | Explain` + status, document count, size, and shard chips.
  - Documents: query bar (Lucene query string → `query_string`, Query DSL editor (autocomplete for mapping fields, query types, aggregations), sort `field:desc`, `_source` fields, recent queries, plan), the same ☰ / {} / ⊞ views as MongoDB (JSON in plain JSON notation), score and highlight display, cell, field, and JSON edits sent with `if_seq_no`/`if_primary_term` and on conflict the same "Current value / Your change" dialog as MongoDB, add, duplicate, and delete documents, bulk update (`_update_by_query`, painless) and bulk delete (`_delete_by_query`) show the affected count and the first 5 hits before the safe-mode confirmation. Paging uses `from`, and past the 10,000th hit uses `search_after` when there is a sort.
  - Right panel: the same app-level column as the MongoDB collection tab (same place, splitter, remembered width, drag to close, ⌘I, and tab-bar button as the SQL tab's row detail panel, open/closed per connection, `docs/MONGODB.md` §3.5). Table view shows the selected row (for nested levels, the element and its path); card and JSON views show the document picked by clicking its header or block or with ↑/↓ as the same field rows, and save with the `if_seq_no`/`if_primary_term` condition (view only when read-only). With nothing selected, or on another sub-tab (Mapping, Settings, Aliases, SQL, Analyze, Explain), it shows index info (name, `docs.count`, `docs.deleted`, `store.size`, `pri.store.size`, health; for aliases and data streams, the backing indexes).
  - Mapping (field tree, types, add field), Settings (grouped view, edit dynamic settings), Aliases (add, edit, delete), SQL (canvas grid, load more with the cursor, translate), Analyze (`_analyze`: analyzer, field, tokenizer + filters, explain), Explain (Profile API tree, per-shard time, `_validate/query`).
- Console tab (`ConsoleTab`): multiple requests, autocomplete for method, path, index, parameters, and body, safe mode (`classify` + `delete` in `_bulk`), response view, history, copy as cURL, auto-indent.
- Cluster tab (`ClusterTab`): status, performance graphs every 2 seconds, nodes, shards, tasks (cancel), hot threads.
- Security tab (`SecurityTab`, tab kind `searchSecurity`, one per connection, the current section is saved in the tab): from the sidebar menu and the connection's ⋯ menu "Security (users, roles, API keys)". Uses `GET /api/search/security` to show the logged-in user and management permission (if `manage` is `false`, "Can't manage security"); if security is off or the plugin is missing, only the server's reason is shown. Each of the `Users | Roles | Role mappings | API keys` sections has a list (name filter, hide built-in and hidden items or invalidated and expired keys) and dialogs (`SecurityDialogs`).
  - Users: create (password and confirmation), edit (Elasticsearch full name, email, roles; OpenSearch description, security roles, backend roles; fields not shown are kept as is from `body`), change password, enable and disable (Elasticsearch only; OpenSearch shows `user_enabled.reason` above the list), delete. Built-in users are view only (on Elasticsearch, password and enable/disable still work).
  - Roles: Elasticsearch has cluster privileges, index privileges (names and patterns, privileges, `field_security` grant and except, document query, `allow_restricted_indices`), application privileges, `run_as`. OpenSearch has `cluster_permissions`, `index_permissions` (patterns, `allowed_actions`, `fls`, `masked_fields`, `dls`), `tenant_permissions`, description. Built-in roles can only be viewed and copied. Privilege fields are chip inputs that suggest built-in privilege and action group names.
  - Role mappings: Elasticsearch has enabled, granted roles, a `rules` JSON editor and rule templates (all users, user name, realm, LDAP group, metadata, all, any, except; `role_templates` is left as is). On OpenSearch the role name is the mapping name, with `users`, `backend_roles`, `hosts`, and description.
  - API keys: name, ID, owner (realm), created, expiry, status (valid, expired, invalidated), invalidate. Creating takes a name, an expiry (default 30 days; a number of days or a custom value like `12h`; OpenSearch converts it to `duration_seconds`, does not accept keys without expiry, and has a default maximum of 90 days (`max_duration_seconds`), so it has no "Never expires" or 365 days and an expiry is required), Elasticsearch `role_descriptors` (templates) and metadata JSON, OpenSearch `cluster_permissions` and `index_permissions` JSON. The created key (`encoded`, OpenSearch `token`) and the `Authorization: ApiKey …` header are shown once, in place, and can be copied. On servers that cannot use them (OpenSearch before 3.7), the server's reason is shown.
  - Every write shows the request it will send (Dev Tools notation, password as `****`) and, when safe mode is on, asks for confirmation, just as `_security` is `danger` in the console. Delete, invalidate, and disabling a user always ask for confirmation regardless of safe mode, and delete requires typing the name in safe mode (or when it is the logged-in user). Read-only connections are view only.
- Admin dialogs (`SearchAdminDialogs`): create index, delete (type the name in safe mode), open, close, refresh, reindex, clone with the same definition, aliases, stats, import (NDJSON, JSON, CSV, `_bulk`, dump; `bulk` in batches of 1,000), export (NDJSON, JSON, CSV, `_bulk`, dump `es-bulk`).
- Shared view changes: MongoDB's `CardView` and `JsonView` gained `json` (plain JSON notation) and `headExtra`, and `DocTableView` gained `facts` (the list of facts the panel shows when nothing is selected). The panel uses `DocDetail` and `FactsList` from `DocDetailPanel`.
- The type column in cards and the right panel shows the mapping type (keyword, long, date, …; "Unmapped" if the field is not in the mapping). Integers above 2^53 are read exactly from the response (`bigints` in `parseJson`) and sent back as numbers unchanged (long, unsigned_long, including CSV, console, and import). Write permission is checked with `GET /api/search/privileges`; if writes are not allowed (or a write is rejected with 403), the tab is marked "Read-only" and edit, add, delete, and bulk writes are hidden. Create, delete, and import in the sidebar follow the same permission.
- Verified (2026-10-29): on OpenSearch 2.19, the connection form (TLS verification off, ask every time), sidebar, console run-all, query string, sort, highlight, card editing and the conflict dialog (overwrite), JSON, table, and right panel, Explain, SQL, adding a mapping field, Analyze, bulk delete (preview count), CSV import (including big integers), cluster tab. On Elasticsearch 8.17, viewing and editing big integers (9007199254740995 and 18446744073709551615 saved unchanged), mapping type display, adding mapping fields (nested, keyword multi-field), editing settings, adding an alias (filter autocomplete), Analyze (english, explain), cluster tab (nodes, shards, tasks, hot threads), create index (name check), reindex (safe-mode confirmation), bulk update (88 documents), dump export, delete (type name), recreate by dump import, close, open, console path/parameter/body autocomplete and the safe-mode confirmation for DELETE, read-only user (edit buttons disappear and "Read-only" is shown).
- Verified (2026-10-30, managed Chromium, ask every time): on OpenSearch 3.9, the security tab (user list, notice about disabling users, creating a 30-day API key → the `os_` token shown once → invalidate), and "Fail over to other nodes" in the connection form (advanced, on by default). On Elasticsearch 8.17, stopping a slow `_update_by_query` in the console → "Still running on the server" report and task cancel, the node serving requests in the cluster tab, the app-level right panel (card, JSON, and table selection fill the full-height panel; saving from the panel → conflict dialog for a document changed elsewhere → saving with overwrite; index info on the mapping tab; collapsing and expanding with ⌘I; dragging the splitter to close), the security tab (creating a user (password masked) → login → disable and enable → delete after typing the name, 32 roles, a role mapping from a rule template, creating and invalidating an API key). On OpenSearch 2.19, the same stop report and task cancel, table selection and panel save conflict (reload with the current value), index info on the settings tab, the security tab (50 roles and 7 role mappings; the API keys section says "from 3.7").
