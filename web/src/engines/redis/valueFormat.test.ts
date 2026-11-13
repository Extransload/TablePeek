import { encode } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";
import { javaValue } from "./decode/java";
import { phpValue } from "./decode/php";
import { bytesRepr, pickleValue } from "./decode/pickle";
import { protobufValue } from "./decode/protobuf";
import {
  asciiEscape,
  asciiUnescape,
  base64Bytes,
  base64Meaningful,
  bitsText,
  bytesToBase64,
  cellInk,
  detectFormat,
  jsonDocument,
  jsonError,
  minifyJson,
  msgpackDocument,
  msgpackEditable,
  msgpackFromJson,
  nestedValue,
  prettyJson,
  timestampOf,
  utf8,
  vectorValues,
} from "./valueFormat";

const bytes = (text: string) => new TextEncoder().encode(text);
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));

// Real samples as hex, made once with Python's pickle (protocols 0, 2,
// 4, 5), a JDK's ObjectOutputStream, and by hand (PHP serialize(),
// protobuf, float vectors).
const FIXTURES: Record<string, string> = {
  pickle0: "286470300a566e616d650a70310a564c616d700a70320a7356746167730a70330a286c70340a56686f6d650a70350a61286c70360a566e65737465640a70370a6149310a6146322e350a616173567768656e0a70380a636461746574696d650a6461746574696d650a70390a28635f636f646563730a656e636f64650a7031300a285607ea0b5c75303030645c7530303061021201e2400a7031310a566c6174696e310a7031320a747031330a527031340a747031350a527031360a73566461790a7031370a636461746574696d650a646174650a7031380a286731300a285607ea0b5c75303030640a7031390a6731320a747032300a527032310a747032320a527032330a735670726963650a7032340a63646563696d616c0a446563696d616c0a7032350a285631392e39300a7032360a747032370a527032380a735669640a7032390a63636f70795f7265670a5f7265636f6e7374727563746f720a7033300a2863757569640a555549440a7033310a635f5f6275696c74696e5f5f0a6f626a6563740a7033320a4e747033330a527033340a28647033350a56696e740a7033360a4c32343139373835373136313031313731353136323137313833393633363938383737383130344c0a736273567365740a7033370a635f5f6275696c74696e5f5f0a7365740a7033380a28286c7033390a49310a6149320a6149330a61747034300a527034310a73567261770a7034320a6731300a28565c75303030300168690a7034330a6731320a747034340a527034350a73566269670a7034360a4c313138303539313632303731373431313330333432344c0a73566e65670a7034370a492d350a73566e6f6e650a7034380a4e73566f6b0a7034390a4930310a7356740a7035300a2849310a56610a7035310a747035320a732e",
  pickle2: "80027d71002858040000006e616d65710158040000004c616d70710258040000007461677371035d7104285804000000686f6d6571055d71062858060000006e657374656471074b01474004000000000000656558040000007768656e7108636461746574696d650a6461746574696d650a7109635f636f646563730a656e636f64650a710a580c00000007c3aa0b0d0a021201c3a240710b58060000006c6174696e31710c86710d52710e85710f52711058030000006461797111636461746574696d650a646174650a7112680a580500000007c3aa0b0d7113680c86711452711585711652711758050000007072696365711863646563696d616c0a446563696d616c0a7119580500000031392e3930711a85711b52711c58020000006964711d63757569640a555549440a711e2981711f7d71205803000000696e7471218a1078563412785634127856341278563412736258030000007365747122635f5f6275696c74696e5f5f0a7365740a71235d7124284b014b024b036585712552712658030000007261777127680a5804000000000168697128680c86712952712a5803000000626967712b8a0900000000000000004058030000006e6567712c4afbffffff58040000006e6f6e65712d4e58020000006f6b712e88580100000074712f4b015801000000617130867131752e",
  pickle4: "8004953a010000000000007d94288c046e616d65948c044c616d70948c0474616773945d94288c04686f6d65945d94288c066e6573746564944b0147400400000000000065658c047768656e948c086461746574696d65948c086461746574696d65949394430a07ea0b0d0a021201e24094859452948c036461799468098c0464617465949394430407ea0b0d94859452948c057072696365948c07646563696d616c948c07446563696d616c9493948c0531392e393094859452948c026964948c0475756964948c04555549449493942981947d948c03696e74948a107856341278563412785634127856341273628c03736574948f94284b014b024b03908c0372617794430400016869948c03626967948a090000000000000000408c036e6567944afbffffff8c046e6f6e65944e8c026f6b94888c0174944b018c0161948694752e",
  pickle5: "8005953a010000000000007d94288c046e616d65948c044c616d70948c0474616773945d94288c04686f6d65945d94288c066e6573746564944b0147400400000000000065658c047768656e948c086461746574696d65948c086461746574696d65949394430a07ea0b0d0a021201e24094859452948c036461799468098c0464617465949394430407ea0b0d94859452948c057072696365948c07646563696d616c948c07446563696d616c9493948c0531392e393094859452948c026964948c0475756964948c04555549449493942981947d948c03696e74948a107856341278563412785634127856341273628c03736574948f94284b014b024b03908c0372617794430400016869948c03626967948a090000000000000000408c036e6567944afbffffff8c046e6f6e65944e8c026f6b94888c0174944b018c0161948694752e",
  django: "8005953e010000000000007d94288c0d5f617574685f757365725f6964948c023432948c125f617574685f757365725f6261636b656e64948c29646a616e676f2e636f6e747269622e617574682e6261636b656e64732e4d6f64656c4261636b656e64948c0f5f617574685f757365725f68617368948c06396632633165948c0f5f73657373696f6e5f657870697279944a007512008c0463617274948c247b226974656d73223a205b7b22736b75223a20224131222c2022717479223a20327d5d7d948c0a6c6173745f6c6f67696e948c086461746574696d65948c086461746574696d65949394430a07ea0b0c091e0000000094680b8c0874696d657a6f6e65949394680b8c0974696d6564656c74619493944b004b004b008794529485945294869452948c05696e6e65729443158005950a000000000000007d948c0178944b01732e94752e",
  ordered: "80049536000000000000008c0b636f6c6c656374696f6e73948c0b4f72646572656444696374949394295294288c0161944b018c0162945d94284b014b0265752e",
  object: "8004952e000000000000008c085f5f6d61696e5f5f948c05506f696e749493942981947d94288c0178944b018c0179948c0374776f9475622e",
  cycle: "80025d7100284b016800652e",
  java: "aced0005737200176a6176612e7574696c2e4c696e6b6564486173684d617034c04e5c106cc0fb0200015a000b6163636573734f72646572787200116a6176612e7574696c2e486173684d61700507dac1c31660d103000246000a6c6f6164466163746f724900097468726573686f6c6478703f4000000000000c77080000001000000006740004757365727372000b53616d706c652455736572000000000000000102000549000269644c0005636f6c6f7274000e4c53616d706c6524436f6c6f723b4c00046e616d657400124c6a6176612f6c616e672f537472696e673b4c0005726f6c65737400104c6a6176612f7574696c2f4c6973743b5b000673636f7265737400025b497870000000077e72000c53616d706c6524436f6c6f7200000000000000001200007872000e6a6176612e6c616e672e456e756d00000000000000001200007870740005475245454e740003677975737200136a6176612e7574696c2e41727261794c6973747881d21d99c7619d03000149000473697a6578700000000277040000000274000561646d696e74000364657678757200025b494dba602676eab2a5020000787000000003000000010000000200000003740005636f756e74737200116a6176612e6c616e672e496e746567657212e2a0a4f781873802000149000576616c7565787200106a6176612e6c616e672e4e756d62657286ac951d0b94e08b02000078700000002a7400036269677372000e6a6176612e6c616e672e4c6f6e673b8be490cc8f23df0200014a000576616c75657871007e00170000011f71fb04cb7400047768656e7372000e6a6176612e7574696c2e44617465686a81014b59741903000078707708000001a1ce9913c878740003736574737200116a6176612e7574696c2e54726565536574dd98509395ed875b0300007870707704000000027400017874000179787400026f6b737200116a6176612e6c616e672e426f6f6c65616ecd207280d59cfaee0200015a000576616c75657870017800",
  php: "613a363a7b733a343a2275736572223b4f3a343a2255736572223a333a7b733a323a226964223b693a34323b733a373a22002a006e616d65223b733a333a22677975223b733a353a22726f6c6573223b613a323a7b693a303b733a353a2261646d696e223b693a313b733a333a22646576223b7d7d733a353a227072696365223b643a31392e393b733a323a226f6b223b623a313b733a343a226e6f6e65223b4e3b733a353a22616761696e223b723a323b733a343a2275746638223b733a363a22ed959ceab880223b7d",
  protobuf: "089601120774657374696e671a06080112026f6b2206038e029ea7052d0000c03f31000000000000044038013802",
  vector32: "cdcccc3d0000c0bf000050406f12833a",
  vector64: "9a9999999999b93f000000000000f8bf9c7500883ce4377e",
};


