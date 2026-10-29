# MongoDB 지원 사양

작성: 2026-10-28 · 상태: 1단계 구현 대상 · 화면 기준: `prototypes/mongodb/tablepeek-mongodb.html`

목표는 **MongoDB Compass의 기능을 모두 갖추되 더 직관적이고 실용적인 것**이다. 엔진 구조는 `docs/ENGINES.md`를 따른다(엔진 id `mongodb`, 패러다임 `document`).

## 1. 범위와 단계

| 단계 | 범위 |
|---|---|
| 1 | 엔진 구조 전환 위에서: 접속, 데이터베이스·컬렉션 목록, 문서 탭(목록·JSON·표+오른쪽 패널), 쿼리 막대, 충돌 감지 편집, 문서 추가·복제·삭제, 인덱스 탭(보기·만들기·삭제), 실행 계획 탭(실제 `explain`), mongosh 탭(명령 일부), 콘솔 기록, 안전 모드 |
| 2 | 집계 편집기, 스키마 탭, 검증 탭 |
| 3 | 가져오기·내보내기, 데이터베이스·컬렉션 관리, 성능 화면, MCP 읽기 전용 도구 |

## 2. 접속

- 엔진 정의 필드(폼에 나오는 순서): 연결 문자열(`mongodb://`, `mongodb+srv://`, 붙여 넣으면 나머지 칸을 채움), 호스트·포트(27017), **인증 방식**(없음 / 사용자·비밀번호 / X.509, 기본 없음), 데이터베이스(선택: 처음 열 데이터베이스), TLS(끔/켬 + CA·클라이언트 인증서), `directConnection`, 고급: 레플리카셋 이름·읽기 선호.
- 인증 방식에 따라 보이는 칸(Compass와 같은 구성):
  - 없음: 인증 칸이 하나도 없다. 호스트나 연결 문자열만으로 연결한다. 서버는 저장돼 있던 사용자·비밀번호(키체인 포함)와 연결 문자열 속 사용자를 모두 무시하고 인증 없이 연결한다.
  - 사용자·비밀번호: 사용자(연결에 필요), 비밀번호(키체인 저장/매번 입력), 인증 DB(`authSource`, 기본 `admin`), SCRAM 방식(기본은 서버가 고름 / SCRAM-SHA-256 / SCRAM-SHA-1). 연결 문자열의 다른 방식(`authMechanism=PLAIN` 등)도 이 선택으로 쓴다.
  - X.509: 클라이언트 인증서·키 파일 칸이 보이고 TLS가 켜진다. 서버는 비밀번호를 보내지 않고 TLS를 항상 켜며, 인증서 파일(폼이나 연결 문자열의 `tlsCertificateKeyFile`)이 없으면 "X.509 인증에는 클라이언트 인증서·키 파일이 필요합니다"로 막는다.
- 연결 문자열을 붙여 넣거나 입력하면 인증 방식이 따라 바뀐다: `authMechanism=MONGODB-X509`면 X.509, 사용자(`user@`)가 있으면 사용자·비밀번호, 없으면 없음.
- 비밀번호는 사용자·비밀번호일 때만 묻는다. 저장된 연결을 열 때 다른 방식이면 키체인을 읽지도, 비밀번호를 묻지도 않는다. 없음·X.509 프로필은 숨은 저장 방식 선택과 상관없이 비밀번호를 키체인에 두지 않는 것으로 저장되고(`persist_password: false`, 터널이 있으면 터널 비밀번호만 둠), 목록에도 `has_password: false`로 나간다.
- 인증 방식(`auth`)이 없는 예전 프로필은 읽을 때와 저장할 때 채운다: 인증 방식이 `MONGODB-X509`(칸이나 연결 문자열)면 X.509, 사용자나 비밀번호가 있으면(연결 문자열의 사용자 포함) 사용자·비밀번호, 아니면 없음. API로 `auth` 없이 연결해도 같은 규칙을 쓴다.
- 1단계 인증: 인증 없음, 사용자/비밀번호(SCRAM-SHA-1/256), X.509. AWS IAM·LDAP·Kerberos·OIDC는 이후 인증 방식의 선택지로 더한다.
- SSH·HTTP 터널은 **호스트 하나**일 때만 쓴다. `mongodb+srv://`나 호스트가 여럿인 연결에 터널을 켜면 "터널은 단일 호스트 연결에서만 쓸 수 있습니다"로 막는다. 터널을 쓸 때는 `directConnection=true`를 넣는다.
- 연결 문자열에 든 비밀번호(`user:password@`)는 저장하지 않는다. 저장할 때 서버가 문자열에서 비밀번호를 빼고(사용자는 남김), 비밀번호 칸이 비어 있으면 그 칸으로 옮겨 다른 비밀번호처럼 키체인에 두거나 매번 묻는다. 연결 목록·내보내기 파일에도 문자열은 비밀번호 없이 나가고, 콘솔·실행 기록·오류 메시지에서는 URL 비밀번호를 `****`로 가린다. 저장하지 않고 바로 연결할 때는 문자열 속 비밀번호를 그대로 쓴다. (`uri` 종류 필드가 있는 모든 엔진에 같은 규칙.)
- 드라이버: 공식 `mongodb` 크레이트(tokio). 서버 선택 시간 제한 5초, 쿼리마다 `maxTimeMS`(설정의 쿼리 시간 제한).
- 능력: `language: "mongo"`, `objects: ["collection","view"]`, `schema: "sampled"`, `edit_by_key: true`, `foreign_keys: false`, `ddl: false`, `databases: "switch"`, `transactions`: 접속한 토폴로지가 레플리카셋·샤드면 `"replica_set"`, 단일 서버면 `"none"`, `explain: "mongo"`, `indexes: { create, drop }`, `validation: true`, `aggregation: true`, `exact_count: false`(필터 없을 때 `estimatedDocumentCount`), `dump: "ejson"`.

