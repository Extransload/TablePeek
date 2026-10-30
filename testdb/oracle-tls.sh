#!/bin/bash
# Gives the Oracle test server a TCPS listener on port 2484 (127.0.0.1:15211
# outside) with the wallet oracle-wallet.sh made: a server certificate for
# oracle, localhost and 127.0.0.1, signed by x509/ca.pem. Clients are not asked
# for certificates. Run inside the container by make test-db ENGINE=oracle;
# does nothing once the listener has the TCPS address.
set -eu
admin="$ORACLE_HOME/network/admin"
wallet=/opt/oracle/tls-wallet
if grep -q TCPS "$admin/listener.ora"; then
  exit 0
fi

mkdir -p "$wallet"
cp /seed/oracle-wallet/cwallet.sso /seed/oracle-wallet/ewallet.p12 "$wallet/"
chmod 600 "$wallet"/*

cat > "$admin/listener.ora" <<EOF
LISTENER =
  (DESCRIPTION_LIST =
    (DESCRIPTION =
      (ADDRESS = (PROTOCOL = IPC)(KEY = EXTPROC_FOR_FREE))
      (ADDRESS = (PROTOCOL = TCP)(HOST=)(PORT = 1521))
      (ADDRESS = (PROTOCOL = TCPS)(HOST=)(PORT = 2484))
    )
  )

DEFAULT_SERVICE_LISTENER = FREE
WALLET_LOCATION = (SOURCE = (METHOD = FILE)(METHOD_DATA = (DIRECTORY = $wallet)))
SSL_CLIENT_AUTHENTICATION = FALSE
EOF
cat >> "$admin/sqlnet.ora" <<EOF
WALLET_LOCATION = (SOURCE = (METHOD = FILE)(METHOD_DATA = (DIRECTORY = $wallet)))
SSL_CLIENT_AUTHENTICATION = FALSE
EOF

lsnrctl stop > /dev/null
lsnrctl start > /dev/null
# The database registers its services with the restarted listener now
# rather than within the minute.
echo 'ALTER SYSTEM REGISTER;' | sqlplus -s -L / as sysdba > /dev/null
