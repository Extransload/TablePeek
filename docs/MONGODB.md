# MongoDB 지원 사양

작성: 2026-10-28 · 상태: 1~4단계 구현됨 · 화면 기준: `prototypes/mongodb/tablepeek-mongodb.html`

목표는 **MongoDB Compass의 기능을 모두 갖추되 더 직관적이고 실용적인 것**이다. 엔진 구조는 `docs/ENGINES.md`를 따른다(엔진 id `mongodb`, 패러다임 `document`).

## 1. 범위와 단계

| 단계 | 범위 | 상태 |
|---|---|---|
| 1 | 엔진 구조 전환 위에서: 접속, 데이터베이스·컬렉션 목록, 문서 탭(목록·JSON·표+오른쪽 패널), 쿼리 막대, 충돌 감지 편집, 문서 추가·복제·삭제, 인덱스 탭(보기·만들기·삭제), 실행 계획 탭(실제 `explain`), mongosh 탭(명령 일부), 콘솔 기록, 안전 모드 | 구현됨 |
| 2 | 집계 편집기, 스키마 탭, 검증 탭 | 구현됨 |
| 3 | 가져오기·내보내기, 데이터베이스·컬렉션 관리, 성능 화면, MCP 읽기 전용 도구 | 구현됨 |
| 4 | Compass와의 남은 차이와 알려진 한계 (§8) | 구현됨 |

## 2. 접속

- 엔진 정의 필드(폼에 나오는 순서): 연결 문자열(`mongodb://`, `mongodb+srv://`, 붙여 넣으면 나머지 칸을 채움), 호스트·포트(27017), **인증 방식**(없음 / 사용자·비밀번호 / X.509 / AWS IAM / LDAP / Kerberos / OIDC, 기본 없음, 선택지가 많아 드롭다운), 데이터베이스(선택: 처음 열 데이터베이스), TLS(끔/켬 + CA·클라이언트 인증서), `directConnection`, 고급: 레플리카셋 이름·읽기 선호.
- 인증 방식에 따라 보이는 칸(Compass와 같은 구성). 같은 칸이라도 방식에 따라 이름·안내가 바뀐다(필드의 `variants`):
  - 없음: 인증 칸이 하나도 없다. 호스트나 연결 문자열만으로 연결한다. 서버는 저장돼 있던 사용자·비밀번호(키체인 포함)와 연결 문자열 속 사용자를 모두 무시하고 인증 없이 연결한다.
  - 사용자·비밀번호: 사용자(연결에 필요), 비밀번호(키체인 저장/매번 입력), 인증 DB(`authSource`, 기본 `admin`), SCRAM 방식(기본은 서버가 고름 / SCRAM-SHA-256 / SCRAM-SHA-1). 예전 프로필의 `PLAIN`은 이 선택으로도 계속 쓴다. 연결 문자열이 다른 방식(AWS·GSSAPI·OIDC·X.509)을 말하면 그 방식은 버리고 SCRAM으로 보낸다.
  - X.509: 클라이언트 인증서·키 파일 칸이 보이고 TLS가 켜진다. 서버는 비밀번호를 보내지 않고 TLS를 항상 켜며, 인증서 파일(폼이나 연결 문자열의 `tlsCertificateKeyFile`)이 없으면 "X.509 인증에는 클라이언트 인증서·키 파일이 필요합니다"로 막는다.
  - AWS IAM(`MONGODB-AWS`): 액세스 키 ID(사용자 칸), 비밀 액세스 키(비밀번호 칸), 세션 토큰(두 번째 비밀, 선택). 키 ID를 비우면 키·토큰 없이 보내 드라이버가 환경 변수·프로필·ECS/EC2 역할·웹 ID에서 자격 증명을 찾는다. 키 ID만 있고 비밀 키가 없으면 "AWS 비밀 액세스 키를 입력하세요".
  - LDAP(`PLAIN`, `$external`): LDAP 사용자·비밀번호(둘 다 연결에 필요). 인증 DB 칸은 안 보이고 늘 `$external`.
  - Kerberos(`GSSAPI`, `$external`): 사용자 주체(`user@REALM`), 서비스 이름(기본 `mongodb`), 서비스 영역(선택), 서비스 호스트(선택), 호스트 이름 정규화(안 함/정방향/정방향·역방향). 비밀번호는 없고 `kinit`으로 받은 티켓을 쓴다. 티켓과 영역 설정은 TablePeek 서버 프로세스의 Kerberos 설정을 따른다: 기본 캐시·`krb5.conf`, 또는 서버를 띄울 때 준 `KRB5CCNAME`·`KRB5_CONFIG`(macOS GSS.framework도 따른다). 서비스 주체는 `<서비스 이름>/<호스트>@<영역>`이고, 호스트는 서비스 호스트가 있으면 그 이름, 없으면 접속 주소(정규화를 고르면 DNS로 바꾼 이름)다. 서버의 주체가 FQDN(`mongodb/db.example.com`)인데 IP·터널 끝(`127.0.0.1`)·로드 밸런서 이름으로 붙으면 서비스 호스트에 그 FQDN을 넣거나, hosts 파일에 그 이름을 두고 그 이름으로 접속한다(정규화 안 함). 아니면 KDC가 `mongodb/127.0.0.1`을 몰라 "LOOKING_UP_SERVER"로 실패한다. macOS 빌드에는 늘 들어 있고(GSS.framework), 다른 OS는 `cargo build --features kerberos`(Kerberos 헤더·libclang 필요, 실행 때 libgssapi_krb5)로만 들어간다. 없는 빌드에서 고르면 그렇게 알린다.
  - OIDC(`MONGODB-OIDC`, `$external`): OIDC 방식(브라우저 로그인 / Azure 관리 ID / GCP 서비스 계정 / Kubernetes 서비스 계정), 사용자 이름(선택: 로그인 힌트, Azure는 관리 ID의 클라이언트 ID), 토큰 리소스(Azure·GCP일 때 필요한 audience). 브라우저 로그인은 §8.2.
- 연결 문자열을 붙여 넣거나 입력하면 인증 방식이 따라 바뀐다: `authMechanism`이 `MONGODB-X509`·`MONGODB-AWS`·`PLAIN`·`GSSAPI`·`MONGODB-OIDC`면 X.509·AWS·LDAP·Kerberos·OIDC, 그 밖에는 사용자(`user@`)가 있으면 사용자·비밀번호, 없으면 없음. `authMechanismProperties`의 `SERVICE_NAME`·`SERVICE_REALM`·`SERVICE_HOST`·`CANONICALIZE_HOST_NAME`·`ENVIRONMENT`·`TOKEN_RESOURCE`·`AWS_SESSION_TOKEN`도 해당 칸을 채운다.
- 비밀번호는 비밀이 있는 방식(사용자·비밀번호, LDAP, 키 ID가 있는 AWS)일 때만 묻는다. 저장된 연결을 열 때 다른 방식이면 키체인을 읽지도, 비밀번호를 묻지도 않는다. 없음·X.509·Kerberos·OIDC·환경 AWS 프로필은 숨은 저장 방식 선택과 상관없이 비밀번호를 키체인에 두지 않는 것으로 저장되고(`persist_password: false`, 터널이 있으면 터널 비밀번호만 둠), 목록에도 `has_password: false`로 나간다.
- 인증 방식(`auth`)이 없는 예전 프로필은 읽을 때와 저장할 때 채운다: 인증 메커니즘(칸이나 연결 문자열)이 위의 다섯 가지면 그 방식, 사용자나 비밀번호가 있으면(연결 문자열의 사용자 포함) 사용자·비밀번호, 아니면 없음. API로 `auth` 없이 연결해도 같은 규칙을 쓴다.
- SSH·HTTP 터널: 호스트 하나면 그 서버로 가는 로컬 끝 하나를 열고 `directConnection=true`로 붙는다. `mongodb+srv://`나 호스트가 여럿인 연결은 §8.2처럼 터널 너머의 구성원마다 연결한다.
- 연결 문자열에 든 비밀번호(`user:password@`)는 저장하지 않는다. 저장할 때 서버가 문자열에서 비밀번호를 빼고(사용자는 남김), 비밀번호 칸이 비어 있으면 그 칸으로 옮겨 다른 비밀번호처럼 키체인에 두거나 매번 묻는다. 연결 목록·내보내기 파일에도 문자열은 비밀번호 없이 나가고, 콘솔·실행 기록·오류 메시지에서는 URL 비밀번호를 `****`로 가린다. 저장하지 않고 바로 연결할 때는 문자열 속 비밀번호를 그대로 쓴다. (`uri` 종류 필드가 있는 모든 엔진에 같은 규칙.)
- 드라이버: 공식 `mongodb` 크레이트(tokio). 서버 선택 시간 제한 5초, 쿼리마다 `maxTimeMS`(설정의 쿼리 시간 제한).
- 능력: `language: "mongo"`, `objects: ["collection","view"]`, `schema: "sampled"`, `edit_by_key: true`, `foreign_keys: false`, `ddl: false`, `databases: "switch"`, `transactions`: 접속한 토폴로지가 레플리카셋·샤드면 `"replica_set"`, 단일 서버면 `"none"`, `explain: "mongo"`, `indexes: { create, drop }`, `validation: true`, `aggregation: true`, `exact_count: false`(필터 없을 때 `estimatedDocumentCount`), `dump: "ejson"`.

