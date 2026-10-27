-- A sample shop in its own schema, for trying TablePeek on something like a
-- real database: foreign keys (a self-reference, composite and text keys,
-- CASCADE and SET NULL), CHECK lists in place of enums, JSON text, bytes, a
-- table without a primary key, awkward names, views, a function, a
-- procedure and a trigger. The engine tests don't read it.
--
-- `make test-db` runs it on every start: once a run has finished, NOEXEC
-- skips the rest. One that failed halfway leaves the schema half built,
-- which the next run reports.
USE tablepeek_test;
GO

-- sqlcmd starts with QUOTED_IDENTIFIER off, and a filtered index needs it
-- on, both to be built and for every later change to its table.
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

-- The schema's description is set last, so it marks a finished run.
IF EXISTS (SELECT 1 FROM sys.extended_properties
           WHERE class = 3 AND major_id = SCHEMA_ID(N'shop') AND name = N'MS_Description')
    SET NOEXEC ON;
ELSE IF SCHEMA_ID(N'shop') IS NOT NULL
    RAISERROR (N'Schema shop is half built: run make test-db-down ENGINE=mssql, then make test-db again.', 16, 1);
GO

CREATE SCHEMA shop;
GO

CREATE TABLE shop.categories (
    id INT PRIMARY KEY,
    -- SQL Server refuses ON DELETE SET NULL on a self-reference.
    parent_id INT REFERENCES shop.categories (id),
    name NVARCHAR(100) NOT NULL,
    slug VARCHAR(50) NOT NULL UNIQUE
);
EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'Product categories; parent_id makes a tree',
    @level0type = N'SCHEMA', @level0name = N'shop', @level1type = N'TABLE', @level1name = N'categories';

CREATE TABLE shop.customers (
    id INT IDENTITY (1, 1) PRIMARY KEY,
    email NVARCHAR(254) NOT NULL UNIQUE,
    full_name NVARCHAR(200) NOT NULL,
    country CHAR(2),
    tier VARCHAR(10) NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'enterprise')),
    is_active BIT NOT NULL DEFAULT 1,
    preferences NVARCHAR(MAX) CHECK (ISJSON(preferences) = 1),
    signed_up_at DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    note NVARCHAR(MAX)
);

CREATE TABLE shop.products (
    id INT PRIMARY KEY,
    category_id INT NOT NULL REFERENCES shop.categories (id),
    sku VARCHAR(20) NOT NULL UNIQUE,
    name NVARCHAR(200) NOT NULL,
    price DECIMAL(10, 2) NOT NULL CHECK (price >= 0),
    stock INT NOT NULL DEFAULT 0,
    -- A JSON array: SQL Server has no array type.
    tags NVARCHAR(400) CHECK (ISJSON(tags) = 1),
    attributes NVARCHAR(MAX) CHECK (ISJSON(attributes) = 1),
    thumbnail VARBINARY(MAX),
    released_on DATE,
    discontinued BIT NOT NULL DEFAULT 0
);

-- A text primary key, which other tables point at.
CREATE TABLE shop.coupons (
    code NVARCHAR(16) PRIMARY KEY,
    discount_pct INT NOT NULL CHECK (discount_pct BETWEEN 1 AND 100),
    expires_on DATE,
    max_uses INT
);

CREATE TABLE shop.orders (
    id BIGINT PRIMARY KEY,
    customer_id INT NOT NULL REFERENCES shop.customers (id),
    status VARCHAR(10) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded')),
    ordered_at DATETIMEOFFSET NOT NULL,
    shipped_at DATETIMEOFFSET,
    shipping_address NVARCHAR(MAX) CHECK (ISJSON(shipping_address) = 1),
    coupon_code NVARCHAR(16) REFERENCES shop.coupons (code) ON UPDATE CASCADE
);

