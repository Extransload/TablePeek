# Elasticsearch · OpenSearch

작성: 2026-10-29 · 상태: 구현됨 (이 문서가 서버·웹 사이의 계약이다)

엔진 정의는 둘(`elasticsearch`, `opensearch`), 드라이버는 하나다(`crates/tablepeek-engine/src/engines/elasticsearch/`). 패러다임은 `search`이고 작업 화면은 `workbench: "search"`(웹 `web/src/engines/elasticsearch/`, `opensearch/`).

## 1. 범위

- 지원 서버: Elasticsearch 6.8·7.x·8.x·9.x, OpenSearch 1.x·2.x·3.x. 6.x(매핑 타입이 있는 서버)에서는 페이지가 다루는 인덱스를 타입 없이(`_doc`) 다룬다: 매핑 읽기·쓰기·인덱스 만들기에 `include_type_name=false`, 문서 고치기는 `/{index}/_doc/{id}/_update`, explain은 `/{index}/_doc/{id}/_explain`, 기본 인덱스가 있는 bulk는 `/{index}/_doc/_bulk`, 기본 인덱스가 없는 bulk는 동작 줄마다 `_type: "_doc"`을 붙이고, SQL은 `/_xpack/sql`.
- 서버 종류(flavor)는 접속할 때 루트 응답(`GET /`)으로 정한다: `version.distribution`이 `"opensearch"`면 OpenSearch, 아니면 Elasticsearch. SQL 경로(`_sql` / `_plugins/_sql`), PIT 경로(`_pit` / `_search/point_in_time`)가 이것을 따른다. 엔진 id(`meta.kind`, 저장 프로필)는 사용자가 고른 엔진 그대로다. 고른 엔진과 서버가 다르면 접속은 되고 `GET /api/search/cluster`의 `flavor`가 실제 종류를 알린다. 루트 응답에 `version.number`가 없으면 "Elasticsearch·OpenSearch 서버의 응답이 아닙니다"로 접속을 막는다.
- 기능이 생긴 버전: point in time은 Elasticsearch 7.10·OpenSearch 2.4부터(그 전 서버의 `/pit`은 `unsupported_capability`), 데이터 스트림은 7.9·OpenSearch 1.0부터(없는 서버는 빈 목록). 내보내기는 Elasticsearch 7.10+에서만 PIT, 그 밖은 scroll.
- HTTP 클라이언트는 `reqwest`(rustls, 엔진 크레이트가 이미 쓰는 것)다. 공식 Rust 클라이언트(`elasticsearch` 크레이트)는 OpenSearch를 거부하는 제품 헤더 검사와 별도 TLS 스택을 가져와 쓰지 않는다.

## 2. 접속

| config 키 | 뜻 |
|---|---|
| `url` | `http(s)://[user[:password]@]host[:port][/path]`. 있으면 `host`·`port`·`tls`·`path_prefix`보다 먼저다. 비밀번호는 저장할 때 `password`로 옮겨진다(다른 엔진의 `uri`와 같은 규칙) |
| `cloud_id` | (Elasticsearch만) Elastic Cloud ID. 있으면 `url`·`host`보다 먼저이고 TLS가 켜진다 |
| `host`, `port` | 기본 `127.0.0.1`, `9200` |
| `tls` | bool. 켜면 `https` |
| `path_prefix` | 프록시 뒤에 있는 클러스터의 경로(`/es`) |
| `auth` | `none` · `basic` · `api_key` · `bearer`. 없으면 `user`가 있을 때 `basic`, 없으면 `none` |
| `user` | `basic`일 때 |
| `password` (비밀) | `basic`은 비밀번호, `api_key`는 API 키(인코딩된 값 또는 `id:api_key`), `bearer`는 토큰. 첫 번째 비밀이라 키체인·매번 입력 규칙을 그대로 따른다. `none`이면 읽지도 묻지도 않는다 |
| `tls_ca_file` | PEM CA. 없으면 시스템 루트 |
| `tls_fingerprint` | 인증서 SHA-256 지문(16진수, `:` 있어도 됨). 서버가 보낸 인증서 사슬 중 하나가 맞으면 믿는다(ES 8이 처음 띄울 때 보여주는 "HTTP CA certificate SHA-256 fingerprint") |
| `tls_skip_verify` | bool. 인증서를 검사하지 않음(개발용) |
| `tls_client_cert`, `tls_client_key` | PKI 인증용 클라이언트 인증서·키(PEM, 둘 다) |
| `sniff` | bool, 기본 켬. 접속한 뒤 `_nodes/http`로 클러스터의 노드 목록을 읽어 두고, 지금 노드가 연결을 받지 않으면 다음 노드로 같은 요청을 보낸다(연결이 맺어지지 않은 요청이라 쓰기도 다시 보내도 안전하다). Cloud ID나 경로 접두어가 있으면(프록시 뒤) 쓰지 않는다 |

- 노드 목록: 설정의 주소(seed)가 첫째이고, 클러스터가 알린 HTTP 주소(`publish_address`, `이름/IP:포트`면 이름)가 뒤에 붙는다. 전용 마스터 노드는 뺀다. 연결을 받지 않은 노드는 60초 동안 건너뛰고, 모두 막히면 하나씩 한 번 더 해 본다. 노드를 바꾸면 콘솔에 `# a:9200에 연결할 수 없어 노드 b:9200으로 바꿉니다`가 남고, 목록을 곧 다시 읽는다. 클러스터 탭이 열려 있으면 60초마다 목록을 다시 읽는다. 노드 목록을 읽을 권한이 없으면 seed만 쓴다(이유는 클러스터 탭에). 서버 정보의 `host`는 seed가 아닌 노드가 응답할 때 그 노드다.

