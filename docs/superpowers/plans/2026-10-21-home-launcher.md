# 홈 시작 창 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 홈을 "헤더 + 가운데 떠 있는 시작 창"으로 바꾼다. 창 안에서는 그룹(오른쪽 클릭으로 만들고 끌어 놓기로 넣고 빼기), 하위 메뉴가 있는 오른쪽 클릭 메뉴, 연결 가져오기·내보내기, 백업·복원 시작을 지원한다. 함께 environment를 없애고 앱 전체 아이콘을 키운다.

**Architecture:**
- 순수 로직은 작은 모듈로 따로 둔다.
  - 그룹 저장소: `connGroups.ts`
  - 메타 이전: `connMeta.ts`
  - 연결 파일 형식: `connectionsFile.ts`
- 화면은 세 개로 나눈다: `HomeScreen.tsx`(데이터·메뉴·대화 상자 조립), `HomeConnectionList.tsx`(목록·끌어 놓기·키보드), `HomeWelcome.tsx`(첫 실행).
- `ContextMenu`는 하위 메뉴를 지원하게 확장한다. 서버 코드는 바꾸지 않는다. 기존 연결 API(`listConnections`/`createConnection`/`updateConnection`/`deleteConnection`/`connectSaved`)만 쓴다.

**Tech Stack:** React 19 + TypeScript + Vite(웹), 기존 CSS 토큰(`web/src/styles.css`), localStorage.

**Spec:** `docs/superpowers/specs/2026-10-21-home-launcher-design.md`

## Global Constraints

- **의존성:** 새 의존성을 추가하지 않는다. 웹 단위 테스트 러너가 없다.
  - 순수 모듈은 esbuild로 묶어 node로 실행하는 확인 스크립트로 검사한다. 스크립트는 저장소 밖의 임시 디렉터리 `$CHECK`에 둔다.
  - 화면은 Playwright로 브라우저에서 확인한다.
- **기본 검증:** 모든 작업의 마지막 검증에는 `cd web && npx tsc --noEmit -p . && npm run build`의 통과가 포함된다.
- **문구:** UI 문구는 한국어 원문을 `t("…")`로 감싼다. 새 문구마다 `web/src/i18n.ts`의 `EN`에 영어 번역을 같은 작업 안에서 추가한다.
- **DB 로고:** `DriverIcon`을 그대로 쓴다. 새로 만들지 않는다.
- **비밀번호:** 내보내기 파일에 비밀번호·SSH 비밀번호·프록시 비밀번호를 절대 넣지 않는다.
- **저장 위치:** 그대로 둔다. 프로필은 서버 `~/.tablepeek/store.json`, 색·태그·그룹은 localStorage.
- **localStorage 실패:** 사생활 보호 모드 등으로 읽기·쓰기가 실패해도 화면은 깨지지 않는다(기존 `try/catch` 패턴을 따른다).
- **헤더:** 로고, 열린 연결 탭, 설정 톱니를 유지한다.
- **커밋:** 사용자가 요청할 때만 한다. 작업마다 커밋하지 않는다.
- **확인 환경:** 사용자의 7870 서버와 3306·3307 포트는 건드리지 않는다. 브라우저 확인은 격리된 서버로 한다.
  - 실행 명령: `HOME=$SCRATCH/home ./target/debug/tablepeek serve --port 7879 --no-open`
  - 필요하면 `--demo`를 붙인다.

## Review Focus

1. **접힌 그룹 안의 연결도 검색에 나온다.** 검색 중에는 일치하는 연결이 있는 그룹을 펼쳐 보여 주고, 검색을 지우면 원래 접힘 상태로 돌아간다. → Task 6의 Step 5
2. **열린 채로 프로필이 지워진 연결도 사라지지 않는다.** 목록 맨 위에 "열린 연결"로 남는다(헤더 탭과 일치). → Task 6의 Step 5
3. **잘못된 가져오기 파일은 하나도 가져오지 않는다.** 형식이 틀리거나 지원하지 않는 드라이버가 섞여 있으면, 일부만 가져오지 않고 설명이 붙은 오류만 보여 준다. → Task 5의 Step 1
4. **끌어 놓기 예외는 아무 일도 하지 않는다.** 자기 그룹에 다시 놓기, 열린 연결 줄(프로필 없음) 끌기, 검색으로 걸러진 상태에서 놓기가 해당한다. 오류도, 엉뚱한 이동도 없어야 한다. → Task 7의 Step 4
5. **메뉴가 화면 밖으로 잘리지 않는다.** 화면 오른쪽·아래 끝에서 연 오른쪽 클릭 메뉴와 하위 메뉴는 화면 안쪽으로 뒤집혀 다 보인다. → Task 4의 Step 4

