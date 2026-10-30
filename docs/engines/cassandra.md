# Cassandra · ScyllaDB

작성: 2026-10-29 · 상태: 구현됨

엔진 정의 `cassandra`와 `scylladb`(별칭 `scylla`), 드라이버 하나 `crates/tablepeek-engine/src/engines/cassandra/`(ScyllaDB는 `engines/scylladb/`에 정의만 있다), 웹 `web/src/engines/cassandra/`·`web/src/engines/scylladb/`. 패러다임은 `sql`, 방언 묶음(`family`)은 `cql`이고 SQL 작업 화면을 그대로 쓴다. CQL이 SQL과 다른 곳(페이지·필터·정렬·트랜잭션·편집)은 능력과 방언 훅으로 바꾼다.

## 1. 범위

- 지원 서버: Apache Cassandra 3.11 이후(시험은 5.0), ScyllaDB 5 이후(시험은 2026.3). CQL 네이티브 프로토콜(기본 9042)로 접속한다.
- 드라이버는 순수 Rust `scylla` 크레이트(1.9, Cassandra와도 호환)다. TLS는 다른 엔진과 같은 rustls(`rustls-023` 기능)이고, 네이티브 라이브러리가 없어 빌드에 조건이 없다.
- 두 정의는 같은 드라이버를 쓴다. 어느 쪽으로 접속하든 서버가 무엇인지(`system.versions`가 있으면 ScyllaDB) 읽어 서버 정보에 "Apache Cassandra 5.0.9"·"ScyllaDB 2026.3.4"처럼 보인다.
- 메타데이터는 드라이버의 스키마 사본을 쓰지 않고(`fetch_schema_metadata(false)`) 페이지가 물을 때 `system_schema`에서 읽는다.

## 2. 접속

| config 키 | 뜻 |
|---|---|
| `host`, `port` | 기본 `127.0.0.1`, `9042` |
| `user`, `password`(비밀) | 인증을 켠 클러스터에서만. 사용자를 비우면 비밀번호를 묻지 않는다(`needs_password`) |
| `database` | 키스페이스. 비우면 모든 키스페이스의 테이블을 `키스페이스.테이블`로 보인다. DB 전환(`databases: "switch"`)이 이 값을 바꿔 다시 접속한다 |
| `consistency` | 기본 일관성 수준(기본 `LOCAL_ONE`) |
| `serial_consistency` | `SERIAL` 또는 `LOCAL_SERIAL`(고급) |
| `datacenter` | 먼저 쓸 데이터센터(고급). 비우면 드라이버가 고른다 |
| `lwt_checks` | bool, 기본 켬(고급). 편집을 `IF EXISTS`/`IF NOT EXISTS`로 보낸다(§5) |
| `tls`, `tls_ca_file`, `tls_cert_file`, `tls_key_file` | TLS. CA가 없으면 시스템 루트. 클라이언트 인증서와 키는 함께 |

- SSH·HTTP 터널: 터널 전체를 받아(`TunnelTarget::Members`) 드라이버가 찾은 노드마다 127.0.0.1에 로컬 끝을 하나씩 열고, 그 끝이 터널을 지나 노드가 스스로 알리는 주소(`system.peers`·`system.local`)와 연결 설정의 포트로 이어진다(`route.rs`, `AddressTranslator`). 그래서 터널 너머에서도 드라이버가 노드마다 따로 붙고, 준비된 문장(편집)은 드라이버의 토큰 인식 라우팅대로 그 파티션의 복제본 노드로 간다. ScyllaDB의 샤드 포트는 쓰지 않는다(일반 포트로 샤드마다 연결). 터널 없이 루프백(컨테이너의 포트 매핑)으로 붙으면 다른 노드의 주소에 닿을 수 없어 모든 노드를 접속 주소로 바꾼다(그 노드가 조정자).
- 접속 실패는 TLS(`TLS 연결 실패: …`)·로그인(`로그인 실패: …`)을 갈라 보인다.

## 3. 능력