- 터널: SSH·HTTP 둘 다. `sniff`가 켜져 있으면 터널 자체(`TunnelTarget::Members`)를 받아 노드마다 로컬 끝을 열고(다른 엔진의 노드별 포워더와 같은 방식), 꺼져 있으면 주소 하나로 가는 로컬 끝(`Address`)을 쓴다. 요청은 로컬 끝으로 가고 `Host` 머리글은 원래 `호스트:포트`다. 호스트 이름이면 URL에 이름을 두고 그 이름만 로컬 끝으로 풀어(`reqwest`의 이름 고정 해석; 포트는 URL의 것이라 로컬 포트를 쓴다) TLS SNI·인증서 검사가 원래 이름으로 되고, IP 주소면 URL이 로컬 끝을 가리키고 인증서는 원래 IP로 검사한다. 터널이 노드에 닿지 못하면 로컬 끝은 HTTP면 `x-tablepeek-tunnel-error`를 단 502로, HTTPS면 핸드셰이크 전에 끊어 답하고, 드라이버는 이것을 연결 실패로 보아 다음 노드로 넘어간다.
- 접속 확인: `GET /`(버전·종류, 30초 제한). 401은 `Authentication failed: …`(저장된 연결이면 비밀번호를 다시 묻게 함), TLS 실패는 `TLS 연결 실패: …`(평문 서버에 TLS로 붙으면 "TLS를 끄세요"), HTTPS만 받는 서버에 평문으로 붙어 연결이 끊기면 "TLS를 켜세요", 연결 거부는 `…에 연결할 수 없습니다`. TCP 연결 시간 제한 10초, 요청 시간 제한은 없다(긴 검색은 취소로 멈춘다).
- HTTP 프록시 환경 변수는 터널이 없을 때만 따른다(터널의 로컬 끝으로 가는 요청은 프록시를 거치지 않는다).

## 3. 능력

| 능력 | 값 |
|---|---|
| `language` | `"es-dsl"` (Query DSL JSON, Dev Tools 콘솔, SQL 탭) |
| `objects` | `["index", "alias", "data_stream"]` |
| `schema` | `"declared"` (매핑) |
| `edit_by_key` | `true` (`_id`로 문서 읽기·고치기·지우기, `if_seq_no`/`if_primary_term`로 충돌 감지) |
| `transactions` | `"none"` |
| `foreign_keys` · `ddl` · `users` · `validation` | `false` |
| `databases` | `"none"` |
| `explain` | `"es-profile"` (Profile API·`_explain`·`_validate/query`) |
| `exact_count` | `true` (`_count`) |
| `dump` | `"es-bulk"` (인덱스 정의 + `_bulk` NDJSON) |
| `import_formats` / `export_formats` | `["ndjson", "json", "csv"]` |
| `sessions` | `{ "kill": true }` (세션 = 실행 중인 작업(tasks), 종료 = `_tasks/<id>/_cancel`) |
| `aggregation` | `true` (집계는 Query DSL의 `aggs`) |
| `indexes` | `{ "create": false, "drop": false }` (보조 인덱스 개념 없음; 인덱스 자체는 아래 경로로 관리) |

## 4. 서버 API

모두 `conn` 쿼리 매개변수, 기존과 같은 토큰 인증. 본문·응답 키는 snake_case, 값은 서버가 준 JSON 그대로다. `index`는 이름 하나, 쉼표 목록, 와일드카드(`logs-*`), 별칭, 데이터 스트림 모두 받는다(만들기·지우기는 예외, 아래). 읽기는 페이지의 문장처럼 연결의 실행 게이트 안에서 돌고 기존 WebSocket `cancel`로 멈춘다(요청마다 `X-Opaque-Id: tablepeek:<n>`을 달고, 취소하면 그 머리글의 작업을 `_tasks/<id>/_cancel`). 쓰기는 취소하지 않는다.

값은 바이트 그대로 지나간다. 문서와 질의(`doc`, `body`, `query`, `script`, `sort`, `search_after`, `source`, `highlight`, `track_total_hits`, `actions`, 인덱스 만들기·매핑·설정 본문, 콘솔 `body`)는 페이지가 보낸 JSON 글 그대로 클러스터로 가고, 클러스터의 응답(`search`·`profile`·`doc/get`·`mapping`·`settings`·`explain`·`validate`·`analyze`·`sql/translate`, 콘솔 `body`, SQL `rows`, 내보내기 줄의 `_source`, 별칭 `filter`)은 받은 글 그대로 페이지로 간다. i64·u64를 넘는 정수(`18446744073709551617123`), 쓴 대로의 소수(`1.10`), f64로 나타낼 수 없는 수(`1e400`)가 그대로 남는다. 서버는 serde_json의 `raw_value`(`Box<RawValue>`, `search::Raw`)로 이 값들을 들고 있고 f64로 읽지 않는다. 위의 값에 키를 더해야 할 때(검색 본문에 `from`·`size`·`sort` 등, `{ "doc": … }`, `{ "query": … }`)는 맨 위 키만 읽고 값은 글 그대로 다시 잇는다(키 순서는 알파벳순이 될 수 있다). 검색 응답의 `elapsed_ms`는 응답 글 맨 앞에 끼워 넣는다. `arbitrary_precision`은 작업 공간 전체의 `serde_json::Value` 동작을 바꾸므로 쓰지 않는다. 서버가 계산해 만드는 응답(`indices`, `nodes`, `perf`, `tasks`, `shards`, `cluster`, `count`, bulk 요약, 쓰기 결과)은 문서 값이 없어 보통 JSON이다.

### 4.1 클러스터

