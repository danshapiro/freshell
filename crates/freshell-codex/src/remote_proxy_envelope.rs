//! codex remote-proxy **envelope scan** — a pure, no-IO byte-level scanner that reads
//! ONLY the top-level `id`/`method` fields (plus duplicate-key detection) out of a raw
//! JSON-RPC frame, without a full `serde_json::from_str` parse. A faithful port of
//! `server/coding-cli/codex-app-server/json-rpc-envelope.ts` (`scanJsonRpcEnvelope`).
//!
//! DEV-0006 Slice 1 (`docs/plans/2026-07-19-dev0006-codex-launch-planning-spec.md` §5):
//! this is the pure, testable core the Slice-2 remote proxy (`ws://127.0.0.1:<port>`
//! loopback relay) will consume to decide, for every relayed frame, whether it needs the
//! (comparatively expensive) full parse in [`crate::remote_proxy_side_effects`] or can be
//! forwarded byte-for-byte untouched. NOT wired into the proxy/server yet — pure library
//! code only (S2 is a separate, later slice).
//!
//! The scan never allocates more than the bytes it decodes (top-level string `id`/`method`
//! values, bounded to [`MAX_SCANNED_TOKEN_BYTES`]) and never recurses into nested
//! containers beyond skipping over them with an explicit stack
//! ([`crate::json_scan::skip_value`]) — a multi-megabyte `result`/`params` payload costs
//! only a linear byte skip, not a parse.

use crate::json_scan::{
    self, is_digit, parse_bounded_string, scan_number, skip_value, skip_whitespace, ScanError,
    BYTE_CLOSE_BRACE, BYTE_COLON, BYTE_COMMA, BYTE_MINUS, BYTE_OPEN_BRACE, BYTE_OPEN_BRACKET,
    BYTE_QUOTE,
};

/// Frames at or under this size get the FULL treatment (parse + side-effect extraction);
/// mirrors `MAX_FULL_PARSE_BYTES` (`json-rpc-envelope.ts:25`, `1 * 1024 * 1024`).
pub const MAX_FULL_PARSE_BYTES: usize = 1024 * 1024;

/// The upper bound on a frame this proxy will ever forward raw, regardless of parseability;
/// mirrors `MAX_RAW_FORWARD_BYTES` (`json-rpc-envelope.ts:26`, `64 * 1024 * 1024`).
pub const MAX_RAW_FORWARD_BYTES: usize = 64 * 1024 * 1024;

/// The byte bound on any individually-scanned top-level token (an `id` or `method`
/// string); mirrors `MAX_SCANNED_TOKEN_BYTES` (`json-rpc-envelope.ts:27`, `8 * 1024`).
pub const MAX_SCANNED_TOKEN_BYTES: usize = 8 * 1024;

/// The top-level JSON-RPC `id`, scanned without full parse. Always a plain JS-`number`
/// equivalent for the numeric case ([`Num`](JsonRpcEnvelopeId::Num), an `f64`) rather than
/// an integer type: the reference implementation runs every numeric id token through JS
/// `Number(token)`, which loses precision past 2^53 — ported test
/// `json-rpc-envelope.test.ts:127-138` pins that exact (lossy) behavior for ids larger
/// than `Number.MAX_SAFE_INTEGER`. (Contrast with
/// [`crate::remote_proxy_side_effects`]'s `extract_top_level_id`, which matches ids
/// against a small, precisely-known pending-request-id set and uses
/// [`crate::protocol::RequestId`] instead — a different function serving a different,
/// narrower purpose, exactly as the two TS files never share this logic either.)
#[derive(Clone, Debug, PartialEq)]
pub enum JsonRpcEnvelopeId {
    Str(String),
    Num(f64),
}

/// A successfully-scanned envelope (`JsonRpcEnvelopeScanSuccess`, `json-rpc-envelope.ts:6-12`).
#[derive(Clone, Debug, PartialEq, Default)]
pub struct JsonRpcEnvelope {
    pub id: Option<JsonRpcEnvelopeId>,
    pub method: Option<String>,
    pub duplicate_top_level_keys: Vec<String>,
}

