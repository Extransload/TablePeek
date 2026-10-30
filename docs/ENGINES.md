# 엔진 구조: 엔진을 수십 개로 늘릴 수 있게

작성: 2026-10-28 · 상태: 설계 확정, 구현 전

TablePeek은 SQLite·PostgreSQL·MySQL/MariaDB·CockroachDB·SQL Server 다섯 엔진으로 시작했고, MongoDB를 시작으로 엔진을 수십 개 더 붙인다. 이 문서는 엔진 하나를 더할 때 **엔진 폴더 하나와 등록 한 줄**만 건드리면 되게 하는 구조와, 그 구조로 옮기면서 지켜야 할 것을 정한다.

## 1. 지금 구조의 문제

조사 결과(2026-10-28) 기준이다.

| 위치 | 지금 | 엔진 하나 추가 시 |
|---|---|---|
| 엔진 크레이트 | `enum Backend`에 대한 `match`가 18곳. Cockroach는 `Backend::Postgres` 안의 `kind` 문자열 분기 | 새 변형 + 18곳 수정 + `EngineError`·`Dialect`·`ActiveTarget` 변형 |
| 서버 크레이트 | 드라이버 문자열 `match` 16곳, 드라이버마다 40줄짜리 `connect_<driver>` 복사본 | 16곳 수정 + 복사본 하나 |
| 타입 | `ConnectRequest`·`SavedConnection`에 엔진마다 선택 필드(`postgres`, `mysql`, …) | 필드 추가 |
| 웹 | 엔진 이름을 키로 한 목록 약 8개(라벨·포트·아이콘·URL 스킴·폼), 엔진 이름 비교 약 150곳, 모르는 엔진은 조용히 `postgres`로 대체 | 목록 8개 + 폼 + 기능별 분기 |

합치면 엔진 하나에 **7개 파일 약 44곳(서버) + 웹 20여 개 파일**이다. 또 `meta.kind`에 모르는 값이 오면 PostgreSQL처럼 동작하는 등, 빠진 처리가 오류 없이 숨는다.

## 2. 원칙

1. **엔진은 자기를 설명한다.** 라벨·아이콘·접속 폼·할 수 있는 것(능력)·쿼리 언어를 엔진 정의 하나에 모은다. 화면과 서버는 엔진 이름을 비교하지 않고 이 정의를 읽는다.
2. **기능은 능력으로 켠다.** "PostgreSQL이면 보인다"가 아니라 "외래 키 능력이 있으면 보인다".
3. **엔진의 종류(패러다임)마다 작업 화면이 하나다.** SQL 엔진은 지금의 SQL 작업 화면을, 문서형 엔진(MongoDB 등)은 문서 작업 화면을 쓴다. 키-값·검색·그래프·시계열은 필요해질 때 같은 방식으로 더한다.
4. **SQL 방언 차이는 방언 객체가 맡는다.** 따옴표·리터럴·페이지 나누기·DDL 같은 SQL 엔진 사이의 차이는 엔진 정의에 딸린 방언 객체로 옮긴다. 기능 켜고 끄기와 섞지 않는다.
5. **모르는 엔진은 실패한다.** 대체 동작 없이 "지원하지 않는 엔진: x"로 멈춘다.
6. **저장된 데이터는 그대로 읽힌다.** `~/.tablepeek/store.json`, 키체인 계정 이름, `.tablepeek` 내보내기 파일의 기존 형식은 계속 읽고, 새로 쓸 때만 새 형식으로 쓴다.

## 3. 엔진 정의

### 3.1 공통 필드 (서버와 웹이 같은 값을 쓴다)

```jsonc
{
  "id": "mongodb",                  // 저장·API·키체인에 쓰는 이름. 한번 정하면 바꾸지 않는다
  "aliases": ["mongo"],             // URL 스킴·옛 이름
  "label": "MongoDB",
  "paradigm": "document",           // "sql" | "document" | 이후 "keyvalue" | "search" | …
  "family": "mongodb",              // 같은 방언을 쓰는 묶음 (cockroach → "postgres", mariadb → "mysql")
  "transport": "server",            // "server" | "file" | "memory"
  "default_port": 27017,
  "url_schemes": ["mongodb", "mongodb+srv"],
  "error_code_prefix": "mongo",     // 선택: 코드가 있는 DB 오류를 `{id}_error` 대신 `mongo_11000`처럼 원문 메시지와 함께 보낸다
  "capabilities": { … 3.2 … },
  "connection": { … 3.3 … }
}
```

### 3.2 능력

모든 JSON 키는 기존 API처럼 snake_case다.

화면은 아래 값만 보고 기능을 켠다. 엔진 정의가 기본값을 갖고, 서버가 접속 후 실제 값(버전·권한에 따라 달라지는 것)을 `meta.capabilities`로 덮어쓴다.