## 3. 화면

### 3.1 사이드바
데이터베이스 → 컬렉션(문서 수), 뷰(표시 `뷰`). 검색, 데이터베이스·컬렉션 우클릭 메뉴(1단계: 열기, 새 쿼리 탭, 새로 고침; 3단계: 만들기·이름 바꾸기·삭제).

### 3.2 컬렉션 탭
- 위: 하위 탭 `문서 | 인덱스 | 실행 계획` (2단계에 `집계 | 스키마 | 검증`, 4단계에 `변경 보기` 추가) + 통계 칩(문서 수, 크기, 평균 크기, 인덱스 수·크기).
- 쿼리 막대: 필터 한 줄(자동완성: 필드 경로, `$` 연산자, 자주 나오는 값), `옵션` 펼침(프로젝션·정렬·건너뛰기·개수), `⌘↩` 찾기, 초기화, 최근 실행·즐겨찾기, `계획`(실행 계획 탭으로).
- 결과 도구 줄: `+ 문서`, 모두 펼치기/접기, (JSON일 때) EJSON 전환·페이지 복사, 오른쪽 끝에 **아이콘만** 있는 보기 전환 ☰ / {} / ⊞ (툴팁·접근성 이름으로 이름을 알림). 보기는 컬렉션 탭마다 기억, `⌃1–3`.
- 아래: 범위(`1–20 / 2,000개 문서`), 새로 고침, 페이지 크기(10·20·50·100, 기본 20), 페이지 이동.

### 3.3 ☰ 목록
문서마다 카드. 필드 이름 · 값 칸 · 오른쪽 끝 타입. 중첩 객체·배열은 카드 안에서 접고 펼치며, 접힌 상태는 `{4} { city: "東京", … }`처럼 미리보기.
- 값 칸 **어디를 눌러도** 편집(타입 유지, 잘못된 값은 칸 아래 메시지). 타입 글자를 눌러 타입 변경. 키 더블클릭으로 이름 변경. `+` 필드·원소 추가, `✕` 삭제.
- 바뀐 필드는 노란색, 추가된 필드는 초록색. 카드 아래 `변경 n건 · 취소 · 저장`.
- 카드 동작: JSON 편집(`replaceOne`), 복제, 복사(EJSON), 삭제(확인).

### 3.4 {} JSON
문서마다 블록 하나. mongosh 표기(EJSON 전환), 색 구분, `{`·`[`마다 접기. 블록에 마우스를 올리면 편집·복제·복사·삭제. 편집은 그 자리에서 코드 편집기(자동완성·오류 위치 표시), `⌘↩` 저장, Esc 취소.

### 3.5 ⊞ 표 + 오른쪽 패널
- 기존 캔버스 그리드를 쓴다. 컬럼은 페이지 문서들의 최상위 필드(있는 비율 순). **헤더에 타입 표시 없음**, 객체·배열 컬럼에만 `›`.
- 객체·배열 칸이나 `›` 헤더를 누르면 그 필드만 따로 표로 열고 위에 경로(`orders › items`). 배열 안 문서는 원소마다 한 줄(부모 `_id`, `#` 순번). 여러 단계 가능.
- 없는 필드 `—`(흐리게)와 `NULL`을 구분.
- 칸 편집은 타입 유지, 하위 단계에서는 점 경로 `$set`(`items.0.quantity`).
- **오른쪽 패널(표 보기에서만)**: 기존 행 상세 패널. 선택한 문서(하위 단계면 선택한 원소와 경로)를 목록 카드와 같은 필드 줄로 보여주고 같은 방식으로 편집·저장. 여러 행이면 공통 값과 `여러 값`. ⌘I·패널 버튼, 너비 조절·기억. 목록·JSON 보기에서는 숨김.

### 3.6 인덱스 탭
목록(키 ↑/↓, UNIQUE·SPARSE·TTL·PARTIAL·복합, 크기는 `collStats.indexSizes`, 사용 횟수는 `$indexStats` — 권한이 없으면 빈칸), 만들기(필드·방향·옵션, 보낼 명령 미리보기), 삭제(확인).

### 3.7 실행 계획 탭
현재 쿼리 막대 내용으로 `explain("executionStats")`. 단계 트리(COLLSCAN, IXSCAN → FETCH → SORT …), 돌려준·읽은 문서 수, 읽은 키 수, 쓴 인덱스, 범위, 시간, 경고(전체 훑기·메모리 정렬·읽은 수 대비 돌려준 수), 원문 보기. 인덱스 제안(같음 → 정렬 → 범위 순)과 만들기 버튼.

### 3.8 mongosh 탭
모든 문장이 아래 형태면 페이지가 해석해 구조화된 요청으로 보낸다(문장마다 안전 모드 확인 가능): `use`, `show dbs|collections`, `db.<c>.find(filter, projection).sort().skip().limit()`, `findOne`, `countDocuments`, `estimatedDocumentCount`, `distinct`, `aggregate([...])`, `insertOne/Many`, `updateOne/Many`, `replaceOne`, `deleteOne/Many`, `createIndex`, `dropIndex`, `getIndexes`, `drop`, `stats`, `.explain()`. 값 표기: 완화된 EJSON(따옴표 없는 키, 작은따옴표, 끝 쉼표, `ObjectId()`, `ISODate()`, `new Date()`, `NumberDecimal()`, `NumberInt()`, `NumberLong()`, `/re/flags`). 해석되지 않는 문장(변수, 함수, 반복문 등)이 하나라도 있으면 실행 범위(선택, 커서의 문장, 모두 실행이면 전체)를 JavaScript 스크립트로 Web Worker에서 실행한다(§8.2). 결과는 같은 세 가지 보기. 해석기는 웹(`web/src/engines/mongodb/shell/`)에 있고 서버에는 구조화된 요청만 간다. 자동완성·강조·실행 기록 다시 실행도 이 해석기를 쓴다.

### 3.9 안전 모드·콘솔
- 조건이 빈 쓰기(`updateOne`/`updateMany`/`replaceOne`/`deleteOne`/`deleteMany`), `drop`, `dropIndex`는 안전 모드 확인 창. 확인하면(안전 모드를 껐으면 바로) `confirmed: true`를 붙여 보낸다 — 서버는 조건이 빈 쓰기를 `confirmed` 없이 거절한다. 읽기(`find`·`aggregate`·`count*`·`distinct`·`explain`)는 확인 없음.
- 화면에서 한 모든 조작은 콘솔(⌘J)에 mongosh 표기로 남는다.

## 4. 편집과 충돌 감지

문서를 연 뒤 다른 곳에서 바뀌었으면 덮어쓰지 않는다.

- 화면은 문서를 불러온 시점의 **원래 값**을 들고 있다. 저장할 때 바꾼 경로마다 원래 값을 조건으로 넣는다.
  ```js
  // status를 "paid"로, items.0.quantity를 5로 바꿀 때
  db.orders.updateOne(
    { _id: ObjectId("…"), status: "pending", "items.0": { sku: "P-0042", quantity: 2, price: NumberDecimal("19.90") } },
    { $set: { status: "paid", "items.0.quantity": 5 } })
  ```
  - 배열 원소를 순번으로 고칠 때는 그 원소 전체(`"items.0": { … }`)를 조건에 넣어, 배열 순서가 바뀐 경우도 잡는다.
  - 필드를 새로 추가하면 `{ field: { $exists: false } }`, 지우면 원래 값을 조건에 넣는다.
  - `replaceOne`(JSON 편집)은 문서 전체를 조건으로 쓰지 않고, 불러온 문서의 각 최상위 필드 원래 값을 조건에 넣는다.
