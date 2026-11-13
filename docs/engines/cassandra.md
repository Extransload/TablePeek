# Cassandra · ScyllaDB

Written: 2026-10-29 · Status: implemented

Engine definitions `cassandra` and `scylladb` (alias `scylla`), one driver in `crates/tablepeek-engine/src/engines/cassandra/` (ScyllaDB only has a definition in `engines/scylladb/`), web code in `web/src/engines/cassandra/` and `web/src/engines/scylladb/`. The paradigm is `sql` and the dialect family (`family`) is `cql`, so it uses the SQL workbench as is. Where CQL differs from SQL (paging, filters, sorting, transactions, editing), capabilities and dialect hooks change the behavior.

## 1. Scope

- Supported servers: Apache Cassandra 3.11 and later (tested on 5.0), ScyllaDB 5 and later (tested on 2026.3). It connects over the CQL native protocol (default 9042).
- The driver is the pure-Rust `scylla` crate (1.9, also compatible with Cassandra). TLS is rustls like the other engines (the `rustls-023` feature), and there is no native library, so the build has no extra requirements.
- Both definitions use the same driver. Whichever one you connect with, it detects the server (ScyllaDB if `system.versions` exists) and the server info shows e.g. "Apache Cassandra 5.0.9" or "ScyllaDB 2026.3.4".
- Metadata does not use the driver's schema copy (`fetch_schema_metadata(false)`); it is read from `system_schema` when a screen asks for it.

## 2. Connecting

| config key | Meaning |
|---|---|
| `host`, `port` | Defaults `127.0.0.1`, `9042` |
| `user`, `password` (secret) | Only for clusters with authentication enabled. With an empty user, no password is asked for (`needs_password`) |
| `database` | Keyspace. When empty, tables from all keyspaces are shown as `keyspace.table`. Switching databases (`databases: "switch"`) changes this value and reconnects |
| `consistency` | Default consistency level (default `LOCAL_ONE`) |
| `serial_consistency` | `SERIAL` or `LOCAL_SERIAL` (advanced) |
| `datacenter` | Preferred datacenter (advanced). When empty, the driver chooses |
| `lwt_checks` | bool, on by default (advanced). Sends edits with `IF EXISTS`/`IF NOT EXISTS` (§5) |
| `tls`, `tls_ca_file`, `tls_cert_file`, `tls_key_file` | TLS. Without a CA, the system roots are used. Client certificate and key go together |

- SSH and HTTP tunnels: the driver takes the whole tunnel (`TunnelTarget::Members`) and opens one local endpoint on 127.0.0.1 for each node it discovers; each endpoint goes through the tunnel to the address the node announces itself (`system.peers`, `system.local`) and the port from the connection settings (`route.rs`, `AddressTranslator`). So the driver still connects to every node separately behind a tunnel, and prepared statements (edits) go to that partition's replica node through the driver's token-aware routing. ScyllaDB's shard-aware port is not used (one connection per shard over the regular port). When connecting over loopback without a tunnel (a container's port mapping), the other nodes' addresses are unreachable, so every node is mapped to the connection address (that node acts as coordinator).
- Connection failures report TLS (`TLS 연결 실패: …`) and login (`로그인 실패: …`) separately.

## 3. Capabilities

| Capability | Value | Notes |
|---|---|---|
| `language` | `cql` | `"…"` names, `'…'` strings, `$$` bodies, `--`, `//`, `/* */` comments, `BEGIN … APPLY BATCH` |
| `objects` | `table`, `materialized_view`, `type`, `function`, `aggregate`, `trigger` | ScyllaDB has no triggers |
| `schema` | `declared` | `system_schema.columns` |
| `edit_by_key` | true | Rows are found by the full primary key (§5) |
| `transactions` | `none` | Apply, import and restore run without a transaction. No "Run in transaction" |
| `foreign_keys` | false | The ER diagram menu is hidden |
| `ddl` | true | §6 |
| `databases` | `switch` | Keyspaces |
| `users` | true only on logged-in connections | Roles (`LIST ROLES`, `CREATE/ALTER/DROP ROLE`) |
| `explain` | `cql-trace` | §7 |
| `exact_count` | false | The estimate is a token-ring sample (§4). Exact counts use `count_steps` |
| `count_steps` | true | The exact COUNT is split into token ranges counted 8 at a time; the data tab shows progress and a stop button (§4) |
| `dump` | `sql` | CQL script (CREATE + INSERT) |
| `import_formats` / `export_formats` | csv, json, sql / csv, json, sql, xlsx | |
| `sessions` | `{ kill: false }` | The list comes from `system_views.clients` (Cassandra 4+) or `system.clients` (ScyllaDB). There is no CQL to disconnect a client |
| `indexes` | create, drop | Secondary indexes, SAI (`StorageAttachedIndex`) |
| `cursor_paging` | true | §4 |

