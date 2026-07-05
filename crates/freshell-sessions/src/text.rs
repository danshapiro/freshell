//! String helpers ported 1:1 from the reference so the parsers reproduce identical
//! session-id / title / first-user-message extraction.
//!
//! Sources:
//! - `looks_like_path`            <- `shared/path-utils.ts` `looksLikePath`
//! - `extract_title_from_message` <- `shared/title-utils.ts` `extractTitleFromMessage`
//! - `normalize_first_user_message` <- `server/coding-cli/types.ts` `normalizeFirstUserMessage`
//! - `is_system_context`/`extract_from_ide_context`/`extract_user_authored_text` <- `server/coding-cli/utils.ts`
//! - `is_canonical_claude_session_id` <- `shared/session-contract.ts` `CLAUDE_SESSION_ID_RE`
//!
//! Regexes are reimplemented with explicit scanners (no regex crate) but the accepted
//! languages match the originals; the parser parity + helper unit tests pin this.

const FIRST_USER_MESSAGE_MAX_CHARS: usize = 4000;

/// `shared/path-utils.ts` `looksLikePath`.
///
/// Rejects `scheme://` URLs; accepts `~`/`.`/`..`, and anything containing a `/` or `\`
/// or a `C:\` Windows drive prefix.
pub fn looks_like_path(s: &str) -> bool {
    if is_url_like(s) {
        return false;
    }
    if s == "~" || s == "." || s == ".." {
        return true;
    }
    s.contains('/') || s.contains('\\') || is_windows_drive_backslash(s)
}

/// `/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//` — scheme followed by `://`.
fn is_url_like(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_alphabetic() {
        return false;
    }
    let mut i = 1;
    while i < bytes.len() {
        let c = bytes[i];
        if c.is_ascii_alphanumeric() || c == b'+' || c == b'.' || c == b'-' {
            i += 1;
        } else {
            break;
        }
    }
    s[i..].starts_with("://")
}

/// `/^[A-Za-z]:\\/` — a Windows drive letter followed by a backslash.
fn is_windows_drive_backslash(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\'
}

/// `shared/title-utils.ts` `extractTitleFromMessage`.
///
/// Multi-line: first non-empty line, whitespace-collapsed, truncated. Single-line:
/// trimmed + whitespace-collapsed + truncated.
pub fn extract_title_from_message(content: &str, max_len: usize) -> String {
    if content.contains('\n') {
        if let Some(first_line) = content.split('\n').find(|line| !line.trim().is_empty()) {
            let cleaned = collapse_whitespace(first_line.trim());
            return truncate_chars(&cleaned, max_len);
        }
        return String::new();
    }
    let cleaned = collapse_whitespace(content.trim());
    truncate_chars(&cleaned, max_len)
}

/// `content.trim().replace(/\s+/g, ' ')` — collapse each run of whitespace to one space.
fn collapse_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_ws = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !in_ws {
                out.push(' ');
                in_ws = true;
            }
        } else {
            out.push(ch);
            in_ws = false;
        }
    }
    out
}

/// `String.prototype.slice(0, maxLen)` truncation (by code point, close enough to the
/// UTF-16 semantics for the BMP text these transcripts carry).
fn truncate_chars(s: &str, max_len: usize) -> String {
    if s.chars().count() <= max_len {
        return s.to_string();
    }
    s.chars().take(max_len).collect()
}

/// `server/coding-cli/types.ts` `normalizeFirstUserMessage`.
pub fn normalize_first_user_message(content: &str) -> Option<String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() <= FIRST_USER_MESSAGE_MAX_CHARS {
        Some(trimmed.to_string())
    } else {
        Some(trimmed.chars().take(FIRST_USER_MESSAGE_MAX_CHARS).collect())
    }
}

const USER_CONTEXT_TAGS: &[&str] = &[
    "environment_context",
    "system_context",
    "system",
    "context",
    "instructions",
    "user_instructions",
    "permissions",
    "collaboration_mode",
    "skills_instructions",
];

// The subset used by the leading `<tag[>\s]` system-context check (matches the alternation
// in the first `isSystemContext` regex).
const SYSTEM_CONTEXT_LEAD_TAGS: &[&str] = &[
    "environment_context",
    "system_context",
    "system",
    "context",
    "instructions",
    "user_instructions",
    "permissions",
    "collaboration_mode",
    "skills_instructions",
];

