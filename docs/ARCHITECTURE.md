# ProDB 아키텍처 설계 (가칭)

작성: 2026-10-16 · 갱신: 2026-10-17 · 상태: M4 구현 완료 (M5 배포 대기)

## 1. 제품 정의

성능을 최우선으로 하는 크로스플랫폼(macOS·Windows) DB 클라이언트.
설치형 단일 바이너리(CLI)가 로컬 엔진을 띄우고, UI는 브라우저에서 동작한다.

### 확정 결정 (논의 결과)

| 항목 | 결정 | 근거 |
|---|---|---|
| 배포 형태 | Model C — 로컬 동반자 (CLI + 브라우저 UI) | 서버 운영 비용 0. 무설치 SaaS는 로컬 DB 접속 불가 + 자격증명 보관 부담 |
| UI 위치 | 웹(브라우저) 단독, 네이티브 GUI 앱 없음 | 한글 IME·에디터 성숙도, 크로스플랫폼 자동 확보 |
| 엔진 언어 | Rust (tokio) | 성능 최우선, 메모리 안전, 단일 툴체인 |
| 엔진 노출 | 127.0.0.1 전용 HTTP + WebSocket (M2 적용), Host 헤더 검증 | 브라우저는 DB에 직접 TCP 연결 불가 — 물리적 제약 |
| 결과 전송 | M0: JSON → M2 이후: Arrow IPC 스트리밍 (적용) | 컬럼형 버퍼로 zero-copy 정렬·필터, 윈도우 페치로 전량 로드 회피 |
| 렌더링 | Canvas 가상화 그리드 (M1 적용, M3 셀 편집) | DOM 테이블은 대량 행에서 한계 |
| SQL 에디터 | CodeMirror 6 (M1 적용) | 브라우저 네이티브 IME가 최대 리스크를 제거 |
| 파일 탐색 | 엔진측 디렉터리 API(`/api/fs/list`) + 브라우저 모달 | 경로 직접 입력은 오타·미검증 위험 |
| 원격 접속 | SSH 터널 내장(russh, M4) + OS 키체인(keyring) | 클라우드 릴레이·서버 비용 불필요, 비밀 정보는 키체인만 |
| 편집 안전 | PK 기반 단일 셀 UPDATE + 명시적 트랜잭션(M3) | 안전한 최소 편집 표면. 세션 스냅샷 패치로 일관성 유지 |
| 개발 기간 | 제약 없음 (성능 우선) | |

## 2. 구성도

```
┌─ 사용자 머신 ─────────────────────────────────────────────────┐
│  [브라우저 탭]  웹 UI (React + CodeMirror 6 + Canvas 그리드)    │
│        │  REST + WebSocket(Arrow IPC) + x-prodb-token          │
│        ▼                                                      │
│  [prodb CLI 프로세스]                                         │
│    prodb-server (axum)  ← 정적 자산(rust-embed), 토큰·Host 검증 │
│                           WS 스트리밍, SSH 터널(russh)          │
│                           store.json(비밀 아님)+키체인(비밀번호) │
│    prodb-engine         ← 백엔드 enum: rusqlite | tokio-postgres│
└───────────────────────────────────────────────────────────────┘
              │                        │
              ▼                        ▼ (SSH 터널 경유 가능)
        SQLite 파일              PostgreSQL 서버
```

## 3. 크레이트 경계

| 크레이트 | 책임 | 의존 |
|---|---|---|
| `prodb` | CLI 엔트리: `serve` 서브커맨드, 포트·토큰 발급, 브라우저 오픈 | server, engine |
| `prodb-server` | axum 라우터, 토큰·Host 인증, 웹 자산(rust-embed), WS 스트리밍, 세션 스냅샷·저널, SSH 터널(russh), store.json·키체인 | engine, types |
| `prodb-engine` | 커넥션·세션·쿼리 실행. 백엔드 enum(rusqlite / tokio-postgres), Arrow IPC 직렬화, 쿼리 취소 | types |
| `prodb-types` | 메시지·결과·접속 설정 공용 타입 (serde) | — |