## 4. Reading

- **Pages advance with the server's paging state, not OFFSET.** The driver reads pages up to `max_rows`, and if rows remain it returns that position as `next_page` (a base64 token). For each statement the data tab collects "the token that continues at row N" (`pageMarks`), and next, previous and the OFFSET box all read from the closest earlier token. For a distant page without a token (the OFFSET box, previous after changing the page size), the server skips the earlier rows, only counting them (`/api/sql/skip`, `SqlDriver::skip_rows`: the rows are not sent to the screen), and records a token at every multiple of the page size so later moves start closer. It walks 1.5 seconds at a time while the status bar shows "N행째로 가는 중 · a / b행 건너뜀" with a progress bar and a stop button; tokens already found are kept after stopping. If the rows run out first, that count becomes the total row count and the last page is shown. Data tab statements have no LIMIT (a LIMIT would cut the whole result across pages). Export and backup also read to the end by token.
- **Row count:** the exact COUNT (`/api/sql/count`, `SqlDriver::count_step`) splits the token ring (Murmur3) into ranges of about 50,000 rows each (based on the sample estimate, at most 4096), counts `token(pk) > a AND token(pk) <= b` ranges 8 at a time, and reports progress every 1.5 seconds (status bar "행 수 세는 중 · 37% · …", stop). A range that times out is split into 8 and counted again (up to 3 levels). When a node reports overload or a timeout (`cql_1001`, `1100`, `1200`, `1300`), that batch is counted again one range at a time. Filters and ALLOW FILTERING are added to every range; a filter on the partition key has nothing to split into ranges and is counted in one statement. Conditions the server won't accept together with a range (some indexes) also run as one statement. The concurrency (8 ranges, 16 duplicate writes) was lowered after the 1.2 GB test container ran out of memory at 16 and 64.
- **Row count estimate:** the token ring is split into four, the density of partitions is measured from the first 256 partition tokens in each part (`PER PARTITION LIMIT 1`; with fewer than 256, that part is exact), and if there are clustering keys this is multiplied by the average `COUNT(*)` of 16 sample partitions to estimate the **row count**. It works right away even on ScyllaDB just after loading, when `size_estimates` is empty. If the sample can't be read, it uses the partition count from `system.size_estimates` divided by the share of the ring that node owns, scaled up to the whole cluster (size uses the same ratio).
- **Sorting:** CQL sorts only within a partition, by clustering key order. The data tab does not sort by key by default (`keyOrder: false`) and sends only the sort you pick. The server rejects a sort when the partition key isn't fixed with an = condition, and the error help explains how.
- **Filters:** only `=`, `>`, `≥`, `<`, `≤`, `IN`, `CONTAINS` (collection element), joined only with AND. Conditions on non-key columns need the "ALLOW FILTERING" switch in the filter bar (turning it on shows a warning that it scans the whole table). The switch applies to data, count, analysis and export statements alike.
- **Values:** numbers and booleans as is, `varint` and `decimal` as numbers with exact digits (strings if they overflow), time (`timestamp` as `2024-03-01 12:00:00.000Z`, UTC), `uuid`, `timeuuid`, `inet`, `duration` (`1h30m`) and `blob` (`0x…`) as strings, and collections, UDTs, tuples and vectors as JSON text matching Cassandra's `toJson()`. The grid shows collection columns as JSON cells.
- **Editor commands:** like cqlsh, it accepts `CONSISTENCY [level]`, `SERIAL CONSISTENCY [level]` and `TRACING ON|OFF` (when on, a trace summary for each statement is logged to the console). `USE ks` changes the keyspace for unqualified tables afterwards. Multiple statements are split on `;`, while `BEGIN … APPLY BATCH` and `$$` bodies stay whole.
- The consistency level picker in the tab bar applies `CONSISTENCY <level>` to every later statement on this connection.