| 메서드·경로 | 본문 | 응답 |
|---|---|---|
| `GET /api/search/cluster` | — | `{ flavor, version, distribution, build_flavor, lucene_version, cluster_name, cluster_uuid, node_name, tagline, health, connection }` (`health` = `_cluster/health` 그대로, `connection` = `{ sniff, current, failovers, sniff_error, nodes: [{ address, name, seed, current, down }] }`) |
| `GET /api/search/nodes` | — | `[{ id, name, ip, roles, master, version, heap_percent, ram_percent, cpu, load_1m, disk_used_percent, uptime }]` (`_cat/nodes`) |
| `GET /api/search/privileges?index=` | — | `{ known, cluster: { monitor, manage }, index: { read, write, create_index, delete_index, manage } }`. Elasticsearch는 `_security/user/_has_privileges`(보안이 꺼져 있으면 모두 `true`), OpenSearch는 `_plugins/_security/api/account`의 역할(`all_access`면 모두 `true`, 보안 플러그인이 없으면 모두 `true`, 그 밖은 `known: false`). `index`를 빼면 `*`. 콘솔에 남지 않는다 |
| `GET /api/search/perf` | — | `{ time, nodes, docs, store_bytes, search: { query_total, query_time_ms, fetch_total, scroll_total, current }, indexing: { index_total, index_time_ms, delete_total, current }, get_total, refresh_total, merges_current, heap_used_bytes, heap_max_bytes, cpu_percent, open_fds, http_open, thread_pools: { search: { active, queue, rejected }, write: {…} } }` (`_nodes/stats` 합계; 웹이 2초마다 불러 차이로 초당 값). 콘솔에 남지 않는다 |
| `GET /api/search/tasks?actions=` | — | `[{ id, node, action, description, start_time_ms, running_time_ms, cancellable, cancelled, parent_task_id, opaque_id }]` (`_tasks?detailed`, `actions` 예: `*search*`) |
| `POST /api/search/tasks/cancel` | `{ id, confirmed }` | 서버 응답 그대로. `confirmed` 없으면 `bad_request` |
| `POST /api/search/stop` | — | 페이지의 정지. 기다리는 읽기를 멈추고, 응답이 오지 않은 페이지의 마지막 요청(`X-Opaque-Id`)의 작업을 `_tasks`에서 찾는다: 읽기의 작업은 취소하고, 남은 작업(쓰기, 서버가 취소할 수 없는 작업)은 그 작업 트리(하위 작업·상위 작업)에서 취소할 수 있는 작업과 함께 `{ stopped, request, cancelled: [작업], running: [{ …작업, related: [작업] }] }`로 답한다. 게이트 밖에서 돈다 |
| `GET /api/search/hot-threads?threads=&interval=` | — | `text/plain` (`_nodes/hot_threads`) |
| `GET /api/search/security` | — | `{ flavor, enabled, reason?, user: { name, roles, realm?/backend_roles? }, manage, manage_api_keys?, user_enabled: { available, reason }, kinds: { users, roles, role_mappings, api_keys: { available, reason? } } }`. Elasticsearch는 `_security/_authenticate`(보안이 꺼져 있으면 `enabled: false`와 서버의 이유)와 `_has_privileges`(`manage_security`, `manage_api_key`·`manage_own_api_key`), OpenSearch는 `_plugins/_security/api/account`(보안 플러그인이 없으면 `enabled: false`), `manage`는 `all_access`·`security_manager` 역할. 사용자 끄기는 Elasticsearch만(`user_enabled.available`). OpenSearch의 API 키(`apitokens`)는 3.7부터라 그 전 서버는 `available: false` |
| `GET /api/search/security/list?kind=` | — | `kind`: `users`·`roles`·`role_mappings`·`api_keys`. 항목마다 `{ name, reserved, hidden?, body, … }`(`body`는 서버가 다시 받을 정의: OpenSearch의 `hash`·`reserved`·`hidden`·`static`, Elasticsearch 역할의 `transient_metadata`는 뺌). 사용자는 `enabled`·`roles`·`full_name`·`email`(OpenSearch는 `roles`·`backend_roles`·`description`), 역할은 `cluster`·`indices`(인덱스 패턴), 역할 매핑은 `enabled`·`roles`·`rules`(OpenSearch는 `users`·`backend_roles`·`hosts`), API 키는 `{ id, name, created_ms, expires_ms, invalidated, user, realm, body }` |
| `POST /api/search/security/put` | `{ kind, name, body, confirmed }` | 만들기·바꾸기(`PUT /_security/user/{name}` 등, OpenSearch `PUT /_plugins/_security/api/internalusers/{name}` 등). 비밀번호 없이 기존 OpenSearch 사용자를 고치면 비밀번호를 잃지 않게 `PATCH`(JSON Patch `add`)로 바꾼다 |
| `POST /api/search/security/delete` | `{ kind, names, confirmed }` | 지우기. API 키는 무효화(Elasticsearch `DELETE /_security/api_key { ids }`, OpenSearch `DELETE …/apitokens/{id}`) |
| `POST /api/search/security/password` | `{ name, password, confirmed }` | Elasticsearch `_password`, OpenSearch `PATCH`의 `/password` |
| `POST /api/search/security/enabled` | `{ name, enabled, confirmed }` | Elasticsearch `_enable`·`_disable`. OpenSearch에는 사용자 끄기가 없어 `unsupported_capability` |
| `POST /api/search/security/api-key` | `{ body, confirmed }` | 새 키(서버 응답 그대로, 비밀은 이때만). 7.16 전 Elasticsearch처럼 `encoded`가 없으면 `id:api_key`를 base64로 붙인다 |
| `GET /api/search/shards?index=` | — | `_cat/shards` 행 배열(크기는 바이트) |

- 보안 쓰기는 모두 `confirmed`가 필요하고(콘솔의 `_security`·`_plugins/_security`가 `danger`인 것과 같음) 콘솔·실행 기록에 남는다. `password`·`hash`, OpenSearch의 비밀번호 JSON Patch의 `value`는 `****`로 가린다.

### 4.2 인덱스·별칭·데이터 스트림

| 메서드·경로 | 본문 | 응답 |
|---|---|---|
| `GET /api/search/indices?hidden=` | — | `[{ name, health, status, uuid, docs, deleted, size, pri_size, primaries, replicas, aliases, data_stream, hidden }]`. `docs`·`size`는 닫힌 인덱스면 `null`, 크기는 바이트. `hidden=true`면 숨은 인덱스(`.`으로 시작하는 시스템 인덱스 포함)도 |
| `GET /api/search/aliases` | — | `[{ alias, index, filter, index_routing, search_routing, is_write_index, is_hidden }]` |
| `GET /api/search/data-streams` | — | `_data_stream`의 `data_streams` 그대로(없는 서버는 `[]`) |
| `GET /api/search/mapping?index=` | — | `_mapping` 그대로(인덱스 이름이 키) |
| `GET /api/search/settings?index=&defaults=` | — | `_settings` 그대로 |
| `GET /api/search/definition?index=` | — | `{ settings, mappings, aliases }`: 그 인덱스를 다시 만들 수 있는 본문(서버가 정한 `uuid`·`creation_date`·`version`·`provided_name`·`routing` 등은 뺌). 구조 탭의 "DDL"과 덤프에 쓴다 |
| `PUT /api/search/mapping` | `{ index, body }` | `_mapping`(필드 추가) 응답 |
| `PUT /api/search/settings` | `{ index, body }` | `_settings` 응답 |
| `POST /api/search/index/create` | `{ index, body? }` | 응답 그대로. 이름에 `*`·`,`가 있으면 `bad_request` |
| `POST /api/search/index/delete` | `{ index, confirmed }` | `confirmed` 필요. `*`·`,`·`_all`은 `bad_request` |
| `POST /api/search/index/open` | `{ index }` | |
| `POST /api/search/index/close` | `{ index, confirmed }` | `confirmed` 필요 |
| `POST /api/search/index/refresh` | `{ index }` | |
| `POST /api/search/reindex` | `{ body, confirmed, wait?: true }` | `body`는 `_reindex` 본문(`source`·`dest`…). `confirmed` 필요. `wait: false`면 `{ task }` |
| `POST /api/search/aliases` | `{ actions, confirmed? }` | `_aliases`. `remove_index` 동작이 있으면 `confirmed` 필요 |

