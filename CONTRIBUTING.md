# Contributing to TablePeek

Thanks for wanting to help. Bug reports, fixes, and small focused features are all welcome. For anything large (a new engine, a new workbench, a change to how data is stored), please open an issue first so we can agree on the shape before you spend time on it.

Security problems go through a private report, not an issue: see [SECURITY.md](SECURITY.md).

## License of contributions

TablePeek is licensed under the [GNU Affero General Public License v3.0](LICENSE), version 3 only (`AGPL-3.0-only`). By opening a pull request you agree that your contribution is licensed under the same terms (inbound = outbound). There is no separate contributor license agreement. Only submit code you wrote or have the right to submit under that license.

The bundled Oracle driver in `crates/vendor/oracledb` keeps its own license (UPL-1.0 OR Apache-2.0); changes there follow that license.

## Building and testing

[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) covers the toolchains, building from source, the project layout, and the test setup. `make help` lists every target. The ones you will use most:

```sh
make install      # install the web dependencies
make run DEMO=1   # build and run the server with an in-memory demo database
make desktop      # run the desktop app from source (macOS, Windows)
make test         # the test suite
make check        # versions, formatting, Rust and TypeScript checks
make fmt          # format the Rust code
```

Please run `make check` and `make test` before opening a pull request. CI also runs `cargo clippy --workspace --all-targets -- -D warnings`, so run that too.

### Live database tests

The engine tests that need a real server are off unless you turn them on. `testdb/compose.yml` runs throwaway, seeded servers in Docker, bound to `127.0.0.1` with test-only accounts:

```sh
make test-db ENGINE=postgres         # start the server(s) ENGINE names
make test-live ENGINE=postgres       # run the engine's live tests against them
make test-db-down ENGINE=postgres    # stop them and throw the data away
```

`make test-live` sets the `TABLEPEEK_TEST_<ENGINE>=1` variables for you. Running `cargo test` directly, set them yourself, for example `TABLEPEEK_TEST_PG=1 cargo test -p tablepeek-engine -- --test-threads=1`. Some servers are heavy (Elasticsearch, Cassandra, ScyllaDB, ClickHouse, Oracle); start those one at a time. The full list of `ENGINE` values, ports, and accounts is in [Test databases](docs/DEVELOPMENT.md#test-databases).

If you change an engine, run its live tests. If you can't (no Docker, or the image doesn't run on your machine), say so in the pull request.

## Making a change

- **Keep a pull request to one change.** A fix and an unrelated cleanup are easier to review as two.
- **Commit messages** describe the user-visible effect, in sentence case and the imperative, without a trailing period. Look at `git log --oneline` for the tone, for example:
  - `Reorder columns by dragging their headers`
  - `Back up and restore SQL on the server, restore in one transaction`
  - `Satisfy clippy in the dump literal writer and a stream test`
- **CHANGELOG.** A change people will notice gets an entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md), in the matching `Added`, `Changed`, or `Fixed` group. Write it for users: what changed for them, not how the code changed. Internal refactors and test-only changes need no entry. Release sections are cut by the maintainers ([docs/RELEASING.md](docs/RELEASING.md)).
- **Docs.** If you change what a user sees or does, update [docs/GUIDE.md](docs/GUIDE.md) (or the engine's guide under [docs/engines](docs/engines)) in the same pull request. User-facing docs are in English.
- **Design notes.** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/ENGINES.md](docs/ENGINES.md) are the internal design notes, written in Korean. Read [docs/ENGINES.md](docs/ENGINES.md) §6 before adding an engine. You don't need to write Korean: describe a design change in English in the pull request and the maintainers will fold it in.
- **UI strings.** The web UI's source strings are Korean, passed through `t("…")`, with the English text in [web/src/i18n.ts](web/src/i18n.ts). A new string needs both: the Korean in `t("…")` and its English entry in `i18n.ts`. If you don't write Korean, put the English in the pull request and ask; we will add the Korean.
- **Style.** Rust is formatted with `cargo fmt` and must pass `cargo clippy` without warnings. TypeScript must pass `npm run typecheck` in `web/`. Follow the patterns already in the file you are changing.

## Reporting bugs and asking for features

Use the [issue forms](https://github.com/Extransload/TablePeek/issues/new/choose). For a bug, the TablePeek version, how you run it (desktop app, command line, or browser), the OS, and the database engine and its server version save a round of questions.
