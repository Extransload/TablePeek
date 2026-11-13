//! Console commands: a line split into arguments the way redis-cli splits
//! it, arguments written back the way redis-cli shows them (for the console
//! log, History and confirmations), and what a command does, so safe mode
//! knows when to ask.

use crate::keyvalue::CommandClass;

/// A line split into arguments as redis-cli does (`sdssplitargs`): blanks
/// separate them; "double quotes" take `\n \r \t \b \a \\ \"` and `\xHH`
/// escapes; 'single quotes' take only `\'`. A closing quote must end the
/// argument. Err with the reason for an unbalanced or misplaced quote.
pub(super) fn split_args(line: &str) -> Result<Vec<Vec<u8>>, &'static str> {
    let bytes = line.as_bytes();
    let mut args = Vec::new();
    let mut at = 0;
    loop {
        while at < bytes.len() && bytes[at].is_ascii_whitespace() {
            at += 1;
        }
        if at >= bytes.len() {
            return Ok(args);
        }
        let mut arg = Vec::new();
        let mut in_double = false;
        let mut in_single = false;
        loop {
            if in_double {
                let Some(&byte) = bytes.get(at) else {
                    return Err("닫는 큰따옴표가 없습니다");
                };
                if byte == b'\\'
                    && bytes.get(at + 1) == Some(&b'x')
                    && bytes.get(at + 2).is_some_and(u8::is_ascii_hexdigit)
                    && bytes.get(at + 3).is_some_and(u8::is_ascii_hexdigit)
                {
                    let hex = std::str::from_utf8(&bytes[at + 2..at + 4]).unwrap_or("00");
                    arg.push(u8::from_str_radix(hex, 16).unwrap_or(0));
                    at += 4;
                } else if byte == b'\\' && at + 1 < bytes.len() {
                    arg.push(match bytes[at + 1] {
                        b'n' => b'\n',
                        b'r' => b'\r',
                        b't' => b'\t',
                        b'b' => 0x08,
                        b'a' => 0x07,
                        other => other,
                    });
                    at += 2;
                } else if byte == b'"' {
                    if bytes
                        .get(at + 1)
                        .is_some_and(|next| !next.is_ascii_whitespace())
                    {
                        return Err("닫는 큰따옴표 뒤에는 공백이 와야 합니다");
                    }
                    at += 1;
                    break;
                } else {
                    arg.push(byte);
                    at += 1;
                }
            } else if in_single {
                let Some(&byte) = bytes.get(at) else {
                    return Err("닫는 작은따옴표가 없습니다");
                };
                if byte == b'\\' && bytes.get(at + 1) == Some(&b'\'') {
                    arg.push(b'\'');
                    at += 2;
                } else if byte == b'\'' {
                    if bytes
                        .get(at + 1)
                        .is_some_and(|next| !next.is_ascii_whitespace())
                    {
                        return Err("닫는 작은따옴표 뒤에는 공백이 와야 합니다");
                    }
                    at += 1;
                    break;
                } else {
                    arg.push(byte);
                    at += 1;
                }
            } else {
                match bytes.get(at) {
                    None => break,
                    Some(byte) if byte.is_ascii_whitespace() => break,
                    Some(b'"') => {
                        in_double = true;
                        at += 1;
                    }
                    Some(b'\'') => {
                        in_single = true;
                        at += 1;
                    }
                    Some(&byte) => {
                        arg.push(byte);
                        at += 1;
                    }
                }
            }
        }
        args.push(arg);
    }
}

/// One argument as redis-cli would take it back: as it is when that is
/// unambiguous, else in double quotes with escapes.
pub(super) fn quote_arg(arg: &[u8]) -> String {
    let plain = !arg.is_empty()
        && std::str::from_utf8(arg).is_ok_and(|text| {
            !text
                .chars()
                .any(|ch| ch.is_whitespace() || ch.is_control() || matches!(ch, '"' | '\'' | '\\'))
        });
    if plain {
        return String::from_utf8_lossy(arg).into_owned();
    }
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('"');
    let text = String::from_utf8_lossy(arg);
    if std::str::from_utf8(arg).is_ok() {
        for ch in text.chars() {
            push_escaped(&mut out, ch);
        }
    } else {
        for &byte in arg {
            if byte.is_ascii() {
                push_escaped(&mut out, byte as char);
            } else {
                out.push_str(&format!("\\x{byte:02x}"));
            }
        }
    }
    out.push('"');
    out
}