/// Why the scan failed (`JsonRpcEnvelopeScanFailure['reason']`, `json-rpc-envelope.ts:16-21`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JsonRpcEnvelopeScanError {
    /// Root is a JSON array — batched JSON-RPC is not supported.
    BatchUnsupported,
    /// Invalid JSON syntax, or a with-value key whose value/delimiters don't parse.
    MalformedJson,
    /// Root is neither an object nor an array (a bare string/number/literal/etc).
    NonObjectRoot,
    /// A scanned top-level `id`/`method` string token exceeded [`MAX_SCANNED_TOKEN_BYTES`].
    TokenTooLarge,
}

impl From<ScanError> for JsonRpcEnvelopeScanError {
    fn from(error: ScanError) -> Self {
        match error {
            ScanError::MalformedJson => Self::MalformedJson,
            ScanError::TokenTooLarge => Self::TokenTooLarge,
        }
    }
}

type ScanResult = Result<JsonRpcEnvelope, JsonRpcEnvelopeScanError>;

/// Scan a raw JSON-RPC frame for its top-level `id`/`method` (plus duplicate-key report),
/// WITHOUT a full parse. A faithful port of `scanJsonRpcEnvelope`
/// (`json-rpc-envelope.ts:142-152`).
pub fn scan_json_rpc_envelope(input: &[u8]) -> ScanResult {
    let index = skip_whitespace(input, 0);
    if index >= input.len() {
        return Err(JsonRpcEnvelopeScanError::MalformedJson);
    }
    let root = input[index];
    if root == BYTE_OPEN_BRACKET {
        return Err(JsonRpcEnvelopeScanError::BatchUnsupported);
    }
    if root != BYTE_OPEN_BRACE {
        return Err(JsonRpcEnvelopeScanError::NonObjectRoot);
    }
    scan_root_object(input, index)
}

fn scan_root_object(raw: &[u8], start: usize) -> ScanResult {
    let mut duplicate_top_level_keys: Vec<String> = Vec::new();
    let mut seen_keys: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut duplicate_keys: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut id: Option<JsonRpcEnvelopeId> = None;
    let mut method: Option<String> = None;

    let mut index = skip_whitespace(raw, start + 1);
    if index >= raw.len() {
        return Err(JsonRpcEnvelopeScanError::MalformedJson);
    }
    if raw[index] == BYTE_CLOSE_BRACE {
        return finish_root_object(raw, index + 1, id, method, duplicate_top_level_keys);
    }

    loop {
        if index >= raw.len() {
            return Err(JsonRpcEnvelopeScanError::MalformedJson);
        }
        let (key, next) = parse_bounded_string(raw, index, MAX_SCANNED_TOKEN_BYTES)?;
        record_duplicate_key(
            &key,
            &mut seen_keys,
            &mut duplicate_keys,
            &mut duplicate_top_level_keys,
        );

        index = skip_whitespace(raw, next);
        if index >= raw.len() || raw[index] != BYTE_COLON {
            return Err(JsonRpcEnvelopeScanError::MalformedJson);
        }
        index = skip_whitespace(raw, index + 1);
        if index >= raw.len() {
            return Err(JsonRpcEnvelopeScanError::MalformedJson);
        }

        if key == "id" {
            let (value, next) = scan_top_level_id(raw, index)?;
            id = value;
            index = next;
        } else if key == "method" {
            let (value, next) = scan_top_level_method(raw, index)?;
            method = value;
            index = next;
        } else {
            index = skip_value(raw, index, None)?;
        }

        index = skip_whitespace(raw, index);
        if index >= raw.len() {
            return Err(JsonRpcEnvelopeScanError::MalformedJson);
        }
        let delimiter = raw[index];
        if delimiter == BYTE_COMMA {
            index = skip_whitespace(raw, index + 1);
            continue;
        }
        if delimiter == BYTE_CLOSE_BRACE {
            return finish_root_object(raw, index + 1, id, method, duplicate_top_level_keys);
        }
        return Err(JsonRpcEnvelopeScanError::MalformedJson);
    }
}

fn finish_root_object(
    raw: &[u8],
    next: usize,
    id: Option<JsonRpcEnvelopeId>,
    method: Option<String>,
    duplicate_top_level_keys: Vec<String>,
) -> ScanResult {
    let trailing = skip_whitespace(raw, next);
    if trailing != raw.len() {
        return Err(JsonRpcEnvelopeScanError::MalformedJson);
    }
    Ok(JsonRpcEnvelope {
        id,
        method,
        duplicate_top_level_keys,
    })
}