- `matchedCount == 0`이면 `_id`로 다시 읽는다. 없으면 "다른 곳에서 삭제되었습니다", 있으면 "다른 곳에서 바뀌었습니다"와 함께 **지금 값 / 내 변경** 두 가지를 나란히 보여주고 `지금 값으로 다시 불러오기` 또는 `내 변경으로 덮어쓰기`를 고르게 한다(덮어쓰기는 `_id`만 조건).
- 검증 규칙 위반(`code 121`)은 해당 카드·블록 아래에 규칙 메시지로 보여준다.
- 서버 API는 이 조건을 받아 그대로 보낸다(`GuardedUpdate { filter_guard, update }`). 조건을 만드는 규칙은 웹에 있다. 화면의 편집은 항상 `_id`를 조건에 넣는다.

## 5. 데이터 전달

- 문서는 **canonical EJSON**으로 주고받는다(Arrow가 아님). 웹은 BSON 타입을 감싼 값(ObjectId, Decimal128, Int32/64, Double, Date, Binary, Regex, Timestamp, MinKey/MaxKey)으로 다루고, Decimal128을 부동소수로 바꾸지 않는다.
- 표 보기는 받은 문서로 웹에서 표를 만든다.
- 큰 데이터:
  - 페이지는 `skip`+`limit`(기본 20). 정렬이 `_id`뿐이면 마지막 `_id` 기준으로 다음 페이지를 읽는다.
  - 문서 수는 필터가 없으면 `estimatedDocumentCount`, 있으면 `countDocuments`(시간 제한 3초, 넘으면 "많음"으로 표시하고 다음 페이지는 계속 됨).
  - 문서 하나가 1MB를 넘거나 배열 원소가 1,000개를 넘으면 카드·JSON 보기에서 잘라 보여주고 "전체 보기"로 펼친다.
  - 스키마 샘플은 `$sample` 최대 1,000건(2단계).

## 6. 서버 API (1단계)

모두 `conn` 쿼리 매개변수, 기존과 같은 토큰 인증. 본문과 응답의 값은 canonical EJSON.

| 메서드·경로 | 본문 | 응답 |
|---|---|---|
| `GET /api/doc/databases` | — | `[{ name, sizeOnDisk, empty }]` |
| `GET /api/doc/collections?db=` | — | `[{ name, type: "collection"\|"view"\|"timeseries", options, count }]` |
| `GET /api/doc/stats?db=&coll=` | — | `{ count, size, avgObjSize, storageSize, nindexes, totalIndexSize, indexSizes }` |
| `POST /api/doc/find` | `{ db, coll, filter, projection?, sort?, skip?, limit, maxTimeMS? }` | `{ docs: [...], elapsedMs }` |
| `POST /api/doc/count` | `{ db, coll, filter }` | `{ count, exact }` |
| `POST /api/doc/aggregate` | `{ db, coll, pipeline, maxTimeMS? }` | `{ docs, elapsedMs }` |
| `POST /api/doc/distinct` | `{ db, coll, key, filter }` | `{ values }` |
| `POST /api/doc/insert` | `{ db, coll, docs: [...] }` | `{ insertedIds }` |
| `POST /api/doc/update` | `{ db, coll, filter, update, many: bool, upsert?: false, confirmed? }` | `{ matched, modified }` (단건 편집은 `filter`에 충돌 조건 포함, `many:false`) |
| `POST /api/doc/replace` | `{ db, coll, filter, replacement, confirmed? }` | `{ matched, modified }` |
| `POST /api/doc/delete` | `{ db, coll, filter, many: bool, confirmed? }` | `{ deleted }` |
| `GET /api/doc/indexes?db=&coll=` | — | `[{ name, key, unique?, sparse?, expireAfterSeconds?, partialFilterExpression?, size?, ops? }]` |
| `POST /api/doc/indexes` | `{ db, coll, keys, options }` | `{ name }` |
| `DELETE /api/doc/indexes` | `{ db, coll, name }` | `{ ok }` |
| `POST /api/doc/explain` | `{ db, coll, find? \| aggregate?, verbosity: "executionStats" }` | 원문 explain 결과 |
| `POST /api/doc/command` | `{ db, command }` (mongosh 탭의 `stats`, `drop` 등 화이트리스트 명령만) | 원문 결과 |

- 취소: 진행 중인 읽기(`find`·`count`·`aggregate`·`distinct`·`explain`)는 요청마다 `comment` 꼬리표(`tablepeek:<id>`)를 달고, 기존 WebSocket `cancel`이 오면 `$currentOp`로 그 꼬리표의 작업을 찾아 `killOp`한다. 쓰기는 취소하지 않는다.
- 오류 코드: MongoDB 오류 코드를 `mongo_<code>`로(예: `mongo_11000` 중복 키, `mongo_121` 검증 실패), 메시지는 원문. 코드가 없는 오류(네트워크 등)는 `mongodb_error`. 아래 규칙 위반은 `bad_request`, 문서형이 아닌 연결에서는 `unsupported_capability`.
- 쓰기 명령(`insert`·`update`·`replace`·`delete`·인덱스·`drop`)은 콘솔과 실행 기록에 mongosh 표기(`db.getSiblingDB("shop").orders.updateOne({ … }, { … })`)로 남기고, 안전 모드 판정은 웹이 한다. 서버는 다음만 거절한다: `update`·`replace`·`delete`의 `filter`가 비었는데(`{}`·`null`·생략, `many`와 상관없이) `confirmed: true`가 없을 때, `command`가 화이트리스트(`collStats`·`dbStats`·`drop`·`listCollections`·`listIndexes`·`ping`·`buildInfo`·`serverStatus`) 밖이거나 `drop`에 `confirmed: true`가 없을 때. 비어 있지 않은 `filter`는 `_id`가 없어도 그대로 보낸다(`db.c.updateOne({ status: "x" }, …)`). 화면의 문서 편집은 `_id`와 충돌 조건을 스스로 넣는다.
- `count`: 빈 `filter`면 `estimatedDocumentCount`(`exact: false`), 아니면 `countDocuments`(3초 제한, `exact: true`). 3초를 넘기면 `{ count: null, exact: false }`.
- `find`의 `limit`은 생략하면 20. `aggregate`는 한 번에 최대 10,000건. `explain`의 `find`는 `{ filter, projection?, sort?, skip?, limit? }`, `aggregate`는 `{ pipeline }`. `indexes` 목록의 `size`·`ops`는 권한이 없으면 `null`.
- 접속 후 `meta.capabilities.transactions`는 `hello` 결과로 정한다: 레플리카셋·샤드면 `"replica_set"`, 단일 서버면 `"none"`. `meta.tables`는 `db.collection` 목록이다.

## 6.1 서버 API (2·3단계 추가)

| 메서드·경로 | 본문 | 응답 |
|---|---|---|
| `POST /api/doc/aggregate` (변경) | `{ db, coll, pipeline, maxTimeMS?, confirmed? }` | 그대로. 파이프라인에 `$out`·`$merge`가 있으면 쓰기로 보고 `confirmed: true`가 없으면 `bad_request` |
| `POST /api/doc/insert` (변경) | `{ db, coll, docs, ordered?: true }` | `{ insertedIds, errors: [{ index, code, message }] }`. `ordered:false`면 실패한 문서를 건너뛰고 계속(가져오기용) |
| `POST /api/doc/export` | `{ db, coll, filter?, projection?, sort?, limit?, pipeline? }` (`pipeline`이 있으면 집계 결과) | NDJSON 스트림: 한 줄에 canonical EJSON 문서 하나, 마지막 줄 `{"$end": { count }}`. 취소는 연결을 끊으면 된다 |
| `GET /api/doc/perf` | — | `{ time, uptime, process, opcounters, opcountersRepl?, connections, network, mem, wiredTiger?: { cacheBytes, cacheMax, dirtyBytes }, globalLock?: { activeReaders, activeWriters, queueReaders, queueWriters } }` (`serverStatus` 일부, `process`는 `mongod`·`mongos`, 웹이 2초마다 불러 차이로 초당 값 계산) |
| `POST /api/doc/command` (화이트리스트 추가) | | `create`(컬렉션·뷰·capped·timeseries·collation·validator), `renameCollection`(admin에서, `confirmed`), `dropDatabase`(`confirmed`), `collMod`(검증 규칙·validationLevel·validationAction·TTL·hidden 인덱스, `confirmed`), `currentOp`, `killOp`(`confirmed`), `top`, `profile`(읽기 `-1`; 수준 바꾸기는 `confirmed`), `hostInfo`, `replSetGetStatus`, `listDatabases` |

