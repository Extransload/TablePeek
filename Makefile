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
# MongoDB servers for particular tests, started only when ENGINE names them
# (each is the compose profile of the same name): TLS with X.509 logins,
# Enterprise with LDAP, Kerberos (with a KDC), OIDC (with an identity
# provider) and AWS IAM (with an STS stand-in), a replica set behind SSH,
# Atlas Local, a sharded cluster.
TESTDB_EXTRAS := mongodb-x509 mongodb-ldap mongodb-kerberos mongodb-oidc mongodb-aws mongodb-rs mongodb-atlas mongodb-sharded
ENGINE ?= $(TESTDB_ENGINES)
TESTDB_SERVICES_mongodb-ldap := openldap mongodb-ldap
TESTDB_SERVICES_mongodb-kerberos := kdc mongodb-kerberos
TESTDB_SERVICES_mongodb-oidc := oidc-idp mongodb-oidc
TESTDB_SERVICES_mongodb-aws := aws-sts mongodb-aws
TESTDB_SERVICES_mongodb-rs := mongo-rs1 mongo-rs2 mongo-rs3 sshd dns
TESTDB_SERVICES_mongodb-sharded := mongo-cfg mongo-shard1 mongos
TESTDB_SERVICES := $(foreach engine,$(ENGINE),$(or $(TESTDB_SERVICES_$(engine)),$(engine)))
TESTDB := docker compose -f testdb/compose.yml $(foreach engine,$(filter $(TESTDB_EXTRAS),$(ENGINE)),--profile $(engine))
# MySQL's host port; the tests read the same variable.
TABLEPEEK_TEST_MYSQL_PORT ?= 3307
export TABLEPEEK_TEST_MYSQL_PORT
TESTDB_ENV := $(if $(filter postgres,$(ENGINE)),TABLEPEEK_TEST_PG=1) \
	$(if $(filter mysql,$(ENGINE)),TABLEPEEK_TEST_MYSQL=1) \
	$(if $(filter cockroach,$(ENGINE)),TABLEPEEK_TEST_COCKROACH=1) \
	$(if $(filter mssql,$(ENGINE)),TABLEPEEK_TEST_MSSQL=1) \
	$(if $(filter mongodb,$(ENGINE)),TABLEPEEK_TEST_MONGODB=1) \
	$(if $(filter mongodb-x509,$(ENGINE)),TABLEPEEK_TEST_MONGODB_X509=1) \
	$(if $(filter mongodb-ldap,$(ENGINE)),TABLEPEEK_TEST_MONGODB_LDAP=1) \
	$(if $(filter mongodb-kerberos,$(ENGINE)),TABLEPEEK_TEST_MONGODB_KERBEROS=1) \
	$(if $(filter mongodb-oidc,$(ENGINE)),TABLEPEEK_TEST_MONGODB_OIDC=1) \
	$(if $(filter mongodb-aws,$(ENGINE)),TABLEPEEK_TEST_MONGODB_AWS=1) \
	$(if $(filter mongodb-rs,$(ENGINE)),TABLEPEEK_TEST_MONGODB_RS=1) \
	$(if $(filter mongodb-atlas,$(ENGINE)),TABLEPEEK_TEST_MONGODB_ATLAS=1) \
	$(if $(filter mongodb-sharded,$(ENGINE)),TABLEPEEK_TEST_MONGODB_SHARDED=1)

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
		'  make test-db ENGINE=mongodb-rs   Also: mongodb-x509 mongodb-ldap mongodb-kerberos mongodb-oidc mongodb-aws mongodb-rs mongodb-atlas mongodb-sharded' \
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
	@unknown='$(filter-out $(TESTDB_ENGINES) $(TESTDB_EXTRAS),$(ENGINE))'; \
	if [ -n "$$unknown" ]; then echo "Unknown ENGINE: $$unknown (use: $(TESTDB_ENGINES) $(TESTDB_EXTRAS))" >&2; exit 2; fi

