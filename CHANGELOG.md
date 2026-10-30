# Changelog

All notable changes to TablePeek are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html): while TablePeek is at 0.x, new features raise the minor version and fixes raise the patch version.

## [Unreleased]

## [0.1.0] - 2026-10-30

The first versioned release of TablePeek: a local-first database client with a Rust engine and a browser UI.

### Added

- **Engines.** SQLite, PostgreSQL, MySQL/MariaDB, CockroachDB, SQL Server, Oracle (pure-Rust thin driver, no Instant Client), ClickHouse, Cassandra, ScyllaDB, MongoDB, Elasticsearch, and OpenSearch.
- **Connections.** Saved profiles in `~/.tablepeek/store.json` with passwords in the OS keychain; TLS with CA and client certificates; SSH and HTTP tunnels; environment badges and colour-coded tabs; groups on the connection home; password-sealed `.tablepeek` export and import.
- **Data grid.** Canvas grid fed by Arrow IPC streaming, with filter conditions or a raw `WHERE`, multi-column sort, paging, remembered column widths, foreign-key jumps, type colours, primary-key cell edits, row insert/duplicate/delete, `DEFAULT`/`NOW()` set on the server, and explicit transactions.
- **Quick Look.** Value editor, JSON tree, encoding/HEX inspector, and the row a foreign key points to.
- **Query workbench.** CodeMirror 6 editor with schema-aware completion (joins from foreign keys, function signatures, templates), query tabs, snippets, history and favourites, safe mode for unqualified `UPDATE`/`DELETE`, visual `EXPLAIN` plans, cancellation, and chart and pivot views.
- **Transfer.** CSV/JSON import; CSV/JSON/XML/SQL export; SQL dump and restore, all as cancellable background jobs.
- **Schema and server tools.** Sidebar tree of tables, views, functions, triggers and sequences; Structure and DDL tabs; table and database creation; server info with sessions; an ER diagram.
- **MongoDB workbench.** Documents, Aggregation, Schema, Validation, Indexes, Explain and Changes tabs; mongosh tabs; import and export; GridFS; Atlas Search indexes; a performance tab.
- **Search engines.** Query DSL, SQL, and a Dev Tools console for Elasticsearch and OpenSearch.
- **MCP.** `tablepeek mcp`, a stdio MCP server with read-only schema and query tools for SQL engines, MongoDB, and the search engines.
- **Settings and themes.** Settings grouped by the part of the screen they change, per-area fonts, 50 built-in themes plus Base16/VS Code theme import, and an English and Korean interface.
- **Security.** Loopback-only listener, a per-run access token, and Host header checks.
- **Releases.** Prebuilt archives for macOS (Apple silicon and Intel), Linux (x86_64 and aarch64), and Windows (x86_64) on GitHub Releases with `SHA256SUMS`, beside source builds.
- **Version and updates.** `tablepeek --version` and `GET /api/version` report the version, commit, build kind (release or source), and target. An in-app notice says when a newer stable release is out, with a link to its notes, update steps for release and source installs, and "skip this version". GitHub Releases is checked at most once a day and nothing is shown when offline. Turn the check off under Settings > General or with `TABLEPEEK_NO_UPDATE_CHECK=1`; `TABLEPEEK_UPDATE_URL` points it at another endpoint.

[Unreleased]: https://github.com/Extransload/TablePeek/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Extransload/TablePeek/releases/tag/v0.1.0