---

### Task 1: 앱 전체 아이콘 키우기

**Files:**
- Modify: `web/src/components/icons.tsx` (`ICON_SCALE`)
- Modify: `web/src/styles.css` (넘치는 버튼 크기만)

**Interfaces:**
- Produces: `ICON_SCALE = 1.5`. 모든 `*Icon` 컴포넌트의 실제 픽셀은 `Math.round(size * 1.5)`.

- [ ] **Step 1:** 바꾸기 전 화면을 찍는다. 격리 서버(`--demo`)에서 홈, 작업 화면(툴바, 스키마 사이드바, 탭 줄, 그리드 헤더, 하단 바), 설정 창, 연결 창을 Playwright로 찍어 둔다.
- [ ] **Step 2:** `icons.tsx`의 `ICON_SCALE`을 `1.3`에서 `1.5`로 바꾼다.
- [ ] **Step 3:** 같은 화면을 다시 찍어 비교한다. 아이콘이 버튼 경계를 넘거나 줄 높이·정렬이 깨진 곳만 `styles.css`에서 버튼 크기·간격을 맞춘다.
- [ ] **Step 4:** 기본 검증(tsc + build)을 통과하고, Step 3 화면에서 넘침이 없어야 한다.

### Task 2: environment 없애기 (태그로 이전)

**Files:**
- Modify: `web/src/connMeta.ts`
- Modify: `web/src/components/ConnectModal.tsx` (환경 선택칸·머리 배지 제거, `form.environment` 제거)
- Modify: `web/src/components/ConnSwitcher.tsx` (환경 배지 제거)
- Modify: `web/src/components/SchemaSidebar.tsx`, `web/src/App.tsx` (`environment` prop과 `data-environment` 제거)
- Modify: `web/src/components/HomeScreen.tsx` (환경 알약 제거. 화면 전체는 Task 6에서 다시 쓴다)
- Modify: `web/src/styles.css` (`.schema-sidebar[data-environment]`, `.env-badge`, `.cm-chip.env-*`, `.env-*` 규칙 제거)
- Test: `$CHECK/check-connmeta.mjs`

**Interfaces:**
- Produces:
  - `export interface ConnMeta { group: string; color: string; tags: string[] }` (`environment` 필드 없음)
  - `export function normalizeMeta(value: unknown): ConnMeta | null` (확인을 위해 export)
- 지우는 것: `ConnectionEnvironment`, `ENVIRONMENT_LABELS`, `ENVIRONMENT_OPTIONS`, `environmentLabel`, `inferEnvironment`, `normalizeEnvironment`

- [ ] **Step 1: 실패하는 확인 스크립트를 쓴다.** `connMeta.ts`를 묶어 `normalizeMeta`를 부른다.
  - `normalizeMeta({ group: "g", color: "#fff", tags: ["a"], environment: "production" })` → `{ group: "g", color: "#fff", tags: ["a", "production"] }`
  - `normalizeMeta({ tags: ["production"], environment: "production" })` → 태그 `["production"]` (중복 없음)
  - `normalizeMeta({ tags: [], environment: "" })` → 태그 `[]`
  - `normalizeMeta({ group: "운영 서버" })` → 태그 `[]` (그룹 이름으로 추측하지 않음)
  - 결과 객체에 `environment` 키가 없다.
