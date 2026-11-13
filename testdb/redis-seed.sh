#!/bin/sh
# Sample keys for the Redis and Valkey test servers, run inside the
# container by `make test-db` with the CLI to use and its login:
#   sh /seed/redis-seed.sh redis-cli -a tablepeek_test_pw --no-auth-warning
# Starts from empty databases. Database 0 holds one key of each type (a big
# hash, a binary string, a stream, keys in `:` namespaces, keys with an
# expiry), database 1 a few more. The JSON document and the time series
# need Redis 8's modules and are skipped where the server lacks them.
set -eu

"$@" > /dev/null <<'EOF'
FLUSHALL
SET greeting "hello, redis"
SET config:json "{\"name\":\"TablePeek\",\"tags\":[\"db\",\"gui\"],\"version\":8}"
SET counter 42
SET bin:blob "\x00\x01\xff\xfeTablePeek\x80\x0a"
SET "key with spaces" "a key whose name has spaces"
SET unicode:키 "값 · värde · 値"
EVAL "for i = 1, 5000 do redis.call('HSET', KEYS[1], 'field:' .. i, 'value ' .. i) end" 1 big:hash
HSET user:1 name Ann email ann@example.com visits 12
HSET user:2 name Bo email bo@example.com visits 3
EVAL "for i = 1, 120 do redis.call('HSET', 'app:users:' .. i, 'name', 'user ' .. i, 'score', i) end" 0
EVAL "for i = 1, 300 do redis.call('SET', 'app:session:' .. i, 'token-' .. i, 'EX', 86400) end" 0
EVAL "for i = 1, 300 do redis.call('RPUSH', KEYS[1], 'job ' .. i) end" 1 queue:jobs
SADD tags redis valkey database cache "with space"
ZADD leaderboard 100 ann 250.5 bo 75 cy -10 dee inf top
EVAL "for i = 1, 250 do redis.call('XADD', KEYS[1], '*', 'kind', 'click', 'n', i) end" 1 events:stream
EXPIRE greeting 86400
SELECT 1
SET db1:hello "from database 1"
HSET db1:hash a 1 b 2
RPUSH db1:list x y z
EOF

# Redis 8's modules (JSON, time series); not on Valkey or Redis 6.
"$@" JSON.SET doc:product '$' '{"id":7,"name":"Lamp","price":19.5,"tags":["home","light"],"stock":{"warehouse":12}}' > /dev/null 2>&1 || true
"$@" TS.CREATE metrics:temp > /dev/null 2>&1 || true
"$@" TS.ADD metrics:temp 1700000000000 21.5 > /dev/null 2>&1 || true