스키마 분석과 검증 규칙 시험은 새 경로 없이 `aggregate`로 한다: 스키마는 `[{ $match: filter }, { $sample: { size } }]`(최대 1,000), 규칙 위반 문서는 `[{ $match: { $nor: [validator] } }, { $limit: 20 }]`. 느린 작업은 `system.profile` 컬렉션을 `find`로 읽는다.

구현에서 정한 세부:

- `insert`: 응답에 `errors`가 늘 있다(없으면 `[]`). `ordered`를 보내면 실패한 문서가 `errors`(`code`는 `mongo_<code>`, 예: `mongo_11000`)로 오고 응답은 200이다. `false`면 나머지를 계속 넣고, `true`면 실패한 문서에서 멈춘다(그 앞 문서만 들어감). `insertedIds`는 실제로 들어간 문서의 id만 보낸 순서대로. `ordered`를 빼면 1단계처럼 첫 실패에서 요청 전체가 `mongo_<code>` 오류다.
- `export`: 첫 바이트 전의 오류(`$out`·`$merge`가 든 파이프라인은 `bad_request`, 커서를 여는 중의 `mongo_<code>`)는 보통 JSON 오류 응답이다. 스트림 중간에 실패하면 마지막 줄이 `{"$error": { code, message }}`이고 `$end`는 없다. `limit`이 없거나 0이면 전부, `pipeline`이 있으면 `filter`·`projection`·`sort`는 무시하고 `limit`은 끝에 `$limit`으로 붙인다.
- `perf`의 `network`는 `{ bytesIn, bytesOut, numRequests }`, `opcounters`·`connections`·`mem`은 `serverStatus`의 것 그대로.
- `command`: `renameCollection`은 `db: "admin"`으로 보내야 한다(아니면 `bad_request`). `collMod`는 옵션과 상관없이(뷰의 `viewOn`·`pipeline` 포함) `confirmed`가 필요하고, `create`는 필요 없다. 바꾸는 명령(`create`·`collMod`·`renameCollection`·`dropDatabase`·`drop`·`killOp`·`profile` 수준 바꾸기)과 `$out`·`$merge` 집계는 실행 기록에도 남는다.
- `perf`·`export`와 `currentOp`·`killOp`·`top`·`serverStatus`·`hostInfo`·`replSetGetStatus`는 연결의 실행 게이트 밖에서 돈다. 긴 쿼리가 도는 동안에도 성능 탭이 갱신되고 그 쿼리를 `killOp`할 수 있다. `$out`·`$merge` 집계는 쓰기라 취소하지 않는다.
- 화면이 되풀이해 부르는 상태 읽기는 콘솔에 남기지 않는다. `GET /api/doc/perf`는 늘 기록하지 않는다. `command`·`find` 본문에 `"poll": true`를 주면 `currentOp`·`top`·`serverStatus`·`hostInfo`·`replSetGetStatus`·`listDatabases`·`profile: -1` 명령과 `system.profile`의 `find`는 콘솔에 남지 않는다. 쓰기(`killOp`, `profile` 수준 바꾸기 등)와 그 밖의 명령은 `poll`과 상관없이 기록한다. 드라이버 `appName`은 `TablePeek`이라 `currentOp`의 `appName`으로 TablePeek의 작업을 알아볼 수 있다.

## 6.2 화면 (2·3단계)

- **집계**: 단계 카드를 위에서 아래로 쌓는다. 카드마다 단계 고르기(자동완성·설명·예시 틀), 코드 편집기, 켜기/끄기, 순서 끌기, 복제·삭제, 그 단계까지 돌린 결과 미리보기(앞 10건, `$limit` 붙여 실행, 단계 바꾸면 0.6초 뒤 다시). 전체 텍스트 모드(파이프라인 배열 하나 편집)와 왕복. 저장된 파이프라인(컬렉션별 localStorage), mongosh 코드 복사, 뷰로 저장(`create` viewOn), 실행 계획, `$out`/`$merge`는 안전 모드 확인 후 실행. 결과는 ☰ {} ⊞ 세 보기.
- **스키마**: 필터 + 표본 크기(100·500·1,000)로 분석. 필드 경로 트리(중첩·배열 원소 포함)마다 있는 비율, 타입 분포 막대, 타입별 요약: 수·날짜는 최소·최대·히스토그램, 문자열은 자주 나오는 값·길이, ObjectId는 생성 시각 범위, 배열은 길이 분포, 불리언은 비율. 값 막대를 누르면 그 값으로 필터를 걸고 문서 탭으로. 결과 JSON 내보내기.
- **검증**: 현재 규칙(`$jsonSchema` 또는 쿼리식)을 편집기에서 고치고, validationLevel(off·moderate·strict)·validationAction(error·warn) 선택. 표본 문서로 "이 규칙이면 통과/위반" 각각 몇 건과 예시를 먼저 보여준 뒤 `collMod`로 적용(안전 모드 확인). 스키마 탭 결과로 `$jsonSchema` 초안 만들기.
- **가져오기**: JSON 배열·NDJSON·EJSON·CSV/TSV 파일. 미리보기(앞 20건), CSV는 컬럼마다 타입(자동 추정·문자열·수·Decimal128·날짜·불리언·ObjectId·건너뛰기)과 점 경로로 중첩 필드 만들기, 오류 시 멈추기/건너뛰기, 1,000건씩 `insert`, 진행률·취소, 실패 목록.
- **내보내기**: 현재 쿼리(필터·프로젝션·정렬) 또는 집계 결과를 JSON(완화/canonical EJSON)·NDJSON·CSV로. CSV는 필드 고르기(스키마 표본에서), 중첩은 점 경로로 펼침, 배열은 JSON 문자열. `/api/doc/export` 스트림을 받아 파일로 저장, 진행률·취소.
- **데이터베이스·컬렉션 관리**: 사이드바 우클릭과 ⋯ 메뉴: 데이터베이스 만들기(첫 컬렉션 이름과 함께), 컬렉션 만들기(capped 크기·개수, timeseries timeField·metaField·granularity, collation, clustered, 검증 규칙 초안), 뷰 만들기(파이프라인), 이름 바꾸기, 삭제(안전 모드가 켜져 있으면 이름 입력 확인, 꺼져 있으면 SQL 쪽 테이블·데이터베이스 삭제처럼 확인 한 번. 어느 쪽이든 `confirmed: true`를 붙여 보낸다), 데이터베이스 삭제, 컬렉션 통계 보기. 보낼 명령 미리보기.
- **성능**: 연결의 ⋯ 메뉴 "성능" 탭. 2초마다 `perf`로 초당 작업 수(insert·query·update·delete·getmore·command), 연결 수, 네트워크 입출력, 메모리·캐시 사용 그래프(최근 5분), 현재 작업 목록(`currentOp`: 작업·ns·실행 시간·클라이언트·계획 요약, 오래 걸리는 순, 작업 종료 `killOp` 확인), 컬렉션별 읽기/쓰기 시간(`top`), 느린 작업(`profile` 수준 보기·바꾸기, `system.profile` 최근 50건). 일시 정지. mongos에는 `top`과 `system.profile`이 없어, 샘플이 mongos를 알리면 `top`을 묻지 않고 두 구역에 샤드의 mongod에 바로 연결하라는 안내를 보인다. 탭 자신의 currentOp(mongos에서는 `$currentOp` 집계)는 목록에서 뺀다.
- **MCP**: 읽기 전용 도구 `mongo_list_collections`, `mongo_find`(limit ≤ 100), `mongo_aggregate`(`$out`·`$merge` 거절), `mongo_schema`(표본 분석 요약), `mongo_indexes`. 쓰기 도구는 없다.

## 7. 테스트

