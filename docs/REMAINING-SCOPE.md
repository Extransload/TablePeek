# 남은 범위와 결정 기록

작성: 2026-10-19 · 갱신: 2026-10-30 (엔진 12종, 남은 한계 정리)

이 문서는 "모두 처리" 범위 중 구현을 마친 항목, 의도적으로 보류한 항목, 별도 마일스톤이 필요한 항목을 구분한다. 완료 판정은 코드 존재가 아니라 빌드·테스트·실서버 확인 근거를 기준으로 한다.

## 1. 이번 범위에서 완료한 항목

| 항목 | 근거 |
|---|---|
| TLS 직접 접속 | PG/Cockroach `ssl_mode` + CA·mTLS, MySQL TLS. Docker TLS 컨테이너 통합 테스트 통과 |
| 접속 전 점검 | `/api/fs/stat` + ConnectModal "점검" 버튼. 존재/파일/읽기 가능 여부 확인, UI 성공·실패 메시지 CDP 검증 |
| 연결 상태 표시 | 상단 ConnSwitcher에 연결됨/연결 중/끊김 표시 |
| EXPLAIN 시각화 | PG/MySQL JSON, SQLite QUERY PLAN 파서 + 트리·비용·행·원본 JSON UI. 3개 엔진 CDP 검증 |
| 테마 Git 가져오기 | Base16, VS Code color theme, TablePeek palette JSON. localStorage 저장·재시작 복원 CDP 검증 |
| DB 생성/삭제 GUI | MySQL 생성·삭제 CDP 검증, 목록 동기화 확인 |
| Laravel 스키마 복사 | `Schema::create` 출력 CDP 검증 |
| MySQL 테이블 옵션 | collation·ROW_FORMAT·COMMENT preview/DDL 일치 CDP 검증 |
| PostgreSQL 오류 상세 | message/detail/hint를 사용자 메시지에 포함, API 검증 |
| MariaDB/Percona/Yugabyte/Redshift 표시 | 버전 문자열 기반 호환 모드 카드 |
| keyring 왕복 | macOS `security` 비대화형 경로로 저장·조회·삭제 왕복 검증. 전용 ignored 테스트 통과 |
| Quick Look·Quick Edit 동작 | 셀 가운데 클릭·⌘Enter Quick Look, 사이드바 가운데/⌘클릭 새 탭, ⌥클릭 Quick Edit 메뉴. CDP 확인 |
| 디자인 시스템 | 입력·체크박스·포커스·모달 공통 토큰, 모션, `prefers-reduced-motion` 적용. 흰 체크박스 테두리 제거 |
| MCP 서버 | `tablepeek mcp` stdio 서버, 연결·스키마·읽기 전용 쿼리 도구. 실제 JSON-RPC 왕복 확인 |

## 2. 보류 결정

### View Using Encoding — 부분 구현

Quick Look의 인코딩/HEX 탭은 현재 표시 값의 UTF-8 바이트를 선택한 인코딩으로 다시 읽는다. EUC-KR 등으로 저장된 원본 바이트를 복원하는 기능은 아니다. 완전한 구현은 엔진 결과 계층에 원시 바이트 컬럼 타입과 셀별 raw 조회 경로를 추가해야 하므로 별도 마일스톤으로 둔다.

### MySQL `prefer` 폴백 — 축소 완료

`IoError::Tls`, `NoClientSslFlagFromServer`, 서버 코드 2026/3159, TLS·SSL·certificate 문자열을 포함한 `Other` 오류에만 평문 재시도를 허용한다. 인증 실패(1045)와 DB 없음(1049)은 폴백하지 않는다. 단위 테스트로 고정했다.

### 키체인 — 검증 완료

macOS `security` 비대화형 경로로 저장·조회·삭제 왕복을 확인했다(`store::tests::macos_keyring_roundtrip`, ignored). CI에서는 실행하지 않는다.

### MCP와 Plugin — MCP 구현, Plugin 보류

MCP 서버는 구현했다. Plugin은 샌드박스·권한·프로세스 격리 설계가 선행되어야 하므로 아직 구현하지 않았다. 서드파티 드라이버를 프로세스 외부 플러그인으로 붙이는 방식은 MCP와 별개의 설계가 필요하다.

## 3. 별도 마일스톤과 제외한 범위

| 범위 | 상태 |
|---|---|
| Snowflake, BigQuery, DynamoDB, Cloudflare D1 | 아직 없음. 인증·쿼리 API·타입 체계가 각각 별도 |
| Vertica | PG wire protocol과 호환되지 않아 현행 PG 드라이버로 접속 불가 |
| Redis, DuckDB, 설치 프로그램, AI 기능, 스키마 비교 | 사용자 결정으로 제외. TablePeek은 웹 전용으로 유지 |
| Plugin 샌드박스 | 권한·프로세스 격리·매니페스트·배포 설계가 선행되어야 함. MCP는 별도로 구현됨 |
| 배포(M5) | 완료: SemVer(v0.1.0부터, `CHANGELOG.md`), 태그 `vX.Y.Z`로 GitHub Releases에 macOS(arm64·x64)·Linux(x64·arm64)·Windows(x64) 일반 아카이브와 `SHA256SUMS` 게시(`.github/workflows/release.yml`, 절차는 `docs/RELEASING.md`), 소스 빌드 병행, 앱 안 새 버전 알림(하루 한 번 확인, 설정에서 끔). 제외: 코드 서명·공증, 설치 프로그램, 패키지 매니저(brew/winget/scoop), 바이너리 자동 교체 |

