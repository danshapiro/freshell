//! SYNC-06 resolve-core parity tests — mirrors the MATCHING-SEMANTICS subset
//! of the Node integration suite
//! `test/integration/server/sessions-resolve-router.test.ts` (exact→fallback→
//! prefix ordering, case gating, subagent exclusion, cap, dedupe, warming,
//! fallbacks) at the logic level, plus wire-shape pins the Node suite leaves
//! implicit (camelCase field names, omitted optionals, hint null). The Node
//! suite's `degraded`/`providerErrors`/`unsearchedProviders`/`homeDir`
//! coverage is NOT mirrored here — that response surface is deferred to
//! `docs/plans/2026-07-30-rust-resolve-parity-hardened.md` Tasks 3, 5, 6.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};

use freshell_sessions::directory_index::IndexedSession;
use freshell_sessions::parse::OpencodeSessionDirectory;
use freshell_sessions::resume_resolve::{
    resolve_resume_input, ClaudeTranscriptHit, ResolveDeps, ResumeResolveResponse,
    RESOLVE_MATCH_CAP,
};

const CLAUDE_ID: &str = "ed2afda6-a340-443e-ba60-024a1b3554b4";
const CODEX_ID: &str = "019fac27-69d7-78a0-b972-b339d551042e";
const OPENCODE_ID: &str = "ses_root0000000000000000000000";
const AMP_ID_NEW: &str = "417e8345-aaaa-4bbb-8ccc-000000000001";
const AMP_ID_OLD: &str = "417e8345-bbbb-4ccc-8ddd-000000000002";

fn session(provider: &str, id: &str, project: &str, last_activity_at: i64) -> IndexedSession {
    IndexedSession {
        session_id: id.to_string(),
        provider: provider.to_string(),
        project_path: project.to_string(),
        title: None,
        summary: None,
        first_user_message: None,
        last_activity_at,
        created_at: None,
        cwd: Some(project.to_string()),
        is_subagent: false,
        is_non_interactive: false,
        source_file: None,
    }
}

/// The Node suite's fixtureProjects(), flattened.
fn fixture_sessions() -> Vec<IndexedSession> {
    let mut claude = session("claude", CLAUDE_ID, "/repo/alpha", 400);
    claude.title = Some("Fix the parser".to_string());
    claude.first_user_message = Some("fix the parser".to_string());
    vec![
        claude,
        session("codex", CODEX_ID, "/repo/alpha", 300),
        session("opencode", OPENCODE_ID, "/repo/beta", 200),
        session("amplifier", AMP_ID_NEW, "/repo/beta", 900),
        session("amplifier", AMP_ID_OLD, "/repo/beta", 100),
    ]
}

fn no_types() -> HashMap<String, String> {
    HashMap::new()
}

fn resolve(input: &str, sessions: &[IndexedSession]) -> ResumeResolveResponse {
    let types = no_types();
    resolve_resume_input(
        input,
        &ResolveDeps {
            sessions: Some(sessions),
            session_types: &types,
            opencode_dir_by_id: None,
            locate_claude_transcript: None,
        },
    )
}

fn as_json(response: &ResumeResolveResponse) -> serde_json::Value {
    serde_json::to_value(response).expect("serialize response")
}

#[test]
fn exact_uuid_resolves_to_single_exact_match() {
    let sessions = fixture_sessions();
    for (input, provider, id) in [
        (CLAUDE_ID.to_string(), "claude", CLAUDE_ID),
        (format!("codex resume {CODEX_ID}"), "codex", CODEX_ID),
        (
            format!("opencode --session {OPENCODE_ID}"),
            "opencode",
            OPENCODE_ID,
        ),
    ] {
        let body = as_json(&resolve(&input, &sessions));
        assert_eq!(body["status"], "ready", "input {input:?}");
        assert_eq!(
            body["matches"].as_array().unwrap().len(),
            1,
            "input {input:?}"
        );
        assert_eq!(body["matches"][0]["provider"], provider);
        assert_eq!(body["matches"][0]["sessionId"], id);
        assert_eq!(body["matches"][0]["matchKind"], "exact");
    }
}