- `testdb/compose.yml`에 `mongodb`(7.x, 레플리카셋 1노드로 띄워 트랜잭션·`$indexStats` 확인 가능), 샘플 `shop` 데이터(시안과 같은 생성 규칙). 4단계 접속·기능 시험용 서버는 compose 프로필(`mongodb-x509`·`-ldap`·`-kerberos`·`-oidc`·`-aws`·`-rs`·`-atlas`·`-sharded`)로 두고 `make test-db ENGINE=…`로 띄운다.
- 엔진 테스트(`TABLEPEEK_TEST_MONGODB=1`): 접속, 목록, find/aggregate/count, 타입 왕복(Decimal128·Int64·Date·ObjectId·Binary), 충돌 감지(동시 수정 시 `matched 0`), 인덱스 만들기·삭제, explain.
- 서버 테스트: API 형식, 빈 조건 `many` 거절, 오류 코드. 4단계(`TABLEPEEK_TEST_MONGODB=1`, `doc_phase4_routes_against_mongodb`): 쿼리 옵션(collation으로 대소문자 무시 찾기, hint, maxTimeMS, explain의 IXSCAN), 미리보기(전·후 비교 뒤 아무것도 남지 않음, 파이프라인 수정), 검색 인덱스 없는 서버의 `unsupported_capability`, 변경 스트림(하트비트·삽입 이벤트·연결을 끊으면 서버 커서 닫힘·`resumeAfter`로 놓친 이벤트), GridFS(5 MB 올리기·목록·내려받아 바이트 비교·끊긴 올리기는 청크를 남기지 않음·삭제 후 404). Atlas Local 컨테이너(`TABLEPEEK_TEST_MONGODB_ATLAS=1`, 127.0.0.1:27019)에서 검색 인덱스 만들기(search·vectorSearch)·목록·고치기·삭제.
- 접속(4단계, `engines/mongodb/live_conn.rs`, `tunnel.rs`): `TABLEPEEK_TEST_MONGODB_X509=1` X.509 접속·인증서 없으면 막힘·TLS 없으면 실패, `…_LDAP=1` LDAP 로그인·틀린 비밀번호, `…_KERBEROS=1` 테스트가 `testdb/kerberos/krb5.conf`와 임시 캐시로 `kinit`(Heimdal은 `--password-file=STDIN`)한 뒤 `127.0.0.1`에 서비스 호스트 `kerberos.tablepeek.test`로 접속·쓰기·읽기·`ann@TABLEPEEK.TEST`로 로그인, 서비스 호스트가 없으면 실패(macOS 또는 `--features kerberos` 빌드에서만), `…_OIDC=1` 브라우저 로그인(기다리는 로그인의 PKCE 주소 → IdP 로그인 폼 → 콜백의 `state`·`code` → `tp/ann`으로 접속·쓰기·읽기)·취소하면 실패·Kubernetes 방식(`AZURE_FEDERATED_TOKEN_FILE`의 클라이언트 자격 증명 토큰 → `tp/tablepeek-machine`; 테스트가 `SSL_CERT_FILE`을 테스트 CA로 둔다), `…_AWS=1` 키(IAM 사용자)·세션 토큰(맡은 역할)·환경 변수 자격 증명·틀린 비밀 키, `…_SHARDED=1` mongos의 `meta`·`perf`, `…_RS=1` 터널 너머 3구성원 세트(구성원 목록·테스트 DNS의 SRV·`readPreference=secondary`가 secondary에서 읽음, 서버 크레이트에서는 실제 SSH로 붙은 채 `replSetStepDown` 뒤 새 프라이머리에 쓰기). 서버는 `make test-db ENGINE=…`의 프로필(README 표). 화면에서는 Kerberos(서비스 호스트 없이 실패 → 넣고 연결 → find)와 OIDC 브라우저 로그인(알림 → 로그인 페이지 → 콜백 → 연결 → find, 취소)을 확인했다: TablePeek를 `KRB5_CONFIG`·`KRB5CCNAME`·`SSL_CERT_FILE=testdb/x509/ca.pem`과 함께 띄운다.
- 화면: 시안의 각 동작을 실제 서버로 다시 확인.

## 8. 4단계: 남은 기능과 한계 극복

### 8.1 추가 기능

| 기능 | 화면 | 서버 |
|---|---|---|
| 여러 문서 한꺼번에 수정·삭제 | 문서 탭 도구 줄 `일괄 수정`·`일괄 삭제`: 지금 필터, 수정 내용 편집기(`$set` 틀, 파이프라인도), 영향받는 문서 수, 앞 몇 건의 바뀌기 전·후 비교, 안전 모드 확인 후 실행 | `POST /api/doc/update/preview`(아래) |
| 쿼리 옵션 | 쿼리 막대 `옵션`에 collation(로캘·강도), hint(인덱스 이름 고르기 또는 키), maxTimeMS 추가 | find·count·aggregate·explain·export에 `collation`, `hint`, `maxTimeMS` |
| 코드로 내보내기 | 문서 탭과 집계 탭에서 `코드로`: Python(PyMongo), Node.js, Java, C#, Go, Rust, PHP, Ruby, mongosh. 접속 코드 포함 여부, 복사 | 없음(웹에서 만든다) |
| 위치 값 지도 | 스키마 탭에서 GeoJSON(Point·MultiPoint는 점, LineString·Polygon 등은 윤곽선)·`[경도, 위도]` 필드(쌍이 배열의 90% 이상이고, 소수 좌표가 있거나 이름이 위치 같을 때)를 오프라인 세계 지도(내장한 Natural Earth 1:110m 육지, 등장방형) 위에. 휠·두 번 눌러 확대, 끌어 이동, 가까운 점은 숫자 묶음, 올리면 값. 사각형·원(또는 Shift+끌기)으로 영역을 고르면 `$geoWithin` 필터: 사각형은 값이 모두 점이면 `$box`, 선·다각형이 섞이면 `$geometry` 다각형(반구보다 크면 strict-winding CRS), 원은 `$centerSphere` | 없음 |
| Atlas Search 인덱스 | 인덱스 탭의 `검색 인덱스` 구역: 목록(상태·조회 가능), 만들기·고치기(JSON 정의, search·vectorSearch), 삭제 | `GET/POST/PUT/DELETE /api/doc/search-indexes`; 지원하지 않는 서버는 `unsupported_capability` |
| 변경 스트림 | 컬렉션 탭(와 데이터베이스 메뉴)의 `변경 보기`: 시작·멈춤, 작업 종류 필터, 이벤트 목록과 문서 전·후 | `POST /api/doc/watch` NDJSON 스트림 |
| GridFS | 사이드바에서 `*.files`/`*.chunks` 묶음을 버킷으로: 파일 목록, 내려받기, 올리기, 삭제, 메타데이터 보기 | `/api/doc/gridfs/*` |

### 8.2 한계와 극복

