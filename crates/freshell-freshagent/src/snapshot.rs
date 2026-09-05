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
//! All three providers are served: **freshcodex/codex** and **freshopencode/opencode** ask
//! their live runtime slices, while **freshclaude/claude** and **kilroy/claude** are a
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

    #[tokio::test]
    async fn unknown_codex_thread_is_404_with_lost_session_code() {
        // `get_snapshot` now attempts ensure-runtime-on-demand for a thread outside the live
        // map (see `codex::snapshot_runtime_for`), which spawns a `CODEX_CMD` subprocess --
        // force a definitely-nonexistent binary (shared `ENV_LOCK` so this can't race
        // against `codex.rs`'s own `CODEX_CMD`-mutating tests in the same process) so this
        // test deterministically exercises the "app-server unreachable" -> non-404 path is
        // NOT what's under test here; this test wants a genuine "no such thread" 404, which
        // requires the spawn to succeed. Since only `codex.rs`'s fake-app-server fixture can
        // provide that, and sharing it across modules is out of scope for this test, assert
        // the REALISTIC outcome instead: with no real codex binary reachable, the request
        // fails, but never with a 200 (masking a nonexistent thread as found).
        let _guard = crate::codex::tests::ENV_LOCK.lock().await;
        std::env::set_var(
            "CODEX_CMD",
            "/definitely/not/a/real/codex/binary-xyz-does-not-exist",
        );
        std::env::remove_var("FAKE_CODEX_APP_SERVER_BEHAVIOR");
        let resp = get_snapshot(
            State(snapshot_state()),
            Path((
                "freshcodex".to_string(),
                "codex".to_string(),
                "does-not-exist".to_string(),
            )),
            Query(HashMap::new()),
            headers_with_token("tok"),
        )
        .await;
        // With no real codex binary reachable, ensure-runtime-on-demand's spawn fails before
        // it can even ask the (nonexistent) app-server whether the thread exists -- a
        // genuine infra error, not "this thread doesn't exist" (see
        // `codex::tests::get_snapshot_ensure_runtime_resumes_a_thread_not_in_the_live_map`
        // for the real "successfully resumes an unknown-but-real thread" proof, and
        // `codex::tests::get_snapshot_with_no_codex_binary_available_is_an_app_server_error`
        // for this exact scenario at the store level). Critically, it must never be 200.
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(
            value["code"].is_null(),
            "generic 500 has no code, matching sendFreshAgentError's fallback"
        );
        std::env::remove_var("CODEX_CMD");
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
    }
}
