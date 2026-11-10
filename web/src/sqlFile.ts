import type { SqlDialect } from "./engines/sqlDialect";
import { decoderFor } from "./importParse";
import { splitSqlRanges } from "./sqlSplit";

// How much of a file is read at a time: a dump runs to gigabytes, more than
// a page can hold as one buffer or string.
const PIECE_BYTES = 8 * 1024 * 1024;

export interface FileStatement {
  // The statement, trimmed, without its ";".
  text: string;
  // The line its code starts on, from 1.
  line: number;
  // How far into the file reading had got when it was split off.
  bytesRead: number;
}

function newlines(text: string, from: number, to: number): number {
  let count = 0;
  for (let at = text.indexOf("\n", from); at >= 0 && at < to; at = text.indexOf("\n", at + 1)) {
    count += 1;
  }
  return count;
}

// The statements of an SQL file, in order, read a piece at a time. A
// piece's last statement may run on into the next piece, so it waits for
// it: the text is split again from that statement's start, where no quote,
// comment or BEGIN … END block is open.
export async function* fileStatements(file: Blob, encoding: string, dialect: SqlDialect): AsyncGenerator<FileStatement> {
  let decoder: TextDecoder | null = null;
  let carry = "";
  // The line `carry` starts on.
  let line = 1;
  let offset = 0;
  do {
    const end = Math.min(offset + PIECE_BYTES, file.size);
    const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    decoder ??= decoderFor(bytes, encoding);
    offset = end;
    const last = offset >= file.size;
    const text = carry + decoder.decode(bytes, { stream: !last });
    const ranges = splitSqlRanges(text, dialect);
    const ready = last ? ranges.length : ranges.length - 1;
    let counted = 0;
    for (let index = 0; index < ready; index += 1) {
      const range = ranges[index];
      line += newlines(text, counted, range.codeFrom);
      counted = range.codeFrom;
      yield { text: range.text, line, bytesRead: offset };
    }
    const keep = last ? text.length : ranges.length > 0 ? ranges[ranges.length - 1].from : 0;
    line += newlines(text, counted, keep);
    carry = text.slice(keep);
  } while (offset < file.size);
}
