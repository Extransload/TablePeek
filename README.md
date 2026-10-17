# prodb (가칭)

성능 우선 크로스플랫폼 DB 클라이언트 — 로컬 Rust 엔진 + 브라우저 UI.
설계 배경과 로드맵은 `docs/ARCHITECTURE.md` 참고.

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
cargo run -p prodb -- serve                        # 인메모리 데모 DB(10,000행)로 시작
cargo run -p prodb -- serve --demo-rows 500000     # 데모 행 수 지정 (최대 2,000,000)
cargo run -p prodb -- serve --db path/to.sqlite    # 실제 SQLite 파일 열기
```

브라우저가 자동으로 열립니다. 옵션: `--port <n>`, `--no-open`.

## PostgreSQL 연결

UI 상단 "연결" 버튼에서 접속 정보를 입력합니다 (호스트/포트/사용자/비밀번호/데이터베이스).

- SSH 터널: 체크 후 SSH 호스트/포트/사용자/키 경로(또는 비밀번호) 입력. 이때 PG 호스트/포트는 **SSH 서버 관점** 주소입니다 (예: 원격지에서 127.0.0.1:5432).
- 저장: "저장" 체크 시 `~/.prodb/store.json`에 비밀번호를 제외한 정보가 저장되고, "비밀번호도 함께 저장"을 체크하면 비밀번호는 OS 키체인에만 보관됩니다.
- TLS는 아직 미지원입니다 (ssl_mode prefer/require는 안내 오류). 원격은 SSH 터널을 사용하세요.
- 스키마 사이드바에서 테이블 클릭 → `SELECT` 자동 입력, "기록"/"즐겨찾기"에서 과거 SQL 재사용.
- 셀 편집은 PK가 있는 테이블에서 더블클릭으로 시작되며, 트랜잭션 시작/커밋/롤백 버튼으로 제어합니다.

## 테스트

```sh
cargo test                     # Rust 단위 테스트 (기본)
cd web && npm run build        # 웹 타입체크(strict) + 프로덕션 번들
cd web && node scripts/ws-smoke.mjs "http://127.0.0.1:7699/?token=..."   # WS e2e 스모크
```

Docker 연동 테스트 (선택):

```sh
docker run -d --name prodb-pg -e POSTGRES_USER=prodb -e POSTGRES_PASSWORD=prodb_test_pw \
  -e POSTGRES_DB=prodb_test -p 5433:5432 postgres:16-alpine
PRODB_TEST_PG=1 cargo test                 # PG 엔진 라운드트립 + 취소
PRODB_TEST_DOCKER=1 cargo test             # 서버 tunnel/connect e2e (prodb-ssh 필요)
```

## 현재 상태: M4 (배포 전)

- M2: WebSocket + Arrow IPC 스트리밍, 윈도우 페치(1,000행), 쿼리 취소, Host 헤더 검증
- M3: PK 기반 셀 편집(DOM 오버레이, 한글 IME 가드), 트랜잭션(begin/commit/rollback), 세션 스냅샷·저널 일관성, `docs/CHECK-M3-IME.md` 수동 체크리스트
- M4: PostgreSQL 드라이버(tokio-postgres), SSH 터널(russh), 스키마 사이드바, 히스토리/즐겨찾기, 키체인 저장
- 다음 단계: 배포(M5) — brew/winget/scoop, 코드 서명·공증, 업데이트 알림
