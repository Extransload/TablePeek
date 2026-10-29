#!/bin/sh
# Throwaway certificates for the mongodb-x509 and mongodb-oidc test servers:
# a CA, a server certificate for localhost and 127.0.0.1, and a client
# certificate whose subject is the X.509 user the server's init script
# creates; for the OIDC identity provider the server certificate again, as
# the PKCS#12 keystore it reads (idp.p12, password tablepeek). Written next
# to this script, once; delete the *.pem and *.p12 files to make new ones.
set -eu
cd "$(dirname "$0")"

if [ ! -f client.pem ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout ca.key -out ca.pem -subj "/O=TablePeek Test/CN=TablePeek Test CA" 2>/dev/null

  printf 'subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:mongodb-x509\nextendedKeyUsage=serverAuth,clientAuth\n' > server.ext
  openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr \
    -subj "/O=TablePeek/OU=Server/CN=localhost" 2>/dev/null
  openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
    -days 3650 -extfile server.ext -out server.crt 2>/dev/null
  cat server.crt server.key > server.pem

  printf 'extendedKeyUsage=clientAuth\n' > client.ext
  openssl req -newkey rsa:2048 -nodes -keyout client.key -out client.csr \
    -subj "/O=TablePeek/OU=Clients/CN=tablepeek-client" 2>/dev/null
  openssl x509 -req -in client.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
    -days 3650 -extfile client.ext -out client.crt 2>/dev/null
  cat client.crt client.key > client.pem

  rm -f server.csr client.csr server.ext client.ext ca.srl server.crt server.key client.crt client.key
fi

# 3DES rather than the newer default ciphers, which some Java versions
# cannot open.
if [ ! -f idp.p12 ]; then
  openssl pkcs12 -export -in server.pem -inkey server.pem -name idp \
    -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1 \
    -passout pass:tablepeek -out idp.p12
fi

# The servers run as other users inside their containers.
chmod 644 ./*.pem ./*.p12
