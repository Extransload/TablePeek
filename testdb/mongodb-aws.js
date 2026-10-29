// The AWS users of the mongodb-aws test server, named by the ARN the test
// STS (testdb/aws/sts.py) answers with: the IAM user of the key
// AKIATABLEPEEKTEST, and the role the same key assumes with its session
// token (MongoDB names an assumed role with `*` for the session). Run
// again, it changes nothing.
const external = db.getSiblingDB("$external");
for (const user of [
  "arn:aws:iam::123456789012:user/tablepeek",
  "arn:aws:sts::123456789012:assumed-role/tablepeek-role/*",
]) {
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
