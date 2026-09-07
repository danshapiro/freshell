//! Task 16 (`PATCH /api/panes/:id`, kills D10): store-backed rename ROUTE
//! tests. Split out of `lib.rs` per this branch's
//! `pane_ops_tests.rs`/`layout_store_tests.rs` precedent (`lib.rs` is already
//! over the 1,000-line ceiling). Formerly `rename_cascade_tests.rs`: the
//! syncable-terminal persistence cascade (`persistSyncableTerminalRename`,
//! `router.ts:649-693`) was removed in b5fb — the route is layout-only, and
//! the b5fb pins at the bottom hold GREEN by structural absence: no
//! persistence seam exists for the route to call, so each rename emits
//! exactly one `ui.command{pane.rename}` frame and zero `terminals.changed`
//! frames.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::response::Response;
use axum::Router;
use serde_json::{json, Value};
use tower::util::ServiceExt;

use super::FreshAgentState;

// ── helpers (oneshot pattern from `lib.rs`'s `rename_pane_tests`) ───────────

fn state_with(tx: tokio::sync::broadcast::Sender<String>) -> FreshAgentState {
    FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx))
}

async fn body_json(resp: Response) -> Value {
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

async fn patch_pane(router: Router, pane_id: &str, name: &str) -> (StatusCode, Value) {
    let req = Request::builder()
        .method("PATCH")
        .uri(format!("/api/panes/{pane_id}"))
        .header("content-type", "application/json")
        .header("x-auth-token", "tok")
        .body(Body::from(json!({ "name": name }).to_string()))
        .unwrap();
    let resp = router.oneshot(req).await.unwrap();
    let status = resp.status();
    (status, body_json(resp).await)
}

/// Create a REAL registry terminal via the Slice-1 shell-tab route, returning
/// its `terminalId` (`pane_ops_tests::create_shell_tab` pattern).
async fn create_registry_terminal(router: Router) -> String {
    let tmp = std::env::temp_dir();
    let req = Request::builder()
        .method("POST")
        .uri("/api/tabs")
        .header("content-type", "application/json")
        .header("x-auth-token", "tok")
        .body(Body::from(
            json!({ "mode": "shell", "cwd": tmp.to_string_lossy() }).to_string(),
        ))
        .unwrap();
    let resp = router.oneshot(req).await.unwrap();
    let status = resp.status();
    let body = body_json(resp).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["data"]["terminalId"].as_str().unwrap().to_string()
}

/// Seed the shared layout store the way Task 13's WS ingestion does
/// (`pane_ops_store_tests::seed_layout` pattern).
fn seed_layout(state: &FreshAgentState, payload: Value) {
    seed_layout_as(state, payload, "test-conn");
}

/// Same, but as a SPECIFIC client connection (multi-client layout store).
fn seed_layout_as(state: &FreshAgentState, payload: Value, conn_id: &str) {
    let sync: freshell_protocol::UiLayoutSync =
        serde_json::from_value(payload).expect("UiLayoutSync parses");
    state.layout.update_from_ui(&sync, conn_id);
}

/// One tab `t1` holding the lone leaf `p1` with the given content — the
/// single-pane-tab shape (`tabRenamed === true` per `router.ts:1414-1415`).
fn lone_pane_layout(content: Value) -> Value {
    json!({
        "tabs": [{ "id": "t1", "title": "First" }],
        "activeTabId": "t1",
        "layouts": { "t1": { "type": "leaf", "id": "p1", "content": content } },
        "activePane": { "t1": "p1" },
        "paneTitles": {},
        "paneTitleSetByUser": {},
        "timestamp": 1,
    })
}

fn drain_frames(rx: &mut tokio::sync::broadcast::Receiver<String>) -> Vec<Value> {
    let mut frames = Vec::new();
    while let Ok(frame) = rx.try_recv() {
        frames.push(serde_json::from_str(&frame).unwrap());
    }
    frames
}

// ── the route tests ──────────────────────────────────────────────────────────

/// Store rename + `ui.command{pane.rename}` broadcast + `tabRenamed:true` for
/// a single-pane tab (`router.ts:1408-1420`).
#[tokio::test]
async fn rename_pane_renames_store_and_broadcasts_ui_command() {
    let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
    let state = state_with(tx);
    seed_layout(&state, lone_pane_layout(json!({ "kind": "terminal" })));

    let (status, body) = patch_pane(crate::router(state.clone()), "p1", "New Name").await;

    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], json!("ok"));
    assert_eq!(body["data"]["tabId"], json!("t1"));
    assert_eq!(body["data"]["paneId"], json!("p1"));
    assert_eq!(body["data"]["tabRenamed"], json!(true), "{body}");
    assert_eq!(body["message"], json!("pane renamed"));

    // The STORE title changed (sticky pane title, `renamePane` layout-store.ts:558-575).
    let rows = state.layout.list_panes(Some("t1")).expect("panes list");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "p1");
    assert_eq!(rows[0].title.as_deref(), Some("New Name"));

    // Exactly one broadcast: `ui.command{pane.rename,{tabId,paneId,title}}`.
    let frames = drain_frames(&mut rx);
    assert_eq!(frames.len(), 1, "{frames:?}");
    assert_eq!(frames[0]["type"], json!("ui.command"));
    assert_eq!(frames[0]["command"], json!("pane.rename"));
    assert_eq!(
        frames[0]["payload"],
        json!({ "tabId": "t1", "paneId": "p1", "title": "New Name" })
    );
}

