# ClickHouse

작성: 2026-10-29 · 상태: 구현됨

엔진 정의 `clickhouse`(별칭 `ch`), 드라이버 `crates/tablepeek-engine/src/engines/clickhouse/`, 웹 `web/src/engines/clickhouse/`. 패러다임은 `sql`이고 SQL 작업 화면을 그대로 쓴다.

## 1. 범위

- 지원 서버: ClickHouse 22.x 이후(시험은 25.8). HTTP 인터페이스(기본 8123, HTTPS 8443)로 접속한다. 네이티브 TCP 프로토콜(9000)은 쓰지 않는다.
- HTTP 클라이언트는 엔진 크레이트가 이미 쓰는 `reqwest`(rustls)다. 새 의존성은 없다. 공식 `clickhouse` 크레이트는 결과를 미리 정한 Rust 타입으로만 읽어 임의의 쿼리를 보여줄 수 없어 쓰지 않는다.
- 결과는 `JSONCompactEachRowWithNamesAndTypes`로 받아 줄 단위로 읽는다. 64비트 정수·Decimal은 문자열로 받아 정확한 값을 지키고, i64에 들어가는 정수는 숫자로 바꾼다. 최대 행 수를 넘으면 응답을 읽다 끊고(`cancel_http_readonly_queries_on_client_close`) 결과에 "잘림"을 표시한다. 문장이 `FORMAT CSV`처럼 형식을 스스로 정하면 그 출력을 한 줄씩 한 열(형식 이름)로 보인다.
- 편집기 문장은 HTTP 세션 하나(`session_id`)에서 돌아 `USE`·`SET`이 다음 문장까지 이어진다. 세션은 문장을 하나씩만 받으므로 드라이버가 차례를 지킨다. 카탈로그 읽기·편집·내보내기는 세션 밖에서 현재 데이터베이스를 지정해 보낸다.

## 2. 접속

| config 키 | 뜻 |
|---|---|
| `host`, `port` | 기본 `127.0.0.1`, `8123`. HTTPS는 보통 `8443` |
| `user` | 기본 `default` |
| `password` (비밀) | `X-ClickHouse-Key` 헤더로 보낸다(URL에 넣지 않는다) |
| `database` | 접속 후 `USE`로 세션의 데이터베이스가 된다. 비우면 사용자의 기본 데이터베이스 |
| `tls` | bool. 켜면 `https` |
| `tls_ca_file` | PEM CA(여러 인증서 가능). 없으면 시스템 루트 |
| `tls_skip_verify` | bool. 인증서를 검사하지 않음(개발용, 고급) |
| `cluster` | 클러스터 이름(고급). 앱이 쓰는 구조 변경의 기본 `ON CLUSTER`(§5) |

- 연결 URL `clickhouse://user:pw@host:8123/db`(또는 `ch://`)를 호스트 칸에 붙여 넣으면 칸이 채워진다. `?secure=true`는 읽지 않으니 HTTPS는 토글로 켠다.
- SSH·HTTP 터널: 터널 끝이 IP면 원래 호스트 이름을 그 주소로 풀어(`resolve`) 보내므로, HTTPS 인증서 이름 검사(SNI 포함)가 터널을 지나도 원래 이름으로 된다. reqwest는 URL의 포트로 접속하므로 URL 포트는 터널 끝의 포트이고, `Host` 헤더는 설정의 `호스트:포트`를 그대로 보낸다(§10에서 SSH 서버와 HTTP 프록시를 지나 `clickhouse.tablepeek.test`로 확인, 인증서에 없는 이름은 거절).
- 접속할 때 `SELECT version(), currentDatabase(), getSetting('readonly')`를 읽는다. 읽기 전용 계정(`readonly` ≠ 0)이면 편집·DDL·사용자·인덱스·가져오기가 꺼지고, `system.users`를 읽을 수 없는 계정이면 사용자 관리가 꺼진다(`meta.capabilities`).

## 3. 능력