## 5. Editing

- Rows are found by the full primary key (partition key + clustering key). Editing is only possible when the result is a SELECT from one table that includes all primary key columns. Materialized views are not editable.
- A cell edit is `UPDATE … SET c = ? WHERE key IF EXISTS`, adding a row is `INSERT … IF NOT EXISTS`, and deleting is `DELETE … WHERE key IF EXISTS`. When the condition fails (`[applied] = false`), it reports 0 rows, which becomes "다른 곳에서 바뀌었을 수 있습니다" (it may have been changed elsewhere). With `lwt_checks` off, statements are sent without conditions (plain CQL upsert).
- Values are parsed to match the types of the prepared statement's markers. Collections, UDTs, tuples and vectors are entered as JSON (`["a","b"]`, `{"city":"서울"}`). NOW becomes `toTimestamp(now())`, `toDate(now())`, `now()` or `currentTime()` depending on the column type. There is no DEFAULT.
- Static columns are found by the partition key alone.
- **counter:** the cell menu's "Add to Value…" stages the number entered (negative subtracts; the cell shows `+n`), and applying it becomes a single `UPDATE … SET c = c + n` statement (`SqlDriver::edit_add`): the server adds atomically. When you type a value directly into the cell, the difference from the value the grid showed (`seen`) is computed at save time and sent as `c = c + (new value − shown value)`; if the server value read just before differs from the shown value, nothing is written and it reports that the value changed from a to b in the meantime (refresh, or use Add to Value). An edit arriving without a shown value (`edit`) does not change counters. Adding a row to a counter table is an addition per counter, and is rejected if a row with the same key already exists (counter tables don't accept `IF NOT EXISTS`, so the check is a read just before).
- Key columns can't be changed (`fixedKeys`): key cells of saved rows are not editable in the grid, and hovering shows why. Only key cells of new rows are filled in.
- There are no transactions, so if applying several changes fails partway, the earlier changes remain, and the screen says so.

## 6. Structure

- Sidebar: tables, materialized views, UDTs (types), functions, aggregates and triggers in the keyspace. Definitions come from the server's `DESCRIBE` (Cassandra 4+, ScyllaDB) when available, otherwise from a CREATE statement built from `system_schema`.
- Structure tab: columns (partition key → clustering key → the rest by name), primary key (`PRIMARY KEY ((a), b)`), secondary indexes and SAI, triggers, table properties (compaction, compression, caching, gc_grace_seconds… from `system_schema.tables`).
- Structure editing: add column (`ALTER TABLE … ADD`), drop (`DROP`), rename (`RENAME`; the server only allows key columns), drop index (`DROP INDEX keyspace.name`). CQL columns have no NOT NULL or default, and the type and primary key membership of an existing column can't be changed (`fixedColumns`), so the structure grid has no is_nullable or column_default columns, and the data_type and is_primary cells of existing columns are read-only (they are chosen only for new columns). The NN and default cells in the new table dialog are disabled too.
- Duplicating a table: the driver accepts the TablePeek command `CREATE TABLE new AS SELECT * FROM source` (not in CQL), creates a new table with the source's columns, primary key, clustering order and options (except extensions), then reads rows by token page and writes them 16 at a time (by addition for counter tables). Write times and TTLs are set anew. There is no rename-table menu (§10).
- A new table (including from import) must have a primary key, so for a table created by import the first column becomes the partition key.

## 7. Execution plan (tracing)

