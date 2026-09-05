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

// ── Task 4: REST fresh-agent resume (`sessionRef` on POST /api/tabs {agent:'opencode'}) ──
//
// The REST `create_tab` resume door: a `sessionRef` on the body resumes the
// referenced opencode session — a durable `ses_*` id directly, a
// `freshopencode-<createRequestId>` placeholder through the pane-identity
// ledger's `lookup_by_create_request_id` — with the resumed pane born-durable
// (placeholder_id = durable id, durable_id set from creation, fresh
// createRequestId) and merged settings (model/effort: body > ledger; cwd:
// ledger > serve-directory-from-probe > body). Failures are LOUD: 400
// malformed/provider-mismatch/unknown-shape, 404 unknown-or-unresolvable,
// 504 bounded-probe timeout, 502 other probe errors. The ledger is read-only
// on resume: no pending write, no binding write, and the LEDGER-BEFORE-PROBE
// ordering is load-bearing (the probe route carries the ledger cwd when one
// is recorded, never the body cwd — a wrong `?directory=` can fail the probe
// of a legitimate session).

use crate::identity_sink::{
    FakeIdentitySink, FreshAgentBindingUpsert, FreshAgentSettings, PaneIdentitySink,
};
use freshell_opencode::{
    Endpoint, EventSource, EventStreamHandle, OpencodeServeManager, PortAllocator, ServeConfig,
    ServeDeps, ServeHttp, ServeHttpError, ServeHttpRequest, ServeHttpResponse,
};
use std::sync::Arc;
use std::time::Duration;

/// A `ServeHttp` fake for the REST resume probe: answers `/global/health`
/// (so `ensure_started()` passes), serves each configured session at
/// `GET /session/:id`, 404s unknown sessions, optionally answers a scripted
/// error status for every session GET, optionally wedges (never resolves)
/// session GETs, and records the raw percent-encoded `directory` query of
/// EVERY session GET — the probe route, which proves the ledger-before-probe
/// ordering.
struct ResumeServeHttp {
    /// session id → the 200 body `GET /session/:id` serves.
    sessions: std::collections::HashMap<String, Value>,
    /// When Some(status), every session GET answers it (never 200/404).
    error_status: Option<u16>,
    /// Wedged-but-accepting serve (V5 caveat b): session GETs never resolve.
    wedged: bool,
    /// The raw `directory=…` query value of each session GET, in order.
    observed_directories: std::sync::Mutex<Vec<Option<String>>>,
}

impl ResumeServeHttp {
    fn with_sessions(sessions: &[(&str, Value)]) -> Self {
        Self {
            sessions: sessions
                .iter()
                .map(|(id, body)| (id.to_string(), body.clone()))
                .collect(),
            error_status: None,
            wedged: false,
            observed_directories: std::sync::Mutex::new(Vec::new()),
        }
    }

    fn wedged() -> Self {
        Self {
            sessions: std::collections::HashMap::new(),
            error_status: None,
            wedged: true,
            observed_directories: std::sync::Mutex::new(Vec::new()),
        }
    }

    fn erroring(error_status: u16) -> Self {
        Self {
            sessions: std::collections::HashMap::new(),
            error_status: Some(error_status),
            wedged: false,
            observed_directories: std::sync::Mutex::new(Vec::new()),
        }
    }
}

impl ServeHttp for ResumeServeHttp {
    fn request<'a>(
        &'a self,
        req: ServeHttpRequest,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<ServeHttpResponse, ServeHttpError>> + Send + 'a,
        >,
    > {
        if req.url.contains("/global/health") {
            return Box::pin(async move { Ok(ServeHttpResponse::new(200, b"{}".to_vec())) });
        }
        // Record the probe route BEFORE any resolution branch (the wedged leg
        // still proves which route the probe carried).
        let id = req
            .url
            .split("/session/")
            .nth(1)
            .and_then(|rest| rest.split(['/', '?']).next())
            .unwrap_or("")
            .to_string();
        let directory = req
            .url
            .split("directory=")
            .nth(1)
            .map(|rest| rest.split('&').next().unwrap_or("").to_string());
        self.observed_directories.lock().unwrap().push(directory);
        if self.wedged {
            return Box::pin(std::future::pending());
        }
        if let Some(status) = self.error_status {
            return Box::pin(async move { Ok(ServeHttpResponse::new(status, b"boom".to_vec())) });
        }
        match self.sessions.get(&id) {
            Some(body) => {
                let bytes = serde_json::to_vec(body).unwrap();
                Box::pin(async move { Ok(ServeHttpResponse::new(200, bytes)) })
            }
            None => Box::pin(async move { Ok(ServeHttpResponse::new(404, b"not found".to_vec())) }),
        }
    }
}

