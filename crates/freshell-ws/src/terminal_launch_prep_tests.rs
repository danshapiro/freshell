//! First direct unit tests for derive_launch_prep (it previously had only
//! indirect integration coverage). Pins the ORIGIN semantics of
//! LaunchPrep.resume_id_from_wire: true only for wire-derived resume ids,
//! false for BOTH server-prealloc arms (claude fresh prealloc AND the
//! amplifier launcher-assigned identity) and for mode == "shell".
use super::*;

fn create_from_json(v: serde_json::Value) -> TerminalCreate {
    serde_json::from_value(v).expect("valid TerminalCreate json")
}

#[test]
fn wire_session_ref_restore_is_from_wire() {
    let create = create_from_json(serde_json::json!({
        "requestId": "r-wire-ref",
        "mode": "codex",
        "shell": "system",
        "restore": true,
        "sessionRef": { "provider": "codex", "sessionId": "stale-codex-id" }
    }));
    let prep = derive_launch_prep(&create, "codex");
    assert!(
        prep.resume_id_from_wire,
        "sessionRef carrier is wire-originated"
    );
    assert_eq!(prep.resume_session_id.as_deref(), Some("stale-codex-id"));
    assert!(!prep.claude_fresh_prealloc);
    assert!(matches!(prep.launch_intent, LaunchIntent::Resume));
}

#[test]
fn wire_legacy_resume_session_id_is_from_wire() {
    let create = create_from_json(serde_json::json!({
        "requestId": "r-wire-legacy",
        "mode": "amplifier",
        "shell": "system",
        "restore": true,
        "resumeSessionId": "stale-amp-id"
    }));
    let prep = derive_launch_prep(&create, "amplifier");
    assert!(
        prep.resume_id_from_wire,
        "legacy resumeSessionId carrier is wire-originated"
    );
    assert_eq!(prep.resume_session_id.as_deref(), Some("stale-amp-id"));
}

#[test]
fn claude_fresh_prealloc_is_server_allocated_not_wire() {
    let create = create_from_json(serde_json::json!({
        "requestId": "r-claude-fresh",
        "mode": "claude",
        "shell": "system"
    }));
    let prep = derive_launch_prep(&create, "claude");
    assert!(prep.claude_fresh_prealloc);
    assert!(matches!(prep.launch_intent, LaunchIntent::Start));
    let minted = prep.resume_session_id.expect("prealloc mints a fresh id");
    uuid::Uuid::parse_str(&minted).expect("minted id is a uuid");
    assert!(
        !prep.resume_id_from_wire,
        "server-preallocated claude id must NEVER be gate-eligible"
    );
}

#[test]
fn amplifier_fresh_prealloc_is_server_allocated_not_wire() {
    // THE TRAP CASE: amplifier prealloc mints a server id while
    // claude_fresh_prealloc stays false — the flag must still be false.
    let create = create_from_json(serde_json::json!({
        "requestId": "r-amp-fresh",
        "mode": "amplifier",
        "shell": "system"
    }));
    let prep = derive_launch_prep(&create, "amplifier");
    assert!(!prep.claude_fresh_prealloc);
    assert!(matches!(prep.launch_intent, LaunchIntent::Resume));
    let minted = prep
        .resume_session_id
        .expect("amplifier prealloc mints a fresh id");
    uuid::Uuid::parse_str(&minted).expect("minted id is a uuid");
    assert!(
        !prep.resume_id_from_wire,
        "server-minted amplifier id must NEVER be gate-eligible"
    );
}

#[test]
fn shell_mode_is_never_from_wire() {
    let create = create_from_json(serde_json::json!({
        "requestId": "r-shell",
        "mode": "shell",
        "shell": "system"
    }));
    let prep = derive_launch_prep(&create, "shell");
    assert!(!prep.resume_id_from_wire);
    assert!(prep.resume_session_id.is_none());
}

// ===========================================================================
// SESSION-01 sidebar-click resume legs. A click on a History/sidebar row
// (`openSessionTab`, `src/store/tabsSlice.ts:569` → `buildResumeContent`,
// `src/lib/session-type-utils.ts:91`) carries the directory row's identity
// ONLY as `sessionRef {provider, sessionId}` (TerminalView.tsx:3125-3140) —
// NO `restore` flag, NO legacy `resumeSessionId`. The e2e
// `sidebar-click-resume.spec.ts` proves the argv landing for amplifier and
// codex; these legs pin the server-side derivation that EVERY terminal
// provider's click payload lands in `derive_launch_prep`'s resume arm — the
// shoulder Claude/OpenCode had no direct coverage for.
// ===========================================================================

