//! Shared low-level byte-scanning primitives for the codex remote-proxy JSON-RPC
//! envelope/side-effect extractors (Slice 1, DEV-0006).
//!
//! A faithful merge of the two independent byte-scanning engines hand-rolled in
//! `server/coding-cli/codex-app-server/json-rpc-envelope.ts` and
//! `server/coding-cli/codex-app-server/json-rpc-side-effects.ts`. Both TS files
//! implement their OWN copy of "skip whitespace / parse a bounded string / parse a
//! number / skip an arbitrary JSON value without recursion" — nothing behaviorally
//! differs between the two copies, so this port consolidates them into one internal
//! engine used by both [`crate::remote_proxy_envelope`] and
//! [`crate::remote_proxy_side_effects`].
//!
//! The whole point of scanning bytes instead of calling `serde_json::from_str` is to
//! avoid paying a full-parse cost merely to read a handful of top-level (or shallow)
//! fields out of a frame that may be enormous (`MAX_FULL_PARSE_BYTES` in the caller
//! modules) — see `json-rpc-envelope.ts:142-152` / `json-rpc-side-effects.ts:711-721`.
//!
//! `skip_value` is explicitly NON-recursive (uses an explicit container-frame stack)
//! so an adversarially deep nested array/object cannot overflow the call stack —
//! ported test: `json-rpc-envelope.test.ts:77-87` (depth 20,000).

pub(crate) const BYTE_TAB: u8 = 0x09;
pub(crate) const BYTE_LF: u8 = 0x0a;
pub(crate) const BYTE_CR: u8 = 0x0d;
pub(crate) const BYTE_SPACE: u8 = 0x20;
pub(crate) const BYTE_QUOTE: u8 = 0x22;
pub(crate) const BYTE_PLUS: u8 = 0x2b;
pub(crate) const BYTE_MINUS: u8 = 0x2d;
pub(crate) const BYTE_COMMA: u8 = 0x2c;
pub(crate) const BYTE_DOT: u8 = 0x2e;
pub(crate) const BYTE_COLON: u8 = 0x3a;
pub(crate) const BYTE_BACKSLASH: u8 = 0x5c;
pub(crate) const BYTE_OPEN_BRACKET: u8 = 0x5b;
pub(crate) const BYTE_CLOSE_BRACKET: u8 = 0x5d;
pub(crate) const BYTE_OPEN_BRACE: u8 = 0x7b;
pub(crate) const BYTE_CLOSE_BRACE: u8 = 0x7d;

/// Low-level scan failure. Higher-level callers ([`crate::remote_proxy_envelope`],
/// [`crate::remote_proxy_side_effects`]) map this into their own richer, domain-specific
/// failure-reason enum (mirroring how each TS file has its own `failure(reason)` helper
/// over a shared shape of primitive errors).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ScanError {
    MalformedJson,
    TokenTooLarge,
}

pub(crate) type IndexScan = Result<usize, ScanError>;

pub(crate) fn is_whitespace(byte: u8) -> bool {
    byte == BYTE_SPACE || byte == BYTE_TAB || byte == BYTE_LF || byte == BYTE_CR
}

pub(crate) fn is_digit(byte: u8) -> bool {
    byte.is_ascii_digit()
}

fn is_digit_one_to_nine(byte: u8) -> bool {
    (0x31..=0x39).contains(&byte)
}

fn is_exponent_marker(byte: u8) -> bool {
    byte == 0x45 || byte == 0x65
}

fn is_sign(byte: u8) -> bool {
    byte == BYTE_PLUS || byte == BYTE_MINUS
}

pub(crate) fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        0x30..=0x39 => Some(byte - 0x30),
        0x41..=0x46 => Some(byte - 0x41 + 10),
        0x61..=0x66 => Some(byte - 0x61 + 10),
        _ => None,
    }
}

fn is_hex_digit(byte: u8) -> bool {
    hex_value(byte).is_some()
}

fn is_simple_escape(byte: u8) -> bool {
    matches!(byte, 0x22 | 0x5c | 0x2f | 0x62 | 0x66 | 0x6e | 0x72 | 0x74)
}

pub(crate) fn skip_whitespace(raw: &[u8], start: usize) -> usize {
    let mut index = start;
    while index < raw.len() && is_whitespace(raw[index]) {
        index += 1;
    }
    index
}

