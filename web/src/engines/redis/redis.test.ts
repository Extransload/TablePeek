import { describe, expect, it } from "vitest";
import { parseConnectionUrl } from "../connection";
import { binFromBytes, binFromHex, binId, binText, consoleArg, hexOf } from "./bin";
import { buildKeyTree, KeySet, matchPattern } from "./keytree";
import { replyText } from "./reply";

describe("Bin", () => {
  it("keeps UTF-8 as text and other bytes as b64", () => {
    expect(binFromBytes(new TextEncoder().encode("héllo"))).toBe("héllo");
    expect(binFromBytes(new Uint8Array([0xff, 0x00, 0x41]))).toEqual({ b64: "/wBB" });
  });

  it("shows bytes as redis-cli does and reads hex back", () => {
    const bin = { b64: "/wBB" };
    expect(binText(bin)).toBe("\\xff\\x00A");
    expect(binText(bin, true)).toBe('"\\xff\\x00A"');
    expect(hexOf(bin)).toBe("ff 00 41");
    expect(binFromHex("ff 00 41")).toEqual(bin);
    expect(binFromHex("0x6869")).toBe("hi");
    expect(binFromHex("abc")).toBeNull();
  });

  it("compares the same bytes however they were written", () => {
    expect(binId({ hex: "68 69" })).toBe(binId({ b64: "aGk=" }));
    expect(binId("hi")).not.toBe(binId({ b64: "aGk=" }));
  });

  it("quotes console arguments only when needed", () => {
    expect(consoleArg("user:1")).toBe("user:1");
    expect(consoleArg("two words")).toBe('"two words"');
    expect(consoleArg('a"b')).toBe('"a\\"b"');
    expect(consoleArg("")).toBe('""');
  });
});

describe("replyText", () => {
  it("prints scalars as redis-cli", () => {
    expect(replyText({ t: "int", v: 3 })).toBe("(integer) 3");
    expect(replyText({ t: "nil" })).toBe("(nil)");
    expect(replyText({ t: "status", v: "OK" })).toBe("OK");
    expect(replyText({ t: "bulk", v: "a\nb" })).toBe('"a\\nb"');
    expect(replyText({ t: "error", v: "WRONGTYPE Operation" })).toBe("(error) WRONGTYPE Operation");
    expect(replyText({ t: "array", v: [] })).toBe("(empty array)");
  });

  it("numbers nested arrays and lines them up", () => {
    const reply = { t: "array" as const, v: [{ t: "bulk" as const, v: "a" }, { t: "array" as const, v: [{ t: "int" as const, v: 1 }, { t: "bulk" as const, v: "b" }] }] };
    expect(replyText(reply)).toBe(['1) "a"', "2) 1) (integer) 1", '   2) "b"'].join("\n"));
  });

  it("writes maps as key => value", () => {
    expect(replyText({ t: "map", v: [[{ t: "bulk", v: "k" }, { t: "int", v: 2 }]] })).toBe('1# "k" => (integer) 2');
  });
});

describe("key tree", () => {
  it("groups keys on the separator with counts", () => {
    const tree = buildKeyTree(
      [
        { key: "user:1:name", type: "string" },
        { key: "user:2:name", type: "string" },
        { key: "user:2:tags", type: "set" },
        { key: "plain", type: "hash" },
      ],
      ":",
    );
    expect(tree.count).toBe(4);
    expect(tree.keys.map((entry) => entry.key)).toEqual(["plain"]);
    expect(tree.folders.map((folder) => [folder.prefix, folder.count])).toEqual([["user:", 3]]);
    expect(tree.folders[0].folders.map((folder) => [folder.name, folder.count])).toEqual([
      ["1", 1],
      ["2", 2],
    ]);
  });

  it("lists every key flat without a separator", () => {
    expect(buildKeyTree([{ key: "a:b", type: "string" }], "").keys).toHaveLength(1);
  });

  it("counts each key once across SCAN pages", () => {
    const set = new KeySet();
    expect(set.add([{ key: "a", type: "string" }, { key: "b", type: "string" }])).toBe(2);
    expect(set.add([{ key: "b", type: "string" }, { key: "c", type: "list" }])).toBe(1);
    expect(set.size).toBe(3);
  });

  it("turns plain text into a contains pattern", () => {
    expect(matchPattern("")).toBeNull();
    expect(matchPattern("user")).toBe("*user*");
    expect(matchPattern("user:*")).toBe("user:*");
  });
});

describe("redis:// URLs", () => {
  it("fills host, port, password, database and TLS off", () => {
    expect(parseConnectionUrl("redis://:s3cret@cache.local:6380/2")?.values).toEqual({
      host: "cache.local",
      port: "6380",
      password: "s3cret",
      database: "2",
      auth: "password",
      tls: false,
      uri: "",
    });
  });

  it("turns TLS on for rediss:// and takes the default port", () => {
    const parsed = parseConnectionUrl("rediss://app:pw@redis.example.com");
    expect(parsed?.engine.id).toBe("redis");
    expect(parsed?.values).toMatchObject({ host: "redis.example.com", port: "6379", user: "app", password: "pw", auth: "password", tls: true });
  });

  it("needs no authentication without a password", () => {
    expect(parseConnectionUrl("redis://localhost")?.values).toMatchObject({ auth: "none", tls: false });
  });
});