const HEARTBEAT = JSON.stringify({
  worker_id: "ai-review-worker:341559390f9a:13",
  queue: "ai_review",
  capabilities: ["ai_review"],
  last_heartbeat: 1794467501.3345892,
  hostname: "341559390f9a",
  pid: 13,
});

describe("detectFormat", () => {
  it("reads a JSON object as JSON, with a byte order mark too", () => {
    expect(detectFormat(bytes(HEARTBEAT))).toBe("json");
    expect(detectFormat(bytes(`\uFEFF  ${HEARTBEAT}\n`))).toBe("json");
    expect(jsonDocument(`\uFEFF[1,2]`)).toEqual([1, 2]);
  });

  it("keeps a number, a quoted string or a word as text", () => {
    expect(detectFormat(bytes("42"))).toBe("text");
    expect(detectFormat(bytes("-3.5e10"))).toBe("text");
    expect(detectFormat(bytes('"quoted"'))).toBe("text");
    expect(detectFormat(bytes("hello world"))).toBe("text");
    // Valid Base64 alphabet, but plain words.
    expect(detectFormat(bytes("Username"))).toBe("text");
    expect(detectFormat(bytes("deadbeef"))).toBe("text");
  });

  it("finds Base64 of text or JSON, not of noise", () => {
    expect(detectFormat(bytes(btoa(HEARTBEAT)))).toBe("base64");
    expect(detectFormat(bytes(btoa("Hello, TablePeek!")))).toBe("base64");
    // Decodes to bytes nobody reads: shown as the text it is.
    expect(base64Meaningful(btoa("\x00\x01\x02\xff\xfe\xfd\x80\x81\x82"))).toBeNull();
  });

  it("reads MessagePack maps and arrays, and other bytes as ASCII or hex", () => {
    expect(detectFormat(encode({ id: 7, tags: ["a", "b"] }))).toBe("msgpack");
    expect(detectFormat(new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x02, 0x03]))).toBe("hex");
    expect(detectFormat(new Uint8Array([...bytes("caf"), 0xe9, ...bytes(" au lait, s'il vous plait")]))).toBe("ascii");
    // Base64 isn't looked for inside decoded bytes.
    expect(detectFormat(bytes(btoa("Hello, TablePeek!")), true)).toBe("text");
  });
});

