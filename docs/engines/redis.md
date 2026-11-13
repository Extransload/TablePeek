# Redis

Written: 2026-11-12 · Status: implemented

Engine definition `redis` (alias `valkey`), driver in `crates/tablepeek-engine/src/engines/redis/`, server routes in `crates/tablepeek-server/src/keyvalue.rs`, web code in `web/src/engines/redis/`. The paradigm is `keyvalue`: a connection opens the Redis workbench (§5) instead of the SQL workbench.

## 1. Scope

- Supported servers: Redis 6.0 and later and Valkey 7.2 and later, standalone (a single server, or one replica). Tested on Redis 8.10, Redis 6.2 and Valkey 8.1.
- The client is the `redis` crate (redis-rs) with its `tokio-comp` feature only. TablePeek opens the TCP connection itself (directly, to a tunnel's local end, or through the tunnel) and does TLS with the same rustls every other engine uses, then hands the stream to redis-rs. That way the certificate is checked against the server's own name even through a tunnel, a client certificate can be presented, and no OpenSSL or second TLS stack is pulled in.
- The connection speaks RESP3 (`HELLO 3`) and falls back to RESP2 when the server or a proxy in front of it does not know `HELLO`. Replies keep the types the server sent (maps, sets, doubles, booleans, big numbers, verbatim strings), which the CLI shows as they are.
- Keys, fields, members and values are binary-safe end to end. On the wire between the page and the server, bytes are a JSON string when they are valid UTF-8 and `{"b64": "…"}` otherwise (the page may also send `{"hex": "…"}`).
- One multiplexed connection per database carries the Browser's commands (the connection's own database first, another when a request names it). The CLI has a connection of its own, so a blocking command or a `MULTI` typed there holds nothing else up.

## 2. Connecting

| config key | Meaning |
|---|---|
| `uri` | `redis://[[user]:password@]host[:port][/db]` or `rediss://…` (TLS). Pasting one fills in the other fields; its password moves to the password field and never stays in the saved profile. `?db=n` also works |
| `host`, `port` | Defaults `127.0.0.1`, `6379` |
| `auth` | `none` or `password`. A profile without it gets `password` when it has a user or password |
| `user` | ACL user (Redis 6+). Empty means the `default` user |
| `password` (secret) | `requirepass` or the ACL user's password. Kept in the keychain |
| `database` | Database index (`SELECT`), default 0. Number or text |
| `tls` | bool. Turned on by `rediss://` |
| `tls_ca_file` | PEM CA file. Without it, the system roots |
| `tls_client_cert`, `tls_client_key` | PEM client certificate and key (both, or neither); one file holding both works for both fields |
| `tls_skip_verify` | bool. Don't verify the server certificate (development only) |

