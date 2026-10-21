import type { ConnectInput, DbInput, SavedConnection, SavedDb } from "./store";

// A saved profile as connection input, shaped the way the connection dialog
// builds it: never a password, certificate paths only while SSL is on, and
// SSH taking precedence over an HTTP proxy.

function dbInput(db: SavedDb): DbInput {
  const input: DbInput = {
    host: db.host,
    port: db.port,
    user: db.user,
    database: db.database,
    ssl_mode: db.ssl_mode,
  };
  if (db.ssl_mode !== "disable") {
    if (db.ssl_root_cert) {
      input.ssl_root_cert = db.ssl_root_cert;
    }
    if (db.ssl_client_cert) {
      input.ssl_client_cert = db.ssl_client_cert;
    }
    if (db.ssl_client_key) {
      input.ssl_client_key = db.ssl_client_key;
    }
  }
  return input;
}

export function inputFromSaved(saved: SavedConnection): ConnectInput {
  let input: ConnectInput;
  if (saved.mysql) {
    input = { driver: "mysql", mysql: dbInput(saved.mysql) };
  } else if (saved.cockroach) {
    input = { driver: "cockroach", cockroach: dbInput(saved.cockroach) };
  } else if (saved.mssql) {
    const db = saved.mssql;
    input = {
      driver: "mssql",
      mssql: {
        host: db.host,
        port: db.port,
        user: db.user,
        database: db.database,
        encrypt: db.encrypt ?? true,
      },
    };
  } else {
    const db = saved.postgres ?? { host: "", port: 5432, user: "", database: "", ssl_mode: "disable" as const };
    input = { driver: "postgres", postgres: dbInput(db) };
  }
  if (saved.ssh) {
    input.ssh = {
      host: saved.ssh.host,
      port: saved.ssh.port,
      user: saved.ssh.user,
      private_key_path: saved.ssh.private_key_path ?? "",
    };
  } else if (saved.http_tunnel) {
    input.http_tunnel = {
      host: saved.http_tunnel.host,
      port: saved.http_tunnel.port,
      ...(saved.http_tunnel.username ? { username: saved.http_tunnel.username } : {}),
    };
  }
  return input;
}
