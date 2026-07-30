//! SYNC-06 resolve-core parity tests — a 1:1 mirror of the Node integration
//! suite `test/integration/server/sessions-resolve-router.test.ts` (matching,
//! ordering, cap, dedupe, warming, fallbacks) at the logic level, plus
//! wire-shape pins the Node suite leaves implicit (camelCase field names,
//! omitted optionals, hint null).

use std::collections::HashMap;

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
    // sessionType absent (no metadata-store overlay entry): key OMITTED,
    // not null — the client and the Node contract treat undefined as omitted.
    assert!(m.get("sessionType").is_none());
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
fn fallbacks_are_not_consulted_when_the_index_matches() {
    // Node only reaches the fallback loop when EVERY candidate missed the index.
    let locate = |_id: &str| -> Option<ClaudeTranscriptHit> {
        panic!("locate_claude_transcript must not run on an index hit")
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
fn garbage_input_is_ready_empty_with_null_hint() {
    let response = resolve("hello decade facade!!", &fixture_sessions());
    assert_eq!(
        as_json(&response),
        serde_json::json!({ "status": "ready", "matches": [], "hint": null })
    );
}

#[test]
fn matching_is_case_insensitive_but_returns_stored_ids() {
    let body = as_json(&resolve(&CLAUDE_ID.to_uppercase(), &fixture_sessions()));
    assert_eq!(body["matches"][0]["sessionId"], CLAUDE_ID);
    assert_eq!(body["matches"][0]["matchKind"], "exact");
}
