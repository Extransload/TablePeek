-- Cassandra: the test login and the keyspaces the shop sample and the
-- engine tests use. Run by `make test-db ENGINE=cassandra` as the default
-- superuser, before cassandra-shop.cql.
CREATE ROLE IF NOT EXISTS tablepeek WITH PASSWORD = 'tablepeek_test_pw' AND LOGIN = true AND SUPERUSER = true;
CREATE KEYSPACE IF NOT EXISTS shop WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};
CREATE KEYSPACE IF NOT EXISTS tablepeek_test WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};
