# TablePeek 아키텍처 설계

작성: 2026-10-16 · 갱신: 2026-10-19 · 상태: M18.1 UI 보정 완료 (M5 배포 대기)

## 1. 제품 정의

성능을 최우선으로 하는 크로스플랫폼(macOS·Windows) DB 클라이언트.
설치형 단일 바이너리(CLI)가 로컬 엔진을 띄우고, UI는 브라우저에서 동작한다.

### 확정 결정 (논의 결과)

| 항목 | 결정 | 근거 |
|---|---|---|
| 제품명 | TablePeek (`tablepeek`) | 담백한 두 단어 이름. "테이블을 가볍게 들여다본다"는 성격을 담음 |
| 배포 형태 | Model C — 로컬 동반자 (CLI + 브라우저 UI) | 서버 운영 비용 0. 무설치 SaaS는 로컬 DB 접속 불가 + 자격증명 보관 부담 |
| UI 위치 | 웹(브라우저) 단독, 네이티브 GUI 앱 없음 | 한글 IME·에디터 성숙도, 크로스플랫폼 자동 확보 |
| 엔진 언어 | Rust (tokio) | 성능 최우선, 메모리 안전, 단일 툴체인 |
| 엔진 노출 | 127.0.0.1 전용 HTTP + WebSocket (M2 적용), Host 헤더 검증 | 브라우저는 DB에 직접 TCP 연결 불가 — 물리적 제약 |
| 결과 전송 | M0: JSON → M2 이후: Arrow IPC 스트리밍 (적용) | 컬럼형 버퍼로 zero-copy 정렬·필터, 윈도우 페치로 전량 로드 회피 |
| 렌더링 | Canvas 가상화 그리드 (M1 적용, M3 셀 편집) | DOM 테이블은 대량 행에서 한계 |
| SQL 에디터 | CodeMirror 6 (M1 적용) | 브라우저 네이티브 IME가 최대 리스크를 제거 |
| 파일 탐색 | OS 기본 파일 선택 창(`/api/fs/pick`: macOS `NSOpenPanel`(첫 선택 때 띄워 계속 쓰는 JXA 헬퍼: 첫 표시 ~1초, 이후 ~0.1초), Windows `OpenFileDialog`, Linux zenity/kdialog). 없는 환경은 엔진측 디렉터리 API(`/api/fs/list`) + 브라우저 모달 | 서버가 루프백 전용이라 선택 창이 브라우저와 같은 화면에 뜸. 경로 직접 입력은 오타·미검증 위험 |
| 원격 접속 | SSH 터널 내장(russh, M4) + OS 키체인(keyring) | 클라우드 릴레이·서버 비용 불필요, 비밀 정보는 키체인만 |
| 편집 안전 | PK 기반 단일 셀 UPDATE + 명시적 트랜잭션(M3), 행 추가/삭제(M9) | 안전한 최소 편집 표면. 세션 스냅샷 패치로 일관성 유지. 구조 변경 시 전 세션 무효화 |
| 다중 DB | SQLite · PostgreSQL · MySQL/MariaDB · CockroachDB · SQL Server | 드라이버 선택은 연결 모달에서. 서버 프로세스당 활성 DB 1개(교체형) |
| 개발 기간 | 제약 없음 (성능 우선) | |

## 2. 구성도

```
[사용자 머신]
  [브라우저 탭]  웹 UI (React + CodeMirror 6 + Canvas 그리드)
       │  REST + WebSocket(Arrow IPC) + x-tablepeek-token
       ▼
  [tablepeek CLI 프로세스]
    tablepeek-server (axum)
      - 정적 자산(rust-embed), 토큰·Host 검증
      - WS 스트리밍, SSH 터널(russh)
      - store.json(비밀 아님) + OS 키체인(비밀번호)
    tablepeek-engine
      - rusqlite | tokio-postgres(PG·CRDB) | mysql_async(MySQL) | tiberius(TDS)
              │
              ▼ (SSH 터널 경유 가능)
  SQLite 파일 / PostgreSQL / MySQL / CockroachDB / SQL Server
```

## 3. 크레이트 경계

