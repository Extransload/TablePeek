// The LDAP user of the mongodb-ldap test server: ann, whose password the
// OpenLDAP server checks (testdb/ldap.ldif). Run again, it changes nothing.
const external = db.getSiblingDB("$external");
if (external.getUser("ann") === null) {
  external.createUser({
    user: "ann",
    roles: [
      { role: "readWriteAnyDatabase", db: "admin" },
      { role: "clusterMonitor", db: "admin" },
    ],
  });
}
