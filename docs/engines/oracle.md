# Oracle

Written: 2026-10-29 · Status: Implemented

Engine definition `oracle` (alias `oracledb`), driver `crates/tablepeek-engine/src/engines/oracle/`, web `web/src/engines/oracle/`. The paradigm is `sql`, and it uses the SQL workbench as is.

## 1. Scope

- Supported servers: Oracle Database 12c and later (pagination with `OFFSET … FETCH` and `ORACLE_MAINTAINED` in the user list both start in 12c). Tested against 23ai Free.
- The driver is `oracledb`, the pure-Rust thin driver made by Oracle (26.0.0-beta.5, pinned exactly). **No Instant Client is needed**: there are no install instructions, no library lookup at connect time, and the build needs no C library. TLS uses rustls, like the other drivers. It is a prerelease, so recheck the API when upgrading.
- The driver is synchronous. Each call runs on a blocking thread and uses a single session in turn (`session.rs`).
- Editor statements are taken one at a time. Plain SQL is sent with the trailing `;` (or a line containing only `/`) removed; PL/SQL (BEGIN/DECLARE blocks, CREATE … PROCEDURE·FUNCTION·PACKAGE [BODY]·TRIGGER·TYPE [BODY]·LIBRARY) is sent with its `END;` kept. SQL*Plus `EXEC p(1)` is rewritten to `BEGIN p(1); END;`.

## 2. Connecting

| config key | Meaning |
|---|---|
| `connect_mode` | `service` (host, port, service name), `sid` (host, port, SID), `descriptor` (connect string) |
| `host`, `port` | Default `127.0.0.1`, `1521` |
| `database` | Service name (e.g. `FREEPDB1`) or SID |
| `connect_string` | Easy Connect (`host:1521/svc`, `tcps://…?…`), `(DESCRIPTION=…)`, or an alias from tnsnames.ora |
| `user`, `password` (secret) | |
| `privilege` | Empty, `sysdba`, `sysoper` |
| `tls` | bool. TCPS (the server certificate is checked against the Mozilla roots and the certificates in the wallet) |
| `wallet_file`, `wallet_password` (secret) | `ewallet.pem`. Its folder is the wallet location. With a private key it is mutual TLS; with certificates only, they are trusted CAs |
| `tnsnames_file` | The tnsnames.ora used to look up aliases. Its folder acts as TNS_ADMIN |

- SID mode connects with `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP|TCPS)(HOST=…)(PORT=…))(CONNECT_DATA=(SID=…)))`.
- SSH and HTTP tunnels work in both modes. In connect-string mode the driver resolves the string into a full descriptor (a tnsnames.ora alias from that file, Easy Connect by expansion) and routes each address in it (`(HOST=…)(PORT=…)`) through the tunnel: with one address it uses a single local tunnel end (`TunnelTarget::Address`); with several it takes the tunnel itself (`TunnelTarget::Members`), opens a local end on 127.0.0.1 per address, and replaces only the descriptor's HOST and PORT with those ends (SERVICE_NAME, SID, FAILOVER, SECURITY and the rest stay as they are). TCPS through a tunnel checks the certificate name against 127.0.0.1, so the certificate must include that address.
- A connect string containing `user/password@` is rejected so it is not saved; use the user and password fields instead.
- Each session sets `NLS_DATE_FORMAT='YYYY-MM-DD HH24:MI:SS'`, `NLS_TIMESTAMP_FORMAT='YYYY-MM-DD HH24:MI:SS.FF'`, `NLS_TIMESTAMP_TZ_FORMAT='… TZH:TZM'`, `NLS_NUMERIC_CHARACTERS='.,'` and enables DBMS_OUTPUT. Date text used by filters, copy, and dumps is read in this format.

## 3. Capabilities

