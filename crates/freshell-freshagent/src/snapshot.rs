//! # freshell-freshagent :: snapshot — the fresh-agent thread-snapshot REST endpoint
//! (Batch D PR-5)
//!
//! `GET /api/fresh-agent/threads/:sessionType/:provider/:threadId` — a faithful, MINIMAL
//! port of `server/fresh-agent/router.ts`'s snapshot route (`router.ts:169-229`), scoped to
//! the two providers this Rust port drives today: **freshcodex/codex** ([`crate::codex`])
//! and **freshopencode/opencode** ([`crate`]'s `get_opencode_snapshot`).
//!
//! ## Why this endpoint is CRITICAL
//!
//! The browser SPA's `commitSnapshot` flow (`src/components/fresh-agent/FreshAgentView.tsx`)
//! calls `getFreshAgentThreadSnapshot` (`src/lib/api.ts:312`) to render a pane's transcript.
//! Without this route, every fresh-agent pane shows only its busy/idle chrome and then 404s
//! on the first refetch — the SPA never renders a single turn of conversation. This route is
//! the "does the pane show anything at all" seam.
//!
//! ## Schema fidelity
//!
//! The response body must validate against the SPA's `FreshAgentSnapshotSchema.safeParse`
//! (`shared/fresh-agent-contract.ts:230-246`, a `.strict()` zod object) — an unrecognized
//! top-level key, a missing required field, or a non-camelCase key silently drops the whole
//! payload client-side (`FreshAgentApiContractError`). [`crate::codex::build_codex_snapshot_json`]
//! and [`crate::build_opencode_snapshot_json`] are built to that exact contract; see their doc
//! comments for the (honest, schema-valid) subset of the reference's rich transcript-item
//! normalization each currently covers.
//!
//! ## Scope
//!
//! `sessionType`/`provider` combinations outside `{freshcodex/codex, freshopencode/opencode}`
//! but within the shared locator's valid enum (`freshclaude/claude`, `kilroy/claude`) mirror
//! the reference's `FreshAgentRuntimeUnavailableError` (`runtime-manager.ts:25-27,338-341`) —
//! a 503 with `code:'FRESH_AGENT_RUNTIME_UNAVAILABLE'` — since this port has no adapter
//! registered for them (`server/fresh-agent/provider-registry.ts` equivalent doesn't exist
//! here yet). An outright invalid enum member (e.g. `sessionType=bogus`) is a 400, mirroring
//! the reference's `ThreadParamsSchema.safeParse` failure (`router.ts:181-186`).

use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::json;

use crate::codex::{CodexSnapshotError, FreshCodexState};
use crate::{FreshAgentState, OpencodeSnapshotError};

/// `FreshAgentSessionTypeSchema` (`fresh-agent-contract.ts:3`).
const VALID_SESSION_TYPES: &[&str] = &["freshclaude", "freshcodex", "kilroy", "freshopencode"];
/// `FreshAgentRuntimeProviderSchema` (`fresh-agent-contract.ts:4`).
const VALID_PROVIDERS: &[&str] = &["claude", "codex", "opencode"];

/// Shared, cheaply-cloneable state for the snapshot endpoint: the auth token plus the two
/// provider slices this port can actually build a snapshot from.
#[derive(Clone)]
pub struct SnapshotState {
    auth_token: Arc<String>,
    codex: FreshCodexState,
    opencode: FreshAgentState,
}

impl SnapshotState {
    pub fn new(auth_token: Arc<String>, codex: FreshCodexState, opencode: FreshAgentState) -> Self {
        Self { auth_token, codex, opencode }
    }
}

/// The pre-bound snapshot sub-router.
pub fn router(state: SnapshotState) -> Router {
    Router::new()
        .route(
            "/api/fresh-agent/threads/{sessionType}/{provider}/{threadId}",
            get(get_snapshot),
        )
        .with_state(state)
}

