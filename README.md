# TablePeek

**A fast, local-first database client that runs in your browser.**

TablePeek pairs a Rust query engine with a browser UI. Open SQLite files or connect to PostgreSQL, MySQL/MariaDB, CockroachDB, SQL Server, and MongoDB. Query, inspect, edit, and explore data without a cloud relay or a heavyweight desktop shell.

![TablePeek data grid showing a PostgreSQL products table with type-colored numbers, text, arrays, JSON, bytes, and NULLs (Catppuccin Mocha theme)](docs/images/grid.png)

## At a glance

| | |
|---|---|
| **Databases** | SQLite, PostgreSQL, MySQL/MariaDB, CockroachDB, SQL Server, MongoDB |
| **Runtime** | Local Rust engine + browser UI |
| **Transport** | HTTP + WebSocket, Arrow IPC streaming |
| **Editing** | Primary-key cell edits, row insert/delete, transactions, `DEFAULT`/`NOW()` set on the server |
| **Transfer** | CSV/JSON import, CSV/JSON/XML/SQL export, SQL dump and restore, all as cancellable background jobs |
| **Security** | Loopback-only, per-run token, OS keychain, TLS/mTLS, SSH tunnels, encrypted connection exports |
| **Themes** | 50 built-in themes + Base16/VS Code theme import |

## Why TablePeek

- **Local by design.** The engine binds to `127.0.0.1` and stops there. There is no hosted backend and no cloud relay; direct connections and SSH tunnels run from your machine to the database.
- **Built for real result sets.** Results stream as Arrow IPC and render on a canvas grid that only paints visible cells. Queries are cancellable, and large tables are fetched in windows instead of loaded all at once.
- **Five engines, one workflow.** Use the same grid, editor, schema browser, and Quick Look across SQLite, PostgreSQL, MySQL/MariaDB, CockroachDB, and SQL Server.
- **Edits with guardrails.** Cell updates target a single row through its primary key. Row inserts and deletes are explicit, and transaction state is tracked per session.
- **Inspect, don't guess.** Open any cell in Quick Look for a full value editor, a structured JSON tree, encoding/HEX views, and, for a foreign key, the row it points to.
- **Long work stays out of the way.** Imports, exports, dumps, and restores run as background jobs with progress and a stop button, and never cancel the queries the page is running.
- **Behaves like a desktop app.** Native-feeling menus, per-area fonts, thin scrollbars, 50 themes, and a settings screen organised by the part of the screen it changes.
- **AI access without write access.** The built-in MCP server exposes schema discovery and read-only queries over stdio.

## Quick start

TablePeek is built from source for now, so you need two toolchains: **Rust** (`cargo`, for the server) and **Node.js 20+** (`npm`, for the web bundle). SQLite is bundled and TLS uses rustls, so there is no OpenSSL or database client library to install. macOS and Windows are the primary targets; Linux uses the same stack.

### 1. Install the toolchains

**macOS**

```sh
xcode-select --install                                          # C compiler and linker (skip if already installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh  # Rust: cargo, rustc
brew install node                                               # Node.js 20+ (or the installer from nodejs.org)
```

**Windows**

