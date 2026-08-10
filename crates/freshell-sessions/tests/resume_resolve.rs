//! SYNC-06 logic-parity mirror of the HARDENED Node core suite
//! `test/unit/server/coding-cli/resolve-session.test.ts` (post-#586),
//! test-for-test. The HTTP wire (auth/validation/router merge) is pinned in
//! `crates/freshell-server/src/resolve.rs`.
//!
//! Layout:
//! 1. The 23-test mirror, in Node file order.
//! 2. Rust-only shape-gate/budget pins with no Node twin in the core suite.
//! 3. Supplementary pins beyond the Node core suite (resolve-fallbacks.test.ts
//!    parity, wire-shape pins, richer variants) carried over from the
//!    pre-hardening Rust suite so coverage never shrinks.

use std::collections::HashMap;

use freshell_sessions::directory_index::IndexedSession;
use freshell_sessions::resume_input::{ResumeHint, ResumeHintProvider, ResumeHintSource};
use freshell_sessions::resume_resolve::{
    resolve_resume_input, ClaudeTranscriptHit, OpencodeByIdHit, ProviderFailure, ResolveDeps,
    ResumeMatchKind, ResumeResolveOutcome, ResumeResolveProviderError, ResumeResolveStatus,
    RESOLVE_MATCH_CAP,
};

const CLAUDE_ID: &str = "ed2afda6-a340-443e-ba60-024a1b3554b4";
const OTHER_UUID: &str = "aaaaaaaa-1111-4222-8333-444444444444";
const SES_ID: &str = "ses_root0000000000000000000000";
const CODEX_ID: &str = "019fac27-69d7-78a0-b972-b339d551042e";
const AMPLIFIER_FULL: &str = "417e8345-90ab-4cde-8f01-234567890abc";

fn session(provider: &str, id: &str, last: i64) -> IndexedSession {
    IndexedSession {
        session_id: id.to_string(),
        provider: provider.to_string(),
        project_path: format!("/repo/{provider}"),
        title: Some(format!("{provider} title")),
        title_provider_generated: false,
        title_source: None,
        summary: None,
        first_user_message: Some("hello".to_string()),
        last_activity_at: last,
        created_at: None,
        cwd: Some(format!("/repo/{provider}")),
        is_subagent: false,
        is_non_interactive: false,
        git_branch: None,
        source_file: None,
    }
}

#[allow(clippy::type_complexity)]
fn resolve(
    input: &str,
    sessions: Option<&[IndexedSession]>,
    claude: Option<
        &(dyn Fn(&str) -> Result<Option<ClaudeTranscriptHit>, ProviderFailure> + Send + Sync),
    >,
    opencode: Option<
        &(dyn Fn(&str) -> Result<Option<OpencodeByIdHit>, ProviderFailure> + Send + Sync),
    >,
) -> ResumeResolveOutcome {
    let session_types: HashMap<String, String> = HashMap::new();
    resolve_resume_input(
        input,
        &ResolveDeps {
            sessions,
            session_types: &session_types,
            locate_claude_transcript: claude,
            opencode_session_by_id: opencode,
        },
    )
}

/// Node's `fourProviderSnapshot`.
fn four_provider_snapshot() -> Vec<IndexedSession> {
    vec![
        session("claude", CLAUDE_ID, 100),
        session("codex", CODEX_ID, 100),
        session("opencode", SES_ID, 100),
        session("amplifier", AMPLIFIER_FULL, 100),
    ]
}

/// Wire-shape helper: `ResumeResolveMatch` is the serialized surface (the
/// outcome envelope itself is re-wrapped by the HTTP layer, Task 6).
fn matches_json(out: &ResumeResolveOutcome) -> serde_json::Value {
    serde_json::to_value(&out.matches).expect("serialize matches")
}

// =========================================================================
// 1. The 23-test mirror of `resolve-session.test.ts`, in Node file order.
// =========================================================================

// Node #1: `exact match wins across all providers at once (claude UUID, no
// hint needed)` — "no hint needed" means no explicit command hint is required
// in the INPUT; a bare v4 UUID still derives the claude id-shape hint on both
// parsers (`shared/resume-input-parser.ts:88-94`, `resume_input.rs:194-202`).
#[test]
fn exact_match_wins_across_all_providers_at_once() {
    let sessions = four_provider_snapshot();
    let out = resolve(CLAUDE_ID, Some(&sessions), None, None);
    assert_eq!(out.matches.len(), 1);
    let m = &out.matches[0];
    assert_eq!(m.provider, "claude");
    assert_eq!(m.session_id, CLAUDE_ID);
    assert_eq!(m.session_type.as_deref(), Some("claude"));
    assert_eq!(m.cwd.as_deref(), Some("/repo/claude"));
    assert_eq!(m.match_kind, ResumeMatchKind::Exact);
    assert_eq!(
        out.hint,
        Some(ResumeHint {
            provider: ResumeHintProvider::Claude,
            source: ResumeHintSource::IdShape,
        })
    );
}

// Node #2: `short hex prefix matches the amplifier session (spec row: 417e8345)`
#[test]
fn short_hex_prefix_matches_the_amplifier_session() {
    let sessions = four_provider_snapshot();
    let out = resolve("417e8345", Some(&sessions), None, None);
    assert_eq!(out.matches.len(), 1);
    assert_eq!(out.matches[0].provider, "amplifier");
    assert_eq!(out.matches[0].session_id, AMPLIFIER_FULL);
    assert_eq!(out.matches[0].match_kind, ResumeMatchKind::Prefix);
}