async fn get_snapshot(
    State(state): State<SnapshotState>,
    Path((session_type, provider, thread_id)): Path<(String, String, String)>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    let cwd = query.get("cwd").cloned();

    match (session_type.as_str(), provider.as_str()) {
        ("freshcodex", "codex") => match state.codex.get_snapshot(&thread_id).await {
            Ok(snapshot) => Json(snapshot).into_response(),
            Err(CodexSnapshotError::NotFound) => fail_with_code(
                StatusCode::NOT_FOUND,
                format!("codex thread {thread_id} not found"),
                "FRESH_AGENT_LOST_SESSION",
            ),
            Err(CodexSnapshotError::AppServer(err)) => fail(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
        },
        ("freshopencode", "opencode") => {
            match state.opencode.get_opencode_snapshot(&thread_id, cwd.as_deref()).await {
                Ok(snapshot) => Json(snapshot).into_response(),
                Err(OpencodeSnapshotError::NotFound) => fail_with_code(
                    StatusCode::NOT_FOUND,
                    format!("opencode session {thread_id} not found"),
                    "FRESH_AGENT_LOST_SESSION",
                ),
                Err(OpencodeSnapshotError::Serve(err)) => fail(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
            }
        }
        (session_type_value, provider_value) => {
            if !VALID_SESSION_TYPES.contains(&session_type_value) || !VALID_PROVIDERS.contains(&provider_value) {
                return fail(StatusCode::BAD_REQUEST, "Invalid request".to_string());
            }
            // A structurally valid locator this port has no adapter registered for
            // (freshclaude/claude, kilroy/claude) -- mirrors `FreshAgentRuntimeUnavailableError`.
            fail_with_code(
                StatusCode::SERVICE_UNAVAILABLE,
                format!("No fresh-agent snapshot adapter registered for {session_type_value}"),
                "FRESH_AGENT_RUNTIME_UNAVAILABLE",
            )
        }
    }
}

fn fail(status: StatusCode, message: String) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

fn fail_with_code(status: StatusCode, message: String, code: &str) -> Response {
    (status, Json(json!({ "error": message, "code": code }))).into_response()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    headers
        .get("x-auth-token")
        .and_then(|v| v.to_str().ok())
        .map(|provided| constant_time_eq(provided.as_bytes(), token.as_bytes()))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_codex::CodexAppServerClient;
    use freshell_opencode::{
        Endpoint, EventSource, EventStreamHandle, OpencodeServeManager, PortAllocator, ProcessSpawner,
        ServeConfig, ServeDeps, ServeHttp, ServeHttpRequest, ServeHttpResponse, ServeProcess, SpawnRequest,
    };

    #[test]
    fn authorized_is_constant_time_and_requires_header() {
        let mut headers = HeaderMap::new();
        assert!(!authorized(&headers, "tok"));
        headers.insert("x-auth-token", "nope".parse().unwrap());
        assert!(!authorized(&headers, "tok"));
        headers.insert("x-auth-token", "tok".parse().unwrap());
        assert!(authorized(&headers, "tok"));
    }

    fn codex_state() -> FreshCodexState {
        FreshCodexState::new(
            Arc::new("tok".to_string()),
            Arc::new(tokio::sync::broadcast::channel::<String>(64).0),
            json!({ "freshAgent": { "enabled": false } }),
        )
    }

    fn opencode_state() -> FreshAgentState {
        FreshAgentState::new(
            Arc::new("tok".to_string()),
            Arc::new(tokio::sync::broadcast::channel::<String>(64).0),
        )
    }

    fn snapshot_state() -> SnapshotState {
        SnapshotState::new(Arc::new("tok".to_string()), codex_state(), opencode_state())
    }

    fn headers_with_token(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", token.parse().unwrap());
        headers
    }

    #[tokio::test]
    async fn missing_auth_header_is_401() {
        let resp = get_snapshot(
            State(snapshot_state()),
            Path(("freshcodex".to_string(), "codex".to_string(), "thread-1".to_string())),
            Query(HashMap::new()),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn unknown_session_type_is_400() {
        let resp = get_snapshot(
            State(snapshot_state()),
            Path(("bogus".to_string(), "codex".to_string(), "thread-1".to_string())),
            Query(HashMap::new()),
            headers_with_token("tok"),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn valid_but_unregistered_locator_is_503_with_code() {
        let resp = get_snapshot(
            State(snapshot_state()),
            Path(("freshclaude".to_string(), "claude".to_string(), "thread-1".to_string())),
            Query(HashMap::new()),
            headers_with_token("tok"),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["code"], json!("FRESH_AGENT_RUNTIME_UNAVAILABLE"));
    }

    #[tokio::test]
    async fn unknown_codex_thread_is_404_with_lost_session_code() {
        let resp = get_snapshot(
            State(snapshot_state()),
            Path(("freshcodex".to_string(), "codex".to_string(), "does-not-exist".to_string())),
            Query(HashMap::new()),
            headers_with_token("tok"),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["code"], json!("FRESH_AGENT_LOST_SESSION"));
    }

    #[tokio::test]
    async fn codex_snapshot_success_returns_200_with_camelcase_body() {
        let (transport, peer) = freshell_codex::new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        let client = Arc::new(client);

        let codex = codex_state();
        codex.insert_session_for_test("thread-1", client, None).await;
        let state = SnapshotState::new(Arc::new("tok".to_string()), codex, opencode_state());

        let driver = tokio::spawn(async move {
            get_snapshot(
                State(state),
                Path(("freshcodex".to_string(), "codex".to_string(), "thread-1".to_string())),
                Query(HashMap::new()),
                headers_with_token("tok"),
            )
            .await
        });

        let (init_id, _m, _p) = peer.expect_request().await;
        peer.respond(
            &init_id,
            json!({ "userAgent": "x", "codexHome": "/h", "platformFamily": "u", "platformOs": "l" }),
        );
        let _ = peer.expect_notification().await;
        let (id, method, _params) = peer.expect_request().await;
        assert_eq!(method, "thread/read");
        peer.respond(
            &id,
            json!({ "thread": { "id": "thread-1", "status": { "type": "idle" }, "turns": [] } }),
        );

        let resp = driver.await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["sessionType"], json!("freshcodex"));
        assert_eq!(value["provider"], json!("codex"));
        assert_eq!(value["threadId"], json!("thread-1"));
        assert!(value.get("session_type").is_none(), "must be camelCase, not snake_case");
    }

    // -- opencode success fakes --

    struct FixedSessionHttp {
        session_body: serde_json::Value,
        messages_body: serde_json::Value,
    }
    impl ServeHttp for FixedSessionHttp {
        fn request<'a>(
            &'a self,
            req: ServeHttpRequest,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<ServeHttpResponse, String>> + Send + 'a>>
        {
            let body = if req.url.contains("/message") {
                serde_json::to_vec(&self.messages_body).unwrap()
            } else if req.url.contains("/session/") {
                serde_json::to_vec(&self.session_body).unwrap()
            } else {
                b"{}".to_vec()
            };
            Box::pin(async move { Ok(ServeHttpResponse::new(200, body)) })
        }
    }
    struct FakeAllocator;
    impl PortAllocator for FakeAllocator {
        fn allocate(&self) -> Result<Endpoint, String> {
            Ok(Endpoint { hostname: "127.0.0.1".into(), port: 1 })
        }
    }
    struct NoopHandle;
    impl EventStreamHandle for NoopHandle {}
    struct NoopEventSource;
    impl EventSource for NoopEventSource {
        fn connect(&self, _url: String, _sink: freshell_opencode::serve::EventSink) -> Box<dyn EventStreamHandle> {
            Box::new(NoopHandle)
        }
    }
    struct NoopProcess;
    impl ServeProcess for NoopProcess {
        fn exited(&self) -> Option<i32> {
            None
        }
        fn take_fatal_startup_error(&self) -> Option<String> {
            None
        }
        fn kill(&self) {}
    }
    struct NoopSpawner;
    impl ProcessSpawner for NoopSpawner {
        fn spawn(&self, _req: SpawnRequest) -> Result<Box<dyn ServeProcess>, String> {
            Ok(Box::new(NoopProcess))
        }
    }

    #[tokio::test]
    async fn opencode_snapshot_success_returns_200_with_camelcase_body() {
        let opencode = opencode_state();
        let deps = ServeDeps {
            spawner: Arc::new(NoopSpawner),
            http: Arc::new(FixedSessionHttp {
                session_body: json!({ "id": "ses_1", "time": { "updated": 5 } }),
                messages_body: json!([
                    { "info": { "id": "m1", "role": "user" }, "parts": [{ "type": "text", "text": "hi" }] },
                ]),
            }),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager.ensure_started().await.expect("healthy fake serve starts");
        opencode.set_manager_for_test(manager).await;

        let state = SnapshotState::new(Arc::new("tok".to_string()), codex_state(), opencode);
        let resp = get_snapshot(
            State(state),
            Path(("freshopencode".to_string(), "opencode".to_string(), "ses_1".to_string())),
            Query(HashMap::new()),
            headers_with_token("tok"),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["sessionType"], json!("freshopencode"));
        assert_eq!(value["provider"], json!("opencode"));
        assert_eq!(value["threadId"], json!("ses_1"));
        assert_eq!(value["turns"][0]["items"][0]["text"], json!("hi"));
    }
}
