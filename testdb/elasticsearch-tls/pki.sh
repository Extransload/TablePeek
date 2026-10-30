#!/bin/sh
# Maps the test client certificate (testdb/x509/client.pem, CN=tablepeek-client)
# to superuser through the PKI realm of the HTTPS Elasticsearch test server.
# Run inside the container by `make test-db ENGINE=elasticsearch-tls`.
set -eu
curl -sSf -o /dev/null --cacert config/certs/ca.pem -u elastic:tablepeek_test_pw \
  -X PUT https://localhost:9200/_security/role_mapping/tablepeek-pki \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"roles":["superuser"],"rules":{"all":[{"field":{"realm.name":"pki1"}},{"field":{"username":"tablepeek-client"}}]}}'
