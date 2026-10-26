import { t } from "./i18n";

// A ZIP container written in the browser: each entry is deflated with the
// platform's CompressionStream, and its CRC-32 taken from the same pass, so
// sizes are known before the local header goes out (no data descriptors).
// Parts stay Blobs, which the browser may keep on disk, so large exports
// don't have to fit in memory at once.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32Update(crc: number, bytes: Uint8Array): number {
  let c = crc;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return c;
}

export function crc32(bytes: Uint8Array): number {
  return (crc32Update(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
}

// Classic ZIP fields are 32-bit; ZIP64 isn't written.
const MAX_32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;
const UTF8_NAMES = 0x0800;

interface CentralEntry {
  name: Uint8Array<ArrayBuffer>;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  time: number;
  date: number;
  offset: number;
}

function dosTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export interface ZipAddOptions {
  // Already-compressed data (an .xlsx) is stored as it is.
  store?: boolean;
  date?: Date;
}

export class ZipWriter {
  private readonly parts: BlobPart[] = [];
  private readonly entries: CentralEntry[] = [];
  private offset = 0;

  async add(name: string, data: Blob | string, options: ZipAddOptions = {}): Promise<void> {
    if (this.entries.length >= MAX_ENTRIES) {
      throw new Error(t("ZIP 파일에 넣을 수 있는 파일 수를 넘었습니다"));
    }
    const blob = typeof data === "string" ? new Blob([data]) : data;
    let crc = 0xffffffff;
    let size = 0;
    const tap = new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
      transform(chunk, controller) {
        crc = crc32Update(crc, chunk);
        size += chunk.length;
        controller.enqueue(chunk);
      },
    });
    const tapped = blob.stream().pipeThrough(tap);
    const method = options.store ? 0 : 8;
    const body = await new Response(
      method === 8 ? tapped.pipeThrough(new CompressionStream("deflate-raw")) : tapped,
    ).blob();
    crc = (crc ^ 0xffffffff) >>> 0;
    if (size > MAX_32 || body.size > MAX_32 || this.offset > MAX_32) {
      throw new Error(t("ZIP 파일이 4GB를 넘어 만들 수 없습니다"));
    }
    const nameBytes = new TextEncoder().encode(name);
    const when = dosTime(options.date ?? new Date());
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, UTF8_NAMES, true);
    header.setUint16(8, method, true);
    header.setUint16(10, when.time, true);
    header.setUint16(12, when.date, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, body.size, true);
    header.setUint32(22, size, true);
    header.setUint16(26, nameBytes.length, true);
    header.setUint16(28, 0, true);
    this.entries.push({
      name: nameBytes,
      method,
      crc,
      compressed: body.size,
      size,
      time: when.time,
      date: when.date,
      offset: this.offset,
    });
    this.parts.push(header.buffer, nameBytes, body);
    this.offset += 30 + nameBytes.length + body.size;
  }

  finish(type = "application/zip"): Blob {
    const start = this.offset;
    let length = 0;
    const central: BlobPart[] = [];
    for (const entry of this.entries) {
      const record = new DataView(new ArrayBuffer(46));
      record.setUint32(0, 0x02014b50, true);
      record.setUint16(4, 20, true);
      record.setUint16(6, 20, true);
      record.setUint16(8, UTF8_NAMES, true);
      record.setUint16(10, entry.method, true);
      record.setUint16(12, entry.time, true);
      record.setUint16(14, entry.date, true);
      record.setUint32(16, entry.crc, true);
      record.setUint32(20, entry.compressed, true);
      record.setUint32(24, entry.size, true);
      record.setUint16(28, entry.name.length, true);
      // Extra field, comment, disk number, internal and external attributes: none.
      record.setUint32(42, entry.offset, true);
      central.push(record.buffer, entry.name);
      length += 46 + entry.name.length;
    }
    if (start + length > MAX_32) {
      throw new Error(t("ZIP 파일이 4GB를 넘어 만들 수 없습니다"));
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.entries.length, true);
    end.setUint16(10, this.entries.length, true);
    end.setUint32(12, length, true);
    end.setUint32(16, start, true);
    return new Blob([...this.parts, ...central, end.buffer], { type });
  }
}
