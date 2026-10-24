use super::tests::{app, delete, get, post, state_with_registry};
use crate::rest_lane::*;
use axum::http::StatusCode;
use serde_json::json;
use std::sync::Arc;

#[derive(Default)]
struct PausedCreateLane {
    started: tokio::sync::Notify,
    finish: tokio::sync::Notify,
    request: std::sync::Mutex<Option<RestLaneCreate>>,
    running: std::sync::atomic::AtomicBool,
}

#[async_trait::async_trait]
impl FreshAgentRestLane for PausedCreateLane {
    async fn create_agent(
        self: Arc<Self>,
        request: RestLaneCreate,
    ) -> Result<RestLaneCreated, RestLaneError> {
        *self.request.lock().unwrap() = Some(request);
        self.started.notify_one();
        self.finish.notified().await;
        self.running
            .store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(RestLaneCreated {
            session_id: "late-runtime".into(),
            cleanup_token: Some("late-runtime-owner".into()),
            ..Default::default()
        })
    }
    async fn send_agent(&self, _: RestLaneSend) -> Result<RestLaneSendResult, RestLaneError> {
        unreachable!("the closed pane must never accept a send")
    }
    async fn abandon_create(
        &self,
        request: &RestLaneCreate,
        created: &RestLaneCreated,
    ) -> Result<(), RestLaneError> {
        assert_eq!(
            request.request_id,
            self.request.lock().unwrap().as_ref().unwrap().request_id
        );
        assert_eq!(created.cleanup_token.as_deref(), Some("late-runtime-owner"));
        self.running
            .store(false, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum CloseDuringCreate {
    Tab,
    SourcePane { sync_layout: bool },
    PendingPane,
}

async fn close_during_create(target: CloseDuringCreate) {
    let split = matches!(target, CloseDuringCreate::SourcePane { .. });
    let state = state_with_registry();
    let before: freshell_protocol::UiLayoutSync = serde_json::from_value(json!({
        "tabs":[{"id":"current-tab"}], "activeTabId":"current-tab", "timestamp":1,
        "layouts":{"current-tab":{"type":"split", "id":"ancestor", "direction":"horizontal", "sizes":[50,50], "children":[
            {"type":"leaf", "id":"source-pane", "content":{"kind":"terminal", "mode":"shell", "createRequestId":"source-create"}},
            {"type":"leaf", "id":"sibling-pane", "content":{"kind":"browser", "url":"https://survivor.example"}},
        ]}}, "activePane":{"current-tab":"source-pane"},
    })).unwrap();
    state.layout.update_from_ui(&before, "creating-browser");
    let lane = Arc::new(PausedCreateLane::default());
    state.set_claude_rest_lane(lane.clone()).unwrap();
    let router = app(state.clone());
    let create_router = router.clone();
    let mut events = state.broadcast_tx.subscribe();
    let creating = tokio::spawn(async move {
        post(
            create_router,
            if split {
                "/api/panes/source-pane/split"
            } else {
                "/api/tabs"
            },
            json!({"agent":"claude"}),
            true,
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), lane.started.notified())
        .await
        .unwrap();
    let request = lane.request.lock().unwrap().clone().unwrap();
    if let CloseDuringCreate::SourcePane { sync_layout } = target {
        let (status, closed) = post(
            router.clone(),
            "/api/panes/source-pane/close",
            json!({}),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{closed}");
        // The closing browser's next sync excludes the not-yet-announced
        // split too: it never knew that tentative pane existed.
        let closed: freshell_protocol::UiLayoutSync = serde_json::from_value(json!({
            "tabs":[{"id":"current-tab"}], "activeTabId":"current-tab", "timestamp":2,
            "layouts":{"current-tab":{"type":"leaf", "id":"sibling-pane", "content":{"kind":"browser", "url":"https://survivor.example"}}},
            "activePane":{"current-tab":"sibling-pane"},
        })).unwrap();
        if sync_layout {
            state.layout.update_from_ui(&closed, "creating-browser");
        }
    } else if matches!(target, CloseDuringCreate::PendingPane) {
        state.layout.release_pane_publication(&request.request_id);
    } else {
        let (status, closed) = delete(
            router.clone(),
            &format!("/api/tabs/{}", request.tab_id.as_deref().unwrap()),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{closed}");
    }
    lane.finish.notify_one();
    let (status, result) = creating.await.unwrap();
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "a closed create target must not publish success: {result}"
    );
    assert_eq!(result["code"], "PANE_CREATE_CANCELLED");
    assert_eq!(result["retryable"], false);
    assert!(
        !lane.running.load(std::sync::atomic::Ordering::SeqCst),
        "the late owned runtime must be cleaned up"
    );
    assert!(state
        .layout
        .get_pane_snapshot(request.pane_id.as_deref().unwrap())
        .is_none());
    while let Ok(frame) = events.try_recv() {
        let frame: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert!(
            !matches!(frame["command"].as_str(), Some("pane.split" | "tab.create")),
            "an abandoned create must not be announced: {frame}"
        );
    }
    assert_eq!(
        state
            .layout
            .get_pane_snapshot("sibling-pane")
            .unwrap()
            .pane_content
            .unwrap()["url"],
        "https://survivor.example"
    );
}

#[tokio::test]
async fn closing_the_target_tab_while_runtime_create_awaits_cleans_the_late_runtime() {
    close_during_create(CloseDuringCreate::Tab).await;
}

#[tokio::test]
async fn closing_the_source_pane_while_runtime_create_awaits_cleans_the_late_runtime() {
    close_during_create(CloseDuringCreate::SourcePane { sync_layout: true }).await;
}

#[tokio::test]
async fn closing_the_source_before_its_layout_debounce_cancels_the_pending_create() {
    close_during_create(CloseDuringCreate::SourcePane { sync_layout: false }).await;
}

#[tokio::test]
async fn a_pane_closed_ack_before_runtime_create_returns_cancels_its_publication() {
    close_during_create(CloseDuringCreate::PendingPane).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_close_after_layout_finalization_cannot_announce_before_the_create() {
    let state = state_with_registry();
    let lane = Arc::new(PausedCreateLane::default());
    state.set_claude_rest_lane(lane.clone()).unwrap();
    let router = app(state.clone());
    let mut events = state.broadcast_tx.subscribe();
    let create_router = router.clone();
    let creating = tokio::spawn(async move {
        post(create_router, "/api/tabs", json!({"agent":"claude"}), true).await
    });
    lane.started.notified().await;
    let request = lane.request.lock().unwrap().clone().unwrap();
    let tab_id = request.tab_id.clone().unwrap();

    // Block the existing cache insertion after the layout has been finalized.
    // DELETE does not need this cache lock to close and announce the tab.
    let held_state = state.clone();
    let (locked, ready) = tokio::sync::oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        let _cache = held_state.panes.lock().unwrap();
        locked.send(()).unwrap();
        released.recv().unwrap();
    });
    ready.await.unwrap();
    lane.finish.notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !state.tabs.lock().unwrap().contains_key(&tab_id) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the create reached cache registration");
    let close_tab = tab_id.clone();
    let mut closing =
        tokio::spawn(async move { delete(router, &format!("/api/tabs/{close_tab}"), true).await });
    // While registration is blocked, a properly serialized close must wait.
    let early_close =
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut closing).await;
    release.send(()).unwrap();
    holder.join().unwrap();
    let (created_status, created) = creating.await.unwrap();
    assert_eq!(created_status, StatusCode::OK, "{created}");
    let (closed_status, closed) = match early_close {
        Ok(closed) => closed.unwrap(),
        Err(_) => closing.await.unwrap(),
    };
    assert_eq!(closed_status, StatusCode::OK, "{closed}");
    let mut commands = Vec::new();
    while let Ok(frame) = events.try_recv() {
        let frame: serde_json::Value = serde_json::from_str(&frame).unwrap();
        if let Some(command) = frame["command"].as_str() {
            commands.push(command.to_string());
        }
    }
    assert_eq!(commands, ["tab.create", "tab.close"]);
    assert!(!state.tabs.lock().unwrap().contains_key(&tab_id));
    assert!(state
        .layout
        .get_pane_snapshot(request.pane_id.as_deref().unwrap())
        .is_none());
}

async fn split_finalization_and_close_are_ordered(close_source: bool) {
    let state = state_with_registry();
    let before = serde_json::from_value(json!({
        "tabs":[{"id":"current-tab"}], "activeTabId":"current-tab", "timestamp":1,
        "layouts":{"current-tab":{"type":"leaf", "id":"source-pane", "content":{"kind":"browser", "url":"https://source.example"}}},
        "activePane":{"current-tab":"source-pane"},
    })).unwrap();
    state.layout.update_from_ui(&before, "creating-browser");
    let lane = Arc::new(PausedCreateLane::default());
    state.set_claude_rest_lane(lane.clone()).unwrap();
    let router = app(state.clone());
    let mut events = state.broadcast_tx.subscribe();
    let create_router = router.clone();
    let creating = tokio::spawn(async move {
        post(
            create_router,
            "/api/panes/source-pane/split",
            json!({"agent":"claude"}),
            true,
        )
        .await
    });
    lane.started.notified().await;
    let request = lane.request.lock().unwrap().clone().unwrap();
    let new_pane = request.pane_id.clone().unwrap();
    let held_state = state.clone();
    let (locked, ready) = tokio::sync::oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        let _cache = held_state.panes.lock().unwrap();
        locked.send(()).unwrap();
        released.recv().unwrap();
    });
    ready.await.unwrap();
    lane.finish.notify_one();

    // On the broken path, the finalized content is observable while cache
    // insertion is blocked. Atomic publication instead keeps this reader and
    // the close behind the layout lock until the announcement is queued.
    let observed_state = state.clone();
    let observed_pane = new_pane.clone();
    let stopping = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observer_stopping = stopping.clone();
    let (finalized, observed) = tokio::sync::oneshot::channel();
    let observer = std::thread::spawn(move || {
        while !observer_stopping.load(std::sync::atomic::Ordering::SeqCst) {
            if observed_state
                .layout
                .get_pane_snapshot(&observed_pane)
                .and_then(|pane| pane.pane_content)
                .is_some_and(|content| content["sessionId"] == "late-runtime")
            {
                let _ = finalized.send(());
                return;
            }
            std::thread::yield_now();
        }
    });
    let _ = tokio::time::timeout(std::time::Duration::from_millis(100), observed).await;
    let close_pane = if close_source {
        "source-pane".to_string()
    } else {
        new_pane.clone()
    };
    let mut closing = tokio::spawn(async move {
        post(
            router,
            &format!("/api/panes/{close_pane}/close"),
            json!({}),
            true,
        )
        .await
    });
    let early_close =
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut closing).await;
    stopping.store(true, std::sync::atomic::Ordering::SeqCst);
    release.send(()).unwrap();
    holder.join().unwrap();
    observer.join().unwrap();
    let (created_status, created) = creating.await.unwrap();
    assert_eq!(created_status, StatusCode::OK, "{created}");
    let (closed_status, closed) = match early_close {
        Ok(closed) => closed.unwrap(),
        Err(_) => closing.await.unwrap(),
    };
    assert_eq!(closed_status, StatusCode::OK, "{closed}");
    let mut commands = Vec::new();
    while let Ok(frame) = events.try_recv() {
        let frame: serde_json::Value = serde_json::from_str(&frame).unwrap();
        if let Some(command) = frame["command"].as_str() {
            commands.push(command.to_string());
        }
    }
    assert_eq!(commands, ["pane.split", "pane.close"]);
    assert_eq!(
        state.layout.get_pane_snapshot(&new_pane).is_some(),
        close_source
    );
    assert_eq!(
        state.layout.get_pane_snapshot("source-pane").is_some(),
        !close_source
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn closing_a_finalized_split_cannot_announce_before_the_split() {
    split_finalization_and_close_are_ordered(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn closing_a_finalized_split_source_cannot_announce_before_the_split() {
    split_finalization_and_close_are_ordered(true).await;
}

struct SyncDuringCreateLane {
    layout: crate::layout_store::LayoutStore,
    browser_sync: freshell_protocol::UiLayoutSync,
}

#[async_trait::async_trait]
impl FreshAgentRestLane for SyncDuringCreateLane {
    async fn create_agent(
        self: Arc<Self>,
        request: RestLaneCreate,
    ) -> Result<RestLaneCreated, RestLaneError> {
        assert!(self
            .layout
            .get_pane_snapshot(request.pane_id.as_deref().unwrap())
            .is_some());
        // A browser can publish its already-scheduled layout before it has
        // received the create announcement, while the runtime launch awaits.
        self.layout
            .update_from_ui(&self.browser_sync, "creating-browser");
        Ok(RestLaneCreated {
            session_id: "created-during-sync".into(),
            ..Default::default()
        })
    }
    async fn send_agent(&self, request: RestLaneSend) -> Result<RestLaneSendResult, RestLaneError> {
        Ok(RestLaneSendResult {
            session_id: request.session_id,
            completed: true,
            submitted_turn_id: Some("submitted-after-create".into()),
            noop: false,
        })
    }
}

#[tokio::test]
async fn an_announced_rest_split_is_discoverable_after_a_browser_sync_during_runtime_create() {
    let state = state_with_registry();
    let payload = json!({
        "tabs":[{"id":"current-tab"}], "activeTabId":"current-tab", "timestamp":1,
        "layouts":{"current-tab":{"type":"split", "id":"existing-ancestor", "direction":"horizontal", "sizes":[40,60], "children":[
            {"type":"leaf", "id":"source-pane", "content":{"kind":"terminal", "mode":"shell"}},
            {"type":"leaf", "id":"sibling-pane", "content":{"kind":"browser", "url":"https://before.example"}},
        ]}}, "activePane":{"current-tab":"source-pane"},
    });
    let initial: freshell_protocol::UiLayoutSync = serde_json::from_value(payload.clone()).unwrap();
    state.layout.update_from_ui(&initial, "creating-browser");
    let mut during_create = payload;
    during_create["layouts"]["current-tab"]["direction"] = json!("vertical");
    during_create["layouts"]["current-tab"]["children"][1]["content"]["url"] =
        json!("https://changed-during-create.example");
    let lane = Arc::new(SyncDuringCreateLane {
        layout: state.layout.clone(),
        browser_sync: serde_json::from_value(during_create).unwrap(),
    });
    state.set_claude_rest_lane(lane.clone()).unwrap();
    let mut events = state.broadcast_tx.subscribe();
    let router = app(state.clone());
    let (status, created) = post(
        router.clone(),
        "/api/panes/source-pane/split",
        json!({"agent":"kilroy"}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let pane = created["data"]["paneId"].as_str().unwrap();
    // An already-sent pre-announcement sync can arrive just after completion too.
    state
        .layout
        .update_from_ui(&lane.browser_sync, "creating-browser");
    let (_, listed) = get(router.clone(), "/api/panes?tabId=current-tab", true).await;
    assert!(
        listed["data"]["panes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == pane),
        "an announced pane must be immediately discoverable: {listed}"
    );
    let (_, snapshot) = get(router.clone(), "/api/layout/snapshot", true).await;
    assert_eq!(
        snapshot["data"]["layouts"]["current-tab"]["id"],
        "existing-ancestor"
    );
    assert_eq!(
        snapshot["data"]["layouts"]["current-tab"]["direction"],
        "vertical"
    );
    assert_eq!(
        state
            .layout
            .get_pane_snapshot("sibling-pane")
            .unwrap()
            .pane_content
            .unwrap()["url"],
        "https://changed-during-create.example"
    );
    let (status, sent) = post(
        router.clone(),
        &format!("/api/panes/{pane}/send-keys"),
        json!({"data":"an immediate external prompt"}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{sent}");
    assert_eq!(sent["data"]["sessionId"], "created-during-sync");
    assert!(
        events.try_recv().is_ok(),
        "the successful split is announced"
    );
    let (status, closed) = post(router, &format!("/api/panes/{pane}/close"), json!({}), true).await;
    assert_eq!(status, StatusCode::OK, "{closed}");
    state
        .layout
        .update_from_ui(&lane.browser_sync, "creating-browser");
    assert!(
        state.layout.get_pane_snapshot(pane).is_none(),
        "an explicit close releases publication authority"
    );
}

#[tokio::test]
async fn an_announced_rest_tab_is_discoverable_after_stale_syncs_during_and_after_create() {
    let state = state_with_registry();
    let browser_sync: freshell_protocol::UiLayoutSync = serde_json::from_value(json!({
        "tabs":[{"id":"current-tab"}], "activeTabId":"current-tab", "timestamp":1,
        "layouts":{"current-tab":{"type":"leaf", "id":"source-pane", "content":{"kind":"terminal", "mode":"shell"}}},
        "activePane":{"current-tab":"source-pane"},
    })).unwrap();
    state
        .layout
        .update_from_ui(&browser_sync, "creating-browser");
    let lane = Arc::new(SyncDuringCreateLane {
        layout: state.layout.clone(),
        browser_sync,
    });
    state.set_claude_rest_lane(lane.clone()).unwrap();
    let router = app(state.clone());
    let (status, created) = post(
        router.clone(),
        "/api/tabs",
        json!({"agent":"claude", "name":"Background conversation"}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let tab = created["data"]["tabId"].as_str().unwrap();
    let pane = created["data"]["paneId"].as_str().unwrap();
    state
        .layout
        .update_from_ui(&lane.browser_sync, "creating-browser");
    let (_, listed) = get(router.clone(), "/api/tabs", true).await;
    assert!(
        listed["data"]["tabs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == tab),
        "the announced tab remains discoverable: {listed}"
    );
    assert_eq!(
        listed["data"]["activeTabId"], "current-tab",
        "publication stays focus neutral"
    );
    let (_, listed) = get(router.clone(), &format!("/api/panes?tabId={tab}"), true).await;
    assert_eq!(listed["data"]["panes"][0]["id"], pane);
    state.layout.close_tab(tab);
    state
        .layout
        .update_from_ui(&lane.browser_sync, "creating-browser");
    assert!(
        state.layout.get_pane_snapshot(pane).is_none(),
        "a closed background tab must not reappear"
    );
}

#[tokio::test]
async fn observing_the_created_leaf_releases_publication_authority_for_later_layout_edits() {
    let state = state_with_registry();
    let original: freshell_protocol::UiLayoutSync = serde_json::from_value(json!({
        "tabs":[{"id":"current-tab"}], "activeTabId":"current-tab", "timestamp":1,
        "layouts":{"current-tab":{"type":"leaf", "id":"source-pane", "content":{"kind":"terminal", "mode":"shell"}}},
        "activePane":{"current-tab":"source-pane"},
    })).unwrap();
    state.layout.update_from_ui(&original, "creating-browser");
    state
        .set_claude_rest_lane(Arc::new(SyncDuringCreateLane {
            layout: state.layout.clone(),
            browser_sync: original.clone(),
        }))
        .unwrap();
    let (status, created) = post(
        app(state.clone()),
        "/api/tabs",
        json!({"agent":"claude"}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let pane = created["data"]["paneId"].as_str().unwrap();
    let mut observed = state.layout.get_normalized_snapshot(None);
    observed["timestamp"] = json!(2);
    state.layout.update_from_ui(
        &serde_json::from_value(observed).unwrap(),
        "creating-browser",
    );
    // Once the browser observed the leaf, subsequent layout edits are its
    // authority again. The publication must not keep forcing the old tab back.
    state.layout.update_from_ui(&original, "creating-browser");
    assert!(state.layout.get_pane_snapshot(pane).is_none());
}