#[test]
fn match_carries_full_resume_metadata() {
    let body = as_json(&resolve(CLAUDE_ID, &fixture_sessions()));
    let m = &body["matches"][0];
    assert_eq!(m["provider"], "claude");
    assert_eq!(m["sessionId"], CLAUDE_ID);
    assert_eq!(m["cwd"], "/repo/alpha");
    assert_eq!(m["title"], "Fix the parser");
    assert_eq!(m["firstUserMessage"], "fix the parser");
    assert_eq!(m["lastActivityAt"], 400);
    // No metadata-store overlay entry: sessionType defaults to the provider —
    // hardened Node's `toMatch` emits `sessionType ?? provider`, never absent.
    assert_eq!(m["sessionType"], "claude");
}

#[test]
fn session_type_overlays_from_metadata_map() {
    let sessions = fixture_sessions();
    let mut types = HashMap::new();
    types.insert(format!("claude:{CLAUDE_ID}"), "freshclaude".to_string());
    let response = resolve_resume_input(
        CLAUDE_ID,
        &ResolveDeps {
            sessions: Some(&sessions),
            session_types: &types,
            opencode_dir_by_id: None,
            locate_claude_transcript: None,
        },
    );
    let body = as_json(&response);
    assert_eq!(body["matches"][0]["sessionType"], "freshclaude");
}

#[test]
fn prefix_matches_short_hex_most_recent_first() {
    let body = as_json(&resolve("417e8345", &fixture_sessions()));
    assert_eq!(body["status"], "ready");
    let ids: Vec<&str> = body["matches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["sessionId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![AMP_ID_NEW, AMP_ID_OLD]);
    assert_eq!(body["matches"][0]["matchKind"], "prefix");
    assert_eq!(body["matches"][0]["provider"], "amplifier");
}

#[test]
fn caps_ambiguous_prefix_matches_at_20() {
    let many: Vec<IndexedSession> = (0..25)
        .map(|i| {
            session(
                "amplifier",
                &format!("417e8345-0000-4000-8000-{i:012}"),
                "/repo/many",
                i,
            )
        })
        .collect();
    let body = as_json(&resolve("417e8345", &many));
    assert_eq!(body["matches"].as_array().unwrap().len(), RESOLVE_MATCH_CAP);
    assert_eq!(body["matches"][0]["lastActivityAt"], 24); // most recent first
}

#[test]
fn dedupes_duplicate_provider_session_id_keeping_most_recent() {
    let mut older = session("claude", CLAUDE_ID, "/repo/alpha", 100);
    older.title = Some("older file".to_string());
    let mut newer = session("claude", CLAUDE_ID, "/repo/alpha", 500);
    newer.title = Some("newer file".to_string());
    let body = as_json(&resolve(CLAUDE_ID, &[older, newer]));
    assert_eq!(body["matches"].as_array().unwrap().len(), 1);
    assert_eq!(body["matches"][0]["title"], "newer file");
    assert_eq!(body["matches"][0]["lastActivityAt"], 500);
}

#[test]
fn reports_hint_alongside_evidence() {
    let body = as_json(&resolve(
        &format!("codex resume {CODEX_ID}"),
        &fixture_sessions(),
    ));
    assert_eq!(
        body["hint"],
        serde_json::json!({ "provider": "codex", "source": "command" })
    );
}

#[test]
fn unknown_id_is_ready_with_empty_matches() {
    let body = as_json(&resolve(
        "019fffff-ffff-7fff-bfff-ffffffffffff",
        &fixture_sessions(),
    ));
    assert_eq!(body["status"], "ready");
    assert_eq!(body["matches"], serde_json::json!([]));
}

