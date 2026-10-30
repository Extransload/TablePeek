#!/bin/sh
# The Oracle test server's TLS wallet (oracle-wallet/): a server certificate
# of its own, signed by x509/gen.sh's test CA, for the names clients reach it
# by: oracle (its name on the test network, through the SSH server),
# localhost and 127.0.0.1; with its key and the CA, as an auto-login wallet
# the listener opens without a password. The image has orapki but no Java
# to run it, so Oracle's PKI library comes from Maven Central and runs on
# this machine's Java, or in a Temurin container when there is none. Written
# once (again when the certificate is missing: older wallets had x509's
# server certificate, without the name oracle); delete oracle-wallet/ to
# make a new one.
set -eu
cd "$(dirname "$0")"
[ -f oracle-wallet/cwallet.sso ] && [ -f oracle-wallet/server.p12 ] && exit 0
rm -f oracle-wallet/cwallet.sso oracle-wallet/ewallet.p12

version=23.26.3.0.0
jar="oracle-wallet/oraclepki-$version.jar"
mkdir -p oracle-wallet
[ -f "$jar" ] || curl -sfL -o "$jar" \
  "https://repo1.maven.org/maven2/com/oracle/database/security/oraclepki/$version/oraclepki-$version.jar"

printf 'subjectAltName=DNS:oracle,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' > oracle-wallet/server.ext
openssl req -newkey rsa:2048 -nodes -keyout oracle-wallet/server.key -out oracle-wallet/server.csr \
  -subj "/O=TablePeek/OU=Server/CN=oracle" 2>/dev/null
openssl x509 -req -in oracle-wallet/server.csr -CA x509/ca.pem -CAkey x509/ca.key -CAcreateserial \
  -CAserial oracle-wallet/ca.srl -days 3650 -extfile oracle-wallet/server.ext -out oracle-wallet/server.crt 2>/dev/null
# 3DES, which orapki's Java opens everywhere.
openssl pkcs12 -export -in oracle-wallet/server.crt -inkey oracle-wallet/server.key -name server \
  -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1 \
  -passout pass:tablepeek -out oracle-wallet/server.p12
rm -f oracle-wallet/server.ext oracle-wallet/server.key oracle-wallet/server.csr oracle-wallet/server.crt oracle-wallet/ca.srl

if command -v java > /dev/null 2>&1 && java -version > /dev/null 2>&1; then
  orapki() { java -cp "$jar" oracle.security.pki.textui.OraclePKITextUI "$@"; }
else
  orapki() {
    docker run --rm -v "$PWD:/w" -w /w eclipse-temurin:21-jre \
      java -cp "$jar" oracle.security.pki.textui.OraclePKITextUI "$@"
  }
fi
password=Wallet_test_pw_0001
orapki wallet create -wallet oracle-wallet -pwd "$password" -auto_login > /dev/null
orapki wallet import_pkcs12 -wallet oracle-wallet -pwd "$password" \
  -pkcs12file oracle-wallet/server.p12 -pkcs12pwd tablepeek > /dev/null
orapki wallet add -wallet oracle-wallet -pwd "$password" -trusted_cert -cert x509/ca.pem > /dev/null
rm -f oracle-wallet/*.lck
# The listener runs as another user inside the container.
chmod 644 oracle-wallet/cwallet.sso oracle-wallet/ewallet.p12