| 능력 | 값 | 비고 |
|---|---|---|
| `language` | `cql` | `"…"` 이름, `'…'` 문자열, `$$` 본문, `--`·`//`·`/* */` 주석, `BEGIN … APPLY BATCH` |
| `objects` | `table`, `materialized_view`, `type`, `function`, `aggregate`, `trigger` | ScyllaDB에는 trigger가 없다 |
| `schema` | `declared` | `system_schema.columns` |
| `edit_by_key` | true | 기본 키 전체로 행을 찾는다(§5) |
| `transactions` | `none` | 적용·가져오기·복원이 트랜잭션 없이 돈다. "트랜잭션으로 실행" 없음 |
| `foreign_keys` | false | ER 다이어그램 메뉴가 사라진다 |
| `ddl` | true | §6 |
| `databases` | `switch` | 키스페이스 |
| `users` | 로그인한 연결에서만 true | 역할(`LIST ROLES`, `CREATE/ALTER/DROP ROLE`) |
| `explain` | `cql-trace` | §7 |
| `exact_count` | false | 추정은 토큰 링 표본(§4)이다. 정확한 수는 `count_steps`로 센다 |
| `count_steps` | true | 정확한 COUNT를 토큰 범위로 나눠 8개씩 동시에 세고, 데이터 탭이 진행률과 중지를 보인다(§4) |
| `dump` | `sql` | CQL 스크립트(CREATE + INSERT) |
| `import_formats` / `export_formats` | csv·json·sql / csv·json·sql·xlsx | |
| `sessions` | `{ kill: false }` | 목록은 `system_views.clients`(Cassandra 4+)·`system.clients`(ScyllaDB). 끊는 CQL은 없다 |
| `indexes` | create·drop | 보조 인덱스, SAI(`StorageAttachedIndex`) |
| `cursor_paging` | true | §4 |

## 4. 읽기

- **페이지는 OFFSET이 아니라 서버의 paging state로 넘긴다.** 드라이버는 `max_rows`만큼 페이지를 이어 읽고, 남은 행이 있으면 그 자리를 `next_page`(base64 토큰)로 돌려준다. 데이터 탭은 문장마다 "몇 번째 행으로 이어지는 토큰"을 모아 두고(`pageMarks`), 다음·이전·OFFSET 칸 모두 그 행에서 가장 가까운 앞 토큰부터 읽는다. 토큰이 없는 먼 페이지(OFFSET 칸, 페이지 크기 변경 뒤의 이전)는 서버가 그 앞의 행을 행 수만 세며 건너뛰고(`/api/sql/skip`, `SqlDriver::skip_rows`: 행은 화면으로 보내지 않는다), 페이지 크기의 배수마다 토큰을 적어 와 다음 이동을 가깝게 한다. 한 번에 1.5초씩 걸어 바닥줄이 "N행째로 가는 중 · a / b행 건너뜀"과 진행 막대, 중지를 보이고, 중지해도 찾은 토큰은 남는다. 행이 먼저 끝나면 그 수가 전체 행 수가 되고 마지막 페이지를 보인다. 데이터 탭 문장에는 LIMIT이 없다(LIMIT은 페이지를 가로질러 전체를 자르므로). 내보내기·백업도 토큰으로 끝까지 읽는다.
- **행 수:** 정확한 COUNT(`/api/sql/count`, `SqlDriver::count_step`)는 토큰 링(Murmur3)을 약 5만 행씩(표본 추정 기준, 최대 4096개) 나눠 `token(pk) > a AND token(pk) <= b` 범위를 8개씩 동시에 세고, 1.5초마다 진행률을 돌려준다(바닥줄 "행 수 세는 중 · 37% · …", 중지). 시간 초과가 난 범위는 8개로 쪼개 다시 센다(3단계까지). 노드가 과부하·시간 초과를 알리면(`cql_1001`·`1100`·`1200`·`1300`) 그 묶음을 하나씩 다시 센다. 필터와 ALLOW FILTERING은 범위마다 붙고, 파티션 키를 거는 필터는 범위로 나눌 것이 없어 한 문장으로 센다. 서버가 범위와 함께 받지 않는 조건(일부 인덱스)도 한 문장으로 돌아간다. 동시 수(범위 8, 복제 쓰기 16)는 1.2 GB 테스트 컨테이너가 16·64에서 메모리 부족으로 죽은 뒤 낮춘 값이다.
- **행 수 추정:** 토큰 링을 넷으로 나눠 각 구간의 처음 256개 파티션 토큰(`PER PARTITION LIMIT 1`)으로 파티션 밀도를 재고(256개보다 적으면 그 구간은 정확), 클러스터링 키가 있으면 표본 파티션 16개의 `COUNT(*)` 평균을 곱해 **행 수**를 추정한다. 막 적재해 `size_estimates`가 비어 있는 ScyllaDB에서도 바로 나온다. 표본을 읽지 못하면 `system.size_estimates`의 파티션 수를 그 노드가 맡은 링 비율로 나눠 클러스터 전체로 늘린 값을 쓴다(크기도 같은 비율).
- **정렬:** CQL은 한 파티션 안에서 클러스터링 키 순서로만 정렬한다. 데이터 탭은 키로 기본 정렬하지 않고(`keyOrder: false`), 사용자가 고른 정렬만 보낸다. 파티션 키를 = 조건으로 고정하지 않은 정렬은 서버가 거절하고 오류 도움말이 그 방법을 알려 준다.
- **필터:** `=`, `>`, `≥`, `<`, `≤`, `IN`, `CONTAINS`(컬렉션 원소)만, AND로만 잇는다. 키가 아닌 컬럼 조건에는 필터 막대의 "ALLOW FILTERING" 스위치가 필요하다(켜면 테이블 전체를 훑는다는 경고가 붙는다). 스위치는 데이터·개수·분석·내보내기 문장 모두에 붙는다.
- **값:** 숫자·불리언은 그대로, `varint`·`decimal`은 정확한 자릿수의 수(넘치면 문자열), 시간(`timestamp`는 `2024-03-01 12:00:00.000Z`, UTC)·`uuid`·`timeuuid`·`inet`·`duration`(`1h30m`)·`blob`(`0x…`)은 문자열, 컬렉션·UDT·튜플·벡터는 Cassandra의 `toJson()`과 같은 JSON 텍스트다. 그리드는 컬렉션 컬럼을 JSON 칸으로 보인다.
- **편집기 명령:** cqlsh처럼 `CONSISTENCY [수준]`, `SERIAL CONSISTENCY [수준]`, `TRACING ON|OFF`(켜면 문장마다 추적 요약이 콘솔에 남는다)를 받는다. `USE ks`는 이후 이름 없는 테이블의 키스페이스를 바꾼다. 여러 문장은 `;`로 나누고 `BEGIN … APPLY BATCH`와 `$$` 본문은 하나로 둔다.
- 탭 막대의 일관성 수준 선택은 이 연결의 이후 문장 전부에 `CONSISTENCY <수준>`을 건다.

