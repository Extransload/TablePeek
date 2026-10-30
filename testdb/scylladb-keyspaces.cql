-- ScyllaDB: the test login and the keyspaces the shop sample and the
-- engine tests use. Tablets off: materialized views, counters and
-- lightweight transactions all work on vnode keyspaces in every version.
CREATE ROLE IF NOT EXISTS tablepeek WITH PASSWORD = 'tablepeek_test_pw' AND LOGIN = true AND SUPERUSER = true;
CREATE KEYSPACE IF NOT EXISTS shop WITH replication = {'class': 'NetworkTopologyStrategy', 'replication_factor': 1} AND tablets = {'enabled': false};
CREATE KEYSPACE IF NOT EXISTS tablepeek_test WITH replication = {'class': 'NetworkTopologyStrategy', 'replication_factor': 1} AND tablets = {'enabled': false};