pub(crate) fn matches_literal(raw: &[u8], start: usize, literal: &[u8]) -> bool {
    if start + literal.len() > raw.len() {
        return false;
    }
    &raw[start..start + literal.len()] == literal
}

/// Bounds of a quote-delimited string starting at `raw[start] == '"'`. `content_start`/
/// `content_end` exclude the surrounding quotes. `has_escape` lets a caller skip the
/// (relatively expensive) escape-decoding pass for the common escape-free case.
/// `max_token_bytes`, when set, bounds the RAW encoded token length (quotes included) —
/// mirrors `scanStringBounds`'s optional `maxTokenBytes` parameter in
/// `json-rpc-envelope.ts:448-483` (side-effects.ts's copy, `:905-951`, has no bound here;
/// callers pass `None` to get that unbounded-scan behavior for skip-only traversal).
pub(crate) struct StringBounds {
    pub content_start: usize,
    pub content_end: usize,
    pub has_escape: bool,
    pub next: usize,
}

pub(crate) fn scan_string_bounds(
    raw: &[u8],
    start: usize,
    max_token_bytes: Option<usize>,
) -> Result<StringBounds, ScanError> {
    if start >= raw.len() || raw[start] != BYTE_QUOTE {
        return Err(ScanError::MalformedJson);
    }
    let mut index = start + 1;
    let mut has_escape = false;
    while index < raw.len() {
        if let Some(max) = max_token_bytes {
            if index - start + 1 > max {
                return Err(ScanError::TokenTooLarge);
            }
        }
        let byte = raw[index];
        if byte == BYTE_QUOTE {
            return Ok(StringBounds {
                content_start: start + 1,
                content_end: index,
                has_escape,
                next: index + 1,
            });
        }
        if byte < BYTE_SPACE {
            return Err(ScanError::MalformedJson);
        }
        if byte == BYTE_BACKSLASH {
            has_escape = true;
            index += 1;
            if index >= raw.len() {
                return Err(ScanError::MalformedJson);
            }
            let escaped = raw[index];
            if escaped == 0x75 {
                for offset in 1..=4 {
                    if index + offset >= raw.len() || !is_hex_digit(raw[index + offset]) {
                        return Err(ScanError::MalformedJson);
                    }
                }
                index += 5;
                continue;
            }
            if !is_simple_escape(escaped) {
                return Err(ScanError::MalformedJson);
            }
        }
        index += 1;
    }
    Err(ScanError::MalformedJson)
}

/// Decode the escape sequences inside a string's raw content bytes (content only, no
/// surrounding quotes) into a `String`. Mirrors `decodeJsonStringContent`
/// (`json-rpc-envelope.ts:534-570`) — treats the content as a byte-for-byte ASCII/UTF-8
/// stream (structural escape bytes are always ASCII) and rejects raw control bytes.
fn decode_json_string_content(raw: &[u8]) -> Option<String> {
    let mut decoded = String::with_capacity(raw.len());
    let mut index = 0;
    while index < raw.len() {
        let byte = raw[index];
        if byte < BYTE_SPACE {
            return None;
        }
        if byte != BYTE_BACKSLASH {
            // Consume one UTF-8 scalar from the raw bytes.
            let width = utf8_char_width(byte);
            let end = (index + width).min(raw.len());
            let s = std::str::from_utf8(&raw[index..end]).ok()?;
            decoded.push_str(s);
            index = end;
            continue;
        }
        index += 1;
        if index >= raw.len() {
            return None;
        }
        let escaped = raw[index];
        match escaped {
            0x22 => decoded.push('"'),
            0x5c => decoded.push('\\'),
            0x2f => decoded.push('/'),
            0x62 => decoded.push('\u{8}'),
            0x66 => decoded.push('\u{c}'),
            0x6e => decoded.push('\n'),
            0x72 => decoded.push('\r'),
            0x74 => decoded.push('\t'),
            0x75 => {
                if index + 4 >= raw.len() {
                    return None;
                }
                let mut code_unit: u32 = 0;
                for offset in 1..=4 {
                    let value = hex_value(raw[index + offset])? as u32;
                    code_unit = code_unit * 16 + value;
                }
                // Mirrors `String.fromCharCode`: a bare UTF-16 code unit, including
                // unpaired surrogates. `char::from_u32` rejects surrogate code points,
                // so fall back to the Unicode replacement character for those —
                // acceptable for our purposes (thread/turn ids never legitimately
                // contain unpaired surrogates) and never panics.
                decoded.push(char::from_u32(code_unit).unwrap_or('\u{fffd}'));
                index += 4;
            }
            _ => return None,
        }
        index += 1;
    }
    Some(decoded)
}