- [ ] **Step 2:** 실행해서 실패를 확인한다. `npx esbuild web/src/connMeta.ts --bundle --format=esm --platform=node --outfile=$CHECK/connmeta.mjs && node $CHECK/check-connmeta.mjs` → export가 없거나 단언이 실패한다.
- [ ] **Step 3: `normalizeMeta`를 고친다.** 저장된 environment 값(`local`/`development`/`staging`/`production`)이 있으면 태그 끝에 추가하고(중복 제외), 결과에서 environment를 뺀다. `setConnMeta`가 쓰는 정규화도 같은 규칙을 따른다. 위 "지우는 것"과 그 사용처를 모두 정리한다.
- [ ] **Step 4:** 확인 스크립트가 통과하고, 기본 검증을 통과한다.
- [ ] **Step 5: 브라우저에서 확인한다.**
  - localStorage `tablepeek.conn-meta`에 `{"x":{"group":"","color":"","tags":[],"environment":"production"}}`를 넣고 연결 편집 창을 열면, 태그 칸에 `production`이 보이고 환경 선택칸은 없다.
  - 헤더 탭에 DEV/PROD 배지가 없다.

### Task 3: 그룹 저장소

**Files:**
- Create: `web/src/connGroups.ts`
- Modify: `web/src/connMeta.ts` (그룹 지정 함수)
- Test: `$CHECK/check-groups.mjs`

**Interfaces:**
- Produces (`connGroups.ts`):
  - `export interface ConnGroup { id: string; name: string; color: string; collapsed: boolean }`
  - `export const GROUP_COLORS: string[]` (6~8색, `ConnectModal`의 `SWATCHES`와 같은 계열)
  - `export function listGroups(): ConnGroup[]` (만든 순서)
  - `export function createGroup(name: string, color?: string): ConnGroup`
    - `color`가 없으면 `GROUP_COLORS`를 차례로 돌려 쓴다.
    - `name`은 앞뒤 공백을 자르고, 비어 있으면 `"새 그룹"`을 쓴다.
  - `export function updateGroup(id: string, patch: Partial<Pick<ConnGroup, "name" | "color" | "collapsed">>): void`
  - `export function deleteGroup(id: string): void` (그 그룹에 속한 연결의 `group`을 `""`로 비운다)
  - `export function findGroupByName(name: string): ConnGroup | undefined` (대소문자 무시)
  - `export function subscribeGroups(listener: () => void): () => void`
  - `export function migrateGroupNames(): void`
    - `connMeta`의 `group`이 그룹 id가 아닌 문자열이면, 같은 이름의 그룹을 찾거나 만들어 id로 바꾼다.
    - 여러 번 불러도 결과가 같다.
  - 저장 키: `tablepeek.conn-groups`
- Produces (`connMeta.ts`): `export function setConnGroup(connId: string, groupId: string): void`. 색·태그는 유지한다.

- [ ] **Step 1: 실패하는 확인 스크립트를 쓴다.** 메모리 `localStorage` 대역을 `globalThis.window`에 둔다.
  - `createGroup("CiteWell")` → `id`가 비어 있지 않고 `listGroups()`에 하나 있다.
  - 메타 `{a:{group:"CiteWell",…}, b:{group:"CiteWell",…}, c:{group:"Ops",…}}` 상태에서 `migrateGroupNames()`를 부른다.
    - 그룹은 `CiteWell`, `Ops` 두 개다(기존 `CiteWell`을 재사용).
    - `a.group === b.group === CiteWell.id`, `c.group === Ops.id`다.
    - 다시 불러도 그룹 수가 그대로다.
  - `deleteGroup(CiteWell.id)` → `a.group === ""`, `b.group === ""`. 연결 메타의 색·태그는 그대로다.
  - `setConnGroup("c", "")` → `c.group === ""`, `c.tags`는 그대로다.
  - `createGroup("  ")` → 이름이 `"새 그룹"`이다.
- [ ] **Step 2:** 실행해서 실패를 확인한다(모듈 없음).
- [ ] **Step 3:** `connGroups.ts`와 `setConnGroup`을 구현한다. 리스너는 `connMeta`와 같은 방식(모듈 수준 `Set`)을 쓴다. `migrateGroupNames`는 `HomeScreen`이 처음 그려질 때 한 번 부른다(Task 6).
- [ ] **Step 4:** 확인 스크립트가 통과하고, 기본 검증을 통과한다.

### Task 4: 하위 메뉴가 있는 오른쪽 클릭 메뉴

**Files:**
- Modify: `web/src/components/ContextMenu.tsx`
- Modify: `web/src/styles.css` (`.context-*`에 하위 메뉴 표시, 체크, 위험 항목 색)

