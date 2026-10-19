# TablePlus 기능 격차 분석 (Parity Checklist)

작성: 2026-10-18 · 갱신: 2026-10-19 · 대상: 설치된 TablePlus 27.0.2 (빌드 818, `/Applications/TablePlus.app`)

## 0. 근거와 방법

- 런타임 메뉴 덤프 (실행 중인 앱 대상 System Events): Apple / TablePlus / File / Edit / View / Tools / Connection / Theme / Navigate / Window / Help
- `en.lproj/Localizable.strings` 925개 항목 (UI 문자열 기반 기능 목록)
- 공식 문서 `docs.tableplus.com` (llms.txt 전체 목차 + 개별 페이지)
- 앱 번들 Frameworks 목록 (지원 드라이버 실측): BigQuery, Cassandra, ClickHouse, CloudflareD1, DynamoDB, ElasticSearch, DynamoDB, MariaDB, ... (13종 이상)
- WrenDB 코드 기준 현재 상태 판정

원칙: 동작·기능 동등성만 목표로 하며 TablePlus의 코드·에셋·디자인을 복제하지 않는다 (독립 구현).

REA 상태: `rea` CLI 설치됨(`~/.nvm/.../bin/rea`), opencode 미등록 + 네이티브 분석 엔진(Hopper/Ghidra/IDA) 부재 → 이번 분석은 위 문서·문자열 근거로 수행. 심층 바이너리 분석이 필요하면 `rea setup --client opencode`(승인 필요, 재시작) + Hopper/Ghidra 설치가 선행되어야 함.

## 0-1. 실측 검증 — 테이블 클릭 시 실행되는 SQL (2026-10-18)

방법: 프로젝트 테스트 컨테이너(`wrendb-pg`, PostgreSQL 16.15)에 `log_statement='all'`을 켜고, URL 딥링크로 TablePlus를 해당 DB에 연결한 뒤 테이블 열기·페이지 이동을 실행해 서버 로그로 실제 전송 SQL을 포착.

포착된 SQL (TablePlus 27.0.2 → PostgreSQL):

- 메타 조회 (연결 시 1회): `SELECT version()`, `pg_type`(geometry/geography 감지), `pg_namespace`, `pg_proc`(함수 목록), `information_schema.tables`, `pg_class`(r/v/p), matview
- 테이블 열 때 (메타 → 데이터 순서):
  - 크기/코멘트: `pg_total_relation_size / pg_table_size / pg_indexes_size / obj_description` (멀티라인)
  - PK: `information_schema.table_constraints` + `key_column_usage` (constraint_type='PRIMARY KEY')
  - FK: `pg_constraint` (contype='f', on_update/on_delete)
  - enum: `pg_type JOIN pg_enum`, 생성 컬럼: `information_schema.columns` (is_generated='ALWAYS')
  - **데이터: `SELECT * FROM "public"."orders" ORDER BY "id" LIMIT 300 OFFSET 0;`**
  - 행수: `select reltuples::int8 as count ...` (추정) + `SELECT COUNT(*) as count FROM "public"."orders";` (정확)
- 다음 페이지: `SELECT * FROM "public"."orders" ORDER BY "id" LIMIT 300 OFFSET 300;` (+ 매 페이지 COUNT 재실행)
- PK 없는 테이블: `SELECT * FROM "public"."tp_nopk" LIMIT 300 OFFSET 0;` → **PK 없으면 ORDER BY 생략**

결론: TablePlus도 클릭 시 SQL을 자동 생성·실행한다. 동작 원리는 동일하되 세부가 다름 → WrenDB 반영 완료:

1. **PK 기본 정렬** — PK 있으면 `ORDER BY "pk"` 자동 추가 (PK 없으면 생략). OFFSET 페이지네이션 안정성 확보. `dataQuery.ts buildPkOrder`, `App.tsx primaryKeyOf` (구조 상세의 primary 인덱스 → 없으면 엔진이 감지한 meta.pk).
2. **기본 페이지 300** — `DEFAULT_PAGE_SIZE=300`, 옵션 `[100, 300, 500, 1000, 5000]`.
3. **메타 우선 로드** — 데이터 탭 첫 실행 전 `/api/table` 상세를 먼저 조회해 PK를 확보한 뒤 데이터 SQL 실행 (TablePlus 관찰 순서와 동일).