fn utf8_char_width(first_byte: u8) -> usize {
    if first_byte & 0x80 == 0 {
        1
    } else if first_byte & 0xE0 == 0xC0 {
        2
    } else if first_byte & 0xF0 == 0xE0 {
        3
    } else if first_byte & 0xF8 == 0xF0 {
        4
    } else {
        1
    }
}

/// Parse a bounded (`max_token_bytes`-limited) JSON string starting at `raw[start] == '"'`,
/// returning the decoded value and the index just past the closing quote. Mirrors
/// `parseBoundedString` (`json-rpc-envelope.ts:432-440`).
pub(crate) fn parse_bounded_string(
    raw: &[u8],
    start: usize,
    max_token_bytes: usize,
) -> Result<(String, usize), ScanError> {
    let bounds = scan_string_bounds(raw, start, Some(max_token_bytes))?;
    let value = decode_string_bounds(raw, &bounds)?;
    Ok((value, bounds.next))
}

/// Decode a scanned string's content, taking the escape-free fast path (a direct UTF-8
/// decode, skipping the backslash-unescaping pass entirely) when `bounds.has_escape` is
/// `false` — the common case for identifiers like thread/turn ids and method names.
fn decode_string_bounds(raw: &[u8], bounds: &StringBounds) -> Result<String, ScanError> {
    let content = &raw[bounds.content_start..bounds.content_end];
    if !bounds.has_escape {
        return std::str::from_utf8(content)
            .map(str::to_string)
            .map_err(|_| ScanError::MalformedJson);
    }
    decode_json_string_content(content).ok_or(ScanError::MalformedJson)
}

/// A scanned (but not decoded) number token's byte span plus the index just past it.
pub(crate) struct NumberToken {
    pub start: usize,
    pub end: usize,
    pub next: usize,
}

/// Scan a JSON number token starting at `raw[start]` (a `-` or digit). `max_token_bytes`,
/// when set, bounds the token length (mirrors the optional bound in
/// `parseNumberToken`/`scanNumber`).
pub(crate) fn scan_number(
    raw: &[u8],
    start: usize,
    max_token_bytes: Option<usize>,
) -> Result<NumberToken, ScanError> {
    let over_limit = |from: usize, to: usize| max_token_bytes.is_some_and(|max| to - from > max);

    let mut index = start;
    if index < raw.len() && raw[index] == BYTE_MINUS {
        index += 1;
        if over_limit(start, index) {
            return Err(ScanError::TokenTooLarge);
        }
    }
    if index >= raw.len() {
        return Err(ScanError::MalformedJson);
    }
    let first_integer_byte = raw[index];
    if first_integer_byte == 0x30 {
        index += 1;
        if over_limit(start, index) {
            return Err(ScanError::TokenTooLarge);
        }
    } else if is_digit_one_to_nine(first_integer_byte) {
        index += 1;
        while index < raw.len() && is_digit(raw[index]) {
            index += 1;
            if over_limit(start, index) {
                return Err(ScanError::TokenTooLarge);
            }
        }
    } else {
        return Err(ScanError::MalformedJson);
    }

    if index < raw.len() && raw[index] == BYTE_DOT {
        index += 1;
        if over_limit(start, index) {
            return Err(ScanError::TokenTooLarge);
        }
        if index >= raw.len() || !is_digit(raw[index]) {
            return Err(ScanError::MalformedJson);
        }
        while index < raw.len() && is_digit(raw[index]) {
            index += 1;
            if over_limit(start, index) {
                return Err(ScanError::TokenTooLarge);
            }
        }
    }

    if index < raw.len() && is_exponent_marker(raw[index]) {
        index += 1;
        if over_limit(start, index) {
            return Err(ScanError::TokenTooLarge);
        }
        if index < raw.len() && is_sign(raw[index]) {
            index += 1;
            if over_limit(start, index) {
                return Err(ScanError::TokenTooLarge);
            }
        }
        if index >= raw.len() || !is_digit(raw[index]) {
            return Err(ScanError::MalformedJson);
        }
        while index < raw.len() && is_digit(raw[index]) {
            index += 1;
            if over_limit(start, index) {
                return Err(ScanError::TokenTooLarge);
            }
        }
    }

    Ok(NumberToken {
        start,
        end: index,
        next: index,
    })
}