// Node #3: `exact-id match is case-insensitive for UUID/hex tokens`
#[test]
fn exact_id_match_is_case_insensitive_for_uuid_hex_tokens() {
    let sessions = vec![session("claude", CLAUDE_ID, 100)];
    let out = resolve(&CLAUDE_ID.to_uppercase(), Some(&sessions), None, None);
    assert_eq!(out.matches.len(), 1);
    assert_eq!(out.matches[0].match_kind, ResumeMatchKind::Exact);
}

// Node #4: `ses_ ids are case-SENSITIVE (base62): a case-variant does NOT match`
#[test]
fn ses_ids_are_case_sensitive_a_case_variant_does_not_match() {
    let sessions = vec![session("opencode", SES_ID, 100)];
    let variant = SES_ID.to_uppercase().replace("SES_", "ses_");
    let out = resolve(&variant, Some(&sessions), None, None);
    assert_eq!(out.status, ResumeResolveStatus::Ready);
    // Not exact — but it IS a prefix miss too (different chars), so empty.
    assert!(out.matches.is_empty());
}

// Node #5: `opencode ses_ id resolves to opencode even though other providers exist`
#[test]
fn opencode_ses_id_resolves_to_opencode_even_though_other_providers_exist() {
    let sessions = four_provider_snapshot();
    let out = resolve(SES_ID, Some(&sessions), None, None);
    assert_eq!(out.matches.len(), 1);
    assert_eq!(out.matches[0].provider, "opencode");
}

// Node #6: `exact match takes precedence over prefix matches of the same token`
#[test]
fn exact_match_takes_precedence_over_prefix_matches_of_the_same_token() {
    let sessions = vec![
        session("amplifier", "417e8345", 1),
        session("amplifier", AMPLIFIER_FULL, 2),
    ];
    let out = resolve("417e8345", Some(&sessions), None, None);
    assert_eq!(out.matches.len(), 1);
    assert_eq!(out.matches[0].match_kind, ResumeMatchKind::Exact);
}

// Node #7: `ambiguous prefix returns all matches most-recent first, capped`
#[test]
fn ambiguous_prefix_returns_all_matches_most_recent_first_capped() {
    let many: Vec<IndexedSession> = (0..25)
        .map(|i| session("amplifier", &format!("417e8345-0000-4000-8000-{i:012}"), i))
        .collect();
    let out = resolve("417e8345", Some(&many), None, None);
    assert_eq!(out.matches.len(), RESOLVE_MATCH_CAP);
    // Most recent first; 25 sessions with activity 24..0 capped at 20 make
    // the tail EXACTLY 5.
    assert_eq!(out.matches[0].last_activity_at, Some(24));
    assert_eq!(out.matches[RESOLVE_MATCH_CAP - 1].last_activity_at, Some(5));
}

// Node #8: `tries candidates in priority order until one resolves`
#[test]
fn tries_candidates_in_priority_order_until_one_resolves() {
    // ses_ token (highest parser priority) misses everywhere; the UUID resolves.
    let sessions = four_provider_snapshot();
    let out = resolve(
        &format!("ses_zzzzzzzzzzzzzzzzzzzzzzzzzz {CLAUDE_ID}"),
        Some(&sessions),
        None,
        None,
    );
    assert_eq!(out.matches.len(), 1);
    assert_eq!(out.matches[0].session_id, CLAUDE_ID);
}

// Node #9: `an EXACT id finds a subagent/child session (spec: scan ALL sessions)`
#[test]
fn an_exact_id_finds_a_subagent_child_session() {
    let mut child = session("claude", CLAUDE_ID, 100);
    child.is_subagent = true;
    let out = resolve(CLAUDE_ID, Some(&[child]), None, None);
    assert_eq!(out.matches.len(), 1);
}

// Node #10: `prefix DISCOVERY does not surface subagent sessions`
#[test]
fn prefix_discovery_does_not_surface_subagent_sessions() {
    let mut child = session("claude", CLAUDE_ID, 100);
    child.is_subagent = true;
    let top = session("claude", "ed2afda6-a340-443e-ba60-024a1b3554b5", 90);
    let out = resolve("ed2afda6", Some(&[child, top]), None, None);
    assert_eq!(out.matches.len(), 1);
    assert_eq!(
        out.matches[0].session_id,
        "ed2afda6-a340-443e-ba60-024a1b3554b5"
    );
}

// Node #11: `an exact FALLBACK hit beats an indexed PREFIX match of the same token`
#[test]
fn an_exact_fallback_hit_beats_an_indexed_prefix_match_of_the_same_token() {
    // Index holds a session whose id merely STARTS WITH the pasted full id.
    let longer = session("claude", &format!("{CLAUDE_ID}0"), 100);
    let hits = |id: &str| -> Result<Option<ClaudeTranscriptHit>, ProviderFailure> {
        Ok(Some(ClaudeTranscriptHit {
            session_id: id.to_ascii_lowercase(),
            cwd: Some("/repo/x".into()),
        }))
    };
    let out = resolve(CLAUDE_ID, Some(&[longer]), Some(&hits), None);
    assert_eq!(out.matches.len(), 1);
    assert_eq!(out.matches[0].session_id, CLAUDE_ID);
    assert_eq!(out.matches[0].provider, "claude");
}