## 5. 편집

- 행은 기본 키 전체(파티션 키 + 클러스터링 키)로 찾는다. 결과가 한 테이블의 SELECT이고 기본 키 컬럼을 모두 담았을 때만 편집할 수 있다. 구체화된 뷰는 편집하지 않는다.
- 셀 편집은 `UPDATE … SET c = ? WHERE 키 IF EXISTS`, 행 추가는 `INSERT … IF NOT EXISTS`, 삭제는 `DELETE … WHERE 키 IF EXISTS`. 조건이 맞지 않으면(`[applied] = false`) 0행으로 알려 "다른 곳에서 바뀌었을 수 있습니다"가 된다. `lwt_checks`를 끄면 조건 없이 보낸다(CQL의 UPSERT 그대로).
- 값은 준비된 문장의 표시자 타입에 맞춰 읽는다. 컬렉션·UDT·튜플·벡터는 JSON으로 입력한다(`["a","b"]`, `{"city":"서울"}`). NOW는 컬럼 타입에 맞는 `toTimestamp(now())`·`toDate(now())`·`now()`·`currentTime()`이 된다. DEFAULT는 없다.
- static 컬럼은 파티션 키만으로 찾는다.
- **counter:** 셀 메뉴의 "더할 값…"은 입력한 수(음수는 뺌)를 스테이징하고(셀에 `+n`), 적용하면 `UPDATE … SET c = c + n` 한 문장이 된다(`SqlDriver::edit_add`): 서버가 원자적으로 더한다. 셀에 값을 직접 쓰면 그리드가 보였던 값(`seen`)과의 차이를 저장할 때 계산해 `c = c + (새 값 − 보인 값)`으로 보내고, 그 직전에 읽은 서버 값이 보인 값과 다르면 쓰지 않고 "그사이 a에서 b로 바뀌었다"고 알린다(새로고침하거나 더할 값으로). 보인 값 없이 오는 편집(`edit`)은 counter를 바꾸지 않는다. counter 테이블의 행 추가는 counter마다 더하기이고, 같은 키의 행이 이미 있으면 거절한다(counter 테이블은 `IF NOT EXISTS`를 받지 않아 확인은 바로 앞의 읽기다).
- 키 컬럼은 바꿀 수 없다(`fixedKeys`): 저장된 행의 키 칸은 그리드에서 편집되지 않고 마우스를 올리면 이유가 보인다. 새 행의 키 칸만 채운다.
- 트랜잭션이 없으므로 여러 변경을 적용하다 실패하면 앞의 변경은 남고, 화면이 그렇게 알린다.