pub(crate) fn number_token_has_fraction_or_exponent(raw: &[u8], start: usize, end: usize) -> bool {
    raw[start..end]
        .iter()
        .any(|&byte| byte == BYTE_DOT || is_exponent_marker(byte))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ValueKind {
    Object,
    Array,
    String,
    Number,
    Literal,
}

pub(crate) fn classify_value(byte: u8) -> ValueKind {
    if byte == BYTE_OPEN_BRACE {
        ValueKind::Object
    } else if byte == BYTE_OPEN_BRACKET {
        ValueKind::Array
    } else if byte == BYTE_QUOTE {
        ValueKind::String
    } else if byte == BYTE_MINUS || is_digit(byte) {
        ValueKind::Number
    } else {
        ValueKind::Literal
    }
}

// The shared `Expect*` prefix names each parser state after what the scanner is
// expecting next (mirroring the TS `state:` string literals verbatim) — clearer here
// than stripping it would be, so the lint is silenced deliberately.
#[allow(clippy::enum_variant_names)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ArrayState {
    ExpectValueOrEnd,
    ExpectValue,
    ExpectCommaOrEnd,
}

#[allow(clippy::enum_variant_names)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ObjectState {
    ExpectKeyOrEnd,
    ExpectKey,
    ExpectColon,
    ExpectValue,
    ExpectCommaOrEnd,
}

/// A discriminated container frame — mirrors the TS `ContainerFrame` union
/// (`{type:'array', state} | {type:'object', state}`) so an array can never end up in an
/// object-only state (or vice versa) and the traversal match below is exhaustive by
/// construction rather than by a runtime invariant.
enum ContainerFrame {
    Array(ArrayState),
    Object(ObjectState),
}

/// Begin scanning one value (string/number/literal/open-container) at `start`, pushing a
/// frame onto `stack` for object/array so the caller's traversal loop can continue
/// non-recursively. `max_number_token_bytes` threads through to number scanning (see
/// module docs: envelope.ts's generic skip leaves numbers unbounded; side-effects.ts's
/// generic skip always bounds them to `MAX_SCANNED_TOKEN_BYTES` — callers choose).
fn begin_skipped_value(
    raw: &[u8],
    start: usize,
    stack: &mut Vec<ContainerFrame>,
    max_number_token_bytes: Option<usize>,
) -> IndexScan {
    if start >= raw.len() {
        return Err(ScanError::MalformedJson);
    }
    let first = raw[start];
    if first == BYTE_QUOTE {
        return Ok(scan_string_bounds(raw, start, None)?.next);
    }
    if first == BYTE_OPEN_BRACE {
        stack.push(ContainerFrame::Object(ObjectState::ExpectKeyOrEnd));
        return Ok(start + 1);
    }
    if first == BYTE_OPEN_BRACKET {
        stack.push(ContainerFrame::Array(ArrayState::ExpectValueOrEnd));
        return Ok(start + 1);
    }
    if first == BYTE_MINUS || is_digit(first) {
        return Ok(scan_number(raw, start, max_number_token_bytes)?.next);
    }
    if matches_literal(raw, start, b"true") {
        return Ok(start + 4);
    }
    if matches_literal(raw, start, b"false") {
        return Ok(start + 5);
    }
    if matches_literal(raw, start, b"null") {
        return Ok(start + 4);
    }
    Err(ScanError::MalformedJson)
}