| 능력 | 값 | 켜지는 것 |
|---|---|---|
| `language` | `"sql"` \| `"mongo"` \| … | 편집기 언어, 문장 나누기, 안전 모드 판정, 자동완성 |
| `objects` | `["table","view",…]` \| `["collection","view"]` | 사이드바 구역 |
| `schema` | `"declared"` \| `"sampled"` | 컬럼 정보 출처(카탈로그 / 샘플 추정) |
| `edit_by_key` | bool | 셀·필드 편집, 행·문서 추가·삭제 |
| `transactions` | `"always"` \| `"replica_set"` \| `"none"` | 트랜잭션 표시·명령 |
| `foreign_keys` | bool | ER 다이어그램, JOIN 제안, 외래 키 이동 |
| `ddl` | bool | 구조 편집, 테이블 생성, DDL 탭 |
| `databases` | `"switch"` \| `"list"` \| `"none"` | DB 전환·생성·삭제 |
| `users` | bool | 사용자 관리 |
| `explain` | `"pg-json"` \| `"mysql-json"` \| `"sqlite"` \| `"mongo"` \| `"clickhouse"` \| `"oracle"`(DBMS_XPLAN 텍스트) \| … \| `null` | 실행 계획 화면 |
| `exact_count` | bool | 행 수를 정확히 셀지 추정할지 |
| `dump` | `"sql"` \| `"ejson"` \| `null` | 백업·복원 형식 |
| `import_formats` / `export_formats` | 목록 | 가져오기·내보내기 형식 |
| `sessions` | `{ "kill": bool }` | 서버 정보의 세션 목록·종료 |
| `validation` | bool | 문서 검증 규칙 탭 |
| `aggregation` | bool | 집계 편집기 |
| `indexes` | `{ "create": bool, "drop": bool }` | 인덱스 탭 |
| `cursor_paging` | bool | 데이터 탭·내보내기·백업이 OFFSET 대신 서버의 페이지 토큰(Cassandra의 paging state)으로 다음 페이지를 읽는다. 데이터 탭은 문장마다 행 위치별 토큰을 모아 두고(`DataTab.pageMarks`), 토큰이 없는 먼 페이지는 서버가 앞의 행을 건너뛰어 찾는다(`/api/sql/skip`) |
| `count_steps` | bool | 정확한 COUNT를 서버가 나눈 단계로 센다(`/api/sql/count`, Cassandra의 토큰 범위). 데이터 탭 바닥줄이 진행률과 중지를 보인다 |
| `cancel_ends_session` | bool | 실행 중인 문장의 취소가 세션을 끝내 열린 트랜잭션이 롤백된다(SQL Server의 KILL). 접속마다 정해진다: Oracle은 out-of-band break도 `ALTER SYSTEM CANCEL SQL`(권한)도 못 쓰는 세션만 참이고, 나머지는 문장만 멈추고 트랜잭션을 살린다. 웹은 참일 때 트랜잭션이 열린 채 정지를 누르면 먼저 묻는다 |
| `binary_cells` | bool | 바이너리 셀(Oracle BLOB·RAW, PostgreSQL bytea, CockroachDB BYTES, MySQL·MariaDB BINARY·VARBINARY·BLOB 계열, SQL Server binary·varbinary·image, SQLite blob)을 그리드가 보이는 16KiB를 넘어 통째로 내려받고, 텍스트·16진수·파일로 바꾼다(`/api/sql/cell`, 양쪽 모두 조각으로 흘림). 셀 메뉴의 "전체 값 내려받기"·"값 바꾸기…". 켠 엔진: oracle, postgres, cockroach, mysql, mssql, sqlite |

능력 이름은 더하기만 하고, 의미를 바꿀 때는 새 이름을 만든다.

### 3.3 접속 폼

엔진마다 폼 컴포넌트를 만들지 않고, 필드 목록으로 폼을 그린다.

```jsonc
"connection": {
  "fields": [
    { "key": "uri",      "type": "uri",      "label": "연결 문자열", "schemes": ["mongodb","mongodb+srv"], "fills_others": true },
    { "key": "host",     "type": "host",     "required": true },
    { "key": "port",     "type": "port",     "default": 27017 },
    { "key": "auth",     "type": "select",   "label": "인증 방식", "default": "none",
      "options": [{ "value": "none", "label": "없음" }, { "value": "password", "label": "사용자·비밀번호" },
                  { "value": "x509", "label": "X.509", "sets": { "tls": true } }] },
    { "key": "user",     "type": "text",     "label": "사용자", "visible_when": { "auth": ["password"] } },
    { "key": "password", "type": "secret",   "label": "비밀번호", "visible_when": { "auth": ["password"] } },
    { "key": "auth_source", "type": "text",   "label": "인증 DB", "default": "admin", "visible_when": { "auth": ["password"] } },
    { "key": "tls",      "type": "toggle",   "default": false },
    { "key": "tls_cert_key_file", "type": "file", "visible_when": [{ "tls": [true] }, { "auth": ["x509"] }] }
  ],
  "tunnels": ["ssh", "http"],         // 비우면 터널 없음. 호스트가 여럿인 연결(레플리카셋·SRV)은 엔진이 막는다
  "summary": "{host} : {database}",                 // Home 목록의 주소 줄
  "detail": "{user}@{host}:{port}/{database}"       // 주소 줄에 마우스를 올렸을 때 보이는 자세한 주소. 이름 없이 연 연결의 이름으로도 쓴다
}
```

- 필드 종류: `text`, `host`, `port`, `secret`, `file`, `path`, `select`, `toggle`, `uri`, `number`, `textarea`.
- `visible_when`: 객체 하나면 그 안의 조건이 모두 맞을 때, 객체 목록이면 그중 하나라도 맞을 때 보인다. 보이지 않는 필드는 서버로 보내지 않는다.
- `select` 선택지의 `sets`: 그 선택지를 고르면 함께 바뀌는 다른 필드 값(X.509를 고르면 TLS가 켜짐). 연결 문자열을 붙여 넣을 때도 적용되지만, 문자열이 직접 말한 값이 이긴다.
- `secret`은 디스크에 쓰지 않고 키체인에 둔다. 계정 이름은 `conn:{저장 id}:{엔진 id}`(첫 번째 비밀), 그 밖의 비밀은 `conn:{저장 id}:{엔진 id}:{필드 key}`.
- 첫 번째 비밀(비밀번호)은 그 필드가 보일 때만 묻는다. 서버도 엔진의 `needs_password(config)`가 참일 때만 저장된 비밀번호를 읽고, 없으면 묻게 한다.
- 검증은 서버가 최종 판단하고, 폼은 `required`·`type`만 미리 검사한다.

