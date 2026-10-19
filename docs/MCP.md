# WrenDB MCP 서버

`wrendb mcp`는 실행 중인 WrenDB에 붙어 읽기 전용 SQL과 스키마 정보를 MCP 클라이언트에 노출한다. 별도 포트를 열지 않고 stdio로 통신하며, 서버 인증은 기존 WrenDB 토큰을 사용한다.

## 준비

1. WrenDB 서버를 실행하고 출력된 URL에서 토큰을 확인한다.
2. MCP 클라이언트 설정에 아래 명령을 등록한다.

```json
{
  "mcpServers": {
    "wrendb": {
      "command": "/absolute/path/to/wrendb",
      "args": ["mcp"],
      "env": {
        "WRENDB_URL": "http://127.0.0.1:7870",
        "WRENDB_TOKEN": "<WRENDB_TOKEN>",
        "WRENDB_CONN": "<CONNECTION_ID>"
      }
    }
  }
}
```

토큰은 프로세스 목록에 남지 않도록 `--token` 인자보다 환경 변수를 권장한다. 로컬 디버깅에서는 `--url`, `--token`, `--conn` 인자도 사용할 수 있다.

`--conn`/`WRENDB_CONN`을 생략하면 기본 연결을 사용한다.

## 제공 도구

| 도구 | 설명 |
|---|---|
| `wrendb_list_connections` | 활성 연결 목록 |
| `wrendb_list_tables` | 테이블·컬럼 목록, `include_system` 지원 |
| `wrendb_describe_table` | 컬럼·인덱스·외래 키·DDL |
| `wrendb_query` | 읽기 전용 SQL 실행, 기본 200행·최대 1000행 |

`wrendb_query`는 `SELECT`, `WITH`, `SHOW`, `DESCRIBE`, `EXPLAIN`만 허용한다. 다중 문장, `INSERT`/`UPDATE`/`DELETE`/`MERGE`/`INTO`/`DROP`/`ALTER`가 포함된 문장은 거부한다. 이 검사는 사고 방지용이며 권한 경계가 아니다. 쓰기 작업은 WrenDB UI에서 수행한다.

## 보안

- MCP 서버는 `127.0.0.1`의 실행 중인 WrenDB에만 접속하는 구성을 전제로 한다.
- 토큰은 파일·로그·대화에 남기지 않는다.
- MCP 클라이언트가 신뢰할 수 있는 로컬 프로세스인지 확인한다. 토큰을 가진 클라이언트는 연결된 DB를 조회할 수 있다.
- HTTPS·원격 WrenDB 접속은 현재 MCP 경로에서 지원하지 않는다.

## 현재 한계

- MCP는 조회 전용이다. 트랜잭션·셀 편집·DDL·내보내기는 노출하지 않는다.
- 플러그인 샌드박스와 서드파티 드라이버 로딩은 아직 구현되지 않았다.
- 서버가 재시작되면 토큰과 연결 ID가 바뀌므로 MCP 설정도 갱신해야 한다.
