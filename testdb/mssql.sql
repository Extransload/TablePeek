-- The rows the SQL Server engine tests read: 5,000 users and 20,000 orders.
-- `make test-db` runs it on every start, so it only adds what is missing.
IF DB_ID(N'tablepeek_test') IS NULL
    CREATE DATABASE tablepeek_test;
GO

USE tablepeek_test;
GO

IF OBJECT_ID(N'dbo.users', N'U') IS NULL
BEGIN
    -- The tests expect name to be NOT NULL.
    CREATE TABLE users (id INT PRIMARY KEY, name NVARCHAR(50) NOT NULL, score DECIMAL(10, 2), created_at DATETIME2);
    WITH n AS (
        SELECT TOP (5000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i
        FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b
    )
    INSERT INTO users
    SELECT i, N'사용자_' + CAST(i AS NVARCHAR(10)), i * 1.5, DATEADD(MINUTE, i, '2024-01-01') FROM n;
END
GO

IF OBJECT_ID(N'dbo.orders', N'U') IS NULL
BEGIN
    CREATE TABLE orders (id INT PRIMARY KEY, user_id INT, amount DECIMAL(10, 2));
    WITH n AS (
        SELECT TOP (20000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i
        FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b
    )
    INSERT INTO orders SELECT i, (i % 5000) + 1, i * 0.5 FROM n;
END
GO
