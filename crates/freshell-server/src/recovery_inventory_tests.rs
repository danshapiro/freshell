//! Tests for the pure recovery-inventory builder (B3/P1.9 Task 1).

use super::*;
use freshell_protocol::SessionLocator;
use freshell_ws::pane_ledger::{
    BindingRow, BindingWrite, FreshAgentBindingWrite, PaneCloseKill, PaneCloseRecord,
    PaneDetachClose, PaneLedger, ProvenancePolicy, ProvenanceStamps, RetiredReason, RowState,
    LEDGER_VERSION,
};
use serde_json::json;
use std::collections::HashSet;

fn no_live() -> LiveEvidence {
    LiveEvidence {
        session_keys: HashSet::new(),
        terminal_ids: HashSet::new(),
    }
}

fn live(pairs: &[(&str, &str)]) -> LiveEvidence {
    LiveEvidence {
        session_keys: pairs
            .iter()
            .map(|(p, s)| (p.to_string(), s.to_string()))
            .collect(),
        terminal_ids: HashSet::new(),
    }
}

/// Focused-episode-6 round 5 (Finding F2): the shell half of the liveness
/// evidence — live TERMINAL ids only (a plain shell has no session identity
/// to claim through).
fn live_terminals(ids: &[&str]) -> LiveEvidence {
    LiveEvidence {
        session_keys: HashSet::new(),
        terminal_ids: ids.iter().map(|id| id.to_string()).collect(),
    }
}

/// Focused-episode-6 round 5 (Finding F2): add terminal-id evidence to an
/// existing set (the precedence pin combines both arms over the same pane).
fn with_terminals(mut ev: LiveEvidence, ids: &[&str]) -> LiveEvidence {
    ev.terminal_ids.extend(ids.iter().map(|id| id.to_string()));
    ev
}

fn union_doc(device: &str, captured_at: u64, panes: serde_json::Value) -> serde_json::Value {
    union_doc_with_tab_key(device, captured_at, "k1", panes)
}

/// Union fixture whose single record carries an explicit `tabKey` — the D8
/// placement clause (delta-r2 Finding 3) offers a kept row only when its
/// stamped tabKey names a tab in the offer's union, so kept-row fixtures and
/// the clause-isolating drop fixtures carry the row's key here.
fn union_doc_with_tab_key(
    device: &str,
    captured_at: u64,
    tab_key: &str,
    panes: serde_json::Value,
) -> serde_json::Value {
    json!({
        "deviceId": device, "deviceLabel": format!("label-{device}"), "capturedAt": captured_at,
        "records": [{ "tabKey": tab_key, "tabId": "t1", "tabName": "work", "revision": 1,
                      "updatedAt": captured_at, "paneCount": 1, "panes": panes }]
    })
}

/// (state, retired_reason, superseded_by) parts for constructing a `BindingRow`.
type StateParts = (RowState, Option<RetiredReason>, Option<SessionLocator>);

fn bound() -> StateParts {
    (RowState::Bound, None, None)
}

fn retired_closed() -> StateParts {
    (RowState::Retired, Some(RetiredReason::Closed), None)
}

fn retired_gc_expired() -> StateParts {
    (RowState::Retired, Some(RetiredReason::GcExpired), None)
}

fn retired_session_missing() -> StateParts {
    (RowState::Retired, Some(RetiredReason::SessionMissing), None)
}

fn retired_superseded_by(provider: &str, session_id: &str) -> StateParts {
    (
        RowState::Retired,
        Some(RetiredReason::Superseded),
        Some(SessionLocator {
            provider: provider.to_string(),
            session_id: session_id.to_string(),
        }),
    )
}

fn binding_row_at(
    provider: &str,
    session_id: &str,
    state_parts: StateParts,
    updated_at: i64,
) -> BindingRow {
    let (state, retired_reason, superseded_by) = state_parts;
    BindingRow {
        ledger_version: LEDGER_VERSION,
        provider: provider.to_string(),
        session_id: session_id.to_string(),
        mode: provider.to_string(),
        cwd: Some("/x".to_string()),
        live_terminal_id: None,
        create_request_id: None,
        created_at: 1000,
        updated_at,
        last_observed_at: updated_at,
        state,
        retired_reason,
        superseded_by,
        pane_kind: None,
        model: None,
        sandbox: None,
        permission_mode: None,
        effort: None,
        // D8 provenance: fixtures default to unattributed (pre-upgrade shape);
        // Task 3's judgment-matrix fixtures name them explicitly.
        client_instance_id: None,
        device_id: None,
        tab_key: None,
        // Delta-r4 Finding 1: unattributed fixture rows are legacy-shaped
        // (no attribution-time key); `with_attribution` stamps one.
        last_attributed_at: None,
    }
}

fn binding_row(provider: &str, session_id: &str, state_parts: StateParts) -> BindingRow {
    binding_row_at(provider, session_id, state_parts, 1000)
}

/// D8 attribution knobs: stamp the fixture row the way the connection-scoped
/// WS create lanes do — `tab_key` composes as `device:tab` (exactly
/// `BindProvenance::for_create`'s rule). Delta-r4 Finding 1: the attributed
/// write also stamps `last_attributed_at`; for the fresh direct lanes
/// receipt ≈ write, so stamping it with the write's own `updated_at` keeps
/// every boundary test below asserting its INTENDED boundary against the
/// judgment key (the late-write split lives in the focused-ep4-r2 pins).
fn with_attribution(mut row: BindingRow, client: &str, device: &str, tab_id: &str) -> BindingRow {
    row.client_instance_id = Some(client.to_string());
    row.device_id = Some(device.to_string());
    row.tab_key = Some(format!("{device}:{tab_id}"));
    row.last_attributed_at = Some(row.updated_at);
    row
}

/// No surviving parent evidence at all (no-snapshot boot, pre-D8 inventory).
fn no_evidence() -> DeviceEvidence {
    Vec::new()
}

/// No close evidence anywhere (the default for fixtures that predate the
/// delta-r6-r2 verdict join — closes change a pane's verdict, so fixtures
/// that need one build their own `CloseEvidence`).
fn no_closes() -> CloseEvidence {
    CloseEvidence::none()
}

/// The delta-r6-r2 close-evidence fixture: a pane close record keyed by
/// terminal id (+ optional createRequestId lineage), plus standing kill
/// tombstones.
fn closes_with(
    terminal_id: &str,
    create_request_id: Option<&str>,
    kills: &[(&str, &str)],
    standing: &[(&str, &str)],
) -> CloseEvidence {
    CloseEvidence {
        standing_kill_tombstones: standing
            .iter()
            .map(|(p, s)| (p.to_string(), s.to_string()))
            .collect(),
        pane_closes: vec![PaneCloseRecord {
            ledger_version: LEDGER_VERSION,
            terminal_id: terminal_id.to_string(),
            create_request_id: create_request_id.map(str::to_string),
            closed_at: 5_000,
            kills: kills
                .iter()
                .map(|(p, s)| PaneCloseKill {
                    provider: p.to_string(),
                    session_id: s.to_string(),
                    at_ms: 5_000,
                })
                .collect(),
        }],
        pane_detach_closes: Vec::new(),
    }
}

/// Delta-round-7 (Finding F2) fixture: the NON-RETIRING detach closes (no
/// kill-lane records, no standing fences) — `(createRequestId, terminalId)`
/// pairs exactly as `list_pane_detach_closes` projects them.
fn closes_with_detach(detaches: &[(&str, Option<&str>)]) -> CloseEvidence {
    CloseEvidence {
        standing_kill_tombstones: HashSet::new(),
        pane_closes: Vec::new(),
        pane_detach_closes: detaches
            .iter()
            .map(|(crid, tid)| PaneDetachClose {
                create_request_id: crid.to_string(),
                terminal_id: tid.map(str::to_string),
            })
            .collect(),
    }
}

/// D8 evidence fixture: device_id -> [(client_instance_id, winner capturedAt)].
fn evidence(maps: &[(&str, &[(&str, u64)])]) -> DeviceEvidence {
    maps.iter()
        .map(|(device, clients)| {
            (
                device.to_string(),
                clients
                    .iter()
                    .map(|(client, captured)| (client.to_string(), *captured))
                    .collect(),
            )
        })
        .collect()
}

/// WAVE-B fast-follow (B3 lane review): the inventory's D7 liveness join must
/// match the server guard's width (terminal.rs D7 live-guard: identity-registry
/// owner check PLUS the registry-row scan). A locator-adopted terminal holds
/// its session in the IDENTITY registry while the registry row's
/// resume_session_id stays unset (fresh pane, never resumed) -- the inventory
/// must still report that session live, or it gets offered for resume and the
/// accept dies on the server guard instead of never being offered.
#[test]
fn live_session_keys_includes_identity_registry_bound_sessions() {
    let registry = freshell_terminal::TerminalRegistry::new();
    registry.register_headless(freshell_terminal::registry::HeadlessTerminal {
        terminal_id: "t-live".into(),
        stream_id: "s1".into(),
        mode: "codex".into(),
        resume_session_id: None, // fresh pane: row carries no resume id
        create_request_id: None,
        created_at: None,
    });
    let identity = freshell_ws::identity::TerminalIdentityRegistry::new();
    identity.upsert("t-live", Some("codex"), Some("sess-live-1"), None, 0);

    let keys = live_session_keys(&registry, &identity);
    assert!(
        keys.contains(&("codex".to_string(), "sess-live-1".to_string())),
        "identity-registry-bound session of a Running terminal must be live"
    );
}

/// Retired identity entries and identity entries whose terminal is not
/// Running never widen the live set.
#[test]
fn live_session_keys_ignores_retired_and_dead_identity_entries() {
    let registry = freshell_terminal::TerminalRegistry::new();
    // No registry row at all for "t-gone" -- its identity entry must not count.
    let identity = freshell_ws::identity::TerminalIdentityRegistry::new();
    identity.upsert("t-gone", Some("codex"), Some("sess-gone"), None, 0);
    // A retired entry on a live terminal must not count either.
    registry.register_headless(freshell_terminal::registry::HeadlessTerminal {
        terminal_id: "t-retired".into(),
        stream_id: "s2".into(),
        mode: "claude".into(),
        resume_session_id: None,
        create_request_id: None,
        created_at: None,
    });
    identity.upsert("t-retired", Some("claude"), Some("sess-retired"), None, 0);
    assert!(identity.retire("t-retired"));

    let keys = live_session_keys(&registry, &identity);
    assert!(!keys.contains(&("codex".to_string(), "sess-gone".to_string())));
    assert!(!keys.contains(&("claude".to_string(), "sess-retired".to_string())));
}

/// Focused-episode-6 round 5 (Finding F2) — the route's shell half of the
/// liveness join: the live-TERMINAL set is the Running registry rows'
/// terminal ids (the same registry read `live_session_keys` filters).
#[test]
fn live_terminal_ids_collect_the_running_registry_rows() {
    let registry = freshell_terminal::TerminalRegistry::new();
    registry.register_headless(freshell_terminal::registry::HeadlessTerminal {
        terminal_id: "t-live".into(),
        stream_id: "s1".into(),
        mode: "shell".into(),
        resume_session_id: None, // a plain shell owns no session identity
        create_request_id: None,
        created_at: None,
    });
    let ids = live_terminal_ids(&registry);
    assert!(
        ids.contains("t-live"),
        "a Running shell row's terminal id is live evidence"
    );
    assert!(
        !ids.contains("t-absent"),
        "an id the registry does not hold is never live"
    );
}

/// Finding F2 (Major) — shell liveness: a plain-shell terminal pane has NO
/// session identity (no rows, no claims — the effective ref is null and the
/// durable-ref liveness arm can never fire), so pre-fix it always reported
/// `live: false`; the client then dropped the saved terminal identity and
/// spawned a DUPLICATE beside the still-running PTY. Such a pane now claims
/// liveness via its snapshot's `payload.liveTerminal.terminalId` membership
/// in the server's live-terminal set. Durable-ref liveness stays primary;
/// terminal-id membership is the fallback for unidentified shells.
#[test]
fn a_live_shell_pane_verdicts_live_via_its_live_terminal_id() {
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "shell", "shell": "system",
                                  "createRequestId": "req-shell",
                                  "liveTerminal": { "terminalId": "t-shell", "serverInstanceId": "srv-x" } } }]),
        ),
    };
    // No rows anywhere (shells never write ledger rows) and no durable claims
    // — only the terminal-id evidence.
    let out = build_inventory(vec![d], vec![], live_terminals(&["t-shell"]), &no_evidence(), &no_closes());
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(
        pane["live"], true,
        "a shell whose snapshot terminal is STILL RUNNING server-side verdicts live: {pane}"
    );
    assert_eq!(
        pane["ledgerState"], "unknown",
        "no identity exists to bind — the ref-less fallback stands: {pane}"
    );
    assert!(pane["sessionRef"].is_null());
}

/// F2 control: the same pane with its terminal NOT in the live set stays
/// dead (the pre-existing fallback is untouched — such a shell restores
/// fresh, exactly as before).
#[test]
fn a_shell_pane_whose_terminal_is_not_live_stays_dead() {
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "shell", "shell": "system",
                                  "createRequestId": "req-shell",
                                  "liveTerminal": { "terminalId": "t-shell", "serverInstanceId": "srv-x" } } }]),
        ),
    };
    let out = build_inventory(vec![d], vec![], no_live(), &no_evidence(), &no_closes());
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(pane["live"], false, "no live-terminal membership, no liveness: {pane}");
    assert_eq!(pane["ledgerState"], "unknown", "{pane}");
}

/// F2's closed gate: a pane covered by a close record can never read live —
/// the close envelope lands BEFORE the kill's teardown, so a terminal can be
/// mid-close and still Running while the pane is already durably closed. The
/// closed verdict wins and the pane is excluded regardless of the
/// still-Running id.
#[test]
fn a_close_covered_pane_stays_non_live_even_while_its_terminal_still_runs() {
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "shell", "shell": "system",
                                  "createRequestId": "req-mid-close",
                                  "liveTerminal": { "terminalId": "t-mid-close", "serverInstanceId": "srv-x" } } }]),
        ),
    };
    let closes = closes_with("t-mid-close", Some("req-mid-close"), &[], &[]);
    let out = build_inventory(vec![d], vec![], live_terminals(&["t-mid-close"]), &no_evidence(), &closes);
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(pane["ledgerState"], "closed", "the close evidence owns the verdict: {pane}");
    assert_eq!(
        pane["live"], false,
        "a mid-teardown terminal is Running but the pane was CLOSED — never live: {pane}"
    );
}

/// F2's durable-ref precedence: an IDENTIFIED live terminal pane (a bound
/// session claim that resolves and is live) still verdicts live through the
/// primary arm — and the terminal-id fallback extending the SAME pane's
/// liveness changes nothing (one boolean, never double-counted).
#[test]
fn the_durable_ref_arm_stays_primary_and_the_terminal_id_fallback_agrees() {
    let d = || DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "claude",
                                  "sessionRef": { "provider": "claude", "sessionId": "S-primary" },
                                  "createRequestId": "req-id",
                                  "liveTerminal": { "terminalId": "t-id", "serverInstanceId": "srv-x" } } }]),
        ),
    };
    let bindings = || vec![binding_row("claude", "S-primary", bound())];
    // Primary arm only: the terminal id is NOT in the live set.
    let out = build_inventory(
        vec![d()],
        bindings(),
        live(&[("claude", "S-primary")]),
        &no_evidence(),
        &no_closes(),
    );
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(pane["live"], true, "the durable-ref arm alone verdicts live: {pane}");
    assert_eq!(pane["ledgerState"], "bound", "{pane}");
    // Both arms: identical verdict and liveness.
    let out = build_inventory(
        vec![d()],
        bindings(),
        with_terminals(live(&[("claude", "S-primary")]), &["t-id"]),
        &no_evidence(),
        &no_closes(),
    );
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(pane["live"], true, "{pane}");
    assert_eq!(pane["ledgerState"], "bound", "{pane}");
}

#[test]
fn empty_inputs_not_recoverable() {
    let out = build_inventory(vec![], vec![], no_live(), &no_evidence(), &no_closes());
    assert_eq!(out["recoverable"], false);
    assert!(out["device"].is_null());
    assert_eq!(out["ledgerOnly"].as_array().unwrap().len(), 0);
}

#[test]
fn newest_device_wins_others_summarized() {
    let old = DeviceUnion {
        device_id: "dev0".into(),
        union_doc: union_doc(
            "dev0",
            500,
            json!([{ "paneId": "p0", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let new = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell", "initialCwd": "/w"} }]),
        ),
    };
    let out = build_inventory(vec![old, new], vec![], no_live(), &no_evidence(), &no_closes());
    assert_eq!(out["recoverable"], true);
    assert_eq!(out["device"]["deviceId"], "dev1");
    assert_eq!(out["device"]["tabs"][0]["panes"][0]["cwd"], "/w");
    assert_eq!(out["device"]["tabs"][0]["panes"][0]["live"], false);
    assert_eq!(out["otherDevices"][0]["deviceId"], "dev0");
    assert_eq!(out["otherDevices"][0]["paneCount"], 1);
}

#[test]
fn ledger_bound_row_overrides_snapshot_claim_via_superseded_chain() {
    // snapshot says S1; ledger: S1 retired(superseded -> S2), S2 bound
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "claude", "sessionRef": { "provider": "claude", "sessionId": "S1" } } }]),
        ),
    };
    let bindings = vec![
        binding_row("claude", "S1", retired_superseded_by("claude", "S2")),
        // S2 is attributed and within grace of its parent's evidence, so ONLY
        // the referenced rule (A4) keeps it out of ledgerOnly — the test's
        // subject stays the deciding filter under D8.
        with_attribution(binding_row("claude", "S2", bound()), "c1", "dev1", "t2"),
    ];
    let out = build_inventory(
        vec![d],
        bindings,
        no_live(),
        &evidence(&[("dev1", &[("c1", 5_000)])]), &no_closes());
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(pane["ledgerState"], "bound");
    assert_eq!(pane["sessionRef"]["sessionId"], "S2"); // ledger identity beat the snapshot claim
    assert_eq!(out["ledgerOnly"].as_array().unwrap().len(), 0); // S2 is referenced, not ledger-only
}

#[test]
fn closed_row_strips_resume_gc_expired_keeps_snapshot_ref_unknown_passes_through() {
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([
                { "paneId": "p1", "kind": "terminal", "payload": { "mode": "claude", "sessionRef": { "provider": "claude", "sessionId": "CLOSED" } } },
                { "paneId": "p2", "kind": "terminal", "payload": { "mode": "codex",  "sessionRef": { "provider": "codex",  "sessionId": "EXPIRED" } } },
                { "paneId": "p3", "kind": "fresh-agent", "payload": { "sessionRef": { "provider": "freshclaude", "sessionId": "NOROW" } } }
            ]),
        ),
    };
    let bindings = vec![
        binding_row("claude", "CLOSED", retired_closed()),
        binding_row("codex", "EXPIRED", retired_gc_expired()),
    ];
    // Retired rows never reach the D8 judgment (row_is_bound pre-filters
    // them), so no evidence is needed.
    let out = build_inventory(vec![d], bindings, no_live(), &no_evidence(), &no_closes());
    let panes = out["device"]["tabs"][0]["panes"].as_array().unwrap();
    assert_eq!(panes[0]["ledgerState"], "closed");
    assert!(panes[0]["sessionRef"].is_null());
    assert_eq!(panes[1]["ledgerState"], "gc_expired");
    assert_eq!(panes[1]["sessionRef"]["sessionId"], "EXPIRED");
    assert_eq!(panes[2]["ledgerState"], "unknown");
    assert_eq!(panes[2]["sessionRef"]["sessionId"], "NOROW");
}

#[test]
fn unattributed_rows_are_never_offered() {
    // D8 (restore-open-sessions-only) — THE USER'S BUG CLASS: a Bound,
    // unreferenced, not-live row with NO provenance stamps (REST/headless
    // lineage, and every pre-upgrade row — e.g. the 30-day tail of closed
    // fresh-agent panes, natural CLI exits, and plain-detach closes whose
    // rows are never retired) must NEVER be offered. Deliberate contract
    // rewrite of the old blanket rule (`unreferenced_bound_rows_become_
    // ledger_only`): the same fixture the old rule offered is now never
    // surfaced, so a collapse back to the blanket bucket re-fails loudly.
    let out = build_inventory(
        vec![],
        vec![binding_row("codex", "C9", bound())],
        no_live(),
        &no_evidence(), &no_closes());
    assert_eq!(out["recoverable"], false);
    assert!(out["device"].is_null());
    assert_eq!(out["ledgerOnly"].as_array().unwrap().len(), 0);

    // Even with a primary device AND surviving parent evidence present, an
    // unattributed row is still dropped: the attribution clause is judged
    // before any evidence lookup, so the row can never name that parent.
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            5_000,
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let out = build_inventory(
        vec![d],
        vec![binding_row("codex", "C9", bound())],
        no_live(),
        &evidence(&[("dev1", &[("c1", 5_000)])]), &no_closes());
    assert_eq!(out["ledgerOnly"].as_array().unwrap().len(), 0);
}

#[test]
fn bound_row_referenced_by_non_primary_device_is_not_ledger_only() {
    // A4: a two-device steady state must not report the OTHER device's sessions as orphaned.
    let newer = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let older = DeviceUnion {
        device_id: "dev0".into(),
        union_doc: union_doc(
            "dev0",
            500,
            json!([{ "paneId": "p0", "kind": "terminal",
                     "payload": { "mode": "codex", "sessionRef": { "provider": "codex", "sessionId": "C9" } } }]),
        ),
    };
    // C9 is attributed to the PRIMARY device with in-grace parent evidence,
    // so the D8 judgment alone would offer it — the A4 cross-device
    // referenced rule remains the deciding filter this test pins.
    let out = build_inventory(
        vec![newer, older],
        vec![with_attribution(
            binding_row("codex", "C9", bound()),
            "c9",
            "dev1",
            "t9",
        )],
        no_live(),
        &evidence(&[("dev1", &[("c9", 5_000)])]), &no_closes());
    assert_eq!(out["device"]["deviceId"], "dev1"); // dev0 is NON-primary
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "C9 is referenced by dev0's union - not orphaned"
    );
}

#[test]
fn live_effective_ref_marks_pane_live_and_live_rows_become_reattach_candidates() {
    // D7 pane half (unchanged): the pane's claim resolves (via the ledger
    // chain) to S2, which a Running terminal owns => the pane verdicts live
    // and the effective ref is still reported.
    //
    // Delta-round-7 Finding F1 (RETARGETED row half — this test previously
    // pinned the round-3 live EXCLUSION, the finding's harm): the
    // unreferenced Bound row C9 is LIVE, meaningfully attributed
    // (client+device+tab stamps with a present `last_attributed_at`), inside
    // its parent's grace window (1_000 + 7_000 >= 5_000), placement-valid
    // (the union's record carries its stamped tabKey "dev1:t9"), and not
    // close-covered => it is OFFERED as a REATTACH candidate: `live:true`
    // (the client's reattach/adopt routing) plus the row's still-running
    // terminal id and its stamped tabKey. Dead rows keep the EXISTING
    // judgment's treatment unchanged: the same row with no live evidence is
    // offered too (the D8 resume cohort — that was never the pinned
    // exclusion; the categorical !is_live drop was).
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc_with_tab_key(
            "dev1",
            1000,
            "dev1:t9",
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "claude", "sessionRef": { "provider": "claude", "sessionId": "S1" } } }]),
        ),
    };
    let mut c9 = with_attribution(binding_row("codex", "C9", bound()), "c9", "dev1", "t9");
    c9.live_terminal_id = Some("term-c9-live".into());
    let bindings = vec![
        binding_row("claude", "S1", retired_superseded_by("claude", "S2")),
        binding_row("claude", "S2", bound()),
        c9,
    ];
    let out = build_inventory(
        vec![d],
        bindings,
        live(&[("claude", "S2"), ("codex", "C9")]),
        &evidence(&[("dev1", &[("c9", 5_000)])]), &no_closes());
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(pane["live"], true);
    assert_eq!(pane["sessionRef"]["sessionId"], "S2"); // ref still reported; the CLIENT strips it (Task 4, D7)
    let only = out["ledgerOnly"].as_array().unwrap();
    // S2 is REFERENCED by the snapshot pane (never ledgerOnly); the live C9
    // row is the one offered member.
    let entry = only
        .iter()
        .find(|e| e["sessionId"] == "C9")
        .unwrap_or_else(|| panic!("the live attributed placement-valid row is offERED as a reattach candidate: {out}"));
    assert_eq!(only.len(), 1, "S2 stays referenced; C9 alone joins: {out}");
    assert_eq!(entry["live"], true, "the live verdict rides the offer entry: {entry}");
    assert_eq!(
        entry["liveTerminalId"], "term-c9-live",
        "the row's still-running terminal id arms the client reattach: {entry}"
    );
    assert_eq!(entry["tabKey"], "dev1:t9", "the original-tab join key: {entry}");
    assert!(entry.get("paneKind").is_none(), "a terminal row carries no paneKind: {entry}");

    // The dead twin: same row, no live evidence — the pre-existing D8 resume
    // cohort. Still offered (never the pinned exclusion), stamped live:false
    // and with NO reattach terminal handle (its terminal is gone).
    let d2 = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc_with_tab_key(
            "dev1",
            1000,
            "dev1:t9",
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "claude", "sessionRef": { "provider": "claude", "sessionId": "S1" } } }]),
        ),
    };
    let mut c9_dead = with_attribution(binding_row("codex", "C9", bound()), "c9", "dev1", "t9");
    c9_dead.live_terminal_id = Some("term-c9-live".into());
    let out_dead = build_inventory(
        vec![d2],
        vec![
            binding_row("claude", "S1", retired_superseded_by("claude", "S2")),
            binding_row("claude", "S2", bound()),
            c9_dead,
        ],
        no_live(),
        &evidence(&[("dev1", &[("c9", 5_000)])]), &no_closes());
    let only_dead = out_dead["ledgerOnly"].as_array().unwrap();
    let entry_dead = only_dead
        .iter()
        .find(|e| e["sessionId"] == "C9")
        .expect("the dead twin stays offered (the D8 resume cohort)");
    assert_eq!(entry_dead["live"], false, "no live evidence, no live stamp: {entry_dead}");
    assert!(
        entry_dead.get("liveTerminalId").is_none() || entry_dead["liveTerminalId"].is_null(),
        "a dead row forwards no reattach handle (it restores by resume): {entry_dead}"
    );
}