// Node #12: `sessionType defaults to the provider name when the index has none`
#[test]
fn session_type_defaults_to_the_provider_name_when_the_overlay_has_none() {
    let sessions = vec![session("claude", CLAUDE_ID, 100)];
    let out = resolve(CLAUDE_ID, Some(&sessions), None, None);
    assert_eq!(out.matches[0].session_type.as_deref(), Some("claude"));
}

// Node #13: `index miss consults exact-id fallbacks (claude transcript locator)`
#[test]
fn index_miss_consults_exact_id_fallbacks_claude_transcript_locator() {
    let locate = |id: &str| -> Result<Option<ClaudeTranscriptHit>, ProviderFailure> {
        Ok(Some(ClaudeTranscriptHit {
            session_id: id.to_ascii_lowercase(),
            cwd: Some("/tmp/found".into()),
        }))
    };
    let out = resolve(OTHER_UUID, Some(&[]), Some(&locate), None);
    assert_eq!(out.matches.len(), 1);
    let m = &out.matches[0];
    assert_eq!(m.provider, "claude");
    assert_eq!(m.session_id, OTHER_UUID);
    assert_eq!(m.cwd.as_deref(), Some("/tmp/found"));
    assert_eq!(m.match_kind, ResumeMatchKind::Exact);
}

// Node #14: `index miss consults opencode by-id fallback` — with the hardened
// row query's richer payload (title + floored lastActivityAt) asserted.
#[test]
fn opencode_fallback_hit_carries_title_and_floored_last_activity() {
    let oc = |id: &str| -> Result<Option<OpencodeByIdHit>, ProviderFailure> {
        Ok(Some(OpencodeByIdHit {
            session_id: id.to_string(),
            cwd: Some("/repo/beta".into()),
            title: Some("beta work".into()),
            last_activity_at: Some(1234),
        }))
    };
    let out = resolve(SES_ID, Some(&[]), None, Some(&oc));
    let m = &out.matches[0];
    assert_eq!(m.provider, "opencode");
    assert_eq!(m.title.as_deref(), Some("beta work"));
    assert_eq!(m.last_activity_at, Some(1234));
    assert_eq!(m.session_type.as_deref(), Some("opencode"));
}

// Node #15: `zero matches when nothing resolves anywhere`
#[test]
fn zero_matches_when_nothing_resolves_anywhere() {
    let sessions = four_provider_snapshot();
    let claude = |_: &str| -> Result<Option<ClaudeTranscriptHit>, ProviderFailure> { Ok(None) };
    let oc = |_: &str| -> Result<Option<OpencodeByIdHit>, ProviderFailure> { Ok(None) };
    let out = resolve("deadbeef1234", Some(&sessions), Some(&claude), Some(&oc));
    assert_eq!(out.status, ResumeResolveStatus::Ready);
    assert!(out.matches.is_empty());
}

// Node #16: `a THROWING fallback never fails the request: it degrades with a
// provider error summary`
#[test]
fn a_failing_fallback_never_fails_the_resolve_it_degrades_with_a_provider_error() {
    // Node production parity: the opencode worker boundary serializes only
    // {name, message} (`opencode-by-id.worker.ts:41-42`) and the runner
    // rebuilds the Error WITHOUT `.code` (`opencode-by-id-runner.ts:103-106`),
    // so opencode provider errors are message-only on the wire — `code` is
    // None here. (Code passthrough-when-present is exercised by the claude
    // fallback's EACCES endpoint test in Task 6.)
    let broken = |_id: &str| -> Result<Option<OpencodeByIdHit>, ProviderFailure> {
        Err(ProviderFailure {
            code: None,
            message: "unable to open database file".into(),
        })
    };
    let out = resolve(SES_ID, Some(&[]), None, Some(&broken));
    assert_eq!(out.status, ResumeResolveStatus::Degraded);
    assert!(out.matches.is_empty());
    assert_eq!(out.provider_errors.len(), 1);
    assert_eq!(out.provider_errors[0].provider, "opencode");
    assert_eq!(out.provider_errors[0].code, None);
    assert_eq!(
        out.provider_errors[0].message.as_deref(),
        Some("unable to open database file")
    );
}

// Node #17: `provider identity in providerErrors comes from the fallback PAIR,
// not its position`
#[test]
fn provider_identity_travels_with_the_fallback_not_its_position() {
    // BOTH fallbacks present; only claude's fails on a uuid token.
    let broken_claude = |_id: &str| -> Result<Option<ClaudeTranscriptHit>, ProviderFailure> {
        Err(ProviderFailure {
            code: Some("EACCES".into()),
            message: "denied".into(),
        })
    };
    let quiet_oc = |_id: &str| -> Result<Option<OpencodeByIdHit>, ProviderFailure> { Ok(None) };
    let out = resolve(OTHER_UUID, Some(&[]), Some(&broken_claude), Some(&quiet_oc));
    assert_eq!(out.provider_errors.len(), 1);
    assert_eq!(out.provider_errors[0].provider, "claude");
    assert_eq!(out.provider_errors[0].code.as_deref(), Some("EACCES"));
}

