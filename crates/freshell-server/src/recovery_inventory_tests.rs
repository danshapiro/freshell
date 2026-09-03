//! Tests for the pure recovery-inventory builder (B3/P1.9 Task 1).

use super::*;
use freshell_protocol::SessionLocator;
use freshell_ws::pane_ledger::{BindingRow, RetiredReason, RowState, LEDGER_VERSION};
use serde_json::json;
use std::collections::HashSet;

fn no_live() -> HashSet<(String, String)> {
    HashSet::new()
}

fn live(pairs: &[(&str, &str)]) -> HashSet<(String, String)> {
    pairs
        .iter()
        .map(|(p, s)| (p.to_string(), s.to_string()))
        .collect()
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
    }
}

fn binding_row(provider: &str, session_id: &str, state_parts: StateParts) -> BindingRow {
    binding_row_at(provider, session_id, state_parts, 1000)
}

/// D8 attribution knobs: stamp the fixture row the way the connection-scoped
/// WS create lanes do — `tab_key` composes as `device:tab` (exactly
/// `BindProvenance::for_create`'s rule).
fn with_attribution(mut row: BindingRow, client: &str, device: &str, tab_id: &str) -> BindingRow {
    row.client_instance_id = Some(client.to_string());
    row.device_id = Some(device.to_string());
    row.tab_key = Some(format!("{device}:{tab_id}"));
    row
}

/// No surviving parent evidence at all (no-snapshot boot, pre-D8 inventory).
fn no_evidence() -> DeviceEvidence {
    Vec::new()
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

#[test]
fn empty_inputs_not_recoverable() {
    let out = build_inventory(vec![], vec![], no_live(), &no_evidence());
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
    let out = build_inventory(vec![old, new], vec![], no_live(), &no_evidence());
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
        &evidence(&[("dev1", &[("c1", 5_000)])]),
    );
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
    let out = build_inventory(vec![d], bindings, no_live(), &no_evidence());
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
        &no_evidence(),
    );
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
        &evidence(&[("dev1", &[("c1", 5_000)])]),
    );
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
        &evidence(&[("dev1", &[("c9", 5_000)])]),
    );
    assert_eq!(out["device"]["deviceId"], "dev1"); // dev0 is NON-primary
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "C9 is referenced by dev0's union - not orphaned"
    );
}

#[test]
fn live_effective_ref_marks_pane_live_and_live_rows_never_ledger_only() {
    // D7: pane resolves (via ledger chain) to S2, which a Running terminal owns;
    // a second live bound row C9 is referenced by no pane.
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
        binding_row("claude", "S2", bound()),
        // C9 is attributed with in-grace parent evidence, so the D8 judgment
        // alone would offer it — the D7 live rule remains the deciding filter.
        with_attribution(binding_row("codex", "C9", bound()), "c9", "dev1", "t9"),
    ];
    let out = build_inventory(
        vec![d],
        bindings,
        live(&[("claude", "S2"), ("codex", "C9")]),
        &evidence(&[("dev1", &[("c9", 5_000)])]),
    );
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(pane["live"], true);
    assert_eq!(pane["sessionRef"]["sessionId"], "S2"); // ref still reported; the CLIENT strips it (Task 4, D7)
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "live bound rows are excluded from ledgerOnly"
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
        &ev(),
    );
    let b = build_inventory(
        vec![union("dev1:t9")],
        vec![with_attribution(
            binding_row("codex", "C9", bound()),
            "c1",
            "dev1",
            "t9",
        )],
        no_live(),
        &ev(),
    );
    let c = build_inventory(
        vec![union("dev1:t8")],
        vec![with_attribution(
            binding_row("codex", "C8", bound()),
            "c1",
            "dev1",
            "t8",
        )],
        no_live(),
        &ev(),
    );
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
        &evidence(&[("dev1", &[("c1", 5_000)])]),
    );
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
        &evidence(&[("dev1", &[("c1", 5_000)])]),
    );
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

// ── D8 (restore-open-sessions-only) parent-relative judgment matrix ──────────
// A Bound, unreferenced, not-live row is offered ONLY while its own stamped
// parent's evidence cannot yet have observed its absence.

#[test]
fn attributed_row_within_grace_of_its_parent_is_offered() {
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
        &evidence(&[("d1", &[("c1", 1_000_000)])]),
    );
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
        &evidence(&[("d1", &[("c1", 1_000_000)])]),
    );
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
        &evidence(&[("d1", &[("c1", 1_000_000)])]),
    );
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
        &evidence(&[("d1", &[("c1", 1_000_000)])]),
    );
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
        &evidence(&[("d0", &[("c9", 8_000)]), ("d1", &[("c9", 8_000)])]),
    );
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
        &evidence(&[("d1", &[("c1", 1_000_000)])]),
    );
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
        &evidence(&[("d1", &[("c1", 1_000_000)])]),
    );
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
        &evidence(&[("d1", &[("c1", 1_000_000)])]),
    );
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
    let out = build_inventory(vec![d], vec![row], no_live(), &evidence);
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        1,
        "a backward clock step must never drop a kill-window row"
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
            "clientInstanceId": "c1", "deviceId": "dev1", "tabKey": "dev1:t9"
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
    // row_time = max(995_000, 994_000) = parent's capturedAt - 5_000: in grace.
    assert_eq!(entry["tabKey"], "dev1:t9");
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