**Interfaces:**
- Produces:

  ```ts
  export interface ContextMenuItem {
    label: string;
    onSelect?(): void;           // submenu가 있으면 생략
    submenu?: ContextMenuItem[];
    checked?: boolean;           // 앞에 ✓
    danger?: boolean;            // 빨간 글자
    disabled?: boolean;
    separatorBefore?: boolean;
  }
  ```

  지금 `onSelect`만 쓰는 모든 호출부는 그대로 동작해야 한다.

- [ ] **Step 1: 하위 메뉴를 구현한다.**
  - `submenu`가 있는 항목은 오른쪽에 `›`를 표시한다. 마우스를 올리거나, 포커스된 상태에서 → 키를 누르면 항목 오른쪽에 하위 메뉴가 열린다.
  - ← 키나 Esc는 한 단계씩 닫는다. ↑↓로 이동하고 Enter로 고른다.
  - 하위 메뉴 항목을 고르면 메뉴 전체가 닫힌다.
  - 바깥을 누르면 전체가 닫힌다. 하위 메뉴 안을 누르는 것은 "바깥"이 아니다.
- [ ] **Step 2: 화면 끝 처리를 구현한다.** 기존 루트 메뉴의 위치 보정과 같은 방식이다. 하위 메뉴가 오른쪽으로 넘치면 부모의 왼쪽에 열고, 아래로 넘치면 위로 올린다.
- [ ] **Step 3: 회귀를 확인한다.** 그리드 셀 오른쪽 클릭, 스키마 사이드바 테이블 오른쪽 클릭, 탭 줄 ⋯ 메뉴가 전과 같이 동작한다.
- [ ] **Step 4: Review Focus 5를 확인한다.** 임시로 3단 메뉴를 화면 오른쪽 아래 끝(창 너비 −20px, 높이 −20px)에서 연다. 세 단 모두 화면 안에 다 보이고, ←·→·Esc가 위 규칙대로 동작한다.
- [ ] **Step 5:** 기본 검증을 통과한다.

### Task 5: 연결 파일 (내보내기·가져오기 형식)

**Files:**
- Create: `web/src/connectionsFile.ts`
- Modify: `web/src/components/ConnectModal.tsx` (`export function inputFromSaved(saved: SavedConnection): ConnectInput` 추가. 내부는 기존 `buildInput(formFromSaved(saved))`)
- Test: `$CHECK/check-connfile.mjs`

**Interfaces:**
- Consumes: `ConnGroup`(Task 3), `ConnMeta`(Task 2), `inputFromSaved`
- Produces (`connectionsFile.ts`):
  - `export const CONNECTIONS_FILE_FORMAT = "tablepeek-connections"`, `export const CONNECTIONS_FILE_VERSION = 1`
  - `export interface ExportedConnection { name: string; connect: ConnectInput; color: string; tags: string[]; group: string /* 그룹 이름, 없으면 "" */ }`
  - `export interface ConnectionsFile { format: typeof CONNECTIONS_FILE_FORMAT; version: number; groups: { name: string; color: string }[]; connections: ExportedConnection[] }`
  - `export function buildConnectionsFile(saved: SavedConnection[], metaById: Record<string, ConnMeta>, groups: ConnGroup[]): ConnectionsFile`
    - 호출하는 쪽이 범위(전체/그룹/연결)를 정해 `saved`를 걸러서 넘긴다.
    - 파일의 `groups`에는 실제로 쓰인 그룹만 넣는다. 단, 그룹 하나를 통째로 내보낼 때는 빈 그룹이라도 넣는다. 이를 위해 `groups` 인자에 그 그룹을 넘긴다.
  - `export function stripSecrets(input: ConnectInput): ConnectInput` (DB `password`, `ssh.password`, `http_tunnel.password` 제거. `buildConnectionsFile`이 항상 거친다)
  - `export class ConnectionsFileError extends Error {}`
  - `export function parseConnectionsFile(text: string): ConnectionsFile`
    - JSON이 아니거나, `format`·`version`이 다르거나, 연결 하나라도 `driver`가 `postgres|mysql|cockroach|mssql`이 아니거나 그 드라이버 설정(호스트·포트)이 없으면 `ConnectionsFileError`를 던진다.
    - 일부만 통과시키지 않는다.
    - 오류 문구는 한국어이고, 몇 번째 연결이 왜 틀렸는지 포함한다.
  - `export function downloadJson(filename: string, data: unknown): void` (Blob + 임시 `<a download>`)