/// Delta-round-7 Finding F1, the gate-parity pins: including live rows never
/// WEAKENS the judgment — a live row answers the SAME attribution, grace, and
/// placement gates as a dead one. Each arm isolates one failing gate with
/// the liveness evidence present (pre-fix every arm passed vacuously: the
/// categorical live drop masked them all).
#[test]
fn live_rows_answer_the_same_attribution_grace_and_placement_gates_as_dead_rows() {
    let open_union = |tab_key: &str| DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc_with_tab_key(
            "dev1",
            1_000_000,
            tab_key,
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let ev = evidence(&[("dev1", &[("c1", 1_000_000)])]);
    let live_ev = live(&[("claude", "S-live")]);

    // (a) OUT OF GRACE: the parent's evidence already observed the row's
    // absence (992_999 + 7_000 < 1_000_000) — excluded, live stamp or not.
    let out = build_inventory(
        vec![open_union("dev1:t1")],
        vec![with_attribution(
            binding_row_at("claude", "S-live", bound(), 992_999),
            "c1",
            "dev1",
            "t1",
        )],
        live_ev,
        &ev, &no_closes());
    assert!(
        out["ledgerOnly"].as_array().unwrap().is_empty(),
        "a live row past its parent's grace stays excluded: {out}"
    );

    // (b) PLACEMENT MISS: the stamped tabKey names no open paned tab in the
    // union — unplaceable, excluded.
    let out = build_inventory(
        vec![open_union("dev1:t-other")],
        vec![with_attribution(
            binding_row_at("claude", "S-live", bound(), 995_000),
            "c1",
            "dev1",
            "t1",
        )],
        live(&[("claude", "S-live")]),
        &ev, &no_closes());
    assert!(
        out["ledgerOnly"].as_array().unwrap().is_empty(),
        "a live row whose stamped tab is not in the union stays excluded: {out}"
    );

    // (c) UNATTRIBUTED: no client/device stamps at all — never offered.
    let out = build_inventory(
        vec![open_union("dev1:t1")],
        vec![binding_row_at("claude", "S-live", bound(), 995_000)],
        live(&[("claude", "S-live")]),
        &ev, &no_closes());
    assert!(
        out["ledgerOnly"].as_array().unwrap().is_empty(),
        "a live but unattributed row stays excluded: {out}"
    );

    // (d) CONTROL: every gate passes — the live row IS offered (anti-vacuity:
    // the three exclusions above are decided by their gates, not by the offer
    // pipeline being broken).
    let out = build_inventory(
        vec![open_union("dev1:t1")],
        vec![with_attribution(
            binding_row_at("claude", "S-live", bound(), 995_000),
            "c1",
            "dev1",
            "t1",
        )],
        live(&[("claude", "S-live")]),
        &ev, &no_closes());
    let only = out["ledgerOnly"].as_array().unwrap();
    assert_eq!(only.len(), 1, "all gates pass => the live row is offered: {out}");
    assert_eq!(only[0]["live"], true, "{out}");
}

/// Delta-round-7 (Finding F2) — the ROW-side detach coverage: a Bound,
/// unreferenced, attributed, in-grace, placement-valid row whose PANE was
/// X-closed (the non-retiring detach wrote its createRequestId-keyed close
/// record) is NEVER offered — LIVE or DEAD (the finding's exact admission:
/// created-then-closed-within-7s read indistinguishable from
/// created-then-crashed). The row itself stays Bound (the record never
/// flips it — sidebar reattach keeps working). The uncovered sibling row
/// stays offered either way (anti-vacuity: the fixture discriminates).
#[test]
fn a_detach_close_covered_row_is_never_offered_live_or_dead() {
    let make = |live_keys: &[(&str, &str)]| {
        let d = DeviceUnion {
            device_id: "dev1".into(),
            union_doc: union_doc_with_tab_key(
                "dev1",
                1_000_000,
                "dev1:t1",
                json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
            ),
        };
        let covered = with_attribution(
            with_correlation_ids(
                binding_row_at("claude", "S-closed", bound(), 995_000),
                Some("req-closed"),
                Some("term-closed"),
            ),
            "c1",
            "dev1",
            "t1",
        );
        let sibling = with_attribution(
            with_correlation_ids(
                binding_row_at("claude", "S-open", bound(), 995_000),
                Some("req-open"),
                Some("term-open"),
            ),
            "c1",
            "dev1",
            "t1",
        );
        build_inventory(
            vec![d],
            vec![covered, sibling],
            live(live_keys),
            &evidence(&[("dev1", &[("c1", 1_000_000)])]),
            &closes_with_detach(&[("req-closed", Some("term-closed"))]),
        )
    };
    for (label, keys) in [
        ("DEAD (post-restart)", &[][..]),
        ("LIVE (still Running)", &[("claude", "S-closed"), ("claude", "S-open")][..]),
    ] {
        let out = make(keys);
        let only = out["ledgerOnly"].as_array().unwrap();
        assert!(
            only.iter().all(|e| e["sessionId"] != "S-closed"),
            "the detach-close-covered row is never offered ({label}): {out}"
        );
        assert!(
            only.iter().any(|e| e["sessionId"] == "S-open"),
            "the uncovered sibling stays offered ({label} anti-vacuity): {out}"
        );
    }

    // The TERMINAL arm alone also covers the row (the conn-less resolution
    // lane writes rows without the advisory createRequestId): a row with NO
    // crid whose live terminal IS the closed pane's terminal is that pane's
    // row — covered. (A live-terminal-id match against a KILL record never
    // reaches here: kill-covered rows are retired or dominance-rewritten
    // before this pipeline.)
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc_with_tab_key(
            "dev1",
            1_000_000,
            "dev1:t1",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let crid_less = with_attribution(
        with_correlation_ids(
            binding_row_at("claude", "S-resolved-late", bound(), 995_000),
            None,
            Some("term-closed"),
        ),
        "c1",
        "dev1",
        "t1",
    );
    let out = build_inventory(
        vec![d],
        vec![crid_less],
        live(&[("claude", "S-resolved-late")]),
        &evidence(&[("dev1", &[("c1", 1_000_000)])]),
        &closes_with_detach(&[("req-closed", Some("term-closed"))]),
    );
    assert!(
        out["ledgerOnly"].as_array().unwrap().is_empty(),
        "the crid-less row on the closed pane's terminal is covered via the terminal arm: {out}"
    );

    // REBOUND LAPSE: the same identity re-created by a NEW pane mints a new
    // createRequestId wholesale — neither arm keys the old close anymore, so
    // a genuinely re-opened session is offerable again.
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc_with_tab_key(
            "dev1",
            1_000_000,
            "dev1:t1",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let rebound = with_attribution(
        with_correlation_ids(
            binding_row_at("claude", "S-rebound", bound(), 995_000),
            Some("req-new-pane"),
            Some("term-new-pane"),
        ),
        "c1",
        "dev1",
        "t1",
    );
    let out = build_inventory(
        vec![d],
        vec![rebound],
        live(&[("claude", "S-rebound")]),
        &evidence(&[("dev1", &[("c1", 1_000_000)])]),
        &closes_with_detach(&[("req-closed", Some("term-closed"))]),
    );
    let only = out["ledgerOnly"].as_array().unwrap();
    assert_eq!(
        only.len(),
        1,
        "a rebound row (fresh pane keys) is never ghosted by the old pane's close: {out}"
    );
}

/// Delta-r7-round-2 (Finding F3) — the reattach lapse: after the sidebar
/// reattach re-stamps the Bound row onto the NEW pane's identity (the
/// attach-carried createRequestId + provenance advance), the OLD pane's
/// close record must never suppress it. Both row-side coverage arms are
/// exercised because they must BOTH lapse: the createRequestId arm no longer
/// keys the row (it was re-stamped), and the live-terminal arm CANNOT key a
/// CRID-bearing row — that arm exists ONLY for rows the conn-less resolution
/// lane wrote WITHOUT the advisory createRequestId. The row is offered
/// again, LIVE or DEAD, with the reattach handle when live.
#[test]
fn a_reattached_row_is_offered_despite_the_old_panes_detach_close() {
    let make = |live_keys: &[(&str, &str)]| {
        let d = DeviceUnion {
            device_id: "dev1".into(),
            union_doc: union_doc_with_tab_key(
                "dev1",
                1_000_000,
                "dev1:t1",
                json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
            ),
        };
        // The RESTAMPED row: the reattaching pane's CRID (uncovered — the new
        // pane was never closed), the SAME terminal the old pane's close
        // record names, attribution ADVANCED to the reattach's assertion time
        // (996_000 — inside grace of the parent's 1_000_000).
        let restamped = with_attribution(
            with_correlation_ids(
                binding_row_at("claude", "S-reopened", bound(), 996_000),
                Some("req-reopened"),
                Some("term-closed"),
            ),
            "c1",
            "dev1",
            "t1",
        );
        build_inventory(
            vec![d],
            vec![restamped],
            live(live_keys),
            &evidence(&[("dev1", &[("c1", 1_000_000)])]),
            &closes_with_detach(&[("req-closed", Some("term-closed"))]),
        )
    };
    for (label, keys, expect_live) in [
        ("DEAD (post-restart)", &[][..], false),
        (
            "LIVE (still Running — the sidebar reattach's own shape)",
            &[("claude", "S-reopened")][..],
            true,
        ),
    ] {
        let out = make(keys);
        let only = out["ledgerOnly"].as_array().unwrap();
        let entry = only
            .iter()
            .find(|e| e["sessionId"] == "S-reopened")
            .unwrap_or_else(|| panic!("the reattached row lapses the old pane's close coverage and is offered ({label}): {out}"));
        assert_eq!(entry["live"], expect_live, "{label}: {entry}");
        if expect_live {
            assert_eq!(
                entry["liveTerminalId"], "term-closed",
                "the live reattach forwards the still-running terminal: {entry}"
            );
        }
    }

    // The uncovered-CRID gate never opens the terminal arm for a row whose
    // OWN pane IS covered: restamped-or-not, a row carrying the CLOSED
    // pane's createRequestId on the closed pane's terminal stays suppressed
    // (the anti-regression control proving the arm still bites its own key).
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc_with_tab_key(
            "dev1",
            1_000_000,
            "dev1:t1",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let still_closed = with_attribution(
        with_correlation_ids(
            binding_row_at("claude", "S-still-closed", bound(), 995_000),
            Some("req-closed"),
            Some("term-closed"),
        ),
        "c1",
        "dev1",
        "t1",
    );
    let out = build_inventory(
        vec![d],
        vec![still_closed],
        live(&[("claude", "S-still-closed")]),
        &evidence(&[("dev1", &[("c1", 1_000_000)])]),
        &closes_with_detach(&[("req-closed", Some("term-closed"))]),
    );
    assert!(
        out["ledgerOnly"].as_array().unwrap().is_empty(),
        "a row still keyed by the closed pane's CRID stays covered (never a lapse): {out}"
    );
}

/// Delta-round-7 (Finding F2) — the PANE-side detach coverage via the
/// createRequestId arm ONLY: a snapshot pane whose createRequestId a detach
/// record keys verdicts CLOSED even though its session is still live (the
/// pane itself was closed; coverage beats liveness) — but a LATER pane
/// reattached to the SAME still-running terminal (fresh createRequestId) is
/// NOT covered: the detach record's terminal id never joins snapshot panes
/// (the P2 false-positive guard — the kill lane's terminal arm is untouched:
/// killed terminals are dead, so it never collides).
#[test]
fn a_detach_close_covers_its_snapshot_pane_by_create_request_id_but_never_a_reattached_pane() {
    // The CLOSED pane, snapshotted pre-close with its identity resolved and
    // its terminal still Running: coverage wins over the live verdict.
    let closed_pane = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "claude",
                                  "sessionRef": { "provider": "claude", "sessionId": "S-closed" },
                                  "createRequestId": "req-closed",
                                  "liveTerminal": { "terminalId": "term-closed", "serverInstanceId": "srv-x" } } }]),
        ),
    };
    let out = build_inventory(
        vec![closed_pane],
        vec![with_correlation_ids(
            binding_row("claude", "S-closed", bound()),
            Some("req-closed"),
            Some("term-closed"),
        )],
        live(&[("claude", "S-closed")]),
        &no_evidence(),
        &closes_with_detach(&[("req-closed", Some("term-closed"))]),
    );
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(
        pane["ledgerState"], "closed",
        "the closed pane's own snapshot verdicts closed (never restored): {pane}"
    );
    assert_eq!(pane["live"], false, "a close-covered pane never reads live: {pane}");

    // The REATTACHED pane: a NEW pane on the SAME still-running terminal
    // (sidebar reattach mints a fresh createRequestId) is NOT covered by the
    // old pane's detach record — it verdicts live through the terminal-id
    // fallback and restores by reattach.
    let reattached_pane = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([{ "paneId": "p2", "kind": "terminal",
                     "payload": { "mode": "shell", "shell": "system",
                                  "createRequestId": "req-reattached",
                                  "liveTerminal": { "terminalId": "term-closed", "serverInstanceId": "srv-x" } } }]),
        ),
    };
    let out = build_inventory(
        vec![reattached_pane],
        vec![],
        with_terminals(no_live(), &["term-closed"]),
        &no_evidence(),
        &closes_with_detach(&[("req-closed", Some("term-closed"))]),
    );
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(
        pane["live"], true,
        "the reattached pane lives (terminal-id fallback), never covered by the old pane's close: {pane}"
    );
    assert_ne!(
        pane["ledgerState"], "closed",
        "a detach record's terminal id never covers a different pane: {pane}"
    );
}

#[test]
fn content_id_is_stable_and_input_sensitive() {
    // D8 repair: the rows must actually be OFFERED (attributed + within grace
    // of their parent's surviving evidence) — two inventories whose rows were
    // both D8-dropped digest identically and the assert_ne below would go
    // vacuous.
    let union = |tab_key: &str| DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc_with_tab_key(
            "dev1",
            5_000,
            tab_key,
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    // row_time = 1_000; 1_000 + 7_000 >= 5_000 => the row is offered.
    let ev = || evidence(&[("dev1", &[("c1", 5_000)])]);
    let a = build_inventory(
        vec![union("dev1:t9")],
        vec![with_attribution(
            binding_row("codex", "C9", bound()),
            "c1",
            "dev1",
            "t9",
        )],
        no_live(),
        &ev(), &no_closes());
    let b = build_inventory(
        vec![union("dev1:t9")],
        vec![with_attribution(
            binding_row("codex", "C9", bound()),
            "c1",
            "dev1",
            "t9",
        )],
        no_live(),
        &ev(), &no_closes());
    let c = build_inventory(
        vec![union("dev1:t8")],
        vec![with_attribution(
            binding_row("codex", "C8", bound()),
            "c1",
            "dev1",
            "t8",
        )],
        no_live(),
        &ev(), &no_closes());
    assert!(
        a["ledgerOnly"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["sessionId"] == "C9"),
        "the offered row participates in the digest (anti-vacuity)"
    );
    assert_eq!(a["contentId"], b["contentId"]);
    assert_ne!(a["contentId"], c["contentId"]);
}

#[test]
fn content_id_ignores_timestamp_churn() {
    // A5/A6: heartbeat re-pushes bump capturedAt/updatedAt every <=5 min - dismissal must survive.
    let doc = |captured_at| {
        union_doc_with_tab_key(
            "dev1",
            captured_at,
            "dev1:t9",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        )
    };
    // D8 evidence alignment: the row is attributed and within grace of its
    // parent's evidence in BOTH builds (2_000 + 7_000 >= 5_000), so it
    // participates in the digest — the churn-freeness pin covers the row too.
    let a = build_inventory(
        vec![DeviceUnion {
            device_id: "dev1".into(),
            union_doc: doc(1000),
        }],
        vec![with_attribution(
            binding_row_at("codex", "C9", bound(), 1000),
            "c1",
            "dev1",
            "t9",
        )],
        no_live(),
        &evidence(&[("dev1", &[("c1", 5_000)])]), &no_closes());
    let b = build_inventory(
        vec![DeviceUnion {
            device_id: "dev1".into(),
            union_doc: doc(2000),
        }],
        vec![with_attribution(
            binding_row_at("codex", "C9", bound(), 2000),
            "c1",
            "dev1",
            "t9",
        )],
        no_live(),
        &evidence(&[("dev1", &[("c1", 5_000)])]), &no_closes());
    assert_eq!(
        a["ledgerOnly"].as_array().unwrap().len(),
        1,
        "the row must be offered (anti-vacuity)"
    );
    assert_eq!(
        a["contentId"], b["contentId"],
        "bumping only capturedAt/updatedAt must not change contentId"
    );
}

/// Focused-episode-6 round 5, Finding F3 (Minor): the verdict's `live` flag
/// is now materially significant — live panes are INCLUDED in the offer and
/// restore by reattach/adopt (the round-5 F1 regime), so a live→dead
/// transition produces a materially different recoverable offer for the SAME
/// panes. The dismissal identity must RE-KEY on that transition: otherwise a
/// dismissal captured against the live-state offer still suppresses the same
/// panes once they have since become resumable. The digest deliberately folds
/// the pane's live flag into its substance. The pinned shape: identical union
/// and bindings, the SOLE difference being the claimed session's liveness.
#[test]
fn content_id_rekeys_on_a_live_to_dead_transition() {
    let d = || DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "claude",
                                  "sessionRef": { "provider": "claude", "sessionId": "S-flip" } } }]),
        ),
    };
    let bindings = || vec![binding_row("claude", "S-flip", bound())];
    let live_build = build_inventory(
        vec![d()],
        bindings(),
        live(&[("claude", "S-flip")]),
        &no_evidence(),
        &no_closes(),
    );
    let dead_build = build_inventory(
        vec![d()],
        bindings(),
        no_live(),
        &no_evidence(),
        &no_closes(),
    );
    // Anti-vacuity: the SAME claimed identity is live in the first build and
    // dead in the second, with the same effective ref (the row stays
    // referenced in both — nothing moves to ledgerOnly).
    assert_eq!(live_build["device"]["tabs"][0]["panes"][0]["live"], true);
    assert_eq!(dead_build["device"]["tabs"][0]["panes"][0]["live"], false);
    assert_eq!(
        live_build["device"]["tabs"][0]["panes"][0]["sessionRef"],
        dead_build["device"]["tabs"][0]["panes"][0]["sessionRef"],
    );
    assert!(live_build["ledgerOnly"].as_array().unwrap().is_empty());
    assert!(dead_build["ledgerOnly"].as_array().unwrap().is_empty());
    // …and the dismissal identity observes the difference.
    assert_ne!(
        live_build["contentId"], dead_build["contentId"],
        "a live→dead transition must re-key the dismissal identity (F3)"
    );
}

// ── D8 (restore-open-sessions-only) parent-relative judgment matrix ──────────
// A Bound, unreferenced, not-live row is offered ONLY while its own stamped
// parent's evidence cannot yet have observed its absence.

