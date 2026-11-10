# TablePeek user guide

- [Databases](#databases)
- [The data grid](#the-data-grid)
- [Import, export, dump, and restore](#import-export-dump-and-restore)
- [Quick Look](#quick-look)
- [Query workbench](#query-workbench)
- [Schema and server tools](#schema-and-server-tools)
- [MongoDB workbench](#mongodb-workbench)
- [Connections](#connections)
- [Settings and themes](#settings-and-themes)
- [Write SQL with AI](#write-sql-with-ai)
- [MCP for AI clients](#mcp-for-ai-clients)
- [Security](#security)

## Databases

Create connections from the in-app connection screen. Profiles are saved in `~/.tablepeek/store.json` without passwords. A saved password is stored in the operating system keychain (the default for new connections; pick "ask every time" to type it on each connect).

| Driver | Connect to | Notes |
|---|---|---|
| **SQLite** | Local file or in-memory demo | Saved connection profiles with a database path (native file dialog), quick open from the file picker, `--db`, or the built-in demo |
| **PostgreSQL** | PostgreSQL servers | `ssl_mode=disable/prefer/require`, CA certificates, mTLS client certificates |
| **MySQL** | MySQL and MariaDB | TLS `prefer`/`require`, CA certificates, mTLS client certificates |
| **CockroachDB** | CockroachDB clusters | PostgreSQL wire protocol; internal tables are excluded from schema browsing |
| **SQL Server** | Microsoft SQL Server | TDS driver with an `encrypt` option |
| **Oracle** | Oracle Database 12c and later (tested on 23ai Free) | Oracle's pure-Rust thin driver: no Instant Client. Service name, SID, Easy Connect, a `(DESCRIPTION=…)` or a tnsnames.ora alias; TCPS with a wallet (`ewallet.pem`); SYSDBA/SYSOPER; SSH/HTTP tunnels for host/port and for connect strings (each address of the descriptor through the tunnel). Schemas, synonyms, packages, materialized views and their DDL (DBMS_METADATA, kept until a structure change), PL/SQL blocks ended by `/`, DBMS_OUTPUT, EXPLAIN PLAN with DBMS_XPLAN, MERGE upserts on import, V$SESSION sessions ([details](engines/oracle.md)) |
| **MongoDB** | MongoDB servers, replica sets and Atlas | `mongodb://` or `mongodb+srv://` connection string or host fields; SCRAM, X.509, AWS IAM, LDAP, Kerberos, or OIDC (browser login or cloud identity); TLS with CA and client certificates; SSH/HTTP tunnels for single hosts, several hosts, and `mongodb+srv://` ([details](MONGODB.md)) |
| **Elasticsearch** | Elasticsearch 7–9 clusters and Elastic Cloud | URL, host fields, or Cloud ID; user and password, API key, or bearer token; TLS with a CA, a certificate fingerprint, client certificates, or no verification; SSH/HTTP tunnels. Query DSL, SQL, and a Dev Tools console ([details](engines/elasticsearch.md)) |
| **OpenSearch** | OpenSearch 1–3 clusters | The same driver and options (no Cloud ID); SQL through the SQL plugin |
| **ClickHouse** | ClickHouse servers and ClickHouse Cloud | HTTP interface (8123) or HTTPS (8443) with a CA file or no verification; SSH/HTTP tunnels. MergeTree tables edited by their sorting key, rows sharing a key told apart by `_part`/`_part_offset` (lightweight UPDATE where the table allows, else mutations), `ON CLUSTER` for structure changes, EXPLAIN plan view, native CSV/JSON export and CSV import ([details](engines/clickhouse.md)) |
| **Cassandra** | Apache Cassandra 3.11–5 clusters | CQL native protocol (9042); user and password, TLS with CA and client certificates; consistency level per connection (tab bar) or per statement (`CONSISTENCY`); SSH/HTTP tunnels to one node. Pages by the server's paging state, rows edited by their full primary key with IF EXISTS checks, tracing as the plan view ([details](engines/cassandra.md)) |
| **ScyllaDB** | ScyllaDB clusters and ScyllaDB Cloud | The same driver and options; server info names the product it reached |

Connection features:

- **SSH tunnels.** Enable a tunnel and provide the SSH host, port, user, and key or password. Database host and port are resolved from the SSH server's point of view, for example `127.0.0.1:5432`.
- **Preflight checks.** The connection dialog verifies local certificate and SSH key paths before connecting.
- **Connection state.** Color-coded connection tabs, environment badges (`LOCAL`, `DEV`, `STAGE`, `PROD`), and live status indicators keep multiple environments easy to tell apart. Waiting shows as a gauge: a connecting connection's row or tab fills with its color, and a query or table tab fills while its rows are on their way.

## The data grid

Filter with a bar of conditions: operators such as contains, starts with, in list, and between, or a raw `WHERE` fragment. Apply a condition on its own or every checked condition together with `AND`/`OR`. Sort by one or more columns, paginate, and jump across foreign keys. Column widths survive sorting, paging, and filtering. A width you drag or double-click a column to is remembered per table: it comes back when the table is opened again, even after a restart. The grid's corner button fits every column to its contents again and forgets them.

Reorder columns by dragging a header sideways: the column lifts and follows the pointer, the others slide aside to show where it will land, and the grid scrolls when you drag near its left or right edge. Release to drop it there, or press `Esc` to send it back. A short press still sorts (or selects the column in a query result), `⇧`-click keeps its meaning (a further sort column, or extending a column selection), and the header's edge still resizes. `⌥←`/`⌥→` moves the current cell's column one place. Staged edits, the selection, widths, and sorts stay with their columns, and copy, export, Quick Look, and the row detail panel follow the order shown. In a table tab the order becomes the tab's column order (the same one the Columns picker shows and sets), kept across paging and refreshes without reading the rows again; a query result keeps it until it is run again.

Insert, duplicate, and delete rows; edit cells through primary-key-targeted updates; set a cell to `DEFAULT` or the current time and read back what the server stored; paste into a selection; and group changes in explicit transactions. The cell menu follows the selection: copy as CSV, JSON, SQL, or Markdown, or as a staged `INSERT`/`UPDATE`.

Type colors distinguish strings, integers, floats, bigints, booleans, JSON, lists, dates, binary, and `NULL`. Binary values show as hex and can be written back as bytes. PostgreSQL values print as PostgreSQL prints them. Colors are derived from the active theme, and custom `typeInks` overrides are supported.

## Import, export, dump, and restore

Export the current result as CSV, JSON, XML, or SQL `INSERT` statements. Import a CSV or JSON file into a new or existing table with column matching, type inference, and exact big numbers. Dump selected tables to a SQL file in foreign-key order, with or without data, and restore a dump statement by statement.

Every transfer runs as a background job. A jobs panel shows progress, a failed import or restore reports the statement it stopped at, and a stop button interrupts the statement in flight. A job holds its connection from its first statement, so the page's own queries and a running import never cancel each other. Imports roll back on failure where the engine allows it (MySQL runs `CREATE TABLE` outside the transaction and drops the table instead).

## Quick Look

Middle-click a cell, or press `Mod+Enter`, to open Quick Look. The drawer provides:

- A full-width value editor with primary-key saves and `NULL` support
- A collapsible JSON tree with path copying
- An encoding/HEX inspector
- For a foreign key, the referenced row, and the referenced table filtered to that key
- Copy actions for values, JSON paths, decoded text, and raw hex
- **Expand** (or `Mod+Enter` again) for a JSON value: a window-filling view built for very large documents, with expand all, collapse all, and expand to a depth; search across keys and values (`Enter`/`Shift+Enter` step through matches); a breadcrumb with path and value copying; long strings shown in full; and a Raw view of the indented text. `Esc` returns to the drawer.

![TablePeek Quick Look showing a JSON value as a tree beside its fields](images/quick-look.png)

`Alt`-click opens the cell menu. `Space` opens row details with relationship tabs, including foreign-key navigation. The right panel keeps a field search and says when no row is selected.

## Query workbench

- CodeMirror 6 editor with IME-safe input and context-aware SQL completion: columns with their types, tables, `JOIN … ON` conditions from foreign keys (or guessed from names like `user_id`), common functions with signatures, statement templates with Tab-through fields, enum values inside strings, fuzzy matching (`usnm` → `user_name`), and an info panel beside the list. Options you pick often rank first.
- Query tabs, snippets, execution history, and favorites
- Command palette (`Mod+P`), new tab (`Mod+T`), close tab (`Mod+W`)
- Safe mode that asks for confirmation before `UPDATE`/`DELETE` without a `WHERE` clause
- Visual `EXPLAIN` / `EXPLAIN ANALYZE` plans with cost, estimated/actual rows, and raw JSON
- Query cancellation and live timing
- Chart and pivot views of any result or table: bar, line, area, pie/donut, and scatter charts with time bucketing and top-N grouping, and pivot tables with totals that copy as TSV

![TablePeek SQL completion suggesting joins from foreign keys, with ON conditions and an info panel](images/completion.png)

![TablePeek chart view showing monthly order totals as a bar chart with a value tooltip](images/chart.png)

## Schema and server tools

Browse tables, views, functions, triggers, and sequences from the sidebar, indented under their section heads; the tree refreshes after the editor creates, drops, or alters anything. Pick several tables to export, copy, truncate or drop them together: `Shift`-click picks a run, `Mod`-click adds or removes one, and `Mod+A` on a table picks every table the list shows (only the search's matches while you search). Open Structure and DDL tabs, create tables, create or drop databases, and inspect generated SQL before applying it. MySQL tables expose collation, `ROW_FORMAT`, and comment options. Laravel `Schema::create` output can be copied directly from the table menu.

The server info tab shows engine version, database size, uptime, and sessions, with session termination where the engine supports it.

The ER diagram tab draws every table with its columns and foreign keys, laid out automatically. Open it with the diagram button in the top bar (between the connections and settings buttons) or `Mod+P` → "ER diagram". Pan, zoom, drag cards (positions are remembered), search for a table, highlight a table's relations, show keys only, and double-click a table to open its data. A table's context menu in the sidebar opens the diagram centred on it.

![TablePeek ER diagram with the shop schema laid out and one table's relations highlighted](images/er.png)

## MongoDB workbench

A MongoDB connection opens a document workspace: databases and collections in the sidebar, a collection tab per collection, and mongosh tabs. A collection tab has seven sub-tabs:

- **Documents.** A filter bar with completion (you can leave out the outer braces), options for projection, sort, skip and limit, and recent and favourite queries. Results show as cards, as JSON blocks, or as a table; switch between them with the ☰ {} ⊞ icons or `Ctrl+1–3`. Click any value to edit it, keeping its BSON type. In the table, nested objects and arrays open as their own tables (`orders › items`), and the detail panel (`Mod+I`) is available there only. Saving puts each changed path's original value in the update filter. If the document changed elsewhere in the meantime, the current value and your change are shown side by side.
- **Aggregation.** A stack of stage cards, each with a preview of its output, an on/off toggle, and drag to reorder. There is also a text mode, saved pipelines, save as view, explain, and `$out`/`$merge` behind a confirmation.
- **Schema.** Analyses a sample of up to 1,000 documents: field presence, the mix of types, histograms, and frequent values. Clicking a value filters the documents by it.
- **Validation.** Edit a `$jsonSchema` or query rule, or draft one from the data. See how many sampled documents would pass or fail before applying it with `collMod`.
- **Indexes.** Lists each index with its size and usage (`$indexStats`), and creates or drops indexes.
- **Explain.** Runs `explain("executionStats")` and shows a stage tree, warnings, and a suggested index.
- **Changes.** Watches the collection through a change stream (a database-wide one from the sidebar), with operation filters and the document before and after.

The mongosh tab runs mongosh statements. Scripts with variables, loops, and functions run as JavaScript in a Web Worker, reading `find`/`aggregate` through server cursors. Import reads JSON, NDJSON, Extended JSON, and CSV/TSV with a type for each column. Export writes JSON, NDJSON, or CSV, streamed from the server. Databases, collections (capped, time series, clustered), and views can be created, renamed, and dropped. The performance tab charts operations, connections, network, and cache use, lists the operations running now (and can kill them), and shows time per collection and the slow-operation profiler.

The documents view also has query options (collation, hint, maxTimeMS), bulk update and delete with a before/after preview, and export of the query or pipeline as driver code (mongosh, Python, Node.js, Java, C#, Go, Rust, PHP, Ruby). The schema tab plots GeoJSON and `[lng, lat]` fields on an offline world map and turns a drawn region into a `$geoWithin` filter. The indexes tab manages Atlas Search and vector search indexes where the server has them, and GridFS buckets show in the sidebar with file listing, upload, download, and delete. Documents over 1 MB and arrays over 1,000 elements are cut short in the cards and JSON views, with "Show all".

## Connections

The connection home groups saved connections. Drag a connection to reorder it within its group or drop it at any spot in another group (onto a folded group's header to put it there), and drag groups to reorder them; the rows part to show where it will land, and `Esc` puts it back. With a connection or group header focused, `Alt+↑`/`Alt+↓` (`⌥↑`/`⌥↓`) move it one place. The order is remembered. Start a new connection from the kind of database you want, or open one from the connection bar. A SQLite connection is saved like any other, with a name, colour, tags, and the database file. Files are picked with the operating system's own open dialog, and the same file opened twice goes to the one connection already open. Connection tabs close on a single click and move focus to their neighbour. Saved connections export to a password-sealed `.tablepeek` file and import back on another machine.

## Settings and themes

Settings open as a sheet docked on the right (`Mod+,` or the gear button), with the app still visible beside it so every change shows live. The pages follow Tern's: General (language, updates, activity-log retention), Appearance (every font and color, in cards: Theme, Colors, Syntax colors with an editor preview, Value colors, Fonts, Material, Display), SQL Editor (keyword case), Data Table (maximum rows, query time limit), Import and export, Shortcuts, Security. Everything works from the keyboard: `↑`/`↓` move between settings (across cards), `←`/`→` switch pages, `Enter` or `Space` flips a switch, steps a choice or opens a menu or picker, `Backspace` resets a changed setting (marked with a dot), and `Esc` steps back (out of a field, clears the search, then closes). Drag the sheet's left edge, or press `←`/`→` on it, to resize it. Scrollbars are the app's own: thin, one size under the pointer, and optionally always in view for the grid and editor.

While Settings is open, Quick Look, dialogs, the command palette, toasts and banners stay in the app area left of the sheet, and follow its edge as it is resized; menus and pickers opened over the app stay left of it too.

**Live preview.** In the theme, font, font size and syntax preset menus, the option under the pointer or highlighted with `↑`/`↓` shows in the whole app right away (a light theme even while dark is shown, and the other way round), without being saved. A click or `Enter` saves it; closing the menu any other way (`Esc`, `Tab`, a click elsewhere, closing Settings) puts the saved look back. Previews stay in the window they are made in.

**Search.** Type anywhere in the sheet, or press `Mod+F`, to search every page. Matching settings are listed under their page's name with the match highlighted, in Korean or English whatever the interface language; a page's name offers that page (`Enter` opens it). `↑`/`↓` and `Enter` work on the results directly, and `Esc` clears the search.

**Motion.** Tabs, dialogs, menus, the settings sheet, panels, the schema tree, Quick Look, counts and dragged connections animate in one style, on springs. Settings › Appearance › Display › Reduce motion makes every change instant (the home backdrop becomes a still frame), at once and in every window; nothing in TablePeek waits for an animation. Only this setting decides: the operating system's Reduce motion preference is not followed.

**Theme.** Settings › Appearance › Mode is Light, Dark or System; System follows the operating system's light or dark mode as it changes (in the desktop app the window follows it too). The light and dark themes are picked separately, each in a small searchable picker (type to filter, `↑`/`↓`, `Enter` picks, `Esc` closes) with a swatch per theme. The accent follows the theme shown unless one is picked.

**Fonts.** Like Tern's, the fonts cascade; all of them are in Settings › Appearance › Fonts. Font and Font size set the interface (sidebars, menus, dialogs). Code font is the monospaced face the SQL editor, the data table and code labels use; its size follows Font size unless set. Editor font and Table font (and their sizes) follow the code font unless set apart. Every picker lists the system's faces and every face installed on the machine, monospaced ones first. Settings saved by earlier versions move over on first start: one theme becomes the theme of its mode, and the SQL editor's, data table's and sidebar's fonts become the code font, a table font where it differed, and the interface font where the sidebar's differed.

**Material.** Settings › Appearance sets the surface material: Solid, Glass (translucent, with an opacity), or Clear (blurred, with a blur radius). Quick Look (the popover and the large view), dialogs, menus and pickers, the command palette and the settings sheet turn to tinted glass at their own **Floating surface opacity** (90% by default, shown when the material isn't Solid), so they stay readable however see-through the window is. In the desktop app the window itself becomes see-through: macOS vibrancy or a blur without tint, Mica or Acrylic on Windows. The picked material alone decides; the system's Reduce transparency setting is not followed (pick Solid for opaque surfaces).

Fifty-two built-in themes are included: TablePeek Dark and Light, Dark Noir and Light Noir, plus Aura, Ayu, Catppuccin, Cobalt2, Dracula, Everforest, GitHub, Gruvbox, Horizon, Kanagawa, Material, Monokai, Night Owl, Nord, One Dark/Light, Panda, Pink Aura, Rosé Pine, Shades of Purple, Snazzy, Solarized, SynthWave '84, Tokyo Night, Tomorrow Night, and Xcode variants. The third-party themes also color the SQL editor while the syntax preset is left on "Theme default"; TablePeek Dark/Light derive editor colors from their accent and status colors. Dark Noir is the look of a Tern terminal theme (Dracula-style surfaces, a vivid 16-color table, a teal accent); Light Noir keeps its hues, darkened so every text color reads at 4.5:1 or better.

**Tern themes.** The theme pickers' Tern group holds the 102 themes of the Tern terminal (oh-my-pi's theme set: `dark`, `light`, and 100 more, MIT-licensed), converted at build time and loaded only when Settings opens or one of them is in use. "Import Tern theme…" at the end of either picker takes a Tern theme CSS (`~/Library/Application Support/Tern/themes/*.css`): its `@import`ed theme with the file's `--tv-bg`, `--tv-fg`, `--ansi0`…`--ansi15` and surface variables (`--tn-page`, `--card`, `--raise`, `--code-bg`, `--tn-pop`) over it, named after the file; other rules (tab and window styling) are skipped. It becomes the theme of its mode. Imported themes are listed under "Imported" in the picker and can be removed there (the × on the entry, or `Mod+Backspace`).

**Color table.** Settings › Appearance shows the color table of the theme shown: background, foreground, and the 16 terminal colors (for a theme not made from one, read from its own colors). The syntax and value colors map to its slots (green strings, yellow numbers, magenta keywords and booleans, cyan functions and dates, blue types and JSON, bright black comments and `NULL`, and so on), so picking a swatch recolors every part mapped to that slot; colors are adjusted where needed to stay readable on the background. Picks are saved per theme. In the settings sheet the table is one row: `Enter` goes into it, the arrow keys move between swatches, `Enter` opens the color picker, and `Backspace` puts a swatch back to the theme's color (on the row, all of them).

![TablePeek settings docked on the right beside the grid](images/settings.png)

Settings also cover alternating row backgrounds, type colors, the maximum rows and query time limit, CSV delimiter and encoding, SQL syntax presets, keyboard shortcuts, and activity-log retention. Both the SQL editor's syntax colors (Appearance › Syntax colors) and the data table's colors for each kind of value (Appearance › Value colors: string, integer, decimal, big integer, boolean, date, time, JSON, array, enum, UUID, binary, NULL) can be picked per theme. The interface is available in English and Korean.

Settings, workspaces, and other UI state are kept in `~/.tablepeek/ui-state.json`, so they survive restarts and are shared by the desktop app and `tablepeek serve`.

## Write SQL with AI

Describe a query in words and TablePeek writes the SQL for the connection in front, using your own model. It is off until you turn it on in Settings › AI; while off, nothing of it shows and nothing is sent anywhere.

**Model and connections.** Settings › AI has one **Model** picker and, below it, the ways to reach each model family, grouped by family; each way is a connection of its own, set up and shown on its own row. The picker lists the models of every connection ready to use, read from it and grouped by it ("GPT · ChatGPT", "GPT · Codex CLI", "Claude · Claude Code", "Gemini · API key"); type to filter, or **Enter a model…** for one that isn't listed. The pick is shown as `model · connection` (`Haiku · Claude Code`, `gemini-3-flash-preview · Gemini`), also in the editor's AI box, where the same picker opens.

| Family | Connection | What it needs |
|---|---|---|
| GPT · OpenAI | ChatGPT sign-in | **Continue with ChatGPT**; requests use your ChatGPT Go, Plus or Pro plan |
| | Codex CLI | The `codex` command installed (`npm i -g @openai/codex` or `brew install codex`) and signed in from a terminal (`codex login`). The answer arrives all at once, after about 6 s |
| | API key | Coming soon |
| Claude · Anthropic | Claude Code CLI | The `claude` command installed (`curl -fsSL https://claude.ai/install.sh \| bash`) and signed in from a terminal (run `claude`, then `/login`). The answer streams in, starting after about 5 s |
| | API key | Coming soon |
| Gemini · Google | API key | A key from Google AI Studio (**Get an API key**), kept in the OS keychain and never shown again; **Replace key** and **Delete** change it |
| Other | OpenRouter · Ollama · LM Studio | Coming soon |

Every connection row reads the same way: its name and state (● Connected, ○ Sign-in needed, ○ Not installed; for Gemini ● Key saved or ○ No key) with its one action at the right, then what it can do: ✓ Write SQL (with a CLI's wait) and ✓ or ✕ Suggest as you type (a CLI takes seconds per answer, so only ChatGPT and Gemini suggest). A CLI that isn't installed or signed in shows the exact terminal command with a **Copy** button instead; **Check again** looks once more after you have run it. Requests run your own CLI on its own plan; TablePeek stores no key or sign-in for it. Gemini's free tier has daily request limits, and Google may use free-tier requests to improve its models (**Free tier terms**). A model saved from a connection that is coming soon shows as unavailable, in Settings and in the AI box, until you pick one from a connection you can use.

**Account and limits.** Each connected row shows the account it is signed in with on one line, `email · plan · workspace` ("Team · Research Factory", "Claude Max"; a workspace that is just the email's own organization is left out); a Gemini key just says it is saved. How much is used has a section of its own, **Usage**, right under the model pickers: a row per connected connection ("GPT · Codex CLI", "Claude · Claude Code", "Gemini · API key", "GPT · ChatGPT") with, for each usage window, a thin bar (amber from 80 %, red at the limit) and when it resets: "5-hour limit 66% used · resets in 1 h 52 min". The Codex CLI's comes live from the CLI (no model call); Claude Code's is as of its last answer ("As of the last answer · 3 min ago"), and shows nothing until it has answered once; ChatGPT's comes from its answers. Google doesn't report what is left of a Gemini key, so its row counts the requests TablePeek sent today per model (Google's day starts at midnight US Pacific) and shows the last limit Google reported, with a daily bar when that limit is per day. It is read when Settings › AI opens, after each answer, and with the section's **Refresh**, never on a timer. The AI box shows what is left of the active connection's most urgent window beside the model ("5-hour 34% left", full lines in its tooltip), and the model picker's headers say what is left ("GPT · Codex CLI — 5-hour 34% left").

**ChatGPT subscription.** **Continue with ChatGPT** opens OpenAI's sign-in in the browser (the desktop app uses the system browser). The first time, OpenAI asks you to name and allow TablePeek and to let it use your plan; then the browser comes back to TablePeek and the page shows the account. The model list is your account's. Requests count toward your plan's usage (on Plus, the five-hour limit is shared with every app using it); **Manage usage** opens ChatGPT's usage settings, where you can cap TablePeek's share or disconnect it. When the limit is reached, the AI box says so and links there. **Sign out** asks OpenAI to end the session and clears it here; **Sign in with another account** switches to a different ChatGPT account. If you abandon the sign-in page, **Cancel** stops waiting. A ChatGPT Business or Enterprise workspace may refuse the sign-in (`3p_delegated_access_policy_denied`) unless its admin allows it; then use the Codex CLI, Claude Code CLI or a Gemini API key. A Claude subscription works through the Claude Code CLI, not a sign-in here.

**Writing.** In a SQL query tab, press `Mod+E`, click **AI** under the editor, or pick "Write SQL with AI" in the command palette. A small box opens in the editor, at the cursor's line, with the focus in its field. Type the request in any language and press `Enter`; a Korean (or other IME) syllable still being composed counts, so one `Enter` sends it. The SQL is written straight into the editor as it streams, highlighted as a pending change with a bar in the gutter: over the selection when SQL is selected ("add a date filter", "join the customer names"; the box says it will change the selected SQL), over the cursor's line when that line is blank, else on new lines below it. Each statement comes under a `--` line summing up what it does, in the request's language; changing SQL rewrites that line rather than adding another. Nothing is ever run for you.

- **Accept**: `Tab` or `Mod+Enter` (in the box or in the editor). The text stays, the highlight goes and the cursor lands after it; one `Mod+Z` takes the whole change back.
- **Reject**: `Esc`. The text and selection are put back exactly as they were.
- **Follow up**: type another request in the box and press `Enter`; it rewrites the pending SQL ("only the names", "sort by date"). **Regenerate** asks the last request again.

An answer that may change data (anything but a single read) is marked as such. The box keeps the keyboard: `Shift+Tab` from its field reaches its buttons (each names its shortcut) and `Tab` cycles back; progress, the finished answer and errors are announced to screen readers. Switching tabs keeps a finished change and drops one still streaming.

**Waiting.** Until the SQL starts to come, the box says what is happening: reading the connection's schema (kept for two minutes, so the next request skips it), then waiting on the model, with the seconds so far. When the answer is in, it shows where the time went: schema, first reply and total. With the Codex CLI nothing comes until the answer is complete: the box keeps counting the seconds, then writes it at once. A long wait before the first reply is the model thinking; pick a faster model, or a smaller one of the same family. **Stop** puts back what was there before.

**Suggestions as you type.** Turn on **Suggest as you type** in Settings › AI. Each time you pause typing (about 0.4 s) with the cursor at the end of a line, the SQL that could come next shows in gray after the cursor: `Tab` inserts it, `Mod+→` takes its next word, `Esc` dismisses it, and typing what it says uses it up (anything else dismisses it). Write a request as a comment (`-- customers who ordered twice`) and press `Enter` to get a whole statement on the next line. Each pause sends the schema and up to 6,000 characters before the cursor and 2,000 after it to the provider: one request per pause, which adds to usage and cost. Suggestions need the ChatGPT sign-in or a Gemini API key: a CLI takes seconds per answer, so the switch stays off until one of them is connected. **Autocomplete model** picks the ChatGPT or Gemini model for this (default: the main model, when that is one of them); a fast one is best: GPT mini, or a Flash-Lite-class Gemini model (about a second per answer). Failures stay out of the editor: the AI button's dot turns amber and a short note beside it says why; when only Settings can fix it (suggestions or AI off, no model, signed out, a usage limit, a CLI model picked for suggestions), suggestions stop until the AI settings change.

**What is sent.** The engine's name, the connection's schema (table and column names, types, primary keys, NOT NULL, foreign keys), your request and the selected SQL, or for suggestions the text around the cursor. Row data is never sent. A large schema is cut to about 48,000 characters (24,000 for suggestions): the tables the request names come first with their foreign-key neighbours, and the rest are listed by name only. The request goes from the TablePeek server on your machine straight to the provider, or to the CLI you picked, which sends it; ChatGPT's tokens and the API key never reach the page.

Works with every SQL engine (SQLite, PostgreSQL, MySQL/MariaDB, CockroachDB, SQL Server, Oracle, ClickHouse, Cassandra and ScyllaDB in CQL). MongoDB and Elasticsearch/OpenSearch workbenches don't offer it.

## MCP for AI clients

`tablepeek mcp` starts a stdio MCP server that connects to a running TablePeek instance. It exposes read-only schema and query tools without opening another port. Point it at a `tablepeek serve` started with a fixed port; the desktop app's port and token are not shown ([why](INSTALL.md#mcp-and-the-desktop-app)).

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
| `search_list_indices` | Elasticsearch/OpenSearch: indices with health, document counts, sizes, aliases, and data streams |
| `search_mapping` | Elasticsearch/OpenSearch: an index's mapping |
| `search_query` | Elasticsearch/OpenSearch: a Query DSL search with sort, `_source`, and aggregations (at most 100 hits) |
| `search_sql` | Elasticsearch/OpenSearch: a read-only SQL query |

The tool list follows the engine of the connection the MCP server is pointed at.

`tablepeek_query` rejects multi-statement input and write statements. That guard is an accident-prevention filter, not a privilege boundary; use a read-only database role if you need hard enforcement. Tokens and connection IDs change when the server restarts, so update the MCP configuration after a restart.

See [MCP.md](MCP.md) for setup details and security notes.

## Security

- **Loopback only.** The HTTP/WebSocket listener binds to `127.0.0.1`; there is no remote listener.
- **Per-run access token.** Each server start generates a token. The browser receives it in the launch URL and sends it with API requests as `x-tablepeek-token`.
- **Host header validation.** Requests with unexpected `Host` headers are rejected to mitigate DNS rebinding. Pages opened as `localhost:<port>` are redirected to `127.0.0.1:<port>`; API calls are answered under either name.
- **Credentials stay local.** `store.json` contains connection metadata and key paths, not passwords. Saved passwords live in the OS keychain (the default for new connections; choose "ask every time" per connection to keep none).
- **Encrypted exports.** Exported connections (`.tablepeek`) are sealed with a file password (Argon2id + AES-256-GCM). Saved passwords go in only when you tick "include saved passwords".
- **Encrypted connections.** PostgreSQL and CockroachDB support `disable`/`prefer`/`require` SSL modes plus CA and client certificates. MySQL supports TLS with CA and client certificates. SQL Server exposes an encryption toggle.
- **SSH without a relay.** Remote databases are reached through a local SSH tunnel, not a hosted proxy.
- **The desktop app exposes no native API to the page.** Links to other sites open in the system browser; downloads go to the Downloads folder.
- **MCP is read-only by policy.** The query filter blocks writes, but a token holder can still read any database the active connection can see. Enforce stricter limits with database roles.
- **Write SQL with AI is opt-in.** Off by default. When on, the schema (never rows) goes to the provider you chose, from your machine, with your request and selected SQL; **Suggest as you type** is a second opt-in that also sends the SQL around the cursor on each pause. With Codex CLI or Claude Code CLI, TablePeek runs the `codex` or `claude` installed on your machine and the CLI sends the request with its own sign-in, which TablePeek doesn't store. The Gemini API key lives in the OS keychain (`ai:gemini`), the other AI settings in `~/.tablepeek/ai.json`.
- **ChatGPT sign-in.** OpenAI sends the browser back to `http://127.0.0.1:<port>/auth/callback`, which accepts only a login TablePeek started (its one-time `state`); the code is exchanged with PKCE and the ID token's signature, issuer, audience and nonce are checked. The tokens are kept in `~/.tablepeek/chatgpt.json`, readable by you only (`0600`), as OpenAI's guide for local apps asks: the refresh token changes on every renewal, about hourly while in use. They never reach the page.
