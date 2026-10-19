# WrenDB

성능 우선 크로스플랫폼 DB 클라이언트 — 로컬 Rust 엔진 + 브라우저 UI.
설계 배경과 로드맵은 `docs/ARCHITECTURE.md`, TablePlus 대비 기능 격차와 웨이브 계획은 `docs/TABLEPLUS-PARITY.md`, 남은 범위 결정은 `docs/REMAINING-SCOPE.md` 참고.

## 요구사항

- Rust (stable)
- Node.js 20+ (웹 UI 빌드용)
- macOS / Windows (Linux도 동일 구조로 동작 예정)

## 빌드

```sh
cd web && npm install && npm run build   # 웹 UI 번들 생성 (web/dist)
cargo build                              # 번들을 바이너리에 임베드
```

## 실행

```sh
cargo run -p wrendb -- serve                        # 인메모리 데모 DB(10,000행)로 시작
cargo run -p wrendb -- serve --demo-rows 500000     # 데모 행 수 지정 (최대 2,000,000)
cargo run -p wrendb -- serve --db path/to.sqlite    # 실제 SQLite 파일 열기
```

브라우저가 자동으로 열립니다. 옵션: `--port <n>`, `--no-open`.

## DB 연결

UI 상단 "연결" 버튼에서 드라이버를 선택하고 접속 정보를 입력합니다.

| 드라이버 | 대상 | 비고 |
|---|---|---|
| SQLite | 파일 / 데모(인메모리) | "파일 열기"·"데모" 버튼 또는 `--db` 옵션 |
| PostgreSQL | PostgreSQL 서버 | `ssl_mode=disable/prefer/require` · CA·클라이언트 인증서(mTLS) 지원 |
| MySQL | MySQL / MariaDB | TLS(`prefer`/`require`) · CA·클라이언트 인증서(mTLS) 지원 |
| CockroachDB | CockroachDB | PG 프로토콜 경로 재사용 |
| SQL Server | MSSQL (TDS) | `encrypt` 옵션으로 TLS 여부 선택 |

- TLS: SSL 모드가 `disable`이 아니면 CA 인증서 경로와 선택적으로 클라이언트 인증서·키를 지정할 수 있습니다. 연결 전 "점검" 버튼이 입력값과 로컬 인증서/SSH 키 파일을 확인합니다.
- SSH 터널: 체크 후 SSH 호스트/포트/사용자/키 경로(또는 비밀번호) 입력. 이때 DB 호스트/포트는 **SSH 서버 관점** 주소입니다 (예: 원격지에서 127.0.0.1:5432).
- 저장: "저장" 체크 시 `~/.wrendb/store.json`에 비밀번호를 제외한 정보가 저장되고, "비밀번호도 함께 저장"을 체크하면 비밀번호는 OS 키체인에만 보관됩니다. macOS에서는 `/usr/bin/security`를 통해 접근하므로, 기존 항목의 첫 접근 시 **항상 허용**을 한 번 선택하면 이후 앱을 다시 빌드해도 허용 창이 반복되지 않습니다.

## UI 기능 요약

- 탭: 쿼리 / 데이터 / 구조 / 서버 정보 / 정의(DDL) 탭. ⌘T 새 탭, ⌘W 닫기, ⌘P 커맨드 팔레트.
- 상단 연결 바: 홈·열린 연결 탭·추가 버튼을 한 줄에 배치. 연결별 색상, 드라이버·환경 배지, 연결 상태 점으로 다중 연결을 즉시 전환.
- 스키마 사이드바: 연결명·드라이버·환경·상태를 보여주는 DB 헤더, 테이블 검색·컬럼 펼치기, 구조 보기, 테이블·뷰별 오브젝트 섹션(뷰/함수/트리거/시퀀스), 서버 정보 진입. 테이블 가운데/⌘클릭은 새 탭.
- 데이터 탭: 필터(AND/OR)·정렬(헤더 클릭, Shift 다중)·페이지네이션, 행 추가(기본값)·복제·삭제, 셀 편집(PK 기반)·트랜잭션, 참조 행 점프(FK), 행 상세, CSV/JSON/SQL 내보내기.
- Quick Look: 셀 가운데 클릭 또는 ⌘Enter로 우측 drawer에서 값·JSON 트리·인코딩/HEX 확인 및 PK 기반 편집, ⌥클릭은 셀 메뉴. 스페이스바는 관계 탭이 있는 행 상세.
- 환경·로딩: LOCAL/DEV/STAGE/PROD 환경 배지, 탭/결과 로딩 스피너와 열림 애니메이션, SQL syntax preset 6종.
- 쿼리 도구: 실행 계획 시각화(EXPLAIN/EXPLAIN ANALYZE 트리·비용·예상/실제 행), SQL 스니펫, 안전 모드(WHERE 없는 UPDATE/DELETE 확인), 기록·즐겨찾기.
- 스키마: 테이블 클릭=데이터, 우클릭 메뉴에서 Laravel 스키마 복사, DB 생성/삭제, MySQL collation·ROW_FORMAT·COMMENT.
- 서버 정보 탭: 엔진 버전·크기·가동 시간·세션 목록, 세션 종료(지원 엔진), MariaDB/Percona/Yugabyte/Redshift 호환 모드 표시.
- 연결 홈: 저장 연결 카드에서 새 창 열기·편집·삭제, 열린 연결과 최근 연결을 한 화면에 표시.
- 설정: 좌측 카테고리 탐색(일반·모양·에디터·데이터·단축키·보안). 내장 테마 9종 + Git 원본 URL에서 Base16/VS Code/WrenDB 테마 JSON 가져오기, 글꼴·강조색·대체 행·스크롤바·CSV·키맵·활동 보관 설정.
- MCP: `wrendb mcp` stdio 서버로 연결·스키마·읽기 전용 쿼리 노출. 설정은 `docs/MCP.md`.

