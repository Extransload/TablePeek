// A statement as written in the editor, and where it is.
export interface SqlRange {
  // Its first character (comments written just before it count as part of it).
  from: number;
  // Its first character that isn't a comment.
  codeFrom: number;
  // Just past its ";", or the end of the text.
  to: number;
  // The statement itself, trimmed, without the ";".
  text: string;
}

// What the engine's SQL allows, which decides what ends a statement:
// # comments, backslash escapes and /*! code */ are MySQL's, [names] SQL
// Server's and SQLite's, $tag$ bodies and E'…' strings PostgreSQL's.
// Unknown: everything, as before.
export interface Lexing {
  hashComments: boolean;
  backslashEscapes: boolean;
  bracketNames: boolean;
  dollarQuotes: boolean;
  executableComments: boolean;
  escapeStrings: boolean;
}

const NONE: Lexing = {
  hashComments: false,
  backslashEscapes: false,
  bracketNames: false,
  dollarQuotes: false,
  executableComments: false,
  escapeStrings: false,
};

export function lexingFor(dialect: string | undefined): Lexing {
  switch (dialect) {
    case "mysql":
    case "mariadb":
      return { ...NONE, hashComments: true, backslashEscapes: true, executableComments: true };
    case "postgres":
    case "cockroach":
      return { ...NONE, dollarQuotes: true, escapeStrings: true };
    case "mssql":
    case "sqlite":
      return { ...NONE, bracketNames: true };
    default:
      return {
        hashComments: true,
        backslashEscapes: true,
        bracketNames: true,
        dollarQuotes: true,
        executableComments: true,
        escapeStrings: true,
      };
  }
}

// BEGIN opens a block (a trigger's or procedure's body, closed by END) when
// a statement follows it (or MariaDB's NOT ATOMIC); BEGIN; or BEGIN
// TRANSACTION starts a transaction, and "SELECT begin FROM t" is a column.
const BLOCK_STARTERS = new Set([
  "SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE", "UPSERT", "WITH", "SET", "DECLARE",
  "IF", "CASE", "WHILE", "LOOP", "REPEAT", "FOR", "RETURN", "BEGIN", "END", "CALL", "EXEC", "EXECUTE",
  "PRINT", "RAISERROR", "THROW", "TRY", "CATCH", "SIGNAL", "RESIGNAL", "LEAVE", "ITERATE", "OPEN",
  "FETCH", "CLOSE", "CREATE", "DROP", "ALTER", "TRUNCATE", "GRANT", "REVOKE", "LOCK", "PERFORM",
  "RAISE", "NULL", "WAITFOR", "GOTO", "USE",
]);
// MySQL's END IF; / END LOOP lbl; close blocks whose openers aren't
// counted. SQL Server has none of them: there END, then IF @x = 1 …, is a
// block's end and the next statement; only a ; (after at most a label) tells
// the two apart.
const END_UNCOUNTED = new Set(["IF", "LOOP", "WHILE", "REPEAT", "FOR"]);
// END CASE closes the CASE counted at its start (and must not count as
// another), END TRY / END CATCH their BEGIN.
const END_NAMED = new Set(["CASE", "TRY", "CATCH"]);

const WORD = /[A-Za-z_][A-Za-z0-9_$]*/y;
const DOLLAR_TAG = /\$[A-Za-z0-9_]*\$/y;
const BLANK = /\s/;

