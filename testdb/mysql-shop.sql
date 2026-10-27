-- A sample shop in its own database (switch to `shop` in TablePeek), for
-- trying the app on something like a real database: foreign keys (a
-- self-reference, composite and text keys, CASCADE and SET NULL), ENUM,
-- JSON, BLOB, a case-sensitive column, a table without a primary key,
-- awkward names, views, a function, a procedure and a trigger. The engine
-- tests don't read it. Runs once, when the container is first created.
SET NAMES utf8mb4;
SET SESSION cte_max_recursion_depth = 30000;

CREATE DATABASE shop CHARACTER SET utf8mb4;
USE shop;

CREATE TABLE categories (
    id INT PRIMARY KEY,
    parent_id INT NULL,
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(100) NOT NULL UNIQUE,
    CONSTRAINT categories_parent FOREIGN KEY (parent_id) REFERENCES categories (id) ON DELETE SET NULL
) COMMENT = 'Product categories; parent_id makes a tree';

CREATE TABLE customers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    full_name VARCHAR(100) NOT NULL,
    country CHAR(2),
    tier ENUM('free', 'pro', 'enterprise') NOT NULL DEFAULT 'free',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    preferences JSON,
    signed_up_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    note TEXT
);

CREATE TABLE products (
    id INT PRIMARY KEY,
    category_id INT NOT NULL,
    sku VARCHAR(20) NOT NULL UNIQUE,
    name VARCHAR(200) NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    stock INT NOT NULL DEFAULT 0,
    tags JSON,
    attributes JSON,
    thumbnail VARBINARY(16),
    released_on DATE,
    discontinued BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT products_price CHECK (price >= 0),
    CONSTRAINT products_category FOREIGN KEY (category_id) REFERENCES categories (id),
    INDEX products_category_idx (category_id)
);

-- A text primary key, which other tables point at.
CREATE TABLE coupons (
    code VARCHAR(16) PRIMARY KEY,
    discount_pct INT NOT NULL,
    expires_on DATE,
    max_uses INT,
    CONSTRAINT coupons_discount CHECK (discount_pct BETWEEN 1 AND 100)
);

CREATE TABLE orders (
    id BIGINT PRIMARY KEY,
    customer_id INT NOT NULL,
    status ENUM('pending', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded') NOT NULL DEFAULT 'pending',
    ordered_at DATETIME NOT NULL,
    shipped_at DATETIME,
    shipping_address JSON,
    coupon_code VARCHAR(16),
    -- Case-sensitive, unlike the rest of the database.
    tracking_no VARCHAR(20) COLLATE utf8mb4_bin,
    CONSTRAINT orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id),
    CONSTRAINT orders_coupon FOREIGN KEY (coupon_code) REFERENCES coupons (code) ON UPDATE CASCADE,
    INDEX orders_customer_recent (customer_id, ordered_at DESC),
    INDEX orders_status (status)
);

CREATE TABLE order_items (
    order_id BIGINT NOT NULL,
    line_no SMALLINT NOT NULL,
    product_id INT NOT NULL,
    quantity INT NOT NULL,
    unit_price DECIMAL(10, 2) NOT NULL,
    PRIMARY KEY (order_id, line_no),
    CONSTRAINT order_items_quantity CHECK (quantity > 0),
    CONSTRAINT order_items_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
    CONSTRAINT order_items_product FOREIGN KEY (product_id) REFERENCES products (id)
);

CREATE TABLE reviews (
    id INT PRIMARY KEY,
    product_id INT NOT NULL,
    customer_id INT,
    rating TINYINT NOT NULL,
    title VARCHAR(200),
    body TEXT,
    created_at DATETIME NOT NULL,
    CONSTRAINT reviews_rating CHECK (rating BETWEEN 1 AND 5),
    CONSTRAINT reviews_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
    CONSTRAINT reviews_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE SET NULL,
    INDEX reviews_product_rating (product_id, rating),
    FULLTEXT INDEX reviews_body (body)
);

