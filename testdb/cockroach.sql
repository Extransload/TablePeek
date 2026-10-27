-- The rows the CockroachDB engine tests read: 5,000 users and 20,000 orders.
-- `make test-db` runs it on every start, so it only adds what is missing.
CREATE TABLE IF NOT EXISTS users (id INT PRIMARY KEY, name VARCHAR(50), score DECIMAL(10, 2), created_at TIMESTAMP);
INSERT INTO users
SELECT i, '사용자_' || i::STRING, i * 1.5, '2024-01-01 00:00:00'::TIMESTAMP + (i || ' minutes')::INTERVAL
FROM generate_series(1, 5000) AS g(i)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS orders (id INT PRIMARY KEY, user_id INT, amount DECIMAL(10, 2));
INSERT INTO orders
SELECT i, (i % 5000) + 1, i * 0.5 FROM generate_series(1, 20000) AS g(i)
ON CONFLICT (id) DO NOTHING;
