# TablePeek MCP server

`tablepeek mcp` attaches to a running TablePeek and exposes read-only SQL and schema information to MCP clients. It talks over stdio without opening a separate port, and authenticates to the server with the existing TablePeek token.

## Setup

1. Start the TablePeek server and find the token in the URL it prints.
2. Register the command below in your MCP client's configuration.

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

Use the environment variable rather than the `--token` argument so the token does not show up in the process list. For local debugging you can also use the `--url`, `--token`, and `--conn` arguments.

If you leave out `--conn`/`TABLEPEEK_CONN`, the server's default connection is used. A default connection exists only when the server was started with `--db` or `--demo`. Without one, look up the connection ID with `tablepeek_list_connections` and pass it as each tool's `conn` argument.

## Tools

| Tool | Description |
|---|---|
| `tablepeek_list_connections` | List of active connections |
| `tablepeek_list_tables` | Tables and columns, supports `include_system` |
| `tablepeek_describe_table` | Columns, indexes, foreign keys, DDL |
| `tablepeek_query` | Run read-only SQL, 200 rows by default, at most 1000 |

`tablepeek_query` allows only `SELECT`, `WITH`, `SHOW`, `DESCRIBE`, and `EXPLAIN`. It rejects multiple statements and statements containing `INSERT`/`UPDATE`/`DELETE`/`MERGE`/`INTO`/`DROP`/`ALTER`. This check is there to prevent accidents; it is not a permission boundary. Do write operations in the TablePeek UI.

For a MongoDB connection, the following tools are exposed instead. All are read-only.

| Tool | Description |
|---|---|
| `mongo_list_collections` | Databases, collections, and views |
| `mongo_find` | `find` with filter, projection, and sort, at most 100 documents |
| `mongo_aggregate` | Run an aggregation pipeline, `$out` and `$merge` rejected, at most 100 documents |
| `mongo_schema` | Summary of field paths, presence ratio, and types from a sample of at most 200 documents (`$sample`) |
| `mongo_indexes` | Indexes of a collection |

The tool list depends on the engine of `--conn` (or the default connection). If the engine is unknown, both sets are exposed.

## Security

- The MCP server assumes a setup where it connects only to a running TablePeek on `127.0.0.1`.
- Do not leave the token in files, logs, or conversations.
- Make sure the MCP client is a trusted local process. A client with the token can query the connected databases.
- HTTPS and remote TablePeek connections are not supported on the MCP path at the moment.

## Current limits

- MCP is query-only. Transactions, cell editing, DDL, and export are not exposed.
- The plugin sandbox and third-party driver loading are not implemented yet.
- Restarting the server changes the token and connection IDs, so the MCP configuration has to be updated too.