/// `scanTopLevelId` (`json-rpc-envelope.ts:262-290`): a string id is always used verbatim;
/// a numeric id lacking a fraction/exponent is used ONLY if `Number(token)` is finite
/// (always true for a bounded digit run); a fractional/exponent numeric id, or any other
/// value shape, yields `None` (the field is treated as absent) while still consuming the
/// value's bytes so the scan can continue.
fn scan_top_level_id(
    raw: &[u8],
    index: usize,
) -> Result<(Option<JsonRpcEnvelopeId>, usize), JsonRpcEnvelopeScanError> {
    let value_start = skip_whitespace(raw, index);
    if value_start >= raw.len() {
        return Err(JsonRpcEnvelopeScanError::MalformedJson);
    }
    let first = raw[value_start];

    if first == BYTE_QUOTE {
        let (value, next) = parse_bounded_string(raw, value_start, MAX_SCANNED_TOKEN_BYTES)?;
        return Ok((Some(JsonRpcEnvelopeId::Str(value)), next));
    }

    if first == BYTE_MINUS || is_digit(first) {
        let token = scan_number(raw, value_start, Some(MAX_SCANNED_TOKEN_BYTES))?;
        if json_scan::number_token_has_fraction_or_exponent(raw, token.start, token.end) {
            return Ok((None, token.next));
        }
        // ASCII-only digits/minus by construction of scan_number.
        let text = std::str::from_utf8(&raw[token.start..token.end])
            .expect("number token is ASCII digits and an optional leading '-'");
        let value: f64 = text.parse().unwrap_or(f64::NAN);
        if value.is_finite() {
            return Ok((Some(JsonRpcEnvelopeId::Num(value)), token.next));
        }
        return Ok((None, token.next));
    }

    let next = skip_value(raw, value_start, None)?;
    Ok((None, next))
}

/// `scanTopLevelMethod` (`json-rpc-envelope.ts:292-302`): a string method is used verbatim
/// (including an empty string — no non-emptiness check at this layer, unlike
/// [`crate::remote_proxy_side_effects`]'s stricter `extractMethod`); any other value shape
/// yields `None` while still consuming the value's bytes.
fn scan_top_level_method(
    raw: &[u8],
    index: usize,
) -> Result<(Option<String>, usize), JsonRpcEnvelopeScanError> {
    let value_start = skip_whitespace(raw, index);
    if value_start >= raw.len() {
        return Err(JsonRpcEnvelopeScanError::MalformedJson);
    }
    if raw[value_start] == BYTE_QUOTE {
        let (value, next) = parse_bounded_string(raw, value_start, MAX_SCANNED_TOKEN_BYTES)?;
        return Ok((Some(value), next));
    }
    let next = skip_value(raw, value_start, None)?;
    Ok((None, next))
}

