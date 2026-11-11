# Changelog

All notable changes to TablePeek are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html): while TablePeek is at 0.x, new features raise the minor version and fixes raise the patch version.

## [Unreleased]

## [0.7.1] - 2026-11-11

A photograph as the built-in background picture.

### Changed

- **Built-in background picture.** Settings › Appearance › Background picture now offers a photograph, snowy peaks under a starry pink sky (from Unsplash), beside None and a picture of your own, in place of 0.7.0's drawn table floor; a window that had the drawn one shows the photograph.

## [0.7.0] - 2026-11-11

A built-in background picture in the theme's colours, and an opacity of their own for every part of the window over it.

### Added

- **Built-in background picture.** Settings › Appearance › Background picture › **Built-in** draws the home screen's table floor under a night sky (a daytime one on a light theme) in the theme's own colours, and follows the theme.
- **Opacity by area.** Over a background picture or in a see-through window, the top bars, the left sidebar, the right sidebar, the console below and the results' toolbars each lay as much of their own colour over the page as you set, and the floating surfaces, the settings sheet and notices each have their own opacity. The floating surfaces turn to glass over a background picture whatever the material.

### Changed

- Over a background picture or in a see-through window, the sidebars, the console, the top bars and the toolbars no longer lay a layer of their own over the page by default, so they run on from the editor and the table with no edge between them, as Tern's panes do; **Opacity by area** brings an edge back.

## [0.6.0] - 2026-11-11

A picture behind the app, an editor and grid that no longer darken over it or in a see-through window, and Apple silicon only on macOS.

### Added

- **Background picture.** Settings › Appearance › Background picture lays a picture (PNG, JPEG, GIF, WebP) behind the app, with how it fits (fill, fit whole, tile), how opaque the app's surfaces are over it and how much it is blurred. Every window, the browser's and the desktop app's, shows the same one.

### Removed

- **Intel Macs are no longer supported.** 0.5.0 is the last release with an Intel Mac app and command-line binary; the Homebrew cask installs on Apple silicon only.

### Fixed

- In a see-through desktop window (Glass or Clear material) the SQL editor, its gutter and the results grid painted the window's translucent background two or three times over, so they came out darker than the rest of the page; they now lie on the page's background once, as the results' empty area does.

## [0.5.0] - 2026-11-11

Backups and restores run on the server: every row of every table, binary values whole, and restores in one transaction several times faster.

### Added

- **Restore in one transaction.** The restore window's **Run in one transaction** commits once at the end instead of after every statement, so a dump of single-row `INSERT`s restores several times faster (200,000 into SQLite: 7.5 s instead of 48 s), and a failure or a stop rolls the whole restore back. MySQL, MariaDB and Oracle still commit at each DDL statement, so only what follows the last one rolls back there. A file with its own `BEGIN`, `COMMIT` or `ROLLBACK` stops at that statement in this mode. Not offered on engines without transactions.

### Changed

- **Backups and restores run on the server.** A backup no longer stops at 200,000 rows per table: the TablePeek server reads each table in one pass straight from the database, instead of the page reading it 5,000 rows at a time by `OFFSET`, and writes the `INSERT`s into a download while it reads, so every row of every table is included, memory stays flat however large the tables are, and a backup can be stopped from its window or the jobs panel. A restore sends its file to the server once; the server splits it with the same rules as the editor and runs each statement while the rest of the file is still arriving, instead of the page sending one request per statement.

### Fixed

- Backups wrote a binary value over 16 KB as the text `<blob N bytes>` the grid shows in its place, so restoring the backup lost those bytes. A backup now writes every binary value whole, on every engine.

## [0.4.0] - 2026-11-10

Write SQL with AI from your own ChatGPT subscription, Codex CLI or Gemini API key; restore SQL dumps of any size; floating surfaces that never show the grid through their text; and TablePeek is now free software under the AGPL-3.0.

### Added

