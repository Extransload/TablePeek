# Oracle

작성: 2026-10-29 · 상태: 구현됨

엔진 정의 `oracle`(별칭 `oracledb`), 드라이버 `crates/tablepeek-engine/src/engines/oracle/`, 웹 `web/src/engines/oracle/`. 패러다임은 `sql`이고 SQL 작업 화면을 그대로 쓴다.

## 1. 범위

- 지원 서버: Oracle Database 12c 이후(페이지 나누기 `OFFSET … FETCH`, 사용자 목록의 `ORACLE_MAINTAINED`가 12c부터). 시험은 23ai Free.
- 드라이버는 Oracle이 만든 순수 Rust thin 드라이버 `oracledb`(26.0.0-beta.5, 정확히 고정)다. **Instant Client가 필요 없다**: 설치 안내도, 접속 때 라이브러리를 찾는 일도 없고 빌드도 C 라이브러리 없이 된다. TLS는 다른 드라이버와 같은 rustls. 프리릴리스라 판을 올릴 때는 API를 다시 확인한다.
- 드라이버는 동기식이다. 호출마다 블로킹 스레드에서 돌고 세션 하나를 차례로 쓴다(`session.rs`).
- 편집기 문장은 하나씩 받는다. 일반 SQL은 끝의 `;`(또는 `/`만 있는 줄)를 떼고 보내고, PL/SQL(BEGIN/DECLARE 블록, CREATE … PROCEDURE·FUNCTION·PACKAGE [BODY]·TRIGGER·TYPE [BODY]·LIBRARY)은 `END;`를 지닌 채 보낸다. SQL*Plus의 `EXEC p(1)`은 `BEGIN p(1); END;`로 바꿔 보낸다.

## 2. 접속

| config 키 | 뜻 |
|---|---|
| `connect_mode` | `service`(호스트·포트·서비스 이름), `sid`(호스트·포트·SID), `descriptor`(연결 문자열) |
| `host`, `port` | 기본 `127.0.0.1`, `1521` |
| `database` | 서비스 이름(예: `FREEPDB1`) 또는 SID |
| `connect_string` | Easy Connect(`host:1521/svc`, `tcps://…?…`), `(DESCRIPTION=…)`, 또는 tnsnames.ora의 별칭 |
| `user`, `password`(비밀) | |
| `privilege` | 빈 값, `sysdba`, `sysoper` |
| `tls` | bool. TCPS(서버 인증서를 Mozilla 루트와 월렛의 인증서로 확인) |
| `wallet_file`, `wallet_password`(비밀) | `ewallet.pem`. 폴더가 월렛 위치. 개인 키가 있으면 상호 TLS, 인증서만 있으면 신뢰할 CA |
| `tnsnames_file` | 별칭을 찾을 tnsnames.ora. 폴더가 TNS_ADMIN 노릇을 한다 |

- SID 방식은 `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP|TCPS)(HOST=…)(PORT=…))(CONNECT_DATA=(SID=…)))`로 접속한다.
- SSH·HTTP 터널은 두 방식 모두에서 쓴다. 연결 문자열 방식에서는 드라이버가 문자열을 완전한 기술자로 풀고(tnsnames.ora 별칭은 그 파일에서, Easy Connect는 펼쳐서) 그 안의 주소(`(HOST=…)(PORT=…)`)마다 터널을 지난다: 주소가 하나면 터널의 로컬 끝 하나(`TunnelTarget::Address`), 여럿이면 터널 자체를 받아(`TunnelTarget::Members`) 주소마다 127.0.0.1에 로컬 끝을 열고, 기술자의 HOST·PORT만 그 끝으로 바꾼다(SERVICE_NAME·SID·FAILOVER·SECURITY 등은 그대로). TCPS를 터널로 지나면 인증서 이름을 127.0.0.1로 검사하므로 인증서가 그 주소를 담아야 한다.
- 연결 문자열에 `user/password@`가 있으면 저장되지 않게 거절하고 사용자·비밀번호 칸을 쓰게 한다.
- 세션마다 `NLS_DATE_FORMAT='YYYY-MM-DD HH24:MI:SS'`, `NLS_TIMESTAMP_FORMAT='YYYY-MM-DD HH24:MI:SS.FF'`, `NLS_TIMESTAMP_TZ_FORMAT='… TZH:TZM'`, `NLS_NUMERIC_CHARACTERS='.,'`를 걸고 DBMS_OUTPUT을 켠다. 필터·복사·덤프가 쓰는 날짜 글자가 이 형식으로 읽힌다.