잔여 차이 해소 (M11 완료): ① 테이블 이름 스키마 한정 — mysql `db.table`/mssql `schema.table` 표시 및 `table_count` 한정 처리, `TableDetail.schema` 추가 ② 상태바 총행수 — COUNT 버튼으로 정확값 조회, COUNT 후 `총 N행`/`N / M 페이지` 표시 ③ COUNT 재조회 — COUNT한 탭은 페이지 이동·행 편집 후 자동 재조회.

## 1. 연결 홈 / 연결 관리

| 기능 | TablePlus | WrenDB 현재 | 상태 | 웨이브 |
|---|---|---|---|---|
| 첫 화면 = 연결 목록 (카드/그룹) | Welcome 화면, 저장 연결 목록 | 있음 (연결 홈: 열린 연결 카드 + 저장 연결 목록 + 데모/파일/새 연결) | 완료 | M10 |
| 최근 연결 우선 정렬 | 있음 | 있음 (`last_used` 기준 내림차순, 상대 시간 표시) | 완료 | M10 |
| 연결 상태 배지 | 있음 | 있음 (상단 연결 바 탭에 연결됨/연결 중/끊김 + 연결 홈 카드 상태 점 + 드라이버 배지) | 완료 | M18.1 |
| 다중 연결 동시 사용 (인앱 전환) | 있음 (Database 사이드바 전환) | 있음 (상단 연결 바 + 서버 ConnSlot 레지스트리 + 연결별 워크스페이스, WS 메시지 conn 라우팅) | 완료 | M18.1 |
| 저장 연결 CRUD + 키체인 비밀번호 | 있음 | 있음 (홈 카드에서 새 창·편집·삭제, 삭제 시 열린 세션 유지) | 완료 | M18.1 |
| 연결 그룹/태그/색상 | 그룹, 태그 | 있음 (로컬 메타데이터 `conn-meta`: 그룹 섹션·색상 점·태그 칩·편집 모달) | 완료 | M15 |
| 환경 배지 (LOCAL/DEV/STAGE/PROD) | 있음 | 있음 (연결 홈·저장 연결·상단 연결 바·상태바·스키마 사이드바, 기존 그룹명에서 환경 자동 추론) | 완료 | M18.1 |
| SSH 터널 | 있음 | 있음 (russh, 키/비밀번호) | 완료 | — |
| HTTP 터널 | 있음 | 있음 (CONNECT 프록시·Basic 인증, 로컬 포워딩, 저장 연결 키링 비밀번호) | 완료 | M15 |
| TLS 직접 접속 (CA/클라이언트 인증서) | 있음 ("Allow remote access (TLS)") | 있음 (PG/Cockroach `ssl_mode`, MySQL TLS, CA·mTLS) | 완료 | M15 |
| 접속 전 환경 점검(클라이언트 존재 확인 등) | 있음 | 있음 (입력 검증 + `/api/fs/stat` 기반 CA/클라이언트 인증서·SSH 키 파일 점검) | 완료 | M15 |

## 2. 워크스페이스 / 탭 / 창

| 기능 | TablePlus | WrenDB 현재 | 상태 | 웨이브 |
|---|---|---|---|---|
| 탭 (쿼리/테이블 등) | 있음 | 있음 (쿼리·데이터·구조·서버·정의) | 완료 | — |
| New Workspace / New SQL Viewer | File 메뉴 | 있음 (연결 홈의 새 연결/파일/데모 + 상단 연결 바 추가 버튼, 새 탭) | 완료 | M18.1 |
| 워크스페이스 분리·복원 (세션 복구) | 있음 | 있음 (연결별 워크스페이스, localStorage `wrendb.workspaces` 복원) | 완료 | M10 |
| 다중 창 (별도 윈도우) | 있음 (Window 메뉴) | 있음 (`/?conn=<id>` URL + 연결 홈 카드 "새 창에서 열기") | 완료 | M18.1 |
| 연결별 독립 탭 세트 | 있음 | 있음 (conn별 TabsState, 전환 시 편집기/결과 스냅샷 복원) | 완료 | M10 |

## 3. 사이드바 / 스키마 탐색

