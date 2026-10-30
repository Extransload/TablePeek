-- A sample shop in its own database (switch to `shop` in TablePeek), for
-- trying the app on something like a real ClickHouse database: the
-- MergeTree family (Replacing, Summing, Aggregating) with ORDER BY,
-- PARTITION BY, TTL and a data skipping index, LowCardinality, Nullable,
-- Enum, Decimal, Array, Map, Tuple, DateTime64, UUID, IPv4 and IPv6, a
-- view, a materialized view feeding a SummingMergeTree, a dictionary, and
-- awkward names. The engine tests don't read it. Runs once, when the
-- container is first created.
CREATE DATABASE shop COMMENT 'Sample shop';

CREATE TABLE shop.categories
(
    id UInt16,
    parent_id Nullable(UInt16),
    name String,
    slug String
)
ENGINE = MergeTree
ORDER BY id
COMMENT 'Product categories; parent_id makes a tree';

CREATE TABLE shop.customers
(
    id UInt32,
    email String,
    full_name String,
    country LowCardinality(FixedString(2)),
    tier Enum8('free' = 1, 'pro' = 2, 'enterprise' = 3) DEFAULT 'free',
    is_active Bool DEFAULT true,
    preferences Map(String, String),
    signed_up_at DateTime64(6, 'UTC') DEFAULT now64(6),
    note Nullable(String),
    version UInt32 DEFAULT 1 COMMENT 'ReplacingMergeTree keeps the highest'
)
ENGINE = ReplacingMergeTree(version)
ORDER BY id;

CREATE TABLE shop.products
(
    id UInt32,
    category_id UInt16,
    sku String,
    name String,
    price Decimal(10, 2),
    stock Int32 DEFAULT 0,
    tags Array(LowCardinality(String)),
    attributes Map(String, String),
    dimensions Tuple(width_mm UInt16, height_mm UInt16, depth_mm UInt16),
    released_on Nullable(Date),
    discontinued Bool DEFAULT false,
    INDEX products_sku sku TYPE bloom_filter GRANULARITY 4
)
ENGINE = MergeTree
ORDER BY (category_id, id);

CREATE TABLE shop.orders
(
    id UInt64,
    order_uuid UUID DEFAULT generateUUIDv4(),
    customer_id UInt32,
    status Enum8('pending' = 1, 'paid' = 2, 'shipped' = 3, 'delivered' = 4, 'cancelled' = 5, 'refunded' = 6),
    ordered_at DateTime('UTC'),
    shipped_at Nullable(DateTime('UTC')),
    shipping_address Tuple(city String, zip String),
    coupon_code LowCardinality(Nullable(String)),
    total Decimal(12, 2)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ordered_at)
ORDER BY (customer_id, ordered_at, id)
TTL ordered_at + INTERVAL 10 YEAR
SETTINGS index_granularity = 8192;

CREATE TABLE shop.order_items
(
    order_id UInt64,
    line_no UInt8,
    product_id UInt32,
    quantity UInt16,
    unit_price Decimal(10, 2)
)
ENGINE = MergeTree
ORDER BY (order_id, line_no);

CREATE TABLE shop.page_views
(
    viewed_at DateTime64(3, 'UTC'),
    path String,
    customer_id Nullable(UInt32),
    referrer Nullable(String),
    duration_ms UInt32,
    client_ip IPv4,
    client_ip6 IPv6
)
ENGINE = MergeTree
PARTITION BY toDate(viewed_at)
ORDER BY (path, viewed_at)
TTL toDateTime(viewed_at) + INTERVAL 5 YEAR DELETE;

-- Rolled up by the materialized view below.
CREATE TABLE shop.daily_sales
(
    day Date,
    product_id UInt32,
    quantity UInt64,
    revenue Decimal(18, 2)
)
ENGINE = SummingMergeTree
ORDER BY (day, product_id);

CREATE TABLE shop.product_uniques
(
    product_id UInt32,
    buyers AggregateFunction(uniq, UInt32)
)
ENGINE = AggregatingMergeTree
ORDER BY product_id;

CREATE TABLE shop.`Edge Cases`
(
    `id` UInt8,
    `Mixed Case` String,
    `select` String,
    `emoji 🎉` Nullable(String)
)
ENGINE = MergeTree
ORDER BY id;

INSERT INTO shop.categories VALUES
    (1, NULL, 'Electronics', 'electronics'),
    (2, NULL, 'Books', 'books'),
    (3, NULL, 'Home', 'home'),
    (4, 1, 'Phones', 'phones'),
    (5, 1, 'Laptops', 'laptops'),
    (6, 2, 'Fiction', 'fiction');

INSERT INTO shop.categories
SELECT 6 + number, 1 + number % 3, concat('Category ', toString(6 + number)), concat('category-', toString(6 + number))
FROM numbers(1, 18);

INSERT INTO shop.customers (id, email, full_name, country, tier, is_active, preferences, signed_up_at, note)
SELECT
    number,
    concat('customer', toString(number), '@example.com'),
    concat(['Kim', 'Lee', 'Park', 'Choi', 'Smith', 'Garcia'][1 + number % 6], ' ', toString(number)),
    ['KR', 'US', 'DE', 'JP', 'FR'][1 + number % 5],
    [ 'free', 'pro', 'enterprise'][1 + number % 3],
    number % 11 != 0,
    map('theme', if(number % 2 = 0, 'dark', 'light'), 'lang', ['ko', 'en'][1 + number % 2]),
    toDateTime64('2023-01-01 00:00:00', 6, 'UTC') + toIntervalSecond(number * 86011),
    if(number % 7 = 0, 'VIP — handle with care', NULL)
