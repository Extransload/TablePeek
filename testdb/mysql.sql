-- The rows the MySQL engine tests read: 5,000 users and 20,000 orders.
-- Runs once, when the container is first created.
SET NAMES utf8mb4;
SET SESSION cte_max_recursion_depth = 30000;

CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(50), score DECIMAL(10, 2), created_at DATETIME);
INSERT INTO users
WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
SELECT i, CONCAT('사용자_', i), i * 1.5, '2024-01-01 00:00:00' + INTERVAL i MINUTE FROM n;

CREATE TABLE orders (id INT PRIMARY KEY, user_id INT, amount DECIMAL(10, 2));
INSERT INTO orders
WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
SELECT i, (i % 5000) + 1, i * 0.5 FROM n;