- [ ] **Step 1: 실패하는 확인 스크립트를 쓴다.**
  - `buildConnectionsFile([saved(비밀번호 포함 입력이 나오도록 만든 대역)], meta, groups)`의 JSON 문자열에 `"password"`가 없다.
  - 두 연결이 그룹 `CiteWell`에 속하면 `groups`는 `[{name:"CiteWell",…}]`이고, 각 연결의 `group`은 `"CiteWell"`이다.
  - `parseConnectionsFile(JSON.stringify(file))`로 되읽은 결과가 원본과 같다.
  - **Review Focus 3:** 연결 두 개 중 두 번째 `driver`가 `"oracle"`이면 `ConnectionsFileError`가 나고, 메시지에 `2`가 들어 있다.
  - `parseConnectionsFile("not json")`, `{format:"x"}`, `{format, version: 2}`는 각각 `ConnectionsFileError`다.
- [ ] **Step 2:** 실행해서 실패를 확인한다.
- [ ] **Step 3:** 구현한다. `ConnectModal.tsx`에 `inputFromSaved`를 export한다. `parseConnectionsFile`은 `ConnectInput`의 드라이버별 필수 필드(`host`, `port`)만 검사하고, 나머지는 그대로 통과시킨다.
- [ ] **Step 4:** 확인 스크립트가 통과하고, 기본 검증을 통과한다.

### Task 6: 시작 창과 목록 (보기·검색·키보드)

**Files:**
- Rewrite: `web/src/components/HomeScreen.tsx` (창 틀, 왼쪽 칸, 위쪽 줄, 상태, 대화 상자 조립)
- Create: `web/src/components/HomeConnectionList.tsx` (그룹·줄·검색 필터·키보드 이동)
- Create: `web/src/components/HomeWelcome.tsx` (기존 `HomeWelcome`을 옮긴다)
- Modify: `web/src/components/icons.tsx` (백업·복원·그룹 아이콘이 기존에 없으면 추가: `UploadIcon`, `GroupIcon`)
- Modify: `web/src/App.tsx` (HomeScreen props)
- Modify: `web/src/styles.css` (기존 `/* Home: … */` 블록과 `.home-*` 전부를 새 시작 창 스타일로 교체)

**Interfaces:**
- Consumes:
  - `listGroups`, `updateGroup`, `subscribeGroups`, `migrateGroupNames`(Task 3)
  - `listConnMeta`, `subscribeConnMeta`(기존)
- Produces (`HomeConnectionList`):

  ```ts
  interface HomeConnectionListProps {
    unsaved: ConnSummary[];                 // 프로필 없는 열린 연결
    saved: SavedConnection[];
    openBySaved: Map<string, ConnSummary>;
    groups: ConnGroup[];
    metaById: Record<string, ConnMeta>;
    query: string;
    busySaved: string | null;
    onActivateSaved(saved: SavedConnection): void;
    onActivateOpen(conn: ConnSummary): void;
    onRowAction(action: "newWindow" | "disconnect" | "edit" | "delete", target: ListTarget): void;
    onContextMenu(target: ListTarget | null, x: number, y: number): void;  // null = 빈 곳
    onMoveToGroup(savedId: string, groupId: string): void;                // Task 7에서 사용
  }
  type ListTarget =
    | { kind: "saved"; saved: SavedConnection; groupId: string }
    | { kind: "open"; conn: ConnSummary }
    | { kind: "group"; group: ConnGroup };
  export function filterConnections(saved: SavedConnection[], metaById: Record<string, ConnMeta>, groups: ConnGroup[], query: string): Set<string>  // 보일 saved id
  ```

- Produces (`HomeScreen` props, App 쪽에서 사용):

  ```ts
  onNewConnection(options?: { driver?: Driver; group?: string; url?: string }): void
  onBackupOrRestore(kind: "backup" | "restore"): void   // Task 8에서 구현. 이 작업에서는 연결만 해 둔다
  ```

  나머지 props(`conns`, `busySaved`, `onOpenConn`, `onOpenNewWindow`, `onCloseConn`, `onOpenFile`, `onConnectSaved`, `onEditConnection`, `savedVersion`, `appError`, `onDismissAppError`)는 지금 이름을 유지한다.