CREATE TABLE audit_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    table_name VARCHAR(64) NOT NULL,
    row_id BIGINT NOT NULL,
    action VARCHAR(32) NOT NULL,
    changed_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    detail JSON
);

-- No primary key: TablePeek reads it but won't edit rows it can't single out.
CREATE TABLE page_views (
    viewed_at DATETIME NOT NULL,
    path VARCHAR(255) NOT NULL,
    customer_id INT,
    referrer VARCHAR(255),
    duration_ms INT
);

-- Names and values that need quoting or escaping.
CREATE TABLE `Edge Cases` (
    id INT PRIMARY KEY,
    `Mixed Case` TEXT,
    `한글 컬럼` TEXT,
    `with space` TEXT,
    `back``tick` TEXT,
    big_number DECIMAL(38, 10),
    tiny_real FLOAT,
    happened_on DATE,
    happened_at DATETIME(3),
    payload JSON,
    raw VARBINARY(16)
);

INSERT INTO categories (id, parent_id, name, slug) VALUES
    (1, NULL, '전자제품', 'electronics'),
    (2, NULL, '도서', 'books'),
    (3, NULL, '패션', 'fashion'),
    (4, NULL, '홈·리빙', 'home'),
    (5, NULL, 'Sports & Outdoors', 'sports'),
    (6, NULL, 'Toys', 'toys');
INSERT INTO categories (id, parent_id, name, slug)
WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 18)
SELECT 6 + i, 1 + (i - 1) % 6,
       ELT(i, '노트북', '소설', '신발', '주방', 'Camping', 'Puzzles', '모니터', '경제', '가방',
              '침구', 'Cycling', 'Board Games', '키보드', '에세이', '모자', '조명', 'Running', 'Lego'),
       CONCAT('sub-', i)
FROM n;

INSERT INTO customers (id, email, full_name, country, tier, is_active, preferences, signed_up_at, note)
WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
SELECT i,
       CONCAT('customer', i, '@example.com'),
       CONCAT(ELT(1 + i % 10, '김', '이', '박', '최', '정', '강', '조', '윤', '장', '임'),
              ELT(1 + (i DIV 10) % 10, '민준', '서연', '도윤', '하은', '지호', '서윤', '예준', '지우', '주원', '하린')),
       ELT(1 + i % 10, 'KR', 'KR', 'KR', 'US', 'JP', 'DE', 'GB', 'FR', 'CA', NULL),
       ELT(1 + i % 6, 'free', 'free', 'free', 'pro', 'pro', 'enterprise'),
       i % 23 <> 0,
       CASE WHEN i % 4 = 0 THEN NULL
            ELSE JSON_OBJECT('newsletter', IF(i % 2 = 0, CAST('true' AS JSON), CAST('false' AS JSON)), 'theme', ELT(1 + i % 2, 'light', 'dark'),
                             'langs', IF(i % 3 = 0, JSON_ARRAY('ko', 'en'), JSON_ARRAY('ko')))
       END,
       TIMESTAMP '2023-01-01 09:00:00' + INTERVAL (i * 1013 % 900) DAY + INTERVAL (i % 86400) SECOND,
       IF(i % 50 = 0, 'VIP: 연락 전 확인', NULL)
FROM n;
-- A few customers whose text needs care.
UPDATE customers SET full_name = 'O''Brien "Danny" \\ 백슬래시', note = '여러 줄\n메모\t탭' WHERE id = 7;
UPDATE customers SET full_name = '이모지 😀 고객', email = 'Emoji.Customer+tag@Example.com' WHERE id = 8;
UPDATE customers SET note = REPEAT('아주 긴 메모 ', 400) WHERE id = 9;

