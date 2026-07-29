//! Tests for the pure recovery-inventory builder (B3/P1.9 Task 1).

use super::*;
use freshell_recovery::RecoveryOwnerKey;
use freshell_ws::pane_ledger::{BindingRow, RetiredReason, RowState, LEDGER_VERSION};
use serde_json::json;
use std::collections::HashSet;

fn owner(provider: &str, session_id: &str, provider_scope: Option<&str>) -> RecoveryOwnerKey {
    RecoveryOwnerKey {
        provider: provider.to_string(),
        session_id: session_id.to_string(),
        provider_scope: provider_scope.map(str::to_string),
    }
}

fn no_live() -> HashSet<RecoveryOwnerKey> {
    HashSet::new()
}

fn live(pairs: &[(&str, &str)]) -> HashSet<RecoveryOwnerKey> {
    pairs.iter().map(|(p, s)| owner(p, s, None)).collect()
}

fn union_doc(device: &str, captured_at: u64, panes: serde_json::Value) -> serde_json::Value {
    json!({
        "deviceId": device, "deviceLabel": format!("label-{device}"), "capturedAt": captured_at,
        "records": [{ "tabKey": "k1", "tabId": "t1", "tabName": "work", "revision": 1,
                      "updatedAt": captured_at, "paneCount": 1, "panes": panes }]
    })
}

/// (state, retired_reason, superseded_by) parts for constructing a `BindingRow`.
type StateParts = (RowState, Option<RetiredReason>, Option<RecoveryOwnerKey>);

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
        Some(RecoveryOwnerKey {
            provider: provider.to_string(),
            session_id: session_id.to_string(),
            provider_scope: None,
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
        provider_scope: None,
        materialization: freshell_recovery::MaterializationState::Unknown,
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
    }
}

fn binding_row(provider: &str, session_id: &str, state_parts: StateParts) -> BindingRow {
    binding_row_at(provider, session_id, state_parts, 1000)
}

fn scoped_binding_row(
    provider: &str,
    session_id: &str,
    provider_scope: &str,
    state_parts: StateParts,
) -> BindingRow {
    let mut row = binding_row(provider, session_id, state_parts);
    row.provider_scope = Some(provider_scope.to_string());
    row
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

    let keys = live_session_keys(&registry, &identity, &[]);
    assert!(
        keys.contains(&owner("codex", "sess-live-1", None)),
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

    let keys = live_session_keys(&registry, &identity, &[]);
    assert!(!keys.contains(&owner("codex", "sess-gone", None)));
    assert!(!keys.contains(&owner("claude", "sess-retired", None)));
}

#[test]
fn empty_inputs_not_recoverable() {
    let out = build_inventory(vec![], vec![], no_live());
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
    let out = build_inventory(vec![old, new], vec![], no_live());
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
        binding_row("claude", "S2", bound()),
    ];
    let out = build_inventory(vec![d], bindings, no_live());
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
    let out = build_inventory(vec![d], bindings, no_live());
    let panes = out["device"]["tabs"][0]["panes"].as_array().unwrap();
    assert_eq!(panes[0]["ledgerState"], "closed");
    assert!(panes[0]["sessionRef"].is_null());
    assert_eq!(panes[1]["ledgerState"], "gc_expired");
    assert_eq!(panes[1]["sessionRef"]["sessionId"], "EXPIRED");
    assert_eq!(panes[2]["ledgerState"], "unknown");
    assert_eq!(panes[2]["sessionRef"]["sessionId"], "NOROW");
}

#[test]
fn unreferenced_bound_rows_become_ledger_only() {
    let out = build_inventory(vec![], vec![binding_row("codex", "C9", bound())], no_live());
    assert_eq!(out["recoverable"], true);
    assert_eq!(out["ledgerOnly"][0]["sessionId"], "C9");
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
    let out = build_inventory(
        vec![newer, older],
        vec![binding_row("codex", "C9", bound())],
        no_live(),
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
        binding_row("codex", "C9", bound()),
    ];
    let out = build_inventory(
        vec![d],
        bindings,
        live(&[("claude", "S2"), ("codex", "C9")]),
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
fn amplifier_supersession_uses_the_successors_complete_scoped_owner() {
    let scope = "/normalized/project";
    let predecessor = BindingRow {
        ledger_version: LEDGER_VERSION,
        provider: "amplifier".to_string(),
        session_id: "legacy-id".to_string(),
        provider_scope: None,
        materialization: freshell_recovery::MaterializationState::Unknown,
        mode: "amplifier".to_string(),
        cwd: Some("/old/raw".to_string()),
        live_terminal_id: None,
        create_request_id: None,
        created_at: 1,
        updated_at: 2,
        last_observed_at: 1,
        state: RowState::Retired,
        retired_reason: Some(RetiredReason::Superseded),
        superseded_by: Some(
            serde_json::from_value(json!({
                "provider": "amplifier",
                "sessionId": "scoped-id",
                "providerScope": scope,
            }))
            .unwrap(),
        ),
        pane_kind: None,
        model: None,
        sandbox: None,
        permission_mode: None,
        effort: None,
    };
    let successor = scoped_binding_row("amplifier", "scoped-id", scope, bound());
    let snapshot = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([{
                "paneId": "p1",
                "kind": "terminal",
                "payload": {
                    "mode": "amplifier",
                    "sessionRef": {
                        "provider": "amplifier",
                        "sessionId": "legacy-id"
                    }
                }
            }]),
        ),
    };
    let mut live_owners = HashSet::new();
    live_owners.insert(owner("amplifier", "scoped-id", Some(scope)));

    let out = build_inventory(vec![snapshot], vec![predecessor, successor], live_owners);
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(pane["ledgerState"], "bound");
    assert_eq!(pane["sessionRef"]["sessionId"], "scoped-id");
    assert_eq!(pane["live"], true);
    assert!(
        out["ledgerOnly"].as_array().unwrap().is_empty(),
        "the referenced scoped successor must not be re-offered as ledger-only"
    );
}

