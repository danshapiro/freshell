//! Tab-route tests for [`crate::pane_ops`]'s tab lifecycle handlers and
//! `terminal_tabs::list_tabs` / the `POST /api/tabs` LayoutStore registration
//! (Task 14, AUTO-03). Split out per this branch's `layout_store_tests.rs`
//! precedent; shares `pane_ops_tests.rs`'s `pub(super)` request helpers.

use super::tests::{app, create_shell_tab, delete, get, patch, post, state_with_registry};
use super::*;

/// Seed the shared layout store the way Task 13's WS ingestion does: a
/// `ui.layout.sync` payload folded via `update_from_ui` (pattern from the
/// Task 12 store tests).
fn seed_layout(state: &FreshAgentState, payload: Value) {
    let sync: freshell_protocol::UiLayoutSync =
        serde_json::from_value(payload).expect("UiLayoutSync parses");
    state.layout.update_from_ui(&sync, "test-conn");
}

/// Two ordered tabs: `t1` (titled "First", active) and `t2` (untitled), one
/// terminal leaf each.
fn two_tab_layout() -> Value {
    json!({
        "tabs": [
            { "id": "t1", "title": "First" },
            { "id": "t2" },
        ],
        "activeTabId": "t1",
        "layouts": {
            "t1": { "type": "leaf", "id": "p1", "content": { "kind": "terminal" } },
            "t2": { "type": "leaf", "id": "p2", "content": { "kind": "terminal" } },
        },
        "activePane": { "t1": "p1", "t2": "p2" },
        "timestamp": 1,
    })
}