#[test]
fn attributed_row_within_grace_of_its_parent_is_offered() {
    // The PURE creation crash-race pin (the SIGKILL-within-5s e2e contract's
    // unit twin): the row below is still BOUND — no explicit close ever
    // happened, so nothing retired it — and inside the grace window the
    // judgment keeps it. The paired kill-window pin
    // (`retired_closed_row_inside_the_grace_window_is_never_offered`, the
    // retire-on-kill/delta-round-5 repair arm's retarget of this boundary)
    // exercises the same window with the row retired Closed: excluded.
    //
    // Parent client "c1" on primary "d1", winner capturedAt = 1_000_000; the
    // row's updated_at sits EXACTLY at the grace boundary (inclusive):
    // 993_000 == 1_000_000 - UNSNAPSHOTTED_BINDING_GRACE_MS. The union's
    // record carries the row's stamped tabKey (the placement clause's match).
    let d = DeviceUnion {
        device_id: "d1".into(),
        union_doc: union_doc_with_tab_key(
            "d1",
            1_000_000,
            "d1:t1",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let row = with_attribution(
        binding_row_at("claude", "S1", bound(), 993_000),
        "c1",
        "d1",
        "t1",
    );
    let out = build_inventory(
        vec![d],
        vec![row],
        no_live(),
        &evidence(&[("d1", &[("c1", 1_000_000)])]), &no_closes());
    let only = out["ledgerOnly"].as_array().unwrap();
    assert_eq!(
        only.len(),
        1,
        "993_000 + 7_000 >= 1_000_000: the grace boundary is inclusive"
    );
    assert_eq!(only[0]["sessionId"], "S1");
    // The stamped tabKey is forwarded for the client-side original-tab join.
    assert_eq!(only[0]["tabKey"], "d1:t1");
    // A terminal row carries NO paneKind (the fresh-agent-only field).
    assert!(only[0].get("paneKind").is_none());
    // No recorded settings on the fixture row ⇒ NO settings fields forwarded
    // (absent-when-None, the same style as paneKind/tabKey).
    for field in ["model", "effort", "sandbox", "permissionMode"] {
        assert!(
            only[0].get(field).is_none(),
            "a row without recorded {field} forwards nothing"
        );
    }
    assert_eq!(out["recoverable"], true);
}

/// Delta-round-5 retire-on-kill: an EXPLICIT `freshAgent.kill` retires the
/// pane's ledger row Closed at kill time, so the created-then-quickly-closed
/// shape this boundary used to admit lands Retired(Closed) — and retired rows
/// are excluded from ledgerOnly by the `row_is_bound` pre-filter REGARDLESS of
/// the grace clause. This is the exclusion pin for the kill-in-window class
/// (the finding preserved from delta review round 5); its Bound twin
/// (`attributed_row_within_grace_of_its_parent_is_offered`) keeps the pure
/// creation crash-race keep-side semantics.
#[test]
fn retired_closed_row_inside_the_grace_window_is_never_offered() {
    // Same boundary geometry as the Bound twin: the row's last_attributed_at
    // (its still-stamped attribution) sits EXACTLY at the inclusive grace
    // boundary of its parent's newest evidence, and the union's record
    // carries the row's stamped tabKey — every D8 fact that made the Bound
    // row offerable is held; ONLY the state differs.
    let d = DeviceUnion {
        device_id: "d1".into(),
        union_doc: union_doc_with_tab_key(
            "d1",
            1_000_000,
            "d1:t1",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let mut row = with_attribution(
        binding_row_at("claude", "S1", retired_closed(), 993_000),
        "c1",
        "d1",
        "t1",
    );
    // A fresh-agent row (the finding class), attribution fully stamped.
    row.mode = "freshclaude".into();
    row.pane_kind = Some("fresh-agent".into());
    let out = build_inventory(
        vec![d],
        vec![row.clone()],
        no_live(),
        &evidence(&[("d1", &[("c1", 1_000_000)])]), &no_closes());
    assert!(
        out["ledgerOnly"].as_array().unwrap().is_empty(),
        "an explicitly-killed (Retired/Closed) row is never offered, even inside the grace window: {}",
        serde_json::to_string_pretty(&out["ledgerOnly"]).unwrap()
    );
    // recoverable requires the device union here, so isolate the row instead:
    // with no unions at all the row alone must not recover.
    let out = build_inventory(
        vec![],
        vec![row],
        no_live(),
        &evidence(&[("d1", &[("c1", 1_000_000)])]), &no_closes());
    assert_eq!(out["recoverable"], false);
    assert!(out["device"].is_null());
}

#[test]
fn attributed_fresh_agent_row_within_grace_forwards_pane_kind() {
    // Finding 2 (delta-r1): a kept FRESH-AGENT ledger row must forward its
    // `pane_kind` as `paneKind` in the ledgerOnly JSON so the client's plan
    // builder packages it as a fresh-agent resume — never a terminal shell
    // (the row's mode is a fresh-agent session type, not a terminal CLI mode).
    let mut row = binding_row_at("opencode", "ses_9", bound(), 995_000);
    row.mode = "freshopencode".into();
    row.pane_kind = Some("fresh-agent".into());
    // Focused-ep1 Finding B: the row's recorded resume settings must ride the
    // ledgerOnly entry so the client's plan rebuilds the pane with its
    // ORIGINAL settings instead of silently adopting CURRENT defaults.
    row.model = Some("big-model".into());
    row.effort = Some("high".into());
    row.sandbox = Some("workspace-write".into());
    row.permission_mode = Some("on-request".into());
    let row = with_attribution(row, "c1", "d1", "t9");
    let d2 = DeviceUnion {
        device_id: "d1".into(),
        union_doc: union_doc_with_tab_key(
            "d1",
            1_000_000,
            "d1:t9",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let out = build_inventory(
        vec![d2],
        vec![row],
        no_live(),
        &evidence(&[("d1", &[("c1", 1_000_000)])]), &no_closes());
    let only = out["ledgerOnly"].as_array().unwrap();
    assert_eq!(only.len(), 1, "the attributed in-grace fresh-agent row is offered");
    assert_eq!(only[0]["sessionId"], "ses_9");
    assert_eq!(only[0]["mode"], "freshopencode");
    assert_eq!(
        only[0]["paneKind"], "fresh-agent",
        "the row's pane_kind must reach the client as paneKind"
    );
    assert_eq!(only[0]["model"], "big-model");
    assert_eq!(only[0]["effort"], "high");
    assert_eq!(only[0]["sandbox"], "workspace-write");
    assert_eq!(only[0]["permissionMode"], "on-request");
}

#[test]
fn attributed_row_before_its_parents_evidence_is_dropped() {
    // The paired boundary drop: one ms earlier falls outside the grace
    // window (992_999 + 7_000 = 999_999 < 1_000_000). The union carries the
    // row's stamped tabKey, so ONLY the grace clause decides this pin.
    let d = DeviceUnion {
        device_id: "d1".into(),
        union_doc: union_doc_with_tab_key(
            "d1",
            1_000_000,
            "d1:t1",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let drop_row = || {
        with_attribution(
            binding_row_at("claude", "S1", bound(), 992_999),
            "c1",
            "d1",
            "t1",
        )
    };
    let out = build_inventory(
        vec![d],
        vec![drop_row()],
        no_live(),
        &evidence(&[("d1", &[("c1", 1_000_000)])]), &no_closes());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "one ms before the grace boundary the row is dropped"
    );
    // recoverable false when the dropped row was the only candidate.
    let out = build_inventory(
        vec![],
        vec![drop_row()],
        no_live(),
        &evidence(&[("d1", &[("c1", 1_000_000)])]), &no_closes());
    assert_eq!(out["recoverable"], false);
    assert!(out["device"].is_null());
}

#[test]
fn row_attributed_to_a_non_primary_device_is_dropped() {
    // D8 device clause (review-round-1 cross-device pin in parent-relative
    // form): the row's parent client HAS surviving in-grace evidence — but
    // only the offer's PRIMARY device can offer rows. d1's evidence map also
    // names the row's client, so without the device-inequality clause the row
    // would be kept: the clause itself is load-bearing here.
    let newer = DeviceUnion {
        device_id: "d1".into(),
        union_doc: union_doc(
            "d1",
            2_000,
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let older = DeviceUnion {
        device_id: "d0".into(),
        union_doc: union_doc(
            "d0",
            1_000,
            json!([{ "paneId": "p0", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let mut row = with_attribution(
        binding_row_at("codex", "C9", bound(), 5_000),
        "c9",
        "d0",
        "t9",
    );
    // The delta-r2 placement clause (tabKey must name a primary-union tab)
    // SUBSUMES realistically-stamped non-primary rows (their device-composed
    // tabKey can never name a d1 tab). To keep THIS pin discriminating on the
    // device clause itself, the fixture carries a tabKey the primary union
    // HAS — a deliberately inconsistent (device d0 / tabKey k1) stamp.
    row.tab_key = Some("k1".to_string());
    let out = build_inventory(
        vec![newer, older],
        vec![row],
        no_live(),
        &evidence(&[("d0", &[("c9", 8_000)]), ("d1", &[("c9", 8_000)])]), &no_closes());
    assert_eq!(out["device"]["deviceId"], "d1"); // d0 is NON-primary
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "a row attributed to a non-primary device is dropped even in grace"
    );
}

#[test]
fn row_whose_parent_client_left_no_surviving_evidence_is_dropped() {
    // The stamped parent client is absent from the device's surviving set
    // (its generations were count-cap-evicted after a reload storm, or its
    // first boot died before its WS-ready push) — undecidable from retained
    // data, so never offered. The union carries the row's stamped tabKey, so
    // ONLY the parent-survivor clause decides this pin.
    let d = DeviceUnion {
        device_id: "d1".into(),
        union_doc: union_doc_with_tab_key(
            "d1",
            1_000_000,
            "d1:t1",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let row = with_attribution(
        binding_row_at("claude", "S1", bound(), 999_000),
        "c-gone",
        "d1",
        "t1",
    );
    let out = build_inventory(
        vec![d],
        vec![row],
        no_live(),
        &evidence(&[("d1", &[("c1", 1_000_000)])]), &no_closes());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "c-gone is not in the surviving set, so its rows are never offered"
    );
}

#[test]
fn attributed_row_whose_tab_key_matches_no_union_tab_is_dropped() {
    // Delta-r2 Finding 3 (placement exactness): the row is attributed, on the
    // primary device, its parent client survives selection, and it is within
    // grace — EVERY earlier D8 clause passes — but its stamped tabKey names a
    // tab that vanished from all retained evidence. Such a row is
    // deliberately EXCLUDED: the pre-fix trailing-tab fallback restored it
    // into an unrelated tab, and a pane whose whole TAB was created and lost
    // inside the sub-cadence push window is unplaceable from retained data.
    let d = DeviceUnion {
        device_id: "d1".into(),
        union_doc: union_doc_with_tab_key(
            "d1",
            1_000_000,
            "d1:t1",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    // 999_000 + 7_000 >= 1_000_000: within grace — the placement clause is
    // the ONLY failing one, so this pin re-fails if it is removed.
    let row = with_attribution(
        binding_row_at("claude", "S1", bound(), 999_000),
        "c1",
        "d1",
        "t-gone",
    );
    let out = build_inventory(
        vec![d],
        vec![row],
        no_live(),
        &evidence(&[("d1", &[("c1", 1_000_000)])]), &no_closes());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "a row whose stamped tabKey matches no union tab is never offered"
    );
    assert_eq!(
        out["recoverable"], true,
        "the union's own tab is still offered (only the unplaceable row drops)"
    );
}

#[test]
fn attributed_row_whose_union_tab_is_a_retained_closed_record_is_dropped() {
    // Focused-ep2-r1 Finding 1 (whitelist openness): the row is attributed,
    // on the primary device, its parent client survives, and it is within
    // grace — EVERY earlier D8 clause passes, and its stamped tabKey matches
    // a union record verbatim. But that record was persisted as
    // CLOSED-but-retained (`buildClosedTabRegistryRecord`,
    // src/lib/tab-registry-snapshot.ts; `shouldKeepClosedTab` retention): the
    // tab was NOT open in the restored evidence, so the row is unplaceable
    // and deliberately EXCLUDED — the pre-fix whitelist collected tabKeys
    // from EVERY primary-union record regardless of status.
    let d = DeviceUnion {
        device_id: "d1".into(),
        union_doc: json!({
            "deviceId": "d1", "deviceLabel": "label-d1", "capturedAt": 1_000_000,
            "records": [{ "tabKey": "d1:t1", "tabId": "t1", "tabName": "work",
                          "status": "closed", "revision": 1, "updatedAt": 1_000_000,
                          "closedAt": 1_000_000, "paneCount": 1,
                          "panes": [{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }] }]
        }),
    };
    // 999_000 + 7_000 >= 1_000_000: within grace — the openness clause is the
    // ONLY failing one, so this pin re-fails if the whitelist re-opens.
    let row = with_attribution(
        binding_row_at("claude", "S1", bound(), 999_000),
        "c1",
        "d1",
        "t1",
    );
    let out = build_inventory(
        vec![d],
        vec![row],
        no_live(),
        &evidence(&[("d1", &[("c1", 1_000_000)])]), &no_closes());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "a row stamped to a closed-but-retained union tab is never offered"
    );
}

#[test]
fn attributed_row_whose_union_tab_has_no_panes_is_dropped() {
    // Focused-ep2-r1 Finding 1 (whitelist paned-ness): every earlier D8
    // clause passes and the stamped tabKey names an OPEN union record — but
    // the record's `panes` array is EMPTY. The client's placement gate
    // (`placeLedgerEntries`, build-recovery-plan.ts) requires panes.length > 0
    // to join a row into a tab, so a server-side whitelist that admits the
    // zero-pane key misaligns the offer count from the accepted plan (the row
    // is offered, then silently unplaced). The server excludes it here.
    let d = DeviceUnion {
        device_id: "d1".into(),
        union_doc: json!({
            "deviceId": "d1", "deviceLabel": "label-d1", "capturedAt": 1_000_000,
            "records": [{ "tabKey": "d1:t1", "tabId": "t1", "tabName": "work",
                          "status": "open", "revision": 1, "updatedAt": 1_000_000,
                          "paneCount": 0, "panes": [] }]
        }),
    };
    let row = with_attribution(
        binding_row_at("claude", "S1", bound(), 999_000),
        "c1",
        "d1",
        "t1",
    );
    let out = build_inventory(
        vec![d],
        vec![row],
        no_live(),
        &evidence(&[("d1", &[("c1", 1_000_000)])]), &no_closes());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "a row stamped to a zero-pane union tab is never offered"
    );
}

#[test]
fn attributed_row_with_no_primary_device_is_dropped() {
    // No union has any records => no primary device => no evidence at all to
    // judge against: even an attributed, in-grace row is never offered.
    let d = DeviceUnion {
        device_id: "d1".into(),
        union_doc: json!({
            "deviceId": "d1", "deviceLabel": "label-d1", "capturedAt": 1_000_000,
            "records": []
        }),
    };
    let row = with_attribution(
        binding_row_at("claude", "S1", bound(), 999_000),
        "c1",
        "d1",
        "t1",
    );
    let out = build_inventory(
        vec![d],
        vec![row],
        no_live(),
        &evidence(&[("d1", &[("c1", 1_000_000)])]), &no_closes());
    assert!(out["device"].is_null());
    assert_eq!(out["ledgerOnly"].as_array().unwrap().len(), 0);
    assert_eq!(out["recoverable"], false);
}

#[test]
fn backward_clock_step_cannot_drop_a_kill_window_row() {
    // REVIEW-ROUND-2 ranking pin: parent "c1" retained rev1@capturedAt=1_000_000
    // AND rev2@capturedAt=900_000 (the server clock stepped backward between
    // pushes). The union's revision-first winner is rev2, so the parent's
    // "newest" is 900_000 — a raw capturedAt-max (1_000_000) would drop a row
    // bound right at the loss.
    let gens = vec![
        json!({"generationId": "g1", "clientInstanceId": "c1", "snapshotRevision": 1, "capturedAt": 1_000_000}),
        json!({"generationId": "g2", "clientInstanceId": "c1", "snapshotRevision": 2, "capturedAt": 900_000}),
    ];
    let selection = select_foreign_recent_generation_ids(&gens, "me", 1_000_001);
    assert_eq!(
        selection.winner_captured_at_by_client,
        vec![("c1".to_string(), 900_000u64)],
        "the parent's newest is the revision-first WINNER's capturedAt, not the capturedAt-max"
    );
    // End-to-end through the judgment: row_time 900_100 + 7_000 >= 900_000 => KEPT.
    let d = DeviceUnion {
        device_id: "d1".into(),
        union_doc: union_doc_with_tab_key(
            "d1",
            900_000,
            "d1:t1",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let row = with_attribution(
        binding_row_at("claude", "S1", bound(), 900_100),
        "c1",
        "d1",
        "t1",
    );
    let evidence: DeviceEvidence = vec![(
        "d1".to_string(),
        selection.winner_captured_at_by_client.clone(),
    )];
    let out = build_inventory(vec![d], vec![row], no_live(), &evidence, &no_closes());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        1,
        "a backward clock step must never drop a kill-window row"
    );
}

// ── Focused-ep4-r5 Finding 3: equal-revision selection honors the route's ──
// ordering contract. `read_device_overview` supplies each client's
// generations (revision, capturedAt)-DESCENDING (its `all_generations_parsed`
// per-client queue sorts `(snapshotRevision, capturedAt)` descending), so the
// FIRST matching entry of the final revision IS that revision's freshest
// stamp — the exact winner key the union composition's `newest_per_client`
// picks ((revision, capturedAt)-max per client), and judgment and offered
// union can never disagree. The superseded r4 rule (greater-or-equal
// replaces, i.e. the LAST array entry) read the run's LOWEST stamp off the
// descending feed — the two shapes disagreed by construction for
// re-delivered same-revision sets.

/// Generations fixture for the skew scenario: one client, push order.
fn skew_gen(id: &str, client: &str, revision: i64, captured_at: u64) -> serde_json::Value {
    json!({"generationId": id, "clientInstanceId": client,
           "snapshotRevision": revision, "capturedAt": captured_at})
}

#[test]
fn equal_revision_ties_keep_the_first_entry_of_the_final_revision_agreeing_with_the_union() {
    // THE FINDING, exercised on the route's actual shape: the parent's FINAL
    // revision 2 has a retained PRE-clock-step entry (capturedAt 1_000_000)
    // AND post-step re-deliveries (960_000, 950_000), fed the way
    // `read_device_overview` emits them — (revision, capturedAt)-descending.
    // The FIRST matching entry of the final revision (1_000_000) is the
    // revision's capturedAt-max — identical to the union's
    // `newest_per_client` winner key there, so the judgment and the offered
    // union can never disagree (the finding's whole point). The superseded r4
    // rule kept the LAST entry (950_000 on this feed).
    let gens = vec![
        skew_gen("g1", "c1", 2, 1_000_000), // FIRST on the descending feed — the run's max
        skew_gen("g3", "c1", 2, 960_000),
        skew_gen("g2", "c1", 2, 950_000),
    ];
    let union = || DeviceUnion {
        device_id: "d1".into(),
        union_doc: union_doc_with_tab_key(
            "d1",
            1_000_000,
            "d1:t1",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let row = || {
        with_attribution(binding_row_at("claude", "S1", bound(), 990_000), "c1", "d1", "t1")
    };
    // boot cutoff above every push: the A16 concurrent-client rule drops nothing.
    let selection = select_foreign_recent_generation_ids(&gens, "me", 2_000_000);
    assert_eq!(
        selection.winner_captured_at_by_client,
        vec![("c1".to_string(), 1_000_000u64)],
        "the FIRST matching entry of the final revision keys the clock — equal \
         to the revision's capturedAt-max on the descending feed"
    );
    // Judgment ≡ union: the composed union's newest for c1 IS the 1_000_000
    // generation (its revision-2 max), so a row attributed at 990_000 is
    // judged against that same 1_000_000 — and dropped (997_000 < 1_000_000).
    // The tradeoff DOES invert for re-delivered same-revision sets during a
    // backward wall-clock jump: the pinned HIGH stamp is union-consistent but
    // skew-inflated, so a row can be dropped up to a skew-magnitude EARLY
    // until the client's first REAL post-step push re-keys the clock (the
    // documented residual) — where the r4 rule kept it up to a skew long but
    // disagreed with the union the offer is actually built from.
    let evidence: DeviceEvidence = vec![(
        "d1".to_string(),
        selection.winner_captured_at_by_client.clone(),
    )];
    let out = build_inventory(vec![union()], vec![row()], no_live(), &evidence, &no_closes());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "990_000 + 7_000 < 1_000_000: judged against the union-consistent key — \
         the evidence the offer is built on has already observed the absence"
    );
    // The ep4-r4 skew property that survives intact: the first REAL post-step
    // push bumps the revision, and a greater revision wins outright no matter
    // where the retained pre-step entries sit — the clock re-keys to the
    // post-step stamp IMMEDIATELY (array order never matters across revisions).
    let mut gens_depinned = vec![skew_gen("g4", "c1", 3, 955_000)];
    gens_depinned.extend(gens.iter().cloned());
    let selection = select_foreign_recent_generation_ids(&gens_depinned, "me", 2_000_000);
    assert_eq!(
        selection.winner_captured_at_by_client,
        vec![("c1".to_string(), 955_000u64)],
        "the first real post-step push (a higher revision) re-keys the clock at once"
    );
    let evidence: DeviceEvidence = vec![(
        "d1".to_string(),
        selection.winner_captured_at_by_client.clone(),
    )];
    let out = build_inventory(vec![union()], vec![row()], no_live(), &evidence, &no_closes());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        1,
        "990_000 + 7_000 >= 955_000: against the post-step clock the row is back \
         within grace — the r4 keep-side semantics, now union-consistent"
    );
    // Closure: once a post-step push outruns the grace horizon the row is
    // dropped — the extension is bounded by the skew, nothing else.
    let mut gens_closed = vec![skew_gen("g5", "c1", 4, 998_000)];
    gens_closed.extend(gens_depinned.iter().cloned());
    let selection = select_foreign_recent_generation_ids(&gens_closed, "me", 2_000_000);
    assert_eq!(
        selection.winner_captured_at_by_client,
        vec![("c1".to_string(), 998_000u64)]
    );
    let evidence: DeviceEvidence = vec![(
        "d1".to_string(),
        selection.winner_captured_at_by_client.clone(),
    )];
    let out = build_inventory(vec![union()], vec![row()], no_live(), &evidence, &no_closes());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "998_000 > 990_000 + 7_000: the keep extension is bounded by the skew"
    );
    // Frozen mirror: WITHOUT any later pushes (evidence frozen at the pre-step
    // push alone, 1_000_000), a row within grace of it (attributed at
    // 994_000) can never be dropped — 1_001_000 >= 1_000_000. Unchanged
    // frozen-evidence semantics (first == max on the singleton set).
    let frozen = vec![skew_gen("g1", "c1", 2, 1_000_000)];
    let selection = select_foreign_recent_generation_ids(&frozen, "me", 2_000_000);
    assert_eq!(
        selection.winner_captured_at_by_client,
        vec![("c1".to_string(), 1_000_000u64)]
    );
    let frozen_row = with_attribution(
        binding_row_at("claude", "S1", bound(), 994_000),
        "c1",
        "d1",
        "t1",
    );
    let evidence: DeviceEvidence = vec![(
        "d1".to_string(),
        selection.winner_captured_at_by_client.clone(),
    )];
    let out = build_inventory(vec![union()], vec![frozen_row], no_live(), &evidence, &no_closes());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        1,
        "frozen evidence at 1_000_000 keeps a within-grace row unconditionally — \
         unchanged frozen-evidence semantics"
    );
}

#[test]
fn monotone_clocks_the_first_entry_of_the_final_revision_is_its_captured_at_max() {
    // No-skew equality pin on the route's descending order (replaces the
    // r4-era ascending-push fixture): clocks monotone => the FIRST matching
    // entry of the final revision IS its capturedAt-max — identical to the
    // union's winner key and to the pre-existing keep/drop matrix. The
    // 993_000 / 992_999 grace boundary re-judged against it.
    let gens = vec![
        skew_gen("g3", "c1", 2, 1_000_000), // FIRST on the descending feed == capturedAt-max
        skew_gen("g2", "c1", 2, 995_000),
        skew_gen("g1", "c1", 2, 990_000),
        skew_gen("g0", "c1", 1, 980_000), // older revision: its LATER position never replaces
    ];
    let selection = select_foreign_recent_generation_ids(&gens, "me", 2_000_000);
    assert_eq!(
        selection.winner_captured_at_by_client,
        vec![("c1".to_string(), 1_000_000u64)],
        "monotone clocks on the descending feed: first == max — no-skew judgments \
         are unchanged"
    );
    let union = || DeviceUnion {
        device_id: "d1".into(),
        union_doc: union_doc_with_tab_key(
            "d1",
            1_000_000,
            "d1:t1",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let evidence: DeviceEvidence = vec![(
        "d1".to_string(),
        selection.winner_captured_at_by_client.clone(),
    )];
    // 993_000 + 7_000 == 1_000_000: the boundary itself is KEPT (existing matrix).
    let kept = with_attribution(binding_row_at("claude", "S1", bound(), 993_000), "c1", "d1", "t1");
    let out = build_inventory(vec![union()], vec![kept], no_live(), &evidence, &no_closes());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        1,
        "the in-grace boundary judges exactly as before"
    );
    // 992_999 + 7_000 == 999_999 < 1_000_000: one ms outside is dropped.
    let dropped =
        with_attribution(binding_row_at("claude", "S2", bound(), 992_999), "c1", "d1", "t1");
    let out = build_inventory(vec![union()], vec![dropped], no_live(), &evidence, &no_closes());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "the out-of-grace boundary judges exactly as before"
    );
}

#[test]
fn equal_revision_keys_are_parent_relative_and_the_staleness_max_is_unchanged() {
    // Two-parent pin on the route's descending interleave (cross-client
    // capturedAt-descending; per-client (revision, capturedAt)-descending):
    // c1's final-revision run OPENS with its retained pre-step entry (the
    // run's capturedAt-max — also the union's winner key there), c2 is
    // no-skew, c3 sits 16 minutes behind. The keys stay PER PARENT (never
    // cross-parent-maxed) and the A15 staleness rule still reads the RAW
    // capturedAt-max per client.
    let t_high: u64 = 100_000_000;
    let gens = vec![
        skew_gen("c1a", "c1", 2, t_high), // c1's FIRST = its run's max
        skew_gen("c2a", "c2", 3, t_high - 20_000),
        skew_gen("c1c", "c1", 2, t_high - 40_000),
        skew_gen("c1b", "c1", 2, t_high - 50_000),
        // c3: 16 min behind the cross-parent max — staled out by A15 (the rule
        // still reads the raw capturedAt-max, NOT the equal-revision winner).
        skew_gen("c3a", "c3", 1, t_high - 16 * 60 * 1000),
    ];
    let selection = select_foreign_recent_generation_ids(&gens, "me", t_high + 1);
    let ids = &selection.selected_ids;
    assert!(ids.contains(&"c1a".to_string()) && ids.contains(&"c1c".to_string()));
    assert!(ids.contains(&"c2a".to_string()));
    assert!(
        !ids.contains(&"c3a".to_string()),
        "the A15 staleness rule still applies its cross-parent capturedAt-max: c3 \
         is staled against c1's raw newest ({t_high})"
    );
    assert_eq!(
        selection.winner_captured_at_by_client,
        vec![
            ("c1".to_string(), t_high),
            ("c2".to_string(), t_high - 20_000)
        ],
        "each parent's key is the FIRST entry of its own final revision — a \
         cross-parent max is never applied to the keys"
    );
    // The judgment stays PARENT-RELATIVE: c1's row at t_high-34_000 is dropped
    // against c1's own key (t_high-27_000 < t_high), and c2's row at
    // t_high-26_000 is KEPT against c2's own (t_high-19_000 >= t_high-20_000)
    // even though a cross-parent max (t_high) would drop it
    // (t_high-19_000 < t_high).
    let union = || DeviceUnion {
        device_id: "d1".into(),
        union_doc: union_doc_with_tab_key(
            "d1",
            t_high,
            "d1:t1",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let evidence: DeviceEvidence = vec![(
        "d1".to_string(),
        selection.winner_captured_at_by_client.clone(),
    )];
    let r1 = with_attribution(
        binding_row_at("claude", "S1", bound(), (t_high - 34_000) as i64),
        "c1",
        "d1",
        "t1",
    );
    let r2 = with_attribution(
        binding_row_at("claude", "S2", bound(), (t_high - 26_000) as i64),
        "c2",
        "d1",
        "t1",
    );
    let out = build_inventory(vec![union()], vec![r1, r2], no_live(), &evidence, &no_closes());
    let offered: Vec<&str> = out["ledgerOnly"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["sessionId"].as_str().unwrap())
        .collect();
    assert_eq!(
        offered,
        vec!["S2"],
        "rows judge against their OWN parent's key: c1's row is dropped \
         (t_high-27_000 < t_high) while c2's row keeps against c2's lower key — \
         a cross-parent max would drop it too"
    );
}

#[test]
fn route_overview_feed_orders_each_client_revision_first_descending_and_the_selection_agrees_with_the_union(
) {
    // Focused-ep4-r5 Finding 3 — verifying WHAT THE ROUTE EMITS FIRST: one
    // REAL `read_device_overview` round trip over on-disk generations. One
    // client holds a retained pre-step push at the final revision (rev 2 @
    // 1_000_000), two post-step re-deliveries of the SAME revision (960_000,
    // 950_000), and an older revision (rev 1 @ 980_000) — written in
    // scrambled disk order.
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    write_snapshot(dir, "dev1", "c1", 950_000, 2, json!([]));
    write_snapshot(dir, "dev1", "c1", 1_000_000, 2, json!([]));
    write_snapshot(dir, "dev1", "c1", 980_000, 1, json!([]));
    write_snapshot(dir, "dev1", "c1", 960_000, 2, json!([]));
    let (union, meta) = freshell_ws::tabs_persist::read_device_overview(dir, "dev1")
        .expect("readable store")
        .expect("the device has generations");
    let ordered: Vec<(i64, u64)> = meta
        .iter()
        .map(|g| {
            (
                g["snapshotRevision"].as_i64().unwrap_or(i64::MIN),
                g["capturedAt"].as_u64().unwrap_or(0),
            )
        })
        .collect();
    assert_eq!(
        ordered,
        vec![(2, 1_000_000u64), (2, 960_000), (2, 950_000), (1, 980_000)],
        "the route emits each client (revision, capturedAt)-DESCENDING — an \
         equal-revision run opens with its capturedAt-max"
    );
    // The selection against the REAL feed keys the first entry of the final
    // revision…
    let selection = select_foreign_recent_generation_ids(&meta, "me", 2_000_000);
    assert_eq!(
        selection.winner_captured_at_by_client,
        vec![("c1".to_string(), 1_000_000u64)],
        "first-in-descending-order for the final revision == that revision's capturedAt-max"
    );
    // …which IS the union's winner key (single client: the union's capturedAt
    // is that client's winner's).
    assert_eq!(
        union["capturedAt"].as_u64().unwrap(),
        1_000_000,
        "judgment and union agree on the production feed by construction"
    );
}

#[test]
fn stale_clients_generations_are_dropped() {
    // A15: any client silent >15 min (heartbeat is 5 min) is closed or rotated - drop it.
    let t_max: u64 = 100_000_000;
    let gens = vec![
        json!({"generationId": "gA", "clientInstanceId": "fresh", "capturedAt": t_max}),
        json!({"generationId": "gB", "clientInstanceId": "fresh", "capturedAt": t_max - 60_000}),
        json!({"generationId": "gC", "clientInstanceId": "stale", "capturedAt": t_max - 16 * 60 * 1000}),
        json!({"generationId": "gD", "clientInstanceId": "me",    "capturedAt": t_max}),
    ];
    // boot cutoff AFTER every push: the A16 concurrent-client rule drops nothing here.
    let ids = select_foreign_recent_generation_ids(&gens, "me", t_max + 1).selected_ids;
    assert!(ids.contains(&"gA".to_string()) && ids.contains(&"gB".to_string()));
    assert!(
        !ids.contains(&"gC".to_string()),
        "stale rotated client must not resurrect closed tabs"
    );
    assert!(
        !ids.contains(&"gD".to_string()),
        "requester's own generations are excluded"
    );
}

// ── Delta-r4 Finding 1: judgment time is attribution time, never write time ──
// A conn-less Inherit maintenance write (the auto-resume respawn sweep,
// terminal.rs's "Conn-less lane (D8)" arm) refreshes a row's `updated_at`
// without any browser asserting the pane. After the parent browser's evidence
// froze (its last retained push), such a refresh parked `row_time` past the
// frozen newest generation, so a long-closed detached pane's row kept
// clearing the grace lower bound and was offered again after every restart.

/// Delta-r4 Finding 1 fixture lane: REAL ledger writes, exactly the two write
/// shapes production composes — the connection-scoped create's `Replace` and
/// the respawn's conn-less `Inherit` — so the row under judgment carries
/// precisely the timestamps those lanes produce.
fn ledger_row_after_writes(steps: &[(ProvenancePolicy<'static>, i64)]) -> BindingRow {
    let tmp = tempfile::tempdir().unwrap();
    let ledger = PaneLedger::new(Some(tmp.path().to_path_buf()));
    let terminal = Box::leak(format!("t-steps-{}", std::process::id()).into_boxed_str());
    for (i, (provenance, now_ms)) in steps.iter().enumerate() {
        ledger
            .record_binding(&BindingWrite {
                provider: "claude",
                session_id: "S1",
                terminal_id: terminal,
                mode: "claude",
                cwd: Some("/w"),
                create_request_id: None,
                provenance: *provenance,
                now_ms: *now_ms,
            })
            .unwrap_or_else(|e| panic!("fixture write {i} failed: {e}"));
    }
    // The returned row is a memory clone; the tempdir may drop with the fn.
    ledger.load_binding("claude", "S1").expect("row written")
}

/// The connection-scoped create/stamp lane's exact policy shape (the WS
/// `bind_provenance` composition): `Replace` with the full stamp triple,
/// asserting at the write's own time (fresh creates: receipt ≈ write).
fn conn_scoped(
    client: &'static str,
    device: &'static str,
    tab_key: &'static str,
    asserted_at: i64,
) -> ProvenancePolicy<'static> {
    ProvenancePolicy::Replace(ProvenanceStamps {
        client_instance_id: Some(client),
        device_id: Some(device),
        tab_key: Some(tab_key),
        asserted_at,
    })
}

#[test]
fn inherit_maintenance_write_after_frozen_parent_evidence_never_revives_the_offer() {
    // THE FINDING end to end through real writes: the browser create stamps
    // the row at T0 (its parent evidence eventually freezes at F — the
    // browser's last retained push), then the auto-resume respawn's conn-less
    // Inherit write at T2 (server restart AFTER the pane was long detached)
    // refreshes `updated_at` to sit within grace of F. The judgment must
    // STILL exclude the row: a maintenance refresh is not a browser
    // re-assertion.
    let d = DeviceUnion {
        device_id: "d1".into(),
        union_doc: union_doc_with_tab_key(
            "d1",
            1_000_000,
            "d1:t1",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let row = ledger_row_after_writes(&[
        (conn_scoped("c1", "d1", "d1:t1", 900_000), 900_000),
        (ProvenancePolicy::Inherit, 995_000),
    ]);
    assert_eq!(row.updated_at, 995_000, "the maintenance write IS fresh");
    assert_eq!(row.created_at, 900_000, "the row BIRTH is the browser's");
    let out = build_inventory(
        vec![d],
        vec![row],
        no_live(),
        &evidence(&[("d1", &[("c1", 1_000_000)])]), &no_closes());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "900_000 + 7_000 < 1_000_000: the parent observed the absence long ago — \
         a conn-less maintenance refresh must not re-open the grace window"
    );
}

#[test]
fn genuine_attributed_rebind_advances_the_judgment_time() {
    // The keep-side twin (same real-lane fixture): a SECOND connection-scoped
    // write at T2 genuinely re-asserts the identity (an attributed re-bind —
    // the browser came back and claimed the pane), so it IS fresh evidence:
    // the same grace math that drops the Inherit-touched row keeps this one.
    let d = DeviceUnion {
        device_id: "d1".into(),
        union_doc: union_doc_with_tab_key(
            "d1",
            1_000_000,
            "d1:t1",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let row = ledger_row_after_writes(&[
        (conn_scoped("c1", "d1", "d1:t1", 900_000), 900_000),
        (conn_scoped("c1", "d1", "d1:t1", 995_000), 995_000),
    ]);
    assert_eq!(
        row.last_attributed_at,
        Some(995_000),
        "the re-bind advanced the attribution time"
    );
    let out = build_inventory(
        vec![d],
        vec![row],
        no_live(),
        &evidence(&[("d1", &[("c1", 1_000_000)])]), &no_closes());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        1,
        "995_000 + 7_000 >= 1_000_000: a genuine re-assertion keeps the kill-window semantics"
    );
}

#[test]
fn legacy_attached_row_without_a_tabkey_is_attributed_but_stays_unplaceable() {
    // Focused-ep4-r5 Finding 1 end to end through REAL ledger writes: a
    // legacy client (`freshAgent.* tabId` additive/optional) creates the
    // pane — client+device+assertion ride the wire, no tabKey. The row
    // ATTACHES that provenance (no prior attribution exists), so the ledger
    // no longer forgets a genuinely-open legacy pane wholesale. The D8
    // placement clause (unchanged) still requires the stamped tabKey to name
    // an OPEN, paned tab in the offer's union, so the attached-but-tab-less
    // row is never OFFERED — the documented ceiling for legacy clients.
    let row = ledger_row_after_writes(&[(
        ProvenancePolicy::Replace(ProvenanceStamps {
            client_instance_id: Some("c1"),
            device_id: Some("d1"),
            tab_key: None, // the legacy shape: no tabId on the wire
            asserted_at: 990_000,
        }),
        990_000,
    )]);
    assert_eq!(row.client_instance_id.as_deref(), Some("c1"));
    assert_eq!(row.device_id.as_deref(), Some("d1"));
    assert_eq!(row.tab_key, None, "the attach records what exists — no tab");
    assert_eq!(row.last_attributed_at, Some(990_000));
    let d = DeviceUnion {
        device_id: "d1".into(),
        union_doc: union_doc_with_tab_key(
            "d1",
            1_000_000,
            "d1:t1",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let out = build_inventory(
        vec![d],
        vec![row],
        no_live(),
        &evidence(&[("d1", &[("c1", 1_000_000)])]), &no_closes());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "in grace of its parent and attributed — but tab-less: unplaceable, \
         never offered (the legacy ceiling)"
    );
}

#[test]
fn a_delayed_pre_clear_assertion_never_resurrects_a_cleared_row_into_the_offer() {
    // Focused-ep4-r5 Finding 2 end to end through REAL ledger writes: the
    // browser create stamps the row (c1/d1:t1, asserted 900_000), a headless
    // lane CLEARS it at 950_000 (the attribution floor rises to the clear),
    // and a delayed gated create whose provenance was captured BEFORE the
    // clear (asserted 940_000) lands last. Pre-fix the cleared row had NO
    // time at all, so the delayed full-triple assertion passed the
    // absent-time arm and resurrected the stale browser stamps wholesale —
    // and the resurrected row judged IN GRACE of the resurrected parent and
    // reached the offer.
    let row = ledger_row_after_writes(&[
        (conn_scoped("c1", "d1", "d1:t1", 900_000), 900_000),
        (ProvenancePolicy::Clear, 950_000),
        (conn_scoped("c2", "d1", "d1:t2", 940_000), 960_000),
    ]);
    assert_eq!(
        row.client_instance_id, None,
        "the cleared stamps never come back"
    );
    assert_eq!(row.device_id, None);
    assert_eq!(row.tab_key, None);
    assert_eq!(
        row.last_attributed_at,
        Some(950_000),
        "the clear raises the floor (max(900_000, 950_000)); the delayed 940_000 \
         assertion is rejected against it"
    );
    // Pre-fix offerability shape: the resurrected row's stamps (c2, d1:t2)
    // plus time 940_000 judged against c2's evidence at 945_000
    // (940_000 + 7_000 >= 945_000) WITH d1:t2 open in the union — OFFERED
    // pre-fix, excluded post-fix (unattributed stamps gate).
    let d = DeviceUnion {
        device_id: "d1".into(),
        union_doc: union_doc_with_tab_key(
            "d1",
            945_000,
            "d1:t2",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let out = build_inventory(
        vec![d],
        vec![row],
        no_live(),
        &evidence(&[("d1", &[("c2", 945_000)])]), &no_closes());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "never offered: the judgment's stamps gate runs before the floored clock \
         is ever consulted"
    );
}

#[test]
fn the_judgment_time_is_the_attribution_time_not_the_last_write() {
    // Pure key pin (direct fixture — real writes always set updated_at ==
    // last_attributed_at on an attributed write, so only a fixture can
    // separate the two keys): updated_at/created_at BOTH sit far outside the
    // grace window, the attribution time inside. Offered iff the judgment
    // reads `last_attributed_at` and nothing else.
    let d = DeviceUnion {
        device_id: "d1".into(),
        union_doc: union_doc_with_tab_key(
            "d1",
            1_000_000,
            "d1:t1",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let mut row = with_attribution(binding_row("claude", "S1", bound()), "c1", "d1", "t1");
    assert_eq!(
        row.updated_at, 1_000,
        "fixture sanity: write time far out of grace"
    );
    row.last_attributed_at = Some(995_000);
    let out = build_inventory(
        vec![d],
        vec![row],
        no_live(),
        &evidence(&[("d1", &[("c1", 1_000_000)])]), &no_closes());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        1,
        "995_000 + 7_000 >= 1_000_000: the attribution time alone decides"
    );
}

#[test]
fn stamped_row_without_the_attribution_time_field_is_never_offered() {
    // Focused-ep4-r4 Finding 1 (the created_at fallback is DELETED): stamps
    // and `last_attributed_at` were introduced TOGETHER in this branch, so
    // the only stamped-but-fieldless rows are intermediate-branch-build dev
    // rows — and those can carry an invented-LATE `created_at` (a
    // marker-derived row's birth is its conn-less resolution time, long
    // after the pane closed). Falling back to `created_at` laundered exactly
    // those rows back into the offer. The attribution-based keep now
    // requires a PRESENT `last_attributed_at`: a fieldless stamped row is
    // excluded exactly like an unattributed one — no clock key, no offer, at
    // ANY `created_at` value.
    //
    // Arm 1 — late invented creation (within grace of the frozen evidence
    // 1_000_000): NOT offered. Pre-fix this arm WAS offered (the fallback
    // key 995_000 + 7_000 >= 1_000_000) — the finding's exact laundry.
    let d = || DeviceUnion {
        device_id: "d1".into(),
        union_doc: union_doc_with_tab_key(
            "d1",
            1_000_000,
            "d1:t1",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let mut row = binding_row_at("claude", "S1", bound(), 995_000);
    row.created_at = 995_000; // invented at the conn-less resolution, not a birth
    let row = with_attribution(row, "c1", "d1", "t1");
    let row = BindingRow {
        last_attributed_at: None, // the intermediate-build shape: stamps, no field
        ..row
    };
    let out = build_inventory(
        vec![d()],
        vec![row],
        no_live(),
        &evidence(&[("d1", &[("c1", 1_000_000)])]), &no_closes());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "a stamped row without `last_attributed_at` is never offered — the \
         created_at fallback must not launder an invented-late birth"
    );

    // Arm 2 — very old creation (long out of grace): NOT offered either
    // (green under both regimes; anchors that arm 1's exclusion — not the
    // time math — is what does the work).
    let mut row = binding_row_at("claude", "S2", bound(), 995_000);
    row.created_at = 900_000;
    let row = with_attribution(row, "c1", "d1", "t1");
    let row = BindingRow {
        last_attributed_at: None,
        ..row
    };
    let out = build_inventory(
        vec![d()],
        vec![row],
        no_live(),
        &evidence(&[("d1", &[("c1", 1_000_000)])]), &no_closes());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "a fieldless stamped row with an old created_at is likewise never offered"
    );

    // Arm 3 — the OTHER legacy shape: an unattributed row from old servers
    // (no stamps at all) is NOT offered (`unattributed_rows_are_never_offered`
    // carries the primary pin; this arm keeps the conjunction in one place:
    // NEITHER legacy shape is ever offered).
    let out = build_inventory(
        vec![d()],
        vec![binding_row_at("claude", "S3", bound(), 995_000)],
        no_live(),
        &evidence(&[("d1", &[("c1", 1_000_000)])]), &no_closes());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "an unattributed legacy row from old servers is never offered"
    );
}

/// Focused-ep4 Finding fixture lane: REAL marker + resolution writes, exactly
/// the two write shapes production composes for a dynamically-identified CLI
/// pane — the connection-scoped spawn's stamped `record_pending` and the
/// conn-less locator resolution's `resolve_pending(.., Inherit, ..)` — so the
/// row under judgment carries precisely the timestamps those lanes produce.
fn ledger_row_from_marker_resolution(
    spawn_ms: i64,
    resolve_ms: i64,
    tab_key: &'static str,
) -> BindingRow {
    let tmp = tempfile::tempdir().unwrap();
    let ledger = PaneLedger::new(Some(tmp.path().to_path_buf()));
    ledger
        .record_pending(
            "t-marker",
            "codex",
            Some("/w"),
            ProvenanceStamps {
                client_instance_id: Some("c1"),
                device_id: Some("d1"),
                tab_key: Some(tab_key),
                asserted_at: spawn_ms,
            },
            spawn_ms,
        )
        .expect("pending marker write");
    ledger
        .resolve_pending(&BindingWrite {
            provider: "codex",
            session_id: "S1",
            terminal_id: "t-marker",
            mode: "codex",
            cwd: Some("/w"),
            create_request_id: None,
            provenance: ProvenancePolicy::Inherit,
            now_ms: resolve_ms,
        })
        .expect("marker resolution write");
    // The returned row is a memory clone; the tempdir may drop with the fn.
    ledger.load_binding("codex", "S1").expect("row written")
}

#[test]
fn marker_derived_resolution_after_the_pane_closed_never_re_offers_it() {
    // THE FINDING end to end through real writes: the browser spawns a codex
    // CLI pane at 900_000 (the marker carries the spawn-time stamps), the pane
    // is closed and omitted by the parent's pushes, the parent's evidence
    // freezes at 1_000_000, and only THEN (1_100_000) does the conn-less
    // locator resolve the session id. The binding row is BORN at resolution
    // (`created_at`/`updated_at` = 1_100_000) but no browser asserted the pane
    // at that moment — the assertion is the marker's spawn. Neither the
    // resolution time nor the row's creation metadata may re-open the grace
    // window. (Scale note: the brief's schematic 1_000/1_500/2_000 collapses
    // into one 7s grace window — a pane born and closed entirely inside a
    // window is genuinely indistinguishable from one alive at freeze, so the
    // discriminating assertion needs a frozen newest more than one grace past
    // the spawn; the ordering marker-spawn < frozen < resolution is intact.)
    let d = DeviceUnion {
        device_id: "d1".into(),
        union_doc: union_doc_with_tab_key(
            "d1",
            1_000_000,
            "d1:t1",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let row = ledger_row_from_marker_resolution(900_000, 1_100_000, "d1:t1");
    assert_eq!(
        row.last_attributed_at,
        Some(900_000),
        "attribution is the marker's spawn time, not the resolve"
    );
    assert_eq!(
        row.created_at, 1_100_000,
        "the row is born at resolution — later than the frozen evidence"
    );
    assert_eq!(row.updated_at, 1_100_000, "the resolve write lands fresh");
    let out = build_inventory(
        vec![d],
        vec![row],
        no_live(),
        &evidence(&[("d1", &[("c1", 1_000_000)])]), &no_closes());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "900_000 + 7_000 < 1_000_000: an identity resolving after the pane \
         closed must not be offered — judgment time is the browser-asserted \
         attribution, never the row's resolution-time creation metadata"
    );
}

#[test]
fn marker_derived_resolution_within_grace_of_the_frozen_parent_is_offered() {
    // Keep-side twin (kill-window parity): a pane spawned 1s before the
    // parent's last push whose conn-less resolution lands AFTER the freeze
    // (server restarted before the locator ran) IS still offered — the
    // marker-time rule re-dates the attribution to the spawn but must not
    // over-tighten the sub-cadence window the grace exists for.
    let d = DeviceUnion {
        device_id: "d1".into(),
        union_doc: union_doc_with_tab_key(
            "d1",
            1_000_000,
            "d1:t1",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let row = ledger_row_from_marker_resolution(999_000, 1_100_000, "d1:t1");
    assert_eq!(row.last_attributed_at, Some(999_000));
    let out = build_inventory(
        vec![d],
        vec![row],
        no_live(),
        &evidence(&[("d1", &[("c1", 1_000_000)])]), &no_closes());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        1,
        "999_000 + 7_000 >= 1_000_000: a genuinely kill-window pane keeps, \
         resolution-time row birth notwithstanding"
    );
}

#[test]
fn an_attributed_rows_judgment_ignores_its_creation_time() {
    // Pure composition pin (the mirror of
    // `the_judgment_time_is_the_attribution_time_not_the_last_write`): an
    // attributed row whose CREATION metadata postdates the frozen evidence
    // must still judge on its attribution time alone. `last_attributed_at` is
    // browser-asserted and authoritative; `created_at` is row-keeping
    // metadata (resolution-time birth for marker-derived rows) and must never
    // floor the judgment back into the offer.
    let d = DeviceUnion {
        device_id: "d1".into(),
        union_doc: union_doc_with_tab_key(
            "d1",
            1_000_000,
            "d1:t1",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let mut row = with_attribution(
        binding_row_at("claude", "S1", bound(), 1_100_000),
        "c1",
        "d1",
        "t1",
    );
    row.created_at = 1_100_000; // resolution-time birth, past the frozen newest
    row.last_attributed_at = Some(900_000); // the browser's assertion, out of grace
    let out = build_inventory(
        vec![d],
        vec![row],
        no_live(),
        &evidence(&[("d1", &[("c1", 1_000_000)])]), &no_closes());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "900_000 + 7_000 < 1_000_000: an over-late created_at must not \
         re-launder an attributed row into the offer"
    );
}

// ── Focused-ep4-r2 Findings 1+2: the provenance value carries its assertion ──
// time; slow create/spawn/fork completion must not manufacture freshness.

/// Focused-ep4-r2 Pin (a): a FRESH-AGENT create whose provenance was captured
/// at WS receipt (T = 900_000) but whose binding write lands at T+30s
/// (930_000 — cold sidecar spawn + deferred SDK init) — the pane already
/// closed mid-flight and the parent's evidence (frozen at 1_000_000) never
/// observed it. The row must attribute at T (never T+30s) and the judgment
/// must then exclude it.
#[test]
fn fresh_agent_create_completed_after_the_pane_closed_is_never_offered() {
    let d = DeviceUnion {
        device_id: "d1".into(),
        union_doc: union_doc_with_tab_key(
            "d1",
            1_000_000,
            "d1:t1",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let tmp = tempfile::tempdir().unwrap();
    let ledger = PaneLedger::new(Some(tmp.path().to_path_buf()));
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            provider: "opencode",
            session_id: "S1",
            mode: "freshopencode",
            cwd: Some("/w"),
            create_request_id: None,
            model: None,
            sandbox: None,
            permission_mode: None,
            effort: None,
            supersedes: None,
            provenance: ProvenancePolicy::Replace(ProvenanceStamps {
                client_instance_id: Some("c1"),
                device_id: Some("d1"),
                tab_key: Some("d1:t1"),
                asserted_at: 900_000,
            }),
            now_ms: 930_000,
        })
        .expect("late landing binding write");
    let row = ledger.load_binding("opencode", "S1").expect("row written");
    assert_eq!(
        row.last_attributed_at,
        Some(900_000),
        "the value's assertion time — not the 30s-late write's now"
    );
    assert_eq!(row.updated_at, 930_000, "the write lands late, durably");
    let out = build_inventory(
        vec![d],
        vec![row],
        no_live(),
        &evidence(&[("d1", &[("c1", 1_000_000)])]), &no_closes());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "900_000 + 7_000 < 1_000_000: a create completed after the pane closed \
         judges on the receipt-time assertion — it is not offered"
    );
}

/// Keep-side twin of Pin (a): a create whose ASSERTION sits inside the
/// parent's kill window is still offered even though its write lands vastly
/// later — the late write must neither drop nor launder the row.
#[test]
fn fresh_agent_create_asserted_inside_the_kill_window_stays_offered_despite_a_late_write() {
    let d = DeviceUnion {
        device_id: "d1".into(),
        union_doc: union_doc_with_tab_key(
            "d1",
            1_000_000,
            "d1:t1",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let tmp = tempfile::tempdir().unwrap();
    let ledger = PaneLedger::new(Some(tmp.path().to_path_buf()));
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            provider: "opencode",
            session_id: "S1",
            mode: "freshopencode",
            cwd: Some("/w"),
            create_request_id: None,
            model: None,
            sandbox: None,
            permission_mode: None,
            effort: None,
            supersedes: None,
            provenance: ProvenancePolicy::Replace(ProvenanceStamps {
                client_instance_id: Some("c1"),
                device_id: Some("d1"),
                tab_key: Some("d1:t1"),
                asserted_at: 999_000,
            }),
            now_ms: 1_500_000,
        })
        .expect("late landing binding write");
    let row = ledger.load_binding("opencode", "S1").expect("row written");
    let out = build_inventory(
        vec![d],
        vec![row],
        no_live(),
        &evidence(&[("d1", &[("c1", 1_000_000)])]), &no_closes());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        1,
        "999_000 + 7_000 >= 1_000_000: a genuinely kill-window assertion keeps"
    );
}

/// Focused-ep4-r2 Pin (b): the TERMINAL post-spawn binding write
/// (terminal.rs's `create_meta_record` arm) — provenance captured at receipt
/// (900_000), the write landing after the spawn completes (930_000), the pane
/// closed while the spawn was in flight. Same judgment outcome as (a).
#[test]
fn terminal_post_spawn_write_completed_after_the_pane_closed_is_never_offered() {
    let d = DeviceUnion {
        device_id: "d1".into(),
        union_doc: union_doc_with_tab_key(
            "d1",
            1_000_000,
            "d1:t1",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let tmp = tempfile::tempdir().unwrap();
    let ledger = PaneLedger::new(Some(tmp.path().to_path_buf()));
    ledger
        .record_binding(&BindingWrite {
            provider: "claude",
            session_id: "S1",
            terminal_id: "t-post",
            mode: "claude",
            cwd: Some("/w"),
            create_request_id: Some("cr-1"),
            provenance: ProvenancePolicy::Replace(ProvenanceStamps {
                client_instance_id: Some("c1"),
                device_id: Some("d1"),
                tab_key: Some("d1:t1"),
                asserted_at: 900_000,
            }),
            now_ms: 930_000,
        })
        .expect("post-spawn binding write");
    let row = ledger.load_binding("claude", "S1").expect("row written");
    assert_eq!(
        row.last_attributed_at,
        Some(900_000),
        "the post-spawn write attributes at receipt, not at spawn completion"
    );
    let out = build_inventory(
        vec![d],
        vec![row],
        no_live(),
        &evidence(&[("d1", &[("c1", 1_000_000)])]), &no_closes());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "900_000 + 7_000 < 1_000_000: the post-spawn write cannot revive an \
         already-closed pane into the offer"
    );
}

/// Focused-ep4-r2 Pin (c) at inventory scale: supersession keeps the parent's
/// assertion time through the fake's own fork write — the fork child (conn-
/// less `Inherit`, `supersedes`) carries the stamps AND the time the parent
/// was last asserted with, so a fork landed after the freeze does not
/// re-enter the offer.
#[test]
fn supersession_after_the_freeze_judges_on_the_parents_assertion_time() {
    let d = DeviceUnion {
        device_id: "d1".into(),
        union_doc: union_doc_with_tab_key(
            "d1",
            1_000_000,
            "d1:t1",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let tmp = tempfile::tempdir().unwrap();
    let ledger = PaneLedger::new(Some(tmp.path().to_path_buf()));
    ledger
        .record_binding(&BindingWrite {
            provider: "codex",
            session_id: "parent-id",
            terminal_id: "t-parent",
            mode: "codex",
            cwd: Some("/w"),
            create_request_id: None,
            provenance: ProvenancePolicy::Replace(ProvenanceStamps {
                client_instance_id: Some("c1"),
                device_id: Some("d1"),
                tab_key: Some("d1:t1"),
                asserted_at: 900_000,
            }),
            now_ms: 900_000,
        })
        .expect("parent binding write");
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            provider: "codex",
            session_id: "child-id",
            mode: "freshcodex",
            cwd: Some("/w"),
            create_request_id: None,
            model: None,
            sandbox: None,
            permission_mode: None,
            effort: None,
            supersedes: Some("parent-id"),
            provenance: ProvenancePolicy::Inherit,
            now_ms: 1_500_000,
        })
        .expect("fork child binding write");
    let child = ledger.load_binding("codex", "child-id").expect("child row");
    assert_eq!(
        child.client_instance_id.as_deref(),
        Some("c1"),
        "stamps inherit"
    );
    assert_eq!(
        child.last_attributed_at,
        Some(900_000),
        "the assertion time inherits: the 1_500_000 fork write asserts nothing"
    );
    let out = build_inventory(
        vec![d],
        vec![child],
        no_live(),
        &evidence(&[("d1", &[("c1", 1_000_000)])]), &no_closes());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "a post-freeze supersession writes no new browser assertion, so the \
         child judges on the parent's time — not offered"
    );
}

// ── Focused-ep4-r3 Finding 1: out-of-order assertion never drags attribution ──
// Assertion time is captured at MESSAGE RECEIPT, before gated/async
// create/fork work — an older delayed write can land AFTER a newer assertion
// for the same session. The ledger applies provenance monotonically in
// `asserted_at`, so the row keeps the NEWER stamps+time and the pane is
// neither omitted (dragged out of its grace window) nor misplaced (dragged
// into the older assertion's tab).

#[test]
fn out_of_order_delayed_create_keeps_the_newer_tab_and_time() {
    // Real-write fixture (both writes are the WS connection-scoped lane's
    // exact shape): the row is attributed at 999_000 to tab t2 by the newer
    // create; a DELAYED write asserted 900_000 (tab t1 — its provenance was
    // captured at its own earlier receipt, then sat in the gated-restore
    // queue) lands at 995_000.
    let row = ledger_row_after_writes(&[
        (conn_scoped("c1", "d1", "d1:t2", 999_000), 999_000),
        (conn_scoped("c1", "d1", "d1:t1", 900_000), 995_000),
    ]);
    assert_eq!(
        row.last_attributed_at,
        Some(999_000),
        "the older delayed assertion never drags the attribution back"
    );
    assert_eq!(row.tab_key.as_deref(), Some("d1:t2"));
    assert_eq!(row.updated_at, 995_000, "the write itself still landed");

    // OMISSION arm: only t2 survives in the restored union — the pane is
    // offered into t2 (pre-fix: attribution dragged to (t1, 900_000) ⇒ out of
    // grace AND off-tab ⇒ the pane vanished from the offer).
    let d_only_t2 = DeviceUnion {
        device_id: "d1".into(),
        union_doc: union_doc_with_tab_key(
            "d1",
            1_000_000,
            "d1:t2",
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let out = build_inventory(
        vec![d_only_t2],
        vec![row.clone()],
        no_live(),
        &evidence(&[("d1", &[("c1", 1_000_000)])]), &no_closes());
    let offered = out["ledgerOnly"].as_array().unwrap();
    assert_eq!(
        offered.len(),
        1,
        "999_000 + 7_000 >= 1_000_000: the pane stays offered under its \
         NEWER attribution — the out-of-order write cannot drag it out of \
         the grace window"
    );
    assert_eq!(offered[0]["tabKey"], "d1:t2");

    // MISPLACEMENT arm: BOTH tabs survive in the union, and the delayed
    // assertion sits inside grace — the offered row still names t2, never
    // dragged back into the older assertion's tab t1 (pre-fix: tabKey t1).
    let row_in_grace = ledger_row_after_writes(&[
        (conn_scoped("c1", "d1", "d1:t2", 999_000), 999_000),
        (conn_scoped("c1", "d1", "d1:t1", 998_500), 999_500),
    ]);
    assert_eq!(row_in_grace.tab_key.as_deref(), Some("d1:t2"));
    let d_both = DeviceUnion {
        device_id: "d1".into(),
        union_doc: json!({
            "deviceId": "d1", "deviceLabel": "label-d1", "capturedAt": 1_000_000,
            "records": [
                { "tabKey": "d1:t1", "tabId": "t1", "tabName": "old", "revision": 1,
                  "updatedAt": 1_000_000, "paneCount": 1,
                  "panes": [{ "paneId": "px", "kind": "terminal", "payload": {"mode": "shell"} }] },
                { "tabKey": "d1:t2", "tabId": "t2", "tabName": "work", "revision": 1,
                  "updatedAt": 1_000_000, "paneCount": 1,
                  "panes": [{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }] },
            ]
        }),
    };
    let out = build_inventory(
        vec![d_both],
        vec![row_in_grace],
        no_live(),
        &evidence(&[("d1", &[("c1", 1_000_000)])]), &no_closes());
    let offered = out["ledgerOnly"].as_array().unwrap();
    assert_eq!(offered.len(), 1);
    assert_eq!(
        offered[0]["tabKey"], "d1:t2",
        "the pane joins the tab its NEWER assertion named — never dragged \
         back into the older assertion's tab"
    );
}

// ── Focused-ep3: bind-by-correlation (late-bound rows vs ref-less panes) ─────
// A codex/opencode CLI pane snapshotted BEFORE its provider identity resolved
// carries paneId/createRequestId/liveTerminal.terminalId but NO sessionRef
// (the association window; the terminal payload producer at
// src/lib/tab-registry-snapshot.ts:17-31 writes `sessionRef:
// content.sessionRef`, which JSON-serialization drops while it is still
// undefined). The attributed Bound row written at identity resolution then
// looks "unreferenced" and the client plan rebuilds BOTH the ref-less
// snapshot leaf (fresh, no resume) AND the row's resume leaf — two panes for
// one originally-open pane, one of them a never-open replacement session.
// Pass 1's bind-by-correlation rule re-attaches the row to ITS snapshot pane
// (one pane, restored WITH resume) and NEVER guesses on ambiguity.

/// Focused-ep3 fixture knob: stamp the advisory correlation ids the way the
/// ledger's real terminal-row writes do (`record_binding_locked`,
/// pane_ledger.rs:576-598 — `live_terminal_id` rides every terminal-row write;
/// `create_request_id` only the lanes that carry it — the conn-less
/// `ledger_resolve_identity` lane passes `None`, pane_ledger.rs:1297).
fn with_correlation_ids(
    mut row: BindingRow,
    create_request_id: Option<&str>,
    live_terminal_id: Option<&str>,
) -> BindingRow {
    row.create_request_id = create_request_id.map(str::to_string);
    row.live_terminal_id = live_terminal_id.map(str::to_string);
    row
}

#[test]
fn ref_less_pane_binds_to_its_late_bound_row_by_create_request_id() {
    // THE FINDING'S SCENARIO at the pure-builder level: the union pane was
    // snapshotted inside the association window (sessionRef absent). The
    // Bound row arrived after; correlation fires on the createRequestId match
    // + provider==mode coherence, and the pane behaves EXACTLY as if the
    // snapshot had claimed the row (ledgerState bound, sessionRef = the row's
    // identity, live via the D7 join) — and the row is referenced, excluded
    // from ledgerOnly.
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc_with_tab_key(
            "dev1",
            5_000,
            "dev1:t1",
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "codex", "createRequestId": "req-1",
                                  "liveTerminal": { "terminalId": "t-9", "serverInstanceId": "srv-x" } } }]),
        ),
    };
    // Attributed, in grace (1_000 + 7_000 >= 5_000), tabKey naming the union
    // tab: EVERY D8 clause would offer this row, so the referenced rule (fed
    // by the correlation) is the ONLY filter keeping it out of ledgerOnly —
    // the deciding clause under test, anti-vacuity.
    let row = with_attribution(
        with_correlation_ids(
            binding_row_at("codex", "C-assoc", bound(), 1_000),
            Some("req-1"),
            Some("t-9"),
        ),
        "c1",
        "dev1",
        "t1",
    );
    let out = build_inventory(
        vec![d],
        vec![row],
        no_live(),
        &evidence(&[("dev1", &[("c1", 5_000)])]), &no_closes());
    let panes = out["device"]["tabs"][0]["panes"].as_array().unwrap();
    assert_eq!(
        panes.len(),
        1,
        "one originally-open pane must restore as ONE pane, not two"
    );
    assert_eq!(panes[0]["ledgerState"], "bound");
    assert_eq!(panes[0]["sessionRef"]["provider"], "codex");
    assert_eq!(panes[0]["sessionRef"]["sessionId"], "C-assoc");
    assert_eq!(panes[0]["live"], false);
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "the correlated row is referenced — never ALSO offered as a ledgerOnly resume leaf"
    );
}

#[test]
fn ref_less_pane_binds_to_its_late_bound_row_by_live_terminal_id() {
    // The conn-less resolution lane (`ledger_resolve_identity`,
    // pane_ledger.rs:1277-1311) writes `create_request_id: None`, so for a
    // dynamically-identified codex/opencode CLI pane the createRequestId arm
    // can be ABSENT — the liveTerminal.terminalId arm is load-bearing for it.
    // The pane here carries NO createRequestId at all, isolating that arm.
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc_with_tab_key(
            "dev1",
            5_000,
            "dev1:t1",
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "opencode",
                                  "liveTerminal": { "terminalId": "t-9", "serverInstanceId": "srv-x" } } }]),
        ),
    };
    let row = with_attribution(
        with_correlation_ids(
            binding_row_at("opencode", "O-assoc", bound(), 1_000),
            None,
            Some("t-9"),
        ),
        "c1",
        "dev1",
        "t1",
    );
    let out = build_inventory(
        vec![d],
        vec![row],
        no_live(),
        &evidence(&[("dev1", &[("c1", 5_000)])]), &no_closes());
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(pane["ledgerState"], "bound");
    assert_eq!(pane["sessionRef"]["provider"], "opencode");
    assert_eq!(pane["sessionRef"]["sessionId"], "O-assoc");
    assert_eq!(out["ledgerOnly"].as_array().unwrap().len(), 0);
}

#[test]
fn correlation_requires_provider_mode_coherence() {
    // An id correlation with NO provider/mode match is a collision, not a
    // match: the row belongs to a different lineage and stays a ledgerOnly
    // candidate; the pane stays ref-less (never guess).
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc_with_tab_key(
            "dev1",
            5_000,
            "dev1:t1",
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "codex", "createRequestId": "req-1" } }]),
        ),
    };
    let row = with_attribution(
        with_correlation_ids(
            binding_row_at("claude", "S-other", bound(), 1_000),
            Some("req-1"), // the SAME advisory id, the WRONG provider
            None,
        ),
        "c1",
        "dev1",
        "t1",
    );
    let out = build_inventory(
        vec![d],
        vec![row],
        no_live(),
        &evidence(&[("dev1", &[("c1", 5_000)])]), &no_closes());
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(pane["ledgerState"], "unknown", "no coherence => no correlation");
    assert!(pane["sessionRef"].is_null());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        1,
        "the mode-mismatched row stays unreferenced and is D8-offered"
    );
}

#[test]
fn correlation_never_binds_fresh_agent_rows_or_panes() {
    // Both gates are load-bearing. Row side: an opencode FRESH-AGENT row's
    // provider IS "opencode", so provider==mode coherence alone would still
    // admit it — `pane_kind` (the row-side discriminator, pane_ledger.rs:121)
    // must exclude it. Pane side: a fresh-agent pane never has an association
    // window (its pre-association snapshots carry a PLACEHOLDER sessionRef,
    // not an absent one), and the `kind` gate must exclude it even against a
    // fabricated `mode` key (the real producer never writes `mode` on
    // fresh-agent payloads, tab-registry-snapshot.ts:45-64).
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc_with_tab_key(
            "dev1",
            5_000,
            "dev1:t1",
            json!([
                { "paneId": "p1", "kind": "terminal",
                  "payload": { "mode": "opencode", "createRequestId": "req-1" } },
                { "paneId": "p2", "kind": "fresh-agent",
                  "payload": { "mode": "opencode", "createRequestId": "req-2" } }
            ]),
        ),
    };
    let mut fresh_row = binding_row_at("opencode", "O-fresh", bound(), 1_000);
    fresh_row.mode = "freshopencode".into();
    fresh_row.pane_kind = Some("fresh-agent".into());
    let rows = vec![
        with_attribution(
            with_correlation_ids(fresh_row, Some("req-1"), None),
            "c1",
            "dev1",
            "t1",
        ),
        with_attribution(
            with_correlation_ids(
                binding_row_at("opencode", "O-term", bound(), 1_000),
                Some("req-2"),
                None,
            ),
            "c1",
            "dev1",
            "t1",
        ),
    ];
    let out = build_inventory(
        vec![d],
        rows,
        no_live(),
        &evidence(&[("dev1", &[("c1", 5_000)])]), &no_closes());
    let panes = out["device"]["tabs"][0]["panes"].as_array().unwrap();
    assert_eq!(
        panes[0]["ledgerState"], "unknown",
        "a fresh-agent ROW never correlates onto a terminal pane"
    );
    assert_eq!(
        panes[1]["ledgerState"], "unknown",
        "a fresh-agent PANE never correlates onto a terminal row"
    );
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        2,
        "both rows stay unreferenced"
    );
}

#[test]
fn two_bound_rows_sharing_the_panes_create_request_id_never_correlate() {
    // Ambiguity shape 1 (never guess): TWO Bound rows carry the same advisory
    // id as the ref-less pane. Correlating either would guess which session
    // the pane actually ran; leave the pane ref-less and BOTH rows
    // unreferenced instead. Focused-ep3-r2 Finding 1: ambiguity-TAINTED rows
    // are also EXCLUDED from the offer itself (never correlated, never
    // offered) — offering them replays the finding's exact three-panes-for-
    // one-open shape (ref-less snapshot leaf + one resume leaf per candidate).
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc_with_tab_key(
            "dev1",
            5_000,
            "dev1:t1",
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "codex", "createRequestId": "req-1" } }]),
        ),
    };
    let row = |session_id: &str| {
        with_attribution(
            with_correlation_ids(binding_row_at("codex", session_id, bound(), 1_000), Some("req-1"), None),
            "c1",
            "dev1",
            "t1",
        )
    };
    let out = build_inventory(
        vec![d],
        vec![row("C-a"), row("C-b")],
        no_live(),
        &evidence(&[("dev1", &[("c1", 5_000)])]), &no_closes());
    let panes = out["device"]["tabs"][0]["panes"].as_array().unwrap();
    assert_eq!(
        panes.len(),
        1,
        "the one originally-open pane restores as exactly ONE ref-less pane"
    );
    assert_eq!(panes[0]["ledgerState"], "unknown");
    assert!(panes[0]["sessionRef"].is_null());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "neither ambiguous row is consumed by the pane AND neither is offered \
         (ambiguity-tainted rows are suppressed — never correlated, never offered)"
    );
}