- [ ] **Step 1: 시작 창 틀을 만든다.**
  - 헤더 아래 영역 가운데에 떠 있는 창을 둔다. 최대 760×480, 둥근 모서리, 테두리, 그림자. 좁은 화면에서는 가장자리 여백 16px로 꽉 찬다.
  - 왼쪽 칸(약 250px): 흐린 `BrandMark`+워드마크, "로컬 DB 클라이언트", 작업 세 개("새 연결 만들기…", "데이터베이스 백업…", "데이터베이스 복원…").
    - 작업 아이콘은 약 28px 배경 칸 안에 16px 이상으로 둔다.
    - 백업·복원은 `onBackupOrRestore`를 부른다.
  - 오른쪽 위 줄: + 버튼(누르면 메뉴. 항목 구성은 Task 7), 검색창(placeholder "연결 검색 (이름·호스트·태그)").
- [ ] **Step 2: 목록을 만든다.**
  - 순서: 프로필 없는 열린 연결 → 그룹 없는 저장된 연결(최근 사용 순) → 그룹(만든 순, 안에서는 최근 사용 순).
  - 그룹 머리줄: 접기 화살표, 그룹 색 원형 아이콘, 이름, 접혔을 때 개수. 누르면 접고 편다(`updateGroup(id, {collapsed})`).
  - 연결 줄: `DriverIcon`(34px), 이름, 태그 알약(연결 색. 색만 있고 태그가 없으면 색 점), 두 번째 줄 `호스트 : DB`, 오른쪽 상태("● 연결됨" 또는 마지막 사용 시간). **테이블 개수 없음.**
  - 마우스를 올리거나 포커스가 오면 상태 자리가 새 창·연결 끊기·편집·삭제 버튼으로 바뀐다. 삭제는 지금처럼 확인을 거친다.
- [ ] **Step 3: 검색을 구현한다.** `filterConnections`는 이름, 호스트, DB 이름, 태그, 그룹 이름을 대소문자 무시 부분 일치로 비교한다. 그룹 이름이 맞으면 그 그룹의 연결이 모두 보인다. 검색 중에는 결과가 있는 그룹만 펼쳐 보이고, 결과가 없으면 "검색 결과가 없습니다"를 보여 준다.
- [ ] **Step 4: 키보드를 구현한다.** 검색창에서 ↓를 누르면 첫 줄로 간다. 줄 사이는 ↑↓, Enter·Space로 연다.
- [ ] **Step 5: Review Focus 1·2를 확인한다.**
  - 접힌 그룹 안의 연결 이름으로 검색하면 그 그룹이 펼쳐져 그 줄이 보이고, 검색을 지우면 다시 접힌다.
  - 열려 있는 저장 연결의 프로필을 삭제하면, 그 연결은 목록 맨 위에 "● 연결됨" 줄로 남는다. 헤더 탭과 개수가 같다. 이를 위해 `unsaved`는 "`saved_id`가 없거나, `saved_id`가 지금 저장 목록에 없는 열린 연결"로 정의한다.
- [ ] **Step 6: 첫 실행 화면을 옮긴다.** 저장 연결·열린 연결·그룹이 모두 없으면 오른쪽 목록 자리에 `HomeWelcome`을 보여 준다. 위쪽 줄(+·검색)은 남긴다. 버튼은 "시작하기", "SQLite 파일 열기", "연결 가져오기…"다. "연결 가져오기…"는 Task 7의 파일 가져오기를 부르고, 이 작업에서는 prop만 연결해 둔다.
- [ ] **Step 7: 저장 목록을 불러오지 못한 경우를 처리한다.** 지금 동작을 유지한다. 오류(`ErrorNotice`)와 "다시 시도"를 목록 위에 보여 주고, 위쪽 줄과 열린 연결은 그대로 둔다.
- [ ] **Step 8: 확인한다.** 기본 검증을 통과한다. 격리 서버(`--demo`, 저장 연결 5개, 그룹 2개: localStorage로 주입)에서 밝은·어두운 테마, 너비 1280·520 화면을 찍어 위 규칙을 확인한다.

### Task 7: 그룹 다루기 · 오른쪽 클릭 메뉴 · 가져오기·내보내기