| 능력 | 값 | 비고 |
|---|---|---|
| `language` | `sql` | 백틱·`"…"` 이름, 백슬래시 이스케이프 문자열, `#`·`--` 주석, `$$` 히어독 |
| `objects` | `table`, `view`, `materialized_view`, `dictionary`, `function` | 함수는 SQL 사용자 정의 함수(`system.functions`의 `SQLUserDefined`) |
| `schema` | `declared` | `system.columns` |
| `edit_by_key` | true (읽기 전용 계정은 false) | 정렬 키로 행을 찾는다(§4) |
| `transactions` | `none` | 적용·가져오기·복원이 트랜잭션 없이 돈다 |
| `foreign_keys` | false | ER 다이어그램·외래 키 이동 없음 |
| `ddl` | true | 아래 §5 |
| `databases` | `switch` | `system.databases`; 전환은 그 데이터베이스로 다시 접속 |
| `users` | true (권한에 따라) | `CREATE USER … IDENTIFIED WITH sha256_password` |
| `explain` | `clickhouse` | §6 |
| `exact_count` | true | `count()` |
| `dump` | `sql` | `SHOW CREATE TABLE` + INSERT |
| `import_formats` | csv, json, sql | CSV·JSON은 `INSERT … FORMAT CSV`로 1만 행씩 |
| `export_formats` | csv, json, sql, xlsx | 테이블의 CSV·JSON은 서버가 직접 쓴다(§7) |
| `sessions` | `{ kill: true }` | `system.processes`, `KILL QUERY WHERE query_id = …` |
| `validation`, `aggregation` | false | |
| `indexes` | `{ create: true, drop: true }` | 데이터 스킵 인덱스(`minmax`) |

## 4. 행 편집

ClickHouse에는 고유 키가 없다. 데이터 탭은 테이블의 **정렬 키**(`ORDER BY`) 컬럼을 키로 쓰고, MergeTree 계열 테이블과 그 위의 Distributed 테이블에서 편집을 연다(뷰·딕셔너리·Memory·Log 등은 읽기만).

