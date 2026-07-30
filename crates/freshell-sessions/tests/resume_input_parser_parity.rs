//! SYNC-06 cross-language parser parity: the SAME fixture table that pins
//! `shared/resume-input-parser.ts` (via `test/unit/shared/resume-input-parser.test.ts`)
//! pins this port. If either implementation changes behavior, exactly one of
//! the two suites goes red — silent drift is impossible.

use freshell_sessions::resume_input::parse_resume_input;

#[derive(serde::Deserialize)]
struct Fixture {
    cases: Vec<Case>,
}

#[derive(serde::Deserialize)]
struct Case {
    name: String,
    input: String,
    candidates: serde_json::Value,
    hint: serde_json::Value,
}

#[test]
fn parser_matches_every_shared_fixture_case() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/resume-input/parser-cases.json");
    let raw = std::fs::read_to_string(&path).expect("read shared parser fixture");
    let fixture: Fixture = serde_json::from_str(&raw).expect("parse fixture json");
    assert!(
        fixture.cases.len() >= 32,
        "shared fixture unexpectedly small: {}",
        fixture.cases.len()
    );
    for case in &fixture.cases {
        let parsed = parse_resume_input(&case.input);
        let candidates = serde_json::to_value(&parsed.candidates).expect("serialize candidates");
        let hint = serde_json::to_value(&parsed.hint).expect("serialize hint");
        assert_eq!(
            candidates, case.candidates,
            "candidates mismatch for case '{}' (input {:?})",
            case.name, case.input
        );
        assert_eq!(
            hint, case.hint,
            "hint mismatch for case '{}' (input {:?})",
            case.name, case.input
        );
    }
}