## 3. 능력

| 능력 | 값 | 비고 |
|---|---|---|
| `language` | `sql` | `"…"` 이름, `q'[…]'` 문자열, `/`로 끝나는 PL/SQL(웹 `lexing.slashBlocks`·`qQuotes`) |
| `objects` | table, view, materialized_view, sequence, synonym, package, procedure, function, trigger, type | ALL_OBJECTS 한 번에 |
| `schema` | `declared` | ALL_TAB_COLUMNS |
| `edit_by_key` | true | 기본 키로만(ROWID를 쓰지 않음) |
| `transactions` | `always` | §5 |
| `foreign_keys` | true | ALL_CONSTRAINTS |
| `ddl` | true | DBMS_METADATA |
| `databases` | `none` | 스키마는 사이드바 이름(`OWNER.NAME`)으로 보인다 |
| `users` | true | ALL_USERS, `CREATE USER … IDENTIFIED BY "…"` |
| `explain` | `oracle` | §6 |
| `exact_count` | false | 구조의 행 수는 통계(NUM_ROWS), 행 세기는 `COUNT(*)` |
| `dump` | `sql` | |
| `import_formats` / `export_formats` | csv, json, sql / csv, json, sql, xlsx | |
| `sessions` | `{ kill: true }` | V$SESSION, `ALTER SYSTEM KILL SESSION 'sid,serial#' IMMEDIATE`. 권한이 없으면 목록이 비고 종료 버튼이 없다 |
| `validation`, `aggregation` | false | |
| `indexes` | `{ create: true, drop: true }` | |
| `cancel_ends_session` | true | §7. 트랜잭션 안에서 정지를 누르면 롤백된다고 먼저 묻는다 |

## 4. 사이드바·구조·정의

- 테이블: 지금 스키마의 것은 맨이름, 다른 스키마(Oracle이 만들지 않은 계정)의 것은 `OWNER.NAME`. "시스템 포함"이면 SYS 등도. 중첩·오버플로·휴지통 테이블과 구체화된 뷰가 행을 담는 테이블은 빠진다. `ALTER SESSION SET CURRENT_SCHEMA`를 실행하면 맨이름의 기준 스키마가 바뀐다.
- 객체: 뷰, 구체화된 뷰(데이터 탭으로 열림), 시퀀스, 동의어(PUBLIC은 시스템 포함일 때), 패키지, 프로시저, 함수, 트리거, 객체 타입.
- 정의: `DBMS_METADATA.GET_DDL`(SQLTERMINATOR 켬, 스토리지 절 끔; 이름은 스키마로 한정해 동의어·외래 키가 다른 스키마를 가리켜도 맞다). 패키지·타입은 명세와 본문, PL/SQL 단위는 `/` 줄로 끝난다. 다른 스키마의 객체를 DBMS_METADATA가 거절하면(SELECT_CATALOG_ROLE 없음) ALL_SOURCE·ALL_VIEWS·ALL_MVIEWS·ALL_SEQUENCES·ALL_SYNONYMS로 대신 쓴다. GET_DDL은 서버에서 1초 남짓 걸려, 객체마다(종류·소유자·이름·스크립트 여부) 받은 DDL을 세션에 기억해 두고 다시 열 때는 바로 보인다. 구조를 바꿀 수 있는 문장(DDL·DML·ALTER SESSION 등 조회가 아닌 것)을 편집기에서 실행하거나 스키마를 새로 고치면 모두 잊는다. 미리 읽어 두는 것은 없다.
- 구조: 컬럼(Oracle 표기 `NUMBER(10,2)`, `VARCHAR2(40 CHAR)`, `TIMESTAMP(6) WITH TIME ZONE`…, 기본값; ID 열의 시퀀스 기본값은 빼고 DDL이 `GENERATED … AS IDENTITY`를 보임), 인덱스(DESC·함수 기반 식), 외래 키, 트리거(CREATE TRIGGER 문으로), 주석, 크기(USER_SEGMENTS, 다른 스키마는 DBA_SEGMENTS를 읽을 수 있을 때), 테이블 속성(테이블스페이스·파티션·임시·IOT·로깅·압축·행 이동·통계 시각), DDL(GET_DDL 실패 시 컬럼으로 만든 CREATE TABLE).

## 5. 값·편집·트랜잭션