- **같은 키의 행 가르기**: 정렬 키가 있는 테이블의 데이터 탭은 컬럼 뒤에 가상 컬럼 `_part`(행이 있는 데이터 파트)와 `_part_offset`(파트 안의 자리)을 함께 읽는다(`SqlDialect.rowIdentity`). 드라이버는 결과에 둘이 있으면 키 뒤에 붙이고, 편집·삭제는 키와 함께 그 파트·자리로 행을 찾는다. 뮤테이션(셀 수정, 경량 DELETE)은 파트 이름 끝에 뮤테이션 번호를 붙여 바꾸지만 행의 자리는 그대로이므로, 조건은 `_part = 'p' OR startsWith(_part, 'p_')`(`p` = `파티션_최소_최대_레벨`)로 이름 바뀐 같은 파트도 찾는다. 23.3 전 서버는 삭제가 파트에서 행을 빼므로 읽은 이름 그대로만 찾는다. 내보내기는 두 컬럼을 뺀다. 쿼리 편집기 결과는 SELECT에 `_part, _part_offset`을 더하면 같다.
- **다시 찾기**: 편집·삭제는 그 행의 모든 컬럼을 그리드가 마지막으로 안 값(`seen`, docs/ENGINES.md §4.1; 읽은 값에 같은 적용이 이미 쓴 값을 반영)을 함께 보낸다. 병합(백그라운드, `OPTIMIZE`)으로 새 파트가 되어 파트·자리로 찾지 못한 행, 또는 파트·자리 없이 키만 있어 여러 행이 맞는 경우, 드라이버는 정렬 키 + 모든 값(`col = CAST(…)`, NULL은 `isNull`)으로 다시 세어 **정확히 한 행**일 때 그 조건으로 바꾼다. 값이 모두 같은 행이 여럿이면 거절하고("정렬 키와 모든 컬럼 값이 같은 행이 여럿…"), 값이 이미 바뀌었으면 0행이다. 같다고 비교할 수 없는 타입(AggregateFunction, JSON·Object·Dynamic·Variant, 지오 타입, 배열·맵 안의 튜플)은 조건에서 빠진다.
- 편집·삭제 전에 지금의 정렬 키가 그리드가 받은 키와 같은지 확인하고, 그 조건에 맞는 행을 센다. 정확히 1개일 때만 바꾸고, 0개면 아무것도 바꾸지 않으며(0행), 2개 이상이면(위의 값으로도 가를 수 없으면) 거절한다.
- **사이드바가 아직 모르는 테이블**(막 만든 테이블): 데이터 탭은 첫 페이지 전에 `/api/table`로 정렬 키를 읽어, 첫 페이지부터 `_part, _part_offset`을 함께 읽는다.
- 셀 수정: 25.7 이후 서버에서 테이블이 `enable_block_number_column = 1`, `enable_block_offset_column = 1`이면(`system.tables.create_table_query`로 확인, 만든 뒤 `MODIFY SETTING`으로 켠 것도) **경량 UPDATE** `UPDATE … SET col = CAST(값 AS 타입) WHERE …`(`allow_experimental_lightweight_update = 1`; 패치 파트를 써서 바로 끝난다). 아니면 `ALTER TABLE … UPDATE … WHERE … SETTINGS mutations_sync = 2` **뮤테이션**이라 데이터 파트를 다시 쓰고, 끝날 때까지 기다린다. 구조 탭의 테이블 속성 "경량 UPDATE: 꺼짐" 옆 **켜기**가 설명과 확인 뒤 `ALTER TABLE … MODIFY SETTING enable_block_number_column = 1, enable_block_offset_column = 1`을 실행해 이후 셀 수정을 경량 UPDATE로 바꾼다(§5). 정렬·파티션 키 컬럼은 서버가 거절한다(오류 도움말이 설명).
- 행 삭제: 23.3 이후 MergeTree는 경량 `DELETE FROM … WHERE …`, 그 전 서버는 `ALTER TABLE … DELETE`. 둘 다 `mutations_sync = 2`로 기다린다.
- 행 추가: `INSERT INTO … VALUES (CAST(…), …)`. 모든 컬럼이 기본값이면 `INSERT … FORMAT JSONEachRow {}`.
- 값은 그리드가 보인 글자를 컬럼 타입으로 `CAST`한다. Array·Map·Tuple은 그리드가 JSON으로 보이므로, JSON으로 고친 값은 ClickHouse 리터럴(`[…]`, `map(…)`, `tuple(…)`)로 바꿔 보낸다. Set Value의 NOW는 `now64(6)`, DEFAULT는 컬럼의 DEFAULT 식(없으면 타입의 기본값).
- **여러 셀 적용의 되돌리기**: 트랜잭션이 없어, 한 번에 적용하던 중 한 문장이 실패하면 웹이 그 앞에 들어간 변경을 거꾸로 되돌린다(셀은 원래 값으로, 지운 행은 다시 넣고, 추가한 행은 지운다; docs/ENGINES.md §4.1 보상 되돌리기). 오류 메시지가 되돌린 변경과 되돌리지 못한 변경·이유를 적는다.
- **클러스터의 행**: Distributed 테이블의 편집·삭제는 그 엔진이 가리키는 로컬 테이블로 가서 `ALTER TABLE 로컬 ON CLUSTER c UPDATE …`·`UPDATE 로컬 ON CLUSTER c SET …`·`DELETE FROM 로컬 ON CLUSTER c …`가 된다(키는 로컬 테이블의 정렬 키이고, 구조 화면·사이드바도 그 컬럼을 키로 보인다). 복제하지 않는 MergeTree 테이블이 연결 설정 `cluster`의 다른 서버에도 있으면(ON CLUSTER로 만든 테이블, `clusterAllReplicas(c, system.tables)`로 확인) 그 편집·삭제도 `ON CLUSTER c`로 모든 서버의 같은 행에 간다. 파트 이름은 서버마다 따로이므로 이때 행은 정렬 키 + 모든 값으로 찾고, `clusterAllReplicas(c, db, t)`로 어느 서버에도 그런 행이 둘 이상 없는지, Distributed 테이블이면 그 테이블로 읽어 샤드 전체에 정확히 한 행인지 확인한다. Replicated 테이블은 접속한 서버에서 바꾸면 복제가 퍼뜨리므로 그대로 둔다.

