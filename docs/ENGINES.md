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
| `explain` | `"pg-json"` \| `"mysql-json"` \| `"sqlite"` \| `"mongo"` \| `null` | 실행 계획 화면 |
| `exact_count` | bool | 행 수를 정확히 셀지 추정할지 |
| `dump` | `"sql"` \| `"ejson"` \| `null` | 백업·복원 형식 |
| `import_formats` / `export_formats` | 목록 | 가져오기·내보내기 형식 |
| `sessions` | `{ "kill": bool }` | 서버 정보의 세션 목록·종료 |
| `validation` | bool | 문서 검증 규칙 탭 |
| `aggregation` | bool | 집계 편집기 |
| `indexes` | `{ "create": bool, "drop": bool }` | 인덱스 탭 |

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
}

#[async_trait]
pub trait SqlDriver: Send + Sync {
    async fn schema(&self, system: bool) -> Result<Vec<TableSchema>, EngineError>;
    async fn relations(&self, system: bool) -> Result<Vec<Relation>, EngineError>;
    async fn query(&self, sql: &str, opts: QueryOpts) -> Result<QueryData, EngineError>;   // Arrow
    async fn edit(&self, target: &EditTarget, value: &ValueExpr) -> Result<(), EngineError>;
    async fn insert(&self, …); async fn delete(&self, …);
    async fn table_detail(&self, name: &str) -> Result<TableDetail, EngineError>;
    async fn tx(&self, op: TxOp) -> Result<(), EngineError>;
    // objects, definition, databases, count, kill_session …
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
```

- 기존 다섯 엔진은 지금 함수(`postgres::schema` 등)를 그대로 두고, 트레이트 구현이 그 함수를 부른다. 동작은 바뀌지 않는다.
- Cockroach는 PostgreSQL 드라이버를 쓰되 `id()`·능력·방언 차이를 드라이버 안에 갖는다.
- `Engine`은 `Arc<dyn Driver>` 하나를 들고, 지금의 `enum Backend` `match` 18곳은 트레이트 호출로 바뀐다.
- 오류는 `EngineError::Driver { engine: &'static str, code: Option<String>, message: String, interrupted: bool }` 하나로 모은다. `interrupted`는 취소로 멈춘 문장인지를 드라이버가 만들 때 정한다. 기존 코드 이름(`postgres_error` 등)은 서버가 `engine`에서 만든다.

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
- `NetRoute`는 SSH·HTTP 터널을 연 뒤의 실제 접속 주소를 넘긴다. 터널을 여는 코드는 서버에 하나만 있다(지금의 `connect_<driver>` 복사본 다섯 개가 없어진다).

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

옛 형식의 엔진별 객체(`postgres: {…}` 등)는 같은 키 이름을 쓰므로, 옮길 때는 객체를 `config`로 옮기기만 하면 된다. 비밀 필드는 저장·응답에서 빠지고, 저장된 비밀이 있으면 응답에 `has_password: true`가 붙는다.


### 4.4 API

- 공통: `/api/engines`, `/api/connect`, `/api/connections/*`, `/api/meta`(+`capabilities`), `/api/server`, `/api/conns`.
- SQL: 지금의 `/api/schema`, `/api/table`, `/api/relations`, `/api/objects`, WebSocket `query`·`edit`·`tx` 등 그대로.
- 문서형: `/api/doc/*` (MongoDB 사양 문서 참고). 엔진이 `document()`를 갖지 않으면 `unsupported_capability`(400).

## 5. 웹

- `web/src/engines/` 아래 엔진마다 폴더. 지금의 SQL 헬퍼(`ddl.ts`, `dataQuery.ts`, `export.ts`, `importSql.ts`, `sqlTools.ts`, `sqlSplit.ts`, `sqlComplete.ts`, `templates.ts`, `grid/columns.ts`, `sessionSettings.ts`, `explainPlan.ts`)에 흩어진 엔진 분기는 각 엔진의 `sql` 방언 객체로 모은다. 헬퍼는 `kind` 문자열 대신 방언 객체를 받는다.
- 기능 켜고 끄기(`serverConn`, 사용자 관리, 실행 계획, ER 다이어그램, DB 전환 등)는 `capabilities`를 본다.
- `ConnectModal`은 엔진 정의의 `connection.fields`로 폼을 그린다. 지금 폼의 모양(카드, SSL 칸, 터널 칸)은 필드 종류별 그리기로 유지한다.
- 작업 화면은 `workbench`로 고른다: `"sql"`은 지금의 화면, `"document"`는 MongoDB 사양 문서의 화면.
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
