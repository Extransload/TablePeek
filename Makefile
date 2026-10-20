SHELL := /bin/sh

CARGO ?= cargo
NPM ?= npm
PORT ?= 7870
DEMO_ROWS ?= 10000
DB ?=
NO_OPEN ?= 0

ifeq ($(strip $(DB)),)
SERVE_ARGS := --demo-rows $(DEMO_ROWS)
else
SERVE_ARGS := --db $(DB)
endif

.PHONY: all help install web build run mcp test test-docker check fmt clean distclean

all: build

help:
	@printf '%s\n' \
		'TablePeek commands:' \
		'  make install                 Install web dependencies' \
		'  make build                   Build web bundle and Rust binary' \
		'  make run                     Build and run the demo server' \
		'  make run PORT=7871           Run on a custom port' \
		'  make run DEMO_ROWS=500000    Set demo row count' \
		'  make run DB=path/to.sqlite   Open a SQLite file' \
		'  make mcp                     Run the MCP stdio server' \
		'  make test                    Run Rust tests and TypeScript checks' \
		'  make test-docker             Run Docker-backed integration tests' \
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