## 5. 구조

- 컬럼: 이름·타입(Nullable·LowCardinality 포함)·기본값(MATERIALIZED·ALIAS·EPHEMERAL은 종류와 함께)·Enum 값 목록. 정렬 키 컬럼이 "기본 키"로 표시된다.
- 인덱스: 데이터 스킵 인덱스(`system.data_skipping_indices`)와 그 정의.
- **테이블 속성**(`TableDetail.properties`): 엔진, ORDER BY, PRIMARY KEY(정렬 키와 다를 때), PARTITION BY, SAMPLE BY, TTL, SETTINGS, 활성 파트 수, 압축 전 크기, 그리고 25.7 이후 서버의 MergeTree 테이블이면 **경량 UPDATE**(켜짐/꺼짐: 블록 번호·위치 컬럼 설정). 구조 화면 아래 "테이블 속성" 칸(하단 "속성" 버튼으로 숨김). "꺼짐" 옆의 **켜기**(`SqlDialect.propertyAction`)는 무엇이 바뀌는지(셀 수정이 뮤테이션 대신 패치 파트, 행마다 블록 번호·위치를 더 저장) 설명하고 실행할 문장을 보인 확인 창을 띄운 뒤 `ALTER TABLE t MODIFY SETTING enable_block_number_column = 1, enable_block_offset_column = 1`을 실행한다. 구조 탭의 ON CLUSTER 선택을 따른다.
- DDL: `SHOW CREATE TABLE`(딕셔너리는 `SHOW CREATE DICTIONARY`).
- 구조 편집: 컬럼 추가는 `ADD COLUMN 이름 타입 [DEFAULT …]`(널 허용은 `Nullable(…)`로 타입에 넣는다), 변경은 `MODIFY COLUMN`(기본값을 지우면 `REMOVE DEFAULT`), 이름 바꾸기 `RENAME COLUMN`, 키 변경 `MODIFY ORDER BY`(서버는 같은 ALTER에서 새로 더한 컬럼을 뒤에 붙이는 것만 받는다). 인덱스는 `ALTER TABLE … ADD INDEX 이름 (컬럼) TYPE minmax GRANULARITY 1` / `DROP INDEX`이며, 이미 있는 파트에는 `MATERIALIZE INDEX`를 따로 실행해야 적용된다.
- 테이블 만들기: 키가 있으면 `PRIMARY KEY (…)` + `ENGINE = MergeTree`, 없으면 `ENGINE = MergeTree ORDER BY tuple()`.
- **ON CLUSTER**(`SqlDialect.clusters`): `system.clusters`에 클러스터가 있으면 테이블 만들기 창과 구조 탭의 "DDL 미리보기" 머리에 "ON CLUSTER" 목록이 나온다. "이 서버만" 또는 클러스터 하나를 고르면 미리보기와 실행되는 문장 모두 `CREATE TABLE 이름 ON CLUSTER c …`, `ALTER TABLE 이름 ON CLUSTER c …`가 된다. 처음 고른 값은 연결 설정 `cluster`이고(미리보기를 열지 않고 저장해도 그 값을 따른다), 사이드바의 이름 바꾸기(`RENAME TABLE … ON CLUSTER c`)·복제(`CREATE TABLE … ON CLUSTER c AS …`, 행 복사 INSERT는 접속한 서버에서만)·비우기·삭제도 그 설정을 따르며 확인 창에 "클러스터 c의 모든 서버에서 실행합니다"가 붙는다. 편집기 문장과 템플릿은 바꾸지 않는다. 서버는 `distributed_ddl` 큐로 모든 서버의 결과를 기다리고, 한 서버라도 실패하면 오류를 낸다.

