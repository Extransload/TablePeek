import { tableFromIPC } from "apache-arrow";

const base = process.argv[2];
if (!base) {
  console.error("usage: node scripts/ws-smoke.mjs <http://127.0.0.1:PORT/?token=TOKEN>");
  process.exit(2);
}

const url = new URL(base);
const token = url.searchParams.get("token");
const wsUrl = `ws://${url.host}/api/ws?token=${token}`;

let failures = 0;
function check(name, ok, detail = "") {
  const label = ok ? "PASS" : "FAIL";
  if (!ok) failures += 1;
  console.log(`${label} ${name}${detail ? ` — ${detail}` : ""}`);
}

function decodeTable(table) {
  const rows = [];
  const cols = table.numCols;
  const children = [];
  for (let c = 0; c < cols; c += 1) {
    children.push(table.getChildAt(c));
  }
  for (let r = 0; r < table.numRows; r += 1) {
    const row = [];
    for (let c = 0; c < cols; c += 1) {
      let value = children[c].get(r);
      if (typeof value === "bigint") {
        value =
          value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(value)
            : value.toString();
      }
      row.push(value);
    }
    rows.push(row);
  }
  return rows;
}

class Client {
  constructor(ws) {
    this.ws = ws;
    this.pendingText = [];
    this.pendingBinary = [];
    this.windowWaiters = new Map();
    ws.binaryType = "arraybuffer";
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        const msg = JSON.parse(event.data);
        if (msg.type === "window") {
          const waiter = this.windowWaiters.get(msg.offset);
          if (waiter) {
            this.windowWaiters.delete(msg.offset);
            const rows = msg.count > 0 ? this.pendingBinary.shift() ?? [] : [];
            waiter({ msg, rows });
            return;
          }
        }
        const index = this.pendingText.findIndex((entry) => entry.filter(msg));
        if (index >= 0) {
          this.pendingText.splice(index, 1)[0].resolve(msg);
        }
      } else {
        this.pendingBinary.push(decodeTable(tableFromIPC(new Uint8Array(event.data))));
      }
    };
  }

  waitFor(filter, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const entry = { filter, resolve: (msg) => { clearTimeout(timer); resolve(msg); } };
      const timer = setTimeout(() => {
        const index = this.pendingText.indexOf(entry);
        if (index >= 0) this.pendingText.splice(index, 1);
        reject(new Error("timeout waiting for message"));
      }, timeoutMs);
      this.pendingText.push(entry);
    });
  }

  waitWindow(offset, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.windowWaiters.delete(offset);
        reject(new Error(`timeout waiting window ${offset}`));
      }, timeoutMs);
      this.windowWaiters.set(offset, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  send(value) {
    this.ws.send(JSON.stringify(value));
  }

  async query(id, sql, options = {}) {
    const metaPromise = this.waitFor((m) => m.type === "meta" && m.id === id);
    const windowPromise = this.waitWindow(0);
    this.send({
      type: "query",
      id,
      sql,
      max_rows: options.maxRows ?? 200000,
      window: options.window ?? 1000,
    });
    const meta = await metaPromise;
    const first = await windowPromise;
    return { meta, first };
  }

  async fetch(id, offset, limit) {
    const windowPromise = this.waitWindow(offset);
    this.send({ type: "fetch", id, offset, limit });
    return windowPromise;
  }

  async edit(request) {
    const promise = this.waitFor((m) => m.type === "edited" || m.type === "error");
    this.send({ type: "edit", ...request });
    const result = await promise;
    if (result.type === "error") throw new Error(result.message);
    return result;
  }

  async tx(action) {
    const promise = this.waitFor((m) => m.type === "tx" || m.type === "error");
    this.send({ type: "tx", action });
    const result = await promise;
    if (result.type === "error") throw new Error(result.message);
    return result.state;
  }
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => reject(new Error("ws connect timeout")), 10000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(new Client(ws));
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("ws connect error"));
    };
  });
}

