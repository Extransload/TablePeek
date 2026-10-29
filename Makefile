SHELL := /bin/sh

CARGO ?= cargo
NPM ?= npm
PORT ?= 7870
DEMO ?= 0
DEMO_ROWS ?= 10000
DB ?=
NO_OPEN ?= 0

# No connection is opened at start unless DB, DEMO=1, or an explicit
# DEMO_ROWS asks for one.
ifneq ($(strip $(DB)),)
SERVE_ARGS := --db $(DB)
else ifeq ($(DEMO),1)
SERVE_ARGS := --demo-rows $(DEMO_ROWS)
else ifneq ($(origin DEMO_ROWS),file)
SERVE_ARGS := --demo-rows $(DEMO_ROWS)
else
SERVE_ARGS :=
endif

# Throwaway test databases (testdb/compose.yml): every engine, or the ones
# ENGINE names, e.g. ENGINE=postgres or ENGINE="mysql mssql".
TESTDB_ENGINES := postgres mysql cockroach mssql mongodb
ENGINE ?= $(TESTDB_ENGINES)
TESTDB := docker compose -f testdb/compose.yml
# MySQL's host port; the tests read the same variable.
TABLEPEEK_TEST_MYSQL_PORT ?= 3307
export TABLEPEEK_TEST_MYSQL_PORT
TESTDB_ENV := $(if $(filter postgres,$(ENGINE)),TABLEPEEK_TEST_PG=1) \
	$(if $(filter mysql,$(ENGINE)),TABLEPEEK_TEST_MYSQL=1) \
	$(if $(filter cockroach,$(ENGINE)),TABLEPEEK_TEST_COCKROACH=1) \
	$(if $(filter mssql,$(ENGINE)),TABLEPEEK_TEST_MSSQL=1) \
	$(if $(filter mongodb,$(ENGINE)),TABLEPEEK_TEST_MONGODB=1)

.PHONY: all help install web build run mcp test test-docker test-db test-db-down test-live check fmt clean distclean testdb-engines

all: build

help:
	@printf '%s\n' \
		'TablePeek commands:' \
		'  make install                 Install web dependencies' \
		'  make build                   Build web bundle and Rust binary' \
		'  make run                     Build and run the server' \
		'  make run PORT=7871           Run on a custom port' \
		'  make run DEMO=1              Also open an in-memory demo database' \
		'  make run DEMO=1 DEMO_ROWS=500000   Set demo row count' \
		'  make run DB=path/to.sqlite   Open a SQLite file' \
		'  make mcp                     Run the MCP stdio server' \
		'  make test                    Run Rust tests and TypeScript checks' \
		'  make test-docker             Run Docker-backed integration tests' \
		'  make test-db                 Start the test databases in Docker, seeded' \
		'  make test-db ENGINE=postgres Start only some (postgres mysql cockroach mssql mongodb)' \
		'  make test-live ENGINE=mysql  Run the engine live tests against them' \
		'  make test-db-down            Stop them and throw their data away' \
		'  TABLEPEEK_TEST_MYSQL_PORT=3329 make test-db ENGINE=mysql   Another MySQL port' \
		'  make check                   Check formatting, Rust, and TypeScript' \
		'  make fmt                     Format Rust code' \
		'  make clean                   Remove Rust and web build artifacts' \
		'  make distclean               Also remove web dependencies'

install:
	cd web && $(NPM) install

web:
	@if [ ! -d web/node_modules ]; then cd web && $(NPM) install; fi
	cd web && $(NPM) run build

build: web
	$(CARGO) build -p tablepeek

run: build
	$(CARGO) run -p tablepeek -- serve --port $(PORT) $(SERVE_ARGS) $(if $(filter 1,$(NO_OPEN)),--no-open,)

mcp: web
	$(CARGO) run -p tablepeek -- mcp

test: web
	$(CARGO) test
	cd web && $(NPM) run typecheck

test-docker: web
	TABLEPEEK_TEST_PG=1 TABLEPEEK_TEST_MYSQL=1 TABLEPEEK_TEST_COCKROACH=1 TABLEPEEK_TEST_MSSQL=1 TABLEPEEK_TEST_DOCKER=1 $(CARGO) test

testdb-engines:
	@unknown='$(filter-out $(TESTDB_ENGINES),$(ENGINE))'; \
	if [ -n "$$unknown" ]; then echo "Unknown ENGINE: $$unknown (use: $(TESTDB_ENGINES))" >&2; exit 2; fi

test-db: testdb-engines
	$(TESTDB) up -d --wait $(ENGINE)
	$(if $(filter cockroach,$(ENGINE)),$(TESTDB) exec -T cockroach /cockroach/cockroach sql --insecure -d defaultdb -f /seed/cockroach.sql > /dev/null)
	$(if $(filter cockroach,$(ENGINE)),$(TESTDB) exec -T cockroach /cockroach/cockroach sql --insecure -d defaultdb -f /seed/cockroach-shop.sql > /dev/null)
	$(if $(filter mssql,$(ENGINE)),$(TESTDB) exec -T mssql /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P MsSql_test_pw1 -b -r0 -i /seed/mssql.sql > /dev/null)
	$(if $(filter mssql,$(ENGINE)),$(TESTDB) exec -T mssql /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P MsSql_test_pw1 -b -r0 -i /seed/mssql-shop.sql > /dev/null)
	$(if $(filter mongodb,$(ENGINE)),$(TESTDB) exec -T mongodb mongosh --quiet /seed/mongodb.js > /dev/null)
	$(if $(filter mongodb,$(ENGINE)),$(TESTDB) exec -T mongodb mongosh --quiet /seed/mongodb-shop.js > /dev/null)
	@printf '%s\n' 'Ready on 127.0.0.1 (test-only accounts; sample data in schema shop, or database shop on MySQL):'
	$(if $(filter postgres,$(ENGINE)),@printf '%s\n' '  PostgreSQL   port 5433   tablepeek / tablepeek_test_pw   database tablepeek_test')
	$(if $(filter mysql,$(ENGINE)),@printf '%s\n' '  MySQL        port $(TABLEPEEK_TEST_MYSQL_PORT)   root / root_pw                  database tablepeek_test')
	$(if $(filter cockroach,$(ENGINE)),@printf '%s\n' '  CockroachDB  port 26258  root (no password; SSL off)    database defaultdb')
	$(if $(filter mssql,$(ENGINE)),@printf '%s\n' '  SQL Server   port 14330  sa / MsSql_test_pw1             database tablepeek_test')
	$(if $(filter mongodb,$(ENGINE)),@printf '%s\n' '  MongoDB      port 27018  tablepeek / tablepeek_test_pw   database shop (replica set rs0, directConnection)')

test-db-down: testdb-engines
	$(if $(filter-out $(ENGINE),$(TESTDB_ENGINES)),$(TESTDB) rm --stop --force --volumes $(ENGINE),$(TESTDB) down --volumes)

test-live: testdb-engines
	$(TESTDB_ENV) $(CARGO) test -p tablepeek-engine -- --test-threads=1

check: web
	$(CARGO) fmt --all --check
	$(CARGO) check --workspace
	cd web && $(NPM) run typecheck

fmt:
	$(CARGO) fmt --all

clean:
	$(CARGO) clean
	rm -rf web/dist

distclean: clean
	rm -rf web/node_modules