| Capability | Value | Notes |
|---|---|---|
| `language` | `sql` | `"…"` names, `q'[…]'` strings, PL/SQL ending in `/` (web `lexing.slashBlocks`, `qQuotes`) |
| `objects` | table, view, materialized_view, sequence, synonym, package, procedure, function, trigger, type | One ALL_OBJECTS query |
| `schema` | `declared` | ALL_TAB_COLUMNS |
| `edit_by_key` | true | Primary key only (ROWID is not used) |
| `transactions` | `always` | §5 |
| `foreign_keys` | true | ALL_CONSTRAINTS |
| `ddl` | true | DBMS_METADATA |
| `databases` | `none` | Schemas show up as sidebar names (`OWNER.NAME`) |
| `users` | true | ALL_USERS, `CREATE USER … IDENTIFIED BY "…"` |
| `explain` | `oracle` | §6 |
| `exact_count` | false | Row counts in Structure come from statistics (NUM_ROWS); row counting uses `COUNT(*)` |
| `dump` | `sql` | |
| `import_formats` / `export_formats` | csv, json, sql / csv, json, sql, xlsx | |
| `sessions` | `{ kill: true }` | V$SESSION, `ALTER SYSTEM KILL SESSION 'sid,serial#' IMMEDIATE`. Without the privilege the list is empty and there is no kill button |
| `validation`, `aggregation` | false | |
| `indexes` | `{ create: true, drop: true }` | |
| `cancel_ends_session` | true | §7. Pressing Stop inside a transaction first asks, warning that it will be rolled back |

## 4. Sidebar, structure, definitions

- Tables: those in the current schema show a bare name; those in other schemas (accounts not created by Oracle) show `OWNER.NAME`. With "Include system", SYS and the like are included too. Nested, overflow, and recycle-bin tables, and the tables that hold materialized view rows, are left out. Running `ALTER SESSION SET CURRENT_SCHEMA` changes the schema that bare names refer to.
- Objects: views, materialized views (open in the Data tab), sequences, synonyms (PUBLIC ones with Include system), packages, procedures, functions, triggers, object types.
- Definitions: `DBMS_METADATA.GET_DDL` (SQLTERMINATOR on, storage clauses off; names are qualified with the schema, so synonyms and foreign keys pointing to other schemas come out right). Packages and types get both specification and body; PL/SQL units end with a `/` line. When DBMS_METADATA refuses an object in another schema (no SELECT_CATALOG_ROLE), ALL_SOURCE, ALL_VIEWS, ALL_MVIEWS, ALL_SEQUENCES, and ALL_SYNONYMS are used instead. GET_DDL takes a little over a second on the server, so the fetched DDL is remembered in the session per object (kind, owner, name, script or not) and shows immediately when reopened. Running a statement in the editor that can change structure (anything that is not a query: DDL, DML, ALTER SESSION, etc.) or refreshing the schema forgets all of it. Nothing is prefetched.
- Structure: columns (Oracle notation `NUMBER(10,2)`, `VARCHAR2(40 CHAR)`, `TIMESTAMP(6) WITH TIME ZONE`…, defaults; the sequence default of an identity column is left out and the DDL shows `GENERATED … AS IDENTITY`), indexes (DESC and function-based expressions), foreign keys, triggers (as CREATE TRIGGER statements), comments, size (USER_SEGMENTS; for other schemas, DBA_SEGMENTS when readable), table properties (tablespace, partitioning, temporary, IOT, logging, compression, row movement, statistics time), DDL (a CREATE TABLE built from the columns when GET_DDL fails).

## 5. Values, editing, transactions

| Type | Grid | When editing |
|---|---|---|
| NUMBER | Integers as numbers; columns with declared scale (`NUMBER(p,s)`) as exact text | `TO_NUMBER(:n)` |
| BINARY_FLOAT/DOUBLE | Number | `TO_BINARY_FLOAT/DOUBLE` |
| DATE | `YYYY-MM-DD HH24:MI:SS` | `TO_DATE`; also accepts `T` and omitted seconds |
| TIMESTAMP(n) | n fractional digits | `TO_TIMESTAMP` |
| TIMESTAMP WITH TIME ZONE | In UTC with ` +00:00` | `TO_TIMESTAMP_TZ`; accepts `Z`, `+0900`, or nothing (+00:00) |
| INTERVAL DAY TO SECOND / YEAR TO MONTH | `+DD HH:MI:SS.FF` / `+YY-MM` | `TO_DSINTERVAL` / `TO_YMINTERVAL` |
| RAW | `0x…` | Bound as bytes |
| BLOB | `0x…` (size only above 16 KiB) | Up to 2000 bytes, bound as bytes. Above that, the statement is wrapped in a PL/SQL block that fills a temporary BLOB (`DBMS_LOB.CREATETEMPORARY`) with `DBMS_LOB.WRITEAPPEND` in 32,767-byte pieces and then uses that BLOB; the affected row count comes back through `SQL%ROWCOUNT` as an out bind. In the console the pieces appear as placeholders such as `:blob1_1` |
| CLOB, NCLOB, LONG | Text | Above 1000 characters, `TO_CLOB(:a) \|\| TO_CLOB(:b) …` |
| BOOLEAN (23ai) | true/false | `TRUE`/`FALSE` |
| JSON, VECTOR | JSON text, `[1,2,3]` | Text as is |