### 3.4 웹에만 있는 것

```ts
// web/src/engines/<id>/index.ts
export const engine: EngineDescriptor = {
  ...shared,                         // 3.1 (서버와 같은 JSON에서 생성)
  icon: { color: "#00ed64", viewBox: "0 0 24 24", paths: [...] },
  workbench: "document",             // paradigm별 작업 화면
  sql?: SqlDialect,                  // paradigm === "sql"일 때: 따옴표, 리터럴, 페이지, DDL, 타입 목록, 실행 계획 파서
  language?: LanguageSupport,        // 편집기 언어, 자동완성 단어·함수, 문장 나누기, 안전 모드 판정
  errorHelp?: { detect: RegExp, hints, rules?: ErrorRule[] },  // 오류 도움말: 이 엔진의 오류 알아보기, 공통 설명에 덧붙일 말, 엔진 고유 오류 규칙(공통 규칙보다 먼저, docs/ERRORS.md)
};
```

`web/src/engines/index.ts`가 모든 엔진을 모아 `engineById(id)`·`engineForUrl(url)`·`engines()`를 내보낸다. 이것이 지금의 `Driver` 유니언과 `DEFAULT_PORT`·`DRIVER_LABEL`·`CHOICES`·`GLYPHS`·`URL_DRIVERS`·`savedTarget`·`inputFromSaved` 등을 대신한다.

## 4. 서버

### 4.1 드라이버 트레이트

`crates/tablepeek-engine/src/driver.rs`:

```rust
#[async_trait]
pub trait Driver: Send + Sync {
    fn id(&self) -> &'static str;                  // "mongodb"
    fn capabilities(&self) -> Capabilities;        // 접속 후 실제 값
    async fn meta(&self, refresh: bool) -> Result<EngineMeta, EngineError>;
    async fn cancel(&self) -> Result<CancelOutcome, EngineError>;
    async fn server_info(&self) -> Result<ServerInfo, EngineError>;
    async fn close(&self);

    // 패러다임별 기능 묶음. 해당하지 않으면 None.
    fn sql(&self) -> Option<&dyn SqlDriver> { None }
    fn document(&self) -> Option<&dyn DocumentDriver> { None }
    fn search(&self) -> Option<&dyn SearchDriver> { None }
}

#[async_trait]
pub trait SqlDriver: Send + Sync {
    async fn schema(&self, system: bool) -> Result<Vec<TableSchema>, EngineError>;
    async fn relations(&self, system: bool) -> Result<Vec<Relation>, EngineError>;
    async fn query(&self, sql: &str, opts: QueryOpts) -> Result<QueryData, EngineError>;   // Arrow
    async fn edit(&self, target: &EditTarget, value: &ValueExpr) -> Result<(), EngineError>;
    async fn edit_seen(&self, target: &EditTarget, seen: &[PkValue]) -> Result<u64, EngineError>; // 기본: edit. seen = 그리드가 마지막으로 안 그 행의 모든 컬럼 값
    async fn insert(&self, …); async fn delete(&self, …);
    async fn delete_row_seen(&self, table: &str, pk: &[PkValue], seen: &[PkValue]) -> Result<u64, EngineError>; // 기본: delete_row
    async fn table_detail(&self, name: &str) -> Result<TableDetail, EngineError>;
    async fn tx(&self, op: TxOp) -> Result<(), EngineError>;
    // objects, definition, databases, count …
    async fn kill_session(&self, id: &str) -> Result<(), EngineError>;   // 세션 목록이 준 id 그대로: 숫자(numeric_session_id), ClickHouse의 query_id, Oracle의 "sid,serial#"
    fn set_query_timeout(&self, secs: u64) {}      // 설정의 쿼리 시간 제한. 문장마다 제한을 보내는 엔진만 쓴다(ClickHouse max_execution_time)
    async fn export_native(&self, sql: &str, export: &NativeExport) -> Result<FileStream, EngineError>; // 기본 Unsupported. DB가 직접 쓰는 CSV·JSON 파일 (ClickHouse)
    async fn read_cell(&self, cell: &CellRef) -> Result<FileStream, EngineError>;  // 기본 Unsupported. 바이너리 셀 하나의 값 전부(binary_cells), 페이지의 세션에서
    async fn write_cell(&self, cell: &CellRef, data: FileStream) -> Result<u64, EngineError>; // 기본 Unsupported. 받는 대로 조각으로 써서 셀을 바꾼다. 셀 편집처럼 열린 트랜잭션 안, 아니면 커밋. 중간 실패는 되돌린다
    fn dialect(&self) -> Dialect;                  // SQL 로그·문장 해석용
}

#[async_trait]
pub trait DocumentDriver: Send + Sync {
    async fn collections(&self, db: &str) -> Result<Vec<CollectionInfo>, EngineError>;
    async fn find(&self, req: FindRequest) -> Result<DocBatch, EngineError>;          // EJSON
    async fn aggregate(&self, req: AggregateRequest) -> Result<DocBatch, EngineError>;
    async fn count(&self, req: CountRequest) -> Result<CountResult, EngineError>;       // 정확/추정
    async fn insert(&self, …); async fn replace(&self, …);
    async fn update(&self, req: GuardedUpdate) -> Result<UpdateOutcome, EngineError>;  // 충돌 감지
    async fn delete(&self, …);
    async fn indexes(&self, …); async fn create_index(&self, …); async fn drop_index(&self, …);
    async fn explain(&self, req: ExplainRequest) -> Result<serde_json::Value, EngineError>;
    async fn sample_schema(&self, req: SampleRequest) -> Result<FieldStats, EngineError>;
    // validation, stats, databases …
}

// crates/tablepeek-engine/src/search.rs
#[async_trait]
pub trait SearchDriver: Send + Sync {
    fn flavor(&self) -> &'static str;                // 접속한 서버가 말한 종류 ("elasticsearch" | "opensearch")
    fn classify(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Classified, EngineError>; // 콘솔 요청: read·write·danger
    async fn cluster(&self) -> Result<Value, EngineError>;          // + nodes, perf, tasks, cancel_task, hot_threads, shards
    async fn indices(&self, hidden: bool) -> Result<Vec<Value>, EngineError>; // + aliases, data_streams, mapping, settings, definition
    async fn search(&self, req: &SearchRequest) -> Result<Value, EngineError>; // + count, open_pit/close_pit, validate, explain, analyze
    async fn get_doc(&self, req: &DocRef) -> Result<Value, EngineError>;       // + index_doc/update_doc/delete_doc (if_seq_no·if_primary_term)
    async fn delete_by_query(&self, req: &ByQueryRequest) -> Result<Value, EngineError>; // + update_by_query, 인덱스 만들기·지우기·열기·닫기, reindex, 별칭, 매핑·설정
    async fn sql(&self, req: &SqlRequest) -> Result<SqlResult, EngineError>;   // + sql_close, sql_translate
    async fn console(&self, req: &ConsoleRequest, class: &Classified) -> Result<ConsoleReply, EngineError>;
    async fn bulk(&self, req: &BulkRequest, body: String) -> Result<Value, EngineError>;
    async fn export(&self, req: &SearchExportRequest) -> Result<DocStream, EngineError>;
}
```