struct ResumeNoopSpawner;
impl freshell_opencode::ProcessSpawner for ResumeNoopSpawner {
    fn spawn(
        &self,
        _req: freshell_opencode::serve::SpawnRequest,
    ) -> Result<Box<dyn freshell_opencode::ServeProcess>, String> {
        struct NoopProcess;
        impl freshell_opencode::ServeProcess for NoopProcess {
            fn exited(&self) -> Option<i32> {
                None
            }
            fn take_fatal_startup_error(&self) -> Option<String> {
                None
            }
            fn kill(&self) {}
        }
        Ok(Box::new(NoopProcess))
    }
}

struct ResumeFakeAllocator;
impl PortAllocator for ResumeFakeAllocator {
    fn allocate(&self) -> Result<Endpoint, String> {
        Ok(Endpoint {
            hostname: "127.0.0.1".into(),
            port: 1,
        })
    }
}

struct ResumeNoopHandle;
impl EventStreamHandle for ResumeNoopHandle {}
struct ResumeNoopEventSource;
impl EventSource for ResumeNoopEventSource {
    fn connect(
        &self,
        _url: String,
        _sink: freshell_opencode::serve::EventSink,
    ) -> Box<dyn EventStreamHandle> {
        Box::new(ResumeNoopHandle)
    }
}

/// A fresh-agent REST state whose manager is backed by `http`, with the fake
/// pane-identity sink wired in. Mirrors `state_with_fixed_session_http`'s
/// shape (lib.rs tests) — the fakes are module-private there, so this file
/// carries its own copies per the brief.
async fn state_with_resume_http(
    http: Arc<ResumeServeHttp>,
) -> (FreshAgentState, Arc<FakeIdentitySink>) {
    let state = state_with_registry();
    let deps = ServeDeps {
        spawner: Arc::new(ResumeNoopSpawner),
        http,
        ports: Arc::new(ResumeFakeAllocator),
        events: Arc::new(ResumeNoopEventSource),
    };
    let manager = OpencodeServeManager::new(deps, ServeConfig::default());
    manager
        .ensure_started()
        .await
        .expect("healthy fake serve starts");
    state.set_manager_for_test(manager).await;
    let sink = Arc::new(FakeIdentitySink::default());
    state.set_identity_sink(sink.clone());
    (state, sink)
}

/// The body a `GET /session/:id` probe answers with (`directory: null` = the
/// serve has no directory for this session — distinct from a recorded one).
fn resume_session_body(id: &str, directory: Option<&str>) -> Value {
    json!({
        "id": id,
        "title": "resumed session",
        "time": { "created": 1i64, "updated": 2i64 },
        "directory": directory,
    })
}

/// Bounded bus drain asserting no frame contains `needle` (the Task 5
/// bounded-drain pattern, opencode_ws.rs tests).
async fn assert_no_frame_contains(rx: &mut tokio::sync::broadcast::Receiver<String>, needle: &str) {
    while let Ok(frame) = tokio::time::timeout(Duration::from_millis(500), rx.recv()).await {
        let Ok(text) = frame else { break };
        assert!(
            !text.contains(needle),
            "no frame may contain {needle:?}, saw: {text}"
        );
    }
}

