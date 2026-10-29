import { cleanConfig } from "./engines/connection";
import { requireEngine } from "./engines";
import type { ConnectInput, SavedConnection } from "./store";

// A saved profile as connection input, shaped the way the connection dialog
// builds it: never a password, only the fields that show (certificate paths
// only while SSL is on), tunnels only where the engine offers them, and SSH
// taking precedence over an HTTP proxy. An engine this page doesn't know is
// an error.
export function inputFromSaved(saved: SavedConnection): ConnectInput {
  const engine = requireEngine(saved.driver);
  const input: ConnectInput = { driver: engine.id, config: cleanConfig(engine, saved.config) };
  const tunnels = engine.connection.tunnels;
  if (saved.ssh && tunnels.includes("ssh")) {
    input.ssh = {
      host: saved.ssh.host,
      port: saved.ssh.port,
      user: saved.ssh.user,
      private_key_path: saved.ssh.private_key_path ?? "",
    };
  } else if (saved.http_tunnel && tunnels.includes("http")) {
    input.http_tunnel = {
      host: saved.http_tunnel.host,
      port: saved.http_tunnel.port,
      ...(saved.http_tunnel.username ? { username: saved.http_tunnel.username } : {}),
    };
  }
  return input;
}