CREATE TABLE shop.order_items (
    order_id BIGINT NOT NULL REFERENCES shop.orders (id) ON DELETE CASCADE,
    line_no SMALLINT NOT NULL,
    product_id INT NOT NULL REFERENCES shop.products (id),
    quantity INT NOT NULL CHECK (quantity > 0),
    unit_price DECIMAL(10, 2) NOT NULL,
    PRIMARY KEY (order_id, line_no)
);

CREATE TABLE shop.reviews (
    id INT PRIMARY KEY,
    product_id INT NOT NULL REFERENCES shop.products (id) ON DELETE CASCADE,
    customer_id INT REFERENCES shop.customers (id) ON DELETE SET NULL,
    rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    title NVARCHAR(200),
    body NVARCHAR(MAX),
    created_at DATETIMEOFFSET NOT NULL
);

CREATE TABLE shop.audit_log (
    id BIGINT IDENTITY (1, 1) PRIMARY KEY,
    table_name VARCHAR(64) NOT NULL,
    row_id BIGINT NOT NULL,
    action VARCHAR(16) NOT NULL,
    changed_at DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    detail NVARCHAR(MAX) CHECK (ISJSON(detail) = 1)
);

-- No primary key: a heap.
CREATE TABLE shop.page_views (
    viewed_at DATETIMEOFFSET NOT NULL,
    path NVARCHAR(200) NOT NULL,
    customer_id INT,
    referrer NVARCHAR(200),
    duration_ms INT
);

-- Names and values that need quoting or escaping, and a few types only SQL
-- Server has.
CREATE TABLE shop.[Edge Cases] (
    id INT PRIMARY KEY,
    [Mixed Case] NVARCHAR(100),
    [한글 컬럼] NVARCHAR(100),
    [with space] NVARCHAR(100),
    [bracket]]inside] NVARCHAR(100),
    big_number DECIMAL(38, 10),
    tiny_real REAL,
    happened_on DATE,
    happened_at DATETIMEOFFSET,
    payload NVARCHAR(MAX) CHECK (ISJSON(payload, VALUE) = 1),
    raw VARBINARY(100),
    guid UNIQUEIDENTIFIER,
    amount MONEY,
    doc XML
);

CREATE INDEX orders_customer_recent ON shop.orders (customer_id, ordered_at DESC);
CREATE INDEX orders_open ON shop.orders (status) WHERE status IN ('pending', 'paid');
CREATE INDEX products_category ON shop.products (category_id);
CREATE INDEX reviews_product_rating ON shop.reviews (product_id, rating);
GO

INSERT INTO shop.categories (id, parent_id, name, slug) VALUES
    (1, NULL, N'전자제품', 'electronics'),
    (2, NULL, N'도서', 'books'),
    (3, NULL, N'패션', 'fashion'),
    (4, NULL, N'홈·리빙', 'home'),
    (5, NULL, N'Sports & Outdoors', 'sports'),
    (6, NULL, N'Toys', 'toys');
WITH n AS (SELECT TOP (18) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i FROM sys.all_objects)
INSERT INTO shop.categories (id, parent_id, name, slug)
SELECT 6 + i, 1 + (i - 1) % 6,
       CHOOSE(i, N'노트북', N'소설', N'신발', N'주방', N'Camping', N'Puzzles',
                 N'모니터', N'경제', N'가방', N'침구', N'Cycling', N'Board Games',
                 N'키보드', N'에세이', N'모자', N'조명', N'Running', N'Lego'),
       'sub-' + CAST(i AS VARCHAR(10))
FROM n;