/// Unknown pane → Node's 200 `ok({message:'pane not found'})`
/// (`router.ts:1411`+`:1423` — result carries only `message`, no broadcast).
#[tokio::test]
async fn rename_pane_unknown_pane_is_200_with_message() {
    let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
    let state = state_with(tx);
    seed_layout(&state, lone_pane_layout(json!({ "kind": "terminal" })));

    let (status, body) = patch_pane(crate::router(state), "nope", "New Name").await;

    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], json!("ok"));
    assert_eq!(body["data"], json!({ "message": "pane not found" }));
    assert_eq!(body["message"], json!("pane not found"));
    assert!(drain_frames(&mut rx).is_empty(), "no broadcast on a miss");
}

// ── multi-client layout store (cross-client pane-id resolution fix) ─────────

/// A pane id known only to a NON-primary client connection must still rename,
/// and `tabRenamed` must be computed from the snapshot where the pane
/// resolved — NOT the primary's same-id tab. (Multi-client divergence from
/// Node's single shared snapshot; Node keeps last-writer-wins.)
#[tokio::test]
async fn rename_from_non_primary_client_succeeds_and_tab_renamed_uses_that_snapshot() {
    let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
    let state = state_with(tx);

    // conn-a: tab t1 is a SINGLE-pane tab holding p1.
    seed_layout_as(
        &state,
        lone_pane_layout(json!({ "kind": "terminal" })),
        "conn-a",
    );
    // conn-b (last writer / primary): the SAME tab id t1, but with TWO panes
    // b1/b2 — a different window's view of the workspace.
    seed_layout_as(
        &state,
        json!({
            "tabs": [{ "id": "t1", "title": "First" }],
            "activeTabId": "t1",
            "layouts": { "t1": {
                "type": "split", "id": "s1", "direction": "horizontal", "sizes": [50, 50],
                "children": [
                    { "type": "leaf", "id": "b1", "content": { "kind": "terminal" } },
                    { "type": "leaf", "id": "b2", "content": { "kind": "terminal" } },
                ],
            } },
            "activePane": { "t1": "b1" },
            "paneTitles": {},
            "paneTitleSetByUser": {},
            "timestamp": 2,
        }),
        "conn-b",
    );

    // p1 exists ONLY in conn-a's snapshot (conn-a is not the last writer).
    let (status, body) = patch_pane(crate::router(state.clone()), "p1", "Cross Client").await;

    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], json!("ok"));
    assert_eq!(body["data"]["tabId"], json!("t1"), "{body}");
    assert_eq!(body["data"]["paneId"], json!("p1"), "{body}");
    assert_eq!(
        body["data"]["tabRenamed"],
        json!(true),
        "tabRenamed must come from conn-a's snapshot (single-pane t1), not \
         the primary's two-pane t1: {body}"
    );

    // The primary's b1 keeps renaming too, and ITS tab is NOT single-pane.
    let (status, body) = patch_pane(crate::router(state), "b1", "Primary Pane").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["tabId"], json!("t1"));
    assert_eq!(body["data"]["tabRenamed"], json!(false), "{body}");

    // Both renames broadcast `ui.command{pane.rename}`.
    let frames = drain_frames(&mut rx);
    assert_eq!(frames.len(), 2, "{frames:?}");
    assert_eq!(
        frames[0]["payload"],
        json!({ "tabId": "t1", "paneId": "p1", "title": "Cross Client" })
    );
}

