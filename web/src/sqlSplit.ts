export function splitSqlStatements(input: string): string[] {
  const statements: string[] = [];
  let current = "";
  let index = 0;
  const length = input.length;

  function flush(): void {
    const trimmed = current.trim();
    if (trimmed !== "") {
      statements.push(trimmed);
    }
    current = "";
  }

  while (index < length) {
    const ch = input[index];
    const next = index + 1 < length ? input[index + 1] : "";

    if (ch === "-" && next === "-") {
      const end = input.indexOf("\n", index);
      const stop = end < 0 ? length : end;
      current += input.slice(index, stop);
      index = stop;
      continue;
    }
    if (ch === "#") {
      const end = input.indexOf("\n", index);
      const stop = end < 0 ? length : end;
      current += input.slice(index, stop);
      index = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = input.indexOf("*/", index + 2);
      const stop = end < 0 ? length : end + 2;
      current += input.slice(index, stop);
      index = stop;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let cursor = index + 1;
      current += ch;
      while (cursor < length) {
        const inner = input[cursor];
        current += inner;
        if (inner === "\\" && quote !== "`" && cursor + 1 < length) {
          current += input[cursor + 1];
          cursor += 2;
          continue;
        }
        if (inner === quote) {
          if (quote === "'" && input[cursor + 1] === "'") {
            current += input[cursor + 1];
            cursor += 2;
            continue;
          }
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      index = cursor;
      continue;
    }
    if (ch === "[") {
      const end = input.indexOf("]", index + 1);
      const stop = end < 0 ? length : end + 1;
      current += input.slice(index, stop);
      index = stop;
      continue;
    }
    if (ch === "$") {
      const match = /^\$[A-Za-z0-9_]*\$/.exec(input.slice(index));
      if (match !== null) {
        const tag = match[0];
        const end = input.indexOf(tag, index + tag.length);
        const stop = end < 0 ? length : end + tag.length;
        current += input.slice(index, stop);
        index = stop;
        continue;
      }
    }
    if (ch === ";") {
      flush();
      index += 1;
      continue;
    }
    current += ch;
    index += 1;
  }
  flush();
  return statements;
}