- SSH and HTTP tunnels lead to `host:port`. With TLS, the certificate is still checked against `host`, not the tunnel's local end.
- On connect the driver reads `INFO`. A server in cluster mode (`redis_mode:cluster`) or a Sentinel (`redis_mode:sentinel`) is refused with what to do instead (§9). On a replica whose `replica-read-only` is on, the connection is read-only: `capabilities.edit_by_key` is false, the page hides its edit controls, and the server refuses edits with a message naming the replica.
- A refused login (`WRONGPASS`, `NOAUTH`) reads "Authentication failed: …", so a saved profile without a stored password asks for one.
- Each connection names itself with `CLIENT SETNAME` (`tablepeek`, or `tablepeek-cli` for the CLI's) and, where the server knows it (7.2+), `CLIENT SETINFO lib-name tablepeek`, so CLIENT LIST shows which clients are TablePeek's. An account the ACL forbids `CLIENT SETNAME` connects all the same.

## 3. Capabilities

`language: "redis"`, `objects: ["key"]`, `edit_by_key: true` (false on a read-only replica), `transactions: "none"`, `databases: "switch"`, `export_formats: ["json", "text"]`, `sessions.kill: true`. There is no SQL, execution plan, dump, import, user management or index management, and the generic features that need them (saved queries, AI SQL, the table import and export dialogs, the MCP SQL tools) are hidden for Redis connections.

`meta.tables` is always empty: a database can hold millions of keys, so the key browser scans them instead. `meta.path` is `redis[s]://[user@]host:port/<db>`.

## 4. API

All routes take `?conn=<id>` and a JSON body, and answer JSON unless noted. Errors use the usual `{code, message}`: a server error is `redis_<code>` (`redis_WRONGTYPE`, `redis_NOPERM`, `redis_READONLY`, …), a key that is gone is `not_found` (404), and a rule broken before anything was sent is `bad_request`.

| Route | What it does |
|---|---|
| `POST /api/kv/databases` | Every database with its key and expiry counts (`INFO keyspace`; the count of databases from `CONFIG GET databases`, read once when connecting, else 16), the current one and its `DBSIZE` |
| `POST /api/kv/overview` | The workbench header's numbers from one `INFO`: `flavor` (`redis` or `valkey`), `version`, `used_memory` (bytes), `ops_per_sec` (`instantaneous_ops_per_sec`), `connected_clients`, `keys_total` (over every database), `current`, and `databases` (`[{index, keys, expires}]`, empty ones too). The page polls it every few seconds while it shows |
| `POST /api/kv/scan` | One step of the key browser: `SCAN cursor MATCH pattern COUNT … TYPE type`, repeated for up to 300 ms or until `count` keys, then each key's `TYPE` in one pipeline. Answers the next cursor (`"0"` at the end) and the keys with their types |
| `POST /api/kv/keys/meta` | `{db, keys}` (at most 500 keys, else `bad_request`): each key's `ttl_ms` (`PTTL`: -1 without an expiry, -2 when gone) and `memory` (`MEMORY USAGE` with Redis's default sampling; null when the account may not run it), in the order asked, as a bare array, from one pipeline. The key list asks for the rows it shows |
| `POST /api/kv/key` | A key's type, `PTTL`, `MEMORY USAGE`, `OBJECT ENCODING` and length (`STRLEN`, `HLEN`, `LLEN`, `SCARD`, `ZCARD`, `XLEN`). Memory and encoding are null when the account may not run them |
| `POST /api/kv/read` | A page of a key's value, by type (§5) |
| `POST /api/kv/edit` | One change to one key (§6) |
| `POST /api/kv/classify` | How a CLI line would act: `read`, `write` or `danger`, with the reason for a dangerous one |
| `POST /api/kv/console` | Runs one CLI line; a `danger` line only with `confirmed: true` |
| `POST /api/kv/stop` | Stops the CLI command running now |
| `POST /api/kv/info` | `INFO` (one section or all) in sections |
| `POST /api/kv/slowlog`, `/api/kv/slowlog/reset` | `SLOWLOG GET n`, `SLOWLOG RESET` |
| `POST /api/kv/export` | A key's whole value as a file, streamed (§7) |

Only changes reach the connection's command log: the commands of `/api/kv/edit`, CLI commands, `SLOWLOG RESET` and `CLIENT KILL`, and of those the writes also go to History. The browser's reads (`databases`, `overview`, `scan`, `keys/meta`, `key`, `read`, `classify`, `info`, `slowlog`, `export`, and the checks an edit makes before it writes) are not logged, so the log shows what the user did rather than what the screen read.

`/api/server`'s sessions mark as current only the connections that serve the page's reads and edits; the CLI's connection is listed as any other client and can be killed.

The generic routes work as for other engines: `/api/server` lists `CLIENT LIST` as sessions, `/api/kill` runs `CLIENT KILL ID`, and `/api/switch-db` reconnects to another database.

## 5. Workbench

A Redis connection opens one workbench of its own, modelled on RedisInsight's Browser, that fills the area under the connection bar. It does not use the SQL workbench's sidebar (Items, Queries, History), per-object tabs, bottom console log or right detail column, and saved queries do not apply.

- **Overview strip** (top): the database picker (every database with its key count from `INFO keyspace`; empty ones dimmed; picking one switches the connection by reconnecting to it), total keys, used memory, ops per second, connected clients and the Redis or Valkey version, from `/api/kv/overview` every 5 seconds while the page is visible. It also switches between the four sections below.
- **Browser**: two resizable panes.
  - The key list never sends `KEYS`. It scans in steps (`SCAN` with `MATCH` and, on Redis 6+, `TYPE`), keeps scanning until the pane is full, then on **Scan more**; the footer reads "Scanned N of M" with M from `DBSIZE`. The header has a pattern search (`user:*`), a filter on one or more types, a List/Tree switch, rescan and **+ Key**. List rows show a type badge, the name (long names keep their end), the TTL and the size; the TTL and size of the rows on screen come in one `/api/kv/keys/meta` request. Tree view groups keys into folders by a delimiter (`:` by default; others can be picked), each folder with its key count. Rows are virtualized, so a list of 100,000 keys stays fast. ↑/↓ move the selection, Enter opens a key, Delete asks before deleting it.
  - The key details pane shows the selected key: its type, name (click to rename), TTL (click to change, × to remove), length, size (`MEMORY USAGE`) and encoding, a refresh and a delete button (with a confirmation), and a menu with export and opening the key in the CLI. Its value, read a page at a time with **Load more**:
    - String: the first 256 KiB (`GETRANGE`), more on request up to 64 MiB; shown as text, as JSON, or as hex (the default when it is not valid UTF-8), and edited with Save and Cancel.
    - Hash, set: `HSCAN`/`SSCAN` pages, with a search on fields or members (`MATCH`).
    - List: `LRANGE` pages by index.
    - Sorted set: `ZRANGE`/`ZREVRANGE … WITHSCORES` pages by rank, lowest or highest score first, or `ZSCAN` with a search. Scores are kept as the server wrote them (`inf`, `-inf`, `250.5`).
    - Stream: `XRANGE`/`XREVRANGE … COUNT n` pages, one column per field; the next page starts at the id right after (or before) the last one, so no entry repeats or goes missing.
    - RedisJSON (`ReJSON-RL`): `JSON.GET`, shown as a tree or as text and edited as JSON.
    - Other module types (time series, Bloom filters, …): a read-only note, with the type, expiry and memory in the header.