| 기능 | TablePlus | WrenDB 현재 | 상태 | 웨이브 |
|---|---|---|---|---|
| 사이드바 연결 컨텍스트 | 있음 (현재 DB 표시) | 있음 (DB 헤더: 연결명·드라이버·환경 배지·연결 상태 점) | 완료 | M18.1 |
| 테이블 클릭 → 데이터 표시 | 있음 (클릭 즉시 Data) | 있음 (단일 클릭=데이터, 화살표=컬럼 펼침) | 완료 | M11 |
| 테이블 오버뷰 (전체 목록 개요) | 있음 (Tables 헤더 클릭) | 있음 (개요 탭: 이름·컬럼수·행수·크기, 검색, 상위 200개 상세) | 완료 | M11 |
| 퍼지 검색 | 있음 | 있음 (부분열 매칭 fuzzy score) | 완료 | M11 |
| Recent 섹션 (최근 5개) | 있음 | 없음 (사용자 요청으로 제거) | 제외 | M11 |
| Pin to top | 있음 | 있음 (우클릭 고정 토글, pinned 우선 정렬, localStorage) | 완료 | M11 |
| 테이블 우클릭 메뉴 (구조/복제/Truncate/Delete/Script 복사) | 있음 | 있음 (데이터/구조/DDL/편집기/고정/CREATE 복사/SELECT 복사/복제/TRUNCATE/삭제) | 완료 | M11 |
| 뷰/함수/프로시저/트리거 섹션 | 있음 (함수 토글, 시스템 스키마 토글) | 있음 (뷰/함수/프로시저/트리거 구분, 서버 include_system 지원) | 완료 | M11 |
| 시스템 스키마 표시 토글 | 있음 | 있음 (SYS 토글, localStorage `wrendb.system-tables`, `/api/meta?system=1`) | 완료 | M11 |
| 다중 DB 스위처 (연결 내 DB 전환) | 있음 (⌘K) | 있음 (⌘K/DB 버튼, `/api/databases`+`/api/switch-db`로 같은 연결 슬롯 엔진 교체) | 완료 | M11 |
| 스키마(DB) 목록·생성·삭제 | 있음 | 있음 (DB 스위처에서 생성·삭제, 확인 모달) | 완료 | M12 |

## 4. 테이블 뷰 — 데이터

| 기능 | TablePlus | WrenDB 현재 | 상태 | 웨이브 |
|---|---|---|---|---|
| Data / Structure / DDL 한 탭 내 전환 (하단) | 있음 (⌘^[ , ⌘^]) | 있음 (데이터/구조/DDL 세그먼트, ⌘⌃[·⌘⌃] 순환) | 완료 | M11 |
| 가상화 그리드 (대량 행) | 있음 | 있음 (Canvas) | 완료 | — |
| 그리드 텍스트 대비·헤더 경계 | 있음 | 있음 (타입별 셀 잉크 색, 라이트/다크 대응, 긴 컬럼명 말줄임·정렬 화살표 예약) | 완료 | M18.1 |
| 셀 편집 (PK 기반) | 있음 | 있음 | 완료 | — |
| 행 추가/복제/삭제 | 있음 | 있음 | 완료 | — |
| 필터 (AND/OR) | 있음 | 있음 | 완료 | — |
| 정렬 (다중) | 있음 | 있음 | 완료 | — |
| 페이지네이션 (기본 300행, limit/offset 직접 입력) | 있음 | 있음 (LIMIT/OFFSET 직접 입력, 최대 500,000, COUNT 버튼) | 완료 | M11 |
| 컬럼 표시/숨김·정렬 변경 | 있음 | 있음 (컬럼 팝오버: 표시·숨김·순서, SQL projection 기반) | 완료 | M11 |
| 행 상세 (Row view) | 있음 | 있음 (필드·관계·JSON·SQL 탭, FK 배지·참조 행 이동, JSON 상세 패널) | 완료 | M18 |
| JSON 뷰어/편집 (문서형 값) | 있음 | 있음 (JSON 탭 편집: 파싱·정규화 후 변경 컬럼만 저장) | 완료 | M11 |
| 컬럼 데이터 타입 자동 감지 | 있음 | 있음 (선언 타입 표시 `decl_type`, 구조 패널·사이드바 컬럼) | 완료 | M11 |
| 참조(FK) 행 점프 | 있음 | 있음 | 완료 | — |
| 안전 모드 / Alert Mode 1·2 | 있음 | 있음 (모드 0/1/2 순환, WHERE 없는 UPDATE/DELETE 확인·리뷰) | 완료 | M14 |
| Code Review (변경분 검토 후 커밋) | 있음 (연결 Safe mode) | 있음 (주의 모드 2: SQL 검토 모달 + 트랜잭션 실행 옵션) | 완료 | M14 |
| 인코딩 변경 (View Using Encoding) | 있음 | 부분 (Quick Look에서 UTF-8 바이트를 선택 인코딩으로 재해석, HEX 표시; 원본 바이트 복원은 미지원) | 부분 | M17 |
| Auto hide scroller / Alternating row 색 | 설정 | 있음 (스크롤바 숨김·대체 행 배경 설정, 캔버스 즉시 반영) | 완료 | M15 |

