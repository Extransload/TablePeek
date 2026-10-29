// The X.509 user of the mongodb-x509 test server: the subject of
// testdb/x509/client.pem (written by testdb/x509/gen.sh).
db.getSiblingDB("$external").runCommand({
  createUser: "CN=tablepeek-client,OU=Clients,O=TablePeek",
  roles: [
    { role: "readWriteAnyDatabase", db: "admin" },
    { role: "clusterMonitor", db: "admin" },
  ],
});
