import { describe, expect, it } from "vitest";
import { fillTemplate, parseConnectionUrl, staleUrlValues, templateValues } from "./connection";

describe("parseConnectionUrl", () => {
  it("fills the form from a PostgreSQL URL, decoding its parts", () => {
    const parsed = parseConnectionUrl("  postgres://app%40corp:p%40ss@db.example.com:6543/my%20db?sslmode=verify-full&sslrootcert=/ca.pem ");
    expect(parsed?.engine.id).toBe("postgres");
    expect(parsed?.values).toEqual({
      host: "db.example.com",
      port: "6543",
      user: "app@corp",
      password: "p@ss",
      database: "my db",
      ssl_mode: "require",
      ssl_root_cert: "/ca.pem",
    });
  });

  it("takes the engine's default port when the URL has none", () => {
    expect(parseConnectionUrl("postgresql://localhost/db?sslmode=disable")?.values).toEqual({
      host: "localhost",
      port: "5432",
      database: "db",
      ssl_mode: "disable",
    });
  });

  it("reads a jdbc: prefix, an IPv6 host and MySQL's ssl- parameters", () => {
    const parsed = parseConnectionUrl("jdbc:mysql://root@[::1]/shop?ssl-mode=PREFERRED&ssl-ca=/ca.pem&ssl-key=/k.pem");
    expect(parsed?.engine.id).toBe("mysql");
    expect(parsed?.values).toEqual({
      host: "::1",
      port: "3306",
      user: "root",
      database: "shop",
      ssl_mode: "prefer",
      ssl_root_cert: "/ca.pem",
      ssl_client_key: "/k.pem",
    });
  });

  it("only fills fields the engine has", () => {
    // SQL Server has no ssl_mode field.
    expect(parseConnectionUrl("sqlserver://sa:pw@host/master?sslmode=require")?.values).toEqual({
      host: "host",
      port: "1433",
      user: "sa",
      password: "pw",
      database: "master",
    });
  });

  it("returns null for a scheme no engine takes, or text that isn't a URL", () => {
    expect(parseConnectionUrl("redis-ish://x")).toBeNull();
    expect(parseConnectionUrl("host=localhost dbname=x")).toBeNull();
  });

  it("splits a single-host MongoDB string into host and port", () => {
    const parsed = parseConnectionUrl("mongodb://u:p%2Fw@h:27018/app?authSource=admin&readPreference=secondary");
    expect(parsed?.engine.id).toBe("mongodb");
    expect(parsed?.values).toMatchObject({
      host: "h",
      port: "27018",
      uri: "",
      user: "u",
      password: "p/w",
      database: "app",
      auth: "password",
      auth_source: "admin",
      read_preference: "secondary",
    });
  });

  it("keeps a MongoDB seed list or SRV name in the connection string, without the password", () => {
    const seed = parseConnectionUrl("mongodb://u:secret@h1:27017,h2:27017/db?replicaSet=rs0")?.values;
    expect(seed?.uri).toBe("mongodb://u@h1:27017,h2:27017/db?replicaSet=rs0");
    expect(seed?.host).toBe("");
    expect(seed?.password).toBe("secret");
    expect(seed?.replica_set).toBe("rs0");
    const srv = parseConnectionUrl("mongodb+srv://cluster0.example.net/app")?.values;
    expect(srv?.uri).toBe("mongodb+srv://cluster0.example.net/app");
    expect(srv?.auth).toBe("none");
  });

  it("maps a MongoDB mechanism to its authentication choice, letting the string's own TLS win", () => {
    const x509 = parseConnectionUrl("mongodb://h/db?authMechanism=MONGODB-X509&tls=false")?.values;
    expect(x509?.auth).toBe("x509");
    expect(x509?.tls).toBe(false);
    expect(x509?.auth_mechanism).toBeUndefined();
    const kerberos = parseConnectionUrl(
      "mongodb://h/db?authMechanism=GSSAPI&authMechanismProperties=SERVICE_NAME:mongo,CANONICALIZE_HOST_NAME:true",
    )?.values;
    expect(kerberos).toMatchObject({
      auth: "kerberos",
      kerberos_service_name: "mongo",
      kerberos_canonicalize: "forwardAndReverse",
    });
  });
});

describe("staleUrlValues", () => {
  it("resets fields the previous URL filled that the new one doesn't mention", () => {
    const first = parseConnectionUrl("postgres://u@h/db?sslmode=require&sslrootcert=/ca.pem")!;
    const second = parseConnectionUrl("postgres://u@h2/db")!;
    const reset = staleUrlValues(first.engine, { ...first.values }, new Set(Object.keys(first.values)), second.values);
    expect(Object.keys(reset).sort()).toEqual(["ssl_mode", "ssl_root_cert"]);
    expect(reset.ssl_root_cert).toBe("");
  });

  it("leaves fields typed by hand alone", () => {
    const parsed = parseConnectionUrl("postgres://u@h/db")!;
    const reset = staleUrlValues(parsed.engine, { ssl_root_cert: "/mine.pem" }, new Set(), parsed.values);
    expect(reset).toEqual({});
  });
});

describe("fillTemplate", () => {
  it("drops the separator before an empty value and before the first value shown", () => {
    expect(fillTemplate("{host}:{port}/{database}", { host: "h", port: 5432, database: "" })).toBe("h:5432");
    expect(fillTemplate("{user}@{host}", { user: "", host: "h" })).toBe("h");
    expect(fillTemplate("{user}@{host}", { user: "u", host: "h" })).toBe("u@h");
  });

  it("lists each placeholder's value", () => {
    expect(templateValues("{host} : {port} {missing}", { host: "h", port: 1 })).toEqual(["h", "1", ""]);
  });
});
