//! Numeric + timestamp coercion, ported from the shared `toFiniteNumber` /
//! `parseTimestampMs` helpers duplicated in `providers/{claude,codex}.ts`.
//!
//! `parse_timestamp_ms` reproduces `Date.parse(...)` for the ISO-8601 shapes these
//! transcripts use. Determinism note: ECMAScript treats an ISO string WITHOUT a
//! timezone + time component as *local* time; we treat a missing timezone as UTC so the
//! indexer is host-timezone-independent (the oracle normalizes timestamps anyway, and
//! every committed fixture carries an explicit `Z`). Explicit `Z` / `±HH:MM` / `±HHMM`
//! offsets are honored exactly.

use serde_json::Value;

/// `toFiniteNumber`: a finite JS number, or a trimmed numeric string.
pub fn to_finite_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64().filter(|f| f.is_finite()),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                return None;
            }
            t.parse::<f64>().ok().filter(|f| f.is_finite())
        }
        _ => None,
    }
}

/// `parseTimestampMs`: a finite JS number (already ms), or `Date.parse` of a string.
pub fn parse_timestamp_ms(value: &Value) -> Option<i64> {
    match value {
        Value::Number(n) => {
            let f = n.as_f64()?;
            if f.is_finite() {
                // Floor fractional passthroughs exactly like the reference's
                // `Math.floor` ("Floor numeric passthroughs: downstream
                // read-model schemas require integer epoch-ms",
                // `providers/codex.ts:47-48`) — a bare `f as i64` truncates
                // toward zero, which only coincides with `Math.floor` for
                // non-negative values.
                Some(f.floor() as i64)
            } else {
                None
            }
        }
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                return None;
            }
            date_parse_ms(t)
        }
        _ => None,
    }
}

/// Days since the Unix epoch for a proleptic-Gregorian y/m/d (Howard Hinnant's
/// `days_from_civil`).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = if m > 2 { m - 3 } else { m + 9 }; // [0, 11]
    let doy = (153 * mp + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146097 + doe - 719468
}