- **Write SQL with AI, using your own model.** Off until turned on in Settings › AI, which has one model picker across the connections ready to use, as `model · connection`, and below it the connections grouped by model family, each set up on its own: for GPT, your **ChatGPT subscription** (**Continue with ChatGPT** signs in through OpenAI, no API key; requests count toward your Go, Plus or Pro plan, with **Manage usage**, sign-out and account switching), or the **Codex CLI** installed and signed in from a terminal on your machine, on its own plan (each row says whether it is connected and what it can do, or shows the exact command to run with **Copy** and **Check again**; TablePeek stores nothing for it); its answers arrive all at once after about 6 s. For Gemini, an **API key** from Google AI Studio (kept in the OS keychain, never shown again; replace or delete it), with a note on the free tier's daily limits and data use. Each connected row shows the email it is signed in with, then its plan and workspace; a **Usage** section shows how much of each connection's limits is used, with a bar and when it resets (Codex live from the CLI, ChatGPT from its answers, Gemini counted by TablePeek since Google doesn't report it), and the AI box and the model picker show what is left of the most urgent one. An Anthropic API key (for Claude), an OpenAI API key, OpenRouter, Ollama and LM Studio are listed as coming soon. Each provider's models are read from the provider, searchable, with room to enter one that isn't listed. In a SQL query tab, `Mod+E`, the **AI** button under the editor or the command palette opens a small box in the editor at the cursor (Cursor-style inline edit), which shows the model and switches it: describe the query in any language and the SQL streams straight into the editor as a highlighted pending change, over the selection or on new lines, each statement under a `--` line summing up what it does. `Tab` or `Mod+Enter` accepts it (one `Mod+Z` undoes all of it), `Esc` puts the text and selection back exactly, and a follow-up request rewrites it; nothing is run. While it waits the box says whether it is reading the schema or waiting on the model, with the seconds so far, and afterwards where the time went (schema, first reply, total); the schema is reused for two minutes, and Gemini's thinking models are asked for low reasoning effort. Answers that may change data are marked (each statement is checked, so several reads are not). A provider's request limit is told in a line (which model's limit, per day or free tier when the provider says, and when it works again), with what to do and the provider's full text under Details. **Suggest as you type** (a second opt-in) shows gray ghost text after a pause at the end of a line, from its own **Autocomplete model**, a ChatGPT or Gemini one (a CLI takes seconds per answer; a Flash-Lite-class Gemini model answers in about a second): `Tab` inserts it, `Mod+→` takes a word, `Esc` dismisses it, and a `-- request` comment followed by `Enter` brings a whole statement; failures show quietly by the AI button. Enter, `Mod+Enter`, `Mod+E` and running pressed while a Korean syllable is still being composed now act once it is committed instead of being dropped. The box is keyboard-only friendly and announced to screen readers. Only the schema (names, types, keys, foreign keys), the request and the selected SQL (with suggestions, the text around the cursor) go to the provider, never rows. Works with every SQL engine, CQL included.
- **Pick every table with `Mod+A`.** With a table focused in the sidebar, `Mod+A` picks all the tables the list shows (just the search's matches while searching) for exporting, copying, truncating or dropping together, instead of selecting the page's text.
- **License: AGPL-3.0.** TablePeek is now free software under the GNU Affero General Public License, version 3 only; the license text ships in the release archives.

### Fixed

- Switches in Settings showed no knob while off, only an empty grey track; the knob now sits on the left when off and slides right when on.
- Floating surfaces no longer show what is under them through their text. In the desktop app's see-through window, error toasts, the error strip over a result, tooltips, the sidebar's table card, the staged-edits bar, the in-grid editor, the lock screen and sticky table headers took the window's opacity, so the grid or the desktop showed through; they now keep the theme's opaque colours. With the glass or clear material, menus, lists, dialogs, Quick Look and the settings sheet stay at least 60% opaque over their blur, and are opaque where nothing is blurred (clear with less than 8 px of blur, or one inside another, like the panel beside the SQL completion list or a menu in the settings sheet); toasts and banners turn to glass too and keep their red or yellow tint.
- In the panel beside the SQL completion list, longer labels ("References", "Referenced by" in English) ran into their values or broke over two lines; the label column now takes the width of the longest label.
- Restoring a large SQL dump failed: a multi-gigabyte file stopped at once with "The I/O read operation failed.", and a statement over 2 MB (a dump's multi-row `INSERT`) with "HTTP 413". A restore now reads its file a piece at a time and runs each statement as it is split off, so any size works (a 5.3 GB dump splits with under 100 MB of memory), statements of any length reach the database, and progress shows statements run and bytes read. Queries run from the editor have no 2 MB limit either.
- The restore window's preview of the file is now shown in the editor's colours, with line numbers.

## [0.3.4] - 2026-11-05

### Added

- **Reorder columns by dragging their headers**, as in TablePlus. Drag a header sideways and the column lifts and follows the pointer while the others slide aside to show where it lands; the grid scrolls near its edges, release drops it, `Esc` sends it back. A short press still sorts or selects and the header's edge still resizes. `⌥←`/`⌥→` moves the current column one place. Staged edits, the selection, widths and sorts stay with their columns, and copy, export, Quick Look and the row detail panel follow the new order. A table tab keeps the order as its column order (shown in the Columns picker) across paging and refreshes without reading the rows again; a query result keeps it until it runs again. Reduce motion makes the moves instant.

## [0.3.3] - 2026-11-05

### Changed

- **⌘R refreshes in the desktop app**, as in TablePlus: the schema is read again and the table in front reloads (F5 still works). A browser tab keeps ⌘R for reloading the page unless you bind it in Settings › Shortcuts. Shortcuts are now saved as the ones you changed only, so a Refresh you never changed follows each place's default; a Refresh left at the old default picks up ⌘R in the app once.
- **The row detail panel (⌘I) colors values by type** like the data grid: numbers, booleans, dates, times, UUIDs, binary and enums in their type colors, JSON objects and arrays token by token, and NULL in the grid's NULL color. With "Color by type" off, values read plain. The MongoDB table view's shared values for several selected rows are colored the same way.

### Fixed

- Refreshing a MongoDB or Elasticsearch collection whose cards hold unsaved edits (F5, ⌘R in the app, or the footer's refresh button) now asks before discarding them; Cancel keeps the edits and the page, Discard drops them and reloads. Before, the reload kept the drafts over the documents read again.
- Moving through a table with the keyboard highlights the current cell's row; before, the highlight stayed on the row under the mouse pointer.

## [0.3.2] - 2026-11-04

### Fixed

- The update status in Settings › General no longer breaks in a narrow sheet: with a release downloaded, its text broke after every word and Check now spilled out of the card. The buttons now move to a line of their own, right-aligned, when they don't fit beside the text.

## [0.3.1] - 2026-11-04

### Added

- **Floating surface opacity** (Settings → Appearance → Material, 90% by default, shown when the material isn't Solid; searchable as "floating"). It sets how opaque Quick Look, dialogs, the command palette, menus and pickers and the settings sheet are, apart from the window's opacity, and applies live as the slider moves.

### Fixed

- **Quick Look stays readable under Glass and Clear.** Its large view wasn't one of the glass surfaces, so in a see-through window it took the window's opacity with no blur (at a low opacity, all but invisible), and its popover's glass grew fainter as the window's opacity went down. Both now use the floating surface opacity with the glass blur, the date picker too.
- **Quick Look and the settings sheet no longer overlap.** With Settings open, the Quick Look popover is placed within the app area left of the sheet (pointing at its cell when there is room), the large view fills that area only, and both follow the sheet's edge as it is resized; clicking the sheet no longer closes Quick Look. Dialogs, the command palette, error toasts, flash notes and the sign-in and file-dialog banners keep to the same area, and menus, pickers and tooltips opened over the app stay left of the sheet.
- ⌘, opens and closes Settings with Quick Look open too.

## [0.3.0] - 2026-11-04

Loading shows as gauges that fill the box that waits, and Reduce motion becomes a TablePeek setting that no system preference overrides.

### Added

- **Reduce motion setting** (Settings → Appearance → Display, off by default). On, every transition and animation is instant: tabs, dialogs, menus, home drag and drop, the schema tree, counts, and the home backdrop as a still frame; turning it on or off applies at once in every window.

### Changed

- **Motion and transparency follow TablePeek's settings only.** The system's "Reduce motion" no longer changes anything; use the new Reduce motion setting. The system's "Reduce transparency" no longer forces Solid: the Material setting alone decides. The desktop app no longer reads it, and `GET /api/window` no longer returns `reducedTransparency`.
- **Loading shows as a gauge filling the box that waits, instead of a spinner.** A saved connection's row on home fills with the connection's color while it connects. A working tab is a gauge of its own color: an open connection's tab in the top bar while it reconnects or is entered, a query tab, a table tab while its rows load and MongoDB/Elasticsearch tabs while they run empty their highlight and fill back up in it from the left, background tabs included (an Elasticsearch console request answered 4xx or 5xx ends as an error). Buttons that wait (Apply changes, dialog buttons, refresh and delete), the "Running…" pill over results, the table count and a step-by-step page walk or count (with its real progress) fill the same way. Without known progress the gauge eases toward 90% and keeps creeping with a glint at its edge; it races to full on success, flashes red and drains on an error, and drains on a cancel. Under Reduce motion a busy box is half tinted, without movement.

## [0.2.0] - 2026-11-04

A desktop app for macOS and Windows (also through Homebrew) that updates itself, settings rebuilt the way Tern does them, Tern's themes and color tables, a large JSON explorer, live setting previews, and motion throughout.

### Added

- **Desktop app for macOS and Windows** (`crates/tablepeek-desktop`, Tauri 2). It starts the same server inside the app on a free port with the same `~/.tablepeek` settings folder, and shows it in native windows: links to other sites open in the system browser, "Open in new window" opens another app window, exports and GridFS downloads go to the Downloads folder (numbered when the name is taken), and file drops reach the page. On macOS ⌘W, ⌘T, ⌘N and ⌘R stay with the page (Close Window is ⇧⌘W). Release builds are ad-hoc signed on macOS and unsigned on Windows; [docs/INSTALL.md](docs/INSTALL.md) covers the first launch.
- **The desktop app updates itself.** When the update check finds a newer release (and checks are on and the release isn't skipped), the app downloads it in the background and checks its updater signature, with no click. Once it is ready, a **Restart to update** pill arrives in the top bar and on the home screen with a wash of color (it just appears with reduced motion); hovering shows the version, a click installs it and relaunches, a failure shows beside the pill and clicking tries again, and right-clicking offers the release notes or skipping the version. Settings > General shows the same state (downloading with its percent, downloaded) with **Check now** and the same button. The app looks again every hour while it stays open (GitHub is still asked at most once a day), keeps a release already downloaded, and replaces it when a newer one appears. `GET /api/update` reports `installable` and `install` (`idle`, `checking`, `downloading`, `ready`, `installing`, `error`); `POST /api/update/install` installs the downloaded release, and `/api/version` reports the desktop build as `dist: "desktop"`.
- Releases also publish `TablePeek-<tag>-<target>.dmg` (macOS arm64, x64), `TablePeek-<tag>-x86_64-pc-windows-msvc-setup.exe`, the updater bundles with their `.sig` signatures, and `latest.json` for the updater. `make desktop` runs the app from source and `make desktop-bundle` bundles it.
- **Homebrew cask for the desktop app**: `brew install --cask extransload/tap/tablepeek`. Each stable release updates it in [Extransload/homebrew-tap](https://github.com/Extransload/homebrew-tap); it clears the download quarantine so the unsigned app opens without a Gatekeeper prompt.
- **Reorder connections on the home screen** by dragging them within a group, or into another group at a chosen spot, the top of the list included; groups reorder the same way, and ⌥↑/⌥↓ move the focused connection or group. The order is kept in `~/.tablepeek/ui-state.json` and the connection picker follows it. Previously a dropped connection took its place by last use, so it could not be put at the top.
- **Large view for JSON in Quick Look.** "Expand" (⌘↩ in the cell popover) opens the value filling the window: a tree that stays responsive with hundreds of thousands of nodes (expand all, collapse all, expand to depth 1–5 or press 1–9), search across keys and values with a match count and ↩/⇧↩ to step through, a breadcrumb with Copy path and Copy value, long strings shown in full, and a Raw view that indents the stored text without rounding big numbers. Esc goes back to the popover. Works for JSON/JSONB columns and MongoDB documents.
- **Window material: Solid, Glass or Clear** (Settings → Appearance), with an opacity and, for Clear, a blur radius. Dialogs, the command palette, menus, pickers and the settings sheet turn to tinted glass over the app. In the desktop app the window itself becomes see-through: macOS vibrancy for Glass, the desktop blurred without the system tint for Clear (Windows: Mica and Acrylic). The page asks for it through `GET/PUT /api/window`; a browser tab reports that its window can't be see-through. Every open window and tab follows a material (or any other setting) changed in another. The system's "Reduce transparency" makes every material solid; on macOS the desktop app reads it itself (WebKit doesn't report it to the page) and `GET /api/window` passes it on as `reducedTransparency`.
- **An animated home.** Behind the connection home a table runs as a floor to the horizon, its rows flowing toward you in the theme's type colors; the pointer is a lens that lifts the cells under it and shows their values, and a click sends a ripple out. First run gets the full show (the wordmark's "Peek" peeks up, the actions rise in turn, the New connection button leans toward the pointer); the connection list gets a dimmer, slower floor without values. One 2D canvas, capped at 60 fps (30 behind the list), paused while the page is hidden and stopped off the home; with reduced motion it is a still frame.
- **Dark Noir and Light Noir themes.** Dark Noir is the look of the author's Tern terminal theme: Dracula-style surfaces, a vivid 16-color table (green strings, yellow numbers, pink keywords, cyan functions and dates, blue types, grey `NULL`) and a teal `#287D8E` accent. Light Noir keeps the same hue in each role on cool light surfaces, every text color at 4.5:1 or better on every surface.
- **Tern's themes** (oh-my-pi's 102 theme files, MIT-licensed, in `web/src/themes/tern`) as a Tern group in the theme pickers, dark and light. The build converts them to color tables and surfaces (`virtual:tern-themes`, an 11.9 kB gzipped chunk) loaded only when Settings opens or a Tern theme is saved; text colors too faint on their background (most light themes' ANSI colors, some accents and secondary text) are darkened or lightened to stay readable.
- **Import a Tern theme file** ("Import Tern theme…" in either theme picker): a Tern theme CSS becomes the theme of its mode, named after the file, from the oh-my-pi theme it `@import`s with its `--tv-bg`, `--tv-fg`, `--ansi0`…`--ansi15` and surface variables over it; its other rules are skipped. Imported themes are kept in `~/.tablepeek/ui-state.json`, listed under "Imported" in the picker, and can be removed there.
- **Color table on the theme page**: the current theme's background, foreground and 16 colors as swatches. Syntax and value colors map to the slots, so a picked color carries to every part mapped to it; picks are saved per theme, and in the settings sheet the table is one row (⏎ in, arrows between swatches, ⏎ opens the picker, ⌫ puts one back, ⌫ on the row puts all back).
- **Settings menus preview live.** Moving over a theme, font, font size or syntax preset (with the pointer or ↑↓) shows it in the whole app at once (data table, SQL editor, sidebar, window material), a light theme even while dark is shown and the other way round; a click or ⏎ saves it, and closing the menu without picking (Esc, Tab, a click elsewhere, closing Settings) puts the saved look back. Previews are never saved or sent to other windows.
- **Motion throughout, in Tern's manner** (one set of durations and spring curves in `styles.css`, `web/src/motion.ts` for what CSS can't do; only transforms and opacity move). With the system's reduced motion everything is instant.
  - **Home drag and drop.** A dragged connection lifts off the list as a glass card that follows the pointer, leaning into sideways moves; the rows part to open a gap where it will land (the gap is the marker), and on release it springs into place. A folded or empty group under it lights up and pulses, the card thins over it, and a drop there falls into the folder, which bounces. A dragged group travels as its header with its rows stacked behind, and its rows unfold where it lands. Esc, or leaving the list, springs it back. ⌥↑/⌥↓ moves glide, and folding a group rolls its rows in and out. Dragging is pointer-driven now, so it works the same in the desktop app's WebKit.
  - **Liquid tabs.** Switching query/table or connection tabs pours the highlight toward the new tab, its leading edge first and its tail catching up; a new tab buds out of the one beside it, a closed one melts into the neighbour taking its place, and the rest slide over.
  - **Overlays share one motion.** Dialogs and the command palette spring up out of a dim that fades in by its color (so a glass dialog is blurred from its first frame), and leave with a quick fade and shrink. Menus, pickers, selects, context menus and popovers grow out of what opened them (the point nearest the pointer or the focused control) and fade back toward it; editor tooltips and hover tooltips drop in. The settings sheet slides in from the right edge on a spring, glass the whole way, and slides back out. Error toasts spring in from the right edge, the others moving aside as one comes or goes, and slide out when closed; the "nothing to run" note rises in and fades. Closing is unchanged (focus goes back at once): what plays is an inert copy.
  - **Panels and the schema tree.** Tree nodes and sections unroll and roll up (a short list's rows drop in one after another, a long one just fades), the sidebar, row detail panel and console slide in and out from their edges, structure, definition and plan views fade in, and Quick Look grows into its large view and shrinks back.
  - **Rolling numbers.** Row counts, query times, the page range, sidebar and group counts, the jobs badge and the pending-edits count roll only the digits that change, up or down. A query's status turns into its result: "Running…" becomes ✓ with the row count and time, or the error.
  - **The Restart to update pill** unfolds from its icon with a flood of accent color, a sweep across and a ring of glow, its words sharpening into focus one by one.

### Changed

- **Every font and color setting is on Settings › Appearance**, grouped into cards: Theme (mode, light and dark theme), Colors (accent, color table), Syntax colors (preset and colors, with the editor preview), Value colors (type colors and their colors), Fonts (interface, code, editor and table fonts with their sizes), Material and Display. The SQL Editor page keeps keyword case and the Data Table page the maximum rows and query time limit; search still finds every setting by its old words.
- The README is now a short page with install steps and screenshots. The details moved to [docs/INSTALL.md](docs/INSTALL.md) (downloads, first launch, updating), [docs/GUIDE.md](docs/GUIDE.md) (databases, features, MCP, security), and [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) (architecture, building, tests).
- The JSON tree in Quick Look drops the type glyphs (Aa, #, ✓, ∅, {}, []) in front of every key: values keep their type colors, objects and arrays show a muted member count after the key (`address {3}`, `tags [3]`), array positions are muted, and hovering a row shows its type.
- **Settings is a keyboard-first sheet docked to the right edge**: it takes its width from the app, which keeps working beside it (its shortcuts too, while focus is outside the sheet), rather than floating over it. ⌘, opens and closes it from anywhere. ↑↓ move between settings, ←→ switch pages, ⏎ or Space flips a switch, steps a choice or opens a menu, typing searches every page, ⌫ resets a setting marked as changed from its default, and Esc steps back (out of a field, clears the search, then closes). Tab stays in the sheet, and the sheet's edge resizes it by drag or ←→; its width is remembered.
- **Settings are laid out like Tern's.** The pages are General (language, updates, activity-log retention), Appearance, SQL Editor, Data Table, Import & Export, Shortcuts and Security; the Theme and Sidebar pages are gone. Appearance holds the theme, accent, color table, fonts, material and display settings. **Theme**: Mode is Light, Dark or System, with a light theme and a dark theme picked separately; System follows the operating system's mode live (the desktop window too, through a new `system` field in `PUT /api/window`). Each theme row opens a compact searchable picker with swatches (type to filter, ↑↓, ⏎, Esc) that also holds Tern's themes, the imported ones and "Import Tern theme…", in place of the inline gallery. The accent follows the theme shown unless one is picked. **Fonts** cascade as Tern's do: Font and Font size for the interface (the sidebars follow it), Code font for monospaced text (SQL editor, data table, code labels) with a size that follows Font size, and an Editor font and a Table font that follow the code font unless set apart; one searchable font picker serves them all. **Search**: "Search settings ⌘F" finds rows on every page in Korean or English, lists them under a small page-name eyebrow with the match highlighted, offers a page by its name, and says "Try a shorter word, or the name of a page." when nothing matches. Notes under settings are shorter. Earlier settings move over on first start: the saved theme becomes the theme of its mode (System if it was the default), an accent that was the theme's own follows the theme, the SQL editor's font and size become the code font's, and the data table's and sidebar's become the table font and the interface font only where they differed.
- The connection home is pared down. With nothing saved it shows the wordmark, one line, three buttons (New connection…, Open SQLite file, Import connections…) and a "Look around with demo data" link; the keychain note, the driver chips, the "what you'll need" box, the tech line, and the `make run DEMO=1` hint are gone. With connections, the search bar carries a New connection button and a … menu (new group, open SQLite file, import, export, database backup and restore, open demo) in place of the big backup/restore tiles.
- Less text in Quick Look and Settings. The large JSON view's right side now matches the popover's: the picked object's or array's members as labeled field boxes (key, type, value; nested values indented as stored), drawn only as they scroll into view, long values cut with "Show all", and a picked value as one box. In both, values (and the tree's) take the data table's colors by kind (string, integer, decimal, big integer, boolean, NULL), and objects and arrays in a box are colored token by token with faint punctuation. The popover's expand button and the settings page tabs are icons with their names in tooltips (Shortcuts gets a keyboard icon), and the update check in Settings › General drops its explanation and error box for a one-line reason under the status.

### Fixed

- Moved the test MySQL default port from 3307 to 3329 so it does not occupy a production proxy's port. Engine and server tests share the same port override.
- Pages opened as `localhost:<port>` now redirect to `127.0.0.1:<port>`, the launch address. The browser stores the token, settings, and workspaces per origin, so the two names used to show a stale token (`invalid_token`) and different settings. API calls still work under either name.
- Settings, language, workspaces and their tabs, drafts, column widths, panel sizes, and recent queries were lost whenever the server started on a different port, because the browser keeps them per origin. They now live in `~/.tablepeek/ui-state.json`, shared by every TablePeek on the machine; each address imports once what the browser kept for it there, for keys not saved yet. Several open windows (browser tabs, desktop windows, a CLI server alongside the desktop app) keep each other's changes instead of writing back stale copies.

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

[Unreleased]: https://github.com/Extransload/TablePeek/compare/v0.7.1...HEAD
[0.7.1]: https://github.com/Extransload/TablePeek/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/Extransload/TablePeek/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Extransload/TablePeek/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Extransload/TablePeek/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Extransload/TablePeek/compare/v0.3.4...v0.4.0
[0.3.4]: https://github.com/Extransload/TablePeek/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/Extransload/TablePeek/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/Extransload/TablePeek/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/Extransload/TablePeek/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Extransload/TablePeek/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Extransload/TablePeek/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Extransload/TablePeek/releases/tag/v0.1.0