## 5. 테이블 구조 / DDL / 생성·수정

| 기능 | TablePlus | WrenDB 현재 | 상태 | 웨이브 |
|---|---|---|---|---|
| 구조 보기 (컬럼/인덱스/FK/트리거/제약) | 있음 | 있음 (컬럼/인덱스/FK/DDL + 트리거·시퀀스·함수·프로시저 섹션) | 완료 | M12 |
| 구조 편집 (컬럼 추가/수정/삭제, ⌘S 커밋) | 있음 | 있음 (드래프트 편집 + DDL 미리보기 + ⌘S 실행; sqlite는 리빌드 경로) | 완료 | M12 |
| 인덱스/FK/제약 편집 | 있음 | 있음 (인덱스·외래 키 편집; sqlite FK 변경 제외) | 완료 | M12 |
| 테이블 생성 GUI (+Column, PK 지정, DDL 미리보기) | 있음 | 있음 (컬럼/인덱스 빌더 + PK + MySQL 엔진·문자셋 + 미리보기) | 완료 | M12 |
| 테이블 이름 변경 / Truncate / Delete | 있음 | 있음 (우클릭 메뉴: 이름 변경·TRUNCATE·삭제, 열린 탭 동기화) | 완료 | M12 |
| DDL(Definition) 보기 | 있음 | 있음 | 완료 | — |
| Copy Script As (CREATE/DROP/TRUNCATE/Laravel) | 있음 (Dump Table 플러그인) | 있음 (CREATE/SELECT/DROP/TRUNCATE/Laravel 스키마) | 완료 | M12 |
| 정렬 규칙·스토리지 옵션 등 세부 설정 | 있음 | 있음 (MySQL 엔진·문자셋·콜레이션·ROW_FORMAT·COMMENT) | 완료 | M12 |

## 6. 오브젝트 (뷰/함수/프로시저/트리거)

| 기능 | TablePlus | WrenDB 현재 | 상태 | 웨이브 |
|---|---|---|---|---|
| 뷰 정의 보기 + 데이터 | 있음 | 완료 (정의/데이터) | 완료 | — |
| 함수/프로시저 정의 보기 | 있음 | 있음 (뷰/함수/프로시저/트리거/시퀀스 정의 보기, 드라이버별 분기) | 완료 | M12 |
| 함수/프로시저/트리거 생성·편집 (Template) | 있음 | 있음 (드라이버별 CREATE 템플릿 + DROP 템플릿, 편집기에서 열기) | 완료 | M12 |
| 트리거 보기/편집 | 있음 | 있음 (정의 보기 + CREATE/DROP 템플릿) | 완료 | M12 |
| 시퀀스 보기/편집 | 있음 | 있음 (pg/mssql 목록 + 정의 보기 + CREATE/DROP 템플릿) | 완료 | M12 |

## 7. 쿼리 에디터 / 결과

| 기능 | TablePlus | WrenDB 현재 | 상태 | 웨이브 |
|---|---|---|---|---|
| 실행/취소, 최대 행 상한 | 있음 | 있음 | 완료 | — |
| 스트리밍 결과 / 비동기 로딩 | 있음 | 있음 (Arrow 스트리밍) | 완료 | — |
| History / Favorites | 있음 | 있음 | 완료 | — |
| Favorite 키워드 바인딩 | 있음 | 있음 (`:keyword` 저장 + 에디터 자동완성) | 완료 | M14 |
| 자동완성 (스키마 기반: 테이블/컬럼/키워드) | 있음 | 있음 (스키마 테이블·컬럼, 키워드, 즐겨찾기 키워드) | 완료 | M14 |
| Format (beautify/minify/uglify) | 있음 | 있음 (Beautify/Minify, 문자열·주석 보존) | 완료 | M14 |
| 다중 커서 | 있음 | 있음 (⌘D 다음 일치 선택, CodeMirror 기본) | 완료 | M14 |
| Split Panes (에디터 분할) | 있음 | 있음 (상하/좌우 전환, 크기 드래그·저장) | 완료 | M14 |
| 결과 분할 탭 (multi-statement) | 있음 | 있음 (순차 실행 + `결과 N` 칩 전환) | 완료 | M14 |
| 쿼리 파라미터 | 있음 | 있음 (`:name` 모달, SQL 리터럴 바인딩, 값 기억) | 완료 | M14 |
| 쿼리 자동 저장 | 있음 | 있음 (탭별 초안 자동 저장, 닫아도 보존, 팔레트 복구) | 완료 | M14 |
| 실행 계획 (Explain) | 있음 | 있음 (PG/MySQL JSON, SQLite QUERY PLAN 트리·비용·행·원본 JSON) | 완료 | M14 |
| 콘솔 로그 (쿼리 로그) | 있음 | 있음 (최근 300건, 검색·소요시간·성공 여부·SQL 재열기) | 완료 | M15 |
| Quick Look (스페이스바 미리보기) | 있음 | 있음 (스페이스=행 상세, 셀 가운데 클릭·⌘Enter=우측 Quick Look drawer, JSON 트리·인코딩/HEX·셀 편집, ⌥클릭=셀 메뉴) | 완료 | M18 |
| Open Anything (⌘P) | 있음 | 있음 (팔레트) | 완료 | — |
| 대문자 자동 변환·자동 괄호 등 에디터 옵션 | 있음 | 부분 (키워드 대문자 변환 설정, 자동 괄호는 CodeMirror 기본) | 부분 | M15 |