- 기존 다섯 엔진은 지금 함수(`postgres::schema` 등)를 그대로 두고, 트레이트 구현이 그 함수를 부른다. 동작은 바뀌지 않는다.
- Cockroach는 PostgreSQL 드라이버를 쓰되 `id()`·능력·방언 차이를 드라이버 안에 갖는다.
- `Engine`은 `Arc<dyn Driver>` 하나를 들고, 지금의 `enum Backend` `match` 18곳은 트레이트 호출로 바뀐다.
- 오류는 `EngineError::Driver { engine: &'static str, code: Option<String>, message: String, interrupted: bool }` 하나로 모은다. `interrupted`는 취소로 멈춘 문장인지를 드라이버가 만들 때 정한다. 기존 코드 이름(`postgres_error` 등)은 서버가 `engine`에서 만든다.
- 검색 엔진(`paradigm: "search"`)은 `search()`를 낸다. 값은 서버가 준 JSON 그대로 오가고, 요청·응답 모양은 `/api/search/*` 본문이다(`docs/engines/elasticsearch.md`). 확인이 필요한 규칙(`check_confirmed`·`check_single_index`·`check_alias_actions`)은 `search.rs`에 있어 서버가 보내기 전에 부른다. 검색 엔진의 세션은 실행 중인 작업(tasks)이라 `Engine::kill_session`은 `cancel_task`로 간다.
- SQL 엔진의 객체 목록(`DbObjects`)은 `views`·`functions`·`procedures`·`triggers`·`sequences`에 더해, 비어 있으면 빠지는 `materialized_views`·`dictionaries`(ClickHouse)·`types`(Cassandra UDT, Oracle 객체 타입)·`aggregates`(Cassandra)·`synonyms`·`packages`(Oracle)와 엔진이 더한 종류를 갖는다. 웹의 `DefinitionKind`가 같은 종류를 갖고, `opensData(kind)`인 것(뷰·구체화된 뷰·딕셔너리)은 데이터 탭으로 열린다. `/api/definition`은 이 종류들을 받는다.
- 방언의 `lexing`에는 Oracle을 위한 `slashBlocks`(PL/SQL 단위·익명 블록은 `/`만 있는 줄에서 끝나고 `END;`를 지닌다)와 `qQuotes`(`q'[…]'`)가 있다. 서버의 `Dialect::Oracle`은 `:N` 바인드와 q-문자열을 읽는다.
- 페이지 토큰(`capabilities.cursor_paging`): 드라이버가 `QueryData.next_page`(남은 행이 시작되는 곳, 불투명한 문자열)를 채우고 `SqlDriver::query_from(sql, max_rows, page)`로 같은 문장을 이어 읽는다(기본 구현은 `Unsupported`). WebSocket `query`가 `page`를 받고 `meta`가 `next_page`를 보낸다. 웹의 `SqlDialect`에는 OFFSET이 없는 엔진을 위한 `keyOrder`·`filterOps`·`filterLogics`·`containsSql`·`allowFilteringClause`·`consistencyLevels`·`noTableRename`·`noTableCopy`, 컬럼에 NOT NULL·기본값이 없고 있는 컬럼의 타입·키 소속이 고정인 엔진을 위한 `fixedColumns`(구조 그리드가 그 열을 빼고 칸을 잠근다), 저장된 행의 키를 바꿀 수 없는 엔진을 위한 `fixedKeys`(그리드가 키 칸을 잠그고 마우스를 올리면 이유를 보인다, `GridEditHandlers.lockedTitle`), 문장 나누기(`Lexing`)에는 `slashComments`·`batchBlocks`가 있다(`docs/engines/cassandra.md`).
- 먼 페이지와 나눠 세기: `SqlDriver::skip_rows(sql, SkipRequest { page, offset, rows, mark_every }, budget)`는 행을 보내지 않고 건너뛰어 멈춘 자리의 토큰과 `mark_every` 배수의 토큰(`marks`)을 돌려주고, `SqlDriver::count_step(sql, cursor, budget)`은 COUNT의 한 단계(`rows`, 다음 `cursor`, 진행률 `done`)를 돌려준다. 둘 다 기본은 `Unsupported`이고, 한 번에 `budget`(서버 1.5초)만 일해 웹이 단계마다 진행을 보이고 단계 사이에서 멈춘다. 서버는 `Holder::Foreground`로 돌려 정지(WebSocket `cancel`)가 그 단계에 닿는다.
- 더하는 편집: `SqlDriver::edit_add(target)`(기본 `Unsupported`)은 `target.value`만큼 컬럼에 원자적으로 더한다(CQL counter). WebSocket `edit`의 `add: true`가 이것을 부르고, 결과 값은 행을 다시 읽어 안다. 웹은 방언의 `addsTo(declType)`가 참인 컬럼에 셀 메뉴 "더할 값…"을 보이고(`WindowedRowSource.stageAdd`, `PendingCell.add`), 그 컬럼에 직접 쓴 값은 드라이버가 `edit_seen`의 보인 값과의 차이로 쓴다.
- 바이너리 셀(`capabilities.binary_cells`, `SqlDriver::read_cell`·`write_cell`): 공통 부분은 `crates/tablepeek-engine/src/cells.rs`(읽기 스트림 `read_stream`, 올린 바이트를 원하는 크기로 자르는 `Chunks`, 오류 문구). 행은 셀 편집처럼 지금의 기본 키로 찾고(`check_key`), 쓰기는 열린 트랜잭션 안에서는 세이브포인트 뒤에서, 밖에서는 자기 트랜잭션으로 돌아 끝에 커밋하며, 업로드가 끊기거나 서버가 거부하면 되돌려 이전 값이 남는다. 읽기는 트랜잭션 밖이면 자기 읽기 트랜잭션(한 스냅숏) 안에서 조각을 읽는다. History에는 값 대신 `/* N bytes */`가 남는다. 엔진별:
  - PostgreSQL(`postgres/cells.rs`): 읽기는 `generate_series` 위의 `substring` 한 문장이라 한 스냅숏의 행이 도착하는 대로 1MiB씩 흐른다. 쓰기는 첫 조각을 `SET c = $1`, 나머지를 `c || $1`로 붙이며, 붙이는 조각은 지금까지 쓴 크기만큼(1MiB~16MiB) 커져 다시 쓰는 양이 값 크기의 몇 배에 머문다. large object는 다루지 않는다.
  - CockroachDB: 읽기는 PostgreSQL과 같다. 쓰기는 값 전체를 한 문장으로 보낸다. 트랜잭션 안에서 같은 행을 거듭 고치면 Raft 명령이 이전 값들을 함께 실어 붙이기가 한계를 늘려 주지 못하기 때문이다. 한계는 `sql.conn.max_read_buffer_message_size`(기본 16MiB)·`kv.raft.command.max_size`·`sql.guardrails.max_row_size_err` 중 가장 작은 값에서 1MiB를 뺀 것(클러스터가 보여 주는 설정, 못 읽으면 기본값)이고, 넘는 업로드는 서버에 보내기 전에 "값이 너무 큽니다: N바이트까지만 쓸 수 있습니다 (설정 이름)"로 멈춘다.
  - MySQL·MariaDB(`mysql/cells.rs`): 읽기는 `SUBSTRING` 조각(값이 크면 조각도 커져 최대 16MiB, InnoDB가 SUBSTRING마다 BLOB 전체를 읽기 때문), 트랜잭션 밖이면 `START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY` 안에서. 쓰기는 `SET c = ?` 뒤 `CONCAT(c, ?)`로 붙이고 한 문장은 `max_allowed_packet`을 넘지 않는다. 서버는 `max_allowed_packet`보다 긴 CONCAT 결과를 만들지 않으므로 값 전체도 그만큼(컬럼 타입이 더 작으면 그 크기, `CHARACTER_OCTET_LENGTH`)이 한계이고, 넘으면 그 한계와 이유(`max_allowed_packet` 또는 컬럼 타입)를 알린다. 되돌리기는 트랜잭션을 지키는 테이블(InnoDB)에서만 된다.
  - SQL Server(`mssql/cells.rs`): 읽기는 `SUBSTRING`과 `DATALENGTH`를 한 번에 묻는 1MiB 조각, 트랜잭션 밖이면 `WITH (REPEATABLEREAD)`로 자기 트랜잭션 안에서. 쓰기는 varbinary(max)가 `.WRITE(@P1, NULL, 0)` 붙이기, image가 `CAST(CAST(c AS VARBINARY(MAX)) + @P1 AS IMAGE)` 다시 쓰기, binary(n)·varbinary(n)은 n바이트까지 한 값으로(넘으면 서버에 보내기 전에 멈춤). 세이브포인트는 `SAVE TRANSACTION`, 실패 뒤 `@@TRANCOUNT`로 서버가 트랜잭션을 롤백했는지 살핀다.
  - SQLite(`src/sqlite_cells.rs`): rowid가 있는 테이블은 incremental blob I/O(rusqlite `blob` 기능)로 양쪽 모두 1MiB씩. blob은 크기를 먼저 정해야 해서(`zeroblob(N)`) 업로드를 임시 파일에 다 받은 뒤 쓴다(끊긴 업로드는 DB에 닿지 않는다). WITHOUT ROWID 테이블은 `substr()`로 읽고 한 값으로 쓴다. BLOB으로 선언된 컬럼(값이 blob이면 다른 컬럼도)만 받는다.
  - MongoDB는 하지 않는다: 문서 화면이 BinData를 canonical EJSON(`$binary` base64)으로 통째로 주고받아 이미 값 전부를 보이고 고친다(문서 한도 16MiB).
