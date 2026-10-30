-- Oracle Free starts with a 1.5 GB SGA and a 512 MB PGA target, more than
-- the container's 2.5 GB cap leaves room for: under load (DBMS_METADATA)
-- it stalls allocating memory. `make test-db` runs this as SYS in the CDB
-- before seeding; it shrinks both once, in the spfile, and exits with 3 so
-- the container is restarted with them.
WHENEVER SQLERROR EXIT FAILURE
VARIABLE changed NUMBER
BEGIN
    SELECT CASE WHEN TO_NUMBER(value) > 1073741824 THEN 3 ELSE 0 END INTO :changed
      FROM v$parameter WHERE name = 'sga_target';
    IF :changed = 3 THEN
        EXECUTE IMMEDIATE 'ALTER SYSTEM SET sga_target = 1G SCOPE = SPFILE';
        EXECUTE IMMEDIATE 'ALTER SYSTEM SET pga_aggregate_target = 256M SCOPE = SPFILE';
    END IF;
END;
/
EXIT :changed