| 타입 | 그리드 | 편집 때 |
|---|---|---|
| NUMBER | 정수는 숫자, 소수 자리가 선언된 열(`NUMBER(p,s)`)은 정확한 글자 | `TO_NUMBER(:n)` |
| BINARY_FLOAT/DOUBLE | 숫자 | `TO_BINARY_FLOAT/DOUBLE` |
| DATE | `YYYY-MM-DD HH24:MI:SS` | `TO_DATE`; `T`·초 생략도 받음 |
| TIMESTAMP(n) | 소수 n자리 | `TO_TIMESTAMP` |
| TIMESTAMP WITH TIME ZONE | UTC로 ` +00:00` | `TO_TIMESTAMP_TZ`; `Z`·`+0900`·생략(+00:00) 받음 |
| INTERVAL DAY TO SECOND / YEAR TO MONTH | `+DD HH:MI:SS.FF` / `+YY-MM` | `TO_DSINTERVAL` / `TO_YMINTERVAL` |
| RAW | `0x…` | 바이트로 바인드 |
| BLOB | `0x…`(16KiB 넘으면 크기만) | 2000바이트까지는 바이트로 바인드. 넘으면 문장을 PL/SQL 블록으로 감싸 임시 BLOB(`DBMS_LOB.CREATETEMPORARY`)에 32,767바이트씩 `DBMS_LOB.WRITEAPPEND`로 채운 뒤 그 BLOB을 쓰고, 바뀐 행 수는 `SQL%ROWCOUNT`를 out 바인드로 받는다. 콘솔에는 조각이 `:blob1_1` 같은 자리표시로 남는다 |
| CLOB, NCLOB, LONG | 글자 | 1000자 넘으면 `TO_CLOB(:a) \|\| TO_CLOB(:b) …` |
| BOOLEAN(23ai) | true/false | `TRUE`/`FALSE` |
| JSON, VECTOR | JSON 글자, `[1,2,3]` | 글자 그대로 |

- 셀·행 편집은 지금의 기본 키가 그리드가 받은 키와 같은지 확인한 뒤 `UPDATE/DELETE … WHERE "K" = …`로 한다. 빈 행 추가는 `INSERT INTO t (첫 컬럼) VALUES (DEFAULT)`. NOW는 DATE에 `SYSDATE`, TIMESTAMP에 `SYSTIMESTAMP`.
- Oracle에는 BEGIN이 없다. 트랜잭션이 열려 있지 않으면 문장마다 바로 COMMIT한다(다른 엔진의 자동 커밋과 같게; 잠그는 `FOR UPDATE` 조회도). "트랜잭션 시작"은 그 커밋을 멈출 뿐이고 COMMIT/ROLLBACK이 끝낸다. 편집기에서 실행한 COMMIT·ROLLBACK·SET TRANSACTION과, 트랜잭션을 먼저 커밋하는 DDL(CREATE·ALTER·DROP·TRUNCATE·GRANT·COMMENT…; ALTER SESSION/SYSTEM 제외)을 따라간다.
- 가져오기(CSV·JSON)는 삽입과 업서트를 고른다. 업서트는 행마다 `MERGE INTO t USING (SELECT 값 AS "C" … FROM DUAL) s ON (t."K" = s."K" …) WHEN MATCHED THEN UPDATE SET (키가 아닌 열) WHEN NOT MATCHED THEN INSERT …`(키만 있는 테이블은 UPDATE 절 없이), 여러 행은 `BEGIN … END;` 블록 하나로 보낸다(웹 `sqlDialect.upsertRow`).
- 안전 모드는 PL/SQL 블록(`BEGIN`/`DECLARE`, `EXEC`/`CALL`)을 안의 문장으로 읽는다(`sqlTools.classifyPlsql`): 흐름 낱말(BEGIN·THEN·ELSE·LOOP·EXCEPTION…) 뒤 문장마다 보고 가장 무거운 것을 따른다. SELECT(INTO)·DBMS_OUTPUT·RAISE_APPLICATION_ERROR·DBMS_SESSION.SLEEP 등은 읽기, `FOR UPDATE`는 쓰기(행 잠금), 안의 DML·DDL은 그 문장 그대로(WHERE 없는 DELETE는 위험), COMMIT·ROLLBACK은 쓰기, `EXECUTE IMMEDIATE`·DBMS_SQL은 위험(무엇을 바꾸는지 모름), 그 밖의 프로시저 호출은 쓰기로 보고 UPDATE처럼 묻는다.

## 6. 실행 계획·출력·컴파일 오류