- `transactions: "none"`이면 웹은 변경 적용·가져오기·복원을 트랜잭션 없이 돌린다: 적용은 BEGIN/COMMIT 없이 하나씩 보내고, 가져오기는 실패한 행 앞까지를 남긴 채 몇 행이 저장됐는지 알리며(`ImportFailure.kept`), "트랜잭션으로 실행"은 보이지 않는다.
- **보상 되돌리기**(`transactions: "none"`, `web/src/store.ts`의 `applyPending`·`undoApplied`): 적용 중 한 문장이 실패하면 그 앞에 들어간 변경을 새것부터 거꾸로 되돌린다. 셀은 원래 값으로 다시 쓰고(카운터의 더하기는 같은 양을 뺀다), 지운 행은 읽어 둔 모든 컬럼 값(`rowIdentity` 컬럼은 빼고)으로 다시 넣고, 추가한 행은 넣은 키·값으로 지운다. 결과는 오류의 `undo`(`AppError.undo = { undone, left: [{ change, reason }] }`)로 실려, 데이터 탭의 오류 띠(`ErrorNotice`)가 제목 아래 짧은 목록으로 되돌린 변경("3행 note", "5행 삭제", "추가한 7행")과 되돌리지 못한 변경·그 이유(키를 DB가 정한 행, 다른 곳에서 바뀐 행)를 보인다(docs/ERRORS.md §3). 스테이징한 변경은 그대로 남아 고쳐서 다시 적용할 수 있다. 이를 위해 트랜잭션이 없는 엔진의 WebSocket `edit`·`delete_row`는 `seen`(`[{column, value}]`: 그 행의 모든 컬럼을 그리드가 마지막으로 안 값 — 읽은 값에 이 적용이 이미 쓴 값을 반영, DEFAULT·NOW·더하기로 DB만 아는 컬럼은 뺌)을 함께 보내고, 서버는 `SqlDriver::edit_seen`·`delete_row_seen`(기본 구현은 `edit`·`delete_row`)으로 넘긴다. 드라이버는 이 값으로 행을 다시 찾거나(ClickHouse: 병합으로 파트가 바뀐 행, 클러스터의 행) 바뀌기 전 값을 안다(Cassandra 카운터). ClickHouse·Cassandra·ScyllaDB가 쓴다.
- `TableDetail.properties`(`[{ name, value }]`, 비어 있으면 빠짐)는 컬럼·인덱스로 말할 수 없는 저장 방식(ClickHouse의 엔진·ORDER BY·PARTITION BY·TTL·SETTINGS)이다. 구조 화면이 "테이블 속성"으로 보인다.
- WebSocket `query`는 `timeout_secs`(설정의 쿼리 시간 제한, 0은 없음)를 함께 보내고, 서버가 `Engine::set_query_timeout`으로 넘긴다.