| 크레이트 | 책임 | 의존 |
|---|---|---|
| `tablepeek` | CLI 엔트리: `serve` 서브커맨드, 포트·토큰 발급, 브라우저 오픈 | server, engine |
| `tablepeek-server` | axum 라우터, 토큰·Host 인증, 웹 자산(rust-embed), WS 스트리밍, 세션 스냅샷·저널, SSH 터널(russh), store.json·키체인 | engine, types |
| `tablepeek-engine` | 커넥션·세션·쿼리 실행. 백엔드 enum(rusqlite / tokio-postgres / mysql_async / tiberius), Arrow IPC 직렬화, 쿼리 취소, 행 추가·삭제 | types |
| `tablepeek-types` | 메시지·결과·접속 설정 공용 타입 (serde) | — |

의존 방향은 항상 위→아래. server는 engine만, engine은 types만 안다.

## 4. 보안 모델

- **127.0.0.1 바인딩만** — 외부 인터페이스 노출 금지.
- **실행 시마다 랜덤 토큰** 발급. 페이지 로드 시 쿼리 파라미터, API 호출 시 `x-tablepeek-token` 헤더로 검증(WS 핸드셰이크는 `?token=`). `/api/*` 전 경로는 본문·업그레이드를 읽기 전에 미들웨어에서 토큰을 확인하고, 없거나 맞지 않으면(서버가 다시 시작돼 바뀐 토큰) 언제나 401 `{code:"invalid_token"}`을 준다.
- **Host 헤더 검증** (M2 적용) — DNS 리바인딩 방어.
- 자격증명: DB/SSH 비밀번호는 **OS 키체인에만** 저장(사용자가 "비밀번호도 저장" 선택 시). `~/.tablepeek/store.json`에는 비밀번호를 기록하지 않으며 SSH 개인키 경로만 저장. 키체인 호출(저장·읽기·삭제·되돌리기)은 모두 비동기 작업자 밖(`spawn_blocking`)에서 하고, macOS `security`는 20초 안에 답이 없으면(잠금 해제 창을 아무도 안 누를 때) 끝내고 "키체인 응답이 없습니다 — 잠금 해제 창을 확인하세요"로 실패한다. 저장은 이미 쓴 항목을 되돌린다. 멈춘 키체인 호출 하나가 다른 요청을 막지 않는다.
- SSH 터널(russh, M4): 원격 DB는 사용자 머신에서 SSH 채널을 열어 127.0.0.1 임의 포트로 포워딩. PG 호스트/포트는 SSH 서버 관점 주소로 지정.
- TLS: PostgreSQL/CockroachDB는 `ssl_mode=disable/prefer/require`와 CA·클라이언트 인증서(mTLS)를 지원한다. MySQL은 `SslOpts`로 CA·클라이언트 인증서를 적용하며 `prefer`는 TLS 실패 시 평문으로 폴백한다. 모든 rustls 경로는 `ensure_crypto_provider()`로 ring provider를 먼저 설치한다. 연결 전 점검은 `/api/fs/stat`으로 로컬 인증서·SSH 키 파일의 존재/파일 여부/읽기 가능 여부만 확인하고 실제 접속은 하지 않는다.

## 5. 성능 원칙과 목표

원칙 (M2에서 전부 적용):
1. 결과는 컬럼형 버퍼(Arrow)로 보관한다.
2. 그리드는 보이는 셀만 즉시 페인트한다 (가상화) — 윈도우 단위(기본 1,000행) 지연 페치.
3. 전량 로드 금지 — max_rows 상한(기본 10,000) + 커서 윈도우 페치.
4. UI/쿼리 스레드 블로킹 금지 — 전부 비동기, 취소는 백엔드 취소 토큰으로 실행 중 쿼리만 중단.

목표(측정 기준):
- 시작: < 1.5초 (CLI 실행 → 브라우저 첫 화면)
- 스크롤: 100만 행에서 60fps 유지
- 첫 결과: < 300ms (로컬, 소형 테이블)
- 유휴 메모리: < 300MB

## 6. 프로토콜 요약 (M2~M9)

- **WS `/api/ws`** (전 메시지 `id` 상관):
  - C→S: `query{sql,max_rows,window}` · `fetch{offset,limit}` · `cancel` · `edit{session,table,pk,column,value,row,col}` · `insert_row{table,values[{column,value}]}` · `delete_row{table,pk[{column,value}]}` · `tx{begin|commit|rollback}`
  - S→C: `meta` → (행>0이면) Arrow IPC 바이너리 → `window{offset,count}` · `error{code,message,cancelled,…}`(REST 오류와 같은 필드, 아래) · `edited` · `row_change{op,rows_affected,invalidate}` · `tx{state,invalidate?}`
