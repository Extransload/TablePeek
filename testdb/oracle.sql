-- The schema the Oracle engine tests read (crates/tablepeek-engine/src/
-- engines/oracle/tests.rs): account TABLEPEEK in FREEPDB1 with 5,000 users,
-- 20,000 orders, a table of every type, and one object of each kind the
-- sidebar lists. Run as SYS by `make test-db ENGINE=oracle` on every start:
-- a finished run (ORDERS has its comment, set last) skips the rest.
SET DEFINE OFF
SET FEEDBACK OFF
WHENEVER SQLERROR EXIT SUCCESS
DECLARE
    done NUMBER;
BEGIN
    SELECT COUNT(*) INTO done FROM dba_tab_comments
     WHERE owner = 'TABLEPEEK' AND table_name = 'ORDERS' AND comments IS NOT NULL;
    IF done > 0 THEN
        RAISE_APPLICATION_ERROR(-20000, 'seeded already');
    END IF;
END;
/
WHENEVER SQLERROR EXIT FAILURE
DECLARE
    started NUMBER;
BEGIN
    SELECT COUNT(*) INTO started FROM dba_users WHERE username = 'TABLEPEEK';
    IF started > 0 THEN
        RAISE_APPLICATION_ERROR(-20001,
            'Schema TABLEPEEK is half built: run make test-db-down ENGINE=oracle, then make test-db again.');
    END IF;
END;
/

CREATE USER tablepeek IDENTIFIED BY tablepeek_test_pw QUOTA UNLIMITED ON users;
GRANT CREATE SESSION, CREATE TABLE, CREATE VIEW, CREATE MATERIALIZED VIEW, CREATE SEQUENCE,
      CREATE SYNONYM, CREATE PROCEDURE, CREATE TRIGGER, CREATE TYPE TO tablepeek;
-- What a DBA's tool account has: the dictionary (sessions, other schemas'
-- DDL) and ALTER SYSTEM (cancel and KILL SESSION). The SHOP account
-- (oracle-shop.sql) has neither, for the paths without them.
GRANT SELECT_CATALOG_ROLE, SELECT ANY DICTIONARY, ALTER SYSTEM TO tablepeek;

ALTER SESSION SET CURRENT_SCHEMA = tablepeek;

CREATE TABLE users (
    id NUMBER(10) PRIMARY KEY,
    name VARCHAR2(50 CHAR) NOT NULL,
    score NUMBER(10, 2),
    created_at TIMESTAMP
);
INSERT INTO users
SELECT LEVEL, '사용자_' || LEVEL, LEVEL * 1.5, TIMESTAMP '2024-01-01 00:00:00' + NUMTODSINTERVAL(LEVEL, 'MINUTE')
FROM dual CONNECT BY LEVEL <= 5000;

CREATE TABLE orders (
    id NUMBER(10) PRIMARY KEY,
    user_id NUMBER(10) REFERENCES users (id),
    amount NUMBER(10, 2)
);
INSERT INTO orders SELECT LEVEL, MOD(LEVEL, 5000) + 1, LEVEL * 0.5 FROM dual CONNECT BY LEVEL <= 20000;
CREATE INDEX orders_user_recent ON orders (user_id, id DESC);

CREATE SEQUENCE kinds_seq START WITH 100;

CREATE TABLE kinds (
    id NUMBER(10) PRIMARY KEY,
    label VARCHAR2(40 CHAR) DEFAULT 'none',
    d DATE,
    ts TIMESTAMP(6),
    tstz TIMESTAMP(3) WITH TIME ZONE,
    ids INTERVAL DAY(2) TO SECOND(6),
    iym INTERVAL YEAR(2) TO MONTH,
    n NUMBER,
    price NUMBER(10, 2),
    f BINARY_DOUBLE,
    r RAW(16),
    c CLOB,
    b BLOB,
    nv NVARCHAR2(20),
    flag BOOLEAN,
    doc JSON
);
INSERT INTO kinds (id, d, ts, tstz, ids, iym, n, price, f, r, c, b, nv, flag, doc) VALUES (
    1,
    TO_DATE('2024-02-29 13:45:10', 'YYYY-MM-DD HH24:MI:SS'),
    TIMESTAMP '2024-02-29 13:45:10.123456',
    TIMESTAMP '2024-02-29 13:45:10.123 +09:00',
    INTERVAL '1 02:03:04.5' DAY TO SECOND,
    INTERVAL '2-3' YEAR TO MONTH,
    12345678901234567890.123,
    9.9,
    1.5,
    HEXTORAW('00FF10'),
    TO_CLOB('긴 텍스트 CLOB'),
    TO_BLOB(HEXTORAW('DEADBEEF')),
    N'한글',
    TRUE,
    JSON('{"a":[1,2]}')
);
INSERT INTO kinds (id) VALUES (2);

CREATE OR REPLACE TRIGGER kinds_bi BEFORE INSERT ON kinds FOR EACH ROW
BEGIN
    IF :NEW.id IS NULL THEN
        :NEW.id := kinds_seq.NEXTVAL;
    END IF;
END;
/

CREATE VIEW active_users AS SELECT id, name, score FROM users WHERE score > 100;

CREATE MATERIALIZED VIEW user_totals AS
SELECT user_id, COUNT(*) AS orders, SUM(amount) AS total FROM orders GROUP BY user_id;

CREATE SYNONYM customers FOR shop.customers;

CREATE OR REPLACE TYPE point_t AS OBJECT (
    x NUMBER,
    y NUMBER,
    MEMBER FUNCTION length RETURN NUMBER
);
/
CREATE OR REPLACE TYPE BODY point_t AS
    MEMBER FUNCTION length RETURN NUMBER IS
    BEGIN
        RETURN SQRT(x * x + y * y);
    END;
END;
/

CREATE OR REPLACE FUNCTION tp_double (n NUMBER) RETURN NUMBER AS
BEGIN
    RETURN n * 2;
END;
/

CREATE OR REPLACE PROCEDURE tp_proc (n NUMBER) AS
BEGIN
    DBMS_OUTPUT.PUT_LINE('tp_proc ' || tp_double(n));
END;
/

CREATE OR REPLACE PACKAGE tp_pkg AS
    FUNCTION greeting (name VARCHAR2) RETURN VARCHAR2;
END tp_pkg;
/
CREATE OR REPLACE PACKAGE BODY tp_pkg AS
    FUNCTION greeting (name VARCHAR2) RETURN VARCHAR2 IS
    BEGIN
        RETURN 'hello, ' || name;
    END;
END tp_pkg;
/

COMMIT;

-- Last, so it marks a finished run (see the top).
COMMENT ON TABLE orders IS 'Orders the tests read';
EXIT