FROM numbers(1, 1000);

-- A newer version of a few customers, merged away by ReplacingMergeTree.
INSERT INTO shop.customers (id, email, full_name, country, tier, version)
SELECT number, concat('customer', toString(number), '@example.org'), concat('Renamed ', toString(number)), 'KR', 'pro', 2
FROM numbers(1, 5);

INSERT INTO shop.products
SELECT
    number,
    1 + number % 24,
    concat('SKU-', leftPad(toString(number), 5, '0')),
    concat(['Basic', 'Pro', 'Ultra', 'Mini'][1 + number % 4], ' ', ['Widget', 'Gadget', 'Book', 'Lamp', 'Phone'][1 + number % 5], ' ', toString(number)),
    toDecimal64(5 + (number * 37) % 995, 2) + toDecimal64(0.99, 2),
    toInt32((number * 13) % 250) - 5,
    arraySlice(['new', 'sale', 'eco', 'gift', 'popular'], 1 + number % 3, 1 + number % 3),
    map('color', ['red', 'blue', 'black', 'white'][1 + number % 4]),
    (toUInt16(50 + number % 200), toUInt16(20 + number % 80), toUInt16(5 + number % 40)),
    if(number % 9 = 0, NULL, toDate('2020-01-01') + number * 3),
    number % 17 = 0
FROM numbers(1, 400);

INSERT INTO shop.orders (id, customer_id, status, ordered_at, shipped_at, shipping_address, coupon_code, total)
SELECT
    number,
    1 + (number * 7919) % 1000,
    ['pending', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded'][1 + number % 6],
    toDateTime('2024-01-01 00:00:00', 'UTC') + toIntervalSecond(number * 4999),
    if(number % 6 IN (2, 3), toDateTime('2024-01-01 00:00:00', 'UTC') + toIntervalSecond(number * 4999 + 172800), NULL),
    (['Seoul', 'Busan', 'Berlin', 'Tokyo', 'Austin'][1 + number % 5], leftPad(toString(number % 99999), 5, '0')),
    if(number % 10 = 0, 'WELCOME10', NULL),
    toDecimal64(10 + (number * 53) % 900, 2)
FROM numbers(1, 6000);

INSERT INTO shop.page_views
SELECT
    toDateTime64('2024-06-01 00:00:00', 3, 'UTC') + toIntervalMillisecond(number * 61237),
    ['/', '/products', '/cart', '/checkout', '/account'][1 + number % 5],
    if(number % 4 = 0, NULL, 1 + number % 1000),
    if(number % 3 = 0, 'https://search.example.com', NULL),
    (number * 97) % 5000,
    toIPv4(concat('10.0.', toString(number % 256), '.', toString((number * 7) % 256))),
    toIPv6(concat('2001:db8::', lower(hex(number % 65535))))
FROM numbers(1, 3000);

INSERT INTO shop.`Edge Cases` VALUES
    (1, 'Upper', 'keyword column', '🎉'),
    (2, 'lower', 'quote '' and \\ backslash', NULL);

CREATE MATERIALIZED VIEW shop.daily_sales_mv TO shop.daily_sales AS
SELECT
    toDate(o.ordered_at) AS day,
    i.product_id AS product_id,
    toUInt64(i.quantity) AS quantity,
    toDecimal128(i.quantity * i.unit_price, 2) AS revenue
FROM shop.order_items AS i
INNER JOIN shop.orders AS o ON o.id = i.order_id;

CREATE MATERIALIZED VIEW shop.product_uniques_mv TO shop.product_uniques AS
SELECT i.product_id AS product_id, uniqState(o.customer_id) AS buyers
FROM shop.order_items AS i
INNER JOIN shop.orders AS o ON o.id = i.order_id
GROUP BY i.product_id;

-- Inserted after the views exist, so they fill daily_sales and product_uniques.
INSERT INTO shop.order_items
SELECT
    o.number AS order_id,
    toUInt8(l.number + 1) AS line_no,
    toUInt32(1 + (o.number * 31 + l.number * 17) % 400) AS product_id,
    toUInt16(1 + (o.number + l.number) % 4) AS quantity,
    toDecimal64(5 + ((o.number * 31 + l.number * 17) % 400 * 37) % 995, 2) AS unit_price
FROM numbers(1, 6000) AS o
CROSS JOIN numbers(0, 4) AS l
WHERE l.number < 1 + o.number % 4;

CREATE VIEW shop.order_totals AS
SELECT o.id AS order_id, o.customer_id, o.status, sum(i.quantity * i.unit_price) AS items_total, count() AS lines
FROM shop.orders AS o
INNER JOIN shop.order_items AS i ON i.order_id = o.id
GROUP BY o.id, o.customer_id, o.status;

CREATE DICTIONARY shop.category_names
(
    id UInt64,
    name String,
    slug String
)
PRIMARY KEY id
SOURCE(CLICKHOUSE(TABLE 'categories' DB 'shop' USER 'tablepeek' PASSWORD 'tablepeek_test_pw'))
LIFETIME(MIN 300 MAX 600)
LAYOUT(FLAT());
