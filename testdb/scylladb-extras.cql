-- ScyllaDB-only parts of the shop: Lua functions and an aggregate
-- (ScyllaDB runs UDFs in Lua or WebAssembly, behind --experimental-features udf).
USE shop;

CREATE FUNCTION line_total(quantity int, unit_price double)
    RETURNS NULL ON NULL INPUT
    RETURNS double
    LANGUAGE lua
    AS 'return unit_price * quantity';

CREATE FUNCTION add_reading(state double, value double)
    CALLED ON NULL INPUT
    RETURNS double
    LANGUAGE lua
    AS 'if value == nil then return state end return state + value';

CREATE AGGREGATE reading_total(double)
    SFUNC add_reading
    STYPE double
    INITCOND 0;