Oracle, MongoDB, Cassandra·ScyllaDB, Elasticsearch·OpenSearch, ClickHouse는 이후 엔진으로 들어왔다(`docs/ENGINES.md`, `docs/MONGODB.md`, `docs/engines/*.md`).

Redshift/Percona/Yugabyte/MariaDB는 현행 호환 드라이버로 접속을 시도할 수 있지만, 카탈로그·DDL·함수 차이를 전부 보증하지 않는다. 서버 정보의 호환 모드 표시는 진단 보조이며 완전 지원 선언이 아니다.

## 4. 엔진별 남은 한계

고칠 수 있는 한계는 고쳤다. 아래는 서버·프로토콜·드라이버가 막아 남은 것이고, 근거와 확인 방법은 각 엔진 문서의 한계 절에 있다.

| 엔진 | 남은 한계 | 문서 |
|---|---|---|
| Oracle | `DISABLE_OOB=ON` 서버나 TCP 긴급 데이터를 버리는 경로(SSH/HTTP 터널, Docker 포트 포워딩)에서는 끊기 신호가 문장이 끝날 때까지 읽히지 않는다. 그 연결에서 ALTER SYSTEM 권한도 없으면 취소가 세션을 끝내고(롤백), 정지 전에 묻는다. RAW 열은 선언한 크기까지. 드라이버는 정식 출시 전 `oracledb 26.0.0-beta.5`를 고정하고 `crates/vendor/oracledb`에서 패치해 쓴다(정식판에 같은 수정이 들어오면 패치를 걷어낸다) | `docs/engines/oracle.md` §10 |
| Cassandra·ScyllaDB | CQL native protocol에 취소 메시지가 없어, 이미 보낸 한 문장은 서버 타임아웃까지 돈다(여러 단계 작업만 다음 문장 전에 멈춘다). 다른 클라이언트 세션 끊기, 테이블 이름 바꾸기, 트랜잭션, 열 기본값은 CQL에 없다. counter 행의 "이미 있음" 확인은 쓰기 직전 읽기다(counter 테이블은 `IF` 조건을 받지 않는다) | `docs/engines/cassandra.md` §10 |
| ClickHouse | INSERT에는 ON CLUSTER가 없어 비복제 클러스터 테이블에 넣은 행은 접속한 서버에만 들어간다(Distributed 테이블로 넣으면 퍼진다). 키와 모든 값이 같은 행은 병합 뒤 새로 고치기 전까지 가르지 못한다. 트랜잭션이 없어 실패 시 되돌리기로 보상하는데, 그사이 다른 쪽이 같은 행을 바꾸면 되돌리기가 실패할 수 있다(배너에 이유와 함께 표시) | `docs/engines/clickhouse.md` §11 |
| Elasticsearch·OpenSearch | 서버가 취소를 받지 않는 작업(클러스터 상태 읽기 등)은 응답만 버리고, 관련 작업 취소 버튼을 보여 준다. ES 6.x는 필터 없이 API 키 목록을 주지 않아, 다른 이름의 realm 사용자가 만든 키는 그 realm으로 로그인해야 보인다. OpenSearch API 키는 3.7부터 | `docs/engines/elasticsearch.md` §8 |
| CockroachDB 바이너리 셀 | 한 값은 클러스터 설정(`sql.conn.max_read_buffer_message_size` 등) 중 가장 작은 것에서 1MiB를 뺀 크기까지(기본 약 15MiB) | `docs/ENGINES.md` |
| MySQL 바이너리 셀 | 한 값은 `max_allowed_packet`과 열 타입 크기 중 작은 것까지. 되돌리기는 InnoDB 테이블에서만 | `docs/ENGINES.md` |
| MongoDB | Atlas Local은 벡터 인덱스 수정을 거부한다(서버 한계). AWS 인증의 실제 STS·EC2/ECS 역할, Azure·GCP 메타데이터는 단위 테스트로만 확인 | `docs/MONGODB.md` §8 |

테스트 환경의 한계: Docker VM 메모리(7.65GB)를 다른 프로젝트 컨테이너와 나눠 쓰므로, 무거운 새 엔진 프로필은 한 번에 하나만 띄운다(`/tmp/tablepeek-docker-heavy.lock`). 메모리가 모자라면 컨테이너가 137로 꺼질 수 있다.


## 5. 남은 검증 게이트

- `cd web && npm run build`
- `touch crates/tablepeek-server/src/lib.rs && cargo build -p tablepeek`
- `cargo test -p tablepeek-server`
- `TABLEPEEK_TEST_PG=1 TABLEPEEK_TEST_MYSQL=1 TABLEPEEK_TEST_COCKROACH=1 TABLEPEEK_TEST_MSSQL=1 TABLEPEEK_TEST_DOCKER=1 cargo test -p tablepeek-engine -- --test-threads=1`
- 200000행 데모 서버(`tablepeek serve --demo-rows 200000`) + `node web/scripts/ws-smoke.mjs <URL>`
- `cdp-m15.mjs` 및 연결 상태·Explain·테마·점검 CDP 시나리오
- `tablepeek mcp` JSON-RPC initialize/tools/list/query/거부 왕복
- `cargo fmt --all -- --check`