## 8. 가져오기 / 내보내기 / 백업

| 기능 | TablePlus | WrenDB 현재 | 상태 | 웨이브 |
|---|---|---|---|---|
| 내보내기 (CSV/JSON/SQL) | 있음 (CSV/JSON/XML/SQL) | 완료 (CSV/JSON/XML/SQL) | 완료 | M13 |
| XML 내보내기 | 있음 | 있음 (toXml, 형식 라디오) | 완료 | M13 |
| 가져오기 (CSV/JSON, 컬럼 매핑 미리보기) | 있음 | 있음 (ImportModal: 구분자 자동감지·매핑·미리보기·청크 INSERT) | 완료 | M13 |
| CSV 옵션 (헤더/구분자/인코딩 기본값) | 설정 있음 | 완료 (헤더/BOM/구분자 4종 내보내기, 인코딩 3종·헤더·빈값→NULL 가져오기) | 완료 | M13 |
| Export/Import 작업 큐 (진행률, done 목록) | 있음 | 있음 (jobs 큐 + JobsModal, 진행 바·오류·완료 정리) | 완료 | M13 |
| Backup / Restore (DB 덤프) | 있음 | 있음 (DumpModal: DDL+데이터 페이징 덤프, 문장 분할 복원) | 완료 | M13 |

## 9. 운영 / 안전 / 계정

| 기능 | TablePlus | WrenDB 현재 | 상태 | 웨이브 |
|---|---|---|---|---|
| 세션/프로세스 목록 + 킬 | 있음 | 있음 (서버 정보 탭) | 완료 | — |
| Activity (작업 로그, 정리 정책) | 있음 | 있음 (작업/DDL 기록, 보관 기간 자동 정리, 비우기) | 완료 | M15 |
| Metrics board (간이 차트 보고서) | 있음 | 있음 (쿼리 수·평균/최대 시간·반환 행·오류 카드 + 최근 30건 SVG 막대) | 완료 | M15 |
| User management (DB 계정 관리) | 있음 | 있음 (pg/mysql/mssql: 목록·생성·삭제·비밀번호 변경; sqlite 미지원 안내) | 완료 | M12 |
| Passcode 잠금 | 있음 | 있음 (SHA-256 로컬 잠금 화면; 암호화 아님) | 완료 | M15 |

## 10. 설정 / 테마

| 기능 | TablePlus | WrenDB 현재 | 상태 | 웨이브 |
|---|---|---|---|---|
| 설정 창 카테고리 탐색 | 있음 (탭/섹션) | 있음 (좌측 내비게이션: 일반·모양·에디터·데이터·단축키·보안) | 완료 | M18.1 |
| 다크 모드 | 있음 | 있음 (다크/라이트 전환, 설정 저장) | 완료 | M15 |
| 라이트 모드 / 커스텀 테마 (Git 테마 가져오기) | 있음 | 있음 (내장 9종 + Git URL에서 Base16/VS Code/WrenDB 테마 가져오기·로컬 저장·삭제) | 완료 | M15 |
| 폰트·컬러 설정 | 있음 | 있음 (에디터 폰트 패밀리·크기, 강조색) | 완료 | M15 |
| SQL syntax 색상 preset | 있음 | 있음 (WrenDB/TablePlus/Solarized/Monokai/GitHub/Nord, 설정 미리보기·즉시 반영) | 완료 | M18 |
| Keymap (단축키 재지정) | 있음 | 있음 (실행/새 탭/닫기/팔레트/DB 전환 5종, 키 캡처·기본 복원) | 완료 | M15 |
| CSV/에디터/테이블 기본 설정 | 있음 | 있음 (CSV 구분자/헤더/인코딩 기본값, 대체 행·스크롤바·대문자 변환·활동 보관) | 완료 | M15 |