- Cell and row edits first check that the current primary key matches the key the grid received, then run `UPDATE/DELETE … WHERE "K" = …`. Adding an empty row runs `INSERT INTO t (first column) VALUES (DEFAULT)`. NOW is `SYSDATE` for DATE and `SYSTIMESTAMP` for TIMESTAMP.
- Oracle has no BEGIN. When no transaction is open, each statement is committed right away (matching other engines' autocommit; locking `FOR UPDATE` queries too). "Begin transaction" only stops that commit, and COMMIT/ROLLBACK ends it. TablePeek tracks COMMIT, ROLLBACK, and SET TRANSACTION run in the editor, and DDL that commits the transaction first (CREATE, ALTER, DROP, TRUNCATE, GRANT, COMMENT…; except ALTER SESSION/SYSTEM).
- Import (CSV, JSON) lets you choose insert or upsert. Upsert runs, per row, `MERGE INTO t USING (SELECT value AS "C" … FROM DUAL) s ON (t."K" = s."K" …) WHEN MATCHED THEN UPDATE SET (non-key columns) WHEN NOT MATCHED THEN INSERT …` (without the UPDATE clause for key-only tables), and sends multiple rows as one `BEGIN … END;` block (web `sqlDialect.upsertRow`).
- Safe mode reads PL/SQL blocks (`BEGIN`/`DECLARE`, `EXEC`/`CALL`) by the statements inside them (`sqlTools.classifyPlsql`): it looks at each statement after flow keywords (BEGIN, THEN, ELSE, LOOP, EXCEPTION…) and follows the heaviest. SELECT (INTO), DBMS_OUTPUT, RAISE_APPLICATION_ERROR, DBMS_SESSION.SLEEP and the like are reads; `FOR UPDATE` is a write (row locks); DML and DDL inside are treated as those statements (DELETE without WHERE is dangerous); COMMIT and ROLLBACK are writes; `EXECUTE IMMEDIATE` and DBMS_SQL are dangerous (what they change is unknown); any other procedure call is treated as a write and asks like an UPDATE.

## 6. Execution plans, output, compile errors

- The execution plan button prepends `EXPLAIN PLAN FOR `. After running that statement, the driver returns the lines of `DBMS_XPLAN.DISPLAY(NULL, NULL, 'TYPICAL')` as a single `PLAN_TABLE_OUTPUT` column. The grid shows the familiar table as is; the plan view shows a tree built from the indentation (cost, rows, conditions on `*` lines).
- If DBMS_OUTPUT left lines after a PL/SQL block, they show as a result with a `DBMS_OUTPUT` column.
- When creating a PL/SQL unit or view leaves compile errors, ALL_ERRORS is read and returned as an `ORA-24344 … (line, column)` error, and the editor marks that line and column (shifted by the number of leading comment lines).

## 7. Cancel, time limits, sessions

- Cancel stops only the statement and keeps the session and any open transaction (ORA-01013; the server rolls back only that statement). The driver is a patched copy in `crates/vendor/oracledb` (`[patch.crates-io]`; the changes are listed in the header of its Cargo.toml and marked by `TablePeek:` comments in the source). Order: (1) An out-of-band break sent over the session's own connection (TCP urgent data, the same approach as python-oracledb thin; no privilege needed). It is used only if the server says at connect time that it accepts OOB (GSO_CAN_RECV_ATTENTION in accept) and the check (1 urgent byte + RESET) passes. It also works over TCPS (confirmed on 23ai). (2) If that does not work, `ALTER SYSTEM CANCEL SQL 'sid,serial#'` with the ALTER SYSTEM privilege (the old driver hanging while reading this break is fixed by the reset fix in the patched copy). (3) If neither works or the call does not return within 5 seconds, `KILL SESSION` (when privileged), then the session is discarded.
- When the session is discarded: the waiting call ends immediately with "closing and reopening the session", that thread's session is closed after the statement finishes, and the next call opens a new session. An open transaction is reported as "rolled back" by the next COMMIT. `cancel_ends_session` is set per connection: true only when OOB does not work and there is no ALTER SYSTEM privilege (the web asks before Stop inside a transaction).
- The query time limit in settings stops queries with the same cancel. The driver's call timeout uses an in-band break (the server does not look at it until the statement ends), so it is not used.
- Server info: banner and version, container (PDB) and service name, character set, uptime (V$INSTANCE), size (DBA_DATA_FILES or USER_SEGMENTS), session list (V$SESSION + SQL from V$SQLAREA). The kill button appears only with the ALTER SYSTEM privilege.

## 8. Errors

- Database errors: `code: "oracle_error"`, `server_code` is the ORA number (942), the message is the first line `ORA-00942: …`, and the position is the offset Oracle gives (characters, counted from 1). Listener errors (no such service or SID) are numbered 12514/12505.
- The web's `engines/oracle/errorHelp.ts` explains ORA-00001, 01400, 02291/02292, 12899, 01722, date format, 00904, 28000, 12514/12505, 04098, 06550, 24344, 01950 and others, and the shared rules (login, missing table, syntax, locks, privileges, cancel, network) also include ORA numbers.

## 9. Test server and verification

- `make test-db ENGINE=oracle`: `gvenzl/oracle-free:23-slim-faststart` (native arm64), 127.0.0.1:15210, service `FREEPDB1`, 2.5 GB memory cap. The image's 1.5 GB SGA and 512 MB PGA stall within that cap waiting for memory during heavy calls such as DBMS_METADATA, so on first start `testdb/oracle-memory.sql` lowers them to 1 GB SGA and 256 MB PGA in the CDB and restarts the container once. Then, as SYS, it loads `testdb/oracle.sql` (test schema TABLEPEEK: 5,000 users, 20,000 orders, KINDS with every type, one object of each kind, ALTER SYSTEM and SELECT_CATALOG_ROLE privileges) and `testdb/oracle-shop.sql` (sample schema SHOP: an unprivileged account). A run that completes leaves a marker (the last COMMENT) so the next start skips it.
- TCPS: 127.0.0.1:15211 (container 2484). `testdb/oracle-wallet.sh` builds an auto-login wallet (`testdb/oracle-wallet/`) with an Oracle-only server certificate (`oracle`, `localhost`, 127.0.0.1) signed by the test CA (`testdb/x509/`) (an older wallet is rebuilt if `server.p12` is missing). The image has orapki but no Java to run it, so the Oracle PKI library (`oraclepki`, Maven Central) runs on this computer's Java (or a Temurin container if there is none). `testdb/oracle-tls.sh` adds the TCPS address and wallet to the listener inside the container and restarts it. The client wallet is a folder with `testdb/x509/ca.pem` placed as `ewallet.pem`.
- SSH: the same profile starts an SSH server (127.0.0.1:2223, user tablepeek, key `testdb/ssh/id_ed25519`); behind it the server is `oracle:1521` (TCP) and `oracle:2484` (TCPS).
- Unit tests (no server): statement preparation (`;`, `/`, EXEC, compile unit names), cell text → SQL (including pieces of long BLOBs), connect descriptors, tunnel targets in connect strings (one Easy Connect, two addresses in a tnsnames.ora alias) and address replacement, binds, q-strings, and password masking in the console.
- Live tests (`TABLEPEEK_TEST_ORACLE=1 cargo test -p tablepeek-engine oracle`): lists, definitions, structure, every type and paging, key edits (including a 40,002-byte BLOB) and transactions, error position, execution plan, DBMS_OUTPUT, EXEC, compile errors, sessions, both cancel paths (privileged TABLEPEEK gets ORA-01013 via CANCEL SQL within 4 seconds, the transaction and its row remain, `cancel_ends_session` false; unprivileged SHOP discards the session, true), time limit, bad login (1017), missing service (12514), missing SID (12505), connecting to the CDB by SID, Easy Connect, TCPS (host/port and `tcps://` strings; a wallet without the CA is rejected), TCPS through a local end (checked by the descriptor's HOST: `localhost` passes, a name not in the certificate is rejected even when connected via 127.0.0.1), writing and reading a 5 MiB BLOB, an interrupted upload keeps the old value, replace and roll back inside a transaction, RAW(100) overflow rejected, missing row is 404, DDL of a view changed by another session. Server side (`TABLEPEEK_TEST_ORACLE=1 cargo test -p tablepeek-server oracle`): host/port TCPS over an SSH tunnel, Easy Connect TCPS, a two-address descriptor, and rejection of a container name not in the certificate (`tablepeek-testdb-oracle-1`). The out-of-band break cannot reach the server from this computer (Docker Desktop port forwarding drops urgent data), so `make test-oracle-oob` temporarily turns off DISABLE_OOB in a container on the test network and runs `crates/vendor/oracledb/tests/tablepeek_break.rs`: on TCP and TCPS, SLEEP and a large join get ORA-01013 in a little over a second, the same SID and open transaction are kept, and 40 breaks sent near the end of a call do not reach the next call.
- Browser check (managed Chromium, password "Ask every time"): connecting and connection test with service name and connect string, sidebar (other schemas, materialized views, sequences, synonyms, packages, types), definitions of packages, types, sequences, synonyms, Data tab (value display, filter CONTAINS, OFFSET paging), applying cell edits, row add (a trigger fills the key), and row delete, structure, indexes, DDL, adding a column, two PL/SQL blocks separated by `/` with DBMS_OUTPUT and q-strings, autocomplete (tables, TO_CHAR), execution plan tree, session list and killing another session, running in a transaction then rolling back, safe mode confirmation, ORA-00942 error help and position underline, cancel during execution followed by a new session, dump download and restore (every type round-trips unchanged), CSV import and export, user list.
- Additional browser check on 2026-10-29: connect string `tcps://oracle:2484/FREEPDB1` + wallet + SSH key tunnel for connection test, save, and connect (`NETWORK_PROTOCOL`=tcps); in safe mode "Confirm all changes", a DBMS_OUTPUT block does not ask while an UPDATE block and an EXECUTE IMMEDIATE block do; CSV upsert import (existing rows changed, missing rows added); applying a 3,000-byte value to a BLOB cell (a `:blob1_1` block in the console); a new column in DDL after ALTER; the Stop confirmation inside a transaction (cancel continues; confirm stops within 0.5 seconds and the transaction indicator disappears; outside a transaction it does not ask); the same Stop confirmation on SQL Server.
- Browser check on 2026-10-30 (managed Chromium, password "Ask every time"): "Download whole value" on a 100,000-byte BLOB cell (`<blob 100000 bytes>`) returned all 100,000 bytes; "Replace value…" with a dropped 300,000-byte file, then commit and grid reload; an invalid value in the hex field is blocked with "Not hex" and `0x CAFE BABE 00` is applied as 5 bytes (confirmed in the DB); Stop on `DBMS_SESSION.SLEEP(30)` after an INSERT inside a transaction: no prompt, stopped within 3 seconds (`ALTER SYSTEM CANCEL SQL` in the console), the transaction indicator remains and the row is visible in the same session, 0 rows after Rollback.

## 10. Limits

- What remains are Oracle's own limits:
  - On a server that does not accept out-of-band breaks (DISABLE_OOB=ON, the default in the gvenzl test image) or on a path that drops urgent data (SSH and HTTP tunnels, Docker Desktop port forwarding), cancel ends the session if there is also no ALTER SYSTEM privilege. The server does not read an in-band break until the statement ends (confirmed with DBMS_SESSION.SLEEP and a large join). Such connections have `cancel_ends_session` true, so the web asks first.
  - The size of RAW columns (RAW(n), at most 2000 bytes, or 32767 with MAX_STRING_SIZE=EXTENDED) is a limit of the type. BLOBs have no size limit and are handled with the cell menu's "Download whole value" and "Replace value…" (text, hex, dropped or pasted file, progress) (§5, `binary_cells`).
- Resolved: TCPS through tunnels (the local end is used only as the address route and the certificate is checked against the descriptor's HOST), cancel that keeps the session (§7), whole values of BLOBs over 16 KiB, DDL of structure changed by another session (each fetch compares a marker of ALL_OBJECTS LAST_DDL_TIME, count, and OBJECT_ID sum; changes within the same second are not cached, and sequences are always read).