/// `server/coding-cli/utils.ts` `isSystemContext`.
pub fn is_system_context(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }

    // /^<(environment_context|...)[>\s]/i
    if let Some(rest) = trimmed.strip_prefix('<') {
        let lower = rest.to_ascii_lowercase();
        for tag in SYSTEM_CONTEXT_LEAD_TAGS {
            if lower.starts_with(tag) {
                if let Some(next) = rest[tag.len()..].chars().next() {
                    if next == '>' || next.is_whitespace() {
                        return true;
                    }
                }
            }
        }
    }

    // /^#\s*(AGENTS|Instructions?|System)/i
    if let Some(after_hash) = trimmed.strip_prefix('#') {
        let body = after_hash.trim_start();
        let lower = body.to_ascii_lowercase();
        if lower.starts_with("agents")
            || lower.starts_with("instructions")
            || lower.starts_with("instruction")
            || lower.starts_with("system")
        {
            return true;
        }
    }

    // /^Base directory for this skill:\s+/i
    if starts_with_ci(trimmed, "base directory for this skill:")
        && trimmed["base directory for this skill:".len()..]
            .starts_with(char::is_whitespace)
    {
        return true;
    }

    // /^\[[A-Z][A-Z_ ]*:/ — bracketed uppercase mode tag.
    if is_bracketed_mode_tag(trimmed) {
        return true;
    }

    // /^#\s*Context from my IDE setup:/i
    if let Some(after_hash) = trimmed.strip_prefix('#') {
        let body = after_hash.trim_start();
        if starts_with_ci(body, "context from my ide setup:") {
            return true;
        }
    }

    // /^\d+,\s/ — pasted log/debug output (digit run, comma, whitespace).
    if is_digit_comma_ws(trimmed) {
        return true;
    }

    // /^You are an automated\b/i
    if starts_with_ci(trimmed, "you are an automated") {
        let after = &trimmed["you are an automated".len()..];
        if after.is_empty() || !after.starts_with(is_word_char) {
            return true;
        }
    }

    // /^[>$]\s+[a-zA-Z.\/]/ pasted shell output, with the prose disambiguation.
    if let Some(first) = trimmed.chars().next() {
        if first == '>' || first == '$' {
            let after_prefix_raw = &trimmed[1..];
            let after_prefix = after_prefix_raw.trim_start();
            // Require at least one whitespace after the prefix and a command-ish first char.
            if after_prefix_raw.len() != after_prefix.len() {
                if let Some(c) = after_prefix.chars().next() {
                    // char class [a-zA-Z.\/] then the prose disambiguation.
                    let matches_class = c.is_ascii_alphabetic() || c == '.' || c == '/';
                    let command_ish = c.is_ascii_lowercase()
                        || after_prefix.starts_with("./")
                        || after_prefix.starts_with('/');
                    if matches_class && command_ish {
                        return true;
                    }
                }
            }
        }
    }

    false
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn starts_with_ci(haystack: &str, needle_lower: &str) -> bool {
    let h = haystack.as_bytes();
    let n = needle_lower.as_bytes();
    if h.len() < n.len() {
        return false;
    }
    h[..n.len()].eq_ignore_ascii_case(n)
}

fn is_bracketed_mode_tag(s: &str) -> bool {
    let b = s.as_bytes();
    if b.first() != Some(&b'[') {
        return false;
    }
    // [A-Z]
    if b.len() < 2 || !b[1].is_ascii_uppercase() {
        return false;
    }
    // [A-Z_ ]* then ':'
    let mut i = 2;
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_uppercase() || c == b'_' || c == b' ' {
            i += 1;
        } else {
            break;
        }
    }
    i < b.len() && b[i] == b':'
}

fn is_digit_comma_ws(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i == 0 {
        return false;
    }
    // ',' then a whitespace char
    b.get(i) == Some(&b',')
        && s[i + 1..].chars().next().map(|c| c.is_whitespace()).unwrap_or(false)
}

/// `server/coding-cli/utils.ts` `extractFromIdeContext`.
pub fn extract_from_ide_context(text: &str) -> Option<String> {
    let mut in_request = false;
    for line in text.split('\n') {
        // /^##\s*My request for Codex:/i
        let l = line.trim_start();
        if let Some(after) = strip_prefix_ci(l, "##") {
            let body = after.trim_start();
            if starts_with_ci(body, "my request for codex:") {
                in_request = true;
                continue;
            }
        }
        if in_request {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn strip_prefix_ci<'a>(haystack: &'a str, needle_lower: &str) -> Option<&'a str> {
    if starts_with_ci(haystack, needle_lower) {
        Some(&haystack[needle_lower.len()..])
    } else {
        None
    }
}

/// `server/coding-cli/utils.ts` `extractUserAuthoredText`.
///
/// Returns only text authored as the user's task/request, stripping the system context
/// that coding CLIs serialize as `role:"user"` records.
pub fn extract_user_authored_text(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some(ide_request) = extract_from_ide_context(trimmed) {
        return Some(ide_request);
    }

    if !is_system_context(trimmed) {
        let cleaned = strip_image_tags(trimmed);
        let cleaned = cleaned.trim();
        return if cleaned.is_empty() {
            None
        } else {
            Some(cleaned.to_string())
        };
    }

    let mut rest = trimmed.to_string();
    let mut removed_structured_block = false;
    loop {
        let before = rest.clone();
        rest = rest.trim().to_string();

        // /^#\s*AGENTS(?:\.md)? instructions[^\n]*(?:\n|$)/i
        if let Some(consumed) = match_agents_header(&rest) {
            rest = rest[consumed..].to_string();
            continue;
        }

        // /^<([a-zA-Z_][\w-]*)\b[^>]*>/
        if let Some((tag, open_len)) = match_xml_open(&rest) {
            if !USER_CONTEXT_TAGS.contains(&tag.to_ascii_lowercase().as_str()) {
                return None;
            }
            let close = format!("</{tag}>");
            match find_ci(&rest, &close) {
                Some(idx) => {
                    let _ = open_len;
                    rest = rest[idx + close.len()..].to_string();
                    removed_structured_block = true;
                    continue;
                }
                None => return None,
            }
        }

        if rest == before {
            break;
        }
    }

    if !removed_structured_block {
        return None;
    }

    let cleaned = strip_image_tags(&rest);
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.to_string())
    }
}