- **CLI**: redis-cli in the workbench (§7).
- **Slow log**: `SLOWLOG GET 128`, with a reset (`SLOWLOG RESET`).
- **Server**: every `INFO` section, and `CLIENT LIST` with a kill button per client (`CLIENT KILL ID`). TablePeek's own connections are named in the list: `tablepeek` for the ones that serve the page's reads and edits (marked as this connection, and not killable from the page) and `tablepeek-cli` for the CLI's (killable; the CLI opens a new one with its next command).

## 6. Editing

Rows of a hash, list, set or sorted set are edited in place (Enter saves, Esc cancels), and several new rows can be added at once. Every change is one command (or one `MULTI … EXEC` where it takes two), logged as redis-cli would show it and recorded in History.

| Change | Commands |
|---|---|
| String value | `SET key value KEEPTTL` (the expiry stays) |
| Hash field add, edit, delete, rename | `HSETNX` (add: fails if the field exists), `HSET`, `HDEL`, `HSET`+`HDEL` in one transaction |
| List set, push, remove | `LSET`, `LPUSH`/`RPUSH`, and for a remove `LSET` to a unique marker then `LREM 1` (Redis removes list items by value only) in one transaction. Set and remove first check the item still holds the value the page read (`LINDEX`) |
| Set add, remove, replace | `SADD`, `SREM`, `SREM`+`SADD` in one transaction |
| Sorted set add, score, remove, rename | `ZADD [NX]`, `ZADD`, `ZREM`, `ZREM`+`ZADD` in one transaction |
| Stream add, delete | `XADD key * field value …`, `XDEL` |
| JSON document | `JSON.SET key $ value` (checked to be JSON first) |
| New key of each type | `EXISTS`, then `SET NX`, `HSET`, `RPUSH`, `SADD`, `ZADD`, `XADD` or `JSON.SET … NX`, with `EXPIRE` in the same transaction when a TTL is given |
| Rename, delete | `RENAMENX` (or `RENAME` when overwriting is chosen), `UNLINK` |
| TTL | `PEXPIRE`, `PERSIST` |

A key whose type changed since it was read is refused rather than overwritten (`TYPE` is checked first).

## 7. CLI and export