fn record_duplicate_key(
    key: &str,
    seen_keys: &mut std::collections::HashSet<String>,
    duplicate_keys: &mut std::collections::HashSet<String>,
    duplicate_top_level_keys: &mut Vec<String>,
) {
    if seen_keys.contains(key) {
        if !duplicate_keys.contains(key) {
            duplicate_keys.insert(key.to_string());
            duplicate_top_level_keys.push(key.to_string());
        }
        return;
    }
    seen_keys.insert(key.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json_scan::matches_literal;

    /// Convenience: does `bytes` start with `literal` at `start`? Used only by tests to
    /// build ad-hoc corpora without pulling in a JSON crate for generation.
    fn literal_present(raw: &[u8], start: usize, literal: &str) -> bool {
        matches_literal(raw, start, literal.as_bytes())
    }

    fn ok(input: &str) -> JsonRpcEnvelope {
        scan_json_rpc_envelope(input.as_bytes()).expect("expected a successful scan")
    }

    fn err(input: &str) -> JsonRpcEnvelopeScanError {
        scan_json_rpc_envelope(input.as_bytes()).expect_err("expected the scan to fail")
    }

    // ── ported: json-rpc-envelope.test.ts:38-62 ──────────────────────────────────────

    #[test]
    fn extracts_top_level_method_and_string_or_integer_ids_regardless_of_field_order() {
        let a = ok(r#"{"jsonrpc":"2.0","id":"abc","method":"turn/start","params":{}}"#);
        assert_eq!(a.id, Some(JsonRpcEnvelopeId::Str("abc".into())));
        assert_eq!(a.method, Some("turn/start".into()));
        assert_eq!(a.duplicate_top_level_keys, Vec::<String>::new());

        let b = ok(r#"{"params":{},"method":"thread/fork","id":7}"#);
        assert_eq!(b.id, Some(JsonRpcEnvelopeId::Num(7.0)));
        assert_eq!(b.method, Some("thread/fork".into()));

        let c = ok(r#"{"method":"initialize","params":{},"id":-12}"#);
        assert_eq!(c.id, Some(JsonRpcEnvelopeId::Num(-12.0)));
        assert_eq!(c.method, Some("initialize".into()));
    }

    // ── ported: json-rpc-envelope.test.ts:64-75 ──────────────────────────────────────

    #[test]
    fn uses_only_top_level_ids_even_when_nested_ids_appear_first_or_after_large_results() {
        let raw = r#"{"result":{"id":"nested-before"},"params":{"id":"nested-param"},"id":"top","method":"turn/start"}"#;
        let scanned = ok(raw);
        assert_eq!(scanned.id, Some(JsonRpcEnvelopeId::Str("top".into())));
        assert_eq!(scanned.method, Some("turn/start".into()));

        let large_result = "x".repeat(128 * 1024);
        let raw2 = format!(r#"{{"result":{{"payload":"{large_result}"}},"id":42}}"#);
        let scanned2 = ok(&raw2);
        assert_eq!(scanned2.id, Some(JsonRpcEnvelopeId::Num(42.0)));
    }

    // ── ported: json-rpc-envelope.test.ts:77-87 ──────────────────────────────────────

    #[test]
    fn skips_adversarially_deep_nested_values_without_overflowing_the_call_stack() {
        let depth = 20_000;
        let nested_result = format!("{}0{}", "[".repeat(depth), "]".repeat(depth));
        let raw = format!(r#"{{"result":{nested_result},"id":"deep","method":"turn/start"}}"#);
        let scanned = ok(&raw);
        assert_eq!(scanned.id, Some(JsonRpcEnvelopeId::Str("deep".into())));
        assert_eq!(scanned.method, Some("turn/start".into()));
        assert_eq!(scanned.duplicate_top_level_keys, Vec::<String>::new());
    }

    // ── ported: json-rpc-envelope.test.ts:89-97 ──────────────────────────────────────

    #[test]
    fn decodes_escaped_top_level_property_names_and_escaped_string_values() {
        let scanned = ok(r#"{"meth\u006fd":"turn\/start","\u0069d":"request-1"}"#);
        assert_eq!(scanned.id, Some(JsonRpcEnvelopeId::Str("request-1".into())));
        assert_eq!(scanned.method, Some("turn/start".into()));
    }

    // ── ported: json-rpc-envelope.test.ts:99-114 ─────────────────────────────────────

    #[test]
    fn reports_duplicate_top_level_keys_while_matching_bounded_json_parse_last_wins_semantics() {
        let scanned = ok(r#"{"id":1,"method":"initialize","id":2,"method":"turn/start"}"#);
        assert_eq!(scanned.id, Some(JsonRpcEnvelopeId::Num(2.0)));
        assert_eq!(scanned.method, Some("turn/start".into()));
        assert_eq!(scanned.duplicate_top_level_keys, vec!["id", "method"]);

        let scanned2 = ok(r#"{"\u0069d":1,"id":null,"meth\u006fd":false,"method":"turn/start"}"#);
        assert_eq!(scanned2.id, None);
        assert_eq!(scanned2.method, Some("turn/start".into()));
        assert_eq!(scanned2.duplicate_top_level_keys, vec!["id", "method"]);
    }

    // ── ported: json-rpc-envelope.test.ts:116-125 ────────────────────────────────────

    #[test]
    fn ignores_invalid_json_rpc_id_types_without_coercion() {
        for id_literal in ["null", "1.25", "true", r#"{"nested":1}"#, "[1]"] {
            let raw = format!(r#"{{"id":{id_literal},"method":"initialize"}}"#);
            let scanned = ok(&raw);
            assert_eq!(
                scanned.id, None,
                "id literal {id_literal} should be ignored"
            );
            assert_eq!(scanned.method, Some("initialize".into()));
            assert_eq!(scanned.duplicate_top_level_keys, Vec::<String>::new());
        }
    }

    // ── ported: json-rpc-envelope.test.ts:127-138 ────────────────────────────────────

    #[test]
    fn matches_js_number_parsing_for_bounded_large_integer_ids() {
        for id_literal in ["999999999999999999999", "9223372036854775807"] {
            let expected_id: f64 = id_literal.parse().unwrap();
            let raw = format!(r#"{{"id":{id_literal},"method":"initialize"}}"#);
            let scanned = ok(&raw);
            assert_eq!(scanned.id, Some(JsonRpcEnvelopeId::Num(expected_id)));
            assert_eq!(scanned.method, Some("initialize".into()));
        }
    }

    // ── ported: json-rpc-envelope.test.ts:140-150 ────────────────────────────────────

    #[test]
    fn accepts_plain_byte_slice_input_including_multi_byte_utf8() {
        let json = r#"{"id":9,"method":"initialize"}"#;
        let scanned = ok(json);
        assert_eq!(scanned.id, Some(JsonRpcEnvelopeId::Num(9.0)));
        assert_eq!(scanned.method, Some("initialize".into()));
        assert!(literal_present(json.as_bytes(), 0, "{"));
    }

    // ── ported: json-rpc-envelope.test.ts:152-157 ────────────────────────────────────

    #[test]
    fn classifies_root_arrays_as_unsupported_batches_not_non_object_traffic() {
        assert_eq!(
            err(r#"[{"id":1,"method":"thread/fork","params":{"threadId":"parent"}}]"#),
            JsonRpcEnvelopeScanError::BatchUnsupported
        );
    }

    // ── ported: json-rpc-envelope.test.ts:159-163 ────────────────────────────────────

    #[test]
    fn classifies_malformed_json_and_scalar_roots_as_unsafe() {
        assert_eq!(err(r#"{"id":1"#), JsonRpcEnvelopeScanError::MalformedJson);
        assert_eq!(
            err(r#"{"method":"bad\q"}"#),
            JsonRpcEnvelopeScanError::MalformedJson
        );
        assert_eq!(
            err(r#""not-an-object""#),
            JsonRpcEnvelopeScanError::NonObjectRoot
        );
    }

    // ── ported: json-rpc-envelope.test.ts:165-171 ────────────────────────────────────

    #[test]
    fn rejects_overlarge_top_level_tokens_that_would_need_to_be_decoded() {
        let too_large_method = "x".repeat(MAX_SCANNED_TOKEN_BYTES + 1);
        let raw = format!(r#"{{"id":1,"method":"{too_large_method}"}}"#);
        assert_eq!(err(&raw), JsonRpcEnvelopeScanError::TokenTooLarge);
    }

    // ── never-panics on arbitrary/malformed byte input ───────────────────────────────

    #[test]
    fn never_panics_on_arbitrary_or_malformed_or_empty_input() {
        let inputs: &[&[u8]] = &[
            b"",
            b"   ",
            b"{",
            b"}",
            b"[",
            b"null",
            b"{\"id\":",
            b"{\"id\":\"",
            b"{\"id\":\"\\",
            b"{\"id\":\"\\u",
            b"{\"id\":\"\\uZZZZ\"}",
            b"\xff\xfe\x00\x01",
            b"{\"id\":1,\"method\":",
            b"{\"a\":{\"b\":{\"c\":",
            &[b'{'; 1],
            &[b'['; 5000],
        ];
        for input in inputs {
            // Must return, not panic, regardless of shape.
            let _ = scan_json_rpc_envelope(input);
        }
    }

    #[test]
    fn duplicate_key_recorded_only_once_even_with_three_repeats() {
        let scanned = ok(r#"{"id":1,"id":2,"id":3,"method":"initialize"}"#);
        assert_eq!(scanned.id, Some(JsonRpcEnvelopeId::Num(3.0)));
        assert_eq!(scanned.duplicate_top_level_keys, vec!["id"]);
    }

    #[test]
    fn unrelated_duplicate_top_level_keys_are_reported_too() {
        let scanned = ok(r#"{"params":{},"params":{"x":1},"method":"initialize"}"#);
        assert_eq!(scanned.duplicate_top_level_keys, vec!["params"]);
    }

    // ── ported: json-rpc-envelope.test.ts:196-242 (deterministic fuzz corpus) ────────
    // Same seeded PRNG (Math.imul-based LCG) as the legacy test, translated bit-for-bit
    // to Rust `u32` wrapping arithmetic, so this exercises the exact corpus the legacy
    // suite pins — compared against a `serde_json`-based "ground truth" extractor
    // standing in for `JSON.parse` + manual top-level id/method extraction.

    struct SeededRandom {
        state: u32,
    }

    impl SeededRandom {
        fn new(seed: u32) -> Self {
            Self { state: seed }
        }

        fn next(&mut self) -> f64 {
            self.state = self
                .state
                .wrapping_mul(1_664_525)
                .wrapping_add(1_013_904_223);
            f64::from(self.state) / 4_294_967_296.0_f64
        }
    }

    fn pick<'a, T>(random: &mut SeededRandom, values: &'a [T]) -> &'a T {
        let index = (random.next() * values.len() as f64).floor() as usize;
        &values[index.min(values.len() - 1)]
    }

    fn expected_envelope(json: &str) -> (Option<JsonRpcEnvelopeId>, Option<String>) {
        let parsed: serde_json::Value = serde_json::from_str(json).unwrap();
        let id = parsed.get("id").and_then(|v| match v {
            serde_json::Value::String(s) => Some(JsonRpcEnvelopeId::Str(s.clone())),
            serde_json::Value::Number(n) => {
                let f = n.as_f64().unwrap();
                if f.fract() == 0.0 {
                    Some(JsonRpcEnvelopeId::Num(f))
                } else {
                    None
                }
            }
            _ => None,
        });
        let method = parsed
            .get("method")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        (id, method)
    }

    #[test]
    fn matches_bounded_json_parse_semantics_for_a_deterministic_corpus_of_top_level_envelopes() {
        let mut random = SeededRandom::new(0xc0de);
        let key_id = ["\"id\"", "\"\\u0069d\""];
        let key_method = ["\"method\"", "\"meth\\u006fd\""];
        let key_params = ["\"params\""];
        let key_result = ["\"result\""];
        let key_other = ["\"jsonrpc\"", "\"meta\"", "\"nested\""];
        let id_values = [
            "0",
            "1",
            "-2",
            "\"request-1\"",
            "\"escaped\\\\id\"",
            "null",
            "false",
            "1.25",
            "{\"id\":\"nested\"}",
            "[1]",
        ];
        let method_values = [
            "\"initialize\"",
            "\"turn\\/start\"",
            "\"thread/fork\"",
            "null",
            "true",
            "7",
            "{\"name\":\"nested\"}",
        ];
        let nested_values = [
            "{\"id\":\"nested\",\"method\":\"nested/method\"}",
            "{\"items\":[{\"id\":1},{\"method\":\"ignored\"}]}",
            "[\"id\",\"method\",{\"id\":\"array-nested\"}]",
        ];
        let slots = ["id", "method", "params", "result", "other"];

        for _ in 0..96 {
            let mut entries: Vec<String> = Vec::new();
            let entry_count = 5 + (random.next() * 5.0).floor() as usize;
            for _ in 0..entry_count {
                let slot = *pick(&mut random, &slots);
                let entry = match slot {
                    "id" => format!(
                        "{}:{}",
                        pick(&mut random, &key_id),
                        pick(&mut random, &id_values)
                    ),
                    "method" => format!(
                        "{}:{}",
                        pick(&mut random, &key_method),
                        pick(&mut random, &method_values)
                    ),
                    "params" => format!(
                        "{}:{}",
                        pick(&mut random, &key_params),
                        pick(&mut random, &nested_values)
                    ),
                    "result" => format!(
                        "{}:{}",
                        pick(&mut random, &key_result),
                        pick(&mut random, &nested_values)
                    ),
                    _ => {
                        let other_literal = ["\"2.0\"", "{\"id\":\"not-top\"}", "3"];
                        format!(
                            "{}:{}",
                            pick(&mut random, &key_other),
                            pick(&mut random, &other_literal)
                        )
                    }
                };
                entries.push(entry);
            }

            let json = format!("{{{}}}", entries.join(","));
            let (expected_id, expected_method) = expected_envelope(&json);
            let scanned = scan_json_rpc_envelope(json.as_bytes())
                .unwrap_or_else(|e| panic!("corpus entry should scan ok, got {e:?}: {json}"));
            assert_eq!(scanned.id, expected_id, "id mismatch for {json}");
            assert_eq!(
                scanned.method, expected_method,
                "method mismatch for {json}"
            );
        }
    }
}
