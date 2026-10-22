//! Cross-language parity for the default/derived name classifier: the SAME
//! fixture table that pins `shared/name-evidence.ts` (via
//! `test/unit/shared/name-evidence.test.ts`) pins this port. If either
//! implementation changes behavior, exactly one of the two suites goes red.

use freshell_sessions::{
    is_default_or_derived_name, is_provider_placeholder_title, NameEvidenceContext,
};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    cases: Vec<ClassifierCase>,
    placeholder_cases: Vec<PlaceholderCase>,
}

#[derive(serde::Deserialize)]
struct ClassifierCase {
    name: String,
    ctx: FixtureContext,
    expected: bool,
}

#[derive(serde::Deserialize, Default, Debug)]
#[serde(default, deny_unknown_fields)]
struct FixtureContext {
    cwd: Option<String>,
    provider: Option<String>,
    mode: Option<String>,
}

#[derive(serde::Deserialize)]
struct PlaceholderCase {
    provider: String,
    title: String,
    expected: bool,
}

fn load_fixture() -> Fixture {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test/fixtures/name-evidence/cases.json"
    );
    let raw = std::fs::read_to_string(path).expect("read shared name-evidence fixture");
    serde_json::from_str(&raw).expect("parse name-evidence fixture json")
}

#[test]
fn shared_fixture_cases_match() {
    let fixture = load_fixture();
    assert!(
        fixture.cases.len() >= 40,
        "shared fixture unexpectedly small: {}",
        fixture.cases.len()
    );
    let mismatches: Vec<String> = fixture
        .cases
        .iter()
        .enumerate()
        .filter_map(|(index, row)| {
            let ctx = NameEvidenceContext {
                cwd: row.ctx.cwd.as_deref(),
                provider: row.ctx.provider.as_deref(),
                mode: row.ctx.mode.as_deref(),
            };
            let actual = is_default_or_derived_name(&row.name, &ctx);
            (actual != row.expected).then(|| {
                format!(
                    "row {index}: {:?} ctx={:?} expected {}, got {actual}",
                    row.name, row.ctx, row.expected
                )
            })
        })
        .collect();
    assert!(
        mismatches.is_empty(),
        "mismatches:\n{}",
        mismatches.join("\n")
    );
}

#[test]
fn opencode_placeholder_reuses_directory_index_predicate() {
    let fixture = load_fixture();
    assert!(!fixture.placeholder_cases.is_empty());
    for row in &fixture.placeholder_cases {
        let actual = is_provider_placeholder_title(&row.provider, &row.title);
        assert_eq!(
            actual, row.expected,
            "placeholder mismatch for provider {} title {:?}",
            row.provider, row.title
        );
        // The OpenCode answer is exactly the directory index's own predicate,
        // so the two can never disagree about an OpenCode title.
        let index_predicate = freshell_sessions::parse::is_opencode_placeholder_title(&row.title);
        assert_eq!(
            is_provider_placeholder_title("opencode", &row.title),
            index_predicate,
            "opencode answer diverges from the directory index predicate for {:?}",
            row.title
        );
        // Other providers have no placeholders.
        assert!(!is_provider_placeholder_title("claude", &row.title));
        assert!(!is_provider_placeholder_title("codex", &row.title));
    }
}