| 한계 | 극복 |
|---|---|
| AWS IAM·LDAP·Kerberos·OIDC 인증 없음 | 인증 방식에 AWS(`MONGODB-AWS`, 키·세션 토큰 또는 환경·역할), LDAP(`PLAIN`), Kerberos(`GSSAPI`, 서비스 이름·영역·호스트·호스트 이름 정규화), OIDC(기계용: Azure·GCP·Kubernetes, 사람용: 브라우저 로그인) 추가(§2). 모두 Enterprise 서버 테스트 컨테이너로 실제 접속 확인(§7): LDAP는 OpenLDAP, Kerberos는 MIT KDC(호스트에서 테스트 전용 `KRB5_CONFIG`·`KRB5CCNAME`으로 `kinit`, macOS GSS.framework로 접속), OIDC는 로컬 IdP(mock-oauth2-server, HTTPS 필수라 테스트 CA 인증서)로 브라우저 로그인(로그인 페이지 → 콜백 → 연결·find, 취소)과 Kubernetes 방식(클라이언트 자격 증명 토큰 파일), AWS는 서버의 `awsSTSUrl`이 가리키는 STS 대역(서명을 테스트 키로 검사해 ARN을 답함)으로 키·세션 토큰(맡은 역할)·환경 변수 자격 증명과 틀린 비밀 키. AWS의 실제 STS·ECS/EC2 역할·웹 ID와 Azure·GCP의 메타데이터 끝점은 클라우드 안에서만 있어 단위 테스트(보낼 자격 증명)로만 확인 |
| X.509 미검증 | 테스트용 CA·서버·클라이언트 인증서(`testdb/x509/gen.sh`)로 TLS가 필수인 테스트 서버를 compose에 두고 실제 접속 확인 |
| SRV·여러 호스트에 터널 불가 | `mongodb+srv://`는 서버가 SRV·TXT를 직접 풀어(SRV 호스트는 같은 도메인이어야 함, TXT는 `authSource`·`replicaSet`·`loadBalanced`만, `srvServiceName`·`srvMaxHosts` 반영, TLS 기본 켬) 구성원 목록 연결 문자열로 바꾼다. 드라이버는 연결마다 서버 안의 SOCKS5 중계(127.0.0.1, 연결마다 임의 비밀번호)를 거치고, 중계는 요청한 구성원 이름으로 SSH(`direct-tcpip`)·HTTP(`CONNECT`) 터널 스트림을 연다. 구성원이 진짜 이름을 그대로 쓰므로 TLS 인증서 검사가 그대로 맞고, 프라이머리 찾기·`NotWritablePrimary`나 네트워크 오류 뒤 다시 찾기·`readPreference=secondary`의 secondary 고르기는 드라이버가 평소대로 한다. 3구성원 테스트 세트에서 SSH로 붙은 채 프라이머리를 `replSetStepDown`해도 같은 연결로 새 프라이머리에 쓰는 것을 확인 |
| 숫자 모양 필드 이름의 순서 | 웹의 문서 표현을 순서를 지키는 구조로 바꾸고, EJSON 읽기를 직접 해서 `"2024"` 같은 키도 원래 순서를 지킨다 |
| mongosh가 JavaScript를 실행하지 않음 | 브라우저 Web Worker 안에서 실제 JavaScript로 실행한다. `db`·컬렉션·커서·`print`/`printjson`·`use`·`show`·`EJSON`·BSON 생성자를 제공하고, 서버 호출은 Worker의 동기 요청으로 해 mongosh처럼 `await` 없이 쓴다. 화면·저장소·토큰 밖에는 손댈 수 없고, 안전 모드 확인이 필요한 쓰기는 그 문장을 단독으로 실행하라고 알린다. 멈춤 버튼과 실행 시간 제한 |

### 8.3 서버 API 추가

- `find`·`count`·`aggregate`·`explain`·`export` 본문에 `collation?`(문서), `hint?`(인덱스 이름 문자열 또는 키 문서), `maxTimeMS?`. `update`·`replace`·`delete`·`update/preview`에도 `collation?`·`hint?`(같은 모양, `maxTimeMS`는 없음).
- `POST /api/doc/update/preview` `{ db, coll, filter, update, limit ≤ 20 }` → `{ matched, samples: [{ before, after }], previewed: bool }`. 트랜잭션이 되는 서버에서는 앞 `limit`건을 트랜잭션 안에서 실제로 고쳐 읽은 뒤 되돌린다(`abortTransaction`); 안 되는 서버는 `previewed: false`와 `matched`만.
- `GET /api/doc/search-indexes?db&coll` → `[{ name, type, status, queryable, latestDefinition }]`; `POST` `{ db, coll, name, type?, definition }`; `PUT` `{ db, coll, name, definition }`; `DELETE` `{ db, coll, name, confirmed }`.
- `POST /api/doc/watch` `{ db, coll?, pipeline?, fullDocument?, fullDocumentBeforeChange?, resumeAfter? }` → NDJSON: 변경 이벤트(canonical EJSON) 한 줄씩, 15초마다 `{"$heartbeat": <ms>}`; 연결을 끊으면 스트림을 닫는다. `resumeAfter`는 마지막으로 받은 이벤트의 `_id`(재연결 시 그 뒤부터 이어 받음).
- GridFS: `GET /api/doc/gridfs/buckets?db` → `[name]`; `POST /api/doc/gridfs/files` `{ db, bucket, filter?, sort?, skip?, limit }` → `{ files }`; `GET /api/doc/gridfs/download?db&bucket&id&token?`(id는 canonical EJSON 문자열) → 파일 바이트(이름·길이 헤더); `POST /api/doc/gridfs/upload?db&bucket&filename&metadata?` 본문 = 파일 → `{ id }`; `DELETE /api/doc/gridfs/files` `{ db, bucket, id, confirmed }`.
- 서버 커서(셸 탭의 `find()`·`aggregate()` 커서): `POST /api/doc/cursor/open` `{ db, coll, find?: { filter, projection?, sort?, skip?, limit?, collation?, hint?, maxTimeMS? } | aggregate?: { pipeline, collation?, hint?, maxTimeMS? }, batchSize?: 1–1000 (기본 101), confirmed? }` → `{ id, batch, done }`; `POST /api/doc/cursor/next` `{ id, batchSize? }` → `{ batch, done }`; `POST /api/doc/cursor/close` `{ id }` → `{ ok: true, closed }`.
- 접속 필드 `auth`: `none | password | x509 | aws | ldap | kerberos | oidc`와 각 방식의 칸(엔진 정의 JSON): `oidc_flow`(`human | azure | gcp | k8s`), `aws_session_token`(비밀), `kerberos_service_name`·`kerberos_service_realm`·`kerberos_service_host`·`kerberos_canonicalize`(`none | forward | forwardAndReverse`), `oidc_token_resource`.
- OIDC 브라우저 로그인: 서버가 IdP 정보(서버가 준 issuer·clientId·scope)로 discovery 문서를 읽고 authorization-code + PKCE(S256) 요청을 만든 뒤 기다린다. `GET /api/oidc/logins` → `[{ id, url, issuer }]`(기다리는 로그인; 웹은 연결이 1초 넘게 걸리면 1초마다 묻고 화면 위 알림에서 로그인 페이지를 연다), `DELETE /api/oidc/logins?id=` → `{ ok }`(취소, 연결은 "브라우저 로그인을 취소했습니다"로 실패). IdP는 브라우저를 `GET /api/oidc/callback?state&code`(이 서버의 `http://127.0.0.1:<포트>`)로 돌려보낸다. 이 경로만 토큰 없이 받고 기다리는 로그인의 `state`가 아니면 400. 받은 코드는 토큰 끝점에서 액세스 토큰으로 바꾸고, refresh token이 있으면 다음에는 브라우저 없이 갱신한다. 5분(드라이버 제한)이 지나면 실패. IdP 요청은 Mozilla 루트와 시스템 루트 인증서(사내 CA)를 믿고, `SSL_CERT_FILE`·`SSL_CERT_DIR`이 있으면 시스템 대신 그 인증서를 쓴다.

구현에서 정한 세부(4단계 서버):

