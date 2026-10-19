export interface EncodingOption {
  id: string;
  label: string;
}

export const ENCODINGS: EncodingOption[] = [
  { id: "utf-8", label: "UTF-8" },
  { id: "euc-kr", label: "EUC-KR / CP949" },
  { id: "shift_jis", label: "Shift_JIS" },
  { id: "gb18030", label: "GB18030" },
  { id: "big5", label: "Big5" },
  { id: "windows-1252", label: "Windows-1252" },
  { id: "iso-8859-2", label: "ISO-8859-2" },
  { id: "utf-16le", label: "UTF-16LE" },
];

const encoder = new TextEncoder();

export function textBytes(text: string): Uint8Array {
  return encoder.encode(text);
}

export function decodeWith(bytes: Uint8Array, encoding: string): string {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

export function hexDump(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return "";
  }
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const chunk = bytes.subarray(offset, Math.min(offset + 16, bytes.length));
    const hex = Array.from(chunk, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex}`);
  }
  return lines.join("\n");
}
