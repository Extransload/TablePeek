pub(crate) fn trim_ident(name: &str) -> String {
    name.trim_matches(|c| matches!(c, '`' | '"' | '\'' | '[' | ']'))
        .to_string()
}

pub(crate) fn parse_single_table(sql: &str) -> Option<(Option<String>, String)> {
    if first_word(sql) != "select" {
        return None;
    }
    if find_keyword(sql, "join", 0).is_some() || find_keyword(sql, "union", 0).is_some() {
        return None;
    }
    let from_pos = find_keyword(sql, "from", 0)?;
    let rest = sql[from_pos + 4..].trim_start();
    if rest.is_empty() || rest.starts_with('(') {
        return None;
    }
    let end = rest
        .find(|c: char| c.is_whitespace() || matches!(c, ',' | '(' | ')' | ';'))
        .unwrap_or(rest.len());
    let token = &rest[..end];
    if token.is_empty() {
        return None;
    }
    if rest[end..].trim_start().starts_with(',') {
        return None;
    }
    let parts: Vec<String> = token.split('.').map(trim_ident).collect();
    match parts.len() {
        1 => {
            if parts[0].is_empty() {
                None
            } else {
                Some((None, parts[0].clone()))
            }
        }
        2 => {
            if parts[0].is_empty() || parts[1].is_empty() {
                None
            } else {
                Some((Some(parts[0].clone()), parts[1].clone()))
            }
        }
        _ => None,
    }
}

fn first_word(sql: &str) -> String {
    sql.trim_start()
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect::<String>()
        .to_lowercase()
}

fn find_keyword(sql: &str, keyword: &str, target_depth: usize) -> Option<usize> {
    let bytes = sql.as_bytes();
    let keyword = keyword.as_bytes();
    if keyword.is_empty() {
        return None;
    }
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    let mut index = 0usize;
    while index < bytes.len() {
        let byte = bytes[index];
        match quote {
            Some(active) => {
                if byte == b'\\' && active != b'`' {
                    index += 2;
                    continue;
                }
                if byte == active {
                    quote = None;
                }
            }
            None => match byte {
                b'\'' | b'"' | b'`' | b'[' => quote = Some(if byte == b'[' { b']' } else { byte }),
                b'(' => {
                    depth += 1;
                }
                b')' => {
                    depth = depth.saturating_sub(1);
                }
                _ => {
                    if depth == target_depth
                        && byte.eq_ignore_ascii_case(&keyword[0])
                        && index + keyword.len() <= bytes.len()
                        && bytes[index..index + keyword.len()].eq_ignore_ascii_case(keyword)
                    {
                        let before_ok = index == 0
                            || bytes[index - 1].is_ascii_whitespace()
                            || bytes[index - 1] == b'(';
                        let after = index + keyword.len();
                        let after_ok = after == bytes.len()
                            || bytes[after].is_ascii_whitespace()
                            || bytes[after] == b'(';
                        if before_ok && after_ok {
                            return Some(index);
                        }
                    }
                }
            },
        }
        index += 1;
    }
    None
}