#[test]
fn pane_matching_two_rows_by_both_correlation_ids_never_correlates() {
    // Ambiguity shape 2: the pane's createRequestId arm names row A while its
    // liveTerminal arm names row B — inconsistent advisory data; never guess.
    // Focused-ep3-r2 Finding 1: both tainted rows are suppressed from the
    // offer too.
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc_with_tab_key(
            "dev1",
            5_000,
            "dev1:t1",
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "codex", "createRequestId": "req-1",
                                  "liveTerminal": { "terminalId": "t-9", "serverInstanceId": "srv-x" } } }]),
        ),
    };
    let rows = vec![
        with_attribution(
            with_correlation_ids(binding_row_at("codex", "C-a", bound(), 1_000), Some("req-1"), None),
            "c1",
            "dev1",
            "t1",
        ),
        with_attribution(
            with_correlation_ids(binding_row_at("codex", "C-b", bound(), 1_000), None, Some("t-9")),
            "c1",
            "dev1",
            "t1",
        ),
    ];
    let out = build_inventory(
        vec![d],
        rows,
        no_live(),
        &evidence(&[("dev1", &[("c1", 5_000)])]), &no_closes());
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(pane["ledgerState"], "unknown");
    assert!(pane["sessionRef"].is_null());
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "both id-arm candidates are ambiguity-tainted — suppressed, never offered"
    );
}

