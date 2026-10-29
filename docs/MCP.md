# TablePeek MCP 서버

`tablepeek mcp`는 실행 중인 TablePeek에 붙어 읽기 전용 SQL과 스키마 정보를 MCP 클라이언트에 노출한다. 별도 포트를 열지 않고 stdio로 통신하며, 서버 인증은 기존 TablePeek 토큰을 사용한다.

## 준비

1. TablePeek 서버를 실행하고 출력된 URL에서 토큰을 확인한다.
2. MCP 클라이언트 설정에 아래 명령을 등록한다.

```json
{
  "mcpServers": {
    "tablepeek": {
      "command": "/absolute/path/to/tablepeek",
      "args": ["mcp"],
      "env": {
        "TABLEPEEK_URL": "http://127.0.0.1:7870",
        "TABLEPEEK_TOKEN": "<TABLEPEEK_TOKEN>",
        "TABLEPEEK_CONN": "<CONNECTION_ID>"
      }
    }
  }
}
```

토큰은 프로세스 목록에 남지 않도록 `--token` 인자보다 환경 변수를 권장한다. 로컬 디버깅에서는 `--url`, `--token`, `--conn` 인자도 사용할 수 있다.

`--conn`/`TABLEPEEK_CONN`을 생략하면 서버의 기본 연결을 사용한다. 기본 연결은 서버를 `--db`나 `--demo`로 띄웠을 때만 있다. 기본 연결이 없으면 `tablepeek_list_connections`로 연결 ID를 확인해 각 도구의 `conn` 인자로 지정한다.

## 제공 도구

| 도구 | 설명 |
|---|---|
| `tablepeek_list_connections` | 활성 연결 목록 |
| `tablepeek_list_tables` | 테이블·컬럼 목록, `include_system` 지원 |
| `tablepeek_describe_table` | 컬럼·인덱스·외래 키·DDL |
| `tablepeek_query` | 읽기 전용 SQL 실행, 기본 200행·최대 1000행 |

`tablepeek_query`는 `SELECT`, `WITH`, `SHOW`, `DESCRIBE`, `EXPLAIN`만 허용한다. 다중 문장, `INSERT`/`UPDATE`/`DELETE`/`MERGE`/`INTO`/`DROP`/`ALTER`가 포함된 문장은 거부한다. 이 검사는 사고 방지용이며 권한 경계가 아니다. 쓰기 작업은 TablePeek UI에서 수행한다.

MongoDB 연결이면 다음 도구를 대신 내보낸다. 모두 읽기 전용이다.

| 도구 | 설명 |
|---|---|
| `mongo_list_collections` | 데이터베이스·컬렉션·뷰 목록 |
| `mongo_find` | 필터·프로젝션·정렬로 `find`, 최대 100건 |
| `mongo_aggregate` | 집계 파이프라인 실행, `$out`·`$merge`는 거부, 최대 100건 |
| `mongo_schema` | 최대 200건 표본(`$sample`)으로 필드 경로·있는 비율·타입 요약 |
| `mongo_indexes` | 컬렉션의 인덱스 목록 |

도구 목록은 `--conn`(없으면 기본 연결)의 엔진에 따라 정해지고, 엔진을 알 수 없으면 두 묶음을 모두 내보낸다.

## 보안

- MCP 서버는 `127.0.0.1`의 실행 중인 TablePeek에만 접속하는 구성을 전제로 한다.
- 토큰은 파일·로그·대화에 남기지 않는다.
- MCP 클라이언트가 신뢰할 수 있는 로컬 프로세스인지 확인한다. 토큰을 가진 클라이언트는 연결된 DB를 조회할 수 있다.
- HTTPS·원격 TablePeek 접속은 현재 MCP 경로에서 지원하지 않는다.

## 현재 한계

- MCP는 조회 전용이다. 트랜잭션·셀 편집·DDL·내보내기는 노출하지 않는다.
- 플러그인 샌드박스와 서드파티 드라이버 로딩은 아직 구현되지 않았다.
- 서버가 재시작되면 토큰과 연결 ID가 바뀌므로 MCP 설정도 갱신해야 한다.