// Node #18: `a typed ClaudeTranscriptLocatorError surfaces its errno code in
// the provider error` — Rust models Node's typed error as `ProviderFailure.code`.
#[test]
fn a_typed_locator_failure_surfaces_its_errno_code_in_the_provider_error() {
    let broken = |_id: &str| -> Result<Option<ClaudeTranscriptHit>, ProviderFailure> {
        Err(ProviderFailure {
            code: Some("EACCES".into()),
            message: "failed to list claude projects dir: /tmp/x".into(),
        })
    };
    let out = resolve(CLAUDE_ID, Some(&[]), Some(&broken), None);
    assert_eq!(out.status, ResumeResolveStatus::Degraded);
    assert_eq!(
        out.provider_errors,
        vec![ResumeResolveProviderError {
            provider: "claude".into(),
            code: Some("EACCES".into()),
            message: Some("failed to list claude projects dir: /tmp/x".into()),
        }]
    );
}

// Node #19: `a healthy resolve reports NO provider errors`
#[test]
fn a_healthy_resolve_reports_no_provider_errors_and_stays_ready() {
    let sessions = vec![session("claude", CLAUDE_ID, 100)];
    let out = resolve(CLAUDE_ID, Some(&sessions), None, None);
    assert_eq!(out.status, ResumeResolveStatus::Ready);
    assert!(out.provider_errors.is_empty());
}

// Node #20: `a failed exact-id fallback does NOT hide a later lower-priority
// match — but marks the response degraded`
#[test]
fn a_failed_fallback_does_not_hide_a_later_lower_priority_match_but_marks_degraded() {
    // ses_ token fails in the fallback; the later hex token prefix-matches the index.
    let indexed = vec![session("amplifier", "417e8345aaaa", 50)];
    let broken = |_id: &str| -> Result<Option<OpencodeByIdHit>, ProviderFailure> {
        Err(ProviderFailure {
            code: None,
            message: "locked".into(),
        })
    };
    let out = resolve(
        &format!("{SES_ID} 417e8345"),
        Some(&indexed),
        None,
        Some(&broken),
    );
    assert_eq!(out.status, ResumeResolveStatus::Degraded);
    assert_eq!(out.matches.len(), 1);
    assert_eq!(out.matches[0].session_id, "417e8345aaaa");
    assert_eq!(out.provider_errors[0].provider, "opencode");
}

// Node #21: `a fallback exact hit for a HIGHER-priority token beats an indexed
// exact hit of a LOWER-priority token`
#[test]
fn a_fallback_exact_hit_for_a_higher_priority_token_beats_an_indexed_exact_of_a_lower_one() {
    // Candidate order: ses_ (prefixed) outranks the uuid. The ses_ id resolves
    // only via the opencode fallback; the uuid has an indexed exact hit.
    let indexed = vec![session("claude", CLAUDE_ID, 100)];
    let oc = |id: &str| -> Result<Option<OpencodeByIdHit>, ProviderFailure> {
        Ok(Some(OpencodeByIdHit {
            session_id: id.to_string(),
            cwd: Some("/repo/oc".into()),
            title: None,
            last_activity_at: None,
        }))
    };
    let out = resolve(
        &format!("{SES_ID} {CLAUDE_ID}"),
        Some(&indexed),
        None,
        Some(&oc),
    );
    assert_eq!(out.matches.len(), 1);
    assert_eq!(out.matches[0].provider, "opencode");
    assert_eq!(out.matches[0].session_id, SES_ID);
}

// Node #22: `dedupes duplicate (provider, sessionId) snapshot entries, keeping
// the most recent`
#[test]
fn dedupes_duplicate_provider_session_id_snapshot_entries_keeping_the_most_recent() {
    let mut older = session("claude", CLAUDE_ID, 100);
    older.title = Some("older file".to_string());
    let mut newer = session("claude", CLAUDE_ID, 500);
    newer.title = Some("newer file".to_string());
    let out = resolve(CLAUDE_ID, Some(&[older, newer]), None, None);
    assert_eq!(out.matches.len(), 1);
    assert_eq!(out.matches[0].title.as_deref(), Some("newer file"));
    assert_eq!(out.matches[0].last_activity_at, Some(500));
}

// Node #23: `returns warming (not "not found") while the index is not ready`
#[test]
fn returns_warming_not_not_found_while_the_index_is_not_ready() {
    let out = resolve(&format!("claude --resume {CLAUDE_ID}"), None, None, None);
    assert_eq!(out.status, ResumeResolveStatus::Warming);
    assert!(out.matches.is_empty());
    assert_eq!(
        out.hint,
        Some(ResumeHint {
            provider: ResumeHintProvider::Claude,
            source: ResumeHintSource::Command,
        })
    );
    assert!(out.provider_errors.is_empty());
}

// =========================================================================
// 2. Rust-only shape-gate/budget pins (no Node twin in the core suite; the
//    Node originals live in resolve-fallbacks.test.ts).
// =========================================================================

#[test]
fn shape_gates_wrong_shape_tokens_do_no_fallback_work() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static CALLS: AtomicUsize = AtomicUsize::new(0);
    let counting = |_id: &str| -> Result<Option<OpencodeByIdHit>, ProviderFailure> {
        CALLS.fetch_add(1, Ordering::SeqCst);
        Ok(None)
    };
    // "ses_short001" matches the parser's prefixed-id family but NOT the
    // full-id shape ^ses_[0-9a-zA-Z]{26}$ — the fallback must not run.
    let out = resolve("ses_short001", Some(&[]), None, Some(&counting));
    assert_eq!(CALLS.load(Ordering::SeqCst), 0);
    assert_eq!(out.status, ResumeResolveStatus::Ready);
}

