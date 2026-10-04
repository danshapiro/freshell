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
//! All three providers are served: **freshcodex/codex** asks its live runtime
//! slice — SIDE-EFFECT-FREE (kata b8ke Task 5): a thread this process tracks
//! serves from the live runtime, an untracked one reads its exact saved rollout
//! (or an empty snapshot when absent, with the additive owner-state fields), and
//! a session another runtime owns
//! or a transition holds answers the typed 409 envelope — never a spawn or a
//! resume; **freshopencode/opencode** (b8ke delta review F4) is the same
//! side-effect-free contract against the shared `opencode serve` daemon: the
//! daemon is consulted only when ALREADY running — daemon-absent GETs answer
//! the typed ownership refusals or the EMPTY-FROM-DISK snapshot and never
//! spawn (cold resume only via the explicit lifecycle); while
//! **freshclaude/claude** and **kilroy/claude** are a
//! disk+env adapter ([`crate::claude_snapshot::get_claude_snapshot`]) that reads the CLI's
//! own transcript store directly (`<claude_home>/projects/*/<threadId>.jsonl`) — no sidecar
//! required, so snapshots survive a server restart. When the session is LIVE, the route
//! overlays its folded pending approvals/questions onto the disk-built JSON and flips the
//! presence-of-pending `capabilities` gates (reload-while-pending — Task 3, matching
//! `normalize.ts:186-204, 226-232`). A missing transcript is a positive
//! denial: 404 with `code:'FRESH_AGENT_LOST_SESSION'` (the codex/opencode convention); a
//! read failure is a 500. An outright invalid enum member (e.g. `sessionType=bogus`) is a
//! 400, mirroring the reference's `ThreadParamsSchema.safeParse` failure (`router.ts:181-186`).

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

use crate::claude::FreshClaudeState;
use crate::codex::{CodexSnapshotError, FreshCodexState};
use crate::{FreshAgentState, OpencodeSnapshotError};

/// `FreshAgentSessionTypeSchema` (`fresh-agent-contract.ts:3`).
const VALID_SESSION_TYPES: &[&str] = &["freshclaude", "freshcodex", "kilroy", "freshopencode"];
/// `FreshAgentRuntimeProviderSchema` (`fresh-agent-contract.ts:4`).
const VALID_PROVIDERS: &[&str] = &["claude", "codex", "opencode"];

/// Shared, cheaply-cloneable state for the snapshot endpoint: the auth token plus the
/// three provider slices this port builds snapshots from (claude included — its live
/// pending approvals/questions overlay the disk-built snapshot, Task 3).
#[derive(Clone)]
pub struct SnapshotState {
    auth_token: Arc<String>,
    codex: FreshCodexState,
    opencode: FreshAgentState,
    claude: FreshClaudeState,
}

impl SnapshotState {
    pub fn new(
        auth_token: Arc<String>,
        codex: FreshCodexState,
        opencode: FreshAgentState,
        claude: FreshClaudeState,
    ) -> Self {
        Self {
            auth_token,
            codex,
            opencode,
            claude,
        }
    }
    async fn local_owner(
        &self,
        session_type: &str,
        provider: &str,
        native_id: &str,
    ) -> Option<freshell_ownership::OwnershipSnapshot> {
        match (session_type, provider) {
            ("freshcodex", "codex") => self.codex.local_snapshot_owner(native_id).await,
            ("freshclaude" | "kilroy", "claude") => {
                self.claude.local_snapshot_owner(native_id).await
            }
            ("freshopencode", "opencode") => self.opencode.local_snapshot_owner(native_id).await,
            _ => None,
        }
    }

    async fn exact_saved_history(
        &self,
        session_type: &str,
        provider: &str,
        native_id: &str,
    ) -> Option<serde_json::Value> {
        let snapshot = match (session_type, provider) {
            ("freshcodex", "codex") => self
                .codex
                .exact_saved_snapshot(native_id)
                .await
                .ok()
                .flatten()?,
            ("freshclaude" | "kilroy", "claude") => {
                let rollback = self.claude.load_rollback_record(native_id).await;
                let saved = crate::claude_snapshot::get_claude_snapshot(
                    session_type,
                    native_id,
                    rollback.as_ref(),
                )
                .await
                .ok()?;
                crate::native_history::readonly_snapshot(provider, saved).ok()?
            }
            ("freshopencode", "opencode") => {
                let id = native_id.to_owned();
                let path =
                    freshell_sessions::parse::default_opencode_data_home().join("opencode.db");
                tokio::task::spawn_blocking(move || {
                    crate::native_history::read_opencode_path(&path, &id).and_then(|snapshot| {
                        crate::native_history::readonly_snapshot("opencode", snapshot)
                    })
                })
                .await
                .ok()?
                .ok()?
            }
            _ => return None,
        };
        (snapshot["threadId"].as_str() == Some(native_id)
            && snapshot["provider"].as_str() == Some(provider)
            && snapshot["sessionType"].as_str() == Some(session_type))
        .then_some(snapshot)
    }