의존 방향은 항상 위→아래. server는 engine만, engine은 types만 안다.

## 4. 보안 모델

- **127.0.0.1 바인딩만** — 외부 인터페이스 노출 금지.
- **실행 시마다 랜덤 토큰** 발급. 페이지 로드 시 쿼리 파라미터, API 호출 시 `x-prodb-token` 헤더로 검증.
- **Host 헤더 검증** (M2 적용) — DNS 리바인딩 방어.
- 자격증명: DB/SSH 비밀번호는 **OS 키체인에만** 저장(사용자가 "비밀번호도 저장" 선택 시). `~/.prodb/store.json`에는 비밀번호를 기록하지 않으며 SSH 개인키 경로만 저장.
- SSH 터널(russh, M4): 원격 DB는 사용자 머신에서 SSH 채널을 열어 127.0.0.1 임의 포트로 포워딩. PG 호스트/포트는 SSH 서버 관점 주소로 지정.
- TLS: M4 시점 미지원 — `ssl_mode=prefer/require` 요청 시 안내 오류 반환, SSH 터널 권장.

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

## 6. 프로토콜 요약 (M2~M4)

- **WS `/api/ws`** (전 메시지 `id` 상관):
  - C→S: `query{sql,max_rows,window}` · `fetch{offset,limit}` · `cancel` · `edit{session,table,pk,column,value,row,col}` · `tx{begin|commit|rollback}`
  - S→C: `meta` → (행>0이면) Arrow IPC 바이너리 → `window{offset,count}` · `error{message,cancelled}` · `edited` · `tx{state}`
- **세션·편집 (M3)**: 결과 세션 상한 8(최근 사용 유지). 편집은 PK 단일 행 UPDATE이며 성공 시 서버가 세션 스냅샷 셀을 패치. 트랜잭션 중 편집은 저널(old 값) 기록 → `rollback` 시 전 세션 저널 역순 복원, `commit`/`begin` 시 저널 폐기.
- **REST**: `/api/meta` · `/api/open`(SQLite/데모 전환, 터널 해제) · `/api/connect`(PG 직접/SSH) · `/api/fs/list` · `/api/schema` · `/api/connections`(CRUD + `/{id}/connect`) · `/api/history`(GET/DELETE) · `/api/favorites`(CRUD) — 전부 토큰 인증.
- **전송 규약**: 행 1개 = Arrow IPC 배치 1개(BATCH_CHUNK 65,536행), Decimal/문자열 타입 매핑은 엔진 `arrow_schema` 참조.

## 7. 마일스톤

| 단계 | 내용 | 상태 |
|---|---|---|
| M0 | 로컬 서버 + 브라우저 UI + SQLite 실행 + JSON 결과 표시 | 완료 |
| M1 | Canvas 가상화 그리드, CodeMirror 6, 복사·키보드 내비게이션, `--db` 파일 UX | 완료 |
| M2 | WebSocket + Arrow IPC 스트리밍, 쿼리 취소, 윈도우 페치, Host 검증 | 완료 |
| M3 | 셀 편집(DOM 오버레이 에디터)·트랜잭션, 세션 스냅샷 일관성, IME 체크리스트 | 완료 |
| M4 | PostgreSQL 드라이버(백엔드 enum), SSH 터널(russh), 스키마 브라우저, 히스토리/즐겨찾기, 키체인 | 완료 |
| M5 | 배포: brew/winget/scoop, 코드 서명·공증, 자동 업데이트 알림 | 예정 |

## 8. 열린 결정

- 제품명 확정 (현재 `prodb`는 가칭)
- 원격 접속 중계(클라우드 릴레이) 여부 — 도입 시에만 서버 비용 발생
- 라이선스 모델 (오픈소스 vs 상용)
- 다중 접속·탭 UX 상세 — 현재 서버 프로세스당 활성 DB 1개(교체형)
- TLS 직접 접속 지원 시점 (M5+)