// Statements split on ";" outside quotes, comments and BEGIN … END bodies
// (triggers, procedures), with their places. A stretch holding only comments
// isn't a statement: it would run as nothing, or fail. MySQL's /*! … */ is
// code, which mysqldump writes its SET and CREATE VIEW statements in.
export function splitSqlRanges(input: string, dialect?: string): SqlRange[] {
  const lex = lexingFor(dialect);
  const ranges: SqlRange[] = [];
  let start = -1;
  let codeStart = -1;
  // The blocks open at this point, innermost last: a BEGIN body or a CASE.
  const open: ("BEGIN" | "CASE")[] = [];
  let index = 0;
  const length = input.length;

  function flush(end: number, to: number): void {
    if (codeStart >= 0) {
      ranges.push({ from: start, codeFrom: codeStart, to, text: input.slice(start, end).trim() });
    }
    start = -1;
    codeStart = -1;
    open.length = 0;
  }

  // Marks where a statement begins (its first non-blank character), and
  // where its first code is.
  function begin(at: number, code: boolean): void {
    if (start < 0) {
      start = at;
    }
    if (code && codeStart < 0) {
      codeStart = at;
    }
  }

  // Whether a ; (or the end of the text) follows `from`, after at most one
  // word: END IF; or END LOOP lbl; rather than END, then IF @x = 1.
  function endsStatement(from: number): boolean {
    const atEnd = (next: { word: string; end: number }): boolean =>
      next.word === ";" || (next.word === "" && next.end >= length);
    const next = nextWord(from);
    return atEnd(next) || (next.word !== "" && atEnd(nextWord(next.end)));
  }

  // The next word after `from`, blanks and comments aside, and where it ends.
  function nextWord(from: number): { word: string; end: number } {
    let at = from;
    while (at < length) {
      if (BLANK.test(input[at])) {
        at += 1;
      } else if (input.startsWith("--", at) || (input[at] === "#" && lex.hashComments)) {
        const end = input.indexOf("\n", at);
        at = end < 0 ? length : end;
      } else if (input.startsWith("/*", at)) {
        const end = input.indexOf("*/", at + 2);
        at = end < 0 ? length : end + 2;
      } else {
        break;
      }
    }
    if (input[at] === ";") {
      return { word: ";", end: at + 1 };
    }
    WORD.lastIndex = at;
    const word = WORD.exec(input)?.[0] ?? "";
    return { word: word.toUpperCase(), end: at + word.length };
  }

  while (index < length) {
    const ch = input[index];
    const next = index + 1 < length ? input[index + 1] : "";

    if ((ch === "-" && next === "-") || (ch === "#" && lex.hashComments)) {
      begin(index, false);
      const end = input.indexOf("\n", index);
      index = end < 0 ? length : end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const executable =
        lex.executableComments && (input[index + 2] === "!" || input.startsWith("M!", index + 2));
      begin(index, executable);
      const end = input.indexOf("*/", index + 2);
      index = end < 0 ? length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      begin(index, true);
      const quote = ch;
      const escapes = (lex.backslashEscapes && quote !== "`") || (lex.escapeStrings && escapeString(input, index));
      let cursor = index + 1;
      while (cursor < length) {
        const inner = input[cursor];
        if (inner === "\\" && escapes && cursor + 1 < length) {
          cursor += 2;
          continue;
        }
        if (inner === quote) {
          if (input[cursor + 1] === quote) {
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
    if (ch === "[" && lex.bracketNames) {
      begin(index, true);
      const end = input.indexOf("]", index + 1);
      index = end < 0 ? length : end + 1;
      continue;
    }
    if (ch === "$" && lex.dollarQuotes) {
      DOLLAR_TAG.lastIndex = index;
      const match = DOLLAR_TAG.exec(input);
      if (match !== null) {
        begin(index, true);
        const tag = match[0];
        const end = input.indexOf(tag, index + tag.length);
        index = end < 0 ? length : end + tag.length;
        continue;
      }
    }
    if (ch === ";") {
      if (open.length > 0) {
        index += 1;
        continue;
      }
      flush(index, index + 1);
      index += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      begin(index, true);
      WORD.lastIndex = index;
      const word = WORD.exec(input)?.[0] ?? ch;
      const upper = word.toUpperCase();
      const after = index + word.length;
      // @end, NEW.end, :begin, #case… are names, not keywords; lbl:BEGIN
      // is a label and its block.
      const before = input[index - 1] ?? "";
      if (/[@.$#]/.test(before) || (before === ":" && !/[A-Za-z0-9_]/.test(input[index - 2] ?? ""))) {
        index = after;
        continue;
      }
      if (upper === "BEGIN") {
        let next = nextWord(after);
        // A labelled statement (MySQL's "l: LOOP"): the word after the label.
        const colon = input.slice(next.end).search(/\S/) + next.end;
        if (next.word !== "" && input[colon] === ":" && input[colon + 1] !== ":" && input[colon + 1] !== "=") {
          next = nextWord(colon + 1);
        }
        if (next.word === "NOT" ? nextWord(next.end).word === "ATOMIC" : BLOCK_STARTERS.has(next.word)) {
          open.push("BEGIN");
        }
      } else if (upper === "CASE") {
        open.push("CASE");
      } else if (upper === "END") {
        const named = nextWord(after);
        // SQL Server's END CONVERSATION @h is a statement, not a block's end.
        if (named.word === "CONVERSATION") {
          index = named.end;
          continue;
        }
        // Inside a CASE, END IF; / END LOOP l; close a block in one of its
        // branches (a CASE statement's), and any other END closes the CASE:
        // CASE … END FOR UPDATE; is a locking read, not MySQL's END FOR, which
        // counts here only with nothing between it and its ";".
        if (open[open.length - 1] === "CASE") {
          const inBranch =
            (END_UNCOUNTED.has(named.word) && named.word !== "FOR" && endsStatement(named.end)) ||
            (named.word === "FOR" && nextWord(named.end).word === ";");
          if (inBranch) {
            index = named.end;
            continue;
          }
          open.pop();
          index = named.word === "CASE" ? named.end : after;
          continue;
        }
        const uncounted = END_UNCOUNTED.has(named.word) && endsStatement(named.end);
        if (!uncounted) {
          open.pop();
        }
        if (uncounted || END_NAMED.has(named.word)) {
          index = named.end;
          continue;
        }
      }
      index = after;
      continue;
    }
    if (!BLANK.test(ch)) {
      begin(index, true);
    }
    index += 1;
  }
  flush(length, length);
  return ranges;
}

// Whether the quote at `at` opens PostgreSQL's E'…' string, where a
// backslash escapes: an E (or e) right before it that isn't a name's end.
export function escapeString(input: string, at: number): boolean {
  return input[at] === "'" && /[Ee]/.test(input[at - 1] ?? "") && !/[A-Za-z0-9_$]/.test(input[at - 2] ?? "");
}

export function splitSqlStatements(input: string, dialect?: string): string[] {
  return splitSqlRanges(input, dialect).map((range) => range.text);
}

// The statement a cursor at `offset` belongs to: the one whose code it is in;
// else the one just before it when only blank space (or the rest of its line,
// "SELECT 1; -- note") lies between; else the one after it when only blank
// space does. Nothing for a cursor in comment lines: a commented-out statement
// above another must not run that other one.
export function statementAt(input: string, offset: number, dialect?: string): SqlRange | null {
  const ranges = splitSqlRanges(input, dialect);
  // A cursor at the start of a comment line is on that line, not after the
  // statement above it.
  const lineStart = input.lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = input.indexOf("\n", offset);
  const rest = input.slice(offset, lineEnd < 0 ? input.length : lineEnd).trimStart();
  const commentLine =
    input.slice(lineStart, offset).trim() === "" &&
    (rest.startsWith("--") || rest.startsWith("/*") || (rest.startsWith("#") && lexingFor(dialect).hashComments));
  const blank = (from: number, to: number): boolean => input.slice(from, to).trim() === "";
  const sameLine = (from: number, to: number): boolean => !input.slice(from, to).includes("\n");
  let before: SqlRange | null = null;
  for (const range of ranges) {
    if (offset >= range.codeFrom && offset <= range.to) {
      return range;
    }
    if (offset < range.codeFrom) {
      if (before !== null && ((blank(before.to, offset) && !commentLine) || sameLine(before.to, offset))) {
        return before;
      }
      return blank(offset, range.codeFrom) ? range : null;
    }
    before = range;
  }
  return before !== null && ((blank(before.to, offset) && !commentLine) || sameLine(before.to, offset))
    ? before
    : null;
}