## 6. 실행 계획

- 실행 계획 버튼은 `EXPLAIN json = 1, actions = 1, indexes = 1`을 앞에 붙인다. 여러 줄로 나뉘어 오는 JSON을 이어 붙여 단계 트리로 그리고, 테이블 읽기 단계에는 인덱스별 "선택된 파트/그래뉼 · 조건"을 보인다. 인덱스가 아무 그래뉼도 거르지 못한 읽기는 경고 색이다.
- 직접 쓴 `EXPLAIN PLAN`·`EXPLAIN PIPELINE`(들여쓰기 텍스트)도 트리로, `EXPLAIN ESTIMATE`(테이블별 파트·행·마크)는 읽기 목록으로 그린다. 스니펫에 PIPELINE·ESTIMATE가 있다.

## 7. 내보내기·가져오기·덤프

- 테이블(또는 고른 컬럼)을 CSV·JSON으로 내보내면 `POST /api/sql/export`로 서버가 `SELECT … FORMAT CSVWithNames`(머리글 없으면 `CSV`) 또는 `FORMAT JSONEachRow`(`output_format_json_array_of_rows = 1`, JSON 배열)를 그대로 흘려보낸다. 행 수 제한이 없고 페이지를 나눠 읽지 않는다. CSV 옵션 중 구분자·머리글·줄바꿈(CRLF/LF)·NULL 표기(빈칸/`NULL`)·BOM은 지키며, 따옴표 바꾸기·소수점 쉼표·줄바꿈을 공백으로는 서버가 쓸 수 없어 그때는 기존처럼 그리드를 거쳐 쓴다. 쿼리 결과·Excel·SQL 내보내기는 기존 경로다.
- CSV 옵션 **"배열·맵·튜플을 JSON으로"**(`nested_json`): 끄면 서버의 CSV 형식(`"['a','b']"`, `"{'k':2}"`, `"(1,'x')"`), 켜면 그리드가 보이는 JSON(`"[""a"",""b""]"`)으로 쓴다. 서버가 `DESCRIBE TABLE (문장)`으로 결과 컬럼의 타입을 읽고, Array·Map·Tuple·Nested 컬럼만 `SELECT * REPLACE (toJSONString(c) AS c, …) FROM (문장)`으로 바꾼다(그리드와 같은 JSON 설정: 64비트 정수·Decimal은 따옴표, 튜플은 배열).
- CSV·JSON 가져오기(“삽입” 모드)는 1만 행씩 `INSERT INTO t (…) FORMAT CSV`로 보낸다. 서버가 각 값을 컬럼 타입으로 읽고 NULL은 `\N`이다. 트랜잭션이 없으므로 실패하면 그 앞 묶음까지는 들어가 있다(가져오기 창이 알린다). 오류가 난 행 찾기는 한 행씩 VALUES로 다시 해 본다.
- 덤프·SQL 내보내기: `SHOW CREATE TABLE` 문(엔진·ORDER BY 포함)과 INSERT. 복원은 문장을 하나씩 실행한다(트랜잭션 없음).

## 8. 세션·제한 시간·로그

- 서버 정보: 버전, 현재 데이터베이스, 가동 시간(`uptime()`), 데이터베이스 크기(활성 파트 합), 실행 중인 쿼리(`system.processes`: query_id·사용자·데이터베이스·상태·쿼리·경과). 세션 종료는 `KILL QUERY WHERE query_id = '…' ASYNC`. 서버 정보를 읽는 쿼리 자신이 "현재"로 표시된다.
- 취소: 실행 중인 문장의 query_id로 `KILL QUERY`를 보낸다. 멈춘 문장은 `interrupted`(코드 394)다.
- 설정의 "쿼리 시간 제한(초)"이 편집기 문장마다 `max_execution_time`으로 간다(0이면 서버 설정). 넘으면 코드 159와 그 도움말.
- 모든 문장(카탈로그 읽기 포함)이 콘솔에 남는다. 오류는 코드(`clickhouse_62`), 이름(`SYNTAX_ERROR`), 위치(“at position N”을 글자 위치로), 원문을 갖는다.