#[test]
fn one_row_matching_two_ref_less_panes_never_correlates_either() {
    // Ambiguity shape 3: the SAME row is the sole candidate for TWO ref-less
    // panes (duplicated generation components, a client-side clone — from
    // retained data it is undecidable which pane owned the session), so NEVER
    // guess either; a pane may bind only a row no other pane claims.
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc_with_tab_key(
            "dev1",
            5_000,
            "dev1:t1",
            json!([
                { "paneId": "p1", "kind": "terminal",
                  "payload": { "mode": "codex", "createRequestId": "req-1" } },
                { "paneId": "p2", "kind": "terminal",
                  "payload": { "mode": "codex", "createRequestId": "req-1" } }
            ]),
        ),
    };
    let out = build_inventory(
        vec![d],
        vec![with_attribution(
            with_correlation_ids(binding_row_at("codex", "C-assoc", bound(), 1_000), Some("req-1"), None),
            "c1",
            "dev1",
            "t1",
        )],
        no_live(),
        &evidence(&[("dev1", &[("c1", 5_000)])]), &no_closes());
    let panes = out["device"]["tabs"][0]["panes"].as_array().unwrap();
    assert_eq!(panes[0]["ledgerState"], "unknown");
    assert_eq!(panes[1]["ledgerState"], "unknown");
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "the contested row is ambiguity-tainted — suppressed, never offered \
         (focused-ep3-r2 Finding 1, row-side ambiguity direction)"
    );
}

#[test]
fn ambiguity_suppression_never_touches_rows_that_do_not_correlate() {
    // Focused-ep3-r2 Finding 1, the boundary pin: suppression reaches ONLY
    // rows that participate in an ambiguous correlation. A row NO ref-less
    // pane names is not tainted — it follows the normal D8 judgment end to
    // end (attributed + in grace + whitelisted tabKey => offered), so a
    // suppression comparator bug (e.g. a key-shape mismatch that suppresses
    // every row) re-fails this test.
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc_with_tab_key(
            "dev1",
            5_000,
            "dev1:t1",
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "codex", "createRequestId": "req-1" } }]),
        ),
    };
    let contested = |session_id: &str| {
        with_attribution(
            with_correlation_ids(binding_row_at("codex", session_id, bound(), 1_000), Some("req-1"), None),
            "c1",
            "dev1",
            "t1",
        )
    };
    let untouched = with_attribution(
        with_correlation_ids(binding_row_at("codex", "C-z", bound(), 1_000), Some("req-z"), None),
        "c1",
        "dev1",
        "t1",
    );
    let out = build_inventory(
        vec![d],
        vec![contested("C-a"), contested("C-b"), untouched],
        no_live(),
        &evidence(&[("dev1", &[("c1", 5_000)])]), &no_closes());
    let only = out["ledgerOnly"].as_array().unwrap();
    assert_eq!(
        only.len(),
        1,
        "only the NON-correlating row survives: the ambiguous pair is suppressed (got {only:?})"
    );
    assert_eq!(
        only[0]["sessionId"], "C-z",
        "the surviving entry is the unrelated row, under the normal D8 judgment"
    );
}

// ── Focused-ep3-r3: retired rows participate in correlation (closed-arm parity) ──
// The focused-ep3 correlation indices hold only Bound rows, but retirement
// (retire_closed / retire_missing / supersession) KEEPS the row's advisory
// create_request_id/live_terminal_id. A ref-less pane (snapshotted inside its
// identity-association window) whose identity was retired before the next
// snapshot correlated to NOTHING and reported ledgerState "unknown", even
// though the ledger authoritatively records where that identity ENDED. The
// retired tier closes the parity gap: an unambiguous retired correlation
// emits the SAME verdict shape the snapshot-claim arm's D4 chain (resolve())
// produces for that row's identity, with the row's identity standing in for
// the absent claim — Closed => ("closed", no ref); successor-less
// SessionMissing/GcExpired => ("gc_expired", row identity — the claim arm's
// keep-the-claim shape); Superseded => the chain's own verdict. Retired rows
// never reach ledgerOnly (the row_is_bound pre-filter, unchanged) and keep
// the bound tier's never-guess discipline (sole candidate AND sole claimant,
// counted only among panes with NO bound candidates).

#[test]
fn ref_less_pane_correlated_to_a_retired_closed_row_reports_closed() {
    // THE FINDING: the union pane was snapshotted inside its association
    // window; the identity then bound AND was explicitly killed
    // (terminal.kill -> retire_closed) before the next snapshot. The pane
    // must report the claim arm's closed-verdict shape (ledgerState "closed",
    // NO effective ref — the client rebuilds it fresh, exactly like the
    // established closed-with-ref arm) instead of "unknown". The retired row
    // stays out of ledgerOnly either way (the row_is_bound pre-filter is the
    // deciding filter for every retired row — attribution cannot change it),
    // and no second pane is planned (exactly one pane in, one pane out).
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc_with_tab_key(
            "dev1",
            5_000,
            "dev1:t1",
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "codex", "createRequestId": "req-1",
                                  "liveTerminal": { "terminalId": "t-9", "serverInstanceId": "srv-x" } } }]),
        ),
    };
    let row = with_correlation_ids(
        binding_row_at("codex", "C-killed", retired_closed(), 1_000),
        Some("req-1"),
        Some("t-9"),
    );
    let out = build_inventory(vec![d], vec![row], no_live(), &no_evidence(), &no_closes());
    let panes = out["device"]["tabs"][0]["panes"].as_array().unwrap();
    assert_eq!(
        panes.len(),
        1,
        "one originally-open pane must restore as ONE pane, not two"
    );
    assert_eq!(panes[0]["ledgerState"], "closed");
    assert!(
        panes[0]["sessionRef"].is_null(),
        "closed verdict carries NO effective ref — the claim arm's Closed shape"
    );
    assert_eq!(panes[0]["live"], false);
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "the closed row is NOT in ledgerOnly (retired rows are already excluded — it stays so)"
    );
}

#[test]
fn ref_less_pane_correlated_to_a_session_missing_row_reports_gc_expired() {
    // Per-reason disposition — SessionMissing: the identity is over (the
    // session file vanished provider-side) but NOT by an observed user close.
    // resolve()'s established verdict for a successor-less non-closed
    // terminus is GcExpired, so the correlated pane reports exactly the claim
    // arm's GcExpired shape: ledgerState "gc_expired" with the effective ref
    // KEPT — the correlated row's identity stands in for the absent claim,
    // exactly as the claim arm keeps the original snapshot claim. Isolated to
    // the liveTerminal arm (the conn-less lane writes create_request_id: None).
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc_with_tab_key(
            "dev1",
            5_000,
            "dev1:t1",
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "opencode",
                                  "liveTerminal": { "terminalId": "t-7", "serverInstanceId": "srv-x" } } }]),
        ),
    };
    let row = with_correlation_ids(
        binding_row_at("opencode", "O-gone", retired_session_missing(), 1_000),
        None,
        Some("t-7"),
    );
    let out = build_inventory(vec![d], vec![row], no_live(), &no_evidence(), &no_closes());
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(pane["ledgerState"], "gc_expired");
    assert_eq!(pane["sessionRef"]["provider"], "opencode");
    assert_eq!(
        pane["sessionRef"]["sessionId"], "O-gone",
        "the claim arm keeps the original claim for gc_expired — the correlated row's identity is that claim"
    );
    assert_eq!(pane["live"], false);
    assert_eq!(out["ledgerOnly"].as_array().unwrap().len(), 0);
}

#[test]
fn ref_less_pane_correlated_to_a_gc_expired_row_reports_gc_expired() {
    // Per-reason disposition — GcExpired: "gc_expired rows are the old dates"
    // (a Bound row unobserved for the 30-day sweep TTL, tombstoned by the GC).
    // The correlation still reports the ledger's authoritative terminus
    // verdict for the pane's identity — GcExpired, the SAME verdict a stale
    // snapshot CLAIM would resolve to through this row (resolve() does not
    // distinguish how the row came to the pane's attention).
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc_with_tab_key(
            "dev1",
            5_000,
            "dev1:t1",
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "codex", "createRequestId": "req-old" } }]),
        ),
    };
    let row = with_correlation_ids(
        binding_row_at("codex", "C-old", retired_gc_expired(), 1_000),
        Some("req-old"),
        None,
    );
    let out = build_inventory(vec![d], vec![row], no_live(), &no_evidence(), &no_closes());
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(pane["ledgerState"], "gc_expired");
    assert_eq!(pane["sessionRef"]["provider"], "codex");
    assert_eq!(pane["sessionRef"]["sessionId"], "C-old");
    assert_eq!(out["ledgerOnly"].as_array().unwrap().len(), 0);
}