#[test]
fn amplifier_inventory_keeps_reference_liveness_and_content_scoped() {
    let scope_a = "/normalized/project-a";
    let scope_b = "/normalized/project-b";
    let rows = vec![
        scoped_binding_row("amplifier", "shared-id", scope_a, bound()),
        scoped_binding_row("amplifier", "shared-id", scope_b, bound()),
    ];
    let mut live_owners = HashSet::new();
    live_owners.insert(owner("amplifier", "shared-id", Some(scope_a)));

    let live_out = build_inventory(vec![], rows.clone(), live_owners);
    assert_eq!(
        live_out["ledgerOnly"].as_array().unwrap(),
        &[json!({
            "provider": "amplifier",
            "sessionId": "shared-id",
            "providerScope": scope_b,
            "mode": "amplifier",
            "cwd": "/x",
        })],
        "liveness in one Amplifier project must not suppress another project"
    );

    let unscoped_snapshot = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([{
                "paneId": "p1",
                "kind": "terminal",
                "payload": {
                    "mode": "amplifier",
                    "initialCwd": "/raw/project-a",
                    "sessionRef": {"provider": "amplifier", "sessionId": "shared-id"}
                }
            }]),
        ),
    };
    let referenced_out = build_inventory(vec![unscoped_snapshot], rows.clone(), no_live());
    assert_eq!(
        referenced_out["ledgerOnly"].as_array().unwrap(),
        &[
            json!({
                "provider": "amplifier",
                "sessionId": "shared-id",
                "providerScope": scope_a,
                "mode": "amplifier",
                "cwd": "/x",
            }),
            json!({
                "provider": "amplifier",
                "sessionId": "shared-id",
                "providerScope": scope_b,
                "mode": "amplifier",
                "cwd": "/x",
            }),
        ],
        "raw pane cwd is not a provider-resolved scope and must not suppress either owner"
    );

    let only_scope_b = build_inventory(vec![], vec![rows[1].clone()], no_live());
    let mut scope_c = rows[1].clone();
    scope_c.provider_scope = Some("/normalized/project-c".to_string());
    let only_scope_c = build_inventory(vec![], vec![scope_c], no_live());
    assert_ne!(
        only_scope_b["contentId"], only_scope_c["contentId"],
        "provider scope is recovery substance and must affect dismissal identity"
    );
}

#[test]
fn content_id_is_stable_and_input_sensitive() {
    let a = build_inventory(vec![], vec![binding_row("codex", "C9", bound())], no_live());
    let b = build_inventory(vec![], vec![binding_row("codex", "C9", bound())], no_live());
    let c = build_inventory(vec![], vec![binding_row("codex", "C8", bound())], no_live());
    assert_eq!(a["contentId"], b["contentId"]);
    assert_ne!(a["contentId"], c["contentId"]);
}

#[test]
fn content_id_ignores_timestamp_churn() {
    // A5/A6: heartbeat re-pushes bump capturedAt/updatedAt every <=5 min - dismissal must survive.
    let doc = |captured_at| {
        union_doc(
            "dev1",
            captured_at,
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        )
    };
    let a = build_inventory(
        vec![DeviceUnion {
            device_id: "dev1".into(),
            union_doc: doc(1000),
        }],
        vec![binding_row_at("codex", "C9", bound(), 1000)],
        no_live(),
    );
    let b = build_inventory(
        vec![DeviceUnion {
            device_id: "dev1".into(),
            union_doc: doc(2000),
        }],
        vec![binding_row_at("codex", "C9", bound(), 2000)],
        no_live(),
    );
    assert_eq!(
        a["contentId"], b["contentId"],
        "bumping only capturedAt/updatedAt must not change contentId"
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
    let ids = select_foreign_recent_generation_ids(&gens, "me", t_max + 1);
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
async fn route_serves_ledger_only_recovery_without_snapshots() {
    // Seed a binding file the ledger boot-scan will load (BindingRow camelCase JSON).
    let home = tempfile::tempdir().unwrap();
    let broot = home.path().join("pane-ledger");
    std::fs::create_dir_all(broot.join("bindings").join("claude")).unwrap();
    std::fs::write(
        broot.join("bindings").join("claude").join("S1.json"),
        serde_json::to_vec(&json!({
            "ledgerVersion": 1, "provider": "claude", "sessionId": "S1", "mode": "claude",
            "cwd": "/w", "createdAt": 1, "updatedAt": 1, "lastObservedAt": 1, "state": "bound"
        }))
        .unwrap(),
    )
    .unwrap();
    let router = router(test_state(None, Some(broot)));
    let (_, body) = get(
        router,
        "/api/recovery/inventory?clientInstanceId=me",
        Some("tok"),
    )
    .await;
    assert_eq!(body["recoverable"], true);
    assert_eq!(body["ledgerOnly"][0]["sessionId"], "S1");
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
    let ids = select_foreign_recent_generation_ids(&gens, "me", boot);
    assert!(
        ids.contains(&"gR".to_string()),
        "pre-boot client is real lost data - kept"
    );
    assert!(
        !ids.contains(&"gJ1".to_string()) && !ids.contains(&"gJ2".to_string()),
        "post-boot-only client is a concurrent fresh window - dropped"
    );
}