- 쿼리 옵션: `collation`은 `locale`이 있는 문서(없거나 틀리면 `bad_request`), `hint`는 빈 문자열이면 없는 것으로 본다. `count`의 `maxTimeMS`는 조건이 있을 때 3초 제한을 대신하고(넘기면 그대로 `{ count: null, exact: false }`), 빈 조건(`estimatedDocumentCount`)에는 `maxTimeMS`만 쓰고 `collation`·`hint`는 무시한다. `explain`은 `collation`·`hint`를 설명할 `find`/`aggregate` 명령에, `maxTimeMS`는 `explain` 명령에 붙인다. 콘솔에는 `find(…).collation({…}).hint(…).maxTimeMS(n)`, `aggregate([…], { collation, hint, maxTimeMS })`, `countDocuments(…, { …, maxTimeMS })`로 남는다.
- 쓰기의 `collation`·`hint`: `update`·`replace`·`delete`가 드라이버의 같은 옵션으로 보내고, 콘솔에는 세 번째(삭제는 두 번째) 인자로 남는다(`updateMany({…}, {…}, { upsert?, collation, hint })`, `deleteMany({…}, { collation })`). `update/preview`는 개수 세기와 앞 몇 건 찾기에 둘 다, 한 건씩 고치는 `updateOne`에는 `collation`만 쓴다.
- `update/preview`: `limit`은 1~20(기본 5, 벗어나면 `bad_request`). 빈 `filter`도 `confirmed` 없이 받는다(아무것도 남기지 않으므로). `matched`는 `countDocuments`(3초 제한)이고 넘기면 `null`. 앞 `limit`건을 `_id` 하나씩 `{ $and: [filter, { _id }] }`로 고치고(위치 연산자 `$`가 그대로 동작) 다시 읽은 뒤 늘 `abortTransaction`한다. 미리보기 중 문서가 사라지면 `after`는 `null`. 콘솔에는 `countDocuments`와 `// 미리보기: …abortTransaction()` 한 줄이 남고, 실행 기록에는 남지 않는다. 연결의 실행 게이트 안에서 읽기처럼 돈다(취소 가능).
- 검색 인덱스: 목록은 서버가 준 문서를 그대로(`id`·`name`·`type`·`status`·`queryable`·`latestDefinition`…, `type`이 없으면 `"search"`) 보낸다. `type`은 `search`·`vectorSearch`만 받는다. Atlas Search가 없는 서버의 오류(`31082` SearchNotEnabled, `6047401` Atlas 전용 단계, 오래된 서버의 `40324`·`59`·`115`)는 `unsupported_capability`(메시지에 원문 포함)로 바꾼다. 만들기·고치기·삭제는 콘솔과 실행 기록에 `createSearchIndex({ name, type?, definition })`·`updateSearchIndex(name, definition)`·`dropSearchIndex(name)`로 남는다.
- `watch`: 열리자마자 `{"$heartbeat": <에포크 ms>}` 한 줄을 먼저 보내고 이후 15초마다 보낸다. 단일 서버는 열기 전에 `unsupported_capability`. 잘못된 `fullDocument`(`updateLookup`·`whenAvailable`·`required`, `default`는 생략과 같음)·`fullDocumentBeforeChange`(`whenAvailable`·`required`·`off`)·`resumeAfter`는 `bad_request`. 스트림 중간 실패는 마지막 줄 `{"$error": { code, message }}`, 스트림이 끝나면(컬렉션 삭제 등 `invalidate` 뒤) 연결을 닫는다. `coll`이 없으면 데이터베이스 전체를 본다. `export`처럼 실행 게이트 밖에서 돌고, 페이지가 연결을 끊으면 다음 줄(늦어도 하트비트)을 보내지 못해 서버 커서가 닫힌다.
- GridFS: 올리기는 본문을 받는 대로 청크(255 KiB)로 써서 파일 전체를 메모리에 두지 않고, 본문이 중간에 끊기면 이미 쓴 청크를 지운다. 내려받기도 청크 단위로 읽어 보낸다. 둘 다 실행 게이트 밖에서 돈다. 응답 헤더는 `Content-Type`(파일 문서의 `contentType`, 없으면 `application/octet-stream`)·`Content-Length`·`Content-Disposition: attachment; filename*=UTF-8''…`. 없는 파일은 404 `not_found`. 내려받기만 `token`을 쿼리로 받는다(`<a download>` 링크용, 헤더도 된다). `metadata`는 canonical EJSON 텍스트, `files`는 `.files` 문서를 그대로(`contentType`·`md5` 등 포함). 콘솔과 실행 기록에는 `mongofiles --db=… --prefix=<버킷> put|get_id|delete_id …`로 남는다(`put` 뒤 `# metadata: {…}`). 버킷은 `<이름>.files`와 `<이름>.chunks`가 둘 다 있는 이름.
- 서버 커서: 연결(슬롯)마다 표에 두고 드라이버 커서를 그대로 열어 둔다. 끝까지 읽으면(`done: true`), `close`, 연결을 닫을 때, 10분 동안 읽지 않으면(30초마다 확인) 닫히고, 서버의 커서도 함께 닫힌다(`killCursors`). 연결마다 32개까지, 넘으면 가장 오래 읽지 않은 것을 닫는다. 첫 배치에서 끝나면 `id`는 `null`(닫을 것이 없음). `next`의 `batchSize`를 빼면 열 때의 크기. 없거나 닫힌 `id`는 404 `not_found`, 같은 커서를 동시에 읽으면 `cursor_busy`, 읽다 실패하면 그 오류를 보내고 커서를 닫는다. 콘솔에는 열 때 한 번 `find(…)….batchSize(n)` / `aggregate([…], { …, batchSize: n })`로 남는다. `$out`·`$merge` 집계는 `confirmed: true`가 있어야 하고 쓰기로 돌며(실행 게이트 안, 실행 기록에 남음) 그 밖의 커서는 `export`처럼 게이트 밖에서 읽는다(`find`의 `limit`이 없거나 0이면 전부, `aggregate` 결과는 10,000건 제한이 없음).

구현에서 정한 세부(4단계 화면):

