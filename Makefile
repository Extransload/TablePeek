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
# Elasticsearch and OpenSearch, one at a time (each takes about 1 GB):
# Elasticsearch 8 over HTTP and over HTTPS, the older Elasticsearch 7.9 and
# 6.8 (mapping types; emulated on ARM) and OpenSearch 2, 1.3 and 3 (API keys).
TESTDB_EXTRAS += elasticsearch elasticsearch-tls elasticsearch-7 elasticsearch-6 opensearch opensearch-1 opensearch-3
# Cassandra and ScyllaDB, one at a time (each takes about 1 GB), and a
# two-node ScyllaDB cluster behind the SSH server.
TESTDB_EXTRAS += cassandra scylladb scylladb-cluster
# ClickHouse over HTTP and HTTPS (about 1 GB at most) with the SSH server
# in front of it, and a two-server cluster for ON CLUSTER (about 1.5 GB).
TESTDB_EXTRAS += clickhouse clickhouse-cluster
# Oracle Database Free (about 2 GB; one heavy profile at a time).
TESTDB_EXTRAS += oracle
ENGINE ?= $(TESTDB_ENGINES)
TESTDB_SERVICES_mongodb-ldap := openldap mongodb-ldap
TESTDB_SERVICES_mongodb-kerberos := kdc mongodb-kerberos
TESTDB_SERVICES_mongodb-oidc := oidc-idp mongodb-oidc
TESTDB_SERVICES_mongodb-aws := aws-sts mongodb-aws
TESTDB_SERVICES_mongodb-rs := mongo-rs1 mongo-rs2 mongo-rs3 sshd dns
TESTDB_SERVICES_mongodb-sharded := mongo-cfg mongo-shard1 mongos
TESTDB_SERVICES_scylladb-cluster := scylla-a scylla-b sshd
TESTDB_SERVICES_clickhouse := clickhouse sshd
TESTDB_SERVICES_clickhouse-cluster := ch-node1 ch-node2
TESTDB_SERVICES_oracle := oracle sshd
# How the CQL seeds log in to make the test login: Cassandra's default
# superuser, ScyllaDB's maintenance socket (it makes no default superuser).
CQL_ADMIN_cassandra := -u cassandra -p cassandra
CQL_ADMIN_scylladb := /var/lib/scylla/cql.m
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
	$(if $(filter mongodb-sharded,$(ENGINE)),TABLEPEEK_TEST_MONGODB_SHARDED=1) \
	$(if $(filter elasticsearch,$(ENGINE)),TABLEPEEK_TEST_ELASTICSEARCH=1) \
	$(if $(filter elasticsearch-tls,$(ENGINE)),TABLEPEEK_TEST_ELASTICSEARCH_TLS=1) \
	$(if $(filter elasticsearch-7,$(ENGINE)),TABLEPEEK_TEST_ELASTICSEARCH_7=1) \
	$(if $(filter elasticsearch-6,$(ENGINE)),TABLEPEEK_TEST_ELASTICSEARCH_6=1) \
	$(if $(filter opensearch,$(ENGINE)),TABLEPEEK_TEST_OPENSEARCH=1) \
	$(if $(filter opensearch-1,$(ENGINE)),TABLEPEEK_TEST_OPENSEARCH_1=1) \
	$(if $(filter opensearch-3,$(ENGINE)),TABLEPEEK_TEST_OPENSEARCH_3=1) \
	$(if $(filter cassandra,$(ENGINE)),TABLEPEEK_TEST_CASSANDRA=1) \
	$(if $(filter scylladb,$(ENGINE)),TABLEPEEK_TEST_SCYLLADB=1) \
	$(if $(filter clickhouse,$(ENGINE)),TABLEPEEK_TEST_CLICKHOUSE=1) \
	$(if $(filter clickhouse-cluster,$(ENGINE)),TABLEPEEK_TEST_CLICKHOUSE_CLUSTER=1) \
	$(if $(filter oracle,$(ENGINE)),TABLEPEEK_TEST_ORACLE=1)
# Kerberos (GSSAPI) is built in on macOS; elsewhere the test needs the
# kerberos feature, and with it the Kerberos headers and libclang.
TESTDB_FEATURES := $(if $(filter mongodb-kerberos,$(ENGINE)),--features tablepeek-engine/kerberos)