fn push_escaped(out: &mut String, ch: char) {
    match ch {
        '"' => out.push_str("\\\""),
        '\\' => out.push_str("\\\\"),
        '\n' => out.push_str("\\n"),
        '\r' => out.push_str("\\r"),
        '\t' => out.push_str("\\t"),
        '\u{7}' => out.push_str("\\a"),
        '\u{8}' => out.push_str("\\b"),
        ch if ch.is_control() && (ch as u32) < 0x100 => {
            out.push_str(&format!("\\x{:02x}", ch as u32));
        }
        ch => out.push(ch),
    }
}

/// A command as redis-cli shows it, the passwords of AUTH, HELLO … AUTH
/// and MIGRATE … AUTH/AUTH2 masked.
pub(super) fn command_text(args: &[&[u8]]) -> String {
    let name = args
        .first()
        .map(|name| String::from_utf8_lossy(name).to_ascii_uppercase())
        .unwrap_or_default();
    let after = |word: &[u8]| args.iter().position(|arg| arg.eq_ignore_ascii_case(word));
    let secret = match name.as_str() {
        // AUTH password, or AUTH user password.
        "AUTH" => Some(args.len().saturating_sub(1)).filter(|at| *at >= 1),
        // HELLO 3 AUTH user password.
        "HELLO" => after(b"AUTH").map(|at| at + 2),
        // MIGRATE … AUTH password, or AUTH2 user password.
        "MIGRATE" => after(b"AUTH2")
            .map(|at| at + 2)
            .or_else(|| after(b"AUTH").map(|at| at + 1)),
        _ => None,
    };
    args.iter()
        .enumerate()
        .map(|(at, arg)| {
            if Some(at) == secret {
                "********".to_string()
            } else {
                quote_arg(arg)
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Commands with subcommands: their name is the two words ("CONFIG SET").
const CONTAINERS: &[&str] = &[
    "ACL", "CLIENT", "CLUSTER", "COMMAND", "CONFIG", "DEBUG", "FUNCTION", "LATENCY", "MEMORY",
    "MODULE", "OBJECT", "PUBSUB", "SCRIPT", "SLOWLOG", "XGROUP", "XINFO",
];

/// The command's name in capitals: the first word, or the first two for a
/// command with subcommands.
pub(super) fn command_name(args: &[Vec<u8>]) -> String {
    let Some(first) = args.first() else {
        return String::new();
    };
    let name = String::from_utf8_lossy(first).to_ascii_uppercase();
    if CONTAINERS.contains(&name.as_str()) {
        if let Some(sub) = args.get(1) {
            return format!(
                "{name} {}",
                String::from_utf8_lossy(sub).to_ascii_uppercase()
            );
        }
    }
    name
}

/// What the console never sends: commands that take the connection over
/// (subscriptions, MONITOR, replication) or change who or what it is.
const REFUSED: &[(&str, &str)] = &[
    (
        "SUBSCRIBE",
        "구독 명령은 콘솔에서 쓸 수 없습니다 (연결을 계속 차지합니다)",
    ),
    (
        "PSUBSCRIBE",
        "구독 명령은 콘솔에서 쓸 수 없습니다 (연결을 계속 차지합니다)",
    ),
    (
        "SSUBSCRIBE",
        "구독 명령은 콘솔에서 쓸 수 없습니다 (연결을 계속 차지합니다)",
    ),
    (
        "UNSUBSCRIBE",
        "구독 명령은 콘솔에서 쓸 수 없습니다 (연결을 계속 차지합니다)",
    ),
    (
        "PUNSUBSCRIBE",
        "구독 명령은 콘솔에서 쓸 수 없습니다 (연결을 계속 차지합니다)",
    ),
    (
        "SUNSUBSCRIBE",
        "구독 명령은 콘솔에서 쓸 수 없습니다 (연결을 계속 차지합니다)",
    ),
    (
        "MONITOR",
        "MONITOR는 콘솔에서 쓸 수 없습니다 (연결을 계속 차지합니다)",
    ),
    ("SYNC", "복제 명령은 콘솔에서 쓸 수 없습니다"),
    ("PSYNC", "복제 명령은 콘솔에서 쓸 수 없습니다"),
    ("QUIT", "연결을 끊는 명령은 콘솔에서 쓸 수 없습니다"),
    (
        "RESET",
        "연결을 처음 상태로 되돌리는 명령은 콘솔에서 쓸 수 없습니다",
    ),
    ("HELLO", "프로토콜과 인증은 연결 설정에서 정하세요"),
    ("AUTH", "프로토콜과 인증은 연결 설정에서 정하세요"),
    ("CLIENT REPLY", "응답을 끄는 명령은 콘솔에서 쓸 수 없습니다"),
    (
        "CLIENT TRACKING",
        "클라이언트 캐시 추적은 콘솔에서 쓸 수 없습니다",
    ),
];

/// Destructive or server-wide commands, with why they are.
const DANGER: &[(&str, &str)] = &[
    ("FLUSHALL", "모든 데이터베이스의 키를 지웁니다"),
    ("FLUSHDB", "이 데이터베이스의 키를 모두 지웁니다"),
    ("SHUTDOWN", "서버를 멈춥니다"),
    ("SWAPDB", "두 데이터베이스의 내용을 맞바꿉니다"),
    (
        "SAVE",
        "저장이 끝날 때까지 서버가 다른 명령을 받지 않습니다",
    ),
    ("REPLICAOF", "서버의 복제 설정을 바꿉니다"),
    ("SLAVEOF", "서버의 복제 설정을 바꿉니다"),
    ("FAILOVER", "마스터를 바꿉니다"),
    ("MIGRATE", "키를 다른 서버로 옮깁니다"),
    ("CONFIG SET", "서버 설정을 바꿉니다"),
    ("CONFIG RESETSTAT", "서버 통계를 지웁니다"),
    ("CONFIG REWRITE", "서버의 설정 파일을 다시 씁니다"),
    ("CLIENT KILL", "다른 클라이언트의 연결을 끊습니다"),
    ("CLIENT PAUSE", "모든 클라이언트의 명령을 멈춥니다"),
    ("SCRIPT FLUSH", "저장된 스크립트를 모두 지웁니다"),
    ("SCRIPT KILL", "실행 중인 스크립트를 멈춥니다"),
    ("FUNCTION FLUSH", "함수 라이브러리를 모두 지웁니다"),
    ("FUNCTION DELETE", "함수 라이브러리를 지웁니다"),
    ("FUNCTION RESTORE", "함수 라이브러리를 바꿉니다"),
    ("FUNCTION KILL", "실행 중인 함수를 멈춥니다"),
    ("ACL SETUSER", "사용자와 권한을 바꿉니다"),
    ("ACL DELUSER", "사용자를 지웁니다"),
    ("ACL LOAD", "ACL 파일을 다시 읽습니다"),
    ("ACL SAVE", "ACL 파일을 다시 씁니다"),
    ("MODULE LOAD", "서버에 모듈을 올립니다"),
    ("MODULE LOADEX", "서버에 모듈을 올립니다"),
    ("MODULE UNLOAD", "서버에서 모듈을 내립니다"),
    ("CLUSTER RESET", "클러스터 설정을 바꿉니다"),
    ("CLUSTER FAILOVER", "클러스터 설정을 바꿉니다"),
    ("CLUSTER FORGET", "클러스터 설정을 바꿉니다"),
    ("CLUSTER MEET", "클러스터 설정을 바꿉니다"),
    ("CLUSTER ADDSLOTS", "클러스터 설정을 바꿉니다"),
    ("CLUSTER DELSLOTS", "클러스터 설정을 바꿉니다"),
    ("CLUSTER SETSLOT", "클러스터 설정을 바꿉니다"),
    ("CLUSTER REPLICATE", "클러스터 설정을 바꿉니다"),
    ("CLUSTER FLUSHSLOTS", "클러스터 설정을 바꿉니다"),
];

/// Commands that only read, by name; the rest are writes unless the
/// server's COMMAND INFO says they only read.
const READS: &[&str] = &[
    // Keys and strings.
    "GET",
    "MGET",
    "GETRANGE",
    "SUBSTR",
    "STRLEN",
    "LCS",
    "EXISTS",
    "TYPE",
    "TTL",
    "PTTL",
    "EXPIRETIME",
    "PEXPIRETIME",
    "SCAN",
    "DBSIZE",
    "RANDOMKEY",
    "DUMP",
    "TOUCH",
    "GETBIT",
    "BITCOUNT",
    "BITPOS",
    "BITFIELD_RO",
    "PFCOUNT",
    "SORT_RO",
    // Hashes, lists, sets, sorted sets, streams, geo.
    "HGET",
    "HMGET",
    "HGETALL",
    "HKEYS",
    "HVALS",
    "HLEN",
    "HEXISTS",
    "HSTRLEN",
    "HSCAN",
    "HRANDFIELD",
    "HTTL",
    "HPTTL",
    "HEXPIRETIME",
    "HPEXPIRETIME",
    "LRANGE",
    "LINDEX",
    "LLEN",
    "LPOS",
    "SMEMBERS",
    "SISMEMBER",
    "SMISMEMBER",
    "SCARD",
    "SSCAN",
    "SRANDMEMBER",
    "SINTER",
    "SUNION",
    "SDIFF",
    "SINTERCARD",
    "ZRANGE",
    "ZREVRANGE",
    "ZRANGEBYSCORE",
    "ZREVRANGEBYSCORE",
    "ZRANGEBYLEX",
    "ZREVRANGEBYLEX",
    "ZSCORE",
    "ZMSCORE",
    "ZRANK",
    "ZREVRANK",
    "ZCARD",
    "ZCOUNT",
    "ZLEXCOUNT",
    "ZSCAN",
    "ZRANDMEMBER",
    "ZINTER",
    "ZUNION",
    "ZDIFF",
    "ZINTERCARD",
    "XRANGE",
    "XREVRANGE",
    "XLEN",
    "XREAD",
    "XPENDING",
    "XINFO STREAM",
    "XINFO GROUPS",
    "XINFO CONSUMERS",
    "XINFO HELP",
    "GEOPOS",
    "GEODIST",
    "GEOHASH",
    "GEORADIUS_RO",
    "GEORADIUSBYMEMBER_RO",
    "GEOSEARCH",
    // The server and the connection.
    "PING",
    "ECHO",
    "TIME",
    "INFO",
    "LASTSAVE",
    "ROLE",
    "LOLWUT",
    "SELECT",
    "MULTI",
    "DISCARD",
    "WATCH",
    "UNWATCH",
    "WAIT",
    "WAITAOF",
    "READONLY",
    "READWRITE",
    "EVAL_RO",
    "EVALSHA_RO",
    "FCALL_RO",
    "CONFIG GET",
    "CONFIG HELP",
    "CLIENT LIST",
    "CLIENT INFO",
    "CLIENT ID",
    "CLIENT GETNAME",
    "CLIENT SETNAME",
    "CLIENT SETINFO",
    "CLIENT HELP",
    "CLIENT NO-EVICT",
    "CLIENT NO-TOUCH",
    "CLIENT GETREDIR",
    "CLIENT TRACKINGINFO",
    "CLIENT UNPAUSE",
    "COMMAND",
    "COMMAND COUNT",
    "COMMAND DOCS",
    "COMMAND GETKEYS",
    "COMMAND GETKEYSANDFLAGS",
    "COMMAND INFO",
    "COMMAND LIST",
    "COMMAND HELP",
    "SLOWLOG GET",
    "SLOWLOG LEN",
    "SLOWLOG HELP",
    "LATENCY LATEST",
    "LATENCY HISTORY",
    "LATENCY DOCTOR",
    "LATENCY GRAPH",
    "LATENCY HISTOGRAM",
    "LATENCY HELP",
    "MEMORY USAGE",
    "MEMORY STATS",
    "MEMORY DOCTOR",
    "MEMORY MALLOC-STATS",
    "MEMORY HELP",
    "OBJECT ENCODING",
    "OBJECT FREQ",
    "OBJECT IDLETIME",
    "OBJECT REFCOUNT",
    "OBJECT HELP",
    "SCRIPT EXISTS",
    "SCRIPT HELP",
    "FUNCTION LIST",
    "FUNCTION DUMP",
    "FUNCTION STATS",
    "FUNCTION HELP",
    "ACL WHOAMI",
    "ACL LIST",
    "ACL USERS",
    "ACL GETUSER",
    "ACL CAT",
    "ACL LOG",
    "ACL GENPASS",
    "ACL DRYRUN",
    "ACL HELP",
    "MODULE LIST",
    "MODULE HELP",
    "PUBSUB CHANNELS",
    "PUBSUB NUMSUB",
    "PUBSUB NUMPAT",
    "PUBSUB SHARDCHANNELS",
    "PUBSUB SHARDNUMSUB",
    "PUBSUB HELP",
    "CLUSTER INFO",
    "CLUSTER NODES",
    "CLUSTER SLOTS",
    "CLUSTER SHARDS",
    "CLUSTER MYID",
    "CLUSTER KEYSLOT",
    "CLUSTER COUNTKEYSINSLOT",
    "CLUSTER GETKEYSINSLOT",
    "CLUSTER HELP",
    "DEBUG HELP",
    // Modules that ship with Redis 8 and Redis Stack.
    "JSON.GET",
    "JSON.MGET",
    "JSON.TYPE",
    "JSON.STRLEN",
    "JSON.ARRLEN",
    "JSON.ARRINDEX",
    "JSON.OBJKEYS",
    "JSON.OBJLEN",
    "JSON.RESP",
    "JSON.DEBUG",
    "FT.SEARCH",
    "FT.AGGREGATE",
    "FT.INFO",
    "FT._LIST",
    "FT.EXPLAIN",
    "FT.EXPLAINCLI",
    "FT.PROFILE",
    "FT.SPELLCHECK",
    "FT.TAGVALS",
    "FT.DICTDUMP",
    "FT.SYNDUMP",
    "TS.GET",
    "TS.MGET",
    "TS.RANGE",
    "TS.REVRANGE",
    "TS.MRANGE",
    "TS.MREVRANGE",
    "TS.INFO",
    "TS.QUERYINDEX",
    "BF.EXISTS",
    "BF.MEXISTS",
    "BF.INFO",
    "BF.CARD",
    "CF.EXISTS",
    "CF.MEXISTS",
    "CF.COUNT",
    "CF.INFO",
    "CMS.QUERY",
    "CMS.INFO",
    "TOPK.QUERY",
    "TOPK.LIST",
    "TOPK.INFO",
    "TDIGEST.INFO",
    "TDIGEST.QUANTILE",
    "TDIGEST.CDF",
    "TDIGEST.MIN",
    "TDIGEST.MAX",
    "TDIGEST.RANK",
    "TDIGEST.REVRANK",
    "TDIGEST.BYRANK",
    "TDIGEST.BYREVRANK",
    "TDIGEST.TRIMMED_MEAN",
];

/// A DEL or UNLINK of this many keys or more needs the user's word.
pub(super) const MANY_KEYS: usize = 10;

/// KEYS on a database with more keys than this blocks the server long
/// enough to need the user's word.
pub(super) const KEYS_BIG_DB: u64 = 10_000;

/// What a command is, before the server is asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Kind {
    /// Never sent from the console; the reason.
    Refused(&'static str),
    Known(CommandClass, Option<String>),
    /// KEYS: dangerous only on a big database.
    Keys,
    /// Not in the lists: COMMAND INFO decides.
    Unknown,
}

pub(super) fn kind_of(args: &[Vec<u8>]) -> Kind {
    let name = command_name(args);
    let first = name.split(' ').next().unwrap_or_default();
    if let Some((_, reason)) = REFUSED
        .iter()
        .find(|(refused, _)| *refused == name || *refused == first)
    {
        return Kind::Refused(reason);
    }
    if let Some((_, reason)) = DANGER.iter().find(|(danger, _)| *danger == name) {
        return Kind::Known(CommandClass::Danger, Some((*reason).to_string()));
    }
    if first == "DEBUG" && name != "DEBUG HELP" {
        return Kind::Known(
            CommandClass::Danger,
            Some("DEBUG는 서버를 멈추거나 바꿀 수 있습니다".into()),
        );
    }
    if matches!(first, "DEL" | "UNLINK") && args.len() > MANY_KEYS {
        return Kind::Known(
            CommandClass::Danger,
            Some(format!("키 {}개를 한꺼번에 지웁니다", args.len() - 1)),
        );
    }
    if first == "KEYS" {
        return Kind::Keys;
    }
    if READS.contains(&name.as_str()) || READS.contains(&first) && !CONTAINERS.contains(&first) {
        return Kind::Known(CommandClass::Read, None);
    }
    if is_known_write(first) {
        return Kind::Known(CommandClass::Write, None);
    }
    Kind::Unknown
}

/// Writes common enough to be known without asking the server.
fn is_known_write(name: &str) -> bool {
    const WRITES: &[&str] = &[
        "SET",
        "SETNX",
        "SETEX",
        "PSETEX",
        "MSET",
        "MSETNX",
        "GETSET",
        "GETDEL",
        "GETEX",
        "APPEND",
        "SETRANGE",
        "INCR",
        "INCRBY",
        "INCRBYFLOAT",
        "DECR",
        "DECRBY",
        "DEL",
        "UNLINK",
        "EXPIRE",
        "PEXPIRE",
        "EXPIREAT",
        "PEXPIREAT",
        "PERSIST",
        "RENAME",
        "RENAMENX",
        "COPY",
        "MOVE",
        "RESTORE",
        "SORT",
        "SETBIT",
        "BITFIELD",
        "BITOP",
        "PFADD",
        "PFMERGE",
        "HSET",
        "HSETNX",
        "HMSET",
        "HDEL",
        "HINCRBY",
        "HINCRBYFLOAT",
        "HEXPIRE",
        "HPEXPIRE",
        "HPERSIST",
        "HGETDEL",
        "HGETEX",
        "HSETEX",
        "LPUSH",
        "RPUSH",
        "LPUSHX",
        "RPUSHX",
        "LPOP",
        "RPOP",
        "LSET",
        "LREM",
        "LINSERT",
        "LTRIM",
        "LMOVE",
        "RPOPLPUSH",
        "BLPOP",
        "BRPOP",
        "BLMOVE",
        "BRPOPLPUSH",
        "LMPOP",
        "BLMPOP",
        "SADD",
        "SREM",
        "SPOP",
        "SMOVE",
        "SINTERSTORE",
        "SUNIONSTORE",
        "SDIFFSTORE",
        "ZADD",
        "ZREM",
        "ZINCRBY",
        "ZPOPMIN",
        "ZPOPMAX",
        "BZPOPMIN",
        "BZPOPMAX",
        "ZMPOP",
        "BZMPOP",
        "ZREMRANGEBYRANK",
        "ZREMRANGEBYSCORE",
        "ZREMRANGEBYLEX",
        "ZRANGESTORE",
        "ZINTERSTORE",
        "ZUNIONSTORE",
        "ZDIFFSTORE",
        "XADD",
        "XDEL",
        "XTRIM",
        "XACK",
        "XCLAIM",
        "XAUTOCLAIM",
        "XREADGROUP",
        "XSETID",
        "XGROUP",
        "GEOADD",
        "GEOSEARCHSTORE",
        "GEORADIUS",
        "GEORADIUSBYMEMBER",
        "PUBLISH",
        "SPUBLISH",
        "EVAL",
        "EVALSHA",
        "FCALL",
        "EXEC",
        "BGSAVE",
        "BGREWRITEAOF",
        "SLOWLOG",
        "LATENCY",
        "SCRIPT",
        "FUNCTION",
        "CONFIG",
        "CLIENT",
        "ACL",
        "MEMORY",
        "OBJECT",
        "MODULE",
        "CLUSTER",
    ];
    WRITES.contains(&name)
}