### 4.3 검색·문서

| 메서드·경로 | 본문 | 응답 |
|---|---|---|
| `POST /api/search/search` | `{ index?, body?, from?, size?, sort?, search_after?, source?, highlight?, track_total_hits?, pit?: { id, keep_alive? }, profile? }` | 서버 응답 그대로 + `elapsed_ms`. 맨 위 키가 `body`의 같은 키를 덮는다(`source` → `_source`). `pit`이 있으면 `index` 없이 보낸다 |
| `POST /api/search/count` | `{ index, query? }` | `{ count }` |
| `POST /api/search/pit` | `{ index, keep_alive?: "1m" }` | `{ id }` |
| `DELETE /api/search/pit` | `{ id }` | `{ ok }` |
| `POST /api/search/doc/get` | `{ index, id, routing? }` | `{ _index, _id, _version, _seq_no, _primary_term, found, _source }` (없으면 `found: false`, 200) |
| `POST /api/search/doc/index` | `{ index, id?, doc, op_type?: "index"\|"create", if_seq_no?, if_primary_term?, routing?, refresh?: "wait_for" }` | `{ _index, _id, _version, result, _seq_no, _primary_term }` |
| `POST /api/search/doc/update` | `{ index, id, doc, if_seq_no?, if_primary_term?, routing?, refresh? }` | 위와 같음 (부분 문서 `{ doc }`로 `_update`) |
| `POST /api/search/doc/delete` | `{ index, id, if_seq_no?, if_primary_term?, routing?, refresh? }` | 위와 같음 |
| `POST /api/search/delete-by-query` | `{ index, query, confirmed, conflicts?, max_docs?, refresh? }` | 서버 응답 그대로. `confirmed` 필요 |
| `POST /api/search/update-by-query` | `{ index, query?, script?, confirmed, conflicts?, max_docs?, refresh? }` | 서버 응답 그대로. `confirmed` 필요 |

- 충돌: 화면의 편집은 문서를 읽을 때 받은 `_seq_no`·`_primary_term`을 `if_seq_no`·`if_primary_term`으로 보낸다. 그사이 다른 곳에서 바뀌었으면 `es_version_conflict_engine_exception`(409)이 오고, 웹은 MongoDB처럼 `doc/get`으로 다시 읽어 "지금 값 / 내 변경"을 보여준다(없으면 "다른 곳에서 삭제되었습니다"). 덮어쓰기는 두 값을 빼고 보낸다.
- `refresh` 기본값은 `"wait_for"`(바로 다시 읽은 목록에 보이게). 문서·by-query·인덱스 관리 쓰기는 콘솔과 실행 기록에 남는다.

### 4.4 분석·실행 계획

| 메서드·경로 | 본문 | 응답 |
|---|---|---|
| `POST /api/search/profile` | `/search`와 같음 | `profile: true`로 검색한 응답 그대로 |
| `POST /api/search/explain` | `{ index, id, query }` | `_explain` 응답 그대로 |
| `POST /api/search/validate` | `{ index?, query }` | `_validate/query?explain=true&rewrite=true` 응답 그대로(`valid`, `explanations`, `error`) |
| `POST /api/search/analyze` | `{ index?, body }` | `_analyze` 응답 그대로(`tokens`) |

### 4.5 SQL

| 메서드·경로 | 본문 | 응답 |
|---|---|---|
| `POST /api/search/sql` | `{ query, fetch_size?, cursor? }` | `{ columns: [{ name, type }], rows: [[…]], cursor, elapsed_ms }` (Elasticsearch `_sql?format=json`, OpenSearch `_plugins/_sql?format=jdbc`를 같은 모양으로; 열 이름은 별칭이 있으면 별칭). `cursor`가 있으면 다음 페이지를 `{ cursor }`만으로. `fetch_size`가 없으면 Elasticsearch는 1,000, OpenSearch는 보내지 않는다(그 서버의 기본 200행, 커서 없음). OpenSearch의 다음 페이지에는 `columns`가 비어 온다(첫 페이지의 것을 쓴다) |
| `POST /api/search/sql/close` | `{ cursor }` | `{ ok }` |
| `POST /api/search/sql/translate` | `{ query }` | 그 SQL이 되는 Query DSL(ES `_sql/translate`, OpenSearch `_plugins/_sql/_explain`) |

### 4.6 Dev Tools 콘솔

| 메서드·경로 | 본문 | 응답 |
|---|---|---|
| `POST /api/search/console` | `{ method, path, body?, confirmed? }` | `{ status, body, content_type, elapsed_ms, class }`. 서버가 4xx·5xx를 돌려줘도 200으로 감싸 보낸다(콘솔에 보이도록). 연결 자체가 실패하면 보통 오류 |
| `GET /api/search/console/classify?method=&path=` | — | `{ class, reason }` |

- `method`: `GET`·`HEAD`·`POST`·`PUT`·`DELETE`(대소문자 무관). `path`는 `/`로 시작하는 경로(+쿼리 문자열)만. `://`, `//`로 시작, 공백·제어 문자·`#`, `.`·`..` 구간은 `bad_request`.
- `body`: JSON 값(객체·배열) 또는 문자열. 문자열은 경로에 `_bulk`·`_msearch`·`_mtermvectors`가 있으면 NDJSON(`application/x-ndjson`, 끝 줄바꿈을 붙임), 아니면 쓴 그대로 JSON으로 보낸다(틀린 JSON은 서버의 파싱 오류가 응답으로 온다). `HEAD`는 본문을 보내지 않는다.
- 분류(`class`):
  - `read`: `GET`·`HEAD`; 끝점(경로에서 `_`로 시작하는 첫 구간부터)이 읽기인 `POST`/`PUT`: `_search`(…`/template`·`/scroll`·`/point_in_time` 포함), `_msearch`, `_count`, `_explain`, `_validate/query`, `_analyze`, `_field_caps`, `_mget`, `_termvectors`, `_mtermvectors`, `_render/template`, `_pit`, `_async_search`, `_eql/search`, `_query`, `_knn_search`, `_terms_enum`, `_rank_eval`, `_sql`(…`/translate`·`/close`), `_plugins/_sql`, `_plugins/_ppl`, `_plugins/_asynchronous_search`, `_search_shards`, `_resolve/index`, `_mapping/field`, `_cat`; `DELETE`의 커서 닫기(`_search/scroll`, `_pit`, `_search/point_in_time`, `_async_search`, `_plugins/_asynchronous_search`).
  - `danger`: 그 밖의 `DELETE`; 끝점이나 그 구간이 `_delete_by_query`, `_update_by_query`, `_reindex`, `_close`, `_shrink`, `_split`, `_restore`, `_shutdown`(`shutdown` 구간도), `_cluster/settings`, `_cluster/voting_config_exclusions`, `_cluster/reroute`, `_security`, `_plugins/_security`인 `POST`/`PUT`; `delete` 동작 줄이 있는 `_bulk`.
  - `write`: 그 밖의 `POST`·`PUT`(문서 넣기·고치기, 인덱스 만들기, 매핑·설정, `_refresh`, `_bulk`, `_tasks/…/_cancel` 등). `reason`은 끝점의 첫 구간(없으면 메서드).