# Linux builds in Docker: the official Rust image plus the D-Bus headers
# (password keyring), the MIT Kerberos headers and libclang the GSSAPI
# bindings are generated with, and MIT's kinit for the Kerberos live test.
# Output goes to target/linux, for the Docker machine's architecture;
# downloaded crates stay in a volume. CARGO_BUILD_JOBS=4 eases the memory
# a build takes inside a small Docker machine.
LINUX_IMAGE := tablepeek-build-linux
LINUX_RUN := docker run --rm -v "$(CURDIR)":/src -w /src \
	-v tablepeek-cargo-registry:/usr/local/cargo/registry \
	-e CARGO_TARGET_DIR=/src/target/linux -e CARGO_BUILD_JOBS -e TABLEPEEK_TEST_MYSQL_PORT

.PHONY: all help install web build run mcp test test-docker test-db test-db-down test-live check fmt clean distclean testdb-engines linux-image build-kerberos-linux test-live-linux test-oracle-oob

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
		'  make test-db ENGINE=elasticsearch  Also, one at a time: elasticsearch elasticsearch-tls elasticsearch-7 elasticsearch-6 opensearch opensearch-1 opensearch-3' \
		'  make test-db ENGINE=cassandra    Also, one at a time: cassandra scylladb' \
		'  make test-db ENGINE=clickhouse   Also: clickhouse (HTTP 18123, HTTPS 18443, SSH 2223) clickhouse-cluster (two servers, 18124 18125)' \
		'  make test-db ENGINE=oracle       Also: oracle (Oracle Database 23ai Free, port 15210, about 2 GB)' \
		'  make test-live ENGINE=mysql  Run the engine live tests against them' \
		'  make build-kerberos-linux    Build a Linux binary with Kerberos in Docker (target/linux/release)' \
		'  make test-live-linux ENGINE=mongodb-kerberos   Run the live tests in that Linux container' \
		'  make test-oracle-oob         Oracle out-of-band break test, on the test network (after make test-db ENGINE=oracle)' \
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
	$(if $(filter mongodb-x509 mongodb-oidc mongodb-aws clickhouse oracle elasticsearch-tls,$(ENGINE)),sh testdb/x509/gen.sh)
	$(if $(filter elasticsearch-tls,$(ENGINE)),sh testdb/elasticsearch-tls/gen.sh)
	$(if $(filter oracle,$(ENGINE)),sh testdb/oracle-wallet.sh)
	$(if $(filter clickhouse,$(ENGINE)),sh testdb/clickhouse/gen.sh)
	$(if $(filter mongodb-rs scylladb-cluster clickhouse oracle,$(ENGINE)),@mkdir -p testdb/ssh && [ -f testdb/ssh/id_ed25519 ] || ssh-keygen -q -t ed25519 -N '' -C tablepeek-test -f testdb/ssh/id_ed25519)
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
	$(if $(filter elasticsearch,$(ENGINE)),$(TESTDB) exec -T elasticsearch sh /seed/search-shop.sh http://localhost:9200 -u elastic:tablepeek_test_pw)
	$(if $(filter elasticsearch-tls,$(ENGINE)),$(TESTDB) exec -T elasticsearch-tls sh /seed/search-shop.sh https://localhost:9200 --cacert config/certs/ca.pem -u elastic:tablepeek_test_pw)
	$(if $(filter elasticsearch-tls,$(ENGINE)),$(TESTDB) exec -T elasticsearch-tls sh /seed/elasticsearch-tls/pki.sh)
	$(foreach es,elasticsearch-7 elasticsearch-6,$(if $(filter $(es),$(ENGINE)),$(TESTDB) exec -T $(es) sh /seed/search-shop.sh http://localhost:9200 -u elastic:tablepeek_test_pw;))
	$(if $(filter opensearch,$(ENGINE)),$(TESTDB) exec -T opensearch sh /seed/search-shop.sh https://localhost:9200 -k -u admin:TablePeek_test_pw1)
	$(if $(filter opensearch,$(ENGINE)),@mkdir -p testdb/opensearch && $(foreach pem,esnode.pem:node.pem root-ca.pem:ca.pem kirk.pem:client.pem kirk-key.pem:client-key.pem,$(TESTDB) cp opensearch:/usr/share/opensearch/config/$(word 1,$(subst :, ,$(pem))) testdb/opensearch/$(word 2,$(subst :, ,$(pem))) &&) true)
	$(if $(filter opensearch-1,$(ENGINE)),$(TESTDB) exec -T opensearch-1 sh /seed/search-shop.sh https://localhost:9200 -k -u admin:admin)
	$(if $(filter opensearch-3,$(ENGINE)),$(TESTDB) exec -T opensearch-3 sh /seed/search-shop.sh https://localhost:9200 -k -u admin:TablePeek_test_pw1)
	$(foreach cql,cassandra scylladb,$(if $(filter $(cql),$(ENGINE)),$(TESTDB) exec -T $(cql) sh -c 'cqlsh -u tablepeek -p tablepeek_test_pw -e "DESCRIBE TABLE shop.categories" > /dev/null 2>&1 || { cqlsh $(CQL_ADMIN_$(cql)) -f /seed/$(cql)-keyspaces.cql && cqlsh -u tablepeek -p tablepeek_test_pw -f /seed/cassandra-shop.cql && cqlsh -u tablepeek -p tablepeek_test_pw -f /seed/$(cql)-extras.cql; }';))
	$(if $(filter scylladb-cluster,$(ENGINE)),$(TESTDB) exec -T scylla-a sh -c 'cqlsh -u tablepeek -p tablepeek_test_pw -e "DESCRIBE TABLE shop.categories" > /dev/null 2>&1 || { cqlsh /var/lib/scylla/cql.m -f /seed/scylladb-keyspaces.cql && cqlsh -u tablepeek -p tablepeek_test_pw -f /seed/cassandra-shop.cql; }')
	$(if $(filter oracle,$(ENGINE)),$(TESTDB) exec -T oracle sqlplus -s -L 'sys/Oracle_test_pw1@//localhost/FREE as sysdba' @/seed/oracle-memory.sql > /dev/null; if [ $$? -eq 3 ]; then $(TESTDB) restart oracle && $(TESTDB) up -d --wait oracle; fi)
	$(foreach seed,oracle oracle-shop,$(if $(filter oracle,$(ENGINE)),$(TESTDB) exec -T -e NLS_LANG=AMERICAN_AMERICA.AL32UTF8 oracle sqlplus -s -L 'sys/Oracle_test_pw1@//localhost/FREEPDB1 as sysdba' @/seed/$(seed).sql > /dev/null;))
	$(if $(filter oracle,$(ENGINE)),$(TESTDB) exec -T oracle bash /seed/oracle-tls.sh)
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
	$(if $(filter elasticsearch,$(ENGINE)),@printf '%s\n' '  Elasticsearch  port 9201  elastic / tablepeek_test_pw  (HTTP; security on)  indices shop-*  aliases shop and orders  data stream logs-shop-default')
	$(if $(filter elasticsearch-tls,$(ENGINE)),@printf '%s\n' '  Elasticsearch  port 9203  elastic / tablepeek_test_pw  (HTTPS; CA testdb/x509/ca.pem; client certificate testdb/x509/client.pem logs in as superuser)  same shop data')
	$(if $(filter elasticsearch-7,$(ENGINE)),@printf '%s\n' '  Elasticsearch 7.9  port 9204  elastic / tablepeek_test_pw  (HTTP; security on; no point in time)  same shop data')
	$(if $(filter elasticsearch-6,$(ENGINE)),@printf '%s\n' '  Elasticsearch 6.8  port 9206  elastic / tablepeek_test_pw  (HTTP; security on; mapping type _doc; no data stream)  same shop data')
	$(if $(filter opensearch,$(ENGINE)),@printf '%s\n' '  OpenSearch     port 9202  admin / TablePeek_test_pw1  (HTTPS self-signed; certificate testdb/opensearch/node.pem)  same shop data')
	$(if $(filter opensearch-1,$(ENGINE)),@printf '%s\n' '  OpenSearch 1.3 port 9205  admin / admin  (HTTPS self-signed; no point in time)  same shop data')
	$(if $(filter opensearch-3,$(ENGINE)),@printf '%s\n' '  OpenSearch 3.9 port 9207  admin / TablePeek_test_pw1  (HTTPS self-signed; API keys on)  same shop data')
	$(if $(filter cassandra,$(ENGINE)),@printf '%s\n' '  Cassandra      port 9043  tablepeek / tablepeek_test_pw  (superuser cassandra / cassandra)  keyspace shop')
	$(if $(filter scylladb,$(ENGINE)),@printf '%s\n' '  ScyllaDB       port 9044  tablepeek / tablepeek_test_pw  (superuser; no other login)  keyspace shop')
	$(if $(filter scylladb-cluster,$(ENGINE)),@printf '%s\n' '  ScyllaDB x2    nodes scylla-a scylla-b:9042  tablepeek / tablepeek_test_pw  keyspace shop' '                 only through SSH 127.0.0.1:2223  user tablepeek  key testdb/ssh/id_ed25519')
	$(if $(filter clickhouse,$(ENGINE)),@printf '%s\n' '  ClickHouse     port 18123 (HTTP) and 18443 (HTTPS; CA testdb/x509/ca.pem)  tablepeek / tablepeek_test_pw  database tablepeek_test; sample database shop' '                 also as clickhouse.tablepeek.test:8123/8443 through SSH 127.0.0.1:2223  user tablepeek  key testdb/ssh/id_ed25519')
	$(if $(filter clickhouse-cluster,$(ENGINE)),@printf '%s\n' '  ClickHouse x2  cluster tp_cluster: ch-node1 port 18124 and ch-node2 port 18125 (HTTP)  tablepeek / tablepeek_test_pw')
	$(if $(filter oracle,$(ENGINE)),@printf '%s\n' '  Oracle         port 15210  tablepeek / tablepeek_test_pw  service FREEPDB1  sample schema SHOP (shop / tablepeek_test_pw)  SYS: Oracle_test_pw1' '                 TCPS port 15211 (CA testdb/x509/ca.pem); as oracle:1521/2484 through SSH 127.0.0.1:2223  user tablepeek  key testdb/ssh/id_ed25519')

test-db-down: testdb-engines
	$(if $(filter-out $(ENGINE),$(TESTDB_ENGINES)),$(TESTDB) rm --stop --force --volumes $(TESTDB_SERVICES),$(TESTDB) down --volumes)

# The replica set behind SSH is tried through the server's own tunnel too,
# and Atlas Local's search indexes and the search engines through the
# server's routes.
test-live: testdb-engines
	$(TESTDB_ENV) $(CARGO) test -p tablepeek-engine $(if $(filter mongodb-rs mongodb-atlas elasticsearch elasticsearch-tls opensearch clickhouse oracle,$(ENGINE)),-p tablepeek-server) $(TESTDB_FEATURES) -- --test-threads=1

linux-image:
	printf '%s\n' 'FROM rust:1-bookworm' \
		'RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libdbus-1-dev libkrb5-dev libclang-dev pkg-config krb5-user && rm -rf /var/lib/apt/lists/*' \
		| docker build -q -t $(LINUX_IMAGE) -

build-kerberos-linux: web linux-image
	$(LINUX_RUN) $(LINUX_IMAGE) cargo build --release -p tablepeek --features kerberos

# The test servers listen on the host's 127.0.0.1, which the container
# shares (Docker Desktop: Settings > Resources > Network > host networking).
test-live-linux: testdb-engines web linux-image
	$(LINUX_RUN) --network host $(foreach var,$(TESTDB_ENV),-e $(var)) $(LINUX_IMAGE) \
		cargo test -p tablepeek-engine $(if $(filter mongodb-rs mongodb-atlas,$(ENGINE)),-p tablepeek-server) $(TESTDB_FEATURES) -- --test-threads=1

# The Oracle driver's out-of-band break (crates/vendor/oracledb), from a
# container on the test network: Docker Desktop's port forwarding drops TCP
# urgent data. The server takes out-of-band breaks for the while (its image
# sets DISABLE_OOB=ON).
ORACLE_SQLNET := docker compose -f testdb/compose.yml --profile oracle exec -T oracle bash -c
test-oracle-oob: linux-image
	$(ORACLE_SQLNET) 'sed -i "s/^DISABLE_OOB=ON/#DISABLE_OOB=ON/" $$ORACLE_HOME/network/admin/sqlnet.ora'
	$(LINUX_RUN) --network tablepeek-testdb_default -e TABLEPEEK_ORACLE_OOB=oracle $(LINUX_IMAGE) \
		cargo test --manifest-path crates/vendor/oracledb/Cargo.toml --test tablepeek_break; \
		status=$$?; \
		$(ORACLE_SQLNET) 'sed -i "s/^#DISABLE_OOB=ON/DISABLE_OOB=ON/" $$ORACLE_HOME/network/admin/sqlnet.ora'; \
		exit $$status

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