#[test]
fn ref_less_pane_correlated_to_a_superseded_row_forwards_to_the_successor_verdict() {
    // Per-reason disposition — Superseded: "superseded rows forward through
    // resolve()". The pane's identity did not END, it MOVED (session switch
    // on a new terminal): S1 retired-superseded keeps the OLD terminal's
    // advisory ids; the Bound successor S2 was bound on a NEW terminal (its
    // advisory ids do NOT match the pane), so the retired arm is the ONLY
    // correlation. resolve(S1) walks to S2 and answers the chain's own
    // verdict — Bound(S2): the pane behaves exactly as if the snapshot had
    // claimed S1 (the claim arm's D4 chain shape). S2 is attributed + in
    // grace + tabKey-matched, so ONLY the referenced rule (fed by the
    // forwarded bind) keeps it out of ledgerOnly — anti-vacuity.
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc_with_tab_key(
            "dev1",
            5_000,
            "dev1:t1",
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "claude", "createRequestId": "req-1",
                                  "liveTerminal": { "terminalId": "t-1", "serverInstanceId": "srv-x" } } }]),
        ),
    };
    let rows = vec![
        with_correlation_ids(
            binding_row_at("claude", "S1", retired_superseded_by("claude", "S2"), 1_000),
            Some("req-1"),
            Some("t-1"),
        ),
        with_attribution(
            with_correlation_ids(
                binding_row_at("claude", "S2", bound(), 1_000),
                None,
                Some("t-2"), // the NEW terminal — the pane's ids never reach S2 directly
            ),
            "c1",
            "dev1",
            "t1",
        ),
    ];
    let out = build_inventory(
        vec![d],
        rows,
        no_live(),
        &evidence(&[("dev1", &[("c1", 5_000)])]), &no_closes());
    let panes = out["device"]["tabs"][0]["panes"].as_array().unwrap();
    assert_eq!(panes.len(), 1);
    assert_eq!(panes[0]["ledgerState"], "bound");
    assert_eq!(panes[0]["sessionRef"]["provider"], "claude");
    assert_eq!(
        panes[0]["sessionRef"]["sessionId"], "S2",
        "the superseded correlation forwards to the chain's Bound verdict, successor identity"
    );
    assert_eq!(panes[0]["live"], false);
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "S1 is retired (never offered); S2 is referenced via the forwarded bind, not ledger-only"
    );
}

#[test]
fn ref_less_pane_correlated_to_a_superseded_row_with_a_closed_terminus_reports_closed() {
    // The forwarding walk ends wherever the CHAIN ends: S1 superseded -> S2,
    // and S2 itself retired-closed. resolve()'s verdict for the pane's
    // identity is therefore Closed — the same ("closed", no effective ref)
    // shape as the finding's direct closed-row correlation.
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc_with_tab_key(
            "dev1",
            5_000,
            "dev1:t1",
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "claude", "createRequestId": "req-1",
                                  "liveTerminal": { "terminalId": "t-1", "serverInstanceId": "srv-x" } } }]),
        ),
    };
    let rows = vec![
        with_correlation_ids(
            binding_row_at("claude", "S1", retired_superseded_by("claude", "S2"), 1_000),
            Some("req-1"),
            Some("t-1"),
        ),
        with_correlation_ids(
            binding_row_at("claude", "S2", retired_closed(), 1_000),
            None,
            Some("t-2"),
        ),
    ];
    let out = build_inventory(vec![d], rows, no_live(), &no_evidence(), &no_closes());
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(pane["ledgerState"], "closed");
    assert!(pane["sessionRef"].is_null());
    assert_eq!(out["ledgerOnly"].as_array().unwrap().len(), 0);
}

#[test]
fn retired_row_correlation_requires_provider_mode_coherence() {
    // The retired tier keeps the coherence gates verbatim (the SAME
    // correlation_candidates): an id match with the WRONG provider/mode is a
    // collision, not a match — NO correlation at all; the pane falls to the
    // unknown arm. (The retired row is never offered either way — retired
    // rows never reach the offer pipeline.)
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc_with_tab_key(
            "dev1",
            5_000,
            "dev1:t1",
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "codex", "createRequestId": "req-1" } }]),
        ),
    };
    let row = with_correlation_ids(
        binding_row_at("claude", "S-killed", retired_closed(), 1_000),
        Some("req-1"), // the SAME advisory id, the WRONG provider
        None,
    );
    let out = build_inventory(vec![d], vec![row], no_live(), &no_evidence(), &no_closes());
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(pane["ledgerState"], "unknown", "no coherence => no correlation");
    assert!(pane["sessionRef"].is_null());
    assert_eq!(out["ledgerOnly"].as_array().unwrap().len(), 0);
}

#[test]
fn retired_fresh_agent_rows_never_correlate() {
    // The row-side `pane_kind` gate applies to the retired tier too: a retired
    // FRESH-AGENT row is never a verdict source for a terminal pane. The
    // fixture mirrors the bound tier's guard — the row's provider DOES equal
    // the pane's mode, so `pane_kind.is_none()` is the ONLY gate excluding it.
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc_with_tab_key(
            "dev1",
            5_000,
            "dev1:t1",
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "opencode", "createRequestId": "req-1" } }]),
        ),
    };
    let mut fresh_row = binding_row_at("opencode", "O-fresh", retired_closed(), 1_000);
    fresh_row.mode = "freshopencode".into();
    fresh_row.pane_kind = Some("fresh-agent".into());
    let row = with_correlation_ids(fresh_row, Some("req-1"), None);
    let out = build_inventory(vec![d], vec![row], no_live(), &no_evidence(), &no_closes());
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(
        pane["ledgerState"], "unknown",
        "a retired fresh-agent ROW never correlates onto a terminal pane"
    );
    assert!(pane["sessionRef"].is_null());
    assert_eq!(out["ledgerOnly"].as_array().unwrap().len(), 0);
}

#[test]
fn two_retired_rows_sharing_the_panes_create_request_id_never_correlate() {
    // The retired tier keeps the campaign's never-guess discipline, pane-side:
    // TWO retired rows named by the one ref-less pane => NO verdict at all
    // (the unknown arm) — never a coin flip between two ended identities.
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc_with_tab_key(
            "dev1",
            5_000,
            "dev1:t1",
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "codex", "createRequestId": "req-1" } }]),
        ),
    };
    let row = |session_id: &str| {
        with_correlation_ids(
            binding_row_at("codex", session_id, retired_closed(), 1_000),
            Some("req-1"),
            None,
        )
    };
    let out = build_inventory(
        vec![d],
        vec![row("C-a"), row("C-b")],
        no_live(),
        &no_evidence(), &no_closes());
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(pane["ledgerState"], "unknown");
    assert!(pane["sessionRef"].is_null());
    assert_eq!(out["ledgerOnly"].as_array().unwrap().len(), 0);
}

#[test]
fn one_retired_row_matching_two_ref_less_panes_never_correlates_either() {
    // Row-side symmetry with the bound tier's claim census: a retired row
    // claimed by TWO ref-less panes (duplicated generation components — from
    // retained data it is undecidable which pane owned the identity) binds
    // NEITHER. The census counts claims only among panes with NO bound
    // candidates — the ones that will actually take the retired arm.
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc_with_tab_key(
            "dev1",
            5_000,
            "dev1:t1",
            json!([
                { "paneId": "p1", "kind": "terminal",
                  "payload": { "mode": "codex", "createRequestId": "req-1" } },
                { "paneId": "p2", "kind": "terminal",
                  "payload": { "mode": "codex", "createRequestId": "req-1" } }
            ]),
        ),
    };
    let out = build_inventory(
        vec![d],
        vec![with_correlation_ids(
            binding_row_at("codex", "C-killed", retired_closed(), 1_000),
            Some("req-1"),
            None,
        )],
        no_live(),
        &no_evidence(), &no_closes());
    let panes = out["device"]["tabs"][0]["panes"].as_array().unwrap();
    assert_eq!(panes[0]["ledgerState"], "unknown");
    assert_eq!(panes[1]["ledgerState"], "unknown");
    assert_eq!(out["ledgerOnly"].as_array().unwrap().len(), 0);
}

// ── Task 2: `GET /api/recovery/inventory` route tests ─────────────────────────

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;

/// Snapshot fixture written directly with the store's REAL layout —
/// `<dir>/<device>/<client>-<capturedAt:020>-r<rev:012>.json` (alphanumeric
/// device/client ids need no escaping).
fn write_snapshot(
    dir: &std::path::Path,
    device: &str,
    client: &str,
    captured_at: u64,
    rev: u64,
    records: serde_json::Value,
) {
    let doc = json!({
        "deviceId": device, "deviceLabel": format!("label-{device}"), "clientInstanceId": client,
        "serverInstanceId": "srv-test", "snapshotRevision": rev, "capturedAt": captured_at,
        "records": records
    });
    let d = dir.join(device);
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(
        d.join(format!("{client}-{captured_at:020}-r{rev:012}.json")),
        serde_json::to_vec(&doc).unwrap(),
    )
    .unwrap();
}

// Fresh EMPTY terminal registry — constructed exactly the way main.rs:249 does;
// no running terminals => every pane comes back `live: false`.
fn test_registry() -> freshell_terminal::TerminalRegistry {
    freshell_terminal::TerminalRegistry::new()
}

fn test_state(
    dir: Option<std::path::PathBuf>,
    ledger_root: Option<std::path::PathBuf>,
) -> RecoveryInventoryState {
    RecoveryInventoryState {
        auth_token: "tok".into(),
        snapshots_dir: dir,
        ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new_locked(
            ledger_root,
        )),
        registry: test_registry(),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
    }
}

async fn get(
    router: axum::Router,
    uri: &str,
    auth: Option<&str>,
) -> (StatusCode, serde_json::Value) {
    let mut req = Request::builder().method("GET").uri(uri);
    if let Some(token) = auth {
        req = req.header("x-auth-token", token);
    }
    let resp = router
        .oneshot(req.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
    )
}

#[tokio::test]
async fn route_requires_auth_and_serves_inventory() {
    let tmp = tempfile::tempdir().unwrap();
    write_snapshot(
        tmp.path(),
        "dev1",
        "clientA",
        1000,
        1,
        json!([
            {"tabKey":"k1","tabId":"t1","tabName":"work","status":"open","revision":1,"updatedAt":1000,
             "paneCount":1,"panes":[{"paneId":"p1","kind":"terminal","payload":{"mode":"shell","initialCwd":"/w"}}]}
        ]),
    );
    let router = router(test_state(Some(tmp.path().to_path_buf()), None));
    // house convention: 401 case asserted alongside the happy path
    let (code, _) = get(
        router.clone(),
        "/api/recovery/inventory?clientInstanceId=me",
        None,
    )
    .await;
    assert_eq!(code, axum::http::StatusCode::UNAUTHORIZED);
    let (code, body) = get(
        router,
        "/api/recovery/inventory?clientInstanceId=me",
        Some("tok"),
    )
    .await;
    assert_eq!(code, axum::http::StatusCode::OK);
    assert_eq!(body["recoverable"], true);
    assert_eq!(body["device"]["deviceId"], "dev1");
    assert_eq!(body["device"]["tabs"][0]["panes"][0]["cwd"], "/w");
}

#[tokio::test]
async fn route_excludes_requesting_clients_own_generations() {
    let tmp = tempfile::tempdir().unwrap();
    write_snapshot(
        tmp.path(),
        "dev1",
        "oldclient",
        1000,
        1,
        json!([
            {"tabKey":"k1","tabId":"t1","tabName":"work","status":"open","revision":1,"updatedAt":1000,
             "paneCount":1,"panes":[{"paneId":"p1","kind":"terminal","payload":{"mode":"shell"}}]}
        ]),
    );
    write_snapshot(
        tmp.path(),
        "dev1",
        "me",
        2000,
        1,
        json!([
            {"tabKey":"junk","tabId":"tj","tabName":"junk","status":"open","revision":1,"updatedAt":2000,
             "paneCount":1,"panes":[{"paneId":"pj","kind":"terminal","payload":{"mode":"shell"}}]}
        ]),
    );
    let router = router(test_state(Some(tmp.path().to_path_buf()), None));
    let (_, body) = get(
        router,
        "/api/recovery/inventory?clientInstanceId=me",
        Some("tok"),
    )
    .await;
    let tabs = body["device"]["tabs"].as_array().unwrap();
    assert!(
        tabs.iter().all(|t| t["tabKey"] != "junk"),
        "requester's own push must be filtered out"
    );
    assert!(tabs.iter().any(|t| t["tabKey"] == "k1"));
}

#[tokio::test]
async fn route_never_offers_ledger_only_rows_without_parent_evidence() {
    // D8 route-level contract (deliberate rewrite of the old blanket-contract
    // test `route_serves_ledger_only_recovery_without_snapshots`): with NO
    // surviving snapshot evidence nothing unreferenced is offered, for BOTH
    // (case 1) an unattributed Bound row (pre-upgrade / headless shape) and
    // (case 2) an attributed row whose stamped parent left no snapshot content.
    let home = tempfile::tempdir().unwrap();
    let broot = home.path().join("pane-ledger");
    std::fs::create_dir_all(broot.join("bindings").join("claude")).unwrap();
    let seed = |session_id: &str, extra: serde_json::Value| {
        let mut row = json!({
            "ledgerVersion": 1, "provider": "claude", "sessionId": session_id, "mode": "claude",
            "cwd": "/w", "createdAt": 1, "updatedAt": 1, "lastObservedAt": 1, "state": "bound"
        });
        row.as_object_mut().unwrap().extend(
            extra
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), v.clone())),
        );
        std::fs::write(
            broot
                .join("bindings")
                .join("claude")
                .join(format!("{session_id}.json")),
            serde_json::to_vec(&row).unwrap(),
        )
        .unwrap();
    };
    seed("S1", json!({})); // case 1: unattributed
    seed(
        "S2", // case 2: attributed, but its parent "c1"/"d0" has no snapshot content at all
        json!({ "clientInstanceId": "c1", "deviceId": "d0", "tabKey": "d0:t1" }),
    );
    let router = router(test_state(None, Some(broot)));
    let (code, body) = get(
        router,
        "/api/recovery/inventory?clientInstanceId=me",
        Some("tok"),
    )
    .await;
    assert_eq!(code, axum::http::StatusCode::OK);
    assert_eq!(
        body["recoverable"], false,
        "no snapshot evidence => nothing unreferenced is offered (got {body})"
    );
    assert_eq!(body["device"], serde_json::Value::Null);
    assert_eq!(body["ledgerOnly"].as_array().unwrap().len(), 0);
}

/// Focused-episode-6 round 3, Finding 2 — the headline pin: close evidence
/// + its snapshot BOTH retained across the TTL edge → the verdict stays
/// `closed` (never re-offered). The chain: a real retained generation
/// references the closed pane's `createRequestId`; the REAL
/// `retained_snapshot_references` scan feeds the ledger's periodic GC at
/// +6h; the record (and its fences) survive; the route still verdicts the
/// pane closed.
#[tokio::test]
async fn a_close_record_and_its_snapshot_both_survive_the_ttl_edge_and_the_verdict_stays_closed() {
    // An OLD retained snapshot whose terminal pane carries the closed pane's
    // createRequestId (snapshots prune by COUNT, never by age — this
    // generation can sit retained indefinitely).
    let tmp = tempfile::tempdir().unwrap();
    write_snapshot(
        tmp.path(),
        "dev1",
        "oldclient",
        1_000_000,
        1,
        json!([
            {"tabKey":"dev1:t1","tabId":"t1","tabName":"work","status":"open","revision":1,"updatedAt":1_000_000,
             "paneCount":1,"panes":[{"paneId":"p1","kind":"terminal",
               "payload":{"mode":"codex",
                          "createRequestId":"cr-closed",
                          "sessionRef":{"provider":"codex","sessionId":"sess-closed"},
                          "liveTerminal":{"terminalId":"term-closed","serverInstanceId":"srv-1"}}}]}
        ]),
    );
    // The pane was closed pre-loss: the close record + row retire persist.
    let home = tempfile::tempdir().unwrap();
    let broot = home.path().join("pane-ledger");
    let seeder = freshell_ws::pane_ledger::PaneLedger::new(Some(broot.clone()));
    seeder
        .close_pane(&freshell_ws::pane_ledger::PaneCloseWrite {
            terminal_id: "term-closed".to_string(),
            create_request_id: Some("cr-closed".to_string()),
            resolved: vec![freshell_protocol::SessionLocator {
                provider: "codex".into(),
                session_id: "sess-closed".into(),
            }],
            now_ms: 1_000_100,
        })
        .expect("the close persists");
    drop(seeder);

    // The periodic GC runs at +TTL with the REAL scan of the retained store:
    // the close evidence MUST survive (reference-time retention).
    let refs =
        freshell_ws::tabs_persist::retained_snapshot_references(tmp.path()).expect("scan io");
    let sweeper = freshell_ws::pane_ledger::PaneLedger::new(Some(broot.clone()));
    let aged = 1_000_100 + freshell_ws::pane_ledger::KILL_TOMBSTONE_TTL_MS + 60_000;
    let report = sweeper.gc(aged, &|_, _| false, None, Some(&refs));
    assert!(
        report.pane_closes_swept.is_empty(),
        "referenced close evidence never prunes across the TTL edge: {:?}",
        report.pane_closes_swept
    );
    assert!(
        sweeper.kill_tombstone_at("codex", "sess-closed").is_some(),
        "the fence survives with its record"
    );
    drop(sweeper);

    let router = router(test_state(Some(tmp.path().to_path_buf()), Some(broot)));
    let (code, body) = get(
        router,
        "/api/recovery/inventory?clientInstanceId=me",
        Some("tok"),
    )
    .await;
    assert_eq!(code, axum::http::StatusCode::OK);
    let panes = body["device"]["tabs"][0]["panes"].as_array().unwrap();
    assert_eq!(
        panes[0]["ledgerState"], "closed",
        "the verdict stays closed across the TTL edge: {body}"
    );
    assert!(panes[0]["sessionRef"].is_null());

    // Counterfactual hinge: the SAME gc over a store that references nothing
    // prunes the record (the TTL still bounds unreferenced evidence).
    let mut refs = freshell_ws::tabs_persist::RetainedSnapshotReferences::default();
    refs.claims.clear();
    let sweeper = freshell_ws::pane_ledger::PaneLedger::new(Some(
        home.path().join("pane-ledger"),
    ));
    let report = sweeper.gc(aged, &|_, _| false, None, Some(&refs));
    assert!(
        report
            .pane_closes_swept
            .contains(&"pane:term-closed".to_string()),
        "unreferenced + fully aged prunes: {:?}",
        report.pane_closes_swept
    );
}

/// Focused-episode-6 round 3, Finding 1 — the end-to-end pin: a fresh-agent
/// (opencode) pane killed BEFORE its first send holds no row, only the
/// placeholder-keyed close evidence the kill's envelope writes; a retained
/// snapshot claiming that placeholder must verdict `closed` and never be
/// offered. The chain pinned: ledger close (placeholder-only) -> the route's
/// `CloseEvidence` read -> the verdict join -> the answer.
#[tokio::test]
async fn route_verdicts_a_pre_materialization_opencode_close_closed_never_offered() {
    let tmp = tempfile::tempdir().unwrap();
    write_snapshot(
        tmp.path(),
        "dev1",
        "oldclient",
        1_000_000,
        1,
        json!([
            {"tabKey":"dev1:t1","tabId":"t1","tabName":"work","status":"open","revision":1,"updatedAt":1_000_000,
             "paneCount":1,"panes":[{"paneId":"p1","kind":"fresh-agent",
               "payload":{"provider":"opencode","sessionType":"freshopencode",
                          "createRequestId":"req-oc-9",
                          "sessionRef":{"provider":"opencode","sessionId":"freshopencode-req-oc-9"}}}]}
        ]),
    );
    // The kill's ONE durable act (the placeholder-only close; what the fixed
    // opencode lane's `retire_closed_batch` envelope persists).
    let home = tempfile::tempdir().unwrap();
    let broot = home.path().join("pane-ledger");
    let seeder = freshell_ws::pane_ledger::PaneLedger::new(Some(broot.clone()));
    seeder
        .close_identities(
            "opencode",
            &["freshopencode-req-oc-9".to_string()],
            &["freshopencode-req-oc-9".to_string()],
            1_000_100,
        )
        .expect("the pre-materialization close persists");
    drop(seeder);
    let router = router(test_state(Some(tmp.path().to_path_buf()), Some(broot)));
    let (code, body) = get(
        router,
        "/api/recovery/inventory?clientInstanceId=me",
        Some("tok"),
    )
    .await;
    assert_eq!(code, axum::http::StatusCode::OK);
    let panes = body["device"]["tabs"][0]["panes"].as_array().unwrap();
    assert_eq!(
        panes[0]["ledgerState"], "closed",
        "the placeholder-claiming snapshot pane is closed by the kill's durable evidence: {body}"
    );
    assert!(
        panes[0]["sessionRef"].is_null(),
        "a closed pane carries no resume ref — the verdict, never the offer: {body}"
    );
    // The offer-side exclusion itself (the closed pane leaves the restore
    // plan and the count) is the client's `isRestorablePane` predicate —
    // pinned in build-recovery-plan.test.ts (delta-r6): the server's half
    // pinned here is that the pane NEVER reads unknown/offerable again.
    assert_eq!(
        body["ledgerOnly"].as_array().unwrap().len(),
        0,
        "no row exists to offer ledger-only: {body}"
    );
}

#[tokio::test]
async fn route_serves_attributed_ledger_only_row_within_parent_grace() {
    // D8 route-level positive: a surviving generation for the row's OWN parent
    // client ("c1" on "dev1") plus an attributed row in grace => offered,
    // recoverable, and the row JSON carries the stamped tabKey. The generation's
    // record carries the row's stamped tabKey ("dev1:t9") — the delta-r2
    // placement clause requires the stamped key to name a tab in the offer's
    // union.
    let tmp = tempfile::tempdir().unwrap();
    write_snapshot(
        tmp.path(),
        "dev1",
        "c1",
        1_000_000,
        1,
        json!([
            {"tabKey":"dev1:t9","tabId":"t9","tabName":"work","status":"open","revision":1,"updatedAt":1_000_000,
             "paneCount":1,"panes":[{"paneId":"p1","kind":"terminal","payload":{"mode":"shell"}}]}
        ]),
    );
    let home = tempfile::tempdir().unwrap();
    let broot = home.path().join("pane-ledger");
    std::fs::create_dir_all(broot.join("bindings").join("claude")).unwrap();
    std::fs::write(
        broot.join("bindings").join("claude").join("S1.json"),
        serde_json::to_vec(&json!({
            "ledgerVersion": 1, "provider": "claude", "sessionId": "S1", "mode": "claude",
            "cwd": "/w", "createdAt": 994_000, "updatedAt": 995_000, "lastObservedAt": 995_000,
            "state": "bound",
            "clientInstanceId": "c1", "deviceId": "dev1", "tabKey": "dev1:t9",
            "lastAttributedAt": 995_000
        }))
        .unwrap(),
    )
    .unwrap();
    let router = router(test_state(Some(tmp.path().to_path_buf()), Some(broot)));
    let (code, body) = get(
        router,
        "/api/recovery/inventory?clientInstanceId=me",
        Some("tok"),
    )
    .await;
    assert_eq!(code, axum::http::StatusCode::OK);
    assert_eq!(body["recoverable"], true);
    let only = body["ledgerOnly"].as_array().unwrap();
    let entry = only
        .iter()
        .find(|e| e["sessionId"] == "S1")
        .unwrap_or_else(|| {
            panic!("row within grace of its parent's winner must be offered (got {body})")
        });
    // The seed is the CURRENT-writer shape: stamps + `lastAttributedAt`
    // (stamped rows always carry the field — focused-ep4-r4 Finding 1 deleted
    // the `created_at` fallback, so the judgment key is 995_000, in grace:
    // 995_000 + 7_000 >= 1_000_000). The fieldless exclusion is unit-covered
    // by `stamped_row_without_the_attribution_time_field_is_never_offered`.
    assert_eq!(entry["tabKey"], "dev1:t9");
}