INSERT INTO products (id, category_id, sku, name, price, stock, tags, attributes, thumbnail, released_on, discontinued)
WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400)
SELECT i,
       7 + i % 18,
       CONCAT('SKU-', LPAD(i, 5, '0')),
       CONCAT(ELT(1 + i % 6, '무선', 'Pro', '미니', 'Ultra', '클래식', 'Eco'), ' ',
              ELT(1 + (i DIV 6) % 8, '마우스', 'Keyboard', '텀블러', 'Backpack', '램프', 'Sneakers', '노트', 'Tent'),
              ' ', i),
       ROUND(((i * 7919) % 50000) / 100.0 + 1, 2),
       (i * 37) % 250,
       CASE i % 5 WHEN 0 THEN NULL WHEN 1 THEN JSON_ARRAY('new') WHEN 2 THEN JSON_ARRAY('sale', 'best')
                  WHEN 3 THEN JSON_ARRAY() ELSE JSON_ARRAY('limited', '한정판') END,
       JSON_OBJECT('color', ELT(1 + i % 4, 'black', 'white', 'red', 'navy'),
                   'weight_g', 100 + (i * 13) % 900,
                   'dimensions', JSON_OBJECT('w', 10 + i % 30, 'h', 5 + i % 20)),
       IF(i % 3 = 0, UNHEX(MD5(i)), NULL),
       DATE '2022-01-01' + INTERVAL ((i * 3) % 1200) DAY,
       i % 41 = 0
FROM n;

INSERT INTO coupons (code, discount_pct, expires_on, max_uses) VALUES
    ('WELCOME10', 10, NULL, NULL),
    ('VIP-20', 20, '2026-12-31', 500),
    ('SUMMER25', 25, '2025-08-31', 1000),
    ('it''s-5', 5, NULL, 1),
    ('쿠폰-한글', 15, '2026-01-01', NULL);

INSERT INTO orders (id, customer_id, status, ordered_at, shipped_at, shipping_address, coupon_code, tracking_no)
WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 6000)
SELECT i,
       1 + (i * 7) % 1000,
       ELT(1 + i % 10, 'delivered', 'delivered', 'delivered', 'shipped', 'paid', 'paid',
                       'pending', 'cancelled', 'refunded', 'delivered'),
       TIMESTAMP '2025-01-01 00:00:00' + INTERVAL (i * 97 % 525600) MINUTE,
       IF(1 + i % 10 IN (1, 2, 3, 4, 10),
          TIMESTAMP '2025-01-01 00:00:00' + INTERVAL (i * 97 % 525600) MINUTE + INTERVAL (1 + i % 5) DAY, NULL),
       JSON_OBJECT('city', ELT(1 + i % 5, '서울', '부산', 'Seattle', '東京', 'Berlin'),
                   'zip', LPAD((i * 31) % 99999, 5, '0')),
       CASE WHEN i % 9 = 0 THEN 'WELCOME10' WHEN i % 13 = 0 THEN 'VIP-20' END,
       IF(i % 2 = 0, CONCAT(IF(i % 4 = 0, 'TRK', 'trk'), LPAD(i, 8, '0')), NULL)
FROM n;

INSERT INTO order_items (order_id, line_no, product_id, quantity, unit_price)
WITH RECURSIVE l (line_no) AS (SELECT 1 UNION ALL SELECT line_no + 1 FROM l WHERE line_no < 4)
SELECT o.id, l.line_no, p.id, 1 + (o.id + l.line_no) % 5, p.price
FROM orders AS o
CROSS JOIN l
JOIN products AS p ON p.id = 1 + (o.id * 13 + l.line_no * 31) % 400
WHERE l.line_no <= 1 + o.id % 4;

INSERT INTO reviews (id, product_id, customer_id, rating, title, body, created_at)
WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2500)
SELECT i,
       1 + (i * 11) % 400,
       IF(i % 17 = 0, NULL, 1 + (i * 3) % 1000),
       1 + (i * 3) % 5,
       ELT(1 + i % 5, '최고예요', '그저 그래요', 'Not bad', '배송이 빨라요', NULL),
       IF(i % 7 = 0, NULL, CONCAT('리뷰 본문 ', i, '\n두 번째 줄')),
       TIMESTAMP '2025-02-01 00:00:00' + INTERVAL (i * 211 % 400000) MINUTE
