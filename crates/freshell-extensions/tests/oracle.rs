//! Differential oracle conformance test (df1 EXT-01).
//!
//! Iterates the frozen migration fixture `fixtures/manifest-oracle.json` —
//! and asserts, for every case:
//!   * same verdict class (valid / invalid-manifest / invalid-JSON-text)
//!   * on success: the typed manifest re-serializes to EXACTLY zod's output
//!     value (defaults materialized; order-insensitive map equality, vector
//!     order strict)
//!   * on schema failure: the flattened (code, path, message) issue list
//!     matches byte-for-byte IN ORDER
//!
//! NEVER patch this test's expectations or the fixture to match the crate.
//! The fixture is frozen provenance; fix the crate when it diverges.

use freshell_extensions::{parse_manifest, ManifestError};

const FIXTURE: &str = include_str!("../fixtures/manifest-oracle.json");

/// JSON equality AS A JS CLIENT SEES IT: numbers compare by their f64 value
/// (a JS client parses `12345678901234567000` and `1.2345678901234567e19` to
/// the same double), arrays compare order-strict, objects order-insensitive.
/// (`serde_json::Number`'s `PartialEq` is variant-strict — u64 vs f64 — which
/// would false-negative on legitimately equal doubles.)
fn js_value_eq(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    use serde_json::Value;
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(u, v)| js_value_eq(u, v))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| js_value_eq(v, w)))
        }
        _ => a == b,
    }
}

#[test]
fn oracle_conformance() {
    let fixture: serde_json::Value = serde_json::from_str(FIXTURE).expect("oracle fixture parses");
    let cases = fixture["cases"].as_array().expect("cases array");
    assert!(
        cases.len() >= 100,
        "fixture should carry >=100 cases (truncation guard), got {}",
        cases.len()
    );

    let mut names = std::collections::HashSet::new();
    let mut valid = 0usize;
    let mut invalid = 0usize;
    let mut parse_error = 0usize;

    for case in cases {
        let name = case["name"].as_str().expect("case name");
        assert!(names.insert(name.to_string()), "duplicate case name {name}");
        let raw_text = case["rawText"].as_str().expect("rawText");
        let expected = &case["expected"];

        let result = parse_manifest(raw_text);

        if expected["parseError"].as_bool().unwrap_or(false) {
            parse_error += 1;
            match &result {
                Err(ManifestError::InvalidJson(_)) => {}
                Err(ManifestError::Invalid(issues)) => {
                    panic!("case {name}: expected InvalidJson class, got issues {issues:?}")
                }
                Ok(m) => panic!("case {name}: expected InvalidJson class, got valid {m:?}"),
            }
            continue;
        }

        if expected["success"].as_bool().unwrap() {
            valid += 1;
            match result {
                Ok(manifest) => {
                    let got = manifest.to_zod_output_value();
                    let want = &expected["data"];
                    assert!(
                        js_value_eq(&got, want),
                        "case {name}: zod-output mismatch.\n got: {}\nwant: {}",
                        serde_json::to_string_pretty(&got).unwrap(),
                        serde_json::to_string_pretty(want).unwrap()
                    );
                }
                Err(e) => panic!("case {name}: expected VALID, got {e}"),
            }
        } else {
            invalid += 1;
            match result {
                Err(ManifestError::Invalid(issues)) => {
                    let got = serde_json::to_value(&issues).unwrap();
                    let want = &expected["issues"];
                    assert_eq!(
                        got,
                        *want,
                        "case {name}: issue-list mismatch.\n got: {}\nwant: {}",
                        serde_json::to_string_pretty(&got).unwrap(),
                        serde_json::to_string_pretty(want).unwrap()
                    );
                }
                Err(ManifestError::InvalidJson(e)) => {
                    panic!("case {name}: expected schema-invalid, got JSON error: {e}")
                }
                Ok(m) => panic!("case {name}: expected schema-invalid, got valid {m:?}"),
            }
        }
    }

    // Sanity spread so a degenerate fixture can't pass vacuously.
    assert!(valid >= 35, "expected plenty of valid cases, got {valid}");
    assert!(
        invalid >= 60,
        "expected plenty of invalid cases, got {invalid}"
    );
    assert!(parse_error >= 1, "expected at least one parse-error case");
    eprintln!("oracle conformance: {valid} valid / {invalid} invalid / {parse_error} parse-error cases ALL MATCH");
}

#[test]
fn frozen_fixture_is_nonempty_and_schema_mutations_are_rejected() {
    let fixture: serde_json::Value = serde_json::from_str(FIXTURE).expect("oracle fixture parses");
    let cases = fixture["cases"].as_array().expect("cases array");
    assert!(!cases.is_empty(), "frozen fixture must contain cases");

    let valid = cases
        .iter()
        .find(|case| case["expected"]["success"].as_bool() == Some(true))
        .expect("frozen fixture must contain a valid case");
    let raw = valid["rawText"].as_str().expect("valid rawText");
    let mut value: serde_json::Value =
        serde_json::from_str(raw).expect("valid case parses as JSON");
    value
        .as_object_mut()
        .expect("valid manifest case is an object")
        .insert(
            "__oracle_mutation__".to_string(),
            serde_json::Value::Bool(true),
        );
    let mutated = serde_json::to_string(&value).expect("mutated manifest serializes");
    assert!(
        matches!(parse_manifest(&mutated), Err(ManifestError::Invalid(_))),
        "adding an unknown manifest key must change the verdict"
    );
}