## 3. 화면

### 3.1 사이드바
데이터베이스 → 컬렉션(문서 수), 뷰(표시 `뷰`). 검색, 데이터베이스·컬렉션 우클릭 메뉴(1단계: 열기, 새 쿼리 탭, 새로 고침; 3단계: 만들기·이름 바꾸기·삭제).

### 3.2 컬렉션 탭
- 위: 하위 탭 `문서 | 인덱스 | 실행 계획` (2단계에 `집계 | 스키마 | 검증` 추가) + 통계 칩(문서 수, 크기, 평균 크기, 인덱스 수·크기).
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
JavaScript를 실행하지 않는다. 다음 명령만 해석해 구조화된 요청으로 보낸다: `use`, `show dbs|collections`, `db.<c>.find(filter, projection).sort().skip().limit()`, `findOne`, `countDocuments`, `estimatedDocumentCount`, `distinct`, `aggregate([...])`, `insertOne/Many`, `updateOne/Many`, `replaceOne`, `deleteOne/Many`, `createIndex`, `dropIndex`, `getIndexes`, `drop`, `stats`, `.explain()`. 값 표기: 완화된 EJSON(따옴표 없는 키, 작은따옴표, 끝 쉼표, `ObjectId()`, `ISODate()`, `new Date()`, `NumberDecimal()`, `NumberInt()`, `NumberLong()`, `/re/flags`). 그 밖의 입력(변수, 함수, 반복문)은 "지원하지 않는 mongosh 문법입니다: …"로 위치와 함께 알린다. 결과는 같은 세 가지 보기. 해석기는 웹(`web/src/engines/mongodb/shell/`)에 있고 서버에는 구조화된 요청만 간다.

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
| `GET /api/doc/perf` | — | `{ time, uptime, opcounters, opcountersRepl?, connections, network, mem, wiredTiger?: { cacheBytes, cacheMax, dirtyBytes }, globalLock?: { activeReaders, activeWriters, queueReaders, queueWriters } }` (`serverStatus` 일부, 웹이 2초마다 불러 차이로 초당 값 계산) |
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
- **성능**: 연결의 ⋯ 메뉴 "성능" 탭. 2초마다 `perf`로 초당 작업 수(insert·query·update·delete·getmore·command), 연결 수, 네트워크 입출력, 메모리·캐시 사용 그래프(최근 5분), 현재 작업 목록(`currentOp`: 작업·ns·실행 시간·클라이언트·계획 요약, 오래 걸리는 순, 작업 종료 `killOp` 확인), 컬렉션별 읽기/쓰기 시간(`top`), 느린 작업(`profile` 수준 보기·바꾸기, `system.profile` 최근 50건). 일시 정지.
- **MCP**: 읽기 전용 도구 `mongo_list_collections`, `mongo_find`(limit ≤ 100), `mongo_aggregate`(`$out`·`$merge` 거절), `mongo_schema`(표본 분석 요약), `mongo_indexes`. 쓰기 도구는 없다.

## 7. 테스트

- `testdb/compose.yml`에 `mongodb`(7.x, 레플리카셋 1노드로 띄워 트랜잭션·`$indexStats` 확인 가능), 샘플 `shop` 데이터(시안과 같은 생성 규칙).
- 엔진 테스트(`TABLEPEEK_TEST_MONGODB=1`): 접속, 목록, find/aggregate/count, 타입 왕복(Decimal128·Int64·Date·ObjectId·Binary), 충돌 감지(동시 수정 시 `matched 0`), 인덱스 만들기·삭제, explain.
- 서버 테스트: API 형식, 빈 조건 `many` 거절, 오류 코드.
- 화면: 시안의 각 동작을 실제 서버로 다시 확인.