    async fn saved_history_or_unavailable(
        &self,
        session_type: &str,
        provider: &str,
        native_id: &str,
    ) -> Response {
        let saved = self
            .exact_saved_history(session_type, provider, native_id)
            .await;
        tracing::debug!(
            event = "fresh_agent.snapshot.saved_history_fallback",
            session_type,
            provider,
            native_id,
            available = saved.is_some(),
            "Live snapshot unavailable; read exact saved history"
        );
        match saved {
            Some(snapshot) => Json(snapshot).into_response(),
            None => fail(
                StatusCode::SERVICE_UNAVAILABLE,
                "Managed conversation snapshot unavailable".into(),
            ),
        }
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

    let local_owner = state
        .local_owner(&session_type, &provider, &thread_id)
        .await;
    if local_owner.is_none()
        && VALID_SESSION_TYPES.contains(&session_type.as_str())
        && VALID_PROVIDERS.contains(&provider.as_str())
    {
        if let Some(gateway) = state.opencode.hosted_rest_gateway() {
            match gateway
                .snapshot(crate::hosted_rest::HostedRestSnapshot {
                    session_id: thread_id.clone(),
                    provider: provider.clone(),
                    session_type: session_type.clone(),
                })
                .await
            {
                Ok(Some(snapshot)) => return Json(snapshot).into_response(),
                Ok(None) => {}
                Err(crate::hosted_rest::HostedRestSnapshotError::ManagedUnavailable) => {
                    return fail(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Managed conversation snapshot unavailable".into(),
                    );
                }
                Err(crate::hosted_rest::HostedRestSnapshotError::OwnershipUnavailable) => {
                    return state
                        .saved_history_or_unavailable(&session_type, &provider, &thread_id)
                        .await
                }
            }
        }
    }

    let response = match (session_type.as_str(), provider.as_str()) {
        ("freshcodex", "codex") => match state.codex.get_snapshot(&thread_id, cwd.as_deref()).await
        {
            Ok(snapshot) => Json(snapshot).into_response(),
            Err(CodexSnapshotError::NotFound) => fail_with_code(
                StatusCode::NOT_FOUND,
                format!("codex thread {thread_id} not found"),
                "FRESH_AGENT_LOST_SESSION",
            ),
            Err(CodexSnapshotError::AppServer(err)) => {
                fail(StatusCode::INTERNAL_SERVER_ERROR, err.to_string())
            }
            // Mirrors `router.ts`'s generic catch-all 500 (`router.ts:165-166`) for an
            // unrecognized codex thread-item `type` (see `CodexSnapshotError::Protocol`).
            Err(CodexSnapshotError::Protocol(message)) => {
                fail(StatusCode::INTERNAL_SERVER_ERROR, message)
            }
            // kata b8ke Task 5: the typed ownership refusals — a session
            // another runtime owns or a transition holds answers the 409
            // envelope (the `fail_json_restore_unavailable` shape).
            Err(
                typed @ (CodexSnapshotError::ReservedByOwner { .. }
                | CodexSnapshotError::HandoffInProgress { .. }),
            ) => {
                let (owner_kind, generation) = match &typed {
                    CodexSnapshotError::ReservedByOwner {
                        owner_kind,
                        generation,
                    } => (Some(*owner_kind), *generation),
                    CodexSnapshotError::HandoffInProgress { generation } => (None, *generation),
                    _ => unreachable!("the match above names only the typed refusals"),
                };
                // The provider already refused this read using the current ownership fence.
                // Preserve that refusal rather than replacing it with saved history below.
                return snapshot_error_response(&thread_id, owner_kind, generation);
            }
            // Defensive depth: `get_snapshot` already folds this into its
            // `Ok` (the empty snapshot), so this arm is unreachable today —
            // but the route's contract for it stays the same 200 empty
            // snapshot if it ever propagates.
            Err(CodexSnapshotError::UntrackedReadonly { ownership }) => {
                Json(state.codex.empty_readonly_snapshot(&thread_id, &ownership)).into_response()
            }
        },
        ("freshopencode", "opencode") => {
            match state
                .opencode
                .get_opencode_snapshot(&thread_id, cwd.as_deref())
                .await
            {
                Ok(snapshot) => Json(snapshot).into_response(),
                Err(OpencodeSnapshotError::NotFound) => fail_with_code(
                    StatusCode::NOT_FOUND,
                    format!("opencode session {thread_id} not found"),
                    "FRESH_AGENT_LOST_SESSION",
                ),
                Err(OpencodeSnapshotError::Serve(err)) => {
                    fail(StatusCode::INTERNAL_SERVER_ERROR, err.to_string())
                }
                // b8ke delta review F4: the typed ownership refusals ride the
                // daemon-absent path — the same 409 envelope the codex arm
                // serves (never a spawn, never a fake snapshot).
                Err(
                    typed @ (OpencodeSnapshotError::ReservedByOwner { .. }
                    | OpencodeSnapshotError::HandoffInProgress { .. }),
                ) => {
                    let (owner_kind, generation) = match &typed {
                        OpencodeSnapshotError::ReservedByOwner {
                            owner_kind,
                            generation,
                        } => (Some(*owner_kind), *generation),
                        OpencodeSnapshotError::HandoffInProgress { generation } => {
                            (None, *generation)
                        }
                        _ => unreachable!("the match above names only the typed refusals"),
                    };
                    return snapshot_error_response(&thread_id, owner_kind, generation);
                }
            }
        }
        // One arm serves both session types (the SAME overlay logic — kilroy rides the
        // claude path): overlays populate + gates flip identically, only the stamped
        // `sessionType` differs.
        ("freshclaude", "claude") | ("kilroy", "claude") => {
            // Kata 1wxv Task 5: the durable rollback record rides the disk-built
            // snapshot (marker bucket + `rollback{canRedo, undoneDepth}` + revision
            // floor). The record is ledger-sync (memory-fast) and resolves by the
            // DURABLE id even when no session is live (durable+multi-client truth).
            let rollback = state.claude.load_rollback_record(&thread_id).await;
            match crate::claude_snapshot::get_claude_snapshot(
                &session_type,
                &thread_id,
                rollback.as_ref(),
            )
            .await
            {
                Ok(mut snapshot) => {
                    // Task 3 (reload-while-pending): overlay the session's LIVE pending
                    // approvals/questions and flip the presence-of-pending gates
                    // (`normalize.ts:186-204, 226-232`). The thread id resolves through
                    // `cli_index` like every claude handler; an untracked id (e.g. a
                    // disk-only read after restart) yields an empty overlay = strict
                    // no-op, byte-identical to the pre-overlay output.
                    let (approvals, questions) =
                        state.claude.snapshot_pending_overlay(&thread_id).await;
                    crate::claude_snapshot::apply_pending_overlay(
                        &mut snapshot,
                        approvals,
                        questions,
                    );
                    state
                        .claude
                        .apply_snapshot_metadata(&thread_id, &mut snapshot)
                        .await;
                    Json(snapshot).into_response()
                }
                Err(crate::claude_snapshot::ClaudeSnapshotError::NotFound) => fail_with_code(
                    StatusCode::NOT_FOUND,
                    format!("claude session {thread_id} not found"),
                    "FRESH_AGENT_LOST_SESSION",
                ),
                Err(crate::claude_snapshot::ClaudeSnapshotError::Io(err)) => {
                    fail(StatusCode::INTERNAL_SERVER_ERROR, err)
                }
            }
        }
        (session_type_value, provider_value) => {
            if !VALID_SESSION_TYPES.contains(&session_type_value)
                || !VALID_PROVIDERS.contains(&provider_value)
            {
                return fail(StatusCode::BAD_REQUEST, "Invalid request".to_string());
            }
            // Every structurally valid locator now has an adapter registered above; this
            // 503 arm is retained purely as a safety net for future enum growth --
            // mirrors `FreshAgentRuntimeUnavailableError` (`runtime-manager.ts:25-27`).
            fail_with_code(
                StatusCode::SERVICE_UNAVAILABLE,
                format!("No fresh-agent snapshot adapter registered for {session_type_value}"),
                "FRESH_AGENT_RUNTIME_UNAVAILABLE",
            )
        }
    };
    // A local read never publishes the authority of an owner that changed while it awaited the provider.
    if let Some(before) = local_owner {
        if state
            .local_owner(&session_type, &provider, &thread_id)
            .await
            .as_ref()
            != Some(&before)
        {
            return state
                .saved_history_or_unavailable(&session_type, &provider, &thread_id)
                .await;
        }
    }
    response
}

fn fail(status: StatusCode, message: String) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

fn fail_with_code(status: StatusCode, message: String, code: &str) -> Response {
    (status, Json(json!({ "error": message, "code": code }))).into_response()
}

/// kata b8ke Task 5: the typed 409 envelope for a snapshot GET against a
/// session another runtime owns or a transition holds — the
/// `fail_json_restore_unavailable` shape (`terminal_tabs.rs`): the frozen
/// "still running on the server." message text (client regexes and muscle
/// memory depend on it) with the additive `ownerKind`/`ownerGeneration`
/// fields riding the same rule (omitted when the transition names no
/// committed owner — the `terminal_owner_fields_from_outcome` discipline).
/// b8ke delta review F4: shared by the codex and opencode arms.
fn snapshot_error_response(
    thread_id: &str,
    owner_kind: Option<freshell_ownership::RuntimeOwnerKind>,
    generation: u64,
) -> Response {
    let mut body = json!({
        "status": "error",
        "code": "RESTORE_UNAVAILABLE",
        "message": format!("Session {thread_id} is still running on the server."),
    });
    if let Some(owner_kind) = owner_kind {
        body["ownerKind"] = json!(match owner_kind {
            freshell_ownership::RuntimeOwnerKind::Terminal => "terminal",
            freshell_ownership::RuntimeOwnerKind::FreshAgent => "fresh-agent",
        });
    }
    // A refusal always names its fence-relevant generation (a transition
    // names no committed owner identity — only its generation is
    // truthfully known).
    body["ownerGeneration"] = json!(generation);
    (StatusCode::CONFLICT, Json(body)).into_response()
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
        Endpoint, EventSource, EventStreamHandle, OpencodeServeManager, PortAllocator,
        ProcessSpawner, ServeConfig, ServeDeps, ServeHttp, ServeHttpError, ServeHttpRequest,
        ServeHttpResponse, ServeProcess, SpawnRequest,
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

    fn claude_state() -> FreshClaudeState {
        FreshClaudeState::new(Arc::new(tokio::sync::broadcast::channel::<String>(64).0))
    }

    fn snapshot_state() -> SnapshotState {
        SnapshotState::new(
            Arc::new("tok".to_string()),
            codex_state(),
            opencode_state(),
            claude_state(),
        )
    }

    fn headers_with_token(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", token.parse().unwrap());
        headers
    }

    struct SnapshotGateway;

    #[async_trait::async_trait]
    impl crate::hosted_rest::HostedFreshAgentRestGateway for SnapshotGateway {
        async fn create_agent(
            self: Arc<Self>,
            _: crate::hosted_rest::HostedRestCreate,
        ) -> Result<crate::hosted_rest::HostedRestCreated, ()> {
            panic!("GET must not create")
        }
        async fn send_agent(
            &self,
            _: crate::hosted_rest::HostedRestSend,
        ) -> Result<crate::hosted_rest::HostedRestSendResult, ()> {
            panic!("GET must not send")
        }
        async fn snapshot(
            &self,
            request: crate::hosted_rest::HostedRestSnapshot,
        ) -> Result<Option<serde_json::Value>, crate::hosted_rest::HostedRestSnapshotError>
        {
            if request.session_id == "unavailable-host" {
                return Err(crate::hosted_rest::HostedRestSnapshotError::ManagedUnavailable);
            }
            Ok(Some(
                json!({"threadId":request.session_id,"status":"running",
                "provider":request.provider,"sessionType":request.session_type,
                "turns":[{"turnId":"owned-live-turn"}]}),
            ))
        }
    }

    #[tokio::test]
    async fn existing_snapshot_get_reads_hosted_truth_and_never_falls_back_on_host_failure() {
        for (id, expected) in [
            ("owned-host", StatusCode::OK),
            ("unavailable-host", StatusCode::SERVICE_UNAVAILABLE),
        ] {
            let state = snapshot_state();
            state
                .opencode
                .set_hosted_rest_gateway(Arc::new(SnapshotGateway))
                .unwrap();
            let response = get_snapshot(
                State(state),
                Path(("freshcodex".into(), "codex".into(), id.into())),
                Query(HashMap::new()),
                headers_with_token("tok"),
            )
            .await;
            assert_eq!(response.status(), expected);
            if expected == StatusCode::OK {
                let body = axum::body::to_bytes(response.into_body(), 4096)
                    .await
                    .unwrap();
                let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(value["status"], "running");
                assert_eq!(value["turns"][0]["turnId"], "owned-live-turn");
            }
        }
    }

    #[tokio::test]
    async fn missing_auth_header_is_401() {
        let resp = get_snapshot(
            State(snapshot_state()),
            Path((
                "freshcodex".to_string(),
                "codex".to_string(),
                "thread-1".to_string(),
            )),
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
            Path((
                "bogus".to_string(),
                "codex".to_string(),
                "thread-1".to_string(),
            )),
            Query(HashMap::new()),
            headers_with_token("tok"),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    // NOTE: `valid_but_unregistered_locator_is_503_with_code` used to live here. With
    // the claude adapter registered, NO structurally-valid locator is unregistered
    // anymore -- the handler's catch-all 503 arm is retained purely as a safety net for
    // future enum growth. The two claude tests below plus the existing 400
    // invalid-locator tests now cover the whole routing table.

    // Env vars are process-global and cargo test is multi-threaded: EVERY test that
    // mutates claude-store env (this file AND claude.rs) must take the SAME lock --
    // two independent per-file locks would NOT serialize against each other. claude.rs's
    // `CLAUDE_ENV_LOCK` is `pub(crate)` for exactly this (mirroring how this file
    // already reuses `crate::codex::tests::ENV_LOCK`).
    use crate::claude::tests::CLAUDE_ENV_LOCK;

    /// The authorized-GET construction every test in this file uses, returning
    /// `(status, parsed JSON body)`.
    async fn get_json(
        session_type: &str,
        provider: &str,
        thread_id: &str,
    ) -> (StatusCode, serde_json::Value) {
        let resp = get_snapshot(
            State(snapshot_state()),
            Path((
                session_type.to_string(),
                provider.to_string(),
                thread_id.to_string(),
            )),
            Query(HashMap::new()),
            headers_with_token("tok"),
        )
        .await;
        let status = resp.status();
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        (status, value)
    }

    #[tokio::test]
    async fn claude_locator_serves_a_snapshot_from_the_transcript_store() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("projects").join("-e2e");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("55555555-5555-4555-8555-555555555555.jsonl"),
            r#"{"type":"user","timestamp":"2026-07-25T10:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}"#,
        )
        .unwrap();
        // CLAUDE_CONFIG_DIR is the FIRST candidate root (what the real CLI honors) --
        // setting it makes the test immune to ambient CLAUDE_HOME/HOME.
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());

        let (status, body) = get_json(
            "freshclaude",
            "claude",
            "55555555-5555-4555-8555-555555555555",
        )
        .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["sessionType"], "freshclaude");
        assert_eq!(body["provider"], "claude");
        assert_eq!(body["turns"][0]["role"], "user");
        assert_eq!(body["turns"][0]["items"][0]["text"], "hello");
        assert!(body["revision"].as_i64().unwrap() >= 0);
    }

    #[tokio::test]
    async fn claude_locator_with_unknown_session_id_is_404_with_lost_session_code() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join("projects")).unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        let (status, body) =
            get_json("kilroy", "claude", "66666666-6666-4666-8666-666666666666").await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["code"], "FRESH_AGENT_LOST_SESSION");
    }

    /// Write a one-user-turn transcript for `durable` under a temp claude store root and
    /// point `CLAUDE_CONFIG_DIR` (the FIRST candidate root) at it. Returns the tempdir
    /// guard + the exact content written (the empty-shape test rebuilds its expectation
    /// from it).
    fn stage_transcript(durable: &str) -> (tempfile::TempDir, &'static str) {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("projects").join("-p");
        std::fs::create_dir_all(&dir).unwrap();
        let content = r#"{"type":"user","timestamp":"2026-08-15T10:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}"#;
        std::fs::write(dir.join(format!("{durable}.jsonl")), content).unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        (home, content)
    }

    /// Authorized GET against an explicit [`SnapshotState`] (the overlay tests stage a
    /// live claude session, so the no-live-claude `get_json` helper cannot serve them).
    async fn get_json_with_state(
        state: SnapshotState,
        session_type: &str,
        thread_id: &str,
    ) -> (StatusCode, serde_json::Value) {
        let resp = get_snapshot(
            State(state),
            Path((
                session_type.to_string(),
                "claude".to_string(),
                thread_id.to_string(),
            )),
            Query(HashMap::new()),
            headers_with_token("tok"),
        )
        .await;
        let status = resp.status();
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, serde_json::from_slice(&body).unwrap())
    }

    /// Task 3 (reload-while-pending): a live claude session's folded pending
    /// approvals/questions overlay the disk-built snapshot — `pendingApprovals`/
    /// `pendingQuestions` populated with the exact `.strict()` contract entry keys
    /// (object equality pins the KEY SET: no extras, no missing) and the
    /// presence-of-pending gates flipped (`normalize.ts:186-204, 226-232`). Addressed by
    /// the DURABLE UUID (the `cli_index` alias), the id a live pane's GET carries.
    #[tokio::test]
    async fn claude_locator_overlays_live_pending_and_flips_capability_gates() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let durable = "81818181-8181-4818-8818-818181818181";
        let (_home, _content) = stage_transcript(durable);
        let claude = claude_state();
        crate::claude::tests::insert_fake_claude_session_with_pending(
            &claude,
            "client-nanoid-9",
            Some(durable),
            &[
                json!({ "type": "sdk.permission.request", "sessionId": "s", "requestId": "req-1",
                        "subtype": "can_use_tool",
                        "tool": { "name": "Bash", "input": { "command": "ls" } },
                        "toolUseID": "toolu_1", "blockedPath": "/repo/.env",
                        "decisionReason": "command requires approval" }),
                json!({ "type": "sdk.question.request", "sessionId": "s", "requestId": "q-1",
                        "questions": [{ "question": "Continue?", "header": "Confirm" }] }),
            ],
        )
        .await;

        let state = SnapshotState::new(
            Arc::new("tok".to_string()),
            codex_state(),
            opencode_state(),
            claude,
        );
        let (status, value) = get_json_with_state(state, "freshclaude", durable).await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(value["sessionType"], json!("freshclaude"));
        assert_eq!(
            value["pendingApprovals"],
            json!([{
                "requestId": "req-1", "toolName": "Bash", "toolUseID": "toolu_1",
                "blockedPath": "/repo/.env", "decisionReason": "command requires approval",
                "input": { "command": "ls" },
            }]),
            "exact `.strict()` entry keys ({{requestId, toolName?, toolUseID?, blockedPath?, decisionReason?, input?}}) — no extras, omitted-when-absent"
        );
        assert_eq!(
            value["pendingQuestions"],
            json!([{
                "requestId": "q-1",
                "questions": [{ "question": "Continue?", "header": "Confirm" }],
            }])
        );
        assert_eq!(value["capabilities"]["approvals"], json!(true));
        assert_eq!(value["capabilities"]["questions"], json!(true));
    }

    /// Delta-review round 5 (AGENT-06): an SDK-valid question whose options carry the
    /// documented `preview` field (plus other extras the sidecar preserves verbatim via
    /// `permission-channel.mjs`'s `...o`) must still produce a snapshot whose
    /// `pendingQuestions` entries satisfy the STRICT
    /// `FreshAgentQuestionDefinitionSchema` — the pending overlay normalizes the
    /// snapshot-bound copy at fold time. With no zod in Rust, strictness is pinned by
    /// exact key-set assertions at BOTH nesting levels. The WS broadcast of the same
    /// frame stays verbatim (forwards-compat), pinned on the claude.rs side.
    #[tokio::test]
    async fn claude_locator_pending_question_entry_is_contract_exact_after_normalize() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let durable = "84848484-8484-4848-8848-848484848484";
        let (_home, _content) = stage_transcript(durable);
        let claude = claude_state();
        crate::claude::tests::insert_fake_claude_session_with_pending(
            &claude,
            "client-nanoid-12",
            Some(durable),
            &[
                json!({ "type": "sdk.question.request", "sessionId": "s", "requestId": "q-prev",
                    "questions": [{
                        "question": "Pick one",
                        "header": "Choice",
                        "multiSelect": false,
                        "options": [
                            { "label": "Yes", "description": "go ahead", "preview": "diff…" },
                            { "label": "No", "description": "stop", "preview": 42 }
                        ],
                        "extraTop": { "nested": "dropped" }
                    }] }),
            ],
        )
        .await;

        let state = SnapshotState::new(
            Arc::new("tok".to_string()),
            codex_state(),
            opencode_state(),
            claude,
        );
        let (status, value) = get_json_with_state(state, "freshclaude", durable).await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        assert_eq!(status, StatusCode::OK);
        // The snapshot route succeeds with the preview-carrying pending question (the
        // reload-while-pending card now renders under the client's strict parse).
        assert_eq!(value["capabilities"]["questions"], json!(true));
        assert_eq!(
            value["pendingQuestions"],
            json!([{
                "requestId": "q-prev",
                "questions": [{
                    "question": "Pick one",
                    "header": "Choice",
                    "multiSelect": false,
                    "options": [
                        { "label": "Yes", "description": "go ahead" },
                        { "label": "No", "description": "stop" }
                    ]
                }],
            }]),
            "snapshot-bound pending question entries carry EXACTLY the strict-contract keys at both levels — `preview` and other extras dropped"
        );
        // Explicit structural key-set assertion at BOTH nesting levels (strictness, no
        // zod required): question ⊆ {question, header, options, multiSelect}, option == {label, description}.
        let question = &value["pendingQuestions"][0]["questions"][0];
        let question_keys: std::collections::BTreeSet<&str> = question
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert!(
            question_keys
                .iter()
                .all(|k| ["question", "header", "options", "multiSelect"].contains(k)),
            "question-level keys stay within the contract: {question_keys:?}"
        );
        for option in question["options"].as_array().unwrap() {
            let option_keys: std::collections::BTreeSet<&str> = option
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect();
            assert_eq!(
                option_keys.iter().copied().collect::<Vec<_>>(),
                ["description", "label"],
                "option keys are EXACTLY {{label, description}} (sorted)"
            );
        }
    }

    /// Task 3: kilroy rides the SAME claude overlay path — live pending overlays, the
    /// gate flips, and `sessionType` keeps the kilroy flavour (AGENT-24's ride-through).
    #[tokio::test]
    async fn kilroy_locator_overlays_live_pending_with_kilroy_session_type() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let durable = "82828282-8282-4828-8828-828282828282";
        let (_home, _content) = stage_transcript(durable);
        let claude = claude_state();
        crate::claude::tests::insert_fake_claude_session_with_pending(
            &claude,
            "client-nanoid-10",
            Some(durable),
            &[
                json!({ "type": "sdk.permission.request", "sessionId": "s", "requestId": "req-7",
                      "subtype": "can_use_tool",
                      "tool": { "name": "Read", "input": { "file_path": "/a" } },
                      "toolUseID": "toolu_7" }),
            ],
        )
        .await;

        let state = SnapshotState::new(
            Arc::new("tok".to_string()),
            codex_state(),
            opencode_state(),
            claude,
        );
        let (status, value) = get_json_with_state(state, "kilroy", durable).await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(value["sessionType"], json!("kilroy"));
        assert_eq!(
            value["pendingApprovals"],
            json!([{
                "requestId": "req-7", "toolName": "Read", "toolUseID": "toolu_7",
                "input": { "file_path": "/a" },
            }])
        );
        assert!(value["pendingQuestions"].as_array().unwrap().is_empty());
        // Per-kind gate independence: approvals flip, questions stay false.
        assert_eq!(value["capabilities"]["approvals"], json!(true));
        assert_eq!(value["capabilities"]["questions"], json!(false));
    }

    /// Kata 1wxv Task 5: the claude route SURFACES the durable rollback record —
    /// the marker bucket (ledger entries union, stamped rolledBack:true) and the
    /// `rollback{canRedo, undoneDepth}` block — on a DISK-ONLY read (no live
    /// session needed; durable+multi-client truth per decision 10). The chain
    /// root's tip is re-read at snapshot time for the canRedo recheck.
    #[tokio::test]
    async fn claude_locator_surfaces_the_durable_rollback_record() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("projects").join("-p");
        std::fs::create_dir_all(&dir).unwrap();
        let original = "93939393-9393-4939-8939-939393939393";
        let current = "94949494-9494-4949-8949-949494949494";
        let original_text = [
            json!({"type":"user","uuid":"u1","parentUuid":null,"timestamp":"t1","message":{"role":"user","content":[{"type":"text","text":"prompt one"}]}}),
            json!({"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"t2","message":{"role":"assistant","content":[{"type":"text","text":"answer one"}]}}),
            json!({"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"t3","message":{"role":"user","content":[{"type":"text","text":"prompt two"}]}}),
            json!({"type":"assistant","uuid":"a2","parentUuid":"u2","timestamp":"t4","message":{"role":"assistant","content":[{"type":"text","text":"answer two"}]}}),
        ]
        .iter()
        .map(|v| v.to_string())
        .collect::<Vec<_>>()
        .join("\n");
        let current_text = original_text.lines().take(2).collect::<Vec<_>>().join("\n");
        std::fs::write(dir.join(format!("{original}.jsonl")), &original_text).unwrap();
        std::fs::write(dir.join(format!("{current}.jsonl")), &current_text).unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());

        // Seed the ledger: one undo op over [u2, a2] (verbatim display-turn JSON,
        // as the Task 4 handler records it; `rolledBack` is stamped at READ).
        let claude = claude_state();
        let fake = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        claude.set_identity_sink(fake.clone());
        use crate::identity_sink::PaneIdentitySink;
        let mut record = crate::rollback_record::RollbackRecord::empty(50);
        record.original_session_id = Some(original.to_string());
        record.original_tip_uuid = Some("a2".to_string());
        record.push_entry(
            crate::rollback_record::RollbackEntry {
                removed_turns: vec![
                    json!({ "id": "u2", "turnId": "u2", "ordinal": 2, "source": "durable", "role": "user", "summary": "prompt two", "items": [{ "id": "u2-i0", "kind": "text", "text": "prompt two" }] }),
                    json!({ "id": "a2", "turnId": "a2", "ordinal": 3, "source": "durable", "role": "assistant", "summary": "answer two", "items": [{ "id": "a2-i0", "kind": "text", "text": "answer two" }] }),
                ],
                prompt_text: "prompt two".into(),
                at_ms: 90,
                epoch: 0,
            },
            100,
        );
        record.set_can_redo(true, 100);
        fake.record_rollback("claude", current, record)
            .await
            .expect("record write");

        let state = SnapshotState::new(
            Arc::new("tok".to_string()),
            codex_state(),
            opencode_state(),
            claude,
        );
        let (status, value) = get_json_with_state(state, "freshclaude", current).await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(value["capabilities"]["undo"], json!(true));
        assert_eq!(value["capabilities"]["redo"], json!(true));
        assert_eq!(
            value["rollback"],
            json!({ "canRedo": true, "undoneDepth": 1, "redoableTurnIds": ["u2"] })
        );
        let bucket = value["rolledBackTurns"].as_array().expect("bucket");
        let ids: Vec<&str> = bucket.iter().filter_map(|t| t["turnId"].as_str()).collect();
        assert_eq!(ids, vec!["u2", "a2"]);
        assert!(bucket.iter().all(|t| t["rolledBack"] == json!(true)));
        assert!(
            bucket.iter().all(|t| t["restorable"] == json!(true)),
            "the REST-surfaced bucket carries restorable:true (current chain, redo available)"
        );
        // The ACTIVE prefix is unaffected by the ledger bucket.
        let prefix: Vec<&str> = value["turns"]
            .as_array()
            .expect("turns")
            .iter()
            .filter_map(|t| t["turnId"].as_str())
            .collect();
        assert_eq!(prefix, vec!["u1", "a1"]);
    }

    /// An idle live session keeps the disk-backed history and empty pending
    /// shape, with an additive marker proving its idle status is live truth.
    #[tokio::test]
    async fn claude_locator_with_a_live_but_empty_pending_set_keeps_the_empty_shape() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let durable = "83838383-8383-4838-8838-838383838383";
        let (_home, content) = stage_transcript(durable);
        let claude = claude_state();
        crate::claude::tests::insert_fake_claude_session_with_pending(
            &claude,
            "client-nanoid-11",
            Some(durable),
            &[],
        )
        .await;

        let state = SnapshotState::new(
            Arc::new("tok".to_string()),
            codex_state(),
            opencode_state(),
            claude,
        );
        let (status, value) = get_json_with_state(state, "freshclaude", durable).await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        assert_eq!(status, StatusCode::OK);
        let mut expected = crate::claude_snapshot::build_claude_snapshot_json(
            "freshclaude",
            durable,
            content,
            0,
            None,
        );
        // `revision` is transcript-mtime-derived — not the shape under test.
        expected["revision"] = value["revision"].clone();
        expected["extensions"]["claude"]["statusFromLiveState"] = json!(true);
        assert_eq!(
            value, expected,
            "empty live pending preserves the snapshot apart from its status authority marker"
        );
    }

    /// kata b8ke Task 5 (round-2 review — intended behavior change): an
    /// unknown codex thread answers 200 with the SIDE-EFFECT-FREE empty
    /// snapshot (owner state vacant) — never the removed cold-start, which
    /// with no reachable `CODEX_CMD` used to surface as a generic 500. The
    /// bogus-binary setup is retained deliberately: if the GET ever regresses
    /// to spawning, this test fails again (coverage purpose preserved,
    /// expectation inverted).
    #[tokio::test]
    async fn unknown_codex_thread_serves_the_side_effect_free_empty_snapshot() {
        let _guard = crate::codex::tests::ENV_LOCK.lock().await;
        std::env::set_var(
            "CODEX_CMD",
            "/definitely/not/a/real/codex/binary-xyz-does-not-exist",
        );
        std::env::remove_var("FAKE_CODEX_APP_SERVER_BEHAVIOR");
        let (status, body) = get_json("freshcodex", "codex", "does-not-exist").await;
        std::env::remove_var("CODEX_CMD");
        assert_eq!(
            status,
            StatusCode::OK,
            "an untracked thread serves the empty snapshot, not an error: {body}"
        );
        assert_eq!(body["sessionType"], json!("freshcodex"));
        assert_eq!(body["threadId"], json!("does-not-exist"));
        assert_eq!(body["turns"], json!([]));
        assert_eq!(
            body["extensions"]["codex"]["ownerKind"],
            json!("vacant"),
            "the additive owner-state fields name the vacant key: {body}"
        );
        assert!(
            body.get("code").is_none(),
            "a 200 snapshot body carries no error code: {body}"
        );
    }

    async fn codex_route_json(app: &Router, id: &str) -> (StatusCode, serde_json::Value) {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/fresh-agent/threads/freshcodex/codex/{id}"))
                    .header("x-auth-token", "tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn untracked_codex_route_reads_exact_saved_rollout_without_starting_or_writing() {
        let _guard = crate::codex::tests::ENV_LOCK.lock().await;
        let home = tempfile::tempdir().unwrap();
        let sessions = home.path().join("sessions/2026/03/01");
        std::fs::create_dir_all(&sessions).unwrap();
        let transcript = format!(
            "{}{}\n",
            include_str!("../../../test/fixtures/coding-cli/codex/task-events.sanitized.jsonl"),
            include_str!("../../../test/fixtures/managed-native-history/codex-tools.jsonl")
                .lines()
                .skip(1)
                .collect::<Vec<_>>()
                .join("\n")
        );
        let rollout = sessions.join("rollout-session-activity.jsonl");
        std::fs::write(&rollout, &transcript).unwrap();
        // A filename containing a requested identity does not prove ownership.
        std::fs::write(sessions.join("rollout-foreign-session.jsonl"), &transcript).unwrap();
        let modified = std::fs::metadata(&rollout).unwrap().modified().unwrap();
        let old_home = std::env::var_os("CODEX_HOME");
        let old_cmd = std::env::var_os("CODEX_CMD");
        std::env::set_var("CODEX_HOME", home.path());
        std::env::set_var("CODEX_CMD", "/definitely/not/a/codex-binary");
        let probe = tempfile::tempdir().unwrap();
        let marker = probe.path().join("spawned");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let script = probe.path().join("codex-probe");
            std::fs::write(
                &script,
                format!("#!/bin/sh\ntouch '{}'\nexit 0\n", marker.display()),
            )
            .unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            std::env::set_var("CODEX_CMD", script);
        }
        let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let mut codex = codex_state();
        codex.set_ownership(ownership.clone());
        let app = router(SnapshotState::new(
            Arc::new("tok".into()),
            codex,
            opencode_state(),
            claude_state(),
        ));
        let mut results = Vec::new();
        for id in ["session-activity", "foreign-session", "genuinely-absent"] {
            results.push(codex_route_json(&app, id).await);
        }
        assert_eq!(
            ownership.observe("codex", "session-activity").state,
            freshell_ownership::OwnershipState::Vacant
        );
        let freshell_ownership::BeginOutcome::Granted { generation } = ownership.begin_start(
            "codex",
            "session-activity",
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "read-test",
            None,
            "test",
            1_000,
        ) else {
            panic!("test grants starting ownership")
        };
        let starting = codex_route_json(&app, "session-activity").await;
        assert_eq!(
            ownership.commit_live(
                "codex",
                "session-activity",
                "read-test",
                generation,
                freshell_ownership::OwnerIdentity {
                    kind: freshell_ownership::RuntimeOwnerKind::Terminal,
                    terminal_id: Some("terminal-reader-test".into()),
                    live_session_key: None,
                    pid: None,
                    ownership_id: None,
                }
            ),
            freshell_ownership::CommitOutcome::Committed
        );
        let terminal_owned = codex_route_json(&app, "session-activity").await;
        for (key, old) in [("CODEX_HOME", old_home), ("CODEX_CMD", old_cmd)] {
            match old {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        let (status, snapshot) = &results[0];
        assert_eq!(*status, StatusCode::OK, "{snapshot}");
        let items: Vec<_> = snapshot["turns"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|turn| turn["items"].as_array().unwrap())
            .collect();
        assert!(
            items.iter().any(|item| item["text"] == "Sanitized prompt"),
            "{snapshot}"
        );
        assert!(items
            .iter()
            .any(|item| item["text"] == "Sanitized completion"));
        assert!(items.iter().any(|item| item["kind"] == "dynamic_tool"
            && item["contentItems"][0]["text"] == "Patch saved"));
        assert!(items
            .iter()
            .any(|item| item["kind"] == "command" && item["output"] == "/workspace"));
        assert!(items.iter().any(|item| item["kind"] == "mcp_tool"));
        assert_eq!(
            snapshot["extensions"]["codex"]["nativeHistoryAvailable"],
            true
        );
        assert_eq!(snapshot["extensions"]["codex"]["ownerKind"], "vacant");
        assert!(snapshot["extensions"]["codex"]["ownerEpoch"].is_number());
        assert!(snapshot["capabilities"]
            .as_object()
            .unwrap()
            .values()
            .filter(|value| value.is_boolean())
            .all(|value| value == false));
        for (status, absent) in &results[1..] {
            assert_eq!(*status, StatusCode::OK);
            assert_eq!(
                absent["turns"],
                json!([]),
                "must not select a foreign rollout"
            );
        }
        assert_eq!(std::fs::read_to_string(&rollout).unwrap(), transcript);
        assert_eq!(
            std::fs::metadata(&rollout).unwrap().modified().unwrap(),
            modified
        );
        assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 1);
        assert!(!marker.exists(), "snapshot GET must not start the provider");
        for (status, refusal) in [starting, terminal_owned] {
            assert_eq!(status, StatusCode::CONFLICT);
            assert_eq!(refusal["code"], "RESTORE_UNAVAILABLE");
            assert!(
                refusal.get("turns").is_none(),
                "saved data cannot bypass ownership"
            );
        }
    }

    #[tokio::test]
    async fn codex_snapshot_success_returns_200_with_camelcase_body() {
        let (transport, peer) = freshell_codex::new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        let client = Arc::new(client);

        let codex = codex_state();
        codex
            .insert_session_for_test("thread-1", client, None)
            .await;
        let state = SnapshotState::new(
            Arc::new("tok".to_string()),
            codex,
            opencode_state(),
            claude_state(),
        );

        let driver = tokio::spawn(async move {
            get_snapshot(
                State(state),
                Path((
                    "freshcodex".to_string(),
                    "codex".to_string(),
                    "thread-1".to_string(),
                )),
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
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["sessionType"], json!("freshcodex"));
        assert_eq!(value["provider"], json!("codex"));
        assert_eq!(value["threadId"], json!("thread-1"));
        assert!(
            value.get("session_type").is_none(),
            "must be camelCase, not snake_case"
        );
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
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<ServeHttpResponse, ServeHttpError>>
                    + Send
                    + 'a,
            >,
        > {
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
            Ok(Endpoint {
                hostname: "127.0.0.1".into(),
                port: 1,
            })
        }
    }
    struct NoopHandle;
    impl EventStreamHandle for NoopHandle {}
    struct NoopEventSource;
    impl EventSource for NoopEventSource {
        fn connect(
            &self,
            _url: String,
            _sink: freshell_opencode::serve::EventSink,
        ) -> Box<dyn EventStreamHandle> {
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
                    { "info": { "id": "m2", "role": "assistant", "error": { "name": "UnknownError", "data": { "message": "boom" } } }, "parts": [{ "type": "step-start" }] },
                ]),
            }),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        opencode.set_manager_for_test(manager).await;

        let state = SnapshotState::new(
            Arc::new("tok".to_string()),
            codex_state(),
            opencode,
            claude_state(),
        );
        let resp = get_snapshot(
            State(state),
            Path((
                "freshopencode".to_string(),
                "opencode".to_string(),
                "ses_1".to_string(),
            )),
            Query(HashMap::new()),
            headers_with_token("tok"),
        )
        .await;

        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["sessionType"], json!("freshopencode"));
        assert_eq!(value["provider"], json!("opencode"));
        assert_eq!(value["threadId"], json!("ses_1"));
        assert_eq!(value["turns"][0]["items"][0]["text"], json!("hi"));
        assert_eq!(value["turns"][1]["error"]["name"], json!("UnknownError"));
        assert_eq!(value["turns"][1]["error"]["message"], json!("boom"));
    }

    /// b8ke delta review F4: the opencode snapshot GET is side-effect-free —
    /// a COLD GET (manager cell empty, shared serve absent) NEVER spawns
    /// the daemon: 200 with the empty-from-disk snapshot (the additive
    /// owner-state fields naming the vacant key), the manager cell still
    /// absent, and `OPENCODE_CMD` never consulted (the marker script proves
    /// a spawn was never attempted — a pre-fix spawn touches the marker and
    /// the exited process fails health, surfacing the 500 instead). Cold
    /// resume happens only through the explicit lifecycle commands.
    #[tokio::test]
    async fn opencode_cold_get_never_spawns_and_serves_the_empty_disk_snapshot() {
        let _guard = crate::OPENCODE_ENV_LOCK.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("marker-opencode");
        let marker = dir.path().join("spawned.marker");
        std::fs::write(
            &script,
            format!("#!/bin/sh\ntouch {}\nexit 0\n", marker.display()),
        )
        .expect("write marker opencode script");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&script).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&script, perms).expect("chmod marker opencode script");
        }
        std::env::set_var("OPENCODE_CMD", &script);
        let opencode = opencode_state();
        assert!(
            !opencode.opencode_manager_present_for_test().await,
            "the manager cell is absent BEFORE the cold GET"
        );

        let state = SnapshotState::new(
            Arc::new("tok".to_string()),
            codex_state(),
            opencode.clone(),
            claude_state(),
        );
        let resp = get_snapshot(
            State(state),
            Path((
                "freshopencode".to_string(),
                "opencode".to_string(),
                "ses_coldget".to_string(),
            )),
            Query(HashMap::new()),
            headers_with_token("tok"),
        )
        .await;
        std::env::remove_var("OPENCODE_CMD");

        assert_eq!(
            resp.status(),
            StatusCode::OK,
            "a cold GET serves the empty-from-disk snapshot, never a spawn"
        );
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["sessionType"], json!("freshopencode"));
        assert_eq!(value["threadId"], json!("ses_coldget"));
        assert_eq!(value["turns"], json!([]), "empty rows: {value}");
        assert_eq!(
            value["extensions"]["opencode"]["ownerKind"],
            json!("vacant"),
            "the additive owner-state fields name the vacant key: {value}"
        );
        assert!(
            value["extensions"]["opencode"]["ownerEpoch"].is_u64()
                && value["extensions"]["opencode"]["ownerGeneration"].is_u64(),
            "the owner-state fence pair rides the empty snapshot: {value}"
        );
        assert!(
            !opencode.opencode_manager_present_for_test().await,
            "the manager cell stays absent AFTER the cold GET — the GET never created it"
        );
        assert!(
            !marker.exists(),
            "the shared serve was never spawned (no marker touched)"
        );
    }

    /// b8ke delta review F4: the coordinator refusals ride the daemon-absent
    /// path (the codex Task-5 contract) — a key a TERMINAL owns answers the
    /// typed 409 (`RESTORE_UNAVAILABLE` with the owner fields), and a key a
    /// lifecycle transition holds answers the typed 409 too; neither ever
    /// consults (let alone spawns) the shared serve.
    #[tokio::test]
    async fn opencode_cold_get_owned_or_transitioning_answers_the_typed_409() {
        let _guard = crate::OPENCODE_ENV_LOCK.lock().await;
        // Pin the serve command to a would-never-start script so a pre-fix
        // run fails fast and deterministically instead of consulting the
        // ambient `opencode` binary.
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("no-opencode");
        std::fs::write(&script, "#!/bin/sh\nexit 1\n").expect("write no-opencode script");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&script).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&script, perms).expect("chmod no-opencode script");
        }
        std::env::set_var("OPENCODE_CMD", &script);
        let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        // Live{Terminal} for one key (begin_start + commit_live).
        let granted = ownership.begin_start(
            "opencode",
            "ses_owned",
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "owner-op",
            None,
            "test",
            0,
        );
        let freshell_ownership::BeginOutcome::Granted { generation } = granted else {
            panic!("the terminal owner must be granted its start");
        };
        assert_eq!(
            ownership.commit_live(
                "opencode",
                "ses_owned",
                "owner-op",
                generation,
                freshell_ownership::OwnerIdentity {
                    kind: freshell_ownership::RuntimeOwnerKind::Terminal,
                    terminal_id: Some("t-owned".to_string()),
                    live_session_key: None,
                    pid: None,
                    ownership_id: None,
                },
            ),
            freshell_ownership::CommitOutcome::Committed,
            "the terminal owner must commit Live"
        );
        // A transition holds a second key.
        assert!(matches!(
            ownership.begin_handoff(
                "opencode",
                "ses_transition",
                freshell_ownership::RuntimeOwnerKind::FreshAgent,
                "transition-op",
                None,
                "test",
                0,
            ),
            freshell_ownership::BeginOutcome::Granted { .. }
        ));
        std::env::remove_var("OPENCODE_CMD");

        let opencode = FreshAgentState::new(
            Arc::new("tok".to_string()),
            Arc::new(tokio::sync::broadcast::channel::<String>(64).0),
        )
        .with_ownership(ownership);
        assert!(
            !opencode.opencode_manager_present_for_test().await,
            "the manager cell is absent — the refusal arms are cold"
        );
        let state = SnapshotState::new(
            Arc::new("tok".to_string()),
            codex_state(),
            opencode.clone(),
            claude_state(),
        );
        for (sid, want_owner_kind) in [("ses_owned", Some("terminal")), ("ses_transition", None)] {
            let resp = get_snapshot(
                State(state.clone()),
                Path((
                    "freshopencode".to_string(),
                    "opencode".to_string(),
                    sid.to_string(),
                )),
                Query(HashMap::new()),
                headers_with_token("tok"),
            )
            .await;
            assert_eq!(
                resp.status(),
                StatusCode::CONFLICT,
                "{sid} answers the typed 409"
            );
            let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
                .await
                .unwrap();
            let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(value["code"], json!("RESTORE_UNAVAILABLE"), "{value}");
            assert!(
                value["message"]
                    .as_str()
                    .is_some_and(|m| m.contains("still running on the server.")),
                "the frozen refusal text: {value}"
            );
            assert!(
                value["ownerGeneration"].as_u64().is_some(),
                "the owner generation is named: {value}"
            );
            match want_owner_kind {
                Some(kind) => assert_eq!(value["ownerKind"], json!(kind), "{value}"),
                None => assert!(
                    value.get("ownerKind").is_none(),
                    "a transition names no committed owner: {value}"
                ),
            }
        }
        assert!(
            !opencode.opencode_manager_present_for_test().await,
            "the refusal arms never created the manager cell"
        );
    }
}