- 실행 계획 버튼은 `EXPLAIN PLAN FOR `를 붙인다. 드라이버가 그 문장을 실행한 뒤 `DBMS_XPLAN.DISPLAY(NULL, NULL, 'TYPICAL')`의 줄을 `PLAN_TABLE_OUTPUT` 한 열로 돌려준다. 그리드에는 익숙한 표 그대로, 계획 화면에는 들여쓰기로 만든 트리(비용·행·`*` 줄의 조건)로 보인다.
- PL/SQL 블록 뒤에 DBMS_OUTPUT이 남긴 줄이 있으면 `DBMS_OUTPUT` 열의 결과로 보인다.
- PL/SQL 단위·뷰를 만들고 컴파일 오류가 남으면 ALL_ERRORS를 읽어 `ORA-24344 … (줄·열)` 오류로 돌려주고, 편집기는 그 줄·열을 표시한다(앞에 붙은 주석 줄 수만큼 옮겨서).

## 7. 취소·시간 제한·세션

- 취소는 세션과 열린 트랜잭션을 살린 채 문장만 멈춘다(ORA-01013, 서버가 그 문장만 되돌림). 드라이버는 `crates/vendor/oracledb`에 둔 수정판이다(`[patch.crates-io]`, 바꾼 곳은 그 Cargo.toml 머리말과 소스의 `TablePeek:` 주석). 순서: (1) 세션 자신의 연결로 보내는 out-of-band break(TCP 긴급 데이터, python-oracledb thin과 같은 방식; 권한 필요 없음). 접속 때 서버가 OOB를 받는다고 답하고(accept의 GSO_CAN_RECV_ATTENTION) 확인(urgent 1바이트 + RESET)이 통과해야 쓴다. TCPS에서도 된다(23ai에서 확인). (2) 그게 안 되면 ALTER SYSTEM 권한으로 `ALTER SYSTEM CANCEL SQL 'sid,serial#'`(예전 드라이버가 이 break를 읽다 멈추던 것은 수정판의 reset 수정으로 고침). (3) 둘 다 안 되거나 5초 안에 호출이 돌아오지 않으면 `KILL SESSION`(권한이 있을 때) 뒤 세션을 버린다.
- 세션을 버릴 때: 기다리던 호출은 바로 "세션을 닫고 다시 엽니다"로 끝나고, 그 스레드의 세션은 문장이 끝난 뒤 닫히며, 다음 호출이 새 세션을 연다. 열려 있던 트랜잭션은 다음 COMMIT이 "롤백되었습니다"로 알린다. `cancel_ends_session`은 접속마다 정해진다: OOB도 안 되고 ALTER SYSTEM 권한도 없을 때만 참(웹이 트랜잭션 안의 정지 전에 묻는다).
- 설정의 쿼리 시간 제한도 같은 취소로 멈춘다. 드라이버의 call timeout은 in-band break를 써서(서버가 문장이 끝날 때까지 보지 않는다) 쓰지 않는다.
- 서버 정보: 배너와 판, 컨테이너(PDB)·서비스 이름, 문자 집합, 가동 시간(V$INSTANCE), 크기(DBA_DATA_FILES 또는 USER_SEGMENTS), 세션 목록(V$SESSION + V$SQLAREA의 SQL). 종료 버튼은 ALTER SYSTEM 권한이 있을 때만.

## 8. 오류

- 데이터베이스 오류: `code: "oracle_error"`, `server_code`는 ORA 번호(942), 메시지는 `ORA-00942: …` 첫 줄, 위치는 Oracle이 준 오프셋(1부터 센 글자). 리스너 오류(서비스·SID 없음)는 12514/12505로 번호를 붙인다.
- 웹의 `engines/oracle/errorHelp.ts`가 ORA-00001·01400·02291/02292·12899·01722·날짜 형식·00904·28000·12514/12505·04098·06550·24344·01950 등을 설명하고, 공통 규칙(로그인·테이블 없음·문법·잠금·권한·취소·네트워크)에도 ORA 번호가 들어 있다.

## 9. 시험 서버와 검증

