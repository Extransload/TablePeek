-- Cassandra-only parts of the shop: Java functions and an aggregate, a
-- storage-attached index, a vector column (Cassandra 5).
USE shop;

CREATE FUNCTION line_total(quantity int, unit_price double)
    RETURNS NULL ON NULL INPUT
    RETURNS double
    LANGUAGE java
    AS 'return unit_price * quantity;';

CREATE FUNCTION add_reading(state double, value double)
    CALLED ON NULL INPUT
    RETURNS double
    LANGUAGE java
    AS 'return value == null ? state : state + value;';

CREATE AGGREGATE reading_total(double)
    SFUNC add_reading
    STYPE double
    INITCOND 0;

CREATE CUSTOM INDEX customers_email ON customers (email) USING 'StorageAttachedIndex';

CREATE TABLE product_embeddings (
    product_id int PRIMARY KEY,
    embedding vector<float, 3>
);
INSERT INTO product_embeddings (product_id, embedding) VALUES (1, [0.1, 0.2, 0.3]);
INSERT INTO product_embeddings (product_id, embedding) VALUES (2, [0.9, 0.1, 0.4]);
