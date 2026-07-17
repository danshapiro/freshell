//! Terminal-output fragment splitter — an **identical port** of
//! `server/terminal-stream/output-fragments.ts` (`fragmentTerminalOutputForPayloadBudget`)
//! plus the payload-byte measurement from `server/terminal-stream/serialized-budget.ts`
//! (`measureSerializedJsonBytes`).
//!
//! ## What it does (spec `terminal-core.md §3.2`)
//!
//! `appendOutputFrames` (`broker.ts:803-826`) splits each raw PTY output string on
//! **code points** so that the *serialized `terminal.output` JSON* of every fragment
//! is `<= TERMINAL_STREAM_BATCH_MAX_BYTES`. The budget is measured with a worst-case
//! seq placeholder (`Number.MAX_SAFE_INTEGER`) and a 512-char reserve `attachRequestId`
//! (`broker.ts:812-816`), so a later seq/attachRequestId can never push a fragment
//! back over budget.
//!
//! ## Byte-measurement fidelity
//!
//! `measureSerializedJsonBytes(payload) = Buffer.byteLength(JSON.stringify(payload), 'utf8')`.
//! `serde_json::to_string` escapes exactly the characters `JSON.stringify` does
//! (`"`, `\`, and the C0 controls, with the short forms `\b \t \n \f \r`; nothing
//! else, and never `/` or non-ASCII) so the serialized **byte length is identical**.
//! JSON object key order does not affect the byte count, so the measurement matches
//! regardless of field ordering.
//!
//! ## Surrogate note (Rust vs JS divergence, benign)
//!
//! The reference guards surrogate pairs because a JS string is UTF-16 and
//! `Array.from` iterates by code point. A Rust `&str` is guaranteed valid UTF-8 and
//! cannot hold a lone surrogate, and `str::chars()` iterates Unicode scalar values
//! (= code points), so the split is inherently surrogate-safe. `containsLoneSurrogate`
//! is therefore structurally unnecessary and is intentionally omitted.

use serde_json::json;

/// `TERMINAL_STREAM_BUDGET_SEQ_PLACEHOLDER = Number.MAX_SAFE_INTEGER` (`broker.ts:54`).
/// Worst-case seq width used only for the fragment-budget measurement.
pub const TERMINAL_STREAM_BUDGET_SEQ_PLACEHOLDER: i64 = 9_007_199_254_740_991;

/// `MAX_REALTIME_MESSAGE_BYTES = 16 * 1024` (`shared/read-models.ts:5`).
pub const MAX_REALTIME_MESSAGE_BYTES: usize = 16 * 1024;

/// The 512-char `attachRequestId` reserve value (`serialized-budget.ts:3`,
/// `'x'.repeat(512)`). Reserved so a real attachRequestId never re-overflows a
/// budgeted fragment.
pub fn attach_request_id_reserve_value() -> String {
    "x".repeat(512)
}

/// `TERMINAL_STREAM_BATCH_MAX_BYTES = max(1024, env.TERMINAL_STREAM_BATCH_MAX_BYTES
/// || MAX_REALTIME_MESSAGE_BYTES)` (`constants.ts:3-6`). Env override honored for
/// fidelity; unset -> 16384.
pub fn terminal_stream_batch_max_bytes() -> usize {
    let from_env = std::env::var("TERMINAL_STREAM_BATCH_MAX_BYTES")
        .ok()
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n > 0.0)
        .map(|n| n.floor() as usize);
    from_env.unwrap_or(MAX_REALTIME_MESSAGE_BYTES).max(1024)
}

/// `measureSerializedJsonBytes` — UTF-8 byte length of the compact JSON serialization.
pub fn measure_serialized_json_bytes(payload: &serde_json::Value) -> usize {
    // `to_string` is compact (no spaces), matching `JSON.stringify` separators.
    serde_json::to_string(payload)
        .expect("terminal.output payload is always serializable")
        .len()
}

/// Build + measure the worst-case `terminal.output` payload for a candidate `data`
/// chunk, exactly as `appendOutputFrames` does (`broker.ts:809-817` ->
/// `buildTerminalOutputPayload`, `broker.ts:2132-2152`).
///
/// Field set/order mirrors the runtime insertion order (order is irrelevant to the
/// byte count but kept for faithfulness): `type, terminalId, streamId, seqStart,
/// seqEnd, data, attachRequestId, source`.
pub fn measure_terminal_output_budget_payload_bytes(
    terminal_id: &str,
    stream_id: &str,
    data: &str,
) -> usize {
    let payload = json!({
        "type": "terminal.output",
        "terminalId": terminal_id,
        "streamId": stream_id,
        "seqStart": TERMINAL_STREAM_BUDGET_SEQ_PLACEHOLDER,
        "seqEnd": TERMINAL_STREAM_BUDGET_SEQ_PLACEHOLDER,
        "data": data,
        "attachRequestId": attach_request_id_reserve_value(),
        "source": "replay",
    });
    measure_serialized_json_bytes(&payload)
}

/// Raised when the budget cannot fit even a single code point — the exact condition
/// the reference throws on (`output-fragments.ts:52`). Unreachable for the real
/// 16 KiB budget; modeled as an error rather than a panic-by-default.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FragmentBudgetTooSmall;

impl std::fmt::Display for FragmentBudgetTooSmall {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("terminal output payload budget is too small for one code point")
    }
}

impl std::error::Error for FragmentBudgetTooSmall {}