**Files:**
- Modify: `web/src/components/HomeScreen.tsx`, `web/src/components/HomeConnectionList.tsx`
- Create: `web/src/components/PromptModal.tsx` (제목·라벨·초기값·확인/취소로 된 한 줄 입력 대화 상자)
- Modify: `web/src/components/ConnectModal.tsx`
  - "그룹" 칸을 없앤다.
  - props `initialGroup?: string`, `initialUrl?: string`을 추가한다.
  - 저장할 때 메타의 `group`은 편집 중이면 기존 값을 유지하고, 새 연결이면 `initialGroup ?? ""`로 한다.
  - `initialUrl`이 있으면 처음에 `parseConnectionUrl` 결과로 폼을 채운다.
- Modify: `web/src/App.tsx`
  - `openNewConnection(options)`이 driver·group·url을 ConnectModal로 넘긴다. `key`에도 반영한다.
  - 복제 처리(`store.createConnection(name + " 복사본", inputFromSaved(saved), false)` 뒤 메타 복사)를 넣는다.

**Interfaces:**
- Consumes:
  - `ContextMenuItem.submenu`(Task 4)
  - `createGroup`/`updateGroup`/`deleteGroup`/`findGroupByName`/`setConnGroup`(Task 3)
  - `buildConnectionsFile`/`parseConnectionsFile`/`downloadJson`/`ConnectionsFileError`(Task 5)
- Produces: `PromptModal({ title, label, initial, confirmLabel, onSubmit(value: string), onClose })`

- [ ] **Step 1: 메뉴를 만든다.** 설계 문서의 표를 그대로 따른다.
  - **연결 줄:** 열기 · 새 창에서 열기(열려 있을 때) · 편집… · 복제 · 그룹으로 이동 › · ── · 새로 만들기 › · 내보내기 › · ── · 삭제(danger)
  - **그룹 머리줄:** 이름 바꾸기… · 색 바꾸기 ›(`GROUP_COLORS`, 지금 색 checked) · 그룹 삭제(danger) · ── · 새로 만들기 › · 내보내기 ›
  - **빈 곳:** 새로 만들기 › · 내보내기 ›
  - **새로 만들기 ›:** 그룹… · 연결… · 연결 가져오기 › (URL에서… · 파일에서…)
    - 그룹 안의 줄이나 그룹 머리줄에서 연 "연결…"은 `onNewConnection({ group })`를 부른다.
  - **내보내기 ›:** 전체 내보내기… · 이 그룹 내보내기…(그룹 맥락에서만) · 이 연결 내보내기…(연결 줄에서만)
  - **그룹으로 이동 ›:** 그룹 목록(지금 그룹 checked) · ── · 그룹 없음
  - **+ 버튼 메뉴:** 새 연결… · 새 그룹… · SQLite 파일 열기… · 연결 가져오기 ›
- [ ] **Step 2: 그룹 동작을 붙인다.**
  - "그룹…"과 "이름 바꾸기…"는 `PromptModal`을 쓴다.
  - "그룹 삭제"는 확인 문구 "‘{name}’ 그룹을 삭제할까요? 안의 연결은 그룹 밖으로 옮겨집니다."를 거친다. 그다음 `deleteGroup`을 부르고 프로필은 지우지 않는다.
- [ ] **Step 3: 끌어 놓기를 붙인다.**
  - 저장된 연결 줄만 `draggable`이다.
  - 그룹 머리줄과 그 그룹의 줄 위에 놓으면 `setConnGroup(id, group.id)`를 부른다.
  - 맨 위 "그룹 없음" 영역(그룹 없는 연결들과 목록 위쪽 여백) 위에 놓으면 `setConnGroup(id, "")`를 부른다.
  - 끄는 동안 놓을 곳에 점선 테두리와 옅은 배경을 표시한다.
- [ ] **Step 4: Review Focus 4를 확인한다.**
  - 같은 그룹에 다시 놓으면 아무 변화가 없다.
  - 열린 연결 줄(프로필 없음)은 끌리지 않는다.
  - 검색으로 걸러진 상태에서 끌어 놓아도 놓은 그룹으로만 들어가고, 검색을 지운 뒤에도 그대로다.
  - 이때 콘솔 오류가 없다.
