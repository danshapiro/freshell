//! Task 16 (`PATCH /api/panes/:id`, kills D10): store-backed rename +
//! syncable-terminal cascade tests. Split out of `lib.rs` per this branch's
//! `pane_ops_tests.rs`/`layout_store_tests.rs` precedent (`lib.rs` is already
//! over the 1,000-line ceiling). The legacy behavior under test:
//! `router.ts:1396-1427` + `persistSyncableTerminalRename` (`:649-693`).

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::response::Response;
use axum::Router;
use serde_json::{json, Value};
use tower::util::ServiceExt;

use super::rename_persistence::{BoxFuture, RenamePersistence};
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
    let sync: freshell_protocol::UiLayoutSync =
        serde_json::from_value(payload).expect("UiLayoutSync parses");
    state.layout.update_from_ui(&sync, "test-conn");
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

/// A recording fake `RenamePersistence` — captures both patch calls verbatim.
#[derive(Default)]
struct RecordingPersistence {
    terminal_calls: Mutex<Vec<(String, String)>>,
    session_calls: Mutex<Vec<(String, String)>>,
}

impl RenamePersistence for RecordingPersistence {
    fn patch_terminal_override_title(&self, terminal_id: &str, title: &str) -> BoxFuture<()> {
        self.terminal_calls
            .lock()
            .unwrap()
            .push((terminal_id.to_string(), title.to_string()));
        Box::pin(async {})
    }

    fn patch_session_override_title(&self, key: &str, title: &str) -> BoxFuture<()> {
        self.session_calls
            .lock()
            .unwrap()
            .push((key.to_string(), title.to_string()));
        Box::pin(async {})
    }
}

// ── the 5 Task-16 behavior tests ─────────────────────────────────────────────

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

/// A syncable (`mode:"claude"`) terminal pane cascades: both persistence
/// patches land with the right args (session key resolved via the explicit
/// `sessionRef` superset read — EDEV-11), the registry title is updated, and
/// `terminals.changed` is broadcast (`router.ts:668-690`).
#[tokio::test]
async fn rename_pane_cascades_to_syncable_terminal_via_injected_persistence() {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    let registry = freshell_terminal::TerminalRegistry::new();
    let fake = Arc::new(RecordingPersistence::default());
    let revision = Arc::new(AtomicI64::new(0));
    let state = state_with(tx.clone())
        .with_terminal_registry(registry.clone())
        .with_rename_persistence(Arc::clone(&fake) as Arc<dyn RenamePersistence>)
        .with_shared_terminals_revision(Arc::clone(&revision));

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
    let (status, body) = patch_pane(crate::router(state.clone()), "p1", "Cascade Title").await;

    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["tabRenamed"], json!(true), "{body}");
    assert_eq!(
        *fake.terminal_calls.lock().unwrap(),
        vec![(terminal_id.clone(), "Cascade Title".to_string())]
    );
    assert_eq!(
        *fake.session_calls.lock().unwrap(),
        vec![("claude:sess-ref-1".to_string(), "Cascade Title".to_string())]
    );
    // `registry.updateTitle` write-through (`router.ts:682`).
    assert_eq!(
        registry.title_of(&terminal_id).as_deref(),
        Some("Cascade Title")
    );

    // `terminals.changed` (shared revision bumped) + `ui.command{pane.rename}`.
    let frames = drain_frames(&mut rx);
    let changed = frames
        .iter()
        .find(|f| f["type"] == json!("terminals.changed"))
        .unwrap_or_else(|| panic!("no terminals.changed in {frames:?}"));
    assert_eq!(changed["revision"], json!(1));
    assert_eq!(revision.load(Ordering::SeqCst), 1);
    assert!(
        frames
            .iter()
            .any(|f| f["type"] == json!("ui.command") && f["command"] == json!("pane.rename")),
        "{frames:?}"
    );
}

/// A plain shell pane NEVER cascades (`mode` ∉ SYNCABLE_TERMINAL_MODES,
/// `router.ts:668`): no persistence calls, no `terminals.changed` — only the
/// `pane.rename` ui.command.
#[tokio::test]
async fn rename_pane_shell_pane_never_cascades() {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    let registry = freshell_terminal::TerminalRegistry::new();
    let fake = Arc::new(RecordingPersistence::default());
    let revision = Arc::new(AtomicI64::new(0));
    let state = state_with(tx.clone())
        .with_terminal_registry(registry.clone())
        .with_rename_persistence(Arc::clone(&fake) as Arc<dyn RenamePersistence>)
        .with_shared_terminals_revision(Arc::clone(&revision));

    let terminal_id = create_registry_terminal(crate::router(state.clone())).await;
    seed_layout(
        &state,
        lone_pane_layout(json!({
            "kind": "terminal",
            "mode": "shell",
            "terminalId": terminal_id,
        })),
    );

    let mut rx = tx.subscribe();
    let (status, body) = patch_pane(crate::router(state), "p1", "Shell Title").await;

    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(fake.terminal_calls.lock().unwrap().is_empty());
    assert!(fake.session_calls.lock().unwrap().is_empty());
    assert_eq!(revision.load(Ordering::SeqCst), 0);

    let frames = drain_frames(&mut rx);
    assert_eq!(frames.len(), 1, "{frames:?}");
    assert_eq!(frames[0]["command"], json!("pane.rename"));
}

/// validator-A10: an agent-api-created claude pane whose paneContent carries
/// NO `sessionRef`/`resumeSessionId` (`router.ts:762-773`) still cascades to
/// the session override, because the session binding lives in the terminal
/// REGISTRY (post-association metadata, resolved REGISTRY-FIRST per
/// `router.ts:658-676`).
#[tokio::test]
async fn rename_pane_cascades_via_registry_session_binding_without_pane_content_session_fields() {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    let registry = freshell_terminal::TerminalRegistry::new();
    let fake = Arc::new(RecordingPersistence::default());
    let revision = Arc::new(AtomicI64::new(0));
    let state = state_with(tx.clone())
        .with_terminal_registry(registry.clone())
        .with_rename_persistence(Arc::clone(&fake) as Arc<dyn RenamePersistence>)
        .with_shared_terminals_revision(Arc::clone(&revision));

    let terminal_id = create_registry_terminal(crate::router(state.clone())).await;
    // The session binding is seeded ONLY in the registry (what a locator
    // association writes back via `set_meta` with zero client involvement).
    registry.set_meta(
        &terminal_id,
        None,
        None,
        Some("claude".to_string()),
        Some("sess-a10".to_string()),
    );
    seed_layout(
        &state,
        lone_pane_layout(json!({
            "kind": "terminal",
            "mode": "claude",
            "terminalId": terminal_id,
        })),
    );

    let (status, body) = patch_pane(crate::router(state), "p1", "A10 Title").await;

    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        *fake.terminal_calls.lock().unwrap(),
        vec![(terminal_id.clone(), "A10 Title".to_string())]
    );
    assert_eq!(
        *fake.session_calls.lock().unwrap(),
        vec![("claude:sess-a10".to_string(), "A10 Title".to_string())],
        "registry-first resolution must find the association-learned binding"
    );
}