/// Remove `<image ...>` / `</image>` tags (`/<\/?image[^>]*>/g`).
fn strip_image_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            // optional '/'
            let mut j = i + 1;
            if j < bytes.len() && bytes[j] == b'/' {
                j += 1;
            }
            if s[j..].len() >= 5 && s[j..j + 5].eq_ignore_ascii_case("image") {
                // consume up to and including the next '>'
                if let Some(gt) = s[j..].find('>') {
                    i = j + gt + 1;
                    continue;
                }
            }
        }
        // push this char
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// `/^#\s*AGENTS(?:\.md)? instructions[^\n]*(?:\n|$)/i` — returns bytes consumed.
fn match_agents_header(s: &str) -> Option<usize> {
    let rest = s.strip_prefix('#')?;
    let after_hash_ws = rest.trim_start();
    let ws_len = rest.len() - after_hash_ws.len();
    let mut idx = 0usize;
    if !starts_with_ci(after_hash_ws, "agents") {
        return None;
    }
    idx += "agents".len();
    if starts_with_ci(&after_hash_ws[idx..], ".md") {
        idx += ".md".len();
    }
    if !starts_with_ci(&after_hash_ws[idx..], " instructions") {
        return None;
    }
    idx += " instructions".len();
    // [^\n]* up to newline or end
    let tail = &after_hash_ws[idx..];
    let line_end = tail.find('\n').map(|n| n + 1).unwrap_or(tail.len());
    Some(1 + ws_len + idx + line_end)
}

/// `/^<([a-zA-Z_][\w-]*)\b[^>]*>/` — returns (tag, matched length).
fn match_xml_open(s: &str) -> Option<(String, usize)> {
    let bytes = s.as_bytes();
    if bytes.first() != Some(&b'<') {
        return None;
    }
    let mut i = 1;
    // first tag char: [a-zA-Z_]
    if i >= bytes.len() || !(bytes[i].is_ascii_alphabetic() || bytes[i] == b'_') {
        return None;
    }
    let tag_start = i;
    i += 1;
    // [\w-]*  (word char or '-')
    while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'-') {
        i += 1;
    }
    let tag = s[tag_start..i].to_string();
    // [^>]* then '>'
    while i < bytes.len() && bytes[i] != b'>' {
        i += 1;
    }
    if i < bytes.len() && bytes[i] == b'>' {
        Some((tag, i + 1))
    } else {
        None
    }
}

fn find_ci(haystack: &str, needle_lower_or_mixed: &str) -> Option<usize> {
    let h = haystack.as_bytes();
    let n = needle_lower_or_mixed.as_bytes();
    if n.is_empty() || h.len() < n.len() {
        return None;
    }
    for start in 0..=h.len() - n.len() {
        if h[start..start + n.len()].eq_ignore_ascii_case(n) {
            return Some(start);
        }
    }
    None
}

/// `shared/session-contract.ts`
/// `CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`.
pub fn is_canonical_claude_session_id(value: &str) -> bool {
    let b = value.as_bytes();
    if b.len() != 36 {
        return false;
    }
    let hex = |c: u8| c.is_ascii_hexdigit();
    // 8-4-4-4-12 with dashes at 8,13,18,23
    for (i, &c) in b.iter().enumerate() {
        match i {
            8 | 13 | 18 | 23 => {
                if c != b'-' {
                    return false;
                }
            }
            14 => {
                // version [1-5]
                if !(b'1'..=b'5').contains(&c) {
                    return false;
                }
            }
            19 => {
                // variant [89ab] (case-insensitive)
                let lc = c.to_ascii_lowercase();
                if !matches!(lc, b'8' | b'9' | b'a' | b'b') {
                    return false;
                }
            }
            _ => {
                if !hex(c) {
                    return false;
                }
            }
        }
    }
    true
}