#[test]
fn fallback_work_is_budgeted_to_two_calls_per_request_per_provider() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static CALLS: AtomicUsize = AtomicUsize::new(0);
    let counting = |_id: &str| -> Result<Option<OpencodeByIdHit>, ProviderFailure> {
        CALLS.fetch_add(1, Ordering::SeqCst);
        Ok(None)
    };
    // Four full-shape ses_ ids in one paste: only the first TWO may do work.
    let ids = [
        "ses_aaaaaaaaaaaaaaaaaaaaaaaaaa",
        "ses_bbbbbbbbbbbbbbbbbbbbbbbbbb",
        "ses_cccccccccccccccccccccccccc",
        "ses_dddddddddddddddddddddddddd",
    ];
    let _ = resolve(&ids.join(" "), Some(&[]), None, Some(&counting));
    assert_eq!(CALLS.load(Ordering::SeqCst), 2);
}

#[test]
fn wrong_shape_tokens_consume_no_budget() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static CALLS: AtomicUsize = AtomicUsize::new(0);
    let counting = |_id: &str| -> Result<Option<ClaudeTranscriptHit>, ProviderFailure> {
        CALLS.fetch_add(1, Ordering::SeqCst);
        Ok(None)
    };
    // Two ses_ tokens (wrong shape for claude) then a valid uuid: the uuid
    // must still reach the claude fallback (shape gate runs BEFORE budget).
    let input =
        format!("ses_aaaaaaaaaaaaaaaaaaaaaaaaaa ses_bbbbbbbbbbbbbbbbbbbbbbbbbb {OTHER_UUID}");
    let _ = resolve(&input, Some(&[]), Some(&counting), None);
    assert_eq!(CALLS.load(Ordering::SeqCst), 1);
}

// =========================================================================
// 3. Supplementary pins beyond the Node core suite (resolve-fallbacks.test.ts
//    parity + wire-shape pins), carried over from the pre-hardening suite and
//    adapted to the hardened interfaces.
// =========================================================================

const AMP_ID_NEW: &str = "417e8345-aaaa-4bbb-8ccc-000000000001";
const AMP_ID_OLD: &str = "417e8345-bbbb-4ccc-8ddd-000000000002";

fn session_in(provider: &str, id: &str, project: &str, last_activity_at: i64) -> IndexedSession {
    IndexedSession {
        session_id: id.to_string(),
        provider: provider.to_string(),
        project_path: project.to_string(),
        title: None,
        title_provider_generated: false,
        title_source: None,
        summary: None,
        first_user_message: None,
        last_activity_at,
        created_at: None,
        cwd: Some(project.to_string()),
        is_subagent: false,
        is_non_interactive: false,
        git_branch: None,
        source_file: None,
    }
}

/// The Node integration suite's fixtureProjects(), flattened.
fn fixture_sessions() -> Vec<IndexedSession> {
    let mut claude = session_in("claude", CLAUDE_ID, "/repo/alpha", 400);
    claude.title = Some("Fix the parser".to_string());
    claude.first_user_message = Some("fix the parser".to_string());
    vec![
        claude,
        session_in("codex", CODEX_ID, "/repo/alpha", 300),
        session_in("opencode", SES_ID, "/repo/beta", 200),
        session_in("amplifier", AMP_ID_NEW, "/repo/beta", 900),
        session_in("amplifier", AMP_ID_OLD, "/repo/beta", 100),
    ]
}

#[test]
fn exact_uuid_resolves_to_single_exact_match() {
    let sessions = fixture_sessions();
    for (input, provider, id) in [
        (CLAUDE_ID.to_string(), "claude", CLAUDE_ID),
        (format!("codex resume {CODEX_ID}"), "codex", CODEX_ID),
        (format!("opencode --session {SES_ID}"), "opencode", SES_ID),
    ] {
        let out = resolve(&input, Some(&sessions), None, None);
        assert_eq!(out.status, ResumeResolveStatus::Ready, "input {input:?}");
        assert_eq!(out.matches.len(), 1, "input {input:?}");
        assert_eq!(out.matches[0].provider, provider);
        assert_eq!(out.matches[0].session_id, id);
        assert_eq!(out.matches[0].match_kind, ResumeMatchKind::Exact);
    }
}

#[test]
fn match_carries_full_resume_metadata() {
    let sessions = fixture_sessions();
    let out = resolve(CLAUDE_ID, Some(&sessions), None, None);
    // Wire-shape pin: camelCase names, all optionals present here.
    assert_eq!(
        matches_json(&out),
        serde_json::json!([{
            "provider": "claude",
            "sessionId": CLAUDE_ID,
            "cwd": "/repo/alpha",
            // No metadata-store overlay entry: sessionType defaults to the
            // provider — hardened Node's `toMatch` emits
            // `sessionType ?? provider`, never absent.
            "sessionType": "claude",
            "title": "Fix the parser",
            "firstUserMessage": "fix the parser",
            "lastActivityAt": 400,
            "matchKind": "exact"
        }])
    );
}

#[test]
fn session_type_overlays_from_metadata_map() {
    let sessions = fixture_sessions();
    let mut types = HashMap::new();
    types.insert(format!("claude:{CLAUDE_ID}"), "freshclaude".to_string());
    let out = resolve_resume_input(
        CLAUDE_ID,
        &ResolveDeps {
            sessions: Some(&sessions),
            session_types: &types,
            locate_claude_transcript: None,
            opencode_session_by_id: None,
        },
    );
    assert_eq!(out.matches[0].session_type.as_deref(), Some("freshclaude"));
}

