// The Kerberos user of the mongodb-kerberos test server: ann@TABLEPEEK.TEST,
// whose ticket the KDC (testdb/kerberos/kdc.sh) hands out. Run again, it
// changes nothing.
const external = db.getSiblingDB("$external");
if (external.getUser("ann@TABLEPEEK.TEST") === null) {
  external.createUser({
    user: "ann@TABLEPEEK.TEST",
    roles: [
      { role: "readWriteAnyDatabase", db: "admin" },
      { role: "clusterMonitor", db: "admin" },
    ],
  });
}