- [ ] **Step 5: 가져오기·내보내기를 붙인다.**
  - **내보내기:** `downloadJson("tablepeek-connections.json", buildConnectionsFile(범위에 맞는 saved, metaById, groups))`
  - **파일에서 가져오기:** 숨긴 `<input type="file" accept=".json,application/json">`으로 읽어 `parseConnectionsFile`을 부른다.
    - 성공하면 그룹은 이름으로 합치거나 만든다(`findGroupByName` → `createGroup`).
    - 연결은 하나씩 `createConnection(name, connect, false)`로 저장하고 메타(색·태그·그룹 id)를 기록한다. 이름이 겹치면 `" (가져옴)"`을 붙인다.
    - 끝나면 "연결 {count}개를 가져왔습니다"를 알린다.
    - `ConnectionsFileError`는 `ErrorNotice`로 보여 준다.
  - **URL에서 가져오기:** `PromptModal`로 URL을 받아 `onNewConnection({ url })`을 부른다.
- [ ] **Step 6: 확인한다.** 기본 검증을 통과하고, 브라우저에서 아래를 확인한다.
  - 그룹을 만들고, 끌어 넣고, 이름·색을 바꾸고, 삭제한다.
  - "그룹으로 이동 ›"으로 옮긴다.
  - 그룹 안에서 "연결…"로 만들면 그 그룹에 들어간다.
  - 전체를 내보낸 파일에 `"password"`가 없다(파일 내용을 읽어 확인).
  - 그 파일을 다른 격리 HOME에서 가져오면 그룹·태그·색이 같다.
  - URL 가져오기로 연결 창이 채워져 열린다.
  - 복제하면 "복사본"이 생기고 메타가 같다.

### Task 8: 시작 창에서 백업·복원

**Files:**
- Create: `web/src/components/ConnectionPickerModal.tsx` (검색 + `HomeConnectionList`와 같은 줄 모양의 단순 목록. 그룹 머리줄은 제목으로만)
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: 기존 `connectSavedById(id)`, `enterConn(id)`, `setDumpTab(kind)`, `DumpModal`
- Produces:
  - `ConnectionPickerModal({ title, conns, saved, onPick(target: { savedId?: string; connId?: string }), onClose })`
  - App의 `pendingDumpRef: { target: { savedId?: string; connId?: string }; kind: "backup" | "restore" } | null`

- [ ] **Step 1: 고르는 창을 구현한다.** `onBackupOrRestore(kind)`는 제목 "백업할 연결 선택" 또는 "복원할 연결 선택"으로 `ConnectionPickerModal`을 연다.
- [ ] **Step 2: 고른 뒤 흐름을 구현한다.**
  1. 고르면 `pendingDumpRef`에 기록한다.
  2. 열린 연결이면 `enterConn`, 저장 연결이면 `connectSavedById`를 부른다.
  3. 활성 연결이 대상과 같아지고 그 `meta`가 준비되면 `setDumpTab(kind)`를 부르고 `pendingDumpRef`를 비운다(`useEffect`).
  - 비밀번호가 없어 연결 창으로 넘어간 경우에도, 그 창에서 연결에 성공하면 같은 효과로 백업·복원 창이 열린다.
  - 사용자가 연결 창을 닫으면 대기를 비운다.
- [ ] **Step 3: 확인한다.** 기본 검증을 통과하고, 격리 서버와 임시 MySQL(포트 33099)에서 아래를 확인한다.
  - 비밀번호가 저장되지 않은 연결로 백업하면, 연결 창에서 비밀번호를 넣은 뒤 백업 창(백업 탭)이 열린다.
  - 이미 열린 연결로 복원하면 바로 복원 탭이 열린다.

### Task 9: 마무리 확인

- [ ] **Step 1:** 기본 검증과 `cargo test --workspace`가 통과한다(서버 코드는 바뀌지 않았지만 회귀 확인).
- [ ] **Step 2:** 남은 코드를 정리한다.
  - `HomeScreen.tsx`, `styles.css`에서 쓰이지 않는 옛 홈 코드·클래스를 찾는다: `grep -rn "home-grid\|home-add\|home-card" web/src`의 결과가 새 구조에서 쓰는 것뿐이어야 한다.
  - `ENVIRONMENT`·`environmentLabel` 흔적이 없어야 한다.
- [ ] **Step 3:** 격리 서버에서 처음 실행(빈 HOME), 연결 몇 개, 그룹이 있는 경우를 밝은·어두운 테마로 찍어 최종 확인한다.