- 서버는 `danger`를 `confirmed: true` 없이 거절한다(`bad_request`). 안전 모드(수준 1은 `danger`, 수준 2는 `write`도) 확인은 웹이 하고 확인 뒤 `confirmed: true`를 붙인다.
- 모든 요청은 콘솔에 `METHOD /path` + 본문(한 줄 JSON, NDJSON은 `# NDJSON n줄`)으로 남고, 성공한(2xx) `write`·`danger`는 실행 기록에도 남는다. 본문의 `password`·`new_password`·`password_hash`·`api_key` 값은 `****`로 가린다. `read`는 페이지의 문장처럼 취소되고, `write`·`danger`는 쓰기로 돈다(취소되지 않음).

### 4.7 가져오기·내보내기

| 메서드·경로 | 본문 | 응답 |
|---|---|---|
| `POST /api/search/bulk?index=&refresh=&confirmed=` | NDJSON 텍스트(`_bulk` 형식, 마지막 줄바꿈 포함) | `{ took, errors, count, failed, failures: [{ position, index, id, status, type, reason }] }` (`failures`는 앞 100개). `delete` 동작이 있으면 `confirmed=true` 필요. 웹은 1,000줄 안팎으로 나눠 보낸다 |
| `POST /api/search/export` | `{ index, query?, sort?, source?, limit? }` | NDJSON 스트림: 한 줄에 `{ _index, _id, _source }` 하나, 마지막 줄 `{"$end": { count }}`; 중간에 실패하면 마지막 줄 `{"$error": { code, message }}`. Elasticsearch 7.10+는 PIT + `search_after`(`_shard_doc`), 그 밖은 scroll(`2m`)로 1,000건씩 읽는다. 연결을 끊으면 PIT·scroll을 닫는다 |

### 4.8 오류

- 서버가 준 오류는 `es_<type>`(`es_index_not_found_exception`, `es_parsing_exception`, `es_version_conflict_engine_exception`, `es_security_exception` …), `message` = `reason`, `server_code` = HTTP 상태, `code_name` = `type`, `details` = `{ status, root_cause, caused_by?, failed_shards?, index? }`, `position` = `{ line, column }`(오류나 첫 root cause의 `line`·`col`, 또는 이유 글의 `[1:15]`·`line 1:15:`), `raw` = 응답 본문 전체. `type`·`reason`은 맨 바깥 `error`의 것이되, 검색 전체가 실패한 `search_phase_execution_exception`("all shards failed")이면 첫 root cause의 것(`es_query_shard_exception` 등). OpenSearch SQL 플러그인의 `details`는 이유 뒤에 붙인다. 취소된 작업(`task_cancelled_exception`)과 취소로 멈춘 요청은 `interrupted`.
- 오류 본문이 JSON이 아닌 응답(프록시의 HTML 등)은 `es_http_<status>`.
- 연결·TLS·시간 초과처럼 서버 응답이 없는 실패는 `elasticsearch_error` / `opensearch_error`.
- 두 엔진 정의 모두 `error_code_prefix: "es"`라 웹의 오류 규칙을 함께 쓴다.

## 5. 콘솔·기록

- 화면이 보낸 요청이 콘솔(⌘J)에 Dev Tools 표기로 남는다: `POST /shop-orders/_search` 다음 줄에 한 줄 JSON 본문. 화면이 되풀이해 부르는 상태 읽기(`cluster`, `nodes`, `perf`, `tasks`, `hot-threads`, `shards`)는 남기지 않는다. 내보내기는 첫 요청만 남긴다.
- 쓰기(문서·by-query·인덱스·별칭·매핑·설정·bulk·콘솔의 `write`/`danger`)는 실행 기록에도 남는다.

## 6. MCP (읽기 전용)

검색 엔진 연결에서 MCP 서버(`tablepeek mcp`)는 `search_list_indices`(숨은 인덱스 선택), `search_mapping`, `search_query`(Query DSL의 `query`·`aggs`·`sort`·`source`·`from`, 최대 100건), `search_sql`(TablePeek의 읽기 전용 판정을 통과한 SQL만, 최대 1,000행)을 낸다. 쓰기 도구는 없다.

## 7. 테스트