#[tokio::test]
async fn rest_resume_durable_ses_is_born_durable_with_ledger_settings_and_route() {
    let http = Arc::new(ResumeServeHttp::with_sessions(&[(
        "ses_resumed_1",
        resume_session_body("ses_resumed_1", Some("/serve/dir")),
    )]));
    let (state, sink) = state_with_resume_http(http.clone()).await;
    // A settings-bearing ledger record (seeded directly, bypassing `seed()`
    // whose bindings-log row would muddy the no-binding-writes assertion).
    sink.settings.lock().unwrap().insert(
        ("opencode".to_string(), "ses_resumed_1".to_string()),
        FreshAgentSettings {
            model: Some("big-model".to_string()),
            sandbox: None,
            permission_mode: None,
            effort: Some("high".to_string()),
            cwd: Some("/real/project".to_string()),
        },
    );
    sink.recorded
        .lock()
        .unwrap()
        .insert(("opencode".to_string(), "ses_resumed_1".to_string()));

    let mut rx = state.broadcast_tx.subscribe();
    let (status, body) = post(
        app(state.clone()),
        "/api/tabs",
        json!({
            "agent": "opencode",
            "sessionRef": { "provider": "opencode", "sessionId": "ses_resumed_1" },
        }),
        true,
    )
    .await;

    assert_eq!(status, StatusCode::OK, "{body}");
    let data = &body["data"];
    assert_eq!(data["sessionId"], json!("ses_resumed_1"), "{body}");
    assert_eq!(
        data["sessionRef"],
        json!({ "provider": "opencode", "sessionId": "ses_resumed_1" }),
        "{body}"
    );
    assert_eq!(body["message"], json!("fresh-agent pane resumed"), "{body}");
    let tab_id = data["tabId"].as_str().expect("tabId").to_string();
    let pane_id = data["paneId"].as_str().expect("paneId").to_string();

    // Born-durable PaneEntry: the placeholder id IS the durable id (no
    // `freshopencode-*` id is ever minted for a resumed pane), durable_id set
    // from creation; settings merged ledger-first; cwd ledger > serve-dir.
    let pane = state
        .panes
        .lock()
        .unwrap()
        .get(&pane_id)
        .cloned()
        .expect("pane entry");
    assert_eq!(
        pane.placeholder_id, "ses_resumed_1",
        "a resumed pane is born-durable: no placeholder-prefixed id"
    );
    assert_eq!(pane.durable_id.as_deref(), Some("ses_resumed_1"));
    assert_eq!(
        pane.cwd.as_deref(),
        Some("/real/project"),
        "ledger cwd wins over the serve directory"
    );
    assert_eq!(pane.model.as_deref(), Some("big-model"));
    assert_eq!(pane.effort.as_deref(), Some("high"));

    // The layout-store paneContent carries the durable identities, status
    // "connected", and a fresh server-minted 32-hex createRequestId.
    let snap = state
        .layout
        .get_pane_snapshot(&pane_id)
        .expect("pane in store");
    let content = snap.pane_content.expect("fresh-agent content");
    assert_eq!(content["kind"], json!("fresh-agent"));
    assert_eq!(content["sessionType"], json!("freshopencode"));
    assert_eq!(content["provider"], json!("opencode"));
    assert_eq!(content["sessionId"], json!("ses_resumed_1"));
    assert_eq!(
        content["sessionRef"],
        json!({ "provider": "opencode", "sessionId": "ses_resumed_1" })
    );
    assert_eq!(content["status"], json!("connected"));
    assert_eq!(content["initialCwd"], json!("/real/project"));
    assert_eq!(content["model"], json!("big-model"));
    assert_eq!(content["effort"], json!("high"));
    let crid = content["createRequestId"]
        .as_str()
        .expect("fresh createRequestId");
    assert_eq!(crid.len(), 32, "expected Uuid::simple format, got {crid:?}");
    assert!(crid.chars().all(|c| c.is_ascii_hexdigit()));

    // The `ui.command` `tab.create` broadcast carries the same content.
    let frame = rx.recv().await.expect("tab.create broadcast");
    let msg: Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(msg["command"], json!("tab.create"));
    assert_eq!(msg["payload"]["id"], json!(tab_id));
    assert_eq!(msg["payload"]["paneId"], json!(pane_id));
    assert_eq!(
        msg["payload"]["paneContent"]["sessionId"],
        json!("ses_resumed_1")
    );
    assert_eq!(
        msg["payload"]["paneContent"]["sessionRef"],
        json!({ "provider": "opencode", "sessionId": "ses_resumed_1" })
    );

    // Ledger read-only on resume: NO pending marker, NO binding row; and the
    // bus carries NO materialized frame / sessions.changed (bounded drain).
    assert!(
        sink.pendings.lock().unwrap().is_empty(),
        "resume must not write a pending marker"
    );
    assert!(
        sink.bindings.lock().unwrap().is_empty(),
        "resume must not write a binding row"
    );
    assert_no_frame_contains(&mut rx, "session.materialized").await;
    assert_no_frame_contains(&mut rx, "sessions.changed").await;

    // LEDGER-BEFORE-PROBE: the probe route carried the recorded ledger cwd
    // (raw percent-encoded: `/real/project` → `%2Freal%2Fproject`), never the
    // body cwd (absent here) and never nothing.
    let observed = http.observed_directories.lock().unwrap().clone();
    assert_eq!(
        observed.len(),
        1,
        "exactly one session GET (the resume probe): {observed:?}"
    );
    assert_eq!(observed[0].as_deref(), Some("%2Freal%2Fproject"));
}

