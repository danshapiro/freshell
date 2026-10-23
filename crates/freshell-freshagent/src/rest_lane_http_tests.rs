use super::tests::{app, get, post, state_with_registry};
use crate::ownership_lane::TerminalOwnerFields;
use crate::rest_lane::*;
use axum::http::StatusCode;
use serde_json::{json, Value};
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

#[tokio::test]
async fn an_explicit_model_override_clears_a_different_saved_exact_selection() {
    let state = state_with_registry();
    let lane = Arc::new(ContextLane {
        layout: state.layout.clone(),
        creates: Default::default(),
    });
    state.set_hosted_rest_gateway(lane.clone()).unwrap();
    state
        .set_rest_create_settings_reader(Arc::new(|| {
            Box::pin(async {
                freshell_protocol::SettingsFreshAgent {
                    default_plugins: vec![],
                    enabled: true,
                    initial_setup_done: None,
                    providers: json!({ "freshclaude": {
            "modelSelection": { "kind": "exact", "modelId": "saved-model" },
            "modelEffortLevels": { "modelId": "saved-model", "levels": [] },
        } }),
                }
            })
        }))
        .unwrap();
    let (status, body) = post(
        app(state.clone()),
        "/api/tabs",
        json!({ "agent": "claude", "model": "explicit-model" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let request = lane.creates.lock().unwrap().last().unwrap().clone();
    assert_eq!(request.model.as_deref(), Some("explicit-model"));
    assert_eq!(
        request.model_selection,
        Some(None),
        "provider create must not prefer an unrelated saved selection"
    );
    let content = state
        .layout
        .get_pane_snapshot(request.pane_id.as_ref().unwrap())
        .unwrap()
        .pane_content
        .unwrap();
    assert_eq!(content["model"], "explicit-model");
    assert_eq!(content["modelSelection"], Value::Null);
    assert!(content.get("modelEffortLevels").is_none());
}

#[tokio::test]
async fn local_claude_lane_creates_tabs_and_splits_without_enabling_codex() {
    let state = state_with_registry();
    let (_, original_pane) = state.layout.create_tab(Some("Original"));
    let lane = Arc::new(ContextLane {
        layout: state.layout.clone(),
        creates: Default::default(),
    });
    state.set_claude_rest_lane(lane.clone()).unwrap();
    let router = app(state.clone());
    for (uri, agent) in [
        ("/api/tabs".to_string(), "claude"),
        (format!("/api/panes/{original_pane}/split"), "kilroy"),
    ] {
        let (status, body) = post(router.clone(), &uri, json!({"agent":agent}), true).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let request = lane.creates.lock().unwrap().last().unwrap().clone();
        assert_eq!(request.provider, "claude");
        assert_eq!(
            request.session_type,
            if agent == "claude" {
                "freshclaude"
            } else {
                "kilroy"
            }
        );
    }
    assert_eq!(lane.creates.lock().unwrap().len(), 2);
    let (status, _) = post(router, "/api/tabs", json!({"agent":"codex"}), true).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(lane.creates.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn hosted_gateway_takes_precedence_over_the_local_claude_lane() {
    let state = state_with_registry();
    let local = Arc::new(ContextLane {
        layout: state.layout.clone(),
        creates: Default::default(),
    });
    let hosted = Arc::new(ContextLane {
        layout: state.layout.clone(),
        creates: Default::default(),
    });
    state.set_claude_rest_lane(local.clone()).unwrap();
    state.set_hosted_rest_gateway(hosted.clone()).unwrap();
    let (status, body) = post(app(state), "/api/tabs", json!({"agent":"claude"}), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(hosted.creates.lock().unwrap().len(), 1);
    assert!(local.creates.lock().unwrap().is_empty());
}

#[derive(Default)]
struct ControlLane {
    sends: std::sync::Mutex<Vec<RestLaneSend>>,
    captures: std::sync::Mutex<Vec<RestLaneCapture>>,
    materialized_session_id: Option<String>,
    concurrent_replacement: Option<(crate::layout_store::LayoutStore, String, String, Value)>,
}

#[async_trait::async_trait]
impl FreshAgentRestLane for ControlLane {
    async fn create_agent(
        self: Arc<Self>,
        _: RestLaneCreate,
    ) -> Result<RestLaneCreated, RestLaneError> {
        Ok(RestLaneCreated {
            session_id: "cached-rest-session".into(),
            ..Default::default()
        })
    }
    async fn send_agent(&self, request: RestLaneSend) -> Result<RestLaneSendResult, RestLaneError> {
        let noop = request.text == "\n";
        let first = self.sends.lock().unwrap().is_empty();
        if first {
            if let Some((layout, tab_id, pane_id, content)) = &self.concurrent_replacement {
                layout.attach_pane_content(tab_id, pane_id, content.clone());
            }
        }
        let result = RestLaneSendResult {
            session_id: first
                .then(|| self.materialized_session_id.clone())
                .flatten()
                .unwrap_or_else(|| request.session_id.clone()),
            completed: true,
            submitted_turn_id: (!noop).then(|| "actual-submitted-uuid".into()),
            noop,
        };
        self.sends.lock().unwrap().push(request);
        Ok(result)
    }
    async fn capture(
        &self,
        request: RestLaneCapture,
    ) -> Result<RestLaneCaptureResult, RestLaneCaptureError> {
        let result = RestLaneCaptureResult {
            session_id: request.session_id.clone(),
            native_session_id: request.session_id.clone(),
            text: "saved conversation".into(),
            truncated: false,
        };
        self.captures.lock().unwrap().push(request);
        Ok(result)
    }
}

#[tokio::test]
async fn settled_session_identity_updates_headless_layout_for_later_send_and_capture() {
    const NEXT_ID: &str = "67cebd37-9576-4de0-93bb-8f286f5fc499";
    let state = state_with_registry();
    let lane = Arc::new(ControlLane {
        materialized_session_id: Some(NEXT_ID.into()),
        ..Default::default()
    });
    state.set_claude_rest_lane(lane.clone()).unwrap();
    let router = app(state);
    let (_, created) = post(router.clone(), "/api/tabs", json!({"agent":"claude"}), true).await;
    let pane = created["data"]["paneId"].as_str().unwrap();
    for text in ["/clear", "next turn"] {
        let (status, body) = post(
            router.clone(),
            &format!("/api/panes/{pane}/send-keys"),
            json!({"data":text}),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["sessionId"], NEXT_ID);
    }
    assert_eq!(lane.sends.lock().unwrap()[1].session_id, NEXT_ID);
    assert_eq!(capture_response(router, pane).await.0, StatusCode::OK);
    assert_eq!(
        lane.captures.lock().unwrap().last().unwrap().session_id,
        NEXT_ID
    );
}

#[tokio::test]
async fn an_old_send_settling_does_not_overwrite_a_concurrent_pane_replacement() {
    const SETTLED_ID: &str = "67cebd37-9576-4de0-93bb-8f286f5fc499";
    const REPLACED_ID: &str = "39a6e5a0-3601-4c71-a878-d8da4db265c0";
    let state = state_with_registry();
    let (tab, pane) = state.layout.create_tab(None);
    state.layout.attach_pane_content(&tab, &pane, json!({"kind":"fresh-agent", "provider":"claude", "sessionType":"freshclaude", "sessionId":"prior-session"}));
    let lane = Arc::new(ControlLane {
        materialized_session_id: Some(SETTLED_ID.into()),
        concurrent_replacement: Some((
            state.layout.clone(),
            tab,
            pane.clone(),
            json!({
                "kind":"fresh-agent", "provider":"claude", "sessionType":"freshclaude", "sessionId":REPLACED_ID,
                "sessionRef":{"provider":"claude", "sessionId":REPLACED_ID}, "model":"replacement-model",
            }),
        )),
        ..Default::default()
    });
    state.set_claude_rest_lane(lane.clone()).unwrap();
    let router = app(state.clone());
    let (status, body) = post(
        router.clone(),
        &format!("/api/panes/{pane}/send-keys"),
        json!({"data":"/clear"}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let content = state
        .layout
        .get_pane_snapshot(&pane)
        .unwrap()
        .pane_content
        .unwrap();
    assert_eq!(content["sessionId"], REPLACED_ID);
    assert_eq!(content["model"], "replacement-model");
    assert_eq!(capture_response(router, &pane).await.0, StatusCode::OK);
    assert_eq!(
        lane.captures.lock().unwrap().last().unwrap().session_id,
        REPLACED_ID
    );
}

async fn capture_response(router: axum::Router, pane_id: &str) -> (StatusCode, String) {
    use tower::util::ServiceExt;
    let response = router
        .oneshot(
            axum::http::Request::builder()
                .uri(format!("/api/panes/{pane_id}/capture?maxBytes=30"))
                .header("x-auth-token", "tok")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    (status, String::from_utf8(bytes.to_vec()).unwrap())
}

#[tokio::test]
async fn local_lane_controls_browser_created_panes_using_the_provider_matched_durable_ref() {
    const DURABLE_ID: &str = "67cebd37-9576-4de0-93bb-8f286f5fc499";
    let state = state_with_registry();
    let (tab, pane_id) = state.layout.create_tab(Some("Browser-created"));
    state.layout.attach_pane_content(
        &tab,
        &pane_id,
        json!({
            "kind":"fresh-agent", "provider":"claude", "sessionType":"kilroy",
            "sessionId":"legacy-alias", "sessionRef":{"provider":"claude", "sessionId":DURABLE_ID},
        }),
    );
    let lane = Arc::new(ControlLane::default());
    state.set_claude_rest_lane(lane.clone()).unwrap();
    let router = app(state);
    let (status, body) = post(
        router.clone(),
        &format!("/api/panes/{pane_id}/send-keys"),
        json!({"data":"continue", "requestId":"caller-request"}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["submittedTurnId"], "actual-submitted-uuid");
    assert_eq!(body["data"]["sessionRef"]["sessionId"], DURABLE_ID);
    let sent = lane.sends.lock().unwrap().last().unwrap().clone();
    assert_eq!(sent.session_id, DURABLE_ID);
    assert_eq!(sent.request_id, "caller-request");
    assert_eq!(sent.session_type, "kilroy");
    let (status, text) = capture_response(router, &pane_id).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    assert_eq!(text, "saved conversation");
    let captured = lane.captures.lock().unwrap().last().unwrap().clone();
    assert_eq!(captured.session_id, DURABLE_ID);
    assert_eq!(captured.max_bytes, 30);
}

#[tokio::test]
async fn a_restored_pane_with_only_its_durable_ref_supports_send_and_capture() {
    const ID: &str = "67cebd37-9576-4de0-93bb-8f286f5fc499";
    let state = state_with_registry();
    let (tab, pane) = state.layout.create_tab(None);
    state.layout.attach_pane_content(
        &tab,
        &pane,
        json!({
            "kind":"fresh-agent", "provider":"claude", "sessionType":"freshclaude",
            "sessionRef":{"provider":"claude", "sessionId":ID},
        }),
    );
    let lane = Arc::new(ControlLane::default());
    state.set_claude_rest_lane(lane.clone()).unwrap();
    let router = app(state);
    let (status, sent) = post(
        router.clone(),
        &format!("/api/panes/{pane}/send-keys"),
        json!({"data":"restored prompt"}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{sent}");
    assert_eq!(sent["data"]["sessionId"], ID);
    assert_eq!(lane.sends.lock().unwrap().last().unwrap().session_id, ID);
    let (status, text) = capture_response(router, &pane).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    assert_eq!(text, "saved conversation");
    assert_eq!(lane.captures.lock().unwrap().last().unwrap().session_id, ID);
}

#[tokio::test]
async fn lane_noop_does_not_report_a_submitted_turn() {
    let state = state_with_registry();
    let (tab, pane_id) = state.layout.create_tab(None);
    state.layout.attach_pane_content(&tab, &pane_id, json!({
        "kind":"fresh-agent", "provider":"claude", "sessionType":"freshclaude", "sessionId":"durable-uuid",
    }));
    state
        .set_hosted_rest_gateway(Arc::new(ControlLane::default()))
        .unwrap();
    let (status, body) = post(
        app(state),
        &format!("/api/panes/{pane_id}/send-keys"),
        json!({"data":"\n"}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["status"], "noop");
    assert!(body["data"].get("submittedTurnId").is_none(), "{body}");
}

#[tokio::test]
async fn lane_controls_use_the_current_layout_identity_after_a_rest_created_pane_is_replaced() {
    const CURRENT_ID: &str = "67cebd37-9576-4de0-93bb-8f286f5fc499";
    let state = state_with_registry();
    let lane = Arc::new(ControlLane::default());
    state.set_claude_rest_lane(lane.clone()).unwrap();
    let router = app(state.clone());
    let (status, created) =
        post(router.clone(), "/api/tabs", json!({"agent":"claude"}), true).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let pane_id = created["data"]["paneId"].as_str().unwrap();
    let tab_id = created["data"]["tabId"].as_str().unwrap();
    state.layout.attach_pane_content(tab_id, pane_id, json!({
        "kind":"fresh-agent", "provider":"claude", "sessionType":"kilroy", "sessionId":"new-pane-alias",
        "sessionRef":{"provider":"claude", "sessionId":CURRENT_ID},
    }));
    let (status, body) = post(
        router.clone(),
        &format!("/api/panes/{pane_id}/send-keys"),
        json!({"data":"continue"}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let send = lane.sends.lock().unwrap().last().unwrap().clone();
    assert_eq!(send.session_id, CURRENT_ID);
    assert_eq!(send.session_type, "kilroy");
    let (status, text) = capture_response(router, pane_id).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    let capture = lane.captures.lock().unwrap().last().unwrap().clone();
    assert_eq!(capture.session_id, CURRENT_ID);
    assert_eq!(capture.session_type, "kilroy");
}

#[tokio::test]
async fn actual_claude_create_conflict_preserves_the_refusing_owner_and_retry_hint() {
    use freshell_ownership::{
        BeginOutcome, CommitOutcome, OwnerIdentity, RuntimeOwnerKind, RuntimeOwnershipRegistry,
    };
    const ID: &str = "67cebd37-9576-4de0-93bb-8f286f5fc499";
    let owner = Arc::new(RuntimeOwnershipRegistry::with_epoch(41));
    let BeginOutcome::Granted { generation } = owner.begin_start(
        "claude",
        ID,
        RuntimeOwnerKind::Terminal,
        "terminal-create",
        None,
        "test",
        1,
    ) else {
        panic!("terminal claim granted")
    };
    assert_eq!(
        owner.commit_live(
            "claude",
            ID,
            "terminal-create",
            generation,
            OwnerIdentity {
                kind: RuntimeOwnerKind::Terminal,
                terminal_id: Some("existing-terminal".into()),
                live_session_key: None,
                pid: None,
                ownership_id: None,
            }
        ),
        CommitOutcome::Committed
    );
    let state = state_with_registry();
    let mut claude = crate::FreshClaudeState::new(Arc::new(tokio::sync::broadcast::channel(16).0));
    claude.set_ownership(owner);
    state
        .set_claude_rest_lane(Arc::new(crate::claude_rest_lane::ClaudeRestLane::new(
            claude,
            Arc::new(|| true),
        )))
        .unwrap();
    let router = app(state);
    let (status, body) = post(
        router.clone(),
        "/api/tabs",
        json!({"agent":"claude", "sessionRef":{"provider":"claude", "sessionId":ID}}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "SESSION_RESERVED");
    assert_eq!(body["ownerKind"], "terminal");
    assert_eq!(body["ownerEpoch"], 41);
    assert_eq!(body["ownerGeneration"], generation);
    assert_eq!(body["retryable"], true);
    assert!(
        body["retryAfterMs"].as_u64().is_some_and(|delay| delay > 0),
        "{body}"
    );
    let (_, tabs) = get(router, "/api/tabs", true).await;
    assert!(tabs["data"]["tabs"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn observed_ownership_pair_reaches_the_create_and_send_lanes_unchanged() {
    let state = state_with_registry();
    let creates = Arc::new(ContextLane {
        layout: state.layout.clone(),
        creates: Default::default(),
    });
    state.set_claude_rest_lane(creates.clone()).unwrap();
    let (status, body) = post(
        app(state),
        "/api/tabs",
        json!({"agent":"claude", "observedEpoch":41, "observedGeneration":7}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let created = creates.creates.lock().unwrap().last().unwrap().clone();
    assert_eq!(
        (created.observed_epoch, created.observed_generation),
        (Some(41), Some(7))
    );
    let state = state_with_registry();
    let (tab, pane) = state.layout.create_tab(None);
    state.layout.attach_pane_content(&tab, &pane, json!({"kind":"fresh-agent", "provider":"claude", "sessionType":"freshclaude", "sessionId":"session"}));
    let sends = Arc::new(ControlLane::default());
    state.set_claude_rest_lane(sends.clone()).unwrap();
    let (status, body) = post(
        app(state),
        &format!("/api/panes/{pane}/send-keys"),
        json!({"data":"continue", "observedEpoch":41, "observedGeneration":7}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let sent = sends.sends.lock().unwrap().last().unwrap().clone();
    assert_eq!(
        (sent.observed_epoch, sent.observed_generation),
        (Some(41), Some(7))
    );
}

#[tokio::test]
async fn actual_claude_spawn_failure_is_unavailable_and_leaves_no_tab() {
    let _guard = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    struct NodeOverride(Option<std::ffi::OsString>);
    impl Drop for NodeOverride {
        fn drop(&mut self) {
            match self.0.take() {
                Some(value) => std::env::set_var("FRESHELL_CLAUDE_NODE", value),
                None => std::env::remove_var("FRESHELL_CLAUDE_NODE"),
            }
        }
    }
    let root = tempfile::tempdir().unwrap();
    let _restore = NodeOverride(std::env::var_os("FRESHELL_CLAUDE_NODE"));
    std::env::set_var("FRESHELL_CLAUDE_NODE", root.path().join("missing-node"));
    let state = state_with_registry();
    let claude = crate::FreshClaudeState::new(Arc::new(tokio::sync::broadcast::channel(16).0));
    state
        .set_claude_rest_lane(Arc::new(crate::claude_rest_lane::ClaudeRestLane::new(
            claude,
            Arc::new(|| true),
        )))
        .unwrap();
    let router = app(state);
    let (status, body) = post(
        router.clone(),
        "/api/tabs",
        json!({"agent":"claude", "cwd":root.path().to_str().unwrap()}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["code"], "CLAUDE_SIDECAR_START_FAILED");
    let (_, tabs) = get(router, "/api/tabs", true).await;
    assert!(tabs["data"]["tabs"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn malformed_or_incomplete_rest_fences_refuse_before_provider_creation() {
    let state = state_with_registry();
    let lane = Arc::new(ContextLane {
        layout: state.layout.clone(),
        creates: Default::default(),
    });
    state.set_claude_rest_lane(lane.clone()).unwrap();
    let router = app(state);
    for body in [
        json!({"agent":"claude", "observedEpoch":41}),
        json!({"agent":"claude", "observedEpoch":"41", "observedGeneration":7}),
        json!({"agent":"claude", "observedEpoch":41, "observedGeneration":-1}),
    ] {
        let (status, body) = post(router.clone(), "/api/tabs", body, true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["code"], "INVALID_FENCE");
    }
    assert!(lane.creates.lock().unwrap().is_empty());
    let (_, tabs) = get(router, "/api/tabs", true).await;
    assert!(tabs["data"]["tabs"].as_array().unwrap().is_empty());
}