/// Minimal ISO-8601 -> epoch-ms parser matching `Date.parse` for the supported shapes:
/// `YYYY-MM-DD`, `YYYY-MM-DD[T ]HH:MM(:SS(.fff)?)?(Z|+-HH:MM|+-HHMM)?`.
fn date_parse_ms(s: &str) -> Option<i64> {
    let bytes = s.as_bytes();
    // Date part: YYYY-MM-DD
    if bytes.len() < 10 {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    if bytes[4] != b'-' {
        return None;
    }
    let month: i64 = s.get(5..7)?.parse().ok()?;
    if bytes[7] != b'-' {
        return None;
    }
    let day: i64 = s.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let mut hour = 0i64;
    let mut minute = 0i64;
    let mut second = 0i64;
    let mut millis = 0i64;
    let mut offset_minutes = 0i64;

    if bytes.len() > 10 {
        // Separator must be 'T' or ' '
        let sep = bytes[10];
        if sep != b'T' && sep != b't' && sep != b' ' {
            return None;
        }
        let rest = &s[11..];
        let rb = rest.as_bytes();
        if rb.len() < 5 {
            return None;
        }
        hour = rest.get(0..2)?.parse().ok()?;
        if rb[2] != b':' {
            return None;
        }
        minute = rest.get(3..5)?.parse().ok()?;

        let mut idx = 5usize;
        // optional :SS
        if rb.get(idx) == Some(&b':') {
            second = rest.get(idx + 1..idx + 3)?.parse().ok()?;
            idx += 3;
            // optional .fff (fractional seconds, up to ms precision)
            if rb.get(idx) == Some(&b'.') {
                let frac_start = idx + 1;
                let mut frac_end = frac_start;
                while frac_end < rb.len() && rb[frac_end].is_ascii_digit() {
                    frac_end += 1;
                }
                let frac = &rest[frac_start..frac_end];
                // take first 3 digits (ms), right-pad if fewer
                let mut ms_str = String::new();
                for i in 0..3 {
                    ms_str.push(frac.as_bytes().get(i).copied().unwrap_or(b'0') as char);
                }
                millis = ms_str.parse().ok()?;
                idx = frac_end;
            }
        }

        // optional timezone
        if idx < rb.len() {
            match rb[idx] {
                b'Z' | b'z' => {
                    // UTC, offset 0
                }
                b'+' | b'-' => {
                    let sign = if rb[idx] == b'+' { 1 } else { -1 };
                    let tz = &rest[idx + 1..];
                    let tzb = tz.as_bytes();
                    if tzb.len() >= 5 && tzb[2] == b':' {
                        let oh: i64 = tz.get(0..2)?.parse().ok()?;
                        let om: i64 = tz.get(3..5)?.parse().ok()?;
                        offset_minutes = sign * (oh * 60 + om);
                    } else if tzb.len() >= 4 {
                        let oh: i64 = tz.get(0..2)?.parse().ok()?;
                        let om: i64 = tz.get(2..4)?.parse().ok()?;
                        offset_minutes = sign * (oh * 60 + om);
                    } else {
                        return None;
                    }
                }
                _ => return None,
            }
        }
    }

    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_minutes * 60;
    Some(secs * 1_000 + millis)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // SESSION-14: fractional epoch-ms passthroughs normalize to integers by
    // FLOORING (`Math.floor` parity with `providers/codex.ts`'s
    // `parseTimestampMs`) — the directory/API read-model schemas require
    // integer epoch-ms, and sort keys, cursors, and revisions are computed
    // from these integers, so a fractional provider clock can never make a
    // projected page oscillate around a millisecond boundary.
    #[test]
    fn fractional_numeric_epoch_ms_is_floored_not_rounded() {
        // Boundary/fractional fixtures around real transcript timestamps.
        assert_eq!(
            parse_timestamp_ms(&json!(1_769_753_756_713.9)),
            Some(1_769_753_756_713)
        );
        assert_eq!(
            parse_timestamp_ms(&json!(1_738_231_200_000.5)),
            Some(1_738_231_200_000)
        );
        // Just below the next millisecond boundary must NOT round up.
        assert_eq!(
            parse_timestamp_ms(&json!(1_738_231_200_000.999)),
            Some(1_738_231_200_000)
        );
        // Exact integers pass through unchanged.
        assert_eq!(parse_timestamp_ms(&json!(0.0)), Some(0));
        assert_eq!(
            parse_timestamp_ms(&json!(1_738_231_200_000i64)),
            Some(1_738_231_200_000)
        );
    }

    #[test]
    fn negative_fractional_epoch_ms_floors_like_math_floor() {
        // `Math.floor(-0.5)` is -1; a bare `f as i64` truncation would give 0.
        assert_eq!(parse_timestamp_ms(&json!(-0.5)), Some(-1));
        assert_eq!(
            parse_timestamp_ms(&json!(-1_738_231_200_000.5)),
            Some(-1_738_231_200_001)
        );
    }

    // ISO strings: sub-second fractions normalize at millisecond precision —
    // digits beyond the third are dropped (never rounded), fewer digits
    // right-pad, exactly as `Date.parse` resolves to whole ms.
    #[test]
    fn iso_fractional_seconds_are_truncated_at_millisecond_precision() {
        // Base: "2025-01-30T10:00:00.000Z" == 1_738_231_200_000 (pinned by
        // `timestamps_match_date_parse_for_fixture_values` in lib.rs).
        assert_eq!(
            parse_timestamp_ms(&json!("2025-01-30T10:00:00.999999Z")),
            Some(1_738_231_200_999)
        );
        assert_eq!(
            parse_timestamp_ms(&json!("2025-01-30T10:00:00.123456789Z")),
            Some(1_738_231_200_123)
        );
        // A purely sub-ms remainder contributes nothing.
        assert_eq!(
            parse_timestamp_ms(&json!("2025-01-30T10:00:00.000001Z")),
            Some(1_738_231_200_000)
        );
        // Fewer than three digits right-pad (`.1` = 100ms, `.12` = 120ms).
        assert_eq!(
            parse_timestamp_ms(&json!("2025-01-30T10:00:00.1Z")),
            Some(1_738_231_200_100)
        );
        assert_eq!(
            parse_timestamp_ms(&json!("2025-01-30T10:00:00.12Z")),
            Some(1_738_231_200_120)
        );
        // A fraction survives an explicit offset unharmed.
        assert_eq!(
            parse_timestamp_ms(&json!("2025-01-30T12:00:00.5555+02:00")),
            Some(1_738_231_200_555)
        );
    }

    #[test]
    fn date_only_iso_is_midnight_utc() {
        assert_eq!(parse_timestamp_ms(&json!("1970-01-01")), Some(0));
        assert_eq!(parse_timestamp_ms(&json!("1969-12-31")), Some(-86_400_000));
    }
}