/// Delta-round-7 (Finding F1), route level: a Bound, unreferenced, attributed,
/// in-grace, placement-valid row whose session is LIVE in the registry is
/// offered as a reattach candidate — `live:true` with the row's still-running
/// terminal id — NOT categorically excluded. The dead control row (no live
/// terminal owns its session) is offered too with `live:false` and no reattach
/// handle (the pre-existing resume cohort, untouched).
#[tokio::test]
async fn route_offers_a_live_attributed_row_as_a_reattach_candidate() {
    let tmp = tempfile::tempdir().unwrap();
    write_snapshot(
        tmp.path(),
        "dev1",
        "c1",
        1_000_000,
        1,
        json!([
            {"tabKey":"dev1:t9","tabId":"t9","tabName":"work","status":"open","revision":1,"updatedAt":1_000_000,
             "paneCount":1,"panes":[{"paneId":"p1","kind":"terminal","payload":{"mode":"shell"}}]}
        ]),
    );
    let home = tempfile::tempdir().unwrap();
    let broot = home.path().join("pane-ledger");
    std::fs::create_dir_all(broot.join("bindings").join("claude")).unwrap();
    let seed = |session_id: &str, live_terminal: Option<&str>| {
        let mut row = json!({
            "ledgerVersion": 1, "provider": "claude", "sessionId": session_id, "mode": "claude",
            "cwd": "/w", "createdAt": 994_000, "updatedAt": 995_000, "lastObservedAt": 995_000,
            "state": "bound",
            "clientInstanceId": "c1", "deviceId": "dev1", "tabKey": "dev1:t9",
            "lastAttributedAt": 995_000
        });
        if let Some(t) = live_terminal {
            row["liveTerminalId"] = json!(t);
        }
        std::fs::write(
            broot.join("bindings").join("claude").join(format!("{session_id}.json")),
            serde_json::to_vec(&row).unwrap(),
        )
        .unwrap();
    };
    seed("S9-live", Some("t-live-9"));
    seed("S9-dead", Some("t-dead-9"));
    // The live evidence: a Running registry row owning S9-live's session.
    let registry = freshell_terminal::TerminalRegistry::new();
    registry.register_headless(freshell_terminal::registry::HeadlessTerminal {
        terminal_id: "t-live-9".into(),
        stream_id: "s9".into(),
        mode: "claude".into(),
        resume_session_id: Some("S9-live".into()),
        create_request_id: None,
        created_at: None,
    });
    let state = RecoveryInventoryState {
        auth_token: "tok".into(),
        snapshots_dir: Some(tmp.path().to_path_buf()),
        ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new_locked(Some(broot))),
        registry,
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
    };
    let router = router(state);
    let (code, body) = get(
        router,
        "/api/recovery/inventory?clientInstanceId=me",
        Some("tok"),
    )
    .await;
    assert_eq!(code, axum::http::StatusCode::OK);
    let only = body["ledgerOnly"].as_array().unwrap();
    let live_entry = only.iter().find(|e| e["sessionId"] == "S9-live").unwrap_or_else(|| {
        panic!("the LIVE attributed placement-valid row is offered (never categorically excluded): {body}")
    });
    assert_eq!(live_entry["live"], true, "the live verdict rides the entry: {live_entry}");
    assert_eq!(
        live_entry["liveTerminalId"], "t-live-9",
        "the still-running terminal id arms the client reattach: {live_entry}"
    );
    let dead_entry = only
        .iter()
        .find(|e| e["sessionId"] == "S9-dead")
        .expect("the dead control row stays offered (the resume cohort)");
    assert_eq!(dead_entry["live"], false);
    assert!(
        dead_entry.get("liveTerminalId").is_none() || dead_entry["liveTerminalId"].is_null(),
        "a dead row forwards no reattach handle: {dead_entry}"
    );
}

/// Delta-round-7 (Finding F2), route level — the finding's verbatim failure
/// shape: a Bound row whose pane was X-closed (the non-retiring terminal
/// DETACH journaled its createRequestId-keyed close record) is NEVER offered,
/// even though the row stays Bound (sidebar reattach) and every
/// attribution/grace/placement gate passes. The uncovered sibling row stays
/// offered (anti-vacuity). Seeding mirrors the reference-time route test: the
/// close is written through a REAL PaneLedger and reloaded by the route's.
#[tokio::test]
async fn route_never_offers_a_detach_close_covered_row() {
    let tmp = tempfile::tempdir().unwrap();
    write_snapshot(
        tmp.path(),
        "dev1",
        "c1",
        1_000_000,
        1,
        json!([
            {"tabKey":"dev1:t9","tabId":"t9","tabName":"work","status":"open","revision":1,"updatedAt":1_000_000,
             "paneCount":1,"panes":[{"paneId":"p1","kind":"terminal","payload":{"mode":"shell"}}]}
        ]),
    );
    let home = tempfile::tempdir().unwrap();
    let broot = home.path().join("pane-ledger");
    std::fs::create_dir_all(broot.join("bindings").join("claude")).unwrap();
    let seed = |session_id: &str, crid: &str| {
        std::fs::write(
            broot.join("bindings").join("claude").join(format!("{session_id}.json")),
            serde_json::to_vec(&json!({
                "ledgerVersion": 1, "provider": "claude", "sessionId": session_id, "mode": "claude",
                "cwd": "/w", "createdAt": 994_000, "updatedAt": 995_000, "lastObservedAt": 995_000,
                "state": "bound", "createRequestId": crid, "liveTerminalId": format!("term-{crid}"),
                "clientInstanceId": "c1", "deviceId": "dev1", "tabKey": "dev1:t9",
                "lastAttributedAt": 995_000
            }))
            .unwrap(),
        )
        .unwrap();
    };
    seed("S-detached-closed", "req-closed");
    seed("S-detached-open", "req-open");
    // THE DURABLE PANE CLOSE (non-retiring): the detach record exists via the
    // same write path the detach handler drives; the row stays Bound.
    let seeder = PaneLedger::new(Some(broot.clone()));
    seeder
        .close_pane_detached("req-closed", Some("term-req-closed"), 996_000)
        .expect("the detach close persists");
    drop(seeder);

    let router = router(test_state(Some(tmp.path().to_path_buf()), Some(broot)));
    let (code, body) = get(
        router,
        "/api/recovery/inventory?clientInstanceId=me",
        Some("tok"),
    )
    .await;
    assert_eq!(code, axum::http::StatusCode::OK);
    let only = body["ledgerOnly"].as_array().unwrap();
    assert!(
        only.iter().all(|e| e["sessionId"] != "S-detached-closed"),
        "a detach-close-covered row is never offered (the created-then-closed ghost): {body}"
    );
    assert!(
        only.iter().any(|e| e["sessionId"] == "S-detached-open"),
        "the uncovered sibling stays offered (the fixture discriminates): {body}"
    );
}

/// Delta-r7-round-2 (Finding F3), route level — the finding's verbatim repair
/// shape: the pane X-closes (its non-retiring `pane.closed` evidence stands),
/// then a NEW pane reattaches the SAME still-running terminal through the real
/// ledger restamp (`note_pane_reattach` — what the attach handler drives),
/// re-keying the row onto the new pane's createRequestId and ADVANCING its
/// attribution. The offer must then name the row again — pre-fix, the row
/// kept the old close-covered createRequestId and the close record's
/// terminal-id arm also keyed it, so a genuinely re-opened pane lost before
/// its first snapshot was suppressed. The old pane's close record itself is
/// untouched (loaded from disk and still covering only the old CRID).
#[tokio::test]
async fn route_offers_a_reattached_row_despite_the_old_panes_close() {
    let tmp = tempfile::tempdir().unwrap();
    write_snapshot(
        tmp.path(),
        "dev1",
        "c1",
        1_000_000,
        1,
        json!([
            {"tabKey":"dev1:t9","tabId":"t9","tabName":"work","status":"open","revision":1,"updatedAt":1_000_000,
             "paneCount":1,"panes":[{"paneId":"p1","kind":"terminal","payload":{"mode":"shell"}}]}
        ]),
    );
    let home = tempfile::tempdir().unwrap();
    let broot = home.path().join("pane-ledger");
    std::fs::create_dir_all(broot.join("bindings").join("claude")).unwrap();
    std::fs::write(
        broot.join("bindings").join("claude").join("S-reopened.json"),
        serde_json::to_vec(&json!({
            "ledgerVersion": 1, "provider": "claude", "sessionId": "S-reopened", "mode": "claude",
            "cwd": "/w", "createdAt": 994_000, "updatedAt": 995_000, "lastObservedAt": 995_000,
            "state": "bound", "createRequestId": "req-closed", "liveTerminalId": "term-rt",
            "clientInstanceId": "c1", "deviceId": "dev1", "tabKey": "dev1:t9",
            "lastAttributedAt": 995_000
        }))
        .unwrap(),
    )
    .unwrap();
    // THE DURABLE PANE CLOSE (non-retiring), keyed by the OLD pane's CRID and
    // naming the row's live terminal — both coverage arms armed pre-fix.
    let seeder = PaneLedger::new(Some(broot.clone()));
    seeder
        .close_pane_detached("req-closed", Some("term-rt"), 996_000)
        .expect("the detach close persists");
    // THE REATTACH (delta-r7-r2): the sidebar's new pane attaches the same
    // terminal; the row re-keys onto the NEW pane and its attribution
    // advances to the reattach's assertion (still in-grace of the parent's
    // 1_000_000).
    let restamped = seeder
        .note_pane_reattach(&freshell_ws::pane_ledger::ReattachWrite {
            provider: "claude",
            session_id: "S-reopened",
            terminal_id: "term-rt",
            create_request_id: "req-reopened",
            provenance: ProvenancePolicy::Replace(ProvenanceStamps {
                client_instance_id: Some("c1"),
                device_id: Some("dev1"),
                tab_key: Some("dev1:t9"),
                asserted_at: 997_000,
            }),
            now_ms: 997_000,
        })
        .expect("the restamp persists");
    assert!(restamped, "a Bound row with a different CRID restamps");
    let row = seeder.load_binding("claude", "S-reopened").unwrap();
    assert_eq!(row.create_request_id.as_deref(), Some("req-reopened"));
    assert_eq!(row.last_attributed_at, Some(997_000));
    drop(seeder);

    let router_reattached = router(test_state(Some(tmp.path().to_path_buf()), Some(broot)));
    let (code, body) = get(
        router_reattached,
        "/api/recovery/inventory?clientInstanceId=me",
        Some("tok"),
    )
    .await;
    assert_eq!(code, axum::http::StatusCode::OK);
    let only = body["ledgerOnly"].as_array().unwrap();
    let entry = only
        .iter()
        .find(|e| e["sessionId"] == "S-reopened")
        .unwrap_or_else(|| {
            panic!(
                "the reattached row is offered again — the old pane's close \
                 covers only the old pane: {body}"
            )
        });
    assert_eq!(entry["tabKey"], "dev1:t9", "the reattach's tabKey: {entry}");

    // Anti-suppression control: the SAME close record, no reattach — the row
    // keyed by the closed pane's CRID is never offered (the route still
    // discriminates).
    let broot2 = home.path().join("pane-ledger-control");
    std::fs::create_dir_all(broot2.join("bindings").join("claude")).unwrap();
    std::fs::write(
        broot2.join("bindings").join("claude").join("S-still-closed.json"),
        serde_json::to_vec(&json!({
            "ledgerVersion": 1, "provider": "claude", "sessionId": "S-still-closed", "mode": "claude",
            "cwd": "/w", "createdAt": 994_000, "updatedAt": 995_000, "lastObservedAt": 995_000,
            "state": "bound", "createRequestId": "req-closed", "liveTerminalId": "term-rt",
            "clientInstanceId": "c1", "deviceId": "dev1", "tabKey": "dev1:t9",
            "lastAttributedAt": 995_000
        }))
        .unwrap(),
    )
    .unwrap();
    let seeder2 = PaneLedger::new(Some(broot2.clone()));
    seeder2
        .close_pane_detached("req-closed", Some("term-rt"), 996_000)
        .expect("the detach close persists");
    drop(seeder2);
    let router_control = router(test_state(Some(tmp.path().to_path_buf()), Some(broot2)));
    let (code2, body2) = get(
        router_control,
        "/api/recovery/inventory?clientInstanceId=me",
        Some("tok"),
    )
    .await;
    assert_eq!(code2, axum::http::StatusCode::OK);
    let only2 = body2["ledgerOnly"].as_array().unwrap();
    assert!(
        only2.iter().all(|e| e["sessionId"] != "S-still-closed"),
        "un-reattached, the closed pane's row stays covered (the route discriminates): {body2}"
    );
}

/// Focused-ep5-r2 Finding 1 (retire-on-kill round 3), the route-level pin the
/// finding demands: `retire_closed`'s two durable writes (kill tombstone,
/// then row retire) can split across a crash or a failed second write. The
/// surviving UNEXPIRED tombstone is the author of truth — the inventory must
/// treat the still-Bound row it dominates as Retired and never offer it.
/// (Reload included: the fresh ledger over the seeded root loads the remnant
/// exactly as a restarted server would.)
#[tokio::test]
async fn route_never_offers_a_bound_row_whose_kill_tombstone_survived_its_retire_write() {
    let tmp = tempfile::tempdir().unwrap();
    let now = now_ms_u64();
    write_snapshot(
        tmp.path(),
        "dev1",
        "c1",
        now - 10_000,
        1,
        json!([
            {"tabKey":"dev1:t9","tabId":"t9","tabName":"work","status":"open","revision":1,"updatedAt":now - 10_000,
             "paneCount":1,"panes":[{"paneId":"pj","kind":"terminal","payload":{"mode":"shell"}}]}
        ]),
    );
    let home = tempfile::tempdir().unwrap();
    let broot = home.path().join("pane-ledger");
    std::fs::create_dir_all(broot.join("bindings").join("claude")).unwrap();
    let seed_bound = |session_id: &str| {
        std::fs::write(
            broot.join("bindings").join("claude").join(format!("{session_id}.json")),
            serde_json::to_vec(&json!({
                "ledgerVersion": 1, "provider": "claude", "sessionId": session_id, "mode": "claude",
                "cwd": "/w", "createdAt": now - 10_000, "updatedAt": now - 10_000,
                "lastObservedAt": now - 10_000, "state": "bound",
                "clientInstanceId": "c1", "deviceId": "dev1", "tabKey": "dev1:t9",
                "lastAttributedAt": now - 10_000
            }))
            .unwrap(),
        )
        .unwrap();
    };
    // Both rows satisfy EVERY D8 clause (the S2 control proves the fixture
    // would offer S1 absent the tombstone).
    seed_bound("S1-killed");
    seed_bound("S2-survivor");
    // THE REMNANT: S1's tombstone landed (durably) and its row retire never
    // did — exactly the finding's split-writes shape.
    std::fs::create_dir_all(broot.join("kill-tombstones").join("claude")).unwrap();
    std::fs::write(
        broot.join("kill-tombstones").join("claude").join("S1-killed.json"),
        serde_json::to_vec(&json!({
            "ledgerVersion": 1, "provider": "claude", "sessionId": "S1-killed",
            "killedAtMs": now
        }))
        .unwrap(),
    )
    .unwrap();

    let router = router(test_state(Some(tmp.path().to_path_buf()), Some(broot)));
    let (code, body) = get(
        router,
        "/api/recovery/inventory?clientInstanceId=me",
        Some("tok"),
    )
    .await;
    assert_eq!(code, axum::http::StatusCode::OK);
    let only = body["ledgerOnly"].as_array().unwrap();
    assert!(
        !only.iter().any(|e| e["sessionId"] == "S1-killed"),
        "a Bound row dominated by a surviving kill tombstone must read as Retired (got {body})"
    );
    assert!(
        only.iter().any(|e| e["sessionId"] == "S2-survivor"),
        "the plain Bound control row stays offered (the fixture discriminates): {body}"
    );
}

/// Focused-ep5-r3 Finding 4 (retire-on-kill round 4), the route-level twin
/// of the split-write test above: the tombstone AND the row are BOTH hours
/// past the 6h kill-tombstone TTL (the close happened before an overnight
/// outage — tombstone write landed, row retire lost to the crash, server
/// back up the next morning). TTL-scoped dominance would let the Bound row
/// resurface in `ledgerOnly`; the TTL-free dominance is exactly what the
/// finding demands. The grace judgment keys on stored-vs-stored timestamps,
/// so the whole fixture is shifted back 7h and remains otherwise offerable
/// (the S2 control discriminates: absent the tombstone, S1 WOULD be
/// offered at this age).
#[tokio::test]
async fn route_never_offers_a_bound_row_dominated_by_a_past_ttl_kill_tombstone() {
    let tmp = tempfile::tempdir().unwrap();
    let now = now_ms_u64();
    // Every stored stamp 7h old (past the 6h TTL); the close 10s after the
    // row's last liveness (the close outranks the row).
    let t = now - (7 * 60 * 60 * 1000);
    write_snapshot(
        tmp.path(),
        "dev1",
        "c1",
        t,
        1,
        json!([
            {"tabKey":"dev1:t9","tabId":"t9","tabName":"work","status":"open","revision":1,"updatedAt":t,
             "paneCount":1,"panes":[{"paneId":"pj","kind":"terminal","payload":{"mode":"shell"}}]}
        ]),
    );
    let home = tempfile::tempdir().unwrap();
    let broot = home.path().join("pane-ledger");
    std::fs::create_dir_all(broot.join("bindings").join("claude")).unwrap();
    let seed_bound = |session_id: &str| {
        std::fs::write(
            broot.join("bindings").join("claude").join(format!("{session_id}.json")),
            serde_json::to_vec(&json!({
                "ledgerVersion": 1, "provider": "claude", "sessionId": session_id, "mode": "claude",
                "cwd": "/w", "createdAt": t, "updatedAt": t,
                "lastObservedAt": t, "state": "bound",
                "clientInstanceId": "c1", "deviceId": "dev1", "tabKey": "dev1:t9",
                "lastAttributedAt": t
            }))
            .unwrap(),
        )
        .unwrap();
    };
    seed_bound("S1-killed-old");
    seed_bound("S2-survivor-old");
    std::fs::create_dir_all(broot.join("kill-tombstones").join("claude")).unwrap();
    std::fs::write(
        broot.join("kill-tombstones").join("claude").join("S1-killed-old.json"),
        serde_json::to_vec(&json!({
            "ledgerVersion": 1, "provider": "claude", "sessionId": "S1-killed-old",
            "killedAtMs": t + 10_000
        }))
        .unwrap(),
    )
    .unwrap();

    let router = router(test_state(Some(tmp.path().to_path_buf()), Some(broot)));
    let (code, body) = get(
        router,
        "/api/recovery/inventory?clientInstanceId=me",
        Some("tok"),
    )
    .await;
    assert_eq!(code, axum::http::StatusCode::OK);
    let only = body["ledgerOnly"].as_array().unwrap();
    assert!(
        !only.iter().any(|e| e["sessionId"] == "S1-killed-old"),
        "a Bound row dominated by a kill tombstone NEVER resurfaces — TTL or not (got {body})"
    );
    assert!(
        only.iter().any(|e| e["sessionId"] == "S2-survivor-old"),
        "the plain Bound control row stays offered at this age (the fixture discriminates): {body}"
    );
}

/// Focused-ep5-r2 Finding 1: the dominance transform's exact contract —
/// ONLY a Bound row whose identity the caller's fresh-tombstone set names
/// becomes Retired(Closed); everything else passes through untouched
/// (already-retired rows keep their verdict, untombstoned Bound rows stay
/// Bound). Row field preservation beyond the state pair is verbatim.
#[test]
fn kill_tombstone_dominance_rewrites_only_fresh_tombstoned_bound_rows() {
    let fresh: HashSet<(String, String)> = [("claude".to_string(), "S-killed".to_string())]
        .into_iter()
        .collect();
    let mut killed = binding_row_at("claude", "S-killed", bound(), 1_000);
    killed.model = Some("opus".into());
    let plain = binding_row_at("claude", "S-plain", bound(), 1_000);
    let already = binding_row_at("claude", "S-retired", retired_gc_expired(), 1_000);
    let out = apply_kill_tombstone_dominance(vec![killed, plain, already], &fresh);
    assert_eq!(out[0].state, RowState::Retired);
    assert_eq!(out[0].retired_reason, Some(RetiredReason::Closed));
    assert_eq!(out[0].model.as_deref(), Some("opus"), "payload preserved");
    assert_eq!(
        out[0].updated_at, 1_000,
        "the read-side transform never re-stamps row keeping"
    );
    assert_eq!(out[1].state, RowState::Bound, "untombstoned Bound untouched");
    assert_eq!(
        out[2].retired_reason,
        Some(RetiredReason::GcExpired),
        "an already-retired row keeps its own verdict"
    );
    // An empty fresh set is identity.
    let plain2 = binding_row_at("claude", "S-plain", bound(), 1_000);
    let out = apply_kill_tombstone_dominance(vec![plain2], &HashSet::new());
    assert_eq!(out[0].state, RowState::Bound);
}

#[tokio::test]
async fn route_correlates_a_late_bound_row_onto_its_ref_less_snapshot_pane() {
    // Focused-ep3 end-to-end JSON contract — the duplicate-restore shape the
    // client plan consumes: a codex CLI pane snapshotted INSIDE its identity
    // association window (sessionRef absent; payload carries only
    // createRequestId + liveTerminal.terminalId) whose attributed Bound row
    // arrived after the snapshot. The inventory must present exactly ONE pane
    // carrying the row's identity AND an EMPTY ledgerOnly — never the pre-fix
    // pair (ref-less snapshot pane + the row's separate resume leaf).
    let tmp = tempfile::tempdir().unwrap();
    let now = now_ms_u64();
    write_snapshot(
        tmp.path(),
        "dev1",
        "lost",
        now - 10_000,
        1,
        json!([
            {"tabKey":"dev1:t1","tabId":"t1","tabName":"work","status":"open","revision":1,"updatedAt":now - 10_000,
             "paneCount":1,"panes":[{"paneId":"p1","kind":"terminal",
               "payload":{"mode":"codex","createRequestId":"req-1",
                          "liveTerminal":{"terminalId":"t-9","serverInstanceId":"srv-test"}}}]}
        ]),
    );
    let home = tempfile::tempdir().unwrap();
    let broot = home.path().join("pane-ledger");
    std::fs::create_dir_all(broot.join("bindings").join("codex")).unwrap();
    // Attributed + in grace of its parent ("lost", winner capturedAt
    // now-10_000; row_time now-10_000 + 7_000 >= now-10_000) + tabKey naming
    // the union tab: pre-fix this row IS D8-offered, so the red failure is
    // exactly the finding's pair (ref-less pane + ledgerOnly resume leaf).
    std::fs::write(
        broot.join("bindings").join("codex").join("C-assoc.json"),
        serde_json::to_vec(&json!({
            "ledgerVersion": 1, "provider": "codex", "sessionId": "C-assoc", "mode": "codex",
            "cwd": "/w", "createdAt": now - 10_000, "updatedAt": now - 10_000,
            "lastObservedAt": now - 10_000, "state": "bound",
            "createRequestId": "req-1", "liveTerminalId": "t-9",
            "clientInstanceId": "lost", "deviceId": "dev1", "tabKey": "dev1:t1"
        }))
        .unwrap(),
    )
    .unwrap();
    let router = router(test_state(Some(tmp.path().to_path_buf()), Some(broot)));
    let (code, body) = get(
        router,
        "/api/recovery/inventory?clientInstanceId=me",
        Some("tok"),
    )
    .await;
    assert_eq!(code, axum::http::StatusCode::OK);
    assert_eq!(body["recoverable"], true);
    let panes = body["device"]["tabs"][0]["panes"].as_array().unwrap();
    assert_eq!(
        panes.len(),
        1,
        "the duplicate-restore shape is gone: exactly one pane for the one originally-open pane (got {body})"
    );
    assert_eq!(panes[0]["ledgerState"], "bound");
    assert_eq!(panes[0]["sessionRef"]["provider"], "codex");
    assert_eq!(panes[0]["sessionRef"]["sessionId"], "C-assoc");
    assert_eq!(
        body["ledgerOnly"].as_array().unwrap().len(),
        0,
        "the correlated row must not ALSO surface as a ledgerOnly resume leaf (got {body})"
    );
}

#[tokio::test]
async fn route_drops_stale_rotated_clients() {
    // A15: a client silent >15 min (heartbeat is 5 min) is closed or rotated - its
    // resurrected tab must not enter the inventory union.
    let tmp = tempfile::tempdir().unwrap();
    let t_max: u64 = 100_000_000;
    write_snapshot(
        tmp.path(),
        "dev1",
        "fresh",
        t_max,
        1,
        json!([
            {"tabKey":"k1","tabId":"t1","tabName":"work","status":"open","revision":1,"updatedAt":t_max,
             "paneCount":1,"panes":[{"paneId":"p1","kind":"terminal","payload":{"mode":"shell"}}]}
        ]),
    );
    write_snapshot(
        tmp.path(),
        "dev1",
        "stale",
        t_max - 16 * 60 * 1000,
        1,
        json!([
            {"tabKey":"zombie","tabId":"tz","tabName":"zombie","status":"open","revision":1,"updatedAt":t_max - 16 * 60 * 1000,
             "paneCount":1,"panes":[{"paneId":"pz","kind":"terminal","payload":{"mode":"shell"}}]}
        ]),
    );
    let router = router(test_state(Some(tmp.path().to_path_buf()), None));
    let (_, body) = get(
        router,
        "/api/recovery/inventory?clientInstanceId=me",
        Some("tok"),
    )
    .await;
    let tabs = body["device"]["tabs"].as_array().unwrap();
    assert!(
        tabs.iter().all(|t| t["tabKey"] != "zombie"),
        "stale client's tab must be dropped"
    );
    assert!(tabs.iter().any(|t| t["tabKey"] == "k1"));
}

