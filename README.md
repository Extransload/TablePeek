# TablePeek

[![CI](https://github.com/Extransload/TablePeek/actions/workflows/ci.yml/badge.svg)](https://github.com/Extransload/TablePeek/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/Extransload/TablePeek)](https://github.com/Extransload/TablePeek/releases/latest)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue)](LICENSE)

**A fast, local-first database client for macOS, Windows, and Linux.**

Query, browse, and edit SQLite, PostgreSQL, MySQL/MariaDB, CockroachDB, SQL Server, Oracle, ClickHouse, Cassandra, ScyllaDB, MongoDB, Elasticsearch, OpenSearch, and Redis/Valkey from one app. Everything runs on your machine: no account, no cloud relay. The interface is in English and Korean.

![TablePeek data grid showing a PostgreSQL products table with type-colored numbers, text, arrays, JSON, bytes, and NULLs](docs/images/grid.png)

- **Fast on big results.** Rows stream in and render on a canvas grid; queries can be cancelled.
- **Safe edits.** Cell edits go through the primary key, with explicit transactions and a safe mode for `UPDATE`/`DELETE` without `WHERE`.
- **Smart SQL editor.** Completion for columns, joins from foreign keys, functions, and templates.
- **Inspect anything.** Quick Look for JSON trees, hex, and the row a foreign key points to; an ER diagram; charts and pivots.
- **Write SQL with AI, your own model.** Opt-in and off by default. Press `⌘E`, describe a query, and the SQL for the connection's schema is written into the editor for you to accept or reject. It can also suggest SQL as you type. Use your ChatGPT subscription, the Codex CLI signed in on your machine, or a Gemini API key. Rows are never sent, and nothing runs until you do.
- **MCP for AI clients.** `tablepeek mcp` lets an AI client such as Claude Desktop list connections, read the schema, and run read-only queries against a running TablePeek.
- **Import and export.** CSV, JSON, XML, and SQL, plus dump and restore, as background jobs.
- **Secure by default.** Loopback only, passwords in the OS keychain, TLS and SSH tunnels.

## Install

**macOS** (Apple silicon; Intel Macs are not supported)

```sh
brew install --cask extransload/tap/tablepeek
```

**Windows**: download `TablePeek-…-setup.exe` from [Releases](https://github.com/Extransload/TablePeek/releases/latest) and run it.

**Command line** (macOS, Linux, Windows): download the `tablepeek-…` archive for your platform from [Releases](https://github.com/Extransload/TablePeek/releases/latest), unpack it, and run:

```sh
./tablepeek serve
```

It opens TablePeek in your browser. Add `--demo` to try it with sample data. The desktop app is for macOS and Windows only; on Linux, use the command line.

> The builds are not signed with a paid certificate, so the first launch of a downloaded file needs one extra click. Homebrew handles that for you. See [the install guide](docs/INSTALL.md) for details, updating, and building from source.

## Screenshots

| Quick Look | SQL completion |
|---|---|
| ![Quick Look showing a JSON value as a tree](docs/images/quick-look.png) | ![SQL completion suggesting joins from foreign keys](docs/images/completion.png) |
| Any cell as a JSON tree, hex, or the row it references | Joins from foreign keys, with an info panel |
| **ER diagram** | **Charts and pivots** |
| ![ER diagram of a shop schema](docs/images/er.png) | ![Bar chart of monthly order totals](docs/images/chart.png) |
| Tables and relations laid out automatically | Bar, line, pie, and pivot views of any result |

## Documentation

- [Install guide](docs/INSTALL.md): every download, first launch, updating, the update check
- [User guide](docs/GUIDE.md): databases and connection options, features, writing SQL with AI, MCP for AI clients, security
- Engine guides: [MongoDB](docs/MONGODB.md), [Oracle](docs/engines/oracle.md), [ClickHouse](docs/engines/clickhouse.md), [Cassandra and ScyllaDB](docs/engines/cassandra.md), [Elasticsearch and OpenSearch](docs/engines/elasticsearch.md), [Redis and Valkey](docs/engines/redis.md)
- [MCP](docs/MCP.md): setting up `tablepeek mcp`, its tools, and its limits
- [Development](docs/DEVELOPMENT.md): architecture, building from source, tests, project layout
- [Contributing](CONTRIBUTING.md): how to propose a change
- [Security](SECURITY.md): the security model and how to report a vulnerability
- [Changelog](CHANGELOG.md): what each release changed

## License

TablePeek is free software under the [GNU Affero General Public License v3.0](LICENSE), version 3 only (`AGPL-3.0-only`). Copyright © 2026 Extransload.

You may use, study, change and share it. If you distribute a changed version, or let other people use a changed version over a network, you must offer them its complete source under the same license. The bundled Oracle driver (`crates/vendor/oracledb`) keeps its own license (UPL-1.0 OR Apache-2.0), and every other library keeps its own.
