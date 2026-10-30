#!/bin/sh
# The HTTPS Elasticsearch test server's certificate, signed by the throwaway
# CA testdb/x509/gen.sh makes (run that first): for localhost, 127.0.0.1 and
# elasticsearch-tls, its name on the test network. Elasticsearch reads the
# certificate and the key from separate files, and the CA to check client
# certificates (testdb/x509/client.pem) against. Written to certs/ next to
# this script, once; delete it to make a new one.
set -eu
cd "$(dirname "$0")"

if [ ! -f certs/node.crt ]; then
  mkdir -p certs
  printf 'subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:elasticsearch-tls\nextendedKeyUsage=serverAuth\n' > certs/node.ext
  openssl req -newkey rsa:2048 -nodes -keyout certs/node.key -out certs/node.csr \
    -subj "/O=TablePeek/OU=Elasticsearch/CN=elasticsearch-tls" 2>/dev/null
  openssl x509 -req -in certs/node.csr -CA ../x509/ca.pem -CAkey ../x509/ca.key -CAcreateserial \
    -days 3650 -extfile certs/node.ext -out certs/node.crt 2>/dev/null
  cp ../x509/ca.pem certs/ca.pem
  # The chain the server sends ends with the CA, as Elasticsearch's own
  # setup does, so a fingerprint of the CA can be checked against it.
  cat certs/ca.pem >> certs/node.crt
  rm -f certs/node.csr certs/node.ext ../x509/ca.srl
  # The server runs as another user inside its container.
  chmod 644 certs/node.crt certs/node.key certs/ca.pem
fi