/// Skip an arbitrary JSON value (object/array/string/number/literal) starting at `start`,
/// returning the index just past it. Non-recursive: nested containers are tracked with an
/// explicit stack so adversarially deep nesting cannot overflow the call stack (mirrors
/// `skipValue` in both TS files).
pub(crate) fn skip_value(
    raw: &[u8],
    start: usize,
    max_number_token_bytes: Option<usize>,
) -> IndexScan {
    let value_start = skip_whitespace(raw, start);
    if value_start >= raw.len() {
        return Err(ScanError::MalformedJson);
    }

    let mut stack: Vec<ContainerFrame> = Vec::new();
    let mut next = begin_skipped_value(raw, value_start, &mut stack, max_number_token_bytes)?;
    if stack.is_empty() {
        return Ok(next);
    }

    while let Some(frame_index) = stack.len().checked_sub(1) {
        next = skip_whitespace(raw, next);
        if next >= raw.len() {
            return Err(ScanError::MalformedJson);
        }

        let frame_kind = match &stack[frame_index] {
            ContainerFrame::Array(state) => Ok(*state),
            ContainerFrame::Object(state) => Err(*state),
        };

        match frame_kind {
            Ok(ArrayState::ExpectValueOrEnd) => {
                if raw[next] == BYTE_CLOSE_BRACKET {
                    stack.pop();
                    next += 1;
                    continue;
                }
                stack[frame_index] = ContainerFrame::Array(ArrayState::ExpectCommaOrEnd);
                next = begin_skipped_value(raw, next, &mut stack, max_number_token_bytes)?;
                continue;
            }
            Ok(ArrayState::ExpectValue) => {
                stack[frame_index] = ContainerFrame::Array(ArrayState::ExpectCommaOrEnd);
                next = begin_skipped_value(raw, next, &mut stack, max_number_token_bytes)?;
                continue;
            }
            Ok(ArrayState::ExpectCommaOrEnd) => {
                let delimiter = raw[next];
                if delimiter == BYTE_COMMA {
                    stack[frame_index] = ContainerFrame::Array(ArrayState::ExpectValue);
                    next += 1;
                    continue;
                }
                if delimiter == BYTE_CLOSE_BRACKET {
                    stack.pop();
                    next += 1;
                    continue;
                }
                return Err(ScanError::MalformedJson);
            }
            Err(ObjectState::ExpectKeyOrEnd) => {
                if raw[next] == BYTE_CLOSE_BRACE {
                    stack.pop();
                    next += 1;
                    continue;
                }
                let bounds = scan_string_bounds(raw, next, None)?;
                stack[frame_index] = ContainerFrame::Object(ObjectState::ExpectColon);
                next = bounds.next;
                continue;
            }
            Err(ObjectState::ExpectKey) => {
                let bounds = scan_string_bounds(raw, next, None)?;
                stack[frame_index] = ContainerFrame::Object(ObjectState::ExpectColon);
                next = bounds.next;
                continue;
            }
            Err(ObjectState::ExpectColon) => {
                if raw[next] != BYTE_COLON {
                    return Err(ScanError::MalformedJson);
                }
                stack[frame_index] = ContainerFrame::Object(ObjectState::ExpectValue);
                next += 1;
                continue;
            }
            Err(ObjectState::ExpectValue) => {
                stack[frame_index] = ContainerFrame::Object(ObjectState::ExpectCommaOrEnd);
                next = begin_skipped_value(raw, next, &mut stack, max_number_token_bytes)?;
                continue;
            }
            Err(ObjectState::ExpectCommaOrEnd) => {
                let delimiter = raw[next];
                if delimiter == BYTE_COMMA {
                    stack[frame_index] = ContainerFrame::Object(ObjectState::ExpectKey);
                    next += 1;
                    continue;
                }
                if delimiter == BYTE_CLOSE_BRACE {
                    stack.pop();
                    next += 1;
                    continue;
                }
                return Err(ScanError::MalformedJson);
            }
        }
    }

    Ok(next)
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ObjectEntry {
    pub key: String,
    pub value_start: usize,
    pub value_end: usize,
    pub value_kind: ValueKind,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ScannedObject {
    pub entries: Vec<ObjectEntry>,
    pub close_index: usize,
    pub end: usize,
}

/// Scan a `{...}` object starting at `raw[start] == '{'`, recording each entry's key,
/// value span, and coarse value kind. Mirrors `scanObject`
/// (`json-rpc-side-effects.ts:723-762`). Keys are bounded to `MAX_SCANNED_TOKEN_BYTES`
/// (the caller passes that constant in); values are only span-recorded, never decoded —
/// callers decode lazily, only the entries they actually need.
pub(crate) fn scan_object(
    raw: &[u8],
    start: usize,
    max_key_token_bytes: usize,
) -> Result<ScannedObject, ScanError> {
    if start >= raw.len() || raw[start] != BYTE_OPEN_BRACE {
        return Err(ScanError::MalformedJson);
    }
    let mut entries = Vec::new();
    let mut index = skip_whitespace(raw, start + 1);
    if index >= raw.len() {
        return Err(ScanError::MalformedJson);
    }
    if raw[index] == BYTE_CLOSE_BRACE {
        return Ok(ScannedObject {
            entries,
            close_index: index,
            end: index + 1,
        });
    }

    loop {
        if index >= raw.len() {
            return Err(ScanError::MalformedJson);
        }
        let (key, next) = parse_bounded_string(raw, index, max_key_token_bytes)?;
        index = skip_whitespace(raw, next);
        if index >= raw.len() || raw[index] != BYTE_COLON {
            return Err(ScanError::MalformedJson);
        }
        let value_start = skip_whitespace(raw, index + 1);
        if value_start >= raw.len() {
            return Err(ScanError::MalformedJson);
        }
        let value_kind = classify_value(raw[value_start]);
        // side-effects.ts's generic object-value skip always bounds numbers to
        // MAX_SCANNED_TOKEN_BYTES (json-rpc-side-effects.ts:1011) — thread through the
        // same key bound (both constants are MAX_SCANNED_TOKEN_BYTES in the caller).
        let value_end = skip_value(raw, value_start, Some(max_key_token_bytes))?;
        entries.push(ObjectEntry {
            key,
            value_start,
            value_end,
            value_kind,
        });
        index = skip_whitespace(raw, value_end);
        if index >= raw.len() {
            return Err(ScanError::MalformedJson);
        }
        if raw[index] == BYTE_COMMA {
            index = skip_whitespace(raw, index + 1);
            continue;
        }
        if raw[index] == BYTE_CLOSE_BRACE {
            return Ok(ScannedObject {
                entries,
                close_index: index,
                end: index + 1,
            });
        }
        return Err(ScanError::MalformedJson);
    }
}

pub(crate) fn find_entry<'a>(entries: &'a [ObjectEntry], key: &str) -> Option<&'a ObjectEntry> {
    entries.iter().find(|entry| entry.key == key)
}