## 6. 구조

- 사이드바: 키스페이스의 테이블, 구체화된 뷰, UDT(타입), 함수, 집계 함수, 트리거. 정의는 서버의 `DESCRIBE`(Cassandra 4+, ScyllaDB)가 있으면 그것을, 없으면 `system_schema`에서 쓴 CREATE 문이다.
- 구조 탭: 컬럼(파티션 키 → 클러스터링 키 → 나머지 이름순), 기본 키(`PRIMARY KEY ((a), b)`), 보조 인덱스·SAI, 트리거, 테이블 속성(`system_schema.tables`의 compaction·compression·caching·gc_grace_seconds…).
- 구조 편집: 컬럼 추가(`ALTER TABLE … ADD`), 삭제(`DROP`), 이름 변경(`RENAME`, 서버는 키 컬럼만 허락), 인덱스 삭제(`DROP INDEX 키스페이스.이름`). CQL 컬럼에는 NOT NULL·기본값이 없고 있는 컬럼의 타입과 기본 키 소속은 바꿀 수 없으므로(`fixedColumns`), 구조 그리드에 is_nullable·column_default 열이 없고 있는 컬럼의 data_type·is_primary 칸은 읽기 전용이다(새 컬럼만 고른다). 새 테이블 창의 NN·기본값 칸도 꺼져 있다.
- 테이블 복제: TablePeek 명령 `CREATE TABLE 새 AS SELECT * FROM 원본`(CQL에는 없다)을 드라이버가 받아, 원본의 컬럼·기본 키·클러스터링 순서·옵션(extensions 제외)으로 새 테이블을 만들고 행을 토큰 페이지로 읽어 16개씩 동시에 쓴다(counter 테이블은 더하기로). 쓰기 시각·TTL은 새로 정해진다. 테이블 이름 변경 메뉴는 없다(§10).
- 새 테이블(가져오기 포함)에는 기본 키가 있어야 해, 가져오기로 만드는 테이블은 첫 컬럼이 파티션 키가 된다.

## 7. 실행 계획(추적)

- CQL에는 EXPLAIN이 없다. TablePeek의 EXPLAIN(`EXPLAIN <문장>`)은 그 문장을 추적(tracing)을 켜고 한 번 실행해(조회는 첫 페이지까지) `system_traces`의 이벤트를 행으로 돌려준다. 문장이 실제로 실행되므로 안전 모드는 EXPLAIN INSERT를 쓰기로 본다.
- 실행 계획 화면은 요청 → 노드별 단계로 보이고, 단계마다 앞 단계로부터 걸린 시간과 전체에서 차지하는 비율로 느린 단계를 표시한다.

## 8. 가져오기·내보내기·백업

- 가져오기(CSV·JSON·CQL 스크립트): 묶음을 `BEGIN UNLOGGED BATCH … APPLY BATCH` 하나로 보내고, 실패하면 그 묶음을 한 행씩 다시 보내 실패한 행을 찾는다. 트랜잭션이 없어 앞의 행은 남고 몇 행이 저장됐는지 알린다. uuid·blob·duration은 따옴표 없이, 컬렉션·UDT는 `fromJson('…')`으로 넣는다.
- 내보내기·백업: 토큰 페이지로 끝까지 읽는다. 백업은 CREATE 문(DESCRIBE)과 INSERT 문이다. 백업·SQL 내보내기·"INSERT로 복사"는 모두 컬럼의 선언 타입으로 값을 쓴다(`importLiteral`: 숫자·uuid는 따옴표 없이, 컬렉션은 `fromJson`).

## 9. 오류

- 서버 오류는 `cql_<16진 코드>`(예: `cql_2200` Invalid, `cql_2000` 문법, `cql_0100` 인증, `cql_1000` 복제본 부족, `cql_1200` 읽기 시간 초과)와 원문, 문법 오류의 줄·열(`line 1:7 …`)로 온다.
- 오류 도움말 규칙: ALLOW FILTERING, 파티션 키 없는 정렬, 기본 키 조건 부족, 없는 컬럼·테이블·키스페이스, 일관성 수준을 맞출 복제본 부족, 시간 초과, 로그인, 타입 불일치, counter, UDF·구체화된 뷰가 꺼진 서버.
- 취소는 기다리기를 멈출 뿐, 서버는 그때 보낸 문장 하나를 끝까지 실행할 수 있다(§10). 먼 페이지 이동·나눠 세기·복제처럼 여러 문장으로 된 일은 다음 문장을 보내지 않으므로 그 자리에서 멈춘다.

