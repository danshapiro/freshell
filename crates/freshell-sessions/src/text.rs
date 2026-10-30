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

// Name-reliability Task 5 (RC12): both lists below also carry the tool
// wrapper blocks coding CLIs serialize as `role:"user"` records that no
// person typed (V5 checked every one against real transcripts on this host):
// - Codex's own model-context fragments, written next to
//   `environment_context`: `recommended_plugins`, `user_shell_command`,
//   `user_action`;
// - Claude Code's slash-command family (an `isMeta` caveat record, then the
//   command's name/message/args, then its output) and its `system-reminder`
//   blocks.
// `bash-input`/`bash-stdout`/`bash-stderr` are deliberately absent: no
// transcript on this host carries them; add them only with evidence. Every
// consumer of `extract_user_authored_text` (titles, search, the AI prompt,
// first messages, Claude's user-message count) and the name classifier's
// leading-tag check (`starts_with_context_tag`, with its TypeScript copy in
// `shared/name-evidence.ts`, kept in step by the shared fixture) sees them.
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
    "recommended_plugins",
    "user_shell_command",
    "user_action",
    "local-command-caveat",
    "command-name",
    "command-message",
    "command-args",
    "local-command-stdout",
    "local-command-stderr",
    "system-reminder",
];

// The subset used by the leading `<tag[>\s]` system-context check (matches the alternation
// in the first `isSystemContext` regex, plus the tool wrapper tags above).
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
    "recommended_plugins",
    "user_shell_command",
    "user_action",
    "local-command-caveat",
    "command-name",
    "command-message",
    "command-args",
    "local-command-stdout",
    "local-command-stderr",
    "system-reminder",
];

/// Whether `text` (after trimming) opens with a known system-context tag:
/// `<tag>` or `<tag ` for a tag in `SYSTEM_CONTEXT_LEAD_TAGS`,
/// case-insensitive (`/^<(environment_context|...)[>\s]/i`, the first
/// `isSystemContext` alternation). This is ONLY the leading-tag check; the
/// rest of [`is_system_context`] also flags text a person may use as a name
/// (`$ cmd`, `1, 2, 3`), so the name classifier
/// (`crate::name_evidence`) uses this check alone.
pub fn starts_with_context_tag(text: &str) -> bool {
    let Some(rest) = text.trim().strip_prefix('<') else {
        return false;
    };
    let lower = rest.to_ascii_lowercase();
    SYSTEM_CONTEXT_LEAD_TAGS.iter().any(|tag| {
        // ASCII lowercasing keeps byte offsets, and the tag is ASCII, so
        // `tag.len()` is a char boundary of `rest` whenever it matched.
        lower.starts_with(tag)
            && rest[tag.len()..]
                .chars()
                .next()
                .is_some_and(|next| next == '>' || next.is_whitespace())
    })
}