// ── b5fb pins: the pane-rename persistence cascade is deleted ────────────────

/// b5fb pin: renaming a SYNCABLE coding-CLI pane writes nothing beyond the
/// layout store — the registry title is untouched, no `terminals.changed`
/// fires, and exactly one `ui.command{pane.rename}` frame goes out. The RED
/// form wired a recording `RenamePersistence` fake into the old cascade and
/// watched it get called; GREEN holds by structural absence (the seam no
/// longer exists) observed through the wire frames.
#[tokio::test]
async fn rename_pane_never_cascades_for_a_syncable_claude_terminal() {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    let registry = freshell_terminal::TerminalRegistry::new();
    let state = state_with(tx.clone()).with_terminal_registry(registry.clone());

    let terminal_id = create_registry_terminal(crate::router(state.clone())).await;
    seed_layout(
        &state,
        lone_pane_layout(json!({
            "kind": "terminal",
            "mode": "claude",
            "terminalId": terminal_id,
            "sessionRef": { "provider": "claude", "sessionId": "sess-ref-1" },
        })),
    );

    // Subscribe AFTER the create so only the rename's frames are captured.
    let mut rx = tx.subscribe();
    let (status, body) = patch_pane(crate::router(state.clone()), "p1", "Local Only").await;

    assert_eq!(status, StatusCode::OK, "{body}");
    assert_ne!(
        registry.title_of(&terminal_id).as_deref(),
        Some("Local Only"),
        "registry title untouched by a pane rename"
    );
    let frames = drain_frames(&mut rx);
    assert!(
        frames
            .iter()
            .all(|f| f["type"] != json!("terminals.changed")),
        "no terminals.changed from a pane rename: {frames:?}"
    );
    let rename_frames: Vec<&Value> = frames
        .iter()
        .filter(|f| f["type"] == json!("ui.command") && f["command"] == json!("pane.rename"))
        .collect();
    assert_eq!(
        rename_frames.len(),
        1,
        "exactly one ui.command{{pane.rename}} frame: {frames:?}"
    );
}

/// b5fb pin: A→B→C pane reuse carries NO pane label into durable history.
/// Two renames of the same pane while bound to successive sessions: neither
/// emits `terminals.changed`, the registry title never takes a pane label,
/// and each rename yields exactly one `ui.command{pane.rename}` frame. The
/// RED form recorded the old cascade's `session_calls` (both sessions were
/// written); GREEN holds by structural absence observed through the frames.
#[tokio::test]
async fn pane_reuse_across_sessions_never_leaves_durable_titles() {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    let registry = freshell_terminal::TerminalRegistry::new();
    let state = state_with(tx.clone()).with_terminal_registry(registry.clone());

    let terminal_id = create_registry_terminal(crate::router(state.clone())).await;
    let mut rx = tx.subscribe();
    // Session A displayed
    seed_layout(
        &state,
        lone_pane_layout(json!({
            "kind": "terminal", "mode": "claude", "terminalId": terminal_id,
            "sessionRef": { "provider": "claude", "sessionId": "sess-A" },
        })),
    );
    let (status, body) = patch_pane(crate::router(state.clone()), "p1", "Reusable Name").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // Pane reused for session B
    seed_layout(
        &state,
        lone_pane_layout(json!({
            "kind": "terminal", "mode": "claude", "terminalId": terminal_id,
            "sessionRef": { "provider": "claude", "sessionId": "sess-B" },
        })),
    );
    let (status, body) = patch_pane(crate::router(state.clone()), "p1", "Reusable Name 2").await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let title = registry.title_of(&terminal_id);
    assert!(
        title.as_deref() != Some("Reusable Name") && title.as_deref() != Some("Reusable Name 2"),
        "registry title never takes a pane label: {title:?}"
    );
    let frames = drain_frames(&mut rx);
    assert!(
        frames
            .iter()
            .all(|f| f["type"] != json!("terminals.changed")),
        "no terminals.changed across pane reuse: {frames:?}"
    );
    let rename_frames: Vec<&Value> = frames
        .iter()
        .filter(|f| f["type"] == json!("ui.command") && f["command"] == json!("pane.rename"))
        .collect();
    assert_eq!(
        rename_frames.len(),
        2,
        "each rename yields exactly one ui.command{{pane.rename}} frame: {frames:?}"
    );
}