## 10. 남은 한계 (CQL이 할 수 없는 것)

2026-10-30에 페이지 번호 이동, 정확한 행 수, counter 편집, 테이블 복제를 고쳤다(§4·§5·§6). 남은 것은 CQL과 그 프로토콜에 수단이 없는 것뿐이다.

- **실행 중인 문장 취소:** CQL 네이티브 프로토콜(v4·v5)의 메시지는 STARTUP·OPTIONS·QUERY·PREPARE·EXECUTE·BATCH·REGISTER·AUTH_RESPONSE(요청)와 그 응답뿐이고 취소 요청이 없다([native_protocol_v5.spec §2.4·§4](https://github.com/apache/cassandra/blob/trunk/doc/native_protocol_v5.spec)). 드라이버(`scylla` 1.9)도 요청을 버리는 것 말고는 할 수 없다. 서버 쪽 문장은 서버의 `read_request_timeout`/`range_request_timeout`에서 끝난다.
- **다른 세션 끊기:** 접속 목록(`system_views.clients`, ScyllaDB `system.clients`)은 읽기 전용 가상 테이블이고, 특정 클라이언트 연결을 닫는 CQL 문이 없다(`nodetool disablebinary`는 노드의 모든 클라이언트를 끊는 관리 명령이라 CQL로 보낼 수 없다).
- **테이블 이름 변경:** CQL의 `ALTER TABLE`은 컬럼 추가·삭제·(키 컬럼) 이름 변경과 옵션만 받는다([CQL DDL](https://cassandra.apache.org/doc/latest/cassandra/developing/cql/ddl.html#alter-table)). 이름을 바꾸려면 복제한 뒤 원본을 지우면 된다.
- **트랜잭션·기본값:** CQL에 다중 문장 트랜잭션과 컬럼 기본값이 없다(Cassandra 5.0·ScyllaDB 2026.3 기준). 적용 실패 시에는 앱의 보상 되돌리기(docs/ENGINES.md §4.1)가 앞의 변경을 되돌린다.
- counter 테이블의 행 추가 확인은 쓰기 직전의 읽기다: Cassandra와 ScyllaDB는 counter 테이블에 경량 트랜잭션(`IF`)을 받지 않는다("Conditional updates are not supported on counter tables").

## 11. 시험

- 테스트 서버: `make test-db ENGINE=cassandra`(9043) 또는 `ENGINE=scylladb`(9044), 한 번에 하나(각각 1 GB 남짓). 둘 다 로그인을 켰고 `tablepeek` / `tablepeek_test_pw`(슈퍼유저). Cassandra는 기본 관리자 `cassandra` / `cassandra`로, ScyllaDB(기본 관리자를 만들지 않는다)는 유지보수 소켓 `/var/lib/scylla/cql.m`(로그인 없음)으로 `*-keyspaces.cql`을 돌려 이 계정과 키스페이스 `shop`·`tablepeek_test`를 만들고, `cassandra-shop.cql`과 엔진별 `*-extras.cql`(Java·Lua 함수, SAI, 벡터)을 넣는다. Cassandra 컨테이너는 CPU 2개·힙 512 MB·직접 메모리 128 MB로 묶어야 1.2 GB 상한 안에서 뜬다.
- 엔진 시험: `TABLEPEEK_TEST_CASSANDRA=1` 또는 `TABLEPEEK_TEST_SCYLLADB=1`로 `cargo test -p tablepeek-engine cassandra`(`engines/cassandra/tests.rs`: 토큰 페이지, 키 편집과 IF 조건, ALLOW FILTERING·문법 오류 코드와 위치, CONSISTENCY, EXPLAIN 추적, 구조·키스페이스·트랜잭션 거절, 제품 판별, 서버 쪽 행 건너뛰기와 토큰 표시, 토큰 범위 COUNT(여러 단계·ALLOW FILTERING·파티션 키 필터), 행 수 추정, counter의 보인 값 편집·거절·더할 값, 테이블 복제). 단위 시험은 값 변환·문장 나누기·명령 판별·COUNT 문 읽기·토큰 범위.
- 2026-10-30: 위 엔진 시험 전체(새 `walks_counts_estimates_and_adds` 포함)가 Cassandra 5.0.9와 ScyllaDB 2026.3에서 통과했다.
- 화면 점검(관리형 Chromium, 2026-10-30, 5,000행 테이블): OFFSET 3000으로 이동(서버 걸음 "301행째부터 2700행을 건너뜀", 첫 행이 `SELECT pk, ck` 결과의 3001번째와 같음, 두 서버 모두), 건너뛰기 요청을 5초 늦춰 "1,201행째로 가는 중 · 0 / 1,200행 건너뜀"과 중지를 보고 중지하면 그 자리에 남음, COUNT 진행(막대·중지, 중지하면 이전 수 유지)과 4096개 범위로 나눈 두 단계 세기(5,000), 행 수 추정(ScyllaDB 막 적재 직후 "파티션 약 997 × 5.0행"), 셀 메뉴 "더할 값…"(+5, −3 → `n = n + 5`), 직접 쓴 counter 값이 서버에서 바뀐 경우의 거절("20에서 21(으)로 바뀌어 저장하지 않았습니다"), 두 셀 적용 중 두 번째 실패 시 첫 셀 되돌림("되돌림: 1행 a"), 사이드바 "테이블 복제…"(5,000행), ScyllaDB에서 counter 테이블 복제. 이때 OFFSET 칸의 Enter가 값을 두 번 커밋해 이동이 둘 생기고 중지가 뒤의 것만 멈추던 문제(모든 엔진의 LIMIT·OFFSET 칸)를 고쳤다.
- 컨테이너(또는 NAT 뒤 클러스터)는 노드가 자기 내부 주소(172.x)를 알려 주므로, 터널 없이 루프백으로 붙으면 드라이버가 모든 노드를 그 주소로 바꿔(`AddressTranslator`) 붙는다. 이것이 없으면 제어 연결만 되고 쿼리는 시간 초과가 난다. 드라이버는 다른 노드의 포트를 접점의 포트로 여기므로, 터널의 노드별 끝은 연결 설정의 포트(9042)로 이어진다.
- 클러스터 점검(2026-10-29, `make test-db ENGINE=scylladb-cluster`: 노드 둘과 sshd): SSH 터널로 `scylla-a:9042`에 붙어 서버 정보가 "노드 2개"를 보이고, 조건 없는 문장의 추적 코디네이터가 172.19.0.8과 172.19.0.9로 갈려(이전 방식이면 늘 접점 노드) 드라이버가 두 노드에 각각 붙었음을 확인했다. 같은 연결에서 키 칸 잠금(툴팁, Enter로 편집기 안 열림)과 다른 칸 편집, 구조 그리드(is_nullable·column_default 없음, 있는 컬럼의 data_type·is_primary 잠금, 새 컬럼은 편집), 새 테이블 창의 NN·기본값 꺼짐, "INSERT로 복사"의 선언 타입 값(varint 따옴표 없이, map은 `fromJson`, blob은 `0x…`)을 확인했다.
- 화면 점검(관리형 Chromium, 2026-10-29, 두 서버 모두): 연결 폼(테스트·저장·"매번 입력"), SSH 터널(`mongodb-rs` 프로필의 sshd 경유), 사이드바(테이블·구체화된 뷰·함수·타입·집계, ScyllaDB의 인덱스용 뷰는 빠짐), 데이터 탭 토큰 페이지(1–300 → 601–900 → 301–600, LIMIT·OFFSET 없음), 파티션 키 필터, 키 아닌 컬럼 필터의 오류 도움말과 ALLOW FILTERING 스위치, 셀·set·map 편집(`IF EXISTS`), 행 추가(`IF NOT EXISTS`)·삭제, 키 컬럼 편집 거절, 실행 계획(추적 트리), 일관성 수준 선택과 `CONSISTENCY`, 문법 오류 위치 밑줄, 구조·DDL·테이블 속성, 테이블 생성·컬럼 추가, 키스페이스 만들기·전환·삭제, 사용자(역할) 만들기·삭제, 서버 정보(제품·토폴로지·접속 목록), CSV 내보내기(1,500행 토큰 페이지), CSV 가져오기(배치), 백업(CQL 리터럴, 키스페이스 없는 이름)과 다른 키스페이스로 복원, 영어 화면.
