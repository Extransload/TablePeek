// The OIDC users of the mongodb-oidc test server, named by the provider's
// prefix tp and the token's subject: tp/ann logs in on the provider's page
// (any name works there; this one has a user), tp/tablepeek-machine is the
// client-credentials token of the machine flow. Run again, it changes
// nothing. The provider may have come up after the server, so its keys are
// read again first.
db.adminCommand({ oidcRefreshKeys: 1 });
const external = db.getSiblingDB("$external");
for (const user of ["tp/ann", "tp/tablepeek-machine"]) {
  if (external.getUser(user) === null) {
    external.createUser({
      user,
      roles: [
        { role: "readWriteAnyDatabase", db: "admin" },
        { role: "clusterMonitor", db: "admin" },
      ],
    });
  }
}