describe("utf8", () => {
  it("rejects invalid UTF-8", () => {
    expect(utf8(new Uint8Array([0x68, 0xc3, 0x28]))).toBeNull();
    expect(utf8(new Uint8Array([0xed, 0xa0, 0x80]))).toBeNull();
    expect(utf8(bytes("héllo"))).toBe("héllo");
  });
});

describe("JSON text", () => {
  it("says where the JSON breaks", () => {
    const error = jsonError('{"a": 1,}');
    expect(error).not.toBeNull();
    expect(error?.at).toBeGreaterThanOrEqual(7);
    expect(error?.at).toBeLessThanOrEqual(9);
    expect(jsonError('{"a": 1}')).toBeNull();
    const bare = '{"pid": 13, "status": oops}';
    expect(jsonError(bare)).toEqual({ message: expect.not.stringContaining("is not valid JSON"), at: bare.indexOf("oops") });
    expect(jsonError('\uFEFF{"a" 1}')?.at).toBe(6);
    expect(jsonError('{"a": 1')?.at).toBe(7);
    expect(jsonError('\uFEFF{"a": 1}')).toBeNull();
  });

  it("indents and minifies without touching big numbers or strings", () => {
    const text = '{ "id" : 12345678901234567890 , "s": "a b\\" c" }';
    expect(minifyJson(text)).toBe('{"id":12345678901234567890,"s":"a b\\" c"}');
    expect(prettyJson(text)).toBe('{\n  "id": 12345678901234567890,\n  "s": "a b\\" c"\n}');
  });
});

describe("ASCII escapes", () => {
  it("writes and reads bytes as redis-cli does", () => {
    const raw = new Uint8Array([0x41, 0x5c, 0x0a, 0x00, 0xff, 0x22]);
    const escaped = asciiEscape(raw);
    expect(escaped).toBe('A\\\\\\n\\x00\\xff"');
    expect(asciiUnescape(escaped)).toEqual(raw);
    expect(asciiEscape(bytes("é"))).toBe("\\xc3\\xa9");
  });

  it("rejects a stray backslash or a character past ASCII", () => {
    expect(asciiUnescape("a\\q")).toBeNull();
    expect(asciiUnescape("\\x4")).toBeNull();
    expect(asciiUnescape("é")).toBeNull();
  });
});