#[test]
fn prefix_matches_short_hex_most_recent_first() {
    let sessions = fixture_sessions();
    let out = resolve("417e8345", Some(&sessions), None, None);
    assert_eq!(out.status, ResumeResolveStatus::Ready);
    let ids: Vec<&str> = out.matches.iter().map(|m| m.session_id.as_str()).collect();
    assert_eq!(ids, vec![AMP_ID_NEW, AMP_ID_OLD]);
    assert_eq!(out.matches[0].match_kind, ResumeMatchKind::Prefix);
    assert_eq!(out.matches[0].provider, "amplifier");
}

#[test]
fn reports_hint_alongside_evidence() {
    let sessions = fixture_sessions();
    let out = resolve(
        &format!("codex resume {CODEX_ID}"),
        Some(&sessions),
        None,
        None,
    );
    assert_eq!(
        out.hint,
        Some(ResumeHint {
            provider: ResumeHintProvider::Codex,
            source: ResumeHintSource::Command,
        })
    );
    assert_eq!(out.matches.len(), 1);
}

#[test]
fn unknown_id_is_ready_with_empty_matches() {
    let sessions = fixture_sessions();
    let out = resolve(
        "019fffff-ffff-7fff-bfff-ffffffffffff",
        Some(&sessions),
        None,
        None,
    );
    assert_eq!(out.status, ResumeResolveStatus::Ready);
    assert!(out.matches.is_empty());
}

#[test]
fn garbage_input_is_ready_empty_with_no_hint() {
    // The `hint: null`-on-the-wire pin lives in the HTTP layer
    // (`resolve.rs`); at the core level absence is `None`.
    let sessions = fixture_sessions();
    let out = resolve("hello decade facade!!", Some(&sessions), None, None);
    assert_eq!(out.status, ResumeResolveStatus::Ready);
    assert!(out.matches.is_empty());
    assert_eq!(out.hint, None);
    assert!(out.provider_errors.is_empty());
}

#[test]
fn opencode_by_id_fallback_uses_row_directory_as_cwd() {
    let unknown = "ses_child000000000000000000000";
    let lookup = |id: &str| -> Result<Option<OpencodeByIdHit>, ProviderFailure> {
        assert_eq!(id, unknown);
        Ok(Some(OpencodeByIdHit {
            session_id: id.to_string(),
            cwd: Some("/repo/beta".to_string()),
            title: None,
            last_activity_at: None,
        }))
    };
    let sessions = fixture_sessions();
    let out = resolve(unknown, Some(&sessions), None, Some(&lookup));
    // Node asserts strict equality: exactly these five keys, nothing else.
    assert_eq!(
        matches_json(&out),
        serde_json::json!([{
            "provider": "opencode",
            "sessionId": unknown,
            "cwd": "/repo/beta",
            "sessionType": "opencode",
            "matchKind": "exact"
        }])
    );
}

#[test]
fn opencode_fallback_hit_without_directory_omits_cwd() {
    // Legacy-schema hits carry `cwd: None`, and Node's `row.cwd || undefined`
    // ALSO drops empty strings: both must OMIT `cwd` entirely on the wire —
    // never `"cwd": null` or `"cwd": ""`. Same rule for `title`.
    let unknown = "ses_legacy00000000000000000000";
    for cwd in [None, Some(String::new())] {
        let cwd_case = cwd.clone();
        let lookup = move |id: &str| -> Result<Option<OpencodeByIdHit>, ProviderFailure> {
            assert_eq!(id, unknown);
            Ok(Some(OpencodeByIdHit {
                session_id: id.to_string(),
                cwd: cwd_case.clone(),
                title: Some(String::new()), // Node: `row.title || undefined`
                last_activity_at: None,
            }))
        };
        let sessions = fixture_sessions();
        let out = resolve(unknown, Some(&sessions), None, Some(&lookup));
        assert_eq!(
            matches_json(&out),
            serde_json::json!([{
                "provider": "opencode",
                "sessionId": unknown,
                "sessionType": "opencode",
                "matchKind": "exact"
            }]),
            "cwd case {cwd:?}"
        );
    }
}

#[test]
fn claude_transcript_fallback_on_exact_id_index_miss() {
    let locate = |id: &str| -> Result<Option<ClaudeTranscriptHit>, ProviderFailure> {
        Ok(Some(ClaudeTranscriptHit {
            session_id: id.to_string(),
            cwd: Some("/repo/gamma".to_string()),
        }))
    };
    let sessions = fixture_sessions();
    let out = resolve(OTHER_UUID, Some(&sessions), Some(&locate), None);
    assert_eq!(
        matches_json(&out),
        serde_json::json!([{
            "provider": "claude",
            "sessionId": OTHER_UUID,
            "cwd": "/repo/gamma",
            "sessionType": "claude",
            "matchKind": "exact"
        }])
    );
}

#[test]
fn fallbacks_are_not_consulted_on_an_exact_index_hit() {
    // Hardened per-token order is exact → fallback → prefix: an EXACT index
    // hit short-circuits before the fallbacks run (fallbacks only cover
    // sessions the index cannot see).
    let locate = |_id: &str| -> Result<Option<ClaudeTranscriptHit>, ProviderFailure> {
        panic!("locate_claude_transcript must not run on an exact index hit")
    };
    let sessions = fixture_sessions();
    let out = resolve(CLAUDE_ID, Some(&sessions), Some(&locate), None);
    assert_eq!(out.matches.len(), 1);
}