- 테스트 서버(`testdb/compose.yml` 프로필, 하나씩): `make test-db ENGINE=elasticsearch`(Elasticsearch 8.17, 보안 켬·HTTP, `127.0.0.1:9201`, `elastic` / `tablepeek_test_pw`), `elasticsearch-tls`(같은 8.17에 HTTPS, `9203`, 노드 인증서는 `testdb/elasticsearch-tls/gen.sh`가 테스트 CA `testdb/x509/ca.pem`으로 서명, 클라이언트 인증서 선택, 체험 라이선스의 PKI 영역이 `testdb/x509/client.pem`(CN=tablepeek-client)을 superuser로 매핑), `elasticsearch-7`(7.9.3, PIT 없음, `9204`), `elasticsearch-6`(6.8.23, 매핑 타입·데이터 스트림 없음, `9206`, x86-64 이미지라 ARM에서는 에뮬레이션), `opensearch`(OpenSearch 2.19, 보안 플러그인 데모 설정·HTTPS 자체 서명, `127.0.0.1:9202`, `admin` / `TablePeek_test_pw1`), `opensearch-1`(1.3.20, PIT 없음, `9205`, `admin` / `admin`), `opensearch-3`(3.9.0, `9207`, `admin` / `TablePeek_test_pw1`, 보안 설정 `testdb/opensearch-3/config.yml`에서 API 키(`api_tokens.enabled`)를 켬). 모두 `http.publish_host: 127.0.0.1`과 바깥 포트를 `http.publish_port`로 알려 노드 목록이 호스트에서 닿는다. 힙 512 MB, 메모리 상한 1.2 GB. `testdb/search-shop.sh`가 `testdb/search-shop.ndjson`(고객 200·상품 100·주문 500(중첩 `items`)·후기 300, 결정적)과 별칭 `shop`·`orders`, 인덱스 템플릿과 데이터 스트림 `logs-shop-default`(이벤트 200건)를 넣는다(6.x는 `include_type_name=false`로 타입 없이, 데이터 스트림 없이). OpenSearch는 노드 인증서를 `testdb/opensearch/node.pem`으로 꺼내 둔다(지문 시험용).
- 엔진 시험(`make test-live ENGINE=…`, `TABLEPEEK_TEST_ELASTICSEARCH=1`·`_ELASTICSEARCH_TLS`·`_ELASTICSEARCH_7`·`_ELASTICSEARCH_6`·`TABLEPEEK_TEST_OPENSEARCH=1`·`_OPENSEARCH_1`·`_OPENSEARCH_3`, `engines/elasticsearch/live.rs`): 서버마다 같은 묶음(`whole`)을 돈다. 접속·종류·서버 정보, 클러스터·노드·성능, 인덱스(문서 수·별칭·데이터 스트림·숨김)·매핑·정의·설정, 검색(필터·정렬·from/size·`_source`·하이라이트·`search_after`·PIT, PIT이 없는 서버는 `unsupported_capability`), count, 오류 코드와 위치, 문서 만들기·읽기·고치기·바꾸기·지우기와 낡은 `if_seq_no`의 충돌, bulk(실패 위치, `delete`는 확인 필요), by-query 쓰기(확인 필요), 매핑·설정·별칭 바꾸기, 닫기·열기, analyze·explain·validate·profile, SQL(커서로 500행 끝까지, 닫기, 번역, 오류), 콘솔(상태 그대로, 글로 쓴 본문), 내보내기(전부·제한; PIT 없는 서버는 scroll), 작업·hot threads·샤드, 느린 검색 취소(바로 `interrupted`, 서버 작업도 취소됨), reindex; 접속 실패(틀린 비밀번호·TLS 반대로·닫힌 포트); 프록시를 거쳐 접속한 뒤 프록시를 닫으면 클러스터가 알린 노드로 넘어감(`sniff: false`면 노드 하나); 보안(개요, 역할·사용자·역할 매핑 만들기·고치기(비밀번호 없이 고쳐도 로그인 유지)·새 사용자로 로그인·비밀번호 바꾸기·끄고 켜기(Elasticsearch; OpenSearch는 `unsupported_capability`)·API 키 만들기·그 키로 로그인·목록·무효화·무효화한 키 거부(OpenSearch 3.7 전은 `unsupported_capability`)·지우기, 확인 없는 쓰기 거절); 정지(아무것도 없을 때 `stopped: false`, 느리게 돌린 `_update_by_query`는 쓰기라 취소하지 않고 `running`으로 알린 뒤 그 작업을 취소, 느린 검색은 작업이 취소되고 남은 것은 취소할 수 없는 작업과 그 관련 작업뿐). Elasticsearch HTTPS는 그 밖에 이름(`localhost`)으로 확인, 시스템 루트 거부, CA·노드 인증서 지문 통과·틀린 지문 거부, 검사 안 함, 클라이언트 인증서만으로 PKI 로그인(사용자 `tablepeek-client`)·키 없는 인증서 거부. Elasticsearch 6.8은 기본 인덱스 없는 bulk의 `_type`도. 그 밖에 Elasticsearch는 API 키(인코딩 값·`id:key`)로 접속과 다른 엔진 정의로 접속(종류는 서버대로), OpenSearch는 자체 서명 인증서 거부·지문으로 접속·틀린 지문 거부.
- 서버 시험(`search.rs`): 다른 엔진에서 `unsupported_capability`, 확인 없는 인덱스 삭제·패턴 삭제 거절, 토큰; 실제 서버에 대해 경로 형식, 콘솔의 `danger` 거절·분류, `es_<type>` 오류 코드, bulk → NDJSON 내보내기(`$end`), 콘솔 기록, HTTP 터널(테스트 안의 CONNECT 프록시)로 이름·IP 주소 둘 다(클러스터가 알린 노드도 터널 너머로 목록에 오름), `/stop`·`/security`, 확인 없는 보안 쓰기 거절, OpenSearch는 터널 너머에서 데모 CA로 IP 주소 확인(통과)·인증서에 없는 이름(거부), OpenSearch 3은 보안 경로로 API 키 만들기(`os_` 토큰)·목록·무효화. 엔진 시험은 OpenSearch 데모 CA(`127.0.0.1`·`localhost`)·클라이언트 인증서(키가 없으면 거부), Elasticsearch 읽기 전용 사용자의 `privileges`·쓰기 거부(`es_security_exception`)도 본다. 7.x·6.x 프로필은 API 키를 켜고(`xpack.security.authc.api_key.enabled`, 8.0 전 기본 꺼짐), 6.8은 API 키가 기본 라이선스에 없어 체험 라이선스로 띄운다.
- 단위 시험: 콘솔 분류·경로 검사·비밀 가리기(OpenSearch 비밀번호 패치·`hash` 포함), 6.x bulk의 `_type`, 오류 해석(위치·root cause·HTML·취소), 지문·API 키·Cloud ID·URL·인증 방식 추론, 경로 인코딩, bulk 요약, 작업 목록, 성능 합계, `publish_address` 읽기·전용 마스터 빼기·노드 넘어가기 순서, 가짜 클러스터 두 노드를 터널(가짜 포워더)로 이어 seed가 사라지면 다른 노드로 넘어가고 모두 사라지면 터널의 이유로 실패, `sniff: false`, API 키 두 서버 모양, OpenSearch 항목의 `hash` 숨김.

## 8. 한계