/// For every indexed terminal provider, a mode-matching sidebar-click
/// sessionRef derives the row's session id as the wire-originated resume id
/// with Resume intent — never a server-prealloc (claude's fresh mint is
/// gated on ref PRESENCE, `ws-handler.ts:2134-2139`'s
/// `shouldPreallocateFreshClaudeSession`; amplifier's mint requires
/// `session_ref.is_none()`).
#[test]
fn sidebar_click_session_ref_derives_wire_resume_id_for_every_terminal_provider() {
    for (mode, session_id) in [
        ("claude", "ed2afda6-a340-443e-ba60-024a1b3554b4"),
        ("codex", "019fac27-69d7-78a0-b972-b339d551042e"),
        ("opencode", "ses_root0000000000000000000000"),
        ("amplifier", "417e8345-90ab-4cde-8f01-234567890abc"),
    ] {
        let create = create_from_json(serde_json::json!({
            "requestId": format!("r-click-{mode}"),
            "mode": mode,
            "shell": "system",
            "sessionRef": { "provider": mode, "sessionId": session_id }
        }));
        let prep = derive_launch_prep(&create, mode);
        assert_eq!(
            prep.resume_session_id.as_deref(),
            Some(session_id),
            "{mode}: the clicked row's sessionId IS the resume id"
        );
        assert!(
            prep.resume_id_from_wire,
            "{mode}: a sidebar-click sessionRef carrier is wire-originated"
        );
        assert!(
            matches!(prep.launch_intent, LaunchIntent::Resume),
            "{mode}: resume intent (amplifier's resumeArgs-only manifest REQUIRES it, golden G-A4)"
        );
        assert!(
            !prep.claude_fresh_prealloc,
            "{mode}: a click never mints a fresh claude identity"
        );
    }
}

/// The ref is MODE-GATED (`ws-handler.ts:2040-2047`:
/// `requestedSessionRef.provider === m.mode ? sessionRef.sessionId :
/// m.resumeSessionId`). A ref stamped for a DIFFERENT provider must not
/// steer the spawn: it is ignored, the legacy carrier is consulted, and —
/// matching legacy's `!requestedSessionRef` prealloc gate reading the RAW
/// ref — its mere presence still suppresses the claude fresh mint.
#[test]
fn session_ref_for_a_different_provider_does_not_steer_the_resume() {
    // No legacy carrier: the mismatched ref is ignored and NO resume id is
    // derived — but the raw ref still suppresses claude fresh prealloc
    // (legacy parity: prealloc requires `!requestedSessionRef`, raw shape).
    let create = create_from_json(serde_json::json!({
        "requestId": "r-mismatch",
        "mode": "claude",
        "shell": "system",
        "sessionRef": { "provider": "codex", "sessionId": "codex-id-1" }
    }));
    let prep = derive_launch_prep(&create, "claude");
    assert_eq!(prep.resume_session_id, None);
    assert!(!prep.claude_fresh_prealloc);
    assert!(matches!(prep.launch_intent, LaunchIntent::Resume));
    assert!(prep.resume_id_from_wire);

    // Legacy carrier present: it wins when the ref's provider mismatches.
    let create = create_from_json(serde_json::json!({
        "requestId": "r-mismatch-legacy",
        "mode": "claude",
        "shell": "system",
        "sessionRef": { "provider": "codex", "sessionId": "codex-id-1" },
        "resumeSessionId": "claude-legacy-id"
    }));
    let prep = derive_launch_prep(&create, "claude");
    assert_eq!(prep.resume_session_id.as_deref(), Some("claude-legacy-id"));
    assert!(prep.resume_id_from_wire);
}

/// Both carriers present and mode-matching: the structured sessionRef wins
/// over the legacy `resumeSessionId` (`ws-handler.ts:2040-2047`'s ternary),
/// not the other way around. (Amplifier, so codex's restore-plan layering
/// cannot confound the carrier-precedence pin.)
#[test]
fn session_ref_wins_over_the_legacy_resume_session_id_carrier() {
    let create = create_from_json(serde_json::json!({
        "requestId": "r-both-carriers",
        "mode": "amplifier",
        "shell": "system",
        "sessionRef": { "provider": "amplifier", "sessionId": "amp-ref-id" },
        "resumeSessionId": "amp-legacy-id"
    }));
    let prep = derive_launch_prep(&create, "amplifier");
    assert_eq!(prep.resume_session_id.as_deref(), Some("amp-ref-id"));
    assert!(prep.resume_id_from_wire);
    assert!(matches!(prep.launch_intent, LaunchIntent::Resume));
}