## 11. 지원 데이터베이스

| 항목 | TablePlus | WrenDB 현재 | 상태 |
|---|---|---|---|
| SQLite | 있음 | 있음 | 완료 |
| PostgreSQL | 있음 | 있음 | 완료 |
| MySQL | 있음 | 있음 | 완료 |
| MariaDB | 있음 | 있음 (MySQL 경로) | 완료 |
| CockroachDB | 있음 | 있음 | 완료 |
| SQL Server | 있음 | 있음 | 완료 |
| Redshift / Vertica / Percona / Yugabyte | 있음 | 부분 (MariaDB/Percona/Yugabyte/Redshift는 호환 접속·서버 정보 표시, Vertica wire protocol 미지원) | 부분 |
| Oracle | 있음 (macOS) | 없음 | 결정 필요 |
| Snowflake | 있음 | 없음 | 결정 필요 |
| Redis / MongoDB / Cassandra / DynamoDB / ElasticSearch / BigQuery / ClickHouse / CloudflareD1 | 있음 | 없음 (KV·문서·분석형은 그리드 모델과 별개 뷰 필요) | 결정 필요 |
| DBngin (로컬 서버 관리 앱) | 별도 제품 | 범위 외 | — |
| Plugin 시스템 / LLM 플러그인 | 있음 | 부분 (MCP stdio 서버로 읽기 전용 도구 제공; 플러그인 샌드박스는 후순위) | 부분 |

## 12. 웨이브 계획 (실행 순서)

| 웨이브 | 내용 | 근거 |
|---|---|---|
| M10 | 연결 홈(카드 목록·최근순·상태 배지) + 인앱 멀티커넥션(연결별 워크스페이스·탭·서버 레지스트리) | 사용자 확정 |
| M11 | 테이블 뷰 재편: 클릭=데이터, Data/Structure/DDL 통합 탭, 우클릭 메뉴(Pin/Truncate/Delete/Script 복사), 오버뷰, Recent, 퍼지 검색, limit/offset 설정, 컬럼 숨김 | 사용자 지적 |
| M12 | 구조 편집(컬럼/인덱스/FK, ⌘S 커밋) + 테이블/스키마 생성·삭제 + 오브젝트 생성/편집 + User management | 격차 |
| M13 | 가져오기(CSV/JSON 매핑) + XML 내보내기 + Backup/Restore + 작업 큐 | 격차 |
| M14 | 에디터 고도화: 스키마 자동완성, Format, 결과 분할, 파라미터, 자동 저장, Safe mode 강화(Alert 1/2, Code Review) | 격차 |
| M15 | 운영/설정: Activity, Metrics board, 테마(9종·Catppuccin·Git 가져오기), 키맵, 폰트, 콘솔 로그, Quick Look, HTTP 터널, TLS, 접속 점검 | 완료 |
| M16 | 숨은 마우스 동작(가운데/⌘/⌥), 셀 Quick Look, 디자인 시스템·모션 | 완료 |
| M17 | 인코딩/HEX 인스펙터, MySQL TLS 폴백 축소, 키체인 왕복, MCP 서버 | 완료 (원본 바이트 복원 제외) |
| M18 | 로딩 스피너·탭 애니메이션, syntax preset, JSON 트리 Quick Look drawer, 환경 배지, 행 관계 탭·FK 점프 | 완료 |
| M18.1 | 그리드 셀 텍스트 대비·헤더 ellipsis, 상단 다중 연결 바, DB 컨텍스트 사이드바, 카테고리 설정 모달, 저장 연결 삭제 | 완료 |
| 후순위 | 추가 드라이버(KV/문서형 포함 여부), Plugin 샌드박스, 자동 업데이트(M5) | 결정 필요 |

각 웨이브는 기존 검증 규칙을 따른다: `cargo test`(게이트 포함), `npm run build`, ws-smoke ALL PASS, 실서버 e2e.