1. Download and run `rustup-init.exe` from [rustup.rs](https://rustup.rs). When it offers to install the Visual Studio C++ Build Tools, accept: Rust uses that linker on Windows.
2. Install Node.js 20+ (LTS) from [nodejs.org](https://nodejs.org).

**Linux (Debian/Ubuntu)**

```sh
sudo apt install build-essential pkg-config libdbus-1-dev       # compiler; D-Bus headers for the password keyring
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Install Node.js 20+ from [nodejs.org](https://nodejs.org) or a version manager such as nvm; distribution packages are often older.

Then **open a new terminal** and check both tools:

```sh
cargo --version
node --version    # v20 or later
```

> `cargo: command not found` right after installing Rust means the terminal predates the installer's PATH change. Open a new terminal, or on macOS/Linux run `source "$HOME/.cargo/env"`.

### 2. Build and run

macOS / Linux:

```sh
git clone https://github.com/Extransload/TablePeek.git
cd TablePeek
make install
make run
```

Windows has no `make`, so run the same steps in PowerShell:

```powershell
git clone https://github.com/Extransload/TablePeek.git
cd TablePeek
cd web; npm install; npm run build; cd ..
cargo run -p tablepeek -- serve --port 7870
```

The first build compiles every Rust dependency and takes a few minutes; later starts take seconds.

`make run` builds the web bundle and Rust binary, starts the server, and opens the browser on the connection home, where you add your first connection. The console prints a tokenized loopback URL; keep that URL private.

To look around with sample data first, start with an in-memory demo database:

```sh
make run DEMO=1
# Windows: cargo run -p tablepeek -- serve --demo
```

Open an existing SQLite file:

```sh
make run DB=/absolute/path/to/app.sqlite
# Windows: cargo run -p tablepeek -- serve --db C:\path\to\app.sqlite
```

Useful options:

```sh
make run PORT=7871                 # default port is 7870
make run DEMO=1 DEMO_ROWS=500000   # demo database with more rows, up to 2,000,000
make run NO_OPEN=1                 # do not open a browser automatically
make help                          # full command list
```

## Database connections

Create connections from the in-app connection screen. Profiles are saved in `~/.tablepeek/store.json` without passwords; a saved password is stored in the operating system keychain (the default for new connections; pick "ask every time" to type it on each connect).

| Driver | Connect to | Notes |
|---|---|---|
| **SQLite** | Local file or in-memory demo | Saved connection profiles with a database path (native file dialog), quick open from the file picker, `--db`, or the built-in demo |
| **PostgreSQL** | PostgreSQL servers | `ssl_mode=disable/prefer/require`, CA certificates, mTLS client certificates |
| **MySQL** | MySQL and MariaDB | TLS `prefer`/`require`, CA certificates, mTLS client certificates |
| **CockroachDB** | CockroachDB clusters | PostgreSQL wire protocol; internal tables are excluded from schema browsing |
| **SQL Server** | Microsoft SQL Server | TDS driver with an `encrypt` option |
| **MongoDB** | MongoDB servers, replica sets and Atlas | `mongodb://` or `mongodb+srv://` connection string or host fields; SCRAM or X.509; TLS with CA and client certificates; tunnels for single-host connections only |

Connection features:

- **SSH tunnels.** Enable a tunnel and provide the SSH host, port, user, and key or password. Database host and port are resolved from the SSH server's point of view, for example `127.0.0.1:5432`.
- **Preflight checks.** The connection dialog verifies local certificate and SSH key paths before connecting.
- **Connection state.** Color-coded connection tabs, environment badges (`LOCAL`, `DEV`, `STAGE`, `PROD`), and live status indicators keep multiple environments easy to distinguish.

## A closer look

### The data grid

Filter with a bar of conditions: operators such as contains, starts with, in list, and between, or a raw `WHERE` fragment. Apply a condition on its own or every checked condition together with `AND`/`OR`. Sort by one or more columns, paginate, and jump across foreign keys. Column widths survive sorting, paging, and filtering, and a width you drag or double-click a column to is remembered per table: it comes back when the table is opened again, even after a restart. The grid's corner button fits every column to its contents again and forgets them.

Insert, duplicate, and delete rows; edit cells through primary-key-targeted updates; set a cell to `DEFAULT` or the current time and read back what the server stored; paste into a selection; and group changes in explicit transactions. The cell menu follows the selection: copy as CSV, JSON, SQL, or Markdown, or as a staged `INSERT`/`UPDATE`.

Type colors distinguish strings, integers, floats, bigints, booleans, JSON, lists, dates, binary, and `NULL`. Binary values show as hex and can be written back as bytes. PostgreSQL values print as PostgreSQL prints them. Colors are derived from the active theme, and custom `typeInks` overrides are supported.

### Import, export, dump, and restore

Export the current result as CSV, JSON, XML, or SQL `INSERT` statements. Import a CSV or JSON file into a new or existing table with column matching, type inference, and exact big numbers. Dump selected tables to a SQL file in foreign-key order, with or without data, and restore a dump statement by statement.

Every transfer runs as a background job: a jobs panel shows progress, a failed import or restore reports the statement it stopped at, and a stop button interrupts the statement in flight. A job holds its connection from its first statement, so the page's own queries and a running import never cancel each other. Imports roll back on failure where the engine allows it (MySQL runs `CREATE TABLE` outside the transaction and drops the table instead).

### Quick Look

Middle-click a cell, or press `Mod+Enter`, to open Quick Look. The drawer provides:

- A full-width value editor with primary-key saves and `NULL` support
- A collapsible JSON tree with path copying
- An encoding/HEX inspector
- For a foreign key, the referenced row, and the referenced table filtered to that key
- Copy actions for values, JSON paths, decoded text, and raw hex

![TablePeek Quick Look showing a JSON value as a tree beside its fields](docs/images/quick-look.png)

`Alt`-click opens the cell menu. `Space` opens row details with relationship tabs, including foreign-key navigation. The right panel keeps a field search and says when no row is selected.

### Query workbench

- CodeMirror 6 editor with IME-safe input and context-aware SQL completion: columns with their types, tables, `JOIN … ON` conditions from foreign keys (or guessed from names like `user_id`), common functions with signatures, statement templates with Tab-through fields, enum values inside strings, fuzzy matching (`usnm` → `user_name`), and an info panel beside the list; options you pick often rank first
- Query tabs, snippets, execution history, and favorites
- Command palette (`Mod+P`), new tab (`Mod+T`), close tab (`Mod+W`)
- Safe mode that asks for confirmation before `UPDATE`/`DELETE` without a `WHERE` clause
- Visual `EXPLAIN` / `EXPLAIN ANALYZE` plans with cost, estimated/actual rows, and raw JSON
- Query cancellation and live timing
- Chart and pivot views of any result or table: bar, line, area, pie/donut, and scatter charts with time bucketing and top-N grouping, and pivot tables with totals that copy as TSV

![TablePeek SQL completion suggesting joins from foreign keys, with ON conditions and an info panel](docs/images/completion.png)

![TablePeek chart view showing monthly order totals as a bar chart with a value tooltip](docs/images/chart.png)

### Schema and server tools

Browse tables, views, functions, triggers, and sequences from the sidebar, indented under their section heads; the tree refreshes after the editor creates, drops, or alters anything. Open Structure and DDL tabs, create tables, create or drop databases, and inspect generated SQL before applying it. MySQL tables expose collation, `ROW_FORMAT`, and comment options. Laravel `Schema::create` output can be copied directly from the table menu.

The server info tab shows engine version, database size, uptime, and sessions, with session termination where the engine supports it.

The ER diagram tab (the diagram button in the top bar, between the connections and settings buttons, or `Mod+P` → "ER diagram") draws every table with its columns and foreign keys, laid out automatically. Pan, zoom, drag cards (positions are remembered), search for a table, highlight a table's relations, show keys only, and double-click a table to open its data. A table's context menu in the sidebar opens the diagram centred on it.

![TablePeek ER diagram with the shop schema laid out and one table's relations highlighted](docs/images/er.png)

### MongoDB workbench

A MongoDB connection opens a document workspace: databases and collections in the sidebar, a collection tab per collection, and mongosh tabs. A collection tab has six sub-tabs:

- **Documents.** A filter bar with completion (you can leave out the outer braces), options for projection, sort, skip and limit, and recent and favourite queries. Results show as cards, as JSON blocks, or as a table; switch between them with the ☰ {} ⊞ icons or `Ctrl+1–3`. Click any value to edit it, keeping its BSON type. In the table, nested objects and arrays open as their own tables (`orders › items`), and the detail panel (`Mod+I`) is available there only. Saving puts each changed path's original value in the update filter. If the document changed elsewhere in the meantime, the current value and your change are shown side by side.
- **Aggregation.** A stack of stage cards, each with a preview of its output, an on/off toggle, and drag to reorder. There is also a text mode, saved pipelines, save as view, explain, and `$out`/`$merge` behind a confirmation.
- **Schema.** Analyses a sample of up to 1,000 documents: field presence, the mix of types, histograms, and frequent values. Clicking a value filters the documents by it.
- **Validation.** Edit a `$jsonSchema` or query rule, or draft one from the data. See how many sampled documents would pass or fail before applying it with `collMod`.
- **Indexes.** Lists each index with its size and usage (`$indexStats`), and creates or drops indexes.
- **Explain.** Runs `explain("executionStats")` and shows a stage tree, warnings, and a suggested index.

The mongosh tab parses a subset of mongosh and never runs JavaScript. Import reads JSON, NDJSON, Extended JSON, and CSV/TSV with a type for each column. Export writes JSON, NDJSON, or CSV, streamed from the server. Databases, collections (capped, time series, clustered), and views can be created, renamed, and dropped. The performance tab charts operations, connections, network, and cache use, lists the operations running now (and can kill them), and shows time per collection and the slow-operation profiler.

### Connections

The connection home groups saved connections; drag groups to reorder them. Start a new connection from the kind of database you want, or open one from the connection bar. A SQLite connection is saved like any other, with a name, colour, tags, and the database file; files are picked with the operating system's own open dialog, and the same file opened twice goes to the one connection already open. Connection tabs close on a single click and move focus to their neighbour. Saved connections export to a password-sealed `.tablepeek` file and import back on another machine.

### Settings and themes

Settings are organised by the part of the screen they change, each with its own live preview: General and Theme; SQL editor, Data table, and Sidebar; Import and export; Shortcuts; Activity log. The SQL editor, data table, and sidebar each pick their own font from every face installed on the machine. Scrollbars are the app's own: thin, one size under the pointer, and optionally always in view for the grid and editor.

Fifty built-in themes are included, grouped into dark and light: TablePeek Dark and Light plus Aura, Ayu, Catppuccin, Cobalt2, Dracula, Everforest, GitHub, Gruvbox, Horizon, Kanagawa, Material, Monokai, Night Owl, Nord, One Dark/Light, Panda, Pink Aura, Rosé Pine, Shades of Purple, Snazzy, Solarized, SynthWave '84, Tokyo Night, Tomorrow Night, and Xcode variants. The third-party themes also color the SQL editor while the syntax preset is left on "Theme default"; TablePeek Dark/Light and imported themes derive editor colors from their accent and status colors. You can also import Base16, VS Code, or TablePeek theme JSON from a Git URL.

![TablePeek data table settings with a color for each kind of value, a live preview, and the grid behind](docs/images/settings.png)

Settings also cover accent color, font sizes, alternating row backgrounds, type colors, CSV delimiter and encoding, SQL syntax presets, keyboard shortcuts, and activity-log retention. Both the SQL editor's syntax colors and the data table's colors for each kind of value (string, integer, decimal, big integer, boolean, date, time, JSON, array, enum, UUID, binary, NULL) can be picked per theme. The interface is available in English and Korean.

## MCP for AI clients

`tablepeek mcp` starts a stdio MCP server that connects to a running TablePeek instance. It exposes read-only schema and query tools without opening another port.

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

`TABLEPEEK_CONN` is optional; omit it to use the default connection.

| Tool | Purpose |
|---|---|
| `tablepeek_list_connections` | List active connections |
| `tablepeek_list_tables` | List tables and columns |
| `tablepeek_describe_table` | Columns, indexes, foreign keys, and DDL |
| `tablepeek_query` | Run read-only `SELECT`, `WITH`, `SHOW`, `DESCRIBE`, or `EXPLAIN` |
| `mongo_list_collections` | MongoDB: databases, collections, and views |
| `mongo_find` | MongoDB: `find` with a filter, projection, and sort (at most 100 documents) |
| `mongo_aggregate` | MongoDB: an aggregation pipeline without `$out`/`$merge` (at most 100 documents) |
| `mongo_schema` | MongoDB: field paths, presence, and types from a sample of up to 200 documents |
| `mongo_indexes` | MongoDB: a collection's indexes |

The tool list follows the engine of the connection the MCP server is pointed at.

`tablepeek_query` rejects multi-statement input and write statements. That guard is an accident-prevention filter, not a privilege boundary. Use a read-only database role if you need hard enforcement. Tokens and connection IDs change when the server restarts, so update the MCP configuration after a restart.

See [docs/MCP.md](docs/MCP.md) for setup details and security notes.

## Architecture

```mermaid
flowchart LR
  subgraph Machine["Your machine"]
    UI["Browser UI<br/>React · CodeMirror 6 · Canvas grid"]
    SERVER["tablepeek-server<br/>axum · static assets · auth"]
    ENGINE["tablepeek-engine<br/>connections · queries · Arrow IPC"]
    KEYCHAIN["OS keychain"]

    UI <-->|"HTTP + WebSocket<br/>Arrow IPC"| SERVER
    SERVER <--> ENGINE
    SERVER -.->|"passwords only when opted in"| KEYCHAIN
  end

  ENGINE --> SQLITE[("SQLite file")]
  ENGINE --> PG[("PostgreSQL")]
  ENGINE --> MYSQL[("MySQL / MariaDB")]
  ENGINE --> CRDB[("CockroachDB")]
  ENGINE --> MSSQL[("SQL Server")]
  ENGINE --> MONGO[("MongoDB")]
```

The server owns the loopback listener, authentication, WebSocket streaming, SSH tunnels, connection profiles, and embedded web assets. The engine owns drivers, sessions, query execution, cancellation, Arrow serialization, and row operations.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design and protocol notes.

## Security model

- **Loopback only.** The HTTP/WebSocket listener binds to `127.0.0.1`; there is no remote listener.
- **Per-run access token.** Each server start generates a token. The browser receives it in the launch URL and sends it with API requests as `x-tablepeek-token`.
- **Host header validation.** Requests with unexpected `Host` headers are rejected to mitigate DNS rebinding.
- **Credentials stay local.** `store.json` contains connection metadata and key paths, not passwords. Saved passwords live in the OS keychain (the default for new connections; choose "ask every time" per connection to keep none).
- **Encrypted exports.** Exported connections (`.tablepeek`) are sealed with a file password (Argon2id + AES-256-GCM). Saved passwords go in only when you tick "include saved passwords".
- **Encrypted connections.** PostgreSQL and CockroachDB support `disable`/`prefer`/`require` SSL modes plus CA and client certificates. MySQL supports TLS with CA and client certificates. SQL Server exposes an encryption toggle.
- **SSH without a relay.** Remote databases are reached through a local SSH tunnel, not a hosted proxy.
- **MCP is read-only by policy.** The query filter blocks writes, but a token holder can still read any database the active connection can see. Enforce stricter limits with database roles.

## Build and test

```sh
make build        # web bundle + Rust binary
make test         # Rust tests + TypeScript checks
make check        # formatting, Rust checks, TypeScript checks
make test-docker  # integration tests against Docker-backed databases
```

### Test databases

`testdb/compose.yml` runs throwaway PostgreSQL, MySQL, CockroachDB, SQL Server, and MongoDB servers in Docker, seeded with the rows the engine's live tests read. Start every engine, or only the ones `ENGINE` names:

```sh
make test-db ENGINE=postgres          # or ENGINE="mysql mssql"; all five when omitted
make test-live ENGINE=postgres        # the engine's live tests against them
make test-db-down ENGINE=postgres     # stop them and throw the data away
```

`make test-db` prints the host, port, and account for each one, so you can also add them as connections in TablePeek and try the app on a real server. Ports are bound to `127.0.0.1` only, and the accounts are test-only: never reuse them on a real server. MySQL listens on 3307; set `TABLEPEEK_TEST_MYSQL_PORT=3329` (for `make test-db` and `make test-live` alike) when that port is taken. SQL Server has no arm64 image, so on Apple Silicon it runs under emulation and takes a minute to start.

Beside the test rows, each server holds a sample shop to explore: the `shop` schema (on MySQL, the `shop` database). It has customers, products, orders, order items, reviews and more, about 28,000 rows in all. They are tied together by foreign keys: a self-reference, composite and text keys, CASCADE and SET NULL. There are also enums and JSON (on SQL Server, CHECK lists and JSON text), arrays where the engine has them, binary columns, a table without a primary key, and a table of awkward names and values (Korean, emoji, quotes, multi-line text, extreme numbers and dates). Two views, a function, a procedure and an audit trigger complete it. The `testdb/*-shop.sql` scripts build it. They never rebuild what is already there, and PostgreSQL and MySQL run theirs only when the container is first created. So after changing a script, or the sample's tables, run `make test-db-down` to start fresh.

Individual tools are available too:

```sh
cd web && npm run typecheck
cd web && npm run build
cargo check --workspace
cargo test
```

## Project layout

| Path | Contents |
|---|---|
| `crates/tablepeek` | CLI entry point and `serve` / `mcp` subcommands |
| `crates/tablepeek-server` | axum server, auth, static assets, WebSocket, SSH tunnels |
| `crates/tablepeek-engine` | Drivers, sessions, query execution, Arrow IPC, row operations |
| `crates/tablepeek-types` | Shared request, result, and connection types |
| `web` | React UI, CodeMirror editor, canvas grid, themes, i18n |
| `testdb` | Docker Compose test databases and their seed data |
| `docs` | Architecture, MCP, remaining scope, and manual checklists |

## Status

TablePeek is pre-release. The feature set is implemented and exercised across the five drivers, and the recent work has been on the everyday surface: filtering, transfer jobs, foreign-key Quick Look, connection management, schema-aware SQL completion, the ER diagram, chart and pivot views, fonts, scrollbars, and settings. Signed installers and package-manager distribution are still ahead; source builds are the supported path today.

See [docs/REMAINING-SCOPE.md](docs/REMAINING-SCOPE.md) for the current scope boundaries and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for design decisions and protocol details.