### 4.2 드라이버 등록

`crates/tablepeek-engine/src/registry.rs`:

```rust
pub trait DriverFactory: Send + Sync {
    fn descriptor(&self) -> &'static EngineDescriptor;     // 3.1~3.3, JSON으로 웹에 그대로 나감
    fn validate(&self, config: &ConnConfig) -> Result<(), ConfigProblem>;
    fn upgrade_config(&self, config: &mut ConnConfig) {}      // 예전 버전이 저장한 프로필에 없는 설정을 그 버전이 읽던 뜻대로 채움
    fn needs_password(&self, config: &ConnConfig) -> bool;    // 기본: 비밀 필드가 있으면 참
    async fn connect(&self, config: &ConnConfig, net: &NetRoute) -> Result<Arc<dyn Driver>, EngineError>;
}

pub fn factories() -> &'static [&'static dyn DriverFactory] { &[&SQLITE, &POSTGRES, &COCKROACH, &MYSQL, &MSSQL, &MONGODB] }
pub fn factory(id: &str) -> Option<&'static dyn DriverFactory>;   // 별칭 포함
```

- 엔진 추가 = `crates/tablepeek-engine/src/engines/<id>/` 폴더 + 이 목록에 한 줄.
- `GET /api/engines`가 모든 엔진 정의를 내보내고, 웹은 이것을 화면의 엔진 정의와 합친다. 서버와 웹의 공통 필드는 서버 쪽 JSON 하나가 원본이다(웹 빌드 때 같은 파일을 읽는다).
- `NetRoute`는 SSH·HTTP 터널을 연 뒤의 실제 접속 주소를 넘긴다. 터널을 여는 코드는 서버에 하나만 있다(지금의 `connect_<driver>` 복사본 다섯 개가 없어진다). 서버 여럿과 이야기하는 엔진은 `tunnel_target`에서 `TunnelTarget::Members`를 돌려 터널 자체(`NetRoute::Tunnel`, `Forwarder`)를 받는다: MongoDB는 그 앞에 SOCKS5 서버를 두고, Cassandra·ScyllaDB는 노드마다 로컬 끝을 열어 드라이버의 `AddressTranslator`로 잇고, Oracle은 연결 기술자의 주소가 여럿이면 주소마다 로컬 끝을 열어 기술자의 HOST·PORT를 바꾸고(하나면 `Address`), Elasticsearch·OpenSearch는 `sniff`가 켜져 있으면 `_nodes/http`가 알린 노드마다 로컬 끝을 열어 노드마다 HTTP 클라이언트를 둔다(터널이 노드에 닿지 못하면 로컬 끝이 연결 실패로 답해 다음 노드로 넘어간다).

### 4.3 접속 설정의 형식

```jsonc
// 새 형식 (쓰기)
{ "driver": "postgres",
  "config": { "host": "…", "port": 5432, "user": "…", "database": "…", "ssl_mode": "prefer" },
  "ssh": { … }, "http_tunnel": { … } }

// 옛 형식 (계속 읽음)
{ "driver": "postgres", "postgres": { "host": "…", "port": 5432, "user": "…", "database": "…", "ssl_mode": "prefer" } }
```