## 테스트

```sh
cargo test                     # Rust 단위 테스트 (기본: 게이트 없이 실행되는 범위)
cd web && npm run build        # 웹 타입체크(strict) + 프로덕션 번들
cd web && node scripts/ws-smoke.mjs "http://127.0.0.1:7699/?token=..."   # WS e2e 스모크(17종)
```

Docker 연동 테스트 (선택, 컨테이너 필요):

```sh
docker run -d --name wrendb-pg -e POSTGRES_USER=wrendb -e POSTGRES_PASSWORD=wrendb_test_pw \
  -e POSTGRES_DB=wrendb_test -p 5433:5432 postgres:16-alpine
docker run -d --name wrendb-mysql -e MYSQL_ROOT_PASSWORD=root_pw -e MYSQL_DATABASE=wrendb_test -p 3307:3306 mysql:8
docker run -d --name wrendb-mssql -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD=MsSql_test_pw1 -p 14330:1433 mcr.microsoft.com/mssql/server:2022-latest
docker run -d --name wrendb-crdb -p 26258:26257 cockroachdb/cockroach:latest start-single-node --insecure
# wrendb-ssh: SSH 터널 테스트용 컨테이너 (2222 포트)

WRENDB_TEST_PG=1 WRENDB_TEST_MYSQL=1 WRENDB_TEST_COCKROACH=1 WRENDB_TEST_MSSQL=1 WRENDB_TEST_DOCKER=1 cargo test
```

## 현재 상태: M18 (배포 전)

- M2: WebSocket + Arrow IPC 스트리밍, 윈도우 페치(1,000행), 쿼리 취소, Host 헤더 검증
- M3: PK 기반 셀 편집(DOM 오버레이, 한글 IME 가드), 트랜잭션(begin/commit/rollback), 세션 스냅샷·저널 일관성, `docs/CHECK-M3-IME.md` 수동 체크리스트
- M4: PostgreSQL 드라이버(tokio-postgres), SSH 터널(russh), 스키마 사이드바, 히스토리/즐겨찾기, 키체인 저장
- M6: MySQL/MariaDB 드라이버(mysql_async), 연결 모달 드라이버 선택
- M6c: CockroachDB(PG 경로)·SQL Server(tiberius) 드라이버, 5개 드라이버 취소·트랜잭션 지원
- M7: UI 셸 전면 개편(탭·툴바·다크 테마) + 데이터 탭(필터·정렬·페이지·행 상세·내보내기)
- M9: 행 추가/삭제·구조/서버 정보/정의 탭·오브젝트 브라우저·세션 킬·커맨드 팔레트·안전 모드·실행 계획·FK 점프·스니펫
- M10~M15: 연결 홈·멀티커넥션, 테이블 뷰 재편, 구조 편집·DB 생성/삭제, 가져오기/내보내기·백업, 에디터 고도화·Explain 시각화, Activity/Metrics, TLS·Git 테마·접속 점검
- M16~M17: Quick Look·숨은 마우스 동작, 입력/체크박스 디자인 시스템·모션, MySQL TLS 폴백 축소, macOS 키체인 왕복, MCP 서버
- M18: 로딩 스피너·탭 애니메이션, syntax preset, JSON 트리 Quick Look drawer, 환경 배지, 행 관계 탭·FK 점프
- M18.1: Canvas 그리드 셀 텍스트 대비·컬럼 헤더 말줄임, 상단 다중 연결 바, DB 컨텍스트 사이드바, 카테고리 설정 모달·기어 아이콘, 저장 연결 삭제
- 다음 단계: 배포(M5) — brew/winget/scoop, 코드 서명·공증, 업데이트 알림