-- Explicit ids; the identity carries on from 1001 afterwards.
SET IDENTITY_INSERT shop.customers ON;
WITH n AS (
    SELECT TOP (1000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i
    FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b
)
INSERT INTO shop.customers (id, email, full_name, country, tier, is_active, preferences, signed_up_at, note)
SELECT i,
       'customer' + CAST(i AS VARCHAR(10)) + '@example.com',
       CHOOSE(1 + i % 10, N'김', N'이', N'박', N'최', N'정', N'강', N'조', N'윤', N'장', N'임')
           + CHOOSE(1 + (i / 10) % 10, N'민준', N'서연', N'도윤', N'하은', N'지호', N'서윤', N'예준', N'지우', N'주원', N'하린'),
       CHOOSE(1 + i % 10, 'KR', 'KR', 'KR', 'US', 'JP', 'DE', 'GB', 'FR', 'CA', NULL),
       CHOOSE(1 + i % 6, 'free', 'free', 'free', 'pro', 'pro', 'enterprise'),
       CASE WHEN i % 23 <> 0 THEN 1 ELSE 0 END,
       CASE WHEN i % 4 <> 0 THEN
           JSON_OBJECT('newsletter': CAST(CASE WHEN i % 2 = 0 THEN 1 ELSE 0 END AS BIT),
                       'theme': CHOOSE(1 + i % 2, 'light', 'dark'),
                       'langs': JSON_QUERY(CASE WHEN i % 3 = 0 THEN '["ko","en"]' ELSE '["ko"]' END))
       END,
       TODATETIMEOFFSET(DATEADD(SECOND, i % 86400, DATEADD(DAY, (i * 1013) % 900, CAST('2023-01-01 09:00:00' AS DATETIME2))), '+09:00'),
       CASE WHEN i % 50 = 0 THEN N'VIP: 연락 전 확인' END
FROM n;
SET IDENTITY_INSERT shop.customers OFF;
-- A few customers whose text needs care.
UPDATE shop.customers SET full_name = N'O''Brien "Danny" \ 백슬래시', note = N'여러 줄' + NCHAR(10) + N'메모' + NCHAR(9) + N'탭' WHERE id = 7;
UPDATE shop.customers SET full_name = N'이모지 😀 고객', email = 'Emoji.Customer+tag@Example.com' WHERE id = 8;
UPDATE shop.customers SET note = REPLICATE(CAST(N'아주 긴 메모 ' AS NVARCHAR(MAX)), 400) WHERE id = 9;

WITH n AS (
    SELECT TOP (400) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i
    FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b
)
INSERT INTO shop.products (id, category_id, sku, name, price, stock, tags, attributes, thumbnail, released_on, discontinued)
SELECT i,
       7 + i % 18,
       'SKU-' + RIGHT('00000' + CAST(i AS VARCHAR(10)), 5),
       CHOOSE(1 + i % 6, N'무선', N'Pro', N'미니', N'Ultra', N'클래식', N'Eco') + N' '
           + CHOOSE(1 + (i / 6) % 8, N'마우스', N'Keyboard', N'텀블러', N'Backpack', N'램프', N'Sneakers', N'노트', N'Tent')
           + N' ' + CAST(i AS NVARCHAR(10)),
       ROUND(((i * 7919) % 50000) / 100.0 + 1, 2),
       (i * 37) % 250,
       CASE i % 5 WHEN 0 THEN NULL WHEN 1 THEN N'["new"]' WHEN 2 THEN N'["sale","best"]'
                  WHEN 3 THEN N'[]' ELSE N'["limited","한정판"]' END,
       JSON_OBJECT('color': CHOOSE(1 + i % 4, 'black', 'white', 'red', 'navy'),
                   'weight_g': 100 + (i * 13) % 900,
                   'dimensions': JSON_OBJECT('w': 10 + i % 30, 'h': 5 + i % 20)),
       CASE WHEN i % 3 = 0 THEN HASHBYTES('MD5', CAST(i AS VARCHAR(10))) END,
       DATEADD(DAY, (i * 3) % 1200, CAST('2022-01-01' AS DATE)),
       CASE WHEN i % 41 = 0 THEN 1 ELSE 0 END
FROM n;

INSERT INTO shop.coupons (code, discount_pct, expires_on, max_uses) VALUES
    (N'WELCOME10', 10, NULL, NULL),
    (N'VIP-20', 20, '2026-12-31', 500),
    (N'SUMMER25', 25, '2025-08-31', 1000),
    (N'it''s-5', 5, NULL, 1),
    (N'쿠폰-한글', 15, '2026-01-01', NULL);

WITH n AS (
    SELECT TOP (6000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i
    FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b
)
INSERT INTO shop.orders (id, customer_id, status, ordered_at, shipped_at, shipping_address, coupon_code)
SELECT i,
       1 + (i * 7) % 1000,
       v.status,
       v.ordered_at,
       CASE WHEN v.status IN ('shipped', 'delivered') THEN DATEADD(DAY, 1 + i % 5, v.ordered_at) END,
       JSON_OBJECT('city': CHOOSE(1 + i % 5, N'서울', N'부산', N'Seattle', N'東京', N'Berlin'),
                   'zip': RIGHT('00000' + CAST((i * 31) % 99999 AS VARCHAR(10)), 5)),
       CASE WHEN i % 9 = 0 THEN N'WELCOME10' WHEN i % 13 = 0 THEN N'VIP-20' END
FROM n
CROSS APPLY (SELECT CHOOSE(1 + i % 10, 'delivered', 'delivered', 'delivered', 'shipped', 'paid', 'paid',
                                       'pending', 'cancelled', 'refunded', 'delivered') AS status,
                    TODATETIMEOFFSET(DATEADD(MINUTE, (i * 97) % 525600, CAST('2025-01-01' AS DATETIME2)), '+09:00') AS ordered_at) AS v;

WITH l AS (SELECT TOP (4) CAST(ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS SMALLINT) AS line_no FROM sys.all_objects)
INSERT INTO shop.order_items (order_id, line_no, product_id, quantity, unit_price)
SELECT o.id, l.line_no, p.id, 1 + (o.id + l.line_no) % 5, p.price
FROM shop.orders AS o
CROSS JOIN l
JOIN shop.products AS p ON p.id = 1 + (o.id * 13 + l.line_no * 31) % 400
WHERE l.line_no <= 1 + o.id % 4;

WITH n AS (
    SELECT TOP (2500) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i
    FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b
)
INSERT INTO shop.reviews (id, product_id, customer_id, rating, title, body, created_at)
SELECT i,
       1 + (i * 11) % 400,
       CASE WHEN i % 17 = 0 THEN NULL ELSE 1 + (i * 3) % 1000 END,
       1 + (i * 3) % 5,
       CHOOSE(1 + i % 5, N'최고예요', N'그저 그래요', N'Not bad', N'배송이 빨라요', NULL),
       CASE WHEN i % 7 <> 0 THEN N'리뷰 본문 ' + CAST(i AS NVARCHAR(10)) + NCHAR(10) + N'두 번째 줄' END,
       TODATETIMEOFFSET(DATEADD(MINUTE, (i * 211) % 400000, CAST('2025-02-01' AS DATETIME2)), '+09:00')
FROM n;

WITH n AS (
    SELECT TOP (3000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i
    FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b
), v AS (
    SELECT TODATETIMEOFFSET(DATEADD(SECOND, i * 17, CAST('2025-06-01' AS DATETIME2)), '+09:00') AS viewed_at,
           CHOOSE(1 + i % 5, N'/', N'/products', N'/products/' + CAST(1 + i % 400 AS NVARCHAR(10)), N'/cart', N'/checkout') AS path,
           CASE WHEN i % 3 <> 0 THEN 1 + i % 1000 END AS customer_id,
           CHOOSE(1 + i % 4, NULL, N'https://www.google.com/', N'https://naver.com/', N'newsletter') AS referrer,
           50 + (i * 53) % 20000 AS duration_ms
    FROM n
)
INSERT INTO shop.page_views (viewed_at, path, customer_id, referrer, duration_ms)
SELECT v.viewed_at, v.path, v.customer_id, v.referrer, v.duration_ms
FROM v
-- Rows that come out short are seeded twice, so they're identical.
CROSS JOIN (VALUES (1), (2)) AS copy(n)
WHERE copy.n = 1 OR v.duration_ms < 200;

INSERT INTO shop.[Edge Cases]
    (id, [Mixed Case], [한글 컬럼], [with space], [bracket]]inside], big_number, tiny_real,
     happened_on, happened_at, payload, raw, guid, amount, doc)
VALUES
    (1, N'Mixed', N'한글 값', N'a b c', N'say "hi"', 1234567890123456789012345678.1234567890, 3.14,
     '2024-02-29', '2024-02-29 23:59:59.999 +09:00', N'{"nested": {"array": [1, 2, {"deep": true}]}}', 0x00FF10,
     '6F9619FF-8B86-D011-B42D-00C04FC964FF', 1234.5678, N'<item id="1"><name>한글</name></item>'),
    (2, N'', N'', N' leading and trailing ', N'', -0.0000000001, -1.5e-10,
     '1970-01-01', '1970-01-01 00:00:00 +00:00', N'[]', 0x,
     '00000000-0000-0000-0000-000000000000', 0, N''),
    (3, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    (4, N'it''s', N'탭' + NCHAR(9) + N'줄바꿈' + NCHAR(10) + N'끝', N'back\slash', N'😀🎉', 9999999999999999999999999999.9999999999, 3.4e38,
     '9999-12-31', '9999-12-31 23:59:59 +00:00', N'"just a string"', 0xDEADBEEF,
     NEWID(), -922337203685477.5808, N'<root><![CDATA[a < b & c]]></root>');
GO

CREATE VIEW shop.order_totals AS
SELECT o.id AS order_id, o.customer_id, c.full_name, o.status, o.ordered_at,
       COUNT(oi.line_no) AS items, COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS total
FROM shop.orders AS o
JOIN shop.customers AS c ON c.id = o.customer_id
LEFT JOIN shop.order_items AS oi ON oi.order_id = o.id
GROUP BY o.id, o.customer_id, c.full_name, o.status, o.ordered_at;
GO

CREATE VIEW shop.product_ratings AS
SELECT p.id AS product_id, p.name, cat.name AS category, COUNT(r.id) AS reviews,
       ROUND(AVG(CAST(r.rating AS DECIMAL(5, 2))), 2) AS average_rating
FROM shop.products AS p
JOIN shop.categories AS cat ON cat.id = p.category_id
LEFT JOIN shop.reviews AS r ON r.product_id = p.id
GROUP BY p.id, p.name, cat.name;
GO

CREATE FUNCTION shop.customer_lifetime_value (@customer INT) RETURNS DECIMAL(12, 2)
AS
BEGIN
    RETURN (
        SELECT COALESCE(SUM(oi.quantity * oi.unit_price), 0)
        FROM shop.orders AS o JOIN shop.order_items AS oi ON oi.order_id = o.id
        WHERE o.customer_id = @customer AND o.status NOT IN ('cancelled', 'refunded')
    );
END;
GO

CREATE PROCEDURE shop.mark_shipped @target BIGINT
AS
    UPDATE shop.orders SET status = 'shipped', shipped_at = SYSDATETIMEOFFSET() WHERE id = @target AND status = 'paid';
GO

CREATE TRIGGER shop.orders_status_audit ON shop.orders AFTER UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    INSERT INTO shop.audit_log (table_name, row_id, action, detail)
    SELECT 'orders', i.id, 'status', JSON_OBJECT('from': d.status, 'to': i.status)
    FROM inserted AS i JOIN deleted AS d ON d.id = i.id
    WHERE d.status <> i.status;
END;
GO

-- Some history for the audit log.
UPDATE shop.orders SET status = 'cancelled' WHERE id % 97 = 0 AND status = 'pending';
EXEC shop.mark_shipped 5;
GO

-- Last, so it marks a finished run (see the top).
EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'Sample shop for trying TablePeek',
    @level0type = N'SCHEMA', @level0name = N'shop';
GO

SET NOEXEC OFF;
GO
