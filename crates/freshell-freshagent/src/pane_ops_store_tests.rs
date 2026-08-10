//! Store-backed pane-route tests for [`crate::pane_ops`] +
//! [`crate::pane_resize`] (Task 15, AUTO-06 + honest snapshot): the pane REST
//! routes rebased onto the shared [`crate::layout_store::LayoutStore`]. Split
//! out per this branch's `pane_ops_tests.rs`/`pane_ops_tab_tests.rs` precedent
//! to keep every file under the 1,000-line ceiling; reuses the
//! `pub(super)` request helpers from `pane_ops_tests.rs`.

use super::tests::{app, create_shell_tab, get, post, state_with_registry};
use super::*;

/// Seed the shared layout store the way Task 13's WS ingestion does: a
/// `ui.layout.sync` payload folded via `update_from_ui` (pattern from the
/// Task 12 store tests).
fn seed_layout(state: &FreshAgentState, payload: Value) {
    let sync: freshell_protocol::UiLayoutSync =
        serde_json::from_value(payload).expect("UiLayoutSync parses");
    state.layout.update_from_ui(&sync, "test-conn");
}

/// Two ordered tabs: `t1` ("First", active) holds split `s1` over terminal
/// `p1` (sticky title "Build") and browser `p2` (derived title
/// "example.com"); `t2` ("Second") holds lone terminal `p3` (sticky title
/// "Build" -- the second "Build" makes that title AMBIGUOUS as a target).
/// Exact `json!` shape from the Task 12 tree tests.
fn split_layout() -> Value {
    json!({
        "tabs": [
            { "id": "t1", "title": "First" },
            { "id": "t2", "title": "Second" },
        ],
        "activeTabId": "t1",
        "layouts": {
            "t1": {
                "type": "split",
                "id": "s1",
                "direction": "horizontal",
                "sizes": [50, 50],
                "children": [
                    { "type": "leaf", "id": "p1", "content": { "kind": "terminal", "terminalId": "term-1" } },
                    { "type": "leaf", "id": "p2", "content": { "kind": "browser", "url": "https://example.com", "devToolsOpen": false } },
                ],
            },
            "t2": { "type": "leaf", "id": "p3", "content": { "kind": "terminal" } },
        },
        "activePane": { "t1": "p1", "t2": "p3" },
        "paneTitles": { "t1": { "p1": "Build" }, "t2": { "p3": "Build" } },
        "paneTitleSetByUser": { "t1": { "p1": true }, "t2": { "p3": true } },
        "timestamp": 7,
    })
}

async fn recv_command(rx: &mut tokio::sync::broadcast::Receiver<String>) -> Value {
    let frame = rx.recv().await.expect("broadcast frame");
    serde_json::from_str(&frame).unwrap()
}

// ── GET /api/layout/snapshot (honest store read) ───────────────────────────