- CQL has no EXPLAIN. TablePeek's EXPLAIN (`EXPLAIN <statement>`) runs the statement once with tracing on (queries up to the first page) and returns the events from `system_traces` as rows. Because the statement really runs, safe mode treats EXPLAIN INSERT as a write.
- The execution plan view shows the request → steps per node, and marks slow steps with the time since the previous step and its share of the total.

## 8. Import, export and backup

- Import (CSV, JSON, CQL script): each batch is sent as one `BEGIN UNLOGGED BATCH … APPLY BATCH`; on failure, the batch is resent one row at a time to find the failing row. There are no transactions, so earlier rows remain, and it reports how many rows were saved. uuid, blob and duration are inserted without quotes, collections and UDTs via `fromJson('…')`.
- Export and backup: read to the end by token page. A backup is CREATE statements (DESCRIBE) and INSERT statements. Backup, SQL export and "INSERT로 복사" (copy as INSERT) all write values using the column's declared type (`importLiteral`: numbers and uuid without quotes, collections via `fromJson`).

## 9. Errors

- Server errors arrive as `cql_<hex code>` (e.g. `cql_2200` Invalid, `cql_2000` syntax, `cql_0100` authentication, `cql_1000` unavailable replicas, `cql_1200` read timeout) with the original message, and syntax errors include line and column (`line 1:7 …`).
- Error help rules: ALLOW FILTERING, sorting without a partition key, missing primary key conditions, unknown column/table/keyspace, not enough replicas for the consistency level, timeouts, login, type mismatch, counters, servers with UDFs or materialized views disabled.
- Cancel only stops waiting; the server may still run the one statement sent at that moment to completion (§10). Multi-statement work such as distant page moves, split counts and duplication stops where it is, because the next statement is not sent.

## 10. Remaining limits (what CQL can't do)

On 2026-10-30, jumping to a page number, exact row counts, counter editing and table duplication were fixed (§4, §5, §6). What remains is only what CQL and its protocol provide no means for.