// ── auth ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn select_tab_requires_auth() {
    let state = state_with_registry();
    let (status, _) = post(app(state), "/api/tabs/nope/select", json!({}), false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn rename_tab_requires_auth() {
    let state = state_with_registry();
    let (status, _) = patch(app(state), "/api/tabs/nope", json!({"name":"x"}), false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn delete_tab_requires_auth() {
    let state = state_with_registry();
    let (status, _) = delete(app(state), "/api/tabs/nope", false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

// ── GET /api/tabs (store-backed rows) ────────────────────────────────────

#[tokio::test]
async fn get_tabs_reads_ordered_rows_from_the_layout_store() {
    let state = state_with_registry();
    seed_layout(&state, two_tab_layout());

    let (status, body) = get(app(state), "/api/tabs", true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let data = &body["data"];
    assert_eq!(data["activeTabId"], json!("t1"));
    let tabs = data["tabs"].as_array().expect("tabs array");
    assert_eq!(tabs.len(), 2, "{body}");
    // Ordered (snapshot order); Node-exact row shape {id, title, activePaneId}
    // (`listTabs`, layout-store.ts:327-334).
    assert_eq!(
        tabs[0],
        json!({ "id": "t1", "title": "First", "activePaneId": "p1" })
    );
    // Title falls back to the tab id; no legacy paneId/kind keys.
    assert_eq!(
        tabs[1],
        json!({ "id": "t2", "title": "t2", "activePaneId": "p2" })
    );
}

#[tokio::test]
async fn get_tabs_lists_rest_created_tabs_in_creation_order() {
    let state = state_with_registry();
    let router = app(state.clone());
    let tmp = std::env::temp_dir();
    let (_, shell_body) = post(
        router.clone(),
        "/api/tabs",
        json!({ "mode": "shell", "cwd": tmp.to_string_lossy() }),
        true,
    )
    .await;
    let (_, browser_body) = post(
        router.clone(),
        "/api/tabs",
        json!({ "browser": "https://example.com", "name": "Docs" }),
        true,
    )
    .await;
    let shell_tab = shell_body["data"]["tabId"].as_str().expect("shell tabId");
    let shell_terminal = shell_body["data"]["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let browser_tab = browser_body["data"]["tabId"].as_str().expect("tabId");
    let browser_pane = browser_body["data"]["paneId"].as_str().expect("paneId");

    let (status, body) = get(router, "/api/tabs", true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let tabs = body["data"]["tabs"].as_array().expect("tabs array");
    assert_eq!(tabs.len(), 2, "{body}");
    assert_eq!(tabs[0]["id"], json!(shell_tab));
    assert_eq!(
        tabs[0]["title"],
        json!(shell_tab),
        "untitled tab title falls back to its id"
    );
    assert_eq!(tabs[1]["id"], json!(browser_tab));
    assert_eq!(tabs[1]["title"], json!("Docs"));
    assert_eq!(tabs[1]["activePaneId"], json!(browser_pane));
    assert!(tabs[0].get("kind").is_none(), "no legacy kind key: {body}");
    assert!(
        tabs[0].get("paneId").is_none(),
        "no legacy paneId key: {body}"
    );
    assert_eq!(
        body["data"]["activeTabId"],
        json!(browser_tab),
        "create sets the active tab"
    );

    state
        .terminal_registry
        .clone()
        .unwrap()
        .kill(&shell_terminal);
}

// ── POST /api/tabs registers in the store ────────────────────────────────

#[tokio::test]
async fn rest_create_registers_tab_and_pane_content_in_the_layout_store() {
    let state = state_with_registry();
    let router = app(state.clone());
    let tmp = std::env::temp_dir();
    let (status, body) = post(
        router,
        "/api/tabs",
        json!({ "mode": "shell", "cwd": tmp.to_string_lossy(), "name": "My Shell" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let tab_id = body["data"]["tabId"].as_str().unwrap().to_string();
    let pane_id = body["data"]["paneId"].as_str().unwrap().to_string();
    let terminal_id = body["data"]["terminalId"].as_str().unwrap().to_string();

    // The store carries the tab under the SAME ids the route returned (Node
    // mints {tabId,paneId} via layoutStore.createTab, router.ts:740-744).
    let (rows, active) = state.layout.list_tabs();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0]["id"], json!(tab_id));
    assert_eq!(rows[0]["title"], json!("My Shell"));
    assert_eq!(rows[0]["activePaneId"], json!(pane_id));
    assert_eq!(active.as_deref(), Some(tab_id.as_str()));

    // attachPaneContent carried the SAME paneContent the route broadcast.
    let pane = state
        .layout
        .get_pane_snapshot(&pane_id)
        .expect("pane in store");
    assert_eq!(pane.kind.as_deref(), Some("terminal"));
    assert_eq!(pane.terminal_id.as_deref(), Some(terminal_id.as_str()));

    state.terminal_registry.clone().unwrap().kill(&terminal_id);
}

#[tokio::test]
async fn rest_browser_create_registers_content_in_the_layout_store() {
    let state = state_with_registry();
    let (status, body) = post(
        app(state.clone()),
        "/api/tabs",
        json!({ "browser": "https://example.com" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let pane_id = body["data"]["paneId"].as_str().unwrap().to_string();
    let pane = state
        .layout
        .get_pane_snapshot(&pane_id)
        .expect("pane in store");
    assert_eq!(pane.kind.as_deref(), Some("browser"));
    assert_eq!(
        pane.pane_content.expect("pane content")["url"],
        json!("https://example.com")
    );
}

#[tokio::test]
async fn failed_terminal_create_rolls_back_the_store_tab() {
    let state = state_with_registry();
    let (status, body) = post(
        app(state.clone()),
        "/api/tabs",
        json!({ "mode": "shell", "cwd": "/does/not/exist/anywhere" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    // Node's catch calls layoutStore.closeTab(createdTabId) (router.ts:824-830)
    // -- a failed spawn must not leave a phantom tab in the store.
    let (rows, _) = state.layout.list_tabs();
    assert!(rows.is_empty(), "no phantom store tab: {rows:?}");
}

// ── tab select ───────────────────────────────────────────────────────────

#[tokio::test]
async fn select_unknown_tab_still_broadcasts_but_reports_not_found() {
    let state = state_with_registry();
    let mut rx = state.broadcast_tx.subscribe();
    let (status, body) = post(
        app(state),
        "/api/tabs/does-not-exist/select",
        json!({}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["message"], json!("tab not found"));
    let frame = rx.recv().await.expect("legacy-exact: always broadcasts");
    let msg: Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(msg["command"], json!("tab.select"));
}

#[tokio::test]
async fn select_known_tab_succeeds() {
    let state = state_with_registry();
    let router = app(state.clone());
    let (tab_id, _pane_id, terminal_id) = create_shell_tab(router.clone()).await;

    let (status, body) = post(
        router,
        &format!("/api/tabs/{tab_id}/select"),
        json!({}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["tabId"], json!(tab_id));

    state.terminal_registry.clone().unwrap().kill(&terminal_id);
}

#[tokio::test]
async fn select_tab_persists_active_tab_id_in_the_store() {
    let state = state_with_registry();
    seed_layout(&state, two_tab_layout());
    let router = app(state.clone());

    let (status, body) = post(router.clone(), "/api/tabs/t2/select", json!({}), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["tabId"], json!("t2"));

    let (_, body) = get(router, "/api/tabs", true).await;
    assert_eq!(body["data"]["activeTabId"], json!("t2"));
}

// ── tab rename ───────────────────────────────────────────────────────────

#[tokio::test]
async fn rename_tab_missing_name_is_400() {
    let state = state_with_registry();
    let (status, body) = patch(app(state), "/api/tabs/does-not-exist", json!({}), true).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["message"], json!("name required"));
}

#[tokio::test]
async fn rename_with_no_snapshot_reports_no_layout_snapshot() {
    // Node parity for the no-client hole: no ui.layout.sync ever arrived and
    // no REST create seeded the store -> renameTab returns
    // { message: 'no layout snapshot' } (layout-store.ts:542-543).
    let state = state_with_registry();
    let mut rx = state.broadcast_tx.subscribe();
    let (status, body) = patch(app(state), "/api/tabs/t1", json!({"name":"X"}), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["message"], json!("no layout snapshot"));
    assert!(
        rx.try_recv().is_err(),
        "no tab.rename broadcast when nothing renamed"
    );
}

#[tokio::test]
async fn rename_unknown_tab_reports_not_found_and_does_not_broadcast() {
    let state = state_with_registry();
    seed_layout(&state, two_tab_layout());
    let mut rx = state.broadcast_tx.subscribe();
    let (status, body) = patch(
        app(state),
        "/api/tabs/does-not-exist",
        json!({"name":"New Name"}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["message"], json!("tab not found"));
    assert!(
        rx.try_recv().is_err(),
        "tab.rename broadcast fires only when renamed"
    );
}

#[tokio::test]
async fn rename_known_tab_broadcasts_tab_rename() {
    let state = state_with_registry();
    let router = app(state.clone());
    let mut rx = state.broadcast_tx.subscribe();
    let (tab_id, _pane_id, terminal_id) = create_shell_tab(router.clone()).await;
    let _ = rx.recv().await; // drain tab.create

    let (status, body) = patch(
        router,
        &format!("/api/tabs/{tab_id}"),
        json!({"name":"Renamed"}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["tabId"], json!(tab_id));

    let frame = rx.recv().await.expect("tab.rename broadcast");
    let msg: Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(msg["command"], json!("tab.rename"));
    assert_eq!(msg["payload"]["id"], json!(tab_id));
    assert_eq!(msg["payload"]["title"], json!("Renamed"));

    state.terminal_registry.clone().unwrap().kill(&terminal_id);
}

#[tokio::test]
async fn rename_updates_store_title_single_pane_mirror_and_legacy_record() {
    let state = state_with_registry();
    let router = app(state.clone());
    let (tab_id, pane_id, terminal_id) = create_shell_tab(router.clone()).await;

    let (status, body) = patch(
        router,
        &format!("/api/tabs/{tab_id}"),
        json!({"name":"Renamed"}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["tabId"], json!(tab_id));

    // The store row (and GET /api/tabs) carries the new title.
    let (rows, _) = state.layout.list_tabs();
    assert_eq!(rows[0]["title"], json!("Renamed"));
    // Single-pane mirror: the pane title goes sticky
    // (`renameTab`, layout-store.ts:542-556).
    let snap = state.layout.get_normalized_snapshot(None);
    assert_eq!(
        snap["paneTitles"][tab_id.as_str()][pane_id.as_str()],
        json!("Renamed")
    );
    assert_eq!(
        snap["paneTitleSetByUser"][tab_id.as_str()][pane_id.as_str()],
        json!(true)
    );
    // Legacy TabRecord.title stays updated (nothing reads it in production today; mirror pinned for consistency).
    assert_eq!(
        state
            .tabs
            .lock()
            .unwrap()
            .get(&tab_id)
            .expect("legacy record")
            .title
            .as_deref(),
        Some("Renamed")
    );

    state.terminal_registry.clone().unwrap().kill(&terminal_id);
}

// ── tab delete ───────────────────────────────────────────────────────────

#[tokio::test]
async fn delete_with_no_snapshot_reports_no_layout_snapshot_but_still_broadcasts() {
    let state = state_with_registry();
    let mut rx = state.broadcast_tx.subscribe();
    let (status, body) = delete(app(state), "/api/tabs/t1", true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["message"], json!("no layout snapshot"));
    let frame = rx.recv().await.expect("legacy-exact: always broadcasts");
    let msg: Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(msg["command"], json!("tab.close"));
}

#[tokio::test]
async fn delete_unknown_tab_reports_not_found_but_still_broadcasts() {
    let state = state_with_registry();
    seed_layout(&state, two_tab_layout());
    let mut rx = state.broadcast_tx.subscribe();
    let (status, body) = delete(app(state), "/api/tabs/does-not-exist", true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["message"], json!("tab not found"));
    let frame = rx.recv().await.expect("legacy-exact: always broadcasts");
    let msg: Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(msg["command"], json!("tab.close"));
}

#[tokio::test]
async fn delete_tab_removes_it_from_the_store_and_advances_active() {
    let state = state_with_registry();
    seed_layout(&state, two_tab_layout());
    let router = app(state.clone());

    let (status, body) = delete(router.clone(), "/api/tabs/t1", true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["tabId"], json!("t1"));

    let (_, body) = get(router, "/api/tabs", true).await;
    let tabs = body["data"]["tabs"].as_array().expect("tabs array");
    assert_eq!(tabs.len(), 1, "{body}");
    assert_eq!(tabs[0]["id"], json!("t2"));
    assert_eq!(
        body["data"]["activeTabId"],
        json!("t2"),
        "closeTab advances the active tab to the first remaining"
    );
}

#[tokio::test]
async fn delete_tab_removes_tab_and_every_owned_pane_without_killing_ptys() {
    let state = state_with_registry();
    let router = app(state.clone());
    let (tab_id, first_pane_id, first_terminal_id) = create_shell_tab(router.clone()).await;

    let tmp = std::env::temp_dir();
    let (status, split_body) = post(
        router.clone(),
        &format!("/api/panes/{first_pane_id}/split"),
        json!({ "cwd": tmp.to_string_lossy() }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{split_body}");
    let second_pane_id = split_body["data"]["paneId"].as_str().unwrap().to_string();
    let second_terminal_id = split_body["data"]["terminalId"]
        .as_str()
        .unwrap()
        .to_string();

    let (status, body) = delete(router, &format!("/api/tabs/{tab_id}"), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["tabId"], json!(tab_id));

    assert!(!state.tabs.lock().unwrap().contains_key(&tab_id));
    assert!(!state.pane_tabs.lock().unwrap().contains_key(&first_pane_id));
    assert!(!state
        .pane_tabs
        .lock()
        .unwrap()
        .contains_key(&second_pane_id));

    // No PTY kill on tab close (this module's documented parity finding) --
    // both terminals remain tracked + running in the shared registry.
    let registry = state.terminal_registry.clone().unwrap();
    assert!(registry.is_running(&first_terminal_id));
    assert!(registry.is_running(&second_terminal_id));

    registry.kill(&first_terminal_id);
    registry.kill(&second_terminal_id);
}

// ── tabs/has ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn tabs_has_requires_auth() {
    let state = state_with_registry();
    let (status, _) = get(app(state), "/api/tabs/has?target=nope", false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn tabs_has_false_for_missing_target() {
    let state = state_with_registry();
    let (status, body) = get(app(state), "/api/tabs/has", true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["exists"], json!(false));
}

#[tokio::test]
async fn tabs_has_empty_target_is_false_even_when_tabs_exist() {
    let state = state_with_registry();
    seed_layout(&state, two_tab_layout());
    let (status, body) = get(app(state), "/api/tabs/has?target=", true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["exists"], json!(false));
}

#[tokio::test]
async fn tabs_has_true_for_known_tab_id() {
    let state = state_with_registry();
    let router = app(state.clone());
    let (tab_id, _pane_id, terminal_id) = create_shell_tab(router.clone()).await;

    let (status, body) = get(router, &format!("/api/tabs/has?target={tab_id}"), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["exists"], json!(true));

    state.terminal_registry.clone().unwrap().kill(&terminal_id);
}

#[tokio::test]
async fn tabs_has_matches_by_title_too() {
    // `hasTab` matches id OR title (layout-store.ts:336-339).
    let state = state_with_registry();
    seed_layout(&state, two_tab_layout());
    let (status, body) = get(app(state), "/api/tabs/has?target=First", true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["exists"], json!(true));
}

#[tokio::test]
async fn tabs_has_false_for_unknown_tab_id() {
    let state = state_with_registry();
    let (status, body) = get(app(state), "/api/tabs/has?target=does-not-exist", true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["exists"], json!(false));
}

// ── tabs next/prev (ordered cycling on the store) ────────────────────────

#[tokio::test]
async fn tabs_next_requires_auth() {
    let state = state_with_registry();
    let (status, _) = post(app(state), "/api/tabs/next", json!({}), false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn tabs_prev_requires_auth() {
    let state = state_with_registry();
    let (status, _) = post(app(state), "/api/tabs/prev", json!({}), false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn tabs_next_with_no_tabs_reports_no_tabs_and_does_not_broadcast() {
    let state = state_with_registry();
    let mut rx = state.broadcast_tx.subscribe();
    let (status, body) = post(app(state), "/api/tabs/next", json!({}), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["message"], json!("no tabs"));
    assert_eq!(body["message"], json!("no tabs"));
    assert!(
        rx.try_recv().is_err(),
        "no tab.select broadcast without a resolved tab"
    );
}

#[tokio::test]
async fn tabs_prev_with_no_tabs_reports_no_tabs() {
    let state = state_with_registry();
    let (status, body) = post(app(state), "/api/tabs/prev", json!({}), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["message"], json!("no tabs"));
    assert_eq!(body["message"], json!("no tabs"));
}

#[tokio::test]
async fn tabs_next_cycles_in_snapshot_order_and_broadcasts_tab_select() {
    let state = state_with_registry();
    seed_layout(&state, two_tab_layout()); // active: t1
    let router = app(state.clone());
    let mut rx = state.broadcast_tx.subscribe();

    let (status, body) = post(router.clone(), "/api/tabs/next", json!({}), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["tabId"], json!("t2"));
    let frame = rx.recv().await.expect("tab.select broadcast");
    let msg: Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(msg["command"], json!("tab.select"));
    assert_eq!(msg["payload"]["id"], json!("t2"));

    // Wraps around modulo the ordered tab list.
    let (_, body) = post(router.clone(), "/api/tabs/next", json!({}), true).await;
    assert_eq!(body["data"]["tabId"], json!("t1"));

    // The selection persisted (GET /api/tabs reads it back).
    let (_, body) = get(router, "/api/tabs", true).await;
    assert_eq!(body["data"]["activeTabId"], json!("t1"));
}

#[tokio::test]
async fn tabs_prev_cycles_backwards_from_the_active_tab() {
    let state = state_with_registry();
    seed_layout(&state, two_tab_layout()); // active: t1
    let router = app(state.clone());

    let (status, body) = post(router.clone(), "/api/tabs/prev", json!({}), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["data"]["tabId"],
        json!("t2"),
        "prev from index 0 wraps to the last tab"
    );
    let (_, body) = post(router, "/api/tabs/prev", json!({}), true).await;
    assert_eq!(body["data"]["tabId"], json!("t1"));
}

// ── POST /api/tabs {"agent":"opencode"} registers in the store (A1) ────────

#[tokio::test]
async fn fresh_agent_rest_create_registers_tab_and_pane_in_the_layout_store() {
    let state = state_with_registry();
    let router = app(state.clone());
    let (status, body) = post(
        router.clone(),
        "/api/tabs",
        json!({ "agent": "opencode", "name": "My Agent" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let tab_id = body["data"]["tabId"].as_str().unwrap().to_string();
    let pane_id = body["data"]["paneId"].as_str().unwrap().to_string();

    // The store carries the tab under the SAME ids the route returned
    // (Node mints {tabId,paneId} via layoutStore.createTab, router.ts:701).
    let (rows, active) = state.layout.list_tabs();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0]["id"], json!(tab_id));
    assert_eq!(rows[0]["title"], json!("My Agent"));
    assert_eq!(rows[0]["activePaneId"], json!(pane_id));
    assert_eq!(active.as_deref(), Some(tab_id.as_str()));

    // GET /api/panes: fresh-agent kind, derived "OpenCode" title
    // (layout_store_content.rs:51), and NO terminalId key (absent = omitted).
    let (status, body) = get(router.clone(), "/api/panes", true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let panes = body["data"]["panes"].as_array().unwrap();
    assert_eq!(panes.len(), 1, "{panes:?}");
    assert_eq!(panes[0]["id"], json!(pane_id));
    assert_eq!(panes[0]["kind"], json!("fresh-agent"));
    assert_eq!(panes[0]["title"], json!("OpenCode"));
    assert!(panes[0].get("terminalId").is_none(), "{:?}", panes[0]);

    // GET /api/tabs over HTTP agrees with the store read.
    let (status, body) = get(router, "/api/tabs", true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["activeTabId"], json!(tab_id));
    assert_eq!(body["data"]["tabs"][0]["id"], json!(tab_id));
}

#[tokio::test]
async fn fresh_agent_rest_created_pane_renames_via_patch() {
    let state = state_with_registry();
    let router = app(state.clone());
    let (status, body) = post(
        router.clone(),
        "/api/tabs",
        json!({ "agent": "opencode" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let tab_id = body["data"]["tabId"].as_str().unwrap().to_string();
    let pane_id = body["data"]["paneId"].as_str().unwrap().to_string();

    let (status, body) = patch(
        router,
        &format!("/api/panes/{pane_id}"),
        json!({ "name": "Renamed Agent" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // Pre-fix this is {message:"pane not found"}; post-fix it is the real
    // rename result (router.ts:1420 shape), tabRenamed because single-pane.
    assert_eq!(body["data"]["tabId"], json!(tab_id), "{body}");
    assert_eq!(body["data"]["paneId"], json!(pane_id));
    assert_eq!(body["data"]["tabRenamed"], json!(true));

    let rows = state
        .layout
        .list_panes(Some(&tab_id))
        .expect("tab in store");
    assert_eq!(rows[0].title.as_deref(), Some("Renamed Agent"));
}

#[tokio::test]
async fn delete_fresh_agent_tab_cleans_legacy_shadow_maps() {
    let state = state_with_registry();
    let router = app(state.clone());
    let (status, body) = post(
        router.clone(),
        "/api/tabs",
        json!({ "agent": "opencode" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let tab_id = body["data"]["tabId"].as_str().unwrap().to_string();
    let pane_id = body["data"]["paneId"].as_str().unwrap().to_string();

    let (status, body) = delete(router, &format!("/api/tabs/{tab_id}"), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // delete_tab's legacy shadow cleanup is gated on
    // state.tabs.remove(..).is_some() (pane_ops.rs:485-491): without A1's
    // TabRecord registration the pane_tabs entry leaks.
    assert!(!state.tabs.lock().unwrap().contains_key(&tab_id));
    assert!(!state.pane_tabs.lock().unwrap().contains_key(&pane_id));
}