#[tokio::test]
async fn rest_resume_resolves_placeholder_sessionref_through_the_ledger() {
    let http = Arc::new(ResumeServeHttp::with_sessions(&[(
        "ses_placeholder_resumed",
        resume_session_body("ses_placeholder_resumed", None),
    )]));
    let (state, sink) = state_with_resume_http(http).await;
    // A lineage-only row (all-blank settings, create_request_id lineage —
    // exactly what the unconditional materialization write produces for a
    // default create) still answers `lookup_by_create_request_id`.
    sink.record_binding(FreshAgentBindingUpsert {
        provider: "opencode".into(),
        session_id: "ses_placeholder_resumed".into(),
        mode: "freshopencode".into(),
        create_request_id: Some("cr-abc123".into()),
        resolves_pending: Some("freshopencode-cr-abc123".into()),
        supersedes: None,
        settings: FreshAgentSettings::default(),
    })
    .await
    .expect("lineage binding write ok");

    let mut rx = state.broadcast_tx.subscribe();
    let (status, body) = post(
        app(state.clone()),
        "/api/tabs",
        json!({
            "agent": "opencode",
            "sessionRef": { "provider": "opencode", "sessionId": "freshopencode-cr-abc123" },
        }),
        true,
    )
    .await;

    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["data"]["sessionId"],
        json!("ses_placeholder_resumed"),
        "{body}"
    );
    assert_eq!(
        body["data"]["sessionRef"],
        json!({ "provider": "opencode", "sessionId": "ses_placeholder_resumed" }),
        "{body}"
    );

    // The lineage-only resume's complement (Task 3 keying): NO SETTINGS_RESET
    // may arm — the row was never settings-bearing, so the absence of a
    // recoverable snapshot is routine, not an anomaly.
    let _ = rx.recv().await; // drain tab.create
    assert_no_frame_contains(&mut rx, "SETTINGS_RESET").await;

    // The ledger is still read-only on resume: the only binding row is the
    // seeded lineage row itself.
    assert_eq!(sink.bindings.lock().unwrap().len(), 1);
    assert!(sink.pendings.lock().unwrap().is_empty());
}