- 일괄 수정·삭제: 문서 탭 도구 줄의 `일괄 수정`·`일괄 삭제`(뷰·읽기 전용 연결에는 없음)가 같은 창을 열고, 창 위에서 수정/삭제를 바꿀 수 있다. 필터는 쿼리 막대의 지금 필터 글로 시작하고 창에서 고쳐도 쿼리 막대는 그대로다. 쿼리 막대 `옵션`의 collation·hint는 창을 열 때 정해져 수 세기·미리보기·실행(`update`·`delete`·`update/preview`)에 함께 가고, 보낼 명령에 mongosh의 셋째(삭제는 둘째) 인자 `{ collation, hint }`로 보인다(시간 제한은 보내지 않는다). 수정 내용은 연산자 문서(`{ $set: { } }` 틀, 키는 모두 `$`로 시작, 빈 연산자 거절) 또는 파이프라인(단계마다 연산자 하나). 입력이 0.5초 멈추면 `count`로 영향받는 문서 수를, 수정은 `update/preview`로 앞 5·10·20건의 전·후를(필드마다 바뀜 노랑·추가 초록·삭제 빨강, 중첩 문서는 안으로 펼침, `바뀐 필드만`), 삭제는 `find`로 지워질 앞 몇 건을 다시 읽는다. `⌘↩`는 바로 다시. `previewed: false`면 단일 서버라 트랜잭션이 없어 미리 볼 수 없다고 말하고 바뀔 문서의 지금 모습을 `find`로 보여준다. 실행은 `updateMany`/`deleteMany`에 늘 `confirmed: true`를 붙이고, 안전 모드 확인은 mongosh 탭과 같은 규칙이다(빈 필터는 수준 1·2에서 위험, 수준 2는 모든 일괄 쓰기). 결과(일치·수정 또는 삭제 수)를 창 아래에 보이고 문서 페이지와 통계를 다시 읽는다. 영향받는 문서가 0개면 실행 단추가 꺼진다.
- mongosh 스크립트(`shell/worker.ts`, `shell/script.ts`): 실행마다 새 Worker 하나. `use x`·`show dbs|collections` 줄은 실행 전에 `use("x")`·`show` 호출로 바꾸고(줄 번호 유지), 나머지는 간접 `eval`로 돌려 마지막 문장의 값을 최종 값으로 보인다. 숫자는 Node 드라이버처럼 32비트 정수면 Int32, 그 밖은 Double, `bigint`는 Int64, `Date`·`RegExp`는 BSON 날짜·정규식. 읽은 문서는 필드 순서를 지킨 평범한 객체(Int32·Double은 숫자, 날짜는 `Date`, Int64·Decimal128 등은 BSON 값). BSON 생성자는 앱의 mongosh 표기·코드 내보내기가 쓰는 것을 모두 읽는다(`ObjectId`, `ISODate`, `NumberLong`/`Long`, `NumberInt`/`Int32`, `Double`, `NumberDecimal`/`Decimal128`, `UUID`, `BinData`, `Binary.createFromBase64`, `Timestamp`, `Code`, `BSONRegExp`, `MinKey`/`MaxKey`). `find`·`aggregate` 커서는 서버 커서(`/api/doc/cursor/open`·`next`·`close`)를 1,000개씩 읽고, 스크립트가 끝나면 열린 커서를 닫는다(멈춘 Worker의 커서는 서버의 유휴 시간 초과로 닫힘). 최종 값이 커서면 앞 1,000개를 보인다. 출력은 `print` 줄 텍스트, `printjson`·객체 하나를 `print`한 값·최종 값은 값으로 메시지에 쌓이고 문서인 값은 `결과 보기`·`출력 n` 고르기로 ☰ {} ⊞ 보기에 연다. 출력은 1,000개·16 MB까지(최종 값은 늘 보임). 시간 제한은 설정 `쿼리 시간 제한`(기본 60초, 0이면 없음, 컬렉션 탭 쿼리의 `maxTimeMS` 기본값도 이것)이고 읽기마다 남은 시간을 `maxTimeMS`로 보낸다. 멈춤·시간 초과는 Worker를 끝낸다. 안전 모드가 켜져 있으면 확인 창이 필요한 쓰기(단독 실행 규칙과 같고, 더해 `$out`·`$merge` 집계와 확인이 필요한 `runCommand`)는 보내지 않고 "이 문장만 따로 실행하거나 안전 모드를 끄라"는 오류로 멈추며, 꺼져 있으면 쓰기에 `confirmed: true`를 붙인다. 스크립트가 시작하기 전에 네트워크·저장소 전역(`fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`, `indexedDB`, `caches`, `navigator`, `postMessage` …)을 지우고, 토큰은 모듈 안에만 두어 미리 잡아 둔 요청 함수에만 넘긴다.
- 검색 인덱스: 인덱스 탭의 인덱스 표 아래 `검색 인덱스` 구역. 이름·종류(`search`·`vectorSearch`)·상태(READY 초록, FAILED 빨강, 그 밖은 만드는 중 노랑)·조회 가능·정의 한 줄. 만드는 중이거나 지우는 중인 인덱스가 있으면 5초마다 다시 읽는다. 만들기·고치기 창은 이름·종류(고치기에서는 둘 다 고정)와 정의 편집기(mongosh 표기 또는 JSON)에 틀 세 가지(동적 매핑, 필드 매핑 — 표본의 첫 최상위 필드, 벡터 검색 — `path`·`numDimensions`·`similarity`를 칸에서 받아 `{ fields: [{ type: "vector", … }] }`)와 보낼 명령. 삭제는 확인 창 뒤 `confirmed: true`. `unsupported_capability`면 오류 대신 "이 서버에서는 검색 인덱스를 쓸 수 없습니다"와 쓸 수 있는 곳을 적은 안내만 보이고 만들기 버튼은 숨긴다.
- 변경 보기: 컬렉션 탭의 하위 탭(뷰에는 없음)과 사이드바 데이터베이스 메뉴의 `변경 보기`(데이터베이스 전체, 탭 하나, 컬렉션 열이 붙음). 세션은 탭마다 페이지가 살아 있는 동안 남고(`changeStream.ts`), 스트림은 그 화면이 보일 때만 열려 있다. 다른 탭·하위 탭으로 가면 닫고, 돌아오면 마지막으로 받은 이벤트의 `_id`를 `resumeAfter`로 다시 열어 그 사이의 변경도 받는다. 연결이 끊기거나 `$error`가 오면 1·2·5·10·30초 간격으로 같은 방법으로 다시 붙는다(`unsupported_capability`·`bad_request`·`invalid_token`·`not_found`·`mongo_286`·`mongo_280`·`mongo_13`·`mongo_47`은 멈추고 오류를 보인다; `다시 시도`는 토큰 없이 새로 연다). `invalidate` 뒤 서버가 닫으면 "서버가 스트림을 닫았습니다". 작업 종류(insert·update·replace·delete·기타) 필터는 파이프라인 `$match`가 아니라 받은 뒤 거른다: 걸러지는 이벤트의 토큰으로 다시 열면 MongoDB 7이 "resume token was not found"로 거절하기 때문이다. 그래서 필터를 바꿔도 스트림은 다시 열지 않고, `바뀐 뒤 문서`(`fullDocument: "updateLookup"`)·`바뀌기 전 문서`(`fullDocumentBeforeChange: "whenAvailable"`, 컬렉션에 `changeStreamPreAndPostImages`가 켜져 있어야 옴)를 바꾸면 마지막 이벤트 뒤부터 다시 연다. 목록은 최신이 위, 최대 1,000개(넘친 수 표시). 줄은 시각(`wallTime`, 없으면 `clusterTime`)·종류·`_id`·요약(설정·제거한 필드, 필드 수, rename 대상), 펼치면 바뀐 필드의 전·후 표(전 값은 변경 전 문서에서 경로로 찾음), 변경 전·후 문서, 원본 이벤트와 복사. 이벤트는 애니메이션 프레임마다 묶어 그린다. `멈춤`은 토큰을 지켜 `시작`이 이어 받고, `비우기`는 목록만 비운다.
- GridFS: 사이드바는 `<b>.files`·`<b>.chunks`가 함께 있는 이름을 `GridFS` 배지가 붙은 버킷 줄 하나로 보이고(수는 파일 수), 누르면 버킷 탭, 화살표로 두 컬렉션을 펼친다. 버킷 탭은 파일 표(이름·크기·올린 때·콘텐츠 유형 — 최상위 `contentType`, 없으면 `metadata.contentType` — ·메타데이터, 머리글 눌러 정렬, 50개씩 쪽, 전체 수는 `.files`의 `count`). 검색 칸은 글이면 파일 이름 대소문자 무시 부분 일치(`$regex`), `{`로 시작하면 필터 문서. 내려받기는 `token`을 쿼리에 단 링크라 브라우저가 바로 받는다. 올리기는 파일 고르기(여러 개)나 목록 위 끌어 놓기, 파일마다 진행 막대·취소, 한 번에 하나씩 보내고(XHR `upload.onprogress`) 브라우저가 아는 MIME 형식을 `metadata.contentType`에 담는다. 삭제는 확인 창(`mongofiles … delete_id` 미리보기) 뒤. `보기`는 파일 문서 전체를 읽기 전용 필드 보기로.
- 쿼리 옵션: 쿼리 막대 `옵션`의 둘째 줄(`QueryOptionsRow.tsx`). collation은 로캘(자주 쓰는 로캘 제안, 아무 지원 로캘이나 써도 됨)과 강도(기본·1~5) — 로캘 없이 강도만 고르면 쿼리 막대 오류. hint는 컬렉션 인덱스 이름 고르기(뷰는 목록이 비어 있음) 또는 `키 문서로 쓰기…`를 고르면 `{ … }` 편집기(빈 문서는 오류). maxTimeMS는 1 이상의 정수(밀리초)로, 비우면 설정의 쿼리 시간 제한을 쓴다. 세 가지는 쿼리 글과 함께 탭 상태(`doc.query`·`doc.applied`)와 최근 실행·즐겨찾기에 남고(이전에 저장된 쿼리는 빈 칸으로 읽음), 초기화가 함께 지운다. 문서 페이지의 `find`, 전체 수 `count`(maxTimeMS가 있으면 3초 제한을 대신함), `정확히 세기`, 실행 계획의 `explain`, 내보내기(`export`, 예상 수의 `count`는 collation·hint만, CSV 필드 표본 `find`)에 붙고, 보낼 명령·실행 계획 줄에 `.collation({…}).hint(…).maxTimeMS(n)`으로 보인다.
- 코드로(`codegen.ts`, `CodeExportModal.tsx`): 문서 탭 도구 줄 `코드로`는 쿼리 막대의 지금 쿼리(글이 틀리면 마지막으로 실행한 쿼리)를 옵션과 함께, 집계 탭 `코드로`(이전 `mongosh 코드` 자리)는 켜진 단계의 파이프라인을 코드로 만든다. 언어는 mongosh·Python(PyMongo)·Node.js(ESM)·Java(sync, `Document`)·C#(.NET, 최상위 문장)·Go(driver v2, maxTimeMS는 컨텍스트 마감으로)·Rust(`mongodb` 3, `doc!`)·PHP(`mongodb/mongodb`)·Ruby. 값은 언어마다 그 타입으로 쓴다: ObjectId, Int64(`Int64(…)`·`Long`·`5L`·`int64(…)`·`_i64`…), 정수인 Double(`Double(3)`·`3.0`…), Decimal128, 날짜(달력으로 나타낼 수 없는 해는 ms), 정규식(BSON 정규식 타입; JS·mongosh 리터럴은 패턴에 `/`가 없을 때만), Binary·UUID(subtype 4), Timestamp, Code, MinKey/MaxKey. `접속 코드 포함`이면 연결 설정(`/api/connection-info`: 저장된 연결은 저장 프로필, 저장하지 않은 연결은 연 설정, 비밀은 서버가 뺌)으로 만든 접속 문자열(비밀번호 자리는 `<password>`, 인증 방식별 `authMechanism`·`authSource`·속성)로 접속·실행·출력까지 하는 프로그램, 끄면 연결된 `client`가 있다고 보고 쿼리 부분만. 언어와 접속 코드 선택은 localStorage에 남는다. mongosh는 `mongosh 탭에서 열기`도 된다. 커서 메서드는 호출의 마지막 줄에 붙인다(mongosh 프롬프트는 `.`으로 시작하는 줄을 REPL 명령으로 읽는다). 각 언어 코드는 테스트 DB에서 실제로 컴파일·실행해 모든 타입이 같은 BSON 타입·값으로 가는지 확인했다(`$type`·`$eq`로).