- **Cancelling a running statement:** the CQL native protocol (v4, v5) messages are STARTUP, OPTIONS, QUERY, PREPARE, EXECUTE, BATCH, REGISTER, AUTH_RESPONSE (requests) and their responses only; there is no cancel request ([native_protocol_v5.spec §2.4, §4](https://github.com/apache/cassandra/blob/trunk/doc/native_protocol_v5.spec)). The driver (`scylla` 1.9) can do nothing but drop the request either. The statement on the server ends at the server's `read_request_timeout`/`range_request_timeout`.
- **Disconnecting other sessions:** the connection list (`system_views.clients`, ScyllaDB `system.clients`) is a read-only virtual table, and there is no CQL statement to close a specific client connection (`nodetool disablebinary` is an admin command that disconnects all clients of a node and can't be sent over CQL).
- **Renaming tables:** CQL's `ALTER TABLE` only accepts adding and dropping columns, renaming (key) columns, and options ([CQL DDL](https://cassandra.apache.org/doc/latest/cassandra/developing/cql/ddl.html#alter-table)). To rename, duplicate the table and then drop the original.
- **Transactions and defaults:** CQL has no multi-statement transactions and no column defaults (as of Cassandra 5.0 and ScyllaDB 2026.3). When applying fails, the app's compensating undo (docs/ENGINES.md §4.1) reverts the earlier changes.
- The existence check when adding a row to a counter table is a read just before the write: Cassandra and ScyllaDB don't accept lightweight transactions (`IF`) on counter tables ("Conditional updates are not supported on counter tables").

## 11. Testing

- Test servers: `make test-db ENGINE=cassandra` (9043) or `ENGINE=scylladb` (9044), one at a time (about 1 GB each). Both have login enabled with `tablepeek` / `tablepeek_test_pw` (superuser). Cassandra runs `*-keyspaces.cql` as the default admin `cassandra` / `cassandra`, and ScyllaDB (which creates no default admin) runs it over the maintenance socket `/var/lib/scylla/cql.m` (no login), to create this account and the keyspaces `shop` and `tablepeek_test`, then loads `cassandra-shop.cql` and the engine-specific `*-extras.cql` (Java and Lua functions, SAI, vectors). The Cassandra container must be limited to 2 CPUs, a 512 MB heap and 128 MB direct memory to start within the 1.2 GB cap.
- Engine tests: `cargo test -p tablepeek-engine cassandra` with `TABLEPEEK_TEST_CASSANDRA=1` or `TABLEPEEK_TEST_SCYLLADB=1` (`engines/cassandra/tests.rs`: token paging, key edits and IF conditions, ALLOW FILTERING and syntax error codes and positions, CONSISTENCY, EXPLAIN tracing, structure, keyspaces and transaction rejection, product detection, server-side row skipping and token marks, token-range COUNT (multiple levels, ALLOW FILTERING, partition key filter), row count estimate, counter shown-value edits, rejection and Add to Value, table duplication). Unit tests cover value conversion, statement splitting, command detection, COUNT statement parsing and token ranges.
- 2026-10-30: all engine tests above (including the new `walks_counts_estimates_and_adds`) passed on Cassandra 5.0.9 and ScyllaDB 2026.3.
- UI check (managed Chromium, 2026-10-30, 5,000-row table): moving to OFFSET 3000 (server walk "301행째부터 2700행을 건너뜀", first row equal to the 3001st of the `SELECT pk, ck` result, on both servers); delaying the skip request by 5 seconds to see "1,201행째로 가는 중 · 0 / 1,200행 건너뜀" and the stop button, and stopping left it in place; COUNT progress (bar and stop; stopping keeps the previous count) and a two-level count split into 4096 ranges (5,000); row count estimate (right after loading on ScyllaDB, "파티션 약 997 × 5.0행"); the cell menu "Add to Value…" (+5, −3 → `n = n + 5`); rejecting a directly typed counter value that changed on the server ("20에서 21(으)로 바뀌어 저장하지 않았습니다"); when the second of two cell changes failed, the first cell was reverted ("되돌림: 1행 a"); sidebar "Duplicate table…" (5,000 rows); duplicating a counter table on ScyllaDB. During this check, a bug where Enter in the OFFSET box committed the value twice, causing two moves with stop only halting the later one (the LIMIT and OFFSET boxes of all engines), was fixed.
- Containers (or clusters behind NAT) announce their internal addresses (172.x), so when connecting over loopback without a tunnel, the driver maps every node to the connection address (`AddressTranslator`). Without this, only the control connection works and queries time out. The driver assumes other nodes use the contact point's port, so the tunnel's per-node endpoints lead to the port from the connection settings (9042).
- Cluster check (2026-10-29, `make test-db ENGINE=scylladb-cluster`: two nodes and sshd): connected through an SSH tunnel to `scylla-a:9042`; the server info showed "노드 2개" (2 nodes), and the trace coordinators of unconditioned statements were split between 172.19.0.8 and 172.19.0.9 (the old approach always used the contact node), confirming the driver connected to each node. On the same connection, also checked: key cell locking (tooltip; Enter does not open the editor) and editing other cells, the structure grid (no is_nullable or column_default; data_type and is_primary locked for existing columns, editable for new columns), the NN and default cells disabled in the new table dialog, and declared-type values in "INSERT로 복사" (varint without quotes, map via `fromJson`, blob as `0x…`).
- UI check (managed Chromium, 2026-10-29, both servers): connection form (test, save, "Ask every time"), SSH tunnel (through the sshd of the `mongodb-rs` profile), sidebar (tables, materialized views, functions, types, aggregates; ScyllaDB's index views excluded), data tab token paging (1–300 → 601–900 → 301–600, no LIMIT or OFFSET), partition key filter, error help for a non-key column filter and the ALLOW FILTERING switch, cell, set and map edits (`IF EXISTS`), adding (`IF NOT EXISTS`) and deleting rows, rejecting key column edits, execution plan (trace tree), consistency level picker and `CONSISTENCY`, syntax error position underline, structure, DDL and table properties, creating tables and adding columns, creating, switching and dropping keyspaces, creating and dropping users (roles), server info (product, topology, connection list), CSV export (1,500 rows by token page), CSV import (batch), backup (CQL literals, names without keyspace) and restoring into another keyspace, English UI.