## 9. MCP

SQL 엔진의 읽기 전용 도구(`tablepeek_list_tables`, `tablepeek_describe_table`, `tablepeek_query`)가 그대로 쓰인다. 쓰기 문장(`ALTER … DELETE` 등)은 거절된다.

## 10. 테스트

- 테스트 서버: `make test-db ENGINE=clickhouse`(compose 프로필 `clickhouse`, 메모리 1 GB 상한, 앞에 SSH 서버). HTTP `127.0.0.1:18123`, HTTPS `127.0.0.1:18443`(인증서는 `testdb/clickhouse/gen.sh`가 `testdb/x509` CA로 `localhost`·`127.0.0.1`·`clickhouse.tablepeek.test`에 대해 만든다, CA `testdb/x509/ca.pem`), `tablepeek` / `tablepeek_test_pw`. 테스트 네트워크에서는 `clickhouse.tablepeek.test`이고, SSH `127.0.0.1:2223`(사용자 `tablepeek`, 키 `testdb/ssh/id_ed25519`)을 지나 그 이름으로 닿는다. `testdb/clickhouse.sql`(엔진 테스트용 `tablepeek_test.kinds`), `testdb/clickhouse-shop.sql`(`shop`: Replacing·Summing·Aggregating MergeTree, 파티션·TTL·스킵 인덱스, 구체화된 뷰 둘, 뷰, 딕셔너리, 이상한 이름). 끝나면 `make test-db-down ENGINE=clickhouse`.
- 클러스터: `make test-db ENGINE=clickhouse-cluster`(서버 둘 `ch-node1`·`ch-node2`, 각 768 MB 상한, 클러스터 `tp_cluster` = 샤드 하나에 복제본 둘, ClickHouse Keeper는 `ch-node1` 안, 설정 `testdb/clickhouse/cluster/`). HTTP `127.0.0.1:18124`·`18125`.
- 엔진 테스트: `make test-live ENGINE=clickhouse`(`TABLEPEEK_TEST_CLICKHOUSE=1`, `engines/clickhouse/tests.rs`): 접속·목록·스키마, 타입 보존·잘림·FORMAT·EXPLAIN, 오류 코드·위치·중간 오류·잘못된 비밀번호, 세션의 USE·SET·구조 속성·딕셔너리 정의, 정렬 키 편집·삽입·삭제·중복 키 거절, 같은 키의 행을 파트·자리로 고치기(뮤테이션 뒤 이름 바뀐 파트에서도, 병합 뒤에는 0행, 복사한 행은 파트·자리 없이 삽입, 경량 DELETE), 경량 UPDATE(블록 설정이 있는 테이블은 뮤테이션 없이, 없는 테이블은 뮤테이션), 취소·시간 제한·세션 종료, HTTPS(CA·검증 끄기·실패), 내보내기 스트림. `TABLEPEEK_TEST_CLICKHOUSE_CLUSTER=1`(`make test-live ENGINE=clickhouse-cluster`)은 앱이 쓰는 모양의 `ON CLUSTER` 문장(CREATE DATABASE·CREATE TABLE ReplicatedMergeTree·ALTER ADD COLUMN·RENAME·TRUNCATE·DROP)을 한 서버에서 실행하고 다른 서버에서 확인하며, 다른 서버에서 고친 행이 복제로 돌아오는지 본다. 터널: `crates/tablepeek-server/src/tunnel.rs`의 `clickhouse_tests`(`TABLEPEEK_TEST_CLICKHOUSE=1`)가 SSH 터널로 HTTP·HTTPS(`clickhouse.tablepeek.test`), 테스트 안의 HTTP CONNECT 프록시로 HTTPS에 닿고, 같은 터널로 인증서에 없는 이름(`other.tablepeek.test`)은 TLS 오류로 거절되는지 본다. 단위 테스트는 서버 없이 돈다(`part_condition_follows_mutations` 포함).
- 화면 점검(2026-10-29, ClickHouse 25.8, 관리형 Chromium, 비밀번호 "매번 입력"): 엔진 카드·접속 폼, `clickhouse://` URL 붙여넣기로 칸 채우기, 저장 프로필 접속(비밀번호 묻기), HTTPS(CA 없을 때 "인증서를 믿을 수 없음" 도움말, 검증 끄기로 접속), 사이드바의 테이블·뷰·구체화된 뷰·딕셔너리, 딕셔너리 데이터 열기, 구체화된 뷰 정의, 데이터 탭 필터(Contains → `toString(col) LIKE`)·정렬·페이지, Enum 셀 편집 적용(ALTER UPDATE)·행 삭제(DELETE)·행 추가(INSERT CAST), 구조 화면과 테이블 속성, 테이블 만들기(+스킵 인덱스)·인덱스 삭제, 편집기 함수 자동완성(대소문자 그대로)·실행·문법 오류 위치, 실행 계획(JSON 트리·PIPELINE·ESTIMATE), 서버 정보·KILL QUERY로 실행 중 쿼리 멈춤, 설정의 쿼리 시간 제한(2초 → 코드 159 도움말), 안전 모드 확인(DROP), 사용자 만들기·지우기, CSV·JSON 네이티브 내보내기(`FORMAT CSVWithNames`·`JSONEachRow`, 6,000행), CSV 가져오기(`INSERT … FORMAT CSV`, 따옴표·쉼표·빈칸→NULL), SQL 덤프, 데이터베이스 전환, 테이블 복제, 기록, MCP(`tablepeek_query`·`tablepeek_describe_table`, 쓰기 거절).
- 화면 점검 2(2026-10-29, ClickHouse 25.8, 관리형 Chromium, 비밀번호 "매번 입력", 파일 선택은 `/api/fs/pick` 응답을 가로채 경로를 넣음): SSH 터널(키 파일)+HTTPS+CA로 `clickhouse.tablepeek.test:8443` 시험·접속, 호스트를 인증서에 없는 `clickhouse`로 바꾸면 "인증서의 서버 이름이 주소와 다름" 도움말; HTTP 프록시(CONNECT를 이름 그대로 받는 프록시)+HTTPS+CA 시험·저장·저장 프로필로 접속(비밀번호 묻기). 같은 키(id 1) 세 행 테이블에서 두 셀을 한 번에 적용(두 번째는 첫 뮤테이션으로 이름이 바뀐 파트에서 찾음), 행 복제(파트·자리 없이 INSERT), 같은 키 행 삭제(경량 DELETE); 블록 설정 테이블의 셀 수정이 `UPDATE … SET`으로 나가고 파트 이름이 그대로임; 결과 내보내기 창에서 `_part`·`_part_offset`이 처음부터 꺼짐. 클러스터 연결(설정 `cluster = tp_cluster`): 테이블 만들기 창의 ON CLUSTER 목록(기본 tp_cluster, "이 서버만"으로 바꾸면 미리보기에서 절이 빠짐)으로 만들기, 구조 탭 미리보기 머리의 목록으로 컬럼 추가, 사이드바 이름 바꾸기, 삭제 확인 창의 "클러스터 tp_cluster의 모든 서버에서 실행합니다" — 각각 다른 서버(`18125`)에 반영됨을 확인.
- 한계 정리(2026-10-30, ClickHouse 25.8): 엔진 테스트에 병합 뒤 키+값으로 다시 찾기(값이 바뀌었으면 0행, 모두 같은 행 둘은 거절)·키만 있는 결과를 값으로 가르기, `MODIFY SETTING`으로 켠 테이블의 경량 UPDATE와 "경량 UPDATE" 속성, `nested_json` CSV, `distributed_target`·`comparable` 단위 테스트를 더했고, 클러스터 테스트 `clickhouse_row_edits_reach_the_cluster`가 ON CLUSTER로 만든 복제하지 않는 테이블의 편집·삭제가 두 서버 모두에 가는지(`ALTER TABLE tp_rows.plain ON CLUSTER tp_cluster UPDATE … WHERE id = … AND note = …`), Distributed 테이블(로컬이 MergeTree·ReplicatedMergeTree, `_part`·`_part_offset`을 Distributed로 읽음)의 키·편집·삭제를 확인한다. 화면 점검(관리형 Chromium, 비밀번호 "매번 입력"): 데이터 탭으로 읽은 뒤 밖에서 `OPTIMIZE … FINAL`한 행의 셀 수정이 `WHERE id = 1 AND note = 'b' AND qty = 20 AND tags = ['y','z']`로 적용됨; 셀 수정 + 행 삭제 + 잘못된 값의 새 행을 한 번에 적용하자 INSERT가 실패하고 웹이 삭제한 행을 다시 넣고 셀을 원래 값으로 되돌려(`ALTER TABLE … UPDATE note = CAST('c' …)`) 테이블이 적용 전과 같아짐.
- 화면 점검 3(2026-10-30, 관리형 Chromium, 비밀번호 "매번 입력"): 셀 수정 + 행 삭제 + 잘못된 값의 새 행을 적용하면 데이터 탭의 오류 띠 제목 아래에 "트랜잭션이 없어 앞서 적용한 변경 2개를 되돌렸습니다 · 되돌림: 3행 삭제 · 되돌림: 1행 note"가 목록으로 보이고 테이블은 적용 전과 같음; 테이블 생성 창으로 만든 `ui_fresh`의 첫 페이지가 `id, _part, _part_offset`으로 열림; 구조 탭 "경량 UPDATE 꺼짐 · 켜기" → 설명과 `ALTER TABLE ui_merge MODIFY SETTING …` 문장을 보인 확인 창 → 켜기 → 속성이 "켜짐", SETTINGS에 두 설정; 테이블 내보내기 창에서 "배열·맵·튜플을 JSON으로"를 켜고 CSV로 내보내면 요청이 `nested_json: true`이고 서버가 `SELECT * REPLACE (toJSONString(tags) AS tags, toJSONString(m) AS m) FROM (SELECT * FROM ui_merge) FORMAT CSVWithNames`를 실행(`"[""x""]"`, `"{""k"":1}"`).