- 문서 수는 검색 한 번(`_index` terms 집계)으로 센 최상위 문서 수이고, 실패하면 `_cat`의 Lucene 문서 수(중첩 문서 포함)를 쓴다. 성능 화면의 문서 수는 노드 합계(중첩·복제본 포함)다. (설계상: 어떤 수를 보이는지의 정의다.)
- 콘솔은 Kibana Dev Tools의 요청 형식(`METHOD /path` + JSON)만 받는다. 여러 요청을 한 번에 보내는 것, 변수, 자동 들여쓰기는 웹이 맡는다. (설계상.)
- 서버가 취소할 수 없는 작업은 정지해도 끝까지 돈다(Elasticsearch·OpenSearch의 tasks API가 `cancellable: false` 작업의 `_cancel`을 거절한다). 정지는 그 사실과, 그 작업 트리에서 취소할 수 있는 관련 작업을 보이고 취소하게 한다.
- OpenSearch의 API 키는 3.7부터 있고 보안 설정의 `api_tokens.enabled`로 켠다(`_plugins/_security/api/apitokens`, OpenSearch 문서 "API keys — Introduced 3.7"). 그 전 서버의 API 키 칸은 이유와 함께 비활성이다. 서버가 그 기능을 끈 채면 목록 요청이 서버의 오류를 그대로 보인다.
- 5.x 이하 Elasticsearch는 지원하지 않는다(`include_type_name`·`if_seq_no`·`_security` 경로가 6.7부터).
- 7.x 전 Elasticsearch는 API 키 목록을 키·사용자·렐름 이름 없이 주지 않는다(`action_request_validation_exception`). 그런 서버에서는 기본 렐름(`reserved`·`default_native`·`default_file`)과 지금 사용자의 렐름 것을 모아 보이므로, 설정에서 이름을 붙인 다른 렐름(LDAP 등)으로 로그인한 사용자가 만든 키는 그 렐름으로 로그인해야 보인다.

## 9. 화면 (웹, `web/src/engines/elasticsearch/`)

- 작업 화면 `workbench: "search"`. 사이드바(`SearchSidebar`): 인덱스(상태 점·문서 수·닫힘/숨김 표시)·별칭(쓰기 인덱스 표시)·데이터 스트림, 검색, 숨은·시스템 인덱스 토글, 우클릭 메뉴(열기, 새 콘솔 탭, 통계, 가져오기·내보내기, `_refresh`, 열기·닫기, 별칭 추가, 재색인, 같은 설정·매핑으로 새 인덱스, 삭제).
- 인덱스 탭(`SearchWorkbench`, 별칭·데이터 스트림도 같은 탭): `문서 | 매핑 | 설정 | 별칭 | SQL | 분석 | 실행 계획` + 상태·문서 수·크기·샤드 칩.
  - 문서: 쿼리 막대(Lucene 검색어 → `query_string`, Query DSL 편집기(매핑 필드·쿼리 종류·집계 자동완성), 정렬 `필드:desc`, `_source` 필드, 최근 쿼리, 계획), MongoDB와 같은 ☰ / {} / ⊞ 보기(JSON은 평범한 JSON 표기), 점수·하이라이트 표시, 셀·필드·JSON 편집은 `if_seq_no`/`if_primary_term`로 보내고 충돌이면 MongoDB와 같은 "지금 값 / 내 변경" 창, 문서 추가·복제·삭제, 일괄 수정(`_update_by_query`, painless)·일괄 삭제(`_delete_by_query`)는 영향받는 수와 앞 5건을 먼저 보여 준 뒤 안전 모드 확인. 페이지는 `from`으로, 10,000번째 뒤로는 정렬이 있을 때 `search_after`로 넘긴다.
  - 오른쪽 패널: MongoDB 컬렉션 탭과 같은 앱 단위 열(SQL 탭의 행 상세 패널과 같은 자리·분할선·너비 기억·끌어서 닫기·⌘I·탭 줄 버튼, 연결마다 열림/닫힘, `docs/MONGODB.md` §3.5). 표 보기는 선택한 행(하위 단계면 원소와 경로), 카드·JSON 보기는 머리·블록을 누르거나 ↑/↓로 고른 문서를 같은 필드 줄로 보여 주고 `if_seq_no`/`if_primary_term` 조건으로 저장한다(읽기 전용이면 보기만). 고른 것이 없거나 다른 하위 탭(매핑·설정·별칭·SQL·분석·실행 계획)이면 인덱스 정보(이름·`docs.count`·`docs.deleted`·`store.size`·`pri.store.size`·health, 별칭·데이터 스트림은 뒤의 인덱스들).
  - 매핑(필드 트리·타입·필드 추가), 설정(그룹 보기·동적 설정 고치기), 별칭(추가·편집·지우기), SQL(캔버스 그리드, 커서로 더 불러오기, 번역), 분석(`_analyze`: 분석기·필드·토크나이저+필터, explain), 실행 계획(Profile API 트리, 샤드별 시간, `_validate/query`).