#[tokio::test]
async fn rest_resume_unresolvable_placeholder_is_404_naming_it() {
    let http = Arc::new(ResumeServeHttp::with_sessions(&[]));
    let (state, _sink) = state_with_resume_http(http).await;

    // Leg 1: a sink is wired but has NO binding for this create requestId.
    let (status, body) = post(
        app(state.clone()),
        "/api/tabs",
        json!({
            "agent": "opencode",
            "sessionRef": { "provider": "opencode", "sessionId": "freshopencode-cr-unknown" },
        }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    let msg = body["message"].as_str().expect("error message");
    assert!(
        msg.contains("freshopencode-cr-unknown"),
        "the 404 message must name the unresolvable placeholder: {msg}"
    );

    // Leg 2: NO identity sink wired at all — same loud 404, never a silent
    // fresh-placeholder substitution.
    let bare = state_with_registry();
    let (status, body) = post(
        app(bare),
        "/api/tabs",
        json!({
            "agent": "opencode",
            "sessionRef": { "provider": "opencode", "sessionId": "freshopencode-cr-unknown" },
        }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");

    // Loud-failure hygiene: no tab/pane was minted for either rejected resume.
    let (rows, _) = state.layout.list_tabs();
    assert!(
        rows.is_empty(),
        "no phantom tab on a rejected resume: {rows:?}"
    );
    assert!(state.panes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn rest_resume_unknown_durable_ses_is_404() {
    let http = Arc::new(ResumeServeHttp::with_sessions(&[]));
    let (state, _sink) = state_with_resume_http(http).await;

    let (status, body) = post(
        app(state.clone()),
        "/api/tabs",
        json!({
            "agent": "opencode",
            "sessionRef": { "provider": "opencode", "sessionId": "ses_unknown_9" },
        }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");

    let (rows, _) = state.layout.list_tabs();
    assert!(
        rows.is_empty(),
        "no phantom tab on a rejected resume: {rows:?}"
    );
    assert!(state.panes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn rest_resume_provider_mismatch_is_400() {
    let http = Arc::new(ResumeServeHttp::with_sessions(&[]));
    let (state, _sink) = state_with_resume_http(http).await;

    for provider in ["claude", "kimi", "codex"] {
        let (status, body) = post(
            app(state.clone()),
            "/api/tabs",
            json!({
                "agent": "opencode",
                "sessionRef": { "provider": provider, "sessionId": "ses_x" },
            }),
            true,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "provider {provider} must be rejected loudly: {body}"
        );
    }
}

#[tokio::test]
async fn rest_resume_malformed_sessionref_is_400() {
    let http = Arc::new(ResumeServeHttp::with_sessions(&[]));
    let (state, _sink) = state_with_resume_http(http).await;

    for (label, session_ref) in [
        ("missing sessionId", json!({ "provider": "opencode" })),
        ("non-object", json!("ses_x")),
        // Neither a durable ses_* id nor a freshopencode- placeholder —
        // an unknown IDENTITY shape, rejected lest it be silently ignored.
        (
            "unknown id shape",
            json!({ "provider": "opencode", "sessionId": "thread-9" }),
        ),
    ] {
        let (status, body) = post(
            app(state.clone()),
            "/api/tabs",
            json!({ "agent": "opencode", "sessionRef": session_ref }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{label}: {body}");
    }
}

#[tokio::test]
async fn rest_resume_dual_carrier_hits_the_frozen_legacy_refusal() {
    let http = Arc::new(ResumeServeHttp::with_sessions(&[]));
    let (state, _sink) = state_with_resume_http(http).await;

    // A body carrying BOTH `resumeSessionId` and `sessionRef` hits the frozen
    // door-top legacy refusal BEFORE the agent gate — the resume branch never
    // evaluates.
    let (status, body) = post(
        app(state),
        "/api/tabs",
        json!({
            "agent": "opencode",
            "resumeSessionId": "ses_legacy",
            "sessionRef": { "provider": "opencode", "sessionId": "ses_resumed_1" },
        }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(
        body["message"],
        json!(
            "Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."
        ),
        "LEGACY_RESUME_IDENTITY_REFUSAL text is frozen: {body}"
    );
}

#[tokio::test]
async fn rest_resume_probe_timeout_is_bounded_and_504() {
    // The wedged-but-accepting serve shape (V5 caveat b): session GETs never
    // resolve. The probe MUST be bounded — and the budget MUST come from the
    // cfg(test) state injection (never the process-global env var, which an
    // opencode_ws.rs test already sets/removes unsynchronized).
    let http = Arc::new(ResumeServeHttp::wedged());
    let (state, _sink) = state_with_resume_http(http).await;
    state.set_resume_probe_timeout_ms_for_test(50);

    let started = std::time::Instant::now();
    let (status, body) = post(
        app(state),
        "/api/tabs",
        json!({
            "agent": "opencode",
            "sessionRef": { "provider": "opencode", "sessionId": "ses_wedged_1" },
        }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::GATEWAY_TIMEOUT, "{body}");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "the probe must be bounded by the injected budget, not the 10s default ({:?})",
        started.elapsed()
    );
}

#[tokio::test]
async fn rest_resume_probe_error_other_than_notfound_or_timeout_is_502() {
    let http = Arc::new(ResumeServeHttp::erroring(500));
    let (state, _sink) = state_with_resume_http(http).await;

    let (status, body) = post(
        app(state),
        "/api/tabs",
        json!({
            "agent": "opencode",
            "sessionRef": { "provider": "opencode", "sessionId": "ses_erroring_1" },
        }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{body}");
}

#[tokio::test]
async fn rest_resume_probe_carries_no_directory_without_ledger_cwd_and_serve_dir_beats_body_cwd() {
    let http = Arc::new(ResumeServeHttp::with_sessions(&[(
        "ses_unrecorded_1",
        resume_session_body("ses_unrecorded_1", Some("/serve/dir")),
    )]));
    let (state, _sink) = state_with_resume_http(http.clone()).await;
    // The sink is wired but has NO record for this session: the probe route
    // must carry NO directory — the body cwd is LAST in cwd precedence and a
    // wrong `?directory=` can fail the probe of a legitimate session.

    let mut rx = state.broadcast_tx.subscribe();
    let (status, body) = post(
        app(state.clone()),
        "/api/tabs",
        json!({
            "agent": "opencode",
            "cwd": "/body/cwd",
            "sessionRef": { "provider": "opencode", "sessionId": "ses_unrecorded_1" },
        }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let observed = http.observed_directories.lock().unwrap().clone();
    assert_eq!(
        observed,
        vec![None],
        "the probe must carry NO directory without a ledger cwd (never the body cwd): {observed:?}"
    );

    // serve-directory-from-probe beats the body cwd.
    let pane_id = body["data"]["paneId"].as_str().expect("paneId").to_string();
    let pane = state
        .panes
        .lock()
        .unwrap()
        .get(&pane_id)
        .cloned()
        .expect("pane entry");
    assert_eq!(pane.cwd.as_deref(), Some("/serve/dir"));

    // Never-recorded resume is ROUTINE: no SETTINGS_RESET (subscription
    // predates the POST, so a frame emitted mid-resume could not be missed).
    let _ = rx.recv().await; // drain tab.create
    assert_no_frame_contains(&mut rx, "SETTINGS_RESET").await;
}

#[tokio::test]
async fn rest_resume_uses_body_cwd_when_ledger_and_serve_directory_are_absent() {
    let http = Arc::new(ResumeServeHttp::with_sessions(&[(
        "ses_no_dir_1",
        resume_session_body("ses_no_dir_1", None),
    )]));
    let (state, _sink) = state_with_resume_http(http).await;

    // No ledger record, serve answers `directory: null` — the body cwd is the
    // FINAL fallback (an implementation that drops body cwd entirely fails
    // this leg).
    let (status, body) = post(
        app(state.clone()),
        "/api/tabs",
        json!({
            "agent": "opencode",
            "cwd": "/body/cwd",
            "sessionRef": { "provider": "opencode", "sessionId": "ses_no_dir_1" },
        }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let pane_id = body["data"]["paneId"].as_str().expect("paneId").to_string();
    let pane = state
        .panes
        .lock()
        .unwrap()
        .get(&pane_id)
        .cloned()
        .expect("pane entry");
    assert_eq!(
        pane.cwd.as_deref(),
        Some("/body/cwd"),
        "body cwd is the final cwd fallback"
    );
    let snap = state
        .layout
        .get_pane_snapshot(&pane_id)
        .expect("pane in store");
    assert_eq!(
        snap.pane_content.expect("content")["initialCwd"],
        json!("/body/cwd")
    );
}

#[tokio::test]
async fn rest_resume_body_model_and_effort_beat_the_ledger_record() {
    let http = Arc::new(ResumeServeHttp::with_sessions(&[(
        "ses_override_1",
        resume_session_body("ses_override_1", None),
    )]));
    let (state, sink) = state_with_resume_http(http).await;
    sink.settings.lock().unwrap().insert(
        ("opencode".to_string(), "ses_override_1".to_string()),
        FreshAgentSettings {
            model: Some("big-model".to_string()),
            sandbox: None,
            permission_mode: None,
            effort: Some("high".to_string()),
            cwd: None,
        },
    );
    sink.recorded
        .lock()
        .unwrap()
        .insert(("opencode".to_string(), "ses_override_1".to_string()));

    let (status, body) = post(
        app(state.clone()),
        "/api/tabs",
        json!({
            "agent": "opencode",
            "model": "small-model",
            "effort": "low",
            "sessionRef": { "provider": "opencode", "sessionId": "ses_override_1" },
        }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let pane_id = body["data"]["paneId"].as_str().expect("paneId").to_string();
    let pane = state
        .panes
        .lock()
        .unwrap()
        .get(&pane_id)
        .cloned()
        .expect("pane entry");
    assert_eq!(
        pane.model.as_deref(),
        Some("small-model"),
        "explicit request model beats the ledger"
    );
    assert_eq!(
        pane.effort.as_deref(),
        Some("low"),
        "explicit request effort beats the ledger"
    );
}

#[tokio::test]
async fn rest_resume_recorded_but_unrecoverable_settings_alarm_and_proceeds() {
    let http = Arc::new(ResumeServeHttp::with_sessions(&[(
        "ses_reset_1",
        resume_session_body("ses_reset_1", Some("/serve/dir")),
    )]));
    let (state, sink) = state_with_resume_http(http).await;
    // was_recorded=true with load_settings=None — the V7/A10 alarm-positive
    // fixture (the genuine "recorded but unrecoverable" anomaly).
    sink.seed_recorded_only("opencode", "ses_reset_1");

    let mut rx = state.broadcast_tx.subscribe();
    let (status, body) = post(
        app(state.clone()),
        "/api/tabs",
        json!({
            "agent": "opencode",
            "sessionRef": { "provider": "opencode", "sessionId": "ses_reset_1" },
        }),
        true,
    )
    .await;
    // The alarm must NOT fail the resume (mirror opencode_ws.rs:1506-1541).
    assert_eq!(status, StatusCode::OK, "{body}");

    let mut found = false;
    while let Ok(frame) = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await {
        let Ok(text) = frame else { break };
        if text.contains("SETTINGS_RESET") {
            let frame: Value = serde_json::from_str(&text).unwrap();
            // Top-level sessionType/provider (locator resolution) + a
            // user-facing message (the banner shows the message, not the code).
            assert_eq!(frame["sessionType"], "freshopencode");
            assert_eq!(frame["provider"], "opencode");
            assert_eq!(frame["event"]["code"], "SETTINGS_RESET");
            assert!(frame["event"]["message"]
                .as_str()
                .unwrap()
                .contains("Reconfirm your settings"));
            found = true;
            break;
        }
    }
    assert!(
        found,
        "recorded-but-unrecoverable resume must broadcast SETTINGS_RESET"
    );

    // …and the resume proceeded with DEFAULTS (no model/effort to recover;
    // cwd still merges serve-dir > body).
    let pane_id = body["data"]["paneId"].as_str().expect("paneId").to_string();
    let pane = state
        .panes
        .lock()
        .unwrap()
        .get(&pane_id)
        .cloned()
        .expect("pane entry");
    assert_eq!(pane.model, None);
    assert_eq!(pane.effort, None);
    assert_eq!(pane.cwd.as_deref(), Some("/serve/dir"));
}
