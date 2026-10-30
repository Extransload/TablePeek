#!/bin/sh
# The ClickHouse test server's certificate, signed by the throwaway CA
# testdb/x509/gen.sh makes (run that first): for localhost, 127.0.0.1 and
# clickhouse.tablepeek.test, the name the server has on the test network,
# so a connection through the SSH server or an HTTP proxy checks the name it
# asked for. Written to certs/ next to this script, once; delete it to make
# a new one.
set -eu
cd "$(dirname "$0")"

if [ ! -f certs/server.pem ]; then
  mkdir -p certs
  printf 'subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:clickhouse.tablepeek.test\nextendedKeyUsage=serverAuth\n' > certs/server.ext
  openssl req -newkey rsa:2048 -nodes -keyout certs/server.key -out certs/server.csr \
    -subj "/O=TablePeek/OU=ClickHouse/CN=clickhouse.tablepeek.test" 2>/dev/null
  openssl x509 -req -in certs/server.csr -CA ../x509/ca.pem -CAkey ../x509/ca.key -CAcreateserial \
    -days 3650 -extfile certs/server.ext -out certs/server.crt 2>/dev/null
  cat certs/server.crt certs/server.key > certs/server.pem
  rm -f certs/server.csr certs/server.ext certs/server.crt certs/server.key ../x509/ca.srl
  # The server runs as another user inside its container.
  chmod 644 certs/server.pem
fi
