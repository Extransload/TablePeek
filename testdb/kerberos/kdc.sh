#!/bin/sh
# The KDC of the mongodb-kerberos test profile (MIT krb5, realm
# TABLEPEEK.TEST). On first start it makes the realm, the user
# ann@TABLEPEEK.TEST (password ann_krb_pw) and the service principal of the
# MongoDB server, mongodb/kerberos.tablepeek.test, whose key goes to the
# keytab the server reads (/keytab/mongodb.keytab, a volume both share).
set -eu
realm=TABLEPEEK.TEST

cat > /etc/krb5.conf <<EOF
[libdefaults]
    default_realm = $realm
[realms]
    $realm = {
        kdc = localhost
        admin_server = localhost
    }
EOF
mkdir -p /etc/krb5kdc
cat > /etc/krb5kdc/kdc.conf <<EOF
[kdcdefaults]
    kdc_ports = 88
    kdc_tcp_ports = 88
[realms]
    $realm = {
        database_name = /var/lib/krb5kdc/principal
        key_stash_file = /etc/krb5kdc/stash
        acl_file = /etc/krb5kdc/kadm5.acl
        max_life = 10h
        max_renewable_life = 7d
        supported_enctypes = aes256-cts-hmac-sha1-96:normal aes128-cts-hmac-sha1-96:normal
    }
EOF

if [ ! -f /var/lib/krb5kdc/principal ]; then
    kdb5_util create -s -r "$realm" -P kdc_master_pw
    kadmin.local -q "addprinc -pw ann_krb_pw ann@$realm"
    kadmin.local -q "addprinc -randkey mongodb/kerberos.tablepeek.test@$realm"
fi
# A fresh keytab each start, readable by the server's own user.
rm -f /keytab/mongodb.keytab
kadmin.local -q "ktadd -k /keytab/mongodb.keytab mongodb/kerberos.tablepeek.test@$realm"
chmod 644 /keytab/mongodb.keytab

exec krb5kdc -n
