-- The rows the PostgreSQL engine tests read: 5,000 users and 20,000 orders.
-- Runs once, when the container is first created.
CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(50), score NUMERIC(10, 2), active BOOLEAN);
INSERT INTO users SELECT i, '사용자_' || i, i * 1.5, i % 2 = 0 FROM generate_series(1, 5000) AS g(i);

CREATE TABLE orders (id INT PRIMARY KEY, user_id INT, amount NUMERIC(10, 2));
INSERT INTO orders SELECT i, (i % 5000) + 1, i * 0.5 FROM generate_series(1, 20000) AS g(i);