- `store.json`을 읽을 때 옛 형식이면 새 형식으로 바꿔 메모리에 올리고, 다음 저장 때 새 형식으로 쓴다. 옛 형식을 읽는 코드는 지우지 않는다(내보내기 파일·이전 버전과의 왕복 때문). 엔진이 새 설정을 더하면 프로필을 읽을 때와 저장할 때 `upgrade_config`가 그 값을 채운다(MongoDB의 `auth`).
- **연결 하나가 깨져도 전체가 비지 않게** 한다. 지금은 하나라도 해석에 실패하면 모든 연결이 빈 목록으로 읽히고 다음 저장 때 덮어써진다. 연결을 하나씩 해석하고, 실패한 것은 원문 그대로 보존해 다시 쓴다.
- 키체인 계정 이름은 지금(`conn:{id}:{driver}`, `ssh`, `http`)을 유지한다.
- `.tablepeek` 내보내기 파일은 `version: 1`을 유지하고 `connect`에 새 형식을 쓴다. 가져오기는 두 형식을 모두 받는다.
### 4.3.1 엔진별 `config` 키 (확정)

| 엔진 | 키 |
|---|---|
| `sqlite` | `path` |
| `postgres`, `cockroach`, `mysql` | `host`, `port`, `user`, `password`(비밀), `database`, `ssl_mode`(`disable`·`prefer`·`require`), `ssl_root_cert`, `ssl_client_cert`, `ssl_client_key` |
| `mssql` | `host`, `port`, `user`, `password`(비밀), `database`, `encrypt`(bool) |
| `mongodb` | `uri`, `host`, `port`, `auth`(`none`·`password`·`x509`), `user`, `password`(비밀), `auth_source`, `auth_mechanism`(SCRAM 방식), `database`, `tls`(bool), `tls_ca_file`, `tls_cert_key_file`, `direct_connection`(bool), `replica_set`, `read_preference` |
| `elasticsearch`, `opensearch` | `url`, `cloud_id`(Elasticsearch만), `host`, `port`, `tls`(bool), `path_prefix`, `auth`(`none`·`basic`·`api_key`·`bearer`), `user`, `password`(비밀: 비밀번호·API 키·토큰), `tls_ca_file`, `tls_fingerprint`, `tls_skip_verify`(bool), `tls_client_cert`, `tls_client_key` |
| `clickhouse` | `host`, `port`(8123, HTTPS 8443), `user`(기본 `default`), `password`(비밀), `database`, `tls`(bool, HTTPS), `tls_ca_file`, `tls_skip_verify`(bool) |
| `oracle` | `connect_mode`(`service`·`sid`·`descriptor`), `host`, `port`(1521), `database`(서비스 이름 또는 SID), `connect_string`(Easy Connect·`(DESCRIPTION=…)`·TNS 별칭), `user`, `password`(비밀), `privilege`(빈 값·`sysdba`·`sysoper`), `tls`(bool, TCPS), `wallet_file`(ewallet.pem), `wallet_password`(비밀), `tnsnames_file` |

옛 형식의 엔진별 객체(`postgres: {…}` 등)는 같은 키 이름을 쓰므로, 옮길 때는 객체를 `config`로 옮기기만 하면 된다. 비밀 필드는 저장·응답에서 빠지고, 저장된 비밀이 있으면 응답에 `has_password: true`가 붙는다.


### 4.4 API

- 공통: `/api/engines`, `/api/connect`, `/api/connections/*`, `/api/meta`(+`capabilities`), `/api/server`, `/api/conns`.
- SQL: 지금의 `/api/schema`, `/api/table`, `/api/relations`, `/api/objects`, WebSocket `query`·`edit`·`tx` 등 그대로. `POST /api/sql/export`는 읽기 문장 하나의 결과 전부를 DB가 직접 쓰는 파일(`format`: `csv`·`json`, CSV 옵션 `header`·`delimiter`·`crlf`·`null_word`·`nested_json`(배열·맵·튜플을 그리드처럼 JSON 글자로))로 흘려보낸다. 중간에 실패하면 본문이 `\n__tablepeek_error__ {code, message}` 줄로 끝난다. `POST /api/sql/skip`(`{sql, page?, offset, rows, mark_every}` → `{page, skipped, marks}`)과 `POST /api/sql/count`(`{sql, cursor?}` → `{rows, cursor, done}`)는 `cursor_paging`·`count_steps` 엔진의 먼 페이지 이동과 나눠 세기 한 단계다.
- 바이너리 셀(`capabilities.binary_cells`): `POST /api/sql/cell`(본문 `CellRef` = `{table, pk: [{column, value}], column}`)은 값 전부를 `application/octet-stream`으로 흘려보내고, 중간에 실패하면 응답을 끊는다(일부를 전부로 받지 않게). `POST /api/sql/cell/write?conn=…&cell=<CellRef JSON>`은 본문(새 값의 바이트, 크기 제한 없음)을 받는 대로 엔진에 넘겨 `{rows}`를 돌려준다.
- 문서형: `/api/doc/*` (MongoDB 사양 문서 참고). 엔진이 `document()`를 갖지 않으면 `unsupported_capability`(400).
- 검색 엔진: `/api/search/*` (`docs/engines/elasticsearch.md` §4). 엔진이 `search()`를 갖지 않으면 `unsupported_capability`(400). 경로는 `crates/tablepeek-server/src/search.rs`에 모여 있다.

## 5. 웹