/// `server/coding-cli/utils.ts` `isSystemContext`.
pub fn is_system_context(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }

    // /^<(environment_context|...)[>\s]/i
    if starts_with_context_tag(trimmed) {
        return true;
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
        && trimmed["base directory for this skill:".len()..].starts_with(char::is_whitespace)
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
        && s[i + 1..]
            .chars()
            .next()
            .map(|c| c.is_whitespace())
            .unwrap_or(false)
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
            let idx = find_ci(&rest, &close)?;
            let _ = open_len;
            rest = rest[idx + close.len()..].to_string();
            removed_structured_block = true;
            continue;
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
            // Compare on BYTES, not a `&str` slice: `j + 5` can land inside a
            // multibyte UTF-8 char (e.g. `→`, 3 bytes), and slicing a `&str` there
            // panics ("not a char boundary"). Byte-slicing is boundary-agnostic and
            // "image" is pure ASCII, so this is an exact, panic-free equivalent of the
            // original regex `/<\/?image[^>]*>/` (which handles Unicode input fine).
            if bytes.len() >= j + 5 && bytes[j..j + 5].eq_ignore_ascii_case(b"image") {
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
    while i < bytes.len()
        && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'-')
    {
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

#[cfg(test)]
mod char_boundary_tests {
    use super::*;

    // Regression for the panic:
    //   "end byte index N is not a char boundary; it is inside '→'"
    // strip_image_tags used a `&str` slice `s[j..j+5]` where `j+5` could land inside
    // a multibyte UTF-8 char (arrows `→` are 3 bytes and extremely common in real
    // AI transcripts), crashing the session indexer thread on real data.
    #[test]
    fn strip_image_tags_does_not_panic_on_multibyte_after_lt() {
        // `<` at 0; the old `s[1..6]` slice landed inside the second `→`.
        assert_eq!(strip_image_tags("<→→x"), "<→→x");
        // A long run of arrows after `<` (mirrors the real 5266-byte offset case).
        let long = format!("<{}", "→".repeat(64));
        assert_eq!(strip_image_tags(&long), long);
    }

    #[test]
    fn strip_image_tags_still_removes_tags_around_multibyte() {
        // Real removal still works, and surrounding multibyte survives intact.
        assert_eq!(strip_image_tags("a<image src=\"x\">b"), "ab");
        assert_eq!(strip_image_tags("</IMAGE>→"), "→");
        assert_eq!(
            strip_image_tags("see → <image foo> then → done"),
            "see →  then → done"
        );
    }

    // Broad guard: the whole text-normalization path must never panic on multibyte,
    // regardless of where a `<` falls relative to char boundaries.
    #[test]
    fn normalize_first_user_message_survives_arrows() {
        for s in [
            "→→→→→→→→→→ <not-a-real-tag> →→→",
            "<image>→→→→→→",
            "plan: a → b → c → d → e",
            "<→<→<→<→<→<→",
        ] {
            let _ = normalize_first_user_message(s);
            let _ = extract_user_authored_text(s);
        }
    }
}

/// Name-reliability Task 5 (RC12): the tool wrapper blocks Codex and Claude
/// Code serialize as `role:"user"` records are system context, never the
/// user's words. A record holding only the block yields no user text; a
/// record whose block is followed by the user's own sentence keeps exactly
/// that sentence; and the name classifier's leading-tag check sees the tag.
#[cfg(test)]
mod wrapper_tag_tests {
    use super::*;

    const USER_SENTENCE: &str = "Fix the sardine importer";

    fn assert_wrapper_block(block: &str) {
        assert_eq!(
            extract_user_authored_text(block),
            None,
            "a record holding only {block:?} has no user-authored text"
        );
        assert_eq!(
            extract_user_authored_text(&format!("{block}\n{USER_SENTENCE}")),
            Some(USER_SENTENCE.to_string()),
            "the user's sentence after {block:?} is kept"
        );
        assert!(
            starts_with_context_tag(block),
            "the leading-tag check recognizes {block:?}"
        );
    }

    // Codex's own model-context fragments (V5: the Codex 0.163.0 binary
    // writes them next to `environment_context`).
    #[test]
    fn extract_user_authored_text_skips_recommended_plugins() {
        assert_wrapper_block(
            "<recommended_plugins>\n- github: review pull requests\n</recommended_plugins>",
        );
    }

    #[test]
    fn extract_user_authored_text_skips_user_shell_command() {
        assert_wrapper_block(
            "<user_shell_command>\n<command>echo hi</command>\n<result>\nhi\nExit code: 0\n</result>\n</user_shell_command>",
        );
    }

    #[test]
    fn extract_user_authored_text_skips_user_action() {
        assert_wrapper_block(
            "<user_action>\n  <context>User initiated a review task. Here's the full review output from reviewer model.</context>\n  <action>review</action>\n</user_action>",
        );
    }

    // Claude Code's slash-command family (V5: real transcripts write the
    // caveat as an `isMeta` record, then the command, then its output).
    #[test]
    fn extract_user_authored_text_skips_local_command_caveat() {
        assert_wrapper_block(
            "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>",
        );
    }

    #[test]
    fn extract_user_authored_text_skips_command_name() {
        assert_wrapper_block("<command-name>/model</command-name>");
    }

    #[test]
    fn extract_user_authored_text_skips_command_message() {
        assert_wrapper_block("<command-message>model</command-message>");
    }

    #[test]
    fn extract_user_authored_text_skips_command_args() {
        assert_wrapper_block("<command-args>opus</command-args>");
    }

    #[test]
    fn extract_user_authored_text_skips_local_command_stdout() {
        assert_wrapper_block("<local-command-stdout>Set model to opus</local-command-stdout>");
    }

    #[test]
    fn extract_user_authored_text_skips_local_command_stderr() {
        assert_wrapper_block(
            "<local-command-stderr>Error: unknown model \"opux\"</local-command-stderr>",
        );
    }

    #[test]
    fn extract_user_authored_text_skips_system_reminder() {
        assert_wrapper_block(
            "<system-reminder>\nThe user opened the file src/main.rs in the IDE.\n</system-reminder>",
        );
    }

    /// The command family's full block, as one record carries it: name,
    /// message and args (an empty args block included) in one part.
    #[test]
    fn extract_user_authored_text_skips_a_whole_command_block() {
        assert_eq!(
            extract_user_authored_text(
                "<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>"
            ),
            None
        );
    }

    /// V5's mixed record: ONE user record whose parts are the caveat, a
    /// slash command, its output, then a plain sentence. Only the sentence
    /// is the user's.
    #[test]
    fn extract_user_authored_text_mixed_wrapper_record_keeps_the_sentence() {
        let sentence =
            "Keep the effort high for the rest of this refactor and explain each step briefly.";
        let record = [
            "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>",
            "<command-name>/effort</command-name>\n            <command-message>effort</command-message>\n            <command-args>high</command-args>",
            "<local-command-stdout>Set effort level to high</local-command-stdout>",
            sentence,
        ]
        .join("\n");
        assert_eq!(
            extract_user_authored_text(&record),
            Some(sentence.to_string())
        );
    }

    /// The real Claude shape end to end through the transcript parser: an
    /// `isMeta` caveat record, a `/model` command record, its stdout record,
    /// then the prompt. The index's first user message is the prompt.
    #[test]
    fn extract_user_authored_text_real_claude_command_shape_yields_the_prompt() {
        let session_id = "5a5a5a5a-0000-4000-8000-000000000005";
        let record = |uuid: &str, extra: serde_json::Value| {
            let mut base = serde_json::json!({
                "cwd": "/home/dan/code/sardines",
                "sessionId": session_id,
                "version": "2.1.23",
                "gitBranch": "main",
                "timestamp": "2026-10-20T10:00:00.000Z",
                "uuid": uuid,
            });
            for (key, value) in extra.as_object().expect("record fields") {
                base[key] = value.clone();
            }
            serde_json::to_string(&base).expect("record serializes")
        };
        let transcript = [
            record(
                "u-caveat",
                serde_json::json!({
                    "type": "user",
                    "isMeta": true,
                    "message": {"role": "user", "content": "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>"},
                }),
            ),
            record(
                "u-command",
                serde_json::json!({
                    "type": "user",
                    "message": {"role": "user", "content": "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>"},
                }),
            ),
            record(
                "u-stdout",
                serde_json::json!({
                    "type": "user",
                    "message": {"role": "user", "content": "<local-command-stdout>Set model to opus</local-command-stdout>"},
                }),
            ),
            record(
                "u-prompt",
                serde_json::json!({
                    "type": "user",
                    "message": {"role": "user", "content": USER_SENTENCE},
                }),
            ),
            record(
                "a-reply",
                serde_json::json!({
                    "type": "assistant",
                    "message": {"role": "assistant", "content": [{"type": "text", "text": "On it."}]},
                }),
            ),
        ]
        .join("\n");
        let parsed = crate::parse::parse_session_content(
            &transcript,
            &crate::parse::ParseSessionOptions::default(),
        );
        assert_eq!(parsed.first_user_message.as_deref(), Some(USER_SENTENCE));
        assert_eq!(parsed.title.as_deref(), Some(USER_SENTENCE));
    }

    /// Pins of what must NOT change: text that merely contains a tag, an
    /// unknown tag, and the shell tags no transcript on this host carries.
    #[test]
    fn extract_user_authored_text_keeps_real_text_around_tags() {
        assert_eq!(
            extract_user_authored_text("Fix <b>bold</b> rendering"),
            Some("Fix <b>bold</b> rendering".to_string())
        );
        assert!(!starts_with_context_tag("<systemic> review"));
        assert!(!starts_with_context_tag("<command-names> list"));
        assert!(!starts_with_context_tag("<bash-input>ls</bash-input>"));
    }
}