const main = async () => {
  const client = await connect();

  const first = await client.query("q1", "SELECT id, name FROM demo LIMIT 5000");
  check("meta columns", JSON.stringify(first.meta.columns) === '["id","name"]', first.meta.columns.join(","));
  check("meta row_count", first.meta.row_count === 5000, String(first.meta.row_count));
  check("meta source_table", first.meta.source_table === "demo", String(first.meta.source_table));
  check("meta pk", JSON.stringify(first.meta.pk) === '["id"]', JSON.stringify(first.meta.pk));
  check("first window count", first.first.msg.count === 1000, String(first.first.msg.count));
  const firstRowName = first.first.rows[0][1];
  check(
    "first window rows",
    first.first.rows.length === 1000 &&
      first.first.rows[0][0] === 1 &&
      (firstRowName === "user_1" || firstRowName === "스모크됨") &&
      first.first.rows[1][1] === "user_2" &&
      first.first.rows[999][1] === "user_1000",
    `first=${JSON.stringify(first.first.rows[0])} last=${JSON.stringify(first.first.rows[999])}`,
  );

  const mid = await client.fetch("q1", 4000, 500);
  check(
    "mid window",
    mid.msg.count === 500 && mid.rows[0][0] === 4001 && mid.rows[0][1] === "user_4001",
    `first=${JSON.stringify(mid.rows[0])}`,
  );

  const tail = await client.fetch("q1", 4900, 200);
  check("tail window clamped", tail.msg.count === 100 && tail.rows.length === 100, String(tail.msg.count));

  const editResult = await client.edit({
    session: "q1",
    table: "demo",
    pk: [{ column: "id", value: 1 }],
    column: "name",
    value: "스모크됨",
    row: 0,
    col: 1,
  });
  check("edit rows_affected", editResult.rows_affected === 1, String(editResult.rows_affected));
  const afterEdit = await client.query("q2", "SELECT name FROM demo WHERE id = 1");
  check("edit persisted", afterEdit.first.rows[0][0] === "스모크됨", String(afterEdit.first.rows[0][0]));
  const patched = await client.fetch("q1", 0, 100);
  check(
    "session patch visible",
    patched.msg.count === 100 && patched.rows[0][1] === "스모크됨",
    JSON.stringify(patched.rows[0]),
  );

  check("tx begin", (await client.tx("begin")) === "began");
  await client.edit({
    session: "q2",
    table: "demo",
    pk: [{ column: "id", value: 1 }],
    column: "name",
    value: "롤백대상",
    row: 0,
    col: 0,
  });
  check("tx rollback", (await client.tx("rollback")) === "rolledback");
  const afterRollback = await client.query("q3", "SELECT name FROM demo WHERE id = 1");
  check("rollback reverted", afterRollback.first.rows[0][0] === "스모크됨", String(afterRollback.first.rows[0][0]));
  const reverted = await client.fetch("q2", 0, 100);
  check(
    "journal revert visible",
    reverted.msg.count === 1 && reverted.rows[0][0] === "스모크됨",
    JSON.stringify(reverted.rows[0]),
  );

  const cancelPromise = client.waitFor((m) => m.type === "error" && m.id === "long", 15000);
  client.send({
    type: "query",
    id: "long",
    sql: "SELECT count(*) FROM demo a, demo b, demo c",
    max_rows: 10,
    window: 100,
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  client.send({ type: "cancel" });
  const cancelled = await cancelPromise;
  check("cancel flag", cancelled.cancelled === true, JSON.stringify(cancelled));

  const afterCancel = await client.query("q4", "SELECT count(*) FROM demo LIMIT 1");
  check("engine alive after cancel", afterCancel.first.rows[0][0] === 200000, String(afterCancel.first.rows[0][0]));

  client.ws.close();
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error("SMOKE ERROR:", err.message);
  process.exit(1);
});
