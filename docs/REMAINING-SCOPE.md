# 남은 범위와 결정 기록

작성: 2026-10-19 · 상태: M15 구현 완료, M5 배포 전

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

## 3. 별도 마일스톤

| 범위 | 이유 |
|---|---|
| Oracle, Snowflake | 새 wire protocol·인증·카탈로그·DDL 구현 필요 |
| Redis, MongoDB, Cassandra, DynamoDB, ElasticSearch | KV/문서/검색 모델은 행·열 그리드와 다른 뷰가 필요 |
| BigQuery, ClickHouse, Cloudflare D1 | 인증·쿼리 API·타입 체계가 별도 |
| Vertica | PG wire protocol과 호환되지 않아 현행 PG 드라이버로 접속 불가 |
| Plugin 샌드박스 | 권한·프로세스 격리·매니페스트·배포 설계가 선행되어야 함. MCP는 별도로 구현됨 |
| 자동 업데이트·서명·공증 | M5 배포 트랙, 사용자 요청으로 현재 제외 |

Redshift/Percona/Yugabyte/MariaDB는 현행 호환 드라이버로 접속을 시도할 수 있지만, 카탈로그·DDL·함수 차이를 전부 보증하지 않는다. 서버 정보의 호환 모드 표시는 진단 보조이며 완전 지원 선언이 아니다.

## 4. 남은 검증 게이트

- `cd web && npm run build`
- `touch crates/tablepeek-server/src/lib.rs && cargo build -p tablepeek`
- `cargo test -p tablepeek-server`
- `TABLEPEEK_TEST_PG=1 TABLEPEEK_TEST_MYSQL=1 TABLEPEEK_TEST_COCKROACH=1 TABLEPEEK_TEST_MSSQL=1 TABLEPEEK_TEST_DOCKER=1 cargo test -p tablepeek-engine -- --test-threads=1`
- 200000행 데모 서버(`tablepeek serve --demo-rows 200000`) + `node web/scripts/ws-smoke.mjs <URL>`
- `cdp-m15.mjs` 및 연결 상태·Explain·테마·점검 CDP 시나리오
- `tablepeek mcp` JSON-RPC initialize/tools/list/query/거부 왕복
- `cargo fmt --all -- --check`