/// `fragmentTerminalOutputForPayloadBudget` (`output-fragments.ts:17-59`).
///
/// `measure_payload_bytes(candidate)` returns the serialized `terminal.output`
/// byte size for a candidate `data` string (the reference's
/// `measureSerializedJsonBytes(payloadForData(candidate))`).
///
/// Returns `[data]` unchanged when the whole payload already fits (the common case:
/// every T1 golden is a handful of ASCII bytes, far under the 16 KiB budget). Larger
/// inputs are greedily split, largest-fitting-prefix first, via the identical binary
/// search over code points.
pub fn fragment_terminal_output_for_payload_budget(
    data: &str,
    max_serialized_bytes: usize,
    measure_payload_bytes: impl Fn(&str) -> usize,
) -> Result<Vec<String>, FragmentBudgetTooSmall> {
    // `Math.max(1, Math.floor(maxSerializedBytes))`; our input is already an integer.
    let max = max_serialized_bytes.max(1);

    if measure_payload_bytes(data) <= max {
        return Ok(vec![data.to_string()]);
    }

    // Fragment on code points (Unicode scalar values), never mid-scalar.
    let code_points: Vec<char> = data.chars().collect();
    let mut chunks: Vec<String> = Vec::new();
    let mut offset = 0usize;

    while offset < code_points.len() {
        // Largest prefix (in code points) from `offset` whose payload fits `max`.
        let mut low = 1usize;
        let mut high = code_points.len() - offset;
        let mut best = 0usize;

        while low <= high {
            let mid = (low + high) / 2; // mid >= 1 (low >= 1, high >= 1)
            let candidate: String = code_points[offset..offset + mid].iter().collect();
            let bytes = measure_payload_bytes(&candidate);
            if bytes <= max {
                best = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        if best == 0 {
            return Err(FragmentBudgetTooSmall);
        }

        let chunk: String = code_points[offset..offset + best].iter().collect();
        chunks.push(chunk);
        offset += best;
    }

    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_max_defaults_to_16k() {
        // Env unset in the test harness -> max(1024, 16384).
        assert_eq!(
            terminal_stream_batch_max_bytes(),
            MAX_REALTIME_MESSAGE_BYTES
        );
    }

    #[test]
    fn measure_matches_json_stringify_byte_length() {
        // Control-char escaping parity with JSON.stringify: "\r\n" -> 4 escaped bytes.
        let v = json!({ "data": "a\r\nb" });
        // {"data":"a\r\nb"} => bytes: {"data":" =9, a =1, \r =2, \n =2, b =1, "} =2 => 17
        assert_eq!(measure_serialized_json_bytes(&v), 17);
    }

    #[test]
    fn small_ascii_is_a_single_fragment() {
        let data = "hello\r\n";
        let frags = fragment_terminal_output_for_payload_budget(
            data,
            terminal_stream_batch_max_bytes(),
            |c| measure_terminal_output_budget_payload_bytes("term", "stream", c),
        )
        .unwrap();
        assert_eq!(frags, vec![data.to_string()]);
    }

    #[test]
    fn budget_payload_is_dominated_by_the_512_reserve_but_under_16k() {
        // Sanity: a tiny data chunk's budgeted payload is well under 16 KiB, so no split.
        let bytes = measure_terminal_output_budget_payload_bytes("term", "stream", "hello\r\n");
        assert!(bytes > 512, "includes the 512-char attachRequestId reserve");
        assert!(
            bytes < MAX_REALTIME_MESSAGE_BYTES,
            "still far under the batch budget"
        );
    }

    #[test]
    fn splits_greedily_largest_prefix_first() {
        // Deterministic pure-splitter check: measure == code-point count, budget = 2.
        let frags = fragment_terminal_output_for_payload_budget("abcdef", 2, |c| c.chars().count())
            .unwrap();
        assert_eq!(frags, vec!["ab", "cd", "ef"]);
        assert_eq!(frags.concat(), "abcdef");
    }

    #[test]
    fn split_never_bisects_a_multibyte_scalar() {
        // "áé" = 2 scalars, 4 UTF-8 bytes. measure == UTF-8 byte length, budget = 2
        // must keep each 2-byte scalar whole (never emit a 1-byte half).
        let frags = fragment_terminal_output_for_payload_budget("áé", 2, |c| c.len()).unwrap();
        assert_eq!(frags, vec!["á", "é"]);
        assert_eq!(frags.concat(), "áé");
    }

    #[test]
    fn budget_too_small_for_one_code_point_errors() {
        // Every candidate measures len+10; budget 1 can never fit one scalar.
        let err = fragment_terminal_output_for_payload_budget("ab", 1, |c| c.len() + 10);
        assert_eq!(err, Err(FragmentBudgetTooSmall));
    }

    #[test]
    fn real_budget_split_reassembles_exactly() {
        // A >16 KiB ASCII blob must split into multiple fragments that concatenate
        // back to the original with no loss or duplication.
        let data = "A".repeat(40_000);
        let frags = fragment_terminal_output_for_payload_budget(
            &data,
            terminal_stream_batch_max_bytes(),
            |c| measure_terminal_output_budget_payload_bytes("term", "stream", c),
        )
        .unwrap();
        assert!(
            frags.len() >= 3,
            "40k of data exceeds several 16 KiB budgets"
        );
        assert_eq!(frags.concat(), data);
        for f in &frags {
            assert!(
                measure_terminal_output_budget_payload_bytes("term", "stream", f)
                    <= terminal_stream_batch_max_bytes()
            );
        }
    }
}
