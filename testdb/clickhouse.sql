-- What the ClickHouse engine tests start from (crates/tablepeek-engine/src/
-- engines/clickhouse/tests.rs). They make and drop their own tables too, in
-- tablepeek_test only. Runs once, when the container is first created.
CREATE DATABASE IF NOT EXISTS tablepeek_test;

CREATE TABLE tablepeek_test.kinds
(
    id UInt32,
    name String,
    nickname Nullable(String),
    tier LowCardinality(String),
    status Enum8('new' = 1, 'done' = 2),
    amount Decimal(12, 2),
    ratio Float64,
    big UInt64,
    tags Array(String),
    attrs Map(String, String),
    pair Tuple(a UInt8, b String),
    happened DateTime64(3, 'UTC'),
    day Date,
    uid UUID,
    ip4 IPv4,
    ip6 IPv6,
    flag Bool
)
ENGINE = MergeTree
ORDER BY id;

INSERT INTO tablepeek_test.kinds VALUES
    (1, 'one', NULL, 'free', 'new', 10.50, 0.25, 18446744073709551615, ['a', 'b'], {'k': 'v'}, (1, 'x'),
     '2024-01-02 03:04:05.678', '2024-01-02', '00000000-0000-0000-0000-000000000001', '10.0.0.1', '::1', true),
    (2, 'two', 'Deux', 'pro', 'done', 0.00, -1.5, 2, [], {}, (2, 'y'),
     '2024-02-03 04:05:06.000', '2024-02-03', '00000000-0000-0000-0000-000000000002', '192.168.0.2', '2001:db8::2', false);

CREATE VIEW tablepeek_test.kinds_view AS SELECT id, name FROM tablepeek_test.kinds;
