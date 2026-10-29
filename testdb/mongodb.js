// Turns the container into a one-member replica set and adds the test
// account. Safe to run again: an initiated set and an existing user are left
// as they are.
try {
  rs.status();
} catch (e) {
  rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "127.0.0.1:27017" }] });
}
// Writes need a primary; a fresh set elects itself within a few seconds.
for (let i = 0; i < 60 && !db.hello().isWritablePrimary; i++) sleep(500);
if (!db.hello().isWritablePrimary) throw new Error("replica set has no primary");

const admin = db.getSiblingDB("admin");
if (!admin.getUser("tablepeek")) {
  admin.createUser({ user: "tablepeek", pwd: "tablepeek_test_pw", roles: ["root"] });
}