- 콘솔 탭(`ConsoleTab`): 여러 요청, 메서드·경로·인덱스·매개변수·본문 자동완성, 안전 모드(`classify` + `_bulk`의 `delete`), 응답 보기, 기록, cURL 복사, 자동 들여쓰기.
- 클러스터 탭(`ClusterTab`): 상태, 2초마다 성능 그래프, 노드, 샤드, 작업(취소), hot threads.
- 보안 탭(`SecurityTab`, 탭 종류 `searchSecurity`, 연결마다 하나, 보던 칸은 탭에 저장): 사이드바 메뉴와 연결의 ⋯ 메뉴 "보안 (사용자·역할·API 키)". `GET /api/search/security`로 로그인한 사용자·관리 권한(`manage`가 `false`면 "보안 관리 권한 없음")을 보이고, 보안이 꺼졌거나 플러그인이 없으면 서버의 이유만 보인다. `사용자 | 역할 | 역할 매핑 | API 키` 칸마다 목록(이름 거르기, 기본 제공·숨김 항목 또는 무효화·만료된 키 숨기기)과 창(`SecurityDialogs`).
  - 사용자: 만들기(비밀번호·확인)·편집(Elasticsearch 전체 이름·이메일·역할, OpenSearch 설명·보안 역할·백엔드 역할; 보이지 않는 필드는 `body`에서 그대로), 비밀번호 바꾸기, 켜기·끄기(Elasticsearch만, OpenSearch는 `user_enabled.reason`을 목록 위에 보인다), 삭제. 기본 제공 사용자는 보기만(Elasticsearch는 비밀번호·켜기·끄기는 된다).
  - 역할: Elasticsearch는 클러스터 권한, 인덱스 권한(이름·패턴, 권한, `field_security` grant·except, 문서 쿼리, `allow_restricted_indices`), 애플리케이션 권한, `run_as`. OpenSearch는 `cluster_permissions`, `index_permissions`(패턴, `allowed_actions`, `fls`, `masked_fields`, `dls`), `tenant_permissions`, 설명. 기본 제공 역할은 보기와 복사만. 권한 칸은 칩 입력이고 기본 권한·동작 그룹 이름을 제안한다.
  - 역할 매핑: Elasticsearch는 사용, 줄 역할, `rules` JSON 편집기와 규칙 템플릿(모든 사용자, 사용자 이름, 렐름, LDAP 그룹, 메타데이터, all·any·except; `role_templates`는 그대로 둔다). OpenSearch는 역할 이름이 매핑 이름이고 `users`·`backend_roles`·`hosts`·설명.
  - API 키: 이름·ID·소유자(렐름)·만든 때·만료·상태(유효·만료됨·무효화됨), 무효화. 만들기는 이름, 만료(기본 30일, 일 수 또는 `12h` 같은 직접 입력; OpenSearch는 `duration_seconds`로 바꾸고, 만료 없는 키를 받지 않고 기본 최대가 90일(`max_duration_seconds`)이라 "만료 없음"·365일이 없고 만료가 꼭 있어야 한다), Elasticsearch `role_descriptors`(템플릿)·메타데이터 JSON, OpenSearch `cluster_permissions`·`index_permissions` JSON. 만든 키(`encoded`·OpenSearch `token`)와 `Authorization: ApiKey …` 머리글은 그 자리에서 한 번만 보이고 복사할 수 있다. 쓸 수 없는 서버(OpenSearch 3.7 전)는 서버의 이유를 보인다.
  - 쓰기는 모두 보낼 요청(Dev Tools 표기, 비밀번호는 `****`)을 보이고, 콘솔의 `_security`가 `danger`인 것처럼 안전 모드가 켜져 있으면 확인한다. 삭제·무효화·사용자 끄기는 안전 모드와 상관없이 확인하고, 삭제는 안전 모드에서(또는 로그인한 사용자 자신이면) 이름을 입력해야 한다. 읽기 전용 연결은 보기만.
- 관리 창(`SearchAdminDialogs`): 인덱스 만들기·삭제(안전 모드에서 이름 입력)·열기·닫기·새로 고침·재색인·같은 정의로 복제·별칭·통계, 가져오기(NDJSON·JSON·CSV·`_bulk`·덤프, 1,000건씩 `bulk`), 내보내기(NDJSON·JSON·CSV·`_bulk`·덤프 `es-bulk`).
- 공유 보기 변경: MongoDB의 `CardView`·`JsonView`에 `json`(평범한 JSON 표기)·`headExtra`, `DocTableView`에 `facts`(고른 것이 없을 때 패널이 보일 사실 목록)를 더했다. 패널은 `DocDetailPanel`의 `DocDetail`·`FactsList`를 쓴다.
- 카드·오른쪽 패널의 타입 칸은 매핑 타입(keyword·long·date…, 매핑에 없으면 "매핑 없음")을 보인다. 2^53을 넘는 정수는 응답을 정확히 읽고(`parseJson`의 `bigints`) 그대로 숫자로 다시 보낸다(long·unsigned_long, CSV·콘솔·가져오기 포함). 쓰기 권한은 `GET /api/search/privileges`로 묻고, 쓸 수 없으면(또는 쓰기가 403으로 거절되면) 탭에 "읽기 전용"을 달고 편집·추가·삭제·일괄 쓰기를 숨긴다. 사이드바의 만들기·삭제·가져오기도 같은 권한을 따른다.
- 확인(2026-10-29): OpenSearch 2.19에서 접속 폼(TLS 검사 안 함, 매번 입력), 사이드바, 콘솔 모두 실행, 검색어·정렬·하이라이트, 카드 편집과 충돌 창(덮어쓰기), JSON·표·오른쪽 패널, 실행 계획, SQL, 매핑 필드 추가, 분석, 일괄 삭제(미리 보기 수), CSV 가져오기(큰 정수 포함), 클러스터 탭. Elasticsearch 8.17에서 큰 정수 보기·편집(9007199254740995, 18446744073709551615가 그대로 저장), 매핑 타입 표시, 매핑 필드 추가(중첩·keyword 다중 필드), 설정 편집, 별칭 추가(필터 자동완성), 분석(english, explain), 클러스터 탭(노드·샤드·작업·핫 스레드), 인덱스 만들기(이름 검사)·재색인(안전 모드 확인)·일괄 수정(88건)·덤프 내보내기·삭제(이름 입력)·덤프 가져오기로 다시 만들기·닫기·열기, 콘솔 경로·매개변수·본문 자동완성과 DELETE 안전 모드 확인, 읽기 전용 사용자(편집 버튼이 사라지고 "읽기 전용" 표시).
- 확인(2026-10-30, 관리형 Chromium, 매번 입력): OpenSearch 3.9의 보안 탭(사용자 목록·사용자 끄기 안내, API 키 30일 만들기 → 한 번 보이는 `os_` 토큰 → 무효화), 접속 폼의 "다른 노드로 넘어가기"(고급, 기본 켬). Elasticsearch 8.17에서 콘솔의 느린 `_update_by_query`를 정지 → "서버에서 계속 실행 중" 보고와 작업 취소, 클러스터 탭의 요청을 받는 노드, 앱 단위 오른쪽 패널(카드·JSON·표 선택이 전체 높이 패널을 채움, 패널에서 저장 → 다른 곳에서 바뀐 문서의 충돌 창 → 덮어쓰기로 저장, 매핑 탭에서 인덱스 정보, ⌘I로 접고 펴기, 분할선을 끌어 닫기), 보안 탭(사용자 만들기(비밀번호 가림) → 로그인 → 끄기·켜기 → 이름 입력 후 삭제, 역할 32개, 규칙 템플릿으로 역할 매핑, API 키 만들기·무효화). OpenSearch 2.19에서 같은 정지 보고·작업 취소, 표 선택·패널 저장 충돌(지금 값으로 다시 불러오기), 설정 탭의 인덱스 정보, 보안 탭(역할 50·역할 매핑 7, API 키 칸은 "3.7부터").
