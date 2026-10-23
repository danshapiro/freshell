use super::tests::{app, get, post, state_with_registry};
use crate::ownership_lane::TerminalOwnerFields;
use crate::rest_lane::*;
use axum::http::StatusCode;
use serde_json::json;
use std::sync::Arc;

struct RefusingLane(RestLaneErrorKind);

#[async_trait::async_trait]
impl FreshAgentRestLane for RefusingLane {
    async fn create_agent(
        self: Arc<Self>,
        _: RestLaneCreate,
    ) -> Result<RestLaneCreated, RestLaneError> {
        Err(RestLaneError {
            kind: self.0,
            code: "SESSION_RESERVED".into(),
            message: "the conversation already has an owner".into(),
            retryable: Some(true),
            retry_after_ms: Some(250),
            owner: Some(TerminalOwnerFields {
                owner_kind: "terminal",
                owner_generation: 7,
                owner_epoch: 3,
            }),
        })
    }

    async fn send_agent(&self, _: RestLaneSend) -> Result<RestLaneSendResult, RestLaneError> {
        unreachable!("creation is refused")
    }
}

#[tokio::test]
async fn typed_create_failures_preserve_status_and_owner_without_leaving_a_tab() {
    for (kind, wanted_status) in [
        (RestLaneErrorKind::BadRequest, StatusCode::BAD_REQUEST),
        (RestLaneErrorKind::Forbidden, StatusCode::FORBIDDEN),
        (RestLaneErrorKind::Conflict, StatusCode::CONFLICT),
        (
            RestLaneErrorKind::Unavailable,
            StatusCode::SERVICE_UNAVAILABLE,
        ),
        (
            RestLaneErrorKind::Internal,
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    ] {
        let state = state_with_registry();
        state
            .set_hosted_rest_gateway(Arc::new(RefusingLane(kind)))
            .unwrap();
        let router = app(state);
        let (status, body) = post(
            router.clone(),
            "/api/tabs",
            json!({ "agent": "claude" }),
            true,
        )
        .await;
        assert_eq!(status, wanted_status, "{body}");
        assert_eq!(body["code"], "SESSION_RESERVED");
        assert_eq!(body["retryable"], true);
        assert_eq!(body["retryAfterMs"], 250);
        assert_eq!(body["ownerKind"], "terminal");
        assert_eq!(body["ownerGeneration"], 7);
        assert_eq!(body["ownerEpoch"], 3);
        let (status, tabs) = get(router, "/api/tabs", true).await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            tabs["data"]["tabs"].as_array().unwrap().is_empty(),
            "{tabs}"
        );
    }
}

struct ContextLane {
    layout: crate::layout_store::LayoutStore,
    creates: std::sync::Mutex<Vec<RestLaneCreate>>,
}

#[async_trait::async_trait]
impl FreshAgentRestLane for ContextLane {
    async fn create_agent(
        self: Arc<Self>,
        request: RestLaneCreate,
    ) -> Result<RestLaneCreated, RestLaneError> {
        let pane_id = request
            .pane_id
            .as_deref()
            .expect("create has its final pane context");
        let tab_id = request
            .tab_id
            .as_deref()
            .expect("create has its final tab context");
        let pane = self
            .layout
            .get_pane_snapshot(pane_id)
            .expect("layout exists before runtime create");
        assert_eq!(pane.tab_id, tab_id);
        let created = RestLaneCreated {
            session_id: format!("session-{}", request.request_id),
            ..Default::default()
        };
        self.creates.lock().unwrap().push(request);
        Ok(created)
    }
    async fn send_agent(&self, _: RestLaneSend) -> Result<RestLaneSendResult, RestLaneError> {
        unreachable!("context test only creates")
    }
}