- `make test-db ENGINE=oracle`: `gvenzl/oracle-free:23-slim-faststart`(arm64 네이티브), 127.0.0.1:15210, 서비스 `FREEPDB1`, 메모리 상한 2.5GB. 이미지의 SGA 1.5GB·PGA 512MB는 상한 안에서 DBMS_METADATA 같은 무거운 호출 때 메모리 할당을 기다리며 멈추므로, 처음 시작 때 `testdb/oracle-memory.sql`이 CDB에서 SGA 1GB·PGA 256MB로 줄이고 컨테이너를 한 번 다시 시작한다. 그다음 SYS로 `testdb/oracle.sql`(시험 스키마 TABLEPEEK: 5,000 users, 20,000 orders, 모든 타입의 KINDS, 종류마다 객체 하나, ALTER SYSTEM·SELECT_CATALOG_ROLE 권한)과 `testdb/oracle-shop.sql`(샘플 스키마 SHOP: 권한 없는 계정)을 넣는다. 끝까지 된 실행은 표시(마지막 COMMENT)를 남겨 다음 시작 때 건너뛴다.
- TCPS: 127.0.0.1:15211(컨테이너 2484). `testdb/oracle-wallet.sh`가 시험 CA(`testdb/x509/`)로 서명한 Oracle 전용 서버 인증서(`oracle`·`localhost`·127.0.0.1)로 자동 로그인 월렛(`testdb/oracle-wallet/`)을 만든다(예전 월렛은 `server.p12`가 없으면 다시 만든다). 이미지에 orapki는 있지만 돌릴 Java가 없어, Oracle PKI 라이브러리(`oraclepki`, Maven Central)를 이 컴퓨터의 Java(없으면 Temurin 컨테이너)로 돌린다. `testdb/oracle-tls.sh`가 컨테이너 안에서 리스너에 TCPS 주소와 월렛을 넣고 다시 시작한다. 클라이언트 월렛은 `testdb/x509/ca.pem`을 `ewallet.pem`으로 둔 폴더.
- SSH: 같은 프로필이 SSH 서버(127.0.0.1:2223, 사용자 tablepeek, 키 `testdb/ssh/id_ed25519`)를 띄우고, 그 너머에서 서버는 `oracle:1521`(TCP)·`oracle:2484`(TCPS)다.
- 단위 시험(서버 없이): 문장 준비(`;`·`/`·EXEC·컴파일 단위 이름), 셀 글자 → SQL(긴 BLOB의 조각 포함), 접속 문자열, 연결 문자열의 터널 대상(Easy Connect 하나·tnsnames.ora 별칭의 두 주소)과 주소 바꾸기, 콘솔의 바인드·q-문자열·비밀번호 가리기.
- 라이브 시험(`TABLEPEEK_TEST_ORACLE=1 cargo test -p tablepeek-engine oracle`): 목록·정의·구조, 모든 타입과 페이지, 키 편집(40,002바이트 BLOB 포함)과 트랜잭션, 오류 위치·실행 계획·DBMS_OUTPUT·EXEC·컴파일 오류·세션, 취소 두 갈래(권한 있는 TABLEPEEK은 CANCEL SQL로 4초 안에 ORA-01013, 트랜잭션과 그 행이 남음·`cancel_ends_session` 거짓; 권한 없는 SHOP은 세션을 버림·참), 시간 제한, 잘못된 로그인(1017)·없는 서비스(12514)·없는 SID(12505)·SID로 CDB 접속·Easy Connect, TCPS(호스트·포트와 `tcps://` 문자열, CA 없는 월렛은 거절), 로컬 끝을 지나는 TCPS(기술자의 HOST로 확인: `localhost`는 통과, 인증서에 없는 이름은 127.0.0.1로 이어도 거절), 5MiB BLOB 쓰고 읽기·끊긴 올리기는 옛 값 유지·트랜잭션 안에서 바꾸고 롤백·RAW(100) 넘침 거절·없는 행은 404, 다른 세션이 바꾼 뷰의 DDL. 서버 쪽(`TABLEPEEK_TEST_ORACLE=1 cargo test -p tablepeek-server oracle`): SSH 터널로 호스트·포트 TCPS, Easy Connect TCPS, 두 주소 기술자, 인증서에 없는 컨테이너 이름(`tablepeek-testdb-oracle-1`)은 거절. out-of-band break는 이 컴퓨터에서 닿지 않아(Docker Desktop 포트 전달이 긴급 데이터를 버림) `make test-oracle-oob`가 시험 네트워크의 컨테이너에서 DISABLE_OOB를 잠시 끄고 `crates/vendor/oracledb/tests/tablepeek_break.rs`를 돌린다: TCP·TCPS에서 SLEEP과 큰 조인이 1초 남짓에 ORA-01013, 같은 SID·열린 트랜잭션 유지, 호출이 끝날 무렵 보낸 break 40번이 다음 호출에 닿지 않음.
- 브라우저 점검(관리형 Chromium, 비밀번호 "매번 입력"): 서비스 이름·연결 문자열 접속과 연결 시험, 사이드바(다른 스키마·구체화된 뷰·시퀀스·동의어·패키지·타입), 패키지·타입·시퀀스·동의어 정의, 데이터 탭(값 표기·필터 CONTAINS·OFFSET 페이지), 셀 편집·행 추가(트리거가 키를 채움)·행 삭제 적용, 구조·인덱스·DDL·컬럼 추가, `/`로 나뉜 PL/SQL 두 블록과 DBMS_OUTPUT·q-문자열, 자동완성(테이블·TO_CHAR), 실행 계획 트리, 세션 목록과 다른 세션 종료, 트랜잭션으로 실행 후 롤백, 안전 모드 확인, ORA-00942 오류 도움말과 위치 밑줄, 실행 중 취소 후 새 세션, 덤프 내려받기·복원(모든 타입 그대로 왕복), CSV 가져오기·내보내기, 사용자 목록.
- 2026-10-29 추가 브라우저 점검: 연결 문자열 `tcps://oracle:2484/FREEPDB1` + 월렛 + SSH 키 터널로 연결 시험·저장·접속(`NETWORK_PROTOCOL`=tcps), 안전 모드 "모든 변경 확인"에서 DBMS_OUTPUT 블록은 묻지 않고 UPDATE 블록·EXECUTE IMMEDIATE 블록은 물음, CSV 업서트 가져오기(있던 행은 바뀌고 없던 행은 추가), BLOB 셀에 3,000바이트 값 적용(콘솔에 `:blob1_1` 블록), ALTER 뒤 DDL에 새 열, 트랜잭션 안의 정지 확인(취소하면 계속, 확인하면 0.5초 안에 멈추고 트랜잭션 표시가 사라짐; 트랜잭션 밖에서는 묻지 않음), SQL Server에서 같은 정지 확인.
- 2026-10-30 브라우저 점검(관리형 Chromium, 비밀번호 "매번 입력"): 100,000바이트 BLOB 셀(`<blob 100000 bytes>`)의 "전체 값 내려받기"로 100,000바이트 그대로 받음, "값 바꾸기…"에 끌어놓은 300,000바이트 파일로 바꾸고 커밋·그리드 다시 읽기, 16진수 칸의 잘못된 값은 "Not hex"로 막고 `0x CAFE BABE 00`은 5바이트로 적용(DB에서 확인), 트랜잭션 안에서 INSERT 뒤 `DBMS_SESSION.SLEEP(30)` 정지: 묻지 않고 3초 안에 멈춤(콘솔에 `ALTER SYSTEM CANCEL SQL`), 트랜잭션 표시가 남고 같은 세션에서 행이 보임, Rollback 뒤 0행.