#[test]
fn warming_when_no_snapshot_with_hint_and_empty_matches() {
    let types = no_types();
    let response = resolve_resume_input(
        &format!("claude --resume {CLAUDE_ID}"),
        &ResolveDeps {
            sessions: None,
            session_types: &types,
            opencode_dir_by_id: None,
            locate_claude_transcript: None,
        },
    );
    assert_eq!(
        as_json(&response),
        serde_json::json!({
            "status": "warming",
            "matches": [],
            "hint": { "provider": "claude", "source": "command" }
        })
    );
}

#[test]
fn opencode_by_id_fallback_uses_row_directory_as_cwd() {
    let unknown = "ses_child000000000000000000000";
    let lookup = |id: &str| {
        assert_eq!(id, unknown);
        Some(OpencodeSessionDirectory {
            directory: Some("/repo/beta".to_string()),
        })
    };
    let types = no_types();
    let sessions = fixture_sessions();
    let response = resolve_resume_input(
        unknown,
        &ResolveDeps {
            sessions: Some(&sessions),
            session_types: &types,
            opencode_dir_by_id: Some(&lookup),
            locate_claude_transcript: None,
        },
    );
    // Node asserts strict equality: exactly these five keys, nothing else.
    assert_eq!(
        as_json(&response)["matches"],
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
    // Legacy-schema and empty-string-directory walk hits carry
    // `directory: None` (Task 3): the wire match must OMIT `cwd` entirely —
    // matching Node, where `cwd: undefined` is dropped by `res.json` — not
    // emit `"cwd": null` or `"cwd": ""`.
    let unknown = "ses_legacy00000000000000000000";
    let lookup = |id: &str| {
        assert_eq!(id, unknown);
        Some(OpencodeSessionDirectory { directory: None })
    };
    let types = no_types();
    let sessions = fixture_sessions();
    let response = resolve_resume_input(
        unknown,
        &ResolveDeps {
            sessions: Some(&sessions),
            session_types: &types,
            opencode_dir_by_id: Some(&lookup),
            locate_claude_transcript: None,
        },
    );
    assert_eq!(
        as_json(&response)["matches"],
        serde_json::json!([{
            "provider": "opencode",
            "sessionId": unknown,
            "sessionType": "opencode",
            "matchKind": "exact"
        }])
    );
}

#[test]
fn claude_transcript_fallback_on_exact_id_index_miss() {
    let unknown = "aaaaaaaa-1111-4222-8333-444444444444";
    let locate = |id: &str| {
        Some(ClaudeTranscriptHit {
            session_id: id.to_string(),
            cwd: Some("/repo/gamma".to_string()),
        })
    };
    let types = no_types();
    let sessions = fixture_sessions();
    let response = resolve_resume_input(
        unknown,
        &ResolveDeps {
            sessions: Some(&sessions),
            session_types: &types,
            opencode_dir_by_id: None,
            locate_claude_transcript: Some(&locate),
        },
    );
    assert_eq!(
        as_json(&response)["matches"],
        serde_json::json!([{
            "provider": "claude",
            "sessionId": unknown,
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
    let locate = |_id: &str| -> Option<ClaudeTranscriptHit> {
        panic!("locate_claude_transcript must not run on an exact index hit")
    };
    let types = no_types();
    let sessions = fixture_sessions();
    let response = resolve_resume_input(
        CLAUDE_ID,
        &ResolveDeps {
            sessions: Some(&sessions),
            session_types: &types,
            opencode_dir_by_id: None,
            locate_claude_transcript: Some(&locate),
        },
    );
    assert_eq!(as_json(&response)["matches"].as_array().unwrap().len(), 1);
}

#[test]
fn exact_id_fallback_beats_a_prefix_match_on_the_same_token() {
    // Hardened ordering: PER TOKEN, exact-id fallbacks run BEFORE prefix
    // matching — an unindexed session whose id EQUALS the token must beat an
    // indexed session whose id merely BEGINS with it, or the wrong session
    // gets resumed. (The retired pre-#586 ordering ran ALL index passes —
    // prefix included — before any fallback.)
    let token = "aaaaaaaa-1111-4222-8333-444444444444";
    // Indexed session whose id starts with the token but is NOT equal to it.
    let sessions = vec![session(
        "claude",
        &format!("{token}-extra"),
        "/repo/alpha",
        400,
    )];
    let locate = |id: &str| {
        Some(ClaudeTranscriptHit {
            session_id: id.to_string(),
            cwd: Some("/repo/gamma".to_string()),
        })
    };
    let types = no_types();
    let response = resolve_resume_input(
        token,
        &ResolveDeps {
            sessions: Some(&sessions),
            session_types: &types,
            opencode_dir_by_id: None,
            locate_claude_transcript: Some(&locate),
        },
    );
    assert_eq!(
        as_json(&response)["matches"],
        serde_json::json!([{
            "provider": "claude",
            "sessionId": token,
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
    let token = "aaaaaaaa-1111-4222-8333-444444444444";
    let indexed_id = format!("{token}-extra");
    let sessions = vec![session("claude", &indexed_id, "/repo/alpha", 400)];
    let locate = |_id: &str| -> Option<ClaudeTranscriptHit> { None };
    let types = no_types();
    let response = resolve_resume_input(
        token,
        &ResolveDeps {
            sessions: Some(&sessions),
            session_types: &types,
            opencode_dir_by_id: None,
            locate_claude_transcript: Some(&locate),
        },
    );
    let body = as_json(&response);
    assert_eq!(body["matches"][0]["sessionId"], indexed_id.as_str());
    assert_eq!(body["matches"][0]["matchKind"], "prefix");
}

#[test]
fn prefix_discovery_excludes_subagent_sessions() {
    // Hardened prefix DISCOVERY is top-level-only (`!isSubagent`): surfacing
    // hidden subagent children for partial ids would flood disambiguation
    // with noise.
    let mut sessions = fixture_sessions();
    let mut child = session(
        "amplifier",
        "417e8345-cccc-4ddd-8eee-000000000003",
        "/repo/beta",
        950,
    );
    child.is_subagent = true;
    sessions.push(child);
    let body = as_json(&resolve("417e8345", &sessions));
    let ids: Vec<&str> = body["matches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["sessionId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![AMP_ID_NEW, AMP_ID_OLD]);
}

#[test]
fn exact_index_match_still_reaches_subagent_sessions() {
    // The asymmetry is the point: an exact pasted id must resolve even for
    // hidden subagent children — only PREFIX discovery filters them.
    let subagent_id = "417e8345-cccc-4ddd-8eee-000000000003";
    let mut sessions = fixture_sessions();
    let mut child = session("amplifier", subagent_id, "/repo/beta", 950);
    child.is_subagent = true;
    sessions.push(child);
    let body = as_json(&resolve(subagent_id, &sessions));
    assert_eq!(body["matches"].as_array().unwrap().len(), 1);
    assert_eq!(body["matches"][0]["sessionId"], subagent_id);
    assert_eq!(body["matches"][0]["matchKind"], "exact");
}

#[test]
fn garbage_input_is_ready_empty_with_null_hint() {
    let response = resolve("hello decade facade!!", &fixture_sessions());
    assert_eq!(
        as_json(&response),
        serde_json::json!({ "status": "ready", "matches": [], "hint": null })
    );
}

#[test]
fn uuid_matching_is_case_insensitive_but_returns_stored_ids() {
    // uuid/hex tokens (hex digits + dashes only) match case-insensitively —
    // Node's `isCaseInsensitiveToken`.
    let body = as_json(&resolve(&CLAUDE_ID.to_uppercase(), &fixture_sessions()));
    assert_eq!(body["matches"][0]["sessionId"], CLAUDE_ID);
    assert_eq!(body["matches"][0]["matchKind"], "exact");
}

#[test]
fn wrong_length_ses_token_never_reaches_the_opencode_fallback() {
    // Node's fallback gate is the FULL-id shape `^ses_[0-9a-zA-Z]{26}$`
    // (`FALLBACK_ID_SHAPES`, `resolve-fallbacks.ts`), NOT the parser's looser
    // 8..=64 `xxx_` family shape. Load-bearing on a legacy-schema opencode
    // DB, where the by-id lookup answers a universal HIT for any id it is
    // asked about: an ungated wrong-length token would yield a FALSE exact
    // hit (Node: miss, zero work).
    let lookup = |_id: &str| -> Option<OpencodeSessionDirectory> {
        panic!("opencode fallback must not run for a wrong-length ses_ token")
    };
    let types = no_types();
    let sessions = fixture_sessions();
    for wrong_length in [
        "ses_short0000", // 9 base62 chars: parser candidate, not a full id
        "ses_toolong000000000000000000000x", // 29 base62 chars
        "ses_wrongchar000000000000000-", // 26 chars but '-' is not base62
    ] {
        let response = resolve_resume_input(
            wrong_length,
            &ResolveDeps {
                sessions: Some(&sessions),
                session_types: &types,
                opencode_dir_by_id: Some(&lookup),
                locate_claude_transcript: None,
            },
        );
        let body = as_json(&response);
        assert_eq!(body["status"], "ready", "input {wrong_length:?}");
        assert_eq!(
            body["matches"],
            serde_json::json!([]),
            "input {wrong_length:?}"
        );
    }
}

#[test]
fn claude_fallback_gate_is_the_full_uuid_shape_in_any_case() {
    // Node's claude gate `^[0-9a-fA-F]{8}-…-[0-9a-fA-F]{12}$` accepts a full
    // UUID in ANY hex case…
    let upper = "AAAAAAAA-1111-4222-8333-444444444444";
    let locate = |id: &str| {
        Some(ClaudeTranscriptHit {
            session_id: id.to_ascii_lowercase(),
            cwd: Some("/repo/gamma".to_string()),
        })
    };
    let types = no_types();
    let sessions = fixture_sessions();
    let response = resolve_resume_input(
        upper,
        &ResolveDeps {
            sessions: Some(&sessions),
            session_types: &types,
            opencode_dir_by_id: None,
            locate_claude_transcript: Some(&locate),
        },
    );
    assert_eq!(
        as_json(&response)["matches"][0]["sessionId"],
        upper.to_ascii_lowercase()
    );
    // …and NOTHING shorter: a bare hex-prefix token must never invoke it.
    let panicking = |_id: &str| -> Option<ClaudeTranscriptHit> {
        panic!("claude fallback must not run for a non-full-uuid token")
    };
    let response = resolve_resume_input(
        "aaaaaaaa11114222833344444444",
        &ResolveDeps {
            sessions: Some(&sessions),
            session_types: &types,
            opencode_dir_by_id: None,
            locate_claude_transcript: Some(&panicking),
        },
    );
    assert_eq!(as_json(&response)["matches"], serde_json::json!([]));
}

#[test]
fn third_fallback_requiring_token_is_budget_gated_like_node() {
    // Node's FALLBACK_BUDGET_PER_REQUEST = 2 (`resolve-fallbacks.ts`): the
    // first two well-shaped ses_ tokens consume the opencode budget with
    // real (missing) lookups; the THIRD would resolve, but must not even be
    // looked up — Node answers not-found here, and so must the port. The
    // budget is consumed by the invocation itself, hit or miss.
    let third = "ses_third00000000000000000000d";
    let calls = AtomicUsize::new(0);
    let lookup = |id: &str| {
        calls.fetch_add(1, Ordering::SeqCst);
        if id == third {
            Some(OpencodeSessionDirectory {
                directory: Some("/repo/x".to_string()),
            })
        } else {
            None
        }
    };
    let types = no_types();
    let sessions = fixture_sessions();
    let input = format!("ses_first00000000000000000000a ses_second0000000000000000000b {third}");
    let response = resolve_resume_input(
        &input,
        &ResolveDeps {
            sessions: Some(&sessions),
            session_types: &types,
            opencode_dir_by_id: Some(&lookup),
            locate_claude_transcript: None,
        },
    );
    let body = as_json(&response);
    assert_eq!(body["status"], "ready");
    assert_eq!(body["matches"], serde_json::json!([]));
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "budget caps real lookups at 2"
    );
}

#[test]
fn shape_gated_tokens_do_not_consume_the_fallback_budget() {
    // Node checks shape FIRST, budget SECOND ("order is load-bearing",
    // `resolve-fallbacks.ts`): wrong-shape tokens ahead of the real id are
    // free no-ops, so the valid third token still gets its real lookup.
    let valid = "ses_valid00000000000000000000c";
    let calls = AtomicUsize::new(0);
    let lookup = |id: &str| {
        calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(id, valid, "only the full-shape id may reach the lookup");
        Some(OpencodeSessionDirectory {
            directory: Some("/repo/x".to_string()),
        })
    };
    let types = no_types();
    let sessions = fixture_sessions();
    let input = format!("ses_short0000 ses_short1111 {valid}");
    let response = resolve_resume_input(
        &input,
        &ResolveDeps {
            sessions: Some(&sessions),
            session_types: &types,
            opencode_dir_by_id: Some(&lookup),
            locate_claude_transcript: None,
        },
    );
    let body = as_json(&response);
    assert_eq!(body["matches"][0]["sessionId"], valid);
    assert_eq!(body["matches"][0]["matchKind"], "exact");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn fallback_budgets_are_tracked_per_provider() {
    // Node's `withRequestBudget` keeps a SEPARATE `used` counter per fallback
    // key: two opencode lookups must not exhaust the claude budget (or vice
    // versa). Parser priority runs prefixed-id tokens before the uuid, so the
    // two ses_ misses happen first.
    let uuid = "aaaaaaaa-1111-4222-8333-444444444444";
    let opencode_calls = AtomicUsize::new(0);
    let lookup = |_id: &str| -> Option<OpencodeSessionDirectory> {
        opencode_calls.fetch_add(1, Ordering::SeqCst);
        None
    };
    let locate = |id: &str| {
        Some(ClaudeTranscriptHit {
            session_id: id.to_string(),
            cwd: Some("/repo/gamma".to_string()),
        })
    };
    let types = no_types();
    let sessions = fixture_sessions();
    let input = format!("ses_first00000000000000000000a ses_second0000000000000000000b {uuid}");
    let response = resolve_resume_input(
        &input,
        &ResolveDeps {
            sessions: Some(&sessions),
            session_types: &types,
            opencode_dir_by_id: Some(&lookup),
            locate_claude_transcript: Some(&locate),
        },
    );
    let body = as_json(&response);
    assert_eq!(opencode_calls.load(Ordering::SeqCst), 2);
    assert_eq!(body["matches"][0]["provider"], "claude");
    assert_eq!(body["matches"][0]["sessionId"], uuid);
    assert_eq!(body["matches"][0]["matchKind"], "exact");
}

#[test]
fn ses_id_matching_is_case_sensitive() {
    // ses_ + base62: upper/lower case are DISTINCT values, so case-folding
    // could resolve the WRONG session. A wrong-case ses_ id must NOT match —
    // neither exact nor prefix.
    let wrong_case = "ses_ROOT0000000000000000000000";
    let body = as_json(&resolve(wrong_case, &fixture_sessions()));
    assert_eq!(body["status"], "ready");
    assert_eq!(body["matches"], serde_json::json!([]));
    // The correctly-cased id still resolves exactly.
    let body = as_json(&resolve(OPENCODE_ID, &fixture_sessions()));
    assert_eq!(body["matches"][0]["sessionId"], OPENCODE_ID);
    assert_eq!(body["matches"][0]["matchKind"], "exact");
}