- **오류 응답** (`docs/ERRORS.md` §2): REST·WS 모두 `{code, message}`에 아는 만큼 `sqlstate`(PG·CockroachDB·MySQL) · `position`(`{offset}` 문장 안 1부터 센 글자 — PG·SQLite `sqlite3_error_offset`, 또는 `{line}` — MySQL `at line N`·SQL Server) · `server_code`(MongoDB code, MySQL errno, SQL Server 번호, SQLite 확장 코드) · `code_name`(MongoDB) · `details`(PG `detail`·`hint`·`schema`·`table`·`column`·`constraint`·`datatype`, MongoDB `errInfo`·`writeErrors[{index,code,code_name?,message,errInfo?}]` canonical EJSON, MongoDB 서버 선택 실패의 `topology`·`set_name`·`servers[{address,type,error}]`) · `raw`(드라이버 원문 전체, 연결 문자열 비밀번호 가림)를 덧붙인다. `message`는 사람에게 보일 첫 줄로, 엔진 라벨·`[SQLSTATE …]`·`ERROR 1064 (42000):` 같은 코드 꼬리 없이 데이터베이스의 말만 담는다(코드는 필드로, 원문은 `raw`로). 사용자가 고칠 수 있는 실패(인증, 연결 거부, 문법, 제약, 트랜잭션 상태, 인증서 설정)는 `내부 오류`(`internal`)가 아니며, `TLS 연결 실패:`는 원인이 TLS일 때만 붙는다. MongoDB 연결 실패는 드라이버 오류 종류로 한 줄 요약한다: `MongoDB 인증 실패: …`(18 AuthenticationFailed), `복제 세트 'rs0'에서 닿을 수 있는 프라이머리가 없습니다 … 직접 연결(directConnection)을 켜세요`, `서버에 연결할 수 없습니다 (연결 거부): host:port`, `호스트를 찾을 수 없습니다`, `DNS 조회 실패`. 연결 실패의 `code`는 `connect_failed`, 다른 MongoDB 오류는 `mongo_<code>`. 문서별 삽입 실패(`insert`의 `errors[]`)도 `server_code`·`code_name`·`details.errInfo`를 갖는다. MCP는 이 필드를 `[SQLSTATE …, offset N]` 꼬리로 붙여 돌려준다.
- **세션·편집 (M3·M9)**: 결과 세션 상한 8(최근 사용 유지). 셀 편집은 PK 단일 행 UPDATE, 행 추가는 지정 컬럼 INSERT(빈 배열=DEFAULT VALUES), 행 삭제는 PK 일치 DELETE. 성공 시 서버가 세션 스냅샷 셀을 패치(M9: 행 추가/삭제는 `row_change.invalidate=true`를 보내고 전 세션을 비움 → UI가 활성 탭 재실행). 트랜잭션 중 편집은 저널(old 값) 기록, 구조적 변경(행 추가/삭제)은 저널에 `Structural` 마커 → `rollback` 시 전 세션 무효화(`tx.invalidate=true`), `commit`/`begin` 시 저널 폐기.
- **REST**: `/api/engines`(등록된 엔진 정의 전체 `{engines:[{id,aliases,label,paradigm,family,transport,default_port?,url_schemes,capabilities,connection}]}`, `docs/ENGINES.md` §3) · `/api/meta`(+`capabilities`: 접속한 연결의 실제 능력) · `/api/doc/*`(문서형 엔진: `databases`·`collections`·`stats`·`find`·`count`·`aggregate`·`distinct`·`insert`·`update`·`replace`·`delete`·`indexes`(GET·POST·DELETE)·`explain`·`command`·`export`(NDJSON 스트림, 마지막 줄 `{"$end":{count}}`, 연결을 끊으면 커서도 닫힘)·`perf`(`serverStatus` 일부). 본문·응답은 canonical EJSON, 오류는 `mongo_<code>`+원문, 조건 없는 `many`·`drop`·`dropDatabase`·`collMod`·`renameCollection`·`killOp`·`profile` 수준 바꾸기·`$out`/`$merge` 집계는 `confirmed:true` 필요, SQL 엔진에서는 `unsupported_capability`. `perf`·`export`와 상태 명령(`currentOp`·`killOp`·`top` 등)은 연결의 게이트 밖에서 돌아 긴 쿼리 뒤에서 기다리지 않음. `docs/MONGODB.md` §6·§6.1) · `/api/exec`(문 하나 실행, 결과 행은 최대 10,000행 + `truncated`) · `/api/open`(SQLite/데모 전환. 이미 열린 파일이면 그 연결로, 저장 프로필 연결도 같음. SQLite 기록·안전 모드는 프로필이 아닌 파일 기준) · `/api/connect`(`{driver, config, ssh?, http_tunnel?}`, 옛 `{driver, postgres:{…}}` 형식도 읽음. 모르는 엔진은 `unsupported_driver` "지원하지 않는 엔진: x") · `/api/fs/list` · `/api/fs/pick`(OS 파일 선택 창) · `/api/schema` · `/api/relations`(`conn`·`system`, 연결의 외래 키 전체 `{relations:[{table,columns,ref_table,ref_columns}]}`, 테이블 이름은 `/api/schema` 표기) · `/api/connections`(CRUD + `/{id}/connect`, sqlite 파일 프로필 포함) · `/api/history`(GET/DELETE) · `/api/favorites`(CRUD) · `/api/table`(컬럼·인덱스·외래 키·DDL·추정 행 수·크기) · `/api/server`(버전·크기·가동 시간·세션 목록) · `/api/objects`(뷰·함수·트리거·시퀀스) · `/api/definition`(뷰/함수/트리거/시퀀스 DDL) · `/api/kill`(세션 종료, 지원 엔진만) — 전부 토큰 인증.
- **드라이버 취소·한계 (M6~M9)**: SQLite `interrupt` · PG `pg_cancel_backend` · MySQL `KILL QUERY`(실제 실행 중 쿼리에만 유효) · CockroachDB `pg_cancel_backend` · SQL Server `KILL {spid}` + 세션 죽음 감지 시 재접속. MSSQL 트랜잭션은 TDS Transaction Manager RPC 사용(배치 경유 `BEGIN TRAN`은 오류 266). MSSQL 구조 조회는 `sys.*` 카탈로그, DDL 스크립트 재구성.
- **전송 규약**: 행 1개 = Arrow IPC 배치 1개(BATCH_CHUNK 65,536행), Decimal/문자열 타입 매핑은 엔진 `arrow_schema` 참조.