FROM n;

INSERT INTO page_views (viewed_at, path, customer_id, referrer, duration_ms)
WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
SELECT TIMESTAMP '2025-06-01 00:00:00' + INTERVAL (i * 17) SECOND,
       ELT(1 + i % 5, '/', '/products', CONCAT('/products/', 1 + i % 400), '/cart', '/checkout'),
       IF(i % 3 = 0, NULL, 1 + i % 1000),
       ELT(1 + i % 4, NULL, 'https://www.google.com/', 'https://naver.com/', 'newsletter'),
       50 + (i * 53) % 20000
FROM n;
-- Identical rows, so no column singles one out.
INSERT INTO page_views SELECT * FROM (SELECT * FROM page_views WHERE duration_ms < 200) AS copy;

INSERT INTO `Edge Cases` VALUES
    (1, 'Mixed', '한글 값', 'a b c', 'say "hi"', 1234567890123456789012345678.1234567890, 3.14, '2024-02-29', '2024-02-29 23:59:59.999', '{"nested": {"array": [1, 2, {"deep": true}]}}', X'00FF10'),
    (2, '', '', ' leading and trailing ', '', -0.0000000001, -1.5e-10, '1970-01-01', '1970-01-01 00:00:00', '[]', X''),
    (3, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    (4, 'it''s', '탭\t줄바꿈\n끝', 'back\\slash', '😀🎉', 9999999999999999999999999999.9999999999, 3.4e38, '9999-12-31', '9999-12-31 23:59:59', '"just a string"', X'DEADBEEF');

CREATE VIEW order_totals AS
SELECT o.id AS order_id, o.customer_id, c.full_name, o.status, o.ordered_at,
       COUNT(oi.line_no) AS items, COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS total
FROM orders AS o
JOIN customers AS c ON c.id = o.customer_id
LEFT JOIN order_items AS oi ON oi.order_id = o.id
GROUP BY o.id, o.customer_id, c.full_name, o.status, o.ordered_at;

CREATE VIEW product_ratings AS
SELECT p.id AS product_id, p.name, cat.name AS category, COUNT(r.id) AS reviews,
       ROUND(AVG(r.rating), 2) AS average_rating
FROM products AS p
JOIN categories AS cat ON cat.id = p.category_id
LEFT JOIN reviews AS r ON r.product_id = p.id
GROUP BY p.id, p.name, cat.name;

DELIMITER //

CREATE FUNCTION customer_lifetime_value(customer INT) RETURNS DECIMAL(12, 2)
READS SQL DATA
BEGIN
    RETURN (
        SELECT COALESCE(SUM(oi.quantity * oi.unit_price), 0)
        FROM orders AS o JOIN order_items AS oi ON oi.order_id = o.id
        WHERE o.customer_id = customer AND o.status NOT IN ('cancelled', 'refunded')
    );
END //

CREATE PROCEDURE mark_shipped(IN target BIGINT)
MODIFIES SQL DATA
BEGIN
    UPDATE orders SET status = 'shipped', shipped_at = NOW() WHERE id = target AND status = 'paid';
END //

CREATE TRIGGER orders_status_audit AFTER UPDATE ON orders
FOR EACH ROW
BEGIN
    IF NOT (OLD.status <=> NEW.status) THEN
        INSERT INTO audit_log (table_name, row_id, action, detail)
        VALUES ('orders', NEW.id, 'status', JSON_OBJECT('from', OLD.status, 'to', NEW.status));
    END IF;
END //

DELIMITER ;

-- Some history for the audit log.
UPDATE orders SET status = 'cancelled' WHERE id % 97 = 0 AND status = 'pending';
CALL mark_shipped(5);

ANALYZE TABLE categories, customers, products, coupons, orders, order_items, reviews, audit_log, page_views, `Edge Cases`;