describe("Base64", () => {
  it("decodes standard and URL-safe text, padding optional", () => {
    expect(base64Bytes("aGk=")).toEqual(bytes("hi"));
    expect(base64Bytes("aGk")).toEqual(bytes("hi"));
    expect(base64Bytes("_-8")).toEqual(new Uint8Array([0xff, 0xef]));
    expect(base64Bytes("aGVs\nbG8=")).toEqual(bytes("hello"));
  });

  it("rejects what isn't Base64", () => {
    expect(base64Bytes("a")).toBeNull();
    expect(base64Bytes("aGk=a")).toBeNull();
    expect(base64Bytes("not base64!")).toBeNull();
  });

  it("decodes to binary when that is what it holds", () => {
    const binary = new Uint8Array([0x00, 0xff, 0x10, 0x80]);
    expect(base64Bytes(bytesToBase64(binary))).toEqual(binary);
  });
});

describe("MessagePack", () => {
  it("decodes to plain JSON", () => {
    const doc = msgpackDocument(encode({ n: 1, big: 2n ** 60n, bin: new Uint8Array([1, 255]), when: new Date(0) }, { useBigInt64: true }));
    expect(doc).toEqual({ n: 1, big: "1152921504606846976", bin: { $binary: "01ff" }, when: "1970-01-01T00:00:00.000Z" });
  });

  it("refuses scalars, trailing bytes and truncated data", () => {
    expect(msgpackDocument(encode(5))).toBeNull();
    expect(msgpackDocument(new Uint8Array([...encode([1]), 0x01]))).toBeNull();
    expect(msgpackDocument(encode({ a: "long text" }).subarray(0, 5))).toBeNull();
  });
});

describe("cellInk", () => {
  it("colours a row value by its kind", () => {
    expect(cellInk("42")).toBe("integer");
    expect(cellInk("12345678901234567890")).toBe("bigint");
    expect(cellInk("0042")).toBe("string");
    expect(cellInk("3.14")).toBe("float");
    expect(cellInk("1e5")).toBe("float");
    expect(cellInk("TRUE")).toBe("boolean");
    expect(cellInk("nil")).toBe("null");
    expect(cellInk("")).toBe("empty");
    expect(cellInk('{"a":1}')).toBe("json");
    expect(cellInk("[1,2]")).toBe("list");
    expect(cellInk("hello")).toBe("string");
  });
});

describe("Pickle", () => {
  const SAMPLE = {
    name: "Lamp",
    tags: ["home", ["nested", 1, 2.5]],
    when: "2026-11-13T10:02:18.123456",
    day: "2026-11-13",
    price: "Decimal('19.90')",
    id: "UUID('12345678-1234-5678-1234-567812345678')",
    set: { __set__: [1, 2, 3] },
    raw: "b'\\x00\\x01hi'",
    big: "1180591620717411303424",
    neg: -5,
    none: null,
    ok: true,
    t: [1, "a"],
  };

  it("reads protocols 0, 2, 4 and 5 to the same value", () => {
    for (const name of ["pickle0", "pickle2", "pickle4", "pickle5"]) {
      expect(pickleValue(fromHex(FIXTURES[name]))?.value, name).toEqual(SAMPLE);
      expect(detectFormat(fromHex(FIXTURES[name])), name).toBe("pickle");
    }
  });

  it("decodes a Django session, nested JSON and pickles included", () => {
    expect(pickleValue(fromHex(FIXTURES.django), nestedValue)?.value).toEqual({
      _auth_user_id: "42",
      _auth_user_backend: "django.contrib.auth.backends.ModelBackend",
      _auth_user_hash: "9f2c1e",
      _session_expiry: 1209600,
      cart: { __json__: { items: [{ sku: "A1", qty: 2 }] } },
      last_login: "2026-11-12T09:30:00Z",
      inner: { __pickle__: { x: 1 } },
    });
    // Without nesting the inner values stay as stored.
    const flat = pickleValue(fromHex(FIXTURES.django))?.value as Record<string, unknown>;
    expect(flat.cart).toBe('{"items": [{"sku": "A1", "qty": 2}]}');
    expect(String(flat.inner).startsWith("b'\\x80\\x05")).toBe(true);
  });

  it("describes instances and dict subclasses without running them", () => {
    expect(pickleValue(fromHex(FIXTURES.object))?.value).toEqual({ __class__: "__main__.Point", state: { x: 1, y: "two" } });
    expect(pickleValue(fromHex(FIXTURES.ordered))?.value).toEqual({ __class__: "collections.OrderedDict", items: { a: 1, b: [1, 2] } });
    expect(pickleValue(fromHex(FIXTURES.cycle))?.value).toEqual([1, "<recursion>"]);
  });

  it("refuses truncated or trailing data and plain text", () => {
    const whole = fromHex(FIXTURES.pickle5);
    expect(pickleValue(whole.subarray(0, whole.length - 1))).toBeNull();
    expect(pickleValue(new Uint8Array([...whole, 0x2e]))).toBeNull();
    expect(detectFormat(bytes("(just a note)."))).toBe("text");
    expect(detectFormat(bytes("I1\n."))).toBe("text");
    expect(bytesRepr(new Uint8Array([0x27, 0x5c, 0x41, 0x00]))).toBe("b'\\'\\\\A\\x00'");
  });
});