#[tokio::test]
async fn layout_snapshot_returns_real_pane_node_trees_from_the_store() {
    let state = state_with_registry();
    seed_layout(&state, split_layout());

    let (status, body) = get(app(state), "/api/layout/snapshot", true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let data = &body["data"];
    assert_eq!(data["activeTabId"], json!("t1"));
    assert_eq!(data["tabs"][0]["id"], json!("t1"));
    assert_eq!(data["tabs"][1]["id"], json!("t2"));

    // A REAL split node -- the {"type":"unknown"} marker is dead.
    let root = &data["layouts"]["t1"];
    assert_eq!(root["type"], json!("split"), "{body}");
    assert_eq!(root["id"], json!("s1"));
    assert_eq!(root["sizes"], json!([50, 50]));
    assert_eq!(root["children"][0]["id"], json!("p1"));
    assert_eq!(root["children"][1]["id"], json!("p2"));
    assert_eq!(root["children"][1]["content"]["kind"], json!("browser"));
    assert_eq!(data["layouts"]["t2"]["type"], json!("leaf"));

    assert_eq!(data["activePane"], json!({ "t1": "p1", "t2": "p3" }));
    assert_eq!(data["paneTitles"]["t1"]["p1"], json!("Build"));
    assert_eq!(data["paneTitleSetByUser"]["t1"]["p1"], json!(true));
    assert_eq!(data["timestamp"], json!(7));
}

#[tokio::test]
async fn layout_snapshot_tab_filter_narrows_and_empty_param_is_none() {
    let state = state_with_registry();
    seed_layout(&state, split_layout());
    let router = app(state);

    let (status, body) = get(router.clone(), "/api/layout/snapshot?tabId=t2", true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let data = &body["data"];
    assert_eq!(data["tabs"].as_array().unwrap().len(), 1, "{body}");
    assert_eq!(data["tabs"][0]["id"], json!("t2"));
    assert_eq!(data["activeTabId"], json!("t2"));
    assert!(data["layouts"].get("t1").is_none(), "{body}");
    assert_eq!(data["layouts"]["t2"]["id"], json!("p3"));

    // Empty query param normalizes to None -> the FULL snapshot.
    let (status, body) = get(router, "/api/layout/snapshot?tabId=", true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["tabs"].as_array().unwrap().len(), 2, "{body}");
}

// ── GET /api/panes (store leaf order) ──────────────────────────────────────

#[tokio::test]
async fn list_panes_rows_are_store_leaf_order_with_optional_fields_omitted() {
    let state = state_with_registry();
    seed_layout(&state, split_layout());
    let router = app(state);

    // Default tab = the ACTIVE tab (t1); rows in depth-first leaf order.
    let (status, body) = get(router.clone(), "/api/panes", true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let panes = body["data"]["panes"].as_array().expect("panes array");
    assert_eq!(panes.len(), 2, "{body}");
    assert_eq!(
        panes[0],
        json!({ "id": "p1", "index": 0, "kind": "terminal", "terminalId": "term-1", "title": "Build" })
    );
    // Absent fields are OMITTED (Node JSON.stringify drops undefined) -- no
    // terminalId key on a browser pane.
    assert_eq!(
        panes[1],
        json!({ "id": "p2", "index": 1, "kind": "browser", "title": "example.com" })
    );

    let (status, body) = get(router, "/api/panes?tabId=t2", true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["data"]["panes"],
        json!([{ "id": "p3", "index": 0, "kind": "terminal", "title": "Build" }])
    );
}

#[tokio::test]
async fn list_panes_empty_store_is_empty_array() {
    let state = state_with_registry();
    let (status, body) = get(app(state), "/api/panes", true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["panes"], json!([]));
}

// ── POST /api/panes/:id/resize ─────────────────────────────────────────────

#[tokio::test]
async fn resize_validation_matrix_is_node_exact() {
    let cases: [(Value, &str); 8] = [
        (
            json!({ "sizes": [60] }),
            "sizes must contain exactly two values",
        ),
        (
            json!({ "sizes": [10, 20, 70] }),
            "sizes must contain exactly two values",
        ),
        (
            json!({ "sizes": ["abc", 40] }),
            "sizes values must be numeric",
        ),
        (
            json!({ "sizes": [0, 100] }),
            "sizes values must be within 1..99",
        ),
        (json!({ "x": "abc" }), "x must be numeric"),
        (json!({ "x": 0 }), "x must be within 1..99"),
        (json!({ "y": "abc" }), "y must be numeric"),
        (json!({ "y": 100 }), "y must be within 1..99"),
    ];
    for (case_body, expected) in cases {
        let state = state_with_registry();
        seed_layout(&state, split_layout());
        let (status, body) =
            post(app(state), "/api/panes/s1/resize", case_body.clone(), true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{case_body} -> {body}");
        assert_eq!(body["message"], json!(expected), "{case_body} -> {body}");
    }
}

#[tokio::test]
async fn resize_split_id_applies_normalized_sizes_and_broadcasts() {
    let state = state_with_registry();
    seed_layout(&state, split_layout());
    let router = app(state.clone());
    let mut rx = state.broadcast_tx.subscribe();

    let (status, body) = post(
        router.clone(),
        "/api/panes/s1/resize",
        json!({ "sizes": [60, 40] }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["tabId"], json!("t1"));
    assert_eq!(body["message"], json!("pane resized"));

    let msg = recv_command(&mut rx).await;
    assert_eq!(msg["command"], json!("pane.resize"));
    assert_eq!(
        msg["payload"],
        json!({ "tabId": "t1", "splitId": "s1", "sizes": [60, 40] })
    );

    let (_, body) = get(router, "/api/layout/snapshot?tabId=t1", true).await;
    assert_eq!(body["data"]["layouts"]["t1"]["sizes"], json!([60, 40]));
}

#[tokio::test]
async fn resize_pane_id_resizes_parent_split_with_x_y_and_current_fallbacks() {
    let state = state_with_registry();
    seed_layout(&state, split_layout());
    let router = app(state);

    // :id is a PANE id -> its parent split is resized, x -> [x, 100-x].
    let (status, body) = post(
        router.clone(),
        "/api/panes/p1/resize",
        json!({ "x": 70 }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["message"], json!("pane matched; resized parent split"));
    assert_eq!(body["data"]["tabId"], json!("t1"));
    let (_, snap) = get(router.clone(), "/api/layout/snapshot?tabId=t1", true).await;
    assert_eq!(snap["data"]["layouts"]["t1"]["sizes"], json!([70, 30]));

    // y -> [100-y, y].
    let (_, body) = post(
        router.clone(),
        "/api/panes/p1/resize",
        json!({ "y": 25 }),
        true,
    )
    .await;
    assert_eq!(body["message"], json!("pane matched; resized parent split"));
    let (_, snap) = get(router.clone(), "/api/layout/snapshot?tabId=t1", true).await;
    assert_eq!(snap["data"]["layouts"]["t1"]["sizes"], json!([75, 25]));

    // Neither -> the split's CURRENT sizes (normalized, unchanged).
    let (status, body) = post(router.clone(), "/api/panes/s1/resize", json!({}), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["message"], json!("pane resized"));
    let (_, snap) = get(router, "/api/layout/snapshot?tabId=t1", true).await;
    assert_eq!(snap["data"]["layouts"]["t1"]["sizes"], json!([75, 25]));
}

#[tokio::test]
async fn resize_unknown_target_and_splitless_pane_report_split_not_found() {
    let state = state_with_registry();
    seed_layout(&state, split_layout());
    let router = app(state.clone());
    let mut rx = state.broadcast_tx.subscribe();

    // Unknown target -> 200 with the message, NOT an error (router.ts:1459-1461).
    let (status, body) = post(router.clone(), "/api/panes/zzz/resize", json!({}), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["message"], json!("split not found"));
    assert_eq!(body["message"], json!("split not found"));

    // A pane WITHOUT a parent split (lone leaf) is the same 200.
    let (status, body) = post(router, "/api/panes/p3/resize", json!({}), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["message"], json!("split not found"));

    assert!(rx.try_recv().is_err(), "no pane.resize broadcast on a miss");
}

#[tokio::test]
async fn resize_ambiguous_pane_title_target_is_409() {
    let state = state_with_registry();
    seed_layout(&state, split_layout());
    // "Build" titles two panes (p1 in t1, p3 in t2).
    let (status, body) = post(app(state), "/api/panes/Build/resize", json!({}), true).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(
        body["message"],
        json!("pane target is ambiguous; use pane id or tab.pane index")
    );
}

// ── POST /api/panes/:id/swap (store swap) ──────────────────────────────────

#[tokio::test]
async fn swap_exchanges_content_and_both_title_maps_in_the_store() {
    let state = state_with_registry();
    seed_layout(&state, split_layout());
    let router = app(state.clone());
    let mut rx = state.broadcast_tx.subscribe();

    let (status, body) = post(
        router.clone(),
        "/api/panes/p1/swap",
        json!({ "target": "p2" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["tabId"], json!("t1"));
    assert_eq!(body["message"], json!("panes swapped"));

    let msg = recv_command(&mut rx).await;
    assert_eq!(msg["command"], json!("pane.swap"));
    assert_eq!(msg["payload"]["tabId"], json!("t1"));
    assert_eq!(msg["payload"]["paneId"], json!("p1"));
    assert_eq!(msg["payload"]["otherId"], json!("p2"));

    let (_, snap) = get(router, "/api/layout/snapshot?tabId=t1", true).await;
    let root = &snap["data"]["layouts"]["t1"];
    // Content exchanged in place (ids keep their tree position).
    assert_eq!(root["children"][0]["id"], json!("p1"));
    assert_eq!(root["children"][0]["content"]["kind"], json!("browser"));
    assert_eq!(root["children"][1]["id"], json!("p2"));
    assert_eq!(root["children"][1]["content"]["kind"], json!("terminal"));
    // BOTH title maps swapped; the other pane's missing sticky entry DELETES
    // yours (swapPane, layout-store.ts:625-652).
    assert_eq!(
        snap["data"]["paneTitles"]["t1"],
        json!({ "p1": "example.com", "p2": "Build" })
    );
    assert_eq!(
        snap["data"]["paneTitleSetByUser"]["t1"],
        json!({ "p2": true })
    );
}

#[tokio::test]
async fn swap_unknown_panes_report_200_panes_not_found_not_404() {
    let state = state_with_registry();
    seed_layout(&state, split_layout());
    let router = app(state.clone());
    let mut rx = state.broadcast_tx.subscribe();

    // Unknown :id falls back to the raw pane id (Node resolvePaneTarget) and
    // the store swap reports the graceful 200, fixing the 404 divergence
    // (survey B.4).
    let (status, body) = post(
        router.clone(),
        "/api/panes/does-not-exist/swap",
        json!({ "target": "p1" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["message"], json!("panes not found"));

    let (status, body) = post(
        router,
        "/api/panes/p1/swap",
        json!({ "target": "does-not-exist" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["message"], json!("panes not found"));

    assert!(rx.try_recv().is_err(), "no pane.swap broadcast on a miss");
}

// ── POST /api/panes/:id/select (store activePane) ──────────────────────────

#[tokio::test]
async fn select_pane_persists_active_pane_in_the_store() {
    let state = state_with_registry();
    seed_layout(&state, split_layout());
    let router = app(state.clone());
    let mut rx = state.broadcast_tx.subscribe();

    let (status, body) = post(router.clone(), "/api/panes/p2/select", json!({}), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["tabId"], json!("t1"));
    assert_eq!(body["data"]["paneId"], json!("p2"));

    let msg = recv_command(&mut rx).await;
    assert_eq!(msg["command"], json!("pane.select"));
    assert_eq!(msg["payload"]["paneId"], json!("p2"));

    let (_, snap) = get(router, "/api/layout/snapshot", true).await;
    assert_eq!(snap["data"]["activePane"]["t1"], json!("p2"));
}

// ── target resolution across the pane routes ───────────────────────────────

#[tokio::test]
async fn pane_target_resolution_supports_tab_title_index_forms_409_and_404() {
    let state = state_with_registry();
    seed_layout(&state, split_layout());
    let router = app(state);

    // Tab title -> that tab's active pane, with the resolver's message
    // surfaced as the envelope message (router.ts:1449).
    let (status, body) = post(router.clone(), "/api/panes/Second/select", json!({}), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["tabId"], json!("t2"));
    assert_eq!(body["data"]["paneId"], json!("p3"));
    assert_eq!(body["message"], json!("tab matched; active pane used"));

    // tab.pane index form.
    let (status, body) = post(router.clone(), "/api/panes/t1.1/select", json!({}), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["paneId"], json!("p2"));

    // Out-of-range numeric index into the active tab -> 404.
    let (status, body) = post(router.clone(), "/api/panes/9/select", json!({}), true).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["message"], json!("active tab used"));

    // Ambiguous pane title -> 409.
    let (status, body) = post(router, "/api/panes/Build/select", json!({}), true).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(
        body["message"],
        json!("pane target is ambiguous; use pane id or tab.pane index")
    );
}

#[tokio::test]
async fn pane_routes_on_an_empty_store_404_no_layout_snapshot() {
    // Node parity for the no-client hole: resolveTarget with no snapshot
    // yields { message: 'no layout snapshot' } -> rejectPaneTargetError 404.
    let state = state_with_registry();
    let router = app(state);
    for uri in [
        "/api/panes/p1/select",
        "/api/panes/p1/close",
        "/api/panes/p1/split",
    ] {
        let (status, body) = post(router.clone(), uri, json!({}), true).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri} -> {body}");
        assert_eq!(body["message"], json!("no layout snapshot"), "{uri}");
    }
}

// ── POST /api/panes/:id/close (store mutation) ─────────────────────────────

#[tokio::test]
async fn close_pane_rebuilds_the_store_layout_and_advances_active_pane() {
    let state = state_with_registry();
    seed_layout(&state, split_layout());
    let router = app(state.clone());
    let mut rx = state.broadcast_tx.subscribe();

    let (status, body) = post(router.clone(), "/api/panes/p1/close", json!({}), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["tabId"], json!("t1"));

    let msg = recv_command(&mut rx).await;
    assert_eq!(msg["command"], json!("pane.close"));
    assert_eq!(msg["payload"]["tabId"], json!("t1"));
    assert_eq!(msg["payload"]["paneId"], json!("p1"));

    let (_, snap) = get(router.clone(), "/api/layout/snapshot?tabId=t1", true).await;
    let root = &snap["data"]["layouts"]["t1"];
    assert_eq!(root["type"], json!("leaf"), "{snap}");
    assert_eq!(root["id"], json!("p2"));
    assert_eq!(snap["data"]["activePane"]["t1"], json!("p2"));

    // The store's own only-pane guard.
    let (status, body) = post(router, "/api/panes/p3/close", json!({}), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["message"], json!("cannot close only pane"));
}

// ── POST /api/panes/:id/split (store mutation) ─────────────────────────────

#[tokio::test]
async fn split_registers_the_new_pane_in_the_store_with_the_same_id() {
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
    let new_pane_id = split_body["data"]["paneId"].as_str().unwrap().to_string();
    let new_terminal_id = split_body["data"]["terminalId"]
        .as_str()
        .unwrap()
        .to_string();

    // The snapshot now shows a REAL split whose second leaf IS the pane the
    // route returned, carrying the spawned terminal's content.
    let (_, snap) = get(router.clone(), "/api/layout/snapshot", true).await;
    let root = &snap["data"]["layouts"][&tab_id];
    assert_eq!(root["type"], json!("split"), "{snap}");
    assert_eq!(root["children"][0]["id"], json!(first_pane_id));
    assert_eq!(root["children"][1]["id"], json!(new_pane_id));
    assert_eq!(
        root["children"][1]["content"]["terminalId"],
        json!(new_terminal_id)
    );

    // listPanes sees both leaves in order.
    let (_, panes_body) = get(router, &format!("/api/panes?tabId={tab_id}"), true).await;
    let panes = panes_body["data"]["panes"].as_array().expect("panes array");
    assert_eq!(panes.len(), 2, "{panes_body}");
    assert_eq!(panes[1]["id"], json!(new_pane_id));

    let registry = state.terminal_registry.clone().unwrap();
    registry.kill(&first_terminal_id);
    registry.kill(&new_terminal_id);
}

#[tokio::test]
async fn split_unknown_pane_with_snapshot_is_approx_not_applied() {
    let state = state_with_registry();
    seed_layout(&state, split_layout());
    let (status, body) = post(
        app(state),
        "/api/panes/does-not-exist/split",
        json!({}),
        true,
    )
    .await;
    // Node: `res.json(approx(result, 'pane split requested; not applied'))`
    // (router.ts:1312-1314).
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], json!("approx"));
    assert_eq!(body["message"], json!("pane split requested; not applied"));
}