## 11. 한계

- 정렬 키와 모든 컬럼 값까지 같은 행이 여럿이면, 병합으로 파트·자리가 바뀐 뒤에는 어느 것인지 알 수 없어 거절한다(새로 고치면 새 파트·자리로 다시 가른다). 내용이 같은 행을 구별할 정보가 파트·자리밖에 없기 때문이다.
- 복제하지 않는 클러스터 테이블에 **추가한 행**은 접속한 서버에만 들어간다. ClickHouse의 INSERT에는 `ON CLUSTER`가 없다(INSERT 문법: `INSERT INTO [TABLE] [db.]table [(c1, …)] [SETTINGS …] VALUES …`; `ON CLUSTER`는 분산 DDL과 그 위의 ALTER·경량 UPDATE/DELETE만 받는다). 모든 서버에 넣으려면 `internal_replication = false`인 Distributed 테이블로 넣는다(데이터 탭의 행 추가가 그 테이블로 간다). 같은 까닭으로 가져오기도 접속한 서버(또는 고른 Distributed 테이블의 샤드 규칙)를 따른다.
- 보상 되돌리기는 트랜잭션이 아니다: 되돌리는 사이 다른 사람이 같은 행을 바꾸면 그 되돌리기는 0행으로 실패하고 오류 메시지의 "남은 변경"에 적힌다. DEFAULT·NOW로 정렬 키를 바꾼 행은 DB가 정한 키를 몰라 되돌리지 못한다고 적는다.