describe("PHP serialize", () => {
  it("reads arrays, objects, references and byte-counted UTF-8 strings", () => {
    const user = { __class__: "User", id: 42, "name:protected": "gyu", roles: ["admin", "dev"] };
    expect(phpValue(fromHex(FIXTURES.php))?.value).toEqual({ user, price: 19.9, ok: true, none: null, again: user, utf8: "한글" });
    expect(detectFormat(fromHex(FIXTURES.php))).toBe("php");
  });

  it("leaves lone scalars and broken input to text", () => {
    expect(detectFormat(bytes("i:5;"))).toBe("text");
    expect(detectFormat(bytes('s:5:"abc";'))).toBe("text");
    expect(phpValue(bytes('a:1:{i:0;s:1:"x";'))).toBeNull();
  });
});

describe("Java serialization", () => {
  it("reads objects, collections, enums, boxed numbers and dates", () => {
    expect(javaValue(fromHex(FIXTURES.java))?.value).toEqual({
      user: { __class__: "Sample$User", id: 7, color: "Color.GREEN", name: "gyu", roles: ["admin", "dev"], scores: [1, 2, 3] },
      count: 42,
      big: 1234567890123,
      when: "2026-11-12T07:11:41.000Z",
      set: ["x", "y"],
      ok: true,
    });
    expect(detectFormat(fromHex(FIXTURES.java))).toBe("java");
    expect(javaValue(fromHex(FIXTURES.java).subarray(0, 100))).toBeNull();
  });
});

describe("Protobuf", () => {
  it("reads a message without its schema", () => {
    expect(protobufValue(fromHex(FIXTURES.protobuf))?.value).toEqual({ 1: 150, 2: "testing", 3: { 1: 1, 2: "ok" }, 4: [3, 270, 86942], 5: 1.5, 6: 2.5, 7: [1, 2] });
    expect(detectFormat(fromHex(FIXTURES.protobuf))).toBe("protobuf");
  });

  it("refuses bytes that don't end on a field", () => {
    expect(protobufValue(fromHex(FIXTURES.protobuf).subarray(0, 5))).toBeNull();
    expect(protobufValue(new Uint8Array([0x0f]))).toBeNull();
  });
});

describe("vectors, timestamps, bits", () => {
  it("reads little-endian float vectors", () => {
    expect(vectorValues(fromHex(FIXTURES.vector32), 32)).toEqual([0.1, -1.5, 3.25, 0.001]);
    expect(vectorValues(fromHex(FIXTURES.vector64), 64)).toEqual([0.1, -1.5, 1e300]);
    expect(vectorValues(new Uint8Array(6), 32)).toBeNull();
  });

  it("tells the unit by size", () => {
    expect(timestampOf("1794467501", "UTC")).toMatchObject({ unit: "s", utc: "2026-11-12T07:11:41.000Z" });
    expect(timestampOf("1794467501334", "UTC")).toMatchObject({ unit: "ms", utc: "2026-11-12T07:11:41.334Z" });
    expect(timestampOf("1794467501334567", "UTC")).toMatchObject({ unit: "µs" });
    expect(timestampOf("1794467501334567890", "UTC")).toMatchObject({ unit: "ns", utc: "2026-11-12T07:11:41.334Z" });
    expect(timestampOf("1794467501.5", "Asia/Seoul")?.local).toContain("2026-11-12 16:11:41");
    expect(timestampOf("soon")).toBeNull();
  });

  it("writes bits a byte a group", () => {
    expect(bitsText(new Uint8Array([1, 255, 0x48]))).toBe("00000001 11111111 01001000");
  });
});

describe("Msgpack editing", () => {
  it("round-trips plain values through JSON, not bytes", () => {
    const packed = msgpackFromJson('{"id": 7, "tags": ["a"], "ok": true}');
    expect(packed).not.toBeNull();
    expect(msgpackEditable(packed as Uint8Array)).toBe(true);
    expect(msgpackFromJson('{"raw": {"$binary": "00"}}')).toBeNull();
  });
});