#[test]
fn exact_id_fallback_beats_a_prefix_match_on_the_same_token() {
    // Wire-shape variant of Node #11: an unindexed session whose id EQUALS
    // the token must beat an indexed session whose id merely BEGINS with it.
    let sessions = vec![session_in(
        "claude",
        &format!("{OTHER_UUID}-extra"),
        "/repo/alpha",
        400,
    )];
    let locate = |id: &str| -> Result<Option<ClaudeTranscriptHit>, ProviderFailure> {
        Ok(Some(ClaudeTranscriptHit {
            session_id: id.to_string(),
            cwd: Some("/repo/gamma".to_string()),
        }))
    };
    let out = resolve(OTHER_UUID, Some(&sessions), Some(&locate), None);
    assert_eq!(
        matches_json(&out),
        serde_json::json!([{
            "provider": "claude",
            "sessionId": OTHER_UUID,
            "cwd": "/repo/gamma",
            "sessionType": "claude",
            "matchKind": "exact"
        }])
    );
}

#[test]
fn prefix_still_resolves_when_the_fallback_misses() {
    // Fallbacks run before prefix, but a fallback MISS falls through to
    // prefix discovery on the same token.
    let indexed_id = format!("{OTHER_UUID}-extra");
    let sessions = vec![session_in("claude", &indexed_id, "/repo/alpha", 400)];
    let locate = |_id: &str| -> Result<Option<ClaudeTranscriptHit>, ProviderFailure> { Ok(None) };
    let out = resolve(OTHER_UUID, Some(&sessions), Some(&locate), None);
    assert_eq!(out.matches[0].session_id, indexed_id);
    assert_eq!(out.matches[0].match_kind, ResumeMatchKind::Prefix);
}

#[test]
fn prefix_discovery_excludes_subagent_sessions_among_top_level_matches() {
    // Multi-session variant of Node #10: the subagent child is filtered while
    // the top-level prefix matches still return, most-recent first.
    let mut sessions = fixture_sessions();
    let mut child = session_in(
        "amplifier",
        "417e8345-cccc-4ddd-8eee-000000000003",
        "/repo/beta",
        950,
    );
    child.is_subagent = true;
    sessions.push(child);
    let out = resolve("417e8345", Some(&sessions), None, None);
    let ids: Vec<&str> = out.matches.iter().map(|m| m.session_id.as_str()).collect();
    assert_eq!(ids, vec![AMP_ID_NEW, AMP_ID_OLD]);
}

#[test]
fn exact_index_match_still_reaches_subagent_sessions() {
    // The asymmetry is the point: an exact pasted id must resolve even for
    // hidden subagent children — only PREFIX discovery filters them.
    let subagent_id = "417e8345-cccc-4ddd-8eee-000000000003";
    let mut sessions = fixture_sessions();
    let mut child = session_in("amplifier", subagent_id, "/repo/beta", 950);
    child.is_subagent = true;
    sessions.push(child);
    let out = resolve(subagent_id, Some(&sessions), None, None);
    assert_eq!(out.matches.len(), 1);
    assert_eq!(out.matches[0].session_id, subagent_id);
    assert_eq!(out.matches[0].match_kind, ResumeMatchKind::Exact);
}

#[test]
fn uuid_matching_is_case_insensitive_but_returns_stored_ids() {
    // uuid/hex tokens (hex digits + dashes only) match case-insensitively —
    // Node's `isCaseInsensitiveToken` — and the STORED id is returned.
    let sessions = fixture_sessions();
    let out = resolve(&CLAUDE_ID.to_uppercase(), Some(&sessions), None, None);
    assert_eq!(out.matches[0].session_id, CLAUDE_ID);
    assert_eq!(out.matches[0].match_kind, ResumeMatchKind::Exact);
}

#[test]
fn ses_id_matching_is_case_sensitive() {
    // ses_ + base62: upper/lower case are DISTINCT values, so case-folding
    // could resolve the WRONG session. A wrong-case ses_ id must NOT match —
    // neither exact nor prefix — while the correctly-cased id still resolves.
    let sessions = fixture_sessions();
    let out = resolve(
        "ses_ROOT0000000000000000000000",
        Some(&sessions),
        None,
        None,
    );
    assert_eq!(out.status, ResumeResolveStatus::Ready);
    assert!(out.matches.is_empty());
    let out = resolve(SES_ID, Some(&sessions), None, None);
    assert_eq!(out.matches[0].session_id, SES_ID);
    assert_eq!(out.matches[0].match_kind, ResumeMatchKind::Exact);
}

#[test]
fn wrong_length_ses_token_never_reaches_the_opencode_fallback() {
    // Node's fallback gate is the FULL-id shape `^ses_[0-9a-zA-Z]{26}$`
    // (`FALLBACK_ID_SHAPES`, `resolve-fallbacks.ts`), NOT the parser's looser
    // 8..=64 `xxx_` family shape. Load-bearing on a legacy-schema opencode
    // DB, where the by-id lookup answers a universal HIT for any id it is
    // asked about: an ungated wrong-length token would yield a FALSE exact
    // hit (Node: miss, zero work).
    let lookup = |_id: &str| -> Result<Option<OpencodeByIdHit>, ProviderFailure> {
        panic!("opencode fallback must not run for a wrong-length ses_ token")
    };
    let sessions = fixture_sessions();
    for wrong_length in [
        "ses_short0000", // 9 base62 chars: parser candidate, not a full id
        "ses_toolong000000000000000000000x", // 29 base62 chars
        "ses_wrongchar000000000000000-", // 26 chars but '-' is not base62
    ] {
        let out = resolve(wrong_length, Some(&sessions), None, Some(&lookup));
        assert_eq!(
            out.status,
            ResumeResolveStatus::Ready,
            "input {wrong_length:?}"
        );
        assert!(out.matches.is_empty(), "input {wrong_length:?}");
    }
}