- The CLI takes lines as redis-cli does: arguments split on blanks, `"double quotes"` with `\n \r \t \" \\ \xHH` escapes, `'single quotes'`. Replies show their RESP3 type (bulk, integer, array, map, set, double, nil, error). ↑/↓ go through the commands typed before, kept per connection. `SELECT` moves only the CLI.
- It has a connection of its own (named `tablepeek-cli`), so a blocking command or a `MULTI` there holds up nothing else. A connection killed from Server › Clients, or dropped, is opened again with the next command, in the CLI's database.
- Safe mode reads the server's class for the line. Writes are known from a list of commands and, for anything else (a module's command), from `COMMAND INFO` flags; an unknown command counts as a write. Dangerous lines need confirmation at safe mode 1 and up: `FLUSHALL`, `FLUSHDB`, `SHUTDOWN`, `SWAPDB`, `SAVE`, `REPLICAOF`, `FAILOVER`, `MIGRATE`, `CONFIG SET/RESETSTAT/REWRITE`, `CLIENT KILL/PAUSE`, `SCRIPT FLUSH/KILL`, `FUNCTION FLUSH/DELETE/RESTORE/KILL`, `ACL SETUSER/DELUSER/LOAD/SAVE`, `MODULE LOAD/UNLOAD`, cluster changes, `DEBUG`, a `DEL`/`UNLINK` of 10 keys or more, and `KEYS` on a database of more than 10,000 keys. The server refuses a dangerous line sent without `confirmed: true` whatever the page did.
- The CLI never sends commands that would take its connection over or change who it is: `SUBSCRIBE` and the other subscription commands, `MONITOR`, `SYNC`/`PSYNC`, `QUIT`, `RESET`, `HELLO`, `AUTH`, `CLIENT REPLY`, `CLIENT TRACKING`.
- Stop ends a blocking command (`BLPOP key 0`): the CLI's connection is dropped and the server is told `CLIENT KILL ID` for it; the next line opens a new one.
- Export (from a key's menu in the list or the details pane) writes one key's value as JSON (`{"key", "type", "ttl_ms", "value"}`: a hash as an object, a list or set as an array, a sorted set as `[{member, score}]`, a stream as `[{id, fields}]`, a JSON document as itself, bytes that are not UTF-8 as `{"b64": …}`) or as text (a string's bytes; one line per item otherwise, `field<TAB>value` and `score<TAB>member`). The server reads it a page at a time (`GETRANGE` 1 MiB, `HSCAN`/`SSCAN`/`LRANGE`/`ZRANGE`/`XRANGE` 1,000 at a time) and streams it; a failure midway cuts the download off.

## 8. Testing

- Unit tests (`cargo test -p tablepeek-engine redis`): the CLI's argument splitting and quoting, password masking in the log, command classes, reply typing under RESP2 and RESP3, the bytes' wire form, connection strings and settings, stream paging ids.
- Live tests: `make test-db ENGINE=redis` (Redis 8 on 16379, password `tablepeek_test_pw`, ACL user `tablepeek`), then `make test-live ENGINE=redis` (`TABLEPEEK_TEST_REDIS=1`). The seed (`testdb/redis-seed.sh`) puts one key of each type in database 0, including a 5,000-field hash, a binary string, a 250-entry stream, a JSON document and a time series, and three keys in database 1. The tests read every type, page through the big hash and the stream both ways, make and change a key of each type, read the overview and the key list's TTL and size batch, check that the Browser's reads stay out of the command log, run the CLI (typed replies, `SELECT`, an error reply, a stopped `BLPOP`), check that only the page's connections are marked current, kill the CLI's connection and run the next command on a new one, export, switch databases and check a wrong password. The server crate's tests call the `/api/kv/*` routes against the same server.
- Also: `ENGINE=redis-tls` (TLS only, client certificate required, 16380, `TABLEPEEK_TEST_REDIS_TLS=1`; also through an HTTP tunnel, the certificate checked against the configured name), `ENGINE=valkey` (Valkey 8, 16381, `TABLEPEEK_TEST_VALKEY=1`) and `ENGINE=redis-6` (Redis 6.2, 16382, `TABLEPEEK_TEST_REDIS_6=1`).

## 9. Limits

- **No Redis Cluster.** A connection to a cluster-mode server is refused. One connection to one node would meet `MOVED` for most keys, and following redirects means a connection per node, which the tunnel model (one address per connection) does not give. Connect to a server with cluster mode off, or use `redis-cli -c`.
- **No Sentinel discovery.** A Sentinel is refused: it holds no keys. Connect to the master it reports (`SENTINEL get-master-addr-by-name <name>`) directly.
- **No Unix sockets.** `unix://` and `redis+unix://` are refused; connect over TCP.
- **No Pub/Sub or MONITOR in the CLI.** They take the connection over until unsubscribed; the CLI refuses them.
- **The CLI has one connection per TablePeek connection.** Two windows open on the same connection send their CLI commands over it one after the other, so a `MULTI` or `WATCH` started in one also covers the other's commands until `EXEC` or `DISCARD`. Each request carries its own database, so `SELECT` in one window does not move the other.
- **List item edits by index can race.** Redis has no compare-and-set for list items. The page's set and remove check the item's value first, but a push between that check and the write can shift the index. Lua would close the gap but scripts are often disabled by ACL, so it is not used.
- **Big values.** A string view reads at most 64 MiB; export has no limit. A RedisJSON document is read whole with `JSON.GET`.
- **Module types are read-only** except RedisJSON. Time series, Bloom filters and other module values are shown by type, expiry and memory only.
- **Exported hash field names that are not valid UTF-8** are written as redis-cli would quote them (`"\xff…"`), since a JSON object's names must be text.
- **MCP has no Redis tools.** The MCP server lists the connection but offers no tools for it.