test-db: testdb-engines
	$(if $(filter mongodb-x509 mongodb-oidc mongodb-aws,$(ENGINE)),sh testdb/x509/gen.sh)
	$(if $(filter mongodb-rs,$(ENGINE)),@mkdir -p testdb/ssh && [ -f testdb/ssh/id_ed25519 ] || ssh-keygen -q -t ed25519 -N '' -C tablepeek-test -f testdb/ssh/id_ed25519)
	$(TESTDB) up -d --wait $(TESTDB_SERVICES)
	$(if $(filter cockroach,$(ENGINE)),$(TESTDB) exec -T cockroach /cockroach/cockroach sql --insecure -d defaultdb -f /seed/cockroach.sql > /dev/null)
	$(if $(filter cockroach,$(ENGINE)),$(TESTDB) exec -T cockroach /cockroach/cockroach sql --insecure -d defaultdb -f /seed/cockroach-shop.sql > /dev/null)
	$(if $(filter mssql,$(ENGINE)),$(TESTDB) exec -T mssql /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P MsSql_test_pw1 -b -r0 -i /seed/mssql.sql > /dev/null)
	$(if $(filter mssql,$(ENGINE)),$(TESTDB) exec -T mssql /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P MsSql_test_pw1 -b -r0 -i /seed/mssql-shop.sql > /dev/null)
	$(if $(filter mongodb,$(ENGINE)),$(TESTDB) exec -T mongodb mongosh --quiet /seed/mongodb.js > /dev/null)
	$(if $(filter mongodb,$(ENGINE)),$(TESTDB) exec -T mongodb mongosh --quiet /seed/mongodb-shop.js > /dev/null)
	$(if $(filter mongodb-ldap,$(ENGINE)),$(TESTDB) exec -T mongodb-ldap mongosh --quiet -u tablepeek -p tablepeek_test_pw /seed/mongodb-ldap.js > /dev/null)
	$(if $(filter mongodb-kerberos,$(ENGINE)),$(TESTDB) exec -T mongodb-kerberos mongosh --quiet -u tablepeek -p tablepeek_test_pw /seed/mongodb-kerberos.js > /dev/null)
	$(if $(filter mongodb-oidc,$(ENGINE)),$(TESTDB) exec -T mongodb-oidc mongosh --quiet -u tablepeek -p tablepeek_test_pw /seed/mongodb-oidc.js > /dev/null)
	$(if $(filter mongodb-aws,$(ENGINE)),$(TESTDB) exec -T mongodb-aws mongosh --quiet -u tablepeek -p tablepeek_test_pw /seed/mongodb-aws.js > /dev/null)
	$(if $(filter mongodb-rs,$(ENGINE)),$(TESTDB) exec -T mongo-rs1 mongosh --quiet --eval 'while (!rs.status().members.some((m) => m.stateStr === "PRIMARY")) sleep(500)' > /dev/null)
	$(if $(filter mongodb-sharded,$(ENGINE)),$(TESTDB) exec -T mongos mongosh --quiet --eval 'if (!db.adminCommand({ listShards: 1 }).shards.length) sh.addShard("sh1/sh1.tablepeek.test:27017")' > /dev/null)
	@printf '%s\n' 'Ready on 127.0.0.1 (test-only accounts; sample data in schema shop, or database shop on MySQL):'
	$(if $(filter postgres,$(ENGINE)),@printf '%s\n' '  PostgreSQL   port 5433   tablepeek / tablepeek_test_pw   database tablepeek_test')
	$(if $(filter mysql,$(ENGINE)),@printf '%s\n' '  MySQL        port $(TABLEPEEK_TEST_MYSQL_PORT)   root / root_pw                  database tablepeek_test')
	$(if $(filter cockroach,$(ENGINE)),@printf '%s\n' '  CockroachDB  port 26258  root (no password; SSL off)    database defaultdb')
	$(if $(filter mssql,$(ENGINE)),@printf '%s\n' '  SQL Server   port 14330  sa / MsSql_test_pw1             database tablepeek_test')
	$(if $(filter mongodb,$(ENGINE)),@printf '%s\n' '  MongoDB      port 27018  tablepeek / tablepeek_test_pw   database shop (replica set rs0; directConnection)')
	$(if $(filter mongodb-x509,$(ENGINE)),@printf '%s\n' '  MongoDB X.509  port 27020  TLS required: CA testdb/x509/ca.pem  client testdb/x509/client.pem')
	$(if $(filter mongodb-ldap,$(ENGINE)),@printf '%s\n' '  MongoDB LDAP   port 27021  LDAP ann / ann_ldap_pw in $$external  (admin tablepeek / tablepeek_test_pw)')
	$(if $(filter mongodb-kerberos,$(ENGINE)),@printf '%s\n' '  MongoDB Kerberos port 27022  ann@TABLEPEEK.TEST / ann_krb_pw  service host kerberos.tablepeek.test  KDC 127.0.0.1:1088' '                 KRB5_CONFIG=testdb/kerberos/krb5.conf KRB5CCNAME=FILE:/tmp/tablepeek-krb5cc kinit ann@TABLEPEEK.TEST')
	$(if $(filter mongodb-oidc,$(ENGINE)),@printf '%s\n' '  MongoDB OIDC   port 27023  browser login at https://127.0.0.1:8180/tablepeek (any name; tp/ann has a user)' '                 run TablePeek with SSL_CERT_FILE=testdb/x509/ca.pem  (admin tablepeek / tablepeek_test_pw)')
	$(if $(filter mongodb-aws,$(ENGINE)),@printf '%s\n' '  MongoDB AWS    port 27024  key AKIATABLEPEEKTEST / tablepeek_aws_secret  (session token tablepeek_session_token for the assumed role)')
	$(if $(filter mongodb-rs,$(ENGINE)),@printf '%s\n' '  MongoDB rs1    members rs1.tablepeek.test rs2.tablepeek.test rs3.tablepeek.test:27017  SRV rs.tablepeek.test (DNS 127.0.0.1:1053)' '                 only through SSH 127.0.0.1:2223  user tablepeek  key testdb/ssh/id_ed25519')
	$(if $(filter mongodb-atlas,$(ENGINE)),@printf '%s\n' '  Atlas Local    port 27019  no authentication (directConnection); search indexes')
	$(if $(filter mongodb-sharded,$(ENGINE)),@printf '%s\n' '  MongoDB mongos port 27040  no authentication (config server + one shard)')

test-db-down: testdb-engines
	$(if $(filter-out $(ENGINE),$(TESTDB_ENGINES)),$(TESTDB) rm --stop --force --volumes $(TESTDB_SERVICES),$(TESTDB) down --volumes)

# The replica set behind SSH is tried through the server's own tunnel too,
# and Atlas Local's search indexes through the server's routes.
test-live: testdb-engines
	$(TESTDB_ENV) $(CARGO) test -p tablepeek-engine $(if $(filter mongodb-rs mongodb-atlas,$(ENGINE)),-p tablepeek-server) -- --test-threads=1

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