## 7. 마일스톤

| 단계 | 내용 | 상태 |
|---|---|---|
| M0 | 로컬 서버 + 브라우저 UI + SQLite 실행 + JSON 결과 표시 | 완료 |
| M1 | Canvas 가상화 그리드, CodeMirror 6, 복사·키보드 내비게이션, `--db` 파일 UX | 완료 |
| M2 | WebSocket + Arrow IPC 스트리밍, 쿼리 취소, 윈도우 페치, Host 검증 | 완료 |
| M3 | 셀 편집(DOM 오버레이 에디터)·트랜잭션, 세션 스냅샷 일관성, IME 체크리스트 | 완료 |
| M4 | PostgreSQL 드라이버(백엔드 enum), SSH 터널(russh), 스키마 브라우저, 히스토리/즐겨찾기, 키체인 | 완료 |
| M6 | MySQL/MariaDB 드라이버(mysql_async), 연결 모달 드라이버 선택, 키체인 계정 분리 | 완료 |
| M6c | CockroachDB(PG 경로 재사용·`crdb_internal` 제외) + SQL Server(tiberius, TLS 옵션) | 완료 |
| M7 | UI 셸 전면 개편(탭·툴바·스플리터·결과 패널) + 데이터 탭(필터·정렬·페이지·행 상세·컨텍스트 메뉴·내보내기) | 완료 |
| M9 | 행 추가/삭제, 구조 탭·서버 정보 탭·오브젝트 브라우저·정의 보기·세션 킬, 커맨드 팔레트(⌘P), 안전 모드·실행 계획·참조 행 점프·스니펫 | 완료 |
| M16 | Quick Look(셀/행), 가운데·⌘클릭 새 탭, ⌥클릭 셀 메뉴, 입력·체크박스 디자인 시스템, 모션 | 완료 |
| M17 | 인코딩/HEX 인스펙터, MySQL `prefer` TLS 오류 한정, 키체인 왕복, MCP stdio 서버 | 완료 |
| M18 | 스피너·탭 모션, SQL syntax preset, JSON 트리 우측 Quick Look, 환경 배지, 행 관계 탭·FK 점프 | 완료 |
| M18.1 | 그리드 셀 텍스트 대비·헤더 ellipsis, 상단 다중 연결 바, DB 컨텍스트 사이드바, 카테고리 설정 모달, 저장 연결 삭제 | 완료 |
| M5 | 배포: brew/winget/scoop, 코드 서명·공증, 자동 업데이트 알림 | 예정 |