pub(crate) fn has_duplicate_key(entries: &[ObjectEntry], key: &str) -> bool {
    let mut seen = false;
    for entry in entries {
        if entry.key != key {
            continue;
        }
        if seen {
            return true;
        }
        seen = true;
    }
    false
}

pub(crate) fn has_any_duplicate_key(entries: &[ObjectEntry], keys: &[&str]) -> bool {
    keys.iter().any(|key| has_duplicate_key(entries, key))
}

pub(crate) fn literal_equals(raw: &[u8], entry: &ObjectEntry, literal: &[u8]) -> bool {
    entry.value_end - entry.value_start == literal.len()
        && &raw[entry.value_start..entry.value_end] == literal
}

pub(crate) fn decode_string_entry(raw: &[u8], entry: &ObjectEntry) -> Result<String, ScanError> {
    if entry.value_kind != ValueKind::String {
        return Err(ScanError::MalformedJson);
    }
    let bounds = scan_string_bounds(raw, entry.value_start, None)?;
    if bounds.next != entry.value_end {
        return Err(ScanError::MalformedJson);
    }
    decode_json_string_content(&raw[bounds.content_start..bounds.content_end])
        .ok_or(ScanError::MalformedJson)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skip_value_survives_adversarially_deep_nesting_without_recursion() {
        let depth = 20_000;
        let mut json = "[".repeat(depth);
        json.push('0');
        json.push_str(&"]".repeat(depth));
        let raw = json.as_bytes();
        let next = skip_value(raw, 0, None).expect("deep nesting should not overflow");
        assert_eq!(next, raw.len());
    }

    #[test]
    fn parse_bounded_string_decodes_unicode_escape() {
        let raw = br#""meth\u006fd""#;
        let (value, next) = parse_bounded_string(raw, 0, 8 * 1024).unwrap();
        assert_eq!(value, "method");
        assert_eq!(next, raw.len());
    }

    #[test]
    fn scan_object_records_entry_spans() {
        let raw = br#"{"a":1,"b":"two","c":{"nested":true}}"#;
        let scanned = scan_object(raw, 0, 8 * 1024).unwrap();
        assert_eq!(scanned.entries.len(), 3);
        assert_eq!(scanned.entries[0].key, "a");
        assert_eq!(scanned.entries[0].value_kind, ValueKind::Number);
        assert_eq!(scanned.entries[1].key, "b");
        assert_eq!(scanned.entries[1].value_kind, ValueKind::String);
        assert_eq!(scanned.entries[2].key, "c");
        assert_eq!(scanned.entries[2].value_kind, ValueKind::Object);
        assert_eq!(scanned.end, raw.len());
    }
}