#[test]
fn claude_fallback_gate_is_the_full_uuid_shape_in_any_case() {
    // Node's claude gate `^[0-9a-fA-F]{8}-…-[0-9a-fA-F]{12}$` accepts a full
    // UUID in ANY hex case…
    let upper = "AAAAAAAA-1111-4222-8333-444444444444";
    let locate = |id: &str| -> Result<Option<ClaudeTranscriptHit>, ProviderFailure> {
        Ok(Some(ClaudeTranscriptHit {
            session_id: id.to_ascii_lowercase(),
            cwd: Some("/repo/gamma".to_string()),
        }))
    };
    let sessions = fixture_sessions();
    let out = resolve(upper, Some(&sessions), Some(&locate), None);
    assert_eq!(out.matches[0].session_id, upper.to_ascii_lowercase());
    // …and NOTHING shorter: a bare hex-prefix token must never invoke it.
    let panicking = |_id: &str| -> Result<Option<ClaudeTranscriptHit>, ProviderFailure> {
        panic!("claude fallback must not run for a non-full-uuid token")
    };
    let out = resolve(
        "aaaaaaaa11114222833344444444",
        Some(&sessions),
        Some(&panicking),
        None,
    );
    assert!(out.matches.is_empty());
}

#[test]
fn third_fallback_requiring_token_is_budget_gated_like_node() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    // Node's FALLBACK_BUDGET_PER_REQUEST = 2 (`resolve-fallbacks.ts`): the
    // first two well-shaped ses_ tokens consume the opencode budget with
    // real (missing) lookups; the THIRD would resolve, but must not even be
    // looked up — Node answers not-found here, and so must the port. The
    // budget is consumed by the invocation itself, hit or miss.
    let third = "ses_third00000000000000000000d";
    let calls = AtomicUsize::new(0);
    let lookup = |id: &str| -> Result<Option<OpencodeByIdHit>, ProviderFailure> {
        calls.fetch_add(1, Ordering::SeqCst);
        if id == third {
            Ok(Some(OpencodeByIdHit {
                session_id: id.to_string(),
                cwd: Some("/repo/x".to_string()),
                title: None,
                last_activity_at: None,
            }))
        } else {
            Ok(None)
        }
    };
    let sessions = fixture_sessions();
    let input = format!("ses_first00000000000000000000a ses_second0000000000000000000b {third}");
    let out = resolve(&input, Some(&sessions), None, Some(&lookup));
    assert_eq!(out.status, ResumeResolveStatus::Ready);
    assert!(out.matches.is_empty());
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "budget caps real lookups at 2"
    );
}

#[test]
fn shape_gated_tokens_do_not_consume_the_fallback_budget() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    // Node checks shape FIRST, budget SECOND ("order is load-bearing",
    // `resolve-fallbacks.ts`): wrong-shape tokens ahead of the real id are
    // free no-ops, so the valid third token still gets its real lookup.
    let valid = "ses_valid00000000000000000000c";
    let calls = AtomicUsize::new(0);
    let lookup = |id: &str| -> Result<Option<OpencodeByIdHit>, ProviderFailure> {
        calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(id, valid, "only the full-shape id may reach the lookup");
        Ok(Some(OpencodeByIdHit {
            session_id: id.to_string(),
            cwd: Some("/repo/x".to_string()),
            title: None,
            last_activity_at: None,
        }))
    };
    let sessions = fixture_sessions();
    let input = format!("ses_short0000 ses_short1111 {valid}");
    let out = resolve(&input, Some(&sessions), None, Some(&lookup));
    assert_eq!(out.matches[0].session_id, valid);
    assert_eq!(out.matches[0].match_kind, ResumeMatchKind::Exact);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn fallback_budgets_are_tracked_per_provider() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    // Node's `withRequestBudget` keeps a SEPARATE `used` counter per fallback
    // key: two opencode lookups must not exhaust the claude budget (or vice
    // versa). Parser priority runs prefixed-id tokens before the uuid, so the
    // two ses_ misses happen first.
    let opencode_calls = AtomicUsize::new(0);
    let lookup = |_id: &str| -> Result<Option<OpencodeByIdHit>, ProviderFailure> {
        opencode_calls.fetch_add(1, Ordering::SeqCst);
        Ok(None)
    };
    let locate = |id: &str| -> Result<Option<ClaudeTranscriptHit>, ProviderFailure> {
        Ok(Some(ClaudeTranscriptHit {
            session_id: id.to_string(),
            cwd: Some("/repo/gamma".to_string()),
        }))
    };
    let sessions = fixture_sessions();
    let input =
        format!("ses_first00000000000000000000a ses_second0000000000000000000b {OTHER_UUID}");
    let out = resolve(&input, Some(&sessions), Some(&locate), Some(&lookup));
    assert_eq!(opencode_calls.load(Ordering::SeqCst), 2);
    assert_eq!(out.matches[0].provider, "claude");
    assert_eq!(out.matches[0].session_id, OTHER_UUID);
    assert_eq!(out.matches[0].match_kind, ResumeMatchKind::Exact);
}