## 8. UI 셸 구성 (M18.1)

- **상단 연결 바**: 홈 버튼과 열린 연결별 `.conn-tab`을 한 줄에 배치하고, 오른쪽 끝의 연결(플러그) 버튼이 저장된 연결 열기와 새 연결을 맡는다. 탭은 connMeta 색상(`--conn-color`), 환경·드라이버 배지, 연결 상태 점, active 하단 stripe를 표시하며 기존 compact dropdown을 대체한다.
- **사이드바**: 열린/저장 연결 목록은 홈과 상단 바가 담당한다. 사이드바는 현재 연결의 DB 헤더(아이콘·label·driver·env·상태)와 테이블/오브젝트 탐색에 집중한다.
- **설정 모달**: 좌측 카테고리(일반·테마 / 화면: SQL 에디터·데이터 테이블·사이드바 / 가져오기·내보내기·단축키·보안) + 우측 pane 구조. 화면 영역 pane은 그 영역의 글꼴·동작과 미리보기를 함께 둔다(SQL 에디터 미리보기는 실제 에디터 설정의 읽기 전용 CodeMirror). 선택된 pane만 그리며, 입력 중인 값은 모달 상태에 남는다.
- **연결 홈**: 저장 연결 카드에서 삭제를 지원한다. 삭제는 저장 목록과 connMeta만 제거하고 이미 열린 세션은 유지한다.
- **Canvas 그리드**: 셀 값 타입별 잉크 색(`textInk`)과 헤더 ellipsis(`fitText`)를 적용해 라이트/다크 테마 모두에서 텍스트 대비와 컬럼 경계를 보장한다.
- **차트·피벗**: 쿼리 결과 바와 테이블 탭의 보기 전환에 `데이터 | 차트 | 피벗`이 있다. 보기와 설정은 탭(`analysis`)에 저장된다. 쿼리 탭은 결과 행을, 테이블 탭은 필터를 적용한 테이블 전체를 별도 job 쿼리로 읽으며 둘 다 최대 50,000행(`ANALYSIS_ROW_CAP`)까지다. 집계·버킷·상위 N+기타·축 눈금은 순수 모듈 `web/src/chartData.ts`가 맡고, 차트는 직접 그린 SVG(라이브러리 없음, 테마 CSS 변수 색), 피벗은 Canvas 그리드 + TSV 복사로 보여 준다.

## 9. 열린 결정

- 원격 접속 중계(클라우드 릴레이) 여부 — 도입 시에만 서버 비용 발생
- 라이선스 모델 (오픈소스 vs 상용)
- 다중 접속·탭 UX 상세 — 현재 서버 프로세스당 활성 DB 1개(교체형)
- View Using Encoding: Quick Look은 UTF-8 바이트 기준 재해석을 제공한다. 원본 바이트 복원은 별도 드라이버 계층 설계 필요
- MCP: `tablepeek mcp`로 읽기 전용 도구를 제공한다. 도구 목록은 기본 연결(`--conn` 또는 서버 기본 연결)의 엔진을 따른다: SQL 엔진이면 `tablepeek_list_tables`·`tablepeek_describe_table`·`tablepeek_query`, MongoDB면 `mongo_list_collections`·`mongo_find`(≤100건)·`mongo_aggregate`(`$out`·`$merge` 거절, ≤100건)·`mongo_schema`(`$sample` ≤200건으로 필드 경로·있는 비율·타입 분포를 MCP 프로세스가 요약)·`mongo_indexes`. 연결을 알 수 없으면 둘 다 낸다. Plugin 샌드박스와 서드파티 드라이버 로딩은 별도 마일스톤
- 추가 드라이버(Oracle/Snowflake/KV·문서형): 별도 마일스톤·제품 결정 필요