- `web/src/engines/` 아래 엔진마다 폴더. 지금의 SQL 헬퍼(`ddl.ts`, `dataQuery.ts`, `export.ts`, `importSql.ts`, `sqlTools.ts`, `sqlSplit.ts`, `sqlComplete.ts`, `templates.ts`, `grid/columns.ts`, `sessionSettings.ts`, `explainPlan.ts`)에 흩어진 엔진 분기는 각 엔진의 `sql` 방언 객체로 모은다. 헬퍼는 `kind` 문자열 대신 방언 객체를 받는다.
- 기능 켜고 끄기(`serverConn`, 사용자 관리, 실행 계획, ER 다이어그램, DB 전환 등)는 `capabilities`를 본다.
- `ConnectModal`은 엔진 정의의 `connection.fields`로 폼을 그린다. 지금 폼의 모양(카드, SSL 칸, 터널 칸)은 필드 종류별 그리기로 유지한다.
- 작업 화면은 `workbench`로 고른다: `"sql"`은 지금의 화면, `"document"`는 MongoDB 사양 문서의 화면.
- 오른쪽 상세 패널은 어느 작업 화면에서나 앱의 열 하나다(작업 화면 옆 전체 높이, 분할선, 너비 기억 `tablepeek.detail-width`, 끌어서 닫기, ⌘I·탭 줄 버튼, 연결마다 열림/닫힘). SQL 작업 화면은 `RowDetailPanel`을 그 자리에 두고, 다른 작업 화면은 앱이 `DetailSlotContext`(`engines/mongodb/ui/DocDetailPanel.tsx`)로 넘기는 열 요소에 `DocDetailPanel`로 고른 것(문서·행·항목, 없으면 컬렉션·인덱스 정보)을 그린다. 이 열을 채우는 탭 종류는 `App.tsx`의 `DOC_PANEL_TABS`이고, 나머지 탭은 "보여 줄 상세 정보가 없습니다"를 보인다. 새 작업 화면도 자기 패널을 따로 만들지 않고 이 열을 쓴다.
- SQL 방언 객체의 선택 항목 중 엔진을 늘리며 더한 것: `columnDef`(널 허용을 타입에 쓰는 엔진), `createIndex`, `tableSuffix`(옵션 없이 CREATE TABLE 끝에 붙는 것), `dropKeywords`, `cellKind`(그리드가 모르는 타입 읽기), `backslashLike`(ESCAPE 없는 LIKE), `insertRows`·`importChunkRows`(가져오기를 엔진 자신의 데이터 형식으로, 더 큰 묶음으로), `upsertRow`(ON CONFLICT·ON DUPLICATE KEY가 없는 엔진의 가져오기 업서트를 행마다 한 문장으로: Oracle의 MERGE), `nativeExport`(`/api/sql/export`로 내보내기), `snippets`(편집기 스니펫), `rowIdentity`(키가 고유하지 않은 엔진에서 행을 가르는 가상 컬럼: 키가 있는 테이블의 데이터 탭이 컬럼 뒤에 읽고, 드라이버의 `detect_source`가 결과에 있으면 키 뒤에 붙여 그 값으로도 행을 찾는다. 내보내기는 뺀다. 사이드바가 아직 모르는 테이블은 데이터 탭이 첫 페이지 전에 `/api/table`로 키를 먼저 읽는다), `clusters`(`listSql`·`onCluster`: 앱이 쓰는 구조 변경을 클러스터의 모든 서버에서 실행. 테이블 생성 창과 구조 탭은 `components/ClusterPicker.tsx`로 문장마다 고르고, 이름 변경·복제·비우기·삭제는 연결 설정 `cluster`를 따른다), `propertyAction`(테이블 속성 한 줄에 붙는 원클릭 변경: 단추·확인 창의 제목과 설명·문장. 구조 탭의 ON CLUSTER 선택을 따른다. ClickHouse의 "경량 UPDATE 켜기").
- `meta.kind`·`driver`가 등록되지 않은 값이면 "지원하지 않는 엔진"을 보여주고, `postgres` 대체값은 모두 없앤다.

## 6. 새 엔진을 붙이는 절차

1. `crates/tablepeek-engine/src/engines/<id>/`에 `DriverFactory`와 `Driver`(+해당 패러다임 트레이트) 구현, 엔진 정의 JSON.
2. `registry.rs` 목록에 한 줄.
3. `web/src/engines/<id>/`에 아이콘과 (SQL이면) 방언 객체, (새 언어면) 편집기 언어. `engines/index.ts`에 한 줄.
4. `testdb/compose.yml`에 테스트 서버, 엔진 테스트(`TABLEPEEK_TEST_<ID>=1`로 켜는 방식).
5. 새 패러다임이면 그 작업 화면을 만든다. 같은 패러다임이면 화면 코드는 건드리지 않는다.

## 7. 옮기는 순서와 확인

1. 서버: 트레이트·등록·새 접속 형식(옛 형식 읽기 포함)·`/api/engines`·`meta.capabilities`로 옮긴다. 기존 다섯 엔진은 트레이트 구현이 기존 함수를 부르는 방식.
2. 웹: 엔진 정의 등록, 방언 객체로 분기 이전, 능력으로 기능 켜고 끄기, 필드 목록으로 접속 폼, 대체값 제거.
3. 확인:
   - `cargo test`(서버·엔진), Docker 테스트 서버 네 종류 엔진 테스트.
   - `store.json` 옛 형식·깨진 항목이 섞인 파일 읽기/쓰기 왕복, 옛 `.tablepeek` 파일 가져오기 테스트.
   - 다섯 엔진 각각 화면 점검: Home 연결·편집, 데이터 탭·필터·편집, 쿼리·자동완성, 구조, ER 다이어그램, 실행 계획, 내보내기·가져오기·덤프, 서버 정보.
4. 그 위에 MongoDB를 올린다(`docs/MONGODB.md`).