#[tokio::test]
async fn route_bootagoms_drops_concurrent_post_boot_clients() {
    // A16/D2 at the ROUTE level: this test forces the bootAgoMs -> boot_cutoff ->
    // read_foreign_unions(_, _, boot_cutoff) wiring to actually exist. It uses REAL
    // wall-clock capturedAt values because boot_cutoff is computed from now_ms().
    let tmp = tempfile::tempdir().unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    // The genuinely lost client: its only push predates the requester's boot by 60s.
    write_snapshot(
        tmp.path(),
        "dev1",
        "lost",
        now - 60_000,
        1,
        json!([
            {"tabKey":"k1","tabId":"t1","tabName":"work","status":"open","revision":1,"updatedAt":now - 60_000,
             "paneCount":1,"panes":[{"paneId":"p1","kind":"terminal","payload":{"mode":"shell"}}]}
        ]),
    );
    // A concurrently-born fresh window: ALL of its generations postdate the boot.
    write_snapshot(
        tmp.path(),
        "dev1",
        "concurrent",
        now,
        1,
        json!([
            {"tabKey":"junk","tabId":"tj","tabName":"junk","status":"open","revision":1,"updatedAt":now,
             "paneCount":1,"panes":[{"paneId":"pj","kind":"terminal","payload":{"mode":"shell"}}]}
        ]),
    );
    let router = router(test_state(Some(tmp.path().to_path_buf()), None));
    // Requester booted 30s ago => boot_cutoff = now - 30s: "concurrent" (born now) is
    // post-boot junk and must be dropped; "lost" (60s ago) predates boot and survives.
    let (_, body) = get(
        router.clone(),
        "/api/recovery/inventory?clientInstanceId=me&bootAgoMs=30000",
        Some("tok"),
    )
    .await;
    let tabs = body["device"]["tabs"].as_array().unwrap();
    assert!(
        tabs.iter().all(|t| t["tabKey"] != "junk"),
        "post-boot concurrent client must be dropped (A16)"
    );
    assert!(
        tabs.iter().any(|t| t["tabKey"] == "k1"),
        "pre-boot lost client must survive"
    );
    // Without bootAgoMs (default 0 => boot_cutoff = now at handler time) BOTH clients
    // predate the cutoff and BOTH tabs appear - pins the optional-default-0 contract.
    let (_, body) = get(
        router,
        "/api/recovery/inventory?clientInstanceId=me",
        Some("tok"),
    )
    .await;
    let tabs = body["device"]["tabs"].as_array().unwrap();
    assert!(
        tabs.iter().any(|t| t["tabKey"] == "junk"),
        "default cutoff must drop nothing pre-request"
    );
    assert!(tabs.iter().any(|t| t["tabKey"] == "k1"));
}

/// The generation-file path `write_snapshot` produced (alphanumeric ids need
/// no escaping) — used to seed the interleaved-prune injection seam.
fn snapshot_path(
    dir: &std::path::Path,
    device: &str,
    client: &str,
    captured_at: u64,
    rev: u64,
) -> std::path::PathBuf {
    dir.join(device)
        .join(format!("{client}-{captured_at:020}-r{rev:012}.json"))
}

fn open_tab_records(tab_key: &str, updated_at: u64) -> serde_json::Value {
    json!([
        {"tabKey": tab_key, "tabId": tab_key, "tabName": tab_key, "status": "open",
         "revision": 1, "updatedAt": updated_at, "paneCount": 1,
         "panes": [{"paneId": format!("p-{tab_key}"), "kind": "terminal", "payload": {"mode": "shell"}}]}
    ])
}

fn now_ms_u64() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// The restart-recovery interleave: every reconnecting client re-pushes right
/// when the fresh window fetches the inventory, and a push from a client at
/// its retention cap PRUNES that client's oldest generation — which the
/// overview scan just selected (selection takes ALL retained generations of
/// surviving clients). The union read must not answer that benign prune by
/// silently omitting the ENTIRE device from the recovery offer: a re-read
/// converges on what actually survives and the device is still offered.
#[tokio::test]
async fn transient_prune_between_reads_never_silently_drops_a_device() {
    let tmp = tempfile::tempdir().unwrap();
    let now = now_ms_u64();
    // The lost client retains two generations (both pre-request, both fresh).
    write_snapshot(
        tmp.path(),
        "dev1",
        "lost",
        now - 240_000,
        1,
        open_tab_records("k-old", now - 240_000),
    );
    write_snapshot(
        tmp.path(),
        "dev1",
        "lost",
        now - 60_000,
        2,
        open_tab_records("k1", now - 60_000),
    );
    // One concurrent retention prune lands between the overview scan and the
    // union read, deleting the oldest just-selected generation.
    INJECTED_PRUNE_BATCHES
        .lock()
        .unwrap()
        .push(vec![snapshot_path(
            tmp.path(),
            "dev1",
            "lost",
            now - 240_000,
            1,
        )]);
    let router = router(test_state(Some(tmp.path().to_path_buf()), None));
    let (code, body) = get(
        router,
        "/api/recovery/inventory?clientInstanceId=me",
        Some("tok"),
    )
    .await;
    assert_eq!(code, axum::http::StatusCode::OK);
    assert_eq!(
        body["recoverable"], true,
        "a benign concurrent prune must not silently empty the recovery offer"
    );
    assert_eq!(body["device"]["deviceId"], "dev1");
    let tabs = body["device"]["tabs"].as_array().unwrap();
    assert!(
        tabs.iter().any(|t| t["tabKey"] == "k1"),
        "the device's surviving newest generation must still be offered"
    );
}

/// Exhausted re-reads mean the store is churning or incoherent under the
/// reader: answer LOUD (500 + error log), never a clean 200 whose inventory
/// silently omits the device (`recovery_inventory.rs` fail-loud policy:
/// "never a silent empty inventory").
#[tokio::test]
async fn persistent_union_incoherence_fails_loud_not_silent_empty() {
    let tmp = tempfile::tempdir().unwrap();
    let now = now_ms_u64();
    for (i, age) in [240_000u64, 180_000, 120_000, 60_000].iter().enumerate() {
        write_snapshot(
            tmp.path(),
            "dev1",
            "lost",
            now - age,
            (i + 1) as u64,
            open_tab_records("k1", now - age),
        );
    }
    // A prune lands between the two reads on EVERY attempt (each batch is
    // consumed by one attempt), so the selected set never survives.
    {
        let mut batches = INJECTED_PRUNE_BATCHES.lock().unwrap();
        batches.push(vec![snapshot_path(
            tmp.path(),
            "dev1",
            "lost",
            now - 240_000,
            1,
        )]);
        batches.push(vec![snapshot_path(
            tmp.path(),
            "dev1",
            "lost",
            now - 180_000,
            2,
        )]);
        batches.push(vec![snapshot_path(
            tmp.path(),
            "dev1",
            "lost",
            now - 120_000,
            3,
        )]);
    }
    let router = router(test_state(Some(tmp.path().to_path_buf()), None));
    let (code, body) = get(
        router,
        "/api/recovery/inventory?clientInstanceId=me",
        Some("tok"),
    )
    .await;
    assert_eq!(
        code,
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "persistent union incoherence must fail loud, not 200 with the device silently missing; got body {body}"
    );
}

#[test]
fn concurrent_fresh_windows_generations_are_dropped() {
    // A16/D2: a client whose ENTIRE retained history postdates the requester's boot is a
    // concurrently-opened fresh window (junk auto shell tab) - it must never demote the
    // genuinely lost device by winning primary-device selection.
    let boot: u64 = 100_000_000;
    let gens = vec![
        json!({"generationId": "gJ1", "clientInstanceId": "sibling-window", "capturedAt": boot + 2_000}),
        json!({"generationId": "gJ2", "clientInstanceId": "sibling-window", "capturedAt": boot + 300_000}),
        json!({"generationId": "gR",  "clientInstanceId": "lost",           "capturedAt": boot - 30_000}),
    ];
    let ids = select_foreign_recent_generation_ids(&gens, "me", boot).selected_ids;
    assert!(
        ids.contains(&"gR".to_string()),
        "pre-boot client is real lost data - kept"
    );
    assert!(
        !ids.contains(&"gJ1".to_string()) && !ids.contains(&"gJ2".to_string()),
        "post-boot-only client is a concurrent fresh window - dropped"
    );
}

// ── Delta-r6-r2 (focused-episode-6 round 1, Finding 1): the verdict join
// consumes the close records — a closed pane is never restored ───────────

/// A ref-less terminal pane (snapshotted inside its identity-association
/// window, then KILLED before the identity landed) is covered by the pane
/// close record the kill wrote under the pane identity: the verdict is
/// `closed` — never `unknown` — so the client excludes it instead of
/// restoring the deliberately-closed pane (THE FINDING).
#[test]
fn a_ref_less_pane_covered_by_a_pane_close_record_verdicts_closed() {
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "codex", "createRequestId": "req-closed",
                                  "liveTerminal": { "terminalId": "t-closed", "serverInstanceId": "srv-x" } } }]),
        ),
    };
    // The kill knew ONLY the pane: no row exists anywhere (the identity
    // never resolved), and the record's kills list is EMPTY (there was
    // nothing to retire) — the verdict must come from the RECORD, not from
    // any retired-row correlation.
    let closes = closes_with("t-closed", Some("req-closed"), &[], &[]);
    let out = build_inventory(vec![d], vec![], no_live(), &no_evidence(), &closes);
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(
        pane["ledgerState"], "closed",
        "a pane the close record covers IS closed (never restored): {pane}"
    );
    assert!(pane["sessionRef"].is_null());
}

/// The same verdict by the OTHER cover key: the snapshot payload's
/// `liveTerminal.terminalId` covers panes whose `createRequestId` arm is
/// absent (the marker-mode snapshot can lack it).
#[test]
fn a_ref_less_pane_covered_by_terminal_id_verdicts_closed() {
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "opencode",
                                  "liveTerminal": { "terminalId": "t-bytid", "serverInstanceId": "srv-x" } } }]),
        ),
    };
    let closes = closes_with("t-bytid", None, &[], &[]);
    let out = build_inventory(vec![d], vec![], no_live(), &no_evidence(), &closes);
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(pane["ledgerState"], "closed");
}

/// A covered pane claims NOTHING (its would-be candidates neither bind to it
/// nor taint into the ambiguity census). Delta-round-7 (Finding F2) RETARGETED
/// the row half (the old pin offered the covered pane's own row): a row the
/// close coverage keys — by EITHER pane linkage (its createRequestId or, for
/// detach records only, its live terminal id) — IS that closed pane's row and
/// is never offered; the ordinary judgment it falls to now includes the
/// row-close-coverage gate. The uncovered control row proves the judgment
/// itself still discriminates.
#[test]
fn a_close_covered_pane_never_claims_its_correlated_row() {
    let d = DeviceUnion {
        device_id: "dev1".into(),
        // `union_doc_with_tab_key`: the placement clause (delta-r2 Finding
        // 3) admits the kept row only when the union carries ITS stamped
        // tabKey, which `with_attribution` composes as `device:tab`.
        union_doc: union_doc_with_tab_key(
            "dev1",
            1000,
            "dev1:k1",
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "codex", "createRequestId": "req-cov",
                                  "liveTerminal": { "terminalId": "t-cov", "serverInstanceId": "srv-x" } } }]),
        ),
    };
    // The row the pane WOULD correlate to (advisory crid match): Bound,
    // attributed, within grace — but it is the CLOSED pane's own row (the
    // kill record names the same createRequestId), so the row-close-coverage
    // gate excludes it.
    let mut row = binding_row("codex", "sess-closed-pane", bound());
    row.create_request_id = Some("req-cov".into());
    row.live_terminal_id = Some("t-cov".into());
    row = with_attribution(row, "c1", "dev1", "k1");
    row.last_attributed_at = Some(900);
    // The control: an UNRELATED row on its own pane — never claimed, never
    // tainted, offered (the judgment discriminates; the covered pane's census
    // skip does not starve it either).
    let mut control = binding_row("codex", "sess-elsewhere", bound());
    control.create_request_id = Some("req-elsewhere".into());
    control.live_terminal_id = Some("t-elsewhere".into());
    control = with_attribution(control, "c1", "dev1", "k1");
    control.last_attributed_at = Some(900);
    let closes = closes_with("t-cov", Some("req-cov"), &[], &[]);
    let out = build_inventory(
        vec![d],
        vec![row, control],
        no_live(),
        &evidence(&[("dev1", &[("c1", 1_000)])]),
        &closes,
    );
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(
        pane["ledgerState"], "closed",
        "the covered pane still verdicts closed (the close beats the correlation)"
    );
    let ledger_only = out["ledgerOnly"].as_array().unwrap();
    assert!(
        ledger_only.iter().all(|e| e["sessionId"] != "sess-closed-pane"),
        "the closed pane's own row is close-covered — never offered (F2): {ledger_only:?}"
    );
    assert!(
        ledger_only.iter().any(|e| e["sessionId"] == "sess-elsewhere"),
        "the unrelated control row reaches the ordinary offer judgment \
         (attributed + in grace + placeable + uncovered): {ledger_only:?}"
    );
}

/// The fresh-agent half: a pane whose snapshot claims a PLACEHOLDER whose
/// kill wrote only the identity-keyed fence (no row ever landed) verdicts
/// `closed` — the standing tombstone IS the durable close for the
/// pre-materialization kill (claude/codex/opencode all write it).
#[test]
fn a_claim_whose_identity_has_a_standing_tombstone_and_no_row_verdicts_closed() {
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([{ "paneId": "p1", "kind": "fresh-agent",
                     "payload": { "provider": "claude", "sessionType": "freshclaude",
                                  "createRequestId": "req-fa",
                                  "sessionRef": { "provider": "claude", "sessionId": "ph-1" } } }]),
        ),
    };
    let closes = closes_with("t-unrelated", None, &[], &[("claude", "ph-1")]);
    let out = build_inventory(vec![d], vec![], no_live(), &no_evidence(), &closes);
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(
        pane["ledgerState"], "closed",
        "a placeholder claim with a standing kill fence and no row IS closed: {pane}"
    );
    assert!(pane["sessionRef"].is_null());
}

/// Delta-r6-r4e (the kill-window e2e's actual payload shape): a claude
/// pane snapshotted pre-association carries NO `sessionRef` at all — the
/// placeholder lives in the payload's `sessionKeys` (the cross-device rings
/// stamp: `provider:sessionId`). The ref-less arms (the terminal-gated
/// correlations) leave such a pane `unknown`; with its kill's standing
/// fence, that re-offers a pane the user just closed. The closed verdict
/// must reach the pane through the sessionKeys claim shape too.
#[test]
fn a_ref_less_fresh_agent_pane_claiming_a_fenced_identity_via_session_keys_verdicts_closed() {
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([{ "paneId": "p1", "kind": "fresh-agent",
                     "payload": { "provider": "claude", "sessionType": "freshclaude",
                                  "createRequestId": "req-fa-sk",
                                  "sessionKeys": ["claude:ph-sk-1"] } }]),
        ),
    };
    let closes = closes_with("t-unrelated", None, &[], &[("claude", "ph-sk-1")]);
    let out = build_inventory(vec![d], vec![], no_live(), &no_evidence(), &closes);
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(
        pane["ledgerState"], "closed",
        "a standing kill fence over the pane's sessionKeys claim IS the durable close: {pane}"
    );
    assert!(pane["sessionRef"].is_null());
}

/// Same claim shape WITHOUT the fence: the pane stays `unknown` (the
/// pre-existing fallback) — a sessionKeys claim alone never suppresses a
/// restore.
#[test]
fn a_ref_less_fresh_agent_pane_claiming_an_unfenced_identity_via_session_keys_stays_unknown() {
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([{ "paneId": "p1", "kind": "fresh-agent",
                     "payload": { "provider": "claude", "sessionType": "freshclaude",
                                  "createRequestId": "req-fa-sk-open",
                                  "sessionKeys": ["claude:ph-sk-open"] } }]),
        ),
    };
    let out = build_inventory(vec![d], vec![], no_live(), &no_evidence(), &no_closes());
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(
        pane["ledgerState"], "unknown",
        "no fence => the ref-less unknown fallback stands: {pane}"
    );
}

/// Multi-key payloads (retargeted by focused-episode-6 round 4, Findings
/// F1+F2): a LIVE association in the pane's sessionKeys beats every stale
/// fence (a fence beside a live alias no longer closes — the pre-fix pin
/// enshrined the finding); the fenced-ONLY slice still closes; and
/// empty/malformed/non-string keys name no identity.
#[test]
fn session_keys_consult_live_association_beats_fence_and_malformed_entries_close_nothing() {
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([
                { "paneId": "p1", "kind": "fresh-agent",
                  "payload": { "provider": "claude", "sessionType": "freshclaude",
                               "createRequestId": "req-fa-sk-m",
                               "sessionKeys": ["claude:ph-sk-live", "claude:ph-sk-killed"] } },
                { "paneId": "p2", "kind": "fresh-agent",
                  "payload": { "provider": "claude", "sessionType": "freshclaude",
                               "createRequestId": "req-fa-sk-md",
                               "sessionKeys": ["", "claude:", ":orphan", 42, null] } },
                { "paneId": "p3", "kind": "fresh-agent",
                  "payload": { "provider": "claude", "sessionType": "freshclaude",
                               "createRequestId": "req-fa-sk-f",
                               "sessionKeys": ["claude:ph-sk-killed"] } }
            ]),
        ),
    };
    let closes = closes_with("t-unrelated", None, &[], &[("claude", "ph-sk-killed")]);
    let out = build_inventory(
        vec![d],
        vec![],
        live(&[("claude", "ph-sk-live")]),
        &no_evidence(),
        &closes,
    );
    let panes = out["device"]["tabs"][0]["panes"].as_array().unwrap();
    assert_eq!(
        panes[0]["live"], true,
        "the pane claims a session that is live RIGHT NOW: live, never closed (F1/F2): {:?}",
        panes[0]
    );
    assert_ne!(
        panes[0]["ledgerState"], "closed",
        "a fence beside the live alias never wins: {:?}",
        panes[0]
    );
    assert_eq!(
        panes[0]["sessionRef"],
        json!({"provider": "claude", "sessionId": "ph-sk-live"}),
        "the effective ref resolves from the LIVE key: {:?}",
        panes[0]
    );
    assert_eq!(
        panes[1]["ledgerState"], "unknown",
        "empty/malformed/non-string keys name no identity and never close anything: {panes:?}"
    );
    assert_eq!(
        panes[2]["ledgerState"], "closed",
        "a slice whose only well-formed key is fenced still closes: {:?}",
        panes[2]
    );
}

/// F2: the pre-association snapshot shape the verdicts used to leave
/// `unknown`+`live:false` — a ref-less fresh-agent pane whose UNFENCED
/// sessionKeys entry is present in the live-session set gets the LIVE
/// verdict (the offer never spawns a second session on top of the running
/// one).
#[test]
fn a_ref_less_fresh_agent_pane_with_a_live_unfenced_session_key_verdicts_live() {
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([{ "paneId": "p1", "kind": "fresh-agent",
                     "payload": { "provider": "claude", "sessionType": "freshclaude",
                                  "createRequestId": "req-fa-sk-open",
                                  "sessionKeys": ["claude:ph-sk-open"] } }]),
        ),
    };
    let out = build_inventory(
        vec![d],
        vec![],
        live(&[("claude", "ph-sk-open")]),
        &no_evidence(),
        &no_closes(),
    );
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(
        pane["live"], true,
        "the unfenced claim lives in the running-session set: live (never re-offered): {pane}"
    );
    assert_ne!(pane["ledgerState"], "closed", "never closed: {pane}");
    assert_eq!(
        pane["sessionRef"],
        json!({"provider": "claude", "sessionId": "ph-sk-open"}),
        "the effective ref resolves from the live key: {pane}"
    );
}

/// F1: reopen-after-fence. A claim genuinely reopened the identity (the row
/// revived Bound; the stale fence is claim residue the pre-consumption
/// journal re-fed after a restart). A subsequently retained snapshot of the
/// reopened pane is LIVE/BOUND, never closed — the current association beats
/// the residue.
#[test]
fn a_reopened_panes_retained_snapshot_verdicts_live_not_closed() {
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([{ "paneId": "p1", "kind": "fresh-agent",
                     "payload": { "provider": "claude", "sessionType": "freshclaude",
                                  "createRequestId": "req-fa-sk-re",
                                  "sessionKeys": ["claude:dur-reopened"] } }]),
        ),
    };
    // The revived row (the claim's commit) is Bound; the residue fence
    // stands beside it.
    let bindings = vec![binding_row("claude", "dur-reopened", bound())];
    let closes = closes_with("t-unrelated", None, &[], &[("claude", "dur-reopened")]);
    let out = build_inventory(
        vec![d],
        bindings,
        live(&[("claude", "dur-reopened")]),
        &no_evidence(),
        &closes,
    );
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(pane["live"], true, "genuinely reopened: live, not closed: {pane}");
    assert_ne!(pane["ledgerState"], "closed", "{pane}");
    assert_eq!(
        pane["sessionRef"],
        json!({"provider": "claude", "sessionId": "dur-reopened"}),
        "the live association supplies the effective ref: {pane}"
    );
}

/// F1's sessionRef-claim half: a fence over the claimed identity never wins
/// against a LIVE claim — the pane's association is current (the fence is
/// residue). The closed verdict survives only when nothing live/current
/// contradicts it.
#[test]
fn a_fenced_placeholder_claim_that_is_still_live_verdicts_live_not_closed() {
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([{ "paneId": "p1", "kind": "fresh-agent",
                     "payload": { "provider": "claude", "sessionType": "freshclaude",
                                  "createRequestId": "req-fa-fl",
                                  "sessionRef": { "provider": "claude", "sessionId": "ph-live" } } }]),
        ),
    };
    let closes = closes_with("t-unrelated", None, &[], &[("claude", "ph-live")]);
    let out = build_inventory(
        vec![d],
        vec![],
        live(&[("claude", "ph-live")]),
        &no_evidence(),
        &closes,
    );
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(
        pane["live"], true,
        "a live claim pre-empts the residue fence: live, not closed: {pane}"
    );
    assert_ne!(pane["ledgerState"], "closed", "{pane}");
}

/// The F1 consult's non-live current association: a Bound row a sessionKeys
/// entry resolves to beats the fence on the slice's OTHER key (the same
/// current-association rule, at ledger-state level).
#[test]
fn a_bound_row_association_beats_the_fence_on_another_key() {
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([{ "paneId": "p1", "kind": "fresh-agent",
                     "payload": { "provider": "claude", "sessionType": "freshclaude",
                                  "createRequestId": "req-fa-sk-b",
                                  "sessionKeys": ["claude:ph-sk-gone", "claude:dur-alive"] } }]),
        ),
    };
    let bindings = vec![binding_row("claude", "dur-alive", bound())];
    let closes = closes_with("t-unrelated", None, &[], &[("claude", "ph-sk-gone")]);
    let out = build_inventory(vec![d], bindings, no_live(), &no_evidence(), &closes);
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(
        pane["ledgerState"], "bound",
        "the current Bound association contradicts the stale fence: {pane}"
    );
    assert_eq!(
        pane["sessionRef"],
        json!({"provider": "claude", "sessionId": "dur-alive"}),
        "{pane}"
    );
    assert_eq!(pane["live"], false, "not live (the row is Bound, not running): {pane}");
}

/// Control: the pre-existing fallback is untouched — a claim with no row and
/// NO close evidence stays `unknown` (restored fresh with its original
/// claim), and a covered pane whose identity GENUINELY lives elsewhere still
/// verdicts closed for THIS pane (the pane itself was closed; the identity's
/// new life belongs to a different pane).
#[test]
fn close_verdicts_apply_only_with_close_evidence() {
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([
                { "paneId": "p1", "kind": "fresh-agent",
                  "payload": { "provider": "claude", "sessionType": "freshclaude",
                               "createRequestId": "req-open",
                               "sessionRef": { "provider": "claude", "sessionId": "ph-open" } } },
                { "paneId": "p2", "kind": "terminal",
                  "payload": { "mode": "codex", "sessionRef": { "provider": "codex", "sessionId": "sess-bound" },
                               "createRequestId": "req-oldpane",
                               "liveTerminal": { "terminalId": "t-oldpane", "serverInstanceId": "srv-x" } } }
            ]),
        ),
    };
    let bindings = vec![binding_row("codex", "sess-bound", bound())];
    // Only p2 has close evidence (killed before the loss; its identity was
    // later resumed by ANOTHER pane — the row reads Bound). p1 has none.
    let closes = closes_with("t-oldpane", Some("req-oldpane"), &[("codex", "sess-bound")], &[]);
    let out = build_inventory(vec![d], bindings, no_live(), &no_evidence(), &closes);
    let panes = out["device"]["tabs"][0]["panes"].as_array().unwrap();
    assert_eq!(
        panes[0]["ledgerState"], "unknown",
        "no close evidence => the pre-existing unknown fallback stands"
    );
    assert_eq!(panes[0]["sessionRef"]["sessionId"], "ph-open");
    assert_eq!(
        panes[1]["ledgerState"], "closed",
        "the pane-close record beats even a Bound identity verdict — the PANE was closed, \
         whatever the identity did later on another pane"
    );
    assert!(panes[1]["sessionRef"].is_null());
}