## 10. 한계

- 남은 것은 Oracle 자체의 한계뿐이다:
  - out-of-band break를 받지 않는 서버(DISABLE_OOB=ON, 시험 이미지 gvenzl의 기본)나 긴급 데이터를 버리는 경로(SSH·HTTP 터널, Docker Desktop의 포트 전달)에서 ALTER SYSTEM 권한도 없으면 취소가 세션을 끝낸다. in-band break는 서버가 문장이 끝날 때까지 읽지 않는다(DBMS_SESSION.SLEEP과 큰 조인으로 확인). 그런 접속은 `cancel_ends_session`이 참이라 웹이 먼저 묻는다.
  - RAW 열의 크기(RAW(n), 최대 2000 또는 MAX_STRING_SIZE=EXTENDED에서 32767바이트)는 타입의 한계다. BLOB은 크기 제한 없이 셀 메뉴의 "전체 값 내려받기"·"값 바꾸기…"(텍스트·16진수·끌어놓거나 붙여 넣은 파일, 진행률)로 다룬다(§5, `binary_cells`).
- 해결한 것: TCPS 터널(로컬 끝은 주소 경로로만 쓰고 기술자의 HOST로 인증서 확인), 세션을 살리는 취소(§7), 16KiB 넘는 BLOB의 전체 값, 다른 세션이 바꾼 구조의 DDL(꺼낼 때마다 ALL_OBJECTS의 LAST_DDL_TIME·개수·OBJECT_ID 합 표식을 비교; 같은 초 안의 변경은 기억하지 않고, 시퀀스는 매번 읽음).