#[tokio::test]
async fn tab_and_split_create_use_final_layout_context_and_one_create_request_id() {
    let state = state_with_registry();
    let (original_tab, original_pane) = state.layout.create_tab(Some("Original"));
    state
        .layout
        .attach_pane_content(&original_tab, &original_pane, json!({ "kind": "terminal" }));
    state.layout.select_tab(&original_tab);
    let lane = Arc::new(ContextLane {
        layout: state.layout.clone(),
        creates: Default::default(),
    });
    state.set_hosted_rest_gateway(lane.clone()).unwrap();
    let router = app(state.clone());
    for (uri, agent, expected_tab) in [
        ("/api/tabs".to_string(), "claude", None),
        (
            format!("/api/panes/{original_pane}/split"),
            "kilroy",
            Some(original_tab.as_str()),
        ),
    ] {
        let (status, body) = post(router.clone(), &uri, json!({ "agent": agent }), true).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let request = lane.creates.lock().unwrap().last().unwrap().clone();
        let pane_id = request.pane_id.as_ref().unwrap();
        let pane = state.layout.get_pane_snapshot(pane_id).unwrap();
        assert_eq!(
            pane.pane_content.as_ref().unwrap()["createRequestId"],
            request.request_id
        );
        assert_eq!(
            pane.pane_content.as_ref().unwrap()["sessionId"],
            format!("session-{}", request.request_id)
        );
        if let Some(tab_id) = expected_tab {
            assert_eq!(pane.tab_id, tab_id);
        }
        let (_, tabs) = get(router.clone(), "/api/tabs", true).await;
        assert_eq!(
            tabs["data"]["activeTabId"], original_tab,
            "automation stays focus neutral"
        );
    }
    assert_eq!(lane.creates.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn claude_defaults_are_read_once_and_used_for_the_runtime_and_pane() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let state = state_with_registry();
    let lane = Arc::new(ContextLane {
        layout: state.layout.clone(),
        creates: Default::default(),
    });
    state.set_hosted_rest_gateway(lane.clone()).unwrap();
    let reads = Arc::new(AtomicUsize::new(0));
    let reads_for_reader = reads.clone();
    state.set_rest_create_settings_reader(Arc::new(move || {
        reads_for_reader.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { freshell_protocol::SettingsFreshAgent {
            default_plugins: vec!["/saved-plugin".into()], enabled: true, initial_setup_done: None,
            providers: json!({
                "freshclaude": { "modelSelection": { "kind": "exact", "modelId": "catalog-a" }, "modelEffortLevels": { "modelId": "catalog-a", "levels": [] }, "effort": "high", "defaultPermissionMode": "plan" },
                "kilroy": { "modelSelection": { "kind": "exact", "modelId": "catalog-b" }, "effort": "low", "defaultPermissionMode": "bypassPermissions" },
            }),
        } })
    })).unwrap();
    let router = app(state.clone());
    for (agent, model, mode, effort) in [
        ("claude", "catalog-a", "plan", None),
        ("kilroy", "catalog-b", "bypassPermissions", Some("low")),
    ] {
        let (status, body) =
            post(router.clone(), "/api/tabs", json!({ "agent": agent }), true).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let request = lane.creates.lock().unwrap().last().unwrap().clone();
        let pane = state
            .layout
            .get_pane_snapshot(request.pane_id.as_ref().unwrap())
            .unwrap()
            .pane_content
            .unwrap();
        assert_eq!(request.model.as_deref(), Some(model));
        assert_eq!(request.permission_mode.as_deref(), Some(mode));
        assert_eq!(request.effort.as_deref(), effort);
        assert_eq!(request.plugins, Some(vec!["/saved-plugin".into()]));
        assert_eq!(pane["model"], model);
        assert_eq!(pane["permissionMode"], mode);
        assert_eq!(pane["effort"].as_str(), effort);
        assert_eq!(pane["plugins"], json!(["/saved-plugin"]));
        assert_eq!(pane["modelSelection"]["modelId"], model);
        assert_eq!(request.naming_handle.is_some(), agent == "claude");
        if agent == "claude" {
            assert_eq!(
                pane["modelEffortLevels"],
                json!({ "modelId": model, "levels": [] })
            );
        }
    }
    assert_eq!(
        reads.load(Ordering::SeqCst),
        2,
        "one settings read per create"
    );
}
